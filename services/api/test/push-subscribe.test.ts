/**
 * The missing server half of web push (E13).
 *
 * `store.pushSubs` was only ever READ (chat/notify.ts) and DELETED
 * (notify.ts pruning, compliance/erasure.ts). NOTHING wrote a row, because the
 * API registered exactly one push path — `/push/room-mute`. Meanwhile
 * @gather/api-client already called `POST /push/subscribe` and
 * `POST /push/unsubscribe`, and contracts already defined both bodies: a
 * perfect mirror-image gap. `notifier.mention()` therefore fanned out to an
 * empty list on every @mention, with valid VAPID keys configured.
 *
 * The load-bearing test is the last one: a mention with a stored subscription
 * must actually ATTEMPT a push. Everything else can pass while the feature is
 * still dead.
 *
 * Endpoints here are real FCM-shaped URLs because src/modules/push/endpoint.ts
 * only accepts real push services (see push-endpoint-ssrf.test.ts for why);
 * DNS for them is pinned so this suite never touches the network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PushSubscribeBody, UserId } from '@gather/contracts';
import { modules } from '../src/modules/index';
import { ChatService } from '../src/modules/chat/service';
import { createNotifier } from '../src/modules/chat/notify';
import { memberDocId } from '../src/adapters/ports';
import type { StorePort } from '../src/adapters/ports';
import type { AuthContext, Deps } from '../src/modules/types';
import { setPushEndpointLookup } from '../src/modules/push/endpoint';
import { addMember, makeApp, seedRoom, signupUser, testConfig } from './helpers';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

/** Every allowed host resolves to a public address; nothing here dials out. */
const PINNED_LOOKUP = async (): Promise<Array<{ address: string; family: number }>> => [
  { address: '142.250.185.106', family: 4 },
];

function subscribeBody(endpoint = ENDPOINT): PushSubscribeBody {
  return {
    platform: 'web',
    endpoint,
    keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret' },
  };
}

/** An account auth context for direct service calls. */
function authOf(userId: UserId): AuthContext {
  return { userId, sessionId: 'sess_test', guest: false, guestRoomId: null };
}

