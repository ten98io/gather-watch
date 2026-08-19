/**
 * Global rate limiting (@fastify/rate-limit) keyed by authenticated userId,
 * falling back to client IP for anonymous traffic. Auth-tier endpoints get a
 * tighter per-route cap via the `config: authRateLimit(app)` route option.
 *
 * WHAT BELONGS ON THE AUTH TIER: every route where the request body carries a
 * SECRET the caller can guess — a magic-link token, a refresh cookie, an
 * invite code, a room password. It is not "routes under /auth": POST
 * /rooms/join takes a room password and checks it against scrypt, which makes
 * it the same kind of surface as POST /auth/guest and puts it on the same
 * budget. The general tier is for routes where being wrong costs the caller
 * nothing to discover.
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
