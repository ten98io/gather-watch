/**
 * In-process ops metrics registry (BUILD_PROMPT §Ops: "metrics counters
 * endpoint"). Deliberately small and honest: HTTP requests counted by
 * route + status class, WS connections tracked by the hub (gauges set
 * on open/close), process gauges read on demand. Everything is in-memory
 * and resets on restart — the /admin/metrics payload says so.
 *
 * Registered once at the app root (app.ts) so the onResponse hook sees every
 * route; the admin module reads the same singleton.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RouteCounter {
  /** Fastify route pattern ('/rooms/:roomId/messages'), 'unknown' pre-router. */
  route: string;
  method: string;
  /** 2xx / 4xx / 5xx buckets. */
  ok: number;
  clientError: number;
  serverError: number;
  /** Cumulative response time in ms (divide by count for the mean). */
  totalMs: number;
}

export interface MetricsSnapshot {
  /** Process start (epoch ms) — all counters reset here. */
  since: number;
  requests: RouteCounter[];
  /** Convenience rollups. */
  totalRequests: number;
  total4xx: number;
  total5xx: number;
  /** WS events dispatched by client-event type. */
  wsEvents: Record<string, number>;
}

const counters = new Map<string, RouteCounter>();
const wsEventCounts = new Map<string, number>();
const startedAt = Date.now();

/** Count one dispatched WS client event (called by the hub). */
export function countWsEvent(type: string): void {
  wsEventCounts.set(type, (wsEventCounts.get(type) ?? 0) + 1);
}

/** Read the current snapshot. */
export function snapshotMetrics(): MetricsSnapshot {
  const requests = [...counters.values()].map((c) => ({ ...c }));
  let totalRequests = 0;
  let total4xx = 0;
  let total5xx = 0;
  for (const c of requests) {
    const n = c.ok + c.clientError + c.serverError;
    totalRequests += n;
    total4xx += c.clientError;
    total5xx += c.serverError;
  }
  return {
    since: startedAt,
    requests: requests.sort((a, b) => a.route.localeCompare(b.route)),
    totalRequests,
    total4xx,
    total5xx,
    wsEvents: Object.fromEntries([...wsEventCounts.entries()].sort()),
  };
}

/** Register the global onResponse counter hook. Call ONCE at the app root. */
export function registerMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', async (request: FastifyRequest, reply) => {
    const route = request.routeOptions?.url ?? 'unknown';
    const key = `${request.method} ${route}`;
    let counter = counters.get(key);
    if (counter === undefined) {
      counter = { route, method: request.method, ok: 0, clientError: 0, serverError: 0, totalMs: 0 };
      counters.set(key, counter);
    }
    const status = reply.statusCode;
    if (status >= 500) counter.serverError += 1;
    else if (status >= 400) counter.clientError += 1;
    else counter.ok += 1;
    counter.totalMs += reply.elapsedTime;
  });
}
