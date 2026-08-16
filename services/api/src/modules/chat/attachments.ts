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
} from '@gather/contracts';
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
 * S3 addressing (mirrors services/media/src/storage/url.ts — the two services
 * MUST agree, and this package cannot import that one). MinIO serves
 * path-style `/bucket/key`; AWS, Cloudflare R2 and Tigris — which is what
 * Railway Buckets run on — serve virtual-hosted `bucket.host/key`, and the
 * bucket's position changes the canonical URI and the signed Host header, so
 * the wrong choice fails as a 404 or a signature mismatch.
 */
const VIRTUAL_HOSTED_SUFFIXES = [
  'railway.app',
  'tigris.dev',
  'amazonaws.com',
  'r2.cloudflarestorage.com',
] as const;

/** Providers that ignore the region but demand the literal 'auto' in SigV4. */
const AUTO_REGION_SUFFIXES = ['railway.app', 'tigris.dev', 'r2.cloudflarestorage.com'] as const;

/** AppConfig['s3'] carries neither region nor addressing style; both are used
 *  when a future config supplies them and derived from the endpoint until
 *  then, so a Railway-linked bucket signs and addresses correctly either way. */
type S3Settings = AppConfig['s3'] & {
  region?: string | undefined;
  pathStyle?: boolean | undefined;
};

function hostMatches(endpoint: string, suffixes: readonly string[]): boolean {
  const host = new URL(endpoint).hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function s3PathStyle(s3: S3Settings): boolean {
  return s3.pathStyle ?? !hostMatches(s3.endpoint, VIRTUAL_HOSTED_SUFFIXES);
}

function s3Region(s3: S3Settings): string {
  return s3.region ?? (hostMatches(s3.endpoint, AUTO_REGION_SUFFIXES) ? 'auto' : 'us-east-1');
}

/** Scheme + authority requests go to; its host half is what SigV4 signs. */
function s3Origin(s3: S3Settings): string {
  const url = new URL(s3.endpoint);
  const host = s3PathStyle(s3) ? url.host : `${s3.bucket}.${url.host}`;
  return `${url.protocol}//${host}`;
}

/** Canonical URI of an object, endpoint path prefix included. */
function s3ObjectPath(s3: S3Settings, key: string): string {
  const basePath = new URL(s3.endpoint).pathname.replace(/\/+$/, '');
  const encodedKey = key.split('/').map(uriEncode).join('/');
  return s3PathStyle(s3) ? `${basePath}/${s3.bucket}/${encodedKey}` : `${basePath}/${encodedKey}`;
}

/**
 * AWS SigV4 query-presigned PUT URL, service s3, node:crypto only.
 * Deterministic for a given `now`. Addressing and region follow the endpoint
 * (see above) — MinIO stays path-style/us-east-1, Railway goes
 * virtual-hosted/auto.
 */
export function presignPutUrl(
  s3: S3Settings,
  key: string,
  expiresSec = 900,
  now: Date = new Date(),
): string {
  const origin = s3Origin(s3);
  const host = new URL(origin).host;
  const region = s3Region(s3);
  const canonicalUri = s3ObjectPath(s3, key);
  // 2026-08-15T00:00:00.000Z → 20260815T000000Z
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const credential = `${s3.accessKey}/${dateStamp}/${region}/s3/aws4_request`;

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
    `${dateStamp}/${region}/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${s3.secretKey}`, dateStamp), region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
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

// ── Object verification (size cap is enforced against REALITY) ──────────────
//
// The presigned PUT is UNSIGNED-PAYLOAD with only `host` signed — S3/MinIO
// accept an object of ANY size through it, so the create-time sizeBytes check
// is advisory only. Completion HEADs the object and enforces the plan cap
// against the actual byte count (deleting oversize objects), then records the
// actual size. Tests inject fake ops per Deps.

export interface AttachmentObjectOps {
  /** Object size via HEAD; null when the key does not exist. */
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  remove(key: string): Promise<void>;
}

const objectOpsOverrides = new WeakMap<Deps, AttachmentObjectOps>();

/** Test seam: pin the object ops used for this app's Deps. */
export function setAttachmentObjectOps(deps: Deps, ops: AttachmentObjectOps | null): void {
  if (ops === null) {
    objectOpsOverrides.delete(deps);
  } else {
    objectOpsOverrides.set(deps, ops);
  }
}

/** Header-signed SigV4 request (HEAD/DELETE control calls, no payload). */
async function signedS3Request(
  s3: S3Settings,
  method: 'HEAD' | 'DELETE',
  key: string,
): Promise<Response> {
  const origin = s3Origin(s3);
  const host = new URL(origin).host;
  const region = s3Region(s3);
  const canonicalUri = s3ObjectPath(s3, key);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update('').digest('hex');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${s3.secretKey}`, dateStamp), region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return fetch(`${origin}${canonicalUri}`, {
    method,
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${s3.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

function objectOps(deps: Deps): AttachmentObjectOps {
  const override = objectOpsOverrides.get(deps);
  if (override !== undefined) {
    return override;
  }
  const { s3 } = deps.config;
  return {
    async stat(key: string): Promise<{ sizeBytes: number } | null> {
      const res = await signedS3Request(s3, 'HEAD', key);
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new AppError('INTERNAL', `attachment HEAD failed with ${res.status}`);
      }
      const size = Number(res.headers.get('content-length'));
      if (!Number.isFinite(size) || size < 0) {
        throw new AppError('INTERNAL', 'attachment HEAD missing content-length');
      }
      return { sizeBytes: size };
    },
    async remove(key: string): Promise<void> {
      const res = await signedS3Request(s3, 'DELETE', key);
      await res.arrayBuffer().catch(() => undefined);
    },
  };
}

/**
 * Mark an upload complete. Owner + uploadId must match; already-'ready' is
 * an idempotent success. The plan size cap is enforced HERE against the
 * actual object (see AttachmentObjectOps above) — oversize objects are
 * deleted and the ticket fails. Returns the serialized asset + public URL.
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
    const ops = objectOps(deps);
    const stat = await ops.stat(doc.storageKey ?? '');
    if (stat === null) {
      throw new AppError('VALIDATION', 'attachment object was never uploaded');
    }
    const cap = await attachmentMaxMb(deps.store, userId);
    if (stat.sizeBytes > cap * 1024 * 1024) {
      await ops.remove(doc.storageKey ?? '').catch(() => undefined);
      await deps.store.assets.updateOne(
        { id: doc.id },
        { status: 'failed', sizeBytes: 0, error: `attachment exceeds the ${cap} MB plan limit` },
      );
      throw new AppError('QUOTA_EXCEEDED', `attachment exceeds the ${cap} MB plan limit`);
    }
    const updated = await deps.store.assets.updateOne(
      { id: doc.id },
      { status: 'ready', sizeBytes: stat.sizeBytes },
    );
    if (updated === null) {
      throw new AppError('NOT_FOUND', 'asset not found');
    }
    asset = updated;
  }
  const url = `${deps.config.s3.publicBaseUrl}/${asset.storageKey ?? ''}`;
  return { asset: serializeAsset(asset), url };
}
