/**
 * Provider detection for the active tab (content script + popup). Pure —
 * unit-tested in node.
 */

export type TabProviderTier = 'api' | 'drm' | 'generic';

export interface TabProvider {
  id: string;
  name: string;
  tier: TabProviderTier;
}

const KNOWN: Array<[RegExp, TabProvider]> = [
  [/^music\.youtube\.com$/, { id: 'youtubemusic', name: 'YouTube Music', tier: 'api' }],
  [/^(.*\.)?youtube\.com$/, { id: 'youtube', name: 'YouTube', tier: 'api' }],
  [/^(.*\.)?soundcloud\.com$/, { id: 'soundcloud', name: 'SoundCloud', tier: 'api' }],
  [/^(.*\.)?vimeo\.com$/, { id: 'vimeo', name: 'Vimeo', tier: 'api' }],
  [/^(.*\.)?netflix\.com$/, { id: 'netflix', name: 'Netflix', tier: 'drm' }],
  [/^(.*\.)?primevideo\.com$/, { id: 'primevideo', name: 'Prime Video', tier: 'drm' }],
  [/^(.*\.)?disneyplus\.com$/, { id: 'disneyplus', name: 'Disney+', tier: 'drm' }],
  [/^(.*\.)?max\.com$/, { id: 'max', name: 'Max', tier: 'drm' }],
  [/^(.*\.)?hulu\.com$/, { id: 'hulu', name: 'Hulu', tier: 'drm' }],
  [/^(.*\.)?paramountplus\.com$/, { id: 'paramountplus', name: 'Paramount+', tier: 'drm' }],
  [/^(.*\.)?peacocktv\.com$/, { id: 'peacock', name: 'Peacock', tier: 'drm' }],
  [/^(.*\.)?crunchyroll\.com$/, { id: 'crunchyroll', name: 'Crunchyroll', tier: 'drm' }],
];

/** Classify a tab URL. Generic pages still work — any <video>/<audio> on the
 *  page is driven (Mode A sync is player-agnostic). */
export function providerForUrl(url: string): TabProvider {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return { id: 'unknown', name: 'This page', tier: 'generic' };
  }
  for (const [re, provider] of KNOWN) {
    if (re.test(host)) return provider;
  }
  return { id: 'generic', name: host, tier: 'generic' };
}
