/**
 * A hand on the SITE's own player, seen from the content script: which
 * transport events become a `userIntent` message to the worker, and — the
 * case that matters most — which do not. The element here fires its events
 * ASYNCHRONOUSLY, on a later task than the command that caused them, exactly
 * as a real media element does, so the self-marking is proven to survive the
 * gap after applyDecision returns.
 *
 * In the style of test/content-drive.test.ts: the fake browser is installed
 * before the module loads, and the module keeps its state across tests, so
 * each test starts by restating the element and the frame's role.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── the page, with document-level capture listeners that really fire ── */

const docListeners = new Map<string, Array<(ev: unknown) => void>>();

/** Deliver an event to every capture listener, target included. */
function fireNow(type: string, target: unknown): void {
  for (const fn of [...(docListeners.get(type) ?? [])]) fn({ type, target });
}

/** What a real element does: the event fires on a later task, never inside
 *  the call that caused it. */
function fireSoon(type: string, target: unknown): void {
  setTimeout(() => fireNow(type, target), 0);
}

const player = { positionMs: 600_000, rate: 1, paused: false, ended: false };

const element = {
  tagName: 'VIDEO',
  isConnected: true,
  readyState: 4,
  muted: false,
  duration: 5400,
  currentSrc: 'https://cdn.example.com/feature.m3u8',
  src: '',
  srcObject: null,
  get ended(): boolean {
    return player.ended;
  },
  getBoundingClientRect: (): { width: number; height: number } => ({ width: 1280, height: 720 }),
  get currentTime(): number {
    return player.positionMs / 1000;
  },
  set currentTime(seconds: number) {
    player.positionMs = seconds * 1000;
    fireSoon('seeked', element);
  },
  get playbackRate(): number {
    return player.rate;
  },
  set playbackRate(rate: number) {
    player.rate = rate;
  },
  get paused(): boolean {
    return player.paused;
  },
  // A playing element plays silently and a paused one pauses silently — no
  // event fires, which is what keeps "exactly one intent" honest.
  play: (): void => {
    if (!player.paused) return;
    player.paused = false;
    fireSoon('play', element);
  },
  pause: (): void => {
    if (player.paused) return;
    player.paused = true;
    fireSoon('pause', element);
  },
};

/** Another element entirely — the one an ad roll swaps in. */
const adElement = { tagName: 'VIDEO', isConnected: true };

/* ── the fake browser ── */

type MessageListener = (
  msg: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

const listeners: MessageListener[] = [];
/** Everything the content script sent to the worker, in order. */
const sent: Array<Record<string, unknown>> = [];

function installBrowserFake(): void {
  const noop = (): void => undefined;
  const g = globalThis as unknown as Record<string, unknown>;

  const win = {
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    top: null as unknown,
  };
  win.top = win;

  g['window'] = win;
  g['location'] = { href: 'https://example.com/watch?v=1', origin: 'https://example.com' };
  g['history'] = { pushState: noop, replaceState: noop };
  g['document'] = {
    documentElement: {},
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    querySelector: (): unknown => null,
    querySelectorAll: (selector: string): unknown[] =>
      selector === 'video, audio' ? [element] : [],
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
      sendMessage: async (msg: Record<string, unknown>): Promise<undefined> => {
        sent.push(msg);
        return undefined;
      },
    },
  };
}

function deliver(msg: Record<string, unknown>): void {
  for (const listener of [...listeners]) listener(msg, {}, () => undefined);
}

/** The `elastic` block exactly as background.ts's drive loop builds it. */
function block(over: {
  transport?: 'play' | 'pause' | 'none';
  seekToMs?: number | null;
  setRate?: number | null;
  reason: string;
}): Record<string, unknown> {
  return {
    transport: over.transport ?? 'none',
    seekToMs: over.seekToMs ?? null,
    setRate: over.setRate ?? null,
    driftMs: 0,
    anchorOffsetMs: 0,
    reason: over.reason,
  };
}

function driveMessage(
  positionMs: number,
  elastic?: Record<string, unknown> | null,
  wire?: { playing?: boolean; rate?: number },
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    kind: 'drive',
    playing: wire?.playing ?? true,
    positionMs,
    rate: wire?.rate ?? 1,
  };
  if (elastic !== undefined) msg['elastic'] = elastic;
  return msg;
}

/* ── the user's gestures: the site's own controls, firing real events ── */

function userPause(): void {
  player.paused = true;
  fireNow('pause', element);
}

function userPlay(): void {
  player.paused = false;
  fireNow('play', element);
}

