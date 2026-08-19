/**
 * Chat attachment uploads: the object size limit, key sanitization, MinIO/S3
 * SigV4 presigned PUT URLs, upload completion — and the check that turns a
 * client's CLAIM about an attachment into a fact (resolveMessageAttachment).
 * The size limit is a storage-sanity ceiling that applies to every account —
 * nothing lifts it.
 */
import { createHash, createHmac } from 'node:crypto';
import type {
  AssetId,
  CompleteUploadBody,
  CreateUploadBody,
  CreateUploadResponse,
  MediaAsset,
  MessageAttachment,
  ReportTarget,
  RoomId,
  UserId,
} from '@gather/contracts';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { AppConfig } from '../../config';
import type { AssetDoc } from '../../adapters/ports';
import type { Deps } from '../types';

/**
 * Hard ceiling on a single chat attachment, identical for every account.
 * This is a storage-sanity limit — a multi-gigabyte object arriving through a
 * presigned PUT is a bug or an abuse, not a purchase decision — so it is
 * enforced at ticket time AND against the real uploaded bytes at completion.
 */
export const ATTACHMENT_MAX_MB = 200;

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
 * S3 addressing. This used to mirror services/media/src/storage/url.ts; that
 * service is deleted, so this is now the only copy. MinIO serves
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
  return presignObjectUrl(s3, key, 'PUT', expiresSec, now);
}

