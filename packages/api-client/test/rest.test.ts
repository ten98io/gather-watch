import { describe, expect, it, vi } from 'vitest';
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
});
