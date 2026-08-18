/**
 * Chat attachment completion: the storage-sanity size limit is enforced
 * against the ACTUAL uploaded object (presigned PUTs are unsigned-payload, so
 * claimed sizeBytes is untrusted); oversize objects are deleted and the doc
 * fails. The limit is the same for every account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { ATTACHMENT_MAX_MB, setAttachmentObjectOps } from '../src/modules/chat/attachments';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

const MB = 1024 * 1024;

describe('chat attachments', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  async function ticketFor(sizeBytes: number): Promise<{
    token: string;
    roomId: string;
    assetId: string;
    uploadId: string;
  }> {
    const { roomId } = await seedRoom(store);
    const account = await signupUser(app, 'uploader@example.com');
    await addMember(store, roomId, account.user.id, 'member');
    const created = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments`,
      headers: { authorization: `Bearer ${account.accessToken}` },
      payload: { filename: 'pic.png', mime: 'image/png', sizeBytes },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { assetId: string; uploadId: string };
    return { token: account.accessToken, roomId, assetId: body.assetId, uploadId: body.uploadId };
  }

  it('completes with the ACTUAL object size recorded', async () => {
    const { token, roomId, assetId, uploadId } = await ticketFor(5 * MB);
    setAttachmentObjectOps(deps, {
      stat: async () => ({ sizeBytes: 3 * MB }),
      remove: async () => undefined,
    });
    const done = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(done.statusCode).toBe(200);
    const asset = (done.json() as { asset: { status: string; sizeBytes: number } }).asset;
    expect(asset.status).toBe('ready');
    expect(asset.sizeBytes).toBe(3 * MB);
  });

  it('accepts a 100 MB object — the size limit is the same for every account', async () => {
    const { token, roomId, assetId, uploadId } = await ticketFor(1 * MB);
    setAttachmentObjectOps(deps, {
      stat: async () => ({ sizeBytes: 100 * MB }),
      remove: async () => undefined,
    });
    const done = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(done.statusCode).toBe(200);
    expect((done.json() as { asset: { sizeBytes: number } }).asset.sizeBytes).toBe(100 * MB);
  });

  it('rejects + deletes an object whose actual size busts the storage limit', async () => {
    // Limit is 200 MB: claim 1 MB, actually PUT well past it.
    const { token, roomId, assetId, uploadId } = await ticketFor(1 * MB);
    const removed: string[] = [];
    setAttachmentObjectOps(deps, {
      stat: async () => ({ sizeBytes: (ATTACHMENT_MAX_MB + 60) * MB }),
      remove: async (key) => {
        removed.push(key);
      },
    });
    const done = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(done.statusCode).toBe(413);
    expect((done.json() as { code: string }).code).toBe('QUOTA_EXCEEDED');
    expect(removed).toHaveLength(1);
    expect((await store.assets.findById(assetId))?.status).toBe('failed');
    expect((await store.assets.findById(assetId))?.error).toBe(
      `attachment exceeds the ${ATTACHMENT_MAX_MB} MB upload limit`,
    );
  });

  it('rejects an oversize ticket at create time without naming a plan', async () => {
    const { roomId } = await seedRoom(store);
    const account = await signupUser(app, 'big-uploader@example.com');
    await addMember(store, roomId, account.user.id, 'member');
    const created = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments`,
      headers: { authorization: `Bearer ${account.accessToken}` },
      payload: { filename: 'huge.bin', mime: 'image/png', sizeBytes: (ATTACHMENT_MAX_MB + 1) * MB },
    });
    expect(created.statusCode).toBe(413);
    const body = created.json() as { code: string; message: string };
    expect(body.code).toBe('QUOTA_EXCEEDED');
    expect(body.message).toBe(`attachment exceeds the ${ATTACHMENT_MAX_MB} MB upload limit`);
    expect(body.message).not.toMatch(/plan|premium|upgrade/i);
  });

  it('rejects completion when the object was never uploaded', async () => {
    const { token, roomId, assetId, uploadId } = await ticketFor(1 * MB);
    setAttachmentObjectOps(deps, {
      stat: async () => null,
      remove: async () => undefined,
    });
    const done = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/attachments/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(done.statusCode).toBe(400);
  });

  describe('attachment content route', () => {
    /**
     * Messages store this route's URL forever, so it — not the bucket — is the
     * read path: the bucket is private and a presigned GET expires, while a
     * chat message does not.
     */
    async function readyAsset(): Promise<string> {
      const { token, roomId, assetId, uploadId } = await ticketFor(1 * MB);
      setAttachmentObjectOps(deps, {
        stat: async () => ({ sizeBytes: 1 * MB }),
        remove: async () => undefined,
      });
      const done = await app.inject({
        method: 'POST',
        url: `/rooms/${roomId}/attachments/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
      });
      expect(done.statusCode).toBe(200);
      const { url } = done.json() as { url: string };
      expect(url).toBe(`${deps.config.apiUrl}/assets/${assetId}/content`);
      expect(url).not.toContain(deps.config.s3.publicBaseUrl);
      return assetId;
    }

    it('redirects a ready asset to a fresh presigned GET and never caches it', async () => {
      const assetId = await readyAsset();
      const res = await app.inject({ method: 'GET', url: `/assets/${assetId}/content` });
      expect(res.statusCode).toBe(302);
      const location = res.headers['location'] as string;
      expect(location).toContain('X-Amz-Signature=');
      expect(location).toContain('X-Amz-Expires=60');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('404s an asset that is not ready, without leaking whether it exists', async () => {
      const { assetId } = await ticketFor(1 * MB); // never completed -> 'uploading'
      const pending = await app.inject({ method: 'GET', url: `/assets/${assetId}/content` });
      expect(pending.statusCode).toBe(404);
      const missing = await app.inject({ method: 'GET', url: '/assets/does-not-exist/content' });
      expect(missing.statusCode).toBe(404);
    });
  });
});
