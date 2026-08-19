/**
 * MediaDriver — the content script's pure core: measure media elements, pick
 * the frame's main one, and translate room sync state into element commands.
 * DOM-touching parts live in content.ts; everything decided here is pure and
 * unit-tested (this module must stay import-free of chrome/DOM globals).
 */

/** Minimal media-element surface the driver needs (HTMLMediaElement-shaped). */
export interface MediaElementLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  play(): Promise<void> | void;
  pause(): void;
}

export interface MediaTelemetry {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  rate: number;
}

// ---------------------------------------------------------------------------
// WHERE THE ROOM SHOULD BE RIGHT NOW is deliberately NOT here. This module
// carried its own `expectedPositionMs` and it had drifted from the one in
// packages/sync-core/src/playback.ts: the copy was missing that one's
// `Math.max(0, …)` floor, so a client whose clock runs behind the server's —
// every client, until the offset estimator settles — projected the room to a
// NEGATIVE position. Two spellings of the room's own clock math is one too
// many, and the copy is the one that goes: background.ts imports sync-core's.
// ---------------------------------------------------------------------------

/** Pick the "main" media element: the largest visible one by area. Pure
 *  given a pre-measured candidate list (jsdom-free testable). Kept as the
 *  base heuristic; `pickBestMedia` layers plausibility on top of it. */
export function pickMainMedia<T extends { area: number }>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (best === null || c.area > best.area) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Plausibility: is this element the page's *content*, or site chrome?
// ---------------------------------------------------------------------------

export type MediaTag = 'video' | 'audio';

/** What a frame measures for one media element, and reports upward. */
export interface MediaMetrics {
  tag: MediaTag;
  /** Visible area in CSS px² (0 when hidden or zero-sized). */
  area: number;
  /** Seconds; 0 when unknown or non-finite (live streams report Infinity). */
  durationSec: number;
  /** HTMLMediaElement.readyState, 0–4. */
  readyState: number;
  paused: boolean;
  muted: boolean;
  /** A src/currentSrc/srcObject is attached (MSE blobs count). */
  hasSource: boolean;
}

/** Raw element readings, before normalisation. content.ts fills this in. */
export interface MediaProbe {
  /** 'VIDEO' | 'AUDIO' (any case). */
  tagName: string;
  area: number;
  /** Seconds; may be NaN (unknown) or Infinity (live). */
  duration: number;
  readyState: number;
  paused: boolean;
  muted: boolean;
  currentSrc: string;
  /** true when srcObject holds a MediaStream/MediaSource. */
  srcObjectPresent: boolean;
}

/** `<audio>` is typically 0×0; give it a nominal footprint so a real audio
 *  player is not beaten by a decorative muted background video. */
export const AUDIO_NOMINAL_AREA = 320 * 180;
/** Below this, a clip is a bumper/ad/preview loop, not the feature. */
export const MIN_MAIN_DURATION_SEC = 30;
/** Score floor for "this frame plausibly holds the player". */
export const MIN_CLAIM_SCORE = 4_000;

/** Normalise raw readings into comparable metrics. */
export function toMetrics(p: MediaProbe): MediaMetrics {
  const finiteDuration = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
  return {
    tag: p.tagName.toLowerCase() === 'audio' ? 'audio' : 'video',
    area: Number.isFinite(p.area) && p.area > 0 ? p.area : 0,
    durationSec: finiteDuration,
    readyState: Number.isFinite(p.readyState) ? p.readyState : 0,
    paused: p.paused,
    muted: p.muted,
    hasSource: p.currentSrc.length > 0 || p.srcObjectPresent || p.readyState > 0,
  };
}

/**
 * How likely this element is the page's main media. Area is the base (the
 * original heuristic); duration, readiness and play-state are multipliers, so
 * a 40×22 muted hover-preview never outranks a paused feature player.
 */
export function scoreMedia(m: MediaMetrics): number {
  if (!m.hasSource && m.readyState === 0 && m.durationSec === 0) return 0;
  const footprint = m.tag === 'audio' ? Math.max(m.area, AUDIO_NOMINAL_AREA) : m.area;
  if (footprint <= 0) return 0;
  let score = footprint;
  if (m.durationSec >= MIN_MAIN_DURATION_SEC) score *= 2;
  else if (m.durationSec > 0) score *= 0.5;
  if (m.readyState >= 2) score *= 1.5; // HAVE_CURRENT_DATA — actually decoding
  if (!m.paused) score *= 2;
  // Muted + short = background art loop, whatever its size.
  if (m.muted && m.durationSec > 0 && m.durationSec < MIN_MAIN_DURATION_SEC) score *= 0.5;
  return score;
}

/** Does this frame hold something worth electing as the room's player? */
export function isPlausibleMain(m: MediaMetrics | null): boolean {
  return m !== null && scoreMedia(m) >= MIN_CLAIM_SCORE;
}

