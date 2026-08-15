/**
 * Test harness: memory asset store + fake object storage + fake pipeline
 * runner (no S3, no ffmpeg, no mongo). Configure fakes BEFORE triggering the
 * requests that consume them (the pipeline starts on the microtask queue as
 * soon as /complete returns).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import type { BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { AppConfig } from '../src/config';
import { MemoryAssetStore } from '../src/store/memory';
import type { CompletedPart, ObjectStorage } from '../src/storage/ports';
import type { PipelineRunner, ProbeResult, TranscodeJob } from '../src/pipeline/ports';
import { newId, signAccessToken } from '../src/lib/tokens';

export const TEST_SECRET = 'test-secret-at-least-32-characters-long!';

export function testConfig(env: Record<string, string> = {}): AppConfig {
  // The pipeline defaults OFF in production config; tests exercise it ON
  // unless a test explicitly overrides the flag.
  return loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: TEST_SECRET,
    ENABLE_MEDIA_PIPELINE: 'true',
    ...env,
  });
}

export class FakeStorage implements ObjectStorage {
  pingOk = true;
  readonly objects = new Map<string, Buffer>();
  readonly multipart = new Map<string, { key: string; mime: string }>();
  readonly completed: Array<{ key: string; uploadId: string; parts: CompletedPart[] }> = [];
  readonly aborted: Array<{ key: string; uploadId: string }> = [];
  readonly deletedPrefixes: string[] = [];
  private seq = 0;

  async ping(): Promise<boolean> {
    return this.pingOk;
  }

  async createMultipartUpload(key: string, mime: string): Promise<string> {
    this.seq += 1;
    const uploadId = `fake-upload-${this.seq}`;
    this.multipart.set(uploadId, { key, mime });
    return uploadId;
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number): string {
    return `http://minio.test/media/${key}?uploadId=${uploadId}&partNumber=${partNumber}`;
  }

  /** headObject size override: simulates a client that PUT more (or fewer)
   *  bytes through the unsigned-payload part URLs than it declared — without
   *  actually allocating that many bytes in the fake. */
  finalizedSizeBytes: number | null = null;

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<void> {
    this.completed.push({ key, uploadId, parts: [...parts] });
    // The finalized object now exists — the pipeline downloads it.
    this.objects.set(key, Buffer.from('fake-source-bytes'));
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.aborted.push({ key, uploadId });
  }

  async getObject(key: string): Promise<Buffer> {
    const body = this.objects.get(key);
    if (body === undefined) throw new Error(`fake storage: no object at ${key}`);
    return body;
  }

  async getObjectToFile(key: string, destPath: string): Promise<void> {
    await writeFile(destPath, await this.getObject(key));
  }

  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    return { sizeBytes: this.finalizedSizeBytes ?? body.length };
  }

  async putObject(key: string, body: Buffer, _contentType: string): Promise<void> {
    this.objects.set(key, body);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    this.deletedPrefixes.push(prefix);
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }

  publicUrl(key: string): string {
    return `http://cdn.test/media/${key}`;
  }
}

export class FakeRunner implements PipelineRunner {
  probeResult: ProbeResult = {
    durationMs: 1234,
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
  };
  failProbe: Error | null = null;
  failTranscode: Error | null = null;
  readonly transcodeCalls: TranscodeJob[] = [];

  async probe(_inputPath: string): Promise<ProbeResult> {
    if (this.failProbe !== null) throw this.failProbe;
    return this.probeResult;
  }

  async transcode(job: TranscodeJob, probe: ProbeResult): Promise<void> {
    this.transcodeCalls.push(job);
    if (this.failTranscode !== null) throw this.failTranscode;
    await mkdir(join(job.outputDir, 'vs0'), { recursive: true });
    await writeFile(join(job.outputDir, 'master.m3u8'), '#EXTM3U\n', 'utf8');
    await writeFile(join(job.outputDir, 'vs0', 'index.m3u8'), '#EXTM3U\n', 'utf8');
    await writeFile(join(job.outputDir, 'vs0', 'seg00000.ts'), Buffer.from('segment'));
    if (probe.hasVideo) {
      await writeFile(join(job.outputDir, 'thumb.jpg'), Buffer.from('jpeg-bytes'));
    } else {
      await writeFile(
        join(job.outputDir, 'waveform.json'),
        JSON.stringify({ version: 1, peaks: [0.1, 0.5] }),
        'utf8',
      );
    }
  }
}

export interface TestRig {
  built: BuiltApp;
  config: AppConfig;
  store: MemoryAssetStore;
  storage: FakeStorage;
  runner: FakeRunner;
  tokenFor(userId: string): Promise<string>;
  guestTokenFor(userId: string, roomId?: string): Promise<string>;
}

export async function makeRig(env: Record<string, string> = {}): Promise<TestRig> {
  const config = testConfig(env);
  const store = new MemoryAssetStore();
  const storage = new FakeStorage();
  const runner = new FakeRunner();
  const built = await buildApp({ config, store, storage, runner });
  const tokenFor = (userId: string): Promise<string> =>
    signAccessToken(config, { userId, sessionId: newId(), guest: false, guestRoomId: null });
  const guestTokenFor = (userId: string, roomId = 'room-1'): Promise<string> =>
    signAccessToken(config, { userId, sessionId: newId(), guest: true, guestRoomId: roomId });
  return { built, config, store, storage, runner, tokenFor, guestTokenFor };
}

/** Create + complete an upload end-to-end, then drain the pipeline. */
export async function completeUpload(
  rig: TestRig,
  userId: string,
  sizeBytes = 1024,
): Promise<string> {
  const token = await rig.tokenFor(userId);
  const created = await rig.built.app.inject({
    method: 'POST',
    url: '/uploads',
    headers: { authorization: `Bearer ${token}` },
    payload: { filename: 'clip.mp4', mime: 'video/mp4', sizeBytes },
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
      parts: parts.map((p) => ({ partNumber: p.partNumber, etag: `"etag-${p.partNumber}"` })),
    },
  });
  if (done.statusCode !== 200) throw new Error(`completeUpload failed: ${done.body}`);
  await rig.built.deps.pipeline.drain();
  return assetId;
}
