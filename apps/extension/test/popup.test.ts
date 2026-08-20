import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { providerForUrl, providerGrantPatterns } from '../src/providers';
import type { TabProvider } from '../src/providers';

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
  provider: TabProvider | null;
  sharing: boolean;
  /** The popup's tab is the driven tab. Optional — older backgrounds omit it. */
  drivenTab?: boolean;
  /** …and a frame on it is elected and actually driven. Optional likewise. */
  driving?: boolean;
  /** Why the ROOM ended the last share; absent when nothing ended that way. */
  shareEnded?: string;
  /** The room's current item title, as the overlay's now-playing line has it;
   *  null when nothing resolvable plays. Optional — older backgrounds omit it. */
  currentItemTitle?: string | null;
}

interface Worker {
  sent: Array<Record<string, unknown>>;
  status: Status;
  /** What the worker answers the next `popup:share` with. */
  shareAnswer: Envelope;
  /** …and the next `popup:cast`, which is answered by the page, not the worker. */
  castAnswer: { clicked: boolean; reason: string };
}

let elements = new Map<string, FakeEl>();
let worker: Worker;

/** The tab the popup is drawn over; null = the browser has no active tab. */
let activeTab: { id: number; url: string } | null;

/** chrome.permissions, recorded: what was asked for, and what Chrome said. */
let permissions: {
  /** Every origins list handed to permissions.request, in order. */
  requested: string[][];
  /** What the next request answers — false is the user declining. */
  requestAnswer: boolean;
  /** What contains() answers about any origins list. */
  containsAnswer: boolean;
};

/** Everything the popup did that has an order worth asserting: 'request' for
 *  a permission ask, 'msg:<kind>' for a worker message. */
let calls: string[] = [];

/** Every ask handed to chrome.search.query, in order. */
let searchQueries: Array<{ text: string; disposition: string }> = [];

/** The worker's half of the internal channel, answering in its envelope. */
async function sendMessage(msg: Record<string, unknown>): Promise<Envelope> {
  worker.sent.push(msg);
  calls.push(`msg:${String(msg['kind'] ?? '')}`);
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
      return { ok: true, value: { ...worker.castAnswer } };
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
      // A healthy driven tab, so only the tests about the unhealthy states
      // have to say anything about driving.
      drivenTab: true,
      driving: true,
      // Nothing resolvable plays by default, so only the find-button tests
      // have to say anything about the current item.
      currentItemTitle: null,
    },
    shareAnswer: SHARED_WINDOW,
    castAnswer: { clicked: false, reason: '' },
  };
  activeTab = { id: 7, url: 'https://example.com/watch' };
  permissions = { requested: [], requestAnswer: true, containsAnswer: false };
  calls = [];
  searchQueries = [];
  globals.document = { getElementById: (id: string): FakeEl | null => elements.get(id) ?? null };
  globals.chrome = {
    runtime: { sendMessage },
    tabs: { query: async () => (activeTab === null ? [] : [activeTab]) },
    permissions: {
      request: async (opts: { origins?: string[] }) => {
        permissions.requested.push([...(opts.origins ?? [])]);
        calls.push('request');
        return permissions.requestAnswer;
      },
      contains: async () => permissions.containsAnswer,
    },
    search: {
      query: async (q: { text: string; disposition: string }) => {
        searchQueries.push({ text: q.text, disposition: q.disposition });
      },
    },
  };
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

/* ── the cast control, which fails more often than it succeeds ── */

/**
 * The cast selectors are DATA (providers.ts), and a site that has been
 * reskinned since they were written is the normal end of their life. What is
 * left when that happens is the sentence, so the sentence has to survive the
 * poll that redraws this document every two seconds — a site Gather can cast
 * from has no standing reason of its own, so the redraw used to blank the slot
 * and the press read as a button that does nothing at all.
 */
