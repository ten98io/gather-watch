import { describe, expect, it } from 'vitest';
import { PROVIDERS, castCapabilityFor, providerById, providerForUrl, tierFor } from '../src/providers';

describe('providerForUrl', () => {
  it('classifies API-tier providers', () => {
    expect(providerForUrl('https://www.youtube.com/watch?v=x').id).toBe('youtube');
    expect(providerForUrl('https://music.youtube.com/watch?v=x').id).toBe('youtubemusic');
    expect(providerForUrl('https://soundcloud.com/a/b').id).toBe('soundcloud');
    expect(providerForUrl('https://vimeo.com/123').id).toBe('vimeo');
    expect(providerForUrl('https://youtu.be/abc').id).toBe('youtube');
  });

  it('classifies the DRM tier (extension Mode A applies)', () => {
    for (const [url, id] of [
      ['https://www.netflix.com/watch/1', 'netflix'],
      ['https://www.primevideo.com/detail/x', 'primevideo'],
      ['https://www.disneyplus.com/video/x', 'disneyplus'],
      ['https://www.max.com/video/x', 'max'],
      ['https://www.hulu.com/watch/x', 'hulu'],
      ['https://www.peacocktv.com/watch/x', 'peacock'],
    ] as const) {
      const p = providerForUrl(url);
      expect(p.id).toBe(id);
      expect(p.tier).toBe('drm');
    }
  });

  it('falls back to generic (any page with a media element works)', () => {
    expect(providerForUrl('https://example.com/watch').tier).toBe('generic');
    expect(providerForUrl('not a url').tier).toBe('generic');
  });

  it('names the host for unknown sites but never leaks it as a known id', () => {
    const p = providerForUrl('https://films.example.org/watch/9');
    expect(p.id).toBe('generic');
    expect(p.name).toBe('films.example.org');
    expect(providerForUrl('not a url').id).toBe('unknown');
  });
});

describe('unified registry (superset of the web registry)', () => {
  it('covers every service the web registry parses, with matching ids', () => {
    const webIds = [
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
    ];
    expect(PROVIDERS.map((p) => p.id)).toEqual(webIds);
    for (const id of webIds) expect(providerById(id)).toBeDefined();
  });

  it('speaks the web capability vocabulary', () => {
    expect(providerForUrl('https://www.youtube.com/watch?v=x').capability).toBe('full-sync');
    expect(providerForUrl('https://open.spotify.com/track/x').capability).toBe('approximate');
    expect(providerForUrl('https://www.hulu.com/watch/x').capability).toBe('extension');
    expect(providerForUrl('https://example.com/').capability).toBe('generic');
  });

  it('derives the legacy tier so existing consumers keep working', () => {
    expect(tierFor({ capability: 'full-sync', drm: false })).toBe('api');
    expect(tierFor({ capability: 'approximate', drm: false })).toBe('api');
    expect(tierFor({ capability: 'extension', drm: true })).toBe('drm');
    expect(tierFor({ capability: 'generic', drm: false })).toBe('generic');
    // DRM wins over the tier — it is the field that gates capture.
    expect(tierFor({ capability: 'approximate', drm: true })).toBe('drm');
  });

  it('marks every protected service as drm (Mode B must never capture it)', () => {
    for (const id of ['netflix', 'primevideo', 'disneyplus', 'max', 'hulu', 'paramountplus', 'peacock', 'crunchyroll']) {
      expect(providerById(id)?.drm).toBe(true);
    }
    expect(providerById('youtube')?.drm).toBe(false);
    expect(providerById('direct')?.drm).toBe(false);
  });

  it('keeps every entry drivable — a registry entry never blocks Mode A', () => {
    // There is no "unsupported" tier: the content script drives any element.
    for (const p of PROVIDERS) {
      expect(['full-sync', 'approximate', 'extension', 'generic']).toContain(p.capability);
    }
  });
});

describe('cast capability descriptors', () => {
  it('gives every provider a descriptor with an honest reason when it cannot cast', () => {
    for (const p of PROVIDERS) {
      if (p.cast.native) {
        expect(p.cast.buttons.length).toBeGreaterThan(0);
      } else {
        expect(p.cast.reason.length).toBeGreaterThan(0);
        expect(p.cast.reason).not.toMatch(/undefined|null/);
      }
    }
  });

  it('exposes YouTube as natively castable, with selectors as data', () => {
    const cast = castCapabilityFor('https://www.youtube.com/watch?v=x');
    expect(cast.native).toBe(true);
    expect(cast.buttons).toContain('.ytp-remote-button');
    expect(cast.reveal).toContain('.ytp-overflow-button');
  });

  it('never claims a protected video service can be cast by Gather', () => {
    for (const id of ['netflix', 'primevideo', 'disneyplus', 'max', 'hulu', 'crunchyroll']) {
      expect(providerById(id)?.cast.native).toBe(false);
    }
  });

  it('offers the generic explanation on unknown sites', () => {
    const cast = castCapabilityFor('https://example.com/');
    expect(cast.native).toBe(false);
    expect(cast.buttons).toEqual([]);
    expect(cast.reason).toContain('Cast…');
  });
});
