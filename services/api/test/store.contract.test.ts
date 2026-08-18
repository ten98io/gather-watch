/**
 * Adapter contract tests.
 *
 * THE POINT OF THIS FILE. Everything inside describeStoreContract() is the
 * STORE CONTRACT — one set of assertions, executed against EVERY adapter that
 * claims to implement StorePort, so a divergence between them fails the suite
 * instead of hiding until production. It ran against MemoryStore only for a
 * long time, and the cost of that was the `sparse: true` unique-index bug:
 * MemoryStore skipped an index entry on `record[key] == null`, real Mongo
 * indexed an explicit null under the key value null, and the two adapters
 * disagreed on exactly the rows production writes (every guest carries
 * `email: null`). 1727 green tests could not see it.
 *
 * WHAT IS AND IS NOT COVERED, honestly:
 *   • Every run: MemoryStore executes the whole contract below. Separately,
 *     store-index-spec.test.ts pins the exact index options MongoStore hands
 *     the driver — that is a STRUCTURAL pin (we ask Mongo for the right index)
 *     and not an execution (that Mongo then behaves as its docs say).
 *   • Only when GATHER_TEST_MONGO_URL points at a mongod: MongoStore executes
 *     the same contract, which is the only thing here that proves a real
 *     server enforces those indexes the way we expect.
 *   • NOT covered, as this repo stands: any automatic signal on the Mongo half.
 *     There is no mongodb-memory-server in the lockfile and no mongod service
 *     in the test setup, so the Mongo pass is SKIPPED by default. A divergence
 *     introduced today would still reach production unnoticed. Closing that
 *     needs a mongod in CI — a repo-level decision, not one this file can make.
 *     Run it by hand with:
 *       GATHER_TEST_MONGO_URL=mongodb://127.0.0.1:27017 pnpm --filter ./services/api test
 *
 * Deliberately OUTSIDE the shared contract, further down: the filter-DSL and
 * findMany-option suites (they drive MemoryCollection directly — MongoStore
 * hands those to the server, which is the reference), searchMessages (the port
 * documents MemoryStore's substring match as a FALLBACK for Mongo's word-based
 * text index, so the two are not supposed to agree), and MemoryBus.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MongoClient } from 'mongodb';
import type { MessageId, RoomId, UserId } from '@gather/contracts';
import { MemoryBus } from '../src/adapters/memory-bus';
import { MemoryCollection, MemoryStore } from '../src/adapters/memory-store';
import { MongoStore } from '../src/adapters/mongo-store';
import type { MessageDoc, PushSubDoc, StorePort, UserDoc } from '../src/adapters/ports';
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

/** An expo registration: `endpoint` and `keys` are written as explicit null. */
function makeExpoSub(id: string, expoPushToken: string): PushSubDoc {
  return {
    id,
    userId: `user-${id}`,
    platform: 'expo',
    endpoint: null,
    keys: null,
    expoPushToken,
    createdAt: 1000,
  };
}

