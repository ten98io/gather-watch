/**
 * Queue module tests over real 127.0.0.1 sockets and app.inject: WS
 * add/remove/reorder happy path, reorder validation no-ops, the queueControl
 * policy matrix, voteSkip threshold math (exact threshold, mid-vote leaver
 * pruning, threshold 0), and the playlists REST CRUD + add-to-queue flow.
 * Service-level math is unit-tested in src/modules/queue/queue.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import { memberDocId } from '../src/adapters/ports';
import { newId } from '../src/lib/tokens';
import type { Deps } from '../src/modules/types';
import { registerMetadataResolver } from '../src/modules/metadata/resolver';
import { getRoomsRuntime } from '../src/modules/rooms/runtime';
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

/** The next `count` frames of a type, with the listener attached BEFORE the
 *  triggering send — the only race-free way to observe two broadcasts that
 *  can land back to back (an add and its metadata patch). */
function collectOfType(
  sock: WebSocket,
  type: string,
  count: number,
  timeoutMs = 3000,
): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('message', onMessage);
    };
    const onMessage = (data: RawData): void => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame.type !== type) return;
      frames.push(frame);
      if (frames.length === count) {
        cleanup();
        resolve(frames);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`timed out waiting for ${count} "${type}" frames (got ${frames.length})`),
      );
    }, timeoutMs);
    sock.on('message', onMessage);
  });
}

/** Resolves 'event' when a frame of the type arrives within the window,
 *  'silent' otherwise — for asserting that NO broadcast happens. */
async function hearsWithin(sock: WebSocket, type: string, timeoutMs: number): Promise<string> {
  return nextOfType(sock, type, timeoutMs).then(
    () => 'event',
    () => 'silent',
  );
}

// ── shared fixtures ──────────────────────────────────────────────────────────

const MEDIA_REF = { kind: 'url', url: 'https://example.com/a.mp3', mime: 'audio/mpeg' } as const;

function itemInput(title: string): unknown {
  return { mediaRef: MEDIA_REF, title, durationMs: null, artworkUrl: null };
}

