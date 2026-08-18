/**
 * In-memory StorePort. This is the REFERENCE implementation of the query DSL
 * from ports.ts — the test suite pins behavior against MemoryStore and
 * MongoStore must match it — so keep the matcher/sort semantics below in
 * lockstep with the DSL doc comments.
 *
 * Docs are deep-cloned on the way in AND on the way out: callers must never
 * be able to mutate stored state (or each other's reads) through a shared
 * reference, which is exactly what a real database gives you for free.
 */
import { AppError } from '../lib/errors';
import { indexKeyOf, UNIQUE_INDEXES } from './ports';
import type {
  AssetDoc,
  AuthTokenDoc,
  CursorDoc,
  DocCollection,
  EventDoc,
  Filter,
  FilterOps,
  FindOptions,
  InviteDoc,
  MemberDoc,
  MessageDoc,
  PlaybackHistoryDoc,
  PlaylistDoc,
  PushSubDoc,
  ReportDoc,
  RoomDoc,
  SessionDoc,
  StorePort,
  UniqueIndexSpec,
  UsageDoc,
  UserDoc,
} from './ports';

/** A filter value is an ops object only when EVERY key starts with '$'
 *  (an empty object literal is a literal match for `{}`). */
function isOpsObject(value: unknown): value is FilterOps<unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

/** Structural equality for literal matching; arrays compare element-wise. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => key in bRecord && deepEqual(aRecord[key], bRecord[key]))
  );
}

/** Comparisons only match when both operands share an ordered type
 *  (number/number or string/string) — matching the DSL doc, not Mongo's
 *  cross-type BSON ordering. */
function compare(op: '$lt' | '$lte' | '$gt' | '$gte', value: unknown, operand: unknown): boolean {
  const comparable =
    (typeof value === 'number' && typeof operand === 'number') ||
    (typeof value === 'string' && typeof operand === 'string');
  if (!comparable) return false;
  switch (op) {
    case '$lt':
      return value < operand;
    case '$lte':
      return value <= operand;
    case '$gt':
      return value > operand;
    case '$gte':
      return value >= operand;
  }
}

function matchOps(value: unknown, ops: FilterOps<unknown>): boolean {
  return Object.entries(ops).every(([op, operand]) => {
    switch (op) {
      case '$eq':
        return deepEqual(value, operand);
      case '$ne':
        return !deepEqual(value, operand);
      case '$lt':
      case '$lte':
      case '$gt':
      case '$gte':
        return compare(op, value, operand);
      case '$in':
        return Array.isArray(operand) && operand.some((item) => deepEqual(value, item));
      case '$nin':
        return Array.isArray(operand) && !operand.some((item) => deepEqual(value, item));
      case '$exists':
        return (value !== undefined) === operand;
      default:
        // Outside the DSL subset — match nothing rather than guess.
        return false;
    }
  });
}

function matches<T>(doc: T, filter: Filter<T>): boolean {
  const record = doc as Record<string, unknown>;
  return Object.entries(filter).every(([key, condition]) => {
    const value = record[key];
    return isOpsObject(condition) ? matchOps(value, condition) : deepEqual(value, condition);
  });
}

/** null/undefined sort FIRST ascending (and last descending), per ports.ts. */
function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

/**
 * One Map-backed collection enforcing duplicate-id and the collection's
 * UNIQUE_INDEXES entries. Exported so tests can exercise the DSL directly.
 */
export class MemoryCollection<T extends { id: string }> implements DocCollection<T> {
  private readonly docs = new Map<string, T>();

  constructor(private readonly uniqueSpecs: ReadonlyArray<UniqueIndexSpec> = []) {}

  private clone(doc: T): T {
    return structuredClone(doc);
  }

  /**
   * Uniqueness by Mongo's rule, not by whatever is convenient in a Map: which
   * documents an index covers, and what key they contribute, is decided by the
   * shared indexKeyOf() so this adapter cannot drift from the real one. A doc
   * with no index entry (null key) collides with nothing — including with
   * other docs that also have no entry.
   */
  private checkUnique(candidate: T, excludeId?: string): void {
    const record = candidate as Record<string, unknown>;
    for (const spec of this.uniqueSpecs) {
      const key = indexKeyOf(spec, record);
      if (key === null) continue;
      for (const other of this.docs.values()) {
        if (excludeId !== undefined && other.id === excludeId) continue;
        const otherKey = indexKeyOf(spec, other as Record<string, unknown>);
        if (otherKey === null) continue;
        if (key.every((value, index) => deepEqual(value, otherKey[index]))) {
          throw new AppError(
            'CONFLICT',
            `Unique index violation on (${spec.keys.join(', ')})`,
          );
        }
      }
    }
  }

  async findById(id: string): Promise<T | null> {
    const doc = this.docs.get(id);
    return doc === undefined ? null : this.clone(doc);
  }

