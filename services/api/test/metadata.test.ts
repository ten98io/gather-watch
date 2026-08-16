/**
 * POST /media/resolve over HTTP: the endpoint the paste-a-link preview calls
 * before anything is queued. Covers the auth gate, the wire shape (parsed
 * with the contracts schema, so the route and the client can never drift),
 * the MediaRef form, and the validation failures.
 *
 * The app's default resolver under NODE_ENV=test reads the link and stops
 * there — no test in this repo ever opens an outbound socket. Tests that need
 * resolved values register their own resolver on the app's Deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ResolveMediaResponse } from '@playin/contracts';
import type { Deps } from '../src/modules/types';
import { registerMetadataResolver } from '../src/modules/metadata/resolver';
import { makeApp, signupUser } from './helpers';

describe('POST /media/resolve', () => {
  let app: FastifyInstance;
  let deps: Deps;

  beforeEach(async () => {
    ({ app, deps } = await makeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  async function authHeaders(email = 'listener@example.com'): Promise<{ authorization: string }> {
    const account = await signupUser(app, email);
    return { authorization: `Bearer ${account.accessToken}` };
  }

  it('returns the resolved title, artwork, duration and provider for a link', async () => {
    registerMetadataResolver(deps, {
      resolve: async () => ({
        title: 'Rick Astley - Never Gonna Give You Up',
        artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        durationMs: 213_000,
        providerId: 'youtube',
        providerName: 'YouTube',
        authorName: 'Rick Astley',
        canonicalId: 'dQw4w9WgXcQ',
        canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        source: 'provider',
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/media/resolve',
      headers: await authHeaders(),
      payload: { url: 'https://youtu.be/dQw4w9WgXcQ' },
    });

    expect(res.statusCode).toBe(200);
    // Parsing with the contract proves the route matches what the client expects.
    const { media } = ResolveMediaResponse.parse(res.json());
    expect(media.title).toBe('Rick Astley - Never Gonna Give You Up');
    expect(media.artworkUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(media.durationMs).toBe(213_000);
    expect(media.providerId).toBe('youtube');
    expect(media.providerName).toBe('YouTube');
    expect(media.source).toBe('provider');
  });

  it('accepts a MediaRef instead of a link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/resolve',
      headers: await authHeaders(),
      payload: { mediaRef: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } },
    });

    expect(res.statusCode).toBe(200);
    const { media } = ResolveMediaResponse.parse(res.json());
    expect(media.providerId).toBe('youtube');
    expect(media.canonicalUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('classifies an ordinary link without pretending to know more', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/resolve',
      headers: await authHeaders(),
      payload: { url: 'https://news.example/story/1' },
    });

    expect(res.statusCode).toBe(200);
    const { media } = ResolveMediaResponse.parse(res.json());
    expect(media.providerId).toBe('link');
    expect(media.title).toBeNull();
    expect(media.source).toBe('link');
  });

  it('requires a signed-in caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/resolve',
      payload: { url: 'https://youtu.be/dQw4w9WgXcQ' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('rejects a body with neither a link nor a MediaRef', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/resolve',
      headers: await authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION');
  });

  it('rejects a link it cannot classify', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/resolve',
      headers: await authHeaders(),
      payload: { url: 'ftp://files.example/movie.mp4' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION');
  });
});
