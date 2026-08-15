/**
 * SSRF-guarded Open Graph unfurler for chat link previews. Fetches a URL
 * (following redirects manually) and extracts og:* meta tags. EVERY hop —
 * the initial URL and each redirect target — is re-validated against the
 * private-address guard, so a public URL cannot redirect into the internal
 * network. All guard failures surface as AppError('VALIDATION'); the
 * unfurler never throws anything else on purpose.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { UnfurlResponse } from '@playin/contracts';
import { AppError } from '../../lib/errors';

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface UnfurlerOptions {
  allowPrivateAddresses?: boolean; // default false — ONLY tests set true
  timeoutMs?: number; // default 3000 (one deadline across all redirects)
  maxBytes?: number; // default 512 * 1024
  maxRedirects?: number; // default 3
  fetchImpl?: typeof fetch; // default globalThis.fetch
  lookupImpl?: LookupFn; // default node:dns/promises lookup(hostname, { all: true })
}

export type Unfurler = (url: string) => Promise<UnfurlResponse>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function privateAddressError(): AppError {
  return new AppError('VALIDATION', 'url resolves to a private address');
}

/**
 * True when `ip` is private/reserved — FAIL CLOSED: anything unparseable
 * counts as private. Covers IPv4 RFC1918/loopback/link-local/CGNAT/
 * documentation/multicast ranges plus IPv6 loopback, ULA, link-local,
 * v4-mapped (recursed on the v4 tail) and NAT64 prefixes.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const octets = ip.split('.').map((part) => Number(part));
    const a = octets[0];
    const b = octets[1];
    const c = octets[2];
    if (a === undefined || b === undefined || c === undefined) {
      return true;
    }
    if (a === 0 || a >= 224) return true;
    if (a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (isIP(lower) !== 6) {
    return true; // fail closed
  }
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    // v4-mapped — decide on the embedded v4 address.
    return isPrivateIp(lower.slice('::ffff:'.length));
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 can smuggle v4
  return false;
}

/** HTML-entity decoding for the handful OG tags actually contain. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|#39|#[0-9]+|#[xX][0-9a-fA-F]+);/g,
    (whole, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case '#39':
          return "'";
        default: {
          const code = entity.toLowerCase().startsWith('#x')
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
          try {
            return Number.isNaN(code) ? whole : String.fromCodePoint(code);
          } catch {
            return whole; // out-of-range code point — leave the entity as-is
          }
        }
      }
    },
  );
}

/** One attribute value out of a tag; quotes may be single or double. */
function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(tag);
  if (match === null) {
    return null;
  }
  return match[1] ?? match[2] ?? null;
}

/**
 * Extract og:title / og:description / og:image / og:site_name from raw HTML.
 * Attribute order inside a <meta> tag does not matter. Falls back to the
 * <title> element and <meta name="description"> when the og: variants are
 * absent. Entities in values are decoded.
 */
export function parseOgTags(html: string): {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
} {
  let title: string | null = null;
  let description: string | null = null;
  let imageUrl: string | null = null;
  let siteName: string | null = null;

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = attrValue(tag, 'property') ?? attrValue(tag, 'name');
    const content = attrValue(tag, 'content');
    if (property === null || content === null) {
      continue;
    }
    const value = decodeEntities(content);
    switch (property.toLowerCase()) {
      case 'og:title':
        title ??= value;
        break;
      case 'og:description':
        description ??= value;
        break;
      case 'og:image':
        imageUrl ??= value;
        break;
      case 'og:site_name':
        siteName ??= value;
        break;
      case 'description':
        description ??= value;
        break;
    }
  }

  if (title === null) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const text = match?.[1];
    if (text !== undefined) {
      title = decodeEntities(text.trim());
    }
  }

  return { title, description, imageUrl, siteName };
}

