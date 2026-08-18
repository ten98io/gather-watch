// @vitest-environment jsdom
/**
 * THE regression test for the owner's report: "the transition between queued
 * items is not graceful, the youtube video after ending keeps looping like
 * pause-unpause and doesn't switch to the next in queue".
 *
 * Two separate defects produced that one symptom, and killing either alone
 * leaves it:
 *   1. `ended` reached a single listener that set a local boolean. Nothing in
 *      the web app ever called sync.setTrack except two user clicks, so the
 *      queue never advanced on its own.
 *   2. A finished player was restarted twice per second — once by the stage's
 *      "rescue a stub iframe that dropped play()" effect (which fires the
 *      instant `ended` clears localPlaying), and once by the drift controller,
 *      whose expectation kept climbing past the end of the item and prescribed
 *      a seek past it (YouTube's seekTo from a non-paused state PLAYS, lands at
 *      the end, and fires ENDED again).
 *
 * Client-rendered (jsdom), not the SSR harness: both halves live in effects and
 * their dependency arrays, and effects never run under renderToStaticMarkup.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, Member, PlaybackState } from '@gather/contracts';

const DURATION_MS = 60_000;
/** Where the room thinks the item is when the test starts: 2 s from the end. */
const START_MS = 58_000;

interface Call {
  call: string;
  arg: number | null;
}

// A recording stand-in for every adapter the stage can construct. jsdom has no
// media pipeline, so the assertions are about what the room ASKED the player to
// do after the source ran out.
class FakeAdapter {
  static live: FakeAdapter | null = null;
  readonly kind = 'youtube';
  readonly calls: Call[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();
  private position = START_MS;

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

  setPosition(ms: number): void {
    this.position = ms;
  }

  load(): void {
    this.calls.push({ call: 'load', arg: null });
  }
  play(): void {
    this.calls.push({ call: 'play', arg: null });
  }
  pause(): void {
    this.calls.push({ call: 'pause', arg: null });
  }
  seekTo(ms: number): void {
    this.calls.push({ call: 'seekTo', arg: ms });
  }
  setRate(rate: number): void {
    this.calls.push({ call: 'setRate', arg: rate });
  }
  positionMs(): number {
    return this.position;
  }
  durationMs(): number {
    return DURATION_MS;
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
const { ROOM_ID, makeMember, makeRoom, queueItem } = await import('./helpers/room-render');
type RoomConnection = ReturnType<typeof useRoomConnection>;

const ENDING: MediaRef = { kind: 'youtube', videoId: 'ending' };
const NEXT: MediaRef = { kind: 'youtube', videoId: 'next' };
/** A third slot, so "the item after the item after" is observable. */
const THIRD: MediaRef = { kind: 'youtube', videoId: 'third' };

const h = React.createElement;

let captured: RoomConnection | null = null;

function Seeded({
  patch,
  children,
}: {
  patch: Record<string, unknown>;
  children?: React.ReactNode;
}) {
  const connection = useRoomConnection();
  captured = connection;
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

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

describe('a queue item that runs out', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    FakeAdapter.live = null;
    captured = null;
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
  });

  /** Mounts the stage mid-item and returns the player + a setTrack recorder. */
  async function mountPlaying(
    role: Member['role'],
  ): Promise<{ player: FakeAdapter; setTrack: ReturnType<typeof vi.fn> }> {
    const items = [
      queueItem(ENDING, 'the one ending'),
      queueItem(NEXT, 'the one after'),
      queueItem(THIRD, 'the one after that'),
    ];
    // Built once so its identity is stable across re-renders: a fresh playback
    // object would re-run the stage's hard-resync effect and muddy the record.
    const patch = {
      playback: {
        mediaRef: ENDING,
        positionMs: START_MS,
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
          { room: makeRoom('watch'), member: makeMember(role), roomId: ROOM_ID } as never,
          h(Seeded, { patch }, h(StagePane, { roomId: ROOM_ID })),
        ),
      );
    });

    const player = FakeAdapter.live;
    if (player === null) throw new Error('the stage never built a player');
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    const setTrack = vi.fn();
    connection.syncSetTrackByQueue = setTrack as unknown as typeof connection.syncSetTrackByQueue;

    // The player comes up and starts, exactly as a real one reports it.
    await act(async () => {
      player.emit('ready');
      player.emit('playing');
    });
    return { player, setTrack };
  }

