/**
 * YouTubeAdapter — Mode A YouTube over the IFrame Player API. Unlike the
 * mobile WebView (approximate sync), the web iframe exposes getCurrentTime /
 * seekTo / setPlaybackRate, so YouTube IS drift-corrected here through the
 * same sync-core math as native media. Chrome is hidden (controls=0): the
 * room's own transport bar stays authoritative.
 */
import type { MediaRef } from '@playin/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';

/* Minimal ambient typings for the iframe API surface we use (no @types dep). */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void; // 0..100
  loadVideoById(videoId: string): void;
  destroy(): void;
}

interface YTWindow {
  YT?: {
    Player: new (
      el: HTMLElement,
      opts: {
        videoId: string;
        playerVars: Record<string, string | number>;
        events: {
          onReady: () => void;
          onStateChange: (ev: { data: number }) => void;
          onError: () => void;
        };
      },
    ) => YTPlayer;
    PlayerState?: { PLAYING: number; PAUSED: number; BUFFERING: number; ENDED: number };
  };
  onYouTubeIframeAPIReady?: () => void;
}

const YT_STATE = { PLAYING: 1, PAUSED: 2, BUFFERING: 3, ENDED: 0 };

let apiPromise: Promise<void> | null = null;

/** Loads the iframe API script exactly once per page. */
function loadIframeApi(): Promise<void> {
  if (apiPromise !== null) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    const w = window as unknown as YTWindow;
    if (w.YT?.Player !== undefined) {
      resolve();
      return;
    }
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('youtube iframe api failed to load'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export class YouTubeAdapter implements PlayerAdapter {
  readonly kind = 'youtube' as const;

  private readonly container: HTMLElement;
  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private player: YTPlayer | null = null;
  private ready = false;
  private pendingVideoId: string | null = null;
  private destroyed = false;

  /** @param container an empty div the iframe is mounted into. */
  constructor(container: HTMLElement) {
    this.container = container;
  }

  load(ref: Extract<MediaRef, { kind: 'youtube' }>): void {
    if (this.destroyed) return;
    if (this.ready && this.player !== null) {
      this.player.loadVideoById(ref.videoId);
      return;
    }
    this.pendingVideoId = ref.videoId;
    if (this.player !== null) return; // API still loading; onReady picks it up

    void loadIframeApi()
      .then(() => {
        if (this.destroyed || this.player !== null) return;
        const w = window as unknown as YTWindow;
        const YT = w.YT;
        if (YT === undefined || this.pendingVideoId === null) {
          this.emit('error');
          return;
        }
        const videoId = this.pendingVideoId;
        this.player = new YT.Player(this.container, {
          videoId,
          playerVars: {
            controls: 0,
            rel: 0,
            playsinline: 1,
            disablekb: 1, // room keyboard map owns the keys (DESIGN.md §9)
            modestbranding: 1,
          },
          events: {
            onReady: () => {
              this.ready = true;
              this.emit('ready');
            },
            onStateChange: (ev) => {
              if (ev.data === YT_STATE.PLAYING) this.emit('playing');
              else if (ev.data === YT_STATE.PAUSED) this.emit('paused');
              else if (ev.data === YT_STATE.BUFFERING) this.emit('buffering');
              else if (ev.data === YT_STATE.ENDED) this.emit('ended');
            },
            onError: () => this.emit('error'),
          },
        });
      })
      .catch(() => this.emit('error'));
  }

  play(): void {
    this.player?.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  seekTo(ms: number): void {
    this.player?.seekTo(Math.max(0, ms / 1000), true);
  }

  setRate(rate: number): void {
    this.player?.setPlaybackRate(rate);
  }

  positionMs(): number {
    if (!this.ready || this.player === null) return 0;
    return this.player.getCurrentTime() * 1000;
  }

  durationMs(): number {
    if (!this.ready || this.player === null) return 0;
    const d = this.player.getDuration();
    return Number.isFinite(d) ? d * 1000 : 0;
  }

  setMuted(muted: boolean): void {
    if (muted) this.player?.mute();
    else this.player?.unMute();
  }

  isMuted(): boolean {
    return this.player?.isMuted() ?? false;
  }

  setVolume(volume: number): void {
    this.player?.setVolume(Math.round(Math.min(1, Math.max(0, volume)) * 100));
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
    this.player?.destroy();
    this.player = null;
    this.ready = false;
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
