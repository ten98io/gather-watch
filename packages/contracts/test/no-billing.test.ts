/**
 * Tombstone for the billing contracts.
 *
 * Gather is free for everyone: there is no plan, no entitlement set and no
 * subscription, so the wire vocabulary that described them must not exist
 * either. A surviving `Plan` enum or `PAYMENT_REQUIRED` code is an invitation
 * for the next author to re-gate something — the schema is the last place a
 * deleted tier can hide, because every client compiles against it.
 *
 * These assertions read the module namespace rather than named imports on
 * purpose: a named import of a deleted symbol is a compile error, which the
 * runtime suite would never reach.
 */
import { describe, it, expect } from 'vitest';
import * as contracts from '../src';
import { AdminOverviewResponse, ERROR_CODES, rest } from '../src';

const BILLING_SYMBOLS = [
  'Plan',
  'Entitlements',
  'Subscription',
  'CreateCheckoutSessionBody',
  'CreateCheckoutSessionResponse',
  'CreatePortalSessionResponse',
  'GetEntitlementsResponse',
];

describe('no billing contracts', () => {
  for (const symbol of BILLING_SYMBOLS) {
    it(`does not export ${symbol}`, () => {
      expect(Object.keys(contracts)).not.toContain(symbol);
    });
  }

  it('has no PAYMENT_REQUIRED error code', () => {
    expect(ERROR_CODES).not.toContain('PAYMENT_REQUIRED');
  });

  it('has no billing group in the rest map', () => {
    expect(Object.keys(rest)).not.toContain('billing');
  });

  /* The admin overview renders every `features` key as a literal badge
     ("gifs: on"). A payment-processor key therefore puts a payments word on
     screen even when its value is false — which is exactly how `stripe: false`
     outlived the billing deletion. Guard the key set, not just the values. */
  it('declares no payment processor among the admin feature flags', () => {
    const features = Object.keys(AdminOverviewResponse.shape.features.shape);
    expect(features).not.toHaveLength(0);
    for (const key of features) {
      expect(key).not.toMatch(/stripe|billing|plan|premium|subscription|entitlement/i);
    }
  });

  /* Usage reporting is not billing: /admin/usage aggregates relay bytes for
     capacity work and the GDPR export owes the user their copy of it. It
     stays. */
  it('keeps the relay usage aggregate', () => {
    expect(Object.keys(contracts)).toContain('RelayUsageMonth');
  });
});
