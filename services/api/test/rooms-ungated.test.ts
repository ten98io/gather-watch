/**
 * Room capabilities are ungated: every account gets theater layout and the
 * full publisher ceiling. Replaces the old premium-gate suite (there is no
 * plan to gate on any more), and pins the two traps that came with removing
 * the gates:
 *
 *  - theater must stay a LAYOUT. It used to flip relayMode to 'cf-sfu', whose
 *    client join path is a dead stub — ungating that write would have handed
 *    every room a broken call instead of a wider stage.
 *  - the publisher ceiling is now the contract bound (1..12) alone. 12 is
 *    physics (mesh fan-out), so it still holds; nothing below it does.
 *
 * A refusal that is genuinely about ROLE must still be a 403.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Room } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import { addMember, makeApp, seedRoom, signupUser } from './helpers';

describe('ungated room capabilities', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeEach(async () => {
    ({ app, store } = await makeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  /** A plain account (no subscriptions row anywhere) hosting `roomId`. */
  async function host(roomId: string): Promise<{ headers: { authorization: string } }> {
    const account = await signupUser(app, `host-${roomId}@example.com`);
    await addMember(store, roomId, account.user.id, 'host');
    return { headers: { authorization: `Bearer ${account.accessToken}` } };
  }

  it('turns theater on for any host', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await host(roomId);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers,
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { room: Room }).room.theater).toBe(true);
    expect((await store.rooms.findById(roomId))!.theater).toBe(true);
  });

  it('theater is a layout only: it never switches the room to cf-sfu', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await host(roomId);

    const on = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { room: Room }).room.relayMode).toBe('mesh');
    expect((await store.rooms.findById(roomId))!.relayMode).toBe('mesh');

    const off = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await store.rooms.findById(roomId))!.theater).toBe(false);
    expect((await store.rooms.findById(roomId))!.relayMode).toBe('mesh');
  });

  it('accepts maxPublishers: 12 from any host', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await host(roomId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${roomId}/policies`,
      headers,
      payload: { maxPublishers: 12 },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { room: Room }).room.policies.maxPublishers).toBe(12);
  });

  it('still rejects maxPublishers above the contract bound of 12', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await host(roomId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${roomId}/policies`,
      headers,
      payload: { maxPublishers: 13 },
    });

    // Mesh fan-out, not a plan: a bad request, never an upsell.
    expect(res.statusCode).toBe(400);
    expect((await store.rooms.findById(roomId))!.policies.maxPublishers).toBe(6);
  });

  it('no room route answers 402 any more', async () => {
    const { roomId } = await seedRoom(store);
    const { headers } = await host(roomId);

    const theater = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers,
      payload: { enabled: true },
    });
    const policies = await app.inject({
      method: 'PATCH',
      url: `/rooms/${roomId}/policies`,
      headers,
      payload: { maxPublishers: 12 },
    });

    expect(theater.statusCode).not.toBe(402);
    expect(policies.statusCode).not.toBe(402);
  });

  it('still answers a genuine permission failure with 403', async () => {
    const { roomId } = await seedRoom(store);
    const account = await signupUser(app, 'plain-member@example.com');
    await addMember(store, roomId, account.user.id, 'member');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${roomId}/theater`,
      headers: { authorization: `Bearer ${account.accessToken}` },
      payload: { enabled: true },
    });

    // Refused for their ROLE — a permission failure, not an upsell.
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('ROOM_POLICY');
  });
});
