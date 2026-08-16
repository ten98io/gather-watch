/**
 * Stateful drift controller with hysteresis and an optional learned anchor.
 *
 * Strict mode (the default — behaviour unchanged since the first release):
 *   drift = expectedMs - actualMs
 * Elastic mode (`anchorEnabled: true`):
 *   drift = (expectedMs - anchorOffsetMs) - actualMs
 *
 * Positive drift → the client is behind → speed up.
 *
 * The anchor is LEARNED, never configured: the caller feeds observations
 * (`noteBuffering`, `noteTrackChange`, `noteHostSeek`, `noteSettledLag`) and the
 * controller decides when to adopt a stable lag instead of fighting it, decays
 * that lag slowly back toward zero while playback is calm, and hard-caps its
 * magnitude. See docs/EXTENSION_FIRST.md Part 1.
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

/**
 * Elastic extensions. Every one of these is off or neutral by default, so a
 * controller built with no options — or with a plain {@link DriftOptions} —
 * behaves exactly as it always has.
 */
export interface ElasticDriftOptions extends DriftOptions {
  /** Master switch for the learned anchor. Default false (strict sync). */
  anchorEnabled?: boolean;
  /** Hard cap on |anchorOffsetMs|. Default 15000. */
  anchorMaxMs?: number;
  /** Ms of offset shed per second of playback while drift is calm. Default 20
   *  (an 8 s anchor evaporates over ~6.7 minutes, imperceptibly). */
  anchorDecayMsPerSec?: number;
  /** A lag must hold steady this long before it is adopted. Default 3000. */
  anchorAdoptAfterMs?: number;
  /** Sample-to-sample movement (vs the smoothed lag) still counted as "steady". Default 400. */
  anchorStabilityMs?: number;
  /** After this long nudging without release, re-arm adoption *if* the nudge is
   *  demonstrably not converging. 0 disables. Default 8000. */
  anchorRearmAfterMs?: number;
  /** EWMA factor for the settled-lag estimate. Default 0.35. */
  anchorSmoothing?: number;
  /** Convergence target while live voice is active. Default 1000. */
  voiceTargetMs?: number;
  /** Time to ramp fully into the voice-tightened band. Default 2000. */
  voiceAttackMs?: number;
  /** Time to relax fully back to the elastic band after voice stops. Default 8000. */
  voiceReleaseMs?: number;
  /** Suppress the hard-seek escape while voice tightening is in effect. Default true. */
  voiceSuppressSeek?: boolean;
  /** Largest inter-call gap counted as elapsed playback time (tab-sleep guard). Default 2000. */
  maxStepMs?: number;
}

/** Options accepted by {@link DriftController.decide}. */
export interface DriftDecideOptions extends ElasticDriftOptions {
  /** Timestamp of this sample on a monotonic client clock. Defaults to the
   *  controller's clock source. Drives anchor decay and the voice ramp. */
  nowMs?: number;
}

/** Constructor options: elastic tunables plus an injectable clock. */
export interface DriftControllerOptions extends ElasticDriftOptions {
  /** Clock source for calls that omit `nowMs`. Default `Date.now`. */
  now?: () => number;
}

/** Observable controller state (debug HUD, room status chip). */
export interface DriftState {
  /** Current learned offset in ms; positive → this viewer deliberately runs behind. */
  anchorOffsetMs: number;
  /** 0 = full elastic band, 1 = fully tightened for live voice. */
  voiceBlend: number;
  /** True while in the nudging regime. */
  nudging: boolean;
  /** False once the caller reported that playbackRate is not honoured. */
  rateControlAvailable: boolean;
  /** True while the controller is willing to adopt a new anchor. */
  anchorArmed: boolean;
}

interface ResolvedDriftOptions {
  deadbandMs: number;
  releaseMs: number;
  seekThresholdMs: number;
  convergeHorizonMs: number;
  minRate: number;
  maxRate: number;
  anchorEnabled: boolean;
  anchorMaxMs: number;
  anchorDecayMsPerSec: number;
  anchorAdoptAfterMs: number;
  anchorStabilityMs: number;
  anchorRearmAfterMs: number;
  anchorSmoothing: number;
  voiceTargetMs: number;
  voiceAttackMs: number;
  voiceReleaseMs: number;
  voiceSuppressSeek: boolean;
  maxStepMs: number;
}