describe('what the popup says a cast press did', () => {
  const youtube = providerForUrl('https://www.youtube.com/watch?v=abc');
  const missed = "Couldn't find YouTube's cast control on this page — start playback first, or cast from the site's own player.";

  it('keeps the miss on screen across the polls that follow', async () => {
    worker.status.provider = youtube;
    worker.castAnswer = { clicked: false, reason: missed };
    await openPopup();
    expect(el('cast').disabled).toBe(false);

    el('cast').click();
    await settle();
    expect(el('cast-reason').textContent).toBe(missed);
    expect(el('cast-reason').hidden).toBe(false);

    vi.advanceTimersByTime(6000);
    await settle();

    expect(el('cast-reason').textContent).toBe(missed);
    expect(el('cast-reason').hidden).toBe(false);
  });

  it('lets the site’s own standing reason replace it', async () => {
    worker.status.provider = youtube;
    worker.castAnswer = { clicked: false, reason: missed };
    await openPopup();
    el('cast').click();
    await settle();

    // The tab went somewhere Gather cannot cast from at all: that reason is
    // about the page in front of the user and outranks a press already made.
    worker.status.provider = providerForUrl('https://www.netflix.com/watch/80100172');
    vi.advanceTimersByTime(2000);
    await settle();

    expect(el('cast-reason').textContent).toBe(worker.status.provider.cast.reason);
    expect(el('cast').disabled).toBe(true);
  });

  it('shows what the press achieved when it did work', async () => {
    worker.status.provider = youtube;
    worker.castAnswer = { clicked: true, reason: "Opened YouTube's cast picker." };
    await openPopup();

    el('cast').click();
    await settle();
    vi.advanceTimersByTime(2000);
    await settle();

    expect(el('cast-reason').textContent).toBe("Opened YouTube's cast picker.");
    expect(el('cast').disabled).toBe(false);
  });
});

/* ── "Find it where you are": the default-search bridge ── */

/**
 * A member in another region often cannot play the queued item where it was
 * queued. The button hands the title to THEIR default engine (chrome.search,
 * on the click's own gesture) and the user picks a site their region has —
 * Gather never navigates for anyone. The worker names the item; this page
 * only renders and asks.
 */
describe('the find-it-where-you-are button', () => {
  it('shows the title and searches the user’s engine in a new tab', async () => {
    worker.status.currentItemTitle = 'The Feature (2019)';
    await openPopup();

    expect(el('find-content').hidden).toBe(false);
    expect(el('find-content').textContent).toBe('Find “The Feature (2019)” where you are');
    expect(el('find-content-hint').hidden).toBe(false);

    el('find-content').click();
    await settle();

    // The full title as the room has it, plus 'watch' — no year synthesis:
    // the resolver upstream already put one in the title when it had one.
    expect(searchQueries).toEqual([
      { text: 'The Feature (2019) watch', disposition: 'NEW_TAB' },
    ]);
  });

  it('truncates a long title in the label, never in the query', async () => {
    const long = 'An Extremely Long Documentary About the Bottom of the Sea (2021)';
    worker.status.currentItemTitle = long;
    await openPopup();

    expect(el('find-content').textContent).toBe(
      'Find “An Extremely Long Documentary About the…” where you are',
    );

    el('find-content').click();
    await settle();

    expect(searchQueries).toEqual([{ text: `${long} watch`, disposition: 'NEW_TAB' }]);
  });

  it('stays hidden with nothing playing, and while not connected', async () => {
    worker.status.currentItemTitle = null;
    await openPopup();

    expect(el('find-content').hidden).toBe(true);
    expect(el('find-content-hint').hidden).toBe(true);

    // A titled item does not resurrect the button on a disconnected popup.
    worker.status = { ...worker.status, connected: false, currentItemTitle: 'The Feature' };
    vi.advanceTimersByTime(2000);
    await settle();

    expect(el('find-content').hidden).toBe(true);
    expect(el('find-content-hint').hidden).toBe(true);
  });

  it('goes away on the poll that stops naming an item', async () => {
    worker.status.currentItemTitle = 'The Feature';
    await openPopup();
    expect(el('find-content').hidden).toBe(false);

    worker.status.currentItemTitle = null;
    vi.advanceTimersByTime(2000);
    await settle();

    expect(el('find-content').hidden).toBe(true);
    expect(el('find-content-hint').hidden).toBe(true);
  });

  it('never appears — and never throws — without chrome.search', async () => {
    worker.status.currentItemTitle = 'The Feature';
    delete (globals.chrome as { search?: unknown }).search;
    await openPopup();

    expect(el('find-content').hidden).toBe(true);
    expect(el('find-content-hint').hidden).toBe(true);
    // A click on the hidden control (keyboard focus can still reach it) is a
    // no-op, not a TypeError on a missing namespace.
    expect(() => el('find-content').click()).not.toThrow();
    expect(searchQueries).toEqual([]);
  });
});

