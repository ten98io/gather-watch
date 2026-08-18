/**
 * Mode B (re-stream) authority: who is sharing, room-wide.
 *
 * Owns: the room's `restream` snapshot and the `restream.state` broadcast.
 * Deliberately NOT: any media. The share's bytes ride the mesh/SFU between
 * clients; this service only agrees on WHO is sharing so every stage can
 * switch to (or away from) the share together.
 *
 * The wire contract (ClientRestreamStart/Stop, ServerRestreamState) existed
 * on both sides from the start — this module is the half that was never
 * written, which is why pressing "Share screen" did nothing room-wide: the
 * client's restream.start fell into the hub's unknown-event error path and
 * no state ever came back.
 *
 * LIVENESS. `restream.active` is persisted, and a client that crashes never
 * sends `restream.stop` — so without a server-side release a share outlives
 * its host FOREVER and the room is stuck on a dead stage. `start()` already
 * softened that (an absent host's share is takeable) but takeover only helps
 * when somebody else wants to share. `ensureShareLiveness` closes it properly:
 * presence departure is the moment the server learns a host is gone, and the
 * share is released right there. The client's stop-on-unmount is still the
 * fast path — this is the floor under it, not a replacement.
 */
import type { RestreamState, RoomId, UserId } from '@gather/contracts';
import { AppError } from '../../lib/errors';
import { memberDocId } from '../../adapters/ports';
import { getRoomsRuntime } from '../rooms/runtime';
import type { Deps } from '../types';

const INACTIVE: RestreamState = {
  active: false,
  hostUserId: null,
  startedAt: null,
  viewerCount: 0,
  uplinkQuality: null,
};

/**
 * Register the share reaper on this app instance's presence tracker, once.
 * Idempotent and cheap, so every entry point that could be the FIRST thing to
 * run for a Deps may call it: the restream module's own service factory, and
 * the rooms presence handler (which is what covers an instance that never saw
 * a `restream.start` but does own the departing host's socket).
 */
const wired = new WeakSet<Deps>();

export function ensureShareLiveness(deps: Deps): void {
  if (wired.has(deps)) {
    return;
  }
  wired.add(deps);
  // The service holds no state beyond `deps`, so one instance serves every
  // departure for this app.
  const service = new RestreamService(deps);
  getRoomsRuntime(deps).presence.onDeparture((roomId) => service.releaseIfHostGone(roomId));
}

export class RestreamService {
  constructor(private readonly deps: Deps) {}

  /**
   * One share per room. A second start while the host is still PRESENT is a
   * conflict; when the recorded host has vanished (crash, closed laptop), an
   * absent host's share may be taken over by anyone allowed to share. That
   * takeover is a CONVENIENCE — the share is released without it, on the
   * host's presence departure (see releaseIfHostGone); this branch just means
   * the next person to press Share does not have to wait for the sweep.
   */
  async start(roomId: RoomId, userId: UserId): Promise<void> {
    const member = await this.deps.store.members.findById(memberDocId(roomId, userId));
    if (member === null || member.banned) {
      throw new AppError('FORBIDDEN', 'not a member of this room');
    }
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) throw new AppError('NOT_FOUND', 'room not found');

    const current = room.restream;
    if (current !== null && current.active && current.hostUserId !== userId) {
      const present = getRoomsRuntime(this.deps)
        .presence.entries(roomId)
        .some((entry) => entry.userId === current.hostUserId && entry.state !== 'offline');
      if (present) {
        throw new AppError('CONFLICT', 'someone is already sharing');
      }
    }

    const state: RestreamState = {
      active: true,
      hostUserId: userId,
      startedAt: Date.now(),
      viewerCount: 0,
      uplinkQuality: null,
    };
    await this.deps.store.rooms.updateOne({ id: roomId }, { restream: state });
    await this.deps.events.emit(roomId, 'restream.state', state);
  }

  /**
   * Release an active share whose host is no longer in the room's presence
   * set. Called on every presence departure, so a host who crashed, closed the
   * lid or was kicked cannot leave the room pinned to a stage nobody feeds.
   *
   * Presence, not sockets, is the liveness source: `hub.localUserIds` only
   * knows THIS instance, while presence entries are mirrored across instances
   * over the `roomctl:` channel, so a host connected elsewhere still counts as
   * here. The write is a compare-and-set on the exact previous snapshot —
   * several instances can observe the same departure, and the CAS makes
   * exactly one of them write and therefore exactly one broadcast reach the
   * room.
   */
  async releaseIfHostGone(roomId: RoomId): Promise<void> {
    const room = await this.deps.store.rooms.findById(roomId);
    const current = room?.restream ?? null;
    if (current === null || !current.active || current.hostUserId === null) {
      return;
    }
    const present = getRoomsRuntime(this.deps)
      .presence.entries(roomId)
      .some((entry) => entry.userId === current.hostUserId && entry.state !== 'offline');
    if (present) {
      return;
    }
    const updated = await this.deps.store.rooms.updateOne(
      { id: roomId, restream: current },
      { restream: INACTIVE },
    );
    if (updated === null) {
      return; // another instance (or a real stop) got there first
    }
    await this.deps.events.emit(roomId, 'restream.state', INACTIVE);
  }

  /** The sharer may stop their own share; host/moderator may stop anyone's. */
  async stop(roomId: RoomId, userId: UserId): Promise<void> {
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) throw new AppError('NOT_FOUND', 'room not found');
    const current = room.restream;
    // Stopping a share that is not running is a no-op, not an error: the
    // client sends stop on every teardown path, including after a crash it
    // cannot distinguish from a clean end.
    if (current === null || !current.active) return;

    if (current.hostUserId !== userId) {
      const member = await this.deps.store.members.findById(memberDocId(roomId, userId));
      const role = member?.role;
      if (role !== 'host' && role !== 'moderator') {
        throw new AppError('FORBIDDEN', 'only the sharer or a moderator can stop a share');
      }
    }

    await this.deps.store.rooms.updateOne({ id: roomId }, { restream: INACTIVE });
    await this.deps.events.emit(roomId, 'restream.state', INACTIVE);
  }
}
