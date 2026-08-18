/**
 * Sync module tests over real 127.0.0.1 sockets: policy/master gating, stale
 * master epochs, late-joiner replay convergence, setTrack by queue index,
 * waitForAll buffering aggregation, and the playback-history usage log.
 *
 * The master-seat AUTHORIZATION rules live in sync-master-authz.test.ts. What
 * is pinned below is the epoch machinery — CAS, monotonicity, server-owned
 * numbering — which is why these rooms run an `everyone` playbackControl: a
 * plain member has to be able to claim the seat legitimately for the epoch
 * mechanics to be exercised at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { QueueItem, RoomId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import { newId } from '../src/lib/tokens';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

// ── socket helpers ───────────────────────────────────────────────────────────

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

/** Next frame of the given type; other broadcasts may interleave. */
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

// ── tests ────────────────────────────────────────────────────────────────────

describe('sync module', () => {
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

  /** Sign up a full account, add it to the room with the given role, and open
   *  its room socket. */
  async function join(email: string, roomId: string, role: 'host' | 'moderator' | 'member'): Promise<Joined> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await connect(wsUrl(roomId, account.accessToken));
    return { account, sock };
  }

  /** Open playback control to every member — see the header note. */
  async function openPlaybackToEveryone(roomId: string): Promise<void> {
    const room = await store.rooms.findById(roomId);
    await store.rooms.updateOne(
      { id: roomId as RoomId },
      { policies: { ...room!.policies, playbackControl: 'everyone' } },
    );
  }

  // ── policy gating ──────────────────────────────────────────────────────────

  it('gates playback mutations on policy; the host mutation persists + broadcasts', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    // playbackControl is 'host': a plain member is rejected and nothing persists.
    const pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'sync.play', {}));
    const err = await pErr;
    expect(err.seq).toBe(0);
    expect(err.payload.code).toBe('ROOM_POLICY');
    expect((await store.rooms.findById(roomId))!.playback).toBeNull();

    // The host passes the gate: both sockets converge on the same sync.state.
    const pHost = nextOfType(host.sock, 'sync.state');
    const pMember = nextOfType(member.sock, 'sync.state');
    host.sock.send(clientFrame(roomId, 'sync.play', { positionMs: 0 }));
    const [stateHost, stateMember] = await Promise.all([pHost, pMember]);

    for (const frame of [stateHost, stateMember]) {
      expect(frame.payload.playing).toBe(true);
      expect(frame.payload.positionMs).toBe(0);
      expect(frame.payload.rate).toBe(1);
      expect(frame.payload.mediaRef).toBeNull();
      expect(frame.payload.queueIndex).toBeNull();
      expect(frame.payload.seq).toBe(1);
    }

    const room = await store.rooms.findById(roomId);
    expect(room!.playback).not.toBeNull();
    expect(room!.playback!.playing).toBe(true);
    expect(room!.playback!.seq).toBe(1);
  });

  // ── master election ────────────────────────────────────────────────────────

  it('seats the claimant, lets them drive, and rejects stale epochs', async () => {
    const { roomId } = await seedRoom(store);
    await openPlaybackToEveryone(roomId);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    // A plain member claims master at epoch 1.
    const pChanged = nextOfType(host.sock, 'sync.masterChanged');
    member.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    const changed = await pChanged;
    expect(changed.payload).toEqual({ masterUserId: member.account.user.id, epoch: 1 });

    // The seat holder drives — under this room's policy, as everyone may.
    const pState = nextOfType(member.sock, 'sync.state');
    member.sock.send(clientFrame(roomId, 'sync.pause', { positionMs: 1234 }));
    const state = await pState;
    expect(state.payload.playing).toBe(false);
    expect(state.payload.positionMs).toBe(1234);

    // An equal epoch from another user is stale.
    const pErr = nextOfType(host.sock, 'error');
    host.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    const err = await pErr;
    expect(err.payload.code).toBe('CONFLICT');
    const room = await store.rooms.findById(roomId);
    expect(room!.master).toEqual({ userId: member.account.user.id, epoch: 1 });

    // A newer epoch wins.
    const pChanged2 = nextOfType(member.sock, 'sync.masterChanged');
    host.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 2 }));
    const changed2 = await pChanged2;
    expect(changed2.payload).toEqual({ masterUserId: host.account.user.id, epoch: 2 });
    expect((await store.rooms.findById(roomId))!.master).toEqual({
      userId: host.account.user.id,
      epoch: 2,
    });
  });

  it('server owns the epoch: a huge injected epoch cannot lock the seat', async () => {
    const { roomId } = await seedRoom(store);
    await openPlaybackToEveryone(roomId);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    // Claim with an absurd epoch: accepted (no master yet) but STORED as 1 —
    // the server assigns stored+1, never the client's number.
    const pChanged = nextOfType(host.sock, 'sync.masterChanged');
    const pChangedMember = nextOfType(member.sock, 'sync.masterChanged');
    member.sock.send(
      clientFrame(roomId, 'sync.claimMaster', { epoch: Number.MAX_SAFE_INTEGER }),
    );
    const changed = await pChanged;
    await pChangedMember; // drain the member's copy so the next wait is clean
    expect(changed.payload).toEqual({ masterUserId: member.account.user.id, epoch: 1 });
    expect((await store.rooms.findById(roomId))!.master).toEqual({
      userId: member.account.user.id,
      epoch: 1,
    });

    // The seat is NOT locked: the host re-claims at the next epoch.
    const pChanged2 = nextOfType(member.sock, 'sync.masterChanged');
    host.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 2 }));
    expect((await pChanged2).payload).toEqual({
      masterUserId: host.account.user.id,
      epoch: 2,
    });
  });

  it('a plain member cannot take the seat while the host is present', async () => {
    // The seat names the SOLE advancer, so it must never go to a client whose
    // setTrack the policy would refuse — otherwise every other tab stands down
    // and the queue stops forever. The seat and the drive share one predicate.
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');
    host.sock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    member.sock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    await new Promise((r) => setTimeout(r, 50));

    const pChanged = nextOfType(member.sock, 'sync.masterChanged');
    host.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    await pChanged;

    const pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 5 }));
    expect((await pErr).payload.code).toBe('ROOM_POLICY');
    expect((await store.rooms.findById(roomId))!.master).toEqual({
      userId: host.account.user.id,
      epoch: 1,
    });
  });

  // ── late joiner convergence ────────────────────────────────────────────────

  it('persists sync.state events so late joiners replay them in seq order', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    const pPlay = nextOfType(host.sock, 'sync.state');
    host.sock.send(clientFrame(roomId, 'sync.play', { positionMs: 1000 }));
    await pPlay;
    const pSeek = nextOfType(host.sock, 'sync.state');
    host.sock.send(clientFrame(roomId, 'sync.seek', { positionMs: 5000 }));
    await pSeek;

    // The replay endpoint is what late joiners / WS-fallback clients read.
    const replay = await app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/events?since=0`,
      headers: { authorization: `Bearer ${member.account.accessToken}` },
    });
    expect(replay.statusCode).toBe(200);
    const events = (replay.json() as { events: unknown[] }).events as Frame[];
    const syncStates = events.filter((e) => e.type === 'sync.state');
    expect(syncStates).toHaveLength(2);
    expect(syncStates.map((e) => e.seq)).toEqual([1, 2]);
    expect(syncStates[0]!.payload.playing).toBe(true);
    expect(syncStates[0]!.payload.positionMs).toBe(1000);
    expect(syncStates[1]!.payload.positionMs).toBe(5000);
    // The playback-snapshot seq is a separate counter from the room event seq.
    expect(syncStates.map((e) => e.payload.seq)).toEqual([1, 2]);
  });

  // ── setTrack ───────────────────────────────────────────────────────────────

  it('rejects an out-of-range queueIndex and tracks a seeded queue item', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');

    const pErr = nextOfType(host.sock, 'error');
    host.sock.send(clientFrame(roomId, 'sync.setTrack', { kind: 'queue', queueIndex: 0 }));
    const err = await pErr;
    expect(err.payload.code).toBe('VALIDATION');

    const mediaRef = { kind: 'url', url: 'https://example.com/a.mp3', mime: 'audio/mpeg' } as const;
    const item: QueueItem = {
      id: newId() as QueueItem['id'],
      mediaRef,
      title: 'Track A',
      durationMs: null,
      artworkUrl: null,
      addedBy: host.account.user.id,
      votesToSkip: [],
    };
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [item], version: 1 } });

    const pState = nextOfType(host.sock, 'sync.state');
    host.sock.send(clientFrame(roomId, 'sync.setTrack', { kind: 'queue', queueIndex: 0 }));
    const state = await pState;
    expect(state.payload.mediaRef).toEqual(mediaRef);
    expect(state.payload.queueIndex).toBe(0);
    expect(state.payload.positionMs).toBe(0);

    const room = await store.rooms.findById(roomId);
    expect(room!.playback!.mediaRef).toEqual(mediaRef);
    expect(room!.playback!.queueIndex).toBe(0);
  });

  // ── buffering / waitForAll ─────────────────────────────────────────────────

  it('aggregates buffering into sync.waiting while waitForAll is on', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    // Host toggles the policy on; the room broadcast carries contracts Room only.
    const pUpdated = nextOfType(member.sock, 'room.updated');
    host.sock.send(clientFrame(roomId, 'sync.waitForAll', { enabled: true }));
    const updated = await pUpdated;
    expect(updated.payload.policies.waitForAll).toBe(true);
    expect(updated.payload.playback).toBeUndefined();
    expect(updated.payload.queue).toBeUndefined();
    expect(updated.payload.restream).toBeUndefined();
    expect(updated.payload.master).toBeUndefined();
    expect((await store.rooms.findById(roomId))!.policies.waitForAll).toBe(true);

    // A member buffering holds playback for the room.
    const pWaiting = nextOfType(host.sock, 'sync.waiting');
    member.sock.send(clientFrame(roomId, 'sync.buffering', { buffering: true }));
    const waiting = await pWaiting;
    expect(waiting.seq).toBe(0); // ephemeral
    expect(waiting.payload.waitingOn).toEqual([member.account.user.id]);

    // Ready again: empty list releases the room.
    const pReady = nextOfType(host.sock, 'sync.waiting');
    member.sock.send(clientFrame(roomId, 'sync.buffering', { buffering: false }));
    const ready = await pReady;
    expect(ready.payload.waitingOn).toEqual([]);
  });

  // ── playback history ───────────────────────────────────────────────────────

  it('appends playback.history usage docs for play/pause/seek transitions', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const userId = host.account.user.id;

    const pPlay = nextOfType(host.sock, 'sync.state');
    host.sock.send(clientFrame(roomId, 'sync.play', { positionMs: 1000 }));
    await pPlay;
    const pPause = nextOfType(host.sock, 'sync.state');
    host.sock.send(clientFrame(roomId, 'sync.pause', { positionMs: 2000 }));
    await pPause;
    const pSeek = nextOfType(host.sock, 'sync.state');
    host.sock.send(clientFrame(roomId, 'sync.seek', { positionMs: 5000 }));
    await pSeek;

    const docs = await store.usage.findMany({ kind: 'playback.history', userId });
    expect(docs).toHaveLength(3);
    const positions = docs
      .map((doc) => doc.meta?.['positionMs'])
      .sort((a, b) => Number(a) - Number(b));
    expect(positions).toEqual([1000, 2000, 5000]);
    for (const doc of docs) {
      expect(doc.roomId).toBe(roomId);
      expect(doc.unit).toBe('ms');
      expect(doc.amount).toBe(doc.meta?.['positionMs']);
      expect(typeof doc.meta?.['startedAt']).toBe('number');
    }
  });
});
