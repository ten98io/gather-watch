/**
 * Plan gates answer 402, not 403.
 *
 * This is a real user-visible bug fix: the web app decides between "you don't
 * have permission to do that here" and "this needs the Premium plan" on the
 * HTTP status alone (apps/web/lib/describe-error.ts), so a plan gate thrown as
 * FORBIDDEN made the upgrade prompt unreachable. Every entitlement check now
 * throws PAYMENT_REQUIRED → 402.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StorePort } from '../src/adapters/ports';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

describe('premium plan gates', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeEach(async () => {
    ({ app, store } = await makeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  /** A host on the free plan (no subscriptions row = free). */
  async function freeHost(roomId: string): Promise<{ headers: { authorization: string }; userId: string }> {
    const account = await signupUser(app, `host-${roomId}@example.com`);
    await addMember(store, roomId, account.user.id, 'host');
    return {
      headers: { authorization: `Bearer ${account.accessToken}` },
      userId: account.user.id,
    };
  }

  async function grantPremium(userId: string): Promise<void> {
    await store.subscriptions.insertOne({
      id: userId,
      userId,
      plan: 'premium',
      status: 'active',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      updatedAt: Date.now(),
    });
  }

  it('answers theater mode on a free plan with 402 PAYMENT_REQUIRED', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await freeHost(roomId);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(402);
    expect((res.json() as { code: string }).code).toBe('PAYMENT_REQUIRED');
    // The room is unchanged — the gate refused before any write.
    expect((await store.rooms.findById(roomId))!.theater).toBe(false);
  });

  it('lets a premium host turn theater mode on', async () => {
    const { roomId } = await seedRoom(store);
    const { headers, userId } = await freeHost(roomId);
    await grantPremium(userId);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect((await store.rooms.findById(roomId))!.theater).toBe(true);
  });

  it('turning theater mode OFF is never gated', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await freeHost(roomId);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it('answers a maxPublishers value above the plan cap with 402', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await freeHost(roomId);

    // 12 is inside the contract's range but above the free plan's cap of 6.
    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${roomId}/policies`,
      headers,
      payload: { maxPublishers: 12 },
    });

    expect(res.statusCode).toBe(402);
    expect((res.json() as { code: string }).code).toBe('PAYMENT_REQUIRED');
  });

  it('still answers a genuine permission failure with 403, not 402', async () => {
    const { roomId } = await seedRoom(store);
    const account = await signupUser(app, 'plain-member@example.com');
    await addMember(store, roomId, account.user.id, 'member');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers: { authorization: `Bearer ${account.accessToken}` },
      payload: { enabled: true },
    });

    // A member is refused for their ROLE — that is a permission failure and
    // must never read as an upsell.
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('ROOM_POLICY');
  });
});
