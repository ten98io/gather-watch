/**
 * Library routes (contracts media.listLibrary / renameAsset / deleteAsset):
 *   GET    /library          → caller's assets, newest first, cursor-paginated
 *   PATCH  /library/:id      → rename (owner only)
 *   DELETE /library/:id      → remove doc + all stored objects (owner only)
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AssetId, ListLibraryQuery, RenameAssetBody } from '@gather/contracts';
import type { MediaAsset } from '@gather/contracts';
import { AppError } from '../lib/errors';
import { artifactKeyPrefix, assetKeyPrefix, serializeAsset } from '../lib/serialize';
import type { AssetDoc } from '../store/ports';
import { requireUser } from '../plugins/auth';
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
      const auth = requireUser(request);
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
    const auth = requireUser(request);
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
    const auth = requireUser(request);
    const params = parseWith(z.object({ id: AssetId }), request.params);
    const { store, storage } = app.deps;
    const doc = await ownedAsset(store, auth, params.id);
    // The pipeline may still be writing artifacts under this prefix; deleting
    // now would orphan whatever it PUTs after our prefix listing. Processing
    // always settles (boot reconciliation re-kicks zombies), so make the
    // caller retry rather than leak unreachable objects.
    if (doc.status === 'processing') {
      throw new AppError('CONFLICT', 'asset is processing; retry once it settles');
    }

    // Best-effort storage cleanup; the doc delete is authoritative.
    if (doc.status === 'uploading' && doc.storageKey !== null && doc.uploadId !== null) {
      await storage.abortMultipartUpload(doc.storageKey, doc.uploadId).catch((err: unknown) => {
        request.log.warn({ err, assetId: doc.id }, 'failed to abort multipart upload');
      });
    }
    await storage.deletePrefix(assetKeyPrefix(doc.ownerId, doc.id)).catch((err: unknown) => {
      request.log.warn({ err, assetId: doc.id }, 'failed to delete asset objects');
    });
    await storage.deletePrefix(artifactKeyPrefix(doc.ownerId, doc.id)).catch((err: unknown) => {
      request.log.warn({ err, assetId: doc.id }, 'failed to delete asset artifacts');
    });
    await store.remove(doc.id);
    return { ok: true };
  });
};
