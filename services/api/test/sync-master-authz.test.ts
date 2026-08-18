/**
 * The master seat is a COORDINATION device, not an authorization device.
 *
 * `sync.claimMaster` used to be an unauthenticated seat grab: with no master
 * stored (the state every room starts in) nothing was checked at all, so any
 * member could claim the seat — and `assertPlaybackControl` let the current
 * master drive playback unconditionally. Net effect: in a
 * `playbackControl: 'host'` room, any member could pause, seek and change the
 * track by first sending one `sync.claimMaster`. The policy the host chose was
 * voided silently.
 *
 * The rule pinned here: claiming the seat requires exactly the authority that
 * DRIVING playback requires, and holding the seat never grants more than the
 * policy currently allows. That keeps it usable — in an `everyone` room every
 * member is eligible, which is what mesh re-election and auto-advance need —
 * while making the seat useless as a bypass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { RoomId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

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

describe('sync.claimMaster authorization', () => {
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
  ): Promise<{ account: SignedUpUser; sock: WebSocket }> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await openSocket(
      `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    return { account, sock };
  }

  async function setPlaybackControl(
    roomId: string,
    level: 'host' | 'mods' | 'everyone',
  ): Promise<void> {
    const room = await store.rooms.findById(roomId as RoomId);
    await store.rooms.updateOne(
      { id: roomId as RoomId },
      { policies: { ...room!.policies, playbackControl: level } },
    );
  }

  it('refuses the seat to a member who could not drive — while someone who can is HERE', async () => {
    // The seat and the drive share ONE predicate on purpose. The client makes
    // the seat holder the SOLE advancer and every other tab stands down, so a
    // seat held by someone the policy forbids is strictly worse than an empty
    // one: their setTrack is refused and nobody else tries. Letting these two
    // drift apart is what froze the queue in a default 'host' room.
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');
    // Both present: the policy's people are reachable, so no fallback.
    host.sock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    member.sock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    await new Promise((r) => setTimeout(r, 50));

    const pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    expect((await pErr).payload.code).toBe('ROOM_POLICY');
  });

  it('GIVES the seat to a plain member once nobody who could drive is present', async () => {
    // The case that motivated all of this: a host on a phone (mobile never
    // claims) or a host who closed their tab. Without the fallback the seat is
    // unfillable and the queue never advances again for anyone.
    const { roomId } = await seedRoom(store);
    await join('host@example.com', roomId, 'host'); // joined, but never announces presence
    const member = await join('member@example.com', roomId, 'member');
    member.sock.send(clientFrame(roomId, 'presence.update', { state: 'watching' }));
    await new Promise((r) => setTimeout(r, 50));

    const pChanged = nextOfType(member.sock, 'sync.masterChanged');
    member.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    expect((await pChanged).payload).toEqual({ masterUserId: member.account.user.id, epoch: 1 });

    // ...and the seat it just took is a REAL one: the same member may drive.
    const pState = nextOfType(member.sock, 'sync.state');
    member.sock.send(clientFrame(roomId, 'sync.pause', { positionMs: 1000 }));
    expect((await pState).payload.playing).toBe(false);
  });

  it('does not let the seat become playback control', async () => {
    const { roomId } = await seedRoom(store);
    await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    // One predicate, two doors: a member refused the SEAT is refused the DRIVE
    // for exactly the same reason, so the two can never disagree.
    const pClaimErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    expect((await pClaimErr).payload.code).toBe('ROOM_POLICY');

    const pPauseErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'sync.pause', { positionMs: 4321 }));
    expect((await pPauseErr).payload.code).toBe('ROOM_POLICY');
    expect((await store.rooms.findById(roomId as RoomId))!.playback).toBeNull();
  });

  it('lets every member claim and re-elect under an `everyone` policy', async () => {
    // The usable half: mesh re-election and auto-advance need an ordinary
    // member to be able to take the seat when the room lets anyone drive.
    const { roomId } = await seedRoom(store);
    await setPlaybackControl(roomId, 'everyone');
    const one = await join('one@example.com', roomId, 'member');
    const two = await join('two@example.com', roomId, 'member');

    const pFirst = nextOfType(two.sock, 'sync.masterChanged');
    one.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    expect((await pFirst).payload).toEqual({ masterUserId: one.account.user.id, epoch: 1 });

    const pSecond = nextOfType(one.sock, 'sync.masterChanged');
    two.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 2 }));
    expect((await pSecond).payload).toEqual({ masterUserId: two.account.user.id, epoch: 2 });

    // And the seat holder can actually drive, which is the point of holding it.
    const pState = nextOfType(one.sock, 'sync.state');
    two.sock.send(clientFrame(roomId, 'sync.pause', { positionMs: 99 }));
    expect((await pState).payload.positionMs).toBe(99);
  });

  it('a seat held from a looser policy does not survive the policy tightening', async () => {
    const { roomId } = await seedRoom(store);
    await setPlaybackControl(roomId, 'everyone');
    const member = await join('member@example.com', roomId, 'member');

    const pChanged = nextOfType(member.sock, 'sync.masterChanged');
    member.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    await pChanged;

    // The host locks playback down. The stored master row still names the
    // member — it must stop being a licence the moment the policy says so.
    await setPlaybackControl(roomId, 'host');
    const pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'sync.seek', { positionMs: 5000 }));
    expect((await pErr).payload.code).toBe('ROOM_POLICY');
    expect((await store.rooms.findById(roomId as RoomId))!.playback).toBeNull();
  });

  it('re-elects between people who CAN drive, under a `mods` policy', async () => {
    const { roomId } = await seedRoom(store);
    await setPlaybackControl(roomId, 'mods');
    const mod = await join('mod@example.com', roomId, 'moderator');
    const other = await join('mod2@example.com', roomId, 'moderator');

    const pChanged = nextOfType(other.sock, 'sync.masterChanged');
    mod.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 1 }));
    expect((await pChanged).payload.masterUserId).toBe(mod.account.user.id);

    const pSecond = nextOfType(mod.sock, 'sync.masterChanged');
    other.sock.send(clientFrame(roomId, 'sync.claimMaster', { epoch: 2 }));
    expect((await pSecond).payload).toEqual({ masterUserId: other.account.user.id, epoch: 2 });
  });
});
