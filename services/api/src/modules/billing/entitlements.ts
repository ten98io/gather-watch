/**
 * Entitlements: the Mongo-backed billing state (store.subscriptions, id =
 * userId) projected onto contracts Entitlements/Subscription — NO Stripe
 * calls anywhere in this file. Also home of `getCaps`, the helper room
 * policy evaluation will call, and the wiring of rooms' EntitlementsPort
 * seam so the rooms module stops using its free/premium fallback.
 */
import type { Entitlements, Plan, Subscription } from '@playin/contracts';
import type { AppConfig } from '../../config';
import type { SubscriptionDoc } from '../../adapters/ports';
import { registerEntitlementsPort } from '../rooms/deps';
import type { Deps } from '../types';

/** A subscriptions row only grants premium while Stripe reports it active. */
export function effectivePlan(sub: SubscriptionDoc | null): Plan {
  return sub !== null && sub.plan === 'premium' && sub.status === 'active' ? 'premium' : 'free';
}

/** Free tier: full product, P2P physics — caps mirror rooms/deps.ts. */
export function freeEntitlements(config: AppConfig): Entitlements {
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

/**
 * Premium (Theater mode): SFU relay, 12 publishers / 50+ viewers, uncapped
 * TURN, 4x upload quota (per K3 brief — note the rooms/deps.ts fallback used
 * 5x until this module's port registration supersedes it).
 */
export function premiumEntitlements(config: AppConfig): Entitlements {
  return {
    plan: 'premium',
    maxPublishers: 12,
    maxShareViewers: 50,
    relayAllowed: true,
    turnCapGbMonth: null,
    uploadQuotaGb: config.storageQuotaGb * 4,
    attachmentMaxMb: 100,
  };
}

export function entitlementsForPlan(config: AppConfig, plan: Plan): Entitlements {
  return plan === 'premium' ? premiumEntitlements(config) : freeEntitlements(config);
}

/** Contracts view of a subscriptions row (absent row = 'none' defaults). */
export function subscriptionView(sub: SubscriptionDoc | null): Subscription {
  return {
    status: sub?.status ?? 'none',
    stripeCustomerId: sub?.stripeCustomerId ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
  };
}

/** GET /billing/entitlements payload, straight from Mongo. */
export async function getEntitlements(
  deps: Deps,
  userId: string,
): Promise<{ entitlements: Entitlements; subscription: Subscription }> {
  const sub = await deps.store.subscriptions.findById(userId);
  return {
    entitlements: entitlementsForPlan(deps.config, effectivePlan(sub)),
    subscription: subscriptionView(sub),
  };
}

/**
 * Capability snapshot for room policy evaluation (orchestrator wires this
 * into rooms; rooms/deps.ts EntitlementsPort is already fed from it).
 */
export interface RoomCaps {
  theaterMode: boolean;
  maxAvPublishers: number;
  maxShareViewers: number;
  turnUncapped: boolean;
  uploadQuotaGb: number;
}

export async function getCaps(deps: Deps, userId: string): Promise<RoomCaps> {
  const sub = await deps.store.subscriptions.findById(userId);
  if (effectivePlan(sub) === 'premium') {
    return {
      theaterMode: true,
      maxAvPublishers: 12,
      maxShareViewers: 50,
      turnUncapped: true,
      uploadQuotaGb: deps.config.storageQuotaGb * 4,
    };
  }
  return {
    theaterMode: false,
    maxAvPublishers: 6,
    maxShareViewers: 8,
    turnUncapped: false,
    uploadQuotaGb: deps.config.storageQuotaGb,
  };
}

/** Register this module as the rooms EntitlementsPort for this app instance
 *  (supersedes the rooms/deps.ts store fallback with identical semantics). */
export function wireEntitlementsPort(deps: Deps): void {
  registerEntitlementsPort(deps, {
    async getFor(userId: string): Promise<Entitlements> {
      const sub = await deps.store.subscriptions.findById(userId);
      return entitlementsForPlan(deps.config, effectivePlan(sub));
    },
  });
}
