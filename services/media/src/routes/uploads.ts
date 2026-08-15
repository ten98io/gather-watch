/**
 * Upload lifecycle routes (contracts media.createUpload / completeUpload /
 * refreshUploadParts):
 *   POST /uploads              → multipart session + presigned part URLs
 *   POST /uploads/:id/parts    → re-presign part URLs (long uploads outlive
 *                                the short presign TTL)
 *   POST /uploads/:id/complete → finalize multipart, VERIFY the actual object
 *                                size against caps/quota, kick the pipeline
 *
 * Quota is entitlement-aware (premium = 4x, mirroring the api's billing
 * entitlements) and enforced twice: optimistically at create time against the
 * client-claimed sizeBytes, then authoritatively at complete time against the
 * real object size (presigned part PUTs are UNSIGNED-PAYLOAD, so claimed
 * bytes are untrusted until HEAD confirms them).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AssetId,
  CompleteUploadBody,
  CreateUploadBody,
  RefreshUploadPartsBody,
} from '@playin/contracts';
import type {
  CreateUploadResponse,
  MediaAsset,
  RefreshUploadPartsResponse,
} from '@playin/contracts';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import { newId } from '../lib/tokens';
import { assetKeyPrefix, planParts, sanitizeFilename, serializeAsset } from '../lib/serialize';
import type { AssetDoc, AssetStore } from '../store/ports';
import { requireUser } from '../plugins/auth';
import { parseWith } from '../plugins/error-mapper';

const GB = 1024 * 1024 * 1024;

/** Entitlement-aware quota: premium = 4x, the api's entitlements multiplier. */
async function quotaBytesFor(
  store: AssetStore,
  config: AppConfig,
  userId: string,
): Promise<number> {
  const plan = await store.planFor(userId);
  const quotaGb = plan === 'premium' ? config.storageQuotaGb * 4 : config.storageQuotaGb;
  return quotaGb * GB;
}

/** Presigned part URL set for a session (create + refresh share this). */
function presignParts(
  storage: { presignUploadPart(key: string, uploadId: string, partNumber: number): string },
  config: AppConfig,
  storageKey: string,
  uploadId: string,
  sizeBytes: number,
): CreateUploadResponse['parts'] {
  return planParts(sizeBytes, config.uploadPartSizeMb).map((part) => ({
    partNumber: part.partNumber,
    url: storage.presignUploadPart(storageKey, uploadId, part.partNumber),
    startByte: part.startByte,
    endByte: part.endByte,
  }));
}

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  app.post('/uploads', async (request): Promise<CreateUploadResponse> => {
    const auth = requireUser(request);
    const body = parseWith(CreateUploadBody, request.body);
    const { config, store, storage } = app.deps;

    if (body.sizeBytes > config.maxFileSizeGb * GB) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        `file exceeds the ${config.maxFileSizeGb} GB max file size`,
      );
    }
    const quotaBytes = await quotaBytesFor(store, config, auth.userId);
    const used = await store.usageBytes(auth.userId);
    if (used + body.sizeBytes > quotaBytes) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        `storage quota of ${Math.round(quotaBytes / GB)} GB exceeded (used ${Math.ceil(
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
      parts: presignParts(storage, config, storageKey, uploadId, body.sizeBytes),
    };
  });

  // Re-presign the session's part URLs: multipart part URLs expire after
  // presignTtlSec, so any upload slower than the TTL refreshes here (keeps
  // the TTL short instead of minting day-long signatures at create time).
  app.post('/uploads/:id/parts', async (request): Promise<RefreshUploadPartsResponse> => {
    const auth = requireUser(request);
    const params = parseWith(z.object({ id: AssetId }), request.params);
    const body = parseWith(RefreshUploadPartsBody, request.body);
    const { config, store, storage } = app.deps;

    const doc = await store.findById(params.id);
    if (doc === null) {
      throw new AppError('NOT_FOUND', 'asset not found');
    }
    if (doc.ownerId !== auth.userId) {
      throw new AppError('FORBIDDEN', 'only the owner can refresh upload URLs');
    }
    if (doc.status !== 'uploading') {
      throw new AppError('CONFLICT', 'upload is already finalized');
    }
    if (doc.uploadId === null || doc.uploadId !== body.uploadId || doc.storageKey === null) {
      throw new AppError('VALIDATION', 'uploadId does not match');
    }
    return { parts: presignParts(storage, config, doc.storageKey, doc.uploadId, doc.sizeBytes) };
  });

  app.post('/uploads/:id/complete', async (request): Promise<{ asset: MediaAsset }> => {
    const auth = requireUser(request);
    const params = parseWith(z.object({ id: AssetId }), request.params);
    const body = parseWith(CompleteUploadBody, request.body);
    if (body.assetId !== params.id) {
      throw new AppError('VALIDATION', 'body assetId does not match the path id');
    }
    const { config, store, storage, pipeline } = app.deps;

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
    // Reject garbage part lists here with a readable 400 instead of letting
    // S3 answer InvalidPartOrder as an opaque 500: ascending, unique, and no
    // more parts than the session ever planned.
    const plannedCount = planParts(doc.sizeBytes, config.uploadPartSizeMb).length;
    if (body.parts.length > plannedCount) {
      throw new AppError('VALIDATION', 'more parts than the upload session planned');
    }
    let prevPartNumber = 0;
    for (const part of body.parts) {
      if (part.partNumber <= prevPartNumber) {
        throw new AppError('VALIDATION', 'parts must be unique and in ascending order');
      }
      prevPartNumber = part.partNumber;
    }

    await storage.completeMultipartUpload(doc.storageKey, body.uploadId, body.parts);

    // The claimed sizeBytes was never trusted past planning: part PUTs are
    // UNSIGNED-PAYLOAD with no content-length constraint. HEAD the finalized
    // object and enforce cap + quota against REALITY, then record the actual
    // size so usageBytes stays honest.
    const head = await storage.headObject(doc.storageKey);
    if (head === null) {
      throw new AppError('INTERNAL', 'finalized object missing from storage');
    }
    const quotaBytes = await quotaBytesFor(store, config, auth.userId);
    const usedExcludingThis = (await store.usageBytes(auth.userId)) - doc.sizeBytes;
    if (
      head.sizeBytes > config.maxFileSizeGb * GB ||
      usedExcludingThis + head.sizeBytes > quotaBytes
    ) {
      await storage.deleteObject(doc.storageKey).catch(() => undefined);
      await store.update(doc.id, {
        status: 'failed',
        sizeBytes: 0,
        error: 'uploaded object exceeds the max file size or storage quota',
      });
      throw new AppError(
        'QUOTA_EXCEEDED',
        'uploaded object exceeds the max file size or storage quota',
      );
    }

    const updated = await store.update(doc.id, {
      status: 'processing',
      sizeBytes: head.sizeBytes,
    });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'asset not found');
    }
    pipeline.enqueue(doc.id);
    return { asset: serializeAsset(updated) };
  });
};
