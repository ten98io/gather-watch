// @vitest-environment jsdom
/**
 * OUTPUT SETTINGS SURVIVE A TRACK CHANGE.
 *
 * Volume and mute are LOCAL output concerns, so PlayerControls owns them —
 * `volume` in its own state, `muted` lifted to the pane so the M shortcut can
 * share it. Neither lives on the adapter, and neither was ever re-applied to a
 * new one.
 *
 * StagePane destroys and rebuilds the player whenever the adapter KIND changes
 * (mp4 → YouTube) and whenever the music/video composition flips, because the
 * two mount their <video> in different containers. Every rebuild starts at the
 * factory defaults: full volume, unmuted. The bar went on rendering the old
 * settings — slider down, icon crossed out — while the room got both barrels.
 *
 * jsdom, because this is entirely about what a mounted component does to an
 * object it is handed, across a re-render.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from '@gather/contracts';
import type { PlayerAdapter } from '@/lib/player/adapter';

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
vi.mock('@/lib/player/extension-driver', () => ({
  useExtensionDriver: () => ({
    state: { phase: 'unavailable' },
    checking: false,
    ready: false,
    driving: false,
    refresh: () => undefined,
    supports: () => false,
    handoff: () => Promise.resolve({ ok: true }),
    sendIntent: () => Promise.resolve({ ok: true }),
    release: () => Promise.resolve({ ok: true }),
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RoomProvider, h, makeMember, makeRoom, playbackFor } = await import(
  './helpers/room-render'
);
const { PlayerControls } = await import('@/components/stage/PlayerControls');

const MP4: MediaRef = { kind: 'url', url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };

/** Records only what this case is about: what the bar told the player. */
class RecordingAdapter {
  readonly volumes: number[] = [];
  readonly mutes: boolean[] = [];
  readonly kind = 'native' as const;
  readonly mediaElement = null as unknown as HTMLVideoElement;
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
  setVolume(v: number): void {
    this.volumes.push(v);
  }
  setDuck(): void {}
  positionMs(): number {
    return 0;
  }
  durationMs(): number {
    return 60_000;
  }
  destroy(): void {}
}

function inputByLabel(label: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (el === null) throw new Error(`no input labelled ${label}`);
  return el;
}

function buttonByLabel(pattern: RegExp): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find(
    (b) => pattern.test(b.getAttribute('aria-label') ?? ''),
  );
  if (btn === undefined) throw new Error(`no button matching ${String(pattern)}`);
  return btn;
}

/** React listens for the native `input` event; the value has to be set through
 *  the prototype setter or React's own value tracker swallows the change. */
function setRange(el: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('volume and mute follow the room onto a rebuilt player', () => {
  let host: HTMLDivElement;
  let root: Root;
  let swap: ((next: PlayerAdapter) => void) | null = null;

  function Harness({ first }: { first: PlayerAdapter }) {
    const [adapter, setAdapter] = React.useState<PlayerAdapter>(first);
    const [muted, setMuted] = React.useState(false);
    swap = setAdapter;
    return h(PlayerControls, {
      adapter,
      playback: playbackFor(MP4, 0),
      enabled: true,
      captionsOn: false,
      onToggleCaptions: () => undefined,
      captionsAvailable: false,
      muted,
      onMutedChange: setMuted,
    });
  }

  async function mount(first: PlayerAdapter): Promise<void> {
    await act(async () => {
      root.render(
        h(RoomProvider, {
          room: makeRoom('watch'),
          member: makeMember('host'),
          lastEventSeq: 0,
          children: h(Harness, { first }),
        }),
      );
    });
  }

  beforeEach(() => {
    swap = null;
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

  it('re-applies the volume the room chose', async () => {
    const first = new RecordingAdapter();
    await mount(first as unknown as PlayerAdapter);

    await act(async () => {
      setRange(inputByLabel('Volume'), 0.2);
    });
    expect(first.volumes.at(-1)).toBe(0.2);

    const second = new RecordingAdapter();
    await act(async () => {
      swap?.(second as unknown as PlayerAdapter);
    });

    // Without this the new player came up at 1 — the slider still reading 0.2.
    expect(second.volumes.at(-1)).toBe(0.2);
  });

  it('re-applies mute, so a track change cannot un-mute a room', async () => {
    const first = new RecordingAdapter();
    await mount(first as unknown as PlayerAdapter);

    await act(async () => {
      buttonByLabel(/^Mute/).click();
    });
    expect(first.mutes.at(-1)).toBe(true);

    const second = new RecordingAdapter();
    await act(async () => {
      swap?.(second as unknown as PlayerAdapter);
    });

    expect(second.mutes.at(-1)).toBe(true);
  });

  it('carries both at once — the muted, quiet room that started this', async () => {
    const first = new RecordingAdapter();
    await mount(first as unknown as PlayerAdapter);
    await act(async () => {
      setRange(inputByLabel('Volume'), 0.1);
      buttonByLabel(/^Mute/).click();
    });

    const second = new RecordingAdapter();
    await act(async () => {
      swap?.(second as unknown as PlayerAdapter);
    });

    expect(second.volumes.at(-1)).toBe(0.1);
    expect(second.mutes.at(-1)).toBe(true);
  });

  it('does not fight the user: moving the slider still reaches the live player', async () => {
    const first = new RecordingAdapter();
    await mount(first as unknown as PlayerAdapter);
    const second = new RecordingAdapter();
    await act(async () => {
      swap?.(second as unknown as PlayerAdapter);
    });
    await act(async () => {
      setRange(inputByLabel('Volume'), 0.6);
    });
    expect(second.volumes.at(-1)).toBe(0.6);
  });
});
