import type { ModulePlugin } from '../types';
import { adminRoutes } from './routes';

const adminModule: ModulePlugin = { name: 'admin', routes: adminRoutes };

export default adminModule;
