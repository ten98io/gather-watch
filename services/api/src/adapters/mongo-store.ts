/**
 * MongoDB StorePort. Filters and patches stay inside the DSL subset defined
 * in ports.ts, so they pass through to the driver nearly verbatim — the only
 * translation is `id` ⇔ `_id` on the way in and out. MemoryStore is the
 * behavioral reference; keep the two in lockstep.
 */
import { MongoClient, MongoServerError } from 'mongodb';
import type { Collection, CreateIndexesOptions, Db, Document } from 'mongodb';
import { AppError } from '../lib/errors';
import { UNIQUE_INDEXES } from './ports';
import type {
  AssetDoc,
  AuthTokenDoc,
  CursorDoc,
  DocCollection,
  EventDoc,
  Filter,
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

/** Strip `id` and store it as the driver's `_id` primary key. */
function toMongoDoc<T extends { id: string }>(doc: T): StoredDoc {
  const { id, ...rest } = doc;
  return { _id: id, ...rest };
}

/** Rebuild the domain doc: `_id` becomes `id` again. */
function fromMongoDoc<T>(doc: Document | null): T | null {
  if (doc === null) return null;
  const { _id, ...rest } = doc;
  // Cast forced by the driver's schemaless Document return type; the shape
  // is T by construction (we wrote it that way).
  return { id: String(_id), ...rest } as T;
}

/** The DSL is a mongo subset by construction; only the `id` key is renamed. */
function toMongoFilter<T>(filter: Filter<T>): Document {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    out[key === 'id' ? '_id' : key] = value;
  }
  return out;
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/** Stored shape: every doc carries a string `_id` (the domain `id`). Typing
 *  the collection this way keeps the driver from defaulting `_id` to
 *  ObjectId in its Filter generics. */
type StoredDoc = Document & { _id: string };

class MongoCollection<T extends { id: string }> implements DocCollection<T> {
  constructor(private readonly collection: Collection<StoredDoc>) {}

  async findById(id: string): Promise<T | null> {
    return fromMongoDoc<T>(await this.collection.findOne({ _id: id }));
  }

  async findOne(filter: Filter<T>): Promise<T | null> {
    return fromMongoDoc<T>(await this.collection.findOne(toMongoFilter(filter)));
  }

  async findMany(filter: Filter<T>, opts: FindOptions<T> = {}): Promise<T[]> {
    let cursor = this.collection.find(toMongoFilter(filter));
    if (opts.sort !== undefined) {
      cursor = cursor.sort(
        Object.fromEntries(opts.sort.map(([key, direction]) => [key === 'id' ? '_id' : key, direction])),
      );
    }
    if (opts.skip !== undefined) cursor = cursor.skip(opts.skip);
    if (opts.limit !== undefined) cursor = cursor.limit(opts.limit);
    const docs = await cursor.toArray();
    return docs.map((doc) => fromMongoDoc<T>(doc)) as T[];
  }

  async count(filter: Filter<T>): Promise<number> {
    return this.collection.countDocuments(toMongoFilter(filter));
  }

  async insertOne(doc: T): Promise<T> {
    try {
      await this.collection.insertOne(toMongoDoc(doc));
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new AppError('CONFLICT', `Duplicate key in insert (id '${doc.id}')`);
      }
      throw err;
    }
    return doc;
  }

  /** `_id` is immutable in Mongo, so an `id` patch is a caller bug. */
  private assertPatch(patch: Partial<T>): void {
    if ('id' in patch) {
      throw new AppError('VALIDATION', 'Patches must not contain id');
    }
  }

  async updateOne(filter: Filter<T>, patch: Partial<T>): Promise<T | null> {
    this.assertPatch(patch);
    try {
      const updated = await this.collection.findOneAndUpdate(
        toMongoFilter(filter),
        { $set: patch },
        { returnDocument: 'after' },
      );
      return fromMongoDoc<T>(updated);
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new AppError('CONFLICT', 'Unique index violation on update');
      }
      throw err;
    }
  }

  async updateMany(filter: Filter<T>, patch: Partial<T>): Promise<number> {
    this.assertPatch(patch);
    try {
      const result = await this.collection.updateMany(toMongoFilter(filter), { $set: patch });
      return result.modifiedCount;
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new AppError('CONFLICT', 'Unique index violation on update');
      }
      throw err;
    }
  }

  async deleteOne(filter: Filter<T>): Promise<boolean> {
    const result = await this.collection.deleteOne(toMongoFilter(filter));
    return result.deletedCount > 0;
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    const result = await this.collection.deleteMany(toMongoFilter(filter));
    return result.deletedCount;
  }
}

