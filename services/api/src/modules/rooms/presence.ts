/**
 * Presence tracker for the rooms realtime surface.
 *
 * Heartbeat TTL lives HERE, not in the bus: BusPort is a frozen seam with no
 * TTL primitive (and Redis pub/sub keyspace TTL would not fit its pub/sub
 * semantics anyway), so each app instance tracks the presence entries it heard
 * locally and expires them itself. Entries heard on OTHER instances are
 * mirrored over the `roomctl:` control-plane channel (RoomCtlMessage 'hb' /
 * 'bye' / 'kick'); every publisher stamps a random `from` origin id and skips
 * its own loopback, because the bus delivers to the publishing instance's own
 * subscribers too.
 *
 * Only the instance that owns a LOCAL entry emits client-visible
 * presence.diff events for it — mirrors never diff, or every instance would
 * broadcast the same change.
 *
 * The disconnect grace is VISIBLE (see `connected` below): the sweep that
 * first finds a socket gone broadcasts the member as unreachable and only the
 * sweep past the grace removes them, so a refresh reads as "reconnecting"
 * rather than as a departure.
 *
 * Departure is also the only moment the server LEARNS that somebody is gone,
 * so it is the hook other modules hang liveness on (`onDeparture` below):
 * anything a member holds room-wide — today, the Mode B share — has to be
 * releasable without that member's cooperation, because the whole failure mode
 * is a client that never got to say goodbye.
 */
import type { PresenceEntry, PresenceState, RoomId, UserId } from '@gather/contracts';
import { newId } from '../../lib/tokens';
import type { Deps } from '../types';
import { roomCtlChannel } from './deps';
import type { RoomCtlMessage } from './deps';

export interface PresenceTimings {
  /** Entry dropped when no heartbeat within this window. */
  ttlMs: number;
  /** Sweep cadence. */
  sweepMs: number;
  /** Socket-gone grace before the entry is dropped (host disconnect →
   *  election-eligibility broadcast). */
  disconnectGraceMs: number;
}

export const DEFAULT_PRESENCE_TIMINGS: PresenceTimings = {
  ttlMs: 45_000,
  sweepMs: 5_000,
  disconnectGraceMs: 15_000,
};

/**
 * The reachability marker, carried alongside the contract's fields.
 *
 * "Momentarily unreachable" is NOT `state: 'offline'`, even though reusing
 * that enum value would need no contract change. Two reasons, both concrete:
 * PeoplePane renders a missing entry and an 'offline' entry with the same
 * word ("Offline"), so the distinction this grace exists to show would be
 * invisible anyway; and packages/p2p `applyPresence` filters on
 * `state !== 'offline'`, so a two-second blip would call removePeer and tear
 * down a WebRTC connection that had every chance of surviving the blip —
 * strictly worse than the silence it replaced. A separate boolean keeps
 * "left" and "still here, momentarily unreachable" apart.
 *
 * PresenceEntry does not declare the field yet (packages/contracts is owned
 * elsewhere as this lands), so it rides as a structural extra: it survives
 * JSON.stringify on the wire and is dropped by the client's
 * ServerEvent.safeParse until the schema names it. Adding
 * `connected: z.boolean().default(true)` to PresenceEntry is the whole
 * client-side switch-on; nothing here changes.
 */
type WireEntry = PresenceEntry & { connected: boolean };

/** Stamp reachability on an entry. THE carrier seam: swapping the marker (to
 *  `state: 'offline'`, say) means changing this function and nothing else. */
function withReachability(entry: PresenceEntry, connected: boolean): WireEntry {
  return { ...entry, connected };
}

/** Entries that predate the marker (and mirrors from an older instance) read
 *  as reachable. */
function isReachable(entry: PresenceEntry): boolean {
  return (entry as Partial<WireEntry>).connected ?? true;
}

/**
 * Notified AFTER a member has been dropped from a room — explicit leave, stale
 * heartbeat, the sweep past the disconnect grace, or a moderator kick. The
 * tracker's view of the room is already updated when a listener runs, so
 * `entries(roomId)` is the post-departure truth.
 *
 * A listener may not fail the departure: rejections are logged and swallowed,
 * because bookkeeping in one module must never stop presence from expiring.
 */
