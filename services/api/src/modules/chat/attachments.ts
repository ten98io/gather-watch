/**
 * Chat attachment uploads: entitlement caps, key sanitization, MinIO/S3
 * SigV4 presigned PUT URLs, and upload completion. The billing module isn't
 * built yet — the FREE/PREMIUM constant pair below is the documented interim
 * source of truth for the chat attachment cap (read from the subscriptions
 * collection, which billing will own).
 */
import { createHash, createHmac } from 'node:crypto';
import type {
  AssetId,
  CompleteUploadBody,
  CreateUploadBody,
  CreateUploadResponse,
  MediaAsset,
  RoomId,
  UserId,
} from '@playin/contracts';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { AppConfig } from '../../config';
import type { AssetDoc, StorePort } from '../../adapters/ports';
import type { Deps } from '../types';

export const FREE_ATTACHMENT_MAX_MB = 25;
export const PREMIUM_ATTACHMENT_MAX_MB = 200;

/** Per-user attachment cap: premium+active subscribers get the higher cap. */
export async function attachmentMaxMb(store: StorePort, userId: string): Promise<number> {
  const sub = await store.subscriptions.findById(userId);
  return sub !== null && sub.plan === 'premium' && sub.status === 'active'
    ? PREMIUM_ATTACHMENT_MAX_MB
    : FREE_ATTACHMENT_MAX_MB;
}

/** Storage-safe filename: [A-Za-z0-9._-] only, max 100 chars, never empty. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return cleaned === '' || /^\.+$/.test(cleaned) ? 'file' : cleaned;
}

/** S3 uriEncode: RFC 3986 — encodeURIComponent plus the missing !'()* chars. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * AWS SigV4 query-presigned PUT URL (path-style, MinIO-compatible), region
 * us-east-1, service s3, node:crypto only. Deterministic for a given `now`.
 */
export function presignPutUrl(
  s3: AppConfig['s3'],
  key: string,
  expiresSec = 900,
  now: Date = new Date(),
): string {
  const host = new URL(s3.endpoint).host;
  const encodedKey = key.split('/').map(uriEncode).join('/');
  const canonicalUri = `/${s3.bucket}/${encodedKey}`;
  // 2026-08-15T00:00:00.000Z → 20260815T000000Z
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const credential = `${s3.accessKey}/${dateStamp}/us-east-1/s3/aws4_request`;

  const canonicalQuery = [
    `X-Amz-Algorithm=${uriEncode('AWS4-HMAC-SHA256')}`,
    `X-Amz-Credential=${uriEncode(credential)}`,
    `X-Amz-Date=${uriEncode(amzDate)}`,
    `X-Amz-Expires=${uriEncode(String(expiresSec))}`,
    `X-Amz-SignedHeaders=${uriEncode('host')}`,
  ].join('&');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${dateStamp}/us-east-1/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${s3.secretKey}`, dateStamp), 'us-east-1'), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `${s3.endpoint}/${s3.bucket}/${encodedKey}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Create an upload ticket: entitlement check, AssetDoc in 'uploading' state,
 * and a single presigned PUT part covering the whole object.
 */
export async function createAttachmentTicket(
  deps: Deps,
  roomId: RoomId,
  userId: UserId,
  body: CreateUploadBody,
): Promise<CreateUploadResponse> {
  const cap = await attachmentMaxMb(deps.store, userId);
  if (body.sizeBytes > cap * 1024 * 1024) {
    throw new AppError('QUOTA_EXCEEDED', `attachment exceeds the ${cap} MB plan limit`);
  }
  const assetId = newId() as AssetId;
  const uploadId = newId();
  const storageKey = `chat/${roomId}/${assetId}/${sanitizeFilename(body.filename)}`;
  const asset: AssetDoc = {
    id: assetId,
    ownerId: userId,
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
  await deps.store.assets.insertOne(asset);
  return {
    assetId,
    uploadId,
    parts: [
      {
        partNumber: 1,
        url: presignPutUrl(deps.config.s3, storageKey),
        startByte: 0,
        endByte: body.sizeBytes,
      },
    ],
  };
}

/** Contracts MediaAsset — never leak storageKey/uploadId to clients. */
function serializeAsset(doc: AssetDoc): MediaAsset {
  return {
    id: doc.id,
    ownerId: doc.ownerId,
    filename: doc.filename,
    mime: doc.mime,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    hlsUrl: doc.hlsUrl,
    thumbnailUrl: doc.thumbnailUrl,
    waveformUrl: doc.waveformUrl,
    durationMs: doc.durationMs,
    error: doc.error,
    createdAt: doc.createdAt,
  };
}

/**
 * Mark an upload complete. Owner + uploadId must match; already-'ready' is
 * an idempotent success. Returns the serialized asset and its public URL.
 */
export async function completeAttachment(
  deps: Deps,
  userId: UserId,
  body: CompleteUploadBody,
): Promise<{ asset: MediaAsset; url: string }> {
  const doc = await deps.store.assets.findById(body.assetId);
  if (doc === null) {
    throw new AppError('NOT_FOUND', 'asset not found');
  }
  if (doc.ownerId !== userId) {
    throw new AppError('FORBIDDEN', 'only the owner can complete an upload');
  }
  if (doc.uploadId !== body.uploadId) {
    throw new AppError('VALIDATION', 'uploadId does not match');
  }
  let asset = doc;
  if (doc.status !== 'ready') {
    const updated = await deps.store.assets.updateOne({ id: doc.id }, { status: 'ready' });
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'asset not found');
    }
    asset = updated;
  }
  const url = `${deps.config.s3.publicBaseUrl}/${asset.storageKey ?? ''}`;
  return { asset: serializeAsset(asset), url };
}
