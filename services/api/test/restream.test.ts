/**
 * Restream module tests over real 127.0.0.1 sockets. The module is the
 * server half of Mode B that was designed on the wire and never written —
 * pressing "Share screen" sent restream.start into the hub's unknown-event
 * path and nothing came back. These tests pin the whole room-wide contract:
 * broadcast + persistence, the one-share-per-room conflict, the
 * absent-host takeover, who may stop, and the late-joiner snapshot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { StorePort } from '../src/adapters/ports';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const cleanup = (): void => {
      sock.off('open', onOpen);
      sock.off('close', onClose);
      sock.off('error', onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve(sock);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`socket closed before open (code ${code})`));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    sock.once('open', onOpen);
    sock.once('close', onClose);
    sock.once('error', onError);
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

describe('restream module', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    ({ app, store } = await makeApp());
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
    await app.close();
  });

  async function connect(url: string): Promise<WebSocket> {
    const sock = await openSocket(url);
    sockets.push(sock);
    return sock;
  }

  function wsUrl(roomId: string, token: string): string {
    return `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${token}`;
  }

  interface Joined {
    account: SignedUpUser;
    sock: WebSocket;
  }

  async function join(
    email: string,
    roomId: string,
    role: 'host' | 'moderator' | 'member',
  ): Promise<Joined> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await connect(wsUrl(roomId, account.accessToken));
    return { account, sock };
  }

  it('start broadcasts restream.state to every socket and persists on the room', async () => {
    const { roomId } = await seedRoom(store);
    const sharer = await join('sharer@example.com', roomId, 'member');
    const viewer = await join('viewer@example.com', roomId, 'member');

    const pSharer = nextOfType(sharer.sock, 'restream.state');
    const pViewer = nextOfType(viewer.sock, 'restream.state');
    sharer.sock.send(clientFrame(roomId, 'restream.start', {}));
    const [a, b] = await Promise.all([pSharer, pViewer]);

    for (const frame of [a, b]) {
      expect(frame.payload.active).toBe(true);
      expect(frame.payload.hostUserId).toBe(sharer.account.user.id);
    }
    const room = await store.rooms.findById(roomId);
    expect(room?.restream?.active).toBe(true);
    expect(room?.restream?.hostUserId).toBe(sharer.account.user.id);
  });

  it('a second start while the host is present is a conflict, not a takeover', async () => {
    const { roomId } = await seedRoom(store);
    const sharer = await join('sharer@example.com', roomId, 'member');
    const rival = await join('rival@example.com', roomId, 'member');

    const started = nextOfType(sharer.sock, 'restream.state');
    sharer.sock.send(clientFrame(roomId, 'restream.start', {}));
    await started;
    // The sharer's presence is what protects their share.
    sharer.sock.send(
      clientFrame(roomId, 'presence.update', { state: 'watching', sharing: true }),
    );

    const pErr = nextOfType(rival.sock, 'error');
    rival.sock.send(clientFrame(roomId, 'restream.start', {}));
    const err = await pErr;
    expect(err.payload.code).toBe('CONFLICT');
    const room = await store.rooms.findById(roomId);
    expect(room?.restream?.hostUserId).toBe(sharer.account.user.id);
  });

  it('an absent host loses the share to the next starter — no stuck rooms', async () => {
    const { roomId } = await seedRoom(store);
    const ghost = await join('ghost@example.com', roomId, 'member');
    const rescuer = await join('rescuer@example.com', roomId, 'member');

    const started = nextOfType(ghost.sock, 'restream.state');
    ghost.sock.send(clientFrame(roomId, 'restream.start', {}));
    await started;
    // The ghost's laptop lid closes: socket gone, no clean stop ever sent.
    ghost.sock.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const pState = nextOfType(rescuer.sock, 'restream.state');
    rescuer.sock.send(clientFrame(roomId, 'restream.start', {}));
    const state = await pState;
    expect(state.payload.active).toBe(true);
    expect(state.payload.hostUserId).toBe(rescuer.account.user.id);
  });

  it('the sharer and a moderator may stop; a bystander may not; idle stop is a no-op', async () => {
    const { roomId } = await seedRoom(store);
    const sharer = await join('sharer@example.com', roomId, 'member');
    const mod = await join('mod@example.com', roomId, 'moderator');
    const bystander = await join('bystander@example.com', roomId, 'member');

    // Idle stop: nothing to do, nothing to complain about.
    sharer.sock.send(clientFrame(roomId, 'restream.stop', {}));

    const started = nextOfType(sharer.sock, 'restream.state');
    sharer.sock.send(clientFrame(roomId, 'restream.start', {}));
    await started;

    const pErr = nextOfType(bystander.sock, 'error');
    bystander.sock.send(clientFrame(roomId, 'restream.stop', {}));
    expect((await pErr).payload.code).toBe('FORBIDDEN');

    const pStopped = nextOfType(bystander.sock, 'restream.state');
    mod.sock.send(clientFrame(roomId, 'restream.stop', {}));
    const stopped = await pStopped;
    expect(stopped.payload.active).toBe(false);
    expect(stopped.payload.hostUserId).toBeNull();
    expect((await store.rooms.findById(roomId))?.restream?.active).toBe(false);
  });

  it('a late joiner receives the active share as a snapshot on connect', async () => {
    const { roomId } = await seedRoom(store);
    const sharer = await join('sharer@example.com', roomId, 'member');

    const started = nextOfType(sharer.sock, 'restream.state');
    sharer.sock.send(clientFrame(roomId, 'restream.start', {}));
    await started;

    const late = await signupUser(app, 'late@example.com');
    await addMember(store, roomId, late.user.id, 'member');
    const sock = await connect(wsUrl(roomId, late.accessToken));
    // Snapshots ride the first presence heartbeat (the real client's join
    // flow), not the socket handshake itself.
    const pSnapshot = nextOfType(sock, 'restream.state');
    sock.send(clientFrame(roomId, 'presence.update', {}));
    const snapshot = await pSnapshot;
    expect(snapshot.payload.active).toBe(true);
    expect(snapshot.payload.hostUserId).toBe(sharer.account.user.id);
  });
});
