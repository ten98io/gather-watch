/**
 * Server-side media metadata resolver: given a pasted link or a MediaRef,
 * produce the real title, artwork, duration and provider so every surface
 * (queue rows, now-playing, history, room cards) can render actual content
 * instead of a grey box.
 *
 * Strategy, in order, per provider (see providers.ts):
 *   1. the service's keyless oEmbed endpoint (YouTube, Vimeo, SoundCloud,
 *      Spotify, Tidal, Deezer) — locked to a fixed host allowlist;
 *   2. the public page's Open Graph tags, via the SAME hardened fetcher the
 *      chat link-preview uses (Apple Music, DRM title pages, any other link),
 *      also used as the retry when oEmbed fails;
 *   3. nothing — the link itself is all we know (`source: 'link'`).
 *
 * SECURITY: every outbound request goes through lib/safe-fetch.ts — scheme
 * check, per-hop redirect re-validation, private-address guard, connect-time
 * DNS pinning, byte cap, deadline — plus, on the oEmbed path, a host
 * allowlist. Nothing here opens a socket by itself.
 *
 * `resolve` NEVER throws for a failed lookup: a provider being down must not
 * fail a queue add. It returns null only when the input is not a link we can
 * classify at all.
 */
import type { MediaRef, ResolvedMedia } from '@playin/contracts';
import { createSafeFetcher } from '../../lib/safe-fetch';
import type { LookupFn, SafeFetcher } from '../../lib/safe-fetch';
import { absoluteImageUrl, parseOgTags } from '../chat/unfurl';
import type { Deps } from '../types';
import { OEMBED_HOSTS, describeMediaRef, describeUrl, oembedRequestUrl } from './providers';
import type { ProviderDescriptor } from './providers';

export interface ResolveInput {
  mediaRef?: MediaRef | undefined;
  /** The original link. Used when there is no MediaRef (paste preview). */
  url?: string | undefined;
}

export interface MetadataResolver {
  resolve(input: ResolveInput): Promise<ResolvedMedia | null>;
}

export interface MetadataResolverOptions {
  fetchImpl?: typeof fetch; // tests only — bypasses DNS pinning
  lookupImpl?: LookupFn; // tests only
  allowPrivateAddresses?: boolean; // tests only
  timeoutMs?: number;
  /** Successful lookups live this long. Default 6h. */
  cacheTtlMs?: number;
  /** Lookups that produced nothing are retried sooner. Default 5min. */
  emptyCacheTtlMs?: number;
  /** Hard cap on cached entries (oldest evicted first). Default 500. */
  cacheMax?: number;
  now?: () => number;
}

const TITLE_MAX = 300;
const AUTHOR_MAX = 200;
const URL_MAX = 2048;
/** 24h — anything longer is a client typo or a hostile value, not a track. */
const DURATION_MAX_MS = 24 * 60 * 60 * 1000;

/** C0/C1 control characters plus the bidi/zero-width tricks used to disguise
 *  a title. Replaced with a space, then collapsed. Control characters in a
 *  character class are exactly the point here, hence the eslint exemption. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]+/g;

// ── value hygiene (shared with the queue's client-hint validation) ──────────

/** Trim, strip control characters, clamp to the contract's 300. */
export function sanitizeTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const cleaned = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) {
    return null;
  }
  return cleaned.slice(0, TITLE_MAX);
}

export function sanitizeAuthor(raw: string | null | undefined): string | null {
  const title = sanitizeTitle(raw);
  return title === null ? null : title.slice(0, AUTHOR_MAX);
}

/**
 * Artwork must be an https URL a browser will load without a mixed-content
 * warning. http, data:, javascript: and anything unparseable are dropped.
 */
export function sanitizeArtworkUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > URL_MAX) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Positive, finite, integer milliseconds within a sane range. */
export function sanitizeDurationMs(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  const ms = Math.round(raw);
  if (ms <= 0 || ms > DURATION_MAX_MS) {
    return null;
  }
  return ms;
}

// ── cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: ResolvedMedia;
  expiresAt: number;
}

/** Insertion-ordered Map used as a TTL cache with a hard size cap. */
class ResolutionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly max: number) {}

  get(key: string, now: number): ResolvedMedia | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return { ...entry.value };
  }

  set(key: string, value: ResolvedMedia, expiresAt: number): void {
    if (this.entries.size >= this.max && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value: { ...value }, expiresAt });
  }
}

