// @vitest-environment jsdom
/**
 * A LIVE STREAM IS NOT A TIMELINE, AND MUST NOT BE CORRECTED TOWARD ONE.
 *
 * `parseProviderUrl` accepts a YouTube live URL and a live `.m3u8` — it cannot
 * tell either from a VOD, and should not try — so both arrive as full-sync
 * kinds and the drift engine drives them. But the room's `positionMs` starts at
 * 0 and projects forward, while a live player's clock does not start at 0 at
 * all: YouTube's iframe reports elapsed-since-broadcast-start and answers 0 for
 * `getDuration()`, so the controller's terminal clamp is disabled too, and
 * hls.js opens a sliding window behind an edge that keeps moving.
 *
 * The result was a measured drift of minutes, a seek prescribed toward a
 * position outside the DVR window, a player that could not go there, and the
 * same prescription again on the next pass — twice a second, for as long as the
 * stream was on the stage.
 *
 * The fix is to give the item a NAME and then stop correcting it: everyone sits
 * at their own live edge, which for a broadcast is within seconds of everyone
 * else's. Transport still applies — this is a room, and play/pause is host
 * intent — and the fact is published so the chrome can say "Live" instead of
 * drawing a position nobody shares.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockEstimator } from '@gather/sync-core';
import type { MediaRef, PlaybackState } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from '@/lib/player/adapter';
import { adapterIsLive } from '@/lib/player/adapter';
import { NativeAdapter } from '@/lib/player/native';
import { VimeoAdapter } from '@/lib/player/vimeo';
import { YouTubeAdapter } from '@/lib/player/youtube';
import { getStageLive, resetStageLive } from '@/lib/player/live';
import { useSyncEngine } from '@/lib/player/useSyncEngine';

vi.mock('@/lib/room-context', () => ({
  useRoomConnection: () => ({
    useRoomState: { getState: () => ({ queue: { items: [] } }) },
    rawSocket: { send: () => undefined },
  }),
}));

/**
 * hls.js, only as far as the one question this file asks it. The real one is
 * imported lazily inside `NativeAdapter.load`, so a fake module is the only way
 * to reach the branch EVERY BROWSER EXCEPT SAFARI takes for an `.m3u8` — which
 * makes it the branch that carries the live verdict for almost every viewer.
 * The element's own `duration` (tested above) is the Safari half.
 */
const LEVEL_LOADED = 'hlsLevelLoaded';
type LevelLoadedCb = (evt: string, data: { details: { live: boolean } }) => void;

class FakeHls {
  static readonly Events = { LEVEL_LOADED } as const;
  /** Every instance ever built, oldest first: a load that was superseded is
   *  only observable through the instance it left behind. */
  static readonly built: FakeHls[] = [];
  private readonly handlers = new Map<string, LevelLoadedCb>();

  constructor() {
    FakeHls.built.push(this);
  }
  static isSupported(): boolean {
    return true;
  }
  on(evt: string, cb: LevelLoadedCb): void {
    this.handlers.set(evt, cb);
  }
  loadSource(): void {}
  attachMedia(): void {}
  destroy(): void {}
  /** The playlist speaking: `live` is false for a VOD, true for a sliding
   *  window that carries no ENDLIST. */
  announce(live: boolean): void {
    this.handlers.get(LEVEL_LOADED)?.(LEVEL_LOADED, { details: { live } });
  }
}

