/**
 * Library routes (contracts media.listLibrary / renameAsset / deleteAsset):
 *   GET    /library          → caller's assets, newest first, cursor-paginated
 *   PATCH  /library/:id      → rename (owner only)
 *   DELETE /library/:id      → remove doc + all stored objects (owner only)
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AssetId, ListLibraryQuery, RenameAssetBody } from '@playin/contracts';
import type { MediaAsset } from '@playin/contracts';
import { AppError } from '../lib/errors';
import { assetKeyPrefix, serializeAsset } from '../lib/serialize';
import type { AssetDoc } from '../store/ports';
import { requireAuth } from '../plugins/auth';
import { parseWith } from '../plugins/error-mapper';
import type { AuthContext } from '../deps';

/** findById + ownership check shared by rename/delete. */
async function ownedAsset(
  store: { findById(id: string): Promise<AssetDoc | null> },
  auth: AuthContext,
  id: string,
): Promise<AssetDoc> {
  const doc = await store.findById(id);
  if (doc === null) {
    throw new AppError('NOT_FOUND', 'asset not found');
  }
  if (doc.ownerId !== auth.userId) {
    throw new AppError('FORBIDDEN', 'only the owner can modify an asset');
  }
  return doc;
}

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/library',
    async (request): Promise<{ items: MediaAsset[]; nextCursor: string | null }> => {
      const auth = requireAuth(request);
      const query = parseWith(ListLibraryQuery, request.query);
      const page = await app.deps.store.listByOwner(
        auth.userId,
        query.limit,
        query.cursor ?? null,
      );
      return { items: page.items.map(serializeAsset), nextCursor: page.nextCursor };
    },
  );

  app.patch('/library/:id', async (request): Promise<{ asset: MediaAsset }> => {
    const auth = requireAuth(request);
    const params = parseWith(z.object({ id: AssetId }), request.params);
    const body = parseWith(RenameAssetBody, request.body);
    const doc = await ownedAsset(app.deps.store, auth, params.id);
    const updated = await app.deps.store.update(doc.id, { filename: body.filename });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'asset not found');
    }
    return { asset: serializeAsset(updated) };
  });

  app.delete('/library/:id', async (request): Promise<{ ok: true }> => {
    const auth = requireAuth(request);
    const params = parseWith(z.object({ id: AssetId }), request.params);
    const { store, storage } = app.deps;
    const doc = await ownedAsset(store, auth, params.id);

    // Best-effort storage cleanup; the doc delete is authoritative.
    if (doc.status === 'uploading' && doc.storageKey !== null && doc.uploadId !== null) {
      await storage.abortMultipartUpload(doc.storageKey, doc.uploadId).catch((err: unknown) => {
        request.log.warn({ err, assetId: doc.id }, 'failed to abort multipart upload');
      });
    }
    await storage.deletePrefix(assetKeyPrefix(doc.ownerId, doc.id)).catch((err: unknown) => {
      request.log.warn({ err, assetId: doc.id }, 'failed to delete asset objects');
    });
    await store.remove(doc.id);
    return { ok: true };
  });
};
