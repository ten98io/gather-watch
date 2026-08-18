/**
 * A push subscription endpoint is a URL the SERVER will later POST to, chosen
 * entirely by the client. Stored verbatim, `POST /push/subscribe` was a
 * request-forgery primitive with persistence: register
 * `http://169.254.169.254/…` (or an internal admin port) and every @mention in
 * any room the account can reach fires that request from inside our network,
 * for as long as the row lives.
 *
 * Two controls are pinned here:
 *   1. the endpoint must belong to a KNOWN push service and survive the
 *      SSRF guard in src/lib/safe-fetch.ts (scheme, host, resolved address);
 *   2. one account's subscriptions are BOUNDED, so a script cannot turn the
 *      table into unbounded storage (and unbounded fan-out per mention).
 *
 * DNS is pinned through a test seam so the suite never touches the network;
 * the addresses returned are what a real resolver would give for these hosts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PushSubscribeBody } from '@gather/contracts';
import type { StorePort } from '../src/adapters/ports';
import {
  MAX_PUSH_SUBS_PER_USER,
  isKnownPushService,
  setPushEndpointLookup,
} from '../src/modules/push/endpoint';
import { makeApp, signupUser } from './helpers';

const FCM = 'https://fcm.googleapis.com/fcm/send/cJKl9-a0b1c2';
const MOZILLA = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB';
const WNS = 'https://par02p.notify.windows.com/w/?token=AwYAAAB';
const APPLE = 'https://web.push.apple.com/QOoAAAAA';

function body(endpoint: string): PushSubscribeBody {
  return {
    platform: 'web',
    endpoint,
    keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret' },
  };
}

describe('push endpoint host constraint', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeAll(async () => {
    ({ app, store } = await makeApp());
    // Every allowed host resolves public; nothing here dials out.
    setPushEndpointLookup(async () => [{ address: '142.250.185.106', family: 4 }]);
  });
  afterAll(async () => {
    setPushEndpointLookup(null);
    await app.close();
  });

  async function subscribe(token: string, endpoint: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { authorization: `Bearer ${token}` },
      payload: body(endpoint),
    });
    return res.statusCode;
  }

  it('knows the four real web-push services and nothing else', () => {
    expect(isKnownPushService(new URL(FCM))).toBe(true);
    expect(isKnownPushService(new URL(MOZILLA))).toBe(true);
    expect(isKnownPushService(new URL(WNS))).toBe(true);
    expect(isKnownPushService(new URL(APPLE))).toBe(true);
    // A subdomain rule must not become an "ends with the string" rule.
    expect(isKnownPushService(new URL('https://evilnotify.windows.com/w/'))).toBe(false);
    expect(isKnownPushService(new URL('https://notify.windows.com.evil.test/w/'))).toBe(false);
    expect(isKnownPushService(new URL('https://fcm.googleapis.com.evil.test/x'))).toBe(false);
    expect(isKnownPushService(new URL('https://push.example.com/sub/abc'))).toBe(false);
  });

  it('accepts a real push-service endpoint', async () => {
    const account = await signupUser(app, 'push-ok@example.com');
    expect(await subscribe(account.accessToken, FCM)).toBe(200);
    const rows = await store.pushSubs.findMany({ userId: account.user.id });
    expect(rows.map((r) => r.endpoint)).toEqual([FCM]);
  });

  it('refuses link-local, loopback and private targets', async () => {
    const account = await signupUser(app, 'push-ssrf@example.com');
    for (const endpoint of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://127.0.0.1:9200/_cluster/state',
      'http://localhost:4000/admin',
      'https://10.0.0.5/internal',
    ]) {
      expect(await subscribe(account.accessToken, endpoint)).toBe(400);
    }
    expect(await store.pushSubs.findMany({ userId: account.user.id })).toEqual([]);
  });

  it('refuses a public host that is not a push service', async () => {
    const account = await signupUser(app, 'push-stranger@example.com');
    expect(await subscribe(account.accessToken, 'https://attacker.example.com/collect')).toBe(400);
    expect(await subscribe(account.accessToken, 'https://fcm.googleapis.com.evil.test/x')).toBe(400);
    expect(await store.pushSubs.findMany({ userId: account.user.id })).toEqual([]);
  });

  it('refuses a non-http scheme outright', async () => {
    const account = await signupUser(app, 'push-scheme@example.com');
    expect(await subscribe(account.accessToken, 'file:///etc/passwd')).toBe(400);
    expect(await store.pushSubs.findMany({ userId: account.user.id })).toEqual([]);
  });
});

describe('push subscriptions are bounded per account', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeAll(async () => {
    ({ app, store } = await makeApp());
    setPushEndpointLookup(async () => [{ address: '142.250.185.106', family: 4 }]);
  });
  afterAll(async () => {
    setPushEndpointLookup(null);
    await app.close();
  });

  it('keeps only the newest MAX_PUSH_SUBS_PER_USER rows', async () => {
    const account = await signupUser(app, 'push-flood@example.com');
    const headers = { authorization: `Bearer ${account.accessToken}` };
    const total = MAX_PUSH_SUBS_PER_USER + 5;

    for (let i = 0; i < total; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/push/subscribe',
        headers,
        payload: body(`${FCM}-${String(i).padStart(3, '0')}`),
      });
      // Registering a new browser must never fail because older, probably
      // dead, endpoints are still on file.
      expect(res.statusCode).toBe(200);
    }

    const rows = await store.pushSubs.findMany({ userId: account.user.id });
    expect(rows).toHaveLength(MAX_PUSH_SUBS_PER_USER);
    const kept = new Set(rows.map((r) => r.endpoint));
    expect(kept.has(`${FCM}-${String(total - 1).padStart(3, '0')}`)).toBe(true);
    expect(kept.has(`${FCM}-000`)).toBe(false);
  });
});

describe('delivery re-checks the host', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeAll(async () => {
    ({ app, store } = await makeApp());
  });
  afterEach(() => {
    setPushEndpointLookup(null);
  });
  afterAll(async () => {
    await app.close();
  });

  it('skips a row that predates the constraint instead of POSTing to it', async () => {
    // Rows written before this guard existed are already in production
    // databases; the send path must refuse them without a migration.
    const { createNotifier } = await import('../src/modules/chat/notify');
    const account = await signupUser(app, 'push-legacy@example.com');
    const { deps } = await makeApp();
    await store.pushSubs.insertOne({
      id: 'legacy-row',
      userId: account.user.id,
      platform: 'web',
      endpoint: 'http://169.254.169.254/latest/meta-data/',
      keys: { p256dh: 'p', auth: 'a' },
      expoPushToken: null,
      createdAt: Date.now(),
    });

    const attempted: string[] = [];
    const notifier = createNotifier(
      { config: deps.config, store, log: deps.log },
      async (sub) => {
        attempted.push(sub.endpoint);
      },
    );
    await notifier.invite({
      roomId: 'room-legacy' as never,
      fromUserId: account.user.id,
      toUserId: account.user.id,
    });

    expect(attempted).toEqual([]);
  });
});
