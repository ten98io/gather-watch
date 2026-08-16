import { describe, expect, it } from 'vitest';
import { providerForUrl } from '../src/providers';

describe('providerForUrl', () => {
  it('classifies API-tier providers', () => {
    expect(providerForUrl('https://www.youtube.com/watch?v=x').id).toBe('youtube');
    expect(providerForUrl('https://music.youtube.com/watch?v=x').id).toBe('youtubemusic');
    expect(providerForUrl('https://soundcloud.com/a/b').id).toBe('soundcloud');
    expect(providerForUrl('https://vimeo.com/123').id).toBe('vimeo');
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
});
