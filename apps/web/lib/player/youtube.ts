/**
 * YouTubeAdapter — Mode A YouTube over the IFrame Player API. Unlike the
 * mobile WebView (approximate sync), the web iframe exposes getCurrentTime /
 * seekTo / setPlaybackRate, so YouTube IS drift-corrected here through the
 * same sync-core math as native media.
 *
 * Chrome suppression (UX_OVERHAUL B2): `controls: 0` removes YouTube's control
 * BAR but NOT its large centre play overlay, which still appears in the
 * unstarted and paused states. So this adapter also (a) mounts into a throwaway
 * inner div — the API REPLACES the element it is handed, and the stage's own
 * container must survive that — and (b) makes the resulting iframe inert to
 * both pointer and keyboard. The stage's click shield is the only surface the
 * user can hit, so exactly one play affordance exists and it is ours.
 */
import type { MediaRef } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';
import { VolumeMixer } from './ducking';

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
        width?: string | number;
        height?: string | number;
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

const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

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
  /** The user's volume and the duck gain, kept apart (lib/player/ducking.ts). */
  private readonly mixer = new VolumeMixer();
  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private player: YTPlayer | null = null;
  private ready = false;
  private pendingVideoId: string | null = null;
  private destroyed = false;
  private buffering = false;
  /** This player has actually run at least once on the CURRENT video — the
   *  precondition for reading a length of 0 as anything at all; see `isLive`. */
  private everPlayed = false;

  /** @param container an empty div the iframe is mounted into. */
  constructor(container: HTMLElement) {
    this.container = container;
  }

  load(ref: Extract<MediaRef, { kind: 'youtube' }>): void {
    if (this.destroyed) return;
    // Said about the video that is leaving. The next one has not run here yet.
    this.everPlayed = false;
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
        // The API replaces this node with its iframe — hand it a throwaway so
        // the stage's own container (and its classes) stay intact.
        const mount = document.createElement('div');
        mount.className = 'h-full w-full';
        this.container.replaceChildren(mount);
        this.player = new YT.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            controls: 0,
            rel: 0,
            playsinline: 1,
            disablekb: 1, // room keyboard map owns the keys (DESIGN.md §9)
            modestbranding: 1,
            iv_load_policy: 3, // no in-video annotations
            // KEPT at 0, and now for a true reason. This said "the room's own
            // chrome handles it" while nothing in the web app called
            // requestFullscreen at all; the transport bar's fullscreen control
            // and the F shortcut (components/stage/StagePane.tsx) are what make
            // the sentence true. Restoring YouTube's own button would fullscreen
            // the IFRAME — dropping the transport, the shield, the badges and
            // the emote overlay out of the picture — and would need
            // `hardenIframe` undone, which is what keeps its centre play overlay
            // from being a second play affordance.
            fs: 0,
          },
          events: {
            onReady: () => {
              this.ready = true;
              this.hardenIframe();
              // A volume or duck set before the API existed was written to
              // nothing; replay the mix now rather than start at 100%.
              this.applyVolume();
              this.emit('ready');
            },
            onStateChange: (ev) => {
              if (ev.data === YT_STATE.PLAYING) {
                this.everPlayed = true;
                this.setBuffering(false);
                this.emit('playing');
              } else if (ev.data === YT_STATE.PAUSED) this.emit('paused');
              else if (ev.data === YT_STATE.BUFFERING) this.setBuffering(true);
              else if (ev.data === YT_STATE.ENDED) {
                this.setBuffering(false);
                this.emit('ended');
              }
              // Unstarted/cued means the video is sitting behind YouTube's own
              // centre overlay — which our shield covers. Report it as paused
              // so the stage knows this device is not actually playing.
              else if (ev.data === YT_STATE.UNSTARTED || ev.data === YT_STATE.CUED)
                this.emit('paused');
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
    const player = this.player;
    if (player === null) return;
    // Bounded at BOTH ends. Past the end is not a position: YouTube's seekTo
    // from a non-paused state plays, so a correction aimed beyond the last
    // frame lands on it and fires ENDED again. Duration reads 0 until the
    // player is ready, which is "unknown", not "zero-length".
    const duration = this.durationMs();
    const target = duration > 0 ? Math.min(ms, duration) : ms;
    player.seekTo(Math.max(0, target) / 1000, true);
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

  /**
   * A live broadcast, which the IFrame API states by refusing to name a length:
   * `getDuration()` answers 0 for one, while `getCurrentTime()` answers
   * elapsed-since-broadcast-start. A room projecting from 0 therefore measures
   * minutes of "drift" that no seek can close — see the live guard in
   * lib/player/useSyncEngine.ts.
   *
   * ONLY ONCE IT HAS PLAYED. 0 is also the answer before the player has read
   * its metadata, so asking any earlier would call every ordinary video live
   * for its first seconds — which would switch drift correction off exactly
   * when a fresh player needs to be landed.
   */
  isLive(): boolean {
    return this.everPlayed && this.durationMs() === 0;
  }

  setMuted(muted: boolean): void {
    if (muted) this.player?.mute();
    else this.player?.unMute();
  }

  isMuted(): boolean {
    return this.player?.isMuted() ?? false;
  }

  setVolume(volume: number): void {
    this.mixer.setUserVolume(volume);
    this.applyVolume();
  }

  setDuck(gain: number): void {
    this.mixer.setDuck(gain);
    this.applyVolume();
  }

  /** The product, and only the product — see lib/player/ducking.ts. Mute is
   *  the iframe API's own mute()/unMute(), untouched by ducking. */
  private applyVolume(): void {
    this.player?.setVolume(Math.round(this.mixer.effective() * 100));
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
    this.buffering = false;
    this.everPlayed = false;
    this.container.replaceChildren();
    this.listeners.clear();
  }

  /** Paired buffering edges — without them the room's wait-for-all never
   *  clears after a YouTube stall. */
  private setBuffering(value: boolean): void {
    if (value === this.buffering) return;
    this.buffering = value;
    this.emit(value ? 'buffering' : 'buffered');
  }

  /** The stage's click shield is the only control surface: YouTube's centre
   *  play overlay must be unreachable by pointer AND by keyboard. */
  private hardenIframe(): void {
    const iframe = this.container.querySelector('iframe');
    if (iframe === null) return;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.pointerEvents = 'none';
    iframe.setAttribute('tabindex', '-1');
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