/** Db name comes from the connection-string path when present. */
function dbNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path === '' ? 'gather' : path;
  } catch {
    return 'gather';
  }
}

// ── Index management ─────────────────────────────────────────────────────────

/** A Mongo index key pattern: field → direction, or an index type for the
 *  non-btree kinds ('text'). */
type IndexKeyPattern = Record<string, 1 | -1 | 'text'>;

/** "Index already exists with different options" (85) and "…with a different
 *  key spec" (86) — the two ways createIndex refuses to redefine in place. */
const INDEX_CONFLICT_CODES: ReadonlySet<number> = new Set([85, 86]);

/**
 * The key pattern and driver options for one unique index.
 *
 * `sparse` is deliberately NEVER emitted. It omits a document only when the
 * field is ABSENT, so a field present with BSON null still gets an index entry
 * (key value null) and the second row written that way collides — which is
 * every guest after the first. See UniqueIndexSpec in ports.ts.
 *
 * Exported because this object is the only part of the Mongo half a test can
 * check without a running mongod: it pins WHAT WE ASK MONGO FOR.
 */
export function uniqueIndexDefinition(spec: UniqueIndexSpec): {
  keys: IndexKeyPattern;
  options: CreateIndexesOptions;
} {
  const keys: IndexKeyPattern = Object.fromEntries(spec.keys.map((key) => [key, 1] as const));
  if (spec.partialOnString !== true) {
    return { keys, options: { unique: true } };
  }
  return {
    keys,
    options: {
      unique: true,
      // `$type: 'string'` and not `$exists: true`: an explicitly-null field DOES
      // exist, so $exists would index it and put back the collision this index
      // is here to remove. Lookups that use this index compare against a string
      // (`findOne({ email })`), which implies the filter, so the planner can
      // still serve them from it.
      partialFilterExpression: { [spec.keys[0]]: { $type: 'string' } },
    },
  };
}

/** Same fields, same order, same directions ⇒ Mongo considers it the same
 *  index and will not redefine it. Note that a TEXT index reports its key as
 *  `{ _fts: 'text', _ftsx: 1 }` rather than the fields it was built from, so it
 *  never matches here: a conflicting text index is re-thrown with Mongo's own
 *  message instead of being silently replaced, which for the one text index we
 *  have is the behavior worth keeping. */
function sameKeyPattern(existing: Document, wanted: IndexKeyPattern): boolean {
  const existingEntries = Object.entries(existing);
  const wantedEntries = Object.entries(wanted);
  return (
    existingEntries.length === wantedEntries.length &&
    existingEntries.every(([field, direction], position) => {
      const want = wantedEntries[position];
      return want !== undefined && want[0] === field && want[1] === direction;
    })
  );
}

/**
 * createIndex, but able to REPLACE an index whose options changed.
 *
 * Mongo will not redefine an index in place — same keys, different options is
 * error 85/86 and it throws. Every database created before the sparse→partial
 * fix carries the old sparse index, so a plain createIndex would crash init()
 * on boot and the fix would reach only the deployments that never needed it.
 * Drop the conflicting index and recreate instead, matched by KEY PATTERN
 * because the old one was created without a name and carries the driver's
 * generated default.
 *
 * The recreate cannot fail on existing data: the partial index covers a SUBSET
 * of the rows the sparse one covered (strings only, versus strings plus every
 * explicit null), so anything the old index accepted the new one accepts too.
 */
async function ensureIndex(
  db: Db,
  collectionName: string,
  keys: IndexKeyPattern,
  options: CreateIndexesOptions = {},
): Promise<void> {
  const collection = db.collection(collectionName);
  try {
    await collection.createIndex(keys, options);
    return;
  } catch (err) {
    if (!(err instanceof MongoServerError) || !INDEX_CONFLICT_CODES.has(Number(err.code))) {
      throw err;
    }
  }
  for (const existing of await collection.listIndexes().toArray()) {
    // Never the primary key, whatever its options claim.
    if (existing['name'] !== '_id_' && sameKeyPattern(existing['key'] as Document, keys)) {
      await collection.dropIndex(String(existing['name']));
    }
  }
  await collection.createIndex(keys, options);
}

export class MongoStore implements StorePort {
  private readonly client: MongoClient;
  private readonly dbName: string;

  readonly users: DocCollection<UserDoc>;
  readonly sessions: DocCollection<SessionDoc>;
  readonly authTokens: DocCollection<AuthTokenDoc>;
  readonly rooms: DocCollection<RoomDoc>;
  readonly members: DocCollection<MemberDoc>;
  readonly invites: DocCollection<InviteDoc>;
  readonly messages: DocCollection<MessageDoc>;
  readonly events: DocCollection<EventDoc>;
  readonly playbackHistory: DocCollection<PlaybackHistoryDoc>;
  readonly cursors: DocCollection<CursorDoc>;
  readonly playlists: DocCollection<PlaylistDoc>;
  readonly assets: DocCollection<AssetDoc>;
  readonly reports: DocCollection<ReportDoc>;
  readonly usage: DocCollection<UsageDoc>;
  readonly pushSubs: DocCollection<PushSubDoc>;

