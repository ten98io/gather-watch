/**
 * Quorums must be about the ROOM, not about one process's sockets.
 *
 * The API runs several instances and a rolling deploy overlaps two of them on
 * every push to main, so for the length of every deploy a room is split across
 * processes. Anything that counted `hub.localUserIds` therefore counted half a
 * room and did not know it:
 *
 *   • vote-skip divided the threshold by the wrong denominator, so 0.5 of a
 *     four-person room became 0.5 of the two people on this instance — one
 *     member unilaterally skipping everybody's track, every deploy, silently.
 *   • wait-for-all pruned a buffering reporter the moment their socket landed
 *     on the other instance, declaring them ready and releasing a hold they
 *     never lifted.
 *
 * Both now read the presence tracker, which mirrors entries across instances
 * over the bus. These tests build TWO apps over ONE store and ONE bus — the
 * deploy, in a test — and would pass trivially against a single instance,
 * which is exactly why they are written this way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import { buildApp } from '../src/app';
import { MemoryBus } from '../src/adapters/memory-bus';
import { MemoryStore } from '../src/adapters/memory-store';
import type { Deps } from '../src/modules/types';
import { getRoomsRuntime } from '../src/modules/rooms/runtime';
import { newId } from '../src/lib/tokens';
import { addMember, seedRoom, signupUser, testConfig } from './helpers';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MEDIA_REF = { kind: 'url', url: 'https://example.com/a.mp3', mime: 'audio/mpeg' } as const;

function seedItem(addedBy: string): QueueItem {
  return {
    id: newId() as QueueItemId,
    mediaRef: MEDIA_REF,
    title: 'Current',
    durationMs: null,
    artworkUrl: null,
    addedBy: addedBy as UserId,
    votesToSkip: [],
  };
}

describe('a room split across two instances', () => {
  let store: MemoryStore;
  let bus: MemoryBus;
  /** [instance 1, instance 2] — one store, one bus, two processes' worth. */
  let apps: FastifyInstance[];
  let deps: Deps[];
  let ports: number[];
  let sockets: WebSocket[];

  beforeEach(async () => {
    store = new MemoryStore();
    bus = new MemoryBus();
    apps = [];
    deps = [];
    ports = [];
    sockets = [];
    for (let i = 0; i < 2; i += 1) {
      const built = await buildApp({ config: testConfig(), store, bus });
      await built.app.listen({ port: 0, host: '127.0.0.1' });
      apps.push(built.app);
      deps.push(built.deps);
      ports.push((built.app.server.address() as AddressInfo).port);
    }
  });

  afterEach(async () => {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    for (const d of deps) {
      await getRoomsRuntime(d).close();
    }
    for (const app of apps) {
      await app.close();
    }
  });

  interface Joined {
    userId: UserId;
    accessToken: string;
    sock: WebSocket;
    /** Which instance owns this socket. */
    instance: number;
  }

  /** Open a room socket for an existing account on instance `at` and beat. */
  async function connect(
    roomId: string,
    at: number,
    account: { userId: UserId; accessToken: string },
  ): Promise<Joined> {
    const sock = await openSocket(
      `ws://127.0.0.1:${String(ports[at])}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    const snapshot = nextOfType(sock, 'queue.state');
    sock.send(clientFrame(roomId, 'presence.update', { state: 'watching', wantSnapshot: true }));
    await snapshot;
    return { ...account, sock, instance: at };
  }

  /** Sign up on instance `at`, join the room, open a socket there, beat. */
  async function join(email: string, roomId: string, at: number): Promise<Joined> {
    const account = await signupUser(apps[at]!, email);
    await addMember(store, roomId, account.user.id, 'member');
    return connect(roomId, at, {
      userId: account.user.id,
      accessToken: account.accessToken,
    });
  }

  function presentOn(instance: number, roomId: string): string[] {
    return getRoomsRuntime(deps[instance]!).presence.presentUserIds(roomId as RoomId);
  }

  /**
   * Beat every socket until every instance HOLDING one agrees the room has
   * `expected` members. An instance subscribes the room's ctl channel on its
   * first LOCAL heartbeat, so the earliest beats can predate the other side's
   * subscription; re-beating is what a live client does anyway. Instances with
   * no socket in the room are not watching it and are not asked.
   */
  async function converge(roomId: string, joined: Joined[], expected: number): Promise<void> {
    const watching = [...new Set(joined.map((member) => member.instance))];
    const counts = (): number[] => watching.map((instance) => presentOn(instance, roomId).length);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (counts().every((count) => count === expected)) {
        return;
      }
      for (const member of joined) {
        member.sock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
      }
      await sleep(25);
    }
    throw new Error(
      `instances never agreed on the roster: got [${counts().join(', ')}], ` +
        `expected ${String(expected)} on each of [${watching.join(', ')}]`,
    );
  }

  it('counts the whole room for a vote-skip, not the half on this instance', async () => {
    const { roomId } = await seedRoom(store);
    // Two members per instance. skipVoteThreshold is 0.5 → 2 of 4 skips; the
    // socket-scoped answer was 1 of the 2 on whichever instance heard the vote.
    const a = await join('split-a@example.com', roomId, 0);
    const b = await join('split-b@example.com', roomId, 0);
    const c = await join('split-c@example.com', roomId, 1);
    const d = await join('split-d@example.com', roomId, 1);
    await converge(roomId, [a, b, c, d], 4);

    const item = seedItem(a.userId);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [item], version: 1 } });

    // Each instance sees only its own two sockets...
    expect(deps[0]!.hub.localUserIds(roomId as RoomId)).toHaveLength(2);
    expect(deps[1]!.hub.localUserIds(roomId as RoomId)).toHaveLength(2);
    // ...and both see all four members.
    expect(presentOn(0, roomId)).toHaveLength(4);
    expect(presentOn(1, roomId)).toHaveLength(4);

    // ONE vote, on instance 1. Against the local socket count that is a
    // majority of two and the track disappears for everybody.
    const pFirst = nextOfType(c.sock, 'queue.state');
    a.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const first = await pFirst;
    expect(first.payload.items).toHaveLength(1);
    expect(first.payload.items[0].votesToSkip).toEqual([a.userId]);

    // The second vote — from the OTHER instance — is what reaches 2 of 4.
    const pSecond = nextOfType(a.sock, 'queue.state');
    c.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    expect((await pSecond).payload.items).toHaveLength(0);
  });

  it('keeps a buffering reporter who moved to the other instance in the waiting list', async () => {
    const { roomId } = await seedRoom(store);
    const room = await store.rooms.findById(roomId);
    await store.rooms.updateOne(
      { id: roomId },
      { policies: { ...room!.policies, waitForAll: true } },
    );

    const mover = await join('mover@example.com', roomId, 0);
    const stayer = await join('stayer@example.com', roomId, 0);
    await converge(roomId, [mover, stayer], 2);

    // The mover reports buffering to instance 1, then their socket goes —
    // a deploy draining that process, a reconnect, a flaky network.
    const pFirst = nextOfType(stayer.sock, 'sync.waiting');
    mover.sock.send(clientFrame(roomId, 'sync.buffering', { buffering: true }));
    expect((await pFirst).payload.waitingOn).toEqual([mover.userId]);
    mover.sock.close();

    // They come back on instance 2 — same account, same membership. They never
    // stopped being in the room, and they never said they were ready.
    const moverAgain = await connect(roomId, 1, mover);
    await converge(roomId, [moverAgain, stayer], 2);
    expect(
      deps[0]!.hub.localUserIds(roomId as RoomId),
    ).not.toContain(mover.userId);
    expect(presentOn(0, roomId)).toContain(mover.userId);

    // Instance 1 broadcasts again. The mover must still be held: pruning them
    // here is how the room used to start playing over somebody's buffering.
    const pSecond = nextOfType(stayer.sock, 'sync.waiting');
    stayer.sock.send(clientFrame(roomId, 'sync.buffering', { buffering: true }));
    const waiting = (await pSecond).payload.waitingOn as string[];
    expect(waiting).toContain(mover.userId);
    expect(waiting).toContain(stayer.userId);
  });
});
