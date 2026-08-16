/**
 * Request authentication: verifies the Bearer access JWT and, when the backing
 * session is still live, attaches the AuthContext to `request.auth`. Invalid,
 * expired, or revoked credentials leave `request.auth` null — the hook never
 * throws; routes decide whether auth is required via requireAuth.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RoomId, UserId } from '@gather/contracts';
import { AppError } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import type { AuthContext } from '../modules/types';

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
    const session = await app.deps.store.sessions.findById(claims.sessionId);
    if (session === null || session.revokedAt !== null) {
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

/** Verified NON-GUEST identity — guests get AppError('FORBIDDEN'). */
export function requireAccount(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.guest) {
    throw new AppError('FORBIDDEN', 'full account required');
  }
  return auth;
}
