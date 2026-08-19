// @vitest-environment jsdom
/**
 * THE TRANSPORT BAR WAS DEAD WHENEVER THE EXTENSION WAS THE PLAYER.
 *
 * StagePane nulls the adapter kind while the extension drives — two players for
 * one room is the bug that rule exists to prevent — so `adapter` is null and
 * every reading this bar takes off a `PlayerAdapter` had no source: the elapsed
 * time froze at `playback.positionMs`, the length read 0:00, the scrubber was
 * inert and play/pause was disabled outright. The driven tab had been streaming
 * position, length, playing and rate once a second the whole time.
 *
 * `lib/player/extension-driver.ts` decodes that stream and projects it
 * (`extensionPositionMs`) exactly the way the extension's own driver does, and
 * says when it has gone quiet (`extensionTelemetryLive`). Those two are the
 * REAL implementations here — only the two hooks are stood in for, because a
 * store fed by a fake chrome port is proven in extension-playback.test.ts and
 * what is under test here is what the BAR draws from the answer.
 *
 * The honesty half matters as much as the numbers: a tab that stops reporting
 * must not leave a playhead sitting there looking like a paused room, and the
 * output controls must not pretend to reach a player in another tab.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import type { ExtensionPlayback } from '@/lib/player/extension-driver';

vi.mock('@/lib/cast', () => ({
  airPlayAvailable: () => false,
  remotePlaybackAvailable: () => false,
  showAirPlayPicker: () => undefined,
  promptRemotePlayback: () => Promise.resolve(),
  ensureCastFramework: () => Promise.resolve(true),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

/** The two hooks, made settable. Everything else in the module — the
 *  projection, the staleness window, the DRM classification — stays real. */
const ext = vi.hoisted(() => ({
  driving: true,
  provider: null as { id: string; name: string; tier: string } | null,
  playback: null as unknown,
}));
vi.mock('@/lib/player/extension-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/player/extension-driver')>();
  return {
    ...actual,
    useExtensionDriver: () => ({
      state: {
        phase: 'ready' as const,
        extensionVersion: '0.1.0',
        protocolVersion: 1,
        capabilities: ['handoff', 'telemetry'],
        driving: ext.driving,
        connected: true,
        roomId: 'room-static',
        roomName: 'Static test room',
        provider: ext.provider,
        hasMedia: true,
        notice: null,
      },
      checking: false,
      ready: true,
      driving: ext.driving,
      refresh: () => undefined,
      supports: () => true,
      handoff: () => Promise.resolve({ ok: true as const }),
      sendIntent: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve({ ok: true as const }),
    }),
    useExtensionPlayback: () => ext.playback ?? actual.NO_EXTENSION_PLAYBACK,
  };
});

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RoomProvider, useRoomConnection } = await import('@/lib/room-context');
const { PlayerControls } = await import('@/components/stage/PlayerControls');
const { StagePane } = await import('@/components/stage/StagePane');
const { ROOM_ID, makeMember, makeRoom, playbackFor, queueItem } = await import(
  './helpers/room-render'
);
type RoomConnection = ReturnType<typeof useRoomConnection>;

const h = React.createElement;
const PAGE: MediaRef = { kind: 'page', url: 'https://example.com/watch/one' };

/** A frame the driven tab sent `agoMs` ago. */
function telemetry(over: Partial<ExtensionPlayback> & { agoMs?: number } = {}): ExtensionPlayback {
  const { agoMs = 0, ...rest } = over;
  return {
    provider: null,
    capability: 'generic',
    drm: false,
    positionMs: 62_000,
    durationMs: 300_000,
    playing: true,
    rate: 1,
    updatedAt: Date.now() - agoMs,
    ...rest,
  };
}

let connection: RoomConnection | null = null;

function Capture({ children }: { children?: React.ReactNode }) {
  connection = useRoomConnection();
  return h(React.Fragment, null, children);
}

/** [elapsed, length] — the bar's two monospaced readouts, in DOM order. */
function timeReadouts(): string[] {
  return Array.from(document.querySelectorAll('span.font-mono.tabular-nums')).map(
    (el) => el.textContent ?? '',
  );
}

/** Tooltip clones its child with `aria-label = content`, so the scrubber's own
 *  label is the tooltip's sentence, not the bare word. */
function seekInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label^="Seek"]');
}

function buttonByLabel(pattern: RegExp): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find((b) =>
      pattern.test(b.getAttribute('aria-label') ?? ''),
    ) ?? null
  );
}

