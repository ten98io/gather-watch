/**
 * Ducking — the content steps back while somebody is actually talking, and
 * comes back when they stop.
 *
 * The original build spec named this and it was never built (that spec is gone;
 * docs/history/README.md says where): a room full
 * of people watching something loud has to choose between hearing the film and
 * hearing each other, and today it chooses by hand, every time, with the
 * volume slider.
 *
 * ── THE NUMBERS, AND WHY THESE ONES ────────────────────────────────────────
 *
 * TARGET 0.35 (≈ −9 dB). Broadcast voice-overs duck the bed by 9–15 dB. The
 * shallow end of that range is right here, because the thing being ducked is
 * not a bed — it is the thing everyone came to watch. −9 dB is enough for
 * conversational speech to sit clearly on top of a loud mix while the film is
 * still audibly playing; go to −15 dB and every remark mutes the room, which
 * is the behaviour people already work around by turning the film down and
 * leaving it down.
 *
 * ATTACK 120 ms. It has to be under the ear's ~200 ms window for hearing two
 * events as one, or the duck is heard as a separate thing that happened after
 * the word rather than as room for it. It must not be much faster either:
 * CallSurface's detector polls at 150 ms, so anything below that resolution is
 * precision we do not have, and an instantaneous gain step is an audible click.
 *
 * HOLD 400 ms, RELEASE 900 ms. This pair is the anti-pumping guarantee, and it
 * is why the envelope exists at all instead of `setVolume(speaking ? 0.35 : 1)`.
 * Ordinary speech has gaps: 50–200 ms between words, 200–500 ms between
 * clauses, and the detector reports every one of them as "stopped". A bare
 * boolean would therefore swing the film's volume several times per sentence —
 * far more distracting than never ducking. HOLD keeps the duck flat through
 * every gap short enough to be part of the same sentence. RELEASE then takes
 * nearly a second to give the level back, so even the end of a sentence reads
 * as the film fading back up rather than as a jump. Total round trip on a
 * genuine pause: ~1.3 s.
 *
 * ── THE MULTIPLIER GUARANTEE ───────────────────────────────────────────────
 *
 * A user's own volume choice is sacred: ducking may only scale it. That is not
 * enforced by convention here, it is enforced by structure — {@link VolumeMixer}
 * keeps the user's setting and the duck gain in two separate fields, and
 * `setDuck` cannot write the user's field. The only value that ever reaches a
 * real player is the product. So the slider's position is still the slider's
 * position mid-duck; releasing the duck restores exactly what the user chose,
 * because it was never overwritten; and dragging the slider while ducked sets
 * the value the duck will release TO. Mute is a third, independent field for
 * the players that have no mute of their own, and it wins outright: no duck
 * gain can make a muted player audible.
 */
import type { PlayerAdapter } from './adapter';
import { subscribeSpeechActive } from './room-audio';

/** Gain the content is scaled to while a peer is speaking (≈ −9 dB). */
export const DUCK_TARGET = 0.35;
/** Time to ramp fully down. Fast — see the header. */
export const DUCK_ATTACK_MS = 120;
/** Silence tolerated inside one sentence before the release starts. */
export const DUCK_HOLD_MS = 400;
/** Time to ramp fully back up. Slow — see the header. */
export const DUCK_RELEASE_MS = 900;
/** How often the envelope is applied while it is moving. */
export const DUCK_TICK_MS = 50;
/**
 * Largest gap counted as elapsed time. A backgrounded tab resumes with minutes
 * on the clock; without this the first tick back would be a gain step, which is
 * exactly the click the ramps exist to avoid.
 */
const DUCK_MAX_STEP_MS = 1_000;

export interface DuckEnvelopeOptions {
  target?: number | undefined;
  attackMs?: number | undefined;
  holdMs?: number | undefined;
  releaseMs?: number | undefined;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

/**
 * Attack / hold / release envelope over a boolean "somebody is speaking".
 * Pure and clock-injected: every method takes the current time, so the ramps
 * are testable without waiting for them.
 */
export class DuckEnvelope {
  private readonly target: number;
  private readonly attackMs: number;
  private readonly holdMs: number;
  private readonly releaseMs: number;

  private level = 1;
  private speaking = false;
  private lastStepMs: number | null = null;
  private speechEndedMs: number | null = null;

