/**
 * The service worker reads the payload the server ACTUALLY sends (E15).
 *
 * sw.js used to destructure `{ title, body, url, tag }`. The server has never
 * sent those keys — chat/notify.ts sends
 * `{ kind, roomId, roomName, fromDisplayName, messageId, preview }` — so every
 * notification that ever reached a device would have read
 * "Gather — Something moved in a room." and opened /home.
 *
 * Second defect in the same file: `notificationclick` focused ANY existing
 * window and never navigated it, so even a correct payload landed the user on
 * whatever page they already had open.
 *
 * Third: a watch-together app must never interrupt playback. A push for the
 * room you are already sitting in, on screen, is pure interruption — the tab
 * badge is the right channel for that, so the OS notification is suppressed.
 *
 * Run the REAL file: sw.js ships as a static asset, is never imported by the
 * bundle, and is exactly the kind of code that rots unwatched. It is evaluated
 * here inside a `node:vm` sandbox that stands in for the worker global scope.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://gather.watch';

interface Shown {
  title: string;
  options: Record<string, unknown>;
}

interface FakeWindow {
  url: string;
  visibilityState?: string;
  focused?: string[];
  navigated?: string[];
}

/** A window client the worker can see through `clients.matchAll()`. */
function windowClient(over: FakeWindow) {
  const focused: string[] = over.focused ?? [];
  const navigated: string[] = over.navigated ?? [];
  return {
    url: over.url,
    visibilityState: over.visibilityState ?? 'hidden',
    focused,
    navigated,
    focus() {
      focused.push(this.url);
      return Promise.resolve(this);
    },
    navigate(url: string) {
      navigated.push(url);
      this.url = url;
      return Promise.resolve(this);
    },
  };
}

type WindowClient = ReturnType<typeof windowClient>;

/** Evaluate sw.js against a stub worker scope and hand back its listeners. */
function loadWorker(windows: WindowClient[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];

  const clients = {
    matchAll: () => Promise.resolve(windows),
    openWindow: (url: string) => {
      opened.push(url);
      return Promise.resolve(null);
    },
    claim: () => Promise.resolve(undefined),
  };
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, fn);
    },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve(undefined);
      },
    },
    location: { origin: ORIGIN },
    skipWaiting: () => Promise.resolve(undefined),
    clients,
  };

  runInContext(
    SOURCE,
    createContext({
      self,
      clients,
      caches: { open: () => Promise.reject(new Error('unused')), keys: () => Promise.resolve([]) },
      fetch: () => Promise.reject(new Error('unused')),
      URL,
      Response,
      console,
    }),
  );

  /** Fire the push handler and settle everything it kept alive. */
  const push = async (data: unknown): Promise<void> => {
    const pending: unknown[] = [];
    const handler = listeners.get('push');
    if (handler === undefined) throw new Error('sw.js registered no push listener');
    handler({
      data: data === undefined ? null : { json: () => data },
      waitUntil: (p: unknown) => pending.push(p),
    });
    await Promise.all(pending);
  };

  /** Fire notificationclick for a notification the worker previously showed. */
  const click = async (notification: Shown): Promise<void> => {
    const pending: unknown[] = [];
    let closed = false;
    const handler = listeners.get('notificationclick');
    if (handler === undefined) throw new Error('sw.js registered no notificationclick listener');
    handler({
      notification: {
        data: notification.options['data'],
        close: () => {
          closed = true;
        },
      },
      waitUntil: (p: unknown) => pending.push(p),
    });
    await Promise.all(pending);
    if (!closed) throw new Error('notificationclick did not close the notification');
  };

  return { shown, opened, push, click };
}

const MENTION = {
  kind: 'mention',
  roomId: 'room_abc',
  roomName: 'Friday Film Club',
  fromDisplayName: 'Ada',
  messageId: 'msg_1',
  preview: 'starting in five, get in here',
};

