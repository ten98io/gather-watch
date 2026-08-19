/**
 * POST /rooms/join belongs on the AUTH rate tier.
 *
 * Its body carries a room password and the check behind it is scrypt, which
 * makes it a credential-guessing surface in exactly the way POST /auth/guest
 * is — and it was sitting on the general budget (300/min) while its twin was
 * capped at 20/min. Fifteen times the guesses per minute against the one
 * secret standing between a stranger and a private room.
 *
 * The tier is a route option, so the only honest test is to shrink the budget
 * and watch the route hit it: nothing else distinguishes a route that opted in
 * from one that merely has not been hammered yet.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, seedRoom, signupUser, testConfig } from './helpers';
import type { TestApp } from './helpers';

/** authMax is deliberately tiny; the general tier stays wide so the two are
 *  told apart by which one runs out. */
const AUTH_MAX = 3;
const GENERAL_MAX = 1000;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function tieredApp(): Promise<TestApp> {
  const app = await makeApp(
    testConfig({ rateLimit: { max: GENERAL_MAX, windowMs: 60_000, authMax: AUTH_MAX } }),
  );
  apps.push(app.app);
  return app;
}

describe('POST /rooms/join sits on the auth rate tier', () => {
  it('runs out of budget at authMax, like its twin POST /auth/guest', async () => {
    const app = await tieredApp();
    const account = await signupUser(app.app, 'joiner@example.com');
    const { roomId } = await seedRoom(app.store);
    await app.app.inject({
      method: 'PATCH',
      url: `/rooms/${roomId}/password`,
      headers: { authorization: `Bearer ${account.accessToken}` },
      payload: { password: 'the-real-one' },
    });

    const guess = (): Promise<{ statusCode: number }> =>
      app.app.inject({
        method: 'POST',
        url: '/rooms/join',
        headers: { authorization: `Bearer ${account.accessToken}` },
        payload: { inviteCode: 'not-a-real-code', password: 'guess' },
      });

    const codes: number[] = [];
    for (let i = 0; i < AUTH_MAX + 2; i += 1) {
      codes.push((await guess()).statusCode);
    }
    // Whatever a wrong guess answers, the budget runs out well inside the
    // general tier's 1000 — which is the whole claim.
    expect(codes).toContain(429);
    expect(codes.filter((code) => code === 429).length).toBe(2);
    expect(codes.slice(0, AUTH_MAX)).not.toContain(429);
  });

  it('leaves general-tier routes on the general budget', async () => {
    const app = await tieredApp();
    const account = await signupUser(app.app, 'creator@example.com');

    // Comfortably past authMax on a route that never opted in.
    const codes: number[] = [];
    for (let i = 0; i < AUTH_MAX + 3; i += 1) {
      const res = await app.app.inject({
        method: 'POST',
        url: '/rooms',
        headers: { authorization: `Bearer ${account.accessToken}` },
        payload: { name: `room ${String(i)}`, kind: 'watch' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).not.toContain(429);
  });
});
