/**
 * Push module entry — REST only, no WS handlers. Registered in
 * src/modules/index.ts; without that line the whole notify path stays dead,
 * which is exactly how it shipped.
 */
import type { ModulePlugin } from '../types';
import { pushRoutes } from './routes';

export const pushModule: ModulePlugin = {
  name: 'push',
  routes: pushRoutes,
};
export default pushModule;