vi.mock('hls.js', () => ({ default: FakeHls }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STREAM: MediaRef = {
  kind: 'url',
  url: 'https://cdn.example/live.m3u8',
  mime: 'application/x-mpegURL',
};
const TICK_MS = 100;

/* ── the two adapters that can actually be live ──────────────────────────── */

/** Pin a media element's `duration`, which jsdom leaves at NaN forever. */
function withDuration(el: HTMLMediaElement, seconds: number): HTMLMediaElement {
  Object.defineProperty(el, 'duration', { value: seconds, configurable: true });
  return el;
}

describe('NativeAdapter.isLive', () => {
  it('reads an unbounded element duration as live', () => {
    const el = withDuration(document.createElement('video'), Number.POSITIVE_INFINITY);
    expect(new NativeAdapter(el).isLive()).toBe(true);
  });

  /**
   * The distinction that decides whether ordinary files keep their sync: NaN is
   * every element before it has read its metadata, and reading "unknown" as
   * "live" would switch correction off at the start of every item.
   */
  it('does not call a player that has no metadata yet live', () => {
    const fresh = document.createElement('video');
    expect(Number.isNaN(fresh.duration)).toBe(true);
    expect(new NativeAdapter(fresh).isLive()).toBe(false);
  });

  it('leaves an ordinary file alone', () => {
    const el = withDuration(document.createElement('video'), 300);
    expect(new NativeAdapter(el).isLive()).toBe(false);
  });
});

/**
 * The other source of the same fact, and the one that answers for nearly every
 * viewer: hls.js parses the playlist and states outright whether it is live,
 * while the element it feeds has a `duration` that merely GROWS — finite at
 * every instant, so the Safari test above can never fire here.
 */
describe('NativeAdapter.isLive on the hls.js path', () => {
  /** An m3u8 by mime, which is what `isHlsRef` routes on. */
  const STREAM_URL: Extract<MediaRef, { kind: 'url' }> = {
    kind: 'url',
    url: 'https://cdn.example/edge.m3u8',
    mime: 'application/x-mpegURL',
  };

  beforeEach(() => {
    FakeHls.built.length = 0;
  });

  /**
   * `load` starts a lazy `import('hls.js')` and subscribes in its `then`. How
   * many microtasks that takes to settle is the module loader's business, not
   * this file's, so wait for the instance to appear rather than counting ticks
   * — a fixed count is a test that starts failing when nothing broke.
   */
  async function loading(): Promise<{ adapter: NativeAdapter; hls: FakeHls }> {
    const before = FakeHls.built.length;
    const adapter = new NativeAdapter(document.createElement('video'));
    adapter.load(STREAM_URL);
    for (let i = 0; i < 100 && FakeHls.built.length === before; i += 1) {
      await Promise.resolve();
    }
    const hls = FakeHls.built.at(-1);
    if (hls === undefined || FakeHls.built.length === before) {
      throw new Error('hls.js was never constructed');
    }
    return { adapter, hls };
  }

  it('takes the playlist’s word that the window is live', async () => {
    const { adapter, hls } = await loading();
    hls.announce(true);
    expect(adapter.isLive()).toBe(true);
  });

  it('…and its word that a VOD playlist is not', async () => {
    const { adapter, hls } = await loading();
    hls.announce(false);
    expect(adapter.isLive()).toBe(false);
  });

  /** Before the first level loads nothing is known, and "unknown" must answer
   *  the same as "not live" or a fresh stream skips its landing. */
  it('says nothing before the playlist has been read', async () => {
    const { adapter } = await loading();
    expect(adapter.isLive()).toBe(false);
  });

  /**
   * THE GENERATION GUARD. A queue advance destroys one hls.js and builds
   * another, but the old instance's callback is still reachable and its
   * playlist was live. Landing that verdict on the item now playing would
   * switch drift correction off for an ordinary video — the exact inversion of
   * this fix, and silent.
   */
  it('cannot be told it is live by the stream it already left', async () => {
    const first = await loading();
    const second = await loading();
    first.hls.announce(true);
    expect(second.adapter.isLive()).toBe(false);
    // The abandoned adapter is a different object; the fact under test is that
    // the CURRENT generation refused the stale verdict.
    expect(FakeHls.built.length).toBe(2);
  });

  /** Liveness belongs to the source, so it leaves with it: the next item starts
   *  from "not known to be live" however loudly the last one said otherwise. */
  it('forgets a live verdict when a new source is loaded', async () => {
    const { adapter, hls } = await loading();
    hls.announce(true);
    expect(adapter.isLive()).toBe(true);

    adapter.load({ kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' });
    expect(adapter.isLive()).toBe(false);
  });
});

/* A minimal stand-in for the IFrame API: enough of `YT.Player` for the adapter
   to build one and for a test to drive its state changes. */
interface FakeEvents {
  onReady: () => void;
  onStateChange: (ev: { data: number }) => void;
  onError: () => void;
}
let fakeEvents: FakeEvents | null = null;
let fakeDurationSec = 0;

function installFakeIframeApi(): void {
  fakeEvents = null;
  fakeDurationSec = 0;
  (window as unknown as { YT: unknown }).YT = {
    Player: class {
      constructor(_el: HTMLElement, opts: { events: FakeEvents }) {
        fakeEvents = opts.events;
        queueMicrotask(() => opts.events.onReady());
      }
      playVideo(): void {}
      pauseVideo(): void {}
      seekTo(): void {}
      setPlaybackRate(): void {}
      getCurrentTime(): number {
        return 0;
      }
      getDuration(): number {
        return fakeDurationSec;
      }
      mute(): void {}
      unMute(): void {}
      isMuted(): boolean {
        return false;
      }
      setVolume(): void {}
      loadVideoById(): void {}
      destroy(): void {}
    },
    PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3, ENDED: 0 },
  };
}

/** Let `loadIframeApi().then(...)` and the fake's own onReady run. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('YouTubeAdapter.isLive', () => {
  beforeEach(() => {
    installFakeIframeApi();
  });

  async function mounted(): Promise<YouTubeAdapter> {
    const adapter = new YouTubeAdapter(document.createElement('div'));
    adapter.load({ kind: 'youtube', videoId: 'live-abc' });
    await flush();
    return adapter;
  }

  /** The API's own way of saying "this has no length": 0, once it is running. */
  it('reads a running player that refuses to name a length as live', async () => {
    const adapter = await mounted();
    fakeDurationSec = 0;
    act(() => fakeEvents?.onStateChange({ data: 1 }));
    expect(adapter.isLive()).toBe(true);
  });

  /**
   * 0 is ALSO the answer before the player has metadata. Asking any earlier
   * would call every ordinary video live for its first seconds — exactly when
   * a fresh player needs to be landed on the room's position.
   */
  it('says nothing about a player that has not started', async () => {
    const adapter = await mounted();
    expect(adapter.durationMs()).toBe(0);
    expect(adapter.isLive()).toBe(false);
  });

  it('leaves an ordinary video alone once it has a length', async () => {
    const adapter = await mounted();
    fakeDurationSec = 212;
    act(() => fakeEvents?.onStateChange({ data: 1 }));
    expect(adapter.isLive()).toBe(false);
  });
});

/* ── the engine ──────────────────────────────────────────────────────────── */

/**
 * A player on a live edge: its position is elapsed-since-broadcast-start (hours
 * of it), and it has no duration to clamp the room's projection with. The room
 * below sits near 0, so the apparent drift is enormous and permanent.
 */
class LiveEdgeAdapter implements PlayerAdapter {
  readonly kind = 'native' as const;
  readonly seeks: number[] = [];
  readonly transport: string[] = [];
  /** Flipped to make the SAME player look like an ordinary file — the control
   *  that proves these cases are not passing by inaction. */
  live = true;
  private readonly startedAt: number;

  constructor(nowMs: number) {
    this.startedAt = nowMs;
  }

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
  setRate(): void {}
  positionMs(): number {
    // Three hours into the broadcast when the room joined, and running.
    return 3 * 60 * 60 * 1000 + (Date.now() - this.startedAt);
  }
  durationMs(): number {
    return 0;
  }
  isLive(): boolean {
    return this.live;
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

describe('adapterIsLive', () => {
  /**
   * Most adapters cannot be live and do not implement the method at all.
   * "Cannot say" has to answer the same as "not live", because false is the
   * branch that keeps drift correction ON: the alternative is an adapter
   * silently opting an ordinary item out of sync by staying quiet.
   */
  it('answers false for an adapter that cannot be live at all', () => {
    expect(adapterIsLive(null)).toBe(false);
    const vimeo: PlayerAdapter = new VimeoAdapter(document.createElement('div'));
    expect(vimeo.isLive).toBeUndefined();
    expect(adapterIsLive(vimeo)).toBe(false);
  });
});

describe('a live stream on the stage', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let adapter: LiveEdgeAdapter;
  let clock: ClockEstimator;
  let samples: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetStageLive();
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
    resetStageLive();
    vi.useRealTimers();
  });

  function state(over: Partial<PlaybackState> = {}): PlaybackState {
    return {
      mediaRef: STREAM,
      positionMs: 0,
      rate: 1,
      playing: true,
      serverTs: 0,
      seq: 1,
      queueIndex: 0,
      ...over,
    };
  }

  function Harness({ playback }: { playback: PlaybackState }): null {
    useSyncEngine({
      adapter,
      playback,
      clock,
      tickMs: TICK_MS,
      onDriftSample: (ms) => samples.push(ms),
    });
    return null;
  }

  function mount(playback: PlaybackState = state()): void {
    adapter = new LiveEdgeAdapter(Date.now());
    samples = [];
    clock = new ClockEstimator();
    // A measured offset of 0: without a sample the engine refuses to correct a
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

  it('is never seeked, however far the room says it has drifted', () => {
    mount();
    run(30_000);

    expect(adapter.seeks).toEqual([]);
  });

  /** The control. The same player, the same impossible drift, described as an
   *  ordinary file — this is the loop the fix exists to stop. */
  it('…while the same drift on an ordinary player is corrected', () => {
    mount();
    adapter.live = false;
    run(30_000);

    expect(adapter.seeks.length).toBeGreaterThan(0);
  });

  /**
   * Not 0, which would read as "perfectly in sync" — the one claim this engine
   * has deliberately stopped being able to make about a live item.
   */
  it('reports no drift it is no longer measuring', () => {
    mount();
    run(5_000);

    expect(samples).toEqual([]);
  });

  /** It is still a room. Play and pause are host intent and apply as ever. */
  it('still carries the room’s transport', () => {
    mount();
    run(1_000);
    render(state({ seq: 2, playing: false, serverTs: Date.now() }));
    render(state({ seq: 3, playing: true, serverTs: Date.now() }));
    run(1_000);

    expect(adapter.transport.slice(-2)).toEqual(['pause', 'play']);
    expect(adapter.seeks).toEqual([]);
  });

  /** What the chrome badges. Published by the engine, because liveness is
   *  discovered by the player rather than declared by the URL. */
  it('publishes the fact for the chrome, and withdraws it with the player', () => {
    mount();
    expect(getStageLive()).toBe(false);
    run(TICK_MS);
    expect(getStageLive()).toBe(true);

    act(() => {
      root?.unmount();
    });
    root = null;
    expect(getStageLive()).toBe(false);
  });

  it('says nothing is live when nothing is', () => {
    mount();
    adapter.live = false;
    run(TICK_MS * 2);

    expect(getStageLive()).toBe(false);
  });
});
