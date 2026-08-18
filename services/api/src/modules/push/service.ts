/**
 * Push-subscription registry. The one place a `pushSubs` row is ever WRITTEN —
 * chat/notify.ts reads them, compliance/erasure.ts deletes them, and until this
 * module existed nothing in the codebase created one, so every mention push
 * fanned out to an empty list.
 *
 * A subscription belongs to a BROWSER (or a device), not to an account: the
 * endpoint is minted by the push service for that installation. So `endpoint`
 * is the identity here, and the row is upserted on it — re-subscribing after a
 * key rotation updates in place, and signing a different account into the same
 * browser MOVES the row rather than leaving the previous account subscribed to
 * a device it no longer has.
 *
 * Everything a client asserts about a web subscription is checked before it is
 * stored: the endpoint against ./endpoint.ts (a server-initiated POST target
 * chosen by the client is an SSRF primitive), and the row count against
 * MAX_PUSH_SUBS_PER_USER.
 */
import { AppError, isAppError } from '../../lib/errors';
import { newId } from '../../lib/tokens';
import type { PushSubDoc, StorePort } from '../../adapters/ports';
import type { PushSubscribeBody, PushUnsubscribeBody } from '@gather/contracts';
import type { UserId } from '@gather/contracts';
import { MAX_PUSH_SUBS_PER_USER, assertPushEndpointAllowed } from './endpoint';

/** The unique key for a subscription body, per platform. */
function identityFilter(
  body: PushSubscribeBody | PushUnsubscribeBody,
): { endpoint: string } | { expoPushToken: string } {
  return body.platform === 'web'
    ? { endpoint: body.endpoint }
    : { expoPushToken: body.expoPushToken };
}

/** The row fields a subscribe body carries, per platform. */
function registration(body: PushSubscribeBody): Pick<
  PushSubDoc,
  'platform' | 'endpoint' | 'keys' | 'expoPushToken'
> {
  return body.platform === 'web'
    ? { platform: 'web', endpoint: body.endpoint, keys: body.keys, expoPushToken: null }
    : { platform: 'expo', endpoint: null, keys: null, expoPushToken: body.expoPushToken };
}

/**
 * Register (or re-register) this installation for `userId`. Idempotent: the
 * same endpoint sent twice leaves exactly one row, with the newest keys.
 */
export async function subscribePush(
  store: StorePort,
  userId: UserId,
  body: PushSubscribeBody,
): Promise<PushSubDoc> {
  if (body.platform === 'web') {
    // Before anything is written: a rejected endpoint must leave no row and
    // no trace of one.
    await assertPushEndpointAllowed(body.endpoint);
  }
  const filter = identityFilter(body);
  const patch = { userId, ...registration(body), createdAt: Date.now() };

  const existing = await store.pushSubs.findOne(filter);
  if (existing !== null) {
    const updated = await store.pushSubs.updateOne({ id: existing.id }, patch);
    if (updated === null) {
      throw new AppError('INTERNAL', 'push subscription vanished mid-update');
    }
    // An upsert usually leaves the count alone — except when this endpoint
    // MOVED accounts (a different person signing into the same browser), which
    // adds a row to the new owner's tally.
    if (existing.userId !== userId) {
      await evictOldestOverBound(store, userId, updated.id);
    }
    return updated;
  }

  let inserted: PushSubDoc;
  try {
    inserted = await store.pushSubs.insertOne({ id: newId(), ...patch });
  } catch (err) {
    // Lost a race against another tab registering the same endpoint. The
    // unique index did its job; converge on the row that won.
    if (!isAppError(err) || err.code !== 'CONFLICT') {
      throw err;
    }
    const winner = await store.pushSubs.findOne(filter);
    if (winner === null) {
      throw err;
    }
    const updated = await store.pushSubs.updateOne({ id: winner.id }, patch);
    return updated ?? winner;
  }
  // A genuinely new row always adds to the tally.
  await evictOldestOverBound(store, userId, inserted.id);
  return inserted;
}

/**
 * Keep at most MAX_PUSH_SUBS_PER_USER rows for the account, dropping the
 * oldest.
 *
 * Ordered ASCENDING on purpose. `createdAt` is a millisecond clock and several
 * registrations can share one tick, and a stable sort resolves ties by the
 * order the adapter yields rows — insertion order in both, which IS age order.
 * Ascending therefore puts the genuinely oldest first even when the clock
 * cannot tell them apart; descending would put ties in exactly the wrong
 * order. `keepId` is belt-and-braces on top: the row this subscribe just wrote
 * is never the one evicted, so registering a new browser always leaves that
 * browser subscribed.
 */
async function evictOldestOverBound(
  store: StorePort,
  userId: UserId,
  keepId: string,
): Promise<void> {
  const rows = await store.pushSubs.findMany({ userId }, { sort: [['createdAt', 1]] });
  const excess = rows.length - MAX_PUSH_SUBS_PER_USER;
  if (excess <= 0) {
    return;
  }
  const evictable = rows.filter((row) => row.id !== keepId);
  for (const stale of evictable.slice(0, excess)) {
    await store.pushSubs.deleteOne({ id: stale.id });
  }
}

/**
 * Drop this installation's registration. Scoped to the caller: an endpoint
 * that now belongs to a different account is left alone, so one stale client
 * cannot unsubscribe whoever signed in after it.
 */
export async function unsubscribePush(
  store: StorePort,
  userId: UserId,
  body: PushUnsubscribeBody,
): Promise<number> {
  return store.pushSubs.deleteMany({ ...identityFilter(body), userId });
}
