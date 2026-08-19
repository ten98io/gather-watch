// @vitest-environment jsdom
/**
 * AN INVITE THAT SURVIVES SIGNING IN.
 *
 * The invite link is how most people meet Gather, and until now the join
 * screen offered a signed-out visitor exactly ONE identity: a throwaway,
 * room-scoped guest. Someone who already had an account either took a second
 * identity under their own name or navigated away to sign in — and /auth/verify
 * ended every sign-in at /home, so the code they arrived with was simply gone.
 * The flow was never broken in a way a test could see, because no test walked
 * further than one screen.
 *
 * This file walks the whole hop: the invitation offers a way to sign in that
 * names where to come back to, /login stores it (the magic link's URL is minted
 * by the server — `${appUrl}/auth/verify?token=…` — so it cannot ride along in
 * the mail), and /auth/verify spends it.
 *
 * ── The half that is a security test ──────────────────────────────────────
 * A stored redirect that runs IMMEDIATELY AFTER authentication is the single
 * worst place in a product to be sloppy: a link that signs someone in and then
 * hands them to another origin is a credential phish wearing our own domain.
 * The stored value is writable by anything on the origin and outlives the tab
 * that wrote it, so `safeAfterSignIn` is asserted on the way OUT of storage as
 * well as on the way in — including against a value this file plants directly,
 * the way a stored-XSS payload would.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteCode } from '@gather/contracts';

// `tsconfig.json` sets `jsx: "preserve"` because Next compiles JSX itself, so
// vitest's esbuild falls back to the CLASSIC runtime and every compiled
// component reaches for a free `React`. Same workaround as
// test/error-boundary.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom ships `sessionStorage` here and NOT `localStorage`: Node 22 defines its
 * own experimental `localStorage` global, which is inert without
 * `--localstorage-file` and shadows jsdom's. So the API the browser really has
 * is restored rather than worked around — lib/after-signin.ts stores across
 * tabs by requirement (a mail client opens the link in a new one), and a test
 * that quietly swapped in `sessionStorage` would be testing a different
 * mechanism than the one that ships.
 */
function installLocalStorage(): void {
  if (typeof window.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => {
        map.clear();
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
}
installLocalStorage();

const CODE = 'ABCD2345' as InviteCode;
const INVITE_PATH = `/join/${CODE}`;
/** What a `?next=` pointing at this invitation looks like on the wire. */
const BACK_HERE = `/login?next=${encodeURIComponent(INVITE_PATH)}`;

const nav = vi.hoisted(() => ({ replaced: [] as string[], search: '' }));
const apiStub = vi.hoisted(() => ({ verify: vi.fn() }));
const authStub = vi.hoisted(() => ({ user: null as unknown, isGuest: false }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => {
      nav.replaced.push(href);
    },
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: authStub.user,
    loading: false,
    isGuest: authStub.isGuest,
    setUser: () => undefined,
    refresh: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
  }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    rooms: {
      listMyRooms: () => Promise.resolve({ rooms: [] }),
      joinRoom: () => Promise.resolve({}),
    },
  },
  guestJoin: () => Promise.resolve({}),
  verifyToken: (token: string) => apiStub.verify(token),
}));

const { JoinClient } = await import('@/app/join/[code]/join-client');
const VerifyPage = (await import('@/app/auth/verify/page')).default;
const { DEFAULT_AFTER_SIGNIN, rememberAfterSignIn, safeAfterSignIn, takeAfterSignIn } =
  await import('@/lib/after-signin');

/** The key lib/after-signin.ts writes. Duplicated ON PURPOSE — the point of
 *  the last test is to write it from OUTSIDE the module, as any other script on
 *  the origin could. */
const STORAGE_KEY = 'gather:after-signin';

let host: HTMLDivElement;
let root: Root;

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

