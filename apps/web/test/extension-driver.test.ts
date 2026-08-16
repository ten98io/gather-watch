import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PROTOCOL_CHANNEL,
  configureExtensionBridge,
  eventPortName,
  resetExtensionBridge,
} from '@/lib/extension-bridge';
import {
  EXTENSION_CAPABILITY,
  EXTENSION_ERROR_MESSAGE,
  createExtensionDriverStore,
  describeExtensionError,
  useExtensionDriver,
} from '@/lib/player/extension-driver';
import type { ExtensionDriverStore } from '@/lib/player/extension-driver';
import type { ProtocolErrorCode } from '@/lib/extension-bridge';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'; // 32 chars, a–p

/* ─────────────────────────── fake-chrome harness ───────────────────────────
 * A copy of the harness in test/extension-bridge.test.ts — a test file exports
 * nothing importable, so the two copies must be kept in step by hand. The only
 * additions here are `FakePort.disconnected` (this suite asserts the event port
 * is actually closed) and `installBareWindow` (a browser with no extension
 * channel at all).
 * ------------------------------------------------------------------------- */

interface FakePort {
  postMessage: (m: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (cb: (m: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  emit: (m: unknown) => void;
  kill: () => void;
  name: string;
  disconnected: boolean;
}

interface FakeChrome {
  runtime: {
    sendMessage: (id: string, msg: unknown, cb: (r?: unknown) => void) => void;
    connect: (id: string, info: { name: string }) => FakePort;
    lastError?: { message?: string } | undefined;
  };
}

type Responder = (id: string, msg: Record<string, unknown>) => unknown | 'silent' | 'error';

function installFakeWindow(responder: Responder): { chrome: FakeChrome; ports: FakePort[] } {
  const ports: FakePort[] = [];
  const listeners = new Set<(ev: unknown) => void>();

  const chrome: FakeChrome = {
    runtime: {
      sendMessage: (id, msg, cb) => {
        const result = responder(id, msg as Record<string, unknown>);
        if (result === 'silent') return; // callback never fires
        setTimeout(() => {
          chrome.runtime.lastError = result === 'error' ? { message: 'no receiving end' } : undefined;
          cb(result === 'error' ? undefined : result);
          chrome.runtime.lastError = undefined;
        }, 0);
      },
      connect: (_id, info) => {
        let onMessage: ((m: unknown) => void) | null = null;
        let onDisconnect: (() => void) | null = null;
        const port: FakePort = {
          name: info.name,
          disconnected: false,
          postMessage: () => undefined,
          disconnect: () => {
            port.disconnected = true;
          },
          onMessage: {
            addListener: (cb) => {
              onMessage = cb;
            },
          },
          onDisconnect: {
            addListener: (cb) => {
              onDisconnect = cb;
            },
          },
          emit: (m) => onMessage?.(m),
          kill: () => onDisconnect?.(),
        };
        ports.push(port);
        return port;
      },
    },
  };

  const fakeWindow = {
    chrome,
    location: { origin: 'http://localhost:3000' },
    addEventListener: (type: string, cb: (ev: unknown) => void) => {
      if (type === 'message') listeners.add(cb);
    },
    removeEventListener: (type: string, cb: (ev: unknown) => void) => {
      if (type === 'message') listeners.delete(cb);
    },
    postMessage: (data: unknown) => {
      // Nothing announces by default; tests that need it dispatch manually.
      void data;
    },
  };
  (globalThis as unknown as { window?: unknown }).window = fakeWindow;
  return { chrome, ports };
}

/** A browser that can never host the extension (Safari, Firefox, a phone). */
function installBareWindow(): void {
  (globalThis as unknown as { window?: unknown }).window = {
    location: { origin: 'http://localhost:3000' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    postMessage: () => undefined,
  };
}

/* ─────────────────── browsers with nothing installed yet ───────────────────
 * The shape the funnel actually meets: `window.chrome` exists, `chrome.runtime`
 * does NOT — a page only gets `chrome.runtime` from an installed extension that
 * lists this origin in `externally_connectable`. Real agent strings, because
 * the whole question is which browser family this is.
 * ------------------------------------------------------------------------- */

const CHROME_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHROME_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const SAFARI_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';
const FIREFOX_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0';
const CHROME_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1';

const CHROMIUM_BRANDS = [
  { brand: 'Not/A)Brand', version: '8' },
  { brand: 'Chromium', version: '124' },
  { brand: 'Google Chrome', version: '124' },
];

interface FakeNavigator {
  userAgent: string;
  userAgentData?: { brands: { brand: string; version: string }[]; mobile: boolean };
}

/** A browser with no Gather extension: chrome object, but no runtime channel. */
function installExtensionlessWindow(navigator: FakeNavigator, hasChromeObject = true): void {
  (globalThis as unknown as { window?: unknown }).window = {
    ...(hasChromeObject ? { chrome: {} } : {}),
    navigator,
    location: { origin: 'http://localhost:3000' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    postMessage: () => undefined,
  };
}

/** `extensionInstallUrl()` reads process.env at call time under vitest (Next
 *  inlines it at build time instead, so the shape is the same either way).
 *  Must await inside the try, or the id is gone before detection settles. */
async function withInstallId<T>(run: () => Promise<T>): Promise<T> {
  const key = 'NEXT_PUBLIC_GATHER_EXTENSION_ID';
  const previous = process.env[key];
  process.env[key] = EXT_ID;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function removeFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

const helloResponse = (msg: Record<string, unknown>, version = '0.1.0'): unknown => ({
  channel: PROTOCOL_CHANNEL,
  v: 1,
  id: msg['id'],
  ok: true,
  type: 'hello',
  payload: {
    extensionVersion: version,
    protocolVersion: 1,
    minProtocolVersion: 1,
    capabilities: ['handoff', 'telemetry', 'modeB', 'modeB.desktop'],
  },
});

const statusResponse = (msg: Record<string, unknown>, session: Record<string, unknown>): unknown => ({
  channel: PROTOCOL_CHANNEL,
  v: 1,
  id: msg['id'],
  ok: true,
  type: msg['type'],
  payload: session,
});

const DRIVING_SESSION = {
  connected: true,
  roomId: 'room_1',
  roomName: 'Friday',
  driving: true,
  provider: { id: 'youtube', name: 'YouTube', tier: 'api' },
  hasMedia: true,
};

/* ───────────────────────────────── helpers ─────────────────────────────── */

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const stores: ExtensionDriverStore[] = [];

function newStore(): ExtensionDriverStore {
  const store = createExtensionDriverStore({ detectTimeoutMs: 50, statusTimeoutMs: 50 });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  removeFakeWindow();
  resetExtensionBridge();
  configureExtensionBridge({ extensionIds: [] });
});

/* ─────────────────────────────── plain copy ────────────────────────────── */

describe('user-facing copy', () => {
  it('has a sentence for every protocol code and never leaks the code', () => {
    const codes = Object.keys(EXTENSION_ERROR_MESSAGE) as ProtocolErrorCode[];
    expect(codes.length).toBeGreaterThan(5);
    for (const code of codes) {
      const message = describeExtensionError({ code, message: 'raw wire text' });
      expect(message).not.toContain(code);
      expect(message).not.toContain('_');
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it('falls back to the caller wording for a code it does not know', () => {
    const message = describeExtensionError(
      { code: 'MADE_UP' as ProtocolErrorCode, message: 'raw' },
      'Something went wrong with the extension.',
    );
    expect(message).toBe('Something went wrong with the extension.');
  });
});

/* ─────────────────────────────── SSR safety ────────────────────────────── */

describe('SSR safety', () => {
  it('renders the hook on the server as "detecting" without touching window', () => {
    expect(typeof window).toBe('undefined');
    function Probe(): ReturnType<typeof createElement> {
      const driver = useExtensionDriver();
      return createElement('span', null, `${driver.state.phase}:${String(driver.checking)}`);
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>detecting:true</span>');
  });

  it('settles off "detecting" with no window at all, rather than spinning', async () => {
    const store = newStore();
    const off = store.subscribe(() => undefined);
    await waitFor(() => store.getSnapshot().state.phase !== 'detecting');
    const state = store.getSnapshot().state;
    expect(state.phase).toBe('unavailable');
    if (state.phase === 'unavailable') {
      expect(state.reason).toBe('unsupported-browser');
      expect(state.canInstall).toBe(false);
      expect(state.installUrl).toBeNull();
    }
    expect(store.getSnapshot().checking).toBe(false);
    off();
  });
});

/* ──────────────────────────── detection states ─────────────────────────── */

describe('detection states (fake chrome)', () => {
  beforeEach(() => {
    resetExtensionBridge();
  });

  it('reports "not installed" on a browser that could have it', async () => {
    installFakeWindow(() => 'error');
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => store.getSnapshot().state.phase !== 'detecting');
    const state = store.getSnapshot().state;
    expect(state.phase).toBe('unavailable');
    if (state.phase === 'unavailable') {
      expect(state.reason).toBe('not-installed');
      expect(state.canInstall).toBe(true);
      expect(state.message).toBe(EXTENSION_ERROR_MESSAGE.NOT_INSTALLED);
    }
    off();
  });

  it('tells an unsupported browser it cannot install, not that it should', async () => {
    installBareWindow();
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => store.getSnapshot().state.phase !== 'detecting');
    const state = store.getSnapshot().state;
    if (state.phase !== 'unavailable') throw new Error(`expected unavailable, got ${state.phase}`);
    expect(state.reason).toBe('unsupported-browser');
    expect(state.canInstall).toBe(false);
    expect(state.message).toContain('Gather app');
    off();
  });

  it('reports a version mismatch as incompatible, with the installed version', async () => {
    installFakeWindow((_id, msg) => ({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      id: msg['id'],
      ok: true,
      type: 'hello',
      payload: {
        extensionVersion: '9.0.0',
        protocolVersion: 9,
        minProtocolVersion: 8,
        capabilities: [],
      },
    }));
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => store.getSnapshot().state.phase !== 'detecting');
    const state = store.getSnapshot().state;
    if (state.phase !== 'incompatible') throw new Error(`expected incompatible, got ${state.phase}`);
    expect(state.installedVersion).toBe('9.0.0');
    expect(state.protocolVersion).toBe(9);
    expect(state.message).toBe(EXTENSION_ERROR_MESSAGE.UNSUPPORTED_VERSION);
    off();
  });

  it('reports ready with capabilities and whether it is driving right now', async () => {
    installFakeWindow((_id, msg) =>
      msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION),
    );
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => store.getSnapshot().state.phase === 'ready');
    const ready = store.getSnapshot().state;
    if (ready.phase !== 'ready') throw new Error('expected ready');
    expect(ready.extensionVersion).toBe('0.1.0');
    expect(ready.capabilities).toContain(EXTENSION_CAPABILITY.handoff);
    expect(ready.capabilities).toContain(EXTENSION_CAPABILITY.modeBDesktop);
    expect(ready.notice).toBeNull();
    expect(store.getSnapshot().checking).toBe(false);

    // driving arrives from the follow-up status probe, not from detection.
    await waitFor(() => {
      const s = store.getSnapshot().state;
      return s.phase === 'ready' && s.driving;
    });
    const driving = store.getSnapshot().state;
    if (driving.phase !== 'ready') throw new Error('expected ready');
    expect(driving.connected).toBe(true);
    expect(driving.roomId).toBe('room_1');
    expect(driving.provider?.name).toBe('YouTube');
    off();
  });

  it('follows the driving flag live from a pushed status event', async () => {
    const { ports } = installFakeWindow((_id, msg) =>
      msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION),
    );
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => {
      const s = store.getSnapshot().state;
      return s.phase === 'ready' && s.driving;
    });
    await waitFor(() => ports.length === 1);
    expect(ports[0]?.name).toBe(eventPortName());

    ports[0]?.emit({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'status',
      payload: { ...DRIVING_SESSION, driving: false, hasMedia: false },
    });

    const state = store.getSnapshot().state;
    if (state.phase !== 'ready') throw new Error('expected ready');
    expect(state.driving).toBe(false);
    expect(state.hasMedia).toBe(false);
    expect(state.connected).toBe(true);
    off();
  });
});

/* ──────────────────── not-installed vs. cannot-install ─────────────────── */

describe('which browser this is (no extension present)', () => {
  beforeEach(() => {
    resetExtensionBridge();
  });

  async function settle(): Promise<ExtensionDriverStore> {
    const store = newStore();
    store.subscribe(() => undefined);
    await waitFor(() => store.getSnapshot().state.phase !== 'detecting');
    return store;
  }

  it('offers the install link on desktop Chrome that has no extension yet', async () => {
    // The funnel's whole job. `chrome.runtime` is absent here — a page is only
    // given it by an installed extension — so it must not be read as a verdict
    // on the browser, or the users this funnel exists to convert are told their
    // browser is unsupported and shown no link.
    installExtensionlessWindow({
      userAgent: CHROME_DESKTOP_UA,
      userAgentData: { brands: CHROMIUM_BRANDS, mobile: false },
    });
    const state = await withInstallId(async () => (await settle()).getSnapshot().state);

    if (state.phase !== 'unavailable') throw new Error(`expected unavailable, got ${state.phase}`);
    expect(state.reason).toBe('not-installed');
    expect(state.canInstall).toBe(true);
    expect(state.message).toBe(EXTENSION_ERROR_MESSAGE.NOT_INSTALLED);
    expect(state.installUrl).toBe(`https://chromewebstore.google.com/detail/${EXT_ID}`);
  });

  it('offers the install link on a Chromium build that sends no client hints', async () => {
    // Older Chromium, or hints stripped by a privacy setting: the agent string
    // is the only signal left and it still says Chromium desktop.
    installExtensionlessWindow({ userAgent: CHROME_DESKTOP_UA });
    const state = await withInstallId(async () => (await settle()).getSnapshot().state);

    if (state.phase !== 'unavailable') throw new Error(`expected unavailable, got ${state.phase}`);
    expect(state.reason).toBe('not-installed');
    expect(state.installUrl).not.toBeNull();
  });

  it('does not send a phone to the Web Store', async () => {
    installExtensionlessWindow({
      userAgent: CHROME_ANDROID_UA,
      userAgentData: { brands: CHROMIUM_BRANDS, mobile: true },
    });
    // The id is configured throughout, so a null link here means the phone was
    // refused a link, not that this build has none to give.
    const state = await withInstallId(async () => (await settle()).getSnapshot().state);

    if (state.phase !== 'unavailable') throw new Error(`expected unavailable, got ${state.phase}`);
    expect(state.reason).toBe('unsupported-browser');
    expect(state.canInstall).toBe(false);
    expect(state.installUrl).toBeNull();
  });

  it('does not send Chrome-on-iOS to the Web Store — it is WebKit underneath', async () => {
    installExtensionlessWindow({ userAgent: CHROME_IOS_UA });
    const state = await withInstallId(async () => (await settle()).getSnapshot().state);

    if (state.phase !== 'unavailable') throw new Error(`expected unavailable, got ${state.phase}`);
    expect(state.reason).toBe('unsupported-browser');
    expect(state.installUrl).toBeNull();
  });

  it('tells desktop Safari and Firefox they cannot run it, with no dead link', async () => {
    for (const userAgent of [SAFARI_DESKTOP_UA, FIREFOX_DESKTOP_UA]) {
      resetExtensionBridge();
      installExtensionlessWindow({ userAgent }, false);
      const state = await withInstallId(async () => (await settle()).getSnapshot().state);

      if (state.phase !== 'unavailable') throw new Error(`expected unavailable, got ${state.phase}`);
      expect(state.reason).toBe('unsupported-browser');
      expect(state.canInstall).toBe(false);
      expect(state.installUrl).toBeNull();
      expect(state.message).toContain('Gather app');
    }
  });

  it('trusts a live extension channel over the agent string', async () => {
    // A browser we would not recognise, but something already injected the
    // channel: presence proves this browser hosts extensions, so the funnel
    // must still offer the link rather than deny it.
    installFakeWindow(() => 'error');
    const state = await withInstallId(async () => (await settle()).getSnapshot().state);

    if (state.phase !== 'unavailable') throw new Error(`expected unavailable, got ${state.phase}`);
    expect(state.reason).toBe('not-installed');
    expect(state.installUrl).not.toBeNull();
  });
});

/* ──────────────────────────── the install funnel ───────────────────────── */

describe('forced re-check', () => {
  beforeEach(() => {
    resetExtensionBridge();
  });

  it('flips unavailable -> ready without a reload once the extension appears', async () => {
    let installed = false;
    installFakeWindow((_id, msg) => {
      if (!installed) return 'error';
      return msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION);
    });
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => store.getSnapshot().state.phase === 'unavailable');

    installed = true;
    store.refresh();

    // The funnel must not flash away: the last known phase stays on screen
    // while the re-check runs.
    expect(store.getSnapshot().state.phase).toBe('unavailable');
    expect(store.getSnapshot().checking).toBe(true);

    await waitFor(() => store.getSnapshot().state.phase === 'ready');
    expect(store.getSnapshot().checking).toBe(false);
    await waitFor(() => {
      const s = store.getSnapshot().state;
      return s.phase === 'ready' && s.driving;
    });
    off();
  });

  it('keeps the status stream alive across a forced re-check', async () => {
    // Regression: detectExtension({force:true}) resets the bridge and closes
    // the shared event port. A listener registered before the reset is never
    // reconnected, so the store must re-attach around a forced pass.
    const { ports } = installFakeWindow((_id, msg) =>
      msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION),
    );
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => store.getSnapshot().state.phase === 'ready');
    await waitFor(() => ports.length === 1);

    store.refresh();
    await waitFor(() => ports.length === 2);
    expect(ports[0]?.disconnected).toBe(true);

    ports[1]?.emit({
      channel: PROTOCOL_CHANNEL,
      v: 1,
      event: 'status',
      payload: { ...DRIVING_SESSION, driving: false },
    });

    const state = store.getSnapshot().state;
    if (state.phase !== 'ready') throw new Error(`expected ready, got ${state.phase}`);
    expect(state.driving).toBe(false);
    off();
  });

  it('does not lose a re-check requested while a pass is still in flight', async () => {
    let installed = false;
    installFakeWindow((_id, msg) => {
      if (!installed) return 'error';
      return msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION);
    });
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    installed = true;
    store.refresh(); // queued behind the first pass, which is still running

    await waitFor(() => store.getSnapshot().state.phase === 'ready', 3000);
    off();
  });
});

