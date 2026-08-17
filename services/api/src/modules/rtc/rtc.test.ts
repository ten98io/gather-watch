/**
 * RTC module tests: the TURN credentials strategy chain
 * (Cloudflare → coturn HMAC → STUN-only) with the free-plan fair-use cap.
 * All on memory adapters; global fetch is stubbed — no network.
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TurnCredentialsResponse } from '@gather/contracts';
import type { AppConfig } from '../../config';
import { newId } from '../../lib/tokens';
import type { TestApp } from '../../../test/helpers';
import { makeApp, signupUser, testConfig } from '../../../test/helpers';
import { TOKEN_TTL_SECONDS } from './service';

const TURN_SECRET = 'test-turn-static-secret';
const GB = 1e9;

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchMock): ReturnType<typeof vi.fn<FetchMock>> {
  const mock = vi.fn<FetchMock>(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Authorization header for token-authed inject calls. */
function bearer(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}

describe('rtc module', () => {
  let app: TestApp;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.app.close();
  });

  describe('GET /rtc/turn-credentials', () => {
    async function turnRequest(
      config: AppConfig,
      email = 'turn@example.com',
    ): Promise<{ body: TurnCredentialsResponse; userId: string }> {
      app = await makeApp(config);
      const account = await signupUser(app.app, email);
      const res = await app.app.inject({
        method: 'GET',
        url: '/rtc/turn-credentials',
        headers: bearer(account.accessToken),
      });
      expect(res.statusCode).toBe(200);
      return { body: TurnCredentialsResponse.parse(res.json()), userId: account.user.id };
    }

    it('falls back to STUN-only when no TURN strategy is configured', async () => {
      const { body } = await turnRequest(testConfig());
      expect(body.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
      expect(body.ttlSeconds).toBe(TOKEN_TTL_SECONDS);
      expect(body.fairUseRemainingGb).toBe(20);
    });

    it('mints coturn HMAC-SHA1 credentials when the static secret is set', async () => {
      const { body, userId } = await turnRequest(testConfig({ turnStaticAuthSecret: TURN_SECRET }));
      expect(body.iceServers).toHaveLength(1);
      const server = body.iceServers[0];
      expect(server?.urls).toEqual([
        'turn:localhost:3478?transport=udp',
        'turn:localhost:3478?transport=tcp',
        'turns:localhost:5349?transport=tcp',
      ]);
      const [expiry, subject] = (server?.username ?? ':').split(':');
      expect(subject).toBe(userId);
      expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000 + TOKEN_TTL_SECONDS - 60);
      expect(server?.credential).toBe(
        createHmac('sha1', TURN_SECRET).update(server?.username ?? '').digest('base64'),
      );
    });

    it('maps Cloudflare TURN-keys credentials through when configured', async () => {
      const fetchMock = stubFetch(async () =>
        new Response(
          JSON.stringify({
            iceServers: {
              urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
              username: 'cf-user',
              credential: 'cf-pass',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      const { body } = await turnRequest(
        testConfig({
          cloudflare: { turnKeyId: 'kid', turnApiToken: 'cf-token', sfuAppId: null, sfuApiToken: null },
        }),
      );
      expect(body.iceServers).toEqual([
        {
          urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
          username: 'cf-user',
          credential: 'cf-pass',
        },
      ]);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer cf-token');
    });

    it('falls through to coturn HMAC when the Cloudflare request fails', async () => {
      stubFetch(async () => {
        throw new Error('network down');
      });
      const { body } = await turnRequest(
        testConfig({
          turnStaticAuthSecret: TURN_SECRET,
          cloudflare: { turnKeyId: 'kid', turnApiToken: 'cf-token', sfuAppId: null, sfuApiToken: null },
        }),
      );
      const first = body.iceServers[0];
      expect(first?.urls.some((u) => u.startsWith('turn:localhost:3478'))).toBe(true);
      expect(first?.credential).toBe(
        createHmac('sha1', TURN_SECRET).update(first?.username ?? '').digest('base64'),
      );
    });

    it('falls through to STUN-only on a Cloudflare API error with no secret', async () => {
      stubFetch(async () => new Response('nope', { status: 403 }));
      const { body } = await turnRequest(
        testConfig({
          cloudflare: { turnKeyId: 'kid', turnApiToken: 'bad-token', sfuAppId: null, sfuApiToken: null },
        }),
      );
      expect(body.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    });

    it('strips relay URLs over the free fair-use cap, keeping STUN', async () => {
      app = await makeApp(testConfig({ turnStaticAuthSecret: TURN_SECRET }));
      const account = await signupUser(app.app, 'heavy@example.com');
      await app.store.usage.insertOne({
        id: newId(),
        userId: account.user.id,
        roomId: null,
        kind: 'turn-bytes',
        amount: 21 * GB,
        unit: 'bytes',
        at: Date.now(),
        meta: null,
      });

      const res = await app.app.inject({
        method: 'GET',
        url: '/rtc/turn-credentials',
        headers: bearer(account.accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = TurnCredentialsResponse.parse(res.json());
      const allUrls = body.iceServers.flatMap((s) => s.urls);
      expect(allUrls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'))).toBe(false);
      expect(allUrls).toContain('stun:stun.l.google.com:19302');
      expect(body.fairUseRemainingGb).toBe(0);
    });

    it('does not meter premium users over the cap', async () => {
      app = await makeApp(testConfig({ turnStaticAuthSecret: TURN_SECRET }));
      const account = await signupUser(app.app, 'premium@example.com');
      await app.store.subscriptions.insertOne({
        id: account.user.id,
        userId: account.user.id,
        plan: 'premium',
        status: 'active',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
        updatedAt: Date.now(),
      });
      await app.store.usage.insertOne({
        id: newId(),
        userId: account.user.id,
        roomId: null,
        kind: 'turn-bytes',
        amount: 500 * GB,
        unit: 'bytes',
        at: Date.now(),
        meta: null,
      });

      const res = await app.app.inject({
        method: 'GET',
        url: '/rtc/turn-credentials',
        headers: bearer(account.accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = TurnCredentialsResponse.parse(res.json());
      expect(body.iceServers[0]?.urls.some((u) => u.startsWith('turn:'))).toBe(true);
      expect(body.fairUseRemainingGb).toBeNull();
    });
  });
});
