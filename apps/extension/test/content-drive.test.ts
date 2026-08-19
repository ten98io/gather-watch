/**
 * The content script's drive path, end to end: a `drive` message arrives from
 * the background worker and something — or, just as often, deliberately
 * nothing — reaches the page's media element.
 *
 * content.ts registers its chrome and DOM listeners at import time, so the
 * fake browser below is installed BEFORE the module is loaded (hence the
 * dynamic import), in the style of test/background.test.ts. The element
 * records every assignment and call in order, so each assertion states exactly
 * what reached the player rather than merely that "a seek happened".
 *
 * What this file does NOT cover: detection, election, claiming and casting —
 * they have their own tests. Only the drive loop is here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── the page's media element ─────────────────────────────────────────── */

/**
 * Recorded state of the one element on the page. Only the properties
 * content.ts actually touches exist — a property the script reaches for and a
 * real player does not have fails here, not in Chrome.
 */
const player = {
  /** In order, as it reached the element: 'seek:<ms>' | 'rate:<n>' | 'play' | 'pause'. */
  touched: [] as string[],
  positionMs: 600_000,
  rate: 1,
  paused: false,
};

const element = {
  tagName: 'VIDEO',
  isConnected: true,
  readyState: 4,
  muted: false,
  duration: 5400,
  currentSrc: 'https://cdn.example.com/feature.m3u8',
  src: '',
  srcObject: null,
  getBoundingClientRect: (): { width: number; height: number } => ({ width: 1280, height: 720 }),
  get currentTime(): number {
    return player.positionMs / 1000;
  },
  set currentTime(seconds: number) {
    player.positionMs = seconds * 1000;
    player.touched.push(`seek:${Math.round(seconds * 1000)}`);
  },
  get playbackRate(): number {
    return player.rate;
  },
  set playbackRate(rate: number) {
    player.rate = rate;
    player.touched.push(`rate:${rate}`);
  },
  get paused(): boolean {
    return player.paused;
  },
  play: (): void => {
    player.paused = false;
    player.touched.push('play');
  },
  pause: (): void => {
    player.paused = true;
    player.touched.push('pause');
  },
};

/* ── the fake browser ─────────────────────────────────────────────────── */

type MessageListener = (
  msg: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

const listeners: MessageListener[] = [];
/** Everything the content script told the worker, in order. */
const toWorker: Array<Record<string, unknown>> = [];

function installBrowserFake(): void {
  const noop = (): void => undefined;
  const g = globalThis as unknown as Record<string, unknown>;

  const win = {
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    top: null as unknown,
  };
  win.top = win; // the top frame, so the provider report is exercised too

  g['window'] = win;
  g['location'] = { href: 'https://example.com/watch?v=1', origin: 'https://example.com' };
  g['history'] = { pushState: noop, replaceState: noop };
  g['document'] = {
    documentElement: {},
    addEventListener: noop,
    querySelector: (): unknown => null,
    // The shadow-root walk asks for '*'; there are no custom elements here.
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
        toWorker.push(msg);
        return undefined;
      },
    },
  };
}

/** Hand a message to the content script the way the worker's port would. */
function deliver(msg: Record<string, unknown>): void {
  for (const listener of [...listeners]) listener(msg, {}, () => undefined);
}

/* ── message builders ─────────────────────────────────────────────────── */

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
    // Report-only fields: the content frame has no HUD, so nothing here may
    // change what happens to the element.
    driftMs: 6200,
    anchorOffsetMs: 5800,
    reason: over.reason,
  };
}

/**
 * A `drive` message. `positionMs` is the worker's projection of where this
 * element is — and it is never exactly right: the telemetry it was computed
 * from is up to a heartbeat old and the projection assumes the player held its
 * rate, so a hiccup, an ad break or a throttled tab leaves the real element
 * several hundred ms away from it. That gap is what the legacy fixed bands
 * react to, and an elastic decision is precisely the instruction to ignore it.
 */
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

beforeAll(async () => {
  // Fake timers before the import: content.ts arms a 1 Hz heartbeat at module
  // scope, and nothing here wants it running.
  vi.useFakeTimers();
  installBrowserFake();
  await import('../src/content');
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  player.touched.length = 0;
  player.positionMs = 600_000;
  player.rate = 1;
  player.paused = false;
  deliver({ kind: 'frameRole', role: 'driver' });
});

/* ────────────── the generic finder, on a site nobody registered ─────── */

/**
 * E19's other half, and the reason every test below it is meaningful: this
 * whole file runs on `https://example.com/watch?v=1` — a site in no registry,
 * with one plain <video> and nothing else. The finder is a scan for
 * `video, audio` with no provider gate anywhere in front of it, so an
 * arbitrary page is driven exactly like a recognised one. That is stated here
 * rather than left implied, because it is the promise a queued page makes.
 */
