/**
 * The unique-index SPEC itself: what MongoStore asks the server for, and
 * whether MemoryStore enforces the same rule.
 *
 * Split from store.contract.test.ts because these are not behavioral store
 * assertions — they are the one thing that CAN be checked about the Mongo half
 * without a mongod: the exact index options that reach the driver, and the
 * shared key-extraction rule both adapters run on.
 */
import { describe, it, expect } from 'vitest';
import { MemoryCollection } from '../src/adapters/memory-store';
import { uniqueIndexDefinition } from '../src/adapters/mongo-store';
import { indexKeyOf, UNIQUE_INDEXES } from '../src/adapters/ports';
import type { PushSubDoc, UniqueIndexSpec, UniqueIndexSpecFor } from '../src/adapters/ports';

/** Loosely typed on purpose: an index rule has to hold for values the domain
 *  types happen to forbid today, or it is a coincidence rather than a rule. */
interface EmailDoc {
  id: string;
  email?: string | number | null;
}

interface HashDoc {
  id: string;
  refreshHash?: string | null;
}

describe('UNIQUE_INDEXES audit', () => {
  /**
   * `sparse` omits a document only when the field is ABSENT. A field that is
   * PRESENT and holds BSON null IS indexed, under the key value null — so a
   * sparse UNIQUE index over a nullable field rejects the second row ever
   * written with an explicit null. Nothing in this repo may declare one.
   */
  it('declares no sparse index anywhere', () => {
    const offenders: string[] = [];
    for (const [collection, specs] of Object.entries(UNIQUE_INDEXES)) {
      for (const spec of specs) {
        if (Object.keys(spec).includes('sparse')) {
          offenders.push(`${collection}(${spec.keys.join(', ')})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The fields below are declared `string | null` and are WRITTEN as an
   * explicit null on the ordinary path. Each one must therefore be partial,
   * not plain — a plain unique index would index every null under the same key
   * and reject the second row.
   */
  it.each([
    ['users', 'email', 'every guest and every erased account'],
    ['pushSubs', 'endpoint', 'every expo registration'],
    ['pushSubs', 'expoPushToken', 'every web registration'],
  ])('%s.%s is partial, because %s writes it as null', (collection, field) => {
    const spec = (UNIQUE_INDEXES[collection] ?? []).find((candidate) =>
      candidate.keys.length === 1 && candidate.keys[0] === field,
    );
    expect(spec).toBeDefined();
    expect(spec?.partialOnString).toBe(true);
  });
});

/**
 * What MongoStore hands the driver. This is a STRUCTURAL pin, and worth being
 * precise about what it does and does not prove: it proves we ASK for the right
 * index, not that a server then behaves as documented. The behavioral half only
 * runs with GATHER_TEST_MONGO_URL set — see store.contract.test.ts.
 */
describe('uniqueIndexDefinition — the options that reach Mongo', () => {
  it('builds a partial index filtered to $type string, never a sparse one', () => {
    const spec: UniqueIndexSpec = { keys: ['email'], partialOnString: true };
    expect(uniqueIndexDefinition(spec)).toEqual({
      keys: { email: 1 },
      options: {
        unique: true,
        partialFilterExpression: { email: { $type: 'string' } },
      },
    });
  });

  it('builds a plain unique index when the field is never null', () => {
    expect(uniqueIndexDefinition({ keys: ['roomId', 'userId'] })).toEqual({
      keys: { roomId: 1, userId: 1 },
      options: { unique: true },
    });
  });

  it('emits no sparse option for any index this repo declares', () => {
    for (const specs of Object.values(UNIQUE_INDEXES)) {
      for (const spec of specs) {
        expect(uniqueIndexDefinition(spec).options).not.toHaveProperty('sparse');
      }
    }
  });

  /**
   * $exists is the tempting alternative and it is wrong: an explicitly-null
   * field EXISTS, so `{$exists: true}` would index every guest's null under the
   * same key and reproduce the original bug with a different spelling.
   */
  it('does not filter on $exists', () => {
    const { options } = uniqueIndexDefinition({ keys: ['email'], partialOnString: true });
    expect(JSON.stringify(options.partialFilterExpression)).not.toContain('$exists');
  });
});

/**
 * The four cases the bug lived in, as a table. These expectations come from
 * MongoDB's documented index behavior, not from reading the implementation
 * back to itself — a partial index stores an entry only for documents matching
 * its filter, and a plain index stores a MISSING field as null. MemoryStore
 * enforcing this rule and MongoStore's options expressing it are the two things
 * that have to agree with the table.
 */
describe('indexKeyOf — absent / null / "" / value', () => {
  const partial: UniqueIndexSpec = { keys: ['email'], partialOnString: true };
  const plain: UniqueIndexSpec = { keys: ['email'] };

  it('partial-on-string: only a string produces an index entry', () => {
    expect(indexKeyOf(partial, {})).toBeNull();
    expect(indexKeyOf(partial, { email: null })).toBeNull();
    expect(indexKeyOf(partial, { email: 0 })).toBeNull();
    expect(indexKeyOf(partial, { email: '' })).toEqual(['']);
    expect(indexKeyOf(partial, { email: 'a@example.com' })).toEqual(['a@example.com']);
  });

  it('plain unique: an absent field IS an entry, and it is the null one', () => {
    expect(indexKeyOf(plain, {})).toEqual([null]);
    expect(indexKeyOf(plain, { email: null })).toEqual([null]);
    expect(indexKeyOf(plain, { email: '' })).toEqual(['']);
    expect(indexKeyOf(plain, { email: 'a@example.com' })).toEqual(['a@example.com']);
  });

  it('compound plain unique keeps field order', () => {
    const compound: UniqueIndexSpec = { keys: ['roomId', 'userId'] };
    expect(indexKeyOf(compound, { roomId: 'r1', userId: 'u1' })).toEqual(['r1', 'u1']);
    expect(indexKeyOf(compound, { roomId: 'r1' })).toEqual(['r1', null]);
  });
});

describe('index key extraction — Mongo semantics, both adapters', () => {
  /**
   * users.email is the live partial-on-string index. The rule Mongo applies to
   * `partialFilterExpression: { email: { $type: 'string' } }` is "indexed only
   * while the field holds a string", which is NOT the same as "indexed unless
   * it is nullish": a non-string value is outside the filter too.
   */
  it('partial-on-string does not index a non-string value', async () => {
    const col = new MemoryCollection<EmailDoc>(UNIQUE_INDEXES['users'] ?? []);
    await col.insertOne({ id: 'a', email: 0 });
    // Outside the partial filter ⇒ no index entry ⇒ nothing to collide with.
    await col.insertOne({ id: 'b', email: 0 });
    expect(await col.count({})).toBe(2);
  });

  it('partial-on-string does not index absent or null, but does index ""', async () => {
    const col = new MemoryCollection<EmailDoc>(UNIQUE_INDEXES['users'] ?? []);
    await col.insertOne({ id: 'absent-1' });
    await col.insertOne({ id: 'absent-2' });
    await col.insertOne({ id: 'null-1', email: null });
    await col.insertOne({ id: 'null-2', email: null });
    expect(await col.count({})).toBe(4);

    await col.insertOne({ id: 'empty-1', email: '' });
    await expect(col.insertOne({ id: 'empty-2', email: '' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  /**
   * A PLAIN unique index indexes every document, and Mongo indexes an ABSENT
   * field as null — it does not distinguish "missing" from "explicitly null"
   * in an index key. Two documents that differ only that way collide.
   */
  it('plain unique treats an absent field and an explicit null as the SAME key', async () => {
    const col = new MemoryCollection<HashDoc>(UNIQUE_INDEXES['sessions'] ?? []);
    await col.insertOne({ id: 'absent' });
    await expect(col.insertOne({ id: 'null', refreshHash: null })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(col.insertOne({ id: 'absent-again' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('plain unique still separates distinct real values', async () => {
    const col = new MemoryCollection<HashDoc>(UNIQUE_INDEXES['sessions'] ?? []);
    await col.insertOne({ id: 'a', refreshHash: 'hash-a' });
    await col.insertOne({ id: 'b', refreshHash: 'hash-b' });
    await expect(col.insertOne({ id: 'c', refreshHash: 'hash-a' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

/**
 * The declaration-site guard, checked by `tsc` rather than by vitest. Declaring
 * a PLAIN unique index over a nullable field is the mistake that started all of
 * this; UniqueIndexSpecFor makes it un-declarable. If that ever stops being
 * true, the directive below becomes an unused-@ts-expect-error and typecheck
 * fails — so the guard cannot be quietly weakened.
 */
const _plainIndexOverANullableFieldIsATypeError: ReadonlyArray<
  UniqueIndexSpecFor<PushSubDoc>
> = [
  // @ts-expect-error `endpoint` is `string | null`, so a plain unique index
  // would give every expo row the same null key. It must be partialOnString.
  { keys: ['endpoint'] },
];
