/**
 * AUTO-ADVANCE IS A COMPARE-AND-SET, NOT A SEAT.
 *
 * The master seat tried to infer WHO should advance the room from presence
 * plus role, and got it wrong in ordinary topologies — a host watching on a
 * phone, a host who transferred the role, a room where nobody present holds
 * the policy. Every such room stopped dead on a finished track, and each patch
 * to the inference produced a new way to stop dead.
 *
 * `sync.advance` asks a different question. It never says "let me drive"; it
 * says "the item I was playing has ENDED, move on from it", and it names that
 * item BY ID. The server takes it from any non-banned member — no policy gate,
 * no seat, no presence lookup — and applies it only while the room is still on
 * that exact item, as a compare-and-set against the playback snapshot. So:
 *
 *   • no election and no single point of failure: whoever is watching reports;
 *   • N clients firing at once is harmless — the first lands, the rest are
 *     SILENT no-ops rather than errors. A late duplicate is the expected case,
 *     not a fault, and must never spam every other tab with an error frame;
 *   • it cannot become a control bypass, because the only destination it can
 *     ever reach is the successor of the item that just ended.
 *
 * That last claim is the one worth executing rather than asserting in prose,
 * so "cannot jump the room anywhere" below names every other item in the queue
 * and shows each one inert.
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

/**
 * Far enough into an item that the room's own clock agrees it could have
 * ENDED. Every test here is about what happens AFTER an ending, so this is
 * their starting state; the plausibility check that makes it necessary — and
 * what a member can do without it — is sync-advance-guard.test.ts.
 */
const ENDED_POSITION_MS = ADVANCE_UNKNOWN_DURATION_FLOOR_MS + 1000;

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

/** Everything the socket receives from now on — the only way to assert that
 *  something did NOT arrive. */
function collect(sock: WebSocket): Frame[] {
  const frames: Frame[] = [];
  sock.on('message', (data: RawData) => {
    frames.push(JSON.parse(data.toString()) as Frame);
  });
  return frames;
}

const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── tests ────────────────────────────────────────────────────────────────────

