/**
 * Which service a link or MediaRef belongs to, and how its metadata can be
 * read. Purely syntactic — no network here.
 *
 * Two lookup strategies come out of this table:
 *   • `oembed` — the service publishes a keyless oEmbed endpoint. The endpoint
 *     is FIXED per provider and never derived from user input, and the set of
 *     endpoint hosts (OEMBED_HOSTS) is the allowlist the metadata fetcher is
 *     locked to.
 *   • `ogFallback` — fetch the public page and read its Open Graph tags. Used
 *     when there is no oEmbed endpoint (Apple Music, DRM services, ordinary
 *     links) and as the second chance when an oEmbed call fails.
 *
 * Provider ids mirror apps/web/lib/providers.ts so a client can map id → icon.
 */
import type { MediaRef } from '@gather/contracts';

export interface OEmbedEndpoint {
  /** Absolute endpoint URL; the item URL is added as the `url` query param. */
  endpoint: string;
  /** Endpoint hostname — must be in OEMBED_HOSTS. */
  host: string;
}

export interface ProviderDescriptor {
  /** Stable provider key ('youtube', 'spotify', 'stream', 'link'…). */
  id: string;
  /** Display name ('YouTube', 'Apple Music', or a bare hostname). */
  name: string;
  /** Public page for the item — the oEmbed subject and OG fetch target. */
  pageUrl: string | null;
  /** Provider-native id when the link carries one. */
  canonicalId: string | null;
  oembed: OEmbedEndpoint | null;
  /** Read the page's OG tags (false for raw media bytes and stream manifests). */
  ogFallback: boolean;
  /** Title derived from the link itself — used only when nothing was fetched. */
  fallbackTitle: string | null;
  /** True when `name` is a bare hostname that og:site_name may improve on. */
  genericName: boolean;
}

/** Keyless oEmbed endpoints. Apple Music has none — it falls back to OG. */
const OEMBED = {
  youtube: { endpoint: 'https://www.youtube.com/oembed', host: 'www.youtube.com' },
  vimeo: { endpoint: 'https://vimeo.com/api/oembed.json', host: 'vimeo.com' },
  soundcloud: { endpoint: 'https://soundcloud.com/oembed', host: 'soundcloud.com' },
  spotify: { endpoint: 'https://open.spotify.com/oembed', host: 'open.spotify.com' },
  deezer: { endpoint: 'https://api.deezer.com/oembed', host: 'api.deezer.com' },
  tidal: { endpoint: 'https://oembed.tidal.com/', host: 'oembed.tidal.com' },
} as const satisfies Record<string, OEmbedEndpoint>;

/** The ONLY hosts the oEmbed fetcher may reach, on any redirect hop. */
export const OEMBED_HOSTS: readonly string[] = Object.values(OEMBED).map((e) => e.host);

/** Recognised DRM services: no embed exists, but their public title pages do
 *  carry posters, which is all we want from them. */
const DRM: Record<string, { id: string; name: string }> = {
  'netflix.com': { id: 'netflix', name: 'Netflix' },
  'primevideo.com': { id: 'primevideo', name: 'Prime Video' },
  'disneyplus.com': { id: 'disneyplus', name: 'Disney+' },
  'max.com': { id: 'max', name: 'Max' },
  'hulu.com': { id: 'hulu', name: 'Hulu' },
  'paramountplus.com': { id: 'paramountplus', name: 'Paramount+' },
  'peacocktv.com': { id: 'peacock', name: 'Peacock' },
  'crunchyroll.com': { id: 'crunchyroll', name: 'Crunchyroll' },
};

const MEDIA_EXTENSIONS = ['.m3u8', '.mp3', '.m4a', '.aac', '.webm', '.mp4', '.mov', '.ogg'];

function baseHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}

/** Last path segment, percent-decoded — the only title a direct link has. */
function filenameOf(url: URL): string | null {
  const segment = url.pathname
    .split('/')
    .filter((part) => part.length > 0)
    .pop();
  if (segment === undefined) {
    return null;
  }
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // malformed escape — keep the raw segment
  }
  const trimmed = decoded.trim();
  return trimmed.length === 0 ? null : trimmed;
}

