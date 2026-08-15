/**
 * Auth REST endpoints. Registered WITHOUT a prefix — the paths below are full
 * and must match @playin/api-client exactly. Refresh tokens travel in the
 * httpOnly `playin_rt` cookie scoped to /auth; access tokens are returned in
 * the body alongside their absolute expiry (typed optional accessToken /
 * accessTokenExpiresAt fields on the contracts verify/refresh/guest-join
 * responses).
 */
import '@fastify/cookie';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  GuestJoinBody,
  RequestMagicLinkBody,
  UpdateProfileBody,
  UpgradeGuestBody,
  VerifyTokenBody,
} from '@playin/contracts';
import type { Member, Room } from '@playin/contracts';
import { AppError } from '../../lib/errors';
import { signAccessToken } from '../../lib/tokens';
import { requireAuth } from '../../plugins/auth';
import { parseWith } from '../../plugins/error-mapper';
import { authRateLimit } from '../../plugins/rate-limit';
import type { MemberDoc, RoomDoc, UserDoc } from '../../adapters/ports';
import { AuthService } from './service';
import { createMailer } from './email';

const RT_COOKIE = 'playin_rt';

/** Pick ONLY the contracts Room fields — never leak RoomDoc's server-only
 *  realtime snapshots (playback/queue/restream/master). */
function serializeRoom(room: RoomDoc): Room {
  return {
    id: room.id,
    kind: room.kind,
    name: room.name,
    inviteCode: room.inviteCode,
    ownerId: room.ownerId,
    policies: room.policies,
    relayMode: room.relayMode,
    theater: room.theater,
    createdAt: room.createdAt,
  };
}

/** Contracts Member — strip the MemberDoc id and the per-room mute flag. */
function serializeMember(member: MemberDoc): Member {
  return {
    roomId: member.roomId,
    userId: member.userId,
    role: member.role,
    joinedAt: member.joinedAt,
    banned: member.banned,
  };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { config, store } = app.deps;
  const service = new AuthService(app.deps);
  const mailer = createMailer(config, app.log);

  const setRefreshCookie = (reply: FastifyReply, token: string): void => {
    reply.setCookie(RT_COOKIE, token, {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: config.refreshTtlDays * 86400,
    });
  };

  /** Short-lived access JWT + absolute expiry. Guests are room-scoped. */
  const issueAccessToken = async (
    user: UserDoc,
    sessionId: string,
    guestRoomId: string | null,
  ): Promise<{ accessToken: string; accessTokenExpiresAt: number }> => ({
    accessToken: await signAccessToken(config, {
      userId: user.id,
      sessionId,
      guest: user.email === null,
      guestRoomId,
    }),
    accessTokenExpiresAt: Date.now() + config.accessTokenTtlSec * 1000,
  });

  /** The verify link is echoed back ONLY in development (no SMTP needed). */
  const devFields = (link: string): { devLink?: string } =>
    config.nodeEnv === 'development' ? { devLink: link } : {};

  app.post('/auth/magic-link', { config: authRateLimit(app) }, async (request) => {
    const body = parseWith(RequestMagicLinkBody, request.body);
    const email = body.email.toLowerCase();
    const { link } = await service.requestMagicLink(email);
    await mailer.send({ to: email, link, kind: 'magic-link' });
    return { ok: true as const, ...devFields(link) };
  });

  app.post('/auth/verify', { config: authRateLimit(app) }, async (request, reply) => {
    const body = parseWith(VerifyTokenBody, request.body);
    const device = request.headers['user-agent'] ?? 'unknown';
    const { user, session, refreshToken } = await service.verifyToken(body.token, device);
    setRefreshCookie(reply, refreshToken);
    const { accessToken, accessTokenExpiresAt } = await issueAccessToken(user, session.id, null);
    return { user, accessToken, accessTokenExpiresAt };
  });

  app.post('/auth/refresh', { config: authRateLimit(app) }, async (request, reply) => {
    const presented = request.cookies[RT_COOKIE];
    if (presented === undefined) {
      throw new AppError('UNAUTHORIZED', 'refresh token required');
    }
    const { user, session, refreshToken } = await service.refresh(presented);
    setRefreshCookie(reply, refreshToken);
    // Guests are room-scoped: their single guest membership carries the room.
    let guestRoomId: string | null = null;
    if (user.email === null) {
      const membership = await store.members.findOne({ userId: user.id, role: 'guest' });
      guestRoomId = membership?.roomId ?? null;
    }
    const { accessToken, accessTokenExpiresAt } = await issueAccessToken(
      user,
      session.id,
      guestRoomId,
    );
    return { user, accessToken, accessTokenExpiresAt };
  });

  app.get('/auth/me', async (request) => {
    const auth = requireAuth(request);
    const user = await store.users.findById(auth.userId);
    if (user === null) {
      throw new AppError('NOT_FOUND', 'user not found');
    }
    return { user };
  });

  app.patch('/auth/me', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(UpdateProfileBody, request.body);
    const user = await service.updateProfile(auth.userId, body);
    return { user };
  });

  app.post('/auth/guest', { config: authRateLimit(app) }, async (request, reply) => {
    const body = parseWith(GuestJoinBody, request.body);
    const device = request.headers['user-agent'] ?? 'unknown';
    const { user, room, member, session, refreshToken, lastEventSeq } = await service.guestJoin(
      body.inviteCode,
      body.displayName,
      device,
    );
    setRefreshCookie(reply, refreshToken);
    const { accessToken, accessTokenExpiresAt } = await issueAccessToken(user, session.id, room.id);
    return {
      user,
      room: serializeRoom(room),
      member: serializeMember(member),
      lastEventSeq,
      accessToken,
      accessTokenExpiresAt,
    };
  });

  app.post('/auth/upgrade', { config: authRateLimit(app) }, async (request) => {
    const auth = requireAuth(request);
    if (!auth.guest) {
      throw new AppError('CONFLICT', 'account already has an email');
    }
    const body = parseWith(UpgradeGuestBody, request.body);
    const email = body.email.toLowerCase();
    const { link } = await service.requestGuestUpgrade(auth.userId, email);
    await mailer.send({ to: email, link, kind: 'guest-upgrade' });
    return { ok: true as const, ...devFields(link) };
  });

  app.post('/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    await service.revokeSession(auth.userId, auth.sessionId);
    reply.clearCookie(RT_COOKIE, { path: '/auth' });
    return { ok: true as const };
  });

  app.get('/auth/sessions', async (request) => {
    const auth = requireAuth(request);
    const sessions = await service.listSessions(auth.userId, auth.sessionId);
    return { sessions };
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/auth/sessions/:sessionId',
    async (request) => {
      const auth = requireAuth(request);
      const revoked = await service.revokeSession(auth.userId, request.params.sessionId);
      if (!revoked) {
        throw new AppError('NOT_FOUND', 'session not found');
      }
      return { ok: true as const };
    },
  );

  app.post('/auth/sessions/revoke-all', async (request) => {
    const auth = requireAuth(request);
    const revoked = await service.revokeAllSessions(auth.userId, auth.sessionId);
    return { revoked };
  });
};
