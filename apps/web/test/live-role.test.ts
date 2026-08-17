/**
 * Live role propagation — the "host switch requires leaving and rejoining"
 * regression. The join response's member row is a snapshot; `useRoom()` must
 * overlay the member.updated stream on top of it so a promotion, demotion, or
 * host transfer reaches every permission gate on every connected client
 * without a rejoin.
 *
 * Two layers prove the chain:
 *  1. RoomConnection reducers: member.updated advances the store's member
 *     row (and ONLY that row — unrelated events must not touch its identity,
 *     because components key effects off these objects).
 *  2. A rendered permission gate (QueuePane's "Add to queue" box) follows the
 *     store's member row, not the join-response prop.
 */
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RestClient } from '@gather/api-client';
import type { FetchLike, WebSocketLike } from '@gather/api-client';
import type { Member, Room, RoomId, ServerEvent, UserId } from '@gather/contracts';
import { RoomConnection, jsonEqual } from '@/lib/room-connection';
import { ME, ROOM_ID, h, makeMember, makeRoom, renderInRoom } from './helpers/room-render';

const { QueuePane } = await import('@/components/queue/QueuePane');

/** QueuePane's library picker uses react-query; SSR needs a client in scope. */
function queuePane(roomId: RoomId) {
  return h(
    QueryClientProvider,
    { client: new QueryClient() },
    h(QueuePane, { roomId }),
  );
}

class FakeSocket implements WebSocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static instances: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.instances = [];
  }

  send(): void {}

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

const OTHER = 'user-other' as UserId;

function memberRow(userId: UserId, role: Member['role']): Member {
  return { roomId: ROOM_ID, userId, role, joinedAt: 1_000, banned: false };
}

function ev<T extends ServerEvent['type']>(
  type: T,
  seq: number,
  payload: Extract<ServerEvent, { type: T }>['payload'],
): ServerEvent {
  return { type, roomId: ROOM_ID, seq, ts: 1_000, payload } as ServerEvent;
}

async function liveConnection(): Promise<{ conn: RoomConnection; sock: FakeSocket }> {
  FakeSocket.reset();
  const fetchImpl: FetchLike = async () => {
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
    roomId: ROOM_ID as RoomId,
    getToken: async () => 'tok',
    wsBaseUrl: 'ws://test/ws',
    socketOptions: {
      wsCtor: FakeSocket,
      heartbeatMs: 60_000,
      backoffBaseMs: 60_000,
      setTimeoutFn: (fn) => fn,
      clearTimeoutFn: () => undefined,
    },
  });
  await conn.connect();
  const sock = FakeSocket.instances[0];
  if (sock === undefined) throw new Error('socket never constructed');
  sock.open();
  return { conn, sock };
}

