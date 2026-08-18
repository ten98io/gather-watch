/**
 * Mode A provider registry — every supported service, its URL parser, and its
 * HONEST capability tier:
 *
 *  full-sync   real player API (YouTube/SoundCloud/Vimeo) → drift-corrected
 *  approximate official embed with no position API (Spotify/Apple Music/
 *              Tidal/Deezer) → play starts together, never corrected. The UI
 *              badges this; nothing is faked.
 *  extension   DRM services (Netflix, Prime Video, Disney+, Max, Hulu,
 *              Paramount+, Peacock, Crunchyroll) → no embed exists and capture
 *              renders black by OS design. These ride the browser-extension
 *              content-script path (everyone's own player, everyone's own
 *              account). In the web app they queue as informational rows.
 *  generic     ANY other https page. Nobody can finish enumerating the web,
 *              so the named entries below are BETTER paths for the sites they
 *              know rather than gates on the ones they don't: an unrecognised
 *              host queues as a `page` MediaRef and each viewer's extension
 *              drives whatever <video>/<audio> that page mounts on their own
 *              device. A viewer without the extension just sees the link, and
 *              the queue note says exactly that.
 */
import type { MediaRef } from '@gather/contracts';

/** Mirrors apps/extension/src/providers.ts — the two registries share tiers. */
export type ProviderCapability = 'full-sync' | 'approximate' | 'extension' | 'generic';

export interface Provider {
  id: string;
  name: string;
  icon: string;
  capability: ProviderCapability;
  /** Queue-add hint shown when a URL parses to this provider. */
  note: string;
}

export const PROVIDERS: readonly Provider[] = [
  { id: 'youtube', name: 'YouTube', icon: '▶', capability: 'full-sync', note: 'Plays in sync for everyone' },
  { id: 'youtubemusic', name: 'YouTube Music', icon: '♫', capability: 'full-sync', note: 'Plays in sync for everyone' },
  { id: 'soundcloud', name: 'SoundCloud', icon: '☁', capability: 'full-sync', note: 'Plays in sync for everyone' },
  { id: 'vimeo', name: 'Vimeo', icon: 'Ⓥ', capability: 'full-sync', note: 'Plays in sync for everyone' },
  { id: 'spotify', name: 'Spotify', icon: '●', capability: 'approximate', note: 'Starts together — may drift slightly' },
  { id: 'applemusic', name: 'Apple Music', icon: '◆', capability: 'approximate', note: 'Starts together — may drift slightly' },
  { id: 'tidal', name: 'Tidal', icon: '≈', capability: 'approximate', note: 'Starts together — may drift slightly' },
  { id: 'deezer', name: 'Deezer', icon: '▤', capability: 'approximate', note: 'Starts together — may drift slightly' },
  { id: 'netflix', name: 'Netflix', icon: 'Ⓝ', capability: 'extension', note: 'Needs the Gather browser extension — everyone uses their own account' },
  { id: 'primevideo', name: 'Prime Video', icon: 'Ⓟ', capability: 'extension', note: 'Needs the Gather browser extension' },
  { id: 'disneyplus', name: 'Disney+', icon: 'Ⓓ', capability: 'extension', note: 'Needs the Gather browser extension' },
  { id: 'max', name: 'Max', icon: 'Ⓜ', capability: 'extension', note: 'Needs the Gather browser extension' },
  { id: 'hulu', name: 'Hulu', icon: 'Ⓗ', capability: 'extension', note: 'Needs the Gather browser extension' },
  { id: 'paramountplus', name: 'Paramount+', icon: '⛰', capability: 'extension', note: 'Needs the Gather browser extension' },
  { id: 'peacock', name: 'Peacock', icon: '🦚', capability: 'extension', note: 'Needs the Gather browser extension' },
  { id: 'crunchyroll', name: 'Crunchyroll', icon: 'Ⓒ', capability: 'extension', note: 'Needs the Gather browser extension' },
  { id: 'direct', name: 'Direct link or upload', icon: '🔗', capability: 'full-sync', note: 'Plays in sync for everyone' },
  // The fallback every unrecognised host lands on. `name` is a placeholder:
  // parseProviderUrl swaps in the actual host, the way the extension's
  // UNKNOWN_URL does, so the row names the site instead of a category.
  { id: 'generic', name: 'Web page', icon: '🌐', capability: 'generic', note: 'Everyone with the Gather browser extension plays it on their own screen — others just see the link' },
] as const;

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface ParsedProviderUrl {
  provider: Provider;
  /** null for extension-tier providers (no playable MediaRef exists). */
  ref: MediaRef | null;
  titleHint: string | null;
}

