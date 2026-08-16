/**
 * Metadata module: the media metadata resolver plus its REST surface. The
 * resolver itself is a per-Deps port (resolver.ts) so the queue can enrich
 * items with the SAME instance — and therefore the same cache — that serves
 * POST /media/resolve.
 */
import type { ModulePlugin } from '../types';
import { metadataRoutes } from './routes';

const metadataModule: ModulePlugin = {
  name: 'metadata',
  routes: metadataRoutes,
};

export default metadataModule;
