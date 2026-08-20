/**
 * Provider registry — the ONE copy. The extension re-exports this superset
 * (apps/extension/src/providers.ts) and the web derives its slimmer list from
 * it (apps/web/lib/providers.ts), so adding a service is one edit here.
 *
 * Beyond id/name/icon/capability/note the registry carries what only the
 * extension used to know:
 *
 *   hosts          which hostnames land on this provider
 *   drm            the media is protected (EME) — drive the site's own
 *                  player, never capture, mirror or re-encode it
 *   cast           whether the site exposes its own cast control we can click
 *                  on the user's behalf — the ONLY DRM-legal route to a TV
 *                  (see docs/EXTENSION_FIRST.md Part 3)
 *   grantPatterns  Chrome match patterns covering the same hosts, for
 *                  chrome.permissions.request. https only — a grant is a
 *                  standing door and http would hold it open for a MITM.
 *
 * This package is ENVIRONMENT-FREE (tsconfig types: [], lib-only): no `new
 * URL`, no DOM, no node. Matching here is HOSTNAME-level only; URL parsing
 * stays in the apps, which own an environment that can parse one.
 */

/** Honest capability tier, shared vocabulary of both app registries. */
export type ProviderCapability = 'full-sync' | 'approximate' | 'extension' | 'generic';

/** Legacy extension vocabulary, derived from `capability` + `drm`. */
export type TabProviderTier = 'api' | 'drm' | 'generic';

/**
 * Per-site casting capability. Declarative on purpose: adding a site is data,
 * not code. `native: false` means Gather cannot act and must say why —
 * capturing or re-encoding a protected surface is never an option.
 */
export interface CastCapability {
  /** The site exposes its own cast control that we can click for the user. */
  native: boolean;
  /** Clicked first when the cast button is hidden behind an overflow menu. */
  reveal: readonly string[];
  /** Cast-button selectors, first visible match wins. Matched through open
   *  shadow roots by the content script. */
  buttons: readonly string[];
  /** Plain-language reason shown when Gather cannot cast from here. */
  reason: string;
}

export interface Provider {
  id: string;
  name: string;
  icon: string;
  capability: ProviderCapability;
  /** Protected media: Mode A only, never Mode B capture. */
  drm: boolean;
  /** Queue-add / status hint. */
  note: string;
  cast: CastCapability;
  /** Host matchers. Empty for entries only reachable by a pasted URL. */
  hosts: readonly RegExp[];
  /** Chrome match patterns covering the same hosts as `hosts`, handed to
   *  chrome.permissions.request. Empty when there is no host to grant. */
  grantPatterns: readonly string[];
}

/** What host classification returns: a registry entry flattened for the wire. */
export interface TabProvider {
  id: string;
  name: string;
  icon: string;
  /** @deprecated derived from `capability`/`drm`; use those instead. */
  tier: TabProviderTier;
  capability: ProviderCapability;
  drm: boolean;
  note: string;
  cast: CastCapability;
}

const NO_CAST = (reason: string): CastCapability => ({
  native: false,
  reveal: [],
  buttons: [],
  reason,
});

/** Fallback for any site we don't know: drivable, not castable by us. */
export const GENERIC_CAST: CastCapability = NO_CAST(
  "This site has no cast control Gather can reach — use your browser's own Cast… menu, which casts the tab.",
);

const DRM_NO_CAST = (name: string): CastCapability =>
  NO_CAST(
    `${name} casts from its own apps. Protected video can't be cast from here — Gather never captures a protected player.`,
  );

const SYNC_NOTE = 'Plays in sync for everyone';
const APPROX_NOTE = 'Starts together — may drift slightly';
const EXT_NOTE = 'Needs the Gather browser extension';