/* ─────────────────────────────── teardown ──────────────────────────────── */

describe('teardown', () => {
  beforeEach(() => {
    resetExtensionBridge();
  });

  it('unsubscribing during detection never notifies again and never warns', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      installFakeWindow((_id, msg) =>
        msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION),
      );
      configureExtensionBridge({ extensionIds: [EXT_ID] });
      const store = newStore();

      let notified = 0;
      const off = store.subscribe(() => {
        notified += 1;
      });
      // This is exactly what useSyncExternalStore does on unmount, mid-detect.
      off();
      const seen = notified;

      await new Promise((r) => setTimeout(r, 200));
      expect(notified).toBe(seen);
      expect(errors).not.toHaveBeenCalled();
      expect(warns).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      warns.mockRestore();
    }
  });

  it('closes the event port when the last subscriber leaves', async () => {
    const { ports } = installFakeWindow((_id, msg) =>
      msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION),
    );
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    const off = store.subscribe(() => undefined);

    await waitFor(() => store.getSnapshot().state.phase === 'ready');
    await waitFor(() => ports.length === 1);
    expect(ports[0]?.disconnected).toBe(false);

    off();
    expect(ports[0]?.disconnected).toBe(true);

    // No second port is opened behind the scenes once nobody is listening.
    await new Promise((r) => setTimeout(r, 50));
    expect(ports).toHaveLength(1);
  });

  it('stops touching state after dispose', async () => {
    installFakeWindow((_id, msg) =>
      msg['type'] === 'hello' ? helloResponse(msg) : statusResponse(msg, DRIVING_SESSION),
    );
    configureExtensionBridge({ extensionIds: [EXT_ID] });
    const store = newStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.dispose();
    const seen = notified;
    store.refresh();

    await new Promise((r) => setTimeout(r, 200));
    expect(notified).toBe(seen);
    expect(store.getSnapshot().state.phase).toBe('detecting');
  });
});
