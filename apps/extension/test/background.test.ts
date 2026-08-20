/**
 * What the background worker decides BEFORE any pixel is captured: which
 * surface to ask for, what to refuse, and exactly what the offscreen document
 * is told. It owns none of the capture itself — that is offscreen.ts — so the
 * assertions here are about the plan and the message, never about a stream.
 *
 * background.ts registers its chrome listeners at import time, so the fake
 * below is installed BEFORE the module is loaded (hence the dynamic import).
 * The fake is deliberately dumb: recorded calls and canned answers, in the
 * style of test/cast.test.ts and test/mediaDriver.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DesktopPick,
  DesktopSource,
  ShareDeps,
  ShareResult,
  ShareRoom,
} from '../src/background';
import { providerForUrl } from '../src/providers';
import type { TabProvider } from '../src/providers';

/**
 * The room socket is the one dependency this file cannot stand up: it opens a
 * real WebSocket. This stand-in owns a room the same way the real one does —
 * it remembers the handlers the worker subscribed with, so a test can deliver
 * a room event, and it records what the worker sent back to the room.
 *
 * Only the newest socket's handlers stay live: a real one is closed and
 * replaced when the room changes, and a closed socket delivers nothing.
 */
const room = vi.hoisted(() => ({
  handlers: new Map<string, Array<(ev: { type: string; payload: unknown }) => void>>(),
  sent: [] as Array<{ type: string; payload: unknown }>,
  status: 'open' as string,
  emit(type: string, payload: unknown): void {
    for (const handler of [...(room.handlers.get(type) ?? [])]) handler({ type, payload });
  },
  reset(): void {
    room.handlers.clear();
    room.sent.length = 0;
    room.status = 'open';
  },
}));

vi.mock('@gather/api-client', () => ({
  RoomSocket: class {
    readonly clock = { serverNow: (now: number) => now };

    constructor() {
      room.handlers.clear();
    }

    get status(): string {
      return room.status;
    }

    connect(): void {}

    send(type: string, payload: unknown): void {
      room.sent.push({ type, payload });
    }

    on(type: string, handler: (ev: { type: string; payload: unknown }) => void): () => void {
      const list = room.handlers.get(type) ?? [];
      list.push(handler);
      room.handlers.set(type, list);
      return () => undefined;
    }

    close(): void {}
  },
}));

/* ── the browser, faked ── */

interface DesktopCall {
  sources: readonly string[];
  /** Argument count proves no targetTab was passed (it would bind the stream
   *  to a tab's origin and lock the offscreen document out of it). */
  argCount: number;
}

/** The worker's internal channel: the popup, and the offscreen document. */
type MessageListener = (
  msg: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

interface FakeEvent<F> {
  addListener(fn: F): void;
  removeListener(): void;
  listeners: F[];
}

/** One message the worker addressed to a tab — and to which frame of it. */
interface TabMessage {
  tabId: number;
  frameId: number | undefined;
  msg: Record<string, unknown>;
}

interface ChromeFake {
  desktopCalls: DesktopCall[];
  tabCaptureCalls: number[];
  sent: Array<Record<string, unknown>>;
  /** Dynamic content-script registrations, exactly as the browser holds them. */
  registrations: Map<string, Record<string, unknown>>;
  /** scripting.executeScript injections, in order. */
  executed: Array<{ tabId: number; allFrames: boolean; files: string[] }>;
  /** Origin match patterns the user has granted (chrome.permissions). */
  grantedOrigins: string[];
  onInstalled: FakeEvent<(details: Record<string, unknown>) => void>;
  onStartup: FakeEvent<() => void>;
  onPermissionsAdded: FakeEvent<(p: { origins?: string[] }) => void>;
  onPermissionsRemoved: FakeEvent<(p: { origins?: string[] }) => void>;
  /** Everything sent into a page: drive, frameRole, driveOff, overlay. */
  tabMessages: TabMessage[];
  /** URLs the worker opened a tab for. */
  createdTabs: string[];
  /** What the next picker call answers with. */
  nextPick: { streamId: string; canRequestAudioTrack: boolean };
  nextTabStreamId: string;
  /** What the offscreen document answers a 'startShare' with. */
  nextShareReply: unknown;
  /** The offscreen document exists only while something is being captured. */
  offscreenOpen: boolean;
  offscreenCreated: number;
  offscreenClosed: number;
  /** Had the stop been delivered by the time the document was closed? Closing
   *  first would strand every viewer on a frozen last frame. */
  stopBeforeClose: boolean | null;
  /** Make the offscreen API reject, as it does once the document is gone. */
  offscreenBroken: boolean;
  activeTab: { id: number; url: string } | null;
  /**
   * What each tab the browser has is showing.
   *
   * The worker classifies a tab by asking `chrome.tabs.get` for its URL, so
   * this map is how a test says "that tab is Netflix" — and, crucially, how it
   * says so WITHOUT a content script having reported anything, which is the
   * state every open tab is in after MV3 recycles the worker.
   */
  tabUrls: Map<number, string>;
  /** Tabs the browser no longer has. `chrome.tabs.get` refuses these, which is
   *  how the worker learns a tab it remembers is gone. */
  closedTabs: Set<number>;
  /** chrome.storage.session, for real — see the storage fake. */
  store: Record<string, unknown>;
  onMessage: FakeEvent<MessageListener>;
  onRemoved: FakeEvent<(tabId: number) => void>;
  /** Chrome's notice that a tab is showing something else — see navigateTab. */
  onUpdated: FakeEvent<
    (tabId: number, change: Record<string, unknown>, tab: Record<string, unknown>) => void
  >;
  /** The web app's event port arrives here — see openEventPort. */
  onConnectExternal: FakeEvent<(port: unknown) => void>;
  /** Chrome's notice that it is about to terminate the worker. The worker
   *  stops its own timers on it, which is how a simulated recycle stops them. */
  onSuspend: FakeEvent<() => void>;
  /** Every event the fake exposes, so a simulated worker death can drop the
   *  dead worker's listeners the way terminating one really does. */
  allEvents: Array<{ listeners: unknown[] }>;
}

/** Chrome match pattern → does it admit this URL? `<all_urls>` admits all,
 *  and a `*.host` pattern admits the bare host too, as Chrome's do. */
function matchesPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace('://*\\.', '://([^/]+\\.)?').split('*').join('.*');
  return new RegExp(`^${source}`).test(url);
}

function installChromeFake(): ChromeFake {
  const allEvents: Array<{ listeners: unknown[] }> = [];
  function evt<F = () => void>(): FakeEvent<F> {
    const listeners: F[] = [];
    allEvents.push({ listeners: listeners as unknown[] });
    return {
      listeners,
      addListener: (fn: F) => {
        listeners.push(fn);
      },
      removeListener: () => undefined,
    };
  }

  const onMessage = evt<MessageListener>();
  const onRemoved = evt<(tabId: number) => void>();
  const onUpdated =
    evt<(tabId: number, change: Record<string, unknown>, tab: Record<string, unknown>) => void>();
  const onConnectExternal = evt<(port: unknown) => void>();
  const onSuspend = evt<() => void>();
  const onInstalled = evt<(details: Record<string, unknown>) => void>();
  const onStartup = evt<() => void>();
  const onPermissionsAdded = evt<(p: { origins?: string[] }) => void>();
  const onPermissionsRemoved = evt<(p: { origins?: string[] }) => void>();
  const state: ChromeFake = {
    desktopCalls: [],
    tabCaptureCalls: [],
    sent: [],
    registrations: new Map<string, Record<string, unknown>>(),
    executed: [],
    grantedOrigins: [],
    onInstalled,
    onStartup,
    onPermissionsAdded,
    onPermissionsRemoved,
    tabMessages: [],
    createdTabs: [],
    nextPick: { streamId: 'desktop-stream-1', canRequestAudioTrack: false },
    nextTabStreamId: 'tab-stream-1',
    nextShareReply: { ok: true, audio: true, note: '' },
    offscreenOpen: false,
    offscreenCreated: 0,
    offscreenClosed: 0,
    stopBeforeClose: null,
    offscreenBroken: false,
    activeTab: { id: 7, url: 'https://example.com/watch' },
    tabUrls: new Map<number, string>([[7, 'https://example.com/watch']]),
    closedTabs: new Set<number>(),
    store: {},
    onMessage,
    onRemoved,
    onUpdated,
    onConnectExternal,
    onSuspend,
    allEvents,
  };

  const chrome = {
    runtime: {
      onMessage,
      onMessageExternal: evt(),
      onConnectExternal,
      onSuspend,
      onInstalled,
      onStartup,
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: async (msg: Record<string, unknown>) => {
        state.sent.push(msg);
        if (msg['kind'] === 'startShare') return state.nextShareReply;
        if (msg['kind'] === 'stopShare') return { ok: true, stopped: true };
        return undefined;
      },
    },
    tabs: {
      onActivated: evt(),
      onUpdated,
      onRemoved,
      // A closed tab is not a tab: Chrome rejects, and that rejection is the
      // only way the worker can tell a remembered tab id from an open one.
      get: async (tabId: number) => {
        if (state.closedTabs.has(tabId)) throw new Error(`No tab with id: ${String(tabId)}`);
        return { id: tabId, url: state.tabUrls.get(tabId) };
      },
      // `url` asks about EVERY open tab (the one-shot after a new grant);
      // without it, the active-tab answer every other caller expects.
      query: async (opts?: { url?: string | string[] }) => {
        if (opts?.url === undefined) return state.activeTab === null ? [] : [state.activeTab];
        const patterns = Array.isArray(opts.url) ? opts.url : [opts.url];
        const out: Array<{ id: number; url: string }> = [];
        for (const [tabId, url] of state.tabUrls) {
          if (state.closedTabs.has(tabId)) continue;
          if (patterns.some((p) => matchesPattern(p, url))) out.push({ id: tabId, url });
        }
        return out;
      },
      sendMessage: async (
        tabId: number,
        msg: Record<string, unknown>,
        opts?: { frameId?: number },
      ) => {
        state.tabMessages.push({ tabId, frameId: opts?.frameId, msg });
        return undefined;
      },
      create: async (opts: { url: string }) => {
        state.createdTabs.push(opts.url);
        return { id: 99 };
      },
    },
    alarms: { onAlarm: evt(), create: async () => undefined, clear: async () => true },
    permissions: {
      onAdded: onPermissionsAdded,
      onRemoved: onPermissionsRemoved,
      getAll: async () => ({ permissions: [], origins: [...state.grantedOrigins] }),
      contains: async (opts: { origins?: string[] }) =>
        (opts.origins ?? []).every((o) => state.grantedOrigins.includes(o)),
      request: async (opts: { origins?: string[] }) => {
        for (const origin of opts.origins ?? []) {
          if (!state.grantedOrigins.includes(origin)) state.grantedOrigins.push(origin);
        }
        return true;
      },
    },
    scripting: {
      registerContentScripts: async (scripts: Array<Record<string, unknown>>) => {
        for (const script of scripts) {
          const id = String(script['id']);
          // Chrome refuses a duplicate id — the worker must update instead.
          if (state.registrations.has(id)) throw new Error(`Duplicate script ID '${id}'`);
          state.registrations.set(id, { ...script });
        }
      },
      updateContentScripts: async (scripts: Array<Record<string, unknown>>) => {
        for (const script of scripts) {
          const id = String(script['id']);
          const existing = state.registrations.get(id);
          if (existing === undefined) throw new Error(`Nonexistent script ID '${id}'`);
          state.registrations.set(id, { ...existing, ...script });
        }
      },
      unregisterContentScripts: async (filter?: { ids?: string[] }) => {
        for (const id of filter?.ids ?? [...state.registrations.keys()]) {
          state.registrations.delete(id);
        }
      },
      getRegisteredContentScripts: async (filter?: { ids?: string[] }) => {
        const all = [...state.registrations.values()];
        if (filter?.ids === undefined) return all;
        return all.filter((s) => filter.ids?.includes(String(s['id'])) === true);
      },
      executeScript: async (opts: {
        target: { tabId: number; allFrames?: boolean };
        files?: string[];
      }) => {
        // A closed tab cannot take an injection, exactly like tabs.get.
        if (state.closedTabs.has(opts.target.tabId)) {
          throw new Error(`No tab with id: ${String(opts.target.tabId)}`);
        }
        state.executed.push({
          tabId: opts.target.tabId,
          allFrames: opts.target.allFrames === true,
          files: [...(opts.files ?? [])],
        });
        return [];
      },
    },
    storage: {
      // Really stores: the share-room mirror exists precisely to outlive the
      // worker, so a fake that forgets everything cannot test it.
      session: {
        get: async (key: string) =>
          key in state.store ? { [key]: state.store[key] } : {},
        set: async (bag: Record<string, unknown>) => {
          Object.assign(state.store, bag);
        },
        remove: async (key: string) => {
          delete state.store[key];
        },
      },
    },
    offscreen: {
      hasDocument: async () => {
        if (state.offscreenBroken) throw new Error('offscreen API unavailable');
        return state.offscreenOpen;
      },
      createDocument: async () => {
        state.offscreenCreated += 1;
        state.offscreenOpen = true;
      },
      closeDocument: async () => {
        if (state.offscreenBroken) throw new Error('no offscreen document to close');
        state.stopBeforeClose = state.sent.some((m) => m['kind'] === 'stopShare');
        state.offscreenClosed += 1;
        state.offscreenOpen = false;
      },
    },
    tabCapture: {
      getMediaStreamId: async (opts: { targetTabId: number }) => {
        state.tabCaptureCalls.push(opts.targetTabId);
        return state.nextTabStreamId;
      },
    },
    desktopCapture: {
      // Rest args on purpose: the OVERLOAD that was called is the thing under
      // test — a second argument would be a targetTab.
      chooseDesktopMedia: (...args: unknown[]): number => {
        const sources = args[0] as string[];
        const callback = args[args.length - 1] as (
          streamId: string,
          options: { canRequestAudioTrack: boolean },
        ) => void;
        state.desktopCalls.push({ sources, argCount: args.length });
        callback(state.nextPick.streamId, {
          canRequestAudioTrack: state.nextPick.canRequestAudioTrack,
        });
        return 1;
      },
    },
  };

  (globalThis as unknown as Record<string, unknown>)['chrome'] = chrome;
  return state;
}

/** The guest join the popup path performs before a room can be shared. */
/** Mutable so a test can express "the user opened a DIFFERENT room". */
let joinRoomId = 'room_1';
/** Mutable so a test can express "nothing on this path named the user" —
 *  which is the web-handoff path's normal state, and the state a share must
 *  never be signed in. */
let joinUserId: string | null = 'user_1';
const GUEST_WIRE = (): Record<string, unknown> => ({
  ...(joinUserId === null ? {} : { user: { id: joinUserId } }),
  room: { id: joinRoomId, name: 'Movie night' },
  accessToken: 'tok_abc',
});

/** What the room's member list answers with. Empty = the API said nothing
 *  useful, which is the case every other test runs under. */
let membersWire: Record<string, unknown> = {};
/** What GET /rooms/:id answers: the room's policies and OUR member record.
 *  Empty = the API said nothing useful — and unknown DENIES playback control,
 *  which is what every other test runs under. */
let roomWire: Record<string, unknown> = {};
/** Every URL the worker fetched, so a test can say what it did NOT fetch. */
let fetched: string[] = [];
/** …and each request's body, so a test can say what a join DID carry. */
let fetchedBodies: Array<{ url: string; body: string }> = [];
/** Make GET /rooms/:id never answer, as a dead network does. */
let hangRoomFetch = false;

