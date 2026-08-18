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

/**
 * Runs one readiness probe, treating a THROWN error as "not ready". A probe
 * that rejects would take /readyz down through the error mapper as a 500, and
 * a 500 there is a different fact than a 503: Railway gates zero-downtime
 * deploys on this endpoint, and the error mapper's 500 is indistinguishable
 * from the app being broken in some unrelated way.
 */
async function probe(run: () => Promise<boolean>): Promise<boolean> {
  try {
    return await run();
  } catch {
    return false;
  }
}

/**
 * Refuse to build on a production configuration that can never become ready.
 *
 * /readyz is honest about the in-memory bus — an instance that cannot reach
 * its peers is not ready, and saying otherwise ships a deaf instance. But
 * honesty is the wrong TOOL for a missing environment variable: Railway gates
 * the deploy on /readyz, so an unset REDIS_URL produced a container that came
 * up fine, answered 503 forever, timed out the healthcheck and rolled back
 * with an error message about the healthcheck — which is a symptom three steps
 * removed from the cause, and identical to the message you get when Redis is
 * merely down. Nothing in that loop ever names the variable.
 *
 * So the two failures are separated by KIND rather than folded together:
 *
 *   • a MISCONFIGURATION cannot heal and must never start. It fails here,
 *     before a socket is opened, with a message naming the variable, what was
 *     silently substituted, and what that costs. Railway surfaces it as a
 *     crashed deploy with that line in the logs — one hop from cause to fix.
 *   • a RUNTIME failure (Redis configured but unreachable, store not
 *     answering) still becomes a 503 on /readyz, which is exactly what a
 *     healthcheck is for, and now carries a `reason`.
 *
 * INJECTED adapters are exempt: passing a store or bus is a deliberate choice
 * by an embedder or a test, and buildApp has no business overruling it. The
 * check is therefore about the config path only — which is precisely the path
 * a deploy takes (server.ts passes neither).
 */
function assertProductionBackingServices(opts: BuildAppOptions): void {
  const { config } = opts;
  if (config.nodeEnv !== 'production') {
    return;
  }
  const missing: string[] = [];
  if (opts.bus === undefined && config.redisUrl === null) {
    missing.push(
      'REDIS_URL is unset or empty, so the bus fell back to MemoryBus: this instance would be ' +
        'realtime-isolated — every socket it owns is cut off from the other instances',
    );
  }
  if (opts.store === undefined && config.mongoUrl === null) {
    missing.push(
      'MONGO_URL is unset or empty, so the store fell back to MemoryStore: every room, message ' +
        'and account would be lost on the next restart',
    );
  }
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `gather-api refuses to start in production: ${missing.join(' | ')}. ` +
      'Set the variable(s) on the service and redeploy. (Failing at boot on purpose — the ' +
      'alternative is a container that never passes its /readyz healthcheck and rolls back ' +
      'without naming the cause. An env var set to the empty string counts as absent.)',
  );
}

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const { config } = opts;
  assertProductionBackingServices(opts);
  const store = opts.store ?? createStore(config);
  const bus = opts.bus ?? createBus(config);

  const app = fastify({
    // Railway terminates TLS at its edge and the api is reachable ONLY through
    // it, so exactly one proxy hop is trustworthy: request.ip becomes the real
    // client (the /ws upgrade's rate-limit bucket is keyed on it, and without
    // this every user behind the edge shares one bucket) while an
    // X-Forwarded-For chain a client wrote itself is still discarded past that
    // hop. Off everywhere else: nothing sits in front of a local process, so
    // any XFF there is forged by definition.
    trustProxy: config.nodeEnv === 'production' ? 1 : false,
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
  await app.register(websocket, {
    options: {
      // Inbound-frame byte ceiling. The frame RATE limiter lives in the hub
      // (300/10s), but a rate limiter does nothing about one 100 MiB frame —
      // ws's default maxPayload — whose JSON.parse would be a room member's
      // one-shot CPU/memory spike. The largest legitimate envelope (a chat
      // body, a queue item) is a few KB; 64 KB is generous headroom.
      maxPayload: 64 * 1024,
    },
  });

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
  // Readiness must cover every dependency a served request needs, and realtime
  // needs the bus as much as the store: an unreachable Redis leaves this
  // instance able to answer REST while every socket it owns is cut off from
  // the other instances. Two distinct failures are folded in here:
  //   - the bus is configured but not answering  → bus.ping() is false;
  //   - the bus is not configured at all in prod → empty/typo'd REDIS_URL fell
  //     back to MemoryBus (adapters/index.ts), which pings true because it IS
  //     alive; it just isn't shared. In development that is the intended
  //     single-instance setup and stays ready.
  // The mode comes off the BUS IN USE, not off REDIS_URL: buildApp takes an
  // injected bus, so config describes intent while bus.mode describes reality.
  //
  // A 503 also has to SAY WHY. Three different facts land on the same status
  // code, and an operator reading a failing healthcheck can otherwise only
  // guess which one they are looking at — so `reason` names it.
  const busMode = bus.mode;
  const busIsShareable = busMode === 'redis' || config.nodeEnv !== 'production';
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    const [storeOk, busOk] = await Promise.all([
      probe(() => store.ping()),
      probe(() => bus.ping()),
    ]);
    const ok = storeOk && busOk && busIsShareable;
    const reasons: string[] = [];
    if (!storeOk) reasons.push('store is not answering');
    if (!busOk) reasons.push('bus is not answering');
    if (!busIsShareable) {
      reasons.push(
        'bus is in-memory in production, so this instance is isolated from every other instance ' +
          '(an injected bus — buildApp refuses to boot a config-derived one)',
      );
    }
    return reply.status(ok ? 200 : 503).send({
      ok,
      store: storeOk,
      bus: busOk,
      busMode,
      ...(ok ? {} : { reason: reasons.join('; ') }),
    });
  });

  app.addHook('onClose', async () => {
    await hub.close();
    await bus.close();
    await store.close();
  });

  return { app, deps, hub };
}
