/**
 * Deterministic master election for the sync beacon role.
 *
 * Every peer runs the same deterministic rule (lowest joinOrder, ties by
 * userId) over the same connected set, so in the common case all peers agree
 * on who should claim without extra traffic. The SERVER stays the arbiter:
 * local claims are intents forwarded as sync.claimMaster, and the server
 * verdict (sync.masterChanged) always overrides local state.
 */

import type { UserId } from '@playin/contracts';
import type { NowFn } from './types';

/** A connected remote peer as election input. */
export interface ElectionPeer {
  userId: UserId;
  joinOrder: number;
}

/** Events emitted by {@link MasterElection}. */
export interface MasterElectionEvents {
  /** Intent: WE should be master at `epoch` — the app forwards this as a
   *  sync.claimMaster WS event; the SERVER stays the arbiter. */
  claimMaster?: (epoch: number) => void;
  /** Local view of the master changed (either optimistic or server-confirmed). */
  masterChanged?: (masterUserId: UserId, epoch: number) => void;
}

/** Options for {@link MasterElection}. */
export interface MasterElectionOptions {
  localUserId: UserId;
  localJoinOrder: number;
  now: NowFn;
  /** Master is presumed dead after this much beacon silence. Default 3000. */
  beaconTimeoutMs?: number;
  events?: MasterElectionEvents;
}

/**
 * Tracks who currently drives playback (the beacon master) using beacon
 * liveness, a deterministic eligibility rule, and lamport-style epochs so
 * split-brain resolves by simply letting the higher epoch win.
 */
export class MasterElection {
  private readonly localUserId: UserId;
  private readonly localJoinOrder: number;
  private readonly now: NowFn;
  private readonly beaconTimeoutMs: number;
  private readonly events: MasterElectionEvents;

  private peers: ElectionPeer[] = [];
  private master: { userId: UserId; epoch: number } | null = null;
  private maxEpoch = 0;
  private lastMasterBeaconTs = 0;
  /** Last epoch we emitted claimMaster for; null until the first claim. */
  private lastClaimedEpoch: number | null = null;

  constructor(opts: MasterElectionOptions) {
    this.localUserId = opts.localUserId;
    this.localJoinOrder = opts.localJoinOrder;
    this.now = opts.now;
    this.beaconTimeoutMs = opts.beaconTimeoutMs ?? 3000;
    this.events = opts.events ?? {};
  }

  /** Replace the set of CONNECTED remote peers (mesh connection state, not presence). */
  setPeers(peers: ElectionPeer[]): void {
    this.peers = [...peers];
  }

  /** A sync beacon arrived from `from` claiming `epoch`. */
  noteBeacon(from: UserId, epoch: number): void {
    const isCurrentMaster = this.master !== null && this.master.userId === from;

    // Stale epochs from non-masters carry no information worth adopting.
    if (epoch < this.maxEpoch && !isCurrentMaster) return;

    if (this.master !== null && isCurrentMaster) {
      // The incumbent keeps the role across epoch bumps; only its silence
      // (beacon timeout) or a higher epoch from elsewhere dislodges it.
      if (epoch >= this.master.epoch) {
        this.lastMasterBeaconTs = this.now();
        if (epoch > this.master.epoch) this.master = { userId: from, epoch };
        if (epoch > this.maxEpoch) this.maxEpoch = epoch;
      }
      return;
    }

    if (this.master === null || epoch > this.master.epoch) {
      // Higher epoch wins outright — this is also the split-brain heal: if we
      // were master ourselves, we step down silently.
      this.adopt(from, epoch);
      return;
    }

    if (epoch === this.master.epoch) {
      // True split-brain tie: deterministic lexicographic tiebreak.
      if (from < this.master.userId) this.adopt(from, epoch);
    }
    // Older epochs from a non-master are stale (already covered by the
    // maxEpoch guard; unreachable unless the invariant breaks).
  }

  /** Authoritative server verdict (sync.masterChanged). Always adopted. */
  applyServerMasterChanged(masterUserId: UserId, epoch: number): void {
    // The server is authoritative even for a LOWER epoch (e.g. it rejected
    // our optimistic claim and confirmed someone else).
    this.adopt(masterUserId, epoch);
  }

  /** Re-evaluate liveness + eligibility; call on a ~500ms cadence and after
   *  setPeers/noteBeacon. May emit claimMaster / masterChanged. */
  evaluate(): void {
    if (this.masterAlive() && this.masterConnected()) return;

    const candidate = this.computeCandidate();
    if (candidate.userId === this.localUserId) {
      this.maxEpoch += 1;
      if (this.lastClaimedEpoch !== this.maxEpoch) {
        this.lastClaimedEpoch = this.maxEpoch;
        this.events.claimMaster?.(this.maxEpoch);
      }
      // Optimistic adoption lets beaconing start immediately; the server
      // verdict still overrides.
      this.adopt(this.localUserId, this.maxEpoch);
    } else {
      // Never claim on a remote candidate's behalf — they will claim, or a
      // later evaluate will once the connected set changes. But do clear a
      // dead/disconnected master locally so followers stop trusting it.
      this.master = null;
    }
  }

  /** Current master view, or null when none is (still) known. */
  currentMaster(): { userId: UserId; epoch: number } | null {
    return this.master === null ? null : { ...this.master };
  }

  /** True while we believe we are the master. */
  isMaster(): boolean {
    return this.master !== null && this.master.userId === this.localUserId;
  }

  /** Highest epoch ever seen (monotonic). */
  epoch(): number {
    return this.maxEpoch;
  }

  private masterAlive(): boolean {
    if (this.master === null) return false;
    // Self needs no beacon liveness check — we know whether we are alive.
    if (this.master.userId === this.localUserId) return true;
    return this.now() - this.lastMasterBeaconTs <= this.beaconTimeoutMs;
  }

  private masterConnected(): boolean {
    if (this.master === null) return false;
    if (this.master.userId === this.localUserId) return true;
    return this.peers.some((p) => p.userId === this.master?.userId);
  }

  /** Lowest joinOrder among self + connected peers, ties by userId. */
  private computeCandidate(): ElectionPeer {
    let best: ElectionPeer = { userId: this.localUserId, joinOrder: this.localJoinOrder };
    for (const peer of this.peers) {
      if (
        peer.joinOrder < best.joinOrder ||
        (peer.joinOrder === best.joinOrder && peer.userId < best.userId)
      ) {
        best = peer;
      }
    }
    return best;
  }

  private adopt(userId: UserId, epoch: number): void {
    const changed =
      this.master === null || this.master.userId !== userId || this.master.epoch !== epoch;
    this.master = { userId, epoch };
    // A freshly adopted master gets a full timeout window before being
    // declared dead, even if its first beacon is still in flight.
    this.lastMasterBeaconTs = this.now();
    if (epoch > this.maxEpoch) this.maxEpoch = epoch;
    if (changed) this.events.masterChanged?.(userId, epoch);
  }
}
