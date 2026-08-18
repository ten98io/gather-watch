// @vitest-environment jsdom
/**
 * THE STAGE'S HALF of auto-advance, after the master seat was deleted.
 *
 * REPLACES stage-advancer.test.ts and advancer-election.test.ts, whole. Those
 * two proved an election: the room chose ONE client to advance it, out of
 * `room.master` with a host fallback, and StagePane claimed the seat on mount.
 * The election was wrong in ordinary topologies — a host on a phone holds the
 * seat while mounting no advancer at all, a host transfer leaves the seat
 * naming the old host, and the client's claim gate was narrower than the
 * server's so the fallback was unreachable — and each patch to it produced a
 * new way for a room to sit on a finished item forever.
 *
 * There is no election now. Ending an item is not seizing control; it is the
 * queue doing the one thing a queue is for. So EVERY client that sees its item
 * end says so, naming the item, and the server compare-and-sets: it moves the
 * room only if the room is still on that exact item. The first report wins and
 * the rest are silent no-ops, which is why "who advances" no longer has to be
 * decided at all — and why none of the topologies above can stick.
 *
 * jsdom: every claim here lives in an effect or an adapter subscription.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, Member, PlaybackState, QueueItem, UserId } from '@gather/contracts';

const DURATION_MS = 60_000;

/** One recording stand-in for every adapter kind the stage can build. */
class FakeAdapter {
  /** Every adapter built since the last reset — a two-client case mounts two. */
  static built: FakeAdapter[] = [];
  readonly kind = 'youtube';
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAdapter.built.push(this);
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
    return DURATION_MS;
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
const { ROOM_ID, ME, makeMember, makeRoom, queueItem } = await import('./helpers/room-render');
type RoomConnection = ReturnType<typeof useRoomConnection>;

const ENDING: MediaRef = { kind: 'youtube', videoId: 'ending' };
const NEXT: MediaRef = { kind: 'youtube', videoId: 'next' };

/** A second person in the room, on their own tab. */
const OTHER = 'user-other' as UserId;

const h = React.createElement;

function Seeded({
  patch,
  onConnection,
  children,
}: {
  patch: Record<string, unknown>;
  onConnection: (c: RoomConnection) => void;
  children?: React.ReactNode;
}) {
  const connection = useRoomConnection();
  onConnection(connection);
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

/** One mounted tab: its player, its recorded intents, and its connection. */
interface Tab {
  player: FakeAdapter;
  ended: ReturnType<typeof vi.fn>;
  sent: Array<[string, unknown]>;
  connection: RoomConnection;
  root: Root;
  host: HTMLDivElement;
}

describe('an item that ends tells the room so', () => {
  const tabs: Tab[] = [];
  let items: QueueItem[] = [];

  beforeEach(() => {
    FakeAdapter.built = [];
    tabs.length = 0;
    items = [queueItem(ENDING, 'the one ending'), queueItem(NEXT, 'the one after')];
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
  });

  afterEach(async () => {
    for (const tab of tabs) {
      await act(async () => {
        tab.root.unmount();
      });
      tab.host.remove();
    }
    vi.useRealTimers();
  });

  /** Mounts one tab watching the first item, mid-credits. */
  async function mount(over: { role: Member['role']; userId?: UserId }): Promise<Tab> {
    const patch = {
      playback: {
        mediaRef: ENDING,
        positionMs: 58_000,
        rate: 1,
        playing: true,
        serverTs: Date.now(),
        seq: 1,
        queueIndex: 0,
      },
      queue: { items, version: 1 },
    };
    const member: Member = { ...makeMember(over.role), userId: over.userId ?? ME };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const before = FakeAdapter.built.length;
    let connection: RoomConnection | null = null;

    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member, roomId: ROOM_ID } as never,
          h(
            Seeded,
            {
              patch,
              onConnection: (c: RoomConnection) => {
                connection = c;
              },
            },
            h(StagePane, { roomId: ROOM_ID }),
          ),
        ),
      );
    });

    const player = FakeAdapter.built[before];
    if (player === undefined) throw new Error('the stage never built a player');
    if (connection === null) throw new Error('no room connection was captured');
    const live: RoomConnection = connection;

    const ended = vi.fn();
    live.syncAdvance = ended as unknown as typeof live.syncAdvance;
    const sent: Array<[string, unknown]> = [];
    vi.spyOn(live.rawSocket, 'send').mockImplementation(((type: string, payload: unknown) => {
      sent.push([type, payload]);
    }) as unknown as typeof live.rawSocket.send);

    await act(async () => {
      player.emit('ready');
      player.emit('playing');
    });

    const tab: Tab = { player, ended, sent, connection: live, root, host };
    tabs.push(tab);
    return tab;
  }

  async function endIt(tab: Tab): Promise<void> {
    await act(async () => {
      tab.player.emit('ended');
      await vi.advanceTimersByTimeAsync(2_000);
    });
  }

  /** Moves the room on, the way the server's sync.state would. */
  async function setPlayback(tab: Tab, over: Partial<PlaybackState>): Promise<void> {
    await act(async () => {
      tab.connection.useRoomState.setState((s) => {
        const current = s.playback;
        if (current === null) throw new Error('the room has no playback to move');
        return { playback: { ...current, ...over } };
      });
      await Promise.resolve();
    });
  }

  it('names the item that ended, not a queue position', async () => {
    // A position is a guess about someone else's array. An id is a fact, and
    // it is the fact the server compare-and-sets against.
    const tab = await mount({ role: 'host' });
    await endIt(tab);
    expect(tab.ended.mock.calls).toEqual([[items[0]?.id]]);
  });

  it('a plain member fires it too — this is the case the seat broke', async () => {
    // Host on a phone, host in another tab, host gone: under the election this
    // client stood down and the room sat on the credits forever. There is no
    // standing down any more; the server sorts out the duplicates.
    const tab = await mount({ role: 'member' });
    await endIt(tab);
    expect(tab.ended.mock.calls).toEqual([[items[0]?.id]]);
  });

  it('two clients both fire, and that is fine', async () => {
    // The property that replaces the election: N reports of one ending are
    // safe, because the second one finds the room already off that item and
    // the server no-ops it. Nothing here has to agree with anything there.
    const first = await mount({ role: 'host' });
    const second = await mount({ role: 'member', userId: OTHER });
    await endIt(first);
    await endIt(second);
    expect(first.ended.mock.calls).toEqual([[items[0]?.id]]);
    expect(second.ended.mock.calls).toEqual([[items[0]?.id]]);
  });

  it('fires once per item however many times the player says so', async () => {
    // Duplicates are harmless on the wire but pointless; a correction landing
    // on the end re-fires 'ended', and the extension never de-duplicates.
    const tab = await mount({ role: 'host' });
    await endIt(tab);
    await endIt(tab);
    await endIt(tab);
    expect(tab.ended.mock.calls).toEqual([[items[0]?.id]]);
  });

  it('the guard does not block the NEXT item', async () => {
    const tab = await mount({ role: 'host' });
    await endIt(tab);
    await setPlayback(tab, { mediaRef: NEXT, queueIndex: 1, positionMs: 0, seq: 2 });
    await endIt(tab);
    expect(tab.ended.mock.calls).toEqual([[items[0]?.id], [items[1]?.id]]);
  });

  it('the guard does not latch on an item the room comes BACK to', async () => {
    // The guard used to remember every key it had ever fired for, so replaying
    // an earlier item left the room permanently unable to leave it. Whatever
    // the server does with a stale report, the client must stay able to make a
    // fresh, legitimate one.
    const tab = await mount({ role: 'host' });
    await endIt(tab);
    await setPlayback(tab, { mediaRef: NEXT, queueIndex: 1, positionMs: 0, seq: 2 });
    await setPlayback(tab, { mediaRef: ENDING, queueIndex: 0, positionMs: 0, seq: 3 });
    await endIt(tab);
    expect(tab.ended.mock.calls).toEqual([[items[0]?.id], [items[0]?.id]]);
  });

  it('claims no seat — the election is gone, not merely unused', async () => {
    // The claim was sent on mount, so a mount that sends nothing is the proof.
    const tab = await mount({ role: 'host' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(tab.sent.filter(([type]) => type === 'sync.claimMaster')).toEqual([]);
  });
});
