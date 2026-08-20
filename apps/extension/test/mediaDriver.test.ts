import { describe, expect, it } from 'vitest';
import {
  AUDIO_NOMINAL_AREA,
  HARD_SEEK_MS,
  LEGACY_BANDS,
  applyDecision,
  decideDrive,
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
    volume: 1,
    muted: false,
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
      volume: 1,
      muted: false,
    });
    expect(readTelemetry(fakeEl({ duration: Number.NaN })).durationMs).toBe(0);
  });

  it('clamps the volume to a finite 0..1 and reads muted honestly', () => {
    expect(readTelemetry(fakeEl({ volume: 0.4, muted: true }))).toMatchObject({
      volume: 0.4,
      muted: true,
    });
    // A player can report anything; a fraction outside 0..1 is not a volume.
    expect(readTelemetry(fakeEl({ volume: 1.5 })).volume).toBe(1);
    expect(readTelemetry(fakeEl({ volume: -0.2 })).volume).toBe(0);
    // 1 is the element default and the honest reading for a broken one.
    expect(readTelemetry(fakeEl({ volume: Number.NaN })).volume).toBe(1);
  });
});

describe('decideDrive', () => {
  it('seeks only past the deadband; hard-seeks past 2 s', () => {
    const el = { positionMs: 10_000, durationMs: 100_000, playing: true, rate: 1, volume: 1, muted: false };
    const room = { playing: true, rate: 1 };
    expect(decideDrive(el, 10_100, room).seekToMs).toBeNull(); // 100 ms — inside deadband
    expect(decideDrive(el, 10_600, room).seekToMs).toBe(10_600); // soft band
    expect(decideDrive(el, 10_000 + HARD_SEEK_MS + 1, room).seekToMs).toBe(12_001);
  });

  it('issues play/pause transitions and rate changes', () => {
    const paused = { positionMs: 0, durationMs: 100_000, playing: false, rate: 1, volume: 1, muted: false };
    expect(decideDrive(paused, 0, { playing: true, rate: 1 }).action).toBe('play');
    expect(decideDrive(paused, 0, { playing: true, rate: 1.5 }).setRate).toBe(1.5);
    const playing = { ...paused, playing: true };
    expect(decideDrive(playing, 0, { playing: false, rate: 1 }).action).toBe('pause');
    expect(decideDrive(playing, 0, { playing: true, rate: 1 }).action).toBe('none');
  });

  /**
   * Volume is per-viewer LOCAL state. Whatever the drift, whatever the
   * transport, sync never prescribes a volume or a mute — the only writer is
   * the viewer's own overlay, through the 'setAudio' path.
   */
  it('never prescribes volume or mute, whatever the element reports', () => {
    const el = { positionMs: 10_000, durationMs: 100_000, playing: true, rate: 1, volume: 0.2, muted: true };
    for (const expected of [10_000, 10_600, 40_000]) {
      const decision = decideDrive(el, expected, { playing: false, rate: 1.5 });
      expect(decision.setVolume).toBeUndefined();
      expect(decision.setMuted).toBeUndefined();
    }
  });
});

