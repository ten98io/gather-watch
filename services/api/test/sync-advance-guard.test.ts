/**
 * THE ADVANCE HAS TO BE PAID FOR IN TIME.
 *
 * `sync.advance` takes the intent from any non-banned member, which is the
 * whole point: an end-of-track advance must not need a seat, a policy or a
 * vote, or rooms stop dead on a finished item. But "the item I was playing has
 * ENDED" is a CLAIM about the world, and the compare half of the CAS only
 * checks WHICH item the claim is about — never whether it could be true. A
 * member who keeps re-reading the current row and re-claiming it therefore
 * walked the whole queue, ten rows in ten calls, with no votes and no policy.
 * That is the film skipped by one guest.
 *
 * So the server checks the claim against what it already knows: `room.playback`
 * carries the media clock (position, rate, playing, serverTs) and the queue row
 * often carries `durationMs`, so the server can project how far into the item
 * the room actually is and refuse a claim the projection contradicts.
 *
 * The guard is one-directional on purpose. It cannot make a genuine ending
 * fail-open into a skip — refusing costs a griefer everything and costs an
 * honest client only a move the room was going to make anyway when the NEXT
 * client's copy of the item ends. And it never applies to a member the policy
 * already lets drive: they can `sync.setTrack` anywhere, so constraining their
 * advance would be theatre.
 *
 * Every refusal here is SILENT, for the same reason a stale id is: the refused
 * client is usually an honest one whose item really did end, and an error frame
 * per refusal is how every console in the room fills up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { PlaybackState, QueueItem, QueueItemId, RoomId, UserId } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import {
  ADVANCE_END_GRACE_MS,
  ADVANCE_UNKNOWN_DURATION_FLOOR_MS,
  SyncService,
} from '../src/modules/sync/service';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

/** A ten-minute film — long enough that "near the end" and "at the start" are
 *  not the same number under any tolerance. */
const FILM_MS = 10 * 60 * 1000;

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