export const PROVIDERS: readonly Provider[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    icon: '▶',
    capability: 'full-sync',
    drm: false,
    note: SYNC_NOTE,
    // Lookahead keeps music.youtube.com on the YouTube Music entry below,
    // independent of array order.
    hosts: [/^(?!music\.)(.*\.)?youtube\.com$/, /^youtu\.be$/],
    // Match patterns cannot express the lookahead; *.youtube.com covers
    // music.youtube.com too, which is fine — the union is what gets granted.
    grantPatterns: ['https://*.youtube.com/*', 'https://youtu.be/*'],
    cast: {
      native: true,
      // Narrow players fold the cast button into the overflow menu.
      reveal: ['.ytp-overflow-button'],
      buttons: ['.ytp-remote-button', 'button.ytp-remote-button', '.ytp-menuitem[role="menuitem"] .ytp-remote-button'],
      reason: '',
    },
  },
  {
    id: 'youtubemusic',
    name: 'YouTube Music',
    icon: '♫',
    capability: 'full-sync',
    drm: false,
    note: SYNC_NOTE,
    hosts: [/^music\.youtube\.com$/],
    grantPatterns: ['https://music.youtube.com/*'],
    cast: {
      native: true,
      reveal: [],
      buttons: ['ytmusic-cast-button', 'ytmusic-cast-button button', '.ytp-remote-button'],
      reason: '',
    },
  },
  {
    id: 'soundcloud',
    name: 'SoundCloud',
    icon: '☁',
    capability: 'full-sync',
    drm: false,
    note: SYNC_NOTE,
    hosts: [/^(.*\.)?soundcloud\.com$/],
    grantPatterns: ['https://*.soundcloud.com/*'],
    cast: GENERIC_CAST,
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    icon: 'Ⓥ',
    capability: 'full-sync',
    drm: false,
    note: SYNC_NOTE,
    hosts: [/^(.*\.)?vimeo\.com$/],
    grantPatterns: ['https://*.vimeo.com/*'],
    cast: GENERIC_CAST,
  },
  {
    id: 'spotify',
    name: 'Spotify',
    icon: '●',
    capability: 'approximate',
    // Spotify's web player is EME-protected; treat as protected (the safe
    // direction — it only ever disables capture, never playback).
    drm: true,
    note: APPROX_NOTE,
    hosts: [/^open\.spotify\.com$/, /^(.*\.)?spotify\.com$/],
    grantPatterns: ['https://open.spotify.com/*', 'https://*.spotify.com/*'],
    cast: {
      // Spotify Connect is the sanctioned path: the device picker hands the
      // stream to the speaker/TV inside Spotify's own session.
      native: true,
      reveal: [],
      buttons: [
        '[data-testid="control-device-picker"]',
        'button[aria-label*="Connect to a device" i]',
      ],
      reason: '',
    },
  },
  {
    id: 'applemusic',
    name: 'Apple Music',
    icon: '◆',
    capability: 'approximate',
    drm: true,
    note: APPROX_NOTE,
    hosts: [/^(embed\.)?music\.apple\.com$/],
    grantPatterns: ['https://music.apple.com/*', 'https://embed.music.apple.com/*'],
    cast: DRM_NO_CAST('Apple Music'),
  },
  {
    id: 'tidal',
    name: 'Tidal',
    icon: '≈',
    capability: 'approximate',
    drm: true,
    note: APPROX_NOTE,
    hosts: [/^(.*\.)?tidal\.com$/],
    grantPatterns: ['https://*.tidal.com/*'],
    cast: DRM_NO_CAST('Tidal'),
  },
  {
    id: 'deezer',
    name: 'Deezer',
    icon: '▤',
    capability: 'approximate',
    drm: true,
    note: APPROX_NOTE,
    hosts: [/^(.*\.)?deezer\.com$/],
    grantPatterns: ['https://*.deezer.com/*'],
    cast: DRM_NO_CAST('Deezer'),
  },
  // DRM video. Selectors are recorded where a cast control is believed to
  // exist but is unverified; `native` stays false until it is confirmed on
  // the real site, so the UI never promises something it can't do.
  {
    id: 'netflix',
    name: 'Netflix',
    icon: 'Ⓝ',
    capability: 'extension',
    drm: true,
    note: 'Needs the Gather browser extension — everyone uses their own account',
    hosts: [/^(.*\.)?netflix\.com$/],
    grantPatterns: ['https://*.netflix.com/*'],
    cast: {
      native: false,
      reveal: [],
      buttons: ['[data-uia="control-cast"]', 'button[aria-label*="cast" i]'],
      reason:
        "Netflix casts from its own mobile and TV apps. Its web player has no cast control Gather can press, and protected video can't be mirrored.",
    },
  },
  {
    id: 'primevideo',
    name: 'Prime Video',
    icon: 'Ⓟ',
    capability: 'extension',
    drm: true,
    note: EXT_NOTE,
    hosts: [/^(.*\.)?primevideo\.com$/],
    grantPatterns: ['https://*.primevideo.com/*'],
    cast: DRM_NO_CAST('Prime Video'),
  },
  {
    id: 'disneyplus',
    name: 'Disney+',
    icon: 'Ⓓ',
    capability: 'extension',
    drm: true,
    note: EXT_NOTE,
    hosts: [/^(.*\.)?disneyplus\.com$/],
    grantPatterns: ['https://*.disneyplus.com/*'],
    cast: DRM_NO_CAST('Disney+'),
  },
  {
    id: 'max',
    name: 'Max',
    icon: 'Ⓜ',
    capability: 'extension',
    drm: true,
    note: EXT_NOTE,
    hosts: [/^(.*\.)?max\.com$/],
    grantPatterns: ['https://*.max.com/*'],
    cast: DRM_NO_CAST('Max'),
  },
  {
    id: 'hulu',
    name: 'Hulu',
    icon: 'Ⓗ',
    capability: 'extension',
    drm: true,
    note: EXT_NOTE,
    hosts: [/^(.*\.)?hulu\.com$/],
    grantPatterns: ['https://*.hulu.com/*'],
    cast: DRM_NO_CAST('Hulu'),
  },
  {
    id: 'paramountplus',
    name: 'Paramount+',
    icon: '⛰',
    capability: 'extension',
    drm: true,
    note: EXT_NOTE,
    hosts: [/^(.*\.)?paramountplus\.com$/],
    grantPatterns: ['https://*.paramountplus.com/*'],
    cast: DRM_NO_CAST('Paramount+'),
  },
  {
    id: 'peacock',
    name: 'Peacock',
    icon: '🦚',
    capability: 'extension',
    drm: true,
    note: EXT_NOTE,
    hosts: [/^(.*\.)?peacocktv\.com$/],
    grantPatterns: ['https://*.peacocktv.com/*'],
    cast: DRM_NO_CAST('Peacock'),
  },
  {
    id: 'crunchyroll',
    name: 'Crunchyroll',
    icon: 'Ⓒ',
    capability: 'extension',
    drm: true,
    note: EXT_NOTE,
    hosts: [/^(.*\.)?crunchyroll\.com$/],
    grantPatterns: ['https://*.crunchyroll.com/*'],
    cast: DRM_NO_CAST('Crunchyroll'),
  },
  {
    // Reachable by pasted URL only (the web app's "direct link or upload").
    // Kept so both registries hold the same id set.
    id: 'direct',
    name: 'Direct link or upload',
    icon: '🔗',
    capability: 'full-sync',
    drm: false,
    note: SYNC_NOTE,
    hosts: [],
    grantPatterns: [],
    cast: GENERIC_CAST,
  },
];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Deduped union of every provider's grant patterns — the one permission
 *  request that covers every host the registry can classify. */