function userSeek(toMs: number): void {
  player.positionMs = toMs;
  fireNow('seeked', element);
}

const intents = (): Array<Record<string, unknown>> =>
  sent.filter((m) => m['kind'] === 'userIntent');

beforeAll(async () => {
  vi.useFakeTimers();
  installBrowserFake();
  await import('../src/content');
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  player.positionMs = 600_000;
  player.rate = 1;
  player.paused = false;
  player.ended = false;
  element.isConnected = true;
  deliver({ kind: 'frameRole', role: 'driver' });
  // Being driven is the licence to speak; an idle decision touches nothing.
  deliver(driveMessage(600_000, block({ reason: 'idle' })));
  // Let every self-marking window from the previous test expire, and let the
  // telemetry heartbeat seed the detector's position baseline.
  vi.advanceTimersByTime(6000);
  sent.length = 0;
});

/* ───────────────────── the user's hand IS room intent ───────────────────── */

describe("the user's hand on the site's player", () => {
  it('turns a user pause into exactly one room intent', () => {
    userPause();
    expect(intents()).toEqual([{ kind: 'userIntent', intent: 'pause', positionMs: 600_000 }]);
  });

  it('turns a user play into exactly one room intent', () => {
    player.paused = true;
    userPlay();
    expect(intents()).toEqual([{ kind: 'userIntent', intent: 'play', positionMs: 600_000 }]);
  });

  it('reports a user seek at the position the player landed on', () => {
    userSeek(630_000);
    expect(intents()).toEqual([{ kind: 'userIntent', intent: 'seek', positionMs: 630_000 }]);
  });

  it('ignores a position twitch too small for anyone to have meant it', () => {
    userSeek(600_900);
    expect(intents()).toEqual([]);
  });

  it('does not read arrival at the end of the media as a pause', () => {
    player.ended = true;
    player.positionMs = 5_400_000;
    userPause();
    expect(intents()).toEqual([]);
  });
});

/* ────────────────── the feedback loop that must not exist ───────────────── */

describe('events our own commands caused are not intent', () => {
  it('a pause WE applied does not echo back as user intent', () => {
    deliver(
      driveMessage(600_000, block({ transport: 'pause', reason: 'transport' }), { playing: false }),
    );
    // The event fires on a later task, after applyDecision has long returned.
    vi.advanceTimersByTime(50);
    expect(intents()).toEqual([]);
  });

  it('a play WE applied does not echo back as user intent', () => {
    player.paused = true;
    deliver(driveMessage(600_000, block({ transport: 'play', reason: 'transport' })));
    vi.advanceTimersByTime(50);
    expect(intents()).toEqual([]);
  });

  it('a seek WE applied does not echo back, even landing off-target', () => {
    deliver(driveMessage(612_000, block({ seekToMs: 612_000, reason: 'seek' })));
    // The player snapped to the nearest keyframe, inside the epsilon.
    player.positionMs = 612_600;
    vi.advanceTimersByTime(50);
    expect(intents()).toEqual([]);
  });

  it("the legacy fallback's corrections are marked too", () => {
    // No elastic block: an older worker. decideDrive prescribes the seek.
    deliver(driveMessage(604_000));
    vi.advanceTimersByTime(50);
    expect(intents()).toEqual([]);
  });

  it("a user scrub right after OUR seek is still the user's", () => {
    deliver(driveMessage(612_000, block({ seekToMs: 612_000, reason: 'seek' })));
    vi.advanceTimersByTime(50); // our seeked lands and is swallowed
    sent.length = 0;
    userSeek(680_000);
    expect(intents()).toEqual([{ kind: 'userIntent', intent: 'seek', positionMs: 680_000 }]);
  });
});

/* ─────────────── who may speak, and about which element ─────────────────── */

describe('only the elected, driven frame — and only its own element', () => {
  it('ignores events from an element this frame is not driving (ad-roll swap)', () => {
    fireNow('pause', adElement);
    fireNow('play', adElement);
    fireNow('seeked', adElement);
    expect(intents()).toEqual([]);
  });

  it('says nothing for an element that left the document', () => {
    element.isConnected = false;
    userPause();
    expect(intents()).toEqual([]);
  });

  it('says nothing while not driven', () => {
    deliver({ kind: 'driveOff' });
    userPause();
    expect(intents()).toEqual([]);
  });

  it('says nothing from a frame the election demoted', () => {
    deliver({ kind: 'frameRole', role: 'idle' });
    userPause();
    expect(intents()).toEqual([]);
  });
});