/* ── a share the ROOM ended ── */

/**
 * Refused outright, or stopped by a moderator. Nothing else on this page would
 * say so: the share was reported as started — locally it had been — and the
 * buttons simply come back a moment later, which is indistinguishable from the
 * user's own stop.
 */
describe('a share the room ended', () => {
  it('shows the room’s reason on the poll that reports the share gone', async () => {
    await openPopup();
    el('share-window').click();
    await settle();
    expect(el('share-stop').hidden).toBe(false);

    worker.status.sharing = false;
    worker.status.shareEnded = 'This room allows 4 people to publish at once.';
    vi.advanceTimersByTime(2000);
    await settle();

    expect(el('share-error').hidden).toBe(false);
    expect(el('share-error').textContent).toBe('This room allows 4 people to publish at once.');
    expect(el('share-stop').hidden).toBe(true);
    expect(el('share-tab').disabled).toBe(false);
  });

  it('says nothing when the share ended in a way the user performed', async () => {
    await openPopup();
    el('share-window').click();
    await settle();

    worker.status.sharing = false;
    worker.status.shareEnded = '';
    vi.advanceTimersByTime(2000);
    await settle();

    expect(el('share-error').hidden).toBe(true);
    expect(el('share-error').textContent).toBe('');
  });
});

/* ── connecting: the password, and the site grant the click carries ── */

describe('connecting with a room code', () => {
  it('sends the password only when one was typed', async () => {
    await openPopup();
    el('code').value = 'abcd-efgh-ijkl';
    el('password').value = '  swordfish  ';
    el('connect').click();
    await settle();

    const first = worker.sent.find((m) => m['kind'] === 'popup:connect');
    expect(first?.['password']).toBe('swordfish');

    worker.sent.length = 0;
    el('password').value = '   ';
    el('connect').click();
    await settle();

    const second = worker.sent.find((m) => m['kind'] === 'popup:connect');
    expect(second).toBeDefined();
    // The KEY is absent, not empty — absence is what "no password" is.
    expect('password' in (second ?? {})).toBe(false);
  });

  it('asks for the site inside the click, before the join is sent', async () => {
    await openPopup();
    calls.length = 0;
    el('code').value = 'abcd-efgh-ijkl';
    el('connect').click();
    await settle();

    // The active tab was read when the popup opened, so the click had its
    // pattern list ready — and asked before anything went to the worker.
    expect(permissions.requested).toEqual([['https://example.com/*']]);
    expect(calls.indexOf('request')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('request')).toBeLessThan(calls.indexOf('msg:popup:connect'));
  });

  it('still connects when the grant is declined — activeTab covers the tab', async () => {
    permissions.requestAnswer = false;
    await openPopup();
    el('code').value = 'abcd-efgh-ijkl';
    el('connect').click();
    await settle();

    expect(worker.sent.filter((m) => m['kind'] === 'popup:connect')).toHaveLength(1);
    expect(el('error').hidden).toBe(true);
  });
});

/* ── the live card's site-access levers ── */

