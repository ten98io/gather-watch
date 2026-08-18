// @vitest-environment jsdom
/**
 * A LOAD THAT FAILS MUST SAY SO.
 *
 * `AdapterEvent` has carried 'error' since the interface was written, every
 * adapter emits it (NativeAdapter on the element's own error and on an HLS
 * manifest it cannot use; the iframe adapters on their providers' failures),
 * and StagePane subscribed to seven of the eight events. Not that one.
 *
 * Two things followed, and they are separate defects with one cause:
 *   1. the stage sat on CueingStage's "Starting…" for as long as the room
 *      stayed open, because nothing else ever clears that wait;
 *   2. the room's wait-for-all kept waiting. `load()` reports buffering, and a
 *      source that errors never reports the other edge — so one member's dead
 *      URL held everybody's playback.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from '@gather/contracts';

class FakeAdapter {
  static live: FakeAdapter | null = null;
  readonly kind = 'native';
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAdapter.live = this;
  }
  on(evt: string, cb: () => void): () => void {
    const set = this.listeners.get(evt) ?? new Set<() => void>();
    set.add(cb);
    this.listeners.set(evt, set);
    return () => set.delete(cb);
  }
  emit(evt: string): void {
    for (const cb of [...(this.listeners.get(evt) ?? [])]) cb();
  }
  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(): void {}
  setRate(): void {}
  positionMs(): number {
    return 0;
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
  destroy(): void {}
  get mediaElement(): { textTracks: { length: number }; currentSrc: string } {
    return { textTracks: { length: 0 }, currentSrc: 'https://cdn.example/dead.mp4' };
  }
}

vi.mock('@/lib/player/native', () => ({ NativeAdapter: FakeAdapter }));
vi.mock('@/lib/player/youtube', () => ({ YouTubeAdapter: FakeAdapter }));
vi.mock('@/lib/player/soundcloud', () => ({ SoundCloudAdapter: FakeAdapter }));
vi.mock('@/lib/player/vimeo', () => ({ VimeoAdapter: FakeAdapter }));
vi.mock('@/lib/player/embed', () => ({ EmbedAdapter: FakeAdapter }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { ROOM_ID, makeMember, makeRoom, queueItem } = await import('./helpers/room-render');
type RoomConnection = ReturnType<typeof useRoomConnection>;

const DEAD: MediaRef = { kind: 'url', url: 'https://cdn.example/dead.mp4', mime: 'video/mp4' };

const h = React.createElement;
let captured: RoomConnection | null = null;

function Seeded({ patch, children }: { patch: Record<string, unknown>; children?: React.ReactNode }) {
  const connection = useRoomConnection();
  captured = connection;
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

describe('a source that will not load', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    FakeAdapter.live = null;
    captured = null;
    vi.useFakeTimers({ now: 1_700_000_000_000 });
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
  });

  async function mountAndFail(): Promise<{
    player: FakeAdapter;
    buffering: ReturnType<typeof vi.fn>;
  }> {
    const items = [queueItem(DEAD, 'A dead link')];
    const patch = {
      playback: {
        mediaRef: DEAD,
        positionMs: 0,
        rate: 1,
        playing: true,
        serverTs: Date.now(),
        seq: 1,
        queueIndex: 0,
      },
      queue: { items, version: 1 },
    };
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member: makeMember('host'), roomId: ROOM_ID } as never,
          h(Seeded, { patch }, h(StagePane, { roomId: ROOM_ID })),
        ),
      );
    });
    const player = FakeAdapter.live;
    if (player === null) throw new Error('the stage never built a player');
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');

    const buffering = vi.fn();
    connection.syncBuffering = buffering as unknown as typeof connection.syncBuffering;

    // Exactly what a real one does: it starts loading, and then it gives up.
    await act(async () => {
      player.emit('buffering');
      player.emit('error');
      await vi.advanceTimersByTimeAsync(3_000);
    });
    return { player, buffering };
  }

  it('stops saying "Starting…" and says what happened instead', async () => {
    await mountAndFail();
    expect(host.textContent).not.toContain('Starting…');
    expect(host.textContent).toContain('This didn’t load on your device');
  });

  it('names the item, so it is clear WHICH thing failed', async () => {
    await mountAndFail();
    expect(host.textContent).toContain('A dead link');
  });

  it('covers the dead surface rather than floating behind it', async () => {
    await mountAndFail();
    // A listen room's hero paints at z-10 in the same stacking context, so a
    // transparent message at z-0 is a message nobody ever reads.
    const panel = host.querySelector<HTMLElement>('div.bg-surface-0');
    expect(panel?.textContent).toContain('This didn’t load on your device');
    expect(panel?.className).toContain('z-10');
    // …and inert, so the transport above it still takes clicks.
    expect(panel?.className).toContain('pointer-events-none');
  });

  it('releases the room’s wait-for-all instead of holding everyone', async () => {
    const { buffering } = await mountAndFail();
    expect(buffering.mock.calls.at(-1)).toEqual([false]);
  });

  it('clears the failure when the next item arrives', async () => {
    await mountAndFail();
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.useRoomState.setState((s) => ({
        playback: {
          ...(s.playback as NonNullable<typeof s.playback>),
          mediaRef: { kind: 'url', url: 'https://cdn.example/good.mp4', mime: 'video/mp4' },
          queueIndex: 0,
          seq: 2,
        },
      }));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(host.textContent).not.toContain('This didn’t load on your device');
  });
});
