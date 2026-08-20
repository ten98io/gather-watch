/**
 * Mode A provider registry — DERIVED from the one shared registry in
 * @gather/contracts (packages/contracts/src/providers.ts): the superset there
 * carries hosts/drm/cast for the extension; this module maps it down to the
 * five fields the web renders and keeps the URL parser, because contracts is
 * environment-free and cannot `new URL`. The honest capability tiers:
 *
 *  full-sync   real player API (YouTube/SoundCloud/Vimeo) → drift-corrected
 *  approximate official embed with no position API (Spotify/Apple Music/
 *              Tidal/Deezer) → play starts together, never corrected. The UI
 *              badges this; nothing is faked.
 *  extension   DRM services (Netflix, Prime Video, Disney+, Max, Hulu,
 *              Paramount+, Peacock, Crunchyroll) → no embed exists and capture
 *              renders black by OS design. These ride the browser-extension
 *              content-script path (everyone's own player, everyone's own
 *              account), so they queue as `page` refs like any other link the
 *              extension drives — the tier is a NOTE, never a refusal. Until
 *              2026-08-19 they parsed to a null ref and the queue declined
 *              them, which told the user to install the extension and then
 *              refused the only eight sites it exists for.
 *  generic     ANY other https page. Nobody can finish enumerating the web,
 *              so the named entries below are BETTER paths for the sites they
 *              know rather than gates on the ones they don't: an unrecognised
 *              host queues as a `page` MediaRef and each viewer's extension
 *              drives whatever <video>/<audio> that page mounts on their own
 *              device. A viewer without the extension just sees the link, and
 *              the queue note says exactly that.
 */
import { PROVIDERS as REGISTRY, providerForHost } from '@gather/contracts';
import type { MediaRef, ProviderCapability } from '@gather/contracts';

export type { ProviderCapability } from '@gather/contracts';

export interface Provider {
  id: string;
  name: string;
  icon: string;
  capability: ProviderCapability;
  /** Queue-add hint shown when a URL parses to this provider. */
  note: string;
}

/** Shared by all eight DRM services — see the `extension` tier above. */
const EXTENSION_NOTE =
  'Plays through the Gather browser extension — everyone signs in with their own account';

export const PROVIDERS: readonly Provider[] = [
  // One sentence for all eight extension-tier services, because the two facts
  // a person needs before pasting are the same on every one of them: it plays
  // through the extension, and nobody is sharing a login. The shared registry
  // keeps the extension popup's shorter per-site notes; this app overrides.
  ...REGISTRY.map(({ id, name, icon, capability, note }) => ({
    id,
    name,
    icon,
    capability,
    note: capability === 'extension' ? EXTENSION_NOTE : note,
  })),
  // The fallback every unrecognised host lands on — this app's own row, the
  // web-side mirror of the shared registry's UNKNOWN. `name` is a
  // placeholder: parseProviderUrl swaps in the actual host, so the row names
  // the site instead of a category.
  { id: 'generic', name: 'Web page', icon: '🌐', capability: 'generic', note: 'Everyone with the Gather browser extension plays it on their own screen — others just see the link' },
] as const;

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export interface ParsedProviderUrl {
  provider: Provider;
  /** Never null: a parse either yields a MediaRef or the whole parse fails.
   *  The extension tier used to be the one exception — callers must not
   *  reintroduce a "recognised but unqueueable" state. */
  ref: MediaRef;
  titleHint: string | null;
}

/** Parse a pasted URL into a provider + MediaRef. Null means "not a link we
 *  can hand to a browser", never "not on the list". */
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
  const found = (id: string, ref: MediaRef, titleHint: string | null = null): ParsedProviderUrl => {
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

  // DRM tier — recognized, never embedded, and queued like any other page. No
  // embed and no capture exist for these, so the room carries the LINK and
  // each viewer's extension drives the site's own player (its driver.ts keys
  // `page:${url}`). Which hosts are extension-tier is the shared registry's
  // knowledge now — no hand-kept host map to drift. Matching a name here is a
  // BETTER row, not a gate: keeping the provider identity is what makes it
  // render as Netflix instead of netflix.com, and the tier is what makes the
  // UI say an extension is needed.
  const registryMatch = providerForHost(host);
  if (registryMatch.capability === 'extension') {
    // Same https rule as the generic page branch below, stated here because a
    // page ref reaches this return without passing that one.
    if (!secure) return null;
    const drm = found(registryMatch.id, { kind: 'page', url });
    return { ...drm, titleHint: drm.provider.name };
  }

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
