import { describe, expect, it } from 'vitest';
import { RestClient } from '@gather/api-client';
import type { FetchLike, TimeoutHandle, WebSocketLike } from '@gather/api-client';
import type { PresenceEntry, RoomId, ServerEvent, UserId } from '@gather/contracts';
import { RoomConnection, toConnectionStatus } from '@/lib/room-connection';

const ME = 'u-me' as UserId;

/** Deterministic scheduler: nothing fires until the test says so. */
class ManualTimers {
  pending: { id: number; fn: () => void; ms: number }[] = [];
  private nextId = 1;

  set = (fn: () => void, ms: number): TimeoutHandle => {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.push({ id, fn, ms });
    return id;
  };

  clear = (handle: TimeoutHandle): void => {
    const idx = this.pending.findIndex((e) => e.id === handle);
    if (idx >= 0) this.pending.splice(idx, 1);
  };

  /** Removes and runs the entry with the smallest delay. */
  runNext(): void {
    if (this.pending.length === 0) throw new Error('no pending timers');
    let best = 0;
    for (let i = 1; i < this.pending.length; i += 1) {
      if (this.pending[i]!.ms < this.pending[best]!.ms) best = i;
    }
    this.pending.splice(best, 1)[0]!.fn();
  }
}

class FakeSocket implements WebSocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
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

function presenceState(roomId: RoomId, entries: PresenceEntry[]): ServerEvent {
  return { type: 'presence.state', roomId, seq: 0, ts: 1_000, payload: { entries } };
}

function entry(over: Partial<PresenceEntry>): PresenceEntry {
  return {
    userId: ME,
    state: 'watching',
    micOn: false,
    camOn: false,
    sharing: false,
    lastSeenTs: 1_000,
    ...over,
  };
}

/** The parsed payloads of every presence.update this client sent. */
function presenceFrames(sock: FakeSocket | undefined): Record<string, unknown>[] {
  return (sock?.sent ?? [])
    .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
    .filter((frame) => frame.type === 'presence.update')
    .map((frame) => frame.payload);
}

/** Just the periodic beats. The one frame every open sends to ask for the
 *  room back is a presence.update too, but it is not a heartbeat — it is
 *  pinned in test/refresh-recovery.test.ts. */
function keepaliveFrames(sock: FakeSocket | undefined): Record<string, unknown>[] {
  return presenceFrames(sock).filter((frame) => frame.wantSnapshot === undefined);
}

