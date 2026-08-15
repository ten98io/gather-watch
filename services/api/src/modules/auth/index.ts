import type { ModulePlugin } from '../types';
import { authRoutes } from './routes';

export const authModule: ModulePlugin = { name: 'auth', routes: authRoutes };
export default authModule;
