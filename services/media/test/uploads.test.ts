import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/tokens';
import { completeUpload, makeRig } from './helpers';
import type { TestRig } from './helpers';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('upload lifecycle', () => {
  let rig: TestRig;

  afterEach(async () => {
    await rig.built.app.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    rig = await makeRig();
    const res = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      payload: { filename: 'a.mp4', mime: 'video/mp4', sizeBytes: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('creates a multipart session with explicit byte ranges', async () => {
    rig = await makeRig();
    const token = await rig.tokenFor('user-a');
    const res = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'My Clip!.mp4', mime: 'video/mp4', sizeBytes: 10 * MB },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      assetId: string;
      uploadId: string;
      parts: Array<{ partNumber: number; url: string; startByte: number; endByte: number }>;
    };
    expect(body.uploadId).toBe('fake-upload-1');
    // 8 MiB part size ⇒ 2 parts, ranges covering the whole file contiguously.
    expect(body.parts).toHaveLength(2);
    expect(body.parts[0]).toMatchObject({ partNumber: 1, startByte: 0, endByte: 8 * MB });
    expect(body.parts[1]).toMatchObject({
      partNumber: 2,
      startByte: 8 * MB,
      endByte: 10 * MB,
    });
    for (const part of body.parts) {
      expect(part.url).toContain(`partNumber=${part.partNumber}`);
      expect(part.url).toContain(`uploadId=${body.uploadId}`);
    }
    // Asset persisted in 'uploading' with the sanitized source key.
    const doc = await rig.store.findById(body.assetId);
    expect(doc).toMatchObject({
      ownerId: 'user-a',
      filename: 'My Clip!.mp4',
      status: 'uploading',
      storageKey: `u/user-a/${body.assetId}/source/My_Clip_.mp4`,
      uploadId: body.uploadId,
    });
  });

  it('rejects files above the max-file cap with 413', async () => {
    rig = await makeRig({ MAX_FILE_SIZE_GB: '1' });
    const token = await rig.tokenFor('user-a');
    const res = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'huge.mp4', mime: 'video/mp4', sizeBytes: GB + 1 },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(rig.storage.multipart.size).toBe(0);
  });

  it('enforces the per-user storage quota across uploads', async () => {
    rig = await makeRig({ STORAGE_QUOTA_GB: '1' });
    const token = await rig.tokenFor('user-a');
    const create = (sizeBytes: number, filename: string) =>
      rig.built.app.inject({
        method: 'POST',
        url: '/uploads',
        headers: { authorization: `Bearer ${token}` },
        payload: { filename, mime: 'video/mp4', sizeBytes },
      });

    expect((await create(600 * MB, 'one.mp4')).statusCode).toBe(200);
    const second = await create(600 * MB, 'two.mp4');
    expect(second.statusCode).toBe(413);
    expect(second.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    // The quota is per-user: another user is unaffected.
    const other = await rig.tokenFor('user-b');
    const res = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${other}` },
      payload: { filename: 'other.mp4', mime: 'video/mp4', sizeBytes: 600 * MB },
    });
    expect(res.statusCode).toBe(200);
  });

  it('completes an upload: multipart finalized, status processing, pipeline kicked', async () => {
    rig = await makeRig();
    const token = await rig.tokenFor('user-a');
    const created = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'clip.mp4', mime: 'video/mp4', sizeBytes: 5 * MB },
    });
    const { assetId, uploadId, parts } = created.json() as {
      assetId: string;
      uploadId: string;
      parts: Array<{ partNumber: number }>;
    };
    const done = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        assetId,
        uploadId,
        parts: parts.map((p) => ({ partNumber: p.partNumber, etag: '"e"' })),
      },
    });
    expect(done.statusCode).toBe(200);
    expect((done.json() as { asset: { status: string } }).asset.status).toBe('processing');
    expect(rig.storage.completed).toHaveLength(1);
    expect(rig.storage.completed[0]?.uploadId).toBe(uploadId);

    await rig.built.deps.pipeline.drain();
    const doc = await rig.store.findById(assetId);
    expect(doc?.status).toBe('ready');

    // Replayed complete is idempotent: current asset, no second finalize.
    const replay = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { asset: { status: string } }).asset.status).toBe('ready');
    expect(rig.storage.completed).toHaveLength(1);
  });

  it('rejects complete with a wrong uploadId, unknown asset, or foreign owner', async () => {
    rig = await makeRig();
    const token = await rig.tokenFor('user-a');
    const created = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'clip.mp4', mime: 'video/mp4', sizeBytes: 5 * MB },
    });
    const { assetId, uploadId } = created.json() as { assetId: string; uploadId: string };
    const complete = (tok: string, id: string, up: string) =>
      rig.built.app.inject({
        method: 'POST',
        url: `/uploads/${id}/complete`,
        headers: { authorization: `Bearer ${tok}` },
        payload: { assetId: id, uploadId: up, parts: [{ partNumber: 1, etag: '"e"' }] },
      });

    expect((await complete(token, assetId, 'wrong-upload')).statusCode).toBe(400);
    expect((await complete(token, newId(), uploadId)).statusCode).toBe(404);
    const stranger = await rig.tokenFor('user-b');
    const forbidden = await complete(stranger, assetId, uploadId);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('ops endpoints', () => {
  let rig: TestRig;

  afterEach(async () => {
    await rig.built.app.close();
  });

  it('healthz is always ok; readyz reflects store + storage', async () => {
    rig = await makeRig();
    expect((await rig.built.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await rig.built.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    rig.storage.pingOk = false;
    const res = await rig.built.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, storage: false });
  });
});

describe('completeUpload helper sanity', () => {
  it('drives an asset to ready', async () => {
    const rig2 = await makeRig();
    const assetId = await completeUpload(rig2, 'user-a');
    const doc = await rig2.store.findById(assetId);
    expect(doc?.status).toBe('ready');
    await rig2.built.app.close();
  });
});
