/**
 * ONE IDENTITY, TWO SOCKETS — the signalling contract the extension share
 * stands on.
 *
 * A person sharing from the extension is in the room twice: the web tab holds
 * their call, the offscreen document holds the screen capture, and both
 * authenticate as the same user. The hub is deliberately blind to the
 * difference — it fans a direct webrtc.* frame out to EVERY socket that user
 * has open, and relays `connectionId` through untouched so the client can tell
 * its own two meshes apart (@gather/p2p mesh lanes).
 *
 * Both halves of that are load-bearing and neither is obvious from the hub's
 * code, so they are pinned here:
 *
 *  - deliver to ONE socket of the user (an "optimization" that looks free) and
 *    the share reaches nobody, because the wrong socket is the one that
 *    answers;
 *  - rewrite or normalise `connectionId` and every frame fails the receiver's
 *    guard in both directions, which is silent — no error, just no call.
 *
 * These are contract pins over behaviour that already holds, not a fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import { ServerEvent } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

interface Frame {
  type: string;
  roomId: string;
  seq: number;
  ts: number;
  payload: Record<string, unknown>;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.once('open', () => resolve(sock));
    sock.once('error', (err: Error) => reject(err));
    sock.once('close', (code: number) => {
      reject(new Error(`socket closed before open (code ${code})`));
    });
  });
}

function nextMessage(sock: WebSocket, timeoutMs = 2000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('message', onMessage);
    };
    const onMessage = (data: RawData): void => {
      cleanup();
      resolve(JSON.parse(data.toString()) as Frame);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a message`));
    }, timeoutMs);
    sock.on('message', onMessage);
  });
}

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

describe('ws signalling with two sockets under one identity', () => {
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

  async function connect(roomId: string, token: string): Promise<WebSocket> {
    const sock = await openSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${token}`);
    sockets.push(sock);
    return sock;
  }

  async function makeMember(email: string, roomId: string): Promise<SignedUpUser> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, 'member');
    return account;
  }

  it('delivers a direct signal to EVERY socket of the target user, id untouched', async () => {
    const { roomId } = await seedRoom(store);
    // Two sockets, one account: the web tab and the offscreen share document.
    const sharer = await makeMember('two-socket-sharer@example.com', roomId);
    const viewer = await makeMember('two-socket-viewer@example.com', roomId);
    const callTab = await connect(roomId, sharer.accessToken);
    const shareDoc = await connect(roomId, sharer.accessToken);
    const viewerSock = await connect(roomId, viewer.accessToken);

    // The viewer answers the share. It cannot know which socket asked, and
    // nothing in the payload names one — only the connectionId does.
    const onCallTab = nextMessage(callTab);
    const onShareDoc = nextMessage(shareDoc);
    const shareConnectionId = `mesh:${roomId}:${sharer.user.id}/share~${viewer.user.id}`;
    viewerSock.send(
      clientFrame(roomId, 'webrtc.answer', {
        targetUserId: sharer.user.id,
        connectionId: shareConnectionId,
        sdp: 'v=0 answer',
      }),
    );

    for (const frame of await Promise.all([onCallTab, onShareDoc])) {
      expect(frame.type).toBe('webrtc.answer');
      expect(frame.seq).toBe(0);
      // Relayed verbatim, lane and all — the receiver matches on this string.
      expect(frame.payload.connectionId).toBe(shareConnectionId);
      expect(frame.payload.sdp).toBe('v=0 answer');
      // Stamped from the authenticated socket, never from the payload: this is
      // what lets a client admit an unknown peer on sight.
      expect(frame.payload.fromUserId).toBe(viewer.user.id);
      ServerEvent.parse(frame);
    }
  });

  it('refuses to take the sender’s word for who they are', async () => {
    const { roomId } = await seedRoom(store);
    const impostor = await makeMember('two-socket-impostor@example.com', roomId);
    const victim = await makeMember('two-socket-victim@example.com', roomId);
    const target = await makeMember('two-socket-target@example.com', roomId);
    const impostorSock = await connect(roomId, impostor.accessToken);
    const targetSock = await connect(roomId, target.accessToken);

    const received = nextMessage(targetSock);
    impostorSock.send(
      clientFrame(roomId, 'webrtc.offer', {
        targetUserId: target.user.id,
        connectionId: `mesh:${roomId}:${target.user.id}~${victim.user.id}`,
        sdp: 'v=0 offer',
        // Claimed, not earned. The hub overwrites it.
        fromUserId: victim.user.id,
      }),
    );

    const frame = await received;
    expect(frame.payload.fromUserId).toBe(impostor.user.id);
    ServerEvent.parse(frame);
  });

  it('leaves a direct signal off every socket that is not the target’s', async () => {
    const { roomId } = await seedRoom(store);
    const sharer = await makeMember('two-socket-a@example.com', roomId);
    const viewer = await makeMember('two-socket-b@example.com', roomId);
    const bystander = await makeMember('two-socket-c@example.com', roomId);
    const shareDoc = await connect(roomId, sharer.accessToken);
    const viewerSock = await connect(roomId, viewer.accessToken);
    const bystanderSock = await connect(roomId, bystander.accessToken);

    const onShareDoc = nextMessage(shareDoc);
    const bystanderSilence = nextMessage(bystanderSock, 250);
    viewerSock.send(
      clientFrame(roomId, 'webrtc.ice', {
        targetUserId: sharer.user.id,
        connectionId: `mesh:${roomId}:${sharer.user.id}/share~${viewer.user.id}`,
        candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0 },
      }),
    );

    expect((await onShareDoc).type).toBe('webrtc.ice');
    await expect(bystanderSilence).rejects.toThrow(/timed out/);
  });
});
