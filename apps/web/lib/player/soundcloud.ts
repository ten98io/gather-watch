/**
 * SoundCloudAdapter — full-sync Mode A over the official SoundCloud Widget
 * API: play/pause/seekTo/getPosition/getDuration/setVolume + PLAY_PROGRESS
 * position events, so sync-core drift correction applies exactly as it does
 * for native media.
 */
import type { MediaRef } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';

interface SCWidget {
  play(): void;
  pause(): void;
  seekTo(ms: number): void;
  setVolume(volume: number): void; // 0..100
  setPlaybackRate?(rate: number): void;
  getPosition(cb: (ms: number) => void): void;
  getDuration(cb: (ms: number) => void): void;
  bind(event: string, cb: (...args: unknown[]) => void): void;
}

interface SCWindow {
  SC?: { Widget: new (iframe: HTMLIFrameElement) => SCWidget };
}

let apiPromise: Promise<void> | null = null;
function loadWidgetApi(): Promise<void> {
  if (apiPromise !== null) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    if ((window as unknown as SCWindow).SC?.Widget !== undefined) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://w.soundcloud.com/player/api.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('soundcloud widget api failed to load'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export class SoundCloudAdapter implements PlayerAdapter {
  readonly kind = 'soundcloud' as const;

  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private iframe: HTMLIFrameElement | null = null;
  private widget: SCWidget | null = null;
  private position = 0;
  private duration = 0;
  private muted = false;
  private destroyed = false;
  private buffering = false;

  /** @param container an empty div the widget iframe is mounted into. */
  constructor(private readonly container: HTMLElement) {}

  load(ref: Extract<MediaRef, { kind: 'soundcloud' }>): void {
    if (this.destroyed) return;
    // Loading IS buffering (same contract as NativeAdapter): it keeps the
    // room's wait-for-all honest and stops the stage mistaking a slow widget
    // for a browser that refused to play.
    this.setBuffering(true);
    void loadWidgetApi()
      .then(() => {
        if (this.destroyed) return;
        const SC = (window as unknown as SCWindow).SC;
        if (SC === undefined) {
          this.emit('error');
          return;
        }
        const iframe = document.createElement('iframe');
        iframe.className = 'h-full w-full border-0';
        iframe.allow = 'autoplay';
        // The stage's click shield is the only control surface: keep the
        // widget's own transport out of reach of pointer and tab order.
        iframe.style.pointerEvents = 'none';
        iframe.setAttribute('tabindex', '-1');
        iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(ref.url)}&auto_play=false&visual=true`;
        this.container.replaceChildren(iframe);
        this.iframe = iframe;
        const widget = new SC.Widget(iframe);
        this.widget = widget;

        widget.bind('ready', () => {
          // The widget API reports getDuration/getPosition/currentPosition in
          // MILLISECONDS already — no conversion, unlike Vimeo's seconds.
          widget.getDuration((ms) => {
            this.duration = ms;
            this.emit('durationchange');
          });
          this.setBuffering(false);
          this.emit('ready');
        });
        widget.bind('play', () => {
          this.setBuffering(false);
          this.emit('playing');
        });
        widget.bind('pause', () => this.emit('paused'));
        widget.bind('finish', () => {
          this.setBuffering(false);
          this.emit('ended');
        });
        widget.bind('error', () => {
          this.setBuffering(false);
          this.emit('error');
        });
        widget.bind('playProgress', (pos: unknown) => {
          const ms = (pos as { currentPosition?: number }).currentPosition;
          if (typeof ms === 'number') this.position = ms;
          this.setBuffering(false);
        });
      })
      .catch(() => {
        this.setBuffering(false);
        this.emit('error');
      });
  }

  /** Paired buffering edges — the room's wait-for-all needs both. */
  private setBuffering(value: boolean): void {
    if (value === this.buffering) return;
    this.buffering = value;
    this.emit(value ? 'buffering' : 'buffered');
  }

  play(): void {
    this.widget?.play();
  }
  pause(): void {
    this.widget?.pause();
  }
  seekTo(ms: number): void {
    this.position = Math.max(0, ms);
    this.widget?.seekTo(this.position);
  }
  setRate(rate: number): void {
    // SoundCloud's widget has no rate control on most tracks; attempt, else
    // the sync engine's nudge is simply a no-op here (seek corrections still
    // work — drift stays honest).
    try {
      this.widget?.setPlaybackRate?.(rate);
    } catch {
      // unsupported — nothing to do
    }
  }
  positionMs(): number {
    return this.position;
  }
  durationMs(): number {
    return this.duration;
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.widget?.setVolume(muted ? 0 : 100);
  }
  isMuted(): boolean {
    return this.muted;
  }
  setVolume(volume: number): void {
    this.widget?.setVolume(Math.round(Math.min(1, Math.max(0, volume)) * 100));
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
    this.buffering = false;
    this.container.replaceChildren();
    this.widget = null;
    this.iframe = null;
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
