/**
 * MediaDriver — the content script's pure core: pick the page's main media
 * element and translate room sync state into element commands. DOM-touching
 * parts are thin; the decisions are pure and unit-tested.
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

export interface RoomPlaybackLike {
  positionMs: number;
  rate: number;
  playing: boolean;
  /** Server timestamp of the state; the caller converts to an expected
   *  position — the driver never does clock math itself. */
  serverTs: number;
}

/** Pick the "main" media element: the largest visible one by area. Pure
 *  given a pre-measured candidate list (jsdom-free testable). */
export function pickMainMedia<T extends { area: number }>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (best === null || c.area > best.area) best = c;
  }
  return best;
}

export interface DriveDecision {
  seekToMs: number | null;
  setRate: number | null;
  action: 'play' | 'pause' | 'none';
}

/** Deadband before seeking (ms) and the drift that forces a hard seek. */
export const SOFT_DEADBAND_MS = 400;
export const HARD_SEEK_MS = 2000;

/**
 * Decide what to do with the element given the room's expected position.
 * Mirrors sync-core's hysteresis (nudge band is approximated by deadband +
 * hard seek — content scripts don't rate-nudge DRM players, some ignore
 * playbackRate).
 */
export function decideDrive(
  el: MediaTelemetry,
  expectedMs: number,
  room: { playing: boolean; rate: number },
): DriveDecision {
  const drift = expectedMs - el.positionMs;
  let seekToMs: number | null = null;
  if (Math.abs(drift) > HARD_SEEK_MS) {
    seekToMs = expectedMs;
  } else if (Math.abs(drift) > SOFT_DEADBAND_MS && room.playing === el.playing) {
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
  if (d.seekToMs !== null) el.currentTime = Math.max(0, d.seekToMs / 1000);
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
