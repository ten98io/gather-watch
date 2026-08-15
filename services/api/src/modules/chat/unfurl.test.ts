/**
 * Unfurler security tests: private-address guard coverage, redirect
 * re-guarding, and — the part a naive guard misses — connect-time address
 * pinning, which is what actually defeats DNS rebinding (an attacker DNS
 * server answering public-to-the-check and private-to-the-connect).
 * The pinning tests run fully offline against a 127.0.0.1 http server.
 */
import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPinnedLookup,
  createPinningFetch,
  createUnfurler,
  isPrivateIp,
  parseOgTags,
} from './unfurl';
import type { ResolvedAddress } from './unfurl';

function htmlResponse(title: string): Response {
  return new Response(`<html><meta property="og:title" content="${title}"></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

describe('isPrivateIp', () => {
  it.each([
    '127.0.0.1',
    '169.254.169.254', // cloud metadata
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '100.64.0.1', // CGNAT
    '::1',
    'fd00::1', // ULA
    'fe80::1', // link-local
    '::ffff:127.0.0.1', // v4-mapped
    '64:ff9b::7f00:1', // NAT64
    'not-an-ip', // unparseable fails closed
  ])('treats %s as private', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111'])('treats %s as public', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('createUnfurler guard', () => {
  const staticFetch = (async () => htmlResponse('x')) as unknown as typeof fetch;

  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://localhost/',
    'file:///etc/passwd',
  ])('rejects %s', async (url) => {
    const unfurl = createUnfurler({ fetchImpl: staticFetch });
    await expect(unfurl(url)).rejects.toThrowError(/private address|http\/https|resolve/);
  });

  it('re-guards every redirect hop (public -> private is rejected)', async () => {
    let hop = 0;
    const redirectingFetch = (async () => {
      hop += 1;
      if (hop === 1) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
      }
      return htmlResponse('internal');
    }) as unknown as typeof fetch;
    const unfurl = createUnfurler({
      fetchImpl: redirectingFetch,
      lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    });
    await expect(unfurl('https://public.example/')).rejects.toThrowError(/private address/);
  });
});

describe('createPinnedLookup (DNS-rebinding defence)', () => {
  const pinned = new Map<string, readonly ResolvedAddress[]>([
    ['pinned.example', [{ address: '203.0.113.7', family: 4 }, { address: '2001:db8::7', family: 6 }]],
  ]);
  const lookup = createPinnedLookup(pinned);

  it('returns only the vetted address for a pinned host', async () => {
    const result = await new Promise<{
      address?: unknown;
      family?: number | undefined;
    }>((resolve, reject) => {
      lookup('pinned.example', {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
    expect(result.address).toBe('203.0.113.7');
    expect(result.family).toBe(4);
  });

  it('supports the all:true callback shape', async () => {
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup('PINNED.example', { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses);
      });
    });
    expect(result).toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '2001:db8::7', family: 6 },
    ]);
  });

  it('filters by requested family', async () => {
    const result = await new Promise<{ address?: unknown }>((resolve, reject) => {
      lookup('pinned.example', { family: 6 }, (err, address) => {
        if (err) reject(err);
        else resolve({ address });
      });
    });
    expect(result.address).toBe('2001:db8::7');
  });

  it('FAILS CLOSED for any host without a vetted entry — never re-resolves', async () => {
    await expect(
      new Promise((resolve, reject) => {
        lookup('rebinder.example', {}, (err, address) => {
          if (err) reject(err);
          else resolve(address);
        });
      }),
    ).rejects.toThrowError(/no vetted address/);
  });
});

describe('createPinningFetch', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><meta property="og:title" content="pinned:${req.headers.host ?? ''}"></html>`);
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('dials the PINNED address for the hostname, not DNS', async () => {
    // pinned.invalid does not resolve anywhere; only the pin can connect it.
    const pinned = new Map<string, readonly ResolvedAddress[]>([
      ['pinned.invalid', [{ address: '127.0.0.1', family: 4 }]],
    ]);
    const pinningFetch = createPinningFetch(pinned);
    const response = await pinningFetch(`http://pinned.invalid:${port}/`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`pinned:pinned.invalid:${port}`);
  });

  it('refuses to connect any un-pinned hostname (fail closed)', async () => {
    const pinningFetch = createPinningFetch(new Map());
    await expect(pinningFetch(`http://unpinned.invalid:${port}/`)).rejects.toThrowError();
  });
});

describe('parseOgTags', () => {
  it('extracts og tags regardless of attribute order and decodes entities', () => {
    const html = [
      '<meta content="A &amp; B" property="og:title">',
      "<meta property='og:description' content='desc'>",
      '<meta property="og:image" content="/img.png">',
    ].join('');
    const tags = parseOgTags(html);
    expect(tags.title).toBe('A & B');
    expect(tags.description).toBe('desc');
    expect(tags.imageUrl).toBe('/img.png');
  });

  it('falls back to the <title> element', () => {
    expect(parseOgTags('<title>Fallback</title>').title).toBe('Fallback');
  });
});
