/**
 * Mode A player adapters (BUILD_PROMPT architecture rule 6): one imperative
 * interface over HLS(hls.js)/native elements and the YouTube iframe. The sync
 * engine (useSyncEngine) drives whichever adapter is mounted; panes never
 * touch element APIs directly.
 */
import type { MediaRef } from '@playin/contracts';

/** Playback lifecycle events every adapter emits. */
export type AdapterEvent =
  | 'ready' // source loaded, position/duration meaningful
  | 'playing'
  | 'paused'
  | 'ended'
  | 'buffering' // stalled / waiting
  | 'buffered' // recovered from a stall
  | 'durationchange'
  | 'error';

export interface PlayerAdapter {
  /** Which MediaRef kinds this adapter plays. */
  readonly kind: 'native' | 'youtube' | 'soundcloud' | 'vimeo' | 'embed';
  /** Load a ref. 'ready' fires when position/duration are meaningful. */
  load(ref: MediaRef): void;
  play(): void;
  pause(): void;
  seekTo(ms: number): void;
  setRate(rate: number): void;
  positionMs(): number;
  /** 0 while unknown (pre-metadata / YouTube pre-ready). */
  durationMs(): number;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  setVolume(volume: number): void; // 0..1
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
  return 'native';
}

/** True when the adapter kind supports transport + drift correction. */
export function isFullSyncKind(kind: AdapterKind | null): boolean {
  return kind === 'native' || kind === 'youtube' || kind === 'soundcloud' || kind === 'vimeo';
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
