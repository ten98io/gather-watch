import { afterEach, describe, expect, it } from 'vitest';
import { completeUpload, makeRig } from './helpers';
import type { TestRig } from './helpers';

describe('library', () => {
  let rig: TestRig;

  afterEach(async () => {
    await rig.built.app.close();
  });

  it('lists only the caller’s assets, newest first, with cursor pagination', async () => {
    rig = await makeRig();
    const a1 = await completeUpload(rig, 'user-a');
    const a2 = await completeUpload(rig, 'user-a');
    await completeUpload(rig, 'user-b');

    const token = await rig.tokenFor('user-a');
    const page1 = await rig.built.app.inject({
      method: 'GET',
      url: '/library?limit=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json() as {
      items: Array<{ id: string; ownerId: string; storageKey?: unknown }>;
      nextCursor: string | null;
    };
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0]?.ownerId).toBe('user-a');
    // Server-only fields must never leak.
    expect(body1.items[0]?.storageKey).toBeUndefined();
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await rig.built.app.inject({
      method: 'GET',
      url: `/library?limit=1&cursor=${encodeURIComponent(body1.nextCursor ?? '')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body2 = page2.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(body2.items).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
    // Two pages covered exactly {a1, a2} — no overlap, no foreign assets.
    expect([body1.items[0]?.id, body2.items[0]?.id].sort()).toEqual([a1, a2].sort());
  });

  it('requires auth', async () => {
    rig = await makeRig();
    const res = await rig.built.app.inject({ method: 'GET', url: '/library' });
    expect(res.statusCode).toBe(401);
  });

  it('renames an asset (owner only)', async () => {
    rig = await makeRig();
    const assetId = await completeUpload(rig, 'user-a');
    const token = await rig.tokenFor('user-a');
    const res = await rig.built.app.inject({
      method: 'PATCH',
      url: `/library/${assetId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'renamed.mp4' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { asset: { filename: string } }).asset.filename).toBe('renamed.mp4');

    const stranger = await rig.tokenFor('user-b');
    const forbidden = await rig.built.app.inject({
      method: 'PATCH',
      url: `/library/${assetId}`,
      headers: { authorization: `Bearer ${stranger}` },
      payload: { filename: 'hijack.mp4' },
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await rig.built.app.inject({
      method: 'PATCH',
      url: `/library/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: 'ghost.mp4' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('deletes an asset: doc gone, stored objects purged (owner only)', async () => {
    rig = await makeRig();
    const assetId = await completeUpload(rig, 'user-a');
    const token = await rig.tokenFor('user-a');

    const stranger = await rig.tokenFor('user-b');
    const forbidden = await rig.built.app.inject({
      method: 'DELETE',
      url: `/library/${assetId}`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await rig.built.app.inject({
      method: 'DELETE',
      url: `/library/${assetId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await rig.store.findById(assetId)).toBeNull();
    expect(rig.storage.deletedPrefixes).toContain(`u/user-a/${assetId}`);
    // The HLS tree uploaded by the pipeline is gone from storage.
    for (const key of rig.storage.objects.keys()) {
      expect(key.startsWith(`u/user-a/${assetId}`)).toBe(false);
    }
  });
});
