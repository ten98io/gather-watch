/**
 * Asset-store port: the media service's narrow view of persistence. The Mongo
 * implementation shares the api's MONGO_URL and the `assets` collection, and
 * AssetDoc is EXACTLY the api's shape (contracts MediaAsset + object-storage
 * bookkeeping) so both services read/write the same documents.
 */
import type { MediaAsset } from '@playin/contracts';

/** Contracts asset + object-storage bookkeeping (same as api's AssetDoc). */
export type AssetDoc = MediaAsset & {
  storageKey: string | null;
  uploadId: string | null;
};

export interface AssetPage {
  items: AssetDoc[];
  nextCursor: string | null;
}

/**
 * Sort order for listByOwner: createdAt DESC, id DESC (deterministic tiebreak).
 * The cursor is opaque to callers: base64url(`${createdAt}:${id}`) of the last
 * item of the previous page.
 */
export interface AssetStore {
  /** Connect and ensure indexes. Must be called before any other method. */
  init(): Promise<void>;
  close(): Promise<void>;
  /** Backing-store liveness (drives /readyz). */
  ping(): Promise<boolean>;

  findById(id: string): Promise<AssetDoc | null>;
  /** Throws AppError('CONFLICT') on duplicate id. */
  insert(doc: AssetDoc): Promise<void>;
  /** Shallow patch; returns the updated doc, or null when nothing matched. */
  update(id: string, patch: Partial<AssetDoc>): Promise<AssetDoc | null>;
  remove(id: string): Promise<boolean>;
  listByOwner(ownerId: string, limit: number, cursor: string | null): Promise<AssetPage>;
  /** Sum of sizeBytes over ALL of the owner's assets — quota accounting.
   *  Failed/orphaned rows count too (conservative: abuse via repeatedly
   *  created-then-failed uploads still consumes quota until deleted). */
  usageBytes(ownerId: string): Promise<number>;
  /** Every asset currently in `status` — boot reconciliation re-enqueues
   *  assets stranded in 'processing' by a crash/redeploy. */
  listByStatus(status: AssetDoc['status']): Promise<AssetDoc[]>;
  /** Billing plan for entitlement-aware quotas: the Mongo store reads the
   *  api's shared `subscriptions` collection (id = userId, premium only
   *  while status is 'active' — same rule as the api's effectivePlan); the
   *  memory store defaults everyone to 'free'. */
  planFor(userId: string): Promise<'free' | 'premium'>;
}

export function encodeCursor(doc: AssetDoc): string {
  return Buffer.from(`${doc.createdAt}:${doc.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf(':');
    if (sep <= 0) return null;
    const createdAt = Number(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (!Number.isInteger(createdAt) || createdAt < 0 || id === '') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
