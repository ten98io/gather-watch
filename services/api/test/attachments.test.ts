/**
 * Chat attachment completion: the plan size cap is enforced against the
 * ACTUAL uploaded object (presigned PUTs are unsigned-payload, so claimed
 * sizeBytes is untrusted); oversize objects are deleted and the doc fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StorePort } from '../src/adapters/ports';
import type { Deps } from '../src/modules/types';
import { setAttachmentObjectOps } from '../src/modules/chat/attachments';
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

  it('rejects + deletes an object whose actual size busts the plan cap', async () => {
    // Free cap is 25 MB: claim 1 MB, actually PUT 200 MB.
    const { token, roomId, assetId, uploadId } = await ticketFor(1 * MB);
    const removed: string[] = [];
    setAttachmentObjectOps(deps, {
      stat: async () => ({ sizeBytes: 200 * MB }),
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
});
