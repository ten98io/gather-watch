/**
 * Stateful drift controller with hysteresis.
 * drift = expectedMs - actualMs (positive → client is behind → speed up).
 */

/** The correction the player should apply at the current instant. */
export type DriftAction =
  | { action: 'none'; rate: 1 }
  | { action: 'nudge'; rate: number }
  | { action: 'seek'; toMs: number; rate: 1 };

/** Tunables for the drift controller. */
export interface DriftOptions {
  /** No correction while |drift| <= this and not already nudging. Default 60. */
  deadbandMs?: number;
  /** Once nudging, keep nudging until |drift| <= this (hysteresis). Default 20. */
  releaseMs?: number;
  /** |drift| beyond this → hard seek. Default 2000. */
  seekThresholdMs?: number;
  /** Proportional gain horizon: nudge rate = 1 + drift/horizon (pre-clamp). Default 10000. */
  convergeHorizonMs?: number;
  /** Rate clamp bounds. Defaults 0.95 / 1.05. */
  minRate?: number;
  maxRate?: number;
}

interface ResolvedDriftOptions {
  deadbandMs: number;
  releaseMs: number;
  seekThresholdMs: number;
  convergeHorizonMs: number;
  minRate: number;
  maxRate: number;
}

const DEFAULTS: ResolvedDriftOptions = {
  deadbandMs: 60,
  releaseMs: 20,
  seekThresholdMs: 2000,
  convergeHorizonMs: 10000,
  minRate: 0.95,
  maxRate: 1.05,
};

function resolve(base: ResolvedDriftOptions, opts?: DriftOptions): ResolvedDriftOptions {
  if (!opts) return base;
  return {
    deadbandMs: opts.deadbandMs ?? base.deadbandMs,
    releaseMs: opts.releaseMs ?? base.releaseMs,
    seekThresholdMs: opts.seekThresholdMs ?? base.seekThresholdMs,
    convergeHorizonMs: opts.convergeHorizonMs ?? base.convergeHorizonMs,
    minRate: opts.minRate ?? base.minRate,
    maxRate: opts.maxRate ?? base.maxRate,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Corrects playback drift with a deadband, proportional rate nudges, hysteresis,
 *  and a hard-seek escape for large drift. */
export class DriftController {
  private readonly opts: ResolvedDriftOptions;
  private nudging = false;

  constructor(opts?: DriftOptions) {
    this.opts = resolve(DEFAULTS, opts);
  }

  /** Decide the correction for the current instant. `opts` here overrides the
   *  constructor options for this call only. */
  decide(expectedMs: number, actualMs: number, opts?: DriftOptions): DriftAction {
    const o = resolve(this.opts, opts);
    const drift = expectedMs - actualMs;
    const abs = Math.abs(drift);

    if (abs > o.seekThresholdMs) {
      this.nudging = false;
      return { action: 'seek', toMs: Math.max(0, expectedMs), rate: 1 };
    }

    if (this.nudging) {
      if (abs <= o.releaseMs) {
        this.nudging = false;
        return { action: 'none', rate: 1 };
      }
    } else {
      if (abs <= o.deadbandMs) {
        return { action: 'none', rate: 1 };
      }
      this.nudging = true;
    }

    const rate = clamp(1 + drift / o.convergeHorizonMs, o.minRate, o.maxRate);
    return { action: 'nudge', rate };
  }

  /** Forget hysteresis state (e.g. after a track change). */
  reset(): void {
    this.nudging = false;
  }

  /** True while the controller is in the nudging regime. */
  isNudging(): boolean {
    return this.nudging;
  }
}
