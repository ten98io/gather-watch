/**
 * RTC REST endpoints. Registered WITHOUT a prefix — paths must match
 * @playin/api-client exactly. Both routes require a verified identity;
 * guests are allowed (livekit-token confines them to their invite room).
 */
import type { FastifyPluginAsync } from 'fastify';
import { LivekitTokenBody } from '@playin/contracts';
import { requireAuth } from '../../plugins/auth';
import { parseWith } from '../../plugins/error-mapper';
import { serviceFor } from './index';

export const rtcRoutes: FastifyPluginAsync = async (app) => {
  app.post('/rtc/livekit-token', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(LivekitTokenBody, request.body);
    return serviceFor(app.deps).mintLivekitToken(auth, body.roomId);
  });

  app.get('/rtc/turn-credentials', async (request) => {
    const auth = requireAuth(request);
    return serviceFor(app.deps).turnCredentials(auth);
  });
};
