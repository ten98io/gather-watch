/**
 * Cross-module seams owned by the rooms module: the entitlements lookup the
 * billing module will register (with a store-backed fallback until it does),
 * and the rooms control-plane bus channel used for presence-heartbeat mirrors
 * and forced disconnects.
 */
import type { Entitlements, PresenceEntry } from '@gather/contracts';
import type { AppConfig } from '../../config';
import type { Deps } from '../types';

/** Entitlements lookup the billing module will implement and register. */
export interface EntitlementsPort {
  getFor(userId: string): Promise<Entitlements>;
}

/** Default caps for a free account. */
export function defaultFreeEntitlements(config: AppConfig): Entitlements {
  return {
    plan: 'free',
    maxPublishers: 6,
    maxShareViewers: 8,
    relayAllowed: false,
    turnCapGbMonth: config.freeTurnCapGbPerMonth,
    uploadQuotaGb: config.storageQuotaGb,
    attachmentMaxMb: 25,
  };
}

/** Default caps for a premium account. */
export function defaultPremiumEntitlements(config: AppConfig): Entitlements {
  return {
    plan: 'premium',
    maxPublishers: 12,
    maxShareViewers: 50,
    relayAllowed: true,
    turnCapGbMonth: null,
    uploadQuotaGb: config.storageQuotaGb * 5,
    attachmentMaxMb: 100,
  };
}

// Keyed on the Deps object (one per app instance / test harness), so a
// registered port never leaks across instances and is GC'd with its deps.
const entitlementsPorts = new WeakMap<Deps, EntitlementsPort>();

/** Register the billing module's entitlements implementation for this app. */
export function registerEntitlementsPort(deps: Deps, port: EntitlementsPort): void {
  entitlementsPorts.set(deps, port);
}

/** Registered port, or the built-in fallback that maps store.subscriptions
 *  (id = userId; plan 'premium' && status 'active' => premium) to defaults. */
export function getEntitlementsPort(deps: Deps): EntitlementsPort {
  const registered = entitlementsPorts.get(deps);
  if (registered !== undefined) {
    return registered;
  }
  return {
    async getFor(userId: string): Promise<Entitlements> {
      const sub = await deps.store.subscriptions.findById(userId);
      if (sub !== null && sub.plan === 'premium' && sub.status === 'active') {
        return defaultPremiumEntitlements(deps.config);
      }
      return defaultFreeEntitlements(deps.config);
    },
  };
}

/** Rooms control-plane bus channel (presence heartbeats mirror + forced
 *  disconnects), separate from roomChannel() which carries client frames. */
export function roomCtlChannel(roomId: string): string {
  return `roomctl:${roomId}`;
}

/** `from` is a random per-publisher origin id so subscribers can skip their
 *  own loopback messages (the bus delivers to the publishing instance too). */
export type RoomCtlMessage =
  | { kind: 'hb'; roomId: string; entry: PresenceEntry; from: string }
  | { kind: 'bye'; roomId: string; userId: string; from: string }
  | { kind: 'kick'; roomId: string; userId: string; from: string };