  constructor(url: string, dbName?: string) {
    this.client = new MongoClient(url);
    this.dbName = dbName ?? dbNameFromUrl(url);
    // client.db() is usable before connect(); operations queue until init().
    const db = this.client.db(this.dbName);
    const wrap = <T extends { id: string }>(name: string): DocCollection<T> =>
      new MongoCollection<T>(db.collection<StoredDoc>(name));
    this.users = wrap<UserDoc>('users');
    this.sessions = wrap<SessionDoc>('sessions');
    this.authTokens = wrap<AuthTokenDoc>('authTokens');
    this.rooms = wrap<RoomDoc>('rooms');
    this.members = wrap<MemberDoc>('members');
    this.invites = wrap<InviteDoc>('invites');
    this.messages = wrap<MessageDoc>('messages');
    this.events = wrap<EventDoc>('events');
    this.playbackHistory = wrap<PlaybackHistoryDoc>('playbackHistory');
    this.cursors = wrap<CursorDoc>('cursors');
    this.playlists = wrap<PlaylistDoc>('playlists');
    this.assets = wrap<AssetDoc>('assets');
    this.reports = wrap<ReportDoc>('reports');
    this.usage = wrap<UsageDoc>('usage');
    this.pushSubs = wrap<PushSubDoc>('pushSubs');
  }

  async init(): Promise<void> {
    await this.client.connect();
    const db = this.client.db(this.dbName);

    // Unique indexes shared with MemoryStore (UNIQUE_INDEXES is the spec).
    // Everything goes through ensureIndex so a changed option is a REPLACEMENT
    // rather than a boot crash on any database that predates the change.
    for (const [name, specs] of Object.entries(UNIQUE_INDEXES)) {
      for (const spec of specs) {
        const { keys, options } = uniqueIndexDefinition(spec);
        await ensureIndex(db, name, keys, options);
      }
    }

    // Non-unique secondaries for the hot query paths. Duplicate keys are fine
    // in all of these, so a null key costs nothing but a wasted entry.
    await ensureIndex(db, 'messages', { roomId: 1, seq: -1 });
    await ensureIndex(db, 'messages', { body: 'text' });
    await ensureIndex(db, 'members', { userId: 1 });
    // Drives the idle-room sweep's candidate scan (oldest rooms first).
    await ensureIndex(db, 'rooms', { createdAt: 1 });
    await ensureIndex(db, 'sessions', { userId: 1 });
    // NOT a working TTL, despite the option. Mongo's TTL monitor only deletes
    // documents whose indexed field is a BSON Date (or an array of them), and
    // AuthTokenDoc.expiresAt is an epoch NUMBER — so nothing is ever expired
    // and used magic-link tokens accumulate forever. Kept, rather than quietly
    // dropped, because the index is right and only the stored TYPE is wrong;
    // making the sweep real means giving the doc a Date field, which belongs to
    // the auth module and not to this adapter.
    await ensureIndex(db, 'authTokens', { expiresAt: 1 }, { expireAfterSeconds: 0 });
    await ensureIndex(db, 'assets', { ownerId: 1 });
    await ensureIndex(db, 'usage', { userId: 1, at: -1 });
    // Drives the room-history read (newest first) and its per-room prune.
    await ensureIndex(db, 'playbackHistory', { roomId: 1, seq: -1 });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.db(this.dbName).command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /** Atomic via findOneAndUpdate+$inc — the one cross-step primitive callers
   *  can build monotonic event seqs on. */
  async nextSeq(scope: string): Promise<number> {
    type CounterDoc = { _id: string; value: number };
    const doc = await this.client
      .db(this.dbName)
      .collection<CounterDoc>('counters')
      .findOneAndUpdate(
        { _id: scope },
        { $inc: { value: 1 } },
        { upsert: true, returnDocument: 'after' },
      );
    // upsert + returnDocument 'after' always yields the doc; the ?? 1 only
    // appeases the driver's nullable return type.
    return doc?.value ?? 1;
  }

  async searchMessages(roomId: string, query: string, limit: number): Promise<MessageDoc[]> {
    const docs = await this.client
      .db(this.dbName)
      .collection('messages')
      .find({ $text: { $search: query }, roomId, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => fromMongoDoc<MessageDoc>(doc)) as MessageDoc[];
  }
}
