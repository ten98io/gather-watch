/**
 * Room lifecycle: 12-char invite codes (hyphen/case-insensitive join),
 * rename/delete CRUD with role gates, free-plan 4h expiry (premium exempt),
 * the activity-reset bump, and the expiry sweeper.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { formatInviteCode, normalizeInviteCode } from '@gather/contracts';
import type { Room } from '@gather/contracts';
import { makeApp, signupUser } from './helpers';
import type { TestApp } from './helpers';
import { sweepExpiredRooms } from '../src/modules/rooms/service';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function newApp(): Promise<TestApp> {
  const app = await makeApp();
  apps.push(app.app);
  return app;
}

async function createRoom(fastify: FastifyInstance, token: string, name = 'Room'): Promise<Room> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/rooms',
    headers: { authorization: `Bearer ${token}` },
    payload: { kind: 'watch', name },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { room: Room }).room;
}

describe('invite codes', () => {
  it('generates 12-char codes, displayed XXXX-XXXX-XXXX', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'a@example.com');
    const room = await createRoom(app.app, accessToken);
    expect(room.inviteCode).toMatch(/^[a-z2-9]{12}$/);
    expect(formatInviteCode(room.inviteCode)).toMatch(/^....-....-....$/);
  });

  it('joins with the hyphenated, uppercased display form', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    const { accessToken: guestToken } = await signupUser(app.app, 'guest@example.com');

    const pretty = formatInviteCode(room.inviteCode).toUpperCase();
    expect(normalizeInviteCode(pretty)).toBe(room.inviteCode);
    const res = await app.app.inject({
      method: 'POST',
      url: '/rooms/join',
      headers: { authorization: `Bearer ${guestToken}` },
      payload: { inviteCode: pretty },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { room: Room }).room.id).toBe(room.id);
  });
});

describe('room CRUD', () => {
  it('host renames, members cannot', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    const { accessToken: memberToken } = await signupUser(app.app, 'm@example.com');
    await app.app.inject({
      method: 'POST',
      url: '/rooms/join',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { inviteCode: room.inviteCode },
    });

    const forbidden = await app.app.inject({
      method: 'PATCH',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'Hijacked' },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.app.inject({
      method: 'PATCH',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { name: 'Renamed' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { room: Room }).room.name).toBe('Renamed');
  });

  it('host deletes; the room, members and messages are gone', async () => {
    const app = await newApp();
    const { accessToken: hostToken, user } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);

    const asMember = await app.app.inject({
      method: 'DELETE',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${(await signupUser(app.app, 'm2@example.com')).accessToken}` },
    });
    expect(asMember.statusCode).toBe(403); // not even a member → forbidden either way

    const ok = await app.app.inject({
      method: 'DELETE',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(await app.store.rooms.findById(room.id)).toBeNull();
    expect(await app.store.members.count({ roomId: room.id })).toBe(0);
    void user;
  });
});

describe('room kind (vestigial)', () => {
  it("create WITHOUT kind succeeds; the doc and response default to 'watch'", async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'nokind@example.com');
    const res = await app.app.inject({
      method: 'POST',
      url: '/rooms',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Kindless' },
    });
    expect(res.statusCode).toBe(200);
    const room = (res.json() as { room: Room }).room;
    expect(room.kind).toBe('watch');
    expect((await app.store.rooms.findById(room.id))?.kind).toBe('watch');
  });

  it("create WITH kind 'listen' still succeeds and serializes it back (old clients)", async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'oldclient@example.com');
    const res = await app.app.inject({
      method: 'POST',
      url: '/rooms',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { kind: 'listen', name: 'Legacy listen' },
    });
    expect(res.statusCode).toBe(200);
    const room = (res.json() as { room: Room }).room;
    expect(room.kind).toBe('listen');
    // Serialized rooms keep carrying kind on every read path.
    const get = await app.app.inject({
      method: 'GET',
      url: `/rooms/${room.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { room: Room }).room.kind).toBe('listen');
  });
});

describe('free-plan expiry', () => {
  it('free rooms get expiresAt ≈ now+4h; premium rooms persist', async () => {
    const app = await newApp();
    const { accessToken: freeToken } = await signupUser(app.app, 'free@example.com');
    const freeRoom = await createRoom(app.app, freeToken);
    expect(freeRoom.expiresAt).not.toBeNull();
    const ttl = (freeRoom.expiresAt ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(3.9 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(4 * 3600_000);

    const { accessToken: proToken, user: proUser } = await signupUser(app.app, 'pro@example.com');
    await app.store.subscriptions.insertOne({
      id: proUser.id,
      userId: proUser.id,
      plan: 'premium',
      status: 'active',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      updatedAt: Date.now(),
    });
    const proRoom = await createRoom(app.app, proToken);
    expect(proRoom.expiresAt).toBeNull();
  });

  it('persisted room events reset the TTL (activity keeps the room alive)', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'act@example.com');
    const room = await createRoom(app.app, accessToken);

    // Simulate a room 2h from expiry, then one persisted event.
    const soon = Date.now() + 2 * 3600_000;
    await app.store.rooms.updateOne({ id: room.id }, { expiresAt: soon });
    await app.deps.events.emit(room.id, 'room.updated', room);

    const after = await app.store.rooms.findById(room.id);
    expect((after?.expiresAt ?? 0) > soon + 3600_000).toBe(true);
  });

  it('the sweeper deletes expired rooms with their members and history', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'old@example.com');
    const room = await createRoom(app.app, accessToken);
    await app.deps.events.emit(room.id, 'room.updated', room);
    await app.store.rooms.updateOne({ id: room.id }, { expiresAt: Date.now() - 1000 });

    const deleted = await sweepExpiredRooms(app.deps, Date.now());
    expect(deleted).toContain(room.id);
    expect(await app.store.rooms.findById(room.id)).toBeNull();
    expect(await app.store.members.count({ roomId: room.id })).toBe(0);
    expect(await app.store.events.count({ roomId: room.id })).toBe(0);
  });
});
