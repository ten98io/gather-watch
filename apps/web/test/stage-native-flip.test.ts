// @vitest-environment jsdom
/**
 * The adapter must be re-bound when the stage composition flips between the
 * music and video layouts (an mp3 → mp4 queue advance): both are the SAME
 * adapter kind ('native'), but each composition mounts its <video> in a
 * different container, so a lifecycle keyed on kind alone kept driving the
 * unmounted element — black stage, audio from a node outside the document,
 * and the sync engine correcting a player nobody could see.
 *
 * Client-rendered (jsdom), not the SSR harness: the bug lives in an effect's
 * dependency array, and effects never run under renderToStaticMarkup.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from '@gather/contracts';

// A recording stand-in for every adapter the stage can construct. jsdom has no
// real media pipeline, so the assertion is about BINDING: which element each
// adapter instance was created around, and whether it was still in the
// document.
const constructed: Array<{ el: HTMLElement | null; connectedAtBirth: boolean }> = [];
class FakeAdapter {
  readonly kind = 'native';
  mediaElement: HTMLElement | null;
  constructor(el: HTMLElement | null = null) {
    this.mediaElement = el;
    constructed.push({ el, connectedAtBirth: el?.isConnected === true });
  }
  on(): () => void {
    return () => undefined;
  }
  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(): void {}
  setRate(): void {}
  setMuted(): void {}
  isMuted(): boolean {
    return false;
  }
  setVolume(): void {}
  setDuck(): void {}
  positionMs(): number {
    return 0;
  }
  durationMs(): number {
    return 0;
  }
  destroy(): void {}
}
vi.mock('@/lib/player/native', () => ({ NativeAdapter: FakeAdapter }));
vi.mock('@/lib/player/youtube', () => ({ YouTubeAdapter: FakeAdapter }));
vi.mock('@/lib/player/soundcloud', () => ({ SoundCloudAdapter: FakeAdapter }));
vi.mock('@/lib/player/vimeo', () => ({ VimeoAdapter: FakeAdapter }));
vi.mock('@/lib/player/embed', () => ({ EmbedAdapter: FakeAdapter }));

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { ROOM_ID, makeMember, makeRoom, playbackFor, queueItem } = await import(
  './helpers/room-render'
);

const MP3: MediaRef = { kind: 'url', url: 'https://cdn.example/track.mp3', mime: 'audio/mpeg' };
const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };

const h = React.createElement;

function Seeded({
  patch,
  children,
}: {
  patch: Record<string, unknown>;
  children?: React.ReactNode;
}) {
  const connection = useRoomConnection();
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

// jsdom ships no matchMedia; the reduced-motion and hover hooks read it at
// mount. A constant no-match is the right stub — this test is about adapter
// binding, not media queries.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe('native adapter across a music/video composition flip', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    constructed.length = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('re-binds to the newly mounted element instead of driving a detached one', async () => {
    const items = [queueItem(MP3, 'a song'), queueItem(MP4, 'a clip')];
    const render = (index: number, ref: MediaRef): React.ReactElement =>
      h(
        RoomProvider,
        { room: makeRoom('watch'), member: makeMember('host'), roomId: ROOM_ID } as never,
        h(
          Seeded,
          {
            patch: {
              playback: { ...playbackFor(ref, index), playing: false },
              queue: { items, version: 1 },
            },
          },
          h(StagePane, { roomId: ROOM_ID }),
        ),
      );

    await act(async () => {
      root.render(render(0, MP3));
    });
    const afterMusic = constructed.length;
    expect(afterMusic).toBeGreaterThan(0);

    await act(async () => {
      root.render(render(1, MP4));
    });

    // The flip MUST construct a fresh adapter (the old one held the music
    // composition's element), and it must be born onto an element that is
    // actually in the document.
    expect(constructed.length).toBeGreaterThan(afterMusic);
    const latest = constructed[constructed.length - 1];
    expect(latest?.connectedAtBirth).toBe(true);
    expect(latest?.el?.isConnected).toBe(true);
  });
});
