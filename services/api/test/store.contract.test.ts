/**
 * Adapter contract tests, run against the reference in-memory adapters
 * (MemoryStore / MemoryBus). MongoStore + RedisBus must honor the same
 * semantics — see src/adapters/ports.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageId, RoomId, UserId } from '@gather/contracts';
import { MemoryBus } from '../src/adapters/memory-bus';
import { MemoryCollection, MemoryStore } from '../src/adapters/memory-store';
import type { MessageDoc, UserDoc } from '../src/adapters/ports';
import { addMember, seedRoom } from './helpers';

/** Flat-ish document for exercising the query DSL directly. */
interface DSLDoc {
  id: string;
  n?: number;
  s?: string;
  flag?: boolean;
  meta?: Record<string, number>;
}

function makeUser(id: string, email: string | null): UserDoc {
  return {
    id: id as UserId,
    email,
    displayName: `User ${id}`,
    avatarUrl: null,
    accentColor: '#8b5cf6',
    createdAt: 1000,
  };
}

function makeMessage(
  id: string,
  roomId: string,
  body: string,
  createdAt: number,
  deletedAt: number | null = null,
): MessageDoc {
  return {
    id: id as MessageId,
    roomId: roomId as RoomId,
    authorId: 'author-1' as UserId,
    kind: 'text',
    body,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt,
    seq: 0,
    createdAt,
  };
}

function ids(docs: ReadonlyArray<{ id: string }>): string[] {
  return docs.map((doc) => doc.id);
}

async function seedDSL(col: MemoryCollection<DSLDoc>): Promise<void> {
  await col.insertOne({ id: '1', n: 1, s: 'apple' });
  await col.insertOne({ id: '2', n: 2, s: 'banana' });
  await col.insertOne({ id: '3', n: 3, s: 'cherry' });
  await col.insertOne({ id: '4', s: 'date' });
}

describe('MemoryStore document CRUD', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('roundtrips a user with full mutation isolation', async () => {
    const original = makeUser('u1', 'a@example.com');

    const inserted = await store.users.insertOne(original);
    expect(inserted).toEqual(original);
    expect(inserted).not.toBe(original);

    const found = await store.users.findById('u1');
    expect(found).toEqual(original);
    expect(found).not.toBe(original);
    expect(found).not.toBe(inserted);

    // Mutating a returned doc must not touch stored state.
    found!.displayName = 'MUTATED';
    const reread = await store.users.findById('u1');
    expect(reread?.displayName).toBe('User u1');

    // Mutating the caller's input doc after insert must not either.
    original.displayName = 'MUTATED AGAIN';
    const reread2 = await store.users.findById('u1');
    expect(reread2?.displayName).toBe('User u1');
  });

  it('returns null for a missing id', async () => {
    expect(await store.users.findById('nope')).toBeNull();
  });
});

describe('filter DSL', () => {
  let col: MemoryCollection<DSLDoc>;
  beforeEach(async () => {
    col = new MemoryCollection<DSLDoc>();
    await seedDSL(col);
  });

  it('matches literal equality', async () => {
    expect(ids(await col.findMany({ n: 2 }))).toEqual(['2']);
    expect(ids(await col.findMany({ s: 'cherry' }))).toEqual(['3']);
  });

  it('matches $ne', async () => {
    expect(ids(await col.findMany({ n: { $ne: 2 } }))).toEqual(['1', '3', '4']);
  });

  it('matches $lt/$lte/$gt/$gte on numbers', async () => {
    expect(ids(await col.findMany({ n: { $lt: 3 } }))).toEqual(['1', '2']);
    expect(ids(await col.findMany({ n: { $lte: 2 } }))).toEqual(['1', '2']);
    expect(ids(await col.findMany({ n: { $gt: 2 } }))).toEqual(['3']);
    expect(ids(await col.findMany({ n: { $gte: 2 } }))).toEqual(['2', '3']);
  });

  it('matches $lt/$gte on strings', async () => {
    expect(ids(await col.findMany({ s: { $gte: 'banana' } }))).toEqual(['2', '3', '4']);
    expect(ids(await col.findMany({ s: { $lt: 'cherry' } }))).toEqual(['1', '2']);
  });

  it('matches $in/$nin', async () => {
    expect(ids(await col.findMany({ n: { $in: [1, 3] } }))).toEqual(['1', '3']);
    expect(ids(await col.findMany({ s: { $nin: ['apple', 'banana'] } }))).toEqual(['3', '4']);
  });

  it('matches $exists true/false', async () => {
    expect(ids(await col.findMany({ n: { $exists: true } }))).toEqual(['1', '2', '3']);
    expect(ids(await col.findMany({ n: { $exists: false } }))).toEqual(['4']);
  });

  it('implicitly ANDs multiple fields', async () => {
    expect(ids(await col.findMany({ n: { $gte: 2 }, s: { $lt: 'date' } }))).toEqual(['2', '3']);
  });
});