export function createUnfurler(options: UnfurlerOptions = {}): Unfurler {
  const allowPrivate = options.allowPrivateAddresses ?? false;
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const lookupImpl: LookupFn =
    options.lookupImpl ?? (async (hostname) => dnsLookup(hostname, { all: true }));

  /** Validate one hop: scheme, localhost, and private-address checks. */
  const guard = async (raw: string): Promise<URL> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError('VALIDATION', 'only http/https urls can be unfurled');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('VALIDATION', 'only http/https urls can be unfurled');
    }
    if (allowPrivate) {
      return url;
    }
    let hostname = url.hostname;
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1); // IPv6 literal brackets
    }
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw privateAddressError();
    }
    if (isIP(hostname) !== 0) {
      if (isPrivateIp(hostname)) {
        throw privateAddressError();
      }
      return url;
    }
    let addresses: ResolvedAddress[];
    try {
      addresses = await lookupImpl(hostname);
    } catch {
      throw new AppError('VALIDATION', 'could not resolve host');
    }
    if (addresses.length === 0) {
      throw new AppError('VALIDATION', 'could not resolve host');
    }
    for (const address of addresses) {
      if (isPrivateIp(address.address)) {
        throw privateAddressError();
      }
    }
    return url;
  };

  const allNull = (url: URL): UnfurlResponse => ({
    url: url.toString(),
    title: null,
    description: null,
    imageUrl: null,
    siteName: null,
  });

  return async (rawUrl: string): Promise<UnfurlResponse> => {
    // One deadline across the whole operation (all redirect hops).
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref();

    try {
      let current = rawUrl;
      for (let hops = 0; ; hops += 1) {
        const url = await guard(current);

        let response: Response;
        try {
          response = await fetchImpl(url.toString(), {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': 'playin-unfurl/1.0', accept: 'text/html,*/*;q=0.5' },
          });
        } catch (_err) {
          if (controller.signal.aborted) {
            throw new AppError('VALIDATION', 'unfurl timed out');
          }
          throw new AppError('VALIDATION', 'unfurl failed');
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (location !== null) {
            if (hops + 1 > maxRedirects) {
              throw new AppError('VALIDATION', 'too many redirects');
            }
            await response.body?.cancel().catch(() => {});
            try {
              current = new URL(location, url).toString();
            } catch {
              throw new AppError('VALIDATION', 'unfurl failed');
            }
            continue; // the guard re-validates the redirect target
          }
        }

        if (response.status < 200 || response.status >= 300) {
          throw new AppError('VALIDATION', `unfurl target returned ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        if (contentType !== null && !contentType.includes('text/html')) {
          await response.body?.cancel().catch(() => {});
          return allNull(url);
        }

        if (response.body === null) {
          return allNull(url);
        }

        // Read at most maxBytes, then cancel and parse the truncated buffer —
        // a huge page still unfurls from its first chunk.
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
              ({ done, value } = await reader.read());
            } catch (_err) {
              if (controller.signal.aborted) {
                throw new AppError('VALIDATION', 'unfurl timed out');
              }
              throw new AppError('VALIDATION', 'unfurl failed');
            }
            if (done) {
              break;
            }
            if (value !== undefined) {
              chunks.push(value);
              total += value.byteLength;
              if (total >= maxBytes) {
                await reader.cancel().catch(() => {});
                break;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        const bytes = new Uint8Array(Math.min(total, maxBytes));
        let offset = 0;
        for (const chunk of chunks) {
          const slice = chunk.subarray(
            0,
            Math.min(chunk.byteLength, bytes.byteLength - offset),
          );
          bytes.set(slice, offset);
          offset += slice.byteLength;
        }
        const html = new TextDecoder().decode(bytes);

        const tags = parseOgTags(html);
        let imageUrl: string | null = null;
        if (tags.imageUrl !== null) {
          try {
            const resolved = new URL(tags.imageUrl, url);
            if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
              imageUrl = resolved.toString();
            }
          } catch {
            imageUrl = null;
          }
        }

        return {
          url: url.toString(),
          title: tags.title,
          description: tags.description,
          imageUrl,
          siteName: tags.siteName,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
