/**
 * Failure-mode tests for the realtime seam: what happens when the BUS is slow,
 * unreachable, or quietly absent. Every case here used to look healthy —
 * /readyz green on a dead bus, a socket "connected" but deaf, a room whose
 * event pipeline stopped forever — which is exactly why they are pinned.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { RoomId } from '@gather/contracts';
import { buildApp } from '../src/app';
import type { BuiltApp } from '../src/app';
import { MemoryBus } from '../src/adapters/memory-bus';
import { MemoryStore } from '../src/adapters/memory-store';
import type { BusHandler, BusPort, RoomBusMessage } from '../src/adapters/ports';
import { addMember, seedRoom, signupUser, testConfig } from './helpers';
import type { TestConfigOverrides } from './helpers';

// ── fake buses ───────────────────────────────────────────────────────────────

/** Reachable, but reports itself dead (Redis configured and not answering). */
class DeadPingBus extends MemoryBus {
  override async ping(): Promise<boolean> {
    return false;
  }
}

/** subscribe() never settles — an unreachable Redis with ioredis' command
 *  queue swallowing the SUBSCRIBE. */
class StallingSubscribeBus extends MemoryBus {
  override subscribe(_channel: string, _handler: BusHandler): Promise<() => Promise<void>> {
    return new Promise(() => undefined);
  }
}

/** ping() THROWS rather than answering false — the shape a real adapter takes
 *  when the client blows up instead of reporting a dead connection. */
class ThrowingPingBus extends MemoryBus {
  override async ping(): Promise<boolean> {
    throw new Error('bus ping exploded');
  }
}

class ThrowingPingStore extends MemoryStore {
  override async ping(): Promise<boolean> {
    throw new Error('store ping exploded');
  }
}

/** Records publish order, and can stall a publish forever (Redis stall: the
 *  command neither completes nor rejects) or delay it by a fixed time. */
class ScriptedPublishBus extends MemoryBus {
  /** seq of every event handed to publish, in call order. */
  readonly publishedSeqs: number[] = [];
  /** Publishes to stall forever, matched by event seq. */
  stallSeqs = new Set<number>();
  /** ms to delay each publish before it lands. */
  delayMs = 0;

  override async publish(channel: string, message: unknown): Promise<void> {
    const seq = ((message as RoomBusMessage).event as { seq: number }).seq;
    this.publishedSeqs.push(seq);
    if (this.stallSeqs.has(seq)) return new Promise<void>(() => undefined);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return super.publish(channel, message);
  }
}

/** Fails the first seq allocation only (a momentary store outage). */
class FlakyFirstSeqStore extends MemoryStore {
  private failed = false;

  override async nextSeq(scope: string): Promise<number> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('nextSeq unavailable');
    }
    return super.nextSeq(scope);
  }
}

// ── rig ──────────────────────────────────────────────────────────────────────

interface Rig extends BuiltApp {
  store: MemoryStore;
}

async function makeRigApp(bus: BusPort, overrides: TestConfigOverrides = {}): Promise<Rig> {
  const store = new MemoryStore();
  const built = await buildApp({ config: testConfig(overrides), store, bus });
  return { ...built, store };
}

/** Resolve to `fallback` if `work` has not settled within `ms` — turns "this
 *  hangs forever" into a readable assertion instead of a suite timeout. */
function orAfter<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return Promise.race([
    work,
    new Promise<F>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      timer.unref();
    }),
  ]);
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.once('open', () => resolve(sock));
    sock.once('error', (err: Error) => reject(err));
  });
}

function closeCode(sock: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    sock.once('close', (code) => resolve(code));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Listen on a loopback port and return it. */
async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

// ── /readyz covers the bus ───────────────────────────────────────────────────

describe('/readyz', () => {
  it('is 503 when the bus is configured but not answering', async () => {
    const rig = await makeRigApp(new DeadPingBus(), { redisUrl: 'redis://configured:6379' });
    try {
      const res = await rig.app.inject({ method: 'GET', url: '/readyz' });
      // The store is perfectly healthy — only the bus is down, and a green
      // /readyz here is what ships a deaf instance through a Railway deploy.
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, store: true, bus: false });
    } finally {
      await rig.app.close();
    }
  });

  it('is 503 when production fell back to the in-memory bus (empty REDIS_URL)', async () => {
    const rig = await makeRigApp(new MemoryBus(), { nodeEnv: 'production', redisUrl: null });
    try {
      const res = await rig.app.inject({ method: 'GET', url: '/readyz' });
      // MemoryBus pings true — it IS alive. It just isn't shared, which in a
      // multi-instance deploy means this instance's events reach nobody.
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, store: true, bus: true, busMode: 'memory' });
    } finally {
      await rig.app.close();
    }
  });

  it('is 200 for an intentional in-memory bus in development', async () => {
    const rig = await makeRigApp(new MemoryBus());
    try {
      const res = await rig.app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, store: true, bus: true, busMode: 'memory' });
    } finally {
      await rig.app.close();
    }
  });

  it('is 503, not 500, when the BUS probe throws instead of answering', async () => {
    const rig = await makeRigApp(new ThrowingPingBus());
    try {
      const res = await rig.app.inject({ method: 'GET', url: '/readyz' });
      // A throwing probe means unhealthy. Letting it reject turns /readyz into
      // a 500 through the error mapper — and Railway gates zero-downtime
      // deploys on this endpoint, so the difference is a deploy that ships.
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, store: true, bus: false });
    } finally {
      await rig.app.close();
    }
  });

  it('is 503, not 500, when the STORE probe throws instead of answering', async () => {
    const built = await buildApp({
      config: testConfig(),
      store: new ThrowingPingStore(),
      bus: new MemoryBus(),
    });
    try {
      const res = await built.app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, store: false, bus: true });
    } finally {
      await built.app.close();
    }
  });

  it('reports the mode of the bus actually in use, not the one REDIS_URL implies', async () => {
    // REDIS_URL is set, but this process is running an in-memory bus (buildApp
    // takes an injected one). An operator reading /readyz must be told what is
    // RUNNING; a mode derived from config describes a bus that isn't there.
    const rig = await makeRigApp(new MemoryBus(), { redisUrl: 'redis://configured:6379' });
    try {
      const res = await rig.app.inject({ method: 'GET', url: '/readyz' });
      expect(res.json()).toMatchObject({ busMode: 'memory' });
    } finally {
      await rig.app.close();
    }
  });
});

