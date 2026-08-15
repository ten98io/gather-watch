/**
 * Review-wave hardening: guest lockout, ENABLE_MEDIA_PIPELINE gating, actual-
 * size verification at complete, part-list validation, entitlement quotas,
 * re-presign route, boot reconciliation of stranded assets, and the delete-
 * during-processing guard.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetId, UserId } from '@playin/contracts';
import { buildApp } from '../src/app';
import type { BuiltApp } from '../src/app';
import { newId } from '../src/lib/tokens';
import { MemoryAssetStore } from '../src/store/memory';
import type { AssetDoc } from '../src/store/ports';
import { FakeRunner, FakeStorage, completeUpload, makeRig, testConfig } from './helpers';
import type { TestRig } from './helpers';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('guest lockout', () => {
  let rig: TestRig;
  afterEach(async () => {
    await rig.built.app.close();
  });

  it('guest tokens get 403 on the whole upload/library surface', async () => {
    rig = await makeRig();
    const guest = await rig.guestTokenFor('guest-1');
    const headers = { authorization: `Bearer ${guest}` };
    const upload = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers,
      payload: { filename: 'a.mp4', mime: 'video/mp4', sizeBytes: MB },
    });
    expect(upload.statusCode).toBe(403);
    expect(upload.json()).toMatchObject({ code: 'FORBIDDEN' });
    const library = await rig.built.app.inject({ method: 'GET', url: '/library', headers });
    expect(library.statusCode).toBe(403);
    const del = await rig.built.app.inject({
      method: 'DELETE',
      url: `/library/${newId()}`,
      headers,
    });
    expect(del.statusCode).toBe(403);
  });
});

describe('ENABLE_MEDIA_PIPELINE gating', () => {
  it('defaults OFF: boots green, media surface answers 501', async () => {
    const config = testConfig({ ENABLE_MEDIA_PIPELINE: '' }); // empty ⇒ absent ⇒ default false
    expect(config.enableMediaPipeline).toBe(false);
    const built = await buildApp({
      config,
      store: new MemoryAssetStore(),
      storage: new FakeStorage(),
      runner: new FakeRunner(),
    });
    try {
      expect((await built.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await built.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      const upload = await built.app.inject({ method: 'POST', url: '/uploads', payload: {} });
      expect(upload.statusCode).toBe(501);
      expect((await built.app.inject({ method: 'GET', url: '/library' })).statusCode).toBe(501);
    } finally {
      await built.app.close();
    }
  });
});

describe('complete-time size verification', () => {
  let rig: TestRig;
  afterEach(async () => {
    await rig.built.app.close();
  });

  async function createSession(sizeBytes: number): Promise<{
    token: string;
    assetId: string;
    uploadId: string;
  }> {
    const token = await rig.tokenFor('user-a');
    const created = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'clip.mp4', mime: 'video/mp4', sizeBytes },
    });
    const body = created.json() as { assetId: string; uploadId: string };
    return { token, assetId: body.assetId, uploadId: body.uploadId };
  }

  it('rejects an object whose ACTUAL size busts the quota, deletes it, fails the doc', async () => {
    rig = await makeRig({ STORAGE_QUOTA_GB: '1', MAX_FILE_SIZE_GB: '4' });
    const { token, assetId, uploadId } = await createSession(MB); // claims 1 MB
    // The client actually PUT ~2 GB through the unsigned-payload part URLs.
    rig.storage.finalizedSizeBytes = 2 * GB;
    const done = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(done.statusCode).toBe(413);
    expect(done.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    const doc = await rig.store.findById(assetId);
    expect(doc?.status).toBe('failed');
    // The oversize object was deleted and no longer counts toward usage.
    expect(doc?.sizeBytes).toBe(0);
    expect([...rig.storage.objects.keys()].some((k) => k.includes(assetId))).toBe(false);
    expect(rig.runner.transcodeCalls).toHaveLength(0);
  });

  it('records the ACTUAL object size on success (usage stays honest)', async () => {
    rig = await makeRig();
    const { token, assetId, uploadId } = await createSession(5 * MB);
    rig.storage.finalizedSizeBytes = 3 * MB; // client sent less than claimed
    const done = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { assetId, uploadId, parts: [{ partNumber: 1, etag: '"e"' }] },
    });
    expect(done.statusCode).toBe(200);
    await rig.built.deps.pipeline.drain();
    expect((await rig.store.findById(assetId))?.sizeBytes).toBe(3 * MB);
    expect(await rig.store.usageBytes('user-a')).toBe(3 * MB);
  });

  it('rejects out-of-order, duplicate, or overlong part lists with 400', async () => {
    rig = await makeRig();
    const { token, assetId, uploadId } = await createSession(10 * MB); // 2 planned parts
    const complete = (parts: Array<{ partNumber: number; etag: string }>) =>
      rig.built.app.inject({
        method: 'POST',
        url: `/uploads/${assetId}/complete`,
        headers: { authorization: `Bearer ${token}` },
        payload: { assetId, uploadId, parts },
      });
    const outOfOrder = await complete([
      { partNumber: 2, etag: '"b"' },
      { partNumber: 1, etag: '"a"' },
    ]);
    expect(outOfOrder.statusCode).toBe(400);
    const dupes = await complete([
      { partNumber: 1, etag: '"a"' },
      { partNumber: 1, etag: '"a"' },
    ]);
    expect(dupes.statusCode).toBe(400);
    const tooMany = await complete([
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
      { partNumber: 3, etag: '"c"' },
    ]);
    expect(tooMany.statusCode).toBe(400);
    expect(rig.storage.completed).toHaveLength(0);
  });
});

describe('entitlement-aware quota', () => {
  let rig: TestRig;
  afterEach(async () => {
    await rig.built.app.close();
  });

  it('premium subscribers get the 4x quota; free users keep the base', async () => {
    rig = await makeRig({ STORAGE_QUOTA_GB: '1' });
    rig.store.plans.set('premium-user', 'premium');
    const create = async (userId: string, sizeBytes: number) =>
      rig.built.app.inject({
        method: 'POST',
        url: '/uploads',
        headers: { authorization: `Bearer ${await rig.tokenFor(userId)}` },
        payload: { filename: 'big.mp4', mime: 'video/mp4', sizeBytes },
      });
    // 2 GB claim: over the 1 GB free quota, within premium's 4 GB.
    expect((await create('free-user', 2 * GB)).statusCode).toBe(413);
    expect((await create('premium-user', 2 * GB)).statusCode).toBe(200);
    // Premium is still bounded: 2 GB used + 3 GB claim busts 4 x 1 GB.
    const over = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${await rig.tokenFor('premium-user')}` },
      payload: { filename: 'bigger.mp4', mime: 'video/mp4', sizeBytes: 3 * GB },
    });
    expect(over.statusCode).toBe(413);
  });
});

describe('part URL refresh', () => {
  let rig: TestRig;
  afterEach(async () => {
    await rig.built.app.close();
  });

  it('re-presigns parts for an owned in-flight upload; guards the rest', async () => {
    rig = await makeRig();
    const token = await rig.tokenFor('user-a');
    const created = await rig.built.app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'slow.mp4', mime: 'video/mp4', sizeBytes: 10 * MB },
    });
    const { assetId, uploadId, parts } = created.json() as {
      assetId: string;
      uploadId: string;
      parts: Array<{ partNumber: number; startByte: number; endByte: number }>;
    };

    const refreshed = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/parts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { uploadId },
    });
    expect(refreshed.statusCode).toBe(200);
    const body = refreshed.json() as { parts: typeof parts };
    // Same plan (numbers + byte ranges) as the original session.
    expect(body.parts.map((p) => [p.partNumber, p.startByte, p.endByte])).toEqual(
      parts.map((p) => [p.partNumber, p.startByte, p.endByte]),
    );

    const wrongUpload = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/parts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { uploadId: 'nope' },
    });
    expect(wrongUpload.statusCode).toBe(400);
    const stranger = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/parts`,
      headers: { authorization: `Bearer ${await rig.tokenFor('user-b')}` },
      payload: { uploadId },
    });
    expect(stranger.statusCode).toBe(403);

    // Finalized uploads cannot be refreshed.
    await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        assetId,
        uploadId,
        parts: parts.map((p) => ({ partNumber: p.partNumber, etag: '"e"' })),
      },
    });
    const late = await rig.built.app.inject({
      method: 'POST',
      url: `/uploads/${assetId}/parts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { uploadId },
    });
    expect(late.statusCode).toBe(409);
    await rig.built.deps.pipeline.drain();
  });
});

describe('boot reconciliation', () => {
  it('re-enqueues assets stranded in processing by a crash', async () => {
    const config = testConfig();
    const store = new MemoryAssetStore();
    const storage = new FakeStorage();
    const runner = new FakeRunner();
    const assetId = newId();
    const storageKey = `u/user-a/${assetId}/source/clip.mp4`;
    storage.objects.set(storageKey, Buffer.from('bytes'));
    const doc: AssetDoc = {
      id: assetId as AssetId,
      ownerId: 'user-a' as UserId,
      filename: 'clip.mp4',
      mime: 'video/mp4',
      sizeBytes: 5,
      status: 'processing', // stranded by the "previous" process
      hlsUrl: null,
      thumbnailUrl: null,
      waveformUrl: null,
      durationMs: null,
      error: null,
      createdAt: Date.now(),
      storageKey,
      uploadId: null,
    };
    await store.insert(doc);

    let built: BuiltApp | null = null;
    try {
      built = await buildApp({ config, store, storage, runner });
      await built.deps.pipeline.drain();
      expect((await store.findById(assetId))?.status).toBe('ready');
      expect(runner.transcodeCalls).toHaveLength(1);
    } finally {
      await built?.app.close();
    }
  });
});

describe('delete during processing', () => {
  let rig: TestRig;
  afterEach(async () => {
    await rig.built.app.close();
  });

  it('answers 409 while the pipeline may still be writing artifacts', async () => {
    rig = await makeRig();
    const assetId = await completeUpload(rig, 'user-a');
    await rig.store.update(assetId, { status: 'processing' }); // simulate in-flight job
    const res = await rig.built.app.inject({
      method: 'DELETE',
      url: `/library/${assetId}`,
      headers: { authorization: `Bearer ${await rig.tokenFor('user-a')}` },
    });
    expect(res.statusCode).toBe(409);
    expect(await rig.store.findById(assetId)).not.toBeNull();
  });
});