export function providerGrantPatterns(): string[] {
  return [...new Set(PROVIDERS.flatMap((p) => p.grantPatterns))];
}

/** Legacy tier, derived. DRM wins: it is the field that gates capture. */
export function tierFor(p: { capability: ProviderCapability; drm: boolean }): TabProviderTier {
  if (p.drm) return 'drm';
  if (p.capability === 'full-sync' || p.capability === 'approximate') return 'api';
  return 'generic';
}

function toTabProvider(p: Provider): TabProvider {
  return {
    id: p.id,
    name: p.name,
    icon: p.icon,
    tier: tierFor(p),
    capability: p.capability,
    drm: p.drm,
    note: p.note,
    cast: p.cast,
  };
}

/** Fallback the apps use when there is no hostname at all (non-URL input).
 *  A real-but-unrecognised hostname gets id 'generic' via providerForHost. */
export const UNKNOWN: TabProvider = {
  id: 'unknown',
  name: 'This page',
  icon: '🔗',
  tier: 'generic',
  capability: 'generic',
  drm: false,
  note: 'Any page with a video or audio element can follow the room',
  cast: GENERIC_CAST,
};

/** Classify a HOSTNAME (never a URL — this package cannot parse one).
 *  Generic hosts still work: any <video>/<audio> on the page is driven
 *  (Mode A sync is player-agnostic), so unknown means a generic entry named
 *  after the host, never a refusal. */
export function providerForHost(hostname: string): TabProvider {
  for (const provider of PROVIDERS) {
    for (const re of provider.hosts) {
      if (re.test(hostname)) return toTabProvider(provider);
    }
  }
  return { ...UNKNOWN, id: 'generic', name: hostname };
}

/** Cast capability for a hostname (popup + content script share this). */
export function castCapabilityForHost(hostname: string): CastCapability {
  return providerForHost(hostname).cast;
}
