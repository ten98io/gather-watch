/**
 * RTC module entry — mirrors the chat module's shape. `serviceFor` keeps ONE
 * RtcService per Deps (WeakMap) so REST routes share strategy/fair-use logic.
 * No WS handlers: WebRTC signaling relays through the hub's generic
 * `signal.*` passthrough, not this module.
 */
import type { Deps, ModulePlugin } from '../types';
import { RtcService } from './service';
import { rtcRoutes } from './routes';

const services = new WeakMap<Deps, RtcService>();

/** The one shared RtcService for a Deps instance. */
export function serviceFor(deps: Deps): RtcService {
  let service = services.get(deps);
  if (service === undefined) {
    service = new RtcService(deps);
    services.set(deps, service);
  }
  return service;
}

export const rtcModule: ModulePlugin = {
  name: 'rtc',
  routes: rtcRoutes,
};
export default rtcModule;
