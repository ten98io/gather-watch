// @vitest-environment jsdom
/**
 * THE STAGE'S FULLSCREEN — which since the 2026-08-20 unification IS the
 * immersive/theater mode (DESIGN.md §11 D1.1): one local latch, entered by
 * the transport control, the share-stage control and `F`, with true browser
 * fullscreen as the ENHANCEMENT the latch asks for where the platform grants
 * it. The room had no fullscreen at all before this file's first version
 * (lib/player/youtube.ts set `fs: 0` next to a comment claiming the room's
 * chrome handled it, and nothing did).
 *
 * What is pinned here is the shape the unified control has to have:
 *   - the control is ALWAYS OFFERED, because the mode is the LAYOUT and works
 *     where the platform cannot fullscreen (iOS Safari has no
 *     `Element.prototype.requestFullscreen`; an embedded document can have
 *     the API and be forbidden to use it). On those platforms activating it
 *     enters the layout and asks the browser for nothing — offered and
 *     throwing would be worse than either;
 *   - the element it fullscreens is the whole stage SECTION, so the transport,
 *     the shield, the overlays and the immersive chrome go with the picture;
 *   - the control reports the MODE (the viewer's own latch, honest the moment
 *     they flip it); the browser's answer is still read back from
 *     `fullscreenchange`, because an exit the user performed out from under
 *     us (Escape, F11, the browser's own control) must take the mode with it.
 *
 * jsdom, and jsdom has no Fullscreen API — which makes it the exact fixture
 * for the iOS case. The capable cases install a stub that records calls and
 * does NOT fire `fullscreenchange` on its own, so "we asked" and "the browser
 * agreed" stay separable.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef, Room } from '@gather/contracts';

// jsdom has no media pipeline; every claim here is about chrome, so the
// adapters are reduced to something that constructs and reports nothing.
class FakeAdapter {
  readonly kind = 'native';
  /** Real enough for the captions effect, which reads `textTracks` off it. */
  mediaElement: HTMLVideoElement = document.createElement('video');
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
    return 120_000;
  }
  destroy(): void {}
}
vi.mock('@/lib/player/native', () => ({ NativeAdapter: FakeAdapter }));
vi.mock('@/lib/player/youtube', () => ({ YouTubeAdapter: FakeAdapter }));
vi.mock('@/lib/player/soundcloud', () => ({ SoundCloudAdapter: FakeAdapter }));
vi.mock('@/lib/player/vimeo', () => ({ VimeoAdapter: FakeAdapter }));
vi.mock('@/lib/player/embed', () => ({ EmbedAdapter: FakeAdapter }));

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { resetImmersive } = await import('@/components/room/ImmersiveStage');
const { ROOM_ID, makeMember, makeRoom, playbackFor, queueItem } = await import(
  './helpers/room-render'
);

const h = React.createElement;
const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };

/** Records what the page ASKED the browser for, and answers `fullscreenElement`
 *  from its own bookkeeping. Deliberately silent: a real browser fires
 *  `fullscreenchange` itself, and the cases below fire it by hand so that the
 *  request and the confirmation are two separate events. */
interface FullscreenStub {
  requests: Element[];
  exits: number;
  /** What `document.fullscreenElement` answers. */
  current: Element | null;
  confirm(): void;
}

function installFullscreenApi(enabled = true): FullscreenStub {
  const stub: FullscreenStub = {
    requests: [],
    exits: 0,
    current: null,
    confirm() {
      document.dispatchEvent(new Event('fullscreenchange'));
    },
  };
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: enabled });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => stub.current,
  });
  Element.prototype.requestFullscreen = function (this: Element): Promise<void> {
    stub.requests.push(this);
    stub.current = this;
    return Promise.resolve();
  };
  document.exitFullscreen = (): Promise<void> => {
    stub.exits += 1;
    stub.current = null;
    return Promise.resolve();
  };
  return stub;
}

function removeFullscreenApi(): void {
  Reflect.deleteProperty(document, 'fullscreenEnabled');
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(Element.prototype, 'requestFullscreen');
  Reflect.deleteProperty(document, 'exitFullscreen');
}

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

function buttonByLabel(pattern: RegExp): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find((b) =>
      pattern.test(b.getAttribute('aria-label') ?? ''),
    ) ?? null
  );
}

/** Playback locked to the host — fullscreen is this viewer's own screen and
 *  must not be gated by it. */
function hostOnlyRoom(): Room {
  const base = makeRoom('watch');
  return { ...base, policies: { ...base.policies, playbackControl: 'host' } };
}