describe('an unregistered site is found and driven like any other', () => {
  it('tells the worker its page changed, and classifies nothing itself', () => {
    const reported = toWorker.filter((m) => m['kind'] === 'provider');
    expect(reported).not.toHaveLength(0);
    // No payload, deliberately: what this tab is showing is the tab's own URL,
    // which the worker reads from the browser and which — unlike anything the
    // page once told it — is still there after MV3 recycles the worker.
    expect(Object.keys(reported[0] ?? {})).toEqual(['kind']);
  });

  /** The scan runs at startup and its result is claimed once — a claim is
   *  re-sent only when it CHANGES, so this is the one the worker elects on. */
  it('claims the page’s plain <video> so the worker has a frame to elect', () => {
    const claim = toWorker.find((m) => m['kind'] === 'frameClaim');
    expect(claim).toBeDefined();
    const metrics = claim?.['metrics'] as Record<string, unknown> | null;
    // Not null: null is "this frame has no player", and would make the page
    // ineligible for election however good its <video> was.
    expect(metrics).not.toBeNull();
    expect(metrics?.['tag']).toBe('video');
    expect(claim?.['url']).toBe('https://example.com/watch?v=1');
  });

  it('applies a room correction to it, which is the whole point', () => {
    deliver(driveMessage(612_000, block({ seekToMs: 612_000, reason: 'seek' })));

    expect(player.touched).toContain('seek:612000');
  });
});

/* ─────────────────────── the elastic decision wins ──────────────────── */

describe('drive — a decision the worker already made', () => {
  it('leaves the player completely alone inside the comfort band', () => {
    // A nudge is in flight (the element runs at 1.03) and the worker has
    // decided to leave it there. The wire's `rate` is the ROOM's rate, so the
    // legacy corrector would pull the nudge out from under the decision.
    player.rate = 1.03;
    deliver(driveMessage(600_700, block({ reason: 'idle' })));
    expect(player.touched).toEqual([]);
  });

  it('does not push a locally paused player back into play on its own', () => {
    // The worker's telemetry still says "playing"; the viewer just pressed the
    // site's own pause button. Doing nothing costs one heartbeat, after which
    // the worker sees the truth and sends a real transport command. Fighting
    // it here would be a control loop against the user.
    player.paused = true;
    deliver(driveMessage(600_200, block({ reason: 'idle' })));
    expect(player.touched).toEqual([]);
  });

  it('never corrects into a buffering player', () => {
    // A stalled player does not advance, but the worker's projection does, so
    // the wire position runs away from the element by seconds. Correcting into
    // a stall is what makes it worse.
    player.rate = 1.03;
    deliver(driveMessage(603_000, block({ reason: 'stalled' })));
    expect(player.touched).toEqual([]);
  });

  it('honours a suppressed seek — voice is live, or the player cannot seek', () => {
    player.rate = 1.03;
    deliver(driveMessage(600_800, block({ reason: 'seek-suppressed' })));
    expect(player.touched).toEqual([]);
  });

  it('holds still when the player ignores playbackRate and the anchor absorbs it', () => {
    deliver(driveMessage(600_900, block({ reason: 'rate-locked' })));
    expect(player.touched).toEqual([]);
  });

  it('applies host intent verbatim: play, with the realign it was given', () => {
    // The element still carries a nudge the worker's last sample predates, so
    // the decision says nothing about the rate. The legacy corrector would see
    // 1.03 against a room rate of 1 and cancel the nudge on its way past.
    player.paused = true;
    player.positionMs = 100_000;
    player.rate = 1.03;
    deliver(driveMessage(130_000, block({ transport: 'play', seekToMs: 130_000, reason: 'transport' })));
    expect(player.touched).toEqual(['seek:130000', 'play']);
  });

  it('applies host intent verbatim: pause, and nothing else', () => {
    // The room paused. The rate is left exactly where the worker left it —
    // the legacy path would reset it to the room rate on the way past.
    player.rate = 1.03;
    deliver(driveMessage(600_600, block({ transport: 'pause', reason: 'transport' }), { playing: false }));
    expect(player.touched).toEqual(['pause']);
  });

  it('seeks to the target it was given, and applies the rate it was given', () => {
    // The message's `positionMs` exists so the legacy shim lands on this same
    // target — but only the elastic path assigns a rate the worker asked for
    // and this frame cannot see the need for. A landed seek ends the nudge.
    deliver(driveMessage(612_000, block({ seekToMs: 612_000, setRate: 1, reason: 'seek' })));
    expect(player.touched).toEqual(['seek:612000', 'rate:1']);
  });

  it('nudges the rate without seeking', () => {
    deliver(driveMessage(600_800, block({ setRate: 1.03, reason: 'nudge' }), { rate: 1.03 }));
    expect(player.touched).toEqual(['rate:1.03']);
  });

  it('restores the room rate without seeking', () => {
    player.rate = 1.03;
    deliver(driveMessage(600_700, block({ setRate: 1, reason: 'restore-rate' })));
    expect(player.touched).toEqual(['rate:1']);
  });
});

