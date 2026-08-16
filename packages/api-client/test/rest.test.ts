import { describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@gather/contracts';
import { ApiError, RestClient } from '../src';
import type { FetchResponseLike } from '../src';
import { FetchMock, demoUser, jsonResponse, rid, tick } from './helpers';

describe('RestClient', () => {
  it('parses a valid response and sends auth header', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.includes('/auth/me') && init?.method === 'GET'
        ? jsonResponse(200, { user: demoUser('u1') })
        : null,
    );
    const client = new RestClient('http://api.test', {
      fetchImpl: fetch.impl,
      getAccessToken: () => 'tok-1',
    });
    const res = await client.auth.me();
    expect(res.user.id).toBe('u1');
    expect(fetch.calls[0]!.init?.headers?.['authorization']).toBe('Bearer tok-1');
    expect(fetch.calls[0]!.init?.credentials).toBe('include');
  });

  it('throws ApiError with server-provided code', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.includes('/rooms') && init?.method === 'POST'
        ? jsonResponse(403, { code: 'FORBIDDEN', message: 'nope' })
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    expect.assertions(3);
    try {
      await client.rooms.createRoom({ kind: 'watch', name: 'x' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('FORBIDDEN');
      expect((err as ApiError).status).toBe(403);
    }
  });

  it('throws VALIDATION when the response fails schema parse', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url) =>
      url.includes('/auth/me') ? jsonResponse(200, { user: { id: 'u1' } }) : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const p = client.auth.me();
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('single-flight refresh: two concurrent 401s cause exactly one refresh then both retry', async () => {
    const fetch = new FetchMock();
    let refreshed = false;
    let releaseRefresh: (() => void) | null = null;
    fetch.handlers.push((url, init) => {
      if (url.includes('/auth/refresh') && init?.method === 'POST') {
        return new Promise<FetchResponseLike>((resolve) => {
          releaseRefresh = () => {
            refreshed = true;
            resolve(jsonResponse(200, { user: demoUser('u1') }));
          };
        });
      }
      if (url.includes('/auth/me') && init?.method === 'GET') {
        return refreshed
          ? jsonResponse(200, { user: demoUser('u1') })
          : jsonResponse(401, { code: 'UNAUTHORIZED', message: 'expired' });
      }
      return null;
    });
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const p1 = client.auth.me();
    const p2 = client.auth.me();
    await tick();
    await tick();
    expect(releaseRefresh).not.toBeNull();
    expect(fetch.count('/auth/refresh', 'POST')).toBe(1);
    releaseRefresh!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.user.id).toBe('u1');
    expect(r2.user.id).toBe('u1');
    expect(fetch.count('/auth/refresh', 'POST')).toBe(1);
    expect(fetch.count('/auth/me', 'GET')).toBe(4);
  });

  it('failed refresh fires onAuthExpired once and rejects with the original 401', async () => {
    const fetch = new FetchMock();
    const onAuthExpired = vi.fn();
    fetch.handlers.push((url) => {
      if (url.includes('/auth/refresh')) {
        return jsonResponse(401, { code: 'UNAUTHORIZED', message: 'no' });
      }
      if (url.includes('/auth/me')) {
        return jsonResponse(401, { code: 'UNAUTHORIZED', message: 'expired' });
      }
      return null;
    });
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl, onAuthExpired });
    const p = client.auth.me();
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(fetch.count('/auth/refresh', 'POST')).toBe(1);
    expect(fetch.count('/auth/me', 'GET')).toBe(1);
  });

  it('auth-exempt endpoints never trigger refresh', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url) =>
      url.includes('/auth/verify')
        ? jsonResponse(401, { code: 'UNAUTHORIZED', message: 'expired' })
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const p = client.auth.verifyToken({ token: 't' });
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(fetch.count('/auth/refresh')).toBe(0);
  });

  it('builds query strings and encodes path params', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push(() => jsonResponse(200, { items: [], nextCursor: null }));
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    await client.messages.listMessages(rid('r one'), { beforeSeq: 7, limit: 10 });
    expect(fetch.calls[0]!.url).toBe(
      'http://api.test/rooms/r%20one/messages?beforeSeq=7&limit=10',
    );
  });

  it('posts livekit.token to the route the API registers', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push(() => jsonResponse(200, { url: 'wss://lk.test', token: 'jwt' }));
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const res = await client.livekit.token({ roomId: rid('r1') });
    expect(res.token).toBe('jwt');
    expect(fetch.calls[0]!.url).toBe('http://api.test/rtc/livekit-token');
    expect(fetch.calls[0]!.init?.method).toBe('POST');
  });
});

