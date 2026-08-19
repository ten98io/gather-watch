/**
 * THE DURATION IS IN EVERY VIEWER'S PLAYER AND NOWHERE ELSE.
 *
 * `QueueItem.durationMs` is null for nearly every row the product carries. The
 * server-side resolver can only read a runtime out of an oEmbed payload, and
 * of the six keyless endpoints only Vimeo's response has the field — YouTube's
 * does not, SoundCloud's does not, the Open Graph fallback has none, and a DRM
 * title page or a `{ kind: 'page' }` link never had one to give. No amount of
 * resolving on insert closes that gap: the fact is not on a wire the server is
 * allowed to read. It IS one `HTMLMediaElement.duration` away in every client.
 *
 * WHAT KNOWING IT BUYS is the last test in this file, and it is the reason the
 * event exists. Without a duration, `endingIsPlausible` cannot verify an
 * ending at all — it PRICES one at twenty seconds, so a member the policy does
 * not admit can advance off a ten-minute film after twenty seconds of it, at
 * any point in the film. With one reported, the same claim costs the item's
 * real remaining runtime.
 *
 * WHY IT IS SAFE TO TAKE FROM ANYONE, and what these therefore pin: it is a
 * FILL, never an edit. The write lands only while the row's duration is still
 * unknown, so the first honest report wins and every later one — a liar's
 * included — writes nothing. It cannot move the room, cannot name a row that
 * is not there, and the value passes the same `sanitizeDurationMs` ceiling a
 * queue insert already passes. The worst a lie achieves is one wrong number on
 * one row of one room, discarded at the next track change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { PlaybackState, QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { ADVANCE_UNKNOWN_DURATION_FLOOR_MS, SyncService } from '../src/modules/sync/service';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

/** A ten-minute film — long enough that "twenty seconds in" and "at the end"
 *  cannot be confused under any tolerance. */
const FILM_MS = 10 * 60 * 1000;

/** The whole price of a duration-UNKNOWN row: past the floor and the server
 *  has nothing left to ask. */
const PAST_THE_FLOOR_MS = ADVANCE_UNKNOWN_DURATION_FLOOR_MS + 1000;

/** `DURATION_MAX_MS` in src/modules/metadata/resolver.ts — anything longer is
 *  a client typo or a hostile value, not a track. Inclusive: 24h exactly is a
 *  duration, 24h + 1ms is not. */
const DURATION_CEILING_MS = 24 * 60 * 60 * 1000;

// ── socket helpers ───────────────────────────────────────────────────────────

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

/** Resolves 'event' when a frame of the type arrives within the window,
 *  'silent' otherwise — for asserting that NO broadcast happens. */
