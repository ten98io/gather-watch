/**
 * The phone reporting the end of an item — the half of auto-advance mobile
 * never had.
 *
 * The stall this closes: the host watches on their phone and nobody is on the
 * web, so no client in the room emits an ending, and the queue stops on the
 * first item forever. `sync.advance` is ungated and compare-and-set, so the
 * phone may simply say what it saw; nothing here elects anybody.
 *
 * Node env, no RN: the pieces under test are the pure item resolution, the
 * player subscription (`armEndOfItem`, which takes any object with the one
 * listener expo-video gives us), and RoomConnection over a fake WebSocket.
 * The only thing left untested is React's two lines of useRef/useEffect glue.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ListMessagesResponse,
  MediaRef,
  PlaybackState,
  QueueItem,
  ReplayEventsResponse,
  RoomId,
  ServerEvent,
  WsEnvelope,
} from '@gather/contracts';
import type { RestClient, WebSocketLike } from '@gather/api-client';
import { RoomConnection } from '../src/room-connection';
import { endedQueueItemId } from '../src/sync/advance';
import { armEndOfItem } from '../src/sync/useSyncEngine';

const ROOM = 'r1' as RoomId;

const FEATURE: MediaRef = { kind: 'url', url: 'https://cdn.test/feature.mp4', mime: 'video/mp4' };
const SECOND: MediaRef = { kind: 'url', url: 'https://cdn.test/second.mp4', mime: 'video/mp4' };

function item(id: string, mediaRef: MediaRef): QueueItem {
  return {
    id: id as QueueItem['id'],
    mediaRef,
    title: id,
    durationMs: null,
    artworkUrl: null,
    addedBy: 'u1' as QueueItem['addedBy'],
    votesToSkip: [],
  };
}

/* ── which item ended ── */

describe('endedQueueItemId', () => {
  it('reads the recorded index when it still names what is playing', () => {
    const items = [item('q_a', FEATURE), item('q_b', SECOND)];
    expect(endedQueueItemId({ queueIndex: 0, items, mediaRef: FEATURE })).toBe('q_a');
  });

  it('finds the playing item when the index has gone stale', () => {
    // Something ahead of it was removed; index 1 now names a different row.
    const items = [item('q_b', SECOND)];
    expect(endedQueueItemId({ queueIndex: 1, items, mediaRef: SECOND })).toBe('q_b');
  });

  it('tells apart the same media queued twice, by the index', () => {
    const items = [item('q_a', FEATURE), item('q_again', FEATURE)];
    expect(endedQueueItemId({ queueIndex: 1, items, mediaRef: FEATURE })).toBe('q_again');
  });

  it('still answers when no index was recorded at all', () => {
    // A setTrack of kind 'media' records no queueIndex.
    const items = [item('q_a', FEATURE), item('q_b', SECOND)];
    expect(endedQueueItemId({ queueIndex: null, items, mediaRef: SECOND })).toBe('q_b');
  });

  it('says nothing when the finished item is no longer in the queue', () => {
    // Vote-skip carried it off mid-play. Naming the row now at that index
    // would advance PAST it — a second item skipped, from one vote-skip.
    const items = [item('q_b', SECOND)];
    expect(endedQueueItemId({ queueIndex: 0, items, mediaRef: FEATURE })).toBeNull();
  });

  it('says nothing when nothing is playing', () => {
    expect(endedQueueItemId({ queueIndex: 0, items: [item('q_a', FEATURE)], mediaRef: null }))
      .toBeNull();
  });
});

/* ── the player's end signal ── */

