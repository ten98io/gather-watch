/**
 * Whether the room overlay is put on the page at all — the content script's
 * half of it. What the panel looks like once mounted is overlay/'s business
 * and has its own tests; this file is about the three rules that decide
 * whether it exists:
 *
 *   - the TOP frame only (this script runs in every frame of every page),
 *   - the tab that is in a room only (the worker answers that question, and
 *     for almost every tab in the browser the answer is no),
 *   - exactly one instance, however many times the site navigates under it.
 *
 * The overlay module itself is mocked, so a test can also state something no
 * assertion about the DOM could: that on a page with no room the module is
 * never even loaded.
 *
 * content.ts registers its listeners at import time, so the fake browser below
 * is installed BEFORE the module is loaded — as in test/content-drive.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── the overlay, mocked: mounting is what we are measuring ─────────────── */

interface MountRecord {
  initialState: unknown;
  updates: unknown[];
  destroyed: boolean;
  send: (message: unknown) => Promise<unknown>;
}

const overlayModule = vi.hoisted(() => ({
  /** Times the module was actually loaded. 0 on a page with no room. */
  loaded: 0,
  mounts: [] as Array<{
    initialState: unknown;
    updates: unknown[];
    destroyed: boolean;
    send: (message: unknown) => Promise<unknown>;
  }>,
}));

vi.mock('../src/overlay', () => {
  overlayModule.loaded += 1;
  return {
    mountOverlay: (opts: {
      initialState: unknown;
      send: (message: unknown) => Promise<unknown>;
    }) => {
      const record: MountRecord = {
        initialState: opts.initialState,
        updates: [],
        destroyed: false,
        send: opts.send,
      };
      overlayModule.mounts.push(record);
      return {
        update: (state: unknown): void => {
          record.updates.push(state);
        },
        destroy: (): void => {
          record.destroyed = true;
        },
      };
    },
  };
});

/* ── the fake page and browser ──────────────────────────────────────────── */

/** What the worker answers `overlay:state` with: the room, or null. */
let room: Record<string, unknown> | null = null;
/** Whether the worker accepts what the overlay sends it. */
let accepting = true;
/** Everything the content script sent the worker. */
const runtimeSent: Array<Record<string, unknown>> = [];

type MessageListener = (
  msg: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

const listeners: MessageListener[] = [];

const location = { href: 'https://example.com/watch?v=1', origin: 'https://example.com' };

interface WindowFake {
  addEventListener: () => void;
  removeEventListener: () => void;
  postMessage: () => void;
  top: unknown;
}

let win: WindowFake;

function installBrowserFake(): void {
  const noop = (): void => undefined;
  const g = globalThis as unknown as Record<string, unknown>;

  win = {
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    top: null,
  };
  win.top = win;

  g['window'] = win;
  g['location'] = location;
  g['history'] = { pushState: noop, replaceState: noop };
  g['document'] = {
    documentElement: {},
    addEventListener: noop,
    querySelector: (): unknown => null,
    // No media on this page at all: nothing here is about driving.
    querySelectorAll: (): unknown[] => [],
  };
  g['MutationObserver'] = class {
    observe(): void {}
    disconnect(): void {}
  };
  g['chrome'] = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getManifest: () => ({ version: '0.1.0' }),
      onMessage: {
        addListener: (fn: MessageListener) => {
          listeners.push(fn);
        },
        removeListener: noop,
      },
      sendMessage: async (msg: Record<string, unknown>): Promise<unknown> => {
        runtimeSent.push(msg);
        if (msg['kind'] === 'overlay:state') return { ok: true, value: room };
        if (String(msg['kind']).startsWith('overlay:')) {
          return accepting ? { ok: true, value: null } : { ok: false, error: 'refused' };
        }
        return undefined;
      },
    },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  };
}

/** Hand a message to the content script the way the worker's port would. */
function deliver(msg: Record<string, unknown>): void {
  for (const listener of [...listeners]) listener(msg, {}, () => undefined);
}

/** An SPA route change: the site swaps the URL under a live document. */
function navigateTo(url: string): void {
  location.href = url;
  (globalThis as unknown as { history: { pushState: (a: unknown, b: string) => void } }).history.pushState(
    {},
    '',
  );
}

/** Let the dynamic import (and the promises around it) finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

const sentKinds = (kind: string): Array<Record<string, unknown>> =>
  runtimeSent.filter((m) => m['kind'] === kind);

const live = (): MountRecord[] => overlayModule.mounts.filter((m) => !m.destroyed);

const ROOM_STATE = {
  connection: 'live',
  roomName: 'Movie night',
  people: [{ id: 'user_1', name: 'Ana', you: true }],
  messages: [],
  sync: null,
};

beforeAll(async () => {
  // Fake timers before the import: content.ts arms a 1 Hz heartbeat at module
  // scope, and nothing here wants it running on its own.
  vi.useFakeTimers();
  installBrowserFake();
  await import('../src/content');
  await settle();
});

afterAll(() => {
  vi.useRealTimers();
});

/* ── the ordinary case: a page in no room ───────────────────────────────── */