/** The ordinary page every test starts on: a site in no registry, with a
 *  player. Its provider is 'generic', which refuses nothing. */
const WATCH_URL = 'https://example.com/watch';
/** A tab showing nothing classifiable — the worker caches no answer for one. */
const BLANK_URL = 'about:blank';
/** Every tab id this file uses. Reset between tests, because the worker's
 *  classification of a tab outlives the test that navigated it. */
const TEST_TABS: readonly number[] = [7, 8, 9];

let fake: ChromeFake;
let bg: typeof import('../src/background');

beforeAll(async () => {
  fake = installChromeFake();
  globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
    const u = String(url);
    fetched.push(u);
    fetchedBodies.push({ url: u, body: typeof init?.body === 'string' ? init.body : '' });
    // A request that never settles — not a rejection, which every caller
    // already handles, but the silence a dead network actually produces.
    if (hangRoomFetch && /\/rooms\/[^/]+$/.test(u)) return new Promise(() => undefined);
    const body = u.includes('/members')
      ? membersWire
      : /\/rooms\/[^/]+$/.test(u)
        ? roomWire
        : GUEST_WIRE();
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  bg = await import('../src/background');
});

beforeEach(async () => {
  // End the previous test's share, through the worker's own door.
  //
  // The worker is ONE module for the whole file, so a test that deliberately
  // ends with a share still running — see 'a share outlives the worker' —
  // hands the next test a worker that still holds the claim. Resetting the
  // browser fake cannot reach it: the claim is a module variable, and the
  // fake's `offscreenOpen: false` then describes a browser that disagrees
  // with the worker, which is a state neither ever occupies in Chrome.
  await ask({ kind: 'popup:stopShare' }).catch(() => undefined);
  fake.desktopCalls.length = 0;
  fake.tabCaptureCalls.length = 0;
  fake.sent.length = 0;
  fake.tabMessages.length = 0;
  fake.createdTabs.length = 0;
  room.reset();
  membersWire = {};
  roomWire = {};
  fetched = [];
  fetchedBodies = [];
  hangRoomFetch = false;
  // Browser-held permission state, like tabUrls: reset to a browser that has
  // granted nothing and registered nothing.
  fake.grantedOrigins.length = 0;
  fake.registrations.clear();
  fake.executed.length = 0;
  fake.nextPick = { streamId: 'desktop-stream-1', canRequestAudioTrack: false };
  fake.nextTabStreamId = 'tab-stream-1';
  fake.nextShareReply = { ok: true, audio: true, note: '' };
  fake.offscreenOpen = false;
  fake.offscreenCreated = 0;
  fake.offscreenClosed = 0;
  for (const key of Object.keys(fake.store)) delete fake.store[key];
  joinRoomId = 'room_1';
  joinUserId = 'user_1';
  fake.stopBeforeClose = null;
  fake.offscreenBroken = false;
  fake.activeTab = { id: 7, url: 'https://example.com/watch' };
  fake.tabUrls.clear();
  fake.closedTabs.clear();
  // Put the browser's tabs back where every test expects them, THROUGH the
  // event the browser would fire: the worker caches what it classified a tab
  // as, so a test that left tab 7 on Netflix has to navigate it away again,
  // exactly as a user would.
  for (const tabId of TEST_TABS) navigateTab(tabId, tabId === 7 ? WATCH_URL : BLANK_URL);
  // Hang up the previous test's pages: an open port is a surface, and a leaked
  // one would tell the worker somebody is still watching.
  for (const close of livePorts.splice(0)) close();
});

/* ── talking to the worker the way the popup does ── */

interface PopupStatus {
  connected: boolean;
  roomName: string | null;
  sharing: boolean;
  /** Why the ROOM ended the last share; '' when it ended some other way. */
  shareEnded: string;
  telemetry: { positionMs: number } | null;
  /** The FULL registry entry, not the redacted summary the page gets: the
   *  popup's cast control is built out of `cast`. */
  provider: TabProvider | null;
}

/**
 * One request to the worker, answered exactly as chrome.runtime would.
 *
 * `sender` is the browser's word for who is asking — a tab id and a frame id,
 * which the worker trusts precisely because the page cannot forge them.
 */
async function ask<T>(
  msg: Record<string, unknown>,
  sender: Record<string, unknown> = {},
): Promise<T> {
  const [listener] = fake.onMessage.listeners;
  if (listener === undefined) throw new Error('the worker registered no message listener');
  return new Promise<T>((resolve, reject) => {
    const willAnswer = listener(msg, sender, (raw) => {
      const res = raw as { ok: true; value: T } | { ok: false; error: string };
      if (res.ok) resolve(res.value);
      else reject(new Error(res.error));
    });
    if (willAnswer !== true) reject(new Error(`nothing answered ${String(msg['kind'])}`));
  });
}

/** A message the worker does not answer: a claim, telemetry, a provider. */
function notify(msg: Record<string, unknown>, sender: Record<string, unknown>): void {
  const [listener] = fake.onMessage.listeners;
  if (listener === undefined) throw new Error('the worker registered no message listener');
  listener(msg, sender, () => undefined);
}

const status = (): Promise<PopupStatus> => ask<PopupStatus>({ kind: 'popup:status' });

const connectRoom = (): Promise<unknown> => ask({ kind: 'popup:connect', code: 'abcd-efgh-ijkl' });

const share = (surface: string): Promise<ShareResult> =>
  ask<ShareResult>({ kind: 'popup:share', surface });

/** Chrome removing a tab: it stops existing, and the event fires. Synchronous
 *  so a fake-timer test can settle it on its own clock. */
function removeTab(tabId: number): void {
  fake.closedTabs.add(tabId);
  for (const listener of fake.onRemoved.listeners) listener(tabId);
}

/** Chrome removing a tab. The teardown it triggers is fire-and-forget, so the
 *  caller waits a turn for it, exactly as the popup's next poll would. */
