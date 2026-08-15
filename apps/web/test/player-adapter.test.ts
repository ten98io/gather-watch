import { describe, expect, it } from 'vitest';
import type { MediaRef } from '@playin/contracts';
import { adapterKindFor, isHlsRef, mediaKey } from '@/lib/player/adapter';

describe('adapterKindFor', () => {
  it('routes youtube to the iframe adapter, everything else native', () => {
    expect(adapterKindFor(null)).toBeNull();
    expect(adapterKindFor({ kind: 'youtube', videoId: 'abc123' })).toBe('youtube');
    expect(adapterKindFor({ kind: 'url', url: 'https://x/y.mp4', mime: 'video/mp4' })).toBe('native');
    expect(
      adapterKindFor({ kind: 'hls', assetId: 'a1' as never, url: 'https://x/y.m3u8' }),
    ).toBe('native');
  });
});

describe('isHlsRef', () => {
  it('detects HLS by kind, mime, or extension', () => {
    expect(isHlsRef({ kind: 'hls', assetId: 'a1' as never, url: 'https://x/y' })).toBe(true);
    expect(isHlsRef({ kind: 'url', url: 'https://x/y', mime: 'application/x-mpegURL' })).toBe(true);
    expect(isHlsRef({ kind: 'url', url: 'https://x/y.m3u8?tok=1', mime: 'video/mp4' })).toBe(true);
    expect(isHlsRef({ kind: 'url', url: 'https://x/y.mp4', mime: 'video/mp4' })).toBe(false);
  });
});

describe('mediaKey', () => {
  it('identifies media identity + epoch', () => {
    expect(mediaKey(null, undefined)).toBe('none');
    expect(mediaKey({ kind: 'youtube', videoId: 'v1' } as MediaRef, 3)).toBe('youtube:v1:3');
    expect(mediaKey({ kind: 'url', url: 'https://x/y.mp4', mime: 'video/mp4' }, 1)).toBe(
      'url:https://x/y.mp4:1',
    );
  });
});
