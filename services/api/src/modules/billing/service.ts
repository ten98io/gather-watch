/**
 * Stripe client wrapper for the billing module. The SDK is imported and
 * constructed LAZILY (first use, only when config.stripe.secretKey is set) so
 * the API boots cleanly on self-hosted installs without Stripe keys. Tests
 * inject a fake/real client per Deps via setStripeClientForDeps — no module
 * singletons, nothing leaks across app instances.
 */
import type Stripe from 'stripe';
import { AppError } from '../../lib/errors';
import type { Deps } from '../types';

/**
 * The narrow slice of the Stripe SDK this module uses. The real `Stripe`
 * instance is structurally assignable; tests can hand-roll a fake (or reuse a
 * real instance for `webhooks.constructEvent`, which is pure local HMAC).
 */
export interface BillingStripe {
  customers: {
    create(params: { email?: string; metadata: Record<string, string> }): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(params: {
        mode: 'subscription';
        customer: string;
        client_reference_id: string;
        metadata: Record<string, string>;
        line_items: Array<{ price: string; quantity: number }>;
        subscription_data: { metadata: Record<string, string> };
        success_url: string;
        cancel_url: string;
      }): Promise<{ url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
  subscriptions: {
    /** Immediate cancellation — GDPR erasure must stop billing for good. */
    cancel(id: string): Promise<{ id: string }>;
  };
  webhooks: {
    constructEvent(payload: Buffer, signature: string, secret: string): Stripe.Event;
  };
}

// Keyed on the Deps object (one per app instance / test harness) so injected
// clients are GC'd with their app and never cross-contaminate tests.
const clientOverrides = new WeakMap<Deps, BillingStripe>();
const liveClients = new WeakMap<Deps, BillingStripe>();

/** Test seam: pin the Stripe client used for this app's Deps. */
export function setStripeClientForDeps(deps: Deps, client: BillingStripe | null): void {
  if (client === null) {
    clientOverrides.delete(deps);
  } else {
    clientOverrides.set(deps, client);
  }
}

/**
 * Resolve the Stripe client for this app. Throws AppError('INTERNAL') when
 * Stripe is not configured — contracts ErrorCode has no SERVICE_UNAVAILABLE,
 * and an unconfigured integration is an operator-side (5xx) problem, not a
 * client error. Entitlements/usage never call this.
 */
export async function getStripe(deps: Deps): Promise<BillingStripe> {
  const override = clientOverrides.get(deps);
  if (override !== undefined) {
    return override;
  }
  const cached = liveClients.get(deps);
  if (cached !== undefined) {
    return cached;
  }
  const { secretKey } = deps.config.stripe;
  if (secretKey === null) {
    throw new AppError('INTERNAL', 'billing is not configured on this server');
  }
  const { default: StripeClient } = await import('stripe');
  const client = new StripeClient(secretKey) as unknown as BillingStripe;
  liveClients.set(deps, client);
  return client;
}

/** True when checkout/portal/webhook can run (keys present or test override). */
export function stripeConfigured(deps: Deps): boolean {
  return clientOverrides.has(deps) || deps.config.stripe.secretKey !== null;
}

export class BillingService {
  constructor(private readonly deps: Deps) {}

  /**
   * Stripe Checkout in subscription mode for the premium monthly price. The
   * Stripe customer is created once and reused from the user's subscriptions
   * row (id = userId). No entitlements change here — the webhook does that.
   */
  async createCheckoutSession(userId: string): Promise<{ url: string }> {
    const { config, store } = this.deps;
    const priceId = config.stripe.pricePremiumMonthly;
    if (priceId === null) {
      throw new AppError('INTERNAL', 'billing is not configured on this server');
    }
    const stripe = await getStripe(this.deps);

    let sub = await store.subscriptions.findById(userId);
    let customerId = sub?.stripeCustomerId ?? null;
    if (customerId === null) {
      const user = await store.users.findById(userId);
      const customer = await stripe.customers.create({
        ...(user?.email != null ? { email: user.email } : {}),
        metadata: { userId },
      });
      customerId = customer.id;
      const now = Date.now();
      if (sub === null) {
        sub = await store.subscriptions.insertOne({
          id: userId,
          userId,
          plan: 'free',
          status: 'none',
          stripeCustomerId: customerId,
          stripeSubscriptionId: null,
          currentPeriodEnd: null,
          updatedAt: now,
        });
      } else {
        sub = await store.subscriptions.updateOne(
          { id: userId },
          { stripeCustomerId: customerId, updatedAt: now },
        );
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: userId,
      metadata: { userId },
      line_items: [{ price: priceId, quantity: 1 }],
      // Propagated onto the Subscription object so customer.subscription.*
      // webhook events can be attributed even before the customer id is known.
      subscription_data: { metadata: { userId } },
      success_url: `${config.appUrl}/billing/success`,
      cancel_url: `${config.appUrl}/billing/cancel`,
    });
    if (session.url === null) {
      throw new AppError('INTERNAL', 'stripe did not return a checkout url');
    }
    return { url: session.url };
  }

  /** Stripe customer-portal session; 404 when the user has no customer yet. */
  async createPortalSession(userId: string): Promise<{ url: string }> {
    const stripe = await getStripe(this.deps);
    const sub = await this.deps.store.subscriptions.findById(userId);
    if (sub === null || sub.stripeCustomerId === null) {
      throw new AppError('NOT_FOUND', 'no billing account for this user');
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${this.deps.config.appUrl}/billing`,
    });
    return { url: session.url };
  }
}

// One service per Deps, created lazily by the routes (chat's serviceFor
// pattern) so per-instance state never crosses app instances.
const services = new WeakMap<Deps, BillingService>();

export function billingServiceFor(deps: Deps): BillingService {
  let service = services.get(deps);
  if (service === undefined) {
    service = new BillingService(deps);
    services.set(deps, service);
  }
  return service;
}
