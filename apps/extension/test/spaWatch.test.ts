import { describe, expect, it } from 'vitest';
import { NAV_EVENTS, watchNavigation } from '../src/spaWatch';
import type { NavigationHost } from '../src/spaWatch';

/** A fake page: a mutable URL, a history object, and an event bus. */
function fakeHost(initial: string): NavigationHost & {
  url: string;
  fire(type: string): void;
  listenerCount(): number;
  pushCalls: number;
} {
  const listeners = new Map<string, Set<() => void>>();
  const host = {
    url: initial,
    pushCalls: 0,
    history: {
      pushState(this: unknown, _data: unknown, _unused: string, url?: string | null): void {
        host.pushCalls += 1;
        if (typeof url === 'string') host.url = url;
      },
      replaceState(this: unknown, _data: unknown, _unused: string, url?: string | null): void {
        if (typeof url === 'string') host.url = url;
      },
    },
    currentUrl: () => host.url,
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type: string) => {
      for (const l of [...(listeners.get(type) ?? [])]) l();
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return host;
}

describe('watchNavigation', () => {
  it('fires on pushState in the same JS world, keeping the original behaviour', () => {
    const host = fakeHost('https://www.youtube.com/');
    const seen: Array<[string, string]> = [];
    watchNavigation(host, (url, previous) => seen.push([url, previous]));

    host.history.pushState({}, '', 'https://www.youtube.com/watch?v=abc');
    expect(host.pushCalls).toBe(1); // original still ran
    expect(seen).toEqual([['https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/']]);
  });

  it('ignores replaceState that does not change the URL (routers spam it)', () => {
    const host = fakeHost('https://app.example/room');
    let fired = 0;
    watchNavigation(host, () => {
      fired += 1;
    });
    host.history.replaceState({}, '', 'https://app.example/room');
    host.history.replaceState({}, '', 'https://app.example/room');
    expect(fired).toBe(0);
  });

  it('fires on popstate and hashchange', () => {
    const host = fakeHost('https://example.com/a');
    const seen: string[] = [];
    watchNavigation(host, (url) => seen.push(url));

    host.url = 'https://example.com/b';
    host.fire('popstate');
    host.url = 'https://example.com/b#t=10';
    host.fire('hashchange');
    expect(seen).toEqual(['https://example.com/b', 'https://example.com/b#t=10']);
  });

  it('catches page-world navigations through check() polling', () => {
    // A content script lives in an isolated world: the page's own pushState
    // never runs through our patch. Polling is the safety net.
    const host = fakeHost('https://www.netflix.com/browse');
    const seen: string[] = [];
    const watcher = watchNavigation(host, (url) => seen.push(url));

    host.url = 'https://www.netflix.com/watch/80100172'; // changed behind our back
    expect(seen).toEqual([]);
    watcher.check();
    expect(seen).toEqual(['https://www.netflix.com/watch/80100172']);
    expect(watcher.currentUrl()).toBe('https://www.netflix.com/watch/80100172');
    watcher.check(); // idempotent
    expect(seen).toHaveLength(1);
  });

  it('restores the host completely on dispose', () => {
    const host = fakeHost('https://example.com/');
    const originalPush = host.history.pushState;
    const watcher = watchNavigation(host, () => undefined);
    expect(host.history.pushState).not.toBe(originalPush);
    expect(host.listenerCount()).toBe(NAV_EVENTS.length);

    watcher.dispose();
    expect(host.history.pushState).toBe(originalPush);
    expect(host.listenerCount()).toBe(0);

    let fired = 0;
    const after = watchNavigation(host, () => {
      fired += 1;
    });
    after.dispose();
    host.url = 'https://example.com/next';
    after.check();
    expect(fired).toBe(0); // disposed watchers stay quiet
  });
});
