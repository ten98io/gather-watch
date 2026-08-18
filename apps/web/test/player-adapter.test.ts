import { describe, expect, it } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import { adapterKindFor, isFullSyncKind, isHlsRef, mediaKey, stageGate } from '@/lib/player/adapter';

describe('adapterKindFor', () => {
  it('routes youtube to the iframe adapter, everything else native', () => {
    expect(adapterKindFor(null)).toBeNull();
    expect(adapterKindFor({ kind: 'youtube', videoId: 'abc123' })).toBe('youtube');
    expect(adapterKindFor({ kind: 'url', url: 'https://x/y.mp4', mime: 'video/mp4' })).toBe('native');
    expect(
      adapterKindFor({ kind: 'hls', assetId: 'a1' as never, url: 'https://x/y.m3u8' }),
    ).toBe('native');
  });

  /**
   * A page ref is the one MediaRef the web cannot play at all: it is a link to
   * an arbitrary HTML document, and only the extension can drive whatever
   * player that document mounts. 'native' here would hand an HTML URL to a
   * <video> element AND — since isFullSyncKind('native') is true — start the
   * drift engine seeking a player that never loads.
   */
  it('reports a page ref as nothing this browser can play', () => {
    expect(adapterKindFor({ kind: 'page', url: 'https://blog.example.com/the-film' })).toBeNull();
    expect(isFullSyncKind(adapterKindFor({ kind: 'page', url: 'https://blog.example.com/x' }))).toBe(
      false,
    );
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

describe('stageGate', () => {
  const base = { active: true, wantsPlay: false, localPlaying: false, blocked: false };

  it('shows nothing when no provider surface is on screen', () => {
    expect(stageGate({ ...base, active: false })).toBe('none');
    expect(stageGate({ ...base, active: false, wantsPlay: false })).toBe('none');
  });

  it('covers the provider whenever the room is paused', () => {
    expect(stageGate(base)).toBe('paused');
    // Even if this device is somehow still rolling, the room is the truth.
    expect(stageGate({ ...base, localPlaying: true })).toBe('paused');
  });

  it('stays transparent while playback is actually running', () => {
    expect(stageGate({ ...base, wantsPlay: true, localPlaying: true })).toBe('none');
    // Not started yet, but nothing says it was refused — no premature prompt.
    expect(stageGate({ ...base, wantsPlay: true })).toBe('none');
  });

  it('asks for a gesture only when the browser refused to start', () => {
    expect(stageGate({ ...base, wantsPlay: true, blocked: true })).toBe('blocked');
    // A refusal that has since resolved must not keep the prompt up.
    expect(stageGate({ ...base, wantsPlay: true, blocked: true, localPlaying: true })).toBe('none');
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
