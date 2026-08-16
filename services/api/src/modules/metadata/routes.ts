/**
 * Media metadata REST surface. Registered WITHOUT a prefix — the path below
 * is full and must match @playin/api-client (`media.resolveMedia`) exactly.
 *
 * POST /media/resolve is the "paste a link and see what it is" endpoint: the
 * client shows a real title, artwork and duration BEFORE anything is queued.
 * Auth-gated (guests included — they paste links in their own room) and held
 * to the tighter auth-tier rate limit, because every call can cost one
 * outbound request.
 */
import type { FastifyPluginAsync } from 'fastify';
import { ResolveMediaBody } from '@playin/contracts';
import { AppError } from '../../lib/errors';
import { requireAuth } from '../../plugins/auth';
import { parseWith } from '../../plugins/error-mapper';
import { authRateLimit } from '../../plugins/rate-limit';
import { getMetadataResolver } from './resolver';

export const metadataRoutes: FastifyPluginAsync = async (app) => {
  app.post('/media/resolve', { config: authRateLimit(app) }, async (request) => {
    requireAuth(request);
    const body = parseWith(ResolveMediaBody, request.body);
    const media = await getMetadataResolver(app.deps).resolve({
      ...(body.mediaRef === undefined ? {} : { mediaRef: body.mediaRef }),
      ...(body.url === undefined ? {} : { url: body.url }),
    });
    if (media === null) {
      throw new AppError('VALIDATION', 'that link is not something we can play');
    }
    return { media };
  });
};
