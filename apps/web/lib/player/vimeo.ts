/**
 * VimeoAdapter — full-sync Mode A over the official player.js API (Promise
 * methods + timeupdate events), drift-corrected like native media.
 */
import type { MediaRef } from '@playin/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';

interface VimeoPlayer {
  play(): Promise<void>;
  pause(): Promise<void>;
  setCurrentTime(seconds: number): Promise<void>;
  getCurrentTime(): Promise<number>;
  getDuration(): Promise<number>;
  setVolume(volume: number): Promise<void>; // 0..1
  getVolume(): Promise<number>;
  setPlaybackRate(rate: number): Promise<void>;
  on(event: string, cb: (data?: unknown) => void): void;
  destroy(): Promise<void>;
}

interface VimeoWindow {
  Vimeo?: { Player: new (el: HTMLElement, opts: { id: string }) => VimeoPlayer };
}

let apiPromise: Promise<void> | null = null;
function loadPlayerJs(): Promise<void> {
  if (apiPromise !== null) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    if ((window as unknown as VimeoWindow).Vimeo?.Player !== undefined) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://player.vimeo.com/api/player.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('vimeo player.js failed to load'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export class VimeoAdapter implements PlayerAdapter {
  readonly kind = 'vimeo' as const;

  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private player: VimeoPlayer | null = null;
  private position = 0;
  private duration = 0;
  private destroyed = false;

  constructor(private readonly container: HTMLElement) {}

  load(ref: Extract<MediaRef, { kind: 'vimeo' }>): void {
    if (this.destroyed) return;
    void loadPlayerJs()
      .then(() => {
        if (this.destroyed) return;
        const Vimeo = (window as unknown as VimeoWindow).Vimeo;
        if (Vimeo === undefined) {
          this.emit('error');
          return;
        }
        const mount = document.createElement('div');
        mount.className = 'h-full w-full';
        this.container.replaceChildren(mount);
        const player = new Vimeo.Player(mount, { id: ref.videoId });
        this.player = player;

        player.on('loaded', () => {
          void player.getDuration().then((ms) => {
            this.duration = ms;
            this.emit('durationchange');
          });
          this.emit('ready');
        });
        player.on('play', () => this.emit('playing'));
        player.on('pause', () => this.emit('paused'));
        player.on('ended', () => this.emit('ended'));
        player.on('bufferstart', () => this.emit('buffering'));
        player.on('bufferend', () => this.emit('buffered'));
        player.on('timeupdate', (data) => {
          const seconds = (data as { seconds?: number } | undefined)?.seconds;
          if (typeof seconds === 'number') this.position = seconds * 1000;
        });
      })
      .catch(() => this.emit('error'));
  }

  play(): void {
    void this.player?.play().catch(() => undefined);
  }
  pause(): void {
    void this.player?.pause().catch(() => undefined);
  }
  seekTo(ms: number): void {
    this.position = Math.max(0, ms);
    void this.player?.setCurrentTime(ms / 1000).catch(() => undefined);
  }
  setRate(rate: number): void {
    void this.player?.setPlaybackRate(rate).catch(() => undefined);
  }
  positionMs(): number {
    return this.position;
  }
  durationMs(): number {
    return this.duration;
  }
  setMuted(muted: boolean): void {
    void this.player?.setVolume(muted ? 0 : 1).catch(() => undefined);
  }
  isMuted(): boolean {
    // player.js getVolume is async; the controls track mute state themselves.
    return false;
  }
  setVolume(volume: number): void {
    void this.player?.setVolume(Math.min(1, Math.max(0, volume))).catch(() => undefined);
  }

  on(evt: AdapterEvent, cb: () => void): () => void {
    let set = this.listeners.get(evt);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(evt, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  destroy(): void {
    this.destroyed = true;
    void this.player?.destroy().catch(() => undefined);
    this.player = null;
    this.container.replaceChildren();
    this.listeners.clear();
  }

  private emit(evt: AdapterEvent): void {
    for (const cb of [...(this.listeners.get(evt) ?? [])]) {
      try {
        cb();
      } catch {
        // A bad listener must not break playback.
      }
    }
  }
}
