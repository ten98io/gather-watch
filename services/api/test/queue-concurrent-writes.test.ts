/**
 * TWO PEOPLE ADDING AT THE SAME MOMENT MUST BOTH GET THEIR TRACK.
 *
 * Every queue mutation is a read-modify-write over an array embedded on the
 * room document: read `room.queue`, run the pure reducer, write the whole
 * thing back. Written with the filter `{ id }` that is not a mutation, it is a
 * LAST-WRITER-WINS overwrite — both writers read version 5, both compute
 * version 6 carrying only their OWN row, and the second erases the first. The
 * room broadcasts two different queues under the SAME version, and the client
 * guard (`version < s.queue.version ? {} : apply`) lets both through, so the
 * loser's track appears and then vanishes with no error anywhere.
 *
 * The window is one store round trip, which is why these tests put a delay in
 * front of `rooms.updateOne`: on the memory store a read-modify-write is
 * effectively atomic by accident, and a real Mongo write is not. The delay
 * simulates nothing — it just makes the window the network already opens wide
 * enough to aim at.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { QueueItem, QueueItemId, QueueItemInput, RoomId, UserId } from '@gather/contracts';
import type { DocCollection, RoomDoc, StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { QueueService } from '../src/modules/queue/service';
import { SyncService } from '../src/modules/sync/service';
import { newId } from '../src/lib/tokens';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

/**
 * Put `ms` of latency in front of every room write, so the read-modify-write
 * window a real store opens by itself is wide enough for a second caller to
 * step into. Shadows the method on the instance — the collection is `readonly`
 * on the store and this is a test rig, not an adapter change.
 */
function delayRoomWrites(rooms: DocCollection<RoomDoc>, ms: number): void {
  const original = rooms.updateOne.bind(rooms);
  rooms.updateOne = async (filter, patch) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return original(filter, patch);
  };
}

const MEDIA_REF = { kind: 'page', url: 'https://example.com/watch/x' } as const;

function itemInput(title: string): QueueItemInput {
  return { mediaRef: MEDIA_REF, title, durationMs: null, artworkUrl: null };
}

describe('concurrent queue writes', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;
  let roomId: RoomId;
  let queue: QueueService;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
    ({ roomId } = await seedRoom(store));
    queue = new QueueService(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function member(email: string): Promise<UserId> {
    const account = await signupUser(app, email);
    await addMember(store, roomId, account.user.id, 'member');
    return account.user.id;
  }

  const queueOf = async (): Promise<{ items: QueueItem[]; version: number }> =>
    (await store.rooms.findById(roomId))!.queue;

  it('keeps BOTH tracks when two adds race, and versions them apart', async () => {
    const alice = await member('alice@example.com');
    const bob = await member('bob@example.com');
    delayRoomWrites(store.rooms, 20);

    await Promise.all([
      queue.add(roomId, alice, itemInput('alice-song')),
      queue.add(roomId, bob, itemInput('bob-song')),
    ]);

    const { items, version } = await queueOf();
    // The pre-fix result was ['bob-song'] at version 1: Alice's row was read,
    // computed and then overwritten by a write that never looked at it.
    expect(items.map((it) => it.title).sort()).toEqual(['alice-song', 'bob-song']);
    // One bump per effective change, and no two changes share a version — the
    // whole basis of the client's `version <` guard.
    expect(version).toBe(2);
  });

  it('does not lose a reported duration to an add that raced it', async () => {
    const watcher = await member('watcher@example.com');
    const adder = await member('adder@example.com');
    const sync = new SyncService(deps);

    const current: QueueItem = {
      id: newId() as QueueItemId,
      mediaRef: MEDIA_REF,
      title: 'Current',
      durationMs: null,
      artworkUrl: null,
      addedBy: watcher,
      votesToSkip: [],
    };
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [current], version: 1 } });
    delayRoomWrites(store.rooms, 20);

    await Promise.all([
      sync.reportDuration(roomId, watcher, current.id, 600_000),
      queue.add(roomId, adder, itemInput('added')),
    ]);

    const { items } = await queueOf();
    expect(items).toHaveLength(2);
    // Losing this write is not cosmetic: with no duration `endingIsPlausible`
    // degrades to the 20 s unknown-duration floor for a ten-minute film, and
    // every member of the room can advance past it after twenty seconds.
    expect(items.find((it) => it.id === current.id)?.durationMs).toBe(600_000);
  });

  it('does not erase an add with a duration write that lands after it', async () => {
    const watcher = await member('late-watcher@example.com');
    const adder = await member('late-adder@example.com');
    const sync = new SyncService(deps);

    const current: QueueItem = {
      id: newId() as QueueItemId,
      mediaRef: MEDIA_REF,
      title: 'Current',
      durationMs: null,
      artworkUrl: null,
      addedBy: watcher,
      votesToSkip: [],
    };
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [current], version: 1 } });
    delayRoomWrites(store.rooms, 20);

    // THE OTHER ORDER, and the one the add's own compare-and-set cannot cover:
    // here the duration write is the loser, so an unconditional one stores a
    // queue computed before the add existed and the added row disappears.
    // Every player in the room reports a duration on load, so this race is not
    // exotic — it is what happens when somebody queues a track while anyone
    // else's player is starting one.
    await Promise.all([
      queue.add(roomId, adder, itemInput('added')),
      sync.reportDuration(roomId, watcher, current.id, 600_000),
    ]);

    const { items } = await queueOf();
    expect(items.map((it) => it.title)).toEqual(['Current', 'added']);
    expect(items.find((it) => it.id === current.id)?.durationMs).toBe(600_000);
  });

  it('keeps a vote-skip that races an add on the same queue', async () => {
    const voter = await member('voter@example.com');
    const adder = await member('adder@example.com');

    const current: QueueItem = {
      id: newId() as QueueItemId,
      mediaRef: MEDIA_REF,
      title: 'Current',
      durationMs: null,
      artworkUrl: null,
      addedBy: voter,
      votesToSkip: [],
    };
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [current], version: 1 } });
    delayRoomWrites(store.rooms, 20);

    await Promise.all([
      queue.voteSkip(roomId, voter, current.id),
      queue.add(roomId, adder, itemInput('added')),
    ]);

    const { items } = await queueOf();
    expect(items).toHaveLength(2);
    expect(items.find((it) => it.id === current.id)?.votesToSkip).toEqual([voter]);
  });

  it('re-applies a removal against the queue an add landed on first', async () => {
    const owner = await member('owner@example.com');
    const first: QueueItem = {
      id: newId() as QueueItemId,
      mediaRef: MEDIA_REF,
      title: 'Doomed',
      durationMs: null,
      artworkUrl: null,
      addedBy: owner,
      votesToSkip: [],
    };
    await store.rooms.updateOne({ id: roomId }, { queue: { items: [first], version: 1 } });
    delayRoomWrites(store.rooms, 20);

    await Promise.all([
      queue.remove(roomId, owner, first.id),
      queue.add(roomId, owner, itemInput('survivor')),
    ]);

    const { items } = await queueOf();
    expect(items.map((it) => it.title)).toEqual(['survivor']);
  });
});
