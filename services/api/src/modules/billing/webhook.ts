/**
 * Stripe webhook: raw-body signature verification + subscription state
 * projection into store.subscriptions. This is the ONLY writer of premium
 * state — entitlements read Mongo afterwards, so Stripe is never in the
 * hot path.
 *
 * RAW BODY: app.ts registers no raw-body seam and Fastify parses JSON
 * globally, so routes.ts overrides the 'application/json' content-type
 * parser INSIDE this module's encapsulated plugin scope (Fastify 5 scoping
 * keeps it local to billing routes): it parses with parseAs 'buffer',
 * stashes the untouched bytes in rawBodies (keyed by request), then JSON-
 * parses as usual so the sibling JSON routes are unaffected.
 * constructEvent() verifies `Stripe-Signature` against those exact bytes.
 */
import type { FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { AppError } from '../../lib/errors';
import type { SubscriptionDoc } from '../../adapters/ports';
import { getStripe } from './service';
import type { Deps } from '../types';

// ── Raw body capture (populated by the scoped parser in routes.ts) ──────────

const rawBodies = new WeakMap<FastifyRequest, Buffer>();

export function stashRawBody(request: FastifyRequest, raw: Buffer): void {
  rawBodies.set(request, raw);
}

function takeRawBody(request: FastifyRequest): Buffer {
  const raw = rawBodies.get(request);
  if (raw === undefined) {
    throw new AppError('VALIDATION', 'webhook raw body unavailable');
  }
  rawBodies.delete(request);
  return raw;
}

// ── Event object shapes (only the fields this module reads) ────────────────

type StripeId = string | { id: string } | null | undefined;

function idOf(value: StripeId): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && value !== undefined && typeof value.id === 'string') return value.id;
  return null;
}

interface CheckoutSessionLike {
  customer: StripeId;
  subscription: StripeId;
  client_reference_id?: string | null;
  metadata?: { userId?: string } | null;
}

interface SubscriptionItemLike {
  current_period_end?: number | null;
  price?: { id?: string } | null;
}

interface SubscriptionLike {
  id: string;
  customer: StripeId;
  status?: string;
  current_period_end?: number | null;
  items?: { data?: SubscriptionItemLike[] } | null;
  metadata?: { userId?: string } | null;
}

// ── Stripe → SubscriptionDoc mapping ───────────────────────────────────────

function mapStatus(status: string | undefined): SubscriptionDoc['status'] {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'none';
  }
}

/** current_period_end moved onto subscription items in newer API versions —
 *  read both shapes. Returns ISO datetime or null. */
function periodEndIso(sub: SubscriptionLike): string | null {
  const direct = sub.current_period_end;
  const unix =
    typeof direct === 'number'
      ? direct
      : sub.items?.data?.[0]?.current_period_end;
  return typeof unix === 'number' && Number.isFinite(unix)
    ? new Date(unix * 1000).toISOString()
    : null;
}

async function upsertSubscription(
  deps: Deps,
  userId: string,
  patch: Partial<SubscriptionDoc>,
): Promise<void> {
  const updated = await deps.store.subscriptions.updateOne(
    { id: userId },
    { ...patch, updatedAt: Date.now() },
  );
  if (updated === null) {
    await deps.store.subscriptions.insertOne({
      id: userId,
      userId,
      plan: patch.plan ?? 'free',
      status: patch.status ?? 'none',
      stripeCustomerId: patch.stripeCustomerId ?? null,
      stripeSubscriptionId: patch.stripeSubscriptionId ?? null,
      currentPeriodEnd: patch.currentPeriodEnd ?? null,
      updatedAt: Date.now(),
    });
  }
}

async function userIdForCustomer(deps: Deps, customerId: string | null): Promise<string | null> {
  if (customerId === null) return null;
  const row = await deps.store.subscriptions.findOne({ stripeCustomerId: customerId });
  return row?.userId ?? null;
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function onCheckoutCompleted(deps: Deps, session: CheckoutSessionLike): Promise<void> {
  const customerId = idOf(session.customer);
  const userId =
    session.client_reference_id ??
    session.metadata?.userId ??
    (await userIdForCustomer(deps, customerId));
  if (userId === null) {
    deps.log.warn({ customerId }, 'stripe webhook: checkout session with unknown user');
    return;
  }
  // currentPeriodEnd stays null here; customer.subscription.updated (sent
  // immediately after) fills it in.
  await upsertSubscription(deps, userId, {
    plan: 'premium',
    status: 'active',
    stripeCustomerId: customerId,
    stripeSubscriptionId: idOf(session.subscription),
    currentPeriodEnd: null,
  });
}

async function onSubscriptionUpdated(deps: Deps, sub: SubscriptionLike): Promise<void> {
  const customerId = idOf(sub.customer);
  const userId = sub.metadata?.userId ?? (await userIdForCustomer(deps, customerId));
  if (userId === null) {
    deps.log.warn({ customerId }, 'stripe webhook: subscription for unknown customer');
    return;
  }
  const status = mapStatus(sub.status);
  await upsertSubscription(deps, userId, {
    plan: status === 'active' || status === 'past_due' ? 'premium' : 'free',
    status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: periodEndIso(sub),
  });
}

async function onSubscriptionDeleted(deps: Deps, sub: SubscriptionLike): Promise<void> {
  const customerId = idOf(sub.customer);
  const userId = sub.metadata?.userId ?? (await userIdForCustomer(deps, customerId));
  if (userId === null) {
    deps.log.warn({ customerId }, 'stripe webhook: deleted subscription for unknown customer');
    return;
  }
  await upsertSubscription(deps, userId, {
    plan: 'free',
    status: 'canceled',
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: null,
  });
}

/**
 * Dispatch one verified Stripe event. Unknown types are acknowledged and
 * ignored so Stripe stops retrying them.
 */
export async function handleStripeEvent(deps: Deps, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await onCheckoutCompleted(deps, event.data.object as unknown as CheckoutSessionLike);
      return;
    case 'customer.subscription.updated':
      await onSubscriptionUpdated(deps, event.data.object as unknown as SubscriptionLike);
      return;
    case 'customer.subscription.deleted':
      await onSubscriptionDeleted(deps, event.data.object as unknown as SubscriptionLike);
      return;
    default:
      deps.log.debug({ type: event.type }, 'stripe webhook: ignoring unhandled event type');
  }
}

/**
 * Verify the request's Stripe-Signature against the stashed raw body and
 * dispatch the event. Throws AppError('VALIDATION') (400) on a bad signature
 * or missing header, AppError('INTERNAL') when the webhook secret is not
 * configured.
 */
export async function processStripeWebhook(deps: Deps, request: FastifyRequest): Promise<void> {
  const { webhookSecret } = deps.config.stripe;
  if (webhookSecret === null) {
    throw new AppError('INTERNAL', 'billing webhook is not configured on this server');
  }
  const signature = request.headers['stripe-signature'];
  if (typeof signature !== 'string' || signature === '') {
    throw new AppError('VALIDATION', 'missing stripe-signature header');
  }
  const raw = takeRawBody(request);
  const stripe = await getStripe(deps);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
  } catch (err) {
    if ((err as { type?: unknown }).type === 'StripeSignatureVerificationError') {
      throw new AppError('VALIDATION', 'invalid stripe webhook signature');
    }
    throw err;
  }
  await handleStripeEvent(deps, event);
}