  /** The source runs out; a finished player sits at the end and stays there. */
  async function endAndSettle(player: FakeAdapter): Promise<Call[]> {
    const before = player.calls.length;
    await act(async () => {
      player.setPosition(DURATION_MS);
      player.emit('ended');
    });
    // Well past several 500 ms correction passes and the 1.5 s start watchdog.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    return player.calls.slice(before);
  }

  it('is not restarted, and hands the room the next item exactly once', async () => {
    const { player, setTrack } = await mountPlaying('host');
    const after = await endAndSettle(player);

    // (a) Nothing may restart a finished player. play() on an ENDED YouTube
    //     player — and .play() on an ended HTMLMediaElement — starts it from 0.
    expect(after.filter((c) => c.call === 'play')).toEqual([]);

    // (b) No correction may name a position past the end of the item. The
    //     room's projection keeps climbing; the item does not.
    expect(after.filter((c) => c.call === 'seekTo' && (c.arg ?? 0) > DURATION_MS)).toEqual([]);

    // (c) The queue advances, once, to the item that follows this one.
    expect(setTrack.mock.calls).toEqual([[1]]);
  });

  it('advances from the designated client only — every other viewer follows', async () => {
    // Elastic sync puts viewers at different offsets, so N viewers reach the
    // credits at N different moments. If they all advanced, the first one there
    // would yank everyone else out of the last ten seconds.
    const { player, setTrack } = await mountPlaying('member');
    const after = await endAndSettle(player);

    expect(setTrack.mock.calls).toEqual([]);
    // A follower whose own player ran out ahead of the room still must not be
    // restarted while it waits for the advance to arrive.
    expect(after.filter((c) => c.call === 'play')).toEqual([]);
    expect(after.filter((c) => c.call === 'seekTo' && (c.arg ?? 0) > DURATION_MS)).toEqual([]);
  });

  /**
   * E8 — WHAT MAY CLEAR THE TERMINAL LATCH.
   *
   * The latch and the advance guard were both keyed on
   * `mediaKey(mediaRef, playback.seq)`. But `seq` is not a track epoch: the
   * server mints a fresh one for EVERY playback mutation (services/api
   * sync/service.ts `mutate()` — play, pause, seek and rate all take one). So
   * pressing pause during the credits changed the key, cleared the latch that
   * says "this item is over here", and re-armed the advance guard. The next
   * play then restarted a finished player and handed the room on a second
   * time — one item silently skipped, from one pause.
   *
   * Only a new ITEM may clear it.
   */
  async function bumpPlayback(over: Partial<PlaybackState>): Promise<void> {
    const connection = captured;
    if (connection === null) throw new Error('no room connection was captured');
    await act(async () => {
      connection.useRoomState.setState((s) => {
        const current = s.playback;
        if (current === null) throw new Error('the room has no playback to bump');
        return { playback: { ...current, ...over } };
      });
      await Promise.resolve();
    });
  }

  it('survives a pause during the credits: the room is handed on once, not twice', async () => {
    const { player, setTrack } = await mountPlaying('host');
    await endAndSettle(player);
    expect(setTrack.mock.calls).toEqual([[1]]);

    // Someone hits pause over the credits, then play again. Same item, same
    // queue slot — two fresh seqs.
    await bumpPlayback({ playing: false, seq: 2, serverTs: Date.now() });
    await bumpPlayback({ playing: true, seq: 3, serverTs: Date.now() });

    // A player restarted by whatever survives that runs out again. The room
    // must recognise this as the SAME item ending, not a new one.
    await act(async () => {
      player.emit('ended');
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(setTrack.mock.calls).toEqual([[1]]);
  });

  it('a seek that does not change the item does not re-arm the advance either', async () => {
    const { player, setTrack } = await mountPlaying('host');
    await endAndSettle(player);

    await bumpPlayback({ positionMs: 30_000, seq: 2, serverTs: Date.now() });
    await act(async () => {
      player.emit('ended');
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(setTrack.mock.calls).toEqual([[1]]);
  });

  it('but a real track change does clear it — the next item may end too', async () => {
    // The latch must not outlive its item, or the room stops at the second one.
    const { player, setTrack } = await mountPlaying('host');
    await endAndSettle(player);
    expect(setTrack.mock.calls).toEqual([[1]]);

    // The advance lands: a different item, at a different queue slot.
    await bumpPlayback({ mediaRef: NEXT, queueIndex: 1, positionMs: 0, seq: 2 });
    await act(async () => {
      player.emit('ended');
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(setTrack.mock.calls).toEqual([[1], [2]]);
  });
});
