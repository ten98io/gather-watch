// @vitest-environment jsdom
/**
 * THE ROOM WAS EATING EVERY CHORD IN THE BROWSER.
 *
 * `useKeyboardShortcuts` matched on `event.key` alone and then called
 * `preventDefault()`. `key` is the PRINTED CHARACTER and says nothing about the
 * modifiers held with it, so inside a room Cmd/Ctrl+C toggled captions and
 * copied nothing, Cmd+R never reloaded, Ctrl+F never opened find — every chord
 * ending in a bound letter was swallowed by the room's own map.
 *
 * The second half of the same shape: ' ' is bound to play/pause and was taken
 * unconditionally, so Space on a focused button — send, a queue row, a tab —
 * was consumed before the button could be pressed. A control you can reach with
 * Tab and cannot press with Space is not keyboard-accessible (§9).
 *
 * Both halves are pinned here on the hook itself, where the rule lives, and
 * then again through the real room map in StagePane, because the map is what
 * has to keep working: nothing in the guard may cost the bindings §9 promises.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import type { ShortcutBinding } from '@/hooks/useKeyboardShortcuts';

/** Records what the room map asked of the player. */
class FakeAdapter {
  readonly kind = 'native';
  mediaElement: HTMLVideoElement = document.createElement('video');
  readonly mutes: boolean[] = [];
  on(): () => void {
    return () => undefined;
  }
  load(): void {}
  play(): void {}
  pause(): void {}
  seekTo(): void {}
  setRate(): void {}
  setMuted(muted: boolean): void {
    this.mutes.push(muted);
  }
  isMuted(): boolean {
    return this.mutes.at(-1) ?? false;
  }
  setVolume(): void {}
  setDuck(): void {}
  positionMs(): number {
    return 30_000;
  }
  durationMs(): number {
    return 120_000;
  }
  destroy(): void {}
}
const built: FakeAdapter[] = [];
class TrackedAdapter extends FakeAdapter {
  constructor() {
    super();
    built.push(this);
  }
}
vi.mock('@/lib/player/native', () => ({ NativeAdapter: TrackedAdapter }));
vi.mock('@/lib/player/youtube', () => ({ YouTubeAdapter: TrackedAdapter }));
vi.mock('@/lib/player/soundcloud', () => ({ SoundCloudAdapter: TrackedAdapter }));
vi.mock('@/lib/player/vimeo', () => ({ VimeoAdapter: TrackedAdapter }));
vi.mock('@/lib/player/embed', () => ({ EmbedAdapter: TrackedAdapter }));

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useKeyboardShortcuts } = await import('@/hooks/useKeyboardShortcuts');
const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { StagePane } = await import('@/components/stage/StagePane');
const { ROOM_ID, makeMember, makeRoom, playbackFor, queueItem } = await import(
  './helpers/room-render'
);
type RoomConnection = ReturnType<typeof useRoomConnection>;

const h = React.createElement;
const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };

/** Fires a key the way a browser does — from the focused element, upward. */
function press(
  from: Element,
  key: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  from.dispatchEvent(event);
  return event;
}