describe('the transport bar while the extension drives', () => {
  let host: HTMLDivElement;
  let root: Root;
  let pause: ReturnType<typeof vi.fn>;
  let seek: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ext.driving = true;
    ext.provider = null;
    ext.playback = null;
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

  /** The bar exactly as StagePane mounts it under the extension: no adapter. */
  async function mountBar(positionMs = 0): Promise<void> {
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          {
            room: makeRoom('watch'),
            member: makeMember('host'),
            lastEventSeq: 0,
            children: h(
              Capture,
              null,
              h(PlayerControls, {
                adapter: null,
                playback: { ...playbackFor(PAGE, 0), positionMs },
                enabled: true,
                captionsOn: false,
                onToggleCaptions: () => undefined,
                captionsAvailable: false,
                muted: false,
                onMutedChange: () => undefined,
              }),
            ),
          } as never,
        ),
      );
    });
    if (connection === null) throw new Error('no room connection was captured');
    pause = vi.fn();
    seek = vi.fn();
    connection.syncPause = pause as unknown as RoomConnection['syncPause'];
    connection.syncSeek = seek as unknown as RoomConnection['syncSeek'];
  }

  it('takes the elapsed time from the driven tab, projected to now', async () => {
    // The frame is 3 s old and the tab was playing, so 1:02 at capture is 1:05
    // now — the same correction the extension applies to its own samples.
    ext.playback = telemetry({ agoMs: 3_000 });
    await mountBar(0);
    // Frozen at `playback.positionMs`, this read 0:00 forever.
    expect(timeReadouts()[0]).toBe('1:05');
  });

  it('takes the length from the driven tab', async () => {
    ext.playback = telemetry();
    await mountBar();
    expect(timeReadouts()[1]).toBe('5:00');
    expect(seekInput()?.max).toBe('300000');
  });

  it('lets the scrubber move, and seeks the ROOM', async () => {
    ext.playback = telemetry();
    await mountBar();
    const input = seekInput();
    expect(input?.disabled).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '90000');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(seek).toHaveBeenCalledWith(90_000);
  });

  it('refuses to scrub a live stream, which has no length to scrub within', async () => {
    // The content script sends 0 rather than Infinity; 0 is "not known"
    // everywhere in this app, and a live stream never had one to give.
    ext.playback = telemetry({ durationMs: 0 });
    await mountBar();
    expect(seekInput()?.disabled).toBe(true);
    expect(timeReadouts()[1]).toBe('--:--');
  });

  it('says the tab went quiet instead of drawing a playhead', async () => {
    // Older than EXTENSION_TELEMETRY_STALE_MS: four missed frames from a 1 Hz
    // reporter is a tab that has stopped talking.
    ext.playback = telemetry({ agoMs: 10_000 });
    await mountBar();
    expect(host.textContent).toContain('The playing tab stopped reporting');
    // No scrubber sitting at the last known position — that is indistinguishable
    // from a paused room.
    expect(seekInput()).toBeNull();
    expect(timeReadouts()[0]).toBe('--:--');
  });

  it('can still pause the room, and pins it at the projected position', async () => {
    ext.playback = telemetry({ agoMs: 3_000 });
    await mountBar();
    const play = buttonByLabel(/^(Play|Pause)/);
    // Disabled outright before this: the bar gated play/pause on a local
    // adapter that deliberately does not exist here.
    expect(play?.disabled).toBe(false);
    await act(async () => {
      play?.click();
    });
    expect(pause).toHaveBeenCalledTimes(1);
    expect(pause.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(65_000);
  });

  it('pauses with NO position when the reading is stale', async () => {
    // A position from a minute ago would rewind everyone in the room to it.
    ext.playback = telemetry({ agoMs: 60_000 });
    await mountBar();
    await act(async () => {
      buttonByLabel(/^(Play|Pause)/)?.click();
    });
    expect(pause).toHaveBeenCalledWith(undefined);
  });

  it('does not pretend the local volume reaches another tab', async () => {
    ext.playback = telemetry();
    await mountBar();
    const mute = buttonByLabel(/playing tab/);
    expect(mute?.getAttribute('aria-label')).toBe('Volume lives in the playing tab');
    expect(mute?.disabled).toBe(true);
    expect(buttonByLabel(/^(Mute|Unmute)/)).toBeNull();
  });

  it('changes nothing when the extension is not the driver', async () => {
    ext.driving = false;
    ext.playback = telemetry();
    await mountBar(20_000);
    // The room's own position, the local player's (absent) length, and the
    // output controls back in this tab's hands.
    expect(timeReadouts()).toEqual(['0:20', '0:00']);
    expect(buttonByLabel(/^Mute/)?.disabled).toBe(false);
  });
});

describe('what the stage says about a driven source', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    ext.driving = true;
    ext.provider = null;
    ext.playback = null;
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
    const items = [queueItem(PAGE, 'the driven item')];
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          {
            room: makeRoom('watch'),
            member: makeMember('host'),
            roomId: ROOM_ID,
            lastEventSeq: 0,
            children: h(Capture, null, h(StagePane, { roomId: ROOM_ID })),
          } as never,
        ),
      );
      // Seeded after mount: this block is about the driving state, not the
      // store's server-render path.
      connection?.useRoomState.setState({
        playback: playbackFor(PAGE, 0),
        queue: { items, version: 1 },
      });
    });
  }

  it('promises a shared second on an ordinary page', async () => {
    ext.provider = { id: 'generic', name: 'This page', tier: 'generic' };
    await mountStage();
    expect(host.textContent).toContain('Everyone stays on the same second');
  });

  it('does NOT promise a shared picture on a protected service', async () => {
    // Netflix and its seven siblings are eight people playing eight copies from
    // eight accounts. Only the timing is common, and the old blanket sentence
    // read as though the room were sending them video.
    ext.provider = { id: 'netflix', name: 'Netflix', tier: 'drm' };
    await mountStage();
    expect(host.textContent).toContain('Playing on Netflix');
    expect(host.textContent).toContain('their own account');
    expect(host.textContent).not.toContain('Everyone stays on the same second');
  });
});
