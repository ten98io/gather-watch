/**
 * /readyz is honest and a deploy still ships.
 *
 * The bind: Railway gates the zero-downtime deploy on /readyz, and /readyz
 * reports 503 when a production instance is running the in-memory bus. Both
 * halves are right on their own and together they produced the worst possible
 * failure — an unset REDIS_URL booted a healthy-looking container that
 * answered 503 forever, timed out the healthcheck, and rolled the deploy back
 * with a message about the healthcheck. Nothing named the variable, and it
 * looked identical to "Redis is down".
 *
 * The split pinned here is by KIND of failure:
 *   • misconfiguration (a config-derived adapter that fell back in production)
 *     never starts, and says which variable and what it costs;
 *   • runtime failure still becomes a 503, now carrying a `reason`.
 * Injected adapters are exempt from the boot check — an embedder or a test
 * passing a bus has made a deliberate choice.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { MemoryBus } from '../src/adapters/memory-bus';
import { MemoryStore } from '../src/adapters/memory-store';
import { testConfig } from './helpers';

/** buildApp resolves an app that must be closed; capture the error instead. */
async function buildError(opts: Parameters<typeof buildApp>[0]): Promise<Error | null> {
  try {
    const built = await buildApp(opts);
    await built.app.close();
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe('production refuses to boot on a config that can never be ready', () => {
  it('names REDIS_URL, the fallback it made, and the cost', async () => {
    const err = await buildError({
      config: testConfig({ nodeEnv: 'production', redisUrl: null, mongoUrl: 'mongodb://db/x' }),
    });
    expect(err).not.toBeNull();
    expect(err?.message).toContain('REDIS_URL');
    expect(err?.message).toContain('MemoryBus');
    expect(err?.message).toContain('realtime-isolated');
    // The operator must be told this is deliberate, or the next person
    // "fixes" it by removing the check.
    expect(err?.message).toContain('/readyz');
  });

  it('names MONGO_URL too — the same silent fallback, with data loss attached', async () => {
    const err = await buildError({
      config: testConfig({
        nodeEnv: 'production',
        redisUrl: 'redis://cache:6379',
        mongoUrl: null,
      }),
    });
    expect(err?.message).toContain('MONGO_URL');
    expect(err?.message).toContain('lost on the next restart');
  });

  it('reports BOTH when both are missing, rather than one at a time', async () => {
    const err = await buildError({
      config: testConfig({ nodeEnv: 'production', redisUrl: null, mongoUrl: null }),
    });
    expect(err?.message).toContain('REDIS_URL');
    expect(err?.message).toContain('MONGO_URL');
  });

  it('does not veto an INJECTED adapter — that is a deliberate choice', async () => {
    const err = await buildError({
      config: testConfig({ nodeEnv: 'production', redisUrl: null, mongoUrl: null }),
      store: new MemoryStore(),
      bus: new MemoryBus(),
    });
    expect(err).toBeNull();
  });

  it('leaves development alone', async () => {
    expect(await buildError({ config: testConfig({ redisUrl: null, mongoUrl: null }) })).toBeNull();
  });
});

describe('a 503 from /readyz says which failure it is', () => {
  it('explains the isolated in-memory bus rather than just failing', async () => {
    const built = await buildApp({
      config: testConfig({ nodeEnv: 'production', redisUrl: null }),
      store: new MemoryStore(),
      bus: new MemoryBus(),
    });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { reason?: string; busMode: string };
      expect(body.busMode).toBe('memory');
      expect(body.reason).toContain('isolated');
    } finally {
      await built.app.close();
    }
  });

  it('says nothing extra when it is ready', async () => {
    const built = await buildApp({
      config: testConfig(),
      store: new MemoryStore(),
      bus: new MemoryBus(),
    });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('reason');
    } finally {
      await built.app.close();
    }
  });
});
