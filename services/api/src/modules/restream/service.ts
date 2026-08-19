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
 *
 * GATES. Membership and the ban list, then SHARE_POLICY (see below) for who,
 * then the room's `maxPublishers` for how many. The ceiling is here because
 * this is the only uplink the server is authoritative over — everything else
 * a "publisher" does rides the mesh between clients, where the signaling
 * server has no say. The call-join half of the same policy is still enforced
 * only in the web's join button.
 */
import type {
  PresenceEntry,
  RestreamState,
  RoomId,
  RoomPolicyLevel,
  UserId,
} from '@gather/contracts';
import { AppError } from '../../lib/errors';
import { memberDocId } from '../../adapters/ports';
import { getRoomsRuntime } from '../rooms/runtime';
import { policyAllows } from '../sync/policy';
import type { Deps } from '../types';

const INACTIVE: RestreamState = {
  active: false,
  hostUserId: null,
  startedAt: null,
  viewerCount: 0,
  uplinkQuality: null,
};

/**
 * WHO MAY START A SHARE. 'everyone' is a decision, not an oversight, and it is
 * written here rather than left implicit in the absence of a check: sharing is
 * ungated by ROLE — guests share too — which is the product's ungated-share
 * doctrine (HANDOFF.md). Membership and the ban list are still the door.
 *
 * It runs through `policyAllows`, the one predicate every gated module uses,
 * so the gate is real and named: the day sharing earns a RoomPolicies field,
 * the level below is the only thing that has to change, and the wire contract
 * that already calls restream.start "(policy-gated)" is telling the truth
 * about the shape of the check rather than about a check that isn't there.
 */
const SHARE_POLICY: RoomPolicyLevel = 'everyone';

/**
 * Everyone currently pushing media into the room's mesh: in the call, or
 * sharing. `maxPublishers` bounds DISTINCT publishing members — the same thing
 * the web's join button counts (`inCallCount >= publisherCap`) — so a member
 * who is already publishing does not consume a second slot by also sharing.
 */
function publishingUserIds(entries: readonly PresenceEntry[]): Set<UserId> {
  const publishers = new Set<UserId>();
  for (const entry of entries) {
    if (entry.state === 'in-call' || entry.sharing) {
      publishers.add(entry.userId);
    }
  }
  return publishers;
}

/**
 * People watching the share: everyone present in the room except the person
 * feeding it. Presence, not sockets — the entries are mirrored across
 * instances, so this is the whole room and not this process's half of it.
 *
 * The host is excluded because the badge this feeds reads "N watching", and
 * counting the presenter among their own audience is the kind of off-by-one
 * that makes a real number look made up.
 */
function countViewers(entries: readonly PresenceEntry[], hostUserId: UserId | null): number {
  let viewers = 0;
  for (const entry of entries) {
    if (entry.state !== 'offline' && entry.userId !== hostUserId) {
      viewers += 1;
    }
  }
  return viewers;
}

/**
 * Wire this app instance's presence tracker to the share, once: the reaper on
 * departure, and the viewer count at both edges. Idempotent and cheap, so
 * every entry point that could be the FIRST thing to run for a Deps may call
 * it: the restream module's own service factory, and the rooms presence
 * handler (which is what covers an instance that never saw a `restream.start`
 * but does own the departing host's socket).
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
  const { presence } = getRoomsRuntime(deps);
  presence.onDeparture(async (roomId) => {
    // Release first: a departure that ends the share makes the count moot,
    // and refreshing a share that is about to go inactive would broadcast a
    // number for a stage nobody is feeding.
    await service.releaseIfHostGone(roomId);
    await service.refreshViewerCount(roomId);
  });
  presence.onArrival((roomId) => service.refreshViewerCount(roomId));
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
    if (!policyAllows(SHARE_POLICY, member.role)) {
      throw new AppError('ROOM_POLICY', 'sharing is not allowed for your role in this room');
    }
    const room = await this.deps.store.rooms.findById(roomId);
    if (room === null) throw new AppError('NOT_FOUND', 'room not found');

    const entries = getRoomsRuntime(this.deps).presence.entries(roomId);
    const current = room.restream;
    if (current !== null && current.active && current.hostUserId !== userId) {
      const present = entries.some(
        (entry) => entry.userId === current.hostUserId && entry.state !== 'offline',
      );
      if (present) {
        throw new AppError('CONFLICT', 'someone is already sharing');
      }
    }

    // The room's publisher ceiling, enforced where the server is actually the
    // authority. `maxPublishers` was a web-only check on a button, so a
    // scripted client walked straight past it; a share is the one uplink the
    // server owns outright (the room doc names its host), so it is the one it
    // can refuse. Somebody already publishing is taking their own slot.
    const publishers = publishingUserIds(entries);
    if (!publishers.has(userId) && publishers.size >= room.policies.maxPublishers) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        `this room allows ${String(room.policies.maxPublishers)} people to publish at once`,
      );
    }

    const state: RestreamState = {
      active: true,
      hostUserId: userId,
      startedAt: Date.now(),
      viewerCount: countViewers(entries, userId),
      uplinkQuality: null,
    };
    await this.deps.store.rooms.updateOne({ id: roomId }, { restream: state });
    await this.deps.events.emit(roomId, 'restream.state', state);
  }

  /**
   * Recompute the share's viewer count from room presence and tell the room
   * when it moved. Called at both presence edges (see ensureShareLiveness),
   * because a count that is only minted at start() is a claim about a moment
   * that has passed — and the number it used to carry was the literal 0 the
   * stage rendered as "Live · 0 watching" for a full room.
   *
   * EPHEMERAL on purpose. The count is cosmetic and changes on every join and
   * leave; persisting one replayable event per arrival would bloat the room's
   * event log for a badge. The room DOC is still written, so a late joiner's
   * snapshot (rooms/ws.ts replies with room.restream) carries the current
   * number without the log carrying its history.
   *
   * Compare-and-set on the exact previous snapshot, exactly like
   * releaseIfHostGone: every instance holding the room observes the same
   * arrival or departure, and the CAS makes one of them the writer.
   */
  async refreshViewerCount(roomId: RoomId): Promise<void> {
    const room = await this.deps.store.rooms.findById(roomId);
    const current = room?.restream ?? null;
    if (current === null || !current.active) {
      return;
    }
    const entries = getRoomsRuntime(this.deps).presence.entries(roomId);
    const viewerCount = countViewers(entries, current.hostUserId);
    if (viewerCount === current.viewerCount) {
      return;
    }
    const state: RestreamState = { ...current, viewerCount };
    const updated = await this.deps.store.rooms.updateOne(
      { id: roomId, restream: current },
      { restream: state },
    );
    if (updated === null) {
      return; // another instance counted the same change first
    }
    this.deps.events.emitEphemeral(roomId, 'restream.state', state);
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
