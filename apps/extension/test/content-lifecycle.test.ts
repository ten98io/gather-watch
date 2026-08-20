/**
 * What the content script takes down when the page goes away, and what it puts
 * back when the page COMES BACK.
 *
 * `pagehide` fires for both, and the two are told apart by `pageshow`'s
 * `persisted` flag: a document entering the back/forward cache is frozen, not
 * destroyed, and is handed back intact. The teardown used to have no partner,
 * so a tab that went Back and then Forward came back with a disposed
 * navigation watcher and a disconnected mutation observer — both of which fail
 * silently, which is why this file measures what the script SENDS rather than
 * what it holds.
 *
 * content.ts registers its listeners at import time, so the fake browser below
 * is installed BEFORE the module is loaded, as in test/content-drive.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── the fake page and browser ──────────────────────────────────────────── */

type WindowListener = (ev: Record<string, unknown>) => void;

/** Every listener the script put on `window`, by event type. */
const windowListeners = new Map<string, WindowListener[]>();
/** Everything the content script told the worker, in order. */
const toWorker: Array<Record<string, unknown>> = [];
/** observe/disconnect on the mutation observer, in order — a restore has to
 *  re-observe, and an ordinary load must not observe twice. */
const observerCalls: string[] = [];

const location = { href: 'https://example.com/watch?v=1', origin: 'https://example.com' };

/**
 * The page's own history, which the navigation watcher patches. Calling
 * `pushState` is how a single-page site changes route, and the patch is the
 * thing a teardown removes — so a push that produces nothing is a watcher
 * that is no longer there.
 */
const history = {
  pushState: (): void => undefined,
  replaceState: (): void => undefined,
};

function installBrowserFake(): void {
  const noop = (): void => undefined;
  const g = globalThis as unknown as Record<string, unknown>;

  const win = {
    addEventListener: (type: string, listener: WindowListener): void => {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
    removeEventListener: (type: string, listener: WindowListener): void => {
      const list = windowListeners.get(type) ?? [];
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    },
    postMessage: noop,
    top: null as unknown,
  };
  win.top = win;

  g['window'] = win;
  g['location'] = location;
  g['history'] = history;
  g['document'] = {
    documentElement: {},
    addEventListener: noop,
    querySelector: (): unknown => null,
    // No media at all: this file is about the lifecycle, not about driving.
    querySelectorAll: (): unknown[] => [],
  };
  g['MutationObserver'] = class {
    observe(): void {
      observerCalls.push('observe');
    }

    disconnect(): void {
      observerCalls.push('disconnect');
    }
  };
  g['chrome'] = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getManifest: () => ({ version: '0.1.0' }),
      onMessage: { addListener: noop, removeListener: noop },
      // Every tab in this file is in no room, so the overlay is never loaded.
      sendMessage: async (msg: Record<string, unknown>): Promise<unknown> => {
        toWorker.push(msg);
        return msg['kind'] === 'overlay:state' ? { ok: true, value: null } : undefined;
      },
    },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  };
}

/** Fire a window event the way the browser would. */
function fire(type: string, ev: Record<string, unknown> = {}): void {
  for (const listener of [...(windowListeners.get(type) ?? [])]) listener({ type, ...ev });
}

/** A single-page route change: the site swaps the URL under a live document. */
function navigateTo(url: string): void {
  location.href = url;
  history.pushState();
}

/** Let the promises the script started settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

const sentKinds = (kind: string): Array<Record<string, unknown>> =>
  toWorker.filter((m) => m['kind'] === kind);

beforeAll(async () => {
  // Fake timers before the import: content.ts arms a 1 Hz heartbeat at boot,
  // and nothing here wants it running on its own.
  vi.useFakeTimers();
  installBrowserFake();
  // The boot sentinel lives on globalThis and survives vi.resetModules, so
  // the harness starts from the state a fresh document is in: no flag.
  delete (globalThis as Record<string, unknown>)['__gatherContentBooted'];
  await import('../src/content');
  await settle();
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  toWorker.length = 0;
  observerCalls.length = 0;
});

describe('an ordinary load arms the page exactly once', () => {
  it('watches for route changes, and reports one route change per push', async () => {
    navigateTo('https://example.com/watch?v=2');
    await settle();

    expect(sentKinds('provider')).toHaveLength(1);
  });

  /** `pageshow` fires on a normal load too, with `persisted` false. Arming a
   *  second time would patch `history` twice and double every route change. */
  it('is not armed again by the pageshow an ordinary load fires', async () => {
    fire('pageshow', { persisted: false });
    await settle();

    navigateTo('https://example.com/watch?v=3');
    await settle();

    expect(sentKinds('provider')).toHaveLength(1);
    expect(observerCalls).toEqual([]);
  });
});

describe('a second injection into the same document', () => {
  /**
   * The narrowed permission model injects this script twice on purpose: the
   * registered (or declarative) script covers the document on load, and the
   * worker's executeScript one-shot covers tabs that were already open when a
   * grant landed or the popup connected. The boot sentinel on globalThis makes
   * the second evaluation a no-op — without it every listener, observer and
   * heartbeat would exist twice and the frame would claim and report double.
   */
  it('does nothing at all — no listener, no observer, no report', async () => {
    const listenersBefore = new Map([...windowListeners].map(([type, list]) => [type, list.length]));

    // The same document, injected again: a fresh module evaluation, the same
    // globalThis, the flag already set by the first copy.
    vi.resetModules();
    await import('../src/content');
    await settle();

    expect(toWorker).toEqual([]);
    expect(observerCalls).toEqual([]);
    for (const [type, list] of windowListeners) {
      expect(list.length, type).toBe(listenersBefore.get(type) ?? 0);
    }
  });
});

describe('a page put aside in the back/forward cache', () => {
  it('stops watching while it is away', async () => {
    fire('pagehide', { persisted: true });
    await settle();
    expect(observerCalls).toEqual(['disconnect']);
    toWorker.length = 0;

    // The site's router is gone with the document's freeze; nothing here
    // should be reported to a worker that is not driving this tab.
    navigateTo('https://example.com/watch?v=4');
    await settle();

    expect(toWorker).toEqual([]);
  });

  /**
   * The whole defect: a restore used to leave the tab with a disposed watcher
   * for as long as it stayed open, so a route change was never noticed again
   * and the overlay never came back.
   */
  it('is re-armed when it comes back, and watches route changes again', async () => {
    fire('pagehide', { persisted: true });
    await settle();
    toWorker.length = 0;
    observerCalls.length = 0;

    fire('pageshow', { persisted: true });
    await settle();

    // The restore itself re-states this frame to the worker: its claim has
    // long since expired out of the election, and it asks again whether this
    // tab is in a room.
    expect(observerCalls).toEqual(['observe']);
    expect(sentKinds('provider')).toHaveLength(1);
    expect(sentKinds('frameClaim')).toHaveLength(1);
    expect(sentKinds('overlay:state')).toHaveLength(1);

    toWorker.length = 0;
    navigateTo('https://example.com/watch?v=5');
    await settle();

    expect(sentKinds('provider')).toHaveLength(1);
    expect(sentKinds('overlay:state')).toHaveLength(1);
  });

  it('survives being put aside and brought back repeatedly, as one watcher', async () => {
    for (const round of [6, 7, 8]) {
      fire('pagehide', { persisted: true });
      await settle();
      fire('pageshow', { persisted: true });
      await settle();
      toWorker.length = 0;

      navigateTo(`https://example.com/watch?v=${String(round)}`);
      await settle();

      // Two watchers would report the same route change twice.
      expect(sentKinds('provider')).toHaveLength(1);
    }
  });
});
