/**
 * Compliance module: content-report mailbox + GDPR export/erasure. See
 * erasure.ts for the purge-scheduling decision record (process-local pending
 * registry + unref'd sweeper, because the frozen StorePort has no persistent
 * home for pending-purge state).
 */
import type { ModulePlugin } from '../types';
import { complianceRoutes } from './routes';

const complianceModule: ModulePlugin = { name: 'compliance', routes: complianceRoutes };
export default complianceModule;
