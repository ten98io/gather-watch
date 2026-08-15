/**
 * MongoDB AssetStore. Shares the api's MONGO_URL and `assets` collection —
 * AssetDoc maps `id` ⇔ `_id` exactly like the api's MongoStore, so both
 * services interoperate on the same documents. The media service only ever
 * touches the `assets` collection.
 */
import { MongoClient, MongoServerError } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import { AppError } from '../lib/errors';
import type { AssetDoc, AssetPage, AssetStore } from './ports';
import { decodeCursor, encodeCursor } from './ports';

/** Strip `id` and store it as the driver's `_id` primary key. */
function toMongoDoc(doc: AssetDoc): Document {
  const { id, ...rest } = doc;
  return { _id: id, ...rest };
}

/** Rebuild the domain doc: `_id` becomes `id` again. */
function fromMongoDoc(doc: Document | null): AssetDoc | null {
  if (doc === null) return null;
  const { _id, ...rest } = doc;
  // Cast forced by the driver's schemaless Document return type; the shape
  // is AssetDoc by construction (we wrote it that way).
  return { id: String(_id), ...rest } as AssetDoc;
}

/** Db name comes from the connection-string path when present. */
function dbNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path === '' ? 'playin' : path;
  } catch {
    return 'playin';
  }
}

/** `{ _id: id }` as a driver filter (the driver's Document types `_id` as
 *  ObjectId by default; our ids are strings by construction). */
function byId(id: string): Document {
  return { _id: id };
}

export class MongoAssetStore implements AssetStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private readonly col: Collection;
  /** The api's billing collection (id = userId) — read-only here, for
   *  entitlement-aware quotas. */
  private readonly subs: Collection;

  constructor(url: string, dbName?: string) {
    this.client = new MongoClient(url);
    this.dbName = dbName ?? dbNameFromUrl(url);
    // client.db() is usable before connect(); operations queue until init().
    this.col = this.client.db(this.dbName).collection('assets');
    this.subs = this.client.db(this.dbName).collection('subscriptions');
  }

  async init(): Promise<void> {
    await this.client.connect();
    // Same index the api's MongoStore ensures — createIndex is idempotent.
    await this.col.createIndex({ ownerId: 1 });
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

  async findById(id: string): Promise<AssetDoc | null> {
    return fromMongoDoc(await this.col.findOne(byId(id)));
  }

  async insert(doc: AssetDoc): Promise<void> {
    try {
      await this.col.insertOne(toMongoDoc(doc));
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        throw new AppError('CONFLICT', `asset ${doc.id} already exists`);
      }
      throw err;
    }
  }

  async update(id: string, patch: Partial<AssetDoc>): Promise<AssetDoc | null> {
    const { id: _ignored, ...rest } = patch;
    const result = await this.col.findOneAndUpdate(
      byId(id),
      { $set: rest },
      { returnDocument: 'after' },
    );
    return fromMongoDoc(result);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.col.deleteOne(byId(id));
    return result.deletedCount === 1;
  }

  async listByOwner(ownerId: string, limit: number, cursor: string | null): Promise<AssetPage> {
    const after = cursor === null ? null : decodeCursor(cursor);
    const filter: Document = { ownerId };
    if (after !== null) {
      // The domain `id` field is stored as `_id` in Mongo.
      filter.$or = [
        { createdAt: { $lt: after.createdAt } },
        { createdAt: after.createdAt, _id: { $lt: after.id } },
      ];
    }
    // Fetch limit+1 to know whether a next page exists.
    const rows = await this.col
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const docs = rows
      .map((row) => fromMongoDoc(row))
      .filter((doc): doc is AssetDoc => doc !== null);
    const items = docs.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = docs.length > limit && last !== undefined ? encodeCursor(last) : null;
    return { items, nextCursor };
  }

  async usageBytes(ownerId: string): Promise<number> {
    const rows = await this.col
      .aggregate([{ $match: { ownerId } }, { $group: { _id: null, total: { $sum: '$sizeBytes' } } }])
      .toArray();
    const first = rows[0] as { total?: unknown } | undefined;
    return typeof first?.total === 'number' ? first.total : 0;
  }

  async listByStatus(status: AssetDoc['status']): Promise<AssetDoc[]> {
    const rows = await this.col.find({ status }).toArray();
    return rows
      .map((row) => fromMongoDoc(row))
      .filter((doc): doc is AssetDoc => doc !== null);
  }

  /** Premium only while Stripe reports the sub active — the exact rule the
   *  api's billing/entitlements.ts effectivePlan applies to the same row. */
  async planFor(userId: string): Promise<'free' | 'premium'> {
    const sub = (await this.subs.findOne(byId(userId))) as {
      plan?: unknown;
      status?: unknown;
    } | null;
    return sub !== null && sub.plan === 'premium' && sub.status === 'active'
      ? 'premium'
      : 'free';
  }
}
