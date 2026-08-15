import { describe, it, expect } from 'vitest';
import { expectedPositionMs, applyServerState, isNewer } from '../src/playback';
import { makeState } from './fixtures';

describe('expectedPositionMs', () => {
  it('returns positionMs for a paused state regardless of serverNowTs', () => {
    const state = makeState({ playing: false, positionMs: 5000, serverTs: 1000 });
    expect(expectedPositionMs(state, 1000)).toBe(5000);
    expect(expectedPositionMs(state, 999_999)).toBe(5000);
    expect(expectedPositionMs(state, 0)).toBe(5000);
  });

  it('advances 1:1 with (serverNowTs - serverTs) at rate 1', () => {
    const state = makeState({ positionMs: 1000, serverTs: 500, rate: 1 });
    expect(expectedPositionMs(state, 2000)).toBe(2500);
  });

  it('scales the elapsed time by rate 2 and 0.5', () => {
    const fast = makeState({ positionMs: 1000, serverTs: 500, rate: 2 });
    expect(expectedPositionMs(fast, 2000)).toBe(4000);
    const slow = makeState({ positionMs: 1000, serverTs: 500, rate: 0.5 });
    expect(expectedPositionMs(slow, 2000)).toBe(1750);
  });

  it('clamps negative elapsed time at 0', () => {
    const state = makeState({ positionMs: 0, serverTs: 5000, rate: 1 });
    expect(expectedPositionMs(state, 1000)).toBe(0);
    // Partial clamp: 100 + (1000 - 5000) < 0 → 0 as well.
    const low = makeState({ positionMs: 100, serverTs: 5000, rate: 1 });
    expect(expectedPositionMs(low, 1000)).toBe(0);
  });
});

describe('applyServerState / isNewer', () => {
  it('accepts the first state when prev is null', () => {
    const next = makeState({ seq: 1 });
    expect(applyServerState(null, next)).toBe(next);
    expect(isNewer(null, next)).toBe(true);
  });

  it('ignores a duplicate seq (same reference returned)', () => {
    const prev = makeState({ seq: 5, positionMs: 100 });
    const next = makeState({ seq: 5, positionMs: 999 });
    expect(applyServerState(prev, next)).toBe(prev);
    expect(isNewer(prev, next)).toBe(false);
  });

  it('ignores a stale (lower) seq', () => {
    const prev = makeState({ seq: 5, positionMs: 100 });
    const next = makeState({ seq: 4, positionMs: 999 });
    expect(applyServerState(prev, next)).toBe(prev);
    expect(isNewer(prev, next)).toBe(false);
  });

  it('accepts a newer (higher) seq', () => {
    const prev = makeState({ seq: 5, positionMs: 100 });
    const next = makeState({ seq: 6, positionMs: 999 });
    expect(applyServerState(prev, next)).toBe(next);
    expect(isNewer(prev, next)).toBe(true);
  });
});