// ── oEmbed ──────────────────────────────────────────────────────────────────

interface OEmbedPayload {
  title?: unknown;
  author_name?: unknown;
  thumbnail_url?: unknown;
  duration?: unknown;
  provider_name?: unknown;
}

function readOEmbed(json: unknown): OEmbedPayload | null {
  return typeof json === 'object' && json !== null ? (json as OEmbedPayload) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** oEmbed `duration` is whole seconds (Vimeo); other providers omit it. */
function durationFromOEmbed(value: unknown): number | null {
  if (typeof value === 'number') {
    return sanitizeDurationMs(value * 1000);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return sanitizeDurationMs(Number(value) * 1000);
  }
  return null;
}

// ── resolver ────────────────────────────────────────────────────────────────

function baseResult(descriptor: ProviderDescriptor): ResolvedMedia {
  return {
    title: sanitizeTitle(descriptor.fallbackTitle),
    artworkUrl: null,
    durationMs: null,
    providerId: descriptor.id,
    providerName: descriptor.name,
    authorName: null,
    canonicalId: descriptor.canonicalId,
    canonicalUrl: descriptor.pageUrl,
    source: 'link',
  };
}

export function createMetadataResolver(options: MetadataResolverOptions = {}): MetadataResolver {
  const now = options.now ?? Date.now;
  const ttlMs = options.cacheTtlMs ?? 6 * 60 * 60 * 1000;
  const emptyTtlMs = options.emptyCacheTtlMs ?? 5 * 60 * 1000;
  const cache = new ResolutionCache(options.cacheMax ?? 500);
  const shared = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.lookupImpl === undefined ? {} : { lookupImpl: options.lookupImpl }),
    ...(options.allowPrivateAddresses === undefined
      ? {}
      : { allowPrivateAddresses: options.allowPrivateAddresses }),
    timeoutMs: options.timeoutMs ?? 4000,
    userAgent: 'playin-metadata/1.0',
    label: 'metadata lookup',
  };

  // Two fetchers, deliberately: the oEmbed one is pinned to the fixed set of
  // provider endpoints; the page one may reach any PUBLIC host (same rules as
  // the chat link preview) because that is the whole point of a fallback.
  const oembedFetcher: SafeFetcher = createSafeFetcher({
    ...shared,
    hostAllowlist: OEMBED_HOSTS,
    maxBytes: 64 * 1024,
  });
  const pageFetcher: SafeFetcher = createSafeFetcher({ ...shared, maxBytes: 256 * 1024 });

  async function viaOEmbed(
    descriptor: ProviderDescriptor,
    result: ResolvedMedia,
  ): Promise<boolean> {
    const { oembed, pageUrl } = descriptor;
    if (oembed === null || pageUrl === null) {
      return false;
    }
    let payload: OEmbedPayload | null;
    try {
      const response = await oembedFetcher.fetch(oembedRequestUrl(oembed, pageUrl), {
        accept: 'application/json',
      });
      if (!response.bodyRead || response.text.length === 0) {
        return false;
      }
      payload = readOEmbed(JSON.parse(response.text));
    } catch {
      return false; // provider down, 404, or a guard refusal — fall back
    }
    if (payload === null) {
      return false;
    }
    const title = sanitizeTitle(asString(payload.title));
    const artworkUrl = sanitizeArtworkUrl(asString(payload.thumbnail_url));
    const durationMs = durationFromOEmbed(payload.duration);
    const authorName = sanitizeAuthor(asString(payload.author_name));
    const providerName = sanitizeTitle(asString(payload.provider_name));
    if (title === null && artworkUrl === null && durationMs === null) {
      return false;
    }
    result.title = title ?? result.title;
    result.artworkUrl = artworkUrl ?? result.artworkUrl;
    result.durationMs = durationMs ?? result.durationMs;
    result.authorName = authorName ?? result.authorName;
    if (descriptor.genericName && providerName !== null) {
      result.providerName = providerName.slice(0, 80);
    }
    result.source = 'provider';
    return true;
  }

  async function viaPage(descriptor: ProviderDescriptor, result: ResolvedMedia): Promise<void> {
    const { pageUrl } = descriptor;
    if (!descriptor.ogFallback || pageUrl === null) {
      return;
    }
    try {
      const response = await pageFetcher.fetch(pageUrl, {
        accept: 'text/html,*/*;q=0.5',
        expectContentType: 'text/html',
      });
      if (!response.bodyRead) {
        return;
      }
      const tags = parseOgTags(response.text);
      const title = sanitizeTitle(tags.title);
      const artworkUrl = sanitizeArtworkUrl(absoluteImageUrl(tags.imageUrl, response.url));
      const siteName = sanitizeTitle(tags.siteName);
      if (title === null && artworkUrl === null && siteName === null) {
        return;
      }
      result.title = title ?? result.title;
      result.artworkUrl = artworkUrl ?? result.artworkUrl;
      if (descriptor.genericName && siteName !== null) {
        result.providerName = siteName.slice(0, 80);
      }
      result.source = result.source === 'provider' ? 'provider' : 'page';
    } catch {
      // Nothing to add — the caller keeps whatever it already has.
    }
  }

  /** One lookup, cached on completion. Never throws. */
  async function lookup(
    descriptor: ProviderDescriptor,
    key: string,
  ): Promise<ResolvedMedia> {
    const result = baseResult(descriptor);
    const gotOEmbed = await viaOEmbed(descriptor, result);
    // The page is worth a look when oEmbed failed outright or left a hole in
    // the two fields every surface renders.
    if (!gotOEmbed || result.title === null || result.artworkUrl === null) {
      await viaPage(descriptor, result);
    }
    cache.set(key, result, now() + (result.source === 'link' ? emptyTtlMs : ttlMs));
    return result;
  }

  // Everyone pasting the same link at the same moment shares ONE lookup.
  const inflight = new Map<string, Promise<ResolvedMedia>>();

  return {
    async resolve(input: ResolveInput): Promise<ResolvedMedia | null> {
      const descriptor =
        input.mediaRef !== undefined
          ? describeMediaRef(input.mediaRef)
          : input.url !== undefined
            ? describeUrl(input.url)
            : null;
      if (descriptor === null) {
        return null;
      }

      const key = `${descriptor.id}|${descriptor.pageUrl ?? descriptor.canonicalId ?? ''}`;
      const cached = cache.get(key, now());
      if (cached !== null) {
        return cached;
      }
      const pending = inflight.get(key);
      if (pending !== undefined) {
        return { ...(await pending) };
      }

      const task = lookup(descriptor, key);
      inflight.set(key, task);
      try {
        return { ...(await task) };
      } finally {
        inflight.delete(key);
      }
    },
  };
}

