import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The popup is a document that talks to the worker, so it is exercised the way
 * a user drives it: press a button, let the answer come back, read what the
 * page now says. The elements come from the SHIPPED markup — an element the
 * script reaches for and the page does not carry fails here, not in Chrome.
 */
const POPUP_HTML = readFileSync(
  fileURLToPath(new URL('../public/popup.html', import.meta.url)),
  'utf8',
);

function popupIds(): string[] {
  return [...POPUP_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1] ?? '').filter((id) => id !== '');
}

/** `hidden` starts where the markup puts it, so an element the script never
 *  touches cannot pass an assertion by accident. */
function startsHidden(id: string): boolean {
  const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(POPUP_HTML)?.[0] ?? '';
  return /\shidden(?=[\s/>])/.test(tag);
}

/** The only element properties popup.ts touches. Nothing else exists. */
interface FakeEl {
  textContent: string;
  hidden: boolean;
  className: string;
  disabled: boolean;
  value: string;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

function fakeEl(id: string): FakeEl {
  const clicks: Array<() => void> = [];
  return {
    textContent: '',
    hidden: startsHidden(id),
    className: '',
    disabled: false,
    value: '',
    addEventListener(type: string, fn: () => void): void {
      if (type === 'click') clicks.push(fn);
    },
    click(): void {
      for (const fn of [...clicks]) fn();
    },
  };
}

type Envelope = { ok: true; value: unknown } | { ok: false; error: string };

interface Status {
  connected: boolean;
  roomName: string | null;
  playing: boolean;
  telemetry: null;
  provider: null;
  sharing: boolean;
}

interface Worker {
  sent: Array<Record<string, unknown>>;
  status: Status;
  /** What the worker answers the next `popup:share` with. */
  shareAnswer: Envelope;
}

let elements = new Map<string, FakeEl>();
let worker: Worker;

/** The worker's half of the internal channel, answering in its envelope. */
async function sendMessage(msg: Record<string, unknown>): Promise<Envelope> {
  worker.sent.push(msg);
  switch (msg['kind']) {
    case 'popup:status':
      return { ok: true, value: { ...worker.status } };
    case 'popup:share': {
      const answer = worker.shareAnswer;
      const value = answer.ok ? (answer.value as { shared?: unknown }) : null;
      // A worker that started a capture reports it from that moment on.
      if (value?.shared === true) worker.status.sharing = true;
      return answer;
    }
    case 'popup:stopShare':
      worker.status.sharing = false;
      return { ok: true, value: null };
    case 'popup:disconnect':
      worker.status = { ...worker.status, connected: false, sharing: false };
      return { ok: true, value: null };
    case 'popup:cast':
      return { ok: true, value: { clicked: false, reason: '' } };
    default:
      return { ok: true, value: null };
  }
}

const globals = globalThis as unknown as { document: unknown; chrome: unknown };

function el(id: string): FakeEl {
  const found = elements.get(id);
  if (found === undefined) throw new Error(`#${id} is not in popup.html`);
  return found;
}

/** Chained promises settle over several microtask turns; none of this is timed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

type Popup = typeof import('../src/popup');

/** Opening the popup: a fresh module, because the real one is destroyed and
 *  rebuilt every time the user clicks the toolbar icon. */
async function openPopup(): Promise<Popup> {
  vi.resetModules();
  const mod = (await import('../src/popup')) as Popup;
  await settle();
  return mod;
}

const SHARED_WINDOW: Envelope = {
  ok: true,
  value: { shared: true, cancelled: false, note: 'Sharing that window with the room.' },
};

beforeEach(() => {
  vi.useFakeTimers();
  elements = new Map(popupIds().map((id) => [id, fakeEl(id)]));
  worker = {
    sent: [],
    status: {
      connected: true,
      roomName: 'Movie night',
      playing: true,
      telemetry: null,
      provider: null,
      sharing: false,
    },
    shareAnswer: SHARED_WINDOW,
  };
  globals.document = { getElementById: (id: string): FakeEl | null => elements.get(id) ?? null };
  globals.chrome = { runtime: { sendMessage } };
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'chrome');
});