/* ──────────────────────────── the fallbacks ─────────────────────────── */

describe('drive — when the decision is ours to make', () => {
  it('follows the room on its own bands when the worker is blind', () => {
    // 'no-telemetry' is the worker saying nothing is reporting back to it. It
    // is the one idle command it sends, precisely so this frame keeps
    // following the room — honouring it verbatim would mean sitting still on a
    // tab whose telemetry never arrives.
    deliver(driveMessage(640_000, block({ reason: 'no-telemetry' })));
    expect(player.touched).toEqual(['seek:640000']);
  });

  it('falls back to the legacy fixed bands for a message with no block', () => {
    // An older background worker driving a newer content script.
    deliver(driveMessage(604_000));
    expect(player.touched).toEqual(['seek:604000']);
  });

  it('stays inside the legacy deadband when the block is absent and drift is small', () => {
    deliver(driveMessage(600_100));
    expect(player.touched).toEqual([]);
  });
});

describe('drive — a block from a worker we cannot trust', () => {
  const malformed: Array<[string, unknown]> = [
    ['not an object at all', 'seek'],
    ['null', null],
    ['an array', []],
    ['an unknown transport', { transport: 'stop', seekToMs: null, setRate: null, reason: 'seek' }],
    ['no transport', { seekToMs: null, setRate: null, reason: 'seek' }],
    ['a seek target that is not a number', { transport: 'none', seekToMs: '612000', setRate: null, reason: 'seek' }],
    ['a non-finite seek target', { transport: 'none', seekToMs: Number.NaN, setRate: null, reason: 'seek' }],
    ['an absent seek field', { transport: 'none', setRate: null, reason: 'seek' }],
    ['a rate of zero', { transport: 'none', seekToMs: null, setRate: 0, reason: 'nudge' }],
    ['a negative rate', { transport: 'none', seekToMs: null, setRate: -1, reason: 'nudge' }],
    ['an absurd rate', { transport: 'none', seekToMs: null, setRate: 1000, reason: 'nudge' }],
    ['a rate that is a string', { transport: 'none', seekToMs: null, setRate: '1.03', reason: 'nudge' }],
  ];

  for (const [name, elastic] of malformed) {
    it(`degrades to the legacy path, and does not throw, given ${name}`, () => {
      expect(() => deliver(driveMessage(604_000, elastic as Record<string, unknown>))).not.toThrow();
      expect(player.touched).toEqual(['seek:604000']);
    });
  }
});

describe('drive — release', () => {
  it('stops driving when the frame loses the election', () => {
    deliver({ kind: 'frameRole', role: 'idle' });
    deliver({ kind: 'driveOff' });
    expect(player.touched).toEqual([]);
  });
});

/**
 * The election is the ONLY thing that lets a frame touch the element. A
 * command is not a licence: the worker addresses a frame by id, and a frame
 * whose id was reused, or whose claim went stale a tick ago (an ad roll swaps
 * the element, a source swap zeroes the duration, a fullscreen transition
 * resizes it), must not take the player back from whoever now holds it.
 */
describe('drive — only the elected frame', () => {
  it('ignores a command sent to a frame the election demoted', () => {
    deliver({ kind: 'frameRole', role: 'idle' });
    deliver({ kind: 'driveOff' });

    deliver(driveMessage(640_000, block({ reason: 'no-telemetry' })));

    expect(player.touched).toEqual([]);
  });

  it('stays stopped for every later command, not only the first', () => {
    deliver({ kind: 'frameRole', role: 'idle' });

    for (const at of [640_000, 641_000, 642_000]) {
      deliver(driveMessage(at, block({ seekToMs: at, reason: 'seek' })));
    }

    expect(player.touched).toEqual([]);
  });

  it('ignores a command with no block either — the legacy path is not a way in', () => {
    deliver({ kind: 'frameRole', role: 'idle' });

    deliver(driveMessage(604_000));

    expect(player.touched).toEqual([]);
  });

  it('drives again only when the election says so again', () => {
    deliver({ kind: 'frameRole', role: 'idle' });
    deliver(driveMessage(612_000, block({ seekToMs: 612_000, reason: 'seek' })));
    expect(player.touched).toEqual([]);

    deliver({ kind: 'frameRole', role: 'driver' });
    deliver(driveMessage(612_000, block({ seekToMs: 612_000, reason: 'seek' })));

    expect(player.touched).toEqual(['seek:612000']);
  });
});
