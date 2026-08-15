import type { MediaAsset } from '@playin/contracts';
import type { AssetDoc } from '../store/ports';

/** Contracts MediaAsset — never leak storageKey/uploadId to clients. */
export function serializeAsset(doc: AssetDoc): MediaAsset {
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

/** Storage-safe filename: [A-Za-z0-9._-] only, max 100 chars, never empty. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return cleaned === '' || /^\.+$/.test(cleaned) ? 'file' : cleaned;
}

/**
 * Multipart part layout: explicit [startByte, endByte) ranges per the
 * contracts convention. Part size starts at config.uploadPartSizeMb and grows
 * (MiB-aligned) when the part count would exceed S3's 10 000-part ceiling.
 */
export function planParts(
  sizeBytes: number,
  partSizeMb: number,
): Array<{ partNumber: number; startByte: number; endByte: number }> {
  const MAX_PARTS = 10_000;
  const MIB = 1024 * 1024;
  let partSize = partSizeMb * MIB;
  if (Math.ceil(sizeBytes / partSize) > MAX_PARTS) {
    partSize = Math.ceil(sizeBytes / MAX_PARTS / MIB) * MIB;
  }
  const parts: Array<{ partNumber: number; startByte: number; endByte: number }> = [];
  for (let start = 0, n = 1; start < sizeBytes; start += partSize, n += 1) {
    parts.push({ partNumber: n, startByte: start, endByte: Math.min(sizeBytes, start + partSize) });
  }
  return parts;
}

/** Object-key root for everything belonging to one asset. */
export function assetKeyPrefix(userId: string, assetId: string): string {
  return `u/${userId}/${assetId}`;
}
