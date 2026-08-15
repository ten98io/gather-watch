/**
 * Sync module: WS handlers for the server-side playback authority. All logic
 * lives in SyncService; handlers only dispatch. Service instances are cached
 * per Deps (this module object is a process-wide singleton reused across app
 * instances, and the service holds per-room buffering state).
 */
import type { Deps, ModulePlugin } from '../types';
import { SyncService } from './service';

const services = new WeakMap<Deps, SyncService>();

function serviceFor(deps: Deps): SyncService {
  let service = services.get(deps);
  if (service === undefined) {
    service = new SyncService(deps);
    services.set(deps, service);
  }
  return service;
}

const syncModule: ModulePlugin = {
  name: 'sync',
  wsHandlers: {
    'sync.play': (event, ctx) =>
      serviceFor(ctx.deps).play(ctx.roomId, ctx.auth.userId, event.payload),
    'sync.pause': (event, ctx) =>
      serviceFor(ctx.deps).pause(ctx.roomId, ctx.auth.userId, event.payload),
    'sync.seek': (event, ctx) =>
      serviceFor(ctx.deps).seek(ctx.roomId, ctx.auth.userId, event.payload),
    'sync.rate': (event, ctx) =>
      serviceFor(ctx.deps).setRate(ctx.roomId, ctx.auth.userId, event.payload),
    'sync.setTrack': (event, ctx) =>
      serviceFor(ctx.deps).setTrack(ctx.roomId, ctx.auth.userId, event.payload),
    'sync.waitForAll': (event, ctx) =>
      serviceFor(ctx.deps).setWaitForAll(ctx.roomId, ctx.auth.userId, event.payload.enabled),
    'sync.buffering': (event, ctx) =>
      serviceFor(ctx.deps).setBuffering(ctx.roomId, ctx.auth.userId, event.payload.buffering),
    'sync.claimMaster': (event, ctx) =>
      serviceFor(ctx.deps).claimMaster(ctx.roomId, ctx.auth.userId, event.payload.epoch),
  },
};

export default syncModule;
