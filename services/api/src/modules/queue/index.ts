/**
 * Queue module: WS handlers for the shared-queue authority plus the playlists
 * REST surface. All queue mutation logic lives in QueueService; handlers only
 * dispatch. Service instances are cached per Deps (this module object is a
 * process-wide singleton reused across app instances).
 */
import type { Deps, ModulePlugin } from '../types';
import { queueRoutes } from './routes';
import { QueueService } from './service';

const services = new WeakMap<Deps, QueueService>();

function serviceFor(deps: Deps): QueueService {
  let service = services.get(deps);
  if (service === undefined) {
    service = new QueueService(deps);
    services.set(deps, service);
  }
  return service;
}

const queueModule: ModulePlugin = {
  name: 'queue',
  routes: queueRoutes,
  wsHandlers: {
    'queue.add': (event, ctx) =>
      serviceFor(ctx.deps).add(ctx.roomId, ctx.auth.userId, event.payload.item),
    'queue.remove': (event, ctx) =>
      serviceFor(ctx.deps).remove(ctx.roomId, ctx.auth.userId, event.payload.itemId),
    'queue.reorder': (event, ctx) =>
      serviceFor(ctx.deps).reorder(ctx.roomId, ctx.auth.userId, event.payload.orderedIds),
    'queue.voteSkip': (event, ctx) =>
      serviceFor(ctx.deps).voteSkip(ctx.roomId, ctx.auth.userId, event.payload.itemId),
  },
};

export default queueModule;
