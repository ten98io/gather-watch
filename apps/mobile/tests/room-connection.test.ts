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

/** Deterministic scheduler: nothing fires until the test says so. */
class ManualTimers {
  pending: { id: number; fn: () => void; ms: number }[] = [];
  private nextId = 1;

  set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.push({ id, fn, ms });
    return id;
  };

  clear = (handle: unknown): void => {
    const idx = this.pending.findIndex((e) => e.id === handle);
    if (idx >= 0) this.pending.splice(idx, 1);
  };

  /** Removes and runs the entry with the smallest delay. */
  runNext(): void {
    if (this.pending.length === 0) throw new Error('no pending timers');
    let best = 0;
    for (let i = 1; i < this.pending.length; i += 1) {
      if ((this.pending[i]?.ms ?? 0) < (this.pending[best]?.ms ?? 0)) best = i;
    }
    this.pending.splice(best, 1)[0]?.fn();
  }
}

/** The parsed payloads of every presence.update this client sent. */
function presenceFrames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
    .filter((frame) => frame.type === 'presence.update')
    .map((frame) => frame.payload);
}

/** Just the periodic beats. The one frame every open sends to ask for the
 *  room back is a presence.update too, but it is not a heartbeat. */
function keepaliveFrames(socket: FakeSocket): Record<string, unknown>[] {
  return presenceFrames(socket).filter((frame) => frame.wantSnapshot === undefined);
}

function makeConn(overrides?: {
  replay?: (roomId: RoomId, sinceSeq: number) => Promise<ReplayEventsResponse>;
  listMessages?: () => Promise<ListMessagesResponse>;
  timers?: ManualTimers;
  userId?: UserId;
  presenceKeepaliveMs?: number;
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
    ...(overrides?.timers === undefined
      ? {}
      : { setTimeoutFn: overrides.timers.set, clearTimeoutFn: overrides.timers.clear }),
    ...(overrides?.userId === undefined ? {} : { userId: overrides.userId }),
    ...(overrides?.presenceKeepaliveMs === undefined
      ? {}
      : { presenceKeepaliveMs: overrides.presenceKeepaliveMs }),
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

  it('beats presence inside the server TTL with the member current state', () => {
    const timers = new ManualTimers();
    const { conn, socket } = makeConn({ timers, userId: ME, presenceKeepaliveMs: 15_000 });
    socket.push(
      env('presence.state', 0, {
        entries: [
          { userId: ME, state: 'in-call', micOn: true, camOn: false, sharing: false, lastSeenTs: 1 },
        ],
      }),
    );
    expect(keepaliveFrames(socket)).toEqual([]);

    timers.runNext(); // the keepalive interval elapses
    // Without a beat the server expires this member after 45s even though the
    // socket is wide open — and it re-asserts 'in-call', not an idle default.
    expect(keepaliveFrames(socket)).toEqual([
      { state: 'in-call', micOn: true, camOn: false, sharing: false },
    ]);
    // A beat never asks for a snapshot: that would cost a full roster + sync
    // + queue reply every 15s, per client.
    expect(keepaliveFrames(socket)[0]).not.toHaveProperty('wantSnapshot');

    timers.runNext(); // it repeats, not once-and-done
    expect(keepaliveFrames(socket)).toHaveLength(2);

    conn.close();
    // Nothing is left ticking after an intentional close.
    expect(timers.pending).toHaveLength(0);
  });

  it('asks for the room back on the first frame of every open', () => {
    const timers = new ManualTimers();
    const { conn, socket } = makeConn({ timers, userId: ME, presenceKeepaliveMs: 15_000 });

    // Reconnecting is not rejoining: the presence entry outlives the drop, so
    // the server sees an ordinary heartbeat and — unless this client asks —
    // replies with nothing, leaving the screen on an empty queue, no playback
    // and an empty roster. Exactly one ask, on the open frame.
    expect(presenceFrames(socket)).toHaveLength(1);
    expect(presenceFrames(socket)[0]?.wantSnapshot).toBe(true);
    expect(presenceFrames(socket)[0]?.state).toBe('watching');

    timers.runNext();
    expect(presenceFrames(socket)).toHaveLength(2);
    expect(presenceFrames(socket)[1]).not.toHaveProperty('wantSnapshot');

    conn.close();
  });

  it('ignores a queue snapshot older than the one already applied', async () => {
    // The reply to our wantSnapshot ask is seq 0 — applied on arrival, past
    // gap detection and replay — and the server reads the room before it
    // awaits the presence heartbeat. So the answer to our own ask can be
    // older than a broadcast that already landed, and nothing would ever
    // correct it: there is no seq gap to replay.
    const { conn, socket } = makeConn();
    const item = (id: string, title: string): QueueItem => ({
      id: id as QueueItem['id'],
      mediaRef: { kind: 'url', url: 'https://cdn.test/a.mp4', mime: 'video/mp4' },
      title,
      durationMs: null,
      artworkUrl: null,
      addedBy: OTHER,
      votesToSkip: [],
    });

    socket.push(env('queue.state', 0, { items: [item('q1', 'a'), item('q2', 'b')], version: 8 }));
    await vi.waitFor(() => expect(conn.store.getState().queue.version).toBe(8));

    socket.push(env('queue.state', 0, { items: [item('q1', 'a')], version: 7 }));
    socket.push(env('queue.state', 0, { items: [item('q2', 'b')], version: 9 }));

    // The stale one left no mark; the newer one applied.
    await vi.waitFor(() => expect(conn.store.getState().queue.version).toBe(9));
    expect(conn.store.getState().queue.items.map((i) => i.id)).toEqual(['q2']);

    conn.close();
  });

  it('member.removed clears the presence entry and bumps membersVersion', async () => {
    const { conn, socket } = makeConn();
    socket.push(
      env('presence.state', 0, {
        entries: [
          { userId: ME, state: 'watching', micOn: false, camOn: false, sharing: false, lastSeenTs: 1 },
          { userId: OTHER, state: 'in-call', micOn: true, camOn: false, sharing: false, lastSeenTs: 1 },
        ],
      }),
    );
    await vi.waitFor(() => expect(conn.store.getState().presence[OTHER]).toBeDefined());
    const before = conn.store.getState().membersVersion;

    // The server has emitted this since the roster fix; nothing on the client
    // listened, so a kick, a ban or a departure stayed invisible.
    socket.push(env('member.removed', 0, { userId: OTHER, reason: 'kicked' }));

    await vi.waitFor(() => expect(conn.store.getState().presence[OTHER]).toBeUndefined());
    // The bump is what makes the People tab refetch its roster.
    expect(conn.store.getState().membersVersion).toBe(before + 1);
    // Everyone who stayed, stayed.
    expect(conn.store.getState().presence[ME]).toBeDefined();

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