describe('a page that is in no room', () => {
  it('never loads the overlay module at all', () => {
    expect(overlayModule.loaded).toBe(0);
    expect(overlayModule.mounts).toEqual([]);
  });

  it('asks the worker once, on load, and takes no for an answer', () => {
    expect(sentKinds('overlay:state')).toHaveLength(1);
  });

  it('asks again after a route change, and still mounts nothing', async () => {
    navigateTo('https://example.com/watch?v=2');
    await settle();

    expect(sentKinds('overlay:state')).toHaveLength(2);
    expect(overlayModule.loaded).toBe(0);
  });
});

/* ── the tab that is in a room ──────────────────────────────────────────── */

describe('the tab that is in a room', () => {
  beforeEach(() => {
    room = ROOM_STATE;
  });

  it('puts the room on the page when the worker pushes it', async () => {
    deliver({ kind: 'overlay', state: ROOM_STATE });
    await settle();

    expect(live()).toHaveLength(1);
    expect(live()[0]?.initialState).toEqual(ROOM_STATE);
  });

  it('refreshes the panel it has instead of mounting a second one', async () => {
    const next = { ...ROOM_STATE, connection: 'reconnecting' };
    deliver({ kind: 'overlay', state: next });
    await settle();

    expect(overlayModule.mounts).toHaveLength(1);
    expect(live()[0]?.updates).toContainEqual(next);
  });

  /**
   * The failure this rules out: a site that routes twenty times in an evening
   * leaving twenty panels stacked on the page, each with its own listeners.
   */
  it('survives repeated route changes as exactly one panel', async () => {
    for (const url of ['/a', '/b', '/c', '/d']) {
      navigateTo(`https://example.com${url}`);
      await settle();
    }

    expect(overlayModule.mounts).toHaveLength(1);
    expect(live()).toHaveLength(1);
  });

  it('loads the overlay module exactly once, however many pushes arrive', async () => {
    deliver({ kind: 'overlay', state: ROOM_STATE });
    await settle();

    expect(overlayModule.loaded).toBe(1);
  });

  it('takes the panel away when the room ends', async () => {
    deliver({ kind: 'overlayOff' });
    await settle();

    expect(live()).toHaveLength(0);
    expect(overlayModule.mounts[0]?.destroyed).toBe(true);
  });

  it('puts it back when a room arrives again', async () => {
    deliver({ kind: 'overlay', state: ROOM_STATE });
    await settle();

    expect(overlayModule.mounts).toHaveLength(2);
    expect(live()).toHaveLength(1);
  });

  it('leaves when the worker says this tab is no longer the room’s', async () => {
    room = null;
    navigateTo('https://example.com/somewhere-else');
    await settle();

    expect(live()).toHaveLength(0);
  });
});

/* ── the overlay's own channel ──────────────────────────────────────────── */

describe('what the overlay sends', () => {
  beforeEach(async () => {
    room = ROOM_STATE;
    accepting = true;
    deliver({ kind: 'overlay', state: ROOM_STATE });
    await settle();
  });

  it('carries a message straight through to the worker', async () => {
    const panel = live()[0];
    if (panel === undefined) throw new Error('expected a mounted panel');

    await expect(panel.send({ kind: 'overlay:chat', text: 'hello' })).resolves.toBeNull();

    expect(sentKinds('overlay:chat')).toContainEqual({ kind: 'overlay:chat', text: 'hello' });
  });

  /** The overlay puts a real sentence in front of the user when a send fails,
   *  so a refusal that resolved would be a lie about a message nobody got. */
  it('rejects when the worker refused it', async () => {
    accepting = false;
    const panel = live()[0];
    if (panel === undefined) throw new Error('expected a mounted panel');

    await expect(panel.send({ kind: 'overlay:chat', text: 'hello' })).rejects.toThrow(
      'The room did not take that.',
    );
  });
});

/* ── every other frame on the page ──────────────────────────────────────── */

describe('a frame that is not the top one', () => {
  /**
   * The same script runs in the player iframe, the ad slots and every tracking
   * pixel on the page. One overlay per frame is the failure mode this repo has
   * already hit with content scripts, so a subframe must not so much as ask.
   */
  it('never asks, and never mounts, whatever the worker sends it', async () => {
    const loadedBefore = overlayModule.loaded;
    const mountsBefore = overlayModule.mounts.length;
    const askedBefore = sentKinds('overlay:state').length;

    // A second copy of the script, this time somewhere other than the top.
    // A real subframe is a different global scope, so its boot sentinel starts
    // unset — the shared globalThis here is the harness's artifact, and the
    // flag is cleared to reproduce the frame's actual starting state.
    vi.resetModules();
    delete (globalThis as Record<string, unknown>)['__gatherContentBooted'];
    listeners.length = 0;
    win.top = { differentFrom: 'this one' };
    room = ROOM_STATE;
    await import('../src/content');
    await settle();

    deliver({ kind: 'overlay', state: ROOM_STATE });
    await settle();

    expect(sentKinds('overlay:state')).toHaveLength(askedBefore);
    expect(overlayModule.mounts).toHaveLength(mountsBefore);
    expect(overlayModule.loaded).toBe(loadedBefore);
  });
});
