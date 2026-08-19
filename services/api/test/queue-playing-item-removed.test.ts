/**
 * A VOTE-SKIP HAS TO ACTUALLY SKIP — AND THE ROOM HAS TO SURVIVE IT.
 *
 * Carrying the PLAYING row off the queue (a vote-skip that crossed the
 * threshold, or somebody removing the current track by hand) used to leave
 * `playback.mediaRef` and `playback.playing` exactly as they were and only
 * detach `queueIndex` to null. Two things followed, and the second is the
 * expensive one:
 *
 *   • the skipped track kept playing on every client, which is the whole of
 *     what a vote-skip was asked to prevent;
 *   • the room was WEDGED for the rest of its life. `SyncService.advance`
 *     early-returns on a null `queueIndex`, and every client's ending resolver
 *     deliberately returns null for an item that has left the queue (naming
 *     the row that shifted down into the gap would skip a SECOND item off one
 *     vote). Each half was individually correct and documented, and each
 *     pointed at the other.
 *
 * So the move belongs to the queue, which is the only party that can name the
 * successor honestly — the row now SITTING AT the removed index, resolved from
 * the post-mutation array. These pin that move, the snapshot that carries it
 * (an ADVANCED playback seq; clients drop one whose seq did not move), the
 * empty-tail case that must PAUSE rather than leave a playhead running on a
 * track nobody is watching, and — the regression this fix could most easily
 * have introduced — that removing a row which was NOT playing still does
 * nothing but bookkeeping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { PlaybackState, QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { QueueService } from '../src/modules/queue/service';
import { ADVANCE_UNKNOWN_DURATION_FLOOR_MS, SyncService } from '../src/modules/sync/service';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';
import type { SignedUpUser } from './helpers';

/** Far enough into a duration-unknown item that the room's own clock agrees it
 *  could have ENDED — see sync-advance-guard.test.ts for why that price is
 *  what an unresolved row costs. */
const ENDED_POSITION_MS = ADVANCE_UNKNOWN_DURATION_FLOOR_MS + 1000;

/** A position deep enough into a track that "carried forward" and "reset to
 *  zero" cannot be confused for one another. */
const MID_TRACK_MS = 30_000;

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

