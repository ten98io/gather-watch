/**
 * SPA navigation watching. YouTube, Netflix, Disney+ and most streaming sites
 * never reload — they swap the route (and the `<video>`) under a live
 * document. A content script that detects once at `document_idle` is stale
 * from the first click.
 *
 * Three signals, deliberately overlapping, because none of them is complete
 * on its own:
 *   1. `popstate` / `hashchange`   — real back/forward and hash routers.
 *   2. patched `history.pushState/replaceState` — catches routers that share
 *      our JS world (and is free); a content script lives in an ISOLATED
 *      world, so a page-world pushState will NOT run through this patch.
 *   3. `check()` polling — the safety net that makes (2)'s blind spot a
 *      sub-second delay instead of a permanent miss. The content script calls
 *      it from the heartbeat it already runs.
 *
 * Pure: everything the watcher touches arrives through `NavigationHost`, so
 * it is tested with a fake host instead of jsdom.
 */

export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

export interface NavigationHost {
  history: HistoryLike;
  currentUrl(): string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Events that mean "the route may have changed" in every router we know of. */
export const NAV_EVENTS: readonly string[] = ['popstate', 'hashchange'];

export interface NavigationWatcher {
  /** Poll now — cheap string compare; safe to call from a 1 Hz heartbeat. */
  check(): void;
  /** Current URL as last observed. */
  currentUrl(): string;
  /** Restore the host's history methods and drop listeners. */
  dispose(): void;
}

/**
 * Watch `host` for same-document navigations. `onNavigate` fires only when
 * the URL actually changed (routers call replaceState constantly).
 */
export function watchNavigation(
  host: NavigationHost,
  onNavigate: (url: string, previousUrl: string) => void,
): NavigationWatcher {
  let last = host.currentUrl();
  let disposed = false;

  const check = (): void => {
    if (disposed) return;
    const next = host.currentUrl();
    if (next === last) return;
    const previous = last;
    last = next;
    onNavigate(next, previous);
  };

  const originalPush = host.history.pushState;
  const originalReplace = host.history.replaceState;
  host.history.pushState = function patchedPush(
    this: HistoryLike,
    data: unknown,
    unused: string,
    url?: string | null,
  ): void {
    originalPush.call(this, data, unused, url);
    check();
  };
  host.history.replaceState = function patchedReplace(
    this: HistoryLike,
    data: unknown,
    unused: string,
    url?: string | null,
  ): void {
    originalReplace.call(this, data, unused, url);
    check();
  };
  for (const type of NAV_EVENTS) host.addEventListener(type, check);

  return {
    check,
    currentUrl: () => last,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      host.history.pushState = originalPush;
      host.history.replaceState = originalReplace;
      for (const type of NAV_EVENTS) host.removeEventListener(type, check);
    },
  };
}