describe('sync.advance: the ending has to be plausible', () => {
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
    // seedRoom's playbackControl is 'host': the guest below is a member the
    // policy does NOT admit, which is the only case the guard applies to.
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

  /** A member with no socket — the service-level probes drive these directly. */
  async function member(email: string, role: 'host' | 'moderator' | 'member' = 'member'): Promise<UserId> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, role);
    return account.user.id;
  }

  /** `count` queue rows, each claiming `durationMs` (null = the common
   *  YouTube case, where nobody ever resolved a duration). */
  async function seedQueue(count: number, durationMs: number | null): Promise<QueueItem[]> {
    const items: QueueItem[] = Array.from({ length: count }, (_, n) => ({
      id: `item-${n}` as QueueItemId,
      mediaRef: { kind: 'page' as const, url: `https://example.com/watch/${n}` },
      title: `item ${n}`,
      durationMs,
      artworkUrl: null,
      addedBy: ownerId,
      votesToSkip: [],
    }));
    await store.rooms.updateOne({ id: roomId }, { queue: { items, version: 1 } });
    return items;
  }

  /**
   * Put the room on a queue row at a given point in the media.
   *
   * `positionMs` IS the story of every test in this file: it is how far into
   * the item the room's own clock says it is, and therefore the only evidence
   * the server has about whether an ending is possible. `playing` defaults to
   * true — the state a track ends from — and can be turned off for the
   * paused-then-ended case.
   */
  async function playAt(index: number, positionMs: number, playing = true): Promise<void> {
    const room = await store.rooms.findById(roomId);
    const playback: PlaybackState = {
      mediaRef: room!.queue.items[index]!.mediaRef,
      positionMs,
      rate: 1,
      playing,
      serverTs: Date.now(),
      seq: await store.nextSeq(`playback:${roomId}`),
      queueIndex: index,
    };
    await store.rooms.updateOne({ id: roomId }, { playback });
  }

  const playbackOf = async (): Promise<PlaybackState> =>
    (await store.rooms.findById(roomId))!.playback!;

  /** The auditor's probe: name whatever row is current, over and over. Returns
   *  how far up the queue the room got. */
  async function walk(userId: UserId, steps: number): Promise<number> {
    const room = await store.rooms.findById(roomId);
    for (let n = 0; n < steps; n += 1) {
      const at = (await playbackOf()).queueIndex;
      if (at === null) break;
      const current = room!.queue.items[at];
      if (current === undefined) break;
      await sync.advance(roomId, userId, current.id);
    }
    return (await playbackOf()).queueIndex ?? -1;
  }

  // ── PROBE A: the capability that had to go ─────────────────────────────────

  it('PROBE A: a plain member cannot walk a ten-item queue, durations KNOWN', async () => {
    await seedQueue(10, FILM_MS);
    await playAt(0, 0);
    const griefer = await member('griefer@example.com');

    // Ten calls, each naming the row that is current at the time — the exact
    // probe that used to end on index 9 with the room stopped.
    const reached = await walk(griefer, 10);

    expect(reached).toBe(0);
    const playback = await playbackOf();
    expect(playback.playing).toBe(true);
    // Not one snapshot minted: the refusals wrote nothing at all.
    expect((await store.events.findMany({ roomId })).filter((e) => e.type === 'sync.state')).toEqual(
      [],
    );
  });

  it('PROBE A: a plain member cannot walk a ten-item queue, durations UNKNOWN', async () => {
    // The common case, and the one the guard can say least about: no duration
    // means no end to compare against. It still has to stop the walk.
    await seedQueue(10, null);
    await playAt(0, 0);
    const griefer = await member('griefer@example.com');

    expect(await walk(griefer, 10)).toBe(0);
    expect((await playbackOf()).playing).toBe(true);
  });

  it('PROBE A: nor by waiting out ONE item and then walking the rest', async () => {
    // The honest first advance is real and must land. What must not follow is
    // the other nine for free: the room lands on item 1 at position 0, and
    // every further claim is about an item that has just started.
    await seedQueue(10, FILM_MS);
    await playAt(0, FILM_MS - 1000);
    const griefer = await member('griefer@example.com');

    expect(await walk(griefer, 10)).toBe(1);
  });

  // ── the genuine ending, which must still work for anyone ───────────────────

  it('takes a genuine end-of-track advance from a plain member, duration KNOWN', async () => {
    const items = await seedQueue(3, FILM_MS);
    await playAt(0, FILM_MS - 1000);
    const watcher = await member('watcher@example.com');

    await sync.advance(roomId, watcher, items[0]!.id);

    const playback = await playbackOf();
    expect(playback.queueIndex).toBe(1);
    expect(playback.mediaRef).toEqual(items[1]!.mediaRef);
    expect(playback.playing).toBe(true);
  });

  it('takes a genuine end-of-track advance from a plain member, duration UNKNOWN', async () => {
    const items = await seedQueue(3, null);
    // Past the floor and nothing else known — the branch where the server is
    // trusting elapsed play time and nothing else.
    await playAt(0, ADVANCE_UNKNOWN_DURATION_FLOOR_MS + 1000);
    const watcher = await member('watcher@example.com');

    await sync.advance(roomId, watcher, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  it('allows the whole grace window: a stall, a short cut, an early ending', async () => {
    // The projection is the ROOM's clock, not this client's. It can sit ahead
    // of a real ending — metadata that over-states the runtime, a file whose
    // credits were trimmed — and that has to pass, because a refusal here
    // leaves the room on a finished item.
    const items = await seedQueue(3, FILM_MS);
    await playAt(0, FILM_MS - ADVANCE_END_GRACE_MS + 2000);
    const watcher = await member('watcher@example.com');

    await sync.advance(roomId, watcher, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  it('takes a paused-then-ended item, and refuses a paused-at-the-start one', async () => {
    const items = await seedQueue(3, FILM_MS);
    // Paused a second from the end: projection freezes at the paused position,
    // which is exactly where the media stopped. An ending is possible.
    await playAt(0, FILM_MS - 1000, false);
    const watcher = await member('watcher@example.com');
    await sync.advance(roomId, watcher, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);

    // Paused ten seconds in, on an item ten minutes long. Nothing ended.
    await playAt(1, 10_000, false);
    await sync.advance(roomId, watcher, items[1]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  it('refuses an advance from further out than the grace window', async () => {
    const items = await seedQueue(3, FILM_MS);
    await playAt(0, FILM_MS - ADVANCE_END_GRACE_MS - 60_000);
    const griefer = await member('griefer@example.com');

    await sync.advance(roomId, griefer, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(0);
  });

  // ── the people the guard must not touch ────────────────────────────────────

  it('does not constrain a member the policy lets drive', async () => {
    const items = await seedQueue(3, FILM_MS);
    await playAt(0, 0); // nothing has ended by any measure
    // The host may `sync.setTrack` to any row already, so refusing their
    // advance would protect nothing and would break the one client most
    // likely to be driving the room.
    await sync.advance(roomId, ownerId, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  it('does not constrain anyone in an "everyone" room', async () => {
    const room = (await store.rooms.findById(roomId))!;
    await store.rooms.updateOne(
      { id: roomId },
      { policies: { ...room.policies, playbackControl: 'everyone' } },
    );
    const items = await seedQueue(3, FILM_MS);
    await playAt(0, 0);
    const guest = await member('guest@example.com');

    await sync.advance(roomId, guest, items[0]!.id);
    expect((await playbackOf()).queueIndex).toBe(1);
  });

  // ── the end of the queue is a mutation too ─────────────────────────────────

  it('refuses to STOP the room on an item that has not ended', async () => {
    // The no-successor branch pauses the room, and pause is policy-gated for
    // exactly this member. Without the guard, naming the last row is a pause
    // they may repeat every time the host presses play.
    const items = await seedQueue(2, FILM_MS);
    await playAt(1, 0);
    const griefer = await member('griefer@example.com');

    await sync.advance(roomId, griefer, items[1]!.id);
    expect((await playbackOf()).playing).toBe(true);

    // And the genuine version of the same call still stops the room.
    await playAt(1, FILM_MS - 1000);
    await sync.advance(roomId, griefer, items[1]!.id);
    expect((await playbackOf()).playing).toBe(false);
  });

  // ── refusals stay silent ───────────────────────────────────────────────────

  it('says NOTHING back: no error frame, no state, on a refused advance', async () => {
    const items = await seedQueue(3, FILM_MS);
    await playAt(0, 0);
    const account = await signupUser(app, 'quiet@example.com');
    await addMember(store, roomId, account.user.id, 'member');
    const sock = await openSocket(
      `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
    );
    sockets.push(sock);
    const frames = collect(sock);

    sock.send(
      JSON.stringify({
        type: 'sync.advance',
        roomId,
        seq: 0,
        ts: Date.now(),
        payload: { endedItemId: items[0]!.id },
      }),
    );
    await settle();

    // A refused client is USUALLY an honest one whose item really did end —
    // its copy simply ran ahead of the room's clock. Telling it off would put
    // an error on a socket that did nothing wrong, and telling a griefer
    // anything at all just tells them what to wait for.
    expect(frames.filter((f) => f.type === 'error')).toEqual([]);
    expect(frames.filter((f) => f.type === 'sync.state')).toEqual([]);
    expect((await playbackOf()).queueIndex).toBe(0);
  });
});