describe('RestClient session + rtc endpoints', () => {
  it('logout posts /auth/logout', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.includes('/auth/logout') && init?.method === 'POST'
        ? jsonResponse(200, { ok: true })
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const res = await client.auth.logout();
    expect(res).toEqual({ ok: true });
    expect(fetch.count('/auth/logout', 'POST')).toBe(1);
  });

  it('listSessions gets /auth/sessions and parses the device list', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.endsWith('/auth/sessions') && init?.method === 'GET'
        ? jsonResponse(200, {
            sessions: [
              { id: 's1', device: 'Safari on macOS', createdAt: 1, lastSeenAt: 2, current: true },
            ],
          })
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const res = await client.auth.listSessions();
    expect(res.sessions[0]!.id).toBe('s1');
    expect(fetch.calls[0]!.init?.method).toBe('GET');
  });

  it('revokeSession DELETEs /auth/sessions/:id with the id URL-encoded', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url) =>
      url.includes('/auth/sessions/') ? jsonResponse(200, { ok: true }) : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    await client.auth.revokeSession('s 1' as SessionId);
    expect(fetch.calls[0]!.url).toBe('http://api.test/auth/sessions/s%201');
    expect(fetch.calls[0]!.init?.method).toBe('DELETE');
  });

  it('revokeAllSessions posts and returns the revoked count', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.includes('/auth/sessions/revoke-all') && init?.method === 'POST'
        ? jsonResponse(200, { revoked: 2 })
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const res = await client.auth.revokeAllSessions();
    expect(res.revoked).toBe(2);
    expect(fetch.calls[0]!.url).toBe('http://api.test/auth/sessions/revoke-all');
    expect(fetch.calls[0]!.init?.method).toBe('POST');
  });

  it('upgradeGuest posts the email body to /auth/upgrade', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.includes('/auth/upgrade') && init?.method === 'POST'
        ? jsonResponse(200, { ok: true })
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    await client.auth.upgradeGuest({ email: 'g@example.com' });
    expect(JSON.parse(fetch.calls[0]!.init!.body as string)).toEqual({
      email: 'g@example.com',
    });
  });

  it('turnCredentials gets /rtc/turn-credentials and validates the schema', async () => {
    const payload = {
      iceServers: [
        { urls: ['turn:relay.test:3478?transport=udp'], username: 'u', credential: 'c' },
      ],
      ttlSeconds: 21600,
      fairUseRemainingGb: 4.2,
    };
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.includes('/rtc/turn-credentials') && init?.method === 'GET'
        ? jsonResponse(200, payload)
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const res = await client.rtc.turnCredentials();
    expect(res).toEqual(payload);
    expect(fetch.calls[0]!.init?.method).toBe('GET');
  });

  it('turnCredentials rejects an invalid payload with VALIDATION', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url) =>
      url.includes('/rtc/turn-credentials') ? jsonResponse(200, { iceServers: 'nope' }) : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const p = client.rtc.turnCredentials();
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('verifyToken surfaces typed accessToken fields', async () => {
    const fetch = new FetchMock();
    fetch.handlers.push((url, init) =>
      url.includes('/auth/verify') && init?.method === 'POST'
        ? jsonResponse(200, { user: demoUser('u1'), accessToken: 'jwt-a', accessTokenExpiresAt: 123 })
        : null,
    );
    const client = new RestClient('http://api.test', { fetchImpl: fetch.impl });
    const res = await client.auth.verifyToken({ token: 't' });
    expect(res.accessToken).toBe('jwt-a');
    expect(res.accessTokenExpiresAt).toBe(123);
  });
});