/** A web registration: `expoPushToken` is written as explicit null. */
function makeWebSub(id: string, endpoint: string): PushSubDoc {
  return {
    id,
    userId: `user-${id}`,
    platform: 'web',
    endpoint,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    expoPushToken: null,
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

// ── Adapter harnesses ────────────────────────────────────────────────────────

interface OpenStore {
  store: StorePort;
  close: () => Promise<void>;
}

interface StoreHarness {
  readonly label: string;
  /** A fresh, EMPTY store plus its teardown. */
  open(): Promise<OpenStore>;
}

const memoryHarness: StoreHarness = {
  label: 'MemoryStore',
  open: async () => ({ store: new MemoryStore(), close: async () => {} }),
};

/** Distinct database per test so one contract case cannot see another's rows. */
let mongoDbCounter = 0;

function mongoHarness(url: string): StoreHarness {
  return {
    label: 'MongoStore',
    open: async () => {
      mongoDbCounter += 1;
      const dbName = `gather_contract_${process.pid}_${mongoDbCounter}`;
      const store = new MongoStore(url, dbName);
      await store.init();
      return {
        store,
        close: async () => {
          await store.close();
          // Dropped through a throwaway client rather than by reaching inside
          // the adapter for its own — the contract tests only ever touch the
          // StorePort surface.
          const admin = new MongoClient(url);
          try {
            await admin.connect();
            await admin.db(dbName).dropDatabase();
          } finally {
            await admin.close();
          }
        },
      };
    },
  };
}

const mongoUrl = process.env['GATHER_TEST_MONGO_URL'];

// ── The contract ─────────────────────────────────────────────────────────────

function describeStoreContract(harness: StoreHarness): void {
  describe(`store contract — ${harness.label}`, () => {
    let opened: OpenStore;
    let store: StorePort;

    beforeEach(async () => {
      opened = await harness.open();
      store = opened.store;
    });
    afterEach(async () => {
      await opened.close();
    });

    describe('document CRUD', () => {
      it('roundtrips a user with full mutation isolation', async () => {
        const original = makeUser('u1', 'a@example.com');

        const inserted = await store.users.insertOne(original);
        expect(inserted).toEqual(original);

        const found = await store.users.findById('u1');
        expect(found).toEqual(original);
        expect(found).not.toBe(original);

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

      it('rejects a duplicate id with CONFLICT', async () => {
        await store.users.insertOne(makeUser('u1', null));
        await expect(store.users.insertOne(makeUser('u1', null))).rejects.toMatchObject({
          code: 'CONFLICT',
        });
      });

      it('updateOne applies a SHALLOW merge and returns the updated doc', async () => {
        await store.users.insertOne(makeUser('u1', 'a@example.com'));
        const updated = await store.users.updateOne({ id: 'u1' as UserId }, { displayName: 'New' });
        expect(updated?.displayName).toBe('New');
        expect(updated?.email).toBe('a@example.com');
      });

      it('updateOne returns null when nothing matched', async () => {
        expect(await store.users.updateOne({ id: 'nope' as UserId }, { displayName: 'x' })).toBeNull();
      });

      it('rejects a patch containing id', async () => {
        await store.users.insertOne(makeUser('u1', null));
        await expect(
          store.users.updateOne({ id: 'u1' as UserId }, { id: 'u2' as UserId }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      });
    });

    describe('unique indexes', () => {
      it('rejects a duplicate rooms.inviteCode with CONFLICT', async () => {
        const { roomId } = await seedRoom(store);
        const room = await store.rooms.findById(roomId);
        expect(room).not.toBeNull();
        await expect(
          store.rooms.insertOne({ ...room!, id: 'another-room' as RoomId }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
      });

      it('rejects a duplicate members (roomId, userId) with CONFLICT', async () => {
        const { roomId } = await seedRoom(store);
        await addMember(store, roomId, 'user-x', 'member');
        await expect(addMember(store, roomId, 'user-x', 'member')).rejects.toMatchObject({
          code: 'CONFLICT',
        });
      });

      it('rejects a duplicate users.email with CONFLICT', async () => {
        await store.users.insertOne(makeUser('u1', 'dup@example.com'));
        await expect(store.users.insertOne(makeUser('u2', 'dup@example.com'))).rejects.toMatchObject(
          { code: 'CONFLICT' },
        );
      });

      it('an update that would collide on a unique index throws CONFLICT', async () => {
        await store.users.insertOne(makeUser('u1', null));
        await store.users.insertOne(makeUser('u2', 'taken@example.com'));
        await expect(
          store.users.updateOne({ id: 'u1' as UserId }, { email: 'taken@example.com' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
      });

      /**
       * The four cases the two adapters have to agree on, spelled out because
       * they are exactly where `sparse` lied. Mongo's rule for a partial index
       * filtered to `{ $type: 'string' }`: the document is indexed only while
       * the field HOLDS A STRING. Absent and null are outside the filter and
       * produce no index entry at all; '' is a string and is indexed.
       */
      it('users.email — ABSENT and NULL never collide, values and even "" do', async () => {
        // Explicit null, many times over: no entry, no collision. (Guests.)
        await store.users.insertOne(makeUser('n1', null));
        await store.users.insertOne(makeUser('n2', null));
        await store.users.insertOne(makeUser('n3', null));
        expect(await store.users.count({ email: null })).toBe(3);

        // A real value is unique.
        await store.users.insertOne(makeUser('v1', 'real@example.com'));
        await expect(
          store.users.insertOne(makeUser('v2', 'real@example.com')),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        // The empty string is a VALUE, not an absence — it is indexed, so a
        // second one collides. (Nothing writes '' today; the assertion is here
        // so neither adapter can quietly start treating it as "no email".)
        await store.users.insertOne(makeUser('e1', ''));
        await expect(store.users.insertOne(makeUser('e2', ''))).rejects.toMatchObject({
          code: 'CONFLICT',
        });
      });

      it('clearing an email back to null never collides (the erasure path)', async () => {
        await store.users.insertOne(makeUser('u1', 'one@example.com'));
        await store.users.insertOne(makeUser('u2', 'two@example.com'));

        // compliance/erasure.ts patches BOTH of these to `email: null`. Under a
        // sparse unique index the second erasure is a CONFLICT forever.
        expect(await store.users.updateOne({ id: 'u1' as UserId }, { email: null })).not.toBeNull();
        expect(await store.users.updateOne({ id: 'u2' as UserId }, { email: null })).not.toBeNull();
        expect(await store.users.count({ email: null })).toBe(2);
      });
    });

    /**
     * The rows production actually writes on a FRESH database — the exact
     * sequence a wiped-and-restarted deployment starts with.
     */
    describe('regression: explicit nulls in indexed fields', () => {
      it('three guests join in sequence and all three land', async () => {
        // Every guest is written with `email: null` (auth/service.ts). The
        // SECOND one is where a sparse unique index turns into a 409 forever.
        await store.users.insertOne(makeUser('guest-1', null));
        await store.users.insertOne(makeUser('guest-2', null));
        await store.users.insertOne(makeUser('guest-3', null));

        const guests = await store.users.findMany({ email: null }, { sort: [['id', 1]] });
        expect(ids(guests)).toEqual(['guest-1', 'guest-2', 'guest-3']);
      });

      it('two expo push subscriptions register despite both writing endpoint: null', async () => {
        await store.pushSubs.insertOne(makeExpoSub('p1', 'ExponentPushToken[aaa]'));
        await store.pushSubs.insertOne(makeExpoSub('p2', 'ExponentPushToken[bbb]'));
        expect(await store.pushSubs.count({ endpoint: null })).toBe(2);
      });

      it('two web push subscriptions register despite both writing expoPushToken: null', async () => {
        await store.pushSubs.insertOne(makeWebSub('w1', 'https://push.example.com/aaa'));
        await store.pushSubs.insertOne(makeWebSub('w2', 'https://push.example.com/bbb'));
        expect(await store.pushSubs.count({ expoPushToken: null })).toBe(2);
      });

      it('but the real identities still collide', async () => {
        await store.pushSubs.insertOne(makeWebSub('w1', 'https://push.example.com/same'));
        await expect(
          store.pushSubs.insertOne(makeWebSub('w2', 'https://push.example.com/same')),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        await store.pushSubs.insertOne(makeExpoSub('p1', 'ExponentPushToken[same]'));
        await expect(
          store.pushSubs.insertOne(makeExpoSub('p2', 'ExponentPushToken[same]')),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
      });
    });

    describe('nextSeq', () => {
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
  });
}

describeStoreContract(memoryHarness);

// Runs only with a mongod to point at; see the header for what that does and
// does not buy. `describe.runIf` keeps the skip visible in the reporter rather
// than silently omitting the adapter.
describe.runIf(mongoUrl !== undefined)('MongoStore contract (GATHER_TEST_MONGO_URL)', () => {
  describeStoreContract(mongoHarness(mongoUrl ?? ''));
});

// ── MemoryStore-only: the DSL reference ──────────────────────────────────────

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

describe('searchMessages (MemoryStore fallback, NOT a cross-adapter contract)', () => {
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
