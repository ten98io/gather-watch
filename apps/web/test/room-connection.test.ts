import { describe, expect, it } from 'vitest';
import { RestClient } from '@gather/api-client';
import type { FetchLike, WebSocketLike } from '@gather/api-client';
import type { RoomId, ServerEvent } from '@gather/contracts';
import { RoomConnection, toConnectionStatus } from '@/lib/room-connection';

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

function presenceDiff(roomId: RoomId, seq: number): ServerEvent {
  return {
    type: 'presence.diff',
    roomId,
    seq,
    ts: 1_000,
    payload: { upserts: [], removed: [] },
  };
}

function makeConnection(opts?: {
  replayEvents?: ServerEvent[];
  initialSeq?: number;
  token?: string | null;
}): { conn: RoomConnection; roomId: RoomId } {
  const roomId = 'room-1' as RoomId;
  const replayEvents = opts?.replayEvents ?? [];
  const fetchImpl: FetchLike = async (url) => {
    if (!url.includes(`/rooms/${roomId}/events`)) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ events: replayEvents }),
      text: async () => JSON.stringify({ events: replayEvents }),
    };
  };
  const api = new RestClient('http://test', { fetchImpl });
  const conn = new RoomConnection({
    api,
    roomId,
    getToken: async () => (opts && 'token' in opts ? (opts.token ?? null) : 'tok'),
    wsBaseUrl: 'ws://test/ws',
    ...(opts?.initialSeq === undefined ? {} : { initialSeq: opts.initialSeq }),
    socketOptions: {
      wsCtor: FakeSocket,
      heartbeatMs: 60_000,
      backoffBaseMs: 60_000,
      // Manual timers: never auto-fire heartbeats/reconnects in tests.
      setTimeoutFn: (fn) => fn,
      clearTimeoutFn: () => undefined,
    },
  });
  return { conn, roomId };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('toConnectionStatus', () => {
  it('maps the socket lifecycle onto the four-state status', () => {
    expect(toConnectionStatus('idle')).toBe('connecting');
    expect(toConnectionStatus('connecting')).toBe('connecting');
    expect(toConnectionStatus('open')).toBe('live');
    expect(toConnectionStatus('reconnecting')).toBe('reconnecting');
    expect(toConnectionStatus('closed')).toBe('closed');
  });
});

describe('RoomConnection', () => {
  it('connects with the auth token in the ws URL and goes live on open', async () => {
    FakeSocket.reset();
    const { conn, roomId } = makeConnection({ initialSeq: 40 });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    expect(sock).toBeDefined();
    expect(sock?.url).toBe(`ws://test/ws?roomId=${roomId}&token=tok`);
    expect(conn.status).toBe('connecting');
    sock?.open();
    expect(conn.status).toBe('live');
    expect(conn.lastSeq).toBe(40);
    conn.close();
    expect(conn.status).toBe('closed');
  });

  it('refuses to connect without an access token', async () => {
    FakeSocket.reset();
    const { conn } = makeConnection({ token: null });
    await expect(conn.connect()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('queues sends while disconnected and flushes on open', async () => {
    FakeSocket.reset();
    const { conn } = makeConnection();
    void conn.connect();
    await tick();
    const sock = FakeSocket.instances[0];
    conn.send({
      type: 'chat.typing',
      roomId: conn.roomId,
      seq: 0,
      ts: 1,
      payload: { typing: true },
    });
    expect(sock?.sent).toHaveLength(0);
    sock?.open();
    expect(sock?.sent).toHaveLength(1);
    conn.close();
  });

  it('dedupes by seq, replays gaps in order, and passes ephemeral events through', async () => {
    FakeSocket.reset();
    const roomId = 'room-1' as RoomId;
    const replay = [presenceDiff(roomId, 2), presenceDiff(roomId, 3)];
    const { conn } = makeConnection({ replayEvents: replay });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    const seen: number[] = [];
    conn.subscribe((ev) => {
      seen.push(ev.seq);
    });

    sock?.deliver(presenceDiff(roomId, 1)); // next → emitted
    sock?.deliver(presenceDiff(roomId, 1)); // duplicate → dropped
    sock?.deliver(presenceDiff(roomId, 3)); // gap → buffered, replay backfills 2..3
    await tick();
    await tick();
    sock?.deliver(presenceDiff(roomId, 0)); // ephemeral → straight through
    sock?.deliver(presenceDiff(roomId, 4)); // next after replay

    expect(seen).toEqual([1, 2, 3, 0, 4]);
    expect(conn.lastSeq).toBe(4);
    conn.close();
  });

  it('emits a fresh subscribe stream to late subscribers', async () => {
    FakeSocket.reset();
    const { conn } = makeConnection();
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();
    const seen: string[] = [];
    const off = conn.subscribe((ev) => {
      seen.push(ev.type);
    });
    sock?.deliver(presenceDiff(conn.roomId, 1));
    off();
    sock?.deliver(presenceDiff(conn.roomId, 2));
    expect(seen).toEqual(['presence.diff']);
    conn.close();
  });
});
