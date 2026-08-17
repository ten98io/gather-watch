/**
 * RTC REST endpoints. Registered WITHOUT a prefix — paths must match
 * @gather/api-client exactly. Requires a verified identity; guests included.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../plugins/auth';
import { serviceFor } from './index';

export const rtcRoutes: FastifyPluginAsync = async (app) => {
  app.get('/rtc/turn-credentials', async (request) => {
    const auth = requireAuth(request);
    return serviceFor(app.deps).turnCredentials(auth);
  });
};