describe('decideDrive with explicit bands', () => {
  const el = { positionMs: 10_000, durationMs: 100_000, playing: true, rate: 1, volume: 1, muted: false };
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

/**
 * Applying a decision to a player that refuses part of it.
 *
 * A driver does not own the player it corrects, so every assignment is a
 * request: DRM elements throw on `playbackRate`, and an element with no
 * seekable range (a live edge, a source still loading) throws on
 * `currentTime`. What must survive either refusal is the ROOM'S TRANSPORT —
 * play and pause are the host's intent and are never subject to any band.
 */
describe('applyDecision', () => {
  /** A player that throws on one assignment and works normally otherwise. */
  function player(refuses: 'currentTime' | 'playbackRate' | 'volume' | 'muted' | null): {
    el: MediaElementLike;
    log: string[];
  } {
    const log: string[] = [];
    let time = 10;
    let rate = 1;
    let volume = 1;
    let muted = false;
    const el: MediaElementLike = {
      get currentTime() {
        return time;
      },
      set currentTime(v: number) {
        if (refuses === 'currentTime') throw new Error('no seekable range');
        time = v;
        log.push(`seek:${v}`);
      },
      duration: 100,
      paused: true,
      get playbackRate() {
        return rate;
      },
      set playbackRate(v: number) {
        if (refuses === 'playbackRate') throw new Error('rate is not settable');
        rate = v;
        log.push(`rate:${v}`);
      },
      get volume() {
        return volume;
      },
      set volume(v: number) {
        if (refuses === 'volume') throw new Error('volume is not settable');
        volume = v;
        log.push(`volume:${v}`);
      },
      get muted() {
        return muted;
      },
      set muted(v: boolean) {
        if (refuses === 'muted') throw new Error('muted is not settable');
        muted = v;
        log.push(`muted:${String(v)}`);
      },
      play: () => {
        log.push('play');
      },
      pause: () => {
        log.push('pause');
      },
    };
    return { el, log };
  }

  it('carries every field of the decision to the element', () => {
    const { el, log } = player(null);
    applyDecision(el, { seekToMs: 5000, setRate: 1.03, action: 'play' });
    expect(log).toEqual(['seek:5', 'rate:1.03', 'play']);
    // A negative target is a projection, not a position: no element has one.
    applyDecision(el, { seekToMs: -4000, setRate: null, action: 'pause' });
    expect(el.currentTime).toBe(0);
  });

  it("still applies the room's transport when the element refuses the seek", () => {
    const { el, log } = player('currentTime');

    expect(() => {
      applyDecision(el, { seekToMs: 5000, setRate: 1.03, action: 'pause' });
    }).not.toThrow();

    // An unguarded write threw out of applyDecision before ever reaching the
    // rate and the pause, so a refused seek silently cost the room the pause
    // it actually asked for — the room says stop and the player plays on.
    expect(log).toEqual(['rate:1.03', 'pause']);
  });

  it("still applies the room's transport when the element refuses the rate", () => {
    const { el, log } = player('playbackRate');

    expect(() => {
      applyDecision(el, { seekToMs: 5000, setRate: 1.03, action: 'play' });
    }).not.toThrow();

    expect(log).toEqual(['seek:5', 'play']);
  });

  it('writes volume and mute when the decision carries them, clamped', () => {
    const { el, log } = player(null);

    applyDecision(el, { seekToMs: null, setRate: null, action: 'none', setVolume: 0.3, setMuted: true });
    // 1.7 came off a wire; no element has a volume past 1.
    applyDecision(el, { seekToMs: null, setRate: null, action: 'none', setVolume: 1.7, setMuted: false });

    expect(log).toEqual(['volume:0.3', 'muted:true', 'volume:1', 'muted:false']);
  });

  it('leaves volume and mute alone for a decision that says nothing about them', () => {
    const { el, log } = player(null);

    // null and absent both mean "leave alone" — same convention as setRate.
    applyDecision(el, { seekToMs: 5000, setRate: 1.03, action: 'play', setVolume: null, setMuted: null });
    applyDecision(el, { seekToMs: null, setRate: null, action: 'pause' });

    expect(log).toEqual(['seek:5', 'rate:1.03', 'play', 'pause']);
  });

  it("still applies the room's transport when the element refuses the volume", () => {
    const { el, log } = player('volume');

    expect(() => {
      applyDecision(el, { seekToMs: null, setRate: null, action: 'pause', setVolume: 0.3, setMuted: true });
    }).not.toThrow();

    // A refused volume write must not carry off the transport with the throw:
    // the room says stop, and stop still happens.
    expect(log).toEqual(['muted:true', 'pause']);
  });

  it("still applies the room's transport when the element refuses the mute", () => {
    const { el, log } = player('muted');

    expect(() => {
      applyDecision(el, { seekToMs: null, setRate: null, action: 'play', setVolume: 0.3, setMuted: true });
    }).not.toThrow();

    expect(log).toEqual(['volume:0.3', 'play']);
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