// ── the handshake survives a stalled bus ─────────────────────────────────────

describe('ws handshake with a stalled bus', () => {
  it('still unregisters a socket the client closes while the subscribe hangs', async () => {
    const rig = await makeRigApp(new StallingSubscribeBus());
    const port = await listen(rig.app);
    try {
      const { roomId } = await seedRoom(rig.store);
      const account = await signupUser(rig.app, 'stalled-close@example.com');
      await addMember(rig.store, roomId, account.user.id, 'member');

      const sock = await openSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
      );
      // Let accept() get as far as the (never-resolving) bus subscribe.
      await sleep(300);
      expect(rig.hub.stats().connections).toBe(1);

      // The client hangs up. Without a 'close' listener attached before the
      // await, this socket stays in the broadcast set forever.
      sock.close();
      await sleep(300);
      expect(rig.hub.stats().connections).toBe(0);
    } finally {
      await rig.app.close();
    }
  }, 20_000);

  it('closes the socket with 1013 instead of leaving it connected and deaf', async () => {
    const rig = await makeRigApp(new StallingSubscribeBus());
    const port = await listen(rig.app);
    try {
      const { roomId } = await seedRoom(rig.store);
      const account = await signupUser(rig.app, 'stalled-1013@example.com');
      await addMember(rig.store, roomId, account.user.id, 'member');

      const sock = await openSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
      );
      // -1 stands for "never closed" — the pre-fix behaviour, where the client
      // believes it is connected and receives nothing forever.
      const code = await orAfter(closeCode(sock), 10_000, -1);
      expect(code).toBe(1013);
      expect(rig.hub.stats().connections).toBe(0);
    } finally {
      await rig.app.close();
    }
  }, 20_000);

  it('shuts down without parking on a subscribe that never settles', async () => {
    const rig = await makeRigApp(new StallingSubscribeBus());
    const port = await listen(rig.app);
    try {
      const { roomId } = await seedRoom(rig.store);
      const account = await signupUser(rig.app, 'stalled-shutdown@example.com');
      await addMember(rig.store, roomId, account.user.id, 'member');

      const sock = await openSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
      );
      // accept() is parked on the bus subscribe, so the room's BusSub entry
      // exists with a `subscribing` promise that will never settle.
      await sleep(300);
      expect(rig.hub.stats().connections).toBe(1);

      const startedAt = Date.now();
      await rig.hub.close();
      // An unsub() that AWAITS the never-settling subscribe never resolves, so
      // shutdown only returns when its 1s ceiling expires — and every teardown
      // that took that path left a pending promise chain behind it.
      expect(Date.now() - startedAt).toBeLessThan(400);
      sock.close();
    } finally {
      await rig.app.close();
    }
  }, 20_000);
});

// ── the handshake leaves no timer behind ─────────────────────────────────────

describe('ws handshake timers', () => {
  it('disarms the bus-subscribe expiry timer once the subscribe has landed', async () => {
    // The hub's handshake ceiling (BUS_SUBSCRIBE_TIMEOUT_MS = 3s). The losing
    // side of a Promise.race stays armed unless it is cleared, so a healthy
    // instance accumulates one live 3s timer per connection.
    const BUS_SUBSCRIBE_TIMEOUT_MS = 3_000;
    const rig = await makeRigApp(new MemoryBus());
    const port = await listen(rig.app);
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const { roomId } = await seedRoom(rig.store);
      const account = await signupUser(rig.app, 'timer-disarm@example.com');
      await addMember(rig.store, roomId, account.user.id, 'member');

      const sock = await openSocket(
        `ws://127.0.0.1:${port}/ws?roomId=${roomId}&token=${account.accessToken}`,
      );
      await sleep(200);
      expect(rig.hub.stats().connections).toBe(1);

      const armed = setSpy.mock.calls
        .map((call, i) => ({ delay: call[1] as number, handle: setSpy.mock.results[i]?.value }))
        .filter((entry) => entry.delay === BUS_SUBSCRIBE_TIMEOUT_MS)
        .map((entry) => entry.handle);
      expect(armed.length).toBeGreaterThan(0);
      const cleared = clearSpy.mock.calls.map((call) => call[0]);
      for (const handle of armed) {
        expect(cleared).toContain(handle);
      }
      sock.close();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      await rig.app.close();
    }
  }, 20_000);
});