describe('push subscription routes', () => {
  let app: FastifyInstance;
  let store: StorePort;

  beforeAll(async () => {
    setPushEndpointLookup(PINNED_LOOKUP);
    ({ app, store } = await makeApp(
      testConfig({
        vapid: {
          publicKey: 'BPublicKeyForTests',
          privateKey: 'private-key-for-tests',
          subject: 'mailto:test@gather.local',
        },
      }),
    ));
  });
  afterAll(async () => {
    setPushEndpointLookup(null);
    await app.close();
  });

  it('is present in the module registry', () => {
    expect(modules.map((m) => m.name)).toContain('push');
  });

  it('stores a row on subscribe and removes it on unsubscribe', async () => {
    const account = await signupUser(app, 'push-roundtrip@example.com');
    const headers = { authorization: `Bearer ${account.accessToken}` };

    const sub = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers,
      payload: subscribeBody(),
    });
    expect(sub.statusCode).toBe(200);

    const rows = await store.pushSubs.findMany({ userId: account.user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(ENDPOINT);
    expect(rows[0]?.platform).toBe('web');
    expect(rows[0]?.keys).toEqual({ p256dh: 'p256dh-key-material', auth: 'auth-secret' });

    const unsub = await app.inject({
      method: 'POST',
      url: '/push/unsubscribe',
      headers,
      payload: { platform: 'web', endpoint: ENDPOINT },
    });
    expect(unsub.statusCode).toBe(200);
    expect(await store.pushSubs.findMany({ userId: account.user.id })).toEqual([]);
  });

  it('refuses an unauthenticated caller', async () => {
    const sub = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      payload: subscribeBody('https://fcm.googleapis.com/fcm/send/anon'),
    });
    expect(sub.statusCode).toBe(401);

    const unsub = await app.inject({
      method: 'POST',
      url: '/push/unsubscribe',
      payload: { platform: 'web', endpoint: 'https://fcm.googleapis.com/fcm/send/anon' },
    });
    expect(unsub.statusCode).toBe(401);

    expect(await store.pushSubs.findMany({ endpoint: 'https://fcm.googleapis.com/fcm/send/anon' })).toEqual(
      [],
    );
  });

  it('re-subscribing the same browser reuses the row instead of duplicating it', async () => {
    const account = await signupUser(app, 'push-resub@example.com');
    const headers = { authorization: `Bearer ${account.accessToken}` };
    const endpoint = 'https://fcm.googleapis.com/fcm/send/resub';

    await app.inject({ method: 'POST', url: '/push/subscribe', headers, payload: subscribeBody(endpoint) });
    const again = await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers,
      payload: {
        platform: 'web',
        endpoint,
        keys: { p256dh: 'rotated-p256dh', auth: 'rotated-auth' },
      },
    });
    expect(again.statusCode).toBe(200);

    const rows = await store.pushSubs.findMany({ endpoint });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keys).toEqual({ p256dh: 'rotated-p256dh', auth: 'rotated-auth' });
  });

  it('moves a shared browser endpoint to whoever is signed in now', async () => {
    const first = await signupUser(app, 'push-handover-a@example.com');
    const second = await signupUser(app, 'push-handover-b@example.com');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/shared-browser';

    await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { authorization: `Bearer ${first.accessToken}` },
      payload: subscribeBody(endpoint),
    });
    await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { authorization: `Bearer ${second.accessToken}` },
      payload: subscribeBody(endpoint),
    });

    const rows = await store.pushSubs.findMany({ endpoint });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(second.user.id);
    expect(await store.pushSubs.findMany({ userId: first.user.id })).toEqual([]);
  });

  it('will not unsubscribe an endpoint another account owns', async () => {
    const owner = await signupUser(app, 'push-owner@example.com');
    const other = await signupUser(app, 'push-other@example.com');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/not-yours';

    await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: subscribeBody(endpoint),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/push/unsubscribe',
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { platform: 'web', endpoint },
    });

    expect(res.statusCode).toBe(200);
    expect(await store.pushSubs.findMany({ endpoint })).toHaveLength(1);
  });

  it('hands the browser the VAPID public key it needs to subscribe', async () => {
    const account = await signupUser(app, 'push-key@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/push/public-key',
      headers: { authorization: `Bearer ${account.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: 'BPublicKeyForTests' });
  });
});

describe('mention push after subscribing', () => {
  let app: FastifyInstance;
  let deps: Deps;
  let store: StorePort;

  beforeAll(async () => {
    setPushEndpointLookup(PINNED_LOOKUP);
    ({ app, deps, store } = await makeApp(
      testConfig({
        vapid: {
          publicKey: 'BPublicKeyForTests',
          privateKey: 'private-key-for-tests',
          subject: 'mailto:test@gather.local',
        },
      }),
    ));
  });
  afterAll(async () => {
    setPushEndpointLookup(null);
    await app.close();
  });

  /** Room with an author and a mention target who has a stored subscription. */
  async function scenario(email: string, endpoint: string) {
    const target = await signupUser(app, email);
    const seeded = await seedRoom(store);
    await addMember(store, seeded.roomId, target.user.id, 'member');
    await app.inject({
      method: 'POST',
      url: '/push/subscribe',
      headers: { authorization: `Bearer ${target.accessToken}` },
      payload: subscribeBody(endpoint),
    });
    return { target, roomId: seeded.roomId, authorId: seeded.ownerId };
  }

  it('actually attempts a push to the subscription the route stored', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/mention-target';
    const { target, roomId, authorId } = await scenario('push-mention@example.com', endpoint);

    const sent: Array<{ endpoint: string; payload: string }> = [];
    const chat = new ChatService(
      deps,
      createNotifier(deps, async (sub, payload) => {
        sent.push({ endpoint: sub.endpoint, payload });
      }),
    );

    await chat.send(roomId, authOf(authorId), {
      kind: 'text',
      body: `hey <@${target.user.id}> the film is starting`,
      gifUrl: null,
      attachment: null,
      replyTo: null,
      mentions: [target.user.id],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.endpoint).toBe(endpoint);
    const payload = JSON.parse(sent[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['kind']).toBe('mention');
    expect(payload['roomId']).toBe(roomId);
    expect(payload['preview']).toContain('the film is starting');
  });

  it('stays silent for a room the target has muted', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/muted-target';
    const { target, roomId, authorId } = await scenario('push-muted@example.com', endpoint);
    await store.members.updateOne(
      { id: memberDocId(roomId, target.user.id) },
      { muted: true },
    );

    const sent: string[] = [];
    const chat = new ChatService(
      deps,
      createNotifier(deps, async (sub) => {
        sent.push(sub.endpoint);
      }),
    );

    await chat.send(roomId, authOf(authorId), {
      kind: 'text',
      body: `<@${target.user.id}> ignore me`,
      gifUrl: null,
      attachment: null,
      replyTo: null,
      mentions: [target.user.id],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toEqual([]);
  });
});