type DescriptorSeed = Partial<ProviderDescriptor> & { id: string; name: string };

function descriptor(seed: DescriptorSeed): ProviderDescriptor {
  return {
    pageUrl: null,
    canonicalId: null,
    oembed: null,
    ogFallback: false,
    fallbackTitle: null,
    genericName: false,
    ...seed,
  };
}

/**
 * Classify a raw link. Returns null for anything that is not an http(s) URL,
 * or a provider URL that carries no item id — callers surface that as a
 * validation error.
 */
export function describeUrl(raw: string): ProviderDescriptor | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  const host = baseHost(url.hostname);
  const href = url.toString();

  // YouTube + YouTube Music share one video id space.
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const match =
      /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|music\/)|youtu\.be\/)([\w-]{6,})/.exec(
        href,
      ) ?? /[?&]v=([\w-]{6,})/.exec(href);
    const videoId = match?.[1];
    if (videoId === undefined) {
      return null;
    }
    const music = url.hostname.toLowerCase().startsWith('music.');
    return descriptor({
      id: music ? 'youtubemusic' : 'youtube',
      name: music ? 'YouTube Music' : 'YouTube',
      pageUrl: `https://www.youtube.com/watch?v=${videoId}`,
      canonicalId: videoId,
      oembed: OEMBED.youtube,
      ogFallback: true,
    });
  }

  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    return descriptor({
      id: 'soundcloud',
      name: 'SoundCloud',
      pageUrl: href,
      oembed: OEMBED.soundcloud,
      ogFallback: true,
    });
  }

  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    const videoId = /vimeo\.com\/(?:video\/)?(\d{6,})/.exec(href)?.[1];
    if (videoId === undefined) {
      return null;
    }
    return descriptor({
      id: 'vimeo',
      name: 'Vimeo',
      pageUrl: `https://vimeo.com/${videoId}`,
      canonicalId: videoId,
      oembed: OEMBED.vimeo,
      ogFallback: true,
    });
  }

  if (host === 'open.spotify.com' || host === 'spotify.com') {
    const match =
      /spotify\.com\/(?:embed\/)?(?:intl-[\w-]+\/)?(track|album|playlist|episode|show)\/(\w+)/.exec(
        href,
      );
    const kind = match?.[1];
    const id = match?.[2];
    if (kind === undefined || id === undefined) {
      return null;
    }
    return descriptor({
      id: 'spotify',
      name: 'Spotify',
      pageUrl: `https://open.spotify.com/${kind}/${id}`,
      canonicalId: `${kind}/${id}`,
      oembed: OEMBED.spotify,
      ogFallback: true,
    });
  }

  // Apple Music publishes no oEmbed endpoint; its pages carry full OG tags.
  if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
    const path = url.pathname.replace(/^\/+/, '');
    return descriptor({
      id: 'applemusic',
      name: 'Apple Music',
      pageUrl: `https://music.apple.com${url.pathname}${url.search}`,
      canonicalId: path === '' ? null : path,
      ogFallback: true,
    });
  }

  if (host === 'tidal.com' || host.endsWith('.tidal.com')) {
    const match = /tidal\.com\/(?:browse\/)?(track|album|playlist|video)s?\/([\w-]+)/.exec(href);
    const kind = match?.[1];
    const id = match?.[2];
    if (kind === undefined || id === undefined) {
      return null;
    }
    return descriptor({
      id: 'tidal',
      name: 'Tidal',
      pageUrl: `https://tidal.com/browse/${kind}/${id}`,
      canonicalId: `${kind}/${id}`,
      oembed: OEMBED.tidal,
      ogFallback: true,
    });
  }

  if (host === 'deezer.com' || host.endsWith('.deezer.com')) {
    const match = /deezer\.com\/(?:widget\/\w+\/|\w{2}\/)?(track|album|playlist)\/(\d+)/.exec(href);
    const kind = match?.[1];
    const id = match?.[2];
    if (kind === undefined || id === undefined) {
      return null;
    }
    return descriptor({
      id: 'deezer',
      name: 'Deezer',
      pageUrl: `https://www.deezer.com/${kind}/${id}`,
      canonicalId: `${kind}/${id}`,
      oembed: OEMBED.deezer,
      ogFallback: true,
    });
  }

  const drmHost = Object.keys(DRM).find((h) => host === h || host.endsWith(`.${h}`));
  const drm = drmHost === undefined ? undefined : DRM[drmHost];
  if (drm !== undefined) {
    return descriptor({
      id: drm.id,
      name: drm.name,
      pageUrl: href,
      ogFallback: true, // title pages are public and carry posters
    });
  }

  const path = url.pathname.toLowerCase();
  if (MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    const filename = filenameOf(url);
    return descriptor({
      id: 'direct',
      name: 'Direct link',
      pageUrl: href,
      ogFallback: false, // these are media bytes, not a page
      fallbackTitle: filename,
    });
  }

  return descriptor({
    id: 'link',
    name: host,
    pageUrl: href,
    ogFallback: true,
    genericName: true,
  });
}