describe('service worker push payload', () => {
  it('builds a mention notification from the keys the server really sends', async () => {
    const sw = loadWorker();
    await sw.push(MENTION);

    expect(sw.shown).toHaveLength(1);
    const [note] = sw.shown;
    expect(note?.title).toContain('Friday Film Club');
    expect(String(note?.options['body'])).toContain('Ada');
    expect(String(note?.options['body'])).toContain('starting in five, get in here');
    expect(note?.options['data']).toMatchObject({ url: '/room/room_abc' });
    // Never "Something moved in a room."
    expect(String(note?.options['body'])).not.toContain('Something moved');
  });

  it('names the inviter on an invite and the room on a room-started ping', async () => {
    const sw = loadWorker();
    await sw.push({
      kind: 'invite',
      roomId: 'room_inv',
      roomName: 'Sunday Roast',
      fromDisplayName: 'Grace',
    });
    await sw.push({ kind: 'room-started', roomId: 'room_live', roomName: 'Sunday Roast' });

    expect(sw.shown).toHaveLength(2);
    expect(`${sw.shown[0]?.title} ${String(sw.shown[0]?.options['body'])}`).toContain('Grace');
    expect(sw.shown[0]?.options['data']).toMatchObject({ url: '/room/room_inv' });
    expect(`${sw.shown[1]?.title} ${String(sw.shown[1]?.options['body'])}`).toContain(
      'Sunday Roast',
    );
    expect(sw.shown[1]?.options['data']).toMatchObject({ url: '/room/room_live' });
  });

  it('collapses a burst of mentions in one room onto a single notification', async () => {
    const sw = loadWorker();
    await sw.push(MENTION);
    await sw.push({ ...MENTION, messageId: 'msg_2', preview: 'seriously, now' });

    expect(sw.shown).toHaveLength(2);
    expect(sw.shown[0]?.options['tag']).toBe(sw.shown[1]?.options['tag']);
    expect(sw.shown[0]?.options['tag']).toContain('room_abc');
  });

  it('stays silent when that room is already on screen — playback is never interrupted', async () => {
    const sw = loadWorker([
      windowClient({ url: `${ORIGIN}/room/room_abc`, visibilityState: 'visible' }),
    ]);
    await sw.push(MENTION);
    expect(sw.shown).toEqual([]);
  });

  it('still notifies when the open window is a different room', async () => {
    const sw = loadWorker([
      windowClient({ url: `${ORIGIN}/room/room_other`, visibilityState: 'visible' }),
    ]);
    await sw.push(MENTION);
    expect(sw.shown).toHaveLength(1);
  });

  it('survives a malformed payload instead of throwing inside the worker', async () => {
    const sw = loadWorker();
    await sw.push(undefined);
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('Gather');
  });
});

describe('service worker notification click', () => {
  it('navigates the window it focuses instead of leaving it where it was', async () => {
    const existing = windowClient({ url: `${ORIGIN}/home` });
    const sw = loadWorker([existing]);
    await sw.push(MENTION);
    await sw.click(sw.shown[0] as Shown);

    expect(existing.navigated).toEqual([`${ORIGIN}/room/room_abc`]);
    expect(existing.focused.length).toBeGreaterThan(0);
    expect(sw.opened).toEqual([]);
  });

  it('opens a window when none is available', async () => {
    const sw = loadWorker([]);
    await sw.push(MENTION);
    await sw.click(sw.shown[0] as Shown);

    expect(sw.opened).toEqual([`${ORIGIN}/room/room_abc`]);
  });

  it('does not re-navigate a window already on the target room', async () => {
    const existing = windowClient({ url: `${ORIGIN}/room/room_abc` });
    const sw = loadWorker([existing]);
    await sw.push(MENTION);
    await sw.click(sw.shown[0] as Shown);

    expect(existing.navigated).toEqual([]);
    expect(existing.focused).toEqual([`${ORIGIN}/room/room_abc`]);
  });
});
