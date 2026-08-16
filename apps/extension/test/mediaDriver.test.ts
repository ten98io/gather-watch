import { describe, expect, it } from 'vitest';
import {
  decideDrive,
  pickMainMedia,
  readTelemetry,
  HARD_SEEK_MS,
} from '../src/mediaDriver';
import type { MediaElementLike } from '../src/mediaDriver';

function fakeEl(over: Partial<MediaElementLike> = {}): MediaElementLike {
  return {
    currentTime: 10,
    duration: 100,
    paused: true,
    playbackRate: 1,
    play: () => undefined,
    pause: () => undefined,
    ...over,
  };
}

describe('pickMainMedia', () => {
  it('picks the largest candidate, or null when empty', () => {
    expect(pickMainMedia([])).toBeNull();
    const picked = pickMainMedia([{ area: 10, id: 'a' }, { area: 50, id: 'b' }, { area: 20, id: 'c' }]);
    expect(picked?.id).toBe('b');
  });
});

describe('readTelemetry', () => {
  it('converts seconds to ms and handles non-finite duration', () => {
    expect(readTelemetry(fakeEl())).toEqual({
      positionMs: 10_000,
      durationMs: 100_000,
      playing: false,
      rate: 1,
    });
    expect(readTelemetry(fakeEl({ duration: Number.NaN })).durationMs).toBe(0);
  });
});

describe('decideDrive', () => {
  it('seeks only past the deadband; hard-seeks past 2 s', () => {
    const el = { positionMs: 10_000, durationMs: 100_000, playing: true, rate: 1 };
    const room = { playing: true, rate: 1 };
    expect(decideDrive(el, 10_100, room).seekToMs).toBeNull(); // 100 ms — inside deadband
    expect(decideDrive(el, 10_600, room).seekToMs).toBe(10_600); // soft band
    expect(decideDrive(el, 10_000 + HARD_SEEK_MS + 1, room).seekToMs).toBe(12_001);
  });

  it('issues play/pause transitions and rate changes', () => {
    const paused = { positionMs: 0, durationMs: 100_000, playing: false, rate: 1 };
    expect(decideDrive(paused, 0, { playing: true, rate: 1 }).action).toBe('play');
    expect(decideDrive(paused, 0, { playing: true, rate: 1.5 }).setRate).toBe(1.5);
    const playing = { ...paused, playing: true };
    expect(decideDrive(playing, 0, { playing: false, rate: 1 }).action).toBe('pause');
    expect(decideDrive(playing, 0, { playing: true, rate: 1 }).action).toBe('none');
  });
});
