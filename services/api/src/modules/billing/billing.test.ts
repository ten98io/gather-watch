/**
 * Billing module tests — memory store, no network. Webhook signature
 * verification runs through the REAL stripe SDK's constructEvent (pure local
 * HMAC; payloads are signed in-test with the configured webhook secret);
 * checkout/portal use an injected fake client via setStripeClientForDeps.
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import type { StorePort, SubscriptionDoc } from '../../adapters/ports';
import type { Deps } from '../types';
import { makeApp, signupUser, testConfig } from '../../../test/helpers';
import type { TestApp } from '../../../test/helpers';
import { effectivePlan, getCaps, getEntitlements } from './entitlements';
import { UsageIngestBody } from './routes';
import { setStripeClientForDeps } from './service';
import type { BillingStripe } from './service';

const WEBHOOK_SECRET = 'whsec_test_secret_k3';
const PRICE_ID = 'price_premium_monthly_test';

function billingConfig() {
  return testConfig({
    stripe: { secretKey: null, webhookSecret: WEBHOOK_SECRET, pricePremiumMonthly: PRICE_ID },
  });
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Stripe-Signature header for a raw payload, signed with the test secret. */
function signPayload(raw: string, secret: string = WEBHOOK_SECRET): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}

function webhookRequest(raw: string, signature?: string) {
  return {
    method: 'POST' as const,
    url: '/billing/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature ?? signPayload(raw),
    },
    payload: raw,
  };
}

/** Real constructEvent (local HMAC), stubbed REST surfaces. */
function fakeStripe(overrides: Partial<BillingStripe> = {}): BillingStripe {
  const real = new Stripe('sk_test_dummy_k3');
  return {
    customers: { create: async () => ({ id: 'cus_test_1' }) },
    checkout: {
      sessions: { create: async () => ({ url: 'https://checkout.stripe.com/c/pay/test' }) },
    },
    billingPortal: {
      sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/session/test' }) },
    },
    webhooks: { constructEvent: (raw, sig, secret) => real.webhooks.constructEvent(raw, sig, secret) },
    subscriptions: { cancel: async (id) => ({ id }) },
    ...overrides,
  };
}

async function seedSubscription(
  store: StorePort,
  userId: string,
  patch: Partial<SubscriptionDoc> = {},
): Promise<SubscriptionDoc> {
  return store.subscriptions.insertOne({
    id: userId,
    userId,
    plan: 'premium',
    status: 'active',
    stripeCustomerId: 'cus_seed',
    stripeSubscriptionId: 'sub_seed',
    currentPeriodEnd: '2030-01-01T00:00:00.000Z',
    updatedAt: Date.now(),
    ...patch,
  });
}

describe('billing entitlements', () => {
  let app: FastifyInstance;
  let store: StorePort;
  let deps: Deps;

  beforeEach(async () => {
    ({ app, store, deps } = await makeApp(billingConfig()));
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns free defaults when no subscription row exists', async () => {
    const account = await signupUser(app, 'free@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/billing/entitlements',
      headers: bearer(account.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entitlements: { plan: string; maxPublishers: number; uploadQuotaGb: number };
      subscription: { status: string; stripeCustomerId: string | null };
    };
    expect(body.entitlements.plan).toBe('free');
    expect(body.entitlements.maxPublishers).toBe(6);
    expect(body.entitlements.uploadQuotaGb).toBe(deps.config.storageQuotaGb);
    expect(body.subscription.status).toBe('none');
    expect(body.subscription.stripeCustomerId).toBeNull();
  });

  it('returns premium caps for an active premium subscription', async () => {
    const account = await signupUser(app, 'pro@example.com');
    await seedSubscription(store, account.user.id);

    const res = await app.inject({
      method: 'GET',
      url: '/billing/entitlements',
      headers: bearer(account.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entitlements: { plan: string; relayAllowed: boolean; uploadQuotaGb: number };
      subscription: { status: string; currentPeriodEnd: string | null };
    };
    expect(body.entitlements.plan).toBe('premium');
    expect(body.entitlements.relayAllowed).toBe(true);
    expect(body.entitlements.uploadQuotaGb).toBe(deps.config.storageQuotaGb * 4);
    expect(body.subscription.status).toBe('active');
    expect(body.subscription.currentPeriodEnd).toBe('2030-01-01T00:00:00.000Z');
  });

  it('treats canceled subscriptions as free (incl. getCaps)', async () => {
    const account = await signupUser(app, 'ex@example.com');
    await seedSubscription(store, account.user.id, { status: 'canceled' });

    expect(effectivePlan(await store.subscriptions.findById(account.user.id))).toBe('free');
    const caps = await getCaps(deps, account.user.id);
    expect(caps).toEqual({
      theaterMode: false,
      maxAvPublishers: 6,
      maxShareViewers: 8,
      turnUncapped: false,
      uploadQuotaGb: deps.config.storageQuotaGb,
    });

    await seedSubscription(store, 'someone-with-premium');
    expect(await getCaps(deps, 'someone-with-premium')).toEqual({
      theaterMode: true,
      maxAvPublishers: 12,
      maxShareViewers: 50,
      turnUncapped: true,
      uploadQuotaGb: deps.config.storageQuotaGb * 4,
    });
  });

  it('rejects unauthenticated entitlements requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/billing/entitlements' });
    expect(res.statusCode).toBe(401);
  });
});

