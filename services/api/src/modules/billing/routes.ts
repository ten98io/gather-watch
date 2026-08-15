/**
 * Billing REST endpoints. Registered WITHOUT a prefix — paths match the
 * contracts `rest.billing` map (paths live here until api-client grows a
 * billing client). The webhook route is PUBLIC: the auth plugin only
 * populates request.auth when credentials verify, so "public" = simply not
 * calling requireAuth (same pattern as the auth module's magic-link routes).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { CreateCheckoutSessionBody } from '@playin/contracts';
import { newId } from '../../lib/tokens';
import { parseWith } from '../../plugins/error-mapper';
import { requireAuth } from '../../plugins/auth';
import { getEntitlements, wireEntitlementsPort } from './entitlements';
import { billingServiceFor } from './service';
import { processStripeWebhook, stashRawBody } from './webhook';

// ── Usage metering body (NO contract exists yet — defined here per the brief
//    and EXPORTED for a later promotion into @playin/contracts) ─────────────

/** Per-unit per-sample caps: nothing a client may meter exceeds a "1 TB/day"
 *  order of magnitude; negative amounts are rejected by the schema itself. */
export const USAGE_UNIT_MAX_AMOUNT: Record<string, number> = {
  bytes: 1_000_000_000_000, // 1 TB
  gb: 1024,
  milliseconds: 86_400_000, // 1 day
  seconds: 86_400,
  minutes: 1_440,
  messages: 100_000,
  samples: 86_400,
};
const USAGE_DEFAULT_MAX_AMOUNT = 86_400_000;

export const UsageIngestBody = z
  .object({
    roomId: z.string().min(1).max(128).nullable().default(null),
    kind: z.string().min(1).max(64),
    amount: z.number().finite().min(0),
    unit: z.string().min(1).max(32),
    meta: z.record(z.unknown()).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const max = USAGE_UNIT_MAX_AMOUNT[value.unit] ?? USAGE_DEFAULT_MAX_AMOUNT;
    if (value.amount > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: `amount exceeds the per-sample cap for unit '${value.unit}'`,
      });
    }
  });
export type UsageIngestBody = z.infer<typeof UsageIngestBody>;

export const billingRoutes: FastifyPluginAsync = async (app) => {
  // Feed the rooms EntitlementsPort seam from this module's store-backed
  // implementation (supersedes the rooms/deps.ts fallback for this app).
  wireEntitlementsPort(app.deps);

  // Raw-body capture for Stripe signature verification, scoped to THIS
  // module's routes: parse as buffer, stash the untouched bytes on the
  // request, then JSON-parse so every billing route keeps normal bodies.
  // See webhook.ts for the consumer side.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    stashRawBody(request, raw);
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw.toString('utf8')) as unknown);
    } catch (err) {
      const parseError = err as Error & { statusCode?: number };
      parseError.statusCode = 400;
      done(parseError);
    }
  });

  app.post('/billing/checkout-session', async (request) => {
    const auth = requireAuth(request);
    parseWith(CreateCheckoutSessionBody, request.body);
    return billingServiceFor(app.deps).createCheckoutSession(auth.userId);
  });

  app.post('/billing/portal-session', async (request) => {
    const auth = requireAuth(request);
    return billingServiceFor(app.deps).createPortalSession(auth.userId);
  });

  app.post(
    '/billing/webhooks/stripe',
    // Stripe retries must never 429; the signature is the authentication.
    { config: { rateLimit: false } },
    async (request) => {
      await processStripeWebhook(app.deps, request);
      return { received: true as const };
    },
  );

  app.get('/billing/entitlements', async (request) => {
    const auth = requireAuth(request);
    return getEntitlements(app.deps, auth.userId);
  });

  app.post('/billing/usage', async (request) => {
    const auth = requireAuth(request);
    const body = parseWith(UsageIngestBody, request.body);
    await app.deps.store.usage.insertOne({
      id: newId(),
      userId: auth.userId,
      roomId: body.roomId,
      kind: body.kind,
      amount: body.amount,
      unit: body.unit,
      at: Date.now(),
      meta: body.meta,
    });
    return { ok: true as const };
  });
};
