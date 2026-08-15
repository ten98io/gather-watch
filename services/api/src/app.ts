/**
 * App factory: builds the Fastify instance, wires deps (store/bus/events/hub),
 * registers plugins, the WS hub, and every feature module. Tests import this
 * only — server.ts owns the listen/shutdown lifecycle.
 */
import fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { AppConfig } from './config';
import { createBus, createStore } from './adapters/index';
import type { BusPort, StorePort } from './adapters/ports';
import { registerErrorMapper } from './plugins/error-mapper';
import { registerAuth } from './plugins/auth';
import { registerMetrics } from './plugins/metrics';
import { registerRateLimit } from './plugins/rate-limit';
import { createEventWriter } from './ws/events';
import { RoomHub, registerWs } from './ws/hub';
import { modules } from './modules/index';
import type { Deps } from './modules/types';

export interface BuildAppOptions {
  config: AppConfig;
  /** Defaults to createStore(config) — tests inject the memory store. */
  store?: StorePort;
  /** Defaults to createBus(config) — tests inject the memory bus. */
  bus?: BusPort;
}

export interface BuiltApp {
  app: FastifyInstance;
  deps: Deps;
  hub: RoomHub;
}

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const { config } = opts;
  const store = opts.store ?? createStore(config);
  const bus = opts.bus ?? createBus(config);

  const app = fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : config.nodeEnv === 'development'
          ? { level: 'debug' }
          : { level: 'info' },
  });

  await store.init();

  await app.register(cookie);
  await app.register(cors, { origin: [config.appUrl], credentials: true });
  await app.register(websocket);

  // Deps: the hub is constructed with everything but itself, then handed the
  // full object before any connection can be accepted.
  const events = createEventWriter({ store, bus, log: app.log });
  const hub = new RoomHub({ config, log: app.log, store, bus, events });
  const deps: Deps = { config, log: app.log, store, bus, events, hub };
  hub.setDeps(deps);
  app.decorate('deps', deps);

  registerErrorMapper(app);
  registerAuth(app);
  registerMetrics(app);
  await registerRateLimit(app);

  registerWs(app, hub);

  for (const mod of modules) {
    hub.registerModule(mod);
    if (mod.routes !== undefined) {
      await app.register(mod.routes);
    }
  }

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    const ok = await store.ping();
    return reply.status(ok ? 200 : 503).send({ ok });
  });

  app.addHook('onClose', async () => {
    await hub.close();
    await bus.close();
    await store.close();
  });

  return { app, deps, hub };
}