const DEFAULTS: ResolvedDriftOptions = {
  deadbandMs: 60,
  releaseMs: 20,
  seekThresholdMs: 2000,
  convergeHorizonMs: 10000,
  minRate: 0.95,
  maxRate: 1.05,
  anchorEnabled: false,
  anchorMaxMs: 15000,
  anchorDecayMsPerSec: 20,
  anchorAdoptAfterMs: 3000,
  anchorStabilityMs: 400,
  anchorRearmAfterMs: 8000,
  anchorSmoothing: 0.35,
  voiceTargetMs: 1000,
  voiceAttackMs: 2000,
  voiceReleaseMs: 8000,
  voiceSuppressSeek: true,
  maxStepMs: 2000,
};

/**
 * Frame-lock. The original defaults, kept as a named preset so callers can be
 * explicit about wanting them: 60 ms deadband, 2 s hard seek, ±5% rate.
 * Correct for a single device driving two of its own players; punishing across
 * a room, where any buffering hiccup trips the seek escape.
 */
export const STRICT_SYNC: Readonly<ElasticDriftOptions> = Object.freeze({
  deadbandMs: 60,
  releaseMs: 20,
  seekThresholdMs: 2000,
  convergeHorizonMs: 10000,
  minRate: 0.95,
  maxRate: 1.05,
  anchorEnabled: false,
});

/**
 * Watch rooms. Do nothing below 2 s; seek only when genuinely lost (12 s);
 * correct at most ±3%.
 *
 * A 3% rate change on dialogue is essentially invisible — pitch moves about
 * half a semitone, and speech carries no fixed pitch reference for a listener
 * to compare against. Video therefore gets the wider rate authority and can
 * afford to converge quickly.
 */
export const WATCH_ELASTIC: Readonly<ElasticDriftOptions> = Object.freeze({
  deadbandMs: 2000,
  releaseMs: 500,
  seekThresholdMs: 12000,
  convergeHorizonMs: 10000,
  minRate: 0.97,
  maxRate: 1.03,
  anchorEnabled: true,
  anchorDecayMsPerSec: 20,
});

/**
 * Listen rooms. Tighter deadband and seek threshold than watch (1.5 s / 8 s —
 * music has less to hide behind, and a seek costs a re-buffer), but a far
 * tighter rate clamp: ±1%.
 *
 * WHY LISTEN IS TIGHTER ON RATE AND ON NOTHING ELSE: playback rate moves pitch.
 * A 5% change is nearly a semitone — a listening room would hear the whole
 * track go sharp, and anyone humming along would fight it. Dialogue tolerates
 * the same shift unnoticed. So a listen room converges more slowly (±1% is
 * about a sixth of a semitone, below the threshold most people can name) and
 * leans on the learned anchor to hold the difference instead of correcting it.
 * The anchor also decays more slowly here (10 ms/s), because every millisecond
 * it sheds is paid for with audible rate.
 */
export const LISTEN_ELASTIC: Readonly<ElasticDriftOptions> = Object.freeze({
  deadbandMs: 1500,
  releaseMs: 400,
  seekThresholdMs: 8000,
  convergeHorizonMs: 10000,
  minRate: 0.99,
  maxRate: 1.01,
  anchorEnabled: true,
  anchorDecayMsPerSec: 10,
});

