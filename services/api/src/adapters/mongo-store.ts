/**
 * MongoDB StorePort. Filters and patches stay inside the DSL subset defined
 * in ports.ts, so they pass through to the driver nearly verbatim — the only
 * translation is `id` ⇔ `_id` on the way in and out. MemoryStore is the
 * behavioral reference; keep the two in lockstep.
 */
import { MongoClient, MongoServerError } from 'mongodb';
import type { Collection, Document } from 'mongodb';
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
  PlaylistDoc,
  PushSubDoc,
  ReportDoc,
  RoomDoc,
  SessionDoc,
  StorePort,
  SubscriptionDoc,
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
  readonly cursors: DocCollection<CursorDoc>;
  readonly playlists: DocCollection<PlaylistDoc>;
  readonly assets: DocCollection<AssetDoc>;
  readonly subscriptions: DocCollection<SubscriptionDoc>;
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
    this.cursors = wrap<CursorDoc>('cursors');
    this.playlists = wrap<PlaylistDoc>('playlists');
    this.assets = wrap<AssetDoc>('assets');
    this.subscriptions = wrap<SubscriptionDoc>('subscriptions');
    this.reports = wrap<ReportDoc>('reports');
    this.usage = wrap<UsageDoc>('usage');
    this.pushSubs = wrap<PushSubDoc>('pushSubs');
  }

  async init(): Promise<void> {
    await this.client.connect();
    const db = this.client.db(this.dbName);

    // Unique indexes shared with MemoryStore (UNIQUE_INDEXES is the spec).
    for (const [name, specs] of Object.entries(UNIQUE_INDEXES)) {
      for (const spec of specs) {
        await db
          .collection(name)
          .createIndex(Object.fromEntries(spec.keys.map((key) => [key, 1])), {
            unique: true,
            ...(spec.sparse === true ? { sparse: true } : {}),
          });
      }
    }

    // Non-unique secondaries for the hot query paths.
    await db.collection('messages').createIndex({ roomId: 1, seq: -1 });
    await db.collection('messages').createIndex({ body: 'text' });
    await db.collection('members').createIndex({ userId: 1 });
    await db.collection('sessions').createIndex({ userId: 1 });
    // TTL: mongo deletes auth tokens as they expire.
    await db.collection('authTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('assets').createIndex({ ownerId: 1 });
    await db.collection('usage').createIndex({ userId: 1, at: -1 });
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