function makeConnection(opts?: {
  replayEvents?: ServerEvent[];
  initialSeq?: number;
  token?: string | null;
  getToken?: () => Promise<string | null>;
  userId?: UserId;
  timers?: ManualTimers;
  presenceKeepaliveMs?: number;
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
  const timers = opts?.timers;
  const conn = new RoomConnection({
    api,
    roomId,
    getToken:
      opts?.getToken ?? (async () => (opts && 'token' in opts ? (opts.token ?? null) : 'tok')),
    wsBaseUrl: 'ws://test/ws',
    ...(opts?.initialSeq === undefined ? {} : { initialSeq: opts.initialSeq }),
    ...(opts?.userId === undefined ? {} : { userId: opts.userId }),
    ...(opts?.presenceKeepaliveMs === undefined
      ? {}
      : { presenceKeepaliveMs: opts.presenceKeepaliveMs }),
    socketOptions: {
      wsCtor: FakeSocket,
      heartbeatMs: 60_000,
      backoffBaseMs: 60_000,
      // Manual timers: never auto-fire heartbeats/reconnects in tests. Without
      // an explicit scheduler nothing fires at all.
      setTimeoutFn: timers === undefined ? (fn) => fn : timers.set,
      clearTimeoutFn: timers === undefined ? () => undefined : timers.clear,
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
  it('connects with the auth token in the ws subprotocol and goes live on open', async () => {
    FakeSocket.reset();
    const { conn, roomId } = makeConnection({ initialSeq: 40 });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    expect(sock).toBeDefined();
    // The credential rides Sec-WebSocket-Protocol; the URL stays log-safe.
    expect(sock?.url).toBe(`ws://test/ws?roomId=${roomId}`);
    expect(sock?.protocols).toEqual(['gather.auth.tok']);
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
    // Two frames: the connection's own snapshot ask (every open sends one)
    // followed by the envelope the user queued while the socket was down.
    const flushed = (sock?.sent ?? []).map((raw) => (JSON.parse(raw) as { type: string }).type);
    expect(flushed).toEqual(['presence.update', 'chat.typing']);
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

  it('beats presence inside the server TTL, carrying the member CURRENT state', async () => {
    FakeSocket.reset();
    const timers = new ManualTimers();
    const { conn, roomId } = makeConnection({ userId: ME, timers, presenceKeepaliveMs: 15_000 });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();
    // The member joined the call: the roster says 'in-call' with mic live.
    sock?.deliver(presenceState(roomId, [entry({ state: 'in-call', micOn: true })]));
    expect(keepaliveFrames(sock)).toEqual([]);

    timers.runNext(); // the keepalive interval elapses
    // A beat happened — without one the server drops this member after 45s
    // and CallMesh tears every peer connection down.
    expect(keepaliveFrames(sock)).toEqual([
      { state: 'in-call', micOn: true, camOn: false, sharing: false },
    ]);
    // It re-asserts the RICHER state, never an idle default…
    expect(keepaliveFrames(sock)[0]?.state).not.toBe('watching');
    // …and never asks for a snapshot, which would make every single beat cost
    // a full roster + sync + queue reply.
    expect(keepaliveFrames(sock)[0]).not.toHaveProperty('wantSnapshot');

    timers.runNext(); // it repeats, not once-and-done
    expect(keepaliveFrames(sock)).toHaveLength(2);
    conn.close();
  });

  it('stops the presence beat on close and restarts it on reconnect', async () => {
    FakeSocket.reset();
    const timers = new ManualTimers();
    const { conn, roomId } = makeConnection({ userId: ME, timers, presenceKeepaliveMs: 15_000 });
    await conn.connect();
    const sock1 = FakeSocket.instances[0];
    sock1?.open();
    sock1?.deliver(presenceState(roomId, [entry({ state: 'listening' })]));

    // Transport drop: no beats while there is no socket to beat on.
    sock1?.onclose?.({ code: 1006 });
    expect(conn.status).toBe('reconnecting');
    const beatsAtDrop = keepaliveFrames(sock1).length;
    timers.runNext(); // backoff elapses → a fresh socket
    await tick();
    const sock2 = FakeSocket.instances[1];
    expect(sock2).toBeDefined();
    expect(keepaliveFrames(sock1)).toHaveLength(beatsAtDrop);

    sock2?.open();
    timers.runNext();
    expect(keepaliveFrames(sock2)).toEqual([
      { state: 'listening', micOn: false, camOn: false, sharing: false },
    ]);

    conn.close();
    // Nothing is left ticking after an intentional close.
    expect(timers.pending).toHaveLength(0);
  });

  it('a refused session ends with a reason instead of reconnecting forever', async () => {
    FakeSocket.reset();
    const timers = new ManualTimers();
    const { conn } = makeConnection({ timers });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();
    sock?.onclose?.({ code: 4403, reason: 'banned' });
    expect(conn.status).toBe('closed');
    expect(conn.closeInfo).toEqual({ code: 4403, reason: 'banned' });
    // The panes can say something true rather than showing a permanent
    // "reconnecting…" for a session that will never come back.
    expect(conn.useRoomState.getState().lastError).toBe('banned');
    expect(timers.pending).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('a token rotation keeps the envelopes the user queued while reconnecting', async () => {
    FakeSocket.reset();
    let issued = 0;
    const { conn } = makeConnection({
      getToken: async () => {
        issued += 1;
        return `tok${issued}`;
      },
    });
    await conn.connect();
    const sock1 = FakeSocket.instances[0];
    sock1?.open();
    // The socket drops; the rotation kicks off on the 'reconnecting' status…
    sock1?.onclose?.({ code: 1006 });
    // …and the user sends a chat message before it completes.
    conn.chatSend({ body: 'still here?' });
    await tick();
    const sock2 = FakeSocket.instances[1];
    // The rotated token: new subprotocol, same credential-free URL.
    expect(sock2?.url).not.toContain('tok');
    expect(sock2?.protocols).toEqual(['gather.auth.tok2']);
    sock2?.open();
    const bodies = (sock2?.sent ?? [])
      .map((raw) => JSON.parse(raw) as { type: string; payload: { body?: string } })
      .filter((frame) => frame.type === 'chat.send')
      .map((frame) => frame.payload.body);
    expect(bodies).toEqual(['still here?']);
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
