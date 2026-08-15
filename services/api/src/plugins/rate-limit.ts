/**
 * Global rate limiting (@fastify/rate-limit) keyed by authenticated userId,
 * falling back to client IP for anonymous traffic. Auth-tier endpoints get a
 * tighter per-route cap via the `config: authRateLimit(app)` route option.
 */
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const { config } = app.deps;
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
  });
}

/** Per-route override for the auth tier: `config: authRateLimit(app)`. */
export function authRateLimit(app: FastifyInstance): {
  rateLimit: { max: number; timeWindow: number };
} {
  return {
    rateLimit: {
      max: app.deps.config.rateLimit.authMax,
      timeWindow: app.deps.config.rateLimit.windowMs,
    },
  };
}