function clientFrame(roomId: string, type: string, payload: unknown): string {
  return JSON.stringify({ type, roomId, seq: 0, ts: Date.now(), payload });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('the queue leaves an item it removed out from under playback', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let port: number;
  let sockets: WebSocket[];
  let roomId: RoomId;
  let ownerId: UserId;
  let queue: QueueService;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    sockets = [];
    // seedRoom: queueControl 'everyone', playbackControl 'host',
    // skipVoteThreshold 0.5.
    ({ roomId, ownerId } = await seedRoom(store));
    queue = new QueueService(deps);
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

  /** Sign up, add to the room, and open the room socket — voteSkip counts
   *  presence-alive members, so these tests need real sockets. */
  async function join(email: string, role: 'host' | 'moderator' | 'member'): Promise<Joined> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    const sock = await openSocket(
      `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    // Beat presence and drain the snapshot reply: the vote-skip quorum counts
    // presence entries (room-wide, mirrored across instances), not this
    // process's sockets, and every real client beats on connect.
    const snapshot = nextOfType(sock, 'queue.state');
    sock.send(clientFrame(roomId, 'presence.update', { state: 'watching', wantSnapshot: true }));
    await snapshot;
    return { account, sock };
  }

  /** A member with no socket — the service-level probes drive these directly. */
  async function member(email: string): Promise<UserId> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, 'member');
    return account.user.id;
  }

  /** Seed `count` queue rows straight through the store. Durations stay null:
   *  that is what nearly every real row carries. */
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
  async function playAt(index: number, positionMs = MID_TRACK_MS): Promise<PlaybackState> {
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
    return playback;
  }

  const playbackOf = async (): Promise<PlaybackState> =>
    (await store.rooms.findById(roomId))!.playback!;

  const queueOf = async (): Promise<{ items: QueueItem[]; version: number }> =>
    (await store.rooms.findById(roomId))!.queue;

  // ── the move itself ────────────────────────────────────────────────────────

  it('moves the room to the SUCCESSOR when the playing row is removed', async () => {
    const items = await seedQueue(3);
    const before = await playAt(1);

    await queue.remove(roomId, ownerId, items[1]!.id);

    // The successor is the row that now sits at the removed index — item 2,
    // which shifted down into the gap. Not "index + 1" against the old array,
    // which would skip item 2 outright.
    const after = await playbackOf();
    expect(after.mediaRef).toEqual(items[2]!.mediaRef);
    expect(after.queueIndex).toBe(1);
    // A new track starts at its beginning; carrying the skipped item's
    // playhead over would drop every viewer 30s into something that just
    // started.
    expect(after.positionMs).toBe(0);
    expect(after.playing).toBe(true);
    // applyServerState keeps `prev` unless `next.seq > prev.seq`, so a
    // snapshot minted at the old seq reaches nobody.
    expect(after.seq).toBeGreaterThan(before.seq);
    expect((await queueOf()).items.map((it) => it.id)).toEqual([items[0]!.id, items[2]!.id]);
  });

  it('tells the room about the move: queue.state and sync.state both broadcast', async () => {
    const items = await seedQueue(3);
    await playAt(1);
    const watcher = await join('watcher@example.com', 'member');

    const pQueue = nextOfType(watcher.sock, 'queue.state');
    const pState = nextOfType(watcher.sock, 'sync.state');
    await queue.remove(roomId, ownerId, items[1]!.id);
    const [queueFrame, stateFrame] = await Promise.all([pQueue, pState]);

    expect(queueFrame.payload.items.map((it: QueueItem) => it.id)).toEqual([
      items[0]!.id,
      items[2]!.id,
    ]);
    expect(stateFrame.payload.mediaRef).toEqual(items[2]!.mediaRef);
    expect(stateFrame.payload.queueIndex).toBe(1);
    expect(stateFrame.payload.positionMs).toBe(0);
    expect(stateFrame.payload.playing).toBe(true);
  });

  it('a vote-skip that crosses the threshold moves the room, end to end', async () => {
    const items = await seedQueue(3);
    const before = await playAt(0);
    // Three live sockets, skipVoteThreshold 0.5 → required 2.
    const host = await join('host@example.com', 'host');
    const a = await join('a@example.com', 'member');
    const b = await join('b@example.com', 'member');

    // First vote: recorded, nothing skipped, so playback must not move.
    const pRecorded = nextOfType(host.sock, 'queue.state');
    a.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: items[0]!.id }));
    expect((await pRecorded).payload.items).toHaveLength(3);
    expect(await playbackOf()).toEqual(before);

    // Deciding vote: the row the room is PLAYING leaves the queue, and the
    // room has to leave it too — this is the case that used to keep playing
    // the skipped track on every client.
    const pState = nextOfType(host.sock, 'sync.state');
    b.sock.send(clientFrame(roomId, 'queue.voteSkip', { itemId: items[0]!.id }));
    const state = await pState;

    expect(state.payload.mediaRef).toEqual(items[1]!.mediaRef);
    expect(state.payload.queueIndex).toBe(0);
    expect(state.payload.positionMs).toBe(0);
    expect(state.payload.playing).toBe(true);
    expect(state.payload.seq).toBeGreaterThan(before.seq);
    expect((await queueOf()).items.map((it) => it.id)).toEqual([items[1]!.id, items[2]!.id]);
  });

  it('records the successor in the room history, like any other track change', async () => {
    const items = await seedQueue(2);
    await playAt(0);

    await queue.remove(roomId, ownerId, items[0]!.id);

    const history = await store.playbackHistory.findMany({ roomId });
    expect(history.map((row) => row.mediaRef)).toEqual([items[1]!.mediaRef]);
  });

  // ── the end of the queue ───────────────────────────────────────────────────

  it('PAUSES the room when the removed row was the last one', async () => {
    const items = await seedQueue(2);
    const before = await playAt(1);

    await queue.remove(roomId, ownerId, items[1]!.id);

    const after = await playbackOf();
    // Nothing left to move to, so the honest answer is a stopped room. Leaving
    // `playing: true` shows every viewer a running playhead on a track that is
    // no longer in the queue, and tells every late joiner to start it.
    expect(after.playing).toBe(false);
    expect(after.queueIndex).toBeNull();
    expect(after.seq).toBeGreaterThan(before.seq);
    // The room stops ON what it was watching rather than silently switching
    // source: the mediaRef is bookkeeping the client already agrees with.
    expect(after.mediaRef).toEqual(items[1]!.mediaRef);
    // The playhead is projected, not rewound to zero — a stop is where the
    // media got to, not the top of the track.
    expect(after.positionMs).toBeGreaterThanOrEqual(MID_TRACK_MS);
    expect((await queueOf()).items.map((it) => it.id)).toEqual([items[0]!.id]);
  });

  // ── the regression risk: rows that were NOT playing ────────────────────────

  it('only realigns the index when a row ABOVE the playing one is removed', async () => {
    const items = await seedQueue(3);
    const before = await playAt(2);

    await queue.remove(roomId, ownerId, items[0]!.id);

    const after = await playbackOf();
    // Bookkeeping only. Nobody seeks, nothing restarts, nothing pauses — the
    // index follows the same track to its new home and the anchor is
    // re-stamped so `positionMs + (now - serverTs)` still projects to the
    // same instant.
    expect(after.queueIndex).toBe(1);
    expect(after.mediaRef).toEqual(items[2]!.mediaRef);
    expect(after.playing).toBe(true);
    expect(after.positionMs).toBeGreaterThanOrEqual(MID_TRACK_MS);
    expect(after.positionMs).toBeLessThan(MID_TRACK_MS + 5000);
    expect(after.seq).toBeGreaterThan(before.seq);
  });

  it('writes no snapshot at all when a row BELOW the playing one is removed', async () => {
    const items = await seedQueue(3);
    const before = await playAt(1);

    await queue.remove(roomId, ownerId, items[2]!.id);

    // The index still names the same track, so there is nothing to correct and
    // no reason to mint a seq. Byte-identical, seq included.
    expect(await playbackOf()).toEqual(before);
    const emitted = await store.events.findMany({ roomId });
    expect(emitted.filter((e) => e.type === 'sync.state')).toEqual([]);
    expect(emitted.filter((e) => e.type === 'queue.state')).toHaveLength(1);
  });

  it('does not touch playback when the room has never started anything', async () => {
    // No playback snapshot at all: a vote-skip on the head of an unstarted
    // queue is a queue edit and nothing more.
    const items = await seedQueue(2);

    await queue.remove(roomId, ownerId, items[0]!.id);

    expect((await store.rooms.findById(roomId))!.playback).toBeNull();
  });

  // ── the wedge ──────────────────────────────────────────────────────────────

  it('leaves the room able to auto-advance again afterwards', async () => {
    const items = await seedQueue(3);
    await playAt(0);
    const sync = new SyncService(deps);
    const watcher = await member('watcher@example.com');

    await queue.remove(roomId, ownerId, items[0]!.id);
    const moved = await playbackOf();
    expect(moved.queueIndex).toBe(0);

    // The successor now plays out. Only the anchor moves — the queueIndex
    // under test is whatever the removal left behind, which is the whole
    // point: a null one here early-returns out of `advance` and the room can
    // never move again.
    await store.rooms.updateOne(
      { id: roomId },
      { playback: { ...moved, positionMs: ENDED_POSITION_MS, serverTs: Date.now() } },
    );
    await sync.advance(roomId, watcher, items[1]!.id);

    const after = await playbackOf();
    expect(after.queueIndex).toBe(1);
    expect(after.mediaRef).toEqual(items[2]!.mediaRef);
    expect(after.playing).toBe(true);
  });
});
