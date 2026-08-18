/**
 * mediaKindFor — the one classifier the stage composition, theater gate,
 * queue icon and presence idle state all hang off. The table covers every
 * MediaRef kind (contracts entities.ts) plus every embed provider, so a new
 * union member or provider fails here first and gets classified on purpose.
 */
import { describe, expect, it } from 'vitest';
import type { AssetId, MediaRef } from '@gather/contracts';
import { mediaKindFor, presenceIdleStateFor } from '@/lib/media-kind';

function embed(provider: 'spotify' | 'applemusic' | 'tidal' | 'deezer'): MediaRef {
  return {
    kind: 'embed',
    provider,
    embedUrl: `https://example.com/${provider}/embed`,
    title: null,
  };
}

describe('mediaKindFor', () => {
  it('classifies nothing playing as null', () => {
    expect(mediaKindFor(null)).toBeNull();
  });

  const table: Array<[string, MediaRef, 'music' | 'video']> = [
    ['soundcloud', { kind: 'soundcloud', url: 'https://soundcloud.com/a/b' }, 'music'],
    ['youtube', { kind: 'youtube', videoId: 'dQw4w9WgXcQ' }, 'video'],
    // Same id space as YouTube video — only the parse-time flag knows the
    // link came from music.youtube.com. Without it, every YT Music track got
    // the video stage and 'watching' presence.
    ['youtube music', { kind: 'youtube', videoId: 'dQw4w9WgXcQ', music: true }, 'music'],
    ['vimeo', { kind: 'vimeo', videoId: '123456' }, 'video'],
    ['hls upload', { kind: 'hls', assetId: 'asset-1' as AssetId, url: 'https://cdn.example/v.m3u8' }, 'video'],
    ['direct audio url', { kind: 'url', url: 'https://cdn.example/t.mp3', mime: 'audio/mpeg' }, 'music'],
    ['direct video url', { kind: 'url', url: 'https://cdn.example/v.mp4', mime: 'video/mp4' }, 'video'],
    // An arbitrary page is unknowable until someone's extension opens it, so
    // it takes the default half of the split: the video stage, and 'watching'
    // presence. Nothing here guesses from the url.
    ['arbitrary web page', { kind: 'page', url: 'https://blog.example/the-film' }, 'video'],
    ['spotify embed', embed('spotify'), 'music'],
    ['apple music embed', embed('applemusic'), 'music'],
    ['tidal embed', embed('tidal'), 'music'],
    ['deezer embed', embed('deezer'), 'music'],
  ];

  it.each(table)('classifies %s', (_name, ref, expected) => {
    expect(mediaKindFor(ref)).toBe(expected);
  });
});

describe('presenceIdleStateFor', () => {
  it('reports listening for music', () => {
    expect(presenceIdleStateFor({ kind: 'soundcloud', url: 'https://soundcloud.com/a/b' })).toBe(
      'listening',
    );
    expect(presenceIdleStateFor(embed('spotify'))).toBe('listening');
  });

  it('reports watching for video', () => {
    expect(presenceIdleStateFor({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' })).toBe('watching');
  });

  it('defaults to watching when nothing plays — the server default', () => {
    expect(presenceIdleStateFor(null)).toBe('watching');
  });
});