/** Highest-scoring candidate (falls back to null when nothing is plausible). */
export function pickBestMedia<T extends { metrics: MediaMetrics }>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = scoreMedia(c.metrics);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Defensive parse of metrics that crossed the extension message boundary. */
export function parseMetrics(raw: unknown): MediaMetrics | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (r['tag'] !== 'audio' && r['tag'] !== 'video') return null;
  return {
    tag: r['tag'],
    area: num(r['area']),
    durationSec: num(r['durationSec']),
    readyState: num(r['readyState']),
    paused: r['paused'] !== false,
    muted: r['muted'] === true,
    hasSource: r['hasSource'] === true,
  };
}

/** A cached element is only reusable while it is still in the document —
 *  SPA routers swap the `<video>` in place and keep the old node detached. */
export function mediaIsUsable(el: { isConnected: boolean } | null): boolean {
  return el !== null && el.isConnected;
}

// ---------------------------------------------------------------------------
// Drive decisions
// ---------------------------------------------------------------------------

export interface DriveDecision {
  seekToMs: number | null;
  setRate: number | null;
  action: 'play' | 'pause' | 'none';
}

/**
 * Deadband before seeking (ms) and the drift that forces a hard seek.
 *
 * THESE ARE FRAME-LOCK NUMBERS and they are no longer the room's policy —
 * docs/EXTENSION_FIRST.md Part 1 rejects them: 400 ms fights every buffering
 * hiccup and a 2 s hard seek is precisely the correction that wrecks perceived
 * quality. The elastic bands (2 s / 12 s watch, 1.5 s / 8 s listen, with a
 * learned per-viewer anchor) live in `driver.ts`, which drives this function
 * from the background worker.
 *
 * They survive as the LOCAL FALLBACK: when the background has no telemetry to
 * reason with — a freshly loaded tab, a revived service worker — the content
 * script still has to do something sane on its own, and these are the numbers
 * it does it with.
 */
export const SOFT_DEADBAND_MS = 400;
export const HARD_SEEK_MS = 2000;

/** Correction thresholds. See {@link SOFT_DEADBAND_MS} for why the defaults
 *  are not the room's policy. */
export interface DriveBands {
  /** Below this drift, do nothing at all. */
  deadbandMs: number;
  /** Beyond this drift, seek. */
  seekThresholdMs: number;
}

/** The fixed thresholds this module has always used. */
export const LEGACY_BANDS: Readonly<DriveBands> = Object.freeze({
  deadbandMs: SOFT_DEADBAND_MS,
  seekThresholdMs: HARD_SEEK_MS,
});

/**
 * Decide what to do with the element given the room's expected position.
 *
 * Pure and unchanged in behaviour: called with three arguments it uses the
 * legacy fixed bands. `bands` lets a caller that has an elastic decision to
 * honour (driver.ts) pass the room's real tolerances instead.
 */
export function decideDrive(
  el: MediaTelemetry,
  expectedMs: number,
  room: { playing: boolean; rate: number },
  bands: DriveBands = LEGACY_BANDS,
): DriveDecision {
  const drift = expectedMs - el.positionMs;
  let seekToMs: number | null = null;
  if (Math.abs(drift) > bands.seekThresholdMs) {
    seekToMs = expectedMs;
  } else if (Math.abs(drift) > bands.deadbandMs && room.playing === el.playing) {
    // Soft band: only correct when not mid play/pause transition.
    seekToMs = expectedMs;
  }
  return {
    seekToMs,
    setRate: el.rate !== room.rate ? room.rate : null,
    action: room.playing && el.playing ? 'none' : room.playing ? 'play' : el.playing ? 'pause' : 'none',
  };
}

/** Read telemetry from a live element. */
export function readTelemetry(el: MediaElementLike): MediaTelemetry {
  return {
    positionMs: el.currentTime * 1000,
    durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : 0,
    playing: !el.paused,
    rate: el.playbackRate,
  };
}

/** Apply a decision to a live element. */
export function applyDecision(el: MediaElementLike, d: DriveDecision): void {
  if (d.seekToMs !== null) {
    try {
      el.currentTime = Math.max(0, d.seekToMs / 1000);
    } catch {
      // Some players reject a currentTime write outright (a live edge with no
      // seekable range, a DRM element mid-licence) — and an unguarded throw
      // here would carry off the play/pause below with it, so a refused seek
      // would silently cost the room its transport too.
    }
  }
  if (d.setRate !== null) {
    try {
      el.playbackRate = d.setRate;
    } catch {
      // Some DRM players reject playbackRate — seek corrections still work.
    }
  }
  if (d.action === 'play') void el.play()?.catch?.(() => undefined);
  else if (d.action === 'pause') el.pause();
}