async function hearsWithin(sock: WebSocket, type: string, timeoutMs: number): Promise<string> {
  return nextOfType(sock, type, timeoutMs).then(
    () => 'event',
    () => 'silent',
  );
}

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('sync.duration: a viewer answers what the resolver could not', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let port: number;
  let sockets: WebSocket[];
  let roomId: RoomId;
  let ownerId: UserId;
  let sync: SyncService;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    sockets = [];
    // seedRoom's playbackControl is 'host': the members below are exactly the
    // people the advance guard applies to.
    ({ roomId, ownerId } = await seedRoom(store));
    sync = new SyncService(deps);
  });

  afterEach(async () => {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    await app.close();
  });

  interface Joined {
    account: SignedUpUser;
    sock: WebSocket;
  }

  async function join(email: string, role: 'host' | 'moderator' | 'member'): Promise<Joined> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await openSocket(
      `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    return { account, sock };
  }

  /** A member with no socket — the service-level probes drive these directly. */
  async function member(email: string): Promise<UserId> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, 'member');
    return account.user.id;
  }

  /** `count` queue rows with the duration nobody could resolve. */
  async function seedQueue(count: number): Promise<QueueItem[]> {
    const items: QueueItem[] = Array.from({ length: count }, (_, n) => ({
      id: `item-${n}` as QueueItemId,
      mediaRef: { kind: 'page' as const, url: `https://example.com/watch/${n}` },
      title: `item ${n}`,
      durationMs: null,
      artworkUrl: null,
      addedBy: ownerId,
      votesToSkip: [],
    }));
    await store.rooms.updateOne({ id: roomId }, { queue: { items, version: 1 } });
    return items;
  }

  /** Put the room on a queue row, playing, `positionMs` into it. */
  async function playAt(index: number, positionMs: number): Promise<void> {
    const room = await store.rooms.findById(roomId);
    const playback: PlaybackState = {
      mediaRef: room!.queue.items[index]!.mediaRef,
      positionMs,
      rate: 1,
      playing: true,
      serverTs: Date.now(),
      seq: await store.nextSeq(`playback:${roomId}`),
      queueIndex: index,
    };
    await store.rooms.updateOne({ id: roomId }, { playback });
  }

  /** Move the room's own clock without touching anything the fill or the
   *  guard reads — same item, same index, further in. */
  async function runOnTo(positionMs: number): Promise<void> {
    const playback = (await store.rooms.findById(roomId))!.playback!;
    await store.rooms.updateOne(
      { id: roomId },
      { playback: { ...playback, positionMs, serverTs: Date.now() } },
    );
  }

  const queueOf = async (): Promise<{ items: QueueItem[]; version: number }> =>
    (await store.rooms.findById(roomId))!.queue;

  const playbackOf = async (): Promise<PlaybackState> =>
    (await store.rooms.findById(roomId))!.playback!;

  const emittedOfType = async (type: string): Promise<unknown[]> =>
    (await store.events.findMany({ roomId })).filter((e) => e.type === type);

  // ── the fill ───────────────────────────────────────────────────────────────

  it('fills a row that had no duration, bumps the version, and broadcasts it', async () => {
    const items = await seedQueue(2);
    const host = await join('host@example.com', 'host');
    const viewer = await join('viewer@example.com', 'member');

    // A plain member's player is the source: no seat, no policy, no gate.
    const pQueue = nextOfType(host.sock, 'queue.state');
    viewer.sock.send(
      clientFrame(roomId, 'sync.duration', { itemId: items[0]!.id, durationMs: FILM_MS }),
    );
    const frame = await pQueue;

    // It is a queue mutation because that is what it is — the row changed —
    // so it carries the whole queue and a bumped version, and late joiners and
    // replaying clients converge on it like any other queue edit.
    expect(frame.payload.version).toBe(2);
    expect(frame.payload.items[0].durationMs).toBe(FILM_MS);
    expect(frame.payload.items[1].durationMs).toBeNull();

    const queue = await queueOf();
    expect(queue.version).toBe(2);
    expect(queue.items[0]!.durationMs).toBe(FILM_MS);
    // Nothing about the room's playback is a duration report's business.
    expect((await store.rooms.findById(roomId))!.playback).toBeNull();
  });

  it('is a FILL, never an edit: the second report does not overwrite the first', async () => {
    const items = await seedQueue(1);
    const host = await join('host@example.com', 'host');
    const honest = await join('honest@example.com', 'member');
    const liar = await join('liar@example.com', 'member');

    const pFirst = nextOfType(host.sock, 'queue.state');
    honest.sock.send(
      clientFrame(roomId, 'sync.duration', { itemId: items[0]!.id, durationMs: FILM_MS }),
    );
    expect((await pFirst).payload.items[0].durationMs).toBe(FILM_MS);

    // A different number for the same row, from a different member. Accepting
    // it would move a duration somebody's player is already synchronised
    // against — and would hand any member a lever on the advance guard.
    const heard = hearsWithin(host.sock, 'queue.state', 400);
    liar.sock.send(
      clientFrame(roomId, 'sync.duration', { itemId: items[0]!.id, durationMs: 5000 }),
    );
    expect(await heard).toBe('silent');

    const queue = await queueOf();
    expect(queue.items[0]!.durationMs).toBe(FILM_MS);
    // No bump either: a no-op write must not churn every client's queue.
    expect(queue.version).toBe(2);
  });

  it('is a silent no-op for an item that is not in the queue', async () => {
    await seedQueue(1);
    const viewer = await member('viewer@example.com');

    // The row was skipped, removed, or never existed. There is nothing to
    // learn and nothing to say — and nothing to throw about either, because
    // an item leaving the queue while a player was loading it is ordinary.
    await sync.reportDuration(roomId, viewer, 'item-nowhere' as QueueItemId, FILM_MS);

    expect((await queueOf()).version).toBe(1);
    expect(await emittedOfType('queue.state')).toEqual([]);
  });

  // ── the value is not trusted ───────────────────────────────────────────────

  it('rejects a value that is not a duration, without touching the row', async () => {
    const items = await seedQueue(1);
    const viewer = await member('viewer@example.com');

    // The contract's `positive().finite()` stops most of these at the socket,
    // but the ceiling is the SERVER's and a caller inside the process is not
    // bound by zod at all — so the sanitizer, not the schema, is what has to
    // hold. A live stream is the real source of the non-finite case.
    const rubbish = [
      0,
      -1,
      -FILM_MS,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      DURATION_CEILING_MS + 1,
    ];
    for (const value of rubbish) {
      await sync.reportDuration(roomId, viewer, items[0]!.id, value);
    }

    expect((await queueOf()).items[0]!.durationMs).toBeNull();
    expect((await queueOf()).version).toBe(1);
    expect(await emittedOfType('queue.state')).toEqual([]);

    // And the row was reachable the whole time: the refusals were about the
    // values, not about a row nothing could write to. 24h exactly is the
    // ceiling, not one past it.
    await sync.reportDuration(roomId, viewer, items[0]!.id, DURATION_CEILING_MS);
    expect((await queueOf()).items[0]!.durationMs).toBe(DURATION_CEILING_MS);
    expect((await queueOf()).version).toBe(2);
  });

  it('still refuses a banned member', async () => {
    const items = await seedQueue(1);
    const banned = await member('banned@example.com');
    await store.members.updateOne({ userId: banned, roomId }, { banned: true });

    await expect(
      sync.reportDuration(roomId, banned, items[0]!.id, FILM_MS),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await queueOf()).items[0]!.durationMs).toBeNull();
  });

  // ── THE PAYOFF ─────────────────────────────────────────────────────────────

  it('BEFORE: with no duration, twenty seconds buys the whole ten-minute film', async () => {
    // Not a bug — a stated limit. With no end to aim at, `endingIsPlausible`
    // cannot verify anything, so it prices the claim instead, and the price is
    // the same twenty seconds whether the item runs three minutes or three
    // hours. This is the baseline the report is here to replace.
    const items = await seedQueue(3);
    await playAt(0, PAST_THE_FLOOR_MS);
    const guest = await member('guest@example.com');

    await sync.advance(roomId, guest, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  it('AFTER: the reported duration makes the guard verify the ending', async () => {
    const items = await seedQueue(3);
    await playAt(0, PAST_THE_FLOOR_MS);
    const guest = await member('guest@example.com');

    // The same member whose player supplied the number is the one it now
    // constrains — which is the point: reporting an honest duration is not a
    // concession, it is what turns "twenty seconds" into "the item's own
    // remaining runtime".
    await sync.reportDuration(roomId, guest, items[0]!.id, FILM_MS);
    expect((await queueOf()).items[0]!.durationMs).toBe(FILM_MS);

    // Twenty-one seconds into ten minutes: refused, and SILENTLY — the room
    // does not move and nothing is minted.
    await sync.advance(roomId, guest, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(0);
    expect(await emittedOfType('sync.state')).toEqual([]);

    // At the real end of the real duration, the same call from the same
    // member is taken. A genuine ending must never fail closed.
    await runOnTo(FILM_MS - 1000);
    await sync.advance(roomId, guest, items[0]!.id);

    const playback = await playbackOf();
    expect(playback.queueIndex).toBe(1);
    expect(playback.mediaRef).toEqual(items[1]!.mediaRef);
    expect(playback.playing).toBe(true);
  });
});
