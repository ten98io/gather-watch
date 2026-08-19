/**
 * NativeAdapter — Mode A playback over a real HTMLMediaElement (spec rule 5:
 * real <video>/<audio> → AirPlay/Remote Playback, MediaSession, Bluetooth all
 * come from the platform). HLS goes through hls.js unless the browser plays
 * m3u8 natively (Safari); hls.js is imported lazily so direct-URL playback
 * never pays for it.
 */
import type Hls from 'hls.js';
import type { MediaRef } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';
import { isHlsRef } from './adapter';
import { VolumeMixer } from './ducking';

export class NativeAdapter implements PlayerAdapter {
  readonly kind = 'native' as const;

  private readonly el: HTMLMediaElement;
  /** The user's volume and the duck gain, kept apart (lib/player/ducking.ts).
   *  Mute is the element's own `muted`, so no duck gain can undo it. */
  private readonly mixer = new VolumeMixer();
  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private hls: Hls | null = null;
  private hlsGeneration = 0;
  private buffering = false;
  /** hls.js's own verdict on the playlist; see `isLive`. */
  private playlistIsLive = false;

  constructor(el: HTMLMediaElement) {
    this.el = el;
    el.addEventListener('playing', () => {
      this.setBuffering(false);
      this.emit('playing');
    });
    el.addEventListener('pause', () => this.emit('paused'));
    el.addEventListener('ended', () => this.emit('ended'));
    el.addEventListener('waiting', () => {
      this.setBuffering(true);
    });
    el.addEventListener('canplay', () => {
      this.setBuffering(false);
      this.emit('ready');
    });
    el.addEventListener('durationchange', () => this.emit('durationchange'));
    el.addEventListener('error', () => this.emit('error'));
  }

  /** The underlying element, for casting/MediaSession/captions integration. */
  get mediaElement(): HTMLMediaElement {
    return this.el;
  }

  load(ref: Extract<MediaRef, { kind: 'hls' | 'url' }>): void {
    const generation = (this.hlsGeneration += 1);
    this.destroyHls();
    // A fact about the source that is going away, not about the one arriving.
    this.playlistIsLive = false;
    // Loading IS buffering: it keeps the room's wait-for-all honest, and it
    // stops the stage mistaking "still fetching" for "the browser refused".
    this.setBuffering(true);
    const url = ref.kind === 'hls' ? ref.url : ref.url;
    if (isHlsRef(ref) && !this.el.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js')
        .then((mod) => {
          if (generation !== this.hlsGeneration) return; // superseded load
          const HlsCtor = mod.default;
          if (!HlsCtor.isSupported()) {
            this.emit('error');
            return;
          }
          const hls = new HlsCtor({ enableWorker: true });
          this.hls = hls;
          // Subscribed BEFORE the source is loaded, or the first level load —
          // the one that decides this — has already happened by the time
          // anybody is listening.
          hls.on(HlsCtor.Events.LEVEL_LOADED, (_evt, data) => {
            if (generation !== this.hlsGeneration) return;
            this.playlistIsLive = data.details.live;
          });
          hls.loadSource(url);
          hls.attachMedia(this.el);
        })
        .catch(() => this.emit('error'));
    } else {
      this.el.src = url;
      this.el.load();
    }
  }

  play(): void {
    // Autoplay policies may reject; the server stays authoritative and the
    // next drift tick re-asserts play state. A refusal is reported as
    // 'blocked' so the stage can offer the one tap that fixes it — never a
    // silently dead player.
    const started = this.el.play() as Promise<void> | undefined;
    if (started === undefined) return;
    void started.catch((err: unknown) => {
      // AbortError = a newer load()/pause() superseded this play, not a block.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.emit('blocked');
    });
  }

  pause(): void {
    this.el.pause();
  }

  seekTo(ms: number): void {
    this.el.currentTime = Math.max(0, ms / 1000);
  }

  setRate(rate: number): void {
    this.el.playbackRate = rate;
  }

  positionMs(): number {
    return this.el.currentTime * 1000;
  }

  durationMs(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration * 1000 : 0;
  }

  /**
   * A sliding window with no start, so there is no room position to correct
   * toward — see the live guard in lib/player/useSyncEngine.ts.
   *
   * TWO SOURCES, because there are two playback paths through this adapter.
   * hls.js parses the playlist and states it outright (a live one carries no
   * ENDLIST), and Safari plays m3u8 natively where the fact arrives the way
   * HTML states it: an unbounded stream's `duration` is Infinity.
   *
   * NaN IS NOT LIVE. `duration` is NaN on any element that has not read its
   * metadata yet — which is every element for its first moments — and reading
   * "unknown" as "live" would switch drift correction off for the start of
   * every ordinary file.
   */
  isLive(): boolean {
    return this.playlistIsLive || this.el.duration === Number.POSITIVE_INFINITY;
  }

  setMuted(muted: boolean): void {
    this.el.muted = muted;
  }

  isMuted(): boolean {
    return this.el.muted;
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
    this.el.volume = this.mixer.effective();
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
    this.destroyHls();
    this.playlistIsLive = false;
    this.el.removeAttribute('src');
    this.el.load();
    this.listeners.clear();
  }

  private setBuffering(value: boolean): void {
    if (value === this.buffering) return;
    this.buffering = value;
    this.emit(value ? 'buffering' : 'buffered');
  }

  private destroyHls(): void {
    this.hls?.destroy();
    this.hls = null;
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