const anchor = (match: string): HTMLAnchorElement | undefined =>
  [...host.querySelectorAll('a')].find((a) => (a.textContent ?? '').includes(match));

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  nav.replaced = [];
  nav.search = '';
  authStub.user = null;
  authStub.isGuest = false;
  apiStub.verify = vi.fn(() => Promise.resolve({ user: { id: 'u1' } }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

async function mount(el: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await settle();
}

describe('safeAfterSignIn', () => {
  it('admits a same-origin path', () => {
    expect(safeAfterSignIn(INVITE_PATH)).toBe(INVITE_PATH);
  });

  it('refuses every shape that leaves the origin', () => {
    // `//host` and `/\host` both start with a slash and are both absolute:
    // the first is protocol-relative, the second is normalised into it.
    const hostile = [
      'https://evil.example/x',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'join/ABCD2345',
      '',
    ];
    for (const value of hostile) {
      expect(safeAfterSignIn(value), value).toBeNull();
    }
  });
});

describe('the remembered destination', () => {
  it('is consumed, not merely read', () => {
    rememberAfterSignIn(INVITE_PATH);
    expect(takeAfterSignIn()).toBe(INVITE_PATH);
    // A destination describes ONE journey. Left behind, it would divert the
    // next unrelated sign-in on this device.
    expect(takeAfterSignIn()).toBe(DEFAULT_AFTER_SIGNIN);
  });

  it('never stores a destination it would refuse to navigate to', () => {
    rememberAfterSignIn('//evil.example');
    expect(takeAfterSignIn()).toBe(DEFAULT_AFTER_SIGNIN);
  });

  it('re-validates on read, because anything on the origin can write storage', () => {
    window.localStorage.setItem(STORAGE_KEY, 'https://evil.example/sign-in');
    expect(takeAfterSignIn()).toBe(DEFAULT_AFTER_SIGNIN);
  });

  it('clears a stale one when a plain sign-in is started', () => {
    rememberAfterSignIn(INVITE_PATH);
    rememberAfterSignIn(null);
    expect(takeAfterSignIn()).toBe(DEFAULT_AFTER_SIGNIN);
  });
});

describe('the invitation', () => {
  it('offers an account holder a way to sign in that names this invitation', async () => {
    await mount(<JoinClient code={CODE} />);

    const signIn = anchor('Sign in instead');
    expect(signIn).toBeDefined();
    expect(signIn?.getAttribute('href')).toBe(BACK_HERE);
  });

  it('offers it to a guest too — it is the only escape from losing that identity', async () => {
    authStub.user = { id: 'g1', email: null, displayName: 'Wanderer' };
    authStub.isGuest = true;

    await mount(<JoinClient code={CODE} />);

    expect(anchor('Sign in instead')?.getAttribute('href')).toBe(BACK_HERE);
  });

  it('keeps the one primary action a button and the alternative a link', async () => {
    await mount(<JoinClient code={CODE} />);

    // §8: one primary per screen region. A second aurora beside "Join as
    // guest" would make both read as "a button" rather than as the action.
    expect(host.innerHTML.match(/aurora-gradient/g) ?? []).toHaveLength(1);
  });
});

describe('the magic link, opened', () => {
  it('lands on the invitation the sign-in started from', async () => {
    rememberAfterSignIn(INVITE_PATH);
    nav.search = 'token=t0k3n';

    await mount(<VerifyPage />);

    expect(apiStub.verify).toHaveBeenCalledWith('t0k3n');
    expect(nav.replaced).toContain(INVITE_PATH);
  });

  it('lands home when the sign-in started nowhere in particular', async () => {
    nav.search = 'token=t0k3n';

    await mount(<VerifyPage />);

    expect(nav.replaced).toContain(DEFAULT_AFTER_SIGNIN);
  });

  it('never follows a destination pointing off the origin', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'https://evil.example/harvest');
    nav.search = 'token=t0k3n';

    await mount(<VerifyPage />);

    expect(nav.replaced).toEqual([DEFAULT_AFTER_SIGNIN]);
  });

  it('carries the destination forward when the link is spent', async () => {
    // The retry goes to /login with no `?next=` of its own, and /login clears
    // storage on every fresh request — so if this href dropped the destination
    // the second link would silently land at /home after all.
    rememberAfterSignIn(INVITE_PATH);
    nav.search = 'token=expired';
    apiStub.verify = vi.fn(() => Promise.reject(new Error('gone')));

    await mount(<VerifyPage />);

    expect(anchor('Send me a new link')?.getAttribute('href')).toBe(BACK_HERE);
    expect(nav.replaced).toHaveLength(0);
  });

  it('says a link expired without saying 404, and offers the one way forward', async () => {
    nav.search = '';

    await mount(<VerifyPage />);

    expect(host.textContent ?? '').toContain('expire');
    expect(anchor('Send me a new link')?.getAttribute('href')).toBe('/login');
  });

  /**
   * The same four zeroes test/entry-surface-budgets.test.tsx holds the other
   * entry surfaces to. This screen is not in that file because it needs a
   * `useSearchParams` mock, and it is the screen that most needed the check:
   * it shipped `glass-panel` with `shadow-glow` — glass with no video under it
   * (§4) and glow outside a signature moment (§5) — on the one surface a
   * person passes through with a live credential in hand.
   */
  it('spends one display step and none of the reserved effects', async () => {
    nav.search = 'token=expired';
    apiStub.verify = vi.fn(() => Promise.reject(new Error('gone')));

    await mount(<VerifyPage />);

    const html = host.innerHTML;
    expect(html.match(/text-display/g) ?? []).toHaveLength(1);
    expect(html.match(/glass-panel|glass-raised/g) ?? []).toHaveLength(0);
    expect(html.match(/shadow-glow/g) ?? []).toHaveLength(0);
    expect(html.match(/text-aurora-|text-accent[\s"]/g) ?? []).toHaveLength(0);
  });
});
