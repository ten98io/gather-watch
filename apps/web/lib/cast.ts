/**
 * Casting helpers (BUILD_PROMPT §Casting & output). Mode A only — the media
 * element is real, so the platform output pickers work on it directly:
 *  - AirPlay: Safari's webkitShowPlaybackTargetPicker / Remote Playback API;
 *  - Chromecast: Cast sender framework loaded ON DEMAND (never in the initial
 *    bundle), default media receiver playing the HLS/MP4 URL, then
 *    HTMLMediaElement.remote.prompt().
 * Everything is feature-detected; unsupported browsers simply don't render
 * the buttons (callers check availability first).
 */

interface RemotePlaybackLike {
  prompt(): Promise<void>;
}

type CastableElement = HTMLMediaElement & {
  remote?: RemotePlaybackLike;
  webkitShowPlaybackTargetPicker?: () => void;
};

/** Safari AirPlay picker availability (webkit proprietary path). */
export function airPlayAvailable(el: HTMLMediaElement): boolean {
  const castable = el as CastableElement;
  return (
    typeof castable.webkitShowPlaybackTargetPicker === 'function' &&
    typeof window !== 'undefined' &&
    'WebKitPlaybackTargetAvailabilityEvent' in window
  );
}

/** Open Safari's AirPlay route picker for the element. */
export function showAirPlayPicker(el: HTMLMediaElement): void {
  (el as CastableElement).webkitShowPlaybackTargetPicker?.();
}

/** Remote Playback API availability (Chrome Cast route / Safari modern). */
export function remotePlaybackAvailable(el: HTMLMediaElement): boolean {
  return typeof (el as CastableElement).remote?.prompt === 'function';
}

interface CastWindow {
  chrome?: {
    cast?: {
      media?: { DEFAULT_MEDIA_RECEIVER_APP_ID: string };
      AutoJoinPolicy?: { ORIGIN_SCOPED: string };
    };
  };
  cast?: {
    framework?: {
      CastContext: {
        getInstance(): {
          setOptions(opts: {
            receiverApplicationId: string;
            autoJoinPolicy: string;
          }): void;
        };
      };
    };
  };
  __onGCastApiAvailable?: (isAvailable: boolean) => void;
}

let castPromise: Promise<boolean> | null = null;

/**
 * Loads the Cast sender framework on demand and initialises the default
 * media receiver. Resolves false (no throw) when the API never materialises
 * — e.g. non-Chrome browsers or no Cast devices on the network.
 */
export function ensureCastFramework(): Promise<boolean> {
  if (castPromise !== null) return castPromise;
  castPromise = new Promise<boolean>((resolve) => {
    const w = window as unknown as CastWindow;
    if (w.cast?.framework !== undefined) {
      configureCast(w);
      resolve(true);
      return;
    }
    const timeout = setTimeout(() => resolve(false), 10_000);
    w.__onGCastApiAvailable = (isAvailable: boolean) => {
      clearTimeout(timeout);
      if (isAvailable) {
        configureCast(w);
        resolve(true);
      } else {
        resolve(false);
      }
    };
    const script = document.createElement('script');
    script.src =
      'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    script.async = true;
    script.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    document.head.appendChild(script);
  });
  return castPromise;
}

function configureCast(w: CastWindow): void {
  const appId = w.chrome?.cast?.media?.DEFAULT_MEDIA_RECEIVER_APP_ID;
  const autoJoin = w.chrome?.cast?.AutoJoinPolicy?.ORIGIN_SCOPED;
  if (appId === undefined || autoJoin === undefined) return;
  w.cast?.framework?.CastContext.getInstance().setOptions({
    receiverApplicationId: appId,
    autoJoinPolicy: autoJoin,
  });
}

/**
 * Open the browser's remote-playback picker (Cast devices in Chrome). Loads
 * the Cast framework first when needed; throws an honest Error when the
 * browser cannot remote-play this element.
 */
export async function promptRemotePlayback(el: HTMLMediaElement): Promise<void> {
  const castable = el as CastableElement;
  if (castable.remote === undefined) {
    throw new Error('This browser has no remote playback support');
  }
  await ensureCastFramework();
  await castable.remote.prompt();
}