describe('the live card offers to make site access stick', () => {
  it('says how to keep Gather on an ungranted site, and asks when pressed', async () => {
    permissions.containsAnswer = false;
    await openPopup();

    expect(el('site-keep').hidden).toBe(false);
    expect(el('site-access-note').hidden).toBe(false);
    expect(el('site-access-note').textContent).toBe(
      'Gather follows this tab only while you keep it connected — allow the site to make it stick.',
    );

    el('site-keep').click();
    await settle();

    expect(permissions.requested).toContainEqual(['https://example.com/*']);
  });

  it('goes quiet once the site is granted', async () => {
    permissions.containsAnswer = true;
    await openPopup();

    expect(el('site-keep').hidden).toBe(true);
    expect(el('site-access-note').hidden).toBe(true);
    expect(el('site-access-note').textContent).toBe('');
  });

  it('requests every supported site from the all-sites button', async () => {
    await openPopup();

    el('site-all').click();
    await settle();

    expect(permissions.requested).toContainEqual(providerGrantPatterns());
  });
});

/* ── 'Connected · playing' must not outrun the tab in front of the user ── */

/**
 * `connected`/`playing` are ROOM state; on an ungranted page whose player
 * lives in a cross-origin iframe (or before any injection at all) the room is
 * "playing" while this tab drives nothing. The worker now says so — status
 * carries `drivenTab` + `driving` — and the provider line owns the sentence.
 */
describe('the popup says when no player has been found on the driven tab', () => {
  it('appends the sentence to the provider line', async () => {
    worker.status.provider = providerForUrl('https://example.com/watch');
    worker.status.driving = false; // the driven tab, but nothing elected on it
    await openPopup();

    // The generic classifier names an unknown site by its hostname.
    expect(el('provider').textContent).toBe(
      'This tab: example.com — no player found on this tab yet',
    );
  });

  it('stands alone when there is no provider line to append to', async () => {
    worker.status.provider = null;
    worker.status.driving = false;
    await openPopup();

    expect(el('provider').textContent).toBe('No player found on this tab yet');
  });

  it('says nothing while a frame is driven, or on a tab the room does not drive', async () => {
    worker.status.provider = providerForUrl('https://example.com/watch');
    await openPopup();
    expect(el('provider').textContent).not.toContain('no player found');

    worker.status = { ...worker.status, drivenTab: false, driving: false };
    vi.advanceTimersByTime(2000);
    await settle();
    expect(el('provider').textContent).not.toContain('no player found');
  });

  it('puts nothing up for an older background that reports neither field', async () => {
    worker.status.provider = providerForUrl('https://example.com/watch');
    delete worker.status.drivenTab;
    delete worker.status.driving;
    await openPopup();

    expect(el('provider').textContent).not.toContain('no player found');
  });
});

/* ── an insecure site cannot be kept ── */

/**
 * siteAccess.ts refuses a standing grant for a plain-http page (a persistent
 * http origin grant is a standing MITM door), so the popup must neither ask
 * for one on connect nor dangle a keep button — and it owes the user the
 * sentence, because to them the site looks exactly like one Gather could keep.
 */
describe('an insecure site cannot be kept', () => {
  it('hides the keep button, explains, and requests nothing on connect', async () => {
    activeTab = { id: 7, url: 'http://intranet.local/movie' };
    await openPopup();

    expect(el('site-keep').hidden).toBe(true);
    expect(el('site-access-note').hidden).toBe(false);
    expect(el('site-access-note').textContent).toBe(
      'Gather follows this tab while it stays connected — an insecure site can’t be kept.',
    );

    el('code').value = 'abcd-efgh-ijkl';
    el('connect').click();
    await settle();

    // The join still goes out — activeTab covers the tab while connected —
    // but no permissions.request is made for an http origin.
    expect(permissions.requested).toEqual([]);
    expect(worker.sent.filter((m) => m['kind'] === 'popup:connect')).toHaveLength(1);
  });

  it('stays silent for a page with nothing grantable at all', async () => {
    activeTab = { id: 7, url: 'chrome://extensions' };
    await openPopup();

    expect(el('site-keep').hidden).toBe(true);
    expect(el('site-access-note').hidden).toBe(true);
    expect(el('site-access-note').textContent).toBe('');
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
