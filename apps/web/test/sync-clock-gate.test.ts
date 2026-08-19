// @vitest-environment jsdom
/**
 * NO CORRECTION BEFORE THE CLOCK HAS BEEN MEASURED.
 *
 * `ClockEstimator.offsetMs()` answers 0 until its first accepted sample, and a
 * genuine zero offset answers 0 too — the two are indistinguishable from
 * outside. `hasEstimate()` exists precisely to tell them apart, and nothing in
 * this app called it.
 *
 * So for the first seconds of every join and every reconnect, `serverNow()` was
 * this machine's own wall clock wearing the server's name, `expectedPositionMs`
 * projected the room against it, and the drift controller corrected toward the
 * result. On a laptop a few seconds off — or an hour off, an afternoon after a
 * DST change — the engine dragged the player somewhere the room never was, and
 * then dragged it back once the first pong landed.
 *
 * A PAUSED room is deliberately NOT gated: its expected position is
 * `positionMs`, a constant that no clock takes part in. Waiting there would
 * leave a late joiner staring at a player parked at 0 while the room sits at
 * forty minutes, for no gain at all.
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

vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => ({
    useRoomState: { getState: () => ({ queue: { items: [] } }) },
    rawSocket: { send: () => undefined },
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };
const TICK_MS = 100;
/** Where the room is. The player below sits at 0, so the drift is enormous —
 *  past WATCH_ELASTIC's 12 s seek threshold — and impossible to miss. */
const ROOM_AT_MS = 600_000;

class ParkedAdapter implements PlayerAdapter {
  readonly kind = 'native' as const;
  readonly rates: number[] = [];
  readonly seeks: number[] = [];
  private position = 0;

  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(ms: number): void {
    this.seeks.push(ms);
    this.position = ms;
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
}

describe('a room joined before the first clock pong', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
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

  function mount(playing: boolean): { adapter: ParkedAdapter; clock: ClockEstimator } {
    const adapter = new ParkedAdapter();
    const clock = new ClockEstimator();
    const playback: PlaybackState = {
      mediaRef: MP4,
      positionMs: ROOM_AT_MS,
      rate: 1,
      playing,
      serverTs: Date.now(),
      seq: 1,
      queueIndex: 0,
    };
    function Harness(): null {
      useSyncEngine({ adapter, playback, clock, tickMs: TICK_MS });
      return null;
    }
    root = createRoot(host as HTMLDivElement);
    act(() => {
      root?.render(React.createElement(Harness));
    });
    return { adapter, clock };
  }

  const run = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('moves the player nowhere while the offset is still a placeholder', () => {
    const { adapter } = mount(true);
    run(3_000);

    // Ten minutes of apparent drift and not one correction: the engine has no
    // idea what time the server thinks it is, and says so by doing nothing.
    expect(adapter.seeks).toEqual([]);
    expect(adapter.rates.every((r) => r === 1)).toBe(true);
  });

  it('lands the track it owed as soon as a sample is accepted', () => {
    const { adapter, clock } = mount(true);
    run(1_000);
    expect(adapter.seeks).toEqual([]);

    // The first pong. Offset 0 — the point is that it was MEASURED, not that
    // it is nonzero.
    const now = Date.now();
    clock.addSample({ clientSendTs: now, serverTs: now, clientRecvTs: now });
    run(TICK_MS * 2);

    // The landing the track change could not perform now happens, unbanded:
    // this is host intent, and a viewer ten minutes out is not "drifting".
    expect(adapter.seeks).toHaveLength(1);
    expect(adapter.seeks[0]).toBeGreaterThanOrEqual(ROOM_AT_MS);
  });

  /** A paused room's expectation is a constant; no clock takes part in it. */
  it('still lands a paused room, which needs no clock at all', () => {
    const { adapter } = mount(false);
    expect(adapter.seeks).toEqual([ROOM_AT_MS]);
  });

  it('reports no drift sample it cannot stand behind', () => {
    const adapter = new ParkedAdapter();
    const clock = new ClockEstimator();
    const samples: number[] = [];
    const playback: PlaybackState = {
      mediaRef: MP4,
      positionMs: ROOM_AT_MS,
      rate: 1,
      playing: true,
      serverTs: Date.now(),
      seq: 1,
      queueIndex: 0,
    };
    function Harness(): null {
      useSyncEngine({
        adapter,
        playback,
        clock,
        tickMs: TICK_MS,
        onDriftSample: (ms) => samples.push(ms),
      });
      return null;
    }
    root = createRoot(host as HTMLDivElement);
    act(() => {
      root?.render(React.createElement(Harness));
    });
    run(2_000);

    // Silence, not a comfortable 0: a debug HUD reading "in sync" would be the
    // one claim this engine cannot make before the clock is measured.
    expect(samples).toEqual([]);
  });
});
