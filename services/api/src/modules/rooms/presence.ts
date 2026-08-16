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
      entry = {
        userId,
        state: patch.state ?? defaultState,
        micOn: patch.micOn ?? false,
        camOn: patch.camOn ?? false,
        sharing: patch.sharing ?? false,
        lastSeenTs: now,
      };
      visibleChanged = true;
      roomMap.set(userId, {
        entry,
        expiresAt: now + this.timings.ttlMs,
        local: true,
        disconnectedAt: null,
      });
    } else {
      const prev = existing.entry;
      entry = {
        userId,
        state: patch.state ?? prev.state,
        micOn: patch.micOn ?? prev.micOn,
        camOn: patch.camOn ?? prev.camOn,
        sharing: patch.sharing ?? prev.sharing,
        lastSeenTs: now,
      };
      // lastSeenTs alone is silent — only client-visible fields diff.
      visibleChanged =
        entry.state !== prev.state ||
        entry.micOn !== prev.micOn ||
        entry.camOn !== prev.camOn ||
        entry.sharing !== prev.sharing;
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
        if (connected) {
          tracked.disconnectedAt = null;
        }
        if (now >= tracked.expiresAt) {
          // Stale heartbeat (the socket may still be open) — drop the user.
          await this.removeUser(roomId, userId);
          continue;
        }
        if (!connected) {
          if (tracked.disconnectedAt === null) {
            tracked.disconnectedAt = now;
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
        this.deps.hub.disconnectUser(roomId, message.userId as UserId, 4403, 'removed');
        this.rooms.get(roomId)?.delete(message.userId as UserId);
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
