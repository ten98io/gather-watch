/**
 * Beacon pipeline: the master broadcasts its clock + playback state at a fixed
 * cadence (and immediately on every mutation); followers feed the beacon
 * timestamps into sync-core's ClockEstimator to get a drift-corrected
 * expected playhead without any server round-trip.
 */

import { ClockEstimator, expectedPositionMs } from '@gather/sync-core';
import type { PlaybackState } from '@gather/contracts';
import type { SyncBeacon, SyncChannelMessage } from './channels';
import type { ClearTimeoutFn, NowFn, SetTimeoutFn, TimeoutHandle } from './types';

/** Playback snapshot carried by a beacon. */
export interface BeaconState {
  positionMs: number;
  rate: number;
  playing: boolean;
}

/** Options for {@link BeaconSender}. */
export interface BeaconSenderOptions {
  /** Typically (msg) => fabric.broadcast('sync', msg). */
  broadcast: (msg: SyncChannelMessage) => void;
  getState: () => BeaconState;
  getEpoch: () => number;
  now: NowFn;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  /** Beacon cadence. Default 1000 (1 Hz). */
  intervalMs?: number;
}

/** Master side: broadcasts sync beacons at 1 Hz and immediately on mutation.
 *
 *  Integration contract: call {@link BeaconSender.stop} SYNCHRONOUSLY from the
 *  election's masterChanged handler when mastership moves elsewhere, and make
 *  `getEpoch` return the epoch of THIS node's own claim (never the global max
 *  epoch) — one late beacon carrying a freshly adopted higher epoch under the
 *  old master's id would resurrect a healed split-brain via the tie-break. */
export class BeaconSender {
  private readonly broadcast: (msg: SyncChannelMessage) => void;
  private readonly getState: () => BeaconState;
  private readonly getEpoch: () => number;
  private readonly now: NowFn;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly intervalMs: number;

  private timer: TimeoutHandle | null = null;

  constructor(opts: BeaconSenderOptions) {
    this.broadcast = opts.broadcast;
    this.getState = opts.getState;
    this.getEpoch = opts.getEpoch;
    this.now = opts.now;
    this.setTimeoutFn = opts.setTimeoutFn;
    this.clearTimeoutFn = opts.clearTimeoutFn;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  /** Begin beaconing: one beacon immediately, then every intervalMs. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.beacon();
    this.schedule();
  }

  /** Stop beaconing and cancel the pending timer. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  /** Playback mutated (play/pause/seek/rate): beacon NOW and restart the cadence. */
  mutate(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.beacon();
    this.schedule();
  }

  /** True while the cadence timer is armed. */
  running(): boolean {
    return this.timer !== null;
  }

  private schedule(): void {
    // Chained setTimeout, not setInterval: there is no ambient setInterval in
    // this package, and chaining keeps the cadence under our control.
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.beacon();
      this.schedule();
    }, this.intervalMs);
  }

  private beacon(): void {
    const state = this.getState();
    this.broadcast({
      t: 'beacon',
      positionMs: state.positionMs,
      rate: state.rate,
      playing: state.playing,
      masterTs: Math.floor(this.now()),
      epoch: this.getEpoch(),
    });
  }
}

/** Options for {@link BeaconFollower}. */
export interface BeaconFollowerOptions {
  now: NowFn;
  /** Injectable for tests; defaults to a fresh ClockEstimator. */
  estimator?: ClockEstimator;
}

/** Follower side: feeds beacon timestamps into sync-core's ClockEstimator and
 *  exposes the drift-corrected expected playhead. */
export class BeaconFollower {
  private readonly now: NowFn;
  private readonly estimator: ClockEstimator;

  private last: SyncBeacon | null = null;
  private lastRecvTs = 0;
  /** Highest beacon epoch accepted so far; lower epochs are stale. */
  private highestEpoch = -1;

  constructor(opts: BeaconFollowerOptions) {
    this.now = opts.now;
    this.estimator = opts.estimator ?? new ClockEstimator();
  }

  /** Ingest a beacon received on the sync channel (stamped with now() on arrival).
   *  Beacons with an epoch lower than the highest seen are stale → ignored. */
  onBeacon(b: SyncBeacon): void {
    if (b.epoch < this.highestEpoch) return;
    this.highestEpoch = b.epoch;
    const recv = this.now();
    // Zero-RTT sample: beacons are one-way, so there is no round trip to
    // halve. The offset therefore absorbs the (small, ~stable) one-way
    // channel latency as a deliberate bias; the estimator's EWMA smooths the
    // jitter around it.
    this.estimator.addSample({ clientSendTs: recv, serverTs: b.masterTs, clientRecvTs: recv });
    this.last = b;
    this.lastRecvTs = recv;
  }

  /** Drift-corrected expected position via sync-core expectedPositionMs; null
   *  before the first accepted beacon. */
  expectedPositionMs(): number | null {
    if (this.last === null) return null;
    const b = this.last;
    // Synthesize the PlaybackState shape sync-core expects: the beacon IS the
    // authoritative state, stamped on the master clock.
    const state: PlaybackState = {
      mediaRef: null,
      queueIndex: null,
      seq: 0,
      serverTs: Math.floor(b.masterTs),
      positionMs: b.positionMs,
      rate: b.rate,
      playing: b.playing,
    };
    return expectedPositionMs(state, this.estimator.serverNow(this.now()));
  }

  /** Estimated (masterClock − localClock) in ms. */
  offsetMs(): number {
    return this.estimator.offsetMs();
  }

  /** Last accepted beacon, or null before the first. */
  lastBeacon(): SyncBeacon | null {
    return this.last;
  }

  /** ms since the last accepted beacon arrived, null before the first. */
  msSinceLastBeacon(): number | null {
    return this.last === null ? null : this.now() - this.lastRecvTs;
  }
}
