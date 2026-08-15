/**
 * Upload lifecycle routes (contracts media.createUpload / completeUpload):
 *   POST /uploads            → multipart session + presigned part URLs
 *   POST /uploads/:id/complete → finalize multipart, kick the pipeline
 * Enforces the per-user storage quota and the max-file cap at create time.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AssetId,
  CompleteUploadBody,
  CreateUploadBody,
} from '@playin/contracts';
import type { CreateUploadResponse, MediaAsset } from '@playin/contracts';
import { AppError } from '../lib/errors';
import { newId } from '../lib/tokens';
import { assetKeyPrefix, planParts, sanitizeFilename, serializeAsset } from '../lib/serialize';
import type { AssetDoc } from '../store/ports';
import { requireAuth } from '../plugins/auth';
import { parseWith } from '../plugins/error-mapper';

const GB = 1024 * 1024 * 1024;

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.post('/uploads', async (request): Promise<CreateUploadResponse> => {
    const auth = requireAuth(request);
    const body = parseWith(CreateUploadBody, request.body);
    const { config, store, storage } = app.deps;

    if (body.sizeBytes > config.maxFileSizeGb * GB) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        `file exceeds the ${config.maxFileSizeGb} GB max file size`,
      );
    }
    const used = await store.usageBytes(auth.userId);
    if (used + body.sizeBytes > config.storageQuotaGb * GB) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        `storage quota of ${config.storageQuotaGb} GB exceeded (used ${Math.ceil(
          used / GB,
        )} GB)`,
      );
    }

    const assetId = newId() as AssetId;
    const storageKey = `${assetKeyPrefix(auth.userId, assetId)}/source/${sanitizeFilename(
      body.filename,
    )}`;
    const uploadId = await storage.createMultipartUpload(storageKey, body.mime);

    const doc: AssetDoc = {
      id: assetId,
      ownerId: auth.userId,
      filename: body.filename,
      mime: body.mime,
      sizeBytes: body.sizeBytes,
      status: 'uploading',
      hlsUrl: null,
      thumbnailUrl: null,
      waveformUrl: null,
      durationMs: null,
      error: null,
      createdAt: Date.now(),
      storageKey,
      uploadId,
    };
    try {
      await store.insert(doc);
    } catch (err) {
      // Don't leak an orphaned multipart session when the doc write fails.
      await storage.abortMultipartUpload(storageKey, uploadId).catch(() => undefined);
      throw err;
    }

    return {
      assetId,
      uploadId,
      parts: planParts(body.sizeBytes, config.uploadPartSizeMb).map((part) => ({
        partNumber: part.partNumber,
        url: storage.presignUploadPart(storageKey, uploadId, part.partNumber),
        startByte: part.startByte,
        endByte: part.endByte,
      })),
    };
  });

  app.post('/uploads/:id/complete', async (request): Promise<{ asset: MediaAsset }> => {
    const auth = requireAuth(request);
    const params = parseWith(z.object({ id: AssetId }), request.params);
    const body = parseWith(CompleteUploadBody, request.body);
    if (body.assetId !== params.id) {
      throw new AppError('VALIDATION', 'body assetId does not match the path id');
    }
    const { store, storage, pipeline } = app.deps;

    const doc = await store.findById(params.id);
    if (doc === null) {
      throw new AppError('NOT_FOUND', 'asset not found');
    }
    if (doc.ownerId !== auth.userId) {
      throw new AppError('FORBIDDEN', 'only the owner can complete an upload');
    }
    if (doc.uploadId === null || doc.uploadId !== body.uploadId) {
      throw new AppError('VALIDATION', 'uploadId does not match');
    }

    // Idempotent: a replayed complete for an already-finalized upload just
    // returns the current asset (never re-runs the pipeline).
    if (doc.status !== 'uploading') {
      return { asset: serializeAsset(doc) };
    }
    if (body.parts.length === 0 || doc.storageKey === null) {
      throw new AppError('VALIDATION', 'multipart upload has no parts');
    }

    await storage.completeMultipartUpload(doc.storageKey, body.uploadId, body.parts);
    const updated = await store.update(doc.id, { status: 'processing' });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'asset not found');
    }
    pipeline.enqueue(doc.id);
    return { asset: serializeAsset(updated) };
  });
};
