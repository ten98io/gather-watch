/**
 * THE MASTER SEAT IS GONE FROM THE SERVER.
 *
 * `sync.claimMaster` had zero producers repo-wide once `sync.advance` took over
 * auto-advance: no app or package sent it, and MasterElection (the only thing
 * designed to) was instantiated nowhere but its own test. What it left behind
 * was not inert — it was a live, persisted, room-wide write that any member
 * could perform, whose whole authorization story existed only to stop it being
 * a control bypass. That is a liability with no benefit.
 *
 * Removed: the ws seat, SyncService.claimMaster, RoomDoc.master, the
 * masterChanged snapshot reply on presence, the reference CAS in
 * rooms/master.ts, and MasterElection.
 *
 * What is asserted here is the ABSENCE, at the two places a reintroduction
 * would show up first: the socket must refuse the frame, and a room must never
 * grow a `master` field. sync-master-authz.test.ts — which pinned who was
 * allowed to claim the seat — was deleted whole with this file as its
 * replacement; there is no authorization question left to answer when there is
 * nothing to authorize.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { RoomId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

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

/** Everything the socket receives from now on — the only way to assert that
 *  something did NOT arrive. */
function collect(sock: WebSocket): Frame[] {
  const frames: Frame[] = [];
  sock.on('message', (data: RawData) => {
    frames.push(JSON.parse(data.toString()) as Frame);
  });
  return frames;
}

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the master seat is removed', () => {
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

  async function join(
    email: string,
    roomId: string,
    role: 'host' | 'moderator' | 'member',
  ): Promise<WebSocket> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await openSocket(
      `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    return sock;
  }

  it('refuses a sync.claimMaster frame at the contract boundary', async () => {
    // Not ROOM_POLICY, not CONFLICT — VALIDATION. The distinction matters: a
    // policy error would mean the seat still exists and this caller merely
    // lacked the authority. VALIDATION means there is no such event.
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');

    const pErr = nextOfType(host, 'error');
    host.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    expect((await pErr).payload.code).toBe('VALIDATION');
  });

  it('never emits sync.masterChanged, and writes no master onto the room', async () => {
    // A host is the most privileged caller there is; if the seat survived
    // anywhere it would survive for them.
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const other = await join('other@example.com', roomId, 'member');
    const seen = collect(other);

    host.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    await settle();

    expect(seen.filter((f) => f.type === 'sync.masterChanged')).toEqual([]);
    const room = await store.rooms.findById(roomId as RoomId);
    expect(room).not.toBeNull();
    expect(Object.keys(room as object)).not.toContain('master');
  });

  it('the presence snapshot reply carries no master', async () => {
    // presence.update with wantSnapshot is what a reloading tab sends, and it
    // used to be the ONLY way a client learned who held the seat. It must not
    // resurrect the event for a late joiner.
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const seen = collect(host);

    host.send(clientFrame(roomId, 'presence.update', { wantSnapshot: true }));
    await settle();

    expect(seen.some((f) => f.type === 'presence.state')).toBe(true);
    expect(seen.filter((f) => f.type === 'sync.masterChanged')).toEqual([]);
  });
});