describe('what the popup says a share did', () => {
  it('shows nothing at all when the user closes the picker', async () => {
    worker.shareAnswer = {
      ok: true,
      value: {
        shared: false,
        cancelled: true,
        note: 'Nothing was shared — you closed the picker.',
      },
    };
    await openPopup();

    el('share-window').click();
    await settle();

    expect(el('share-note').hidden).toBe(true);
    expect(el('share-note').textContent).toBe('');
    expect(el('share-error').hidden).toBe(true);
    expect(el('share-stop').hidden).toBe(true);
    for (const id of ['share-tab', 'share-window', 'share-screen']) {
      expect(el(id).disabled).toBe(false);
    }
    expect(el('share-window').textContent).toBe('A window');
  });

  it('shows a capture that failed as a failure, not as a live share', async () => {
    worker.shareAnswer = {
      ok: true,
      value: {
        shared: false,
        cancelled: false,
        note: 'That share could not start — nothing is going to the room.',
      },
    };
    await openPopup();

    el('share-screen').click();
    await settle();

    expect(el('share-error').hidden).toBe(false);
    expect(el('share-error').textContent).toBe(
      'That share could not start — nothing is going to the room.',
    );
    expect(el('share-note').hidden).toBe(true);
    expect(el('share-stop').hidden).toBe(true);
    expect(el('share-screen').disabled).toBe(false);
  });

  it('repeats the sentence the worker sent about sound, not a guess of its own', async () => {
    const note =
      'Sharing that window with the room — without its sound. Share a tab if the sound matters.';
    worker.shareAnswer = { ok: true, value: { shared: true, cancelled: false, note } };
    await openPopup();

    el('share-window').click();
    await settle();

    expect(el('share-note').textContent).toBe(note);
    expect(el('share-note').hidden).toBe(false);
    expect(el('share-stop').hidden).toBe(false);
    expect(el('share-tab').disabled).toBe(true);
  });

  it('shows a refusal the user can fix even when it reads like a closed picker', async () => {
    // Reachable while connected: the driven tab was closed, so there is no tab
    // to share — a genuine refusal that the old wording test called a dismissal.
    worker.shareAnswer = { ok: false, error: 'no tab selected' };
    await openPopup();

    el('share-tab').click();
    await settle();

    expect(el('share-error').hidden).toBe(false);
    expect(el('share-error').textContent).toBe('no tab selected');
    expect(el('share-note').hidden).toBe(true);
    expect(el('share-stop').hidden).toBe(true);
    expect(el('share-tab').disabled).toBe(false);
  });
});

describe('a share that ends without the popup', () => {
  it('returns the buttons and drops the sentence within one poll', async () => {
    await openPopup();
    el('share-window').click();
    await settle();
    expect(el('share-stop').hidden).toBe(false);

    // Chrome's own "Stop sharing" bar: the capture ends, the worker forgets
    // it, and the only way this document hears about it is the next poll.
    worker.status.sharing = false;
    vi.advanceTimersByTime(2000);
    await settle();

    for (const id of ['share-tab', 'share-window', 'share-screen']) {
      expect(el(id).disabled).toBe(false);
    }
    expect(el('share-stop').hidden).toBe(true);
    expect(el('share-note').hidden).toBe(true);
    expect(el('share-note').textContent).toBe('');
  });

  it('does not claim the old share again when the next one is refused', async () => {
    await openPopup();
    el('share-window').click();
    await settle();

    worker.status.sharing = false;
    vi.advanceTimersByTime(2000);
    await settle();

    worker.shareAnswer = { ok: false, error: 'connect to a room first' };
    el('share-tab').click();
    await settle();

    expect(el('share-stop').hidden).toBe(true);
    expect(el('share-note').hidden).toBe(true);
    expect(el('share-error').textContent).toBe('connect to a room first');
  });
});

describe('stopping a share from the popup', () => {
  it('offers a way to stop the share it started', async () => {
    await openPopup();
    el('share-window').click();
    await settle();

    el('share-stop').click();
    await settle();

    expect(worker.sent.filter((m) => m['kind'] === 'popup:stopShare')).toHaveLength(1);
    expect(el('share-stop').hidden).toBe(true);
    expect(el('share-note').hidden).toBe(true);
    expect(el('share-tab').disabled).toBe(false);
  });

  it('can stop a share it did not start, opened while one is running', async () => {
    worker.status.sharing = true;
    await openPopup();

    expect(el('share-stop').hidden).toBe(false);
    expect(el('share-note').hidden).toBe(false);
    expect(el('share-note').textContent.length).toBeGreaterThan(0);
    expect(el('share-tab').disabled).toBe(true);

    el('share-stop').click();
    await settle();

    expect(worker.sent.filter((m) => m['kind'] === 'popup:stopShare')).toHaveLength(1);
    expect(el('share-stop').hidden).toBe(true);
    expect(el('share-tab').disabled).toBe(false);
  });

  it('speaks only to the worker, never to the capture document', async () => {
    worker.status.sharing = true;
    await openPopup();
    el('share-stop').click();
    await settle();

    const internal = worker.sent.filter((m) => {
      const kind = String(m['kind'] ?? '');
      return kind === 'startShare' || kind === 'stopShare' || kind === 'shareEnded';
    });
    expect(internal).toEqual([]);
  });
});

describe('reading the worker answer', () => {
  it('tells the three outcomes apart by their fields', async () => {
    const { shareView } = await openPopup();

    expect(
      shareView({ shared: true, cancelled: false, note: 'Sharing this tab with the room.' }),
    ).toEqual({ live: true, note: 'Sharing this tab with the room.', error: '' });
    expect(
      shareView({
        shared: false,
        cancelled: true,
        note: 'Nothing was shared — you closed the picker.',
      }),
    ).toEqual({ live: false, note: '', error: '' });
    expect(
      shareView({
        shared: false,
        cancelled: false,
        note: 'That room ended before the share started.',
      }),
    ).toEqual({ live: false, note: '', error: 'That room ended before the share started.' });
  });

  it('never claims a share from an answer it cannot read', async () => {
    const { shareView } = await openPopup();

    for (const answer of [null, undefined, {}, 'ok', { shared: 'yes' }]) {
      const view = shareView(answer);
      expect(view.live).toBe(false);
      expect(view.note).toBe('');
      expect(view.error.length).toBeGreaterThan(0);
    }
  });
});
