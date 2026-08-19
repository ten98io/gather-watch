// @vitest-environment jsdom
/**
 * A PLAYER THAT IGNORES `playbackRate`, NOTICED.
 *
 * `DriftController.noteRateRejected` exists so the controller can stop
 * prescribing a correction the player will silently drop: with rate control
 * gone it sits still, lets the learned anchor absorb the offset, and leaves the
 * hard seek as the only real correction (which is the honest answer — a seek is
 * what re-buffers a stream or renegotiates a DRM licence). The extension has
 * called it since it shipped. The web never did, so on a player that accepts
 * `playbackRate = 1.03` and goes on playing at 1.0 — protected media is the
 * usual one — the engine prescribed a nudge every 500 ms forever while the
 * viewer sat further and further out, and the controller believed it was
 * converging.
 *
 * THE TEST IS THE EXTENSION'S TEST (apps/extension/src/driver.ts,
 * `checkRateReadback`): assign, wait past the grace period, read back on a
 * LATER pass, and conclude "ignored" ONLY when the value did not move at all.
 * A value that moved somewhere else is the USER changing speed, which is not a
 * refusal and must not cost the room its rate correction for the rest of the
 * item.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockEstimator } from '@gather/sync-core';
import type { MediaRef, PlaybackState } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from '@/lib/player/adapter';
import { observedRate, useSyncEngine } from '@/lib/player/useSyncEngine';

vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => ({
    useRoomState: { getState: () => ({ queue: { items: [] } }) },
    rawSocket: { send: () => undefined },
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };
const ROOM_START_MS = 60_000;
/** Inside WATCH_ELASTIC's 12 s seek threshold, outside its 2 s deadband: the
 *  band where a rate nudge is the ONLY correction the controller prescribes. */
const LAG_MS = 4_000;
const TICK_MS = 100;

/**
 * A `<video>` that is always `LAG_MS` behind, with a `playbackRate` that can be
 * made to stick or to be silently dropped.
 *
 * `mediaElement` is the real element `NativeAdapter` exposes, and it is the one
 * read-back the adapter interface makes available today — see `observedRate`.
 */
class ElementAdapter implements PlayerAdapter {
  readonly kind = 'native' as const;
  readonly rates: number[] = [];
  readonly seeks: number[] = [];
  /** What the "player" is really running at. */
  readonly mediaElement: { playbackRate: number };
  /** False models a player that accepts the assignment and does nothing. */
  honoursRate = true;
  /** True models a hand on the site's own speed control: the rate keeps moving,
   *  but never to the value we asked for. */
  userFiddling = false;
  private userNext = 1.5;

  constructor(private readonly startedAt: number) {
    this.mediaElement = { playbackRate: 1 };
  }

  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(ms: number): void {
    this.seeks.push(ms);
  }
  setRate(rate: number): void {
    this.rates.push(rate);
    if (this.honoursRate) this.mediaElement.playbackRate = rate;
    if (this.userFiddling) {
      this.mediaElement.playbackRate = this.userNext;
      this.userNext += 0.1;
    }
  }
  positionMs(): number {
    return Math.max(0, ROOM_START_MS + (Date.now() - this.startedAt) - LAG_MS);
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

  nudgesSince(mark: number): number[] {
    return this.rates.slice(mark).filter((r) => r !== 1);
  }
}

/** An adapter with no reachable player object — every iframe adapter today. */
class OpaqueAdapter extends ElementAdapter {
  override readonly mediaElement = undefined as unknown as { playbackRate: number };
}

describe('observedRate', () => {
  it('reads the rate off the element an adapter exposes', () => {
    const adapter = new ElementAdapter(0);
    adapter.mediaElement.playbackRate = 1.03;
    expect(observedRate(adapter)).toBe(1.03);
  });

  /**
   * Null is "no evidence", never "refused". `noteRateRejected` is one-way, so
   * an adapter that cannot answer must never be concluded about.
   */
  it('answers null for an adapter whose player it cannot reach', () => {
    expect(observedRate(new OpaqueAdapter(0))).toBeNull();
  });

  it('answers null for a nonsense reading', () => {
    const adapter = new ElementAdapter(0);
    adapter.mediaElement.playbackRate = Number.NaN;
    expect(observedRate(adapter)).toBeNull();
    adapter.mediaElement.playbackRate = 0;
    expect(observedRate(adapter)).toBeNull();
  });
});

describe('a player that silently drops playbackRate', () => {
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

  function mount(adapter: ElementAdapter): void {
    const playback: PlaybackState = {
      mediaRef: MP4,
      positionMs: ROOM_START_MS,
      rate: 1,
      playing: true,
      serverTs: 0,
      seq: 1,
      queueIndex: 0,
    };
    const clock = new ClockEstimator();
    clock.addSample({ clientSendTs: 0, serverTs: 0, clientRecvTs: 0 });
    function Harness(): null {
      useSyncEngine({ adapter, playback, clock, tickMs: TICK_MS });
      return null;
    }
    root = createRoot(host as HTMLDivElement);
    act(() => {
      root?.render(React.createElement(Harness));
    });
  }

  const run = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('is told once, and then stops being asked', () => {
    const adapter = new ElementAdapter(Date.now());
    adapter.honoursRate = false;
    mount(adapter);

    // Long enough to prescribe, read back, and conclude.
    run(2_000);
    const mark = adapter.rates.length;
    run(3_000);

    // With rate control reported gone, the controller prescribes no more
    // nudges — it holds the offset with the anchor instead. Every rate the
    // engine still asks for is the ROOM's own rate, never a correction.
    expect(adapter.nudgesSince(mark)).toEqual([]);
  });

  it('goes on nudging a player that honours the rate', () => {
    const adapter = new ElementAdapter(Date.now());
    mount(adapter);
    run(2_000);
    const mark = adapter.rates.length;
    run(2_000);

    expect(adapter.nudgesSince(mark).length).toBeGreaterThan(0);
  });

  /**
   * The distinction the read-back exists to make. Someone reaching for the
   * speed control is not a player refusing one — and mistaking the two costs
   * the room its rate correction for the rest of the item.
   */
  it('does not mistake the user changing speed for a refusal', () => {
    const adapter = new ElementAdapter(Date.now());
    // The player drops what we ask for AND the rate keeps moving — a hand on
    // the site's own speed control. The read-back sees a value that is neither
    // what we asked for nor what the player held when we asked, which is the
    // one shape that proves nothing.
    adapter.honoursRate = false;
    adapter.userFiddling = true;
    mount(adapter);
    run(2_000);
    const mark = adapter.rates.length;
    run(2_000);

    expect(adapter.nudgesSince(mark).length).toBeGreaterThan(0);
  });

  /** No read-back, no conclusion: an adapter that cannot be asked keeps its
   *  rate correction rather than losing it on a guess. */
  it('concludes nothing about an adapter it cannot read back', () => {
    const adapter = new OpaqueAdapter(Date.now());
    adapter.honoursRate = false;
    mount(adapter);
    run(2_000);
    const mark = adapter.rates.length;
    run(2_000);

    expect(adapter.nudgesSince(mark).length).toBeGreaterThan(0);
  });
});
