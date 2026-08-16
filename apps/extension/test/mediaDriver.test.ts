import { describe, expect, it } from 'vitest';
import {
  AUDIO_NOMINAL_AREA,
  HARD_SEEK_MS,
  LEGACY_BANDS,
  decideDrive,
  expectedPositionMs,
  isPlausibleMain,
  mediaIsUsable,
  parseMetrics,
  pickBestMedia,
  pickMainMedia,
  readTelemetry,
  scoreMedia,
  toMetrics,
} from '../src/mediaDriver';
import type { MediaElementLike, MediaMetrics, MediaProbe } from '../src/mediaDriver';

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

function fakeProbe(over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    tagName: 'VIDEO',
    area: 1280 * 720,
    duration: 3600,
    readyState: 4,
    paused: false,
    muted: false,
    currentSrc: 'blob:https://example.com/abc',
    srcObjectPresent: false,
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

describe('decideDrive with explicit bands', () => {
  const el = { positionMs: 10_000, durationMs: 100_000, playing: true, rate: 1 };
  const room = { playing: true, rate: 1 };

  it('defaults to the legacy fixed thresholds', () => {
    expect(LEGACY_BANDS).toEqual({ deadbandMs: 400, seekThresholdMs: 2000 });
    expect(decideDrive(el, 10_600, room)).toEqual(decideDrive(el, 10_600, room, LEGACY_BANDS));
  });

  it('widens the local fallback to the room band instead of frame-lock', () => {
    const watch = { deadbandMs: 2000, seekThresholdMs: 12_000 };
    expect(decideDrive(el, 11_500, room, watch).seekToMs).toBeNull(); // 1.5 s — ignored
    expect(decideDrive(el, 11_500, room).seekToMs).toBe(11_500); // …frame-lock seeks
    expect(decideDrive(el, 18_000, room, watch).seekToMs).toBe(18_000); // 8 s — corrected
  });

  it('applies only the hard threshold across a play/pause transition', () => {
    const watch = { deadbandMs: 2000, seekThresholdMs: 12_000 };
    const paused = { ...el, playing: false };
    expect(decideDrive(paused, 18_000, room, watch).seekToMs).toBeNull(); // resume, 8 s
    expect(decideDrive(paused, 25_000, room, watch).seekToMs).toBe(25_000); // genuinely lost
  });
});

describe('expectedPositionMs', () => {
  it('projects a playing room forward at its rate', () => {
    const room = { positionMs: 30_000, rate: 1, playing: true, serverTs: 1_000_000 };
    expect(expectedPositionMs(room, 1_000_000)).toBe(30_000);
    expect(expectedPositionMs(room, 1_002_000)).toBe(32_000);
    expect(expectedPositionMs({ ...room, rate: 2 }, 1_002_000)).toBe(34_000);
  });

  it('freezes a paused room at its stored position', () => {
    const room = { positionMs: 30_000, rate: 1, playing: false, serverTs: 1_000_000 };
    expect(expectedPositionMs(room, 1_099_000)).toBe(30_000);
  });
});

describe('toMetrics', () => {
  it('normalises live/unknown durations to 0 and detects sources', () => {
    expect(toMetrics(fakeProbe({ duration: Number.POSITIVE_INFINITY })).durationSec).toBe(0);
    expect(toMetrics(fakeProbe({ duration: Number.NaN })).durationSec).toBe(0);
    expect(toMetrics(fakeProbe({ currentSrc: '', srcObjectPresent: true })).hasSource).toBe(true);
    // MSE players attach nothing until readyState climbs.
    expect(toMetrics(fakeProbe({ currentSrc: '', srcObjectPresent: false, readyState: 2 })).hasSource).toBe(true);
    expect(toMetrics(fakeProbe({ currentSrc: '', srcObjectPresent: false, readyState: 0 })).hasSource).toBe(false);
  });

  it('reads the tag and clamps a negative/NaN area', () => {
    expect(toMetrics(fakeProbe({ tagName: 'AUDIO' })).tag).toBe('audio');
    expect(toMetrics(fakeProbe({ area: Number.NaN })).area).toBe(0);
  });
});

describe('scoreMedia / isPlausibleMain', () => {
  const feature = toMetrics(fakeProbe());

  it('ranks the feature player above ads, previews and hero loops', () => {
    const ad = toMetrics(fakeProbe({ area: 300 * 250, duration: 15, muted: true }));
    const heroLoop = toMetrics(fakeProbe({ area: 1600 * 400, duration: 8, muted: true }));
    const thumbPreview = toMetrics(fakeProbe({ area: 40 * 22, duration: 10, muted: true }));
    expect(scoreMedia(feature)).toBeGreaterThan(scoreMedia(heroLoop));
    expect(scoreMedia(heroLoop)).toBeGreaterThan(scoreMedia(ad));
    expect(isPlausibleMain(thumbPreview)).toBe(false);
  });

  it('does not write off a paused, not-yet-loaded player', () => {
    const cold = toMetrics(fakeProbe({ paused: true, readyState: 0, duration: Number.NaN }));
    expect(isPlausibleMain(cold)).toBe(true);
  });

  it('scores audio elements on a nominal footprint (they are 0×0)', () => {
    const audio = toMetrics(fakeProbe({ tagName: 'AUDIO', area: 0 }));
    expect(scoreMedia(audio)).toBeGreaterThanOrEqual(AUDIO_NOMINAL_AREA);
    expect(isPlausibleMain(audio)).toBe(true);
  });

  it('scores nothing for an empty or invisible element', () => {
    expect(scoreMedia(toMetrics(fakeProbe({ area: 0 })))).toBe(0);
    expect(
      scoreMedia(
        toMetrics(fakeProbe({ currentSrc: '', srcObjectPresent: false, readyState: 0, duration: Number.NaN })),
      ),
    ).toBe(0);
    expect(isPlausibleMain(null)).toBe(false);
  });

  it('keeps a live stream (duration 0) fully eligible', () => {
    const live = toMetrics(fakeProbe({ duration: Number.POSITIVE_INFINITY }));
    expect(isPlausibleMain(live)).toBe(true);
  });
});

describe('pickBestMedia', () => {
  it('picks by score, not raw area', () => {
    const banner = { id: 'banner', metrics: toMetrics(fakeProbe({ area: 2000 * 500, duration: 6, muted: true })) };
    const player = { id: 'player', metrics: toMetrics(fakeProbe({ area: 854 * 480 })) };
    expect(pickBestMedia([banner, player])?.id).toBe('player');
    expect(pickBestMedia([])).toBeNull();
  });
});

describe('parseMetrics', () => {
  it('accepts a well-formed claim and rejects junk from the wire', () => {
    const wire: MediaMetrics = toMetrics(fakeProbe());
    expect(parseMetrics(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
    expect(parseMetrics(null)).toBeNull();
    expect(parseMetrics('video')).toBeNull();
    expect(parseMetrics({ tag: 'iframe', area: 10 })).toBeNull();
  });

  it('coerces non-finite numbers to 0 rather than poisoning the election', () => {
    const parsed = parseMetrics({
      tag: 'video',
      area: Number.POSITIVE_INFINITY,
      durationSec: Number.NaN,
      readyState: '4',
      paused: false,
      muted: true,
      hasSource: true,
    });
    expect(parsed).toEqual({
      tag: 'video',
      area: 0,
      durationSec: 0,
      readyState: 0,
      paused: false,
      muted: true,
      hasSource: true,
    });
  });
});

describe('mediaIsUsable', () => {
  it('rejects a cached element that was swapped out of the document', () => {
    expect(mediaIsUsable({ isConnected: true })).toBe(true);
    expect(mediaIsUsable({ isConnected: false })).toBe(false);
    expect(mediaIsUsable(null)).toBe(false);
  });
});
