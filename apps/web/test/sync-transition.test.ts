// @vitest-environment jsdom
/**
 * THE LEARNED ANCHOR HAS TO SURVIVE A PAUSE.
 *
 * `DriftController`'s anchor is the whole elastic design: a viewer whose
 * connection settles them six seconds behind the room is allowed to STAY six
 * seconds behind and play smoothly there, instead of being dragged back twice a
 * second (docs/EXTENSION_FIRST.md Part 1). It costs `anchorAdoptAfterMs` — 3
 * seconds of steady lag — to learn one.
 *
 * The web threw it away on every play, pause, seek and rate change. The resync
 * effect was keyed on `mediaKey(mediaRef, playback.seq)`, and `seq` is minted by
 * every one of those mutations (services/api sync/service.ts `mutate()`), so
 * each of them ran `controller.reset()` and then snapped the player to within
 * 250 ms of the room's projection. Somebody pausing to answer the door
 * re-imposed frame-lock on every viewer in the room, and the six seconds had to
 * be re-learned from zero.
 *
 * WHAT THESE CASES WATCH. The controller is private to the hook, so the
 * assertions read the only thing the hook exposes: what it asks the player to
 * do. A surviving anchor is SILENCE — no seek, no rate change — while the raw
 * drift stays at six seconds, which is three times WATCH_ELASTIC's deadband and
 * would be corrected loudly by a controller that had forgotten it.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockEstimator } from '@gather/sync-core';
import type { MediaRef, PlaybackState } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from '@/lib/player/adapter';
import { playbackTransition, useSyncEngine } from '@/lib/player/useSyncEngine';

/** The engine reports the item's length to the room; nothing here has a queue,
 *  so the report declines to name an item. See sync-duration-report.test.ts. */
vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => ({
    useRoomState: { getState: () => ({ queue: { items: [] } }) },
    rawSocket: { send: () => undefined },
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };
const OTHER: MediaRef = { kind: 'url', url: 'https://cdn.example/next.mp4', mime: 'video/mp4' };

/** Well into the item, so the lag below is steady from the very first tick
 *  rather than ramping up out of a fresh start. */
const ROOM_START_MS = 60_000;
/** How far behind this viewer settles: 3× WATCH_ELASTIC's 2 s deadband, and
 *  well inside its 12 s seek threshold — squarely the case the anchor is for. */
const LAG_MS = 6_000;
const TICK_MS = 100;

/** A player that is always exactly `LAG_MS` behind the room and cannot be moved:
 *  it RECORDS what the engine asks for instead of obeying, which is what makes
 *  "the engine left it alone" observable. */
class LaggingAdapter implements PlayerAdapter {
  readonly kind = 'native' as const;
  readonly rates: number[] = [];
  readonly seeks: number[] = [];
  readonly transport: string[] = [];
  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();

  constructor(private readonly startedAt: number) {}

  load(): void {}
  play(): void {
    this.transport.push('play');
  }
  pause(): void {
    this.transport.push('pause');
  }
  seekTo(ms: number): void {
    this.seeks.push(ms);
  }
  setRate(rate: number): void {
    this.rates.push(rate);
  }
  positionMs(): number {
    return Math.max(0, ROOM_START_MS + (Date.now() - this.startedAt) - LAG_MS);
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
  on(evt: AdapterEvent, cb: () => void): () => void {
    let set = this.listeners.get(evt);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(evt, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }
  emit(evt: AdapterEvent): void {
    for (const cb of [...(this.listeners.get(evt) ?? [])]) cb();
  }
  destroy(): void {}

  /** Did the engine prescribe a correction since the mark? */
  correctedSince(mark: { rates: number; seeks: number }): boolean {
    return this.rates.slice(mark.rates).some((r) => r !== 1) || this.seeks.length > mark.seeks;
  }

  mark(): { rates: number; seeks: number } {
    return { rates: this.rates.length, seeks: this.seeks.length };
  }
}

describe('playbackTransition', () => {
  const at = (over: Partial<PlaybackState>): PlaybackState => ({
    mediaRef: MP4,
    positionMs: 10_000,
    rate: 1,
    playing: true,
    serverTs: 1_000,
    seq: 1,
    queueIndex: 0,
    ...over,
  });

  it('calls the first state a track change — there is nothing to compare to', () => {
    expect(playbackTransition(null, at({}))).toBe('track');
  });

  it('is silent when only the object identity changed', () => {
    expect(playbackTransition(at({}), at({}))).toBe('none');
  });

  it('names a play/pause at the same position transport, not a seek', () => {
    const playing = at({ seq: 1, positionMs: 10_000, serverTs: 1_000 });
    // Paused a second later, at the position the room had reached by then.
    const paused = at({ seq: 2, playing: false, positionMs: 11_000, serverTs: 2_000 });
    expect(playbackTransition(playing, paused)).toBe('transport');
    expect(playbackTransition(paused, at({ seq: 3, positionMs: 11_000, serverTs: 9_000 }))).toBe(
      'transport',
    );
  });

  it('names a rate change transport', () => {
    const before = at({ seq: 1 });
    expect(playbackTransition(before, at({ seq: 2, rate: 1.5 }))).toBe('transport');
  });

  it('names a jump in the room’s own timeline a seek', () => {
    const before = at({ seq: 1, positionMs: 10_000, serverTs: 1_000 });
    const after = at({ seq: 2, positionMs: 40_000, serverTs: 1_500 });
    expect(playbackTransition(before, after)).toBe('seek');
  });

  it('names different content a track change however the position moved', () => {
    const before = at({ seq: 1 });
    expect(playbackTransition(before, at({ seq: 2, mediaRef: OTHER, positionMs: 0 }))).toBe(
      'track',
    );
  });

  /**
   * The comparison happens at the moment the new state DESCRIBES, never at
   * "now". Projecting both to the current instant would make the answer depend
   * on how long the frame took to arrive — a resume delivered two seconds late
   * would show a two-second jump and be called a seek.
   */
  it('does not turn a late-arriving resume into a seek', () => {
    const paused = at({ seq: 1, playing: false, positionMs: 30_000, serverTs: 1_000 });
    const resumed = at({ seq: 2, playing: true, positionMs: 30_000, serverTs: 900_000 });
    expect(playbackTransition(paused, resumed)).toBe('transport');
  });
});

describe('a room that pauses and plays again', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let adapter: LaggingAdapter;
  let clock: ClockEstimator;

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

  function state(over: Partial<PlaybackState>): PlaybackState {
    return {
      mediaRef: MP4,
      positionMs: ROOM_START_MS,
      rate: 1,
      playing: true,
      serverTs: 0,
      seq: 1,
      queueIndex: 0,
      ...over,
    };
  }

  function Harness({ playback }: { playback: PlaybackState }): null {
    useSyncEngine({ adapter, playback, clock, tickMs: TICK_MS });
    return null;
  }

  function mount(playback: PlaybackState): void {
    adapter = new LaggingAdapter(Date.now());
    clock = new ClockEstimator();
    // A measured offset of 0. Without a sample the engine refuses to correct a
    // playing room at all, and every case here would pass by doing nothing.
    clock.addSample({ clientSendTs: 0, serverTs: 0, clientRecvTs: 0 });
    root = createRoot(host as HTMLDivElement);
    act(() => {
      root?.render(React.createElement(Harness, { playback }));
    });
  }

  const render = (playback: PlaybackState): void => {
    act(() => {
      root?.render(React.createElement(Harness, { playback }));
    });
  };

  const run = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  /** Mounts, then lets the controller adopt the steady 6 s lag. */
  function settled(): void {
    mount(state({}));
    // Past `anchorAdoptAfterMs` (3 s) of an unchanging lag, with room to spare.
    run(5_000);
    const mark = adapter.mark();
    run(1_000);
    // The anchor is adopted: six seconds of drift, and the engine says nothing.
    expect(adapter.correctedSince(mark)).toBe(false);
  }

  /** The room's projected position right now. */
  const roomNow = (): number => ROOM_START_MS + Date.now();

  it('keeps the learned anchor across a pause and a resume', () => {
    settled();
    const mark = adapter.mark();

    // Somebody pauses. The room records where IT had reached.
    render(state({ seq: 2, playing: false, positionMs: roomNow(), serverTs: Date.now() }));
    run(2_000);
    // …and plays again from the same place.
    render(state({ seq: 3, playing: true, positionMs: roomNow() - 2_000, serverTs: Date.now() }));
    run(3_000);

    // The transport itself was applied — this test must not pass by inaction.
    expect(adapter.transport.slice(-2)).toEqual(['pause', 'play']);
    // …and nothing else was. A controller that had been reset would see six
    // seconds of unanchored drift and correct it: 6 s is past WATCH_ELASTIC's
    // 2 s deadband, and the resync effect used to snap anything past 250 ms.
    expect(adapter.seeks.length).toBe(mark.seeks);
    expect(adapter.correctedSince(mark)).toBe(false);
  });

  it('keeps it across a rate change too', () => {
    settled();
    const mark = adapter.mark();
    render(state({ seq: 2, rate: 1.25, positionMs: roomNow(), serverTs: Date.now() }));
    run(2_000);

    // The room's rate is what the player was set to — the nudge multiplier is
    // 1, so every rate the engine asked for is the room's own.
    expect(adapter.rates.slice(mark.rates).every((r) => r === 1.25)).toBe(true);
    expect(adapter.seeks.length).toBe(mark.seeks);
  });

  /**
   * The other half of the same rule: an anchor describes a POSITION, so when
   * the room's own timeline jumps the anchor is meaningless and has to go.
   *
   * Made observable by seeking the room back to exactly where this player
   * already is. With the anchor dropped there is no drift left and the engine
   * says nothing; with a stale 6 s anchor still applied the engine would read
   * the viewer as six seconds AHEAD and slow them down.
   */
  it('drops it when the host seeks, instead of correcting toward a stale offset', () => {
    settled();
    const mark = adapter.mark();

    render(
      state({ seq: 2, positionMs: roomNow() - LAG_MS, serverTs: Date.now() }),
    );
    run(3_000);

    expect(adapter.correctedSince(mark)).toBe(false);
  });

  /**
   * A follower reaches the credits while the room is still on the item —
   * elastic sync is what puts them there. From that moment the player is
   * FINISHED, not paused, and `play()` on an ended HTMLMediaElement restarts it
   * from zero (YouTube's playVideo does the same). So a pause and a resume
   * while this device is over must not touch it.
   */
  it('never restarts a player that has already finished here', () => {
    settled();
    act(() => {
      adapter.emit('ended');
    });
    const mark = adapter.transport.length;

    const seeks = adapter.seeks.length;
    render(state({ seq: 2, playing: false, positionMs: roomNow(), serverTs: Date.now() }));
    render(state({ seq: 3, playing: true, positionMs: roomNow(), serverTs: Date.now() }));
    run(2_000);

    expect(adapter.transport.slice(mark)).toEqual(['pause']);
    // Nor may it be seeked: seeking a finished player is the other way to
    // start it again.
    expect(adapter.seeks.length).toBe(seeks);
  });

  /**
   * A track change is host intent and lands unbanded on every viewer — the one
   * transition that IS allowed to snap the player and forget everything.
   */
  it('lands hard on a track change', () => {
    settled();
    const mark = adapter.mark();

    render(state({ seq: 2, mediaRef: OTHER, positionMs: 0, serverTs: Date.now() }));

    expect(adapter.seeks.length).toBeGreaterThan(mark.seeks);
    expect(adapter.seeks[adapter.seeks.length - 1]).toBe(0);
  });
});