function seedItem(title: string, addedBy: string): QueueItem {
  return {
    id: newId() as QueueItemId,
    mediaRef: MEDIA_REF,
    title,
    durationMs: null,
    artworkUrl: null,
    addedBy: addedBy as UserId,
    votesToSkip: [],
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('queue module', () => {
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

  /** The room's presence set — the vote-skip denominator. */
  function presentIds(roomId: string): string[] {
    return getRoomsRuntime(deps).presence.presentUserIds(roomId as RoomId);
  }

  interface Joined {
    account: SignedUpUser;
    sock: WebSocket;
  }

  /**
   * Sign up a full account, add it to the room with the given role, open its
   * room socket, and BEAT PRESENCE.
   *
   * The beat is not decoration. A socket is a connection to one process;
   * membership of the room's skip quorum is a presence entry, which is what
   * survives being spread over two instances mid-deploy. Every real client
   * beats on connect, so a fixture that only opened a socket was modelling a
   * client that does not exist — and pinning the wrong denominator.
   *
   * The snapshot reply is drained here (queue.state is the last of it in a
   * room with no share) so no test mistakes it for a broadcast.
   */
  async function join(email: string, roomId: string, role: 'host' | 'moderator' | 'member'): Promise<Joined> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await connect(wsUrl(roomId, account.accessToken));
    const snapshot = nextOfType(sock, 'queue.state');
    sock.send(clientFrame(roomId, 'presence.update', { state: 'watching', wantSnapshot: true }));
    await snapshot;
    return { account, sock };
  }

  // ── add / remove / reorder ─────────────────────────────────────────────────

  it('adds, reorders, and removes over WS, broadcasting every version to the room', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    // Member adds two items (policy 'everyone'): v1 then v2 on both sockets.
    const pH1 = nextOfType(host.sock, 'queue.state');
    const pM1 = nextOfType(member.sock, 'queue.state');
    member.sock.send(clientFrame(roomId, 'queue.add', { item: itemInput('Track A') }));
    const [h1, m1] = await Promise.all([pH1, pM1]);
    expect(h1.payload.version).toBe(1);
    expect(h1.payload.items).toHaveLength(1);
    expect(h1.payload.items[0].title).toBe('Track A');
    expect(h1.payload.items[0].addedBy).toBe(member.account.user.id);
    expect(m1.payload).toEqual(h1.payload);

    const pH2 = nextOfType(host.sock, 'queue.state');
    const pM2 = nextOfType(member.sock, 'queue.state');
    member.sock.send(clientFrame(roomId, 'queue.add', { item: itemInput('Track B') }));
    const [h2, m2] = await Promise.all([pH2, pM2]);
    expect(h2.payload.version).toBe(2);
    expect(h2.payload.items.map((it: QueueItem) => it.title)).toEqual(['Track A', 'Track B']);
    expect(m2.payload).toEqual(h2.payload);

    let room = await store.rooms.findById(roomId);
    expect(room!.queue.version).toBe(2);
    expect(room!.queue.items.map((it) => it.title)).toEqual(['Track A', 'Track B']);

    // Reorder to [b, a]: v3, order persisted.
    const [a, b] = h2.payload.items.map((it: QueueItem) => it.id) as [string, string];
    const pH3 = nextOfType(host.sock, 'queue.state');
    member.sock.send(clientFrame(roomId, 'queue.reorder', { orderedIds: [b, a] }));
    const h3 = await pH3;
    expect(h3.payload.version).toBe(3);
    expect(h3.payload.items.map((it: QueueItem) => it.id)).toEqual([b, a]);
    room = await store.rooms.findById(roomId);
    expect(room!.queue.items.map((it) => it.id)).toEqual([b, a]);

    // Member removes their own item: v4, only the other remains.
    const pH4 = nextOfType(host.sock, 'queue.state');
    member.sock.send(clientFrame(roomId, 'queue.remove', { itemId: a }));
    const h4 = await pH4;
    expect(h4.payload.version).toBe(4);
    expect(h4.payload.items.map((it: QueueItem) => it.id)).toEqual([b]);
    room = await store.rooms.findById(roomId);
    expect(room!.queue.version).toBe(4);
    expect(room!.queue.items).toHaveLength(1);
  });

  // ── server-side metadata enrichment ────────────────────────────────────────

  it('stores the client hint at once, then broadcasts the resolved metadata', async () => {
    registerMetadataResolver(deps, {
      resolve: async () => ({
        title: 'Real Song Title',
        artworkUrl: 'https://img.example/cover.jpg',
        durationMs: 205_000,
        providerId: 'direct',
        providerName: 'Direct link',
        authorName: 'Some Artist',
        canonicalId: null,
        canonicalUrl: 'https://example.com/a.mp3',
        source: 'provider',
      }),
    });
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');

    // Both broadcasts are observed from the moment the add is sent.
    const hostFrames = collectOfType(host.sock, 'queue.state', 2);
    const memberFrames = collectOfType(member.sock, 'queue.state', 2);
    host.sock.send(clientFrame(roomId, 'queue.add', { item: itemInput('Pasted link') }));
    const [added, enriched] = await hostFrames;

    // v1: exactly what the client sent — the add is never blocked on a lookup.
    expect(added?.payload.version).toBe(1);
    expect(added?.payload.items[0].title).toBe('Pasted link');
    expect(added?.payload.items[0].artworkUrl).toBeNull();
    expect(added?.payload.items[0].durationMs).toBeNull();

    // v2: the same item, patched with the resolved metadata.
    expect(enriched?.payload.version).toBe(2);
    expect(enriched?.payload.items).toHaveLength(1);
    expect(enriched?.payload.items[0].id).toBe(added?.payload.items[0].id);
    expect(enriched?.payload.items[0].title).toBe('Real Song Title');
    expect(enriched?.payload.items[0].artworkUrl).toBe('https://img.example/cover.jpg');
    expect(enriched?.payload.items[0].durationMs).toBe(205_000);

    // Every client in the room sees the patch, not just the adder.
    const memberSeen = await memberFrames;
    expect(memberSeen[1]?.payload).toEqual(enriched?.payload);

    // …and it is persisted, so late joiners get the enriched snapshot.
    const room = await store.rooms.findById(roomId);
    expect(room!.queue.items[0]!.title).toBe('Real Song Title');
    expect(room!.queue.items[0]!.artworkUrl).toBe('https://img.example/cover.jpg');
    expect(room!.queue.version).toBe(2);
  });

  it('leaves the queue alone when the resolver has nothing to add', async () => {
    registerMetadataResolver(deps, { resolve: async () => null });
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');

    const pState = nextOfType(host.sock, 'queue.state');
    host.sock.send(clientFrame(roomId, 'queue.add', { item: itemInput('Pasted link') }));
    expect((await pState).payload.version).toBe(1);

    // No follow-up broadcast, no version bump.
    expect(await hearsWithin(host.sock, 'queue.state', 300)).toBe('silent');
    expect((await store.rooms.findById(roomId))!.queue.version).toBe(1);
  });

  // ── reorder validation ─────────────────────────────────────────────────────

  it('rejects non-permutation reorders and silently ignores the identical order', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const a = seedItem('Track A', host.account.user.id);
    const b = seedItem('Track B', host.account.user.id);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [a, b], version: 1 } });

    // Bogus id in the set: VALIDATION, version unchanged.
    let pErr = nextOfType(host.sock, 'error');
    host.sock.send(
      clientFrame(roomId, 'queue.reorder', { orderedIds: [a.id, newId() as QueueItemId] }),
    );
    expect((await pErr).payload.code).toBe('VALIDATION');
    expect((await store.rooms.findById(roomId))!.queue.version).toBe(1);

    // Duplicate id: VALIDATION, version unchanged.
    pErr = nextOfType(host.sock, 'error');
    host.sock.send(clientFrame(roomId, 'queue.reorder', { orderedIds: [a.id, a.id] }));
    expect((await pErr).payload.code).toBe('VALIDATION');
    expect((await store.rooms.findById(roomId))!.queue.version).toBe(1);

    // Identical to the current order: silent no-op — no broadcast, no bump.
    const pSilence = hearsWithin(host.sock, 'queue.state', 300);
    host.sock.send(clientFrame(roomId, 'queue.reorder', { orderedIds: [a.id, b.id] }));
    expect(await pSilence).toBe('silent');
    expect((await store.rooms.findById(roomId))!.queue.version).toBe(1);
  });

  // ── queueControl policy matrix ─────────────────────────────────────────────

  it('enforces the queueControl policy, the owner-retract exception, and bans', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');
    const room = await store.rooms.findById(roomId);
    await store.rooms.updateOne(
      { id: roomId },
      { policies: { ...room!.policies, queueControl: 'host' } },
    );
    const mine = seedItem('Mine', member.account.user.id);
    const theirs = seedItem('Theirs', host.account.user.id);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [mine, theirs], version: 1 } });

    // Member queue.add → ROOM_POLICY, store unchanged.
    let pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'queue.add', { item: itemInput('Nope') }));
    expect((await pErr).payload.code).toBe('ROOM_POLICY');
    expect((await store.rooms.findById(roomId))!.queue.version).toBe(1);
    expect((await store.rooms.findById(roomId))!.queue.items).toHaveLength(2);

    // Member queue.reorder → ROOM_POLICY.
    pErr = nextOfType(member.sock, 'error');
    member.sock.send(
      clientFrame(roomId, 'queue.reorder', { orderedIds: [theirs.id, mine.id] }),
    );
    expect((await pErr).payload.code).toBe('ROOM_POLICY');

    // Member removing an item they did NOT add → ROOM_POLICY.
    pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'queue.remove', { itemId: theirs.id }));
    expect((await pErr).payload.code).toBe('ROOM_POLICY');
    expect((await store.rooms.findById(roomId))!.queue.items).toHaveLength(2);

    // Owner-retract: removing their OWN item succeeds despite the policy.
    const pState = nextOfType(host.sock, 'queue.state');
    member.sock.send(clientFrame(roomId, 'queue.remove', { itemId: mine.id }));
    const state = await pState;
    expect(state.payload.version).toBe(2);
    expect(state.payload.items.map((it: QueueItem) => it.id)).toEqual([theirs.id]);

    // The host passes the gate.
    const pHostState = nextOfType(host.sock, 'queue.state');
    host.sock.send(clientFrame(roomId, 'queue.add', { item: itemInput('Host Track') }));
    expect((await pHostState).payload.version).toBe(3);

    // A banned member is FORBIDDEN even on the ungated voteSkip.
    await store.members.updateOne(
      { id: memberDocId(roomId, member.account.user.id) },
      { banned: true },
    );
    pErr = nextOfType(member.sock, 'error');
    member.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: theirs.id }));
    expect((await pErr).payload.code).toBe('FORBIDDEN');
  });

  // ── voteSkip threshold ─────────────────────────────────────────────────────

  it('skips the current item exactly at the vote threshold', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const m1 = await join('m1@example.com', roomId, 'member');
    const m2 = await join('m2@example.com', roomId, 'member');
    await join('m3@example.com', roomId, 'member');
    // 4 active sockets, skipVoteThreshold 0.5 → required 2.
    const item = seedItem('Current', host.account.user.id);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [item], version: 1 } });

    // First vote: recorded on the item, item stays.
    const pV1 = nextOfType(host.sock, 'queue.state');
    m1.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const v1 = await pV1;
    expect(v1.payload.version).toBe(2);
    expect(v1.payload.items).toHaveLength(1);
    expect(v1.payload.items[0].votesToSkip).toEqual([m1.account.user.id]);

    // Second vote (different member): 2 of 4 = exactly the threshold → removed.
    const pV2 = nextOfType(host.sock, 'queue.state');
    m2.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const v2 = await pV2;
    expect(v2.payload.version).toBe(3);
    expect(v2.payload.items).toHaveLength(0);
    expect((await store.rooms.findById(roomId))!.queue.items).toHaveLength(0);
  });

  it('prunes votes from members who left before the deciding vote', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const a = await join('a@example.com', roomId, 'member');
    const b = await join('b@example.com', roomId, 'member');
    const c = await join('c@example.com', roomId, 'member');
    // 4 active → required 2.
    const item = seedItem('Current', host.account.user.id);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [item], version: 1 } });

    // A votes: recorded, item stays.
    const pV1 = nextOfType(host.sock, 'queue.state');
    a.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    expect((await pV1).payload.items[0].votesToSkip).toEqual([a.account.user.id]);

    // A leaves. LEAVING IS A PRESENCE DEPARTURE, not a closed socket: a
    // socket that drops is a member reconnecting until the grace says
    // otherwise, and the quorum must not shrink under everyone mid-refresh.
    // `presence.update { state: 'offline' }` is the explicit leave every
    // client sends on its way out.
    const pGone = nextOfType(host.sock, 'presence.diff');
    a.sock.send(clientFrame(roomId, 'presence.update', { state: 'offline' }));
    expect((await pGone).payload.removed).toContain(a.account.user.id);
    a.sock.close();
    expect(presentIds(roomId)).not.toContain(a.account.user.id);

    // B votes: A's stale vote is pruned — 3 present → required 2, only B counts.
    const pV2 = nextOfType(host.sock, 'queue.state');
    b.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const v2 = await pV2;
    expect(v2.payload.items).toHaveLength(1);
    expect(v2.payload.items[0].votesToSkip).toEqual([b.account.user.id]);

    // C votes: B + C = 2 ≥ 2 → item removed.
    const pV3 = nextOfType(host.sock, 'queue.state');
    c.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    expect((await pV3).payload.items).toHaveLength(0);
  });

  it('threshold 0 disables auto-skip but still records votes', async () => {
    const { roomId } = await seedRoom(store);
    const host = await join('host@example.com', roomId, 'host');
    const member = await join('member@example.com', roomId, 'member');
    const room = await store.rooms.findById(roomId);
    await store.rooms.updateOne(
      { id: roomId },
      { policies: { ...room!.policies, skipVoteThreshold: 0 } },
    );
    const item = seedItem('Current', host.account.user.id);
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [item], version: 1 } });

    // Both active members vote; both emits arrive and the item stays.
    const pV1 = nextOfType(host.sock, 'queue.state');
    host.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const v1 = await pV1;
    expect(v1.payload.items[0].votesToSkip).toEqual([host.account.user.id]);

    const pV2 = nextOfType(host.sock, 'queue.state');
    member.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: item.id }));
    const v2 = await pV2;
    expect(v2.payload.items).toHaveLength(1);
    expect(v2.payload.items[0].votesToSkip).toEqual([
      host.account.user.id,
      member.account.user.id,
    ]);
    expect((await store.rooms.findById(roomId))!.queue.items).toHaveLength(1);
  });

  // ── playlists REST ─────────────────────────────────────────────────────────

  it('creates, lists, gets, patches, and deletes playlists over HTTP', async () => {
    const account = await signupUser(app, 'owner@example.com');
    const headers = { authorization: `Bearer ${account.accessToken}` };

    // Create: full shape.
    const created = await app.inject({
      method: 'POST',
      url: '/playlists',
      headers,
      payload: { title: 'My Mix' },
    });
    expect(created.statusCode).toBe(200);
    const playlist = (created.json() as { playlist: any }).playlist; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(playlist.id).toEqual(expect.any(String));
    expect(playlist.ownerId).toBe(account.user.id);
    expect(playlist.roomId).toBeNull();
    expect(playlist.title).toBe('My Mix');
    expect(playlist.items).toEqual([]);

    // List: only the caller's playlists.
    const listed = await app.inject({ method: 'GET', url: '/playlists', headers });
    expect(listed.statusCode).toBe(200);
    const { playlists } = listed.json() as { playlists: Array<{ id: string }> };
    expect(playlists.map((p) => p.id)).toEqual([playlist.id]);

    // Get.
    const got = await app.inject({
      method: 'GET',
      url: `/playlists/${playlist.id}`,
      headers,
    });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { playlist: { title: string } }).playlist.title).toBe('My Mix');

    // Patch title + items.
    const item = seedItem('Track A', account.user.id);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/playlists/${playlist.id}`,
      headers,
      payload: { title: 'Renamed', items: [item] },
    });
    expect(patched.statusCode).toBe(200);
    const updated = (patched.json() as { playlist: any }).playlist; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(updated.title).toBe('Renamed');
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].id).toBe(item.id);

    // Non-owner GET → 403; unauthenticated GET → 401.
    const stranger = await signupUser(app, 'stranger@example.com');
    const forbidden = await app.inject({
      method: 'GET',
      url: `/playlists/${playlist.id}`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect((forbidden.json() as { code: string }).code).toBe('FORBIDDEN');

    const anon = await app.inject({ method: 'GET', url: `/playlists/${playlist.id}` });
    expect(anon.statusCode).toBe(401);
    expect((anon.json() as { code: string }).code).toBe('UNAUTHORIZED');

    // Delete → { ok: true }; then GET → 404.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/playlists/${playlist.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    const gone = await app.inject({
      method: 'GET',
      url: `/playlists/${playlist.id}`,
      headers,
    });
    expect(gone.statusCode).toBe(404);
    expect((gone.json() as { code: string }).code).toBe('NOT_FOUND');
  });

  it('adds playlist copies to the room queue and broadcasts one bump', async () => {
    const { roomId } = await seedRoom(store);
    const caller = await join('caller@example.com', roomId, 'member');
    const headers = { authorization: `Bearer ${caller.account.accessToken}` };

    // Playlist with 2 items.
    const created = await app.inject({
      method: 'POST',
      url: '/playlists',
      headers,
      payload: { title: 'Mix', roomId },
    });
    const playlistId = (created.json() as { playlist: { id: string } }).playlist.id;
    const items = [
      seedItem('Track A', caller.account.user.id),
      seedItem('Track B', caller.account.user.id),
    ];
    await app.inject({
      method: 'PATCH',
      url: `/playlists/${playlistId}`,
      headers,
      payload: { items },
    });

    // add-to-queue: copies with fresh ids, one version bump, one broadcast.
    const pState = nextOfType(caller.sock, 'queue.state');
    const added = await app.inject({
      method: 'POST',
      url: '/playlists/add-to-queue',
      headers,
      payload: { playlistId, roomId },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toEqual({ added: 2 });

    const state = await pState;
    expect(state.payload.version).toBe(1);
    expect(state.payload.items).toHaveLength(2);
    const playlistIds = items.map((it) => it.id);
    for (const [i, copy] of (state.payload.items as QueueItem[]).entries()) {
      expect(playlistIds).not.toContain(copy.id);
      expect(copy.addedBy).toBe(caller.account.user.id);
      expect(copy.votesToSkip).toEqual([]);
      expect(copy.title).toBe(items[i]!.title);
      expect(copy.mediaRef).toEqual(items[i]!.mediaRef);
    }
    const room = await store.rooms.findById(roomId);
    expect(room!.queue.version).toBe(1);
    expect(room!.queue.items).toHaveLength(2);

    // Empty playlist: { added: 0 }, no version bump.
    const emptyCreated = await app.inject({
      method: 'POST',
      url: '/playlists',
      headers,
      payload: { title: 'Empty' },
    });
    const emptyId = (emptyCreated.json() as { playlist: { id: string } }).playlist.id;
    const pSilence = hearsWithin(caller.sock, 'queue.state', 300);
    const emptyAdded = await app.inject({
      method: 'POST',
      url: '/playlists/add-to-queue',
      headers,
      payload: { playlistId: emptyId, roomId },
    });
    expect(emptyAdded.json()).toEqual({ added: 0 });
    expect(await pSilence).toBe('silent');
    expect((await store.rooms.findById(roomId))!.queue.version).toBe(1);

    // queueControl 'host': a member caller is rejected with ROOM_POLICY.
    const roomNow = await store.rooms.findById(roomId);
    await store.rooms.updateOne(
      { id: roomId },
      { policies: { ...roomNow!.policies, queueControl: 'host' } },
    );
    const policyBlocked = await app.inject({
      method: 'POST',
      url: '/playlists/add-to-queue',
      headers,
      payload: { playlistId, roomId },
    });
    expect(policyBlocked.statusCode).toBe(403);
    expect((policyBlocked.json() as { code: string }).code).toBe('ROOM_POLICY');

    // A non-owner caller (even the host) gets FORBIDDEN 'not your playlist'.
    const host = await join('host2@example.com', roomId, 'host');
    const notYours = await app.inject({
      method: 'POST',
      url: '/playlists/add-to-queue',
      headers: { authorization: `Bearer ${host.account.accessToken}` },
      payload: { playlistId, roomId },
    });
    expect(notYours.statusCode).toBe(403);
    expect((notYours.json() as { code: string; message: string }).message).toBe(
      'not your playlist',
    );
  });
});
