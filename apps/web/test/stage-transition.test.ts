// @vitest-environment jsdom
/**
 * C11 — THE GAP BETWEEN TWO ITEMS.
 *
 * DESIGN.md §6 promises "page transitions: fade + 12px rise", and
 * `packages/design/src/scales.ts` has carried `pageRisePx: 12` with not one
 * consumer anywhere in the app. On the stage the absence showed as something
 * worse than a missing flourish: a track change across kinds tears the old
 * adapter down and builds a new one, and for that whole stretch — plus however
 * long the new source takes to start — the stage was the bare void. EmptyStage
 * only ever rendered for NO media, and the shield's backdrop only for
 * paused/blocked, so "loading the next thing" had no state at all.
 *
 * Two claims, and reduced motion is not an afterthought in either: §9 says
 * positional motion goes away, and a rise is positional motion.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { motion } from '@gather/design';
import type { MediaRef } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in for every adapter: it reports nothing unless the test says so. */
class SilentAdapter {
  static live: SilentAdapter | null = null;
  readonly kind = 'youtube';
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor() {
    SilentAdapter.live = this;
  }
  on(evt: string, cb: () => void): () => void {
    let set = this.listeners.get(evt);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(evt, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }
  emit(evt: string): void {
    for (const cb of [...(this.listeners.get(evt) ?? [])]) cb();
  }
  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(): void {}
  setRate(): void {}
  positionMs(): number {
    return 0;
  }
  durationMs(): number {
    return 0;
  }
  setMuted(): void {}
  isMuted(): boolean {
    return false;
  }
  setVolume(): void {}
  setDuck(): void {}
  destroy(): void {}
}

vi.mock('@/lib/player/native', () => ({ NativeAdapter: SilentAdapter }));
vi.mock('@/lib/player/youtube', () => ({ YouTubeAdapter: SilentAdapter }));
vi.mock('@/lib/player/soundcloud', () => ({ SoundCloudAdapter: SilentAdapter }));
vi.mock('@/lib/player/vimeo', () => ({ VimeoAdapter: SilentAdapter }));
vi.mock('@/lib/player/embed', () => ({ EmbedAdapter: SilentAdapter }));

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { ROOM_ID, makeMember, makeRoom, queueItem } = await import('./helpers/room-render');

const h = React.createElement;
const VIDEO: MediaRef = { kind: 'youtube', videoId: 'arriving' };

function Seeded({ patch, children }: { patch: Record<string, unknown>; children?: React.ReactNode }) {
  const connection = useRoomConnection();
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

function stubMatchMedia(reducedMotion: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('the stage between two items', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    SilentAdapter.live = null;
    stubMatchMedia(false);
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

  /** Renders the stage on an item the room is playing and this device is not. */
  async function mountArriving(): Promise<SilentAdapter> {
    const patch = {
      playback: {
        mediaRef: VIDEO,
        positionMs: 0,
        rate: 1,
        playing: true,
        serverTs: Date.now(),
        seq: 4,
        queueIndex: 0,
      },
      queue: { items: [queueItem(VIDEO, 'The one arriving')], version: 1 },
    };
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member: makeMember('host'), roomId: ROOM_ID } as never,
          h(Seeded, { patch }, h(StagePane, { roomId: ROOM_ID })),
        ),
      );
    });
    const player = SilentAdapter.live;
    if (player === null) throw new Error('the stage never built a player');
    return player;
  }

  it('says what is coming instead of showing the void', async () => {
    await mountArriving();
    expect(host.textContent).toContain('The one arriving');
    expect(host.textContent).toContain('Starting…');
  });

  it('gets out of the way the moment the picture starts', async () => {
    const player = await mountArriving();
    await act(async () => {
      player.emit('ready');
      player.emit('playing');
    });
    expect(host.textContent).not.toContain('Starting…');
  });

  it('never covers the play affordance — it is inert and sits below the shield', async () => {
    await mountArriving();
    // Document order lists ancestors first, so the LAST match is the innermost.
    const cue = [...host.querySelectorAll('div')]
      .filter((d) => (d.textContent ?? '').includes('Starting…'))
      .pop();
    expect(cue).toBeDefined();
    const layer = cue?.closest('.pointer-events-none');
    expect(layer).not.toBeNull();
    // z-0 against the shield's z-10: one play affordance, still clickable.
    expect(layer?.className).toContain('z-0');
  });

  it('fades and rises by the token, not by a number someone typed', async () => {
    await mountArriving();
    const cue = [...host.querySelectorAll('div')].find((d) =>
      d.className.includes('animate-fade-in'),
    );
    expect(cue).toBeDefined();
    // The rise starts displaced by exactly `pageRisePx` and transitions home.
    expect(cue?.getAttribute('style') ?? '').toContain(`translateY(${String(motion.pageRisePx)}px)`);
    expect(cue?.getAttribute('style') ?? '').toContain(`${String(motion.microMs)}ms`);
  });

  it('drops the motion entirely under prefers-reduced-motion', async () => {
    stubMatchMedia(true);
    await mountArriving();

    // The message is still there — reduced motion removes the movement, never
    // the information.
    expect(host.textContent).toContain('Starting…');
    const cue = [...host.querySelectorAll('div')].find((d) =>
      (d.textContent ?? '').includes('Starting…'),
    );
    expect(cue).toBeDefined();
    const moving = [...host.querySelectorAll('div')].filter(
      (d) =>
        d.className.includes('animate-fade-in') ||
        (d.getAttribute('style') ?? '').includes('translateY'),
    );
    expect(moving).toEqual([]);
  });
});
