// @vitest-environment jsdom
/**
 * E17 — the adaptive comfort band, on the web.
 *
 * docs/EXTENSION_FIRST.md Part 1 "Consequence B" describes the whole
 * loose-sync-versus-live-voice trade: the call does not travel the content's
 * path, so while people are on mic the elastic band has to tighten or a reply
 * lands seconds away from the thing it is about. `DriftController` has
 * implemented that since it shipped, and until now the browser extension was
 * the only caller — the web app, where most people watch, never told the
 * controller a single thing about voice.
 *
 * The band is driven by PRESENCE mic state, never by measured speech. Both
 * halves of that are asserted here: turning a mic on tightens the band, and
 * somebody drawing breath does not touch it. A controller whose attack is two
 * seconds and whose release is eight would spend its whole life mid-ramp if it
 * were retuned every time the 150 ms speech detector changed its mind.
 *
 * WHAT "TIGHTER" LOOKS LIKE FROM OUTSIDE. The controller is private to the
 * hook, so the assertions read the only thing the hook exposes: what it does to
 * the adapter. WATCH_ELASTIC ignores drift under 2 s. Voice-tightened, the
 * deadband converges toward 1 s. So a steady 1.5 s of drift is silence in a
 * quiet room and a rate nudge in a room with an open mic — the same drift,
 * two different bands.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockEstimator } from '@gather/sync-core';
import type { MediaRef, PlaybackState } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from '@/lib/player/adapter';
import { useSyncEngine } from '@/lib/player/useSyncEngine';
import {
  publishSpeechActive,
  publishVoiceActive,
  resetRoomAudio,
} from '@/lib/player/room-audio';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };

/** Steady lag this device is running at, in ms — inside WATCH_ELASTIC's 2 s
 *  deadband, outside the ~1 s the voice-tightened band converges to. */
const DRIFT_MS = 1_500;

const TICK_MS = 100;

/** An adapter that is always exactly `driftMs` behind the room. */
class LaggingAdapter implements PlayerAdapter {
  readonly kind = 'native' as const;
  readonly rates: number[] = [];
  readonly seeks: number[] = [];
  /** Settable so a case can let the room converge before it asserts. */
  driftMs = DRIFT_MS;

  constructor(private readonly startedAt: number) {}

  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(ms: number): void {
    this.seeks.push(ms);
  }
  setRate(rate: number): void {
    this.rates.push(rate);
  }
  positionMs(): number {
    return Math.max(0, Date.now() - this.startedAt - this.driftMs);
  }
  durationMs(): number {
    return 0; // unknown → the controller does not clamp
  }
  setMuted(): void {}
  isMuted(): boolean {
    return false;
  }
  setVolume(): void {}
  setDuck(): void {}
  on(_evt: AdapterEvent, _cb: () => void): () => void {
    return () => undefined;
  }
  destroy(): void {}

  /** Did the engine prescribe a correction since the mark? */
  nudgedSince(mark: number): boolean {
    return this.rates.slice(mark).some((r) => r !== 1);
  }
}

describe('the sync band follows presence mic state', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetRoomAudio();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
    resetRoomAudio();
    vi.useRealTimers();
  });

  function mount(): LaggingAdapter {
    const startedAt = Date.now();
    const adapter = new LaggingAdapter(startedAt);
    const playback: PlaybackState = {
      mediaRef: MP4,
      positionMs: 0,
      rate: 1,
      playing: true,
      serverTs: startedAt,
      seq: 1,
      queueIndex: null,
    };
    const clock = new ClockEstimator();
    function Harness(): null {
      useSyncEngine({ adapter, playback, clock, tickMs: TICK_MS });
      return null;
    }
    root = createRoot(host as HTMLDivElement);
    act(() => {
      root?.render(React.createElement(Harness));
    });
    return adapter;
  }

  const run = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('leaves a 1.5 s lag alone while nobody is on mic', () => {
    const adapter = mount();
    const mark = adapter.rates.length;
    run(3_000);
    expect(adapter.rates.length).toBeGreaterThan(mark);
    expect(adapter.nudgedSince(mark)).toBe(false);
    expect(adapter.seeks).toEqual([]);
  });

  it('tightens onto the same lag once somebody opens a mic', () => {
    const adapter = mount();
    run(1_000);
    const mark = adapter.rates.length;
    act(() => {
      publishVoiceActive(true);
    });
    // Past the controller's 2 s voice attack.
    run(3_000);
    expect(adapter.nudgedSince(mark)).toBe(true);
    // Consequence B: converge with RATE only. A seek is the one correction
    // guaranteed to wreck a live reaction.
    expect(adapter.seeks).toEqual([]);
  });

  it('relaxes back once every mic closes', () => {
    const adapter = mount();
    act(() => {
      publishVoiceActive(true);
    });
    run(2_000);
    expect(adapter.nudgedSince(0)).toBe(true);

    /* The room settles — the nudge did its job — so hysteresis lets go, and
       every mic closes. Both matter: a controller still mid-correction keeps
       correcting whatever the band says, and a controller that sat on a steady
       1.5 s for three seconds would have LEARNED it as an anchor and then sit
       still for a reason that has nothing to do with voice. 200 ms of calm is
       too small to be adopted, so what is measured below is the band. */
    adapter.driftMs = 200;
    act(() => {
      publishVoiceActive(false);
    });
    // Past the controller's 8 s voice release.
    run(9_000);

    // The same 1.5 s opens up again. In a quiet room that is inside the band.
    adapter.driftMs = DRIFT_MS;
    const mark = adapter.rates.length;
    run(2_000);
    expect(adapter.rates.length).toBeGreaterThan(mark);
    expect(adapter.nudgedSince(mark)).toBe(false);
  });

  /**
   * The distinction the whole design rests on. Speech is the FAST signal and it
   * belongs to ducking; if it reached the band, every syllable would restart a
   * two-second ramp.
   */
  it('does not retune the band when someone merely speaks', () => {
    const adapter = mount();
    const mark = adapter.rates.length;
    act(() => {
      publishSpeechActive(true);
    });
    run(3_000);
    expect(adapter.nudgedSince(mark)).toBe(false);
  });

  /** A mic already open before this stage mounted has to count immediately —
   *  the band cannot wait for the next person to join the call. */
  it('picks up a mic that was already open at mount', () => {
    publishVoiceActive(true);
    const adapter = mount();
    const mark = adapter.rates.length;
    run(3_000);
    expect(adapter.nudgedSince(mark)).toBe(true);
  });
});
