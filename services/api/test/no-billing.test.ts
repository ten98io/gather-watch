/**
 * There is no billing surface on this server. Gather is free for everyone,
 * so the API must not merely refuse to charge — the routes must not exist.
 *
 * This suite is the tombstone for the deleted billing module. It pins the
 * three ways the old machinery could come back by accident:
 *
 *  - a checkout/portal/entitlements/webhook route reappearing (a live route
 *    that 500s "billing is not configured" is worse than no route: it tells a
 *    caller that payment is a thing here that merely needs configuring);
 *  - the admin overview advertising a payment processor;
 *  - a usage-ingest endpoint returning, since POST /billing/usage existed
 *    only to feed the deleted TURN fair-use meter. The `usage` COLLECTION is
 *    deliberately still here — playback history, ops telemetry and the GDPR
 *    export all read it — so the last case also proves that keeping the store
 *    did not keep the route.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StorePort } from '../src/adapters/ports';
import { AdminOverviewResponse } from '@gather/contracts';
import { makeApp, signupUser, testConfig } from './helpers';

const ADMIN_EMAIL = 'owner@example.com';

const BILLING_ROUTES: Array<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'POST', url: '/billing/checkout-session' },
  { method: 'POST', url: '/billing/portal-session' },
  { method: 'POST', url: '/billing/webhooks/stripe' },
  { method: 'GET', url: '/billing/entitlements' },
  { method: 'POST', url: '/billing/usage' },
];

describe('no billing surface', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeEach(async () => {
    ({ app, store } = await makeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  for (const route of BILLING_ROUTES) {
    it(`${route.method} ${route.url} does not exist`, async () => {
      const account = await signupUser(app, `billing-${route.url.split('/').pop()}@example.com`);
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${account.accessToken}` },
        payload: {},
      });
      // 404, not 401/403/500: authenticated, well-formed, and still nowhere.
      expect(res.statusCode).toBe(404);
    });
  }

  it('the admin overview reports no payment processor', async () => {
    // Fresh app: the ADMIN_EMAILS gate has to be open for this account before
    // /admin/overview will answer at all.
    const admin = await makeApp(testConfig({ adminEmails: [ADMIN_EMAIL] }));
    try {
      const { accessToken } = await signupUser(admin.app, ADMIN_EMAIL);
      const res = await admin.app.inject({
        method: 'GET',
        url: '/admin/overview',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      AdminOverviewResponse.parse(res.json());
      // Checked on the RAW body, not the parsed one — zod strips unknown keys,
      // so a parsed `features` would look clean either way. The flag has to be
      // gone entirely rather than reported false: an admin badge reading
      // "stripe: off" is still a payment processor on screen.
      expect(res.json()).not.toHaveProperty('features.stripe');
    } finally {
      await admin.app.close();
    }
  });

  it('keeps the usage collection — it is telemetry, not metering for a bill', async () => {
    // Guards the one thing the billing deletion had to NOT take with it.
    await store.usage.insertOne({
      id: 'usage-kept-1',
      userId: 'user-kept-1',
      roomId: null,
      kind: 'session-minutes',
      amount: 7,
      unit: 'min',
      at: Date.now(),
      meta: null,
    });
    expect(await store.usage.count({ userId: 'user-kept-1' })).toBe(1);
  });
});
