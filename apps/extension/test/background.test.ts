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
import type { ProviderSummary } from '../src/protocol';

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
  /** chrome.storage.session, for real — see the storage fake. */
  store: Record<string, unknown>;
  onMessage: FakeEvent<MessageListener>;
  onRemoved: FakeEvent<(tabId: number) => void>;
  /** The web app's event port arrives here — see openEventPort. */
  onConnectExternal: FakeEvent<(port: unknown) => void>;
}

function evt<F = () => void>(): FakeEvent<F> {
  const listeners: F[] = [];
  return {
    listeners,
    addListener: (fn: F) => {
      listeners.push(fn);
    },
    removeListener: () => undefined,
  };
}

function installChromeFake(): ChromeFake {
  const onMessage = evt<MessageListener>();
  const onRemoved = evt<(tabId: number) => void>();
  const onConnectExternal = evt<(port: unknown) => void>();
  const state: ChromeFake = {
    desktopCalls: [],
    tabCaptureCalls: [],
    sent: [],
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
    store: {},
    onMessage,
    onRemoved,
    onConnectExternal,
  };

  const chrome = {
    runtime: {
      onMessage,
      onMessageExternal: evt(),
      onConnectExternal,
      onSuspend: evt(),
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async (msg: Record<string, unknown>) => {
        state.sent.push(msg);
        if (msg['kind'] === 'startShare') return state.nextShareReply;
        if (msg['kind'] === 'stopShare') return { ok: true, stopped: true };
        return undefined;
      },
    },
    tabs: {
      onActivated: evt(),
      onUpdated: evt(),
      onRemoved,
      get: async () => ({}),
      query: async () => (state.activeTab === null ? [] : [state.activeTab]),
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
/** Make GET /rooms/:id never answer, as a dead network does. */
let hangRoomFetch = false;

let fake: ChromeFake;
let bg: typeof import('../src/background');

beforeAll(async () => {
  fake = installChromeFake();
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    fetched.push(u);
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

beforeEach(() => {
  fake.desktopCalls.length = 0;
  fake.tabCaptureCalls.length = 0;
  fake.sent.length = 0;
  fake.tabMessages.length = 0;
  fake.createdTabs.length = 0;
  room.reset();
  membersWire = {};
  roomWire = {};
  fetched = [];
  hangRoomFetch = false;
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
});

/* ── talking to the worker the way the popup does ── */

interface PopupStatus {
  connected: boolean;
  roomName: string | null;
  sharing: boolean;
  telemetry: { positionMs: number } | null;
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

/** Chrome removing a tab. The teardown it triggers is fire-and-forget, so the
 *  caller waits a turn for it, exactly as the popup's next poll would. */
async function closeTab(tabId: number): Promise<void> {
  for (const listener of fake.onRemoved.listeners) listener(tabId);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ── injected deps, so the plan can be tested without a browser ── */

const ROOM: ShareRoom = { roomId: 'room_1', accessToken: 'tok_abc', tabId: 7, userId: 'user_1' };

const NETFLIX: ProviderSummary = { id: 'netflix', name: 'Netflix', tier: 'drm' };
const YOUTUBE: ProviderSummary = { id: 'youtube', name: 'YouTube', tier: 'api' };

function fakeDeps(
  over: {
    provider?: ProviderSummary | undefined;
    tabStreamId?: string;
    pick?: DesktopPick;
  } = {},
): ShareDeps & { pickedSources: DesktopSource[][]; tabCaptured: number[] } {
  const pickedSources: DesktopSource[][] = [];
  const tabCaptured: number[] = [];
  return {
    pickedSources,
    tabCaptured,
    providerOf: () => over.provider,
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

  it('works on a tab nothing has classified yet', async () => {
    const plan = await bg.planShare(ROOM, 'tab', fakeDeps());
    if (!plan.start) throw new Error('expected a started share');
    expect(plan.message.source).toBe('tab');
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
      'Netflix is protected — capture would send a black frame. Everyone plays their own copy in sync instead.',
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
function openEventPort(): { posted: Array<Record<string, unknown>> } {
  const posted: Array<Record<string, unknown>> = [];
  const port = {
    name: 'gather.ext.events.v1',
    sender: { origin: 'http://localhost:3000', url: 'http://localhost:3000/room/room_1' },
    postMessage: (msg: Record<string, unknown>) => {
      posted.push(msg);
    },
    disconnect: () => undefined,
    onDisconnect: { addListener: () => undefined },
  };
  for (const listener of fake.onConnectExternal.listeners) {
    (listener as unknown as (p: unknown) => void)(port);
  }
  posted.length = 0; // drop the opening status snapshot
  return { posted };
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
    expect(room.sent.filter((m) => m.type.startsWith('sync.'))).toEqual([]);
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

/* ── the injected room overlay ── */

interface OverlayState {
  connection: string;
  roomName: string | null;
  people: Array<{ id: string; name: string; you: boolean; micOn: boolean; away: boolean }>;
  messages: Array<{ id: string; author: string; text: string; mine: boolean }>;
  sync: { stalled: boolean } | null;
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

/* ── manifest ↔ code ── */

describe('manifest permissions', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../public/manifest.json', import.meta.url)), 'utf8'),
  ) as { permissions: string[] };

  it('declares both capture permissions — neither API implies the other', () => {
    expect(manifest.permissions).toContain('desktopCapture');
    expect(manifest.permissions).toContain('tabCapture');
  });

  it('still declares what the share path already depended on', () => {
    for (const permission of ['offscreen', 'storage', 'activeTab', 'scripting', 'alarms']) {
      expect(manifest.permissions, permission).toContain(permission);
    }
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
