/**
 * Full auth flows through app.inject: magic links, refresh rotation with
 * reuse detection, guest join/upgrade (incl. merge into an existing account),
 * session management, and rate limiting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Session, User } from '@gather/contracts';
import { memberDocId } from '../src/adapters/ports';
import type { StorePort } from '../src/adapters/ports';
import { makeApp, seedRoom, signupUser, testConfig } from './helpers';

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function rtCookie(value: string): { cookie: string } {
  return { cookie: `gather_rt=${value}` };
}

/** POST /auth/magic-link and return the devLink's token (dev mode). */
async function requestMagicLinkToken(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { ok: boolean; devLink?: string };
  expect(body.ok).toBe(true);
  expect(typeof body.devLink).toBe('string');
  const token = new URL(body.devLink!).searchParams.get('token');
  expect(token).toBeTruthy();
  return token!;
}

describe('auth', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeEach(async () => {
    ({ app, store } = await makeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it('issues a dev magic link that verifies into a session', async () => {
    const token = await requestMagicLinkToken(app, 'Alice@Example.com');

    // A garbage token is rejected with the contracts error shape.
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token: 'garbage-token' },
    });
    expect(bad.statusCode).toBe(401);
    const badBody = bad.json() as { code: string; message: string };
    expect(badBody.code).toBe('UNAUTHORIZED');
    expect(typeof badBody.message).toBe('string');

    const ok = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { user: User; accessToken: string };
    expect(body.user.email).toBe('alice@example.com');
    expect(typeof body.accessToken).toBe('string');

    const cookie = ok.cookies.find((c) => c.name === 'gather_rt');
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.path).toBe('/auth');
  });

  it('magic-link tokens are single-use', async () => {
    const token = await requestMagicLinkToken(app, 'once@example.com');
    const first = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
    expect(second.statusCode).toBe(401);
    expect((second.json() as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('serves and updates /auth/me with a Bearer access token', async () => {
    const account = await signupUser(app, 'me@example.com');

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(account.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: User }).user.email).toBe('me@example.com');

    const anon = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(anon.statusCode).toBe(401);
    expect((anon.json() as { code: string }).code).toBe('UNAUTHORIZED');

    const patched = await app.inject({
      method: 'PATCH',
      url: '/auth/me',
      headers: bearer(account.accessToken),
      payload: { displayName: 'New Name' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { user: User }).user.displayName).toBe('New Name');
  });

  it('rotates refresh tokens and kills the session family on reuse', async () => {
    const account = await signupUser(app, 'rotate@example.com');

    // Access JWTs have second-granularity iat/exp — cross a second boundary
    // so the freshly minted token is guaranteed to differ byte-for-byte.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Rotate: old cookie → new access token + new cookie.
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: rtCookie(account.cookie),
    });
    expect(refreshed.statusCode).toBe(200);
    const refreshedBody = refreshed.json() as { accessToken: string };
    expect(typeof refreshedBody.accessToken).toBe('string');
    expect(refreshedBody.accessToken).not.toBe(account.accessToken);
    const newCookie = refreshed.cookies.find((c) => c.name === 'gather_rt');
    expect(newCookie).toBeDefined();
    expect(newCookie!.value).not.toBe(account.cookie);

    // REUSE DETECTION: replaying the rotated-out cookie revokes the session.
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: rtCookie(account.cookie),
    });
    expect(replay.statusCode).toBe(401);

    // The whole family is dead: the NEW cookie now fails too.
    const killed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: rtCookie(newCookie!.value),
    });
    expect(killed.statusCode).toBe(401);

    // And the still-unexpired access token is rejected (session revoked).
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(refreshedBody.accessToken),
    });
    expect(me.statusCode).toBe(401);
  });

  it('a concurrent double-refresh mints exactly ONE successor token', async () => {
    // Two tabs holding the same cookie refresh in the same instant. The
    // rotation write is compare-and-set on the presented hash, so the loser
    // fails instead of minting a token no store row will ever match again.
    const account = await signupUser(app, 'race@example.com');
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/refresh', headers: rtCookie(account.cookie) }),
      app.inject({ method: 'POST', url: '/auth/refresh', headers: rtCookie(account.cookie) }),
    ]);
    expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([200, 401]);
  });

  it('refuses to refresh a guest whose membership is gone', async () => {
    // A kicked guest (or a deleted room) leaves the guest USER row alive with
    // no membership. Refreshing there must fail: the alternative is minting a
    // guest token with a NULL room scope, and assertGuestScope only confines
    // a token whose roomId is non-null.
    const { inviteCode, roomId } = await seedRoom(store);
    const joined = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode, displayName: 'Shortlived' },
    });
    expect(joined.statusCode).toBe(200);
    const guestCookie = joined.cookies.find((c) => c.name === 'gather_rt');
    expect(guestCookie).toBeDefined();
    const guestUser = (joined.json() as { user: User }).user;

    await store.members.deleteOne({ id: `${roomId}:${guestUser.id}` });

    const refresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: rtCookie(guestCookie!.value),
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('joins a room as a guest via invite code', async () => {
    const { inviteCode } = await seedRoom(store);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode, displayName: 'Guesty' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      user: User;
      room: Record<string, unknown>;
      member: { role: string };
      lastEventSeq: number;
      accessToken: string;
    };
    expect(body.user.email).toBeNull();
    expect(body.user.displayName).toBe('Guesty');
    // Server-only RoomDoc fields must never leak.
    expect(body.room).not.toHaveProperty('playback');
    expect(body.room).not.toHaveProperty('queue');
    expect(body.room).not.toHaveProperty('restream');
    expect(body.room).not.toHaveProperty('master');
    expect(body.member.role).toBe('guest');
    // The join emits the guest's own `member.updated` arrival before reading
    // the tip, so the seeded room's tip is that arrival (seq 1), not 0.
    expect(body.lastEventSeq).toBe(1);
    expect(typeof body.accessToken).toBe('string');
    expect(res.cookies.find((c) => c.name === 'gather_rt')).toBeDefined();
  });

  it('rejects an unknown invite code with 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode: 'nope1234', displayName: 'Nobody' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('NOT_FOUND');
  });

  it('upgrades a guest to a fresh email, keeping id and membership', async () => {
    const { roomId, inviteCode } = await seedRoom(store);
    const guestRes = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode, displayName: 'Soon Real' },
    });
    const guest = guestRes.json() as { user: User; accessToken: string };

    const upgrade = await app.inject({
      method: 'POST',
      url: '/auth/upgrade',
      headers: bearer(guest.accessToken),
      payload: { email: 'fresh@example.com' },
    });
    expect(upgrade.statusCode).toBe(200);
    const devLink = (upgrade.json() as { devLink?: string }).devLink;
    const token = new URL(devLink!).searchParams.get('token')!;

    const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
    expect(verified.statusCode).toBe(200);
    const upgraded = (verified.json() as { user: User }).user;
    // Fresh email: same user id, now with the email attached.
    expect(upgraded.id).toBe(guest.user.id);
    expect(upgraded.email).toBe('fresh@example.com');

    // The room membership survives the upgrade.
    const membership = await store.members.findById(memberDocId(roomId, guest.user.id));
    expect(membership).not.toBeNull();
  });

  it('upgrades a guest into an EXISTING account by merging', async () => {
    const accountA = await signupUser(app, 'a@example.com');
    const { roomId, inviteCode } = await seedRoom(store);
    const guestRes = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { inviteCode, displayName: 'Merge Me' },
    });
    const guest = guestRes.json() as { user: User; accessToken: string };

    const upgrade = await app.inject({
      method: 'POST',
      url: '/auth/upgrade',
      headers: bearer(guest.accessToken),
      payload: { email: 'a@example.com' },
    });
    expect(upgrade.statusCode).toBe(200);
    const devLink = (upgrade.json() as { devLink?: string }).devLink;
    const token = new URL(devLink!).searchParams.get('token')!;

    const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
    expect(verified.statusCode).toBe(200);
    // The verified identity IS account A.
    expect((verified.json() as { user: User }).user.id).toBe(accountA.user.id);

    // The membership row was repointed to A.
    const repointed = await store.members.findById(memberDocId(roomId, accountA.user.id));
    expect(repointed).not.toBeNull();
    expect(repointed?.role).toBe('guest');

    // The guest user row is gone.
    expect(await store.users.findById(guest.user.id)).toBeNull();
  });

  it('rejects /auth/upgrade for non-guest accounts with 409', async () => {
    const account = await signupUser(app, 'full@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/upgrade',
      headers: bearer(account.accessToken),
      payload: { email: 'other@example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('CONFLICT');
  });

  it('manages sessions: list, revoke one, revoke-all', async () => {
    const s1 = await signupUser(app, 'multi@example.com');
    const s2 = await signupUser(app, 'multi@example.com');

    const list = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: bearer(s1.accessToken),
    });
    expect(list.statusCode).toBe(200);
    const sessions = (list.json() as { sessions: Session[] }).sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    // Revoke the other session; its access token dies.
    const other = sessions.find((s) => !s.current);
    expect(other).toBeDefined();
    const del = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${other!.id}`,
      headers: bearer(s1.accessToken),
    });
    expect(del.statusCode).toBe(200);
    const meOther = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(s2.accessToken),
    });
    expect(meOther.statusCode).toBe(401);

    // revoke-all kills every other live session, current one survives.
    const s3 = await signupUser(app, 'multi@example.com');
    const revokeAll = await app.inject({
      method: 'POST',
      url: '/auth/sessions/revoke-all',
      headers: bearer(s1.accessToken),
    });
    expect(revokeAll.statusCode).toBe(200);
    expect((revokeAll.json() as { revoked: number }).revoked).toBeGreaterThanOrEqual(0);
    const meS3 = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(s3.accessToken),
    });
    expect(meS3.statusCode).toBe(401);
    const meS1 = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(s1.accessToken),
    });
    expect(meS1.statusCode).toBe(200);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const account = await signupUser(app, 'bye@example.com');
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: bearer(account.accessToken),
    });
    expect(out.statusCode).toBe(200);
    const cleared = out.cookies.find((c) => c.name === 'gather_rt');
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe('');

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(account.accessToken),
    });
    expect(me.statusCode).toBe(401);
  });

  it('rate limits auth endpoints per the configured authMax', async () => {
    const limited = await makeApp(
      testConfig({ rateLimit: { max: 100000, windowMs: 60000, authMax: 2 } }),
    );
    try {
      const statuses: number[] = [];
      let lastBody: { code?: string } = {};
      for (let i = 0; i < 3; i += 1) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/auth/magic-link',
          payload: { email: `rl${i}@example.com` },
        });
        statuses.push(res.statusCode);
        lastBody = res.json() as { code?: string };
      }
      expect(statuses).toEqual([200, 200, 429]);
      expect(lastBody.code).toBe('RATE_LIMITED');
    } finally {
      await limited.app.close();
    }
  });
});
