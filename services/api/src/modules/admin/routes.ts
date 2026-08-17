/**
 * Admin ops module (BUILD_PROMPT §Ops + compliance surface). REST-only —
 * every route requires a verified ACCOUNT whose email is listed in
 * ADMIN_EMAILS. Scope discipline (binding): operational telemetry only —
 * counts, gauges, aggregates, reports. No message bodies, no playback
 * content: the spec's safeguard clause forbids telemetry on what users
 * play, and private rooms stay private.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  AdminMetricsResponse,
  AdminOverviewResponse,
  AdminReportsResponse,
  AdminResolveReportBody,
  AdminResolveReportResponse,
  AdminRoomsResponse,
  AdminUsageResponse,
  AdminUsersResponse,
} from '@gather/contracts';
import type { UserId } from '@gather/contracts';
import { AppError } from '../../lib/errors';
import { requireAccount } from '../../plugins/auth';
import { snapshotMetrics } from '../../plugins/metrics';
import { parseWith } from '../../plugins/error-mapper';
import { executeTakedown, listOpenReports } from '../../cli/takedown';
import type { Deps } from '../types';

/** Admin gate: account identity + email on the ADMIN_EMAILS list. */
async function requireAdmin(deps: Deps, request: FastifyRequest): Promise<void> {
  const auth = requireAccount(request);
  const user = await deps.store.users.findById(auth.userId);
  const email = user?.email?.toLowerCase();
  if (email === undefined || email === null || !deps.config.adminEmails.includes(email)) {
    throw new AppError('FORBIDDEN', 'admin access requires an owner-listed account');
  }
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const { deps } = app;
  const { store } = deps;

  app.get('/admin/overview', async (request): Promise<AdminOverviewResponse> => {
    await requireAdmin(deps, request);
    const [users, rooms, members, messages, reportsOpen, sessionsActive, assets] =
      await Promise.all([
        store.users.count({}),
        store.rooms.count({}),
        store.members.count({}),
        store.messages.count({}),
        store.reports.count({ resolvedAt: null }),
        store.sessions.count({ revokedAt: null }),
        store.assets.count({}),
      ]);
    const live = deps.hub.stats();
    return {
      now: Date.now(),
      processStartedAt: Math.round(Date.now() - process.uptime() * 1000),
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      counts: { users, rooms, members, messages, reportsOpen, sessionsActive, assets },
      live,
      adapters: {
        store: deps.config.mongoUrl === null ? 'memory' : 'mongo',
        bus: deps.config.redisUrl === null ? 'memory' : 'redis',
      },
      features: {
        mediaPipeline: deps.config.enableMediaPipeline,
        gifs: deps.config.tenorApiKey !== null,
        stripe: deps.config.stripe.secretKey !== null,
        push: deps.config.vapid.publicKey !== null,
      },
    };
  });

  app.get('/admin/metrics', async (request): Promise<AdminMetricsResponse> => {
    await requireAdmin(deps, request);
    return snapshotMetrics();
  });

  app.get('/admin/reports', async (request): Promise<AdminReportsResponse> => {
    await requireAdmin(deps, request);
    const open = await listOpenReports(store);
    const reports = await Promise.all(
      open.map(async (r) => {
        const reporter = await store.users.findById(r.reporterId);
        return {
          id: r.id,
          reporterId: r.reporterId as UserId,
          reporterName: reporter?.displayName ?? null,
          target: r.target,
          reason: r.reason,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
        };
      }),
    );
    return { reports };
  });

  app.post(
    '/admin/reports/resolve',
    async (request): Promise<AdminResolveReportResponse> => {
      await requireAdmin(deps, request);
      const body = parseWith(AdminResolveReportBody, request.body);
      try {
        const result = await executeTakedown(store, body.reportId, { dismiss: body.dismiss });
        return { ok: true, action: result.action };
      } catch (err) {
        if (err instanceof Error && err.message.includes('not found')) {
          throw new AppError('NOT_FOUND', err.message);
        }
        if (err instanceof Error && err.message.includes('already resolved')) {
          throw new AppError('CONFLICT', err.message);
        }
        throw err;
      }
    },
  );

  app.get('/admin/rooms', async (request): Promise<AdminRoomsResponse> => {
    await requireAdmin(deps, request);
    const rooms = await store.rooms.findMany({}, { sort: [['createdAt', -1]], limit: 200 });
    const rows = await Promise.all(
      rooms.map(async (room) => ({
        room: {
          id: room.id,
          kind: room.kind,
          name: room.name,
          inviteCode: room.inviteCode,
          ownerId: room.ownerId,
          policies: room.policies,
          relayMode: room.relayMode,
          theater: room.theater,
          expiresAt: room.expiresAt,
          createdAt: room.createdAt,
        },
        memberCount: await store.members.count({ roomId: room.id }),
        liveConnections: deps.hub.localConnectionCount(room.id),
        messageCount: await store.messages.count({ roomId: room.id }),
      })),
    );
    return { rooms: rows };
  });

  app.get('/admin/users', async (request): Promise<AdminUsersResponse> => {
    await requireAdmin(deps, request);
    const users = await store.users.findMany({}, { sort: [['createdAt', -1]], limit: 200 });
    const rows = await Promise.all(
      users.map(async (user) => ({
        user,
        activeSessions: await store.sessions.count({ userId: user.id, revokedAt: null }),
        memberships: await store.members.count({ userId: user.id }),
      })),
    );
    return { users: rows };
  });

  app.get('/admin/usage', async (request): Promise<AdminUsageResponse> => {
    await requireAdmin(deps, request);
    const windowDays = 30;
    const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const samples = await store.usage.findMany({ at: { $gte: since } });

    const buckets = new Map<string, { kind: string; unit: string; total: number; samples: number }>();
    const roomMinutes = new Map<string, number>();
    for (const s of samples) {
      if (s.kind === 'playback.history') continue; // content-adjacent; not ops telemetry
      const key = `${s.kind}:${s.unit}`;
      const bucket = buckets.get(key) ?? { kind: s.kind, unit: s.unit, total: 0, samples: 0 };
      bucket.total += s.amount;
      bucket.samples += 1;
      buckets.set(key, bucket);
      if (s.kind === 'session-minutes' && s.roomId !== null) {
        roomMinutes.set(s.roomId, (roomMinutes.get(s.roomId) ?? 0) + s.amount);
      }
    }

    const topRoomIds = [...roomMinutes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topRooms = await Promise.all(
      topRoomIds.map(async ([roomId, minutes]) => {
        const room = await store.rooms.findById(roomId);
        return {
          roomId: roomId as never,
          roomName: room?.name ?? null,
          sessionMinutes: Math.round(minutes * 10) / 10,
        };
      }),
    );

    return {
      windowDays,
      buckets: [...buckets.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
      topRooms,
    };
  });
};