export type DepartureListener = (roomId: RoomId, userId: UserId) => void | Promise<void>;

/** One tracked entry: the client-visible record plus bookkeeping. */
interface Tracked {
  entry: PresenceEntry;
  expiresAt: number;
  /** True when this instance heard the heartbeat from its own socket. */
  local: boolean;
  /** Set on the first sweep that finds no local socket; cleared on reconnect. */
  disconnectedAt: number | null;
}

export class PresenceTracker {
  private readonly deps: Deps;
  private timings: PresenceTimings;
  private readonly originId = newId();
  private readonly rooms = new Map<RoomId, Map<UserId, Tracked>>();
  private readonly ctlSubs = new Map<RoomId, () => Promise<void>>();
  private readonly departureListeners = new Set<DepartureListener>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(deps: Deps, timings?: Partial<PresenceTimings>) {
    this.deps = deps;
    this.timings = { ...DEFAULT_PRESENCE_TIMINGS, ...timings };
  }

  /** Adjust timings (tests use tiny values); restarts the sweep interval. */
  configure(timings: Partial<PresenceTimings>): void {
    this.timings = { ...this.timings, ...timings };
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      this.ensureSweep();
    }
  }

  /** Register a departure listener; returns an idempotent unregister. */
  onDeparture(listener: DepartureListener): () => void {
    this.departureListeners.add(listener);
    return () => {
      this.departureListeners.delete(listener);
    };
  }

  /** Merge a heartbeat; returns the entry and whether it was created. */
  async heartbeat(
    roomId: RoomId,
    userId: UserId,
    patch: {
      state?: PresenceState;
      micOn?: boolean;
      camOn?: boolean;
      sharing?: boolean;
    },
    defaultState: PresenceState,
  ): Promise<{ entry: PresenceEntry; created: boolean }> {
    const now = Date.now();
    await this.ensureCtl(roomId);
    this.ensureSweep();
    let roomMap = this.rooms.get(roomId);
    if (roomMap === undefined) {
      roomMap = new Map<UserId, Tracked>();
      this.rooms.set(roomId, roomMap);
    }

    const existing = roomMap.get(userId);
    let entry: PresenceEntry;
    let visibleChanged: boolean;
    const created = existing === undefined;
    if (created) {
      entry = withReachability(
        {
          userId,
          state: patch.state ?? defaultState,
          micOn: patch.micOn ?? false,
          camOn: patch.camOn ?? false,
          sharing: patch.sharing ?? false,
          lastSeenTs: now,
        },
        true,
      );
      visibleChanged = true;
      roomMap.set(userId, {
        entry,
        expiresAt: now + this.timings.ttlMs,
        local: true,
        disconnectedAt: null,
      });
    } else {
      const prev = existing.entry;
      entry = withReachability(
        {
          userId,
          state: patch.state ?? prev.state,
          micOn: patch.micOn ?? prev.micOn,
          camOn: patch.camOn ?? prev.camOn,
          sharing: patch.sharing ?? prev.sharing,
          lastSeenTs: now,
        },
        // A heartbeat arrives over the socket, so the socket is back.
        true,
      );
      // lastSeenTs alone is silent — only client-visible fields diff.
      visibleChanged =
        entry.state !== prev.state ||
        entry.micOn !== prev.micOn ||
        entry.camOn !== prev.camOn ||
        entry.sharing !== prev.sharing ||
        // A heartbeat landing inside the grace is the reconnect: say so, even
        // when nothing else about the member changed.
        !isReachable(prev);
      existing.entry = entry;
      existing.expiresAt = now + this.timings.ttlMs;
      existing.local = true;
      existing.disconnectedAt = null;
    }

    const message: RoomCtlMessage = { kind: 'hb', roomId, entry, from: this.originId };
    await this.deps.bus.publish(roomCtlChannel(roomId), message);
    if (visibleChanged) {
      this.deps.events.emitEphemeral(roomId, 'presence.diff', { upserts: [entry], removed: [] });
    }
    return { entry, created };
  }

  /** All known entries for the room (local + mirrored), stable order. */
  entries(roomId: RoomId): PresenceEntry[] {
    const roomMap = this.rooms.get(roomId);
    if (roomMap === undefined) {
      return [];
    }
    return [...roomMap.values()].map((tracked) => tracked.entry);
  }

  /** Drop a user now (explicit offline / leave): diff + 'bye' broadcast. */
  async removeUser(roomId: RoomId, userId: UserId): Promise<void> {
    const roomMap = this.rooms.get(roomId);
    if (roomMap === undefined || !roomMap.delete(userId)) {
      return;
    }
    this.deps.events.emitEphemeral(roomId, 'presence.diff', {
      upserts: [],
      removed: [userId],
    });
    const message: RoomCtlMessage = { kind: 'bye', roomId, userId, from: this.originId };
    await this.deps.bus.publish(roomCtlChannel(roomId), message);
    // Before dropRoom, so a listener that reads entries() sees the room the
    // departure actually left behind rather than an already-forgotten one.
    await this.announceDeparture(roomId, userId);
    if (roomMap.size === 0) {
      await this.dropRoom(roomId);
    }
  }

  /** One TTL/disconnect pass; exposed for tests. */
  async sweep(now: number = Date.now()): Promise<void> {
    for (const [roomId, roomMap] of [...this.rooms]) {
      const locals = this.deps.hub.localUserIds(roomId);
      for (const [userId, tracked] of [...roomMap]) {
        if (!tracked.local) {
          // Mirror entries expire silently — the origin instance owns the diff.
          if (now >= tracked.expiresAt) {
            roomMap.delete(userId);
          }
          continue;
        }
        const connected = locals.includes(userId);
        if (connected && tracked.disconnectedAt !== null) {
          // Back before the grace ran out: cancel it and say the member is
          // reachable again, or the roster would stay stuck mid-blip until
          // their next visible change.
          tracked.disconnectedAt = null;
          await this.setReachability(roomId, tracked, true);
        }
        if (now >= tracked.expiresAt) {
          // Stale heartbeat — the owner is gone, socket or no socket.
          //
          // This deliberately does NOT also require the socket to be absent.
          // `connected` is measured PER USER (hub.localUserIds folds every
          // open socket for a userId into one), and the extension holds its
          // own room socket that never beats presence and is not closed when
          // the web tab dies — so requiring both made the entry IMMORTAL for
          // every extension user: never reaped, never graced, `onDeparture`
          // never fired, and a ghost held the master seat and an orphaned
          // share forever.
          //
          // The beat is the liveness signal, so anything that wants to keep an
          // entry alive must beat: the extension now does so while a share is
          // live (apps/extension/src/background.ts), which is what actually
          // fixed the share being declared over ~45s after it started.
          await this.removeUser(roomId, userId);
          continue;
        }
        if (!connected) {
          if (tracked.disconnectedAt === null) {
            tracked.disconnectedAt = now;
            // The socket is gone but the grace is still running. Broadcasting
            // it is the whole point: silence here is what made a refresh read
            // to everyone else as a departure.
            await this.setReachability(roomId, tracked, false);
          } else if (now - tracked.disconnectedAt >= this.timings.disconnectGraceMs) {
            // Grace elapsed: this diff IS the election-eligibility broadcast.
            await this.removeUser(roomId, userId);
          }
        }
      }
      if (this.rooms.get(roomId) !== undefined && roomMap.size === 0) {
        await this.dropRoom(roomId);
      }
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const unsubs = [...this.ctlSubs.values()];
    this.ctlSubs.clear();
    this.rooms.clear();
    await Promise.all(unsubs.map((unsub) => unsub()));
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Run the departure listeners. Never throws — see DepartureListener. */
  private async announceDeparture(roomId: RoomId, userId: UserId): Promise<void> {
    for (const listener of this.departureListeners) {
      try {
        await listener(roomId, userId);
      } catch (err) {
        this.deps.log.warn({ err, roomId, userId }, 'presence departure listener failed');
      }
    }
  }

  /**
   * Re-stamp a LOCAL entry's reachability and broadcast it: a client diff for
   * live sockets (everywhere — emitEphemeral fans out over the room channel)
   * plus an 'hb' mirror so another instance's roster snapshot agrees. No
   * lastSeenTs bump: the member has not been heard from.
   */
  private async setReachability(
    roomId: RoomId,
    tracked: Tracked,
    connected: boolean,
  ): Promise<void> {
    const entry = withReachability(tracked.entry, connected);
    tracked.entry = entry;
    this.deps.events.emitEphemeral(roomId, 'presence.diff', { upserts: [entry], removed: [] });
    const message: RoomCtlMessage = { kind: 'hb', roomId, entry, from: this.originId };
    await this.deps.bus.publish(roomCtlChannel(roomId), message);
  }

  private ensureSweep(): void {
    if (this.sweepTimer !== null) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.timings.sweepMs);
    // Never keep the process alive just for presence sweeping.
    this.sweepTimer.unref();
  }

  /** Subscribe the room's ctl channel on first local activity for the room. */
  private async ensureCtl(roomId: RoomId): Promise<void> {
    if (this.ctlSubs.has(roomId)) {
      return;
    }
    const subscribing = this.deps.bus.subscribe(roomCtlChannel(roomId), (raw) => {
      this.onCtlMessage(raw);
    });
    // Stash immediately (behind the pending promise) so concurrent first
    // heartbeats for one room cannot double-subscribe.
    this.ctlSubs.set(roomId, async () => {
      const unsub = await subscribing;
      await unsub();
    });
    await subscribing;
  }

  private onCtlMessage(raw: unknown): void {
    const message = raw as RoomCtlMessage;
    // The bus loops our own publishes back to us — skip them.
    if (message.from === this.originId) {
      return;
    }
    const roomId = message.roomId as RoomId;
    switch (message.kind) {
      case 'hb': {
        let roomMap = this.rooms.get(roomId);
        if (roomMap === undefined) {
          roomMap = new Map<UserId, Tracked>();
          this.rooms.set(roomId, roomMap);
        }
        const userId = message.entry.userId;
        const existing = roomMap.get(userId);
        if (existing !== undefined) {
          // Never downgrade a local entry to a mirror; just refresh fields.
          existing.entry = message.entry;
          existing.expiresAt = Date.now() + this.timings.ttlMs;
        } else {
          roomMap.set(userId, {
            entry: message.entry,
            expiresAt: Date.now() + this.timings.ttlMs,
            local: false,
            disconnectedAt: null,
          });
        }
        // No client diff — the origin instance already emitted it.
        break;
      }
      case 'bye': {
        const roomMap = this.rooms.get(roomId);
        const tracked = roomMap?.get(message.userId as UserId);
        if (roomMap !== undefined && tracked !== undefined && !tracked.local) {
          roomMap.delete(message.userId as UserId);
          if (roomMap.size === 0) {
            void this.dropRoom(roomId);
          }
        }
        // No client diff — the origin instance already emitted it.
        break;
      }
      case 'kick': {
        const userId = message.userId as UserId;
        this.deps.hub.disconnectUser(roomId, userId, 4403, 'removed');
        // A kicked member never gets to say goodbye either, so this is a
        // departure like any other. Fired on every instance that had the
        // entry; listeners are expected to converge (the share reaper does it
        // with a compare-and-set, so exactly one write wins).
        if (this.rooms.get(roomId)?.delete(userId) === true) {
          void this.announceDeparture(roomId, userId);
        }
        break;
      }
    }
  }

  /** Unsubscribe the ctl channel and drop the room map. */
  private async dropRoom(roomId: RoomId): Promise<void> {
    this.rooms.delete(roomId);
    const unsub = this.ctlSubs.get(roomId);
    this.ctlSubs.delete(roomId);
    if (unsub !== undefined) {
      await unsub();
    }
  }
}
