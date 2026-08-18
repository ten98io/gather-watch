/**
 * Module registry. MODULE WORKERS: register by adding EXACTLY ONE line inside
 * the array below, e.g.
 *   (await import('./chat/index')).default,
 * Do not touch anything else in this file or the rest of the skeleton.
 */
import authModule from './auth/index';
import type { ModulePlugin } from './types';

export const modules: ModulePlugin[] = [
  authModule,
  (await import('./chat/index')).default,
  (await import('./sync/index')).default,
  (await import('./queue/index')).default,
  (await import('./metadata/index')).default,
  (await import('./rtc/index')).default,
  (await import('./compliance/index')).default,
  (await import('./restream/index')).default,
  (await import('./push/index')).default,
  (await import('./rooms/index')).default,
  (await import('./admin/index')).default,
];