/** expo-video's player, reduced to the one thing this wiring needs. */
function fakePlayer() {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    addListener(_name: 'playToEnd', listener: () => void) {
      listeners.push(listener);
      return {
        remove: () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
    end(): void {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('armEndOfItem', () => {
  it('latches the end AND reports it', () => {
    const player = fakePlayer();
    const ended = { current: false };
    const onEnded = vi.fn();

    armEndOfItem(player, ended, onEnded);
    player.end();

    // The latch is what stops drift correction seeking a finished player.
    expect(ended.current).toBe(true);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('lets go of the player and the latch when the item changes', () => {
    const player = fakePlayer();
    const ended = { current: false };
    const onEnded = vi.fn();

    const off = armEndOfItem(player, ended, onEnded);
    player.end();
    off();

    // Re-armed per media+epoch: a latch left standing would silence the
    // engine for the FOLLOWING item, and a listener left attached would
    // report the next item's end through the previous item's closure.
    expect(ended.current).toBe(false);
    expect(player.listeners).toHaveLength(0);
    player.end();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});

/* ── the intent, on the wire ── */

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  open(): void {
    this.onopen?.();
  }

  push(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function env(type: ServerEvent['type'], seq: number, payload: unknown): ServerEvent {
  return { type, roomId: ROOM, seq, ts: 1_000, payload } as ServerEvent;
}

function playbackOn(index: number | null, mediaRef: MediaRef, seq: number): PlaybackState {
  return {
    mediaRef,
    positionMs: 600_000,
    rate: 1,
    playing: true,
    serverTs: 1_000,
    seq,
    queueIndex: index,
  };
}

function makeConn() {
  const conn = new RoomConnection({
    rest: {
      events: { replay: vi.fn(() => Promise.resolve<ReplayEventsResponse>({ events: [] })) },
      messages: {
        listMessages: () => Promise.resolve<ListMessagesResponse>({ items: [], nextCursor: null }),
      },
    } as unknown as Pick<RestClient, 'events' | 'messages'>,
    wsUrl: 'wss://example.test/ws',
    wsCtor: FakeSocket as unknown as new (url: string) => WebSocketLike,
    heartbeatMs: 60_000,
  });
  conn.connect(ROOM, 'test-token', { initialSeq: 0 });
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (socket === undefined) throw new Error('no socket created');
  socket.open();
  return { conn, socket };
}

/** Every sync.advance payload this client put on the wire, in order. */
function advances(socket: FakeSocket): unknown[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as WsEnvelope)
    .filter((frame) => frame.type === 'sync.advance')
    .map((frame) => frame.payload);
}

describe('reporting the end to the room', () => {
  it('names the ended item, by id', () => {
    const { conn, socket } = makeConn();
    socket.push(env('queue.state', 1, { items: [item('q_a', FEATURE), item('q_b', SECOND)], version: 1 }));
    socket.push(env('sync.state', 2, playbackOn(0, FEATURE, 1)));

    conn.reportEndedItem();

    expect(advances(socket)).toEqual([{ endedItemId: 'q_a' }]);
    conn.close();
  });

  it('is what the player`s end signal actually reaches', () => {
    const { conn, socket } = makeConn();
    socket.push(env('queue.state', 1, { items: [item('q_a', FEATURE)], version: 1 }));
    socket.push(env('sync.state', 2, playbackOn(0, FEATURE, 1)));

    // The whole mobile chain, minus React: expo-video runs out → the engine's
    // end guard → the room.
    const player = fakePlayer();
    armEndOfItem(player, { current: false }, () => conn.reportEndedItem());
    player.end();

    expect(advances(socket)).toEqual([{ endedItemId: 'q_a' }]);
    conn.close();
  });

  it('fires once per item, however many ends arrive', () => {
    const { conn, socket } = makeConn();
    socket.push(env('queue.state', 1, { items: [item('q_a', FEATURE), item('q_b', SECOND)], version: 1 }));
    socket.push(env('sync.state', 2, playbackOn(0, FEATURE, 1)));

    conn.reportEndedItem();
    conn.reportEndedItem();
    conn.reportEndedItem();

    expect(advances(socket)).toEqual([{ endedItemId: 'q_a' }]);
    conn.close();
  });

  it('does not latch: the NEXT item is reportable too', () => {
    const { conn, socket } = makeConn();
    socket.push(env('queue.state', 1, { items: [item('q_a', FEATURE), item('q_b', SECOND)], version: 1 }));
    socket.push(env('sync.state', 2, playbackOn(0, FEATURE, 1)));
    conn.reportEndedItem();

    // The server's answer to that report: the room moved on.
    socket.push(env('sync.state', 3, playbackOn(1, SECOND, 2)));
    conn.reportEndedItem();

    expect(advances(socket)).toEqual([{ endedItemId: 'q_a' }, { endedItemId: 'q_b' }]);
    conn.close();
  });

  it('stays silent when the finished item is not in the queue', () => {
    const { conn, socket } = makeConn();
    socket.push(env('queue.state', 1, { items: [item('q_b', SECOND)], version: 1 }));
    socket.push(env('sync.state', 2, playbackOn(0, FEATURE, 1)));

    conn.reportEndedItem();

    expect(advances(socket)).toEqual([]);
    conn.close();
  });

  it('stays silent before the room has said what is playing', () => {
    const { conn, socket } = makeConn();
    socket.push(env('queue.state', 1, { items: [item('q_a', FEATURE)], version: 1 }));

    conn.reportEndedItem();

    expect(advances(socket)).toEqual([]);
    conn.close();
  });
});
