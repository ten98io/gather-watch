/**
 * What a MediaRef IS — music or video — decided by the content itself, never
 * by the room. The room's stored `kind` field is compatibility ballast
 * (contracts entities.ts marks it deprecated); the stage composition, the
 * theater gate, the queue icon and the presence idle state all follow the
 * PLAYING item through this one classifier.
 */
import type { MediaRef } from '@gather/contracts';

export type MediaKind = 'music' | 'video';

/** The embed tier is all music services today (contracts MediaRef enum); the
 *  list is spelled out so a future video embed lands as video by choice, not
 *  by accident. */
const MUSIC_EMBED_PROVIDERS: ReadonlySet<string> = new Set([
  'spotify',
  'applemusic',
  'tidal',
  'deezer',
]);

export function mediaKindFor(ref: MediaRef | null): MediaKind | null {
  if (ref === null) return null;
  switch (ref.kind) {
    case 'soundcloud':
      return 'music';
    case 'url':
      return ref.mime.startsWith('audio/') ? 'music' : 'video';
    case 'embed':
      return MUSIC_EMBED_PROVIDERS.has(ref.provider) ? 'music' : 'video';
    case 'youtube':
      // The id space is shared with YouTube Music; the parse-time flag is the
      // only place the origin survives into the MediaRef.
      return ref.music === true ? 'music' : 'video';
    case 'vimeo':
    case 'hls':
      return 'video';
  }
}

/**
 * The presence state an idle member reports for what is playing. 'watching'
 * when nothing plays — the server's own default for a stateless
 * presence.update. The richer states ('in-call', 'away') are never produced
 * here; callers must not overwrite them with an idle state.
 */
export function presenceIdleStateFor(ref: MediaRef | null): 'watching' | 'listening' {
  return mediaKindFor(ref) === 'music' ? 'listening' : 'watching';
}
