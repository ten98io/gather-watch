/**
 * A share must not outlive its host.
 *
 * `restream.active` is persisted on the room doc and, before this suite, was
 * cleared by exactly one thing: an explicit `restream.stop`. Close the lid,
 * kill the tab, lose the network — the room stayed "sharing" FOREVER, with a
 * hostUserId nobody could reach. RestreamService.start() already knew this
 * ("an absent host's share may be taken over by anyone allowed to share") but
 * takeover only helps when somebody else wants to share; a room where nobody
 * does is stuck on a dead stage.
 *
 * The liveness path pinned here is presence: the sweep that finally DROPS a
 * member (post-grace, or on a stale heartbeat) is the moment the server learns
 * a host is gone, so that is where the share is reaped.
 *
 * Timings are driven by hand — the tracker is reconfigured to a tiny grace and
 * `sweep(now)` is called directly — so nothing here waits on a wall clock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { RoomId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { getRoomsRuntime } from '../src/modules/rooms/runtime';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

const GRACE_MS = 50;

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.once('open', () => resolve(sock));
    sock.once('error', (err: Error) => reject(err));
  });
}

interface Frame {
  type: string;
  roomId: string;
  seq: number;
  ts: number;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
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

describe('an orphaned share is reaped', () => {
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
    // Sweeps are called by hand below; the interval must not race them.
    getRoomsRuntime(deps).presence.configure({
      ttlMs: 60_000,
      sweepMs: 600_000,
      disconnectGraceMs: GRACE_MS,
    });
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

  async function connect(url: string): Promise<WebSocket> {
    const sock = await openSocket(url);
    sockets.push(sock);
    return sock;
  }

  async function join(
    email: string,
    roomId: string,
    role: 'host' | 'moderator' | 'member',
  ): Promise<{ account: SignedUpUser; sock: WebSocket }> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await connect(`ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`);
    return { account, sock };
  }

  /** Heartbeat, then wait for the roster reply so the entry definitely exists. */
  async function beat(sock: WebSocket, roomId: string): Promise<void> {
    const roster = nextOfType(sock, 'presence.state');
    sock.send(clientFrame(roomId, 'presence.update', { state: 'watching', wantSnapshot: true }));
    await roster;
  }

  /** Run the grace to completion: first sweep marks unreachable, second drops. */
  async function sweepPastGrace(): Promise<void> {
    const { presence } = getRoomsRuntime(deps);
    const t0 = Date.now();
    await presence.sweep(t0);
    await presence.sweep(t0 + GRACE_MS + 10);
  }

  it('clears restream.active when the host loses its presence entry', async () => {
    const { roomId } = await seedRoom(store);
    const ghost = await join('ghost@example.com', roomId, 'member');
    const viewer = await join('viewer@example.com', roomId, 'member');
    await beat(ghost.sock, roomId);
    await beat(viewer.sock, roomId);

    const started = nextOfType(viewer.sock, 'restream.state');
    ghost.sock.send(clientFrame(roomId, 'restream.start', {}));
    expect((await started).payload.active).toBe(true);

    // The lid closes: socket gone, no clean stop ever sent.
    const stopped = nextOfType(viewer.sock, 'restream.state', 3000);
    ghost.sock.close();
    await sleep(50);
    await sweepPastGrace();

    const frame = await stopped;
    expect(frame.payload.active).toBe(false);
    expect(frame.payload.hostUserId).toBeNull();

    const room = await store.rooms.findById(roomId as RoomId);
    expect(room?.restream?.active).toBe(false);
    expect(room?.restream?.hostUserId).toBeNull();
  });

  it('leaves a share alone while its host is merely unreachable (inside the grace)', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('blip@example.com', roomId, 'member');
    await beat(host.sock, roomId);

    const started = nextOfType(host.sock, 'restream.state');
    host.sock.send(clientFrame(roomId, 'restream.start', {}));
    await started;

    // A refresh: the socket goes, the grace starts, nothing is dropped yet.
    host.sock.close();
    await sleep(50);
    await getRoomsRuntime(deps).presence.sweep(Date.now());

    const room = await store.rooms.findById(roomId as RoomId);
    expect(room?.restream?.active).toBe(true);
  });

  it('does not disturb another member share when an unrelated member leaves', async () => {
    const { roomId } = await seedRoom(store);
    const sharer = await join('sharer@example.com', roomId, 'member');
    const leaver = await join('leaver@example.com', roomId, 'member');
    await beat(sharer.sock, roomId);
    await beat(leaver.sock, roomId);

    const started = nextOfType(sharer.sock, 'restream.state');
    sharer.sock.send(clientFrame(roomId, 'restream.start', {}));
    await started;

    // The leaver says goodbye explicitly; the sharer is still right here.
    leaver.sock.send(clientFrame(roomId, 'presence.update', { state: 'offline' }));
    await sleep(50);
    await getRoomsRuntime(deps).presence.sweep(Date.now());

    const room = await store.rooms.findById(roomId as RoomId);
    expect(room?.restream?.active).toBe(true);
    expect(room?.restream?.hostUserId).toBe(sharer.account.user.id);
  });
});
