/**
 * Request authentication: verifies the Bearer access JWT (same JWT_SECRET
 * scheme as services/api) and attaches the AuthContext to `request.auth`.
 * Invalid/expired credentials leave `request.auth` null — the hook never
 * throws; routes decide via requireAuth. JWT-only: no session-store lookup
 * (see lib/tokens.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RoomId, UserId } from '@playin/contracts';
import { AppError } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import type { AuthContext } from '../deps';

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return;
    }
    const claims = await verifyAccessToken(app.deps.config, header.slice('Bearer '.length));
    if (claims === null) {
      return;
    }
    request.auth = {
      userId: claims.userId as UserId,
      sessionId: claims.sessionId,
      guest: claims.guest,
      guestRoomId: claims.guestRoomId === null ? null : (claims.guestRoomId as RoomId),
    };
  });
}

/** Verified identity, or AppError('UNAUTHORIZED') when unauthenticated. */
export function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.auth;
  if (auth === null) {
    throw new AppError('UNAUTHORIZED', 'authentication required');
  }
  return auth;
}
