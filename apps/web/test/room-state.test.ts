import { describe, expect, it } from 'vitest';
import { RestClient } from '@gather/api-client';
import type { FetchLike, WebSocketLike } from '@gather/api-client';
import type { Message, RoomId, ServerEvent, UserId } from '@gather/contracts';
import { RoomConnection } from '@/lib/room-connection';

class FakeSocket implements WebSocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static instances: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.instances = [];
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.();
  }

  deliver(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const ROOM = 'room-1' as RoomId;
const ME = 'user-me' as UserId;

let msgCounter = 0;
function makeMessage(over: Partial<Message> = {}): Message {
  msgCounter += 1;
  return {
    id: `m-${msgCounter}` as Message['id'],
    roomId: ROOM,
    authorId: 'user-other' as UserId,
    kind: 'text',
    body: `hello ${msgCounter}`,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt: null,
    seq: msgCounter,
    createdAt: 1_000 + msgCounter,
    ...over,
  };
}

function ev<T extends ServerEvent['type']>(
  type: T,
  seq: number,
  payload: Extract<ServerEvent, { type: T }>['payload'],
): ServerEvent {
  return { type, roomId: ROOM, seq, ts: 1_000, payload } as ServerEvent;
}

function makeConnection(): { conn: RoomConnection } {  FakeSocket.reset();
  const fetchImpl: FetchLike = async (url) => {
    if (!url.includes('/messages')) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const body = { items: [], nextCursor: null };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  const api = new RestClient('http://test', { fetchImpl });
  const conn = new RoomConnection({
    api,
    roomId: ROOM,
    getToken: async () => 'tok',
    wsBaseUrl: 'ws://test/ws',
    emoteTtlMs: 5,
    socketOptions: {
      wsCtor: FakeSocket,
      heartbeatMs: 60_000,
      backoffBaseMs: 60_000,
      setTimeoutFn: (fn) => fn,
      clearTimeoutFn: () => undefined,
    },
  });
  return { conn };
}

describe('RoomConnection room-state reducers', () => {
  it('inserts chat messages ascending by seq and dedupes by id', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    const m1 = makeMessage({ seq: 1 });
    const m2 = makeMessage({ seq: 2 });
    sock?.deliver(ev('chat.message', 1, m1));
    sock?.deliver(ev('chat.message', 2, m2));
    sock?.deliver(ev('chat.message', 3, m2)); // duplicate id → dropped by reducer

    const messages = conn.useRoomState.getState().messages;
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
    conn.close();
  });

  it('applies reactions add/remove and empties the emoji key', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    const m = makeMessage({ seq: 1 });
    sock?.deliver(ev('chat.message', 1, m));
    sock?.deliver(
      ev('chat.reaction', 2, { messageId: m.id, emoji: '🔥', userId: ME, op: 'add' }),
    );
    let msg = conn.useRoomState.getState().messages[0];
    expect(msg?.reactions['🔥']).toEqual([ME]);

    sock?.deliver(
      ev('chat.reaction', 3, { messageId: m.id, emoji: '🔥', userId: ME, op: 'remove' }),
    );
    msg = conn.useRoomState.getState().messages[0];
    expect(msg?.reactions['🔥']).toBeUndefined();
    conn.close();
  });

  it('tombstones deleted messages', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();
    const m = makeMessage({ seq: 1 });
    sock?.deliver(ev('chat.message', 1, m));
    sock?.deliver(ev('chat.deleted', 2, { messageId: m.id, deletedAt: 9_999 }));
    const msg = conn.useRoomState.getState().messages[0];
    expect(msg?.deletedAt).toBe(9_999);
    expect(msg?.body).toBe('');
    conn.close();
  });

  it('tracks presence snapshots and diffs', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    const entry = {
      userId: ME,
      state: 'watching' as const,
      micOn: false,
      camOn: false,
      sharing: false,
      lastSeenTs: 1_000,
    };
    sock?.deliver(ev('presence.state', 1, { entries: [entry] }));
    expect(conn.useRoomState.getState().presence[ME]?.state).toBe('watching');

    sock?.deliver(
      ev('presence.diff', 2, {
        upserts: [{ ...entry, state: 'in-call' as const, micOn: true }],
        removed: [],
      }),
    );
    expect(conn.useRoomState.getState().presence[ME]?.state).toBe('in-call');

    sock?.deliver(ev('presence.diff', 3, { upserts: [], removed: [ME] }));
    expect(conn.useRoomState.getState().presence[ME]).toBeUndefined();
    conn.close();
  });

  it('stores queue, playback, restream and room updates', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    sock?.deliver(ev('queue.state', 1, { items: [], version: 7 }));
    expect(conn.useRoomState.getState().queue.version).toBe(7);

    const playback = {
      mediaRef: null,
      positionMs: 4_000,
      rate: 1,
      playing: true,
      serverTs: 1_000,
      seq: 12,
      queueIndex: null,
    };
    sock?.deliver(ev('sync.state', 2, playback));
    expect(conn.useRoomState.getState().playback?.positionMs).toBe(4_000);

    const restream = {
      active: true,
      hostUserId: ME,
      startedAt: 1_000,
      viewerCount: 3,
      uplinkQuality: 'good' as const,
    };
    sock?.deliver(ev('restream.state', 3, restream));
    expect(conn.useRoomState.getState().restream?.active).toBe(true);
    conn.close();
  });

  it('shows emote bursts briefly, then expires them', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    sock?.deliver(ev('emote.burst', 0, { userId: ME, emoji: '🔥', xPct: 10, yPct: 20 }));
    expect(conn.useRoomState.getState().emotes).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(conn.useRoomState.getState().emotes).toHaveLength(0);
    conn.close();
  });

  it('keeps read cursors monotonic', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    const cursor = (lastReadSeq: number) => ({
      roomId: ROOM,
      userId: ME,
      lastReadSeq,
      at: 1_000,
    });
    sock?.deliver(ev('chat.read', 1, cursor(10)));
    sock?.deliver(ev('chat.read', 2, cursor(4))); // out-of-order → stays 10
    expect(conn.useRoomState.getState().readCursors[ME]).toBe(10);
    conn.close();
  });

  it('sends typed client events through the socket', async () => {
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    conn.chatSend({ body: 'hi room' });
    conn.queueVoteSkip('q-1' as never);
    conn.syncSeek(12_000);
    conn.presenceUpdate({ micOn: true });

    const types = (sock?.sent ?? []).map(
      (raw) => (JSON.parse(raw) as { type: string }).type,
    );
    // The connection's own frame leads: every open asks the server for the
    // room back before the user has done anything (test/refresh-recovery).
    expect(types).toEqual([
      'presence.update',
      'chat.send',
      'queue.voteSkip',
      'sync.seek',
      'presence.update',
    ]);
    const first = JSON.parse(sock?.sent[1] ?? '{}') as { payload: { kind: string } };
    expect(first.payload.kind).toBe('text');
    conn.close();
  });
});
