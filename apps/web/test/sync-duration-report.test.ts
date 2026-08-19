// @vitest-environment jsdom
/**
 * THE CLIENT HALF OF `sync.duration` — the producer, not just a handler.
 *
 * `QueueItem.durationMs` is null for nearly every row this product carries.
 * The server-side resolver can only read a length out of an oEmbed response and
 * of the six keyless endpoints only Vimeo's has the field: YouTube's does not,
 * SoundCloud's does not, the Open Graph fallback has none, and a DRM title page
 * or a `{ kind: 'page' }` link never had one to give (packages/contracts ws.ts
 * spells this out at length). The number is not on any wire the server may
 * read — it is in every viewer's player, one `HTMLMediaElement.duration` away.
 *
 * The contract and the server handler for it already shipped. Nothing sent it.
 * A handler with no producer is a mechanism that passes its own tests and does
 * nothing in the product, so what these cases pin is the SEND: through the real
 * stage, from the real hook, with the real room connection underneath.
 *
 * Both driving surfaces are here, because either one can be the only player in
 * the room: this page's own adapter, and the extension — which is the ONLY
 * surface that can ever answer for the DRM and `page` items whose rows the
 * resolver was structurally unable to fill.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, Member, PlaybackState, QueueItem } from '@gather/contracts';
import type { ExtensionPlayback } from '@/lib/player/extension-driver';

/**
 * The driven-player store, made controllable. Spread over the real module so
 * everything else in it — `useExtensionDriver` above all, which the stage needs
 * to decide whether to build a player at all — behaves exactly as it ships.
 */
const drivenListeners = new Set<(playback: ExtensionPlayback) => void>();
vi.mock('@/lib/player/extension-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/player/extension-driver')>();
  return {
    ...actual,
    extensionPlaybackStore: () => ({
      getSnapshot: () => actual.NO_EXTENSION_PLAYBACK,
      subscribe: () => () => undefined,
      observe: (cb: (playback: ExtensionPlayback) => void) => {
        drivenListeners.add(cb);
        return () => drivenListeners.delete(cb);
      },
      dispose: () => undefined,
    }),
  };
});

/** Every adapter the stage can construct, reporting a length on demand. */
class FakeAdapter {
  static live: FakeAdapter | null = null;
  static durationMs = 0;
  readonly kind = 'youtube';
  private readonly listeners = new Map<string, Set<() => void>>();
  private position = 0;

  constructor() {
    FakeAdapter.live = this;
  }

  on(evt: string, cb: () => void): () => void {
    let set = this.listeners.get(evt);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(evt, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  emit(evt: string): void {
    for (const cb of [...(this.listeners.get(evt) ?? [])]) cb();
  }

  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(ms: number): void {
    this.position = ms;
  }
  setRate(): void {}
  positionMs(): number {
    return this.position;
  }
  durationMs(): number {
    return FakeAdapter.durationMs;
  }
  setMuted(): void {}
  isMuted(): boolean {
    return false;
  }
  setVolume(): void {}
  setDuck(): void {}
  destroy(): void {}
}

vi.mock('@/lib/player/native', () => ({ NativeAdapter: FakeAdapter }));
vi.mock('@/lib/player/youtube', () => ({ YouTubeAdapter: FakeAdapter }));
vi.mock('@/lib/player/soundcloud', () => ({ SoundCloudAdapter: FakeAdapter }));
vi.mock('@/lib/player/vimeo', () => ({ VimeoAdapter: FakeAdapter }));
vi.mock('@/lib/player/embed', () => ({ EmbedAdapter: FakeAdapter }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { useSyncEngine } = await import('@/lib/player/useSyncEngine');
const { NO_EXTENSION_PLAYBACK } = await import('@/lib/player/extension-driver');
const { ROOM_ID, makeMember, makeRoom, queueItem } = await import('./helpers/room-render');
type RoomConnection = ReturnType<typeof useRoomConnection>;

const h = React.createElement;

const VIDEO: MediaRef = { kind: 'youtube', videoId: 'the-one-playing' };
/** The long-tail item only the extension can ever play — and exactly the row
 *  the server-side resolver can never fill. */
const PAGE: MediaRef = { kind: 'page', url: 'https://example.com/watch/one' };

/** 45 minutes, in ms — a plausible episode. */
const REAL_LENGTH_MS = 2_700_000;

let captured: RoomConnection | null = null;
/** Every frame this client sent, by type. */
let sent: { type: string; payload: unknown }[] = [];

function Seeded({
  patch,
  children,
}: {
  patch: Record<string, unknown>;
  children?: React.ReactNode;
}) {
  const connection = useRoomConnection();
  if (captured === null) {
    captured = connection;
    sent = [];
    // The socket in this harness has never connected, and `RoomSocket.send`
    // throws outright before it has (see RoomConnection.markChatSeen). Record
    // instead — what is under test is what the engine decides to say.
    vi.spyOn(connection.rawSocket, 'send').mockImplementation(((
      type: string,
      payload: unknown,
    ) => {
      sent.push({ type, payload });
    }) as never);
  }
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

const durationFrames = (): unknown[] =>
  sent.filter((frame) => frame.type === 'sync.duration').map((frame) => frame.payload);

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe('the length this page’s own player learned', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    FakeAdapter.live = null;
    FakeAdapter.durationMs = 0;
    captured = null;
    sent = [];
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Mounts the stage on `items[0]`, already playing. */
  async function mountPlaying(
    items: QueueItem[],
    playbackOver: Partial<PlaybackState> = {},
  ): Promise<FakeAdapter> {
    const patch = {
      playback: {
        mediaRef: VIDEO,
        positionMs: 0,
        rate: 1,
        playing: true,
        serverTs: Date.now(),
        seq: 1,
        queueIndex: 0,
        ...playbackOver,
      },
      queue: { items, version: 1 },
    };
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member: makeMember('member' as Member['role']) } as never,
          h(Seeded, { patch }, h(StagePane, { roomId: ROOM_ID })),
        ),
      );
    });
    const player = FakeAdapter.live;
    if (player === null) throw new Error('the stage never built a player');
    return player;
  }

