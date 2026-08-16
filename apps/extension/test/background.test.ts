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
 * real WebSocket. Everything the worker asks of it is a no-op here, which is
 * enough to own a room — and owning a room is what the share path requires.
 */
vi.mock('@playin/api-client', () => ({
  RoomSocket: class {
    readonly clock = { serverNow: (now: number) => now };
    connect(): void {}
    send(): void {}
    on(): () => void {
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

interface ChromeFake {
  desktopCalls: DesktopCall[];
  tabCaptureCalls: number[];
  sent: Array<Record<string, unknown>>;
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
  const state: ChromeFake = {
    desktopCalls: [],
    tabCaptureCalls: [],
    sent: [],
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
  };

  const chrome = {
    runtime: {
      onMessage,
      onMessageExternal: evt(),
      onConnectExternal: evt(),
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
      sendMessage: async () => undefined,
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
const GUEST_WIRE = (): Record<string, unknown> => ({
  user: { id: 'user_1' },
  room: { id: joinRoomId, name: 'Movie night' },
  accessToken: 'tok_abc',
});

let fake: ChromeFake;
let bg: typeof import('../src/background');

beforeAll(async () => {
  fake = installChromeFake();
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => GUEST_WIRE(),
    text: async () => '',
  })) as unknown as typeof fetch;
  bg = await import('../src/background');
});

beforeEach(() => {
  fake.desktopCalls.length = 0;
  fake.tabCaptureCalls.length = 0;
  fake.sent.length = 0;
  fake.nextPick = { streamId: 'desktop-stream-1', canRequestAudioTrack: false };
  fake.nextTabStreamId = 'tab-stream-1';
  fake.nextShareReply = { ok: true, audio: true, note: '' };
  fake.offscreenOpen = false;
  fake.offscreenCreated = 0;
  fake.offscreenClosed = 0;
  for (const key of Object.keys(fake.store)) delete fake.store[key];
  joinRoomId = 'room_1';
  fake.stopBeforeClose = null;
  fake.offscreenBroken = false;
  fake.activeTab = { id: 7, url: 'https://example.com/watch' };
});

/* ── talking to the worker the way the popup does ── */

interface PopupStatus {
  connected: boolean;
  roomName: string | null;
  sharing: boolean;
}

/** One popup → worker request, answered exactly as chrome.runtime would. */
async function ask<T>(msg: Record<string, unknown>): Promise<T> {
  const [listener] = fake.onMessage.listeners;
  if (listener === undefined) throw new Error('the worker registered no message listener');
  return new Promise<T>((resolve, reject) => {
    const willAnswer = listener(msg, {}, (raw) => {
      const res = raw as { ok: true; value: T } | { ok: false; error: string };
      if (res.ok) resolve(res.value);
      else reject(new Error(res.error));
    });
    if (willAnswer !== true) reject(new Error(`nothing answered ${String(msg['kind'])}`));
  });
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

const ROOM: ShareRoom = { roomId: 'room_1', accessToken: 'tok_abc', tabId: 7 };

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