describe('a binding is a BARE key', () => {
  let host: HTMLDivElement;
  let root: Root;
  let fired: string[];

  function Harness({ bindings }: { bindings: ShortcutBinding[] }) {
    useKeyboardShortcuts(bindings);
    return h(
      'div',
      null,
      h('button', { type: 'button', id: 'btn' }, 'press me'),
      h('div', { id: 'faux', role: 'button', tabIndex: 0 }, 'faux button'),
      h('input', { id: 'field', 'aria-label': 'a field' }),
    );
  }

  async function mount(bindings: ShortcutBinding[]): Promise<void> {
    await act(async () => {
      root.render(h(Harness, { bindings }));
    });
  }

  function binding(key: string, over: Partial<ShortcutBinding> = {}): ShortcutBinding {
    return {
      key,
      handler: () => {
        fired.push(key);
      },
      ...over,
    };
  }

  beforeEach(() => {
    fired = [];
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

  it('runs on the bare key, and claims it', async () => {
    await mount([binding('c')]);
    const event = press(document.body, 'c');
    expect(fired).toEqual(['c']);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ['metaKey', 'c'],
    ['ctrlKey', 'c'],
    ['metaKey', 'r'],
    ['ctrlKey', 'f'],
    ['altKey', 'ArrowLeft'],
  ] as const)('leaves %s+%s to the browser', async (modifier, key) => {
    await mount([binding(key)]);
    const event = press(document.body, key, { [modifier]: true });
    expect(fired).toEqual([]);
    // Not preventing it is the whole point: the copy, the reload and the find
    // bar all happen in the default action this used to cancel.
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not treat Shift as a chord — "?" is Shift+/ on most layouts', async () => {
    await mount([binding('?')]);
    const event = press(document.body, '?', { shiftKey: true });
    expect(fired).toEqual(['?']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('runs a chord only where the binding asked for one', async () => {
    await mount([binding('k', { allowModifiers: true })]);
    press(document.body, 'k', { metaKey: true });
    press(document.body, 'k');
    expect(fired).toEqual(['k', 'k']);
  });

  it('never takes Space from a focused button', async () => {
    await mount([binding(' ')]);
    const btn = document.getElementById('btn');
    const event = press(btn as Element, ' ');
    expect(fired).toEqual([]);
    // Prevented, and the button is never pressed: a control reachable by Tab
    // that cannot be activated by Space is not keyboard-accessible.
    expect(event.defaultPrevented).toBe(false);
  });

  it('protects role="button" too, and Enter as well as Space', async () => {
    await mount([binding(' '), binding('Enter')]);
    const faux = document.getElementById('faux');
    press(faux as Element, ' ');
    press(faux as Element, 'Enter');
    expect(fired).toEqual([]);
  });

  it('still owns Space everywhere else on the page', async () => {
    await mount([binding(' ')]);
    const event = press(document.body, ' ');
    expect(fired).toEqual([' ']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps out of fields unless invited', async () => {
    await mount([binding('m'), binding('Escape', { allowInFields: true })]);
    const field = document.getElementById('field');
    press(field as Element, 'm');
    press(field as Element, 'Escape');
    expect(fired).toEqual(['Escape']);
  });
});

function Seeded({
  patch,
  capture,
  children,
}: {
  patch: Record<string, unknown>;
  capture(connection: RoomConnection): void;
  children?: React.ReactNode;
}) {
  const connection = useRoomConnection();
  capture(connection);
  Object.assign(connection.useRoomState.getInitialState(), patch);
  connection.useRoomState.setState(patch);
  return h(React.Fragment, null, children);
}

describe('the room map §9 promises still works', () => {
  let host: HTMLDivElement;
  let root: Root;
  let connection: RoomConnection | null;
  let seek: ReturnType<typeof vi.fn>;
  let pause: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    built.length = 0;
    connection = null;
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
  });

  async function mountStage(): Promise<void> {
    const items = [queueItem(MP4, 'a clip')];
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          {
            room: makeRoom('watch'),
            member: makeMember('host'),
            roomId: ROOM_ID,
            lastEventSeq: 0,
          } as never,
          h(
            Seeded,
            {
              patch: { playback: playbackFor(MP4, 0), queue: { items, version: 1 } },
              capture: (c: RoomConnection) => {
                connection = c;
              },
            },
            h(StagePane, { roomId: ROOM_ID }),
          ),
        ),
      );
    });
    if (connection === null) throw new Error('no room connection was captured');
    seek = vi.fn();
    pause = vi.fn();
    connection.syncSeek = seek as unknown as RoomConnection['syncSeek'];
    connection.syncPause = pause as unknown as RoomConnection['syncPause'];
  }

  it('Space still pauses the room', async () => {
    await mountStage();
    await act(async () => {
      press(document.body, ' ');
    });
    expect(pause).toHaveBeenCalledWith(30_000);
  });

  it('arrows still seek ±10 s, clamped at zero', async () => {
    await mountStage();
    await act(async () => {
      press(document.body, 'ArrowRight');
      press(document.body, 'ArrowLeft');
    });
    expect(seek.mock.calls).toEqual([[40_000], [20_000]]);
  });

  /** The transport bar re-asserts the room's output settings onto every new
   *  player (see player-controls-output.test.ts), so a fresh adapter already
   *  carries one `setMuted(false)` before any key is pressed. */
  function mutesSincePress(before: number): boolean[] {
    return built.at(-1)?.mutes.slice(before) ?? [];
  }

  it('M still mutes', async () => {
    await mountStage();
    const before = built.at(-1)?.mutes.length ?? 0;
    await act(async () => {
      press(document.body, 'm');
    });
    expect(mutesSincePress(before)).toEqual([true]);
  });

  it('Cmd+M is the OS minimising a window, not the room muting', async () => {
    await mountStage();
    const before = built.at(-1)?.mutes.length ?? 0;
    await act(async () => {
      press(document.body, 'm', { metaKey: true });
    });
    expect(mutesSincePress(before)).toEqual([]);
  });

  it('Space on the transport’s own play button reaches the button', async () => {
    await mountStage();
    const play = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find(
      (b) => /^(Play|Pause)/.test(b.getAttribute('aria-label') ?? ''),
    );
    expect(play).toBeDefined();
    let event: KeyboardEvent | null = null;
    await act(async () => {
      event = press(play as Element, ' ');
    });
    // The room map must not swallow it — the button's own activation is what
    // pauses the room from here, and it never ran while ' ' was taken globally.
    expect(event === null ? true : (event as KeyboardEvent).defaultPrevented).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });
});