  /** The player comes up, starts, and runs for a few correction passes. */
  async function startAndRun(player: FakeAdapter, ms = 2_000): Promise<void> {
    await act(async () => {
      player.emit('ready');
      player.emit('playing');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('reaches the room once, naming the item that is playing', async () => {
    const items = [queueItem(VIDEO, 'the one playing'), queueItem(PAGE, 'the one after')];
    FakeAdapter.durationMs = REAL_LENGTH_MS;
    const player = await mountPlaying(items);
    await startAndRun(player);

    // ONE frame, however many correction passes ran — the report is per item,
    // not per tick.
    expect(durationFrames()).toEqual([{ itemId: items[0]?.id, durationMs: REAL_LENGTH_MS }]);
  });

  it('does not send until the player has actually started this item', async () => {
    const items = [queueItem(VIDEO, 'the one playing')];
    FakeAdapter.durationMs = REAL_LENGTH_MS;
    await mountPlaying(items);
    // Ticks are running; the player has not reported that it is playing, so
    // whatever `durationMs()` answers may still describe the item BEFORE this
    // one (YouTube's getDuration does exactly that across a loadVideoById).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(durationFrames()).toEqual([]);
  });

  /** Infinity is not a length. The contract's payload is `finite().positive()`
   *  and the server's unknown-duration branch is the right answer for a stream
   *  that has no end. */
  it('never reports a live stream', async () => {
    const items = [queueItem(VIDEO, 'the live one')];
    FakeAdapter.durationMs = Number.POSITIVE_INFINITY;
    const player = await mountPlaying(items);
    await startAndRun(player);
    expect(durationFrames()).toEqual([]);
  });

  it('says nothing while the length is still unknown', async () => {
    const items = [queueItem(VIDEO, 'pre-metadata')];
    FakeAdapter.durationMs = 0; // every adapter's "not known yet"
    const player = await mountPlaying(items);
    await startAndRun(player);
    expect(durationFrames()).toEqual([]);
  });

  /** The server writes only onto a row whose duration is unset, so a report for
   *  a row that already has one is a no-op it must load the room to discover. */
  it('does not re-report a length the room already has', async () => {
    const known = { ...queueItem(VIDEO, 'already measured'), durationMs: REAL_LENGTH_MS };
    FakeAdapter.durationMs = REAL_LENGTH_MS;
    const player = await mountPlaying([known]);
    await startAndRun(player);
    expect(durationFrames()).toEqual([]);
  });

  /** The queue moves under the playing item; the report is a FILL against one
   *  id, so naming the wrong row writes a wrong length onto an item nobody is
   *  playing. Nothing matches here, so nothing is said. */
  it('says nothing when no queue row answers to what is playing', async () => {
    const items = [queueItem(PAGE, 'something else entirely')];
    FakeAdapter.durationMs = REAL_LENGTH_MS;
    const player = await mountPlaying(items, { queueIndex: null });
    await startAndRun(player);
    expect(durationFrames()).toEqual([]);
  });
});

describe('the length the extension learned, on a room this page cannot play', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    captured = null;
    sent = [];
    drivenListeners.clear();
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    drivenListeners.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The engine with NO adapter — which is exactly what the stage hands it
   *  while the extension is the driver, so that this page never builds a
   *  second player for one room. */
  async function mountDeferring(items: QueueItem[]): Promise<void> {
    const playback: PlaybackState = {
      mediaRef: PAGE,
      positionMs: 0,
      rate: 1,
      playing: true,
      serverTs: Date.now(),
      seq: 1,
      queueIndex: 0,
    };
    function Harness(): null {
      const connection = useRoomConnection();
      useSyncEngine({ adapter: null, playback, clock: connection.clock });
      return null;
    }
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member: makeMember('member' as Member['role']) } as never,
          h(
            Seeded,
            { patch: { playback, queue: { items, version: 1 } } },
            h(Harness, null),
          ),
        ),
      );
    });
  }

  const drive = (over: Partial<ExtensionPlayback>): void => {
    act(() => {
      for (const cb of [...drivenListeners]) {
        cb({ ...NO_EXTENSION_PLAYBACK, updatedAt: Date.now(), ...over });
      }
    });
  };

  it('reports the driven tab’s length, once', async () => {
    const items = [queueItem(PAGE, 'a page only the extension can play')];
    await mountDeferring(items);

    drive({ playing: true, durationMs: REAL_LENGTH_MS });
    drive({ playing: true, durationMs: REAL_LENGTH_MS });

    expect(durationFrames()).toEqual([{ itemId: items[0]?.id, durationMs: REAL_LENGTH_MS }]);
  });

  it('waits for a frame that says the tab is actually playing', async () => {
    const items = [queueItem(PAGE, 'a page only the extension can play')];
    await mountDeferring(items);

    // A tab that has not started may still be reporting the previous item's
    // metadata — the same reason the web adapter waits for 'playing'.
    drive({ playing: false, durationMs: REAL_LENGTH_MS });
    expect(durationFrames()).toEqual([]);

    drive({ playing: true, durationMs: REAL_LENGTH_MS });
    expect(durationFrames()).toHaveLength(1);
  });

  it('says nothing for a stream with no length', async () => {
    const items = [queueItem(PAGE, 'a live page')];
    await mountDeferring(items);
    drive({ playing: true, durationMs: 0 });
    expect(durationFrames()).toEqual([]);
  });
});
