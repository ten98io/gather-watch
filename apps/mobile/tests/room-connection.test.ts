/**
 * RoomConnection logic tests (node env, no RN): gap recovery with replay
 * backfill + dedupe, reducer behavior for chat/queue/presence/sync events,
 * and gap-loss fallback. RoomSocket is driven through a fake WebSocket; the
 * REST replay/list calls are stubbed.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ListMessagesResponse,
  Message,
  PresenceEntry,
  QueueItem,
  ReplayEventsResponse,
  RoomId,
  ServerEvent,
  UserId,
  WsEnvelope,
} from '@gather/contracts';
import type { RestClient, WebSocketLike } from '@gather/api-client';
import { RoomConnection, applyReaction, insertMessage } from '../src/room-connection';

const ROOM = 'r1' as RoomId;
const ME = 'u-me' as UserId;
const OTHER = 'u-other' as UserId;

function makeMessage(seq: number, body = `msg ${seq}`): Message {
  return {
    id: `m${seq}` as Message['id'],
    roomId: ROOM,
    authorId: OTHER,
    kind: 'text',
    body,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt: null,
    seq,
    createdAt: 1_000 + seq,
  };
}

function env(type: ServerEvent['type'], seq: number, payload: unknown): ServerEvent {
  return { type, roomId: ROOM, seq, ts: 1_000, payload } as ServerEvent;
}

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  // Test drivers:
  open(): void {
    this.onopen?.();
  }

  push(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function makeConn(overrides?: {
  replay?: (roomId: RoomId, sinceSeq: number) => Promise<ReplayEventsResponse>;
  listMessages?: () => Promise<ListMessagesResponse>;
}) {
  const replay =
    overrides?.replay ?? vi.fn(() => Promise.resolve<ReplayEventsResponse>({ events: [] }));
  const listMessages =
    overrides?.listMessages ??
    vi.fn(() => Promise.resolve<ListMessagesResponse>({ items: [], nextCursor: null }));
  const conn = new RoomConnection({
    rest: {
      events: { replay },
      messages: { listMessages: () => listMessages() },
    } as unknown as Pick<RestClient, 'events' | 'messages'>,
    wsUrl: 'wss://example.test/ws',
    wsCtor: FakeSocket as unknown as new (url: string) => WebSocketLike,
    heartbeatMs: 60_000, // keep the heartbeat out of these tests
    replayRetryDelayMs: 1,
  });
  conn.connect(ROOM, 'test-token', { initialSeq: 0 });
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (socket === undefined) throw new Error('no socket created');
  socket.open();
  return { conn, socket, replay, listMessages };
}

describe('RoomConnection', () => {
  it('applies in-order events and sends typed client frames', async () => {
    const { conn, socket } = makeConn();
    socket.push(env('chat.message', 1, makeMessage(1)));
    socket.push(env('chat.message', 2, makeMessage(2)));
    await vi.waitFor(() => expect(conn.store.getState().messages).toHaveLength(2));

    conn.chatSend({ body: 'hello room' });
    const frame = JSON.parse(socket.sent[socket.sent.length - 1] ?? '{}') as WsEnvelope & {
      payload: { body: string; kind: string };
    };
    expect(frame.type).toBe('chat.send');
    expect(frame.seq).toBe(0);
    expect(frame.payload.kind).toBe('text');
    expect(frame.payload.body).toBe('hello room');
    conn.close();
  });

  it('closes a seq gap via replayFetch and dedupes replayed/live events', async () => {
    const replay = vi.fn((roomId: RoomId, sinceSeq: number) => {
      expect(roomId).toBe(ROOM);
      expect(sinceSeq).toBe(1);
      return Promise.resolve<ReplayEventsResponse>({ events: [env('chat.message', 2, makeMessage(2))] });
    });
    const { conn, socket } = makeConn({ replay });

    socket.push(env('chat.message', 1, makeMessage(1)));
    socket.push(env('chat.message', 3, makeMessage(3))); // gap at 2 → replay

    await vi.waitFor(() => {
      expect(conn.store.getState().messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    });
    expect(replay).toHaveBeenCalledTimes(1);

    // A duplicate (e.g. replay echoed by a reconnect) must not double-apply.
    socket.push(env('chat.message', 2, makeMessage(2, 'dupe')));
    socket.push(env('chat.message', 3, makeMessage(3, 'dupe')));
    await Promise.resolve();
    expect(conn.store.getState().messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(conn.store.getState().messages[0]?.body).toBe('msg 1');
    conn.close();
  });

  it('merges reactions onto the target message (add dedupe + remove)', async () => {
    const { conn, socket } = makeConn();
    socket.push(env('chat.message', 1, makeMessage(1)));
    await vi.waitFor(() => expect(conn.store.getState().messages).toHaveLength(1));

    const react = (op: 'add' | 'remove', userId: UserId, seq: number) =>
      socket.push(env('chat.reaction', seq, { messageId: 'm1', emoji: '🔥', userId, op }));

    react('add', OTHER, 2);
    react('add', OTHER, 3); // duplicate add — no double count
    react('add', ME, 4);
    await vi.waitFor(() => {
      expect(conn.store.getState().messages[0]?.reactions['🔥']).toEqual([OTHER, ME]);
    });

    react('remove', OTHER, 5);
    await vi.waitFor(() => {
      expect(conn.store.getState().messages[0]?.reactions['🔥']).toEqual([ME]);
    });
    conn.close();
  });

  it('applies queue snapshots, presence state+diff, and sync seq guard', async () => {
    const { conn, socket } = makeConn();

    const item: QueueItem = {
      id: 'q1' as QueueItem['id'],
      mediaRef: { kind: 'url', url: 'https://cdn.test/a.mp4', mime: 'video/mp4' },
      title: 'a.mp4',
      durationMs: null,
      artworkUrl: null,
      addedBy: OTHER,
      votesToSkip: [],
    };
    socket.push(env('queue.state', 1, { items: [item], version: 7 }));
    await vi.waitFor(() => expect(conn.store.getState().queue.version).toBe(7));

    const entry = (userId: UserId, micOn: boolean): PresenceEntry => ({
      userId,
      state: 'in-call',
      micOn,
      camOn: false,
      sharing: false,
      lastSeenTs: 1,
    });
    socket.push(env('presence.state', 2, { entries: [entry(OTHER, false)] }));
    socket.push(env('presence.diff', 3, { upserts: [entry(ME, true)], removed: [] }));
    socket.push(env('presence.diff', 4, { upserts: [], removed: [OTHER] }));
    await vi.waitFor(() => {
      const presence = conn.store.getState().presence;
      expect(presence[ME]?.micOn).toBe(true);
      expect(presence[OTHER]).toBeUndefined();
    });

    const playback = (seq: number, positionMs: number) => ({
      mediaRef: null,
      positionMs,
      rate: 1,
      playing: false,
      serverTs: 1_000,
      seq,
      queueIndex: null,
    });
    socket.push(env('sync.state', 5, playback(50, 9_000)));
    socket.push(env('sync.state', 6, playback(49, 1_000))); // stale seq → ignored
    await vi.waitFor(() => {
      expect(conn.store.getState().playback?.positionMs).toBe(9_000);
    });
    conn.close();
  });

  it('onGapLoss bumps gapLossCount and reloads the chat window', async () => {
    const replay = vi.fn(() => Promise.reject<ReplayEventsResponse>(new Error('replay down')));
    const recovered = makeMessage(42, 'recovered');
    const listMessages = vi.fn(() =>
      Promise.resolve<ListMessagesResponse>({ items: [recovered], nextCursor: null }),
    );
    const { conn, socket } = makeConn({ replay, listMessages });

    socket.push(env('chat.message', 1, makeMessage(1)));
    socket.push(env('chat.message', 3, makeMessage(3)));

    await vi.waitFor(
      () => {
        expect(conn.store.getState().gapLossCount).toBe(1);
      },
      { timeout: 4_000 },
    );
    await vi.waitFor(() => {
      expect(conn.store.getState().messages.some((m) => m.id === recovered.id)).toBe(true);
    });
    expect(replay.mock.calls.length).toBeGreaterThanOrEqual(3); // retried before giving up
    conn.close();
  });

  it('read cursors are monotonic per user', async () => {
    const { conn, socket } = makeConn();
    const cursor = (lastReadSeq: number, seq: number) =>
      socket.push(
        env('chat.read', seq, { roomId: ROOM, userId: OTHER, lastReadSeq, at: 1_000 }),
      );
    cursor(10, 1);
    cursor(7, 2); // older cursor arrives late — must not regress
    cursor(12, 3);
    await vi.waitFor(() => expect(conn.store.getState().readCursors[OTHER]).toBe(12));
    conn.close();
  });
});

describe('pure reducers', () => {
  it('insertMessage keeps ascending seq order, dedupes, and caps the window', () => {
    let list: Message[] = [];
    list = insertMessage(list, makeMessage(2));
    list = insertMessage(list, makeMessage(1));
    list = insertMessage(list, makeMessage(3));
    expect(list.map((m) => m.seq)).toEqual([1, 2, 3]);
    const again = insertMessage(list, { ...makeMessage(1), body: 'rewritten' });
    expect(again.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(again[0]?.body).toBe('msg 1'); // dedupe by id keeps the original
  });

  it('applyReaction removes the emoji key when the last user un-reacts', () => {
    const m = makeMessage(1);
    const added = applyReaction(m, '👍', ME, 'add');
    expect(added.reactions['👍']).toEqual([ME]);
    const removed = applyReaction(added, '👍', ME, 'remove');
    expect('👍' in removed.reactions).toBe(false);
  });
});
