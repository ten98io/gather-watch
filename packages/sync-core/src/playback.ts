import type { PlaybackState } from '@playin/contracts';

/** Where the media should be right now given an authoritative state and the current
 *  server-clock time. Paused → positionMs. Playing → positionMs + (serverNowTs - serverTs) * rate,
 *  clamped to >= 0. */
export function expectedPositionMs(state: PlaybackState, serverNowTs: number): number {
  if (!state.playing) return state.positionMs;
  return Math.max(0, state.positionMs + (serverNowTs - state.serverTs) * state.rate);
}

/** True when `next` should replace `prev` (prev is null, or next.seq > prev.seq). */
export function isNewer(prev: PlaybackState | null, next: PlaybackState): boolean {
  return prev === null || next.seq > prev.seq;
}

/** Seq-guarded merge: returns `next` when it is newer, otherwise returns `prev`
 *  unchanged (stale and duplicate seq are ignored). */
export function applyServerState(
  prev: PlaybackState | null,
  next: PlaybackState,
): PlaybackState {
  return prev === null || next.seq > prev.seq ? next : prev;
}