async function closeTab(tabId: number): Promise<void> {
  removeTab(tabId);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A tab goes somewhere else. Chrome's own `tabs.onUpdated` carries it, and
 * that event is the whole point: it needs no content script, so it is what
 * keeps the worker's idea of a tab true across a recycle.
 */
function navigateTab(tabId: number, url: string): void {
  fake.tabUrls.set(tabId, url);
  for (const listener of [...fake.onUpdated.listeners]) {
    listener(tabId, { url }, { id: tabId, url });
  }
}

/** Put a tab at a URL and make it the one the popup is drawn over. */
function focusTab(tabId: number, url: string): void {
  navigateTab(tabId, url);
  fake.activeTab = { id: tabId, url };
}

/**
 * A tab the browser ALREADY has, arriving with no event at all.
 *
 * This is every open tab from the point of view of a worker that has just
 * started — or just been revived, which MV3 does roughly every thirty seconds
 * of quiet. Nothing has reported it and nothing will; the only way to know
 * what it is showing is to ask the browser.
 */
function existingTab(tabId: number, url: string): void {
  fake.tabUrls.set(tabId, url);
  fake.activeTab = { id: tabId, url };
}

/** The top frame telling the worker its page changed. It carries no
 *  classification — the worker reads the tab's URL for itself. */
function pageChanged(tabId: number): void {
  notify({ kind: 'provider' }, { tab: { id: tabId } });
}

/** Let the fire-and-forget promise chains behind an event settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The browser announcing the extension is installed / the browser started. */
async function fireInstalled(): Promise<void> {
  for (const listener of [...fake.onInstalled.listeners]) listener({ reason: 'install' });
  await flush();
}

async function fireStartup(): Promise<void> {
  for (const listener of [...fake.onStartup.listeners]) listener();
  await flush();
}

/** The user grants origins: the browser records them, THEN fires the event —
 *  the order chrome.permissions itself guarantees. */
async function grantOrigins(...patterns: string[]): Promise<void> {
  for (const pattern of patterns) {
    if (!fake.grantedOrigins.includes(pattern)) fake.grantedOrigins.push(pattern);
  }
  for (const listener of [...fake.onPermissionsAdded.listeners]) listener({ origins: patterns });
  await flush();
}

/** …and takes them away again, from the extensions page. */
async function revokeOrigins(...patterns: string[]): Promise<void> {
  for (const pattern of patterns) {
    const at = fake.grantedOrigins.indexOf(pattern);
    if (at >= 0) fake.grantedOrigins.splice(at, 1);
  }
  for (const listener of [...fake.onPermissionsRemoved.listeners]) listener({ origins: patterns });
  await flush();
}

/**
 * The worker is terminated, and something wakes it.
 *
 * Everything the worker held in memory goes: its module variables, its
 * timers, its listeners, the ports pages had open on it. Everything the
 * BROWSER holds stays: chrome.storage.session, the offscreen document, the
 * user's tabs. Re-importing the module reproduces exactly that split — and
 * the import is itself the wake, because background.ts ends in
 * `void restoreSession()`.
 *
 * Callers hold the fake clock BEFORE the recycle, always: the revived worker
 * arms a fresh beat timer, and a timer armed while the clock is real is a
 * timer `advanceTimersByTime` can never reach.
 */
async function recycleWorker(): Promise<void> {
  // Chrome's notice before it terminates. The worker's own handler stops its
  // timers on it — without that, `vi.resetModules()` leaves the dead worker's
  // intervals running and two workers beat for one room.
  for (const listener of [...fake.onSuspend.listeners]) listener();
  for (const event of fake.allEvents) event.listeners.length = 0;
  room.handlers.clear();
  vi.resetModules();
  bg = await import('../src/background');
  await vi.advanceTimersByTimeAsync(0);
}

/* ── injected deps, so the plan can be tested without a browser ── */

const NETFLIX_URL = 'https://www.netflix.com/watch/80100172';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const ROOM: ShareRoom = { roomId: 'room_1', accessToken: 'tok_abc', tabId: 7, userId: 'user_1' };

/** Built by the registry rather than by hand: the refusal reads the same
 *  `drm` flag the classifier sets, and a hand-written stub can agree with it
 *  today and drift tomorrow. */
const NETFLIX = providerForUrl(NETFLIX_URL);
const YOUTUBE = providerForUrl(YOUTUBE_URL);

function fakeDeps(
  over: {
    provider?: TabProvider | undefined;
    tabStreamId?: string;
    pick?: DesktopPick;
  } = {},
): ShareDeps & { pickedSources: DesktopSource[][]; tabCaptured: number[] } {
  const pickedSources: DesktopSource[][] = [];
  const tabCaptured: number[] = [];
  return {
    pickedSources,
    tabCaptured,
    providerOf: async () => over.provider,
    tabStreamId: async (tabId) => {
      tabCaptured.push(tabId);
      return over.tabStreamId ?? 'tab-stream-1';
    },
    chooseDesktop: async (sources) => {
      pickedSources.push([...sources]);
      return over.pick ?? { streamId: 'desktop-stream-1', canRequestAudioTrack: false };
    },
  };
}

/* ── surfaces ── */

describe('desktopSources', () => {
  it('shows the asked-for surface first and still offers the others', () => {
    expect(bg.desktopSources('screen')).toEqual(['screen', 'window', 'tab', 'audio']);
    expect(bg.desktopSources('window')).toEqual(['window', 'screen', 'tab', 'audio']);
  });

  it('always asks for audio (the picker decides whether it can be given)', () => {
    for (const surface of ['screen', 'window'] as const) {
      expect(bg.desktopSources(surface)).toContain('audio');
    }
  });
});

describe('parseShareSurface', () => {
  it('defaults to the tab — absent means what shipped before surfaces existed', () => {
    expect(bg.parseShareSurface(undefined)).toBe('tab');
    expect(bg.parseShareSurface(null)).toBe('tab');
    expect(bg.parseShareSurface('tab')).toBe('tab');
    expect(bg.parseShareSurface('desktop')).toBe('tab');
    expect(bg.parseShareSurface(42)).toBe('tab');
  });

  it('accepts exactly the two surfaces the picker adds', () => {
    expect(bg.parseShareSurface('window')).toBe('window');
    expect(bg.parseShareSurface('screen')).toBe('screen');
  });
});

/* ── the tab path: unchanged ── */

describe('planShare — tab (the original Mode B path)', () => {
  it('captures the driven tab and never opens the picker', async () => {
    const deps = fakeDeps({ provider: YOUTUBE, tabStreamId: 'tab-stream-9' });
    const plan = await bg.planShare(ROOM, 'tab', deps);
    expect(deps.tabCaptured).toEqual([7]);
    expect(deps.pickedSources).toEqual([]);
    if (!plan.start) throw new Error('expected a started share');
    expect(plan.message).toEqual({
      kind: 'startShare',
      streamId: 'tab-stream-9',
      roomId: 'room_1',
      accessToken: 'tok_abc',
      // Who the share is FROM. Every viewer derives the pair's connectionId
      // from it, so a message without it is a share nobody can receive.
      userId: 'user_1',
      source: 'tab',
      canRequestAudioTrack: true,
    });
  });

  it('still captures a tab classified as generic — unknown sites are shareable', async () => {
    const plan = await bg.planShare(
      ROOM,
      'tab',
      fakeDeps({ provider: providerForUrl('https://example.com/watch') }),
    );
    if (!plan.start) throw new Error('expected a started share');
    expect(plan.message.source).toBe('tab');
  });

  /**
   * Unclassifiable is not unprotected. The unclassified-skips-the-DRM-refusal
   * bug shipped once (README, Honest limits); under the narrowed permission
   * model "no URL" is a state a tab can genuinely be in, and it must refuse
   * rather than capture blind.
   */
  it('refuses a tab it cannot classify at all, before any capture call', async () => {
    const deps = fakeDeps();
    await expect(bg.planShare(ROOM, 'tab', deps)).rejects.toThrow(
      "Gather can't see what this tab is, so it won't share it — reconnect from the Gather button on that tab.",
    );
    expect(deps.tabCaptured).toEqual([]);
    expect(deps.pickedSources).toEqual([]);
  });

  it('refuses without a tab to capture', async () => {
    await expect(bg.planShare({ ...ROOM, tabId: null }, 'tab', fakeDeps())).rejects.toThrow(
      'no tab selected',
    );
  });
});

/* ── the DRM refusal ── */

describe('planShare — protected tabs', () => {
  it('refuses in plain language, before any capture call', async () => {
    const deps = fakeDeps({ provider: NETFLIX });
    await expect(bg.planShare(ROOM, 'tab', deps)).rejects.toThrow(
      'Netflix is protected — sharing it would show a black picture. Everyone plays their own copy in sync instead.',
    );
    expect(deps.tabCaptured).toEqual([]);
    expect(deps.pickedSources).toEqual([]);
  });

  it('says nothing technical — no code, no API name', async () => {
    const message = await bg
      .planShare(ROOM, 'tab', fakeDeps({ provider: NETFLIX }))
      .then(() => '', (err: unknown) => (err instanceof Error ? err.message : ''));
    expect(message).not.toMatch(/tabCapture|DRM|drm|widevine|getUserMedia/);
  });

  /**
   * We cannot know what is on a screen — the user may open the protected tab
   * a second after picking — so the refusal is deliberately not extended
   * there. The platform blacks the protected surface out itself.
   */
  it('does not extend the refusal to a screen pick it cannot see into', async () => {
    const deps = fakeDeps({ provider: NETFLIX });
    const plan = await bg.planShare(ROOM, 'screen', deps);
    expect(plan.start).toBe(true);
    expect(deps.pickedSources).toHaveLength(1);
  });
});

/**
 * The refusal above is only worth anything if the worker can still SAY what a
 * tab is. It used to know that from one place — a content script's report, at
 * module load and on an SPA route change — so MV3 terminating the worker (it
 * does so after roughly thirty seconds of quiet) left every already-open tab
 * unclassified with nothing to reclassify it. Unclassified is not "generic"
 * here: the guard reads `undefined` and lets the capture through, and the room
 * gets a black rectangle nobody can explain.
 */
describe('what a tab is, after the worker has forgotten', () => {
  afterEach(async () => {
    vi.useRealTimers();
    if ((await status()).connected) await ask({ kind: 'popup:disconnect' });
  });

  it('refuses a protected tab no content script has ever reported', async () => {
    existingTab(9, NETFLIX_URL);
    await connectRoom();

    await expect(share('tab')).rejects.toThrow(
      'Netflix is protected — sharing it would show a black picture.',
    );
    expect(fake.tabCaptureCalls).toEqual([]);
  });

  it('still refuses it after MV3 has recycled the worker', async () => {
    vi.useFakeTimers();
    focusTab(7, NETFLIX_URL);
    await connectRoom();
    // The content script reported once, as it does on load…
    pageChanged(7);
    await vi.advanceTimersByTimeAsync(0);
    // …and then the worker died and woke up, which is all it takes.
    await recycleWorker();

    await expect(share('tab')).rejects.toThrow('Netflix is protected');
    expect(fake.tabCaptureCalls).toEqual([]);
  });

  it('still captures an unprotected tab it was never told about', async () => {
    existingTab(9, YOUTUBE_URL);
    await connectRoom();

    const result = await share('tab');

    expect(result.shared).toBe(true);
    expect(fake.tabCaptureCalls).toEqual([9]);
  });

  it('refuses a tab the browser will not describe, rather than capturing blind', async () => {
    // No URL means no classification, and no classification means the DRM
    // refusal cannot run. Capturing anyway is how the unclassified tab slipped
    // past the refusal once before — refuse, and say how to recover.
    fake.activeTab = { id: 9, url: 'https://example.com/watch' };
    fake.tabUrls.delete(9);
    await connectRoom();

    await expect(share('tab')).rejects.toThrow("Gather can't see what this tab is");
    expect(fake.tabCaptureCalls).toEqual([]);
    expect(fake.desktopCalls).toEqual([]);
    // The offscreen document exists only to capture; a refusal opens nothing.
    expect(fake.offscreenCreated).toBe(0);
  });

  /**
   * The cache's one dangerous lie. Without host permissions, tabs.onUpdated
   * omits changeInfo.url for ungranted origins — so a navigation never
   * invalidates the cached classification, and a tab classified on YouTube
   * then moved to Netflix would be shared as unprotected: a black rectangle
   * for the room. The share path must therefore classify from a FRESH
   * chrome.tabs.get, never from the cache.
   */
  it('classifies a tab share from the browser, never from a stale cache', async () => {
    // Classified while the tab was YouTube…
    focusTab(7, YOUTUBE_URL);
    await connectRoom();
    pageChanged(7);
    await flush();

    // …then navigated to Netflix WITHOUT a url-bearing onUpdated (the
    // ungranted-origin case). Only the browser itself knows.
    fake.tabUrls.set(7, NETFLIX_URL);
    // The cache still says YouTube — precisely the lie the fresh read closes.
    expect((await status()).provider?.name).toBe('YouTube');

    await expect(share('tab')).rejects.toThrow(
      'Netflix is protected — sharing it would show a black picture. Everyone plays their own copy in sync instead.',
    );
    expect(fake.tabCaptureCalls).toEqual([]);
    expect(fake.desktopCalls).toEqual([]);
  });
});

/* ── the desktop pick ── */

describe('planShare — screen and window', () => {
  it('sends the picked stream as a desktop source', async () => {
    const deps = fakeDeps({ pick: { streamId: 'screen-77', canRequestAudioTrack: true } });
    const plan = await bg.planShare(ROOM, 'screen', deps);
    expect(deps.pickedSources).toEqual([['screen', 'window', 'tab', 'audio']]);
    expect(deps.tabCaptured).toEqual([]);
    if (!plan.start) throw new Error('expected a started share');
    expect(plan.message).toEqual({
      kind: 'startShare',
      streamId: 'screen-77',
      roomId: 'room_1',
      accessToken: 'tok_abc',
      userId: 'user_1',
      source: 'desktop',
      canRequestAudioTrack: true,
    });
    expect(plan.note).toBe('Sharing your screen with the room.');
  });

  it('carries the picker’s audio answer through, and says so when it is no', async () => {
    const plan = await bg.planShare(
      ROOM,
      'window',
      fakeDeps({ pick: { streamId: 'win-3', canRequestAudioTrack: false } }),
    );
    if (!plan.start) throw new Error('expected a started share');
    expect(plan.message.canRequestAudioTrack).toBe(false);
    expect(plan.note).toBe(
      'Sharing that window with the room — without its sound. Share a tab if the sound matters.',
    );
  });

  it('needs no driven tab — a screen is not a tab', async () => {
    const plan = await bg.planShare({ ...ROOM, tabId: null }, 'screen', fakeDeps());
    expect(plan.start).toBe(true);
  });
});

/* ── the user closed the picker ── */

describe('planShare — a dismissed picker', () => {
  const cancelled = { streamId: '', canRequestAudioTrack: false };

  it('is an answer, not a failure: it resolves, and starts nothing', async () => {
    for (const surface of ['screen', 'window'] as const) {
      const plan = await bg.planShare(ROOM, surface, fakeDeps({ pick: cancelled }));
      expect(plan.start, surface).toBe(false);
      expect(plan.note).toBe('Nothing was shared — you closed the picker.');
    }
  });

  it('never rejects, so nothing downstream can render it as a crash', async () => {
    const settled = await bg
      .planShare(ROOM, 'screen', fakeDeps({ pick: cancelled }))
      .then((plan) => plan, () => null);
    expect(settled).not.toBeNull();
    expect(settled?.start).toBe(false);
    expect(settled?.note.length ?? 0).toBeGreaterThan(0);
  });
});

/* ── the real chrome deps ── */

describe('browserShareDeps', () => {
  it('asks tabCapture for the tab it was given', async () => {
    fake.nextTabStreamId = 'tab-stream-42';
    await expect(bg.browserShareDeps.tabStreamId(11)).resolves.toBe('tab-stream-42');
    expect(fake.tabCaptureCalls).toEqual([11]);
  });

  it('wraps the picker callback, passing NO targetTab (it would bind the stream to a tab)', async () => {
    fake.nextPick = { streamId: 'screen-1', canRequestAudioTrack: true };
    const pick = await bg.browserShareDeps.chooseDesktop(['screen', 'window', 'tab', 'audio']);
    expect(pick).toEqual({ streamId: 'screen-1', canRequestAudioTrack: true });
    const [call] = fake.desktopCalls;
    expect(call?.sources).toEqual(['screen', 'window', 'tab', 'audio']);
    expect(call?.argCount).toBe(2);
  });

  it('reports a dismissed picker as an empty id rather than hanging', async () => {
    fake.nextPick = { streamId: '', canRequestAudioTrack: false };
    await expect(bg.browserShareDeps.chooseDesktop(['screen'])).resolves.toEqual({
      streamId: '',
      canRequestAudioTrack: false,
    });
  });
});

/* ── what the offscreen document answered ── */

describe('readShareReply', () => {
  const plan = { note: 'Sharing this tab with the room.', canRequestAudioTrack: true };
  const readShareReplyOf = (raw: unknown): ShareResult => bg.readShareReply(raw, plan);

  it('keeps the plan’s sentence when the share started with its sound', () => {
    expect(readShareReplyOf({ ok: true, audio: true, note: '' })).toEqual({
      shared: true,
      cancelled: false,
      note: plan.note,
    });
  });

  it('prefers the document’s sentence when the sound the plan promised never came', () => {
    const silent = 'Sharing video without sound — this tab did not hand over its audio.';
    expect(readShareReplyOf({ ok: true, audio: false, note: silent }).note).toBe(silent);
  });

  it('keeps the plan’s sentence when the plan already said there would be no sound', () => {
    const quiet = { note: 'Sharing your screen with the room — without its sound.', canRequestAudioTrack: false };
    const res = bg.readShareReply({ ok: true, audio: false, note: 'anything' }, quiet);
    expect(res.note).toBe(quiet.note);
  });

  it('is a failure whenever the document did not say it started', () => {
    for (const raw of [undefined, null, 'ok', {}, { ok: false, error: 'boom' }]) {
      expect(readShareReplyOf(raw).shared, JSON.stringify(raw ?? null)).toBe(false);
    }
  });

  it('never repeats a browser error back to the user', () => {
    const res = readShareReplyOf({ ok: false, error: 'NotAllowedError: Permission denied by system' });
    expect(res.note.length).toBeGreaterThan(0);
    expect(res.note).not.toMatch(/NotAllowedError|Permission denied|getUserMedia|chromeMediaSource/);
  });
});

/* ── the share lifecycle, driven through the popup's own channel ── */

describe('sharing a room', () => {
  beforeEach(async () => {
    await connectRoom();
  });

  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  it('tells the offscreen document what the picker said about audio', async () => {
    await share('tab');
    expect(fake.sent).toContainEqual({
      kind: 'startShare',
      streamId: 'tab-stream-1',
      roomId: 'room_1',
      accessToken: 'tok_abc',
      userId: 'user_1',
      source: 'tab',
      canRequestAudioTrack: true,
    });
    expect(fake.offscreenCreated).toBe(1);
  });

  it('reports a capture the document refused as a failure, not as a share', async () => {
    fake.nextShareReply = { ok: false, error: 'NotAllowedError: Permission denied by system' };

    const res = await share('tab');

    expect(res.shared).toBe(false);
    expect(res.cancelled).toBe(false);
    expect(res.note).not.toMatch(/NotAllowedError|Permission denied/);
    expect((await status()).sharing).toBe(false);
    // Nothing is capturing, so nothing is left standing either.
    expect(fake.offscreenOpen).toBe(false);
  });

  it('reports silence from a document that never answered, rather than success', async () => {
    fake.nextShareReply = undefined;

    const res = await share('tab');

    expect(res.shared).toBe(false);
    expect((await status()).sharing).toBe(false);
  });

  it('passes on the document’s own sentence when the sound it promised never came', async () => {
    const silent =
      'Sharing video without sound — this tab did not hand over its audio. Everyone can still hear you on the call.';
    fake.nextShareReply = { ok: true, audio: false, note: silent };

    const res = await share('tab');

    expect(res.shared).toBe(true);
    expect(res.note).toBe(silent);
  });

  it('stops the capture and closes the document when the room is left', async () => {
    await share('tab');
    expect(fake.offscreenOpen).toBe(true);

    await ask({ kind: 'popup:disconnect' });

    expect(fake.sent).toContainEqual({ kind: 'stopShare' });
    expect(fake.offscreenClosed).toBe(1);
    expect(fake.offscreenOpen).toBe(false);
    // The room is told the share ended before the document that tells it dies.
    expect(fake.stopBeforeClose).toBe(true);
    const after = await status();
    expect(after.connected).toBe(false);
    expect(after.sharing).toBe(false);
  });

  it('stops the capture on request without leaving the room', async () => {
    await share('tab');

    await expect(ask({ kind: 'popup:stopShare' })).resolves.toBeNull();

    expect(fake.sent).toContainEqual({ kind: 'stopShare' });
    expect(fake.offscreenOpen).toBe(false);
    const after = await status();
    expect(after.connected).toBe(true);
    expect(after.sharing).toBe(false);
  });

  it('clears the claim when the capture ends on its own, so sharing can start again', async () => {
    await share('tab');
    expect((await status()).sharing).toBe(true);

    // What the offscreen document sends when Chrome's own sharing bar is used.
    await ask({ kind: 'shareEnded' });

    expect((await status()).sharing).toBe(false);
    expect(fake.offscreenOpen).toBe(false);
    await expect(share('tab')).resolves.toMatchObject({ shared: true });
  });

  /**
   * A share the ROOM ended — refused outright, or stopped by a moderator —
   * has nothing else on the screen to explain itself: the popup was told the
   * share started, because locally it had, and the buttons simply come back.
   * The offscreen document is the only thing that hears the room's answer, so
   * its sentence has to survive the trip to the next status the popup asks
   * for, and no further.
   */
  it('keeps the room’s reason for the popup, until the next attempt', async () => {
    await share('tab');

    await ask({ kind: 'shareEnded', reason: 'Someone is already sharing.' });

    const after = await status();
    expect(after.sharing).toBe(false);
    expect(after.shareEnded).toBe('Someone is already sharing.');
    // Reading it does not consume it: the popup polls, and the sentence has to
    // still be there on the poll the person actually looks at.
    expect((await status()).shareEnded).toBe('Someone is already sharing.');

    await share('tab');

    expect((await status()).shareEnded).toBe('');
  });

  it('says nothing about a share the person ended themselves', async () => {
    await share('tab');

    // Chrome's own stop bar and the shared tab closing both arrive like this.
    await ask({ kind: 'shareEnded' });

    expect((await status()).shareEnded).toBe('');
  });

  it('clears the claim when the shared tab is closed', async () => {
    await share('tab');
    expect((await status()).sharing).toBe(true);

    await closeTab(7);

    expect((await status()).sharing).toBe(false);
    expect(fake.offscreenOpen).toBe(false);
  });

  it('leaves a screen share alone when some unrelated tab closes', async () => {
    fake.nextPick = { streamId: 'screen-77', canRequestAudioTrack: false };
    await share('screen');

    await closeTab(7);

    expect((await status()).sharing).toBe(true);
  });
});

/* ── one person, one share ── */

/**
 * A room's stage names ONE host, and the server lets that host replace their
 * own share without a word. So a person already sharing — from this extension,
 * or from their web tab — who presses Share here gets a SECOND capture on the
 * same lane under the same user id, whose connectionId collides with the
 * first: viewers answer whichever spoke first and drop the other as a glare
 * loser, and the room sees one of the two at random while both machines pay to
 * send it. Both refusals happen BEFORE the picker, because being refused after
 * choosing a window is the rudest possible way to say no.
 */
describe('a second share from the same person is refused', () => {
  const stage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    active: true,
    hostUserId: 'user_1',
    startedAt: 1_000,
    viewerCount: 0,
    uplinkQuality: null,
    ...over,
  });

  beforeEach(async () => {
    await connectRoom();
  });

  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  it('refuses a second capture while this extension is already sharing', async () => {
    await share('tab');
    fake.desktopCalls.length = 0;
    fake.tabCaptureCalls.length = 0;

    const res = await share('screen');

    expect(res).toMatchObject({ shared: false, cancelled: false });
    expect(res.note).toMatch(/already sharing/i);
    // No picker was opened, and the share that IS running was left alone.
    expect(fake.desktopCalls).toEqual([]);
    expect(fake.tabCaptureCalls).toEqual([]);
    expect(fake.offscreenCreated).toBe(1);
    expect((await status()).sharing).toBe(true);
  });

  /**
   * The other person's share this worker cannot see at all: a capture running
   * in their web tab, in another process. The room's stage is the only place
   * it is visible from here — it names the host, and the host is us.
   */
  it('refuses when the room already shows this person’s share from elsewhere', async () => {
    room.emit('restream.state', stage());

    const res = await share('tab');

    expect(res).toMatchObject({ shared: false, cancelled: false });
    expect(res.note).toMatch(/somewhere else/i);
    expect(fake.tabCaptureCalls).toEqual([]);
    expect(fake.offscreenCreated).toBe(0);
    expect((await status()).sharing).toBe(false);
  });

  it('shares as usual when the stage is somebody else’s, or nobody’s', async () => {
    for (const held of [stage({ hostUserId: 'user_2' }), stage({ active: false, hostUserId: null })]) {
      room.emit('restream.state', held);

      await expect(share('tab')).resolves.toMatchObject({ shared: true });

      await ask({ kind: 'popup:stopShare' });
    }
  });
});

