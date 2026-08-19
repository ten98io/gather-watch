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
  /**
   * How long `ensureRoster` waits for another instance to answer the roster
   * request before answering from what it has.
   *
   * A CEILING, not a delay: the first 'state' response resolves it, so on a
   * live bus this costs one round trip. What it bounds is the case with no
   * answer at all — a single-instance deploy, where nobody is there to reply,
   * and a dropped request, where the reply never comes. Both must end in the
   * caller being served rather than parked, and both are paid once per room
   * per instance because the result is memoized.
   */
  rosterSyncMs: number;
}

export const DEFAULT_PRESENCE_TIMINGS: PresenceTimings = {
  ttlMs: 45_000,
  sweepMs: 5_000,
  disconnectGraceMs: 15_000,
  rosterSyncMs: 150,
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

/**
 * Notified AFTER a member has been ADDED to a room by this instance's own
 * socket — the mirror of DepartureListener, and it exists for the same reason:
 * some room-wide state is a function of who is here, so it has to be recomputed
 * at BOTH edges or it only ever ratchets one way (today, the share's viewer
 * count, which would count down on leaves and never back up).
 *
 * Mirrors do not fire it. The instance that owns the socket is the one that
 * created the entry, exactly as it is the one that emits the presence.diff.
 *
 * Same failure contract as DepartureListener: rejections are logged and
 * swallowed, because bookkeeping in one module must never fail a heartbeat.
 */
export type ArrivalListener = (roomId: RoomId, userId: UserId) => void | Promise<void>;

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
  /** roomId → the in-flight (then settled) roster handshake for that room. */
  private readonly rosterSyncs = new Map<RoomId, Promise<void>>();
  /** roomId → resolve() for the handshake above, while it is still waiting. */
  private readonly rosterWaiters = new Map<RoomId, () => void>();
  private readonly departureListeners = new Set<DepartureListener>();
  private readonly arrivalListeners = new Set<ArrivalListener>();
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

  /** Register an arrival listener; returns an idempotent unregister. */
  onArrival(listener: ArrivalListener): () => void {
    this.arrivalListeners.add(listener);
    return () => {
      this.arrivalListeners.delete(listener);
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
    if (created) {
      await this.announceArrival(roomId, userId);
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

  /**
   * ROOM-WIDE user ids: this instance's own members AND the ones mirrored from
   * every other instance. The denominator for anything that reasons about "who
   * is in this room" — a skip quorum, a wait-for-all roster, a viewer count.
   *
   * It exists because `hub.localUserIds` answers a DIFFERENT question — whose
   * socket is open on THIS process — and the API runs several processes, with
   * a rolling deploy overlapping two of them on every push. Counting sockets
   * therefore counts a fraction of the room for the length of every deploy,
   * and each fraction disagrees with the others: quorums halve, and a roster
   * broadcast from one instance overwrites the room's view with a partial one.
   *
   * A member inside the disconnect grace still counts. They have not left —
   * the sweep past the grace is what removes them — so a refresh must not
   * momentarily shrink every quorum in the app.
   */
  presentUserIds(roomId: RoomId): UserId[] {
    const roomMap = this.rooms.get(roomId);
    if (roomMap === undefined) {
      return [];
    }
    const present: UserId[] = [];
    for (const tracked of roomMap.values()) {
      if (tracked.entry.state !== 'offline') {
        present.push(tracked.entry.userId);
      }
    }
    return present;
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
    // Release anything parked on a roster window before the timers stop
    // mattering, so shutdown never waits on an answer that cannot arrive.
    for (const resolve of this.rosterWaiters.values()) resolve();
    this.rosterWaiters.clear();
    this.rosterSyncs.clear();
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

  /** Run the arrival listeners. Never throws — see ArrivalListener. */
  private async announceArrival(roomId: RoomId, userId: UserId): Promise<void> {
    for (const listener of this.arrivalListeners) {
      try {
        await listener(roomId, userId);
      } catch (err) {
        this.deps.log.warn({ err, roomId, userId }, 'presence arrival listener failed');
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

  /** Subscribe the room's ctl channel on first local activity for the room,
   *  and ask the other instances for the half of the roster this one has never
   *  seen (see requestRoster). */
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
    // Stashed just as eagerly, and for the same reason: a second caller that
    // finds the subscription already registered must be able to WAIT on the
    // same handshake rather than conclude there isn't one.
    this.rosterSyncs.set(roomId, this.requestRoster(roomId, subscribing));
    await subscribing;
  }

  /**
   * Subscribed AND caught up: the room's control channel is live and either an
   * instance has answered with its half of the roster or the window closed.
   *
   * Anything that reasons about the SIZE of the room has to go through here
   * first. `entries` and `presentUserIds` answer from whatever this instance
   * happens to know, and on an instance that has just picked the room up that
   * is the caller and nobody else — which is not a small error, it is a
   * different room. A skip quorum divided by it; `sync.advance` read it as
   * "nobody who may drive is present" and waived its clock check.
   *
   * Memoized per room, so this is a bus round trip the first time and free
   * afterwards, and it is deliberately best-effort: the bus is at-most-once,
   * so a dropped request leaves the view incomplete and the callers stay
   * responsible for not acting on a roster of one (see QueueService.voteSkip
   * and SyncService.privilegedHolderAbsent).
   */
  async ensureRoster(roomId: RoomId): Promise<void> {
    await this.ensureCtl(roomId);
    await this.rosterSyncs.get(roomId);
  }

  /**
   * Publish the roster request and settle on the first answer, or on the
   * window. Never rejects: a bus that cannot carry the request leaves this
   * instance with the view it already had, which is exactly what happened
   * before the handshake existed.
   */
  private async requestRoster(roomId: RoomId, subscribing: Promise<unknown>): Promise<void> {
    try {
      await subscribing;
      const answered = new Promise<void>((resolve) => {
        this.rosterWaiters.set(roomId, resolve);
      });
      const message: RoomCtlMessage = { kind: 'sync', roomId, from: this.originId };
      await this.deps.bus.publish(roomCtlChannel(roomId), message);
      await Promise.race([answered, this.rosterWindow()]);
    } catch (err) {
      this.deps.log.warn({ err, roomId }, 'presence roster sync failed');
    } finally {
      this.rosterWaiters.delete(roomId);
    }
  }

  /** The roster window as a promise. Unref'd — waiting for a roster must never
   *  be the reason a process stays alive. */
  private rosterWindow(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.timings.rosterSyncMs);
      timer.unref();
    });
  }

  /** Answer another instance's roster request with the entries THIS instance
   *  owns. Mirrors are left to the instance that owns them, so one answer per
   *  entry reaches the asker rather than one per instance holding it. */
  private async answerRoster(roomId: RoomId, to: string): Promise<void> {
    const entries: PresenceEntry[] = [];
    for (const tracked of this.rooms.get(roomId)?.values() ?? []) {
      if (tracked.local) entries.push(tracked.entry);
    }
    if (entries.length === 0) {
      return;
    }
    const message: RoomCtlMessage = { kind: 'state', roomId, entries, from: this.originId, to };
    await this.deps.bus.publish(roomCtlChannel(roomId), message);
  }

  /**
   * Merge a roster answer and tell this instance's clients about the people it
   * did not know were there.
   *
   * THE ONE PLACE A MIRROR DIFFS, and it has to be: the rule everywhere else
   * is that only the instance owning an entry broadcasts it, because otherwise
   * every instance re-announces every change. But nobody CHANGED here — the
   * asker was simply missing entries the room settled on before it arrived,
   * and the owners have no reason to say them again. Without this the roster
   * repairs in the tracker and never on the screen, which is the whole
   * "sitting alone in a room full of people" symptom.
   */
  private applyRosterAnswer(roomId: RoomId, entries: readonly PresenceEntry[]): void {
    const learned: PresenceEntry[] = [];
    for (const entry of entries) {
      if (this.mergeMirror(roomId, entry)) learned.push(entry);
    }
    this.rosterWaiters.get(roomId)?.();
    if (learned.length > 0) {
      this.deps.events.emitEphemeral(roomId, 'presence.diff', {
        upserts: learned,
        removed: [],
      });
    }
  }

  /**
   * Merge one entry heard from another instance. Returns true when it was NEW
   * to this instance (the caller decides whether that is worth saying).
   *
   * A local entry is normally not downgraded — this instance owns the socket
   * and its own sweep is the authority on it. The exception is the whole of
   * DEFECT 4: when the socket is gone from this instance but another instance
   * is beating for that user, they did not leave, they RECONNECTED somewhere
   * else. Keeping the entry local there means this instance's disconnect grace
   * expires and calls `removeUser`, which broadcasts a room-wide removal and
   * fires `onDeparture` — so a member who is perfectly well connected is
   * evicted from everyone's roster and has their screen share force-stopped by
   * the instance they LEFT. Handing ownership to the instance that now has the
   * socket is the honest reading of a heartbeat from somewhere else.
   */
  private mergeMirror(roomId: RoomId, entry: PresenceEntry): boolean {
    let roomMap = this.rooms.get(roomId);
    if (roomMap === undefined) {
      roomMap = new Map<UserId, Tracked>();
      this.rooms.set(roomId, roomMap);
    }
    const userId = entry.userId;
    const existing = roomMap.get(userId);
    if (existing === undefined) {
      roomMap.set(userId, {
        entry,
        expiresAt: Date.now() + this.timings.ttlMs,
        local: false,
        disconnectedAt: null,
      });
      return true;
    }
    const movedAway =
      existing.local && !this.deps.hub.localUserIds(roomId).includes(userId);
    if (movedAway) {
      // This instance already told the room the member was unreachable, and
      // that is now known to be wrong. It broadcast the claim, so it corrects
      // it — no other instance can, and the owning one has nothing new to say.
      const wasUnreachable = existing.disconnectedAt !== null || !isReachable(existing.entry);
      existing.local = false;
      existing.disconnectedAt = null;
      if (wasUnreachable) {
        this.deps.events.emitEphemeral(roomId, 'presence.diff', {
          upserts: [entry],
          removed: [],
        });
      }
    }
    existing.entry = entry;
    existing.expiresAt = Date.now() + this.timings.ttlMs;
    return false;
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
        // No client diff — the origin instance already emitted it.
        this.mergeMirror(roomId, message.entry);
        break;
      }
      case 'sync': {
        void this.answerRoster(roomId, message.from).catch((err: unknown) => {
          this.deps.log.warn({ err, roomId }, 'presence roster answer failed');
        });
        break;
      }
      case 'state': {
        // Addressed: every instance holding the room sees every answer, and
        // merging one meant for somebody else would be harmless but would also
        // resolve a handshake this instance never sent.
        if (message.to !== this.originId) break;
        this.applyRosterAnswer(roomId, message.entries);
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

  /** Unsubscribe the ctl channel and drop the room map. The roster handshake
   *  goes with it: the next instance-local activity for this room subscribes
   *  again, and asks again, because the view starts empty again. */
  private async dropRoom(roomId: RoomId): Promise<void> {
    this.rooms.delete(roomId);
    this.rosterWaiters.get(roomId)?.();
    this.rosterWaiters.delete(roomId);
    this.rosterSyncs.delete(roomId);
    const unsub = this.ctlSubs.get(roomId);
    this.ctlSubs.delete(roomId);
    if (unsub !== undefined) {
      await unsub();
    }
  }
}
