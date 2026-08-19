/**
 * What restream.start is allowed to do, and what it is allowed to claim.
 *
 * Three separate things were wrong at once:
 *
 *  1. The wire contract annotates ClientRestreamStart "(policy-gated)" and the
 *     service checked membership and the ban list only. The doctrine it should
 *     have been expressing is that sharing is UNGATED BY ROLE — guests share,
 *     on purpose — so the fix names the level ('everyone') and routes it
 *     through the same `policyAllows` every other module uses, rather than
 *     tightening who may share. The first test is the doctrine, pinned: a
 *     guest must still be able to start.
 *
 *  2. `maxPublishers` was enforced in a web button and nowhere else, so a
 *     scripted client walked past it. The share is the one uplink the server
 *     is authoritative over, so it is the one it can refuse.
 *
 *  3. `viewerCount` was the literal 0, rendered to people as "Live · 0
 *     watching" in a full room. It is now computed from room presence and
 *     refreshed at both presence edges.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { PresenceState, RoomId, RoomPolicies, UserId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import { memberDocId } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { getRoomsRuntime } from '../src/modules/rooms/runtime';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

interface Frame {
  type: string;
  roomId: string;
  seq: number;
  ts: number;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.once('open', () => resolve(sock));
    sock.once('error', (err: Error) => reject(err));
  });
}

function nextOfType(sock: WebSocket, type: string, timeoutMs = 2000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('message', onMessage);
    };
    const onMessage = (data: RawData): void => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame.type !== type) return;
      cleanup();
      resolve(frame);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a "${type}" message`));
    }, timeoutMs);
    sock.on('message', onMessage);
  });
}

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

describe('restream.start gates and what it reports', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    sockets = [];
  });

  afterEach(async () => {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    await getRoomsRuntime(deps).close();
    await app.close();
  });

  interface Joined {
    account: SignedUpUser;
    sock: WebSocket;
  }

  /** Join with a role, open a socket, and beat presence in `state`. */
  async function join(
    email: string,
    roomId: string,
    role: 'host' | 'moderator' | 'member' | 'guest',
    state: PresenceState = 'watching',
  ): Promise<Joined> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await openSocket(
      `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    const snapshot = nextOfType(sock, 'queue.state');
    sock.send(clientFrame(roomId, 'presence.update', { state, wantSnapshot: true }));
    await snapshot;
    return { account, sock };
  }

  async function setPolicies(roomId: string, patch: Partial<RoomPolicies>): Promise<void> {
    const room = await store.rooms.findById(roomId);
    await store.rooms.updateOne(
      { id: roomId as RoomId },
      { policies: { ...room!.policies, ...patch } },
    );
  }

  // ── 1. the ungated-share doctrine ──────────────────────────────────────────

  it('lets a GUEST start a share — sharing is gated by membership, never by role', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('gate-host@example.com', roomId, 'host');
    const guest = await join('gate-guest@example.com', roomId, 'guest');

    const pState = nextOfType(host.sock, 'restream.state');
    guest.sock.send(clientFrame(roomId, 'restream.start', {}));
    const state = await pState;

    expect(state.payload.active).toBe(true);
    expect(state.payload.hostUserId).toBe(guest.account.user.id);
  });

  it('still refuses a banned member, gate or no gate', async () => {
    const { roomId } = await seedRoom(store);
    await join('gate-host2@example.com', roomId, 'host');
    const member = await join('gate-banned@example.com', roomId, 'member');
    await store.members.updateOne(
      { id: memberDocId(roomId, member.account.user.id) },
      { banned: true },
    );

    const pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'restream.start', {}));
    expect((await pErr).payload.code).toBe('FORBIDDEN');
  });

  // ── 2. the publisher ceiling ───────────────────────────────────────────────

  it('refuses a share once maxPublishers people are already publishing', async () => {
    const { roomId } = await seedRoom(store);
    await setPolicies(roomId, { maxPublishers: 2 });
    // Two members already in the call — the room's whole publisher budget.
    await join('cap-a@example.com', roomId, 'host', 'in-call');
    await join('cap-b@example.com', roomId, 'member', 'in-call');
    const third = await join('cap-c@example.com', roomId, 'member');

    const pErr = nextOfType(third.sock, 'error');
    third.sock.send(clientFrame(roomId, 'restream.start', {}));
    expect((await pErr).payload.code).toBe('QUOTA_EXCEEDED');
    expect((await store.rooms.findById(roomId))?.restream).toBeNull();
  });

  it('lets somebody already publishing share — they take their own slot, not a second', async () => {
    const { roomId } = await seedRoom(store);
    await setPolicies(roomId, { maxPublishers: 2 });
    const a = await join('slot-a@example.com', roomId, 'host', 'in-call');
    await join('slot-b@example.com', roomId, 'member', 'in-call');

    const pState = nextOfType(a.sock, 'restream.state');
    a.sock.send(clientFrame(roomId, 'restream.start', {}));
    expect((await pState).payload.active).toBe(true);
  });

  // ── 3. the viewer count ────────────────────────────────────────────────────

  it('counts the room minus the sharer, and moves when somebody arrives or leaves', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('view-host@example.com', roomId, 'host');
    const watcher = await join('view-a@example.com', roomId, 'member');

    // Host + one watcher present; the host is feeding the share, so 1 watching.
    const pStart = nextOfType(watcher.sock, 'restream.state');
    host.sock.send(clientFrame(roomId, 'restream.start', {}));
    expect((await pStart).payload.viewerCount).toBe(1);

    // A third person arrives: the count has to move, and everybody has to hear
    // about it — a number minted once at start() is a claim about the past.
    const pArrival = nextOfType(watcher.sock, 'restream.state');
    await join('view-b@example.com', roomId, 'member');
    expect((await pArrival).payload.viewerCount).toBe(2);
    expect((await store.rooms.findById(roomId))?.restream?.viewerCount).toBe(2);

    // ...and back down when one of them leaves.
    const pDeparture = nextOfType(host.sock, 'restream.state');
    watcher.sock.send(clientFrame(roomId, 'presence.update', { state: 'offline' }));
    expect((await pDeparture).payload.viewerCount).toBe(1);
  });

  it('does not persist a viewer count for a room with no share', async () => {
    const { roomId } = await seedRoom(store);
    await join('idle-a@example.com', roomId, 'host');
    await join('idle-b@example.com', roomId, 'member');
    // Presence churn on a room that is not sharing must write nothing at all.
    expect((await store.rooms.findById(roomId))?.restream).toBeNull();
  });

  it('counts presence entries, not the sockets this instance happens to hold', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('presence-host@example.com', roomId, 'host');

    const pStart = nextOfType(host.sock, 'restream.state');
    host.sock.send(clientFrame(roomId, 'restream.start', {}));
    expect((await pStart).payload.viewerCount).toBe(0);

    // A member with a presence entry and no socket here — what a member on the
    // far side of a rolling deploy looks like to this process once their
    // heartbeat has been mirrored over the bus.
    const elsewhere = 'user_on_the_other_instance' as UserId;
    await addMember(store, roomId, elsewhere, 'member');
    const pJoined = nextOfType(host.sock, 'restream.state');
    await getRoomsRuntime(deps).presence.heartbeat(
      roomId as RoomId,
      elsewhere,
      { state: 'watching' },
      'watching',
    );
    expect((await pJoined).payload.viewerCount).toBe(1);
    expect(deps.hub.localUserIds(roomId as RoomId)).not.toContain(elsewhere);
  });
});