describe('member.updated stream → live member row', () => {
  it('advances the seeded row on a role change and bumps membersVersion', async () => {
    const { conn, sock } = await liveConnection();
    conn.seedMember(memberRow(ME, 'member'));
    expect(conn.useRoomState.getState().members[ME]?.role).toBe('member');

    sock.deliver(ev('member.updated', 1, memberRow(ME, 'moderator')));
    const state = conn.useRoomState.getState();
    expect(state.members[ME]?.role).toBe('moderator');
    expect(state.membersVersion).toBe(1);
    conn.close();
  });

  it('keeps the member identity across unrelated presence events', async () => {
    const { conn, sock } = await liveConnection();
    conn.seedMember(memberRow(ME, 'member'));
    sock.deliver(ev('member.updated', 1, memberRow(ME, 'host')));
    const mine = conn.useRoomState.getState().members[ME];

    sock.deliver(
      ev('presence.diff', 2, {
        upserts: [
          {
            userId: OTHER,
            state: 'watching' as const,
            micOn: false,
            camOn: false,
            sharing: false,
            lastSeenTs: 2_000,
          },
        ],
        removed: [],
      }),
    );
    expect(Object.is(conn.useRoomState.getState().members[ME], mine)).toBe(true);
    conn.close();
  });

  it('keeps MY identity when another member is updated (host transfer far side)', async () => {
    const { conn, sock } = await liveConnection();
    conn.seedMember(memberRow(ME, 'member'));
    const mine = conn.useRoomState.getState().members[ME];

    sock.deliver(ev('member.updated', 1, memberRow(OTHER, 'host')));
    const state = conn.useRoomState.getState();
    expect(state.members[OTHER]?.role).toBe('host');
    expect(Object.is(state.members[ME], mine)).toBe(true);
    conn.close();
  });

  it('keeps identity when a re-delivered payload carries no change', async () => {
    const { conn, sock } = await liveConnection();
    sock.deliver(ev('member.updated', 1, memberRow(ME, 'moderator')));
    const first = conn.useRoomState.getState().members[ME];

    sock.deliver(ev('member.updated', 2, memberRow(ME, 'moderator')));
    expect(Object.is(conn.useRoomState.getState().members[ME], first)).toBe(true);
    // The roster refetch signal still fires — profiles may have changed.
    expect(conn.useRoomState.getState().membersVersion).toBe(2);
    conn.close();
  });

  it('keeps the room identity when room.updated re-delivers identical content', async () => {
    const { conn, sock } = await liveConnection();
    const room: Room = makeRoom('watch');
    conn.seedRoom(room);
    sock.deliver(ev('room.updated', 1, { ...room, policies: { ...room.policies } }));
    expect(Object.is(conn.useRoomState.getState().room, room)).toBe(true);

    sock.deliver(ev('room.updated', 2, { ...room, theater: true }));
    expect(conn.useRoomState.getState().room?.theater).toBe(true);
    conn.close();
  });

  it('re-seeding an unchanged snapshot keeps both identities', async () => {
    const { conn } = await liveConnection();
    const room = makeRoom('watch');
    conn.seedRoom(room);
    conn.seedMember(memberRow(ME, 'member'));
    const seededMember = conn.useRoomState.getState().members[ME];

    conn.seedRoom({ ...room, policies: { ...room.policies } });
    conn.seedMember(memberRow(ME, 'member'));
    expect(Object.is(conn.useRoomState.getState().room, room)).toBe(true);
    expect(Object.is(conn.useRoomState.getState().members[ME], seededMember)).toBe(true);
    conn.close();
  });
});

describe('a live role change flips a rendered permission gate (no rejoin)', () => {
  const modsOnlyQueue = (): Room => {
    const room = makeRoom('watch');
    return { ...room, policies: { ...room.policies, queueControl: 'mods' } };
  };

  it('joined as member: the queue box appears when the stream promotes me', () => {
    const room = modsOnlyQueue();
    // Snapshot alone (no stream update yet): the gate is closed.
    const before = renderInRoom(room, makeMember('member'), {}, queuePane(room.id));
    expect(before).not.toContain('Add to queue');

    // The member.updated stream produced a moderator row for me — the gate
    // must follow the STORE row, not the join-response prop.
    const after = renderInRoom(
      room,
      makeMember('member'),
      { members: { [ME]: memberRow(ME, 'moderator') } },
      queuePane(room.id),
    );
    expect(after).toContain('Add to queue');
  });

  it('joined as host: the queue box disappears when the stream demotes me', () => {
    const room = modsOnlyQueue();
    const before = renderInRoom(room, makeMember('host'), {}, queuePane(room.id));
    expect(before).toContain('Add to queue');

    const after = renderInRoom(
      room,
      makeMember('host'),
      { members: { [ME]: memberRow(ME, 'member') } },
      queuePane(room.id),
    );
    expect(after).not.toContain('Add to queue');
  });
});

describe('jsonEqual', () => {
  it('matches structural JSON regardless of key order, rejects real changes', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 1 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});
