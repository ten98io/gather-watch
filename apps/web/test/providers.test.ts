import { describe, expect, it } from 'vitest';
import { MediaRef } from '@gather/contracts';
import { adapterKindFor, isFullSyncKind, mediaKey } from '@/lib/player/adapter';
import { parseProviderUrl, providerById } from '@/lib/providers';

describe('parseProviderUrl', () => {
  it('parses YouTube + YouTube Music as full-sync youtube refs', () => {
    const yt = parseProviderUrl('https://www.youtube.com/watch?v=abc123XYZ');
    expect(yt?.ref).toEqual({ kind: 'youtube', videoId: 'abc123XYZ' });
    expect(yt?.provider.capability).toBe('full-sync');

    const music = parseProviderUrl('https://music.youtube.com/watch?v=abc123XYZ');
    expect(music?.provider.id).toBe('youtubemusic');
    expect(music?.ref).toEqual({ kind: 'youtube', videoId: 'abc123XYZ' });
  });

  it('parses SoundCloud and Vimeo as full-sync refs', () => {
    const sc = parseProviderUrl('https://soundcloud.com/artist/track-name');
    expect(sc?.ref).toEqual({ kind: 'soundcloud', url: 'https://soundcloud.com/artist/track-name' });
    const vi = parseProviderUrl('https://vimeo.com/123456789');
    expect(vi?.ref).toEqual({ kind: 'vimeo', videoId: '123456789' });
  });

  it('parses Spotify/Apple Music/Tidal/Deezer as honest embeds', () => {
    const sp = parseProviderUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    expect(sp?.ref).toEqual({
      kind: 'embed',
      provider: 'spotify',
      embedUrl: 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
      title: null,
    });
    expect(sp?.provider.capability).toBe('approximate');

    const am = parseProviderUrl('https://music.apple.com/us/album/example/12345');
    expect(am?.ref).toMatchObject({
      kind: 'embed',
      provider: 'applemusic',
      embedUrl: 'https://embed.music.apple.com/us/album/example/12345',
    });

    const ti = parseProviderUrl('https://tidal.com/browse/track/123456');
    expect(ti?.ref).toMatchObject({ provider: 'tidal', embedUrl: 'https://embed.tidal.com/tracks/123456' });

    const dz = parseProviderUrl('https://deezer.com/track/987654');
    expect(dz?.ref).toMatchObject({ provider: 'deezer', embedUrl: 'https://widget.deezer.com/widget/dark/track/987654' });
  });

  it('recognizes DRM services without producing a MediaRef', () => {
    for (const [url, id] of [
      ['https://www.netflix.com/watch/80123456', 'netflix'],
      ['https://www.primevideo.com/detail/XYZ', 'primevideo'],
      ['https://www.disneyplus.com/video/abc', 'disneyplus'],
      ['https://www.max.com/video/abc', 'max'],
      ['https://www.hulu.com/watch/abc', 'hulu'],
    ] as const) {
      const parsed = parseProviderUrl(url);
      expect(parsed?.provider.id).toBe(id);
      expect(parsed?.provider.capability).toBe('extension');
      expect(parsed?.ref).toBeNull();
    }
  });

  it('parses direct media and rejects junk', () => {
    expect(parseProviderUrl('https://cdn.example.com/x.mp3')?.ref).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/x.mp3',
      mime: 'audio/mpeg',
    });
    expect(parseProviderUrl('not a url')).toBeNull();
    expect(parseProviderUrl('https://example.com/page.html')).toBeNull();
  });

  it('every parsed ref passes the contracts MediaRef schema', () => {
    const samples = [
      'https://youtu.be/abc123XYZ',
      'https://soundcloud.com/a/b',
      'https://vimeo.com/123456',
      'https://open.spotify.com/track/abc',
      'https://cdn.example.com/movie.mp4',
    ];
    for (const s of samples) {
      const ref = parseProviderUrl(s)?.ref;
      expect(ref).not.toBeNull();
      expect(() => MediaRef.parse(ref)).not.toThrow();
    }
  });

  it('registry entries are unique and complete', () => {
    const ids = new Set<string>();
    for (const url of [
      'https://youtu.be/abc123XYZ', 'https://music.youtube.com/watch?v=abc123XYZ',
      'https://soundcloud.com/a/b', 'https://vimeo.com/123456',
      'https://open.spotify.com/track/abc', 'https://music.apple.com/us/album/x/1',
      'https://tidal.com/browse/track/1', 'https://deezer.com/track/1',
      'https://www.netflix.com/watch/1', 'https://www.hulu.com/watch/1',
      'https://cdn.example.com/x.mp4',
    ]) {
      const p = parseProviderUrl(url);
      expect(p, url).not.toBeNull();
      ids.add(p!.provider.id);
    }
    expect(ids.size).toBe(11);
    expect(providerById('crunchyroll')?.capability).toBe('extension');
  });
});

describe('adapter routing', () => {
  it('routes each MediaRef kind to its adapter and marks embed as non-synced', () => {
    expect(adapterKindFor({ kind: 'soundcloud', url: 'https://soundcloud.com/a/b' })).toBe('soundcloud');
    expect(adapterKindFor({ kind: 'vimeo', videoId: '1' })).toBe('vimeo');
    expect(
      adapterKindFor({ kind: 'embed', provider: 'spotify', embedUrl: 'https://open.spotify.com/embed/x', title: null }),
    ).toBe('embed');
    expect(isFullSyncKind('soundcloud')).toBe(true);
    expect(isFullSyncKind('vimeo')).toBe(true);
    expect(isFullSyncKind('embed')).toBe(false);
  });

  it('mediaKey covers the new kinds', () => {
    expect(mediaKey({ kind: 'soundcloud', url: 'https://sc/x' }, 2)).toBe('soundcloud:https://sc/x:2');
    expect(mediaKey({ kind: 'vimeo', videoId: '42' }, 1)).toBe('vimeo:42:1');
    expect(
      mediaKey({ kind: 'embed', provider: 'tidal', embedUrl: 'https://embed.tidal.com/tracks/1', title: null }, 5),
    ).toBe('embed:https://embed.tidal.com/tracks/1:5');
  });
});
