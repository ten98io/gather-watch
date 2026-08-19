// @vitest-environment jsdom
/**
 * THE BUDGETS DESIGN.md WRITES DOWN AND NOTHING MEASURED.
 *
 * `packages/design/test/palette.test.ts` walks token PAIRS — it proves the
 * palette is legible and it never reads a Tailwind class string, so every rule
 * that is about WHERE a token may be spent has been enforced by memory alone.
 * That is not a hypothetical gap: three call sites shipped `hover:text-accent`
 * and `text-accent-ink` against §2 and stayed there long enough to be written
 * into DESIGN.md as known debt, and two more (`text-aurora-1` on the login dev
 * link and on the join screen's invite code) were never catalogued at all.
 *
 * This file measures the four that are countable, on the screens a person
 * meets before the room:
 *
 *   §3  `text-display` at most ONCE per screen, and it must be what the screen
 *       is about. `text-hero` is auth/marketing only, at most once per page.
 *   §2  the aurora gradient has a budget of three PLACES product-wide and at
 *       most one per screen region. `.aurora-gradient` is the class that paints
 *       it; the brand mark paints its own inside an <svg>, so a screen carrying
 *       a wordmark and one primary action reads as exactly one here.
 *   §4  glass is reserved for surfaces floating over moving video. An entry
 *       surface has no video on it, so the count is zero.
 *   §5  glow is a signature moment. Also zero.
 *
 * Deliberately NOT: an opinion on whether the composition is any good. It
 * counts what the rules count and nothing else — a test that asserted the
 * layout would fail on every deliberate change and get deleted.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// `tsconfig.json` sets `jsx: "preserve"` because Next compiles JSX itself, so
// vitest's esbuild falls back to the CLASSIC runtime and every compiled
// component reaches for a free `React`. Same workaround as
// test/error-boundary.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia; useReducedMotion and useTheme both read it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});

/** What the mocked `useQuery` answers with, per test. */
const state = vi.hoisted(() => ({ rooms: [] as unknown[], pending: false, error: false }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'ada@example.test',
      displayName: 'Ada',
      avatarUrl: null,
      accentColor: '#7c5cfc',
      createdAt: 1,
    },
    loading: false,
    isGuest: false,
    setUser() {},
    refresh: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
  }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    rooms: { listMyRooms: () => Promise.resolve({ rooms: [] }) },
    auth: { updateProfile: () => Promise.resolve({}) },
  },
  apiFetch: () => Promise.resolve({}),
  requestMagicLink: () => Promise.resolve({ devLink: null }),
  guestJoin: () => Promise.resolve({}),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve(), clear() {} }),
  useQuery: () => ({
    isPending: state.pending,
    isError: state.error,
    isSuccess: !state.pending && !state.error,
    data: { rooms: state.rooms, sessions: [] },
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock('@/hooks/useServiceWorker', () => ({
  usePushNotifications: () => ({
    state: 'off',
    busy: false,
    enable: () => Promise.resolve('off'),
    disable: () => Promise.resolve(),
  }),
  unsubscribeFromPush: () => Promise.resolve(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { error() {}, success() {} } }));

const RootPage = (await import('@/app/page')).default;
const LoginPage = (await import('@/app/login/page')).default;
const HomePage = (await import('@/app/home/page')).default;
const SettingsPage = (await import('@/app/settings/page')).default;
const LegalLayout = (await import('@/app/legal/layout')).default;

/** Rendered rather than statically inspected: half of these screens choose
 *  their composition from query state, and a source grep cannot tell the empty
 *  branch's display setting from the populated branch's. */
function render(el: React.ReactElement): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(el);
  });
  return { host, root };
}

interface Budgets {
  display: number;
  hero: number;
  gradient: number;
  glow: number;
  glass: number;
  accentAsText: number;
}

