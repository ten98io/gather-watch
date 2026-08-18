/**
 * Restream module: WS handlers for the Mode B share authority. All logic
 * lives in RestreamService; handlers only dispatch. Service instances are
 * cached per Deps (this module object is a process-wide singleton reused
 * across app instances).
 *
 * `restream.handoff` is declared on the wire but deliberately unhandled: no
 * client sends it yet, and an unhandled event maps to the hub's standard
 * error reply rather than a silent success — honest until it is built.
 */
import type { Deps, ModulePlugin } from '../types';
import { RestreamService, ensureShareLiveness } from './service';

const services = new WeakMap<Deps, RestreamService>();

function serviceFor(deps: Deps): RestreamService {
  // Wiring the reaper here covers the instance that handled the start; the
  // rooms presence handler covers every other instance (see ensureShareLiveness).
  ensureShareLiveness(deps);
  let service = services.get(deps);
  if (service === undefined) {
    service = new RestreamService(deps);
    services.set(deps, service);
  }
  return service;
}

const restreamModule: ModulePlugin = {
  name: 'restream',
  wsHandlers: {
    'restream.start': (_event, ctx) => serviceFor(ctx.deps).start(ctx.roomId, ctx.auth.userId),
    'restream.stop': (_event, ctx) => serviceFor(ctx.deps).stop(ctx.roomId, ctx.auth.userId),
  },
};

export default restreamModule;