/**
 * Classify a MediaRef. `hls` keeps whatever metadata the row already carries —
 * nothing is fetched for a playlist manifest. No surface produces an `hls` ref
 * since services/media (the library) was deleted; only rows stored before then
 * still reach this arm.
 */
export function describeMediaRef(ref: MediaRef): ProviderDescriptor {
  switch (ref.kind) {
    case 'hls':
      return descriptor({ id: 'stream', name: 'Stream', canonicalId: ref.assetId });
    case 'youtube':
      return descriptor({
        id: 'youtube',
        name: 'YouTube',
        pageUrl: `https://www.youtube.com/watch?v=${ref.videoId}`,
        canonicalId: ref.videoId,
        oembed: OEMBED.youtube,
        ogFallback: true,
      });
    case 'vimeo':
      return descriptor({
        id: 'vimeo',
        name: 'Vimeo',
        pageUrl: `https://vimeo.com/${ref.videoId}`,
        canonicalId: ref.videoId,
        oembed: OEMBED.vimeo,
        ogFallback: true,
      });
    case 'soundcloud':
      return describeUrl(ref.url) ?? descriptor({ id: 'soundcloud', name: 'SoundCloud' });
    case 'url':
      return describeUrl(ref.url) ?? descriptor({ id: 'direct', name: 'Direct link' });
    case 'embed':
      return describeUrl(ref.embedUrl) ?? embedFallback(ref.provider);
    // An arbitrary web page: the same classification a raw link gets, because
    // that is all this ref ever was. describeUrl resolves a recognised host to
    // its real provider descriptor and any other to the generic 'link' tier;
    // the ?? arm is unreachable for a stored ref (HttpsUrl already parsed) and
    // exists so a hand-built ref cannot return undefined.
    case 'page':
      return (
        describeUrl(ref.url) ??
        descriptor({ id: 'link', name: 'Web page', pageUrl: ref.url, ogFallback: true, genericName: true })
      );
  }
}

const EMBED_NAMES: Record<string, string> = {
  spotify: 'Spotify',
  applemusic: 'Apple Music',
  tidal: 'Tidal',
  deezer: 'Deezer',
};

function embedFallback(provider: 'spotify' | 'applemusic' | 'tidal' | 'deezer'): ProviderDescriptor {
  return descriptor({ id: provider, name: EMBED_NAMES[provider] ?? provider });
}

/** oEmbed request URL for one item — always built from the FIXED endpoint. */
export function oembedRequestUrl(endpoint: OEmbedEndpoint, pageUrl: string): string {
  const url = new URL(endpoint.endpoint);
  url.searchParams.set('url', pageUrl);
  url.searchParams.set('format', 'json');
  return url.toString();
}
