/**
 * EmbedAdapter — official embed iframes (Spotify / Apple Music / Tidal /
 * Deezer). HONEST SCOPE: these embeds expose no position/transport API across
 * origins, so play/pause/seek are no-ops here and drift correction does NOT
 * apply. The stage badges this tier as "approximate sync" and hides the seek
 * bar; transport commands simply don't exist for these players.
 */
import type { MediaRef } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';

export class EmbedAdapter implements PlayerAdapter {
  readonly kind = 'embed' as const;

  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private destroyed = false;

  constructor(private readonly container: HTMLElement) {}

  load(ref: Extract<MediaRef, { kind: 'embed' }>): void {
    if (this.destroyed) return;
    const iframe = document.createElement('iframe');
    iframe.className = 'h-full w-full border-0';
    iframe.allow = 'autoplay; encrypted-media; clipboard-write';
    iframe.loading = 'eager';
    iframe.src = ref.embedUrl;
    iframe.onload = () => this.emit('ready');
    iframe.onerror = () => this.emit('error');
    this.container.replaceChildren(iframe);
  }

  /** No cross-origin transport API exists — honest no-op. This tier is also
   *  the ONE case the stage leaves interactive (no click shield): the embed's
   *  own controls are the only controls that exist for it. It can never emit
   *  'playing'/'ended'/'blocked' either, so no auto-advance and no
   *  autoplay-recovery prompt apply here. */
  play(): void {}
  pause(): void {}
  seekTo(): void {}
  setRate(): void {}
  /** Unknown by design (milliseconds elsewhere): position is never reported. */
  positionMs(): number {
    return 0;
  }
  durationMs(): number {
    return 0;
  }
  setMuted(): void {}
  isMuted(): boolean {
    return false;
  }
  setVolume(): void {}

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
    this.container.replaceChildren();
    this.listeners.clear();
  }

  private emit(evt: AdapterEvent): void {
    for (const cb of [...(this.listeners.get(evt) ?? [])]) {
      try {
        cb();
      } catch {
        // A bad listener must not break the stage.
      }
    }
  }
}
