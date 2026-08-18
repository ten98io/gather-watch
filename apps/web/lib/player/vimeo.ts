/**
 * VimeoAdapter — full-sync Mode A over the official player.js API (Promise
 * methods + timeupdate events), drift-corrected like native media.
 */
import type { MediaRef } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';
import { VolumeMixer } from './ducking';

interface VimeoPlayer {
  play(): Promise<void>;
  pause(): Promise<void>;
  setCurrentTime(seconds: number): Promise<void>;
  getCurrentTime(): Promise<number>; // seconds
  getDuration(): Promise<number>; // seconds
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
  /** player.js has no mute of its own either — mute, the user's volume and the
   *  duck gain resolve here and only the product is sent (lib/player/ducking.ts). */
  private readonly mixer = new VolumeMixer();
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
          this.hardenIframe();
          // Anything set before the player existed went nowhere; replay it.
          this.applyVolume();
          // player.js reports SECONDS; the adapter contract is milliseconds.
          void player.getDuration().then((seconds) => {
            this.duration = seconds * 1000;
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

  /** The stage's click shield is the only control surface: keep Vimeo's own
   *  chrome out of reach of both the pointer and the tab order. */
  private hardenIframe(): void {
    const iframe = this.container.querySelector('iframe');
    if (iframe === null) return;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.pointerEvents = 'none';
    iframe.setAttribute('tabindex', '-1');
  }

  play(): void {
    void this.player?.play().catch((err: unknown) => {
      // Interrupted by a newer seek/pause — not an autoplay refusal.
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError' || name === 'PlayInterrupted') return;
      this.emit('blocked');
    });
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
    this.mixer.setMuted(muted);
    this.applyVolume();
  }
  isMuted(): boolean {
    // player.js getVolume is async, so the answer comes from what we last
    // asked for rather than a round trip — which is also what makes unmuting
    // restore the user's volume instead of slamming to 1.
    return this.mixer.isMuted();
  }
  setVolume(volume: number): void {
    this.mixer.setUserVolume(volume);
    this.applyVolume();
  }
  setDuck(gain: number): void {
    this.mixer.setDuck(gain);
    this.applyVolume();
  }
  private applyVolume(): void {
    void this.player?.setVolume(this.mixer.effective()).catch(() => undefined);
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
