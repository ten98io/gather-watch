/**
 * App factory: builds the Fastify instance, wires deps (store/storage/
 * pipeline), registers plugins and routes. Tests import this only —
 * server.ts owns the listen/shutdown lifecycle.
 */
import fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config';
import type { Deps } from './deps';
import type { AssetStore } from './store/ports';
import { createAssetStore } from './store/index';
import type { ObjectStorage } from './storage/ports';
import { S3Storage } from './storage/s3';
import type { PipelineRunner } from './pipeline/ports';
import { FfmpegRunner } from './pipeline/ffmpeg';
import { SerialMediaPipeline } from './pipeline/pipeline';
import { registerErrorMapper } from './plugins/error-mapper';
import { registerAuth } from './plugins/auth';
import { uploadRoutes } from './routes/uploads';
import { libraryRoutes } from './routes/library';

export interface BuildAppOptions {
  config: AppConfig;
  /** Defaults to createAssetStore(config) — tests inject the memory store. */
  store?: AssetStore;
  /** Defaults to the SigV4 S3 client — tests inject a fake. */
  storage?: ObjectStorage;
  /** Defaults to the ffmpeg runner — tests inject a fake. */
  runner?: PipelineRunner;
}

export interface BuiltApp {
  app: FastifyInstance;
  deps: Deps;
}

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const { config } = opts;
  const store = opts.store ?? createAssetStore(config);
  const storage = opts.storage ?? new S3Storage(config.s3, config.presignTtlSec);
  const runner = opts.runner ?? new FfmpegRunner(config);

  const app = fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : config.nodeEnv === 'development'
          ? { level: 'debug' }
          : { level: 'info' },
  });

  await store.init();

  await app.register(cors, { origin: [config.appUrl], credentials: true });

  const pipeline = new SerialMediaPipeline({ config, log: app.log, store, storage, runner });
  const deps: Deps = { config, log: app.log, store, storage, pipeline };
  app.decorate('deps', deps);

  registerErrorMapper(app);
  registerAuth(app);
  await app.register(uploadRoutes);
  await app.register(libraryRoutes);

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) => {
    const [storeOk, storageOk] = await Promise.all([store.ping(), storage.ping()]);
    const ok = storeOk && storageOk;
    return reply.status(ok ? 200 : 503).send({ ok, store: storeOk, storage: storageOk });
  });

  app.addHook('onClose', async () => {
    await pipeline.drain();
    await store.close();
  });

  return { app, deps };
}
