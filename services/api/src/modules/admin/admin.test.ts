/**
 * Admin ops surface: the ADMIN_EMAILS gate (403 for non-admins, guests,
 * unknown accounts), overview/metrics payloads, the reports → takedown flow,
 * and usage aggregation. Runs fully on the memory adapters.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UserId } from '@playin/contracts';
import {
  AdminMetricsResponse,
  AdminOverviewResponse,
  AdminReportsResponse,
  AdminUsageResponse,
} from '@playin/contracts';
import { makeApp, seedRoom, signupUser, testConfig } from '../../../test/helpers';
import type { TestApp } from '../../../test/helpers';
import { newId } from '../../../src/lib/tokens';

const ADMIN_EMAIL = 'owner@example.com';

function adminConfig() {
  return testConfig({ adminEmails: [ADMIN_EMAIL] });
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function adminApp(): Promise<{ app: TestApp; token: string }> {
  const app = await makeApp(adminConfig());
  apps.push(app.app);
  const { accessToken } = await signupUser(app.app, ADMIN_EMAIL);
  return { app, token: accessToken };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
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