/* ── who the share is from ── */

/**
 * D2. The offscreen document signs every signalling frame as whoever this
 * message says it is, and the server stamps the sender's id from the
 * authenticated socket — so the two must be the same person or every frame in
 * both directions fails the receiving mesh's connectionId guard. The share
 * then connects to nobody while telling the sharer it started.
 */
describe('the share knows who is sharing', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  it('sends the id the room issued at guest join', async () => {
    joinUserId = 'user_77';
    await connectRoom();

    await share('tab');

    const start = fake.sent.find((m) => m['kind'] === 'startShare');
    expect(start?.['userId']).toBe('user_77');
  });

  /**
   * The handoff path is the one that matters: the web app hands over a room id
   * and a token and NOTHING about who the user is — deliberately, because a
   * page may not tell this worker who it is talking to. The token names them,
   * so the room's own record does too.
   */
  it('learns the id from the room’s own record when nothing else named it', async () => {
    joinUserId = null;
    roomWire = { room: { policies: { playbackControl: 'everyone' } }, member: { role: 'host', userId: 'user_from_room' } };
    await connectRoom();
    // loadRoomAccess is fire-and-forget; let it land, as a real click would.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await share('tab');

    const start = fake.sent.find((m) => m['kind'] === 'startShare');
    expect(start?.['userId']).toBe('user_from_room');
    expect(fetched.some((u) => /\/rooms\/room_1$/.test(u))).toBe(true);
  });

  it('fetches the id on demand when the share is the first thing to need it', async () => {
    joinUserId = null;
    roomWire = { member: { role: 'member', userId: 'user_late' } };
    await connectRoom();

    // No settling wait at all: the share itself must go and find out.
    const res = await share('tab');

    expect(res.shared).toBe(true);
    expect(fake.sent.find((m) => m['kind'] === 'startShare')?.['userId']).toBe('user_late');
  });

  /**
   * The look-up sits in front of a button a person just pressed, and the
   * request behind it has no timeout of its own. A dead network must cost
   * them a sentence, never a Share button that never answers.
   */
  it('gives up waiting rather than leaving the share button hanging', async () => {
    joinUserId = null;
    await connectRoom();
    hangRoomFetch = true;
    vi.useFakeTimers();
    try {
      const pending = share('tab');
      await vi.advanceTimersByTimeAsync(5000);
      const res = await pending;
      expect(res.shared).toBe(false);
      expect(res.note).toMatch(/moment|again/i);
      expect(fake.offscreenCreated).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses rather than capturing for a room that cannot place us', async () => {
    joinUserId = null;
    roomWire = {}; // the API said nothing useful about who we are
    await connectRoom();

    const res = await share('tab');

    expect(res.shared).toBe(false);
    expect(res.cancelled).toBe(false);
    // A sentence, not a code, and it says what will fix it.
    expect(res.note).toMatch(/moment|again/i);
    // Nothing was captured, nothing was opened, nothing claims to be sharing.
    expect(fake.sent.some((m) => m['kind'] === 'startShare')).toBe(false);
    expect(fake.offscreenCreated).toBe(0);
    expect(fake.tabCaptureCalls).toEqual([]);
    expect((await status()).sharing).toBe(false);
  });
});

describe('stopping a share that is not there', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  it('touches nothing and answers normally', async () => {
    await expect(ask({ kind: 'popup:stopShare' })).resolves.toBeNull();
    expect(fake.sent).toEqual([]);
    expect(fake.offscreenClosed).toBe(0);
  });

  it('does not fail when the offscreen API refuses to answer', async () => {
    await connectRoom();
    await share('tab');
    fake.offscreenBroken = true;

    await expect(ask({ kind: 'popup:stopShare' })).resolves.toBeNull();
    expect((await status()).sharing).toBe(false);
  });

  it('calls a document that outlived this worker’s memory of it a share', async () => {
    // A terminated-and-revived worker knows nothing about the capture it
    // started; the document still being open is the browser's own proof.
    fake.offscreenOpen = true;
    expect((await status()).sharing).toBe(true);
  });
});

/**
 * The popup is drawn over one tab and says "This tab: X" about it. That
 * sentence used to come from a module-global written by ANY tab's top frame,
 * on load and on every SPA route change, and overwritten again by the web
 * app's handoff — so the tab it named was whichever one spoke last. The cast
 * affordance is derived from the same answer, while the cast CLICK correctly
 * targets the active tab, which is what turned a wrong sentence into a button
 * that dispatched into the wrong site.
 */
describe('the popup is answered about the tab it is drawn over', () => {
  afterEach(async () => {
    // Give the election back what this suite borrowed: a claim is not scoped
    // to a test, and a leaked one drives a tab the next test says nothing has
    // ever claimed. Null is a frame saying it holds no player.
    claimFrom(7, 3, null);
    if ((await status()).connected) await ask({ kind: 'popup:disconnect' });
  });

  it('names the active tab, not the tab that reported last', async () => {
    // A room driving YouTube in one window…
    focusTab(7, YOUTUBE_URL);
    await connectRoom();
    pageChanged(7);
    // …while the user is looking at Netflix in another.
    focusTab(9, NETFLIX_URL);

    expect((await status()).provider?.name).toBe('Netflix');
  });

  it('carries the cast descriptor the popup builds its control from', async () => {
    focusTab(9, YOUTUBE_URL);

    const provider = (await status()).provider;

    expect(provider?.cast.native).toBe(true);
    expect(provider?.cast.buttons.length).toBeGreaterThan(0);
  });

  it('says a protected site is protected, so the popup can say so too', async () => {
    focusTab(9, NETFLIX_URL);

    const provider = (await status()).provider;

    expect(provider?.drm).toBe(true);
    expect(provider?.cast.native).toBe(false);
  });

  it('shows the position counter only for the tab the room is driving', async () => {
    focusTab(7, YOUTUBE_URL);
    await connectRoom();
    claimFrom(7, 3);
    room.emit('sync.state', playbackAt(0));
    notify(
      { kind: 'telemetry', positionMs: 12_000, durationMs: 600_000, playing: true, rate: 1 },
      { tab: { id: 7 }, frameId: 3 },
    );
    expect((await status()).telemetry?.positionMs).toBe(12_000);

    // The user moves to another tab. That tab's line is about that tab, and
    // the driven tab's position is not a fact about it.
    focusTab(9, NETFLIX_URL);

    expect((await status()).telemetry).toBeNull();
  });

  it('has nothing to say when the browser has no active tab', async () => {
    fake.activeTab = null;

    expect((await status()).provider).toBeNull();
  });
});

/**
 * 'Connected · playing' is ROOM state; only the election proves a player on
 * THIS tab is being driven. The status answer now carries both facts, and the
 * status ask itself is the recovery for a handoff-armed tab that never got
 * injected: opening the popup IS an activeTab grant, so the worker spends it
 * on a best-effort one-shot — floored at once per 5 s per tab, and never when
 * a frame is already elected, there is no session, or the active tab is not
 * the driven tab.
 */
describe('popup:status says whether this tab is actually driven', () => {
  interface DrivingStatus {
    connected: boolean;
    drivenTab: boolean;
    driving: boolean;
  }

  const drivingStatus = (): Promise<DrivingStatus> => ask<DrivingStatus>({ kind: 'popup:status' });

  afterEach(async () => {
    vi.useRealTimers();
    claimFrom(7, 3, null);
    if ((await status()).connected) await ask({ kind: 'popup:disconnect' });
  });

  it('reports driving only for the driven tab with an elected frame', async () => {
    await connectRoom();
    let s = await drivingStatus();
    expect(s.drivenTab).toBe(true);
    expect(s.driving).toBe(false);

    claimFrom(7, 3);
    s = await drivingStatus();
    expect(s.driving).toBe(true);

    // Another tab's popup is about that tab, not about the room's.
    focusTab(9, YOUTUBE_URL);
    s = await drivingStatus();
    expect(s.drivenTab).toBe(false);
    expect(s.driving).toBe(false);
  });

  it('injects the content script as recovery — at most once per five seconds', async () => {
    vi.useFakeTimers();
    await connectRoom();
    // Clear of the connect-time injection AND of any stamp an earlier test's
    // status ask left for this tab (the floor is a per-tab module timestamp).
    await vi.advanceTimersByTimeAsync(6000);
    fake.executed.length = 0;

    await drivingStatus();
    await drivingStatus();
    expect(fake.executed).toEqual([{ tabId: 7, allFrames: true, files: ['content.js'] }]);

    await vi.advanceTimersByTimeAsync(5000);
    await drivingStatus();
    expect(fake.executed).toHaveLength(2);
  });

  it('does not inject when elected, without a session, or off the driven tab', async () => {
    // No session: a popup on any tab gets its status and nothing else.
    await drivingStatus();
    expect(fake.executed).toEqual([]);

    await connectRoom();
    claimFrom(7, 3);
    fake.executed.length = 0;
    await drivingStatus(); // a frame is elected: healthy, nothing to recover
    expect(fake.executed).toEqual([]);

    focusTab(9, YOUTUBE_URL); // the popup is not over the driven tab
    await drivingStatus();
    expect(fake.executed).toEqual([]);
  });
});

/* ── who gets driven: the election, and nothing else ── */

/** A frame reporting a full-screen feature player — comfortably plausible. */
const PLAYER_CLAIM = {
  tag: 'video',
  area: 1280 * 720,
  durationSec: 5400,
  readyState: 4,
  paused: false,
  muted: false,
  hasSource: true,
};

/** What a frame sends: its best element's metrics, or null for "I have none". */
function claimFrom(tabId: number, frameId: number, metrics: unknown = PLAYER_CLAIM): void {
  notify(
    { kind: 'frameClaim', metrics, url: 'https://example.com/watch' },
    { tab: { id: tabId }, frameId },
  );
}

/** The room's playback, as sync.state delivers it. */
function playbackAt(
  positionMs: number,
  mediaRef: Record<string, unknown> = {
    kind: 'url',
    url: 'https://cdn.example.com/feature.m3u8',
    mime: 'video/mp4',
  },
): Record<string, unknown> {
  return {
    mediaRef,
    positionMs,
    rate: 1,
    playing: true,
    serverTs: Date.now(),
    seq: 1,
    queueIndex: null,
  };
}

/** An arbitrary web page in the queue — what the registry used to refuse. */
const PAGE_REF = (url = 'https://some.site/article') => ({ kind: 'page', url });

const messagesOfKind = (kind: string): TabMessage[] =>
  fake.tabMessages.filter((m) => m.msg['kind'] === kind);

/** Which frames were actually driven, in order. */
const drivenFrames = (): Array<number | undefined> =>
  messagesOfKind('drive').map((m) => m.frameId);

const rolesSent = (): Array<{ frameId: number | undefined; role: unknown }> =>
  messagesOfKind('frameRole').map((m) => ({ frameId: m.frameId, role: m.msg['role'] }));

describe('driving a tab', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  /**
   * The tab was chosen by its URL alone — that is all `resolveAutoTab` and the
   * popup's active tab ever prove. A URL is not a player: a page whose only
   * media is a muted hero loop or an ad slot never claims at all. Driving its
   * top frame regardless seeks whatever element happens to be there.
   */
  it('drives nothing while no frame has claimed a player', async () => {
    await connectRoom();

    room.emit('sync.state', playbackAt(0));

    expect(drivenFrames()).toEqual([]);
    expect(rolesSent()).toEqual([]);
  });

  it('drives nothing when every frame reports it has no player', async () => {
    await connectRoom();
    claimFrom(7, 0, null);

    room.emit('sync.state', playbackAt(0));

    expect(drivenFrames()).toEqual([]);
  });

  it('drives the elected frame, and tells it that it is the driver first', async () => {
    await connectRoom();
    room.emit('sync.state', playbackAt(0));
    claimFrom(7, 3);

    expect(rolesSent()).toContainEqual({ frameId: 3, role: 'driver' });
    expect(drivenFrames()).toEqual([3]);
    expect(messagesOfKind('drive')[0]?.tabId).toBe(7);
  });

  it('stops, and stays stopped, when the elected frame loses its player', async () => {
    await connectRoom();
    room.emit('sync.state', playbackAt(0));
    claimFrom(7, 3);
    expect(drivenFrames()).toEqual([3]);
    fake.tabMessages.length = 0;

    // The element was swapped out from under it — an ad roll, a source swap.
    claimFrom(7, 3, null);
    room.emit('sync.state', playbackAt(5000));

    expect(rolesSent()).toContainEqual({ frameId: 3, role: 'idle' });
    expect(messagesOfKind('driveOff').map((m) => m.frameId)).toEqual([3]);
    expect(drivenFrames()).toEqual([]);
  });

  /**
   * A player iframe that re-navigates comes back as a fresh content script,
   * idle, while the election still points at that same frame id. With the role
   * as the only licence to drive, silence here would leave the room's real
   * player unable to follow for as long as the tab stayed open.
   */
  it('re-states the grant to a frame that reloaded under an unchanged election', async () => {
    await connectRoom();
    claimFrom(7, 3);
    fake.tabMessages.length = 0;

    claimFrom(7, 3);

    expect(rolesSent()).toEqual([{ frameId: 3, role: 'driver' }]);
  });

  /**
   * The client clock runs behind the server's until the offset estimator has
   * settled — and on the very first state it has no samples at all. Projecting
   * a state stamped in the future then yields a NEGATIVE position, which is
   * not a place in any media. sync-core's expectedPositionMs floors it at 0;
   * this worker used to read a SECOND copy of that projection out of
   * mediaDriver.ts which had lost the floor, and put the negative number on
   * the wire for the content script to seek to.
   */
  it('never puts a negative position on the wire when the clock runs behind', async () => {
    await connectRoom();
    claimFrom(7, 3);
    fake.tabMessages.length = 0;

    room.emit('sync.state', { ...playbackAt(0), serverTs: Date.now() + 5000 });

    expect(messagesOfKind('drive').at(-1)?.msg['positionMs']).toBe(0);
  });

  it('takes telemetry from the elected frame only', async () => {
    await connectRoom();
    claimFrom(7, 3);

    notify(
      { kind: 'telemetry', positionMs: 111, durationMs: 5000, playing: true, rate: 1 },
      { tab: { id: 7 }, frameId: 9 },
    );
    expect((await status()).telemetry).toBeNull();

    notify(
      { kind: 'telemetry', positionMs: 222, durationMs: 5000, playing: true, rate: 1 },
      { tab: { id: 7 }, frameId: 3 },
    );
    expect((await status()).telemetry?.positionMs).toBe(222);
  });
});

