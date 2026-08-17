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

export class RestreamService {
  constructor(private readonly deps: Deps) {}

  /**
   * One share per room. A second start while the host is still PRESENT is a
   * conflict; when the recorded host has vanished (crash, closed laptop —
   * there is no module-level disconnect hook to clean up after them), the
   * room would otherwise be stuck "sharing" forever, so an absent host's
   * share may be taken over by anyone allowed to share.
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
