/**
 * Mode A player adapters (BUILD_PROMPT architecture rule 6): one imperative
 * interface over HLS(hls.js)/native elements and the YouTube iframe. The sync
 * engine (useSyncEngine) drives whichever adapter is mounted; panes never
 * touch element APIs directly.
 */
import type { MediaRef } from '@gather/contracts';

/**
 * Playback lifecycle events every adapter emits.
 *
 * Contract notes (all adapters, no exceptions):
 *  - `ended` MUST fire when the source runs out, so the room can auto-advance.
 *  - `blocked` MUST fire when the browser refuses a play() we asked for
 *    (autoplay policy). The stage turns it into one "start watching" tap
 *    instead of a silently dead player.
 */
export type AdapterEvent =
  | 'ready' // source loaded, position/duration meaningful
  | 'playing'
  | 'paused'
  | 'ended'
  | 'buffering' // stalled / waiting
  | 'buffered' // recovered from a stall
  | 'blocked' // the browser refused to start playback without a gesture
  | 'durationchange'
  | 'error';

export interface PlayerAdapter {
  /** Which MediaRef kinds this adapter plays. */
  readonly kind: 'native' | 'youtube' | 'soundcloud' | 'vimeo' | 'embed';
  /** Load a ref. 'ready' fires when position/duration are meaningful. */
  load(ref: MediaRef): void;
  play(): void;
  pause(): void;
  /** @param ms MILLISECONDS — every adapter converts to its own unit. */
  seekTo(ms: number): void;
  setRate(rate: number): void;
  /** MILLISECONDS since the start of the source. */
  positionMs(): number;
  /** MILLISECONDS; 0 while unknown (pre-metadata / YouTube pre-ready). */
  durationMs(): number;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  setVolume(volume: number): void; // 0..1
  /**
   * Duck gain, 0..1, applied ON TOP of `setVolume` — see lib/player/ducking.ts.
   * This is the ONE volume input that does not belong to the user, so it is
   * deliberately a second channel rather than a second caller of setVolume:
   * an adapter multiplies the two and writes only the product, which is what
   * makes a duck incapable of moving the user's own setting.
   */
  setDuck(gain: number): void;
  on(evt: AdapterEvent, cb: () => void): () => void;
  destroy(): void;
}

/** Key identifying "which media + which epoch" for hard resyncs. */
export function mediaKey(
  mediaRef: MediaRef | null | undefined,
  seq: number | undefined,
): string {
  if (mediaRef === null || mediaRef === undefined) return 'none';
  const id =
    mediaRef.kind === 'youtube' || mediaRef.kind === 'vimeo'
      ? mediaRef.videoId
      : mediaRef.kind === 'embed'
        ? mediaRef.embedUrl
        : mediaRef.url;
  return `${mediaRef.kind}:${id}:${seq ?? 0}`;
}

export type AdapterKind = 'native' | 'youtube' | 'soundcloud' | 'vimeo' | 'embed';

/** Which adapter plays this ref; null = nothing playable. */
export function adapterKindFor(ref: MediaRef | null): AdapterKind | null {
  if (ref === null) return null;
  if (ref.kind === 'youtube') return 'youtube';
  if (ref.kind === 'soundcloud') return 'soundcloud';
  if (ref.kind === 'vimeo') return 'vimeo';
  if (ref.kind === 'embed') return 'embed';
  // A page ref is a LINK, not media bytes. Only the browser extension can play
  // one (it drives whatever <video>/<audio> the page mounts on that device),
  // and when the extension drives, this function is never reached — StagePane
  // nulls the adapter kind first. So reaching here means "no extension on this
  // device", and the honest answer is the one this function already documents:
  // nothing playable. Falling through to 'native' instead would point a
  // <video> at an HTML document and, because isFullSyncKind('native') is true,
  // run the drift engine against a player that can never load.
  if (ref.kind === 'page') return null;
  return 'native';
}

/** True when the adapter kind supports transport + drift correction. */
export function isFullSyncKind(kind: AdapterKind | null): boolean {
  return kind === 'native' || kind === 'youtube' || kind === 'soundcloud' || kind === 'vimeo';
}

/**
 * What the stage's click shield is showing over the provider surface
 * (UX_OVERHAUL B2 — exactly one play affordance at a time):
 *  - 'none'    → the shield is transparent; it only swallows pointer events so
 *                the provider's own overlay can never be clicked.
 *  - 'paused'  → the room is paused; our backdrop covers the provider's centre
 *                overlay and shows the single centre play ring.
 *  - 'blocked' → the room is playing but this browser refused to start; the
 *                one affordance is "start watching/listening together".
 */
export type StageGate = 'none' | 'paused' | 'blocked';

/** Pure gate decision, so the stage's overlay rules stay testable. */
export function stageGate(input: {
  /** A full-sync provider surface is on screen (shield mounted). */
  active: boolean;
  /** Room-authoritative: playback should be running. */
  wantsPlay: boolean;
  /** This device's player reports it is actually running. */
  localPlaying: boolean;
  /** play() was refused, or never started long after we asked. */
  blocked: boolean;
}): StageGate {
  if (!input.active) return 'none';
  if (!input.wantsPlay) return 'paused';
  if (!input.localPlaying && input.blocked) return 'blocked';
  return 'none';
}

/** True when the ref's bytes are HLS (m3u8) rather than progressive. */
export function isHlsRef(ref: Extract<MediaRef, { kind: 'hls' | 'url' }>): boolean {
  if (ref.kind === 'hls') return true;
  return (
    ref.mime === 'application/x-mpegURL' ||
    ref.mime === 'application/vnd.apple.mpegurl' ||
    ref.url.split('?')[0]?.toLowerCase().endsWith('.m3u8') === true
  );
}