describe('sync.advance: the queue moves on without a seat', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let port: number;
  let sockets: WebSocket[];
  let roomId: RoomId;
  let ownerId: UserId;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    sockets = [];
    // seedRoom's playbackControl is 'host' — the policy that used to freeze
    // the room is exactly the one these tests run under.
    ({ roomId, ownerId } = await seedRoom(store));
  });

  afterEach(async () => {
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    }
    await app.close();
  });

  function clientFrame(type: string, payload: unknown): string {
    return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
  }

  interface Joined {
    account: SignedUpUser;
    sock: WebSocket;
  }

  async function join(email: string, role: 'host' | 'moderator' | 'member'): Promise<Joined> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await openSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`);
    sockets.push(sock);
    return { account, sock };
  }

  /** A member with no socket — the service-level tests drive these directly. */
  async function member(email: string): Promise<UserId> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, 'member');
    return account.user.id;
  }

  /** Seed `count` queue rows straight through the store. */
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

  /** Put the room on a queue row, playing and a good way into it — the state a
   *  track ENDS from. */
  async function playAt(index: number, positionMs = ENDED_POSITION_MS): Promise<void> {
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

  const playbackOf = async (): Promise<PlaybackState> =>
    (await store.rooms.findById(roomId))!.playback!;

  // ── the point of the whole mechanism ───────────────────────────────────────

  it('lets a member with NO playback control advance off the item that ended', async () => {
    const items = await seedQueue(3);
    await playAt(0);
    const guest = await join('member@example.com', 'member');

    // Baseline, same room and same socket: this member genuinely cannot drive.
    const pErr = nextOfType(guest.sock, 'error');
    guest.sock.send(clientFrame('sync.setTrack', { kind: 'queue', queueIndex: 1 }));
    expect((await pErr).payload.code).toBe('ROOM_POLICY');

    // And yet the room still moves on when their item ends. That is the
    // difference between "seizing control" and "the queue doing its job".
    const pState = nextOfType(guest.sock, 'sync.state');
    guest.sock.send(clientFrame('sync.advance', { endedItemId: items[0]!.id }));
    const state = await pState;
    expect(state.payload.queueIndex).toBe(1);
    expect(state.payload.mediaRef).toEqual(items[1]!.mediaRef);
    expect(state.payload.positionMs).toBe(0);
    expect(state.payload.playing).toBe(true);

    const playback = await playbackOf();
    expect(playback.queueIndex).toBe(1);
    expect(playback.mediaRef).toEqual(items[1]!.mediaRef);
  });

  // ── the race the seat existed to prevent ───────────────────────────────────

  it('two simultaneous advances make ONE move, and neither is an error', async () => {
    const items = await seedQueue(3);
    await playAt(0);
    const sync = new SyncService(deps);
    const [a, b] = [await member('a@example.com'), await member('b@example.com')];

    // Started together on purpose: both read the same playback snapshot before
    // either writes, which is precisely the interleaving a naive read-then-
    // write loses. Neither call rejects — a lost race is not a fault.
    await Promise.all([
      sync.advance(roomId, a, items[0]!.id),
      sync.advance(roomId, b, items[0]!.id),
    ]);

    expect((await playbackOf()).queueIndex).toBe(1);
    const moves = (await store.events.findMany({ roomId })).filter((e) => e.type === 'sync.state');
    expect(moves).toHaveLength(1);
    // One move, one history row — the loser leaves no trace anywhere.
    expect(await store.usage.findMany({ kind: 'playback.history' })).toHaveLength(1);
  });

  it('is a SILENT no-op when the room has already left the named item', async () => {
    const items = await seedQueue(3);
    await playAt(1); // the room is already past item 0
    const guest = await join('member@example.com', 'member');
    const frames = collect(guest.sock);

    guest.sock.send(clientFrame('sync.advance', { endedItemId: items[0]!.id }));
    await settle();

    // NOT an error: a duplicate arriving late is the expected case, and an
    // error frame per straggler is how every client's console fills up.
    expect(frames.filter((f) => f.type === 'error')).toEqual([]);
    expect(frames.filter((f) => f.type === 'sync.state')).toEqual([]);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  // ── the bypass proof ───────────────────────────────────────────────────────

  it('cannot jump the room anywhere: every non-current item is inert', async () => {
    const items = await seedQueue(5);
    await playAt(0);
    const sync = new SyncService(deps);
    const attacker = await member('attacker@example.com');
    const before = await playbackOf();

    // Naming ANY other row — the one after next, the last one, the one just
    // played — moves nothing and mints no snapshot.
    for (const item of items.slice(1)) {
      await sync.advance(roomId, attacker, item.id);
    }
    // An id that is not in the queue at all is inert too.
    await sync.advance(roomId, attacker, 'item-does-not-exist' as QueueItemId);
    expect(await playbackOf()).toEqual(before);

    // The reachable destination set is exactly {successor of the current
    // item}, and it is reached one step at a time.
    await sync.advance(roomId, attacker, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
    await sync.advance(roomId, attacker, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  it('refuses a banned member outright', async () => {
    const items = await seedQueue(2);
    await playAt(0);
    const sync = new SyncService(deps);
    const banned = await member('banned@example.com');
    await store.members.updateOne({ userId: banned, roomId }, { banned: true });

    await expect(sync.advance(roomId, banned, items[0]!.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await playbackOf()).queueIndex).toBe(0);
  });

  // ── the end of the queue ───────────────────────────────────────────────────

  it('stops at the last item instead of wrapping to the top', async () => {
    const items = await seedQueue(2);
    await playAt(1); // the LAST row
    const sync = new SyncService(deps);
    const watcher = await member('watcher@example.com');

    await sync.advance(roomId, watcher, items[1]!.id);
    const stopped = await playbackOf();
    expect(stopped.queueIndex).toBe(1); // did not wrap to 0
    expect(stopped.mediaRef).toEqual(items[1]!.mediaRef);
    expect(stopped.playing).toBe(false);

    // And a straggler naming the same finished item changes nothing further —
    // the stop is idempotent, so N clients ending together stop the room once.
    await sync.advance(roomId, watcher, items[1]!.id);
    expect(await playbackOf()).toEqual(stopped);
  });
});
