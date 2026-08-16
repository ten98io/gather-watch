/**
 * Per-link bitrate adaptation: a pure loss/RTT-trend governor decides the
 * target bitrate from normalized stats samples, and a LinkAdaptor drives it
 * from a periodic poll, applying targets to an RTP sender.
 */

import type { ClearTimeoutFn, RtpSenderLike, SetTimeoutFn, TimeoutHandle } from './types';

/** One normalized stats sample for a link (extracted from getStats upstream). */
export interface LinkSample {
  timestampMs: number;
  rttMs: number | null;
  /** Fraction of packets lost over the sample window, 0..1. */
  lossFraction: number | null;
}

/** Options for {@link BitrateGovernor}. */
export interface BitrateGovernorOptions {
  minBps?: number;
  maxBps?: number;
  startBps?: number;
  downFactor?: number;
  upFactor?: number;
  lossDownThreshold?: number;
  lossUpThreshold?: number;
  /** rtt counts as spiking above max(minRttSeen * rttSpikeFactor, minRttSeen + rttSpikePadMs). */
  rttSpikeFactor?: number;
  rttSpikePadMs?: number;
  badSamplesToDrop?: number;
  goodSamplesToRaise?: number;
  /** No upward move within this window after any change (hysteresis). Default 4000. */
  cooldownMs?: number;
}

/**
 * Pure loss/RTT-trend governor: feed samples, get bitrate targets.
 * Multiplicative decrease on consecutive bad samples (loss spike or RTT
 * spike), gentle increase on consecutive good samples behind a cooldown.
 */
export class BitrateGovernor {
  private readonly minBps: number;
  private readonly maxBps: number;
  private readonly startBps: number;
  private readonly downFactor: number;
  private readonly upFactor: number;
  private readonly lossDownThreshold: number;
  private readonly lossUpThreshold: number;
  private readonly rttSpikeFactor: number;
  private readonly rttSpikePadMs: number;
  private readonly badSamplesToDrop: number;
  private readonly goodSamplesToRaise: number;
  private readonly cooldownMs: number;

  private target: number;
  private minRttSeen: number | null = null;
  private badStreak = 0;
  private goodStreak = 0;
  /** timestampMs of the last target change; -Infinity until the first. */
  private lastChange = Number.NEGATIVE_INFINITY;

  constructor(opts?: BitrateGovernorOptions) {
    this.minBps = opts?.minBps ?? 200_000;
    this.maxBps = opts?.maxBps ?? 8_000_000;
    this.startBps = opts?.startBps ?? 2_500_000;
    this.downFactor = opts?.downFactor ?? 0.7;
    this.upFactor = opts?.upFactor ?? 1.15;
    this.lossDownThreshold = opts?.lossDownThreshold ?? 0.05;
    this.lossUpThreshold = opts?.lossUpThreshold ?? 0.01;
    this.rttSpikeFactor = opts?.rttSpikeFactor ?? 1.5;
    this.rttSpikePadMs = opts?.rttSpikePadMs ?? 100;
    this.badSamplesToDrop = opts?.badSamplesToDrop ?? 2;
    this.goodSamplesToRaise = opts?.goodSamplesToRaise ?? 3;
    this.cooldownMs = opts?.cooldownMs ?? 4000;
    this.target = this.startBps;
  }

  /** Returns the NEW target bps when this sample changes it, else null. */
  onSample(s: LinkSample): number | null {
    if (s.rttMs !== null) {
      this.minRttSeen = this.minRttSeen === null ? s.rttMs : Math.min(this.minRttSeen, s.rttMs);
    }
    const rttSpiking =
      s.rttMs !== null &&
      this.minRttSeen !== null &&
      s.rttMs > Math.max(this.minRttSeen * this.rttSpikeFactor, this.minRttSeen + this.rttSpikePadMs);
    const bad = (s.lossFraction !== null && s.lossFraction >= this.lossDownThreshold) || rttSpiking;
    const good =
      (s.lossFraction === null || s.lossFraction <= this.lossUpThreshold) && !rttSpiking;

    if (bad) {
      this.badStreak += 1;
      this.goodStreak = 0;
      if (this.badStreak < this.badSamplesToDrop) return null;
      this.badStreak = 0;
      // Downward moves ignore the cooldown: congestion gets worse fast.
      return this.moveTo(Math.max(this.minBps, Math.round(this.target * this.downFactor)), s.timestampMs);
    }
    if (good) {
      this.goodStreak += 1;
      this.badStreak = 0;
      if (this.goodStreak < this.goodSamplesToRaise) return null;
      if (s.timestampMs - this.lastChange < this.cooldownMs) return null;
      this.goodStreak = 0;
      return this.moveTo(Math.min(this.maxBps, Math.round(this.target * this.upFactor)), s.timestampMs);
    }
    // In-between sample: neither trend survives.
    this.badStreak = 0;
    this.goodStreak = 0;
    return null;
  }

