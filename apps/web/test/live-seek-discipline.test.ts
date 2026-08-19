// @vitest-environment jsdom
/**
 * WHAT THE ENGINE OWES A PLAYER THAT WILL NOT SEEK.
 *
 * The web engine prescribed a seek on every correction pass — 2 Hz, no floor
 * between them and no notice taken of whether the last one landed. A player
 * that ignores or rounds a seek was therefore asked again 500 ms later, and
 * again, for as long as the item was on the stage: it never finished answering
 * the first question, and the viewer watched a stage that re-buffered twice a
 * second.
 *
 * The extension's driver has had both halves since it shipped
 * (apps/extension/src/driver.ts — `MIN_SEEK_INTERVAL_MS`, a DRM floor, and
 * `MAX_SEEK_MISSES`), and this is that discipline ported: a floor between
 * seeks, and a count of the ones that plainly did not land. Two ignored in a
 * row and the engine stops asking — the elastic anchor is what absorbs a
 * difference the player will not close, which is the whole point of an anchor.
 *
 * A HOST LANDING IS NOT A PRESCRIPTION. A track change lands unbanded on a
 * player that may not have read its metadata yet, so it is neither subject to
 * the floor nor evidence about the player. Every count below is written to
 * separate the two.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockEstimator } from '@gather/sync-core';
import type { MediaRef, PlaybackState } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from '@/lib/player/adapter';
import { MIN_SEEK_INTERVAL_MS, useSyncEngine } from '@/lib/player/useSyncEngine';

vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => ({
    useRoomState: { getState: () => ({ queue: { items: [] } }) },
    rawSocket: { send: () => undefined },
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };
/** Ten minutes out — far past WATCH_ELASTIC's 12 s seek threshold, so the
 *  controller prescribes a seek on every pass and nothing else. */
const ROOM_AT_MS = 600_000;
const TICK_MS = 100;

/** How a player answers a seek. */
type Landing =
  /** Goes exactly where it was asked. */
  | 'exact'
  /** Snaps to a keyframe 1.5 s short — honoured, not ignored. */
  | 'keyframe'
  /** Does not move at all. The player this file exists for. */
  | 'ignored';

/**
 * A player that never advances on its own: whatever it is told, it stays there.
 * That makes the room's lead regrow at real time after every correction, so a
 * player that IS listening keeps being corrected while one that is not can be
 * seen to be abandoned.
 */
class FrozenAdapter implements PlayerAdapter {
  readonly kind = 'native' as const;
  readonly seeks: { toMs: number; atMs: number }[] = [];
  readonly rates: number[] = [];
  private position = 0;

  constructor(private readonly landing: Landing) {}

  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(ms: number): void {
    this.seeks.push({ toMs: ms, atMs: Date.now() });
    if (this.landing === 'ignored') return;
    this.position = Math.max(0, ms - (this.landing === 'keyframe' ? 1500 : 0));
  }
  setRate(rate: number): void {
    this.rates.push(rate);
  }
  positionMs(): number {
    return this.position;
  }
  durationMs(): number {
    return 0;
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

  /** Everything after the unbanded track landing, which is host intent and
   *  belongs to nobody's budget. */
  corrections(): { toMs: number; atMs: number }[] {
    return this.seeks.slice(1);
  }
}

describe('a player that is asked to seek', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
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
    vi.useRealTimers();
  });

  function mount(landing: Landing): FrozenAdapter {
    const adapter = new FrozenAdapter(landing);
    const playback: PlaybackState = {
      mediaRef: MP4,
      positionMs: ROOM_AT_MS,
      rate: 1,
      playing: true,
      serverTs: 0,
      seq: 1,
      queueIndex: 0,
    };
    const clock = new ClockEstimator();
    // A measured offset of 0: without a sample the engine refuses to correct a
    // playing room at all, and every case here would pass by doing nothing.
    clock.addSample({ clientSendTs: 0, serverTs: 0, clientRecvTs: 0 });
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

  /** The track landing itself, so the counts below mean what they say. */
  it('lands the track once, unbanded, before any of this applies', () => {
    const adapter = mount('exact');
    expect(adapter.seeks).toHaveLength(1);
    expect(adapter.seeks[0]?.toMs).toBeGreaterThanOrEqual(ROOM_AT_MS);
  });

  /**
   * The loop itself. Ten minutes out and frozen, this player was asked to seek
   * on every one of the thirty passes in this window.
   */
  it('is not asked again on the next pass', () => {
    const adapter = mount('ignored');
    run(3_000);

    expect(adapter.corrections()).toEqual([]);
  });

  it('is never asked twice inside the floor', () => {
    const adapter = mount('ignored');
    run(60_000);

    const gaps = adapter
      .corrections()
      .slice(1)
      .map((seek, i) => seek.atMs - (adapter.corrections()[i]?.atMs ?? 0));
    expect(gaps.every((gap) => gap >= MIN_SEEK_INTERVAL_MS)).toBe(true);
  });

  /**
   * …and then the engine stops asking altogether. Two prescriptions, both
   * ignored, and this player is left to play smoothly where it is while the
   * anchor holds the difference — the honest answer, since there is nothing
   * left to fight with.
   */
  it('is asked twice, and then left alone for good', () => {
    const adapter = mount('ignored');
    run(30_000);
    const askedFor = adapter.corrections().length;
    expect(askedFor).toBe(2);

    run(120_000);
    expect(adapter.corrections()).toHaveLength(askedFor);
    // Nor is it fought with rate instead: every rate asked for is the room's.
    expect(adapter.rates.every((rate) => rate === 1)).toBe(true);
  });

  /**
   * The distinction the counter exists to make, and the reason it is not a
   * plain "two seeks per item" budget: a player that HONOURS corrections goes
   * on getting them for as long as it needs them.
   */
  it('goes on correcting a player that actually moves', () => {
    const listening = mount('exact');
    run(150_000);
    const heard = listening.corrections().length;

    act(() => {
      root?.unmount();
    });
    const deaf = mount('ignored');
    run(150_000);

    expect(heard).toBeGreaterThan(deaf.corrections().length);
  });

  /**
   * A seek lands on the nearest keyframe, not on the millisecond asked for.
   * Counting that as a refusal would abandon every player in the room after two
   * corrections, so the miss window is wide enough for the snap and nothing
   * else.
   */
  it('does not mistake a keyframe snap for a refusal', () => {
    const snapping = mount('keyframe');
    run(150_000);
    const snapped = snapping.corrections().length;

    act(() => {
      root?.unmount();
    });
    const deaf = mount('ignored');
    run(150_000);

    expect(snapped).toBeGreaterThan(deaf.corrections().length);
  });
});
