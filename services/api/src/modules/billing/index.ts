/**
 * Billing module: Stripe checkout/portal, signature-verified webhook
 * (raw-body, Mongo-projected), entitlements, room caps, usage metering.
 */
import type { ModulePlugin } from '../types';
import { billingRoutes } from './routes';

export const billingModule: ModulePlugin = {
  name: 'billing',
  routes: billingRoutes,
};
export default billingModule;

// Public seams: rooms policy evaluation (getCaps) and the usage body schema
// slated for promotion into @gather/contracts.
export { getCaps, wireEntitlementsPort } from './entitlements';
export type { RoomCaps } from './entitlements';
export { UsageIngestBody, USAGE_UNIT_MAX_AMOUNT } from './routes';
export { setStripeClientForDeps, billingServiceFor } from './service';
export type { BillingStripe } from './service';