function resolve(base: ResolvedDriftOptions, opts?: ElasticDriftOptions): ResolvedDriftOptions {
  if (!opts) return base;
  return {
    deadbandMs: opts.deadbandMs ?? base.deadbandMs,
    releaseMs: opts.releaseMs ?? base.releaseMs,
    seekThresholdMs: opts.seekThresholdMs ?? base.seekThresholdMs,
    convergeHorizonMs: opts.convergeHorizonMs ?? base.convergeHorizonMs,
    minRate: opts.minRate ?? base.minRate,
    maxRate: opts.maxRate ?? base.maxRate,
    anchorEnabled: opts.anchorEnabled ?? base.anchorEnabled,
    anchorMaxMs: opts.anchorMaxMs ?? base.anchorMaxMs,
    anchorDecayMsPerSec: opts.anchorDecayMsPerSec ?? base.anchorDecayMsPerSec,
    anchorAdoptAfterMs: opts.anchorAdoptAfterMs ?? base.anchorAdoptAfterMs,
    anchorStabilityMs: opts.anchorStabilityMs ?? base.anchorStabilityMs,
    anchorRearmAfterMs: opts.anchorRearmAfterMs ?? base.anchorRearmAfterMs,
    anchorSmoothing: opts.anchorSmoothing ?? base.anchorSmoothing,
    voiceTargetMs: opts.voiceTargetMs ?? base.voiceTargetMs,
    voiceAttackMs: opts.voiceAttackMs ?? base.voiceAttackMs,
    voiceReleaseMs: opts.voiceReleaseMs ?? base.voiceReleaseMs,
    voiceSuppressSeek: opts.voiceSuppressSeek ?? base.voiceSuppressSeek,
    maxStepMs: opts.maxStepMs ?? base.maxStepMs,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Why anchor adoption is currently allowed. */
type ArmReason = 'disturbance' | 'stalemate';

/** Corrects playback drift with a deadband, proportional rate nudges, hysteresis,
 *  and a hard-seek escape for large drift. With `anchorEnabled` it additionally
 *  learns a per-viewer offset and plays smoothly against that instead. */
export class DriftController {
  private readonly opts: ResolvedDriftOptions;
  private readonly clock: () => number;
  private nudging = false;

  // Elastic state.
  private anchor = 0;
  private armed: boolean;
  private armReason: ArmReason = 'disturbance';
  private lastTickMs: number | null = null;
  private windowStartMs: number | null = null;
  private windowStartLag = 0;
  private lagEwma = 0;
  private nudgeGainMs = 0;
  private lastRateDeviation = 0;
  private nudgingSinceMs: number | null = null;
  private voiceActive = false;
  private blend = 0;
  private rateAvailable = true;

  constructor(opts?: DriftControllerOptions) {
    this.opts = resolve(DEFAULTS, opts);
    this.clock = opts?.now ?? Date.now;
    // A fresh controller is at a track start: the first stable lag may be adopted.
    this.armed = true;
  }

  /** Decide the correction for the current instant. `opts` here overrides the
   *  constructor options for this call only. */
  decide(expectedMs: number, actualMs: number, opts?: DriftDecideOptions): DriftAction {
    const o = resolve(this.opts, opts);
    const anchoring = o.anchorEnabled;
    const now = opts?.nowMs ?? this.clock();
    const dt = this.lastTickMs === null ? 0 : clamp(now - this.lastTickMs, 0, o.maxStepMs);
    this.lastTickMs = now;

    // Voice tightening ramps in and out smoothly — never as a step.
    this.blend = this.voiceActive
      ? Math.min(1, this.blend + dt / Math.max(1, o.voiceAttackMs))
      : Math.max(0, this.blend - dt / Math.max(1, o.voiceReleaseMs));
    const tightening = this.voiceActive || this.blend > 0;

    // While voice is live the anchor itself is squeezed toward the voice target:
    // a 1 s band is meaningless if the viewer is anchored 8 s back.
    const ceiling = lerp(o.anchorMaxMs, Math.min(o.anchorMaxMs, o.voiceTargetMs), this.blend);
    if (anchoring && Math.abs(this.anchor) > ceiling) {
      this.anchor = Math.sign(this.anchor) * ceiling;
    }

    const rawDrift = expectedMs - actualMs;
    const deadband = lerp(o.deadbandMs, Math.min(o.deadbandMs, o.voiceTargetMs), this.blend);
    const release = Math.min(o.releaseMs, deadband);

    if (anchoring) {
      this.track(rawDrift, now, dt, o);
      this.maybeAdopt(rawDrift, now, o, deadband, ceiling);
    }

    const anchorInUse = anchoring ? this.anchor : 0;
    const drift = rawDrift - anchorInUse;
    const abs = Math.abs(drift);

    // Consequence B: while people are actually talking we converge with rate only.
    // A seek is the one correction guaranteed to wreck a live reaction.
    const seekAllowed = !(tightening && o.voiceSuppressSeek);

    if (abs > o.seekThresholdMs && seekAllowed) {
      this.stopNudging();
      // The position is about to jump: every lag sample in the window is stale.
      this.resetWindow();
      this.arm('disturbance');
      return { action: 'seek', toMs: Math.max(0, expectedMs - anchorInUse), rate: 1 };
    }

    if (this.nudging) {
      if (abs <= release) {
        this.stopNudging();
        this.decayAnchor(dt, o, anchoring);
        return { action: 'none', rate: 1 };
      }
    } else {
      if (abs <= deadband) {
        this.lastRateDeviation = 0;
        this.decayAnchor(dt, o, anchoring);
        return { action: 'none', rate: 1 };
      }
      this.nudging = true;
      this.nudgingSinceMs = now;
    }

    if (!this.rateAvailable) {
      // The player silently refuses playbackRate (common on DRM): prescribing a
      // nudge forever would be a lie. Sit still and let the anchor absorb the
      // offset; the seek escape above stays the only real correction.
      this.stopNudging();
      return { action: 'none', rate: 1 };
    }

    const rate = clamp(1 + drift / o.convergeHorizonMs, o.minRate, o.maxRate);
    this.lastRateDeviation = Math.abs(rate - 1);
    return { action: 'nudge', rate };
  }

  /** Full reset: hysteresis, learned anchor, settle window and elapsed-time
   *  bookkeeping. Caller-declared modes (voice activity, rate availability) are
   *  deliberately preserved — they describe the room, not the drift. */
  reset(): void {
    this.stopNudging();
    this.anchor = 0;
    this.lastTickMs = null;
    this.windowStartMs = null;
    this.windowStartLag = 0;
    this.lagEwma = 0;
    this.nudgeGainMs = 0;
    this.arm('disturbance');
  }

  /** True while the controller is in the nudging regime. */
  isNudging(): boolean {
    return this.nudging;
  }

  /** Current learned offset in ms (0 when nothing has been adopted). */
  anchorOffsetMs(): number {
    return this.anchor;
  }

  /** Snapshot for debug HUDs and room status. */
  state(): DriftState {
    return {
      anchorOffsetMs: this.anchor,
      voiceBlend: this.blend,
      nudging: this.nudging,
      rateControlAvailable: this.rateAvailable,
      anchorArmed: this.armed,
    };
  }

  // ---- observations the caller feeds in -------------------------------------

  /** A buffering/stall event, a tab wake, or network recovery: whatever lag the
   *  viewer settles at afterwards may be adopted. Keeps the current anchor until
   *  a new one is learned. */
  noteBuffering(): void {
    this.arm('disturbance');
    this.resetWindow();
  }

  /** New track: forget the anchor entirely and learn a fresh one. */
  noteTrackChange(): void {
    this.reanchor();
  }

  /** The host seeked: the old offset says nothing about the new position. */
  noteHostSeek(): void {
    this.reanchor();
  }

  /** Explicitly set the anchor (default 0 = drop it) and re-arm learning. */
  reanchor(offsetMs = 0): void {
    const cap = this.opts.anchorMaxMs;
    this.anchor = clamp(offsetMs, -cap, cap);
    this.stopNudging();
    this.arm('disturbance');
    this.resetWindow();
  }

  /** Report a measured settled lag (positive → this viewer runs behind). Adopted
   *  immediately, capped at `anchorMaxMs`. */
  noteSettledLag(lagMs: number): void {
    if (!Number.isFinite(lagMs)) return;
    const cap = this.opts.anchorMaxMs;
    this.anchor = clamp(lagMs, -cap, cap);
    this.armed = false;
    this.stopNudging();
    this.resetWindow();
  }

  /** Live voice in the room. While true the band tightens toward `voiceTargetMs`
   *  using rate only — never a seek. Going false relaxes back over
   *  `voiceReleaseMs` rather than snapping. */
  setVoiceActive(active: boolean): void {
    this.voiceActive = active;
  }

  /** True while voice tightening is in effect (including the relax tail). */
  isVoiceTightening(): boolean {
    return this.voiceActive || this.blend > 0;
  }

  /** Report whether the player honours playbackRate. When false the controller
   *  stops prescribing nudges, lets the anchor absorb the offset, and corrects
   *  only by seeking past `seekThresholdMs`. */
  setRateControlAvailable(available: boolean): void {
    this.rateAvailable = available;
    if (!available) {
      this.stopNudging();
      this.arm('disturbance');
    }
  }

  /** Convenience for adapters whose `setRate` threw or was ignored. */
  noteRateRejected(): void {
    this.setRateControlAvailable(false);
  }

  // ---- internals ------------------------------------------------------------

  private stopNudging(): void {
    this.nudging = false;
    this.nudgingSinceMs = null;
    this.lastRateDeviation = 0;
  }

  private arm(reason: ArmReason): void {
    this.armed = true;
    this.armReason = reason;
  }

  private resetWindow(): void {
    this.windowStartMs = null;
    this.windowStartLag = 0;
    this.lagEwma = 0;
    this.nudgeGainMs = 0;
  }

  /** Track how steady the raw lag is, and how much ground our own nudging has
   *  been asking for, since the current settle window opened. */
  private track(rawDrift: number, now: number, dt: number, o: ResolvedDriftOptions): void {
    if (this.windowStartMs === null || Math.abs(rawDrift - this.lagEwma) > o.anchorStabilityMs) {
      this.windowStartMs = now;
      this.windowStartLag = rawDrift;
      this.lagEwma = rawDrift;
      this.nudgeGainMs = 0;
    } else {
      // Position the last prescribed rate should have bought us over `dt`.
      this.nudgeGainMs += this.lastRateDeviation * dt;
      this.lagEwma += o.anchorSmoothing * (rawDrift - this.lagEwma);
    }

    // Stalemate: nudging for a long stretch with no release. Re-arm, but the
    // adoption test below still refuses to give up while the nudge is working.
    if (
      !this.armed &&
      o.anchorRearmAfterMs > 0 &&
      this.nudgingSinceMs !== null &&
      now - this.nudgingSinceMs >= o.anchorRearmAfterMs
    ) {
      this.arm('stalemate');
    }
  }

  private maybeAdopt(
    rawDrift: number,
    now: number,
    o: ResolvedDriftOptions,
    deadband: number,
    ceiling: number,
  ): void {
    // With rate control gone there is nothing to fight with, so learning stays open.
    if (!this.armed && this.rateAvailable) return;
    if (this.windowStartMs === null) return;
    if (now - this.windowStartMs < o.anchorAdoptAfterMs) return;

    const candidate = this.lagEwma;
    if (Math.abs(candidate) <= deadband) return;

    if (this.armed && this.armReason === 'stalemate' && this.rateAvailable) {
      const progress = Math.abs(this.windowStartLag) - Math.abs(rawDrift);
      // The nudge is delivering at least half of what it promised → let it work.
      if (this.nudgeGainMs > 0 && progress >= this.nudgeGainMs * 0.5) return;
    }

    this.anchor = clamp(candidate, -ceiling, ceiling);
    this.armed = false;
    this.stopNudging();
    this.windowStartMs = now;
    this.windowStartLag = rawDrift;
    this.nudgeGainMs = 0;
  }

  /** Shed a little of the anchor for every second of calm playback, so a viewer
   *  who fell behind quietly catches up over minutes instead of staying behind
   *  forever. Only runs while inside the band — never while correcting. */
  private decayAnchor(dt: number, o: ResolvedDriftOptions, anchoring: boolean): void {
    if (!anchoring || dt <= 0 || this.anchor === 0) return;
    const step = (o.anchorDecayMsPerSec * dt) / 1000;
    const mag = Math.abs(this.anchor) - step;
    this.anchor = mag <= 0 ? 0 : Math.sign(this.anchor) * mag;
  }
}
