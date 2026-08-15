/**
 * Pipeline orchestration: drives an asset through `processing → ready|failed`
 * after its upload completes. Downloads the source from object storage to a
 * temp dir, probes + transcodes via the PipelineRunner port, uploads the
 * produced artifact tree (`hls/` prefix on the asset's key root), and records
 * the outcome on the asset document.
 *
 * Execution is SERIAL per process (a single promise chain) — the service is
 * single-replica per deploy in the Railway topology, and serial execution
 * keeps ffmpeg from oversubscribing CPU. Status fanout: written to the shared
 * `assets` collection only; the api's WS `media.status` fanout is an
 * orchestrator TODO (no hook exists in services/api today).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config';
import type { AssetStore } from '../store/ports';
import type { ObjectStorage } from '../storage/ports';
import type { PipelineRunner } from './ports';
import { assetKeyPrefix } from '../lib/serialize';

export interface MediaPipeline {
  /** Queue processing for a just-completed asset. Fire-and-forget; failures
   *  land on the asset document (status 'failed'), never on the caller. */
  enqueue(assetId: string): void;
  /** Resolve when every queued job has settled (tests, graceful shutdown). */
  drain(): Promise<void>;
}

interface PipelineDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  store: AssetStore;
  storage: ObjectStorage;
  runner: PipelineRunner;
}

/** Content-Type by artifact extension (HLS tree + thumbnail + waveform). */
function contentTypeFor(relPath: string): string {
  if (relPath.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (relPath.endsWith('.ts')) return 'video/mp2t';
  if (relPath.endsWith('.jpg') || relPath.endsWith('.jpeg')) return 'image/jpeg';
  if (relPath.endsWith('.json')) return 'application/json';
  if (relPath.endsWith('.m4s')) return 'video/iso.segment';
  return 'application/octet-stream';
}

/** All files under dir, as posix-style relative paths (recursive). */
async function walkFiles(dir: string, base: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs, base)));
    } else if (entry.isFile()) {
      out.push(relative(base, abs).split(sep).join('/'));
    }
  }
  return out;
}

export class SerialMediaPipeline implements MediaPipeline {
  private readonly deps: PipelineDeps;
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  enqueue(assetId: string): void {
    this.tail = this.tail.then(() => this.process(assetId));
    // The chain itself must never reject — process() catches internally, but
    // belt-and-braces against unexpected escapes.
    this.tail = this.tail.catch((err: unknown) => {
      this.deps.log.error({ err, assetId }, 'pipeline job escaped error handling');
    });
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  private async process(assetId: string): Promise<void> {
    const { log, store, storage, runner } = this.deps;
    const doc = await store.findById(assetId);
    // Stale enqueue (deleted, or already transitioned) — nothing to do.
    if (doc === null || doc.status !== 'processing') return;
    if (doc.storageKey === null) {
      await store.update(assetId, { status: 'failed', error: 'asset has no storage key' });
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'playin-media-'));
    try {
      const inputPath = join(workDir, 'source');
      await writeFile(inputPath, await storage.getObject(doc.storageKey));

      const probe = await runner.probe(inputPath);
      const outputDir = join(workDir, 'out');
      await runner.transcode({ assetId, inputPath, outputDir }, probe);

      const prefix = `${assetKeyPrefix(doc.ownerId, doc.id)}/hls`;
      const files = await walkFiles(outputDir);
      for (const rel of files) {
        await storage.putObject(`${prefix}/${rel}`, await readFile(join(outputDir, rel)), contentTypeFor(rel));
      }

      const has = (rel: string): boolean => files.includes(rel);
      await store.update(assetId, {
        status: 'ready',
        durationMs: probe.durationMs,
        hlsUrl: has('master.m3u8') ? storage.publicUrl(`${prefix}/master.m3u8`) : null,
        thumbnailUrl: has('thumb.jpg') ? storage.publicUrl(`${prefix}/thumb.jpg`) : null,
        waveformUrl: has('waveform.json') ? storage.publicUrl(`${prefix}/waveform.json`) : null,
        error: null,
      });
      log.info({ assetId }, 'media pipeline: asset ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, assetId }, 'media pipeline: asset failed');
      await store.update(assetId, { status: 'failed', error: message.slice(0, 500) });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