/* ── E19: an arbitrary page, driven like anything else ── */

/**
 * The whole promise of the generic driver: the room queues a plain web page,
 * and whichever frame of the driven tab found a <video> follows the room on
 * it. Nothing about a page is special to this worker — which is the point, and
 * is exactly what these tests pin, because the worker used to have no key for
 * such an item at all and every one of them looked like the same nameless
 * thing to the drift controller.
 */
describe('a page in the queue is driven like any other item', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  it('drives the elected frame for a page ref', async () => {
    await connectRoom();
    room.emit('sync.state', playbackAt(0, PAGE_REF()));
    claimFrom(7, 3);

    expect(rolesSent()).toContainEqual({ frameId: 3, role: 'driver' });
    expect(drivenFrames()).toEqual([3]);
  });

  it('names the page when its end is reported, so a late end can be matched', async () => {
    const web = openEventPort();
    await connectRoom();
    claimFrom(7, 3);
    room.emit('sync.state', playbackAt(600_000, PAGE_REF('https://some.site/film')));

    notify(
      { kind: 'mediaEnded', positionMs: 5_400_000, durationMs: 5_400_000 },
      { tab: { id: 7 }, frameId: 3 },
    );

    const payload = web.posted.filter((m) => m['event'] === 'ended')[0]?.['payload'] as
      | Record<string, unknown>
      | undefined;
    // Not undefined: a page used to fall off the end of mediaKeyOf's switch,
    // so every page in a room shared one nameless identity.
    expect(payload?.['mediaKey']).toBe('page:https://some.site/film');
  });

  it('keeps driving a page as the room moves, tick after tick', async () => {
    await connectRoom();
    claimFrom(7, 3);
    room.emit('sync.state', playbackAt(0, PAGE_REF()));
    fake.tabMessages.length = 0;

    // Telemetry from a real player on that page, then the room moves on.
    notify(
      { kind: 'telemetry', positionMs: 0, durationMs: 5_400_000, playing: true, rate: 1 },
      { tab: { id: 7 }, frameId: 3 },
    );
    room.emit('sync.state', playbackAt(600_000, PAGE_REF()));

    // 600 s adrift on a page is 600 s adrift on anything: it is corrected.
    const drive = messagesOfKind('drive').at(-1);
    expect(drive?.frameId).toBe(3);
    expect((drive?.msg['elastic'] as Record<string, unknown>)['seekToMs']).not.toBeNull();
  });
});

/* ── the user's own hand on the driven site's player ── */

/** GET /rooms/:id wire naming the room's playback policy and OUR role. */
function accessWire(playbackControl: string, role: string): Record<string, unknown> {
  return { room: { policies: { playbackControl } }, member: { role } };
}

