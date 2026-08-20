/**
 * Admin ops surface: the ADMIN_EMAILS gate (403 for non-admins, guests,
 * unknown accounts), overview/metrics payloads, the relay readout, the
 * reports → takedown flow, and usage aggregation. Runs fully on the memory
 * adapters with fetch stubbed — no Redis, no Mongo, no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UserId } from '@gather/contracts';
import {
  AdminMetricsResponse,
  AdminOverviewResponse,
  AdminReportsResponse,
  AdminUsageResponse,
} from '@gather/contracts';
import { makeApp, seedRoom, signupUser, testConfig } from '../../../test/helpers';
import type { TestApp, TestConfigOverrides } from '../../../test/helpers';
import { newId } from '../../../src/lib/tokens';
import { RELAY_STATUS_TTL_MS } from '../rtc/service';

const ADMIN_EMAIL = 'owner@example.com';

function adminConfig(overrides: TestConfigOverrides = {}) {
  return testConfig({ adminEmails: [ADMIN_EMAIL], ...overrides });
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.unstubAllGlobals();
});

async function adminApp(overrides: TestConfigOverrides = {}): Promise<{
  app: TestApp;
  token: string;
}> {
  const app = await makeApp(adminConfig(overrides));
  apps.push(app.app);
  const { accessToken } = await signupUser(app.app, ADMIN_EMAIL);
  return { app, token: accessToken };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Both Cloudflare TURN keys set — the deployment the owner THINKS they have. */