describe('true browser fullscreen for the stage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The latch is a module store (three owners across two subtrees) and a
    // bare StagePane never resets it — the shell does, and there is no shell
    // here. Left dirty, one case's mode leaks into the next one's mount.
    resetImmersive();
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
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    removeFullscreenApi();
  });

  async function mount(
    room: Room = makeRoom('watch'),
    over: { shareLive?: boolean } = {},
  ): Promise<void> {
    const items = [queueItem(MP4, 'a clip')];
    const member = makeMember('member');
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room, member, roomId: ROOM_ID, lastEventSeq: 0 } as never,
          h(
            Seeded,
            {
              patch: {
                playback: playbackFor(MP4, 0),
                queue: { items, version: 1 },
                ...(over.shareLive === true
                  ? {
                      restream: {
                        active: true,
                        hostUserId: member.userId,
                        startedAt: 1,
                        viewerCount: 0,
                        uplinkQuality: null,
                      },
                    }
                  : {}),
              },
            },
            h(StagePane, { roomId: ROOM_ID }),
          ),
        ),
      );
    });
  }

  it('offers the control even where the platform has no fullscreen — the mode is the layout', async () => {
    // jsdom as shipped == iOS Safari on iPhone for this purpose: no
    // `Element.prototype.requestFullscreen` at all. The control used to be
    // withheld here; now it enters the immersive LAYOUT and simply asks the
    // browser for nothing — reaching the assertion without a throw is half
    // the claim.
    await mount();
    const btn = buttonByLabel(/^fullscreen/i);
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.click();
    });
    expect(buttonByLabel(/^exit fullscreen/i)).not.toBeNull();
  });

  it('enters the layout but asks the browser for nothing where fullscreen is forbidden', async () => {
    // An embedded document whose embedder omitted allow="fullscreen": the
    // method exists and every call rejects. useFullscreen's availability
    // guard is what keeps the request count at zero — the mode itself is
    // still this viewer's to have.
    const fs = installFullscreenApi(false);
    await mount();
    await act(async () => {
      buttonByLabel(/^fullscreen/i)?.click();
    });
    expect(buttonByLabel(/^exit fullscreen/i)).not.toBeNull();
    expect(fs.requests).toHaveLength(0);
  });

  it('offers it where the platform can, to a member who may not press play', async () => {
    installFullscreenApi();
    await mount(hostOnlyRoom());
    const btn = buttonByLabel(/fullscreen/i);
    expect(btn?.getAttribute('aria-label')).toBe('Fullscreen (F)');
    expect(btn?.disabled).toBe(false);
  });

  it('keeps a fullscreen control during a screen share, where the transport is withheld', async () => {
    // The transport bar deliberately disappears while a share is on stage, and
    // the fullscreen control lived in it — so the one moment a whole screen is
    // exactly what a viewer wants was the one moment the button did not exist.
    // The F key worked the entire time; a key nobody is told about is not an
    // affordance.
    installFullscreenApi();
    await mount(makeRoom('watch'), { shareLive: true });
    // The transport is genuinely gone…
    expect(buttonByLabel(/^(Play|Pause)/)).toBeNull();
    // …and fullscreen survives on the share stage itself.
    const btn = buttonByLabel(/^fullscreen/i);
    expect(btn).not.toBeNull();
  });

  it('the share-stage control enters the layout too where the platform cannot fullscreen', async () => {
    await mount(makeRoom('watch'), { shareLive: true });
    const btn = buttonByLabel(/^fullscreen/i);
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.click();
    });
    // No API to call and nothing thrown — the mode is on regardless.
    expect(buttonByLabel(/^exit fullscreen/i)).not.toBeNull();
  });

  it('fullscreens the whole stage section, so the transport goes with it', async () => {
    const fs = installFullscreenApi();
    await mount();
    await act(async () => {
      buttonByLabel(/fullscreen/i)?.click();
    });
    // Not the <video>: fullscreening that alone strands the transport bar, the
    // shield and every overlay behind the top layer.
    expect(fs.requests).toHaveLength(1);
    expect(fs.requests[0]?.getAttribute('aria-label')).toBe('Stage');
    expect(fs.requests[0]?.tagName).toBe('SECTION');
  });

  it('claims the MODE at once, and still sends the browser the real request', async () => {
    // The control reports the viewer's own latch — honest the moment they
    // flip it, with or without a top layer. What must NOT be assumed is the
    // browser's side: the request is recorded here and `fullscreenchange` is
    // still the only thing that marks the top layer as actually held (the
    // Escape case below is where that distinction pays).
    const fs = installFullscreenApi();
    await mount();
    await act(async () => {
      buttonByLabel(/^fullscreen/i)?.click();
    });
    const btn = buttonByLabel(/^exit fullscreen/i);
    expect(btn?.getAttribute('aria-label')).toBe('Exit fullscreen (F)');
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(fs.requests).toHaveLength(1);
  });

  it('follows an exit the USER performed — Escape, F11, the browser’s own button', async () => {
    const fs = installFullscreenApi();
    await mount();
    await act(async () => {
      buttonByLabel(/fullscreen/i)?.click();
    });
    await act(async () => {
      fs.confirm();
    });
    expect(buttonByLabel(/fullscreen/i)?.getAttribute('aria-label')).toBe('Exit fullscreen (F)');

    // Escape is the browser's: it leaves the top layer with no keydown of ours
    // involved and reports it as `fullscreenchange`.
    await act(async () => {
      fs.current = null;
      fs.confirm();
    });
    expect(buttonByLabel(/fullscreen/i)?.getAttribute('aria-label')).toBe('Fullscreen (F)');
    expect(fs.exits).toBe(0);
  });

  it('exits when the control is pressed again', async () => {
    const fs = installFullscreenApi();
    await mount();
    await act(async () => {
      buttonByLabel(/fullscreen/i)?.click();
      fs.confirm();
    });
    await act(async () => {
      buttonByLabel(/fullscreen/i)?.click();
    });
    expect(fs.exits).toBe(1);
    expect(fs.requests).toHaveLength(1);
  });

  it('enters and leaves on F (DESIGN.md §11 D1.1)', async () => {
    const fs = installFullscreenApi();
    await mount(hostOnlyRoom());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    });
    expect(fs.requests).toHaveLength(1);

    await act(async () => {
      fs.confirm();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    });
    expect(fs.exits).toBe(1);
  });

  it('F enters the layout, not a crash, where the API is absent', async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    });
    // Reaching here at all is half the assertion: an unguarded call would
    // have thrown on a missing `Element.prototype.requestFullscreen`. The
    // other half is that the key did its job anyway — the mode is the layout.
    expect(buttonByLabel(/^exit fullscreen/i)).not.toBeNull();

    // …and Escape leaves it, because with no top layer there is no browser
    // exit to defer to (D1.1: Esc exits).
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(buttonByLabel(/^exit fullscreen/i)).toBeNull();
    expect(buttonByLabel(/^fullscreen/i)).not.toBeNull();
  });

  it('leaves fullscreen for a dialog, which portals outside the top layer', async () => {
    // components/ui/dialog.tsx portals to document.body, and the fullscreen top
    // layer paints over the whole document — a dialog opened from inside
    // fullscreen would simply not be on screen.
    const fs = installFullscreenApi();
    await mount();
    await act(async () => {
      buttonByLabel(/fullscreen/i)?.click();
      fs.confirm();
    });
    const share = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Share screen',
    );
    await act(async () => {
      share?.click();
    });
    expect(fs.exits).toBe(1);
  });

  it('the immersive MODE survives the share dialog — only browser fullscreen is lent out', async () => {
    // The dialog's exit arrives as the same `fullscreenchange` a user's Escape
    // does, and reading it as "the user left" collapsed the entire immersive
    // layout the moment anyone pressed Share screen inside it: header and rail
    // back, chat sidebar and call pills unmounted, call tiles remounted. The
    // reviewer proved it with exactly this sequence; the separate act() blocks
    // are load-bearing — the exit request runs in a passive effect AFTER the
    // click, so folding these together never observes fullscreen.active=true.
    const fs = installFullscreenApi();
    const { useImmersive } = await import('@/components/room/ImmersiveStage');
    await mount();
    await act(async () => {
      buttonByLabel(/fullscreen/i)?.click();
    });
    await act(async () => {
      fs.confirm();
    });
    expect(useImmersive.getState().active).toBe(true);

    const share = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Share screen',
    );
    await act(async () => {
      share?.click();
    });
    await act(async () => {
      fs.confirm(); // the browser acknowledges the exit the dialog asked for
    });

    expect(useImmersive.getState().active).toBe(true);

    // Closing the dialog gives the screen back: fullscreen is re-requested.
    const before = fs.requests.length;
    const scrim = document.querySelector('[aria-label="Close dialog"]') as HTMLButtonElement | null;
    await act(async () => {
      scrim?.click();
    });
    expect(fs.requests.length).toBeGreaterThan(before);
    expect(useImmersive.getState().active).toBe(true);
  });
});
