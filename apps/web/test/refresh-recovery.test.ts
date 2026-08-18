/**
 * Refreshing the room page must bring the room back.
 *
 * The most-reported bug in the app: "when the host refreshed, the guests got
 * kicked silently but the host doesn't know that, and then when the guest
 * joined the queue came back". A refresh is NOT a leave — nothing evicts
 * anyone. What actually happened is that the reloaded tab was REFUSED a state
 * snapshot: its presence entry outlives a 1-5s reload, so the server saw an
 * ordinary heartbeat and replied with nothing. The fresh store then stayed at
 * initialRoomState() — empty queue, null playback, EMPTY presence — and an
 * empty roster is what makes CallMesh tear down every peer connection, so
 * from the other machines the guests genuinely did disappear. The queue
 * "coming back when a guest joined" was the tell: a new entry made the server
 * treat it as a join and send the snapshot it had all along.
 *
 * So the client has to ASK, explicitly, on every open. These tests pin both
 * halves of that: the ask happens on every open, and it never leaks into the
 * 15s keepalive beats (each one would cost a full room snapshot).
 */
import { describe, expect, it } from 'vitest';
import { RestClient } from '@gather/api-client';
import type { FetchLike, TimeoutHandle, WebSocketLike } from '@gather/api-client';
import type {
  Member,
  PresenceEntry,
  QueueItemId,
  RoomId,
  ServerEvent,
  UserId,
} from '@gather/contracts';
import { RoomConnection } from '@/lib/room-connection';

const ME = 'u-me' as UserId;
const OTHER = 'u-other' as UserId;

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

/** The parsed payloads of every presence.update this socket carried. */
function presenceFrames(sock: FakeSocket | undefined): Record<string, unknown>[] {
  return (sock?.sent ?? [])
    .map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> })
    .filter((frame) => frame.type === 'presence.update')
    .map((frame) => frame.payload);
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

function presenceState(roomId: RoomId, entries: PresenceEntry[]): ServerEvent {
  return { type: 'presence.state', roomId, seq: 0, ts: 1_000, payload: { entries } };
}

function member(userId: UserId, roomId: RoomId): Member {
  return { roomId, userId, role: 'member', joinedAt: 1_000, banned: false };
}

function memberRemoved(roomId: RoomId, userId: UserId): ServerEvent {
  return {
    type: 'member.removed',
    roomId,
    seq: 0,
    ts: 1_000,
    payload: { userId, reason: 'kicked' },
  };
}

function makeConnection(opts?: { timers?: ManualTimers; userId?: UserId }): {
  conn: RoomConnection;
  roomId: RoomId;
} {
  const roomId = 'room-1' as RoomId;
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ events: [] }),
    text: async () => JSON.stringify({ events: [] }),
  });
  const api = new RestClient('http://test', { fetchImpl });
  const timers = opts?.timers;
  const conn = new RoomConnection({
    api,
    roomId,
    getToken: async () => 'tok',
    wsBaseUrl: 'ws://test/ws',
    presenceKeepaliveMs: 15_000,
    ...(opts?.userId === undefined ? {} : { userId: opts.userId }),
    socketOptions: {
      wsCtor: FakeSocket,
      heartbeatMs: 60_000,
      backoffBaseMs: 60_000,
      setTimeoutFn: timers === undefined ? (fn) => fn : timers.set,
      clearTimeoutFn: timers === undefined ? () => undefined : timers.clear,
    },
  });
  return { conn, roomId };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('asking for the room back', () => {
  it('sends the ask on the first frame of an open, and on the reconnect too', async () => {
    FakeSocket.reset();
    const timers = new ManualTimers();
    const { conn } = makeConnection({ userId: ME, timers });
    await conn.connect();
    const sock1 = FakeSocket.instances[0];
    sock1?.open();

    // The very first thing this client says is "I'm here — send me the room".
    // Without it the reload lands on an empty queue, no playback and an empty
    // roster, and the roster is what the call mesh reconciles peers from.
    // Exactly one frame — the provider used to announce presence on 'live'
    // too, and two frames per open means two full room snapshots.
    expect(presenceFrames(sock1)).toHaveLength(1);
    expect(presenceFrames(sock1)[0]?.wantSnapshot).toBe(true);
    expect(presenceFrames(sock1)[0]?.state).toBe('watching');

    // Keepalive beats are NOT asks: a snapshot every 15s, per client, is a
    // presence + sync + queue reply the server has no reason to pay for.
    timers.runNext();
    expect(presenceFrames(sock1)).toHaveLength(2);
    expect(presenceFrames(sock1)[1]).not.toHaveProperty('wantSnapshot');
    timers.runNext();
    expect(presenceFrames(sock1)[2]).not.toHaveProperty('wantSnapshot');

    // A transport drop is the same problem as a refresh: the entry survives,
    // so the fresh socket has to ask again or the room never comes back.
    sock1?.onclose?.({ code: 1006 });
    expect(conn.status).toBe('reconnecting');
    timers.runNext(); // backoff elapses → a fresh socket
    await tick();
    const sock2 = FakeSocket.instances[1];
    expect(sock2).toBeDefined();
    sock2?.open();

    expect(presenceFrames(sock2)).toHaveLength(1);
    expect(presenceFrames(sock2)[0]?.wantSnapshot).toBe(true);
    timers.runNext();
    expect(presenceFrames(sock2)[1]).not.toHaveProperty('wantSnapshot');

    conn.close();
  });

  it('the ask carries the member CURRENT state, so it re-arms the TTL too', async () => {
    FakeSocket.reset();
    const timers = new ManualTimers();
    const { conn, roomId } = makeConnection({ userId: ME, timers });
    await conn.connect();
    const sock1 = FakeSocket.instances[0];
    sock1?.open();
    // This member is in the call with their mic live.
    sock1?.deliver(presenceState(roomId, [entry({ state: 'in-call', micOn: true })]));

    sock1?.onclose?.({ code: 1006 });
    timers.runNext();
    await tick();
    const sock2 = FakeSocket.instances[1];
    sock2?.open();

    // One frame that both fetches the room and re-asserts who this member is
    // — an idle default here would drop them out of the call on the roster.
    expect(presenceFrames(sock2)).toEqual([
      { state: 'in-call', micOn: true, camOn: false, sharing: false, wantSnapshot: true },
    ]);

    conn.close();
  });
});

