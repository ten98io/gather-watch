/**
 * Tests for the parts of the shared guard that the unfurler never exercised:
 * the fixed-host allowlist (initial hop AND redirects), the content-type
 * gate that stops the fetcher from downloading media bytes, and the byte cap.
 * The private-address/pinning coverage lives in modules/chat/unfurl.test.ts —
 * those tests now run against this same implementation.
 */
import { describe, expect, it } from 'vitest';
import { createSafeFetcher } from './safe-fetch';

/** A public address so the guard lets the (faked) fetch through. */
const PUBLIC_LOOKUP = async (): Promise<Array<{ address: string; family: number }>> => [
  { address: '93.184.216.34', family: 4 },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createSafeFetcher host allowlist', () => {
  it('refuses a host outside the allowlist WITHOUT opening a connection', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(input);
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const fetcher = createSafeFetcher({
      hostAllowlist: ['www.youtube.com'],
      fetchImpl,
      lookupImpl: PUBLIC_LOOKUP,
    });

    await expect(fetcher.fetch('https://evil.example/oembed')).rejects.toThrowError(
      /host is not allowed/,
    );
    expect(calls).toEqual([]);
  });

  it('re-checks the allowlist on every redirect hop', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(input);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/steal' },
        });
      }
      return jsonResponse({ title: 'should never be read' });
    }) as unknown as typeof fetch;
    const fetcher = createSafeFetcher({
      hostAllowlist: ['www.youtube.com'],
      fetchImpl,
      lookupImpl: PUBLIC_LOOKUP,
    });

    await expect(fetcher.fetch('https://www.youtube.com/oembed')).rejects.toThrowError(
      /host is not allowed/,
    );
    expect(calls).toHaveLength(1); // the redirect target was never dialled
  });

  it('holds even in the test-only allowPrivateAddresses mode', async () => {
    const fetcher = createSafeFetcher({
      hostAllowlist: ['www.youtube.com'],
      allowPrivateAddresses: true,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await expect(fetcher.fetch('http://127.0.0.1/oembed')).rejects.toThrowError(
      /host is not allowed/,
    );
  });

  it('allows an allowlisted host and returns the decoded body', async () => {
    const fetcher = createSafeFetcher({
      hostAllowlist: ['www.youtube.com'],
      fetchImpl: (async () => jsonResponse({ title: 'ok' })) as unknown as typeof fetch,
      lookupImpl: PUBLIC_LOOKUP,
    });
    const result = await fetcher.fetch('https://www.youtube.com/oembed?url=x');
    expect(result.bodyRead).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ title: 'ok' });
    expect(result.url.host).toBe('www.youtube.com');
  });
});

describe('createSafeFetcher body handling', () => {
  it('skips the body when the content-type is not what the caller expects', async () => {
    const fetchImpl = (async () =>
      new Response('binary-ish', {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })) as unknown as typeof fetch;
    const fetcher = createSafeFetcher({ fetchImpl, lookupImpl: PUBLIC_LOOKUP });

    const result = await fetcher.fetch('https://cdn.example/clip.mp4', {
      expectContentType: 'text/html',
    });
    expect(result.bodyRead).toBe(false);
    expect(result.text).toBe('');
  });

  it('truncates at maxBytes instead of buffering the whole response', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(10_000), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const fetcher = createSafeFetcher({ fetchImpl, lookupImpl: PUBLIC_LOOKUP, maxBytes: 100 });

    const result = await fetcher.fetch('https://page.example/');
    expect(result.text.length).toBe(100);
  });

  it('rejects non-http(s) schemes before anything else', async () => {
    const fetcher = createSafeFetcher({
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await expect(fetcher.fetch('file:///etc/passwd')).rejects.toThrowError(/http\/https/);
  });
});
