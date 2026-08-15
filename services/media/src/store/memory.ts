/**
 * In-memory AssetStore — the behavioral reference and the test adapter.
 * Selected automatically when MONGO_URL is unset (see store/index.ts).
 */
import { AppError } from '../lib/errors';
import type { AssetDoc, AssetPage, AssetStore } from './ports';
import { decodeCursor, encodeCursor } from './ports';

/** createdAt DESC, id DESC — must stay in lockstep with MongoAssetStore. */
function compareDocs(a: AssetDoc, b: AssetDoc): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : -1;
}

export class MemoryAssetStore implements AssetStore {
  private readonly docs = new Map<string, AssetDoc>();
  /** Test seam for planFor — no subscriptions collection in memory mode. */
  readonly plans = new Map<string, 'free' | 'premium'>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async ping(): Promise<boolean> {
    return true;
  }

  async findById(id: string): Promise<AssetDoc | null> {
    const doc = this.docs.get(id);
    return doc === undefined ? null : { ...doc };
  }

  async insert(doc: AssetDoc): Promise<void> {
    if (this.docs.has(doc.id)) {
      throw new AppError('CONFLICT', `asset ${doc.id} already exists`);
    }
    this.docs.set(doc.id, { ...doc });
  }

  async update(id: string, patch: Partial<AssetDoc>): Promise<AssetDoc | null> {
    const doc = this.docs.get(id);
    if (doc === undefined) return null;
    const updated = { ...doc, ...patch, id: doc.id };
    this.docs.set(id, updated);
    return { ...updated };
  }

  async remove(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  async listByOwner(ownerId: string, limit: number, cursor: string | null): Promise<AssetPage> {
    const after = cursor === null ? null : decodeCursor(cursor);
    const owned = [...this.docs.values()]
      .filter((doc) => doc.ownerId === ownerId)
      .sort(compareDocs);
    const filtered =
      after === null
        ? owned
        : owned.filter(
            (doc) =>
              doc.createdAt < after.createdAt ||
              (doc.createdAt === after.createdAt && doc.id < after.id),
          );
    const items = filtered.slice(0, limit).map((doc) => ({ ...doc }));
    const last = items[items.length - 1];
    const nextCursor =
      filtered.length > limit && last !== undefined ? encodeCursor(last) : null;
    return { items, nextCursor };
  }

  async usageBytes(ownerId: string): Promise<number> {
    let total = 0;
    for (const doc of this.docs.values()) {
      if (doc.ownerId === ownerId) total += doc.sizeBytes;
    }
    return total;
  }

  async listByStatus(status: AssetDoc['status']): Promise<AssetDoc[]> {
    return [...this.docs.values()]
      .filter((doc) => doc.status === status)
      .map((doc) => ({ ...doc }));
  }

  async planFor(userId: string): Promise<'free' | 'premium'> {
    return this.plans.get(userId) ?? 'free';
  }
}
