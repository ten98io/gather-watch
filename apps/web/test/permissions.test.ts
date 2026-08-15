import { describe, expect, it } from 'vitest';
import { canAct, formatMs, mediaRefFromUrl } from '@/lib/permissions';

describe('canAct', () => {
  it('ranks host > moderator > member > guest against policy levels', () => {
    expect(canAct('everyone', 'guest')).toBe(true);
    expect(canAct('everyone', 'host')).toBe(true);
    expect(canAct('mods', 'member')).toBe(false);
    expect(canAct('mods', 'moderator')).toBe(true);
    expect(canAct('mods', 'host')).toBe(true);
    expect(canAct('host', 'moderator')).toBe(false);
    expect(canAct('host', 'host')).toBe(true);
  });
});

describe('mediaRefFromUrl', () => {
  it('parses YouTube watch/shorts/youtu.be links', () => {
    expect(mediaRefFromUrl('https://www.youtube.com/watch?v=abc123XYZ')).toEqual({
      kind: 'youtube',
      videoId: 'abc123XYZ',
    });
    expect(mediaRefFromUrl('https://youtube.com/shorts/abc123XYZ')).toEqual({
      kind: 'youtube',
      videoId: 'abc123XYZ',
    });
    expect(mediaRefFromUrl('https://youtu.be/abc123XYZ')).toEqual({
      kind: 'youtube',
      videoId: 'abc123XYZ',
    });
  });

  it('infers mime from direct media URLs', () => {
    expect(mediaRefFromUrl('https://cdn.example.com/song.mp3')).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/song.mp3',
      mime: 'audio/mpeg',
    });
    expect(mediaRefFromUrl('https://cdn.example.com/stream.m3u8?tok=1')).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/stream.m3u8?tok=1',
      mime: 'application/x-mpegURL',
    });
    expect(mediaRefFromUrl('https://cdn.example.com/clip.webm')).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/clip.webm',
      mime: 'video/webm',
    });
  });

  it('rejects non-URLs', () => {
    expect(mediaRefFromUrl('not a url')).toBeNull();
    expect(mediaRefFromUrl('')).toBeNull();
    expect(mediaRefFromUrl('ftp://old.example/x.mp4')).toBeNull();
  });
});

describe('formatMs', () => {
  it('formats m:ss', () => {
    expect(formatMs(0)).toBe('0:00');
    expect(formatMs(61_500)).toBe('1:02');
    expect(formatMs(-5)).toBe('0:00');
  });
});