  constructor(opts: DuckEnvelopeOptions = {}) {
    this.target = clamp01(opts.target ?? DUCK_TARGET);
    this.attackMs = Math.max(1, opts.attackMs ?? DUCK_ATTACK_MS);
    this.holdMs = Math.max(0, opts.holdMs ?? DUCK_HOLD_MS);
    this.releaseMs = Math.max(1, opts.releaseMs ?? DUCK_RELEASE_MS);
  }

  /** Report the speech detector's current answer. */
  setSpeaking(active: boolean, nowMs: number): void {
    // Settle the ramp up to this instant BEFORE the edge, or the time spent in
    // the previous state is silently credited to the new one.
    this.step(nowMs);
    if (active === this.speaking) return;
    this.speaking = active;
    this.speechEndedMs = active ? null : nowMs;
  }

  /** Advance the envelope to `nowMs` and return the gain to apply. */
  step(nowMs: number): number {
    if (this.lastStepMs === null) {
      this.lastStepMs = nowMs;
      return this.level;
    }
    const dt = Math.min(Math.max(0, nowMs - this.lastStepMs), DUCK_MAX_STEP_MS);
    this.lastStepMs = nowMs;
    const span = 1 - this.target;
    if (this.speaking) {
      this.level = Math.max(this.target, this.level - (span * dt) / this.attackMs);
    } else if (this.speechEndedMs !== null && nowMs - this.speechEndedMs < this.holdMs) {
      // Hold: a gap this short is part of the sentence, not the end of it.
    } else {
      this.level = Math.min(1, this.level + (span * dt) / this.releaseMs);
    }
    return this.level;
  }

  /** Current gain without advancing. */
  gain(): number {
    return this.level;
  }

  /** True when the envelope has nothing left to do until the next edge. */
  settled(): boolean {
    if (this.speaking) return this.level <= this.target;
    return this.level >= 1;
  }
}

/**
 * The user's volume, the duck gain and mute, kept apart on purpose — see the
 * multiplier guarantee in the header. Every adapter mixes through one of these
 * and writes only {@link effective} to its underlying player.
 */
export class VolumeMixer {
  private user = 1;
  private duck = 1;
  private muted = false;

  /** The user moved the slider. The ONLY writer of the user's setting. */
  setUserVolume(volume: number): void {
    this.user = clamp01(volume);
  }

  /** What the user chose, untouched by any duck. */
  userVolume(): number {
    return this.user;
  }

  /** Ducking. Cannot reach the user's setting from here — that is the point. */
  setDuck(gain: number): void {
    this.duck = clamp01(gain);
  }

  duckGain(): number {
    return this.duck;
  }

  /** For players whose only mute is "volume 0"; independent of both above. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** The one value that reaches the player. */
  effective(): number {
    return this.muted ? 0 : this.user * this.duck;
  }
}

/** Test seam so a suite can drive the envelope without real time. */
export interface ContentDuckingOptions {
  now?: (() => number) | undefined;
  envelope?: DuckEnvelopeOptions | undefined;
}

/**
 * Drives one adapter's duck gain from the room's SPEECH signal.
 *
 * Called from useSyncEngine, which is already the one place that owns "apply
 * what the room is doing to the mounted adapter" — and which receives exactly
 * the adapters that have a volume to duck.
 *
 * The teardown restores unity gain. That is not tidiness: leaving on the last
 * ducked value when the call surface goes away is a room whose film is quietly
 * at 35% with no speech to explain it and no control that says so.
 */
export function attachContentDucking(
  adapter: PlayerAdapter,
  opts: ContentDuckingOptions = {},
): () => void {
  const now = opts.now ?? Date.now;
  const envelope = new DuckEnvelope(opts.envelope ?? {});
  let handle: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (handle === null) return;
    clearInterval(handle);
    handle = null;
  };

  const apply = (): void => {
    adapter.setDuck(envelope.step(now()));
    if (envelope.settled()) stop();
  };

  const off = subscribeSpeechActive((active) => {
    envelope.setSpeaking(active, now());
    // Apply on the same beat the signal arrived, then let the ticker ramp.
    adapter.setDuck(envelope.gain());
    if (!envelope.settled() && handle === null) {
      handle = setInterval(apply, DUCK_TICK_MS);
    }
  });

  return () => {
    off();
    stop();
    adapter.setDuck(1);
  };
}
