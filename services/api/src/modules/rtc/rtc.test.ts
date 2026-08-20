/**
 * RTC module tests: the TURN credentials strategy chain
 * (Cloudflare → STUN-only), unmetered for every account, and the honesty
 * field that says whether a relay actually came through. All on memory
 * adapters; global fetch is stubbed — no network, and no Redis or Mongo is
 * involved in any of it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TurnCredentialsResponse } from '@gather/contracts';
import type { AppConfig } from '../../config';
import { newId } from '../../lib/tokens';
import type { TestApp } from '../../../test/helpers';
import { makeApp, signupUser, testConfig } from '../../../test/helpers';
import { TOKEN_TTL_SECONDS } from './service';

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

/** Cloudflare TURN-keys payload with a real relay URL in it. */
function cloudflarePayload(): string {
  return JSON.stringify({
    iceServers: {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'cf-user',
      credential: 'cf-pass',
    },
  });
}

/** A 200 from Cloudflare that carries no relay: STUN reflects an address,
 *  it cannot carry media for a peer that fails to hole-punch. */
function stunOnlyCloudflarePayload(): string {
  return JSON.stringify({ iceServers: { urls: ['stun:stun.cloudflare.com:3478'] } });
}

const CF_CONFIGURED = {
  cloudflare: { turnKeyId: 'kid', turnApiToken: 'cf-token', sfuAppId: null, sfuApiToken: null },
};

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

    it('falls back to STUN-only when Cloudflare TURN is not configured', async () => {
      const { body } = await turnRequest(testConfig());
      expect(body.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
      expect(body.ttlSeconds).toBe(TOKEN_TTL_SECONDS);
      expect(body.fairUseRemainingGb).toBeNull();
    });

    it('maps Cloudflare TURN-keys credentials through when configured', async () => {
      const fetchMock = stubFetch(async () =>
        new Response(cloudflarePayload(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const { body } = await turnRequest(testConfig(CF_CONFIGURED));
      expect(body.iceServers).toEqual([
        {
          urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
          username: 'cf-user',
          credential: 'cf-pass',
        },
      ]);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      // The suffix is the fix: the bare `/credentials` path answers 405
      // ("reserved for future WHIP/WHEP"), so every fetch failed and the
      // service silently served STUN-only — TURN never worked, keys or not.
      expect(String(url)).toBe(
        'https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers',
      );
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer cf-token');
    });

    it('tags the Cloudflare credential with the requesting user', async () => {
      const fetchMock = stubFetch(async () =>
        new Response(cloudflarePayload(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const { userId } = await turnRequest(testConfig(CF_CONFIGURED));
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as {
        ttl?: number;
        customIdentifier?: string;
      };
      expect(body.customIdentifier).toBe(userId);
      expect(body.ttl).toBe(TOKEN_TTL_SECONDS);
    });

    it('falls through to STUN-only when the Cloudflare request fails', async () => {
      stubFetch(async () => {
        throw new Error('network down');
      });
      const { body } = await turnRequest(testConfig(CF_CONFIGURED));
      expect(body.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    });

    it('falls through to STUN-only on a Cloudflare API error', async () => {
      stubFetch(async () => new Response('nope', { status: 403 }));
      const { body } = await turnRequest(
        testConfig({
          cloudflare: { turnKeyId: 'kid', turnApiToken: 'bad-token', sfuAppId: null, sfuApiToken: null },
        }),
      );
      expect(body.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    });

    it('says relayAvailable: false when the fallback carries no relay', async () => {
      const { body } = await turnRequest(testConfig());
      // The deployment state behind the silent two-person call: a STUN server
      // and nothing that can carry a byte when hole-punching fails.
      expect(body.relayAvailable).toBe(false);
    });

    it('says relayAvailable: true when a turn: URL is actually issued', async () => {
      stubFetch(async () =>
        new Response(cloudflarePayload(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const { body } = await turnRequest(testConfig(CF_CONFIGURED));
      expect(body.relayAvailable).toBe(true);
    });

    it('reports a failed key exactly as it reports no key — same experience', async () => {
      stubFetch(async () => new Response('nope', { status: 403 }));
      const { body: failed } = await turnRequest(testConfig(CF_CONFIGURED), 'bad@example.com');
      vi.unstubAllGlobals();
      await app.app.close();
      const { body: absent } = await turnRequest(testConfig(), 'absent@example.com');
      expect(failed.relayAvailable).toBe(false);
      expect(failed.relayAvailable).toBe(absent.relayAvailable);
      expect(failed.iceServers).toEqual(absent.iceServers);
    });

    it('reads relayAvailable off the issued URLs, not off the key being set', async () => {
      stubFetch(async () =>
        new Response(stunOnlyCloudflarePayload(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const { body } = await turnRequest(testConfig(CF_CONFIGURED));
      // Cloudflare answered, so the servers are handed through — but nothing
      // in them relays, and the caller is told so.
      expect(body.iceServers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }]);
      expect(body.relayAvailable).toBe(false);
    });

    it('keeps relay URLs for a heavy user — TURN relay is unmetered', async () => {
      stubFetch(async () =>
        new Response(cloudflarePayload(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      app = await makeApp(testConfig(CF_CONFIGURED));
      const account = await signupUser(app.app, 'heavy@example.com');
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
      const allUrls = body.iceServers.flatMap((s) => s.urls);
      expect(allUrls).toContain('turn:turn.cloudflare.com:3478?transport=udp');
      expect(body.fairUseRemainingGb).toBeNull();
    });
  });
});