// ── one stalled publish must not wedge the room ──────────────────────────────

describe('event emit chain', () => {
  it('keeps emitting after a publish that never settles', async () => {
    const bus = new ScriptedPublishBus();
    const rig = await makeRigApp(bus);
    try {
      const { roomId } = await seedRoom(rig.store);
      // The FIRST persisted event of the room stalls in publish forever.
      bus.stallSeqs.add(1);

      const first = rig.deps.events.emit(roomId as RoomId, 'sync.waiting', { waitingOn: [] });
      const second = rig.deps.events.emit(roomId as RoomId, 'sync.waiting', { waitingOn: [] });
      const settled = await orAfter(Promise.all([first, second]), 8_000, 'WEDGED' as const);
      // 'WEDGED' means the room's whole event pipeline — chat, sync, queue,
      // roster — is stopped until the process restarts.
      expect(settled).not.toBe('WEDGED');

      const events = settled as Awaited<typeof first>[];
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
      // Both are durably persisted, which is what makes seq-gap replay a real
      // recovery path for the event whose publish was lost.
      expect(await rig.store.events.count({ roomId })).toBe(2);
    } finally {
      await rig.app.close();
    }
  }, 20_000);

  it('does not swallow the emits queued behind one that rejected', async () => {
    const store = new FlakyFirstSeqStore();
    const built = await buildApp({ config: testConfig(), store, bus: new MemoryBus() });
    try {
      const { roomId } = await seedRoom(store);
      const doomed = built.deps.events.emit(roomId as RoomId, 'sync.waiting', { waitingOn: [] });
      // Queued behind the failing one, in the same tick — chaining off the
      // predecessor's SUCCESS would drop this emit's body on the floor and
      // reject it with the predecessor's error.
      const queued = built.deps.events.emit(roomId as RoomId, 'sync.waiting', { waitingOn: [] });
      await expect(doomed).rejects.toThrow(/nextSeq unavailable/);
      const event = await queued;
      expect(event.seq).toBe(1);
      expect(await store.events.count({ roomId })).toBe(1);
    } finally {
      await built.app.close();
    }
  }, 20_000);

  it('still publishes in seq order when publishes resolve slowly', async () => {
    const bus = new ScriptedPublishBus();
    bus.delayMs = 25;
    const rig = await makeRigApp(bus);
    try {
      const { roomId } = await seedRoom(rig.store);
      const emits = [1, 2, 3, 4].map(() =>
        rig.deps.events.emit(roomId as RoomId, 'sync.waiting', { waitingOn: [] }),
      );
      const events = await Promise.all(emits);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      // The ordering guarantee the per-room chain exists for: publish order
      // matches seq order, bounded timeout or not.
      expect(bus.publishedSeqs).toEqual([1, 2, 3, 4]);
    } finally {
      await rig.app.close();
    }
  }, 20_000);
});

// ── request.ip behind the edge ───────────────────────────────────────────────

describe('trustProxy', () => {
  async function ipFor(rig: Rig, forwardedFor?: string): Promise<string> {
    const res = await rig.app.inject({
      method: 'GET',
      url: '/ip-probe',
      ...(forwardedFor !== undefined ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
    });
    return (res.json() as { ip: string }).ip;
  }

  /** A route added after buildApp, so the probe sees the real Fastify config. */
  function addProbe(rig: Rig): void {
    rig.app.get('/ip-probe', { config: { rateLimit: false } }, async (request) => ({
      ip: request.ip,
    }));
  }

  it('resolves request.ip through exactly one proxy hop in production', async () => {
    const rig = await makeRigApp(new MemoryBus(), { nodeEnv: 'production' });
    addProbe(rig);
    try {
      // Railway's edge appends the real client; without trustProxy every user
      // behind it shares one rate-limit bucket keyed on the edge's own address.
      expect(await ipFor(rig, '203.0.113.7')).toBe('203.0.113.7');
      // Only ONE hop is trusted, so a client that forges a longer chain cannot
      // choose which address the app believes — the edge-appended entry wins.
      expect(await ipFor(rig, '198.51.100.9, 203.0.113.7')).toBe('203.0.113.7');
    } finally {
      await rig.app.close();
    }
  });

  it('ignores X-Forwarded-For outside production, where nothing sits in front', async () => {
    const rig = await makeRigApp(new MemoryBus());
    addProbe(rig);
    try {
      expect(await ipFor(rig, '203.0.113.7')).toBe('127.0.0.1');
    } finally {
      await rig.app.close();
    }
  });
});