// ── per-app wiring ──────────────────────────────────────────────────────────

/**
 * A resolver that reads the link and stops there — no sockets, ever. This is
 * the default under NODE_ENV=test so the suite is hermetic; tests that
 * exercise resolution register their own via registerMetadataResolver().
 */
export function createOfflineResolver(): MetadataResolver {
  return {
    async resolve(input: ResolveInput): Promise<ResolvedMedia | null> {
      const descriptor =
        input.mediaRef !== undefined
          ? describeMediaRef(input.mediaRef)
          : input.url !== undefined
            ? describeUrl(input.url)
            : null;
      return descriptor === null ? null : baseResult(descriptor);
    },
  };
}

// Keyed on the Deps object (one per app instance / test harness), so a
// registered resolver never leaks across instances and is GC'd with its deps.
const registered = new WeakMap<Deps, MetadataResolver>();
const defaults = new WeakMap<Deps, MetadataResolver>();

/** Override the resolver for this app instance (tests, or a future module
 *  that adds provider API keys). */
export function registerMetadataResolver(deps: Deps, resolver: MetadataResolver): void {
  registered.set(deps, resolver);
}

/** The registered resolver, else this app's lazily-built default. */
export function getMetadataResolver(deps: Deps): MetadataResolver {
  const override = registered.get(deps);
  if (override !== undefined) {
    return override;
  }
  let fallback = defaults.get(deps);
  if (fallback === undefined) {
    fallback =
      process.env['NODE_ENV'] === 'test' ? createOfflineResolver() : createMetadataResolver();
    defaults.set(deps, fallback);
  }
  return fallback;
}
