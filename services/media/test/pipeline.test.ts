import { afterEach, describe, expect, it } from 'vitest';
import { completeUpload, makeRig } from './helpers';
import type { TestRig } from './helpers';

describe('processing pipeline (fake runner)', () => {
  let rig: TestRig;

  afterEach(async () => {
    await rig.built.app.close();
  });

  it('video source → ready with hls + thumbnail, no waveform', async () => {
    rig = await makeRig();
    const assetId = await completeUpload(rig, 'user-a');
    const doc = await rig.store.findById(assetId);
    const prefix = `public/u/user-a/${assetId}/hls`;
    expect(doc).toMatchObject({
      status: 'ready',
      durationMs: 1234,
      hlsUrl: `http://cdn.test/media/${prefix}/master.m3u8`,
      thumbnailUrl: `http://cdn.test/media/${prefix}/thumb.jpg`,
      waveformUrl: null,
      error: null,
    });
    // The fake runner's artifact tree was uploaded verbatim.
    expect(rig.storage.objects.has(`${prefix}/master.m3u8`)).toBe(true);
    expect(rig.storage.objects.has(`${prefix}/vs0/index.m3u8`)).toBe(true);
    expect(rig.storage.objects.has(`${prefix}/vs0/seg00000.ts`)).toBe(true);
    expect(rig.storage.objects.has(`${prefix}/thumb.jpg`)).toBe(true);
    expect(rig.runner.transcodeCalls).toHaveLength(1);
  });

  it('audio-only source → ready with waveform, no thumbnail', async () => {
    rig = await makeRig();
    rig.runner.probeResult = {
      durationMs: 65_000,
      hasVideo: false,
      hasAudio: true,
      width: null,
      height: null,
    };
    const assetId = await completeUpload(rig, 'user-a');
    const doc = await rig.store.findById(assetId);
    const prefix = `public/u/user-a/${assetId}/hls`;
    expect(doc).toMatchObject({
      status: 'ready',
      durationMs: 65_000,
      hlsUrl: `http://cdn.test/media/${prefix}/master.m3u8`,
      thumbnailUrl: null,
      waveformUrl: `http://cdn.test/media/${prefix}/waveform.json`,
    });
    expect(rig.storage.objects.has(`${prefix}/waveform.json`)).toBe(true);
  });

  it('transcode failure → failed with the error message recorded', async () => {
    rig = await makeRig();
    rig.runner.failTranscode = new Error('boom: ffmpeg exploded');
    const assetId = await completeUpload(rig, 'user-a');
    const doc = await rig.store.findById(assetId);
    expect(doc?.status).toBe('failed');
    expect(doc?.error).toContain('boom');
    expect(doc?.hlsUrl).toBeNull();
  });

  it('probe failure → failed', async () => {
    rig = await makeRig();
    rig.runner.failProbe = new Error('not a media file');
    const assetId = await completeUpload(rig, 'user-a');
    const doc = await rig.store.findById(assetId);
    expect(doc?.status).toBe('failed');
    expect(doc?.error).toContain('not a media file');
  });
});