  /** Current target bitrate in bps. */
  targetBps(): number {
    return this.target;
  }

  /** Back to the start bitrate; clears streaks, min-RTT, and cooldown. */
  reset(): void {
    this.target = this.startBps;
    this.minRttSeen = null;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.lastChange = Number.NEGATIVE_INFINITY;
  }

  /** Apply a clamped target; returns null when the clamp made no difference. */
  private moveTo(next: number, timestampMs: number): number | null {
    if (next === this.target) return null;
    this.target = next;
    this.lastChange = timestampMs;
    return next;
  }
}

/** Clamp helper: writes maxBitrate into every encoding of a sender. */
export async function applyMaxBitrate(sender: RtpSenderLike, bps: number): Promise<void> {
  const parameters = sender.getParameters();
  for (const encoding of parameters.encodings) encoding.maxBitrate = bps;
  await sender.setParameters(parameters);
}

/** Undo helper: removes maxBitrate from encodings that still carry EXACTLY
 *  `bps` — a different value belongs to another writer (e.g. the adaptation
 *  governor) and must survive. No-op when nothing matches. */
export async function clearMaxBitrate(sender: RtpSenderLike, bps: number): Promise<void> {
  const parameters = sender.getParameters();
  let changed = false;
  for (const encoding of parameters.encodings) {
    if (encoding.maxBitrate === bps) {
      delete encoding.maxBitrate;
      changed = true;
    }
  }
  if (changed) await sender.setParameters(parameters);
}

/** Options for {@link LinkAdaptor}. */
export interface LinkAdaptorOptions {
  /** Produces a normalized sample per poll (wraps getStats extraction upstream). */
  pollFn: () => Promise<LinkSample>;
  /** Applies a new target, e.g. (bps) => applyMaxBitrate(sender, bps). */
  apply: (bps: number) => void | Promise<void>;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  intervalMs?: number;
  governor?: BitrateGovernor;
  onError?: (err: unknown) => void;
}

/** Drives a BitrateGovernor from a periodic stats poll. */
export class LinkAdaptor {
  private readonly pollFn: () => Promise<LinkSample>;
  private readonly apply: (bps: number) => void | Promise<void>;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly intervalMs: number;
  private readonly governor: BitrateGovernor;
  private readonly onError: (err: unknown) => void;

  private timer: TimeoutHandle | null = null;
  private running = false;

  constructor(opts: LinkAdaptorOptions) {
    this.pollFn = opts.pollFn;
    this.apply = opts.apply;
    this.setTimeoutFn = opts.setTimeoutFn;
    this.clearTimeoutFn = opts.clearTimeoutFn;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.governor = opts.governor ?? new BitrateGovernor();
    this.onError = opts.onError ?? (() => {});
  }

  /** Begin polling every intervalMs. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  /** Stop polling and cancel the pending timer. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  /** The governor this adaptor feeds (inspect/reset the target). */
  governorRef(): BitrateGovernor {
    return this.governor;
  }

  private schedule(): void {
    // Chained setTimeout (no ambient setInterval), scheduled AFTER the tick
    // resolves so a slow poll cannot stack overlapping ticks.
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (this.running && this.timer === null) this.schedule();
      });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      const sample = await this.pollFn();
      const next = this.governor.onSample(sample);
      if (next !== null) await this.apply(next);
    } catch (err) {
      this.onError(err);
    }
  }
}