  async findOne(filter: Filter<T>): Promise<T | null> {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return this.clone(doc);
    }
    return null;
  }

  async findMany(filter: Filter<T>, opts: FindOptions<T> = {}): Promise<T[]> {
    let results = [...this.docs.values()].filter((doc) => matches(doc, filter));
    if (opts.sort !== undefined) {
      const sort = opts.sort;
      results = results.sort((a, b) => {
        const aRecord = a as Record<string, unknown>;
        const bRecord = b as Record<string, unknown>;
        for (const [key, direction] of sort) {
          const order = compareValues(aRecord[key], bRecord[key]);
          if (order !== 0) return order * direction;
        }
        return 0;
      });
    }
    if (opts.skip !== undefined) results = results.slice(opts.skip);
    if (opts.limit !== undefined) results = results.slice(0, opts.limit);
    return results.map((doc) => this.clone(doc));
  }

  async count(filter: Filter<T>): Promise<number> {
    let total = 0;
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) total += 1;
    }
    return total;
  }

  async insertOne(doc: T): Promise<T> {
    if (this.docs.has(doc.id)) {
      throw new AppError('CONFLICT', `Duplicate id '${doc.id}'`);
    }
    this.checkUnique(doc);
    this.docs.set(doc.id, this.clone(doc));
    return this.clone(doc);
  }

  /** Rejecting `id` in patches keeps this identical to MongoStore (where
   *  `_id` is immutable) and avoids corrupting the primary-key Map. */
  private assertPatch(patch: Partial<T>): void {
    if ('id' in patch) {
      throw new AppError('VALIDATION', 'Patches must not contain id');
    }
  }

  async updateOne(filter: Filter<T>, patch: Partial<T>): Promise<T | null> {
    this.assertPatch(patch);
    for (const doc of this.docs.values()) {
      if (!matches(doc, filter)) continue;
      const updated = { ...doc, ...this.clonePatch(patch) };
      this.checkUnique(updated, doc.id);
      this.docs.set(doc.id, updated);
      return this.clone(updated);
    }
    return null;
  }

  async updateMany(filter: Filter<T>, patch: Partial<T>): Promise<number> {
    this.assertPatch(patch);
    const targets = [...this.docs.values()].filter((doc) => matches(doc, filter));
    // Check all updates before applying any so a conflict cannot leave the
    // collection half-patched.
    const updated = targets.map((doc) => {
      const next = { ...doc, ...this.clonePatch(patch) };
      this.checkUnique(next, doc.id);
      return next;
    });
    for (const doc of updated) this.docs.set(doc.id, doc);
    return updated.length;
  }

  private clonePatch(patch: Partial<T>): Partial<T> {
    return structuredClone(patch) as Partial<T>;
  }

  async deleteOne(filter: Filter<T>): Promise<boolean> {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return this.docs.delete(doc.id);
    }
    return false;
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    let removed = 0;
    for (const doc of [...this.docs.values()]) {
      if (matches(doc, filter) && this.docs.delete(doc.id)) removed += 1;
    }
    return removed;
  }
}

/**
 * The full StorePort over MemoryCollections. Single-process only, which is
 * why nextSeq can be a plain in-memory increment and still be race-free.
 */
export class MemoryStore implements StorePort {
  readonly users = new MemoryCollection<UserDoc>(UNIQUE_INDEXES['users'] ?? []);
  readonly sessions = new MemoryCollection<SessionDoc>(UNIQUE_INDEXES['sessions'] ?? []);
  readonly authTokens = new MemoryCollection<AuthTokenDoc>(UNIQUE_INDEXES['authTokens'] ?? []);
  readonly rooms = new MemoryCollection<RoomDoc>(UNIQUE_INDEXES['rooms'] ?? []);
  readonly members = new MemoryCollection<MemberDoc>(UNIQUE_INDEXES['members'] ?? []);
  readonly invites = new MemoryCollection<InviteDoc>(UNIQUE_INDEXES['invites'] ?? []);
  readonly messages = new MemoryCollection<MessageDoc>();
  readonly events = new MemoryCollection<EventDoc>(UNIQUE_INDEXES['events'] ?? []);
  readonly playbackHistory = new MemoryCollection<PlaybackHistoryDoc>(
    UNIQUE_INDEXES['playbackHistory'] ?? [],
  );
  readonly cursors = new MemoryCollection<CursorDoc>(UNIQUE_INDEXES['cursors'] ?? []);
  readonly playlists = new MemoryCollection<PlaylistDoc>();
  readonly assets = new MemoryCollection<AssetDoc>();
  readonly reports = new MemoryCollection<ReportDoc>();
  readonly usage = new MemoryCollection<UsageDoc>();
  readonly pushSubs = new MemoryCollection<PushSubDoc>(UNIQUE_INDEXES['pushSubs'] ?? []);

  private readonly seqs = new Map<string, number>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async ping(): Promise<boolean> {
    return true;
  }

  async nextSeq(scope: string): Promise<number> {
    const next = (this.seqs.get(scope) ?? 0) + 1;
    this.seqs.set(scope, next);
    return next;
  }

  /** Case-insensitive substring fallback for Mongo's text index; excludes
   *  deleted messages, newest first — the contract both adapters share. The
   *  substring match is not expressible in the DSL, so it filters post-query. */
  async searchMessages(roomId: string, query: string, limit: number): Promise<MessageDoc[]> {
    const candidates = await this.messages.findMany(
      // Cast: the port signature uses plain string, the doc field is branded.
      { roomId: roomId as MessageDoc['roomId'], deletedAt: null },
      { sort: [['createdAt', -1]] },
    );
    const needle = query.toLowerCase();
    return candidates.filter((doc) => doc.body.toLowerCase().includes(needle)).slice(0, limit);
  }
}