describe('billing webhook', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeEach(async () => {
    ({ app, store } = await makeApp(billingConfig()));
    setStripeClientForDeps(app.deps, fakeStripe());
  });

  afterEach(async () => {
    await app.close();
  });

  it('checkout.session.completed marks the user premium (valid signature)', async () => {
    const account = await signupUser(app, 'buyer@example.com');
    const raw = JSON.stringify({
      id: 'evt_checkout_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          object: 'checkout.session',
          customer: 'cus_buyer',
          subscription: 'sub_buyer',
          client_reference_id: account.user.id,
          metadata: { userId: account.user.id },
        },
      },
    });

    const res = await app.inject(webhookRequest(raw));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { received: boolean }).received).toBe(true);

    const row = await store.subscriptions.findById(account.user.id);
    expect(row).not.toBeNull();
    expect(row!.plan).toBe('premium');
    expect(row!.status).toBe('active');
    expect(row!.stripeCustomerId).toBe('cus_buyer');
    expect(row!.stripeSubscriptionId).toBe('sub_buyer');

    // The entitlements endpoint reflects the webhook write (no Stripe call).
    const ent = await app.inject({
      method: 'GET',
      url: '/billing/entitlements',
      headers: bearer(account.accessToken),
    });
    expect((ent.json() as { entitlements: { plan: string } }).entitlements.plan).toBe('premium');
  });

  it('customer.subscription.updated syncs status and currentPeriodEnd', async () => {
    const account = await signupUser(app, 'sync@example.com');
    await seedSubscription(store, account.user.id, {
      stripeCustomerId: 'cus_sync',
      stripeSubscriptionId: 'sub_sync',
    });
    const raw = JSON.stringify({
      id: 'evt_sub_1',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_sync',
          object: 'subscription',
          customer: 'cus_sync',
          status: 'past_due',
          current_period_end: 1_893_456_000, // 2030-01-01T00:00:00Z
        },
      },
    });

    const res = await app.inject(webhookRequest(raw));
    expect(res.statusCode).toBe(200);

    const row = await store.subscriptions.findById(account.user.id);
    expect(row!.status).toBe('past_due');
    expect(row!.currentPeriodEnd).toBe('2030-01-01T00:00:00.000Z');
  });

  it('customer.subscription.deleted downgrades to free/canceled', async () => {
    const account = await signupUser(app, 'churn@example.com');
    await seedSubscription(store, account.user.id, {
      stripeCustomerId: 'cus_churn',
      stripeSubscriptionId: 'sub_churn',
    });
    const raw = JSON.stringify({
      id: 'evt_del_1',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_churn', object: 'subscription', customer: 'cus_churn', status: 'canceled' },
      },
    });

    const res = await app.inject(webhookRequest(raw));
    expect(res.statusCode).toBe(200);

    const row = await store.subscriptions.findById(account.user.id);
    expect(row!.plan).toBe('free');
    expect(row!.status).toBe('canceled');
    expect((await getEntitlements(app.deps, account.user.id)).entitlements.plan).toBe('free');
  });

  it('rejects an invalid signature with 400 VALIDATION', async () => {
    const raw = JSON.stringify({
      id: 'evt_bad',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_bad', customer: 'cus_x', subscription: 'sub_x' } },
    });
    const res = await app.inject(webhookRequest(raw, 't=1,v1=definitely-not-valid'));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION');
    expect(await store.subscriptions.count({})).toBe(0);
  });

  it('acknowledges and ignores unknown event types', async () => {
    const raw = JSON.stringify({
      id: 'evt_invoice',
      object: 'event',
      type: 'invoice.paid',
      data: { object: { id: 'in_1', object: 'invoice' } },
    });
    const res = await app.inject(webhookRequest(raw));
    expect(res.statusCode).toBe(200);
    expect(await store.subscriptions.count({})).toBe(0);
  });
});