describe("a user's gesture on the driven player becomes room intent", () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  /** A driven room: connected, access loaded, frame 3 elected, room playing. */
  async function openDrivenRoom(access: Record<string, unknown> | null): Promise<void> {
    if (access !== null) roomWire = access;
    await connectRoom();
    // loadRoomAccess is fire-and-forget; let it land before anything speaks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    claimFrom(7, 3);
    room.emit('sync.state', playbackAt(600_000));
  }

  function telemetryFrom(
    frameId: number,
    over: { positionMs: number; playing: boolean },
  ): void {
    notify(
      {
        kind: 'telemetry',
        positionMs: over.positionMs,
        durationMs: 5_400_000,
        playing: over.playing,
        rate: 1,
      },
      { tab: { id: 7 }, frameId },
    );
  }

  function intentFrom(frameId: number, intent: unknown, positionMs: unknown): void {
    notify({ kind: 'userIntent', intent, positionMs }, { tab: { id: 7 }, frameId });
  }

  const syncSent = (type: string): Array<{ type: string; payload: unknown }> =>
    room.sent.filter((m) => m.type === type);

  it('one user pause: one room intent, no correction fired against it', async () => {
    await openDrivenRoom(accessWire('everyone', 'guest'));
    telemetryFrom(3, { positionMs: 600_000, playing: true });

    // The user pauses the site's own player.
    telemetryFrom(3, { positionMs: 600_400, playing: false });
    intentFrom(3, 'pause', 600_400);

    // Exactly the web transport's wire shape, exactly once.
    expect(syncSent('sync.pause')).toEqual([
      { type: 'sync.pause', payload: { positionMs: 600_400 } },
    ]);

    // The room still says "playing" — the echo is in flight. No un-pause.
    fake.tabMessages.length = 0;
    room.emit('sync.state', playbackAt(600_000));
    expect(messagesOfKind('drive')).toEqual([]);

    // The echo lands. Still nothing to correct — the user stays paused.
    room.emit('sync.state', { ...playbackAt(600_400), playing: false });
    expect(messagesOfKind('drive')).toEqual([]);
    expect(syncSent('sync.pause')).toHaveLength(1);
  });

  it('forwards play and seek with the same wire shapes the web app uses', async () => {
    await openDrivenRoom(accessWire('everyone', 'member'));
    telemetryFrom(3, { positionMs: 600_000, playing: true });

    intentFrom(3, 'play', 600_000);
    intentFrom(3, 'seek', 630_500);

    expect(syncSent('sync.play')).toEqual([
      { type: 'sync.play', payload: { positionMs: 600_000 } },
    ]);
    expect(syncSent('sync.seek')).toEqual([
      { type: 'sync.seek', payload: { positionMs: 630_500 } },
    ]);
  });

  it('sends nothing without permission, and the driver corrects as ever', async () => {
    await openDrivenRoom(accessWire('host', 'member'));
    telemetryFrom(3, { positionMs: 600_000, playing: true });
    room.emit('sync.state', playbackAt(600_000));
    fake.tabMessages.length = 0;

    // The user pauses — but this room lets only the host drive playback.
    telemetryFrom(3, { positionMs: 600_200, playing: false });
    intentFrom(3, 'pause', 600_200);
    expect(room.sent.filter((m) => m.type.startsWith('sync.'))).toEqual([]);

    // Their local pause IS drift, by design: the next pass un-pauses them.
    room.emit('sync.state', playbackAt(600_000));
    const drives = messagesOfKind('drive');
    expect(drives.length).toBeGreaterThan(0);
    expect((drives.at(-1)?.msg['elastic'] as { transport?: string }).transport).toBe('play');
  });

  it('denies while the room record could not be read — unknown is not a licence', async () => {
    await openDrivenRoom(null); // roomWire stays empty: no policy, no role
    telemetryFrom(3, { positionMs: 600_000, playing: false });
    intentFrom(3, 'pause', 600_000);
    expect(room.sent.filter((m) => m.type.startsWith('sync.'))).toEqual([]);
  });

  it('takes intent only from the elected frame of the driven tab', async () => {
    await openDrivenRoom(accessWire('everyone', 'guest'));
    telemetryFrom(3, { positionMs: 600_000, playing: true });

    intentFrom(9, 'pause', 600_000); // an unelected frame of the driven tab
    notify({ kind: 'userIntent', intent: 'pause', positionMs: 600_000 }, { tab: { id: 8 }, frameId: 3 });
    notify({ kind: 'userIntent', intent: 'pause', positionMs: 600_000 }, {});

    expect(syncSent('sync.pause')).toEqual([]);
  });

  it('drops malformed intent without throwing', async () => {
    await openDrivenRoom(accessWire('everyone', 'guest'));
    telemetryFrom(3, { positionMs: 600_000, playing: true });

    expect(() => {
      intentFrom(3, 'stop', 600_000);
      intentFrom(3, 'pause', Number.NaN);
      intentFrom(3, 'pause', '600000');
      intentFrom(3, undefined, undefined);
    }).not.toThrow();

    expect(room.sent.filter((m) => m.type.startsWith('sync.'))).toEqual([]);
  });

  it('does not read a buffering pause as intent — the stall judgement decides', async () => {
    const T = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T);
    try {
      await openDrivenRoom(accessWire('everyone', 'guest'));
      telemetryFrom(3, { positionMs: 600_000, playing: true });
      room.emit('sync.state', { ...playbackAt(600_000), serverTs: T });

      // 600ms later the player has not advanced at all: it is buffering.
      nowSpy.mockReturnValue(T + 600);
      telemetryFrom(3, { positionMs: 600_000, playing: true });
      room.emit('sync.state', { ...playbackAt(600_000), serverTs: T });

      // Whatever pause-shaped state the site produces now is NOT the user.
      intentFrom(3, 'pause', 600_000);
      expect(syncSent('sync.pause')).toEqual([]);

      // The same pause once the player advances again IS the user: the stall
      // judgement, not the pause, is what gated it.
      nowSpy.mockReturnValue(T + 1600);
      telemetryFrom(3, { positionMs: 601_000, playing: true });
      room.emit('sync.state', { ...playbackAt(600_000), serverTs: T });
      telemetryFrom(3, { positionMs: 601_100, playing: false });
      intentFrom(3, 'pause', 601_100);
      expect(syncSent('sync.pause')).toEqual([
        { type: 'sync.pause', payload: { positionMs: 601_100 } },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

/* ── the end of the driven item, on its own event ── */

/**
 * The web app's event port, exactly as `runtime.connect` from an allowlisted
 * origin produces one: a name that carries the protocol version, a sender the
 * browser populated, and somewhere for the worker's events to land.
 */
/**
 * Every port a test opened, so the next test starts with none.
 *
 * A real port dies with its tab. These have to be hung up on purpose, and
 * leaving them open is not a harmless leak: an open port IS one of the
 * surfaces the presence beat reads, so a port left behind by an earlier test
 * makes every later one look like somebody is still in the room.
 */
const livePorts: Array<() => void> = [];

function openEventPort(): { posted: Array<Record<string, unknown>>; close(): void } {
  const posted: Array<Record<string, unknown>> = [];
  // A real port hangs up when its tab closes or navigates. The fake carries
  // its disconnect listeners for the same reason: that hang-up is the only
  // notice the worker gets that a web surface is gone.
  const hangUp: Array<() => void> = [];
  const port = {
    name: 'gather.ext.events.v1',
    sender: { origin: 'http://localhost:3000', url: 'http://localhost:3000/room/room_1' },
    postMessage: (msg: Record<string, unknown>) => {
      posted.push(msg);
    },
    disconnect: () => undefined,
    onDisconnect: {
      addListener: (fn: () => void) => {
        hangUp.push(fn);
      },
    },
  };
  for (const listener of fake.onConnectExternal.listeners) {
    (listener as unknown as (p: unknown) => void)(port);
  }
  posted.length = 0; // drop the opening status snapshot
  const close = (): void => {
    for (const fn of hangUp.splice(0)) fn();
  };
  livePorts.push(close);
  return { posted, close };
}

describe('the driven item running out', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  async function openDrivenRoom(): Promise<void> {
    await connectRoom();
    claimFrom(7, 3);
    room.emit('sync.state', playbackAt(600_000));
  }

  function endedFrom(
    frameId: number,
    over: { positionMs?: unknown; durationMs?: unknown } = {},
    tabId = 7,
  ): void {
    notify(
      {
        kind: 'mediaEnded',
        positionMs: over.positionMs ?? 5_400_000,
        durationMs: over.durationMs ?? 5_400_000,
      },
      { tab: { id: tabId }, frameId },
    );
  }

  const endEvents = (posted: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    posted.filter((m) => m['event'] === 'ended');

  it('reaches the web app as its own event, never as a pause', async () => {
    const web = openEventPort();
    await openDrivenRoom();

    endedFrom(3);

    const [event] = endEvents(web.posted);
    expect(event).toBeDefined();
    const payload = event?.['payload'] as Record<string, unknown>;
    expect(payload['positionMs']).toBe(5_400_000);
    // The duration travels with it: the page cannot clamp its projection to an
    // item it does not know the length of.
    expect(payload['durationMs']).toBe(5_400_000);
    expect(payload['mediaKey']).toBe('url:https://cdn.example.com/feature.m3u8');
    // The end is a fact about the media. Nobody paused anything.
    //
    // Named transports rather than every `sync.*`: the end DOES now put
    // `sync.advance` on this socket once the worker knows the room's queue
    // (see "the end of an item reaches the room from the worker itself"), and
    // a blanket prefix assertion here would have quietly forbidden it.
    const transports = ['sync.play', 'sync.pause', 'sync.seek', 'sync.setTrack'];
    expect(room.sent.filter((m) => transports.includes(m.type))).toEqual([]);
  });

  it('takes the end from the elected frame of the driven tab only', async () => {
    const web = openEventPort();
    await openDrivenRoom();

    endedFrom(9); // an unelected frame of the driven tab
    endedFrom(3, {}, 8); // the elected frame id, but another tab entirely
    notify({ kind: 'mediaEnded', positionMs: 1, durationMs: 2 }, {}); // no tab at all

    expect(endEvents(web.posted)).toEqual([]);
  });

  it('drops malformed ends without throwing', async () => {
    const web = openEventPort();
    await openDrivenRoom();

    expect(() => {
      endedFrom(3, { positionMs: Number.NaN, durationMs: '5400000' });
    }).not.toThrow();

    const payload = endEvents(web.posted)[0]?.['payload'] as Record<string, unknown>;
    expect(payload['positionMs']).toBe(0);
    expect(payload['durationMs']).toBe(0);
  });
});

/* ── the worker reports the end to the ROOM, not only to the page ── */

/**
 * The stall this closes: a user who connected from the POPUP has no Gather tab
 * at all, so `ports.broadcast('ended')` reaches nobody, and the relay the web
 * app performs — bridge → StagePane → `sync.advance` — does not exist. The
 * room sat on a finished item forever. The worker holds its own room socket
 * (presence and re-stream ride it already), so it sends the intent itself.
 */
describe('the end of an item reaches the room from the worker itself', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  /** A queue item, in the shape queue.state delivers it. */
  const item = (id: string, mediaRef: Record<string, unknown>): Record<string, unknown> => ({
    id,
    mediaRef,
    title: id,
    durationMs: null,
    artworkUrl: null,
    addedBy: 'user_1',
    votesToSkip: [],
  });

  const FEATURE = { kind: 'url', url: 'https://cdn.example.com/feature.m3u8', mime: 'video/mp4' };
  const SECOND = { kind: 'url', url: 'https://cdn.example.com/second.m3u8', mime: 'video/mp4' };

  /** The room's queue, as the server broadcasts it. */
  function queueOf(items: Array<Record<string, unknown>>, version = 1): void {
    room.emit('queue.state', { items, version });
  }

  /** Playback carrying the queue row it was set from — what the server sends. */
  function onQueueItem(index: number, mediaRef: Record<string, unknown>): Record<string, unknown> {
    return { ...playbackAt(600_000, mediaRef), queueIndex: index };
  }

  const advances = (): unknown[] =>
    room.sent.filter((m) => m.type === 'sync.advance').map((m) => m.payload);

  function endedFromDriver(): void {
    notify(
      { kind: 'mediaEnded', positionMs: 5_400_000, durationMs: 5_400_000 },
      { tab: { id: 7 }, frameId: 3 },
    );
  }

  async function openDrivenRoom(): Promise<void> {
    await connectRoom();
    claimFrom(7, 3);
  }

  it('sends sync.advance naming the ended item, with no web tab open', async () => {
    await openDrivenRoom();
    queueOf([item('q_a', FEATURE), item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(0, FEATURE));

    endedFromDriver();

    // Nothing relayed it: no event port was ever opened in this test.
    expect(advances()).toEqual([{ endedItemId: 'q_a' }]);
  });

  it('names the item BY ID even when the recorded index has gone stale', async () => {
    await openDrivenRoom();
    // The playing item was at index 1; something ahead of it was then removed,
    // so index 1 now names a different row and only the media identifies it.
    queueOf([item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(1, SECOND));

    endedFromDriver();

    expect(advances()).toEqual([{ endedItemId: 'q_b' }]);
  });

  it('fires once per item, however many ends arrive', async () => {
    await openDrivenRoom();
    queueOf([item('q_a', FEATURE), item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(0, FEATURE));

    endedFromDriver();
    endedFromDriver();
    endedFromDriver();

    expect(advances()).toEqual([{ endedItemId: 'q_a' }]);
  });

  it('does not latch: the NEXT item is reportable too', async () => {
    await openDrivenRoom();
    queueOf([item('q_a', FEATURE), item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(0, FEATURE));
    endedFromDriver();

    // The room moved on — the server's own answer to that first report.
    room.emit('sync.state', onQueueItem(1, SECOND));
    endedFromDriver();

    expect(advances()).toEqual([{ endedItemId: 'q_a' }, { endedItemId: 'q_b' }]);
  });

  it('names a PAGE item, the kind only this extension can play', async () => {
    await openDrivenRoom();
    const page = PAGE_REF('https://some.site/film');
    queueOf([item('q_page', page), item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(0, page));

    endedFromDriver();

    // A page has no embed and no position API: nothing but this extension
    // reaches the end of one, so if the worker cannot name it, nothing can.
    expect(advances()).toEqual([{ endedItemId: 'q_page' }]);
  });

  it('tells apart the same media queued twice, by the index', async () => {
    await openDrivenRoom();
    queueOf([item('q_first', FEATURE), item('q_again', FEATURE)]);
    room.emit('sync.state', onQueueItem(1, FEATURE));

    endedFromDriver();

    expect(advances()).toEqual([{ endedItemId: 'q_again' }]);
  });

  it('stays silent when the finished item is not in the room queue', async () => {
    await openDrivenRoom();
    // Vote-skip carried the playing item off while it was still on the stage.
    queueOf([item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(0, FEATURE));

    endedFromDriver();

    // Saying nothing is the safe answer: naming the row now at that index
    // would advance PAST it, skipping an item nobody skipped.
    expect(advances()).toEqual([]);
  });

  it('stays silent for an end that did not come from the driven frame', async () => {
    await openDrivenRoom();
    queueOf([item('q_a', FEATURE), item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(0, FEATURE));

    notify({ kind: 'mediaEnded', positionMs: 1, durationMs: 2 }, { tab: { id: 7 }, frameId: 9 });
    notify({ kind: 'mediaEnded', positionMs: 1, durationMs: 2 }, { tab: { id: 8 }, frameId: 3 });

    expect(advances()).toEqual([]);
  });

  /**
   * WITH a web tab the extension still sends — see background.ts. The relayed
   * web path sends one too, and the server's compare-and-set makes the loser a
   * silent no-op; suppressing on "a port is open" would be an inference about
   * a surface that may be mid-navigation, which is the advancer election this
   * whole mechanism replaced.
   */
  it('sends its own intent even while the web app is listening', async () => {
    const web = openEventPort();
    await openDrivenRoom();
    queueOf([item('q_a', FEATURE), item('q_b', SECOND)]);
    room.emit('sync.state', onQueueItem(0, FEATURE));

    endedFromDriver();

    expect(advances()).toEqual([{ endedItemId: 'q_a' }]);
    // And the page still hears it: the overlay and the web stage both read it.
    expect(web.posted.filter((m) => m['event'] === 'ended')).toHaveLength(1);
  });

  it('takes the newer queue when a snapshot reply lands behind a broadcast', async () => {
    await openDrivenRoom();
    queueOf([item('q_a', FEATURE), item('q_b', SECOND)], 4);
    // The wantSnapshot reply is written from a room read that raced the
    // broadcast — older, and it must not overwrite what already landed.
    queueOf([item('q_old', FEATURE)], 2);
    room.emit('sync.state', onQueueItem(0, FEATURE));

    endedFromDriver();

    expect(advances()).toEqual([{ endedItemId: 'q_a' }]);
  });
});

/* ── how long the item is: the one fact only a viewer's player has ── */

/**
 * `QueueItem.durationMs` is null on nearly every row. The server can only read
 * a duration out of an oEmbed payload and, of the keyless endpoints, only
 * Vimeo's carries one — YouTube's does not, SoundCloud's does not, the Open
 * Graph fallback has none, and a `{kind:'page'}` link never had one to give.
 * This extension is the surface that plays precisely those items, and the
 * number is sitting on the element it drives. So the worker reports it: once
 * per item, into a row that does not already know, and never for a live
 * stream, which has no length to report.
 */
describe('the length of the playing item reaches the room from the worker', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  const FEATURE = { kind: 'url', url: 'https://cdn.example.com/feature.m3u8', mime: 'video/mp4' };
  const SECOND = { kind: 'url', url: 'https://cdn.example.com/second.m3u8', mime: 'video/mp4' };

  /** A queue row, in the shape queue.state delivers it. */
  const item = (
    id: string,
    mediaRef: Record<string, unknown>,
    durationMs: number | null = null,
  ): Record<string, unknown> => ({
    id,
    mediaRef,
    title: id,
    durationMs,
    artworkUrl: null,
    addedBy: 'user_1',
    votesToSkip: [],
  });

  const durations = (): unknown[] =>
    room.sent.filter((m) => m.type === 'sync.duration').map((m) => m.payload);

  /** One telemetry frame, as the driven frame's 1 Hz heartbeat sends it. */
  function telemetry(durationMs: number, frameId = 3): void {
    notify(
      { kind: 'telemetry', positionMs: 1000, durationMs, playing: true, rate: 1 },
      { tab: { id: 7 }, frameId },
    );
  }

  /**
   * The settling frame every track change really produces: the page has
   * re-elected its element and its metadata has not loaded, so it reports a
   * duration of 0. The worker throws the first frame under a new name away
   * (see reportItemDuration) precisely because a frame in flight may still
   * describe the OUTGOING item, and this is that frame.
   */
  function settle(frameId = 3): void {
    telemetry(0, frameId);
  }

  /** A driven room sitting on `index` of the queue it was given, with the
   *  post-track-change settling frame already delivered. */
  async function playingItem(
    items: Array<Record<string, unknown>>,
    index = 0,
    mediaRef: Record<string, unknown> = FEATURE,
  ): Promise<void> {
    await connectRoom();
    claimFrom(7, 3);
    room.emit('queue.state', { items, version: 1 });
    room.emit('sync.state', { ...playbackAt(1000, mediaRef), queueIndex: index });
    settle();
  }

  it("reports the playing item's length once its player knows it", async () => {
    await playingItem([item('q_a', FEATURE), item('q_b', SECOND)]);

    telemetry(5_400_000);

    expect(durations()).toEqual([{ itemId: 'q_a', durationMs: 5_400_000 }]);
  });

  it('sends it once per item, not once per telemetry tick', async () => {
    await playingItem([item('q_a', FEATURE), item('q_b', SECOND)]);

    // A frame every second from every viewer in the room is a broadcast
    // storm; that the server drops repeats is not a reason to send them.
    telemetry(5_400_000);
    telemetry(5_400_000);
    telemetry(5_400_000);

    expect(durations()).toHaveLength(1);
  });

  it('does not latch: the NEXT item is reported too', async () => {
    await playingItem([item('q_a', FEATURE), item('q_b', SECOND)]);
    telemetry(5_400_000);

    room.emit('sync.state', { ...playbackAt(0, SECOND), queueIndex: 1 });
    settle();
    telemetry(1_800_000);

    expect(durations()).toEqual([
      { itemId: 'q_a', durationMs: 5_400_000 },
      { itemId: 'q_b', durationMs: 1_800_000 },
    ]);
  });

  it("never attributes the OUTGOING item's length to the incoming one", async () => {
    // A duration is a FILL-ONCE on the server, so the first wrong number is
    // the permanent one and no later report from anybody can replace it. The
    // hazard is real because a telemetry frame carries no media identity: the
    // page samples its <video>, the room renames the media, and the worker
    // reads a frame that still describes what just finished.
    await playingItem([item('q_a', FEATURE), item('q_b', SECOND)]);
    telemetry(5_400_000);

    room.emit('sync.state', { ...playbackAt(0, SECOND), queueIndex: 1 });
    // In flight when the rename landed: still the finished item's length.
    telemetry(5_400_000);

    expect(durations()).toEqual([{ itemId: 'q_a', durationMs: 5_400_000 }]);

    // …and the page's first honest frame under the new name still lands.
    telemetry(1_800_000);
    expect(durations()).toEqual([
      { itemId: 'q_a', durationMs: 5_400_000 },
      { itemId: 'q_b', durationMs: 1_800_000 },
    ]);
  });

  it('says nothing for a live stream, which has no length', async () => {
    await playingItem([item('q_a', FEATURE)]);

    // The content script maps a non-finite duration to 0 (readTelemetry), and
    // 0 is also every player's "metadata has not loaded yet". Neither is a
    // duration, and the server's unknown branch is the honest answer for both.
    telemetry(0);

    expect(durations()).toEqual([]);
  });

  it("says nothing when the room's own row already carries a length", async () => {
    await playingItem([item('q_a', FEATURE, 5_400_000)]);

    telemetry(5_400_000);

    expect(durations()).toEqual([]);
  });

  it('says nothing when the playing item is not in the room queue', async () => {
    // Vote-skip carried it off while it was still on the stage. Naming a row
    // by the index it used to sit at would fill in a different item's length.
    await playingItem([item('q_b', SECOND)], 0, FEATURE);

    telemetry(5_400_000);

    expect(durations()).toEqual([]);
  });

  it('takes it from the elected frame of the driven tab only', async () => {
    await playingItem([item('q_a', FEATURE)]);

    // Another frame of the same tab has media of its own — an ad slot, a
    // trailer in a sidebar. Its length is not the room's item's length.
    telemetry(90_000, 9);
    telemetry(90_000, 9);

    expect(durations()).toEqual([]);
  });

  it('reports whole milliseconds: the row stores an integer', async () => {
    await playingItem([item('q_a', FEATURE)]);

    // `currentTime * 1000` on a real element is rarely a round number.
    telemetry(5_400_000.4);

    expect(durations()).toEqual([{ itemId: 'q_a', durationMs: 5_400_000 }]);
  });
});

/* ── an ad in the driven element cannot speak for the film ── */

/**
 * A preroll/mid-roll swapped into the driven element (same element, new src)
 * fires a genuine 'ended' under a fresh end-latch key, reports the AD's
 * duration in telemetry, and sits at a position the drive loop reads as a
 * catastrophic lag. Unvetoed, that chain (1) named the FILM's queue row in
 * `sync.advance` and moved the whole room off it, (2) filled the film's
 * fill-once null-duration row with ~15 s, permanently, and (3) had the drive
 * loop hard-seek the ad to its end — manufacturing the 'ended' itself. The
 * veto is driver.ts's `isInterstitialSource`, judged against the same room
 * projection the drive tick uses.
 */
describe('an interstitial source cannot speak for the film', () => {
  const FEATURE = { kind: 'url', url: 'https://cdn.example.com/feature.m3u8', mime: 'video/mp4' };

  const item = (id: string, mediaRef: Record<string, unknown>): Record<string, unknown> => ({
    id,
    mediaRef,
    title: id,
    durationMs: null,
    artworkUrl: null,
    addedBy: 'user_1',
    votesToSkip: [],
  });

  const advances = (): unknown[] =>
    room.sent.filter((m) => m.type === 'sync.advance').map((m) => m.payload);
  const durations = (): unknown[] =>
    room.sent.filter((m) => m.type === 'sync.duration').map((m) => m.payload);

  function telemetry(over: { positionMs: number; durationMs: number }): void {
    notify(
      {
        kind: 'telemetry',
        positionMs: over.positionMs,
        durationMs: over.durationMs,
        playing: true,
        rate: 1,
      },
      { tab: { id: 7 }, frameId: 3 },
    );
  }

  /** A driven room ten minutes into the feature — the position an ad break
   *  interrupts, and far past any ad's own length. */
  async function tenMinutesIn(): Promise<void> {
    await connectRoom();
    claimFrom(7, 3);
    room.emit('queue.state', { items: [item('q_a', FEATURE)], version: 1 });
    room.emit('sync.state', { ...playbackAt(600_000, FEATURE), queueIndex: 0 });
  }

  afterEach(async () => {
    claimFrom(7, 3, null);
    await ask({ kind: 'popup:disconnect' });
  });

  it("does not advance the room off an ad's 'ended'", async () => {
    await tenMinutesIn();

    // A 15 s ad swapped into the driven element runs out.
    notify(
      { kind: 'mediaEnded', positionMs: 15_000, durationMs: 15_000 },
      { tab: { id: 7 }, frameId: 3 },
    );
    expect(advances()).toEqual([]);

    // The film's own end still advances: the veto is per-source, not a latch.
    notify(
      { kind: 'mediaEnded', positionMs: 5_400_000, durationMs: 5_400_000 },
      { tab: { id: 7 }, frameId: 3 },
    );
    expect(advances()).toEqual([{ endedItemId: 'q_a' }]);
  });

  it("does not fill the film's blank duration row with the ad's length", async () => {
    await tenMinutesIn();
    // The settling frame every rename produces (see reportItemDuration).
    telemetry({ positionMs: 600_000, durationMs: 0 });

    // The ad's frames arrive under the film's name. A duration is a FILL-ONCE
    // on the server, so one accepted frame here would be permanent.
    telemetry({ positionMs: 3_000, durationMs: 15_000 });
    telemetry({ positionMs: 4_000, durationMs: 15_000 });
    expect(durations()).toEqual([]);

    // The element holds the film again: its real length still lands — the
    // veto must not have latched the item as already reported.
    telemetry({ positionMs: 615_000, durationMs: 5_400_000 });
    expect(durations()).toEqual([{ itemId: 'q_a', durationMs: 5_400_000 }]);
  });

  it('sends the tab nothing while the ad holds the element, and resumes after', async () => {
    await tenMinutesIn();
    // The ad as the drive loop sees it: a short source near its start, which
    // reads as a ~10-minute lag — the correction would be a hard seek to the
    // ad's end, which is what manufactures its 'ended'.
    telemetry({ positionMs: 3_000, durationMs: 15_000 });
    fake.tabMessages.length = 0;

    room.emit('sync.state', { ...playbackAt(601_000, FEATURE), queueIndex: 0 });
    expect(messagesOfKind('drive')).toEqual([]);

    // The film is back in the element. Driving resumes by itself: the same
    // room state now produces the correction the ad was denied.
    telemetry({ positionMs: 300_000, durationMs: 5_400_000 });
    room.emit('sync.state', { ...playbackAt(602_000, FEATURE), queueIndex: 0 });
    expect(messagesOfKind('drive').length).toBeGreaterThan(0);
  });

  it('leaves the no-telemetry fallback and unknown durations alone', async () => {
    await tenMinutesIn();
    fake.tabMessages.length = 0;
    // No telemetry at all: the no-telemetry fallback drive still goes out.
    room.emit('sync.state', { ...playbackAt(601_000, FEATURE), queueIndex: 0 });
    expect(messagesOfKind('drive').length).toBeGreaterThan(0);

    // durationMs 0 is "unknown", never "short": a pre-metadata player (or a
    // live stream reporting 0) ten minutes adrift is corrected, not vetoed.
    telemetry({ positionMs: 0, durationMs: 0 });
    fake.tabMessages.length = 0;
    room.emit('sync.state', { ...playbackAt(602_000, FEATURE), queueIndex: 0 });
    expect(messagesOfKind('drive').length).toBeGreaterThan(0);
  });
});

/* ── the injected room overlay ── */

interface OverlayState {
  connection: string;
  roomName: string | null;
  people: Array<{ id: string; name: string; you: boolean; micOn: boolean; away: boolean }>;
  messages: Array<{ id: string; author: string; text: string; mine: boolean }>;
  sync: { stalled: boolean } | null;
  nowPlaying: string | null;
  upNext: string | null;
  canSkip: boolean;
  /** The driven element's LOCAL volume/mute; null until telemetry says. */
  audio: { volume: number; muted: boolean } | null;
}

function presence(userId: string, over: { state?: string; micOn?: boolean } = {}): unknown {
  return {
    userId,
    state: over.state ?? 'watching',
    micOn: over.micOn ?? false,
    camOn: false,
    sharing: false,
    lastSeenTs: Date.now(),
  };
}

function chatWire(over: { id: string; authorId: string; body: string; deletedAt?: number }): unknown {
  return {
    id: over.id,
    roomId: 'room_1',
    authorId: over.authorId,
    kind: 'text',
    body: over.body,
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
    reactions: {},
    pinned: false,
    editedAt: null,
    deletedAt: over.deletedAt ?? null,
    seq: 1,
    createdAt: Date.now(),
  };
}

/** The last room state pushed at a page, and the frame it was pushed to. */
function lastOverlayPush(): TabMessage | undefined {
  return messagesOfKind('overlay').pop();
}

describe('the injected room overlay', () => {
  beforeEach(async () => {
    await connectRoom();
  });

  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  it('answers the tab that is in the room, and only that tab', async () => {
    const inRoom = await ask<OverlayState | null>({ kind: 'overlay:state' }, { tab: { id: 7 } });
    expect(inRoom?.roomName).toBe('Movie night');

    const elsewhere = await ask<OverlayState | null>(
      { kind: 'overlay:state' },
      { tab: { id: 8 } },
    );
    expect(elsewhere).toBeNull();

    // A message with no tab behind it is not a tab in a room either.
    expect(await ask<OverlayState | null>({ kind: 'overlay:state' })).toBeNull();
  });

  it('pushes the room to the top frame of the driven tab when it changes', () => {
    fake.tabMessages.length = 0;

    room.emit('presence.state', { entries: [presence('user_1'), presence('user_2', { micOn: true })] });

    const push = lastOverlayPush();
    expect(push?.tabId).toBe(7);
    expect(push?.frameId).toBe(0);
    const state = push?.msg['state'] as OverlayState;
    expect(state.people).toEqual([
      { id: 'user_1', name: '', you: true, micOn: false, away: false },
      { id: 'user_2', name: '', you: false, micOn: true, away: false },
    ]);
  });

  it('says nothing when nothing a person would see has changed', () => {
    room.emit('presence.state', { entries: [presence('user_1')] });
    fake.tabMessages.length = 0;

    room.emit('presence.state', { entries: [presence('user_1')] });

    expect(messagesOfKind('overlay')).toEqual([]);
  });

  it('carries the room chat, and drops what was deleted', () => {
    room.emit('chat.message', chatWire({ id: 'm1', authorId: 'user_2', body: 'starting now' }));
    room.emit('chat.message', chatWire({ id: 'm2', authorId: 'user_1', body: 'ok!' }));
    room.emit('chat.message', chatWire({ id: 'm3', authorId: 'user_2', body: 'oops', deletedAt: 5 }));

    const state = lastOverlayPush()?.msg['state'] as OverlayState;
    expect(state.messages).toEqual([
      { id: 'm1', author: '', text: 'starting now', mine: false },
      { id: 'm2', author: '', text: 'ok!', mine: true },
    ]);
  });

  it('sends what was typed to the room', async () => {
    await ask({ kind: 'overlay:chat', text: '  hello everyone  ' }, { tab: { id: 7 } });

    expect(room.sent).toEqual([
      {
        type: 'chat.send',
        payload: {
          kind: 'text',
          body: 'hello everyone',
          gifUrl: null,
          attachment: null,
          replyTo: null,
          mentions: [],
        },
      },
    ]);
  });

  it('refuses to send from a tab that is not in the room', async () => {
    await expect(ask({ kind: 'overlay:chat', text: 'hi' }, { tab: { id: 8 } })).rejects.toThrow(
      'This tab is not in the room.',
    );
    expect(room.sent).toEqual([]);
  });

  it('leaves the room, and takes the panel away with it', async () => {
    fake.tabMessages.length = 0;

    await ask({ kind: 'overlay:leave' }, { tab: { id: 7 } });

    expect(fake.tabMessages).toContainEqual({
      tabId: 7,
      frameId: 0,
      msg: { kind: 'overlayOff' },
    });
    expect((await status()).connected).toBe(false);
  });

  it('opens this room in the web app, and no other page', async () => {
    await ask({ kind: 'overlay:open-app' }, { tab: { id: 7 } });

    expect(fake.createdTabs).toEqual(['http://localhost:3000/room/room_1']);
  });
});

/**
 * The overlay's volume lever, routed through the worker. Everything here is
 * LOCAL: the ask lands on the driven frame's element as `setAudio`, nothing
 * touches the room's socket, and the overlay state's `audio` block is read
 * from the driven frame's own telemetry — the external event-port telemetry
 * shape stays exactly what it was.
 */
describe('the overlay volume lever', () => {
  /** The driven frame's 1 Hz heartbeat, with the audio half on it. */
  function telemetryFrom(
    tabId: number,
    frameId: number,
    over: { volume?: number; muted?: boolean } = {},
  ): void {
    notify(
      {
        kind: 'telemetry',
        positionMs: 600_000,
        durationMs: 5_400_000,
        playing: true,
        rate: 1,
        volume: over.volume ?? 1,
        muted: over.muted ?? false,
      },
      { tab: { id: tabId }, frameId },
    );
  }

  const audioSent = (): TabMessage[] => messagesOfKind('setAudio');

  beforeEach(async () => {
    await connectRoom();
    claimFrom(7, 3);
  });

  afterEach(async () => {
    claimFrom(7, 3, null);
    await ask({ kind: 'popup:disconnect' });
  });

  it('routes overlay:volume to the driven frame as setAudio, clamped', async () => {
    await ask({ kind: 'overlay:volume', volume: 0.3 }, { tab: { id: 7 } });
    await ask({ kind: 'overlay:volume', volume: 1.7 }, { tab: { id: 7 } });

    expect(audioSent()).toEqual([
      { tabId: 7, frameId: 3, msg: { kind: 'setAudio', volume: 0.3 } },
      { tabId: 7, frameId: 3, msg: { kind: 'setAudio', volume: 1 } },
    ]);
    // LOCAL means local: nothing about volume ever reaches the room.
    expect(room.sent).toEqual([]);
  });

  it('routes overlay:mute the same way', async () => {
    await ask({ kind: 'overlay:mute', muted: true }, { tab: { id: 7 } });

    expect(audioSent()).toEqual([
      { tabId: 7, frameId: 3, msg: { kind: 'setAudio', muted: true } },
    ]);
    expect(room.sent).toEqual([]);
  });

  it('refuses the ask from a tab that is not in the room', async () => {
    await expect(ask({ kind: 'overlay:volume', volume: 0.3 }, { tab: { id: 8 } })).rejects.toThrow(
      'This tab is not in the room.',
    );
    await expect(ask({ kind: 'overlay:mute', muted: true }, { tab: { id: 8 } })).rejects.toThrow(
      'This tab is not in the room.',
    );
    expect(audioSent()).toEqual([]);
  });

  it('refuses a volume that is not a number at all', async () => {
    await expect(ask({ kind: 'overlay:volume', volume: 'loud' }, { tab: { id: 7 } })).rejects.toThrow(
      'There was nothing to change.',
    );
    expect(audioSent()).toEqual([]);
  });

  it('carries no audio block before any telemetry has said where the lever is', async () => {
    const state = await ask<OverlayState | null>({ kind: 'overlay:state' }, { tab: { id: 7 } });
    expect(state?.audio).toBeNull();
  });

  it('reads the audio block from the driven frame’s telemetry', async () => {
    telemetryFrom(7, 3, { volume: 0.4, muted: true });

    const state = await ask<OverlayState | null>({ kind: 'overlay:state' }, { tab: { id: 7 } });
    expect(state?.audio).toEqual({ volume: 0.4, muted: true });
  });

  it('ignores the audio another tab or frame reports — the election gate holds', async () => {
    telemetryFrom(8, 0, { volume: 0.1, muted: true });
    telemetryFrom(7, 5, { volume: 0.1, muted: true });

    const state = await ask<OverlayState | null>({ kind: 'overlay:state' }, { tab: { id: 7 } });
    expect(state?.audio).toBeNull();
  });

  it('pushes the overlay when the audible facts move, not on every heartbeat', async () => {
    telemetryFrom(7, 3, { volume: 0.5 });
    fake.tabMessages.length = 0;

    // Same reading again: the 1 Hz heartbeat must not become a 1 Hz redraw.
    telemetryFrom(7, 3, { volume: 0.5 });
    expect(messagesOfKind('overlay')).toEqual([]);

    telemetryFrom(7, 3, { volume: 0.5, muted: true });
    const push = messagesOfKind('overlay').pop();
    expect(push?.tabId).toBe(7);
    expect((push?.msg['state'] as OverlayState).audio).toEqual({ volume: 0.5, muted: true });
  });
});

/**
 * The worker has held the room's queue all along — it is what `sync.advance`
 * names the ended item out of — and its own comment said "Nothing draws it",
 * while the panel's header cited a model defined as injecting the
 * chat/call/QUEUE UI. Two titles and a skip is what is cheap and honest: no
 * request, no new state, and the two rows a person watching actually asks
 * about.
 */
describe('the overlay says what is playing and what is next', () => {
  const FEATURE = { kind: 'url', url: 'https://cdn.example.com/feature.m3u8', mime: 'video/mp4' };
  const SECOND = { kind: 'url', url: 'https://cdn.example.com/second.m3u8', mime: 'video/mp4' };

  const queueRow = (id: string, title: string, mediaRef: Record<string, unknown>): unknown => ({
    id,
    mediaRef,
    title,
    durationMs: null,
    artworkUrl: null,
    addedBy: 'user_1',
    votesToSkip: [],
  });

  const advances = (): unknown[] =>
    room.sent.filter((m) => m.type === 'sync.advance').map((m) => m.payload);

  /** A room on the first of two queued rows, driven from tab 7. */
  async function playingFirstOfTwo(): Promise<void> {
    await connectRoom();
    claimFrom(7, 3);
    room.emit('queue.state', {
      items: [queueRow('q_a', 'The Feature', FEATURE), queueRow('q_b', 'The Short', SECOND)],
      version: 1,
    });
    room.emit('sync.state', { ...playbackAt(600_000, FEATURE), queueIndex: 0 });
  }

  const drawn = (): OverlayState => {
    const push = lastOverlayPush();
    if (push === undefined) throw new Error('nothing was pushed to the page');
    return push.msg['state'] as OverlayState;
  };

  afterEach(async () => {
    claimFrom(7, 3, null);
    if ((await status()).connected) await ask({ kind: 'popup:disconnect' });
  });

  it('names the playing row and the one after it', async () => {
    await playingFirstOfTwo();

    expect(drawn().nowPlaying).toBe('The Feature');
    expect(drawn().upNext).toBe('The Short');
  });

  it('says nothing is next at the end of the queue', async () => {
    await connectRoom();
    room.emit('queue.state', { items: [queueRow('q_b', 'The Short', SECOND)], version: 1 });
    room.emit('sync.state', { ...playbackAt(0, SECOND), queueIndex: 0 });

    expect(drawn().nowPlaying).toBe('The Short');
    expect(drawn().upNext).toBeNull();
  });

  it('names nothing for a room playing something its queue does not hold', async () => {
    await connectRoom();
    room.emit('queue.state', { items: [queueRow('q_b', 'The Short', SECOND)], version: 1 });
    room.emit('sync.state', playbackAt(0, FEATURE));

    expect(drawn().nowPlaying).toBeNull();
    expect(drawn().canSkip).toBe(false);
  });

  it('redraws when the queue changes under an unchanged playing item', async () => {
    await playingFirstOfTwo();
    fake.tabMessages.length = 0;

    room.emit('queue.state', {
      items: [queueRow('q_a', 'The Feature', FEATURE), queueRow('q_c', 'Something Else', SECOND)],
      version: 2,
    });

    expect(drawn().upNext).toBe('Something Else');
  });

  it('offers no skip to a member the room does not let drive playback', async () => {
    await playingFirstOfTwo();

    expect(drawn().canSkip).toBe(false);

    await expect(ask({ kind: 'overlay:skip' }, { tab: { id: 7 } })).rejects.toThrow(
      'The room does not let you skip.',
    );
    expect(advances()).toEqual([]);
  });

  it('offers a skip once the room says this member may drive', async () => {
    roomWire = {
      room: { policies: { playbackControl: 'everyone' } },
      member: { role: 'guest', userId: 'user_1' },
    };
    await playingFirstOfTwo();
    // loadRoomAccess is started without being waited on; it lands a turn later.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(drawn().canSkip).toBe(true);
  });

  /** The same intent the end of an item produces, so the server's own
   *  compare-and-set is the only thing that decides what happens. */
  it('sends sync.advance naming the row it is on', async () => {
    roomWire = {
      room: { policies: { playbackControl: 'everyone' } },
      member: { role: 'guest', userId: 'user_1' },
    };
    await playingFirstOfTwo();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await ask({ kind: 'overlay:skip' }, { tab: { id: 7 } });

    expect(advances()).toEqual([{ endedItemId: 'q_a' }]);
  });

  it('refuses a skip from a tab that is not in the room', async () => {
    roomWire = {
      room: { policies: { playbackControl: 'everyone' } },
      member: { role: 'guest', userId: 'user_1' },
    };
    await playingFirstOfTwo();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(ask({ kind: 'overlay:skip' }, { tab: { id: 8 } })).rejects.toThrow(
      'This tab is not in the room.',
    );
    expect(advances()).toEqual([]);
  });
});

describe('the overlay names the people in the room', () => {
  afterEach(async () => {
    await ask({ kind: 'popup:disconnect' });
  });

  /** Presence and chat carry ids only. "Someone, Someone and Someone are
   *  here" is not a room, so the member list is read once when it opens. */
  it('reads the member list once and shows people by name', async () => {
    membersWire = {
      members: [
        { member: {}, user: { id: 'user_1', displayName: 'Ana' } },
        { member: {}, user: { id: 'user_2', displayName: 'Ben' } },
      ],
    };

    await connectRoom();
    await new Promise((resolve) => setTimeout(resolve, 0));
    room.emit('presence.state', { entries: [presence('user_1'), presence('user_2')] });

    const state = lastOverlayPush()?.msg['state'] as OverlayState;
    expect(state.people.map((p) => p.name)).toEqual(['Ana', 'Ben']);
    expect(fetched.filter((url) => url.includes('/members'))).toHaveLength(1);
  });

  it('carries on with "Someone" when the member list cannot be read', async () => {
    await connectRoom();
    await new Promise((resolve) => setTimeout(resolve, 0));
    room.emit('presence.state', { entries: [presence('user_9')] });

    const state = lastOverlayPush()?.msg['state'] as OverlayState;
    // The overlay itself renders an empty name as "Someone" — see overlay/state.
    expect(state.people).toEqual([
      { id: 'user_9', name: '', you: false, micOn: false, away: false },
    ]);
  });
});

/* ── reaching content pages under the narrowed permissions ── */

/**
 * The manifest no longer demands any host: content pages are reached through
 * a dynamic registration that mirrors what the user has GRANTED, plus a
 * one-shot injection for the tab the popup connects (activeTab) and for tabs
 * already open when a grant lands. These tests pin that mirror — because a
 * registration that drifts from the grants is either a site that silently
 * stops working or a site the user revoked that Gather still boards.
 */
describe('the registered content script mirrors the granted origins', () => {
  const NETFLIX_GRANT = 'https://*.netflix.com/*';
  const CUSTOM_GRANT = 'https://films.example.org/*';
  const driver = (): Record<string, unknown> | undefined =>
    fake.registrations.get('gather-driver');

  it('registers exactly the granted origins on install — Gather origins excluded', async () => {
    // The Gather origin grant is the declarative entry's territory: the
    // announce ships in the manifest and must not be said twice.
    fake.grantedOrigins.push(NETFLIX_GRANT, CUSTOM_GRANT, 'http://localhost:3000/*');
    await fireInstalled();

    const reg = driver();
    expect(reg).toBeDefined();
    expect(reg?.['matches']).toEqual([NETFLIX_GRANT, CUSTOM_GRANT]);
    expect(reg?.['js']).toEqual(['content.js']);
    // Every frame, and about:blank/srcdoc player frames by parent origin —
    // the registered script must reach everything the old declarative
    // <all_urls> entry reached, or the player iframe design breaks.
    expect(reg?.['allFrames']).toBe(true);
    expect(reg?.['matchOriginAsFallback']).toBe(true);
    expect(reg?.['persistAcrossSessions']).toBe(true);
    expect(reg?.['runAt']).toBe('document_idle');
  });

  it('puts the registration back on browser startup', async () => {
    fake.grantedOrigins.push(NETFLIX_GRANT);
    await fireStartup();

    expect(driver()?.['matches']).toEqual([NETFLIX_GRANT]);
  });

  it('registers nothing while nothing is granted', async () => {
    await fireInstalled();

    expect(driver()).toBeUndefined();
  });

  it('follows a new grant, and injects into matching tabs already open', async () => {
    fake.grantedOrigins.push(NETFLIX_GRANT);
    await fireInstalled();
    navigateTab(8, 'https://vimeo.com/12345');
    fake.executed.length = 0;

    await grantOrigins('https://*.vimeo.com/*');

    expect(driver()?.['matches']).toEqual([NETFLIX_GRANT, 'https://*.vimeo.com/*']);
    // The registration reaches only documents that load AFTER it exists; the
    // tab already open on the granted origin gets the one-shot — all frames,
    // because its player iframe may already be there. No other tab is touched.
    expect(fake.executed).toEqual([{ tabId: 8, allFrames: true, files: ['content.js'] }]);
  });

  it('shrinks with a revoked grant, and unregisters at zero', async () => {
    fake.grantedOrigins.push(NETFLIX_GRANT, CUSTOM_GRANT);
    await fireInstalled();

    await revokeOrigins(CUSTOM_GRANT);
    expect(driver()?.['matches']).toEqual([NETFLIX_GRANT]);

    await revokeOrigins(NETFLIX_GRANT);
    expect(driver()).toBeUndefined();
  });
});

describe('connecting from the popup, under activeTab', () => {
  afterEach(async () => {
    if ((await status()).connected) await ask({ kind: 'popup:disconnect' });
  });

  it('injects the content script into the connected tab, before any driving', async () => {
    await connectRoom();

    // The popup click was the activeTab grant; the injection spends it. All
    // frames, because the player iframe may already exist.
    expect(fake.executed).toEqual([{ tabId: 7, allFrames: true, files: ['content.js'] }]);
    // Nothing has been driven yet: the script is in place before the room
    // can say anything to the tab.
    expect(fake.tabMessages.filter((m) => m.msg['kind'] === 'drive')).toEqual([]);
  });

  it('carries the room password to the join — and only when one was given', async () => {
    await ask({ kind: 'popup:connect', code: 'abcd-efgh-ijkl', password: '  swordfish  ' });
    await ask({ kind: 'popup:disconnect' });
    await ask({ kind: 'popup:connect', code: 'abcd-efgh-ijkl' });

    const joins = fetchedBodies.filter((f) => f.url.includes('/auth/guest'));
    expect(joins).toHaveLength(2);
    const withPassword = JSON.parse(joins[0]?.body ?? '{}') as Record<string, unknown>;
    const withoutPassword = JSON.parse(joins[1]?.body ?? '{}') as Record<string, unknown>;
    expect(withPassword['password']).toBe('swordfish');
    // The KEY is absent, not empty: absence is what "no password" is.
    expect('password' in withoutPassword).toBe(false);
  });
});

/* ── manifest ↔ code ── */

describe('manifest permissions', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
  ) as {
    permissions: string[];
    host_permissions?: string[];
    optional_host_permissions?: string[];
    content_scripts: Array<{ matches: string[]; all_frames?: boolean }>;
    icons: Record<string, string>;
    action: { default_icon?: Record<string, string> };
    version: string;
  };

  it('declares both capture permissions — neither API implies the other', () => {
    expect(manifest.permissions).toContain('desktopCapture');
    expect(manifest.permissions).toContain('tabCapture');
  });

  it('still declares what the share path already depended on', () => {
    for (const permission of ['offscreen', 'storage', 'activeTab', 'scripting', 'alarms']) {
      expect(manifest.permissions, permission).toContain(permission);
    }
  });

  it('demands no host at install — every content origin is an optional grant', () => {
    // `<all_urls>` under host_permissions is the maximum-warning install and
    // the maximum-scrutiny review. Optional means: grantable at runtime,
    // silent at install.
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toContain('<all_urls>');
  });

  it('injects declaratively on the Gather web origins only — the announce path', () => {
    // detectExtension()'s announce fallback dies without this entry; content
    // sites are reached by the dynamic registration instead.
    expect(manifest.content_scripts[0]?.matches).toEqual([
      'http://localhost:3000/*',
      'http://127.0.0.1:3000/*',
      'https://gather.watch/*',
      'https://www.gather.watch/*',
      'https://app.gather.watch/*',
    ]);
  });

  it('ships icons at every size the store lists, on both surfaces', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons[size], size).toBe(`icon-${size}.png`);
    }
    expect(manifest.action.default_icon).toEqual(manifest.icons);
  });

  it('carries a real listing version, not the scaffold placeholder', () => {
    expect(manifest.version).not.toBe('0.1.0');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('a share outlives the worker, but not the room', () => {
  /**
   * MV3 recycles the service worker after ~30s of quiet, and the revived worker
   * calls restoreSession() -> openSession(), which resets session state. The
   * offscreen document deliberately survives that, so the reset must not be
   * allowed to tear the capture down: a user sharing their screen would
   * otherwise have it die every time the worker was recycled, for no reason
   * they could see.
   */
  it('keeps a live share when the same room is re-opened', async () => {
    await connectRoom();
    await share('screen');
    expect((await status()).sharing).toBe(true);
    const closedBefore = fake.offscreenClosed;

    await connectRoom();

    expect(fake.offscreenClosed).toBe(closedBefore);
    expect((await status()).sharing).toBe(true);
  });

  /** The other half: a share must not follow the user into a different room,
   *  or the room they just left keeps receiving their screen. */
  it('stops a live share when a different room is opened', async () => {
    await connectRoom();
    await share('screen');
    expect((await status()).sharing).toBe(true);

    joinRoomId = 'room_2';
    await connectRoom();

    expect(fake.offscreenClosed).toBeGreaterThan(0);
    expect((await status()).sharing).toBe(false);
  });
});

/* ── the presence beat and the surfaces it belongs to ── */

/**
 * The beat is this extension telling the room "that person is still here". The
 * room believes it: the server's 45s presence TTL is what decides somebody has
 * gone, and that departure is what releases the screen share they left behind.
 *
 * So the beat has to mean something. It was made unconditional to stop a share
 * being declared over forty-five seconds after it started, and an unconditional
 * beat outlives every surface a person can close — the room then holds an
 * immortal member and an orphaned share. These tests pin both ends: the beat
 * stops when the last surface goes, and it does NOT stop for the one thing
 * that looks like leaving and is not — MV3 recycling the worker.
 */
describe('the presence beat belongs to a surface the user can close', () => {
  const PRESENCE_BEAT_MS = 15_000;

  /** Beats written to the room since the last reset. */
  const beats = (): number => room.sent.filter((m) => m.type === 'presence.update').length;

  afterEach(async () => {
    vi.useRealTimers();
    if ((await status()).connected) await ask({ kind: 'popup:disconnect' });
  });

  it('beats while the driven tab — the tab the overlay is on — is open', async () => {
    vi.useFakeTimers();
    await connectRoom();
    room.sent.length = 0;

    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 3);

    expect(beats()).toBe(3);
  });

  it('never writes presence STATE from a timer', async () => {
    // The presence entry is one per PERSON, not one per socket. This beat used
    // to stamp `state: 'watching'` every 15 seconds — so for a member also on
    // the room's call in a web tab, every beat told the room they had left it,
    // and everyone else's call pulled their audio and video. The web tab wrote
    // 'in-call' back when it noticed, and the two fought for the whole call.
    // The extension knows the person is watching; it does not know they are
    // not ALSO on the call, so state is not its to write on a schedule.
    vi.useFakeTimers();
    await connectRoom();
    room.sent.length = 0;

    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 3);

    const stamped = room.sent
      .filter((m) => m.type === 'presence.update')
      .filter((m) => (m.payload as Record<string, unknown>)['state'] !== undefined);
    expect(stamped).toEqual([]);
  });

  it('stops beating, and lets the room go, once the last surface closes', async () => {
    vi.useFakeTimers();
    await connectRoom();
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 2);
    expect(beats()).toBeGreaterThan(0);

    // The user closes the tab they were watching on. Nothing is being shared
    // and no web app page is connected: there is no surface left at all.
    removeTab(7);
    await vi.advanceTimersByTimeAsync(0);
    const written = beats();

    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 4);

    // Not one more beat. The entry now expires on the server's own clock,
    // which is what fires onDeparture and releases anything held for them.
    expect(beats()).toBe(written);
    // And the socket goes with it, once the reload window has passed.
    expect((await status()).connected).toBe(false);
  });

  it('treats the web app tab hanging up as a surface closing', async () => {
    vi.useFakeTimers();
    await connectRoom();
    const web = openEventPort();
    // The driven tab is gone, so the web app's port is the only surface left.
    removeTab(7);
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS);
    const withPort = beats();
    expect(withPort).toBeGreaterThan(0);

    // onConnectExternal registered no onDisconnect handler at all, so a closed
    // web tab was never noticed and the beat ran on without it.
    web.close();
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 4);

    expect(beats()).toBe(withPort);
    expect((await status()).connected).toBe(false);
  });

  it('holds the room through a reload — a port that comes back is not a departure', async () => {
    vi.useFakeTimers();
    await connectRoom();
    const web = openEventPort();
    removeTab(7);
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS);

    // The room page navigates: the port drops, and a new one opens a beat later.
    web.close();
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS);
    openEventPort();
    room.sent.length = 0;
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 3);

    expect(beats()).toBe(3);
    expect((await status()).connected).toBe(true);
  });

  /**
   * The original bug, still fixed: an extension-hosted share was declared over
   * about forty-five seconds in, because the socket read presence and never
   * wrote it.
   */
  it('keeps an extension-hosted share alive well past the 45s TTL', async () => {
    vi.useFakeTimers();
    await connectRoom();
    expect((await share('screen')).shared).toBe(true);
    room.sent.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);

    // Four beats inside a 45s window: the entry never lapses, so onDeparture
    // never fires, so the share is never released out from under the sharer.
    expect(beats()).toBe(4);
    expect((await status()).sharing).toBe(true);
    expect((await status()).connected).toBe(true);
  });

  /**
   * The trap in the fix. A recycled worker has forgotten `sharingSource` and
   * every open port; if "is anybody here?" were answered out of memory it would
   * answer "no" on every wake, stop the beat, and bring the original bug back.
   * It is answered by the browser instead — the offscreen document is still
   * there, and the offscreen document exists only to capture.
   */
  it('does not stop the beat when the worker is recycled under a live share', async () => {
    vi.useFakeTimers();
    await connectRoom();
    expect((await share('screen')).shared).toBe(true);
    // Strip every surface except the share, so the share alone decides.
    removeTab(7);
    await vi.advanceTimersByTimeAsync(0);

    await recycleWorker();

    room.sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(beats()).toBe(4);
    expect((await status()).sharing).toBe(true);
    expect((await status()).connected).toBe(true);
  });

  /**
   * The other half of that trap. The absence clock is persisted precisely
   * because MV3 wakes this worker every ~30s: a clock kept in memory would be
   * reset by every wake, the grace window would never elapse, and the room
   * would be held open forever by the mechanism written to release it.
   */
  it('releases a room the user left even though the worker keeps waking up', async () => {
    vi.useFakeTimers();
    await connectRoom();
    removeTab(7); // the last surface; the absence clock starts
    await vi.advanceTimersByTimeAsync(0);

    // Wake after wake after wake, each a fresh worker with no memory at all.
    await recycleWorker();
    await recycleWorker();
    await recycleWorker();

    room.sent.length = 0;
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 2);

    expect(beats()).toBe(0);
    expect((await status()).connected).toBe(false);
  });

  /**
   * A revived worker's presence entry is still alive server-side, so no join
   * snapshot comes back on its own — and without one the queue is UNKNOWN
   * until the next mutation, which is exactly the window where a finished
   * item's ending goes silently unreported (sync.advance names the item).
   * The revived worker asks explicitly, the same door the web client's
   * refresh path uses.
   */
  it('asks for a room snapshot when a recycled worker revives the session', async () => {
    vi.useFakeTimers();
    await connectRoom();
    room.sent.length = 0;

    await recycleWorker();

    const asks = room.sent.filter(
      (m) =>
        m.type === 'presence.update' &&
        (m.payload as { wantSnapshot?: boolean }).wantSnapshot === true,
    );
    expect(asks).toHaveLength(1);
  });

  /**
   * …but ONLY on revive. A fresh join is answered with a snapshot anyway
   * (the server's `created` branch), and an ask on every beat would cost a
   * full roster reply every fifteen seconds.
   */
  it('does not ask on a fresh join or on ordinary beats', async () => {
    vi.useFakeTimers();
    await connectRoom();
    await vi.advanceTimersByTimeAsync(PRESENCE_BEAT_MS * 2);

    const asks = room.sent.filter(
      (m) =>
        m.type === 'presence.update' &&
        (m.payload as { wantSnapshot?: boolean }).wantSnapshot === true,
    );
    expect(asks).toHaveLength(0);
  });
});
