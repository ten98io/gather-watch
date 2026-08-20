import { describe, expect, it } from 'vitest';
import {
  EmbedProvider,
  PROVIDERS,
  providerForHost,
  providerGrantPatterns,
} from '../src';

describe('provider registry', () => {
  // A reorder or rename here ripples into both apps (the extension pins this
  // exact list, the web derives its rows from it) — make it loud.
  it('pins the ids in order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      'youtube',
      'youtubemusic',
      'soundcloud',
      'vimeo',
      'spotify',
      'applemusic',
      'tidal',
      'deezer',
      'netflix',
      'primevideo',
      'disneyplus',
      'max',
      'hulu',
      'paramountplus',
      'peacock',
      'crunchyroll',
      'direct',
    ]);
  });

  // The weld: EMBED_PROVIDER_HOSTS pins each embeddable service to one
  // origin, keyed by this enum. If the registry gains or loses an
  // 'approximate' (embed-tier) service without the enum moving in lockstep,
  // the room would carry embed refs no origin pin covers — or pin origins for
  // providers that no longer exist.
  it('welds the EmbedProvider enum to the approximate tier', () => {
    const approximate = PROVIDERS.filter((p) => p.capability === 'approximate').map((p) => p.id);
    expect([...EmbedProvider.options]).toEqual(approximate);
  });
});

describe('grantPatterns', () => {
  // These strings are handed to chrome.permissions.request verbatim; a
  // malformed one rejects the whole request. https only — a grant is a
  // standing door. Host is either exact or a single leading '*.'; path is
  // the whole-site '/*'.
  it('every pattern is a valid https match pattern', () => {
    for (const p of PROVIDERS) {
      for (const pattern of p.grantPatterns) {
        expect(pattern, `${p.id}: ${pattern}`).toMatch(
          /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\/\*$/,
        );
      }
    }
  });

  it('direct has no host, so nothing to grant', () => {
    expect(PROVIDERS.find((p) => p.id === 'direct')?.grantPatterns).toEqual([]);
  });

  it('the union is deduped and covers every listed pattern', () => {
    const union = providerGrantPatterns();
    expect(new Set(union).size).toBe(union.length);
    for (const p of PROVIDERS) {
      for (const pattern of p.grantPatterns) expect(union).toContain(pattern);
    }
  });
});

describe('providerForHost', () => {
  it('routes a sample hostname to every provider that has hosts', () => {
    for (const [host, id] of [
      ['www.youtube.com', 'youtube'],
      ['youtu.be', 'youtube'],
      // The one ordering trap: the youtube entry's lookahead must cede
      // music.youtube.com to the youtubemusic entry regardless of array order.
      ['music.youtube.com', 'youtubemusic'],
      ['soundcloud.com', 'soundcloud'],
      ['vimeo.com', 'vimeo'],
      ['open.spotify.com', 'spotify'],
      ['music.apple.com', 'applemusic'],
      ['embed.music.apple.com', 'applemusic'],
      ['listen.tidal.com', 'tidal'],
      ['www.deezer.com', 'deezer'],
      ['www.netflix.com', 'netflix'],
      ['www.primevideo.com', 'primevideo'],
      ['www.disneyplus.com', 'disneyplus'],
      ['play.max.com', 'max'],
      ['www.hulu.com', 'hulu'],
      ['www.paramountplus.com', 'paramountplus'],
      ['www.peacocktv.com', 'peacock'],
      ['www.crunchyroll.com', 'crunchyroll'],
    ] as const) {
      expect(providerForHost(host).id, host).toBe(id);
    }
  });

  it('names an unknown host as itself under the generic id', () => {
    const p = providerForHost('films.example.org');
    expect(p.id).toBe('generic');
    expect(p.name).toBe('films.example.org');
    expect(p.capability).toBe('generic');
  });
});
