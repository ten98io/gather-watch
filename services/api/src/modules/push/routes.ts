/**
 * Push REST endpoints. Registered WITHOUT a prefix — the paths below are full
 * and must match @gather/api-client exactly (`push.subscribe`,
 * `push.unsubscribe`, `push.publicKey`). The per-room mute toggle lives with
 * the rooms module, which owns the membership row it writes.
 *
 * Guests are allowed: a guest holds a real, room-scoped identity and can be
 * @mentioned in the room they joined, so refusing them would silently drop
 * exactly the notification they most need.
 */
import type { FastifyPluginAsync } from 'fastify';
import { PushSubscribeBody, PushUnsubscribeBody } from '@gather/contracts';
import { requireAuth } from '../../plugins/auth';
import { parseWith } from '../../plugins/error-mapper';
import { subscribePush, unsubscribePush } from './service';

export const pushRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The VAPID application-server key. `pushManager.subscribe` cannot be called
   * without it and it is server-only config, so the browser has to ask. It is
   * a PUBLIC key by construction — the private half never leaves the server —
   * but it still sits behind auth, since only signed-in clients subscribe.
   */
  app.get('/push/public-key', async (request) => {
    requireAuth(request);
    return { publicKey: app.deps.config.vapid.publicKey };
  });

  app.post('/push/subscribe', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(PushSubscribeBody, request.body);
    await subscribePush(app.deps.store, auth.userId, body);
    return { ok: true as const };
  });

  app.post('/push/unsubscribe', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(PushUnsubscribeBody, request.body);
    await unsubscribePush(app.deps.store, auth.userId, body);
    return { ok: true as const };
  });
};