describe('findMany options', () => {
  let col: MemoryCollection<DSLDoc>;
  beforeEach(async () => {
    col = new MemoryCollection<DSLDoc>();
    await col.insertOne({ id: 'a', s: 'b', n: 1 });
    await col.insertOne({ id: 'b', s: 'a', n: 2 });
    await col.insertOne({ id: 'c', s: 'b', n: 3 });
    await col.insertOne({ id: 'd', s: 'a', n: 4 });
  });

  it('sorts by multiple keys, asc then desc', async () => {
    const sorted = await col.findMany({}, { sort: [['s', 1], ['n', -1]] as const });
    expect(ids(sorted)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('applies skip and limit after sorting', async () => {
    const sort = [['s', 1], ['n', -1]] as const;
    expect(ids(await col.findMany({}, { sort, limit: 2 }))).toEqual(['d', 'b']);
    expect(ids(await col.findMany({}, { sort, skip: 1 }))).toEqual(['b', 'c', 'a']);
    expect(ids(await col.findMany({}, { sort, skip: 1, limit: 1 }))).toEqual(['b']);
  });
});

describe('updates and deletes', () => {
  let col: MemoryCollection<DSLDoc>;
  beforeEach(async () => {
    col = new MemoryCollection<DSLDoc>();
    await col.insertOne({ id: '1', n: 1, meta: { a: 1, b: 2 } });
    await col.insertOne({ id: '2', n: 2 });
    await col.insertOne({ id: '3', n: 3 });
  });

  it('updateOne returns the updated doc with a SHALLOW merge', async () => {
    const updated = await col.updateOne({ id: '1' }, { meta: { a: 9 } });
    // Shallow: meta is replaced wholesale, not deep-merged.
    expect(updated?.meta).toEqual({ a: 9 });
    // Untouched fields survive.
    expect(updated?.n).toBe(1);
    expect((await col.findById('1'))?.meta).toEqual({ a: 9 });
  });

  it('updateOne returns null on no match', async () => {
    expect(await col.updateOne({ id: 'nope' }, { n: 5 })).toBeNull();
  });

  it('updateMany patches all matches and returns the count', async () => {
    const count = await col.updateMany({ n: { $gte: 2 } }, { flag: true });
    expect(count).toBe(2);
    expect((await col.findById('1'))?.flag).toBeUndefined();
    expect((await col.findById('2'))?.flag).toBe(true);
    expect((await col.findById('3'))?.flag).toBe(true);
  });

  it('deleteOne reports whether something was removed', async () => {
    expect(await col.deleteOne({ id: '1' })).toBe(true);
    expect(await col.deleteOne({ id: '1' })).toBe(false);
    expect(await col.count({})).toBe(2);
  });

  it('deleteMany removes all matches and returns the count', async () => {
    expect(await col.deleteMany({ n: { $gte: 2 } })).toBe(2);
    expect(ids(await col.findMany({}))).toEqual(['1']);
  });
});

describe('unique indexes', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('rejects a duplicate rooms.inviteCode with CONFLICT', async () => {
    const { roomId } = await seedRoom(store);
    const room = await store.rooms.findById(roomId);
    expect(room).not.toBeNull();
    await expect(
      store.rooms.insertOne({ ...room!, id: 'another-room' as RoomId }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('rejects a duplicate members (roomId, userId) with CONFLICT', async () => {
    const { roomId } = await seedRoom(store);
    await addMember(store, roomId, 'user-x', 'member');
    await expect(addMember(store, roomId, 'user-x', 'member')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('users.email is sparse: null emails never collide, non-null ones do', async () => {
    await store.users.insertOne(makeUser('u1', null));
    // A second null email inserts fine (sparse index skips nulls).
    await store.users.insertOne(makeUser('u2', null));

    await store.users.insertOne(makeUser('u3', 'dup@example.com'));
    await expect(
      store.users.insertOne(makeUser('u4', 'dup@example.com')),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('an update that would collide on a unique index throws CONFLICT', async () => {
    await store.users.insertOne(makeUser('u1', null));
    await store.users.insertOne(makeUser('u2', 'taken@example.com'));
    await expect(
      store.users.updateOne({ id: 'u1' as UserId }, { email: 'taken@example.com' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('nextSeq', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('starts at 1 and increments monotonically, per scope', async () => {
    expect(await store.nextSeq('scope-a')).toBe(1);
    expect(await store.nextSeq('scope-a')).toBe(2);
    // Independent scopes are independent.
    expect(await store.nextSeq('scope-b')).toBe(1);
    expect(await store.nextSeq('scope-a')).toBe(3);
    expect(await store.nextSeq('scope-b')).toBe(2);
  });

  it('yields exactly 1..50 for 50 concurrent calls on one scope', async () => {
    const seqs = await Promise.all(
      Array.from({ length: 50 }, () => store.nextSeq('room:concurrent')),
    );
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('searchMessages', () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = new MemoryStore();
    await store.messages.insertOne(makeMessage('m1', 'r1', 'Hello world', 1));
    await store.messages.insertOne(makeMessage('m2', 'r1', 'nothing relevant', 2));
    await store.messages.insertOne(makeMessage('m3', 'r1', 'say HELLO again', 3));
    await store.messages.insertOne(makeMessage('m4', 'r2', 'hello from another room', 4));
    await store.messages.insertOne(makeMessage('m5', 'r1', 'hello but deleted', 5, 500));
  });

  it('matches case-insensitively, scoped to the room, newest first', async () => {
    const hits = await store.searchMessages('r1', 'hello', 10);
    expect(ids(hits)).toEqual(['m3', 'm1']);
  });

  it('excludes deleted messages and non-matching bodies', async () => {
    const hits = await store.searchMessages('r1', 'hello', 10);
    expect(ids(hits)).not.toContain('m5');
    expect(ids(hits)).not.toContain('m2');
  });

  it('respects the limit', async () => {
    const hits = await store.searchMessages('r1', 'hello', 1);
    expect(ids(hits)).toEqual(['m3']);
  });
});

describe('MemoryBus', () => {
  it('delivers asynchronously — never synchronously from publish', async () => {
    const bus = new MemoryBus();
    const received: unknown[] = [];
    await bus.subscribe('ch', (message) => {
      received.push(message);
    });

    const publishPromise = bus.publish('ch', { a: 1 });
    // publish has returned but delivery must NOT have happened yet.
    expect(received).toEqual([]);
    await publishPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([{ a: 1 }]);
    await bus.close();
  });

  it("delivers to the publisher's own subscription", async () => {
    const bus = new MemoryBus();
    const received: unknown[] = [];
    await bus.subscribe('ch', (message) => {
      received.push(message);
    });
    await bus.publish('ch', 'self');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(['self']);
    await bus.close();
  });

  it('unsubscribe stops delivery and is idempotent', async () => {
    const bus = new MemoryBus();
    const received: unknown[] = [];
    const unsub = await bus.subscribe('ch', (message) => {
      received.push(message);
    });
    await bus.publish('ch', 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([1]);

    await unsub();
    // Second call must be a no-op, not an error.
    await unsub();

    await bus.publish('ch', 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([1]);
    await bus.close();
  });

  it('a throwing handler does not prevent other handlers from receiving', async () => {
    const bus = new MemoryBus();
    const received: unknown[] = [];
    await bus.subscribe('ch', () => {
      throw new Error('boom');
    });
    await bus.subscribe('ch', (message) => {
      received.push(message);
    });
    await bus.publish('ch', 'payload');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(['payload']);
    await bus.close();
  });
});
