/**
 * RoomHub tests over real 127.0.0.1 sockets: handshake auth (close codes),
 * frame validation, the handler registry with seq assignment, clock.ping,
 * WebRTC relay, REST replay, and cross-instance bus fanout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import { ServerEvent } from '@gather/contracts';
import { buildApp } from '../src/app';
import type { RoomHub } from '../src/ws/hub';
import type { Deps } from '../src/modules/types';
import type { StorePort } from '../src/adapters/ports';
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

function collectMessages(sock: WebSocket, n: number, timeoutMs = 2000): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const collected: Frame[] = [];
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('message', onMessage);
    };
    const onMessage = (data: RawData): void => {
      collected.push(JSON.parse(data.toString()) as Frame);
      if (collected.length >= n) {
        cleanup();
        resolve(collected);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`timed out after ${timeoutMs}ms with ${collected.length}/${n} messages`),
      );
    }, timeoutMs);
    sock.on('message', onMessage);
  });
}

function closeCode(sock: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    sock.once('close', (code) => resolve(code));
  });
}

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('ws hub', () => {
  let app: FastifyInstance;
  let deps: Deps;
  let hub: RoomHub;
  let store: StorePort;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    ({ app, deps, hub, store } = await makeApp());
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

  function wsUrl(roomId: string, token?: string): string {
    const base = `ws://127.0.0.1:${port}/ws?roomId=${roomId}`;
    return token === undefined ? base : `${base}&token=${token}`;
  }

  /** Sign up a full account and make it a room member. */
  async function makeMember(email: string, roomId: string): Promise<SignedUpUser> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, 'member');
    return account;
  }

  /** Connect, expect the server to close the socket with the given code. */
  async function expectClose(url: string, code: number): Promise<void> {
    const sock = await connect(url);
    expect(await closeCode(sock)).toBe(code);
  }

  // ── handshake auth ─────────────────────────────────────────────────────────

  it('closes with 4401 when the token is missing', async () => {
    const { roomId } = await seedRoom(store);
    await expectClose(wsUrl(roomId), 4401);
  });

  it('closes with 4401 for a garbage token — checked before the room exists', async () => {
    // Unknown roomId + garbage token: token is verified FIRST, so 4401 not 4404.
    await expectClose(wsUrl('no-such-room', 'garbage-token'), 4401);
  });

  it('closes with 4403 for a valid token whose user is not a member', async () => {
    const { roomId } = await seedRoom(store);
    const outsider = await signupUser(app, 'outsider@example.com');
    await expectClose(wsUrl(roomId, outsider.accessToken), 4403);
  });

  it('closes with 4403 for a banned member', async () => {
    const { roomId } = await seedRoom(store);
    const banned = await makeMember('banned@example.com', roomId);
    await store.members.updateOne(
      { roomId, userId: banned.user.id },
      { banned: true },
    );
    await expectClose(wsUrl(roomId, banned.accessToken), 4403);
  });

  it('closes with 4404 for an unknown roomId', async () => {
    const account = await signupUser(app, 'someone@example.com');
    await expectClose(wsUrl('no-such-room', account.accessToken), 4404);
  });

  it('closes with 4403 when a guest token for room A is used on room B', async () => {
    const roomA = await seedRoom(store);
    const roomB = await seedRoom(store);
    const guestRes = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode: roomA.inviteCode, displayName: 'Guest A' },
    });
    expect(guestRes.statusCode).toBe(200);
    const guest = guestRes.json() as { accessToken: string };
    await expectClose(wsUrl(roomB.roomId, guest.accessToken), 4403);
  });

  // ── frame validation ───────────────────────────────────────────────────────

  it('answers invalid frames with an ephemeral error event', async () => {
    const { roomId } = await seedRoom(store);
    const member = await makeMember('valid@example.com', roomId);
    const sock = await connect(wsUrl(roomId, member.accessToken));

    // Not JSON at all.
    const p1 = nextMessage(sock);
    sock.send('not json');
    const err1 = await p1;
    expect(err1.type).toBe('error');
    expect(err1.seq).toBe(0);
    expect(err1.payload.code).toBe('VALIDATION');

    // Valid JSON envelope, but the type is not in the ClientEvent union.
    const p2 = nextMessage(sock);
    sock.send(clientFrame(roomId, 'madeup.type', {}));
    const err2 = await p2;
    expect(err2.type).toBe('error');
    expect(err2.seq).toBe(0);
    expect(err2.payload.code).toBe('VALIDATION');
    expect(err2.payload.message).toContain('type');

    // Syntactically valid ClientEvent whose type has no registered handler
    // (no module claims restream.* yet): the error names the offending type.
    const p3 = nextMessage(sock);
    sock.send(clientFrame(roomId, 'restream.start', {}));
    const err3 = await p3;
    expect(err3.payload.code).toBe('VALIDATION');
    expect(err3.payload.message).toContain('restream.start');

    // Valid ClientEvent addressed at a DIFFERENT room than this connection.
    const other = await seedRoom(store);
    const p4 = nextMessage(sock);
    sock.send(clientFrame(other.roomId, 'clock.ping', { clientTs: 1 }));
    const err4 = await p4;
    expect(err4.type).toBe('error');
    expect(err4.seq).toBe(0);
    expect(err4.payload.code).toBe('FORBIDDEN');
  });

  // ── handler registry + seq assignment ─────────────────────────────────────

  it('closes live sockets with 4401 when their session is revoked (logout)', async () => {
    const { roomId } = await seedRoom(store);
    const account = await makeMember('revokee@example.com', roomId);
    const sock = await connect(wsUrl(roomId, account.accessToken));
    const closed = closeCode(sock);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${account.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    // The revoke must reach the ALREADY-OPEN socket, not just future accepts.
    expect(await closed).toBe(4401);
  });

  it('rate-limits inbound frames: flood gets one RATE_LIMITED error, frames dropped', async () => {
    const { roomId } = await seedRoom(store);
    const account = await makeMember('flooder@example.com', roomId);
    const sock = await connect(wsUrl(roomId, account.accessToken));

    const rateLimited = new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no RATE_LIMITED frame')), 5000);
      sock.on('message', (data: RawData) => {
        const frame = JSON.parse(data.toString()) as Frame;
        if (frame.type === 'error' && frame.payload.code === 'RATE_LIMITED') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
    // 300 frames/10s is the ceiling; blow past it inside one window.
    for (let i = 0; i < 305; i += 1) {
      sock.send(clientFrame(roomId, 'clock.ping', { clientTs: Date.now() }));
    }
    const err = await rateLimited;
    expect(err.payload.code).toBe('RATE_LIMITED');
    // The connection survives (drop, not disconnect).
    expect(sock.readyState).toBe(WebSocket.OPEN);
  });

  it('dispatches registered handlers and assigns monotonic seqs', async () => {
    const { roomId } = await seedRoom(store);
    hub.registerModule({
      name: 'test',
      wsHandlers: {
        'restream.start': async (_ev, ctx) => {
          ctx.deps.events.emitEphemeral(ctx.roomId, 'chat.typing', {
            userId: ctx.auth.userId,
            typing: true,
          });
          await ctx.deps.events.emit(ctx.roomId, 'sync.waiting', { waitingOn: [] });
        },
      },
    });
    // Registering a duplicate type throws synchronously.
    expect(() =>
      hub.registerModule({
        name: 'test-dup',
        wsHandlers: { 'restream.start': () => {} },
      }),
    ).toThrow();

    const a = await makeMember('a@example.com', roomId);
    const b = await makeMember('b@example.com', roomId);
    const sockA = await connect(wsUrl(roomId, a.accessToken));
    const sockB = await connect(wsUrl(roomId, b.accessToken));

    // First send: BOTH sockets get the ephemeral (seq 0) and the persisted
    // sync.waiting (seq 1).
    const pa1 = collectMessages(sockA, 2);
    const pb1 = collectMessages(sockB, 2);
    sockA.send(clientFrame(roomId, 'restream.start', {}));
    const [msgsA, msgsB] = await Promise.all([pa1, pb1]);

    for (const msgs of [msgsA, msgsB]) {
      const typing = msgs.find((m) => m.type === 'chat.typing');
      const waiting = msgs.find((m) => m.type === 'sync.waiting');
      expect(typing).toBeDefined();
      expect(typing!.seq).toBe(0);
      expect(typing!.payload).toEqual({ userId: a.user.id, typing: true });
      expect(waiting).toBeDefined();
      expect(waiting!.seq).toBe(1);
      expect(waiting!.payload).toEqual({ waitingOn: [] });
      // Both envelopes parse with the contracts ServerEvent schema.
      ServerEvent.parse(typing);
      ServerEvent.parse(waiting);
    }

    // Second send: the next persisted event gets seq 2 (monotonic).
    const pb2 = collectMessages(sockB, 2);
    sockA.send(clientFrame(roomId, 'restream.start', {}));
    const msgs2 = await pb2;
    const waiting2 = msgs2.find((m) => m.type === 'sync.waiting');
    expect(waiting2).toBeDefined();
    expect(waiting2!.seq).toBe(2);
    ServerEvent.parse(waiting2);
  });

  // ── clock.ping ─────────────────────────────────────────────────────────────

  it('replies clock.pong only to the sender', async () => {
    const { roomId } = await seedRoom(store);
    const a = await makeMember('ping-a@example.com', roomId);
    const b = await makeMember('ping-b@example.com', roomId);
    const sockA = await connect(wsUrl(roomId, a.accessToken));
    const sockB = await connect(wsUrl(roomId, b.accessToken));

    const pPong = nextMessage(sockA);
    const pSilence = nextMessage(sockB, 200);
    sockA.send(clientFrame(roomId, 'clock.ping', { clientTs: 987654321 }));

    const pong = await pPong;
    expect(pong.type).toBe('clock.pong');
    expect(pong.seq).toBe(0);
    expect(pong.payload.clientTs).toBe(987654321);
    expect(typeof pong.payload.serverTs).toBe('number');
    ServerEvent.parse(pong);

    // The other socket receives nothing for it.
    await expect(pSilence).rejects.toThrow(/timed out/);
  });

  // ── webrtc relay ───────────────────────────────────────────────────────────

  it('relays webrtc.offer to the target user only, stamped with the sender', async () => {
    const { roomId } = await seedRoom(store);
    const a = await makeMember('rtc-a@example.com', roomId);
    const b = await makeMember('rtc-b@example.com', roomId);
    const sockA = await connect(wsUrl(roomId, a.accessToken));
    const sockB = await connect(wsUrl(roomId, b.accessToken));

    const pOffer = nextMessage(sockB);
    const pSilence = nextMessage(sockA, 200);
    sockA.send(
      clientFrame(roomId, 'webrtc.offer', {
        targetUserId: b.user.id,
        connectionId: 'c1',
        sdp: 'x',
      }),
    );

    const offer = await pOffer;
    expect(offer.type).toBe('webrtc.offer');
    expect(offer.seq).toBe(0);
    expect(offer.payload).toEqual({
      targetUserId: b.user.id,
      connectionId: 'c1',
      sdp: 'x',
      fromUserId: a.user.id,
    });
    ServerEvent.parse(offer);

    // The sender does NOT receive its own offer back.
    await expect(pSilence).rejects.toThrow(/timed out/);
  });

  // ── replay via REST ────────────────────────────────────────────────────────

  it('replays persisted events via GET /rooms/:id/events', async () => {
    const { roomId } = await seedRoom(store);
    hub.registerModule({
      name: 'test',
      wsHandlers: {
        'restream.start': async (_ev, ctx) => {
          await ctx.deps.events.emit(ctx.roomId, 'sync.waiting', { waitingOn: [] });
        },
      },
    });
    const a = await makeMember('replay-a@example.com', roomId);
    const sockA = await connect(wsUrl(roomId, a.accessToken));

    // Emit two persisted events; receiving the seq-2 one proves both landed.
    const p = collectMessages(sockA, 2);
    sockA.send(clientFrame(roomId, 'restream.start', {}));
    sockA.send(clientFrame(roomId, 'restream.start', {}));
    const msgs = await p;
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);

    const replay = await app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/events?since=0`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(replay.statusCode).toBe(200);
    const events = (replay.json() as { events: unknown[] }).events;
    expect(events).toHaveLength(2);
    for (const event of events) {
      ServerEvent.parse(event);
    }
    const seqs = events.map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);

    const since1 = await app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/events?since=1`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const events1 = (since1.json() as { events: unknown[] }).events;
    expect(events1).toHaveLength(1);
    expect((events1[0] as { seq: number }).seq).toBe(2);

    // Non-member → 403; unauthenticated → 401.
    const outsider = await signupUser(app, 'replay-outsider@example.com');
    const forbidden = await app.inject({
      method: 'GET',
      url: `/rooms/${roomId}/events?since=0`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: `/rooms/${roomId}/events?since=0` });
    expect(anon.statusCode).toBe(401);
  });

  // ── multi-instance fanout ──────────────────────────────────────────────────

  it('fans an emit out across app instances sharing one bus', async () => {
    const { roomId } = await seedRoom(store);
    hub.registerModule({
      name: 'test',
      wsHandlers: {
        'restream.start': async (_ev, ctx) => {
          await ctx.deps.events.emit(ctx.roomId, 'sync.waiting', { waitingOn: [] });
        },
      },
    });

    // Second app over the SAME store + bus instances (multi-instance deploy).
    const built2 = await buildApp({ config: deps.config, store: deps.store, bus: deps.bus });
    const app2 = built2.app;
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const port2 = (app2.server.address() as AddressInfo).port;

    try {
      const a = await makeMember('fanout-a@example.com', roomId);
      const c = await signupUser(app2, 'fanout-c@example.com');
      await addMember(store, roomId, c.user.id, 'member');

      const sockA = await connect(wsUrl(roomId, a.accessToken));
      const sockC = await connect(
        `ws://127.0.0.1:${port2}/ws?roomId=${roomId}&token=${c.accessToken}`,
      );

      const pa = collectMessages(sockA, 1);
      const pc = collectMessages(sockC, 1);
      sockA.send(clientFrame(roomId, 'restream.start', {}));
      const [msgsA, msgsC] = await Promise.all([pa, pc]);

      // The emit triggered on app 1 reached member C on app 2 via the bus,
      // with the same seq.
      expect(msgsC[0]!.type).toBe('sync.waiting');
      expect(msgsC[0]!.seq).toBe(msgsA[0]!.seq);
      expect(msgsC[0]!.seq).toBe(1);
      ServerEvent.parse(msgsC[0]);
    } finally {
      await app2.close();
    }
  });
});