function budgets(host: HTMLDivElement): Budgets {
  const html = host.innerHTML;
  const count = (re: RegExp): number => (html.match(re) ?? []).length;
  return {
    display: count(/text-display/g),
    hero: count(/text-hero/g),
    gradient: count(/aurora-gradient/g),
    glow: count(/shadow-glow/g),
    glass: count(/glass-panel|glass-raised/g),
    // `text-aurora-*` and `text-accent` are the two shapes §2 forbids: on
    // Daylight the accent clears the 3:1 non-text bar and not the 4.5:1 text
    // bar, so either one is a failing colour on half the product.
    accentAsText: count(/text-aurora-|text-accent[\s"]/g),
  };
}

/** Every entry surface owes the same four zeroes. */
function expectNoReservedEffects(b: Budgets): void {
  expect(b.glass, 'glass on a surface with no video under it (§4)').toBe(0);
  expect(b.glow, 'glow outside a signature moment (§5)').toBe(0);
  expect(b.accentAsText, '--accent used as a text colour (§2)').toBe(0);
}

const room = (id: string, name: string, unreadCount: number, muted: boolean) => ({
  room: { id, name },
  unreadCount,
  memberCount: 3,
  muted,
});

describe('the surfaces before the room', () => {
  it('/ opens on the one hero in the product and spends no display step', () => {
    const { host, root } = render(<RootPage />);
    const b = budgets(host);
    expect(b.hero).toBe(1);
    expect(b.display).toBe(0);
    // The header's brand mark and the hero's primary action are two regions.
    expect(b.gradient).toBe(1);
    expectNoReservedEffects(b);
    act(() => {
      root.unmount();
    });
  });

  it('/login states itself at display size and keeps the hero for the front door', () => {
    const { host, root } = render(<LoginPage />);
    const b = budgets(host);
    expect(b.display).toBe(1);
    expect(b.hero).toBe(0);
    expect(b.gradient).toBe(1);
    expectNoReservedEffects(b);
    act(() => {
      root.unmount();
    });
  });

  it('an empty /home is a poster, and it carries the screen’s only primary', () => {
    state.rooms = [];
    state.pending = false;
    state.error = false;
    const { host, root } = render(<HomePage />);
    const b = budgets(host);
    // The masthead is NOT rendered in this branch, exactly so that the poster
    // can hold the display step and the one aurora without repeating the CTA.
    expect(b.display).toBe(1);
    expect(b.gradient).toBe(1);
    expect(host.textContent).toContain('The void is quiet');
    expectNoReservedEffects(b);
    act(() => {
      root.unmount();
    });
  });

  it('a populated /home moves the display step to the masthead, not onto the cards', () => {
    state.rooms = [room('r1', 'Friday premieres', 4, true), room('r2', 'Sunday matinee', 0, false)];
    const { host, root } = render(<HomePage />);
    const b = budgets(host);
    expect(b.display).toBe(1);
    expect(b.gradient).toBe(1);
    expect(host.textContent).toContain('Friday premieres');
    expect(host.textContent).toContain('2 rooms');
    expectNoReservedEffects(b);
    act(() => {
      root.unmount();
    });
  });

  it('/home while loading shows the masthead and skeletons, never a spinner (§10)', () => {
    state.pending = true;
    const { host, root } = render(<HomePage />);
    expect(budgets(host).display).toBe(1);
    expect(host.querySelectorAll('.skeleton-shimmer')).toHaveLength(3);
    state.pending = false;
    act(() => {
      root.unmount();
    });
  });

  it('/settings names itself once and sits on the solid ladder', () => {
    const { host, root } = render(<SettingsPage />);
    const b = budgets(host);
    expect(b.display).toBe(1);
    expectNoReservedEffects(b);
    act(() => {
      root.unmount();
    });
  });

  it('a legal page spends its display step on the document title', () => {
    const { host, root } = render(
      <LegalLayout>
        <h1>Terms of Service</h1>
        <p>Body.</p>
      </LegalLayout>,
    );
    expect(budgets(host).display).toBe(1);
    expect(host.textContent).toContain('Terms of Service');
    act(() => {
      root.unmount();
    });
  });
});
