// @vitest-environment jsdom
/**
 * The cast affordance must be discoverable in EVERY session (EXTENSION_FIRST
 * Part 3), with three honest states:
 *   (a) native media + capable browser → the real AirPlay / cast pickers,
 *       wired to lib/cast.ts;
 *   (b) provider content → one sentence saying the service casts with its own
 *       cast button (and, when the extension drives the tab, that it lives in
 *       that tab — never promising an extension that is not there);
 *   (c) native media + incapable browser → says that, plainly.
 * Before this control existed, states (b) and (c) rendered NOTHING: the
 * buttons were gated on `nativeEl !== null && <API present>`, so the most
 * common session in the product (YouTube in Chrome) had no cast affordance
 * at all.
 *
 * Client-rendered (jsdom): the states hinge on runtime availability probes
 * and click handlers, neither of which exist under renderToStaticMarkup.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import type { PlayerAdapter } from '@/lib/player/adapter';

const cast = vi.hoisted(() => ({
  airPlayAvailable: vi.fn((): boolean => false),
  remotePlaybackAvailable: vi.fn((): boolean => false),
  showAirPlayPicker: vi.fn(),
  promptRemotePlayback: vi.fn((): Promise<void> => Promise.resolve()),
  ensureCastFramework: vi.fn((): Promise<boolean> => Promise.resolve(true)),
}));
vi.mock('@/lib/cast', () => cast);

// The default (non-error) toast is what the explanation states tap into; the
// mock records it without mounting a Toaster portal.
const toastSpy = vi.hoisted(() => {
  const fn = vi.fn();
  return Object.assign(fn, { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() });
});
vi.mock('@/components/ui/toast', () => ({ toast: toastSpy }));

// Controllable stand-in for the extension driver singleton. Only the fields
// PlayerControls reads are modelled.
const ext = vi.hoisted(() => ({
  state: { phase: 'unavailable' } as Record<string, unknown>,
  driving: false,
}));
// Spread over the real module, not a replacement: the bar also reads the
// driven tab's telemetry store (`useExtensionPlayback` and its projection
// helpers), and a total replacement fails every case here on a missing export
// that has nothing to do with casting.
vi.mock('@/lib/player/extension-driver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/player/extension-driver')>()),
  useExtensionDriver: () => ({
    state: ext.state,
    checking: false,
    ready: ext.state['phase'] === 'ready',
    driving: ext.driving,
    refresh: () => undefined,
    supports: () => false,
    handoff: () => Promise.resolve({ ok: true }),
    sendIntent: () => Promise.resolve({ ok: true }),
    release: () => Promise.resolve({ ok: true }),
  }),
}));

const { RoomProvider, h, makeMember, makeRoom, playbackFor } = await import(
  './helpers/room-render'
);
const { PlayerControls } = await import('@/components/stage/PlayerControls');

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };

/** jsdom has no media pipeline; the assertions are about which controls render
 *  and what they call, so a bare recording adapter is enough. */
class FakeAdapter {
  mediaElement: HTMLVideoElement | null;
  constructor(
    readonly kind: PlayerAdapter['kind'],
    el: HTMLVideoElement | null,
  ) {
    this.mediaElement = el;
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
    return 60_000;
  }
  destroy(): void {}
}

/** API identifiers must never surface in user-facing cast copy. */
const RAW_API_NAMES = /api|webkit|remote|playback target|htmlmedia|prompt/i;

function castLabels(): string[] {
  return Array.from(document.querySelectorAll('button[aria-label]'))
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((label) => /cast|airplay/i.test(label));
}

function buttonByLabel(pattern: RegExp): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find(
    (b) => pattern.test(b.getAttribute('aria-label') ?? ''),
  );
  if (btn === undefined) throw new Error(`no button matching ${String(pattern)}`);
  return btn;
}

describe('cast affordance states', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    cast.airPlayAvailable.mockReturnValue(false);
    cast.remotePlaybackAvailable.mockReturnValue(false);
    ext.state = { phase: 'unavailable' };
    ext.driving = false;
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

  async function renderControls(adapter: FakeAdapter | null): Promise<void> {
    await act(async () => {
      root.render(
        h(
          RoomProvider,
          { room: makeRoom('watch'), member: makeMember('host'), lastEventSeq: 0 } as never,
          h(PlayerControls, {
            adapter: adapter as unknown as PlayerAdapter | null,
            playback: playbackFor(MP4, 0),
            enabled: true,
            captionsOn: false,
            onToggleCaptions: () => undefined,
            captionsAvailable: false,
            muted: false,
            onMutedChange: () => undefined,
          }),
        ),
      );
    });
  }

  it('native + capable browser: both pickers render and drive lib/cast', async () => {
    cast.airPlayAvailable.mockReturnValue(true);
    cast.remotePlaybackAvailable.mockReturnValue(true);
    const el = document.createElement('video');
    await renderControls(new FakeAdapter('native', el));

    const airPlay = buttonByLabel(/^AirPlay$/);
    const castBtn = buttonByLabel(/^Cast to TV$/);
    await act(async () => {
      airPlay.click();
    });
    expect(cast.showAirPlayPicker).toHaveBeenCalledWith(el);
    await act(async () => {
      castBtn.click();
    });
    expect(cast.promptRemotePlayback).toHaveBeenCalledWith(el);
    for (const label of castLabels()) expect(label).not.toMatch(RAW_API_NAMES);
  });

  it('provider content (YouTube iframe): the control explains the service casts itself', async () => {
    await renderControls(new FakeAdapter('youtube', null));

    const labels = castLabels();
    expect(labels).toHaveLength(1);
    const label = labels[0] ?? '';
    expect(label).toContain('YouTube');
    expect(label).toContain('cast button');
    // The extension is not detected here, so the copy must not promise it.
    expect(label).not.toMatch(/extension/i);
    expect(label).not.toMatch(RAW_API_NAMES);

    // Never a dead control: tapping surfaces the same sentence.
    await act(async () => {
      buttonByLabel(/cast button/).click();
    });
    expect(toastSpy).toHaveBeenCalledWith(label);
  });

  it('extension driving the tab: the control points at the provider tab', async () => {
    ext.state = {
      phase: 'ready',
      driving: true,
      provider: { id: 'youtube', name: 'YouTube', tier: 'full-sync' },
    };
    ext.driving = true;
    await renderControls(null);

    const labels = castLabels();
    expect(labels).toHaveLength(1);
    const label = labels[0] ?? '';
    expect(label).toContain('YouTube');
    expect(label).toContain('cast button');
    expect(label).toMatch(/tab/i);
    expect(label).not.toMatch(RAW_API_NAMES);
  });

  it('native + incapable browser: the control says so instead of vanishing', async () => {
    const el = document.createElement('video');
    await renderControls(new FakeAdapter('native', el));

    const labels = castLabels();
    expect(labels).toHaveLength(1);
    const label = labels[0] ?? '';
    expect(label).toMatch(/isn’t available in this browser/);
    expect(label).not.toMatch(RAW_API_NAMES);

    await act(async () => {
      buttonByLabel(/browser/).click();
    });
    expect(toastSpy).toHaveBeenCalledWith(label);
    expect(cast.showAirPlayPicker).not.toHaveBeenCalled();
    expect(cast.promptRemotePlayback).not.toHaveBeenCalled();
  });
});