/** The same SigV4 query-presign for any method; GET is the read path. */
export function presignObjectUrl(
  s3: S3Settings,
  key: string,
  // DELETE is used by the bucket-clear CLI (src/cli/clear-bucket.ts); the
  // signature is identical, only the verb in the canonical request changes.
  method: 'GET' | 'PUT' | 'DELETE',
  expiresSec: number,
  now: Date = new Date(),
  /** Extra query params folded into the SIGNED canonical query. They cannot be
   *  appended to the returned URL afterwards: SigV4 signs the query string, so
   *  a param added later invalidates the signature (S3 answers 403
   *  SignatureDoesNotMatch). Used for ListObjectsV2 by the bucket-clear CLI. */
  extraQuery: Readonly<Record<string, string>> = {},
): string {
  const origin = s3Origin(s3);
  const host = new URL(origin).host;
  const region = s3Region(s3);
  const canonicalUri = s3ObjectPath(s3, key);
  // 2026-08-15T00:00:00.000Z → 20260815T000000Z
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const credential = `${s3.accessKey}/${dateStamp}/${region}/s3/aws4_request`;

  // SigV4 requires the canonical query sorted by ENCODED key.
  const canonicalQuery = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec)],
    ['X-Amz-SignedHeaders', 'host'],
    ...Object.entries(extraQuery),
  ]
    .map(([k, v]) => [uriEncode(String(k)), uriEncode(String(v))] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    method,
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
 * Create an upload ticket: size check, AssetDoc in 'uploading' state, and a
 * single presigned PUT part covering the whole object.
 */
export async function createAttachmentTicket(
  deps: Deps,
  roomId: RoomId,
  userId: UserId,
  body: CreateUploadBody,
): Promise<CreateUploadResponse> {
  if (body.sizeBytes > ATTACHMENT_MAX_MB * 1024 * 1024) {
    throw new AppError(
      'QUOTA_EXCEEDED',
      `attachment exceeds the ${ATTACHMENT_MAX_MB} MB upload limit`,
    );
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
// is advisory only. Completion HEADs the object and enforces the size limit
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
 * THE url a chat message may carry for an asset — one per asset, derived, and
 * never taken from a client. A STABLE capability URL, not a bucket URL: the
 * bucket is private (a Railway bucket has no anonymous read) and a presigned
 * GET expires while a chat message lives forever, so messages store the api's
 * own content route, which redirects to a fresh short-lived presign per view.
 * The asset id is unguessable, which is the same access model as
 * Discord/Slack attachment links; possession of the link is possession of the
 * file.
 */
export function attachmentContentUrl(config: Deps['config'], assetId: AssetId): string {
  return `${config.apiUrl}/assets/${assetId}/content`;
}

/**
 * Turn the attachment a client SENT into the attachment the server will store.
 *
 * Everything in MessageAttachment was previously taken on trust and persisted
 * verbatim, so a message could name an asset belonging to somebody else (the
 * id is the whole capability — attaching a stranger's private upload to a
 * message in a room they are not in re-publishes it), or point `url` anywhere
 * at all, which is a stored redirect for every reader of the room.
 *
 * So: the ASSET is the authority for everything the server can know — owner,
 * mime, filename, byte count, and the one legal url — and only the intrinsics
 * we never learn server-side (pixel dimensions, media duration; there is no
 * probing pipeline) survive from the client, already bounded by the contract.
 * A caller may only attach an asset that is theirs and finished uploading.
 */
export async function resolveMessageAttachment(
  deps: Deps,
  userId: UserId,
  claimed: MessageAttachment,
): Promise<MessageAttachment> {
  const asset = await deps.store.assets.findById(claimed.assetId);
  if (asset === null) {
    throw new AppError('NOT_FOUND', 'attachment asset not found');
  }
  if (asset.ownerId !== userId) {
    throw new AppError('FORBIDDEN', 'attachment belongs to another account');
  }
  if (asset.status !== 'ready') {
    throw new AppError('VALIDATION', 'attachment upload is not complete');
  }
  return {
    assetId: asset.id,
    url: attachmentContentUrl(deps.config, asset.id),
    mime: asset.mime,
    name: asset.filename,
    sizeBytes: asset.sizeBytes,
    width: claimed.width,
    height: claimed.height,
    // Voice notes carry a duration the client measured while recording and
    // nothing server-side has ever measured; prefer a stored one if a
    // transcode pipeline ever produces one.
    durationMs: asset.durationMs ?? claimed.durationMs,
  };
}

// ── Revocation (a takedown has to actually take something down) ─────────────
//
// `GET /assets/:assetId/content` is unauthenticated BY DESIGN — the id is the
// capability, the Discord/Slack model, and the bucket stays private. The
// consequence nobody had built for is that possession of the link is
// permanent: deleting the room, erasing the account and tombstoning the
// message all left the AssetDoc alone, so every link ever pasted kept
// resolving. For DMCA, for GDPR and for illegal content alike, the takedown
// took nothing down.
//
// WHY THE DOC IS DELETED RATHER THAN FLAGGED. A "revoked" state wants a home
// on the document, and there isn't one: AssetDoc is MediaAsset plus the two
// storage fields, `MediaAssetStatus` is a contracts enum, and neither is this
// module's to widen. The nearest existing state, `status: 'failed'`, is
// actively wrong here — `completeAttachment` re-STATs and re-marks any
// non-ready doc as 'ready', so a flagged asset could be un-revoked by its own
// uploader replaying the completion call. Deleting the row is the only shape
// that is unambiguous in the code that already exists: the content route's
// `doc === null` branch answers 404 with no change, the message-attach path
// answers "asset not found", and completion cannot resurrect what is gone.
//
// The object goes too, best-effort. A takedown for illegal content that
// leaves the bytes in the bucket is a takedown of a pointer; but object
// storage is a network call that can fail, and a failed DELETE must not stop
// the capability from being revoked — so the row goes first and the object
// follows, with its failure logged rather than thrown.

/**
 * Revoke assets by id: the capability URL stops resolving, then the bytes go.
 * Unknown ids are skipped. Returns the number of asset rows removed.
 */
export async function revokeAssets(deps: Deps, assetIds: readonly AssetId[]): Promise<number> {
  let revoked = 0;
  for (const assetId of assetIds) {
    const doc = await deps.store.assets.findById(assetId);
    if (doc === null) {
      continue;
    }
    // Row first: this is the half that must not fail, because it is the half
    // that closes the URL.
    if (!(await deps.store.assets.deleteOne({ id: doc.id }))) {
      continue;
    }
    revoked += 1;
    if (doc.storageKey !== null) {
      await objectOps(deps)
        .remove(doc.storageKey)
        .catch((err: unknown) => {
          deps.log.warn(
            { err, assetId: doc.id },
            'asset revoked but its object could not be removed',
          );
        });
    }
  }
  return revoked;
}

/** Every asset id a room's messages point at. Read BEFORE the messages are
 *  deleted — once the rows are gone nothing names the assets any more. */
export async function roomAttachmentAssetIds(deps: Deps, roomId: RoomId): Promise<AssetId[]> {
  const messages = await deps.store.messages.findMany({ roomId });
  const ids: AssetId[] = [];
  for (const message of messages) {
    if (message.attachment !== null) {
      ids.push(message.attachment.assetId);
    }
  }
  return ids;
}

/** Every asset id owned by one account — the GDPR cascade's read. */
export async function userAssetIds(deps: Deps, userId: UserId): Promise<AssetId[]> {
  const assets = await deps.store.assets.findMany({ ownerId: userId });
  return assets.map((asset) => asset.id);
}

/**
 * The assets a takedown of this report target must revoke, read BEFORE the
 * takedown runs (it tombstones the message that names them).
 *
 * A `user` target is deliberately empty: that action is a BAN, not an
 * erasure — the account still exists and so do its uploads. Erasing an
 * account is DELETE /me, which revokes them all (compliance/erasure.ts).
 */
export async function reportTargetAssetIds(
  deps: Deps,
  target: ReportTarget,
): Promise<AssetId[]> {
  switch (target.kind) {
    case 'asset':
      return [target.assetId];
    case 'message': {
      const message = await deps.store.messages.findById(target.messageId);
      return message?.attachment == null ? [] : [message.attachment.assetId];
    }
    case 'room':
      return roomAttachmentAssetIds(deps, target.roomId);
    case 'user':
      return [];
  }
}

/**
 * Mark an upload complete. Owner + uploadId must match; already-'ready' is
 * an idempotent success. The size limit is enforced HERE against the actual
 * object (see AttachmentObjectOps above) — oversize objects are deleted and
 * the ticket fails. Returns the serialized asset + public URL.
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
    if (stat.sizeBytes > ATTACHMENT_MAX_MB * 1024 * 1024) {
      const message = `attachment exceeds the ${ATTACHMENT_MAX_MB} MB upload limit`;
      await ops.remove(doc.storageKey ?? '').catch(() => undefined);
      await deps.store.assets.updateOne(
        { id: doc.id },
        { status: 'failed', sizeBytes: 0, error: message },
      );
      throw new AppError('QUOTA_EXCEEDED', message);
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
  // The same one url resolveMessageAttachment will re-derive when the message
  // that carries it is sent — see attachmentContentUrl.
  return { asset: serializeAsset(asset), url: attachmentContentUrl(deps.config, asset.id) };
}
