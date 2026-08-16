/**
 * Chat attachment uploads against the room-scoped endpoints
 * (POST /rooms/:id/attachments[/complete]). The server issues ONE presigned
 * PUT covering the whole object (chat cap is tens of MB, not library GB), so
 * this is a straight PUT — no multipart machinery. Returns a contracts
 * MessageAttachment ready for chat.send. Honest errors: entitlement caps,
 * missing object, and network failures surface to the composer.
 */
import {
  CompleteUploadBody,
  CreateUploadResponse,
  MediaAsset,
} from '@gather/contracts';
import type { MessageAttachment, RoomId } from '@gather/contracts';
import { z } from 'zod';
import { apiFetch } from './api';

const CompleteAttachmentResponse = z.object({
  asset: MediaAsset,
  /** Public object URL — extra key over CompleteUploadResponse. */
  url: z.string().url(),
});

/** Measure image dimensions for the attachment record (null when unknown). */
function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith('image/')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export interface UploadAttachmentOptions {
  /** 0..1 progress from the XMLHttpRequest upload channel. */
  onProgress?: (fraction: number) => void;
  /** Voice notes must carry their duration (server-validated). */
  durationMs?: number | null;
}

export async function uploadChatAttachment(
  roomId: RoomId,
  file: File,
  opts?: UploadAttachmentOptions,
): Promise<MessageAttachment> {
  const mime = file.type.length > 0 ? file.type : 'application/octet-stream';
  const ticket = await apiFetch(`/rooms/${roomId}/attachments`, {
    method: 'POST',
    body: { filename: file.name, mime, sizeBytes: file.size },
    schema: CreateUploadResponse,
  });
  const part = ticket.parts[0];
  if (part === undefined) {
    throw new Error('upload ticket carried no part URL');
  }

  // Presigned single PUT (UNSIGNED-PAYLOAD) — progress via XHR; the ETag
  // response header is echoed back in the completion body (S3 convention).
  const etag = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', part.url);
    xhr.setRequestHeader('content-type', mime);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts?.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader('ETag')?.replaceAll('"', '') ?? 'single-part');
      } else {
        reject(new Error(`attachment upload failed with ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('attachment upload failed (network)'));
    xhr.send(file);
  });

  const body = CompleteUploadBody.parse({
    assetId: ticket.assetId,
    uploadId: ticket.uploadId,
    parts: [{ partNumber: part.partNumber, etag }],
  });
  const done = await apiFetch(`/rooms/${roomId}/attachments/complete`, {
    method: 'POST',
    body,
    schema: CompleteAttachmentResponse,
  });

  const size = await imageSize(file);
  return {
    assetId: done.asset.id,
    url: done.url,
    mime,
    name: file.name,
    sizeBytes: file.size,
    width: size?.width ?? null,
    height: size?.height ?? null,
    durationMs: opts?.durationMs ?? null,
  };
}
