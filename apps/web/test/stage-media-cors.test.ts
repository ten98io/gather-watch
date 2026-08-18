// @vitest-environment jsdom
/**
 * CROSS-ORIGIN MEDIA MUST PLAY.
 *
 * Both stage media elements carried `crossOrigin="anonymous"`, unconditionally.
 * That attribute is not a preference — it turns the media fetch into a CORS
 * request outright, so every direct .mp4 and .mp3 from a host that does not
 * send Access-Control-Allow-Origin (most of the web) failed to load at all: a
 * black stage, or silence, for content the browser would otherwise have played.
 *
 * What it bought was canvas/WebAudio access to CROSS-ORIGIN media for two
 * decorations — the ambient glow and the listen visualiser — both of which
 * already document a fallback for exactly this case. So the trade was playing
 * nothing in order to tint something.
 *
 * Removing it moves the hazard to the visualiser, which is why the same-origin
 * guard is tested right beside it: `createMediaElementSource` does not fail on
 * a cross-origin element, it succeeds and outputs SILENCE while permanently
 * routing the element's audio through the graph.
 */
import { describe, expect, it } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import {
  h,
  makeMember,
  makeRoom,
  playbackFor,
  queueItem,
  renderInRoom,
} from './helpers/room-render';

const { StagePane } = await import('@/components/stage/StagePane');
const { canTapMediaElement } = await import('@/components/stage/ListenStage');

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };
const MP3: MediaRef = { kind: 'url', url: 'https://cdn.example/song.mp3', mime: 'audio/mpeg' };

const LATER: MediaRef = { kind: 'url', url: 'https://cdn.example/next.mp3', mime: 'audio/mpeg' };

function renderStage(mediaRef: MediaRef): string {
  const room = makeRoom('watch');
  const items = [queueItem(mediaRef, 'Something direct'), queueItem(LATER, 'And another')];
  return renderInRoom(
    room,
    makeMember('host'),
    { playback: playbackFor(mediaRef, 0), queue: { items, version: 1 } },
    h(StagePane, { roomId: room.id }),
  );
}

describe('the stage does not force a CORS fetch on the media it plays', () => {
  it('mounts the video element without crossOrigin', () => {
    const html = renderStage(MP4);
    expect(html).toContain('aria-label="Shared video"');
    expect(html).not.toContain('crossorigin');
    expect(html).not.toContain('crossOrigin');
  });

  it('mounts the listen room’s audio element without it either', () => {
    const html = renderStage(MP3);
    // The listen composition is chosen by the item, so this really is the
    // hidden <video> that plays an mp3.
    expect(html).toContain('Up next');
    expect(html).not.toContain('crossorigin');
    expect(html).not.toContain('crossOrigin');
  });
});

describe('the visualiser only taps media it is allowed to tap', () => {
  const here = window.location.origin;

  it('taps same-origin media', () => {
    expect(canTapMediaElement({ currentSrc: `${here}/media/take.mp3` })).toBe(true);
  });

  it('refuses cross-origin media, which WebAudio would silently mute', () => {
    expect(canTapMediaElement({ currentSrc: 'https://cdn.example/song.mp3' })).toBe(false);
  });

  it('taps hls.js MSE playback, whose blob: URL this document minted', () => {
    expect(canTapMediaElement({ currentSrc: `blob:${here}/2f0c-*` })).toBe(true);
  });

  it('refuses an element with no source yet, rather than guessing', () => {
    expect(canTapMediaElement({ currentSrc: '', src: '' })).toBe(false);
    expect(canTapMediaElement({})).toBe(false);
  });

  it('reads currentSrc first — src is what was ASKED for, currentSrc what loaded', () => {
    expect(
      canTapMediaElement({ currentSrc: 'https://cdn.example/song.mp3', src: `${here}/x.mp3` }),
    ).toBe(false);
  });

  it('refuses an opaque origin', () => {
    expect(canTapMediaElement({ currentSrc: 'data:audio/mpeg;base64,AAAA' })).toBe(false);
  });
});
