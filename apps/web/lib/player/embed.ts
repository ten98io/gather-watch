/**
 * EmbedAdapter — official embed iframes (Spotify / Apple Music / Tidal /
 * Deezer). HONEST SCOPE: these embeds expose no position/transport API across
 * origins, so play/pause/seek are no-ops here and drift correction does NOT
 * apply. The stage badges this tier as "approximate sync" and hides the seek
 * bar; transport commands simply don't exist for these players.
 */
import type { MediaRef } from '@gather/contracts';
import type { AdapterEvent, PlayerAdapter } from './adapter';

/**
 * The scheme this adapter is willing to put in an iframe.
 *
 * The contract already pins embedUrl to https on the provider's own host
 * (packages/contracts entities.ts, EMBED_PROVIDER_HOSTS) and that is where the
 * rule belongs — it covers web, mobile and the extension at once. This is the
 * second layer, and it exists because a contract only guards the door values
 * come in THROUGH: a queue row written before the rule existed is already in
 * the database, reads back as a plain string, and arrives here having been
 * validated by nothing. `iframe.src` was the sink the stored XSS used, so it
 * decides for itself.
 *
 * Scheme only. The host pin needs `provider` beside it and belongs where the
 * two are checked together; a second copy of the host table here would be one
 * more thing to keep in step, and the copy is what drifts.
 */
const SAFE_EMBED_SCHEME = /^https:\/\//i;

/**
 * What the room grants a third-party frame, and nothing beyond it: `autoplay`
 * because the ROOM starts the track rather than the viewer, `encrypted-media`
 * because all four providers stream DRM-protected audio. Set as an attribute
 * rather than through `iframe.allow` — identical in a browser, but the IDL
 * property is unreflected in jsdom, and a capability list no test can read is
 * a capability list nobody notices growing.
 */
const EMBED_ALLOW = 'autoplay; encrypted-media';

export class EmbedAdapter implements PlayerAdapter {
  readonly kind = 'embed' as const;

  private readonly listeners = new Map<AdapterEvent, Set<() => void>>();
  private destroyed = false;

  constructor(private readonly container: HTMLElement) {}

  load(ref: Extract<MediaRef, { kind: 'embed' }>): void {
    if (this.destroyed) return;
    if (!SAFE_EMBED_SCHEME.test(ref.embedUrl)) {
      // Clear first, then report. A refusal has to take the PREVIOUS frame
      // down as well as decline this one — otherwise the last track keeps
      // playing under a stage that has already given up on it, and nothing
      // else removes that frame until some later load succeeds.
      this.container.replaceChildren();
      this.emit('error');
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.className = 'h-full w-full border-0';
    iframe.setAttribute('allow', EMBED_ALLOW);
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
  /** Nothing to duck: this tier has no volume API, so a room talking over a
   *  Spotify embed keeps the embed at whatever the provider is playing it at.
   *  Faking it (muting the iframe) would be worse than admitting it. */
  setDuck(): void {}

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
