/**
 * Rooms module entry point. Part A registers the REST routes only; part B
 * adds wsHandlers for the realtime surface.
 */
import type { ModulePlugin } from '../types';
import { roomsRoutes } from './routes';
import { roomsWsHandlers } from './ws';

export const roomsModule: ModulePlugin = {
  name: 'rooms',
  routes: roomsRoutes,
  wsHandlers: roomsWsHandlers,
};
export default roomsModule;
