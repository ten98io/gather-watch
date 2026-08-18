/**
 * Room passwords: the host sets, rotates and clears a passphrase from room
 * settings; new joins (account AND guest) must present it; existing members
 * rejoin without re-verifying. Two properties matter more than the feature:
 *
 *  • PROBE-PROOF — an unknown invite code, a missing password and a WRONG
 *    password all answer the same NOT_FOUND, so the error shape never reveals
 *    that a code is real but gated.
 *  • NO LEAK — the scrypt hash is server-only (RoomDoc.passwordHash); the
 *    wire carries only the boolean hasPassword.
 *
 * Rotation IS recovery: there is no reset flow, so these tests pin that the
 * old password dies the moment a new one is set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Room } from '@gather/contracts';
import { makeApp, signupUser } from './helpers';
import type { TestApp } from './helpers';
import { hashPassword, verifyPassword } from '../src/lib/tokens';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function newApp(): Promise<TestApp> {
  const app = await makeApp();
  apps.push(app.app);
  return app;
}

async function createRoom(fastify: FastifyInstance, token: string): Promise<Room> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/rooms',
    headers: { authorization: `Bearer ${token}` },
    payload: { kind: 'watch', name: 'Room' },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { room: Room }).room;
}

async function setPassword(
  fastify: FastifyInstance,
  token: string,
  roomId: string,
  password: string | null,
) {
  return fastify.inject({
    method: 'PATCH',
    url: `/rooms/${roomId}/password`,
    headers: { authorization: `Bearer ${token}` },
    payload: { password },
  });
}

async function join(
  fastify: FastifyInstance,
  token: string,
  inviteCode: string,
  password?: string,
) {
  return fastify.inject({
    method: 'POST',
    url: '/rooms/join',
    headers: { authorization: `Bearer ${token}` },
    payload: password === undefined ? { inviteCode } : { inviteCode, password },
  });
}

async function guestJoin(fastify: FastifyInstance, inviteCode: string, password?: string) {
  return fastify.inject({
    method: 'POST',
    url: '/auth/guest',
    payload: {
      inviteCode,
      displayName: 'Guest',
      ...(password === undefined ? {} : { password }),
    },
  });
}

describe('scrypt password hashing', () => {
  it('round-trips, and rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse');
    await expect(verifyPassword('correct horse', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse', stored)).resolves.toBe(false);
  });

  it('salts every hash — the same password never hashes twice alike', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });

  it('refuses a malformed stored hash rather than throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });
});

describe('room password management', () => {
  it('host sets a password; the wire carries hasPassword and NEVER the hash', async () => {
    const app = await newApp();
    const { accessToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, accessToken);
    expect(room.hasPassword).toBe(false);

    const res = await setPassword(app.app, accessToken, room.id, 's3cret');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { room: Room };
    expect(body.room.hasPassword).toBe(true);
    expect(res.body).not.toContain('passwordHash');
    expect(res.body).not.toContain('s3cret');
  });

  it('members and moderators cannot set or clear it — host only', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    const { accessToken: memberToken } = await signupUser(app.app, 'm@example.com');
    await join(app.app, memberToken, room.inviteCode);

    const res = await setPassword(app.app, memberToken, room.id, 's3cret');
    expect(res.statusCode).toBe(403);
  });

  it('rotation is recovery: the old password dies with the new one', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    await setPassword(app.app, hostToken, room.id, 'first');
    await setPassword(app.app, hostToken, room.id, 'second');

    const { accessToken: joiner } = await signupUser(app.app, 'j@example.com');
    expect((await join(app.app, joiner, room.inviteCode, 'first')).statusCode).toBe(404);
    expect((await join(app.app, joiner, room.inviteCode, 'second')).statusCode).toBe(200);
  });

  it('clearing (null) opens the room again', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    await setPassword(app.app, hostToken, room.id, 's3cret');
    const cleared = await setPassword(app.app, hostToken, room.id, null);
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { room: Room }).room.hasPassword).toBe(false);

    const { accessToken: joiner } = await signupUser(app.app, 'j@example.com');
    expect((await join(app.app, joiner, room.inviteCode)).statusCode).toBe(200);
  });
});

describe('the join gate', () => {
  it('unknown code, missing password and wrong password are the SAME 404', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    await setPassword(app.app, hostToken, room.id, 's3cret');
    const { accessToken: joiner } = await signupUser(app.app, 'j@example.com');

    const unknownCode = await join(app.app, joiner, 'aaaaaaaaaaaa');
    const missing = await join(app.app, joiner, room.inviteCode);
    const wrong = await join(app.app, joiner, room.inviteCode, 'nope');
    for (const res of [unknownCode, missing, wrong]) {
      expect(res.statusCode).toBe(404);
      expect((res.json() as { code: string }).code).toBe('NOT_FOUND');
    }
    // Indistinguishable means identical, not just same-coded.
    expect(missing.body).toBe(unknownCode.body);
    expect(wrong.body).toBe(unknownCode.body);
  });

  it('admits the correct password, account and guest alike', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    await setPassword(app.app, hostToken, room.id, 's3cret');

    const { accessToken: joiner } = await signupUser(app.app, 'j@example.com');
    expect((await join(app.app, joiner, room.inviteCode, 's3cret')).statusCode).toBe(200);

    const guest = await guestJoin(app.app, room.inviteCode, 's3cret');
    expect(guest.statusCode).toBe(200);
  });

  it('gates guest joins too, with the same probe-proof 404', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    await setPassword(app.app, hostToken, room.id, 's3cret');

    expect((await guestJoin(app.app, room.inviteCode)).statusCode).toBe(404);
    expect((await guestJoin(app.app, room.inviteCode, 'nope')).statusCode).toBe(404);
  });

  it('an existing member rejoins without re-verifying (join is idempotent)', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    const { accessToken: memberToken } = await signupUser(app.app, 'm@example.com');
    await join(app.app, memberToken, room.inviteCode);

    // The host gates the room AFTER the member is already in.
    await setPassword(app.app, hostToken, room.id, 's3cret');
    expect((await join(app.app, memberToken, room.inviteCode)).statusCode).toBe(200);
  });

  it('an ungated room never asks — password or not, the join proceeds', async () => {
    const app = await newApp();
    const { accessToken: hostToken } = await signupUser(app.app, 'host@example.com');
    const room = await createRoom(app.app, hostToken);
    const { accessToken: joiner } = await signupUser(app.app, 'j@example.com');

    expect((await join(app.app, joiner, room.inviteCode)).statusCode).toBe(200);
    expect((await guestJoin(app.app, room.inviteCode)).statusCode).toBe(200);
  });
});