describe('billing usage ingest', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeEach(async () => {
    ({ app, store } = await makeApp(billingConfig()));
  });

  afterEach(async () => {
    await app.close();
  });

  it('stores a valid getStats sample', async () => {
    const account = await signupUser(app, 'meter@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/billing/usage',
      headers: bearer(account.accessToken),
      payload: { roomId: 'room-1', kind: 'turn-relay', amount: 12_500_000, unit: 'bytes', meta: { srflx: false } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);

    const docs = await store.usage.findMany({ userId: account.user.id });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.roomId).toBe('room-1');
    expect(docs[0]!.amount).toBe(12_500_000);
    expect(docs[0]!.unit).toBe('bytes');
    expect(docs[0]!.meta).toEqual({ srflx: false });
  });

  it('rejects negative and absurd amounts with 400', async () => {
    const account = await signupUser(app, 'abuser@example.com');
    for (const payload of [
      { roomId: 'room-1', kind: 'turn-relay', amount: -5, unit: 'bytes' },
      { roomId: 'room-1', kind: 'turn-relay', amount: 5_000_000_000_000, unit: 'bytes' }, // 5 TB
      { roomId: null, kind: 'session', amount: Number.POSITIVE_INFINITY, unit: 'minutes' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/usage',
        headers: bearer(account.accessToken),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe('VALIDATION');
    }
    expect(await store.usage.count({})).toBe(0);
  });

  it('schema defaults roomId/meta to null', () => {
    const parsed = UsageIngestBody.parse({ kind: 'session-minutes', amount: 3, unit: 'minutes' });
    expect(parsed.roomId).toBeNull();
    expect(parsed.meta).toBeNull();
  });
});

describe('billing checkout/portal', () => {
  let built: TestApp;

  afterEach(async () => {
    await built.app.close();
  });

  it('fails cleanly (500, not a crash) when Stripe is not configured', async () => {
    built = await makeApp(billingConfig()); // secretKey null, no override
    const account = await signupUser(built.app, 'nostripe@example.com');

    const checkout = await built.app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: bearer(account.accessToken),
      payload: { plan: 'premium' },
    });
    expect(checkout.statusCode).toBe(500);
    expect((checkout.json() as { code: string }).code).toBe('INTERNAL');

    const portal = await built.app.inject({
      method: 'POST',
      url: '/billing/portal-session',
      headers: bearer(account.accessToken),
    });
    expect(portal.statusCode).toBe(500);
    expect((portal.json() as { code: string }).code).toBe('INTERNAL');
  });

  it('creates a checkout session and reuses the Stripe customer', async () => {
    built = await makeApp(billingConfig());
    const calls: string[] = [];
    setStripeClientForDeps(
      built.app.deps,
      fakeStripe({
        customers: {
          create: async (params) => {
            calls.push(`customer:${params.metadata['userId'] ?? ''}`);
            return { id: 'cus_reused' };
          },
        },
        checkout: {
          sessions: {
            create: async (params) => {
              calls.push(`checkout:${params.customer}:${params.line_items[0]?.price ?? ''}`);
              return { url: 'https://checkout.stripe.com/c/pay/test' };
            },
          },
        },
      }),
    );
    const account = await signupUser(built.app, 'upgrade@example.com');

    for (let i = 0; i < 2; i += 1) {
      const res = await built.app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: bearer(account.accessToken),
        payload: { plan: 'premium' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { url: string }).url).toBe('https://checkout.stripe.com/c/pay/test');
    }
    // Customer created exactly once; both checkouts reuse it with our price.
    expect(calls.filter((c) => c.startsWith('customer:'))).toHaveLength(1);
    expect(calls.filter((c) => c === `checkout:cus_reused:${PRICE_ID}`)).toHaveLength(2);

    const row = await built.store.subscriptions.findById(account.user.id);
    expect(row!.stripeCustomerId).toBe('cus_reused');
  });

  it('portal: 404 without a customer, url with one', async () => {
    built = await makeApp(billingConfig());
    setStripeClientForDeps(built.app.deps, fakeStripe());
    const account = await signupUser(built.app, 'portal@example.com');

    const missing = await built.app.inject({
      method: 'POST',
      url: '/billing/portal-session',
      headers: bearer(account.accessToken),
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe('NOT_FOUND');

    await seedSubscription(built.store, account.user.id, { stripeCustomerId: 'cus_portal' });
    const res = await built.app.inject({
      method: 'POST',
      url: '/billing/portal-session',
      headers: bearer(account.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { url: string }).url).toBe('https://billing.stripe.com/p/session/test');
  });
});