const CF_CONFIGURED: TestConfigOverrides = {
  cloudflare: { turnKeyId: 'kid', turnApiToken: 'cf-token' },
};

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchMock): ReturnType<typeof vi.fn<FetchMock>> {
  const mock = vi.fn<FetchMock>(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** A Cloudflare TURN-keys 200 carrying `urls`. */
function cloudflareResponse(urls: string[]): Response {
  return new Response(JSON.stringify({ iceServers: { urls } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function overview(app: TestApp, token: string): Promise<AdminOverviewResponse> {
  const res = await app.app.inject({
    method: 'GET',
    url: '/admin/overview',
    headers: authed(token),
  });
  expect(res.statusCode).toBe(200);
  return AdminOverviewResponse.parse(res.json());
}

describe('admin gate', () => {
  it('rejects unauthenticated, non-admin, and guest callers with 401/403', async () => {
    const { app, token } = await adminApp();

    const anon = await app.app.inject({ method: 'GET', url: '/admin/overview' });
    expect(anon.statusCode).toBe(401);

    const { accessToken: memberToken } = await signupUser(app.app, 'member@example.com');
    const notAdmin = await app.app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: authed(memberToken),
    });
    expect(notAdmin.statusCode).toBe(403);

    const ok = await app.app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: authed(token),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects every admin route for non-admins', async () => {
    const { app } = await adminApp();
    const { accessToken } = await signupUser(app.app, 'intruder@example.com');
    for (const url of [
      '/admin/overview',
      '/admin/metrics',
      '/admin/reports',
      '/admin/rooms',
      '/admin/users',
      '/admin/usage',
    ]) {
      const res = await app.app.inject({ method: 'GET', url, headers: authed(accessToken) });
      expect(res.statusCode, url).toBe(403);
    }
    const post = await app.app.inject({
      method: 'POST',
      url: '/admin/reports/resolve',
      headers: authed(accessToken),
      payload: { reportId: 'x', dismiss: false },
    });
    expect(post.statusCode).toBe(403);
  });
});

describe('admin overview + metrics', () => {
  it('reports contract-shaped counts, live gauges, adapters and features', async () => {
    const { app, token } = await adminApp();
    await seedRoom(app.store);

    const res = await app.app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: authed(token),
    });
    expect(res.statusCode).toBe(200);
    const body = AdminOverviewResponse.parse(res.json());
    expect(body.counts.users).toBe(2); // admin + room owner
    expect(body.counts.rooms).toBe(1);
    expect(body.live.connections).toBe(0);
    expect(body.adapters).toEqual({ store: 'memory', bus: 'memory' });
    // mediaPipeline is a wire tombstone: ENABLE_MEDIA_PIPELINE was deleted
    // from config, and the route pins the still-contract-required field false.
    expect(body.features.mediaPipeline).toBe(false);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('counts HTTP requests by route and status class', async () => {
    const { app, token } = await adminApp();
    // Generate one 404 + one 200 before reading metrics.
    await app.app.inject({ method: 'GET', url: '/nope', headers: authed(token) });
    await app.app.inject({ method: 'GET', url: '/healthz' });

    const res = await app.app.inject({
      method: 'GET',
      url: '/admin/metrics',
      headers: authed(token),
    });
    expect(res.statusCode).toBe(200);
    const metrics = AdminMetricsResponse.parse(res.json());
    expect(metrics.totalRequests).toBeGreaterThanOrEqual(2);
    expect(metrics.total4xx).toBeGreaterThanOrEqual(1);
    const healthz = metrics.requests.find((r) => r.route === '/healthz');
    expect(healthz?.ok).toBeGreaterThanOrEqual(1);
  });
});

/*
 * The readout that would have answered the owner's question BEFORE the call
 * instead of after it: two people joined, both tiles rendered, and neither
 * could see or hear the other because the deployment had no relay at all.
 * Config alone cannot say this — a key that no longer issues reads exactly
 * like a working one — so the state is observed from a real credential issue.
 */
describe('admin overview: relay reality', () => {
  it('reports not-configured, and names the vars, without touching the network', async () => {
    const fetchMock = stubFetch(async () => {
      throw new Error('an unconfigured deployment must not call anyone');
    });
    const { app, token } = await adminApp();

    const body = await overview(app, token);
    expect(body.relay?.state).toBe('not-configured');
    expect(body.relay?.detail).toContain('CF_TURN_KEY_ID');
    expect(body.relay?.detail).toContain('CF_TURN_API_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports ok only when the issued credential carries a turn: URL', async () => {
    stubFetch(async () => cloudflareResponse(['turn:turn.cloudflare.com:3478?transport=udp']));
    const { app, token } = await adminApp(CF_CONFIGURED);

    const body = await overview(app, token);
    expect(body.relay?.state).toBe('ok');
    expect(body.relay?.detail).toBeNull();
    expect(body.relay?.checkedAt).toBeGreaterThan(0);
  });

  it('distinguishes a key that does not work from no key at all', async () => {
    stubFetch(async () => new Response('nope', { status: 403 }));
    const broken = await adminApp(CF_CONFIGURED);
    const brokenBody = await overview(broken.app, broken.token);

    vi.unstubAllGlobals();
    const missing = await adminApp();
    const missingBody = await overview(missing.app, missing.token);

    // Both deployments strand the same users; only the fix differs, and the
    // owner console is the one place that difference is visible.
    expect(brokenBody.relay?.state).toBe('failing');
    expect(brokenBody.relay?.detail).toContain('403');
    expect(missingBody.relay?.state).toBe('not-configured');
    expect(brokenBody.relay?.detail).not.toBe(missingBody.relay?.detail);
  });

  it('carries the provider error text when the request never lands', async () => {
    stubFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND rtc.live.cloudflare.com');
    });
    const { app, token } = await adminApp(CF_CONFIGURED);

    const body = await overview(app, token);
    expect(body.relay?.state).toBe('failing');
    expect(body.relay?.detail).toContain('ENOTFOUND');
  });

  it('reads a live key that issues no turn: URL as failing, not ok', async () => {
    stubFetch(async () => cloudflareResponse(['stun:stun.cloudflare.com:3478']));
    const { app, token } = await adminApp(CF_CONFIGURED);

    const body = await overview(app, token);
    expect(body.relay?.state).toBe('failing');
    expect(body.relay?.detail).toContain('turn:');
  });

  it('does not spend a credential issue per poll', async () => {
    // The console refetches the overview every 5s; an uncached probe would
    // mint a Cloudflare credential on every one of them.
    const fetchMock = stubFetch(async () =>
      cloudflareResponse(['turn:turn.cloudflare.com:3478?transport=udp']),
    );
    const { app, token } = await adminApp(CF_CONFIGURED);

    const first = await overview(app, token);
    const second = await overview(app, token);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second.relay).toEqual(first.relay);
  });

  it('lets a cached verdict EXPIRE — a relay that died at 3am must not read ok forever', async () => {
    // The cache above is what makes the console affordable; this is what keeps
    // it honest. Freezing the observation (one token: TTL → MAX_SAFE_INTEGER)
    // left the whole suite green while converting the owner's only relay
    // instrument into a permanent stale `ok` — the exact "the room never said
    // WHY" failure this readout exists to kill, relocated to the console.
    // Date.now is nudged directly; faking the whole timer wheel hangs the
    // app's own keepalives.
    let skewMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
    try {
      const fetchMock = stubFetch(async () =>
        cloudflareResponse(['turn:turn.cloudflare.com:3478?transport=udp']),
      );
      const { app, token } = await adminApp(CF_CONFIGURED);

      const healthy = await overview(app, token);
      expect(healthy.relay?.state).toBe('ok');

      // The relay dies. Inside the TTL the console may still say ok…
      stubFetch(async () => new Response('revoked', { status: 403 }));
      skewMs = RELAY_STATUS_TTL_MS - 1000;
      const cached = await overview(app, token);
      expect(cached.relay?.state).toBe('ok');

      // …and five minutes on, it must have probed again and said what it
      // found. FIVE MINUTES IS DELIBERATELY NOT DERIVED FROM THE CONSTANT:
      // the first version of this test skewed by `RELAY_STATUS_TTL_MS + 1000`
      // and so scaled with any mutation of the TTL — freezing it at
      // MAX_SAFE_INTEGER left the test green, which is the exact defect it
      // exists to catch. The absolute bound is the PRODUCT claim: however the
      // cache is tuned, the owner's relay readout may never be more than a
      // few minutes stale.
      skewMs = 5 * 60_000;
      const truth = await overview(app, token);
      expect(truth.relay?.state).toBe('failing');
      expect(truth.relay?.detail).toContain('403');
      expect(fetchMock).toHaveBeenCalledOnce(); // the healthy probe; the dead one is a new stub
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reports what a real caller got, not a separate synthetic check', async () => {
    const fetchMock = stubFetch(async () =>
      cloudflareResponse(['turn:turn.cloudflare.com:3478?transport=udp']),
    );
    const { app, token } = await adminApp(CF_CONFIGURED);
    const member = await signupUser(app.app, 'member@example.com');

    const creds = await app.app.inject({
      method: 'GET',
      url: '/rtc/turn-credentials',
      headers: authed(member.accessToken),
    });
    expect(creds.statusCode).toBe(200);

    const body = await overview(app, token);
    expect(body.relay?.state).toBe('ok');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});


describe('admin reports → takedown', () => {
  it('lists open reports with reporter names and resolves them', async () => {
    const { app, token } = await adminApp();
    const { roomId } = await seedRoom(app.store);
    const { accessToken: reporterToken, user: reporter } = await signupUser(
      app.app,
      'reporter@example.com',
    );

    const reportRes = await app.app.inject({
      method: 'POST',
      url: '/report',
      headers: authed(reporterToken),
      payload: { target: { kind: 'room', roomId }, reason: 'test report' },
    });
    expect(reportRes.statusCode).toBe(200);
    const { reportId } = reportRes.json() as { reportId: string };

    const list = await app.app.inject({
      method: 'GET',
      url: '/admin/reports',
      headers: authed(token),
    });
    const { reports } = AdminReportsResponse.parse(list.json());
    expect(reports).toHaveLength(1);
    expect(reports[0]?.reporterName).toBe(reporter.displayName);

    const resolve = await app.app.inject({
      method: 'POST',
      url: '/admin/reports/resolve',
      headers: authed(token),
      payload: { reportId, dismiss: false },
    });
    expect(resolve.statusCode).toBe(200);
    expect((resolve.json() as { action: string }).action).toContain('room deleted');
    expect(await app.store.rooms.findById(roomId)).toBeNull();

    // Resolving twice is an honest 409, not a silent success.
    const again = await app.app.inject({
      method: 'POST',
      url: '/admin/reports/resolve',
      headers: authed(token),
      payload: { reportId, dismiss: false },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('admin usage', () => {
  it('aggregates metering buckets and top rooms by session-minutes', async () => {
    const { app, token } = await adminApp();
    const { roomId } = await seedRoom(app.store);
    const now = Date.now();
    await app.store.usage.insertOne({
      id: newId(),
      userId: newId() as UserId,
      roomId,
      kind: 'session-minutes',
      amount: 42,
      unit: 'minutes',
      at: now,
      meta: null,
    });
    await app.store.usage.insertOne({
      id: newId(),
      userId: newId() as UserId,
      roomId: null,
      kind: 'turn-relay',
      amount: 1_500_000_000,
      unit: 'bytes',
      at: now,
      meta: null,
    });
    // Content-adjacent rows never surface as ops telemetry.
    await app.store.usage.insertOne({
      id: newId(),
      userId: newId() as UserId,
      roomId,
      kind: 'playback.history',
      amount: 1,
      unit: 'ms',
      at: now,
      meta: null,
    });

    const res = await app.app.inject({
      method: 'GET',
      url: '/admin/usage',
      headers: authed(token),
    });
    expect(res.statusCode).toBe(200);
    const usage = AdminUsageResponse.parse(res.json());
    const kinds = usage.buckets.map((b) => b.kind);
    expect(kinds).toContain('session-minutes');
    expect(kinds).toContain('turn-relay');
    expect(kinds).not.toContain('playback.history');
    expect(usage.topRooms[0]?.sessionMinutes).toBe(42);
  });
});