/** Parse a pasted URL into a provider + MediaRef (or an extension-tier row). */
export function parseProviderUrl(raw: string): ParsedProviderUrl | null {
  const url = raw.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  let host = '';
  let secure = false;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');
    secure = parsed.protocol === 'https:';
  } catch {
    return null;
  }
  const found = (id: string, ref: MediaRef | null, titleHint: string | null = null): ParsedProviderUrl => {
    const provider = providerById(id);
    if (provider === undefined) throw new Error(`unknown provider ${id}`);
    return { provider, ref, titleHint };
  };

  // YouTube + YouTube Music (same videoId space).
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    const yt = /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|music\/)|youtu\.be\/)([\w-]{6,})/.exec(url);
    const videoId = yt?.[1] ?? (/[?&]v=([\w-]{6,})/.exec(url)?.[1]);
    if (videoId === undefined) return null;
    // Title hints are user-visible queue titles: never surface the raw id.
    return found(
      host === 'music.youtube.com' ? 'youtubemusic' : 'youtube',
      host === 'music.youtube.com'
        ? { kind: 'youtube', videoId, music: true }
        : { kind: 'youtube', videoId },
      host === 'music.youtube.com' ? 'YouTube Music track' : 'YouTube video',
    );
  }

  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    return found('soundcloud', { kind: 'soundcloud', url }, 'SoundCloud track');
  }

  const vimeo = /vimeo\.com\/(?:video\/)?(\d{6,})/.exec(url);
  if (vimeo?.[1] !== undefined) {
    return found('vimeo', { kind: 'vimeo', videoId: vimeo[1] }, 'Vimeo video');
  }

  const spotify = /open\.spotify\.com\/(track|album|playlist|episode|show)\/([\w]+)/.exec(url);
  if (spotify?.[1] !== undefined && spotify[2] !== undefined) {
    return found('spotify', {
      kind: 'embed',
      provider: 'spotify',
      embedUrl: `https://open.spotify.com/embed/${spotify[1]}/${spotify[2]}`,
      title: null,
    });
  }

  if (host === 'music.apple.com') {
    const path = new URL(url).pathname;
    return found('applemusic', {
      kind: 'embed',
      provider: 'applemusic',
      embedUrl: `https://embed.music.apple.com${path}`,
      title: null,
    });
  }

  const tidal = /tidal\.com\/(?:browse\/)?(track|album|playlist)\/([\w-]+)/.exec(url);
  if (tidal?.[1] !== undefined && tidal[2] !== undefined) {
    return found('tidal', {
      kind: 'embed',
      provider: 'tidal',
      embedUrl: `https://embed.tidal.com/${tidal[1]}s/${tidal[2]}`,
      title: null,
    });
  }

  const deezer = /deezer\.com\/(?:\w+\/)?(track|album|playlist)\/(\d+)/.exec(url);
  if (deezer?.[1] !== undefined && deezer[2] !== undefined) {
    return found('deezer', {
      kind: 'embed',
      provider: 'deezer',
      embedUrl: `https://widget.deezer.com/widget/dark/${deezer[1]}/${deezer[2]}`,
      title: null,
    });
  }

  // DRM tier — recognized, never embedded.
  const drmHosts: Record<string, string> = {
    'netflix.com': 'netflix',
    'primevideo.com': 'primevideo',
    'disneyplus.com': 'disneyplus',
    'max.com': 'max',
    'hulu.com': 'hulu',
    'paramountplus.com': 'paramountplus',
    'peacocktv.com': 'peacock',
    'crunchyroll.com': 'crunchyroll',
  };
  const drmId = Object.entries(drmHosts).find(([h]) => host === h || host.endsWith(`.${h}`))?.[1];
  if (drmId !== undefined) return found(drmId, null);

  // Direct media.
  const lower = url.split('?')[0]?.toLowerCase() ?? '';
  const mime = lower.endsWith('.m3u8')
    ? 'application/x-mpegURL'
    : lower.endsWith('.mp3')
      ? 'audio/mpeg'
      : lower.endsWith('.m4a') || lower.endsWith('.aac')
        ? 'audio/aac'
        : lower.endsWith('.webm')
          ? 'video/webm'
          : lower.endsWith('.mp4')
            ? 'video/mp4'
            : null;
  if (mime !== null) {
    return found('direct', { kind: 'url', url, mime }, url.split('/').pop() ?? url);
  }

  // Anything else that is a real page. This is the branch that used to be a
  // bare `return null` — the one that turned every site nobody had written a
  // parser for into "only supported sites". https only: a page ref is handed
  // to a browser as a link to open, and the contract (HttpsUrl) refuses the
  // rest independently, so this is the same rule stated where the user is.
  if (!secure) return null;
  const page = found('generic', { kind: 'page', url }, host);
  return { ...page, provider: { ...page.provider, name: host } };
}
