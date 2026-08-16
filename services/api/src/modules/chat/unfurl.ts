/**
 * Open Graph unfurler for chat link previews: fetches a URL and extracts
 * og:* meta tags.
 *
 * All of the security — http/https only, per-hop re-validation of manual
 * redirects, the private-address guard, connect-time DNS pinning, the byte cap
 * and the single deadline — lives in lib/safe-fetch.ts and is SHARED with the
 * media metadata resolver, so there is exactly one guard to audit. The
 * primitives are re-exported here because this module has been the public
 * import site for them since before the resolver existed.
 *
 * All guard failures surface as AppError('VALIDATION'); the unfurler never
 * throws anything else on purpose.
 */
import type { UnfurlResponse } from '@gather/contracts';
import { createSafeFetcher } from '../../lib/safe-fetch';
import type { SafeFetchOptions } from '../../lib/safe-fetch';

export {
  createPinnedLookup,
  createPinningFetch,
  createSafeFetcher,
  isPrivateIp,
} from '../../lib/safe-fetch';
export type {
  LookupFn,
  PinnedLookup,
  ResolvedAddress,
  SafeFetcher,
  SafeFetchResult,
} from '../../lib/safe-fetch';

/** Unfurl knobs = the shared fetch guard's knobs (`allowPrivateAddresses`
 *  and `fetchImpl` are test-only; see lib/safe-fetch.ts). */
export type UnfurlerOptions = SafeFetchOptions;

export type Unfurler = (url: string) => Promise<UnfurlResponse>;

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

/** Absolute http(s) form of an og:image, resolved against the page URL. */
export function absoluteImageUrl(raw: string | null, base: URL): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const resolved = new URL(raw, base);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

export function createUnfurler(options: UnfurlerOptions = {}): Unfurler {
  const fetcher = createSafeFetcher({ label: 'unfurl', ...options });

  const allNull = (url: URL): UnfurlResponse => ({
    url: url.toString(),
    title: null,
    description: null,
    imageUrl: null,
    siteName: null,
  });

  return async (rawUrl: string): Promise<UnfurlResponse> => {
    const result = await fetcher.fetch(rawUrl, {
      accept: 'text/html,*/*;q=0.5',
      expectContentType: 'text/html',
    });
    if (!result.bodyRead) {
      return allNull(result.url);
    }
    const tags = parseOgTags(result.text);
    return {
      url: result.url.toString(),
      title: tags.title,
      description: tags.description,
      imageUrl: absoluteImageUrl(tags.imageUrl, result.url),
      siteName: tags.siteName,
    };
  };
}