describe('member.removed reaches the store', () => {
  it('drops the row, clears the presence entry, and bumps membersVersion', async () => {
    FakeSocket.reset();
    const { conn, roomId } = makeConnection({ userId: ME });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    conn.seedMember(member(ME, roomId));
    conn.seedMember(member(OTHER, roomId));
    sock?.deliver(
      presenceState(roomId, [entry({}), entry({ userId: OTHER, state: 'in-call' })]),
    );
    const before = conn.useRoomState.getState().membersVersion;
    expect(conn.useRoomState.getState().members[OTHER]).toBeDefined();
    expect(conn.useRoomState.getState().presence[OTHER]).toBeDefined();

    // The server has emitted this since the roster fix; nothing on the client
    // listened, so a kick stayed invisible until someone hit refresh.
    sock?.deliver(memberRemoved(roomId, OTHER));

    const after = conn.useRoomState.getState();
    expect(after.members[OTHER]).toBeUndefined();
    expect(after.presence[OTHER]).toBeUndefined();
    // The bump is the signal PeoplePane and CallSurface refetch on.
    expect(after.membersVersion).toBe(before + 1);
    // Everyone who stayed, stayed.
    expect(after.members[ME]).toBeDefined();
    expect(after.presence[ME]).toBeDefined();

    conn.close();
  });

  it('survives being told YOU were removed', async () => {
    // Single-instance the server disconnects you before emitting this, so you
    // never see your own removal — but the ctl kick and the room event travel
    // on different channels with no ordering guarantee, so across instances
    // you can. The store must simply drop your rows: role gates fall back to
    // the SSR snapshot member, and the terminal 4403 close is what actually
    // ends the session.
    FakeSocket.reset();
    const { conn, roomId } = makeConnection({ userId: ME });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    conn.seedMember(member(ME, roomId));
    conn.seedMember(member(OTHER, roomId));
    sock?.deliver(presenceState(roomId, [entry({}), entry({ userId: OTHER })]));

    sock?.deliver(memberRemoved(roomId, ME));

    const after = conn.useRoomState.getState();
    expect(after.members[ME]).toBeUndefined();
    expect(after.presence[ME]).toBeUndefined();
    // Nobody else is collateral, and the store is still a store.
    expect(after.members[OTHER]).toBeDefined();
    expect(after.presence[OTHER]).toBeDefined();
    expect(after.closed).toBeNull();

    conn.close();
  });
});

/**
 * The snapshot reply is stamped seq 0, so the seq tracker calls it ephemeral
 * and applies it the moment it lands — no gap detection, no buffering, no
 * replay behind it. The server also reads the room BEFORE awaiting the
 * presence heartbeat's bus publish, so that reply can be a snapshot of a
 * queue that has already moved on. Without a version guard the answer to our
 * own ask would roll the queue backwards, and since there is no seq gap
 * nothing would ever put it right.
 */
describe('a late queue snapshot cannot roll the queue backwards', () => {
  function queueState(roomId: RoomId, version: number, titles: string[]): ServerEvent {
    return {
      type: 'queue.state',
      roomId,
      seq: 0,
      ts: 1_000,
      payload: {
        version,
        items: titles.map((title, i) => ({
          id: `qi-${i}` as QueueItemId,
          mediaRef: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
          title,
          durationMs: null,
          artworkUrl: null,
          addedBy: ME,
          votesToSkip: [],
        })),
      },
    };
  }

  it('keeps the newer queue when a stale snapshot arrives after it', async () => {
    FakeSocket.reset();
    const { conn, roomId } = makeConnection({ userId: ME });
    await conn.connect();
    const sock = FakeSocket.instances[0];
    sock?.open();

    // Someone added a track while our ask was in flight; the broadcast wins
    // the race and lands first.
    sock?.deliver(queueState(roomId, 8, ['First up', 'Then this', 'Just added']));
    expect(conn.useRoomState.getState().queue.version).toBe(8);

    // Now the handler resumes and answers with the pre-await clone.
    sock?.deliver(queueState(roomId, 7, ['First up', 'Then this']));

    const queue = conn.useRoomState.getState().queue;
    expect(queue.version).toBe(8);
    expect(queue.items.map((i) => i.title)).toEqual(['First up', 'Then this', 'Just added']);

    // A genuinely newer snapshot still applies.
    sock?.deliver(queueState(roomId, 9, ['Then this', 'Just added']));
    expect(conn.useRoomState.getState().queue.version).toBe(9);

    conn.close();
  });
});
