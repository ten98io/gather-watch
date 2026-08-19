import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom ships no matchMedia; useReducedMotion / useTheme both read it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }),
});

const state = vi.hoisted(() => ({ rooms: [] as unknown[], pending: false, error: false }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.test', displayName: 'Ada', avatarUrl: null, accentColor: '#7c5cfc', createdAt: 1 },
    loading: false, isGuest: false, setUser() {}, refresh: () => Promise.resolve(null), logout: () => Promise.resolve(),
  }),
}));
vi.mock('@/lib/api', () => ({
  api: { rooms: { listMyRooms: () => Promise.resolve({ rooms: [] }) }, auth: { updateProfile: () => Promise.resolve({}) } },
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
  usePushNotifications: () => ({ state: 'off', busy: false, enable: () => Promise.resolve('off'), disable: () => Promise.resolve() }),
  unsubscribeFromPush: () => Promise.resolve(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { error() {}, success() {} } }));

const RootPage = (await import('@/app/page')).default;
const LoginPage = (await import('@/app/login/page')).default;
const HomePage = (await import('@/app/home/page')).default;
const SettingsPage = (await import('@/app/settings/page')).default;
const LegalLayout = (await import('@/app/legal/layout')).default;

function render(el: React.ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(el); });
  return host;
}

/** DESIGN.md §3: `text-display` at most once per screen, and §2: at most one
 *  aurora gradient per screen REGION (the brand mark + one primary is two
 *  regions; two primaries in a row is not). */
function counts(host: HTMLDivElement) {
  const html = host.innerHTML;
  return {
    display: (html.match(/text-display/g) ?? []).length,
    hero: (html.match(/text-hero/g) ?? []).length,
    gradient: (html.match(/aurora-gradient/g) ?? []).length,
    glow: (html.match(/shadow-glow/g) ?? []).length,
    glass: (html.match(/glass-panel|glass-raised/g) ?? []).length,
    accentText: (html.match(/text-aurora-|text-accent[" ]/g) ?? []).length,
  };
}

const ROOM = { room: { id: 'r1', name: 'Friday premieres' }, unreadCount: 4, memberCount: 3, muted: true };

describe('entry surfaces render and obey the ramp budgets', () => {
  it('/ — one hero, no display, one gradient (the primary; the mark is an <svg> gradient)', () => {
    const c = counts(render(<RootPage />));
    expect(c.hero).toBe(1);
    expect(c.display).toBe(0);
    expect(c.gradient).toBe(1);
    expect(c.glow + c.glass + c.accentText).toBe(0);
  });

  it('/login — one display, one gradient', () => {
    const c = counts(render(<LoginPage />));
    expect(c.display).toBe(1);
    expect(c.hero).toBe(0);
    expect(c.gradient).toBe(1);
    expect(c.glow + c.glass + c.accentText).toBe(0);
  });

  it('/home empty — the poster carries the only display and the only primary', () => {
    state.rooms = []; state.pending = false; state.error = false;
    const host = render(<HomePage />);
    const c = counts(host);
    expect(c.display).toBe(1);
    expect(c.gradient).toBe(1);
    expect(host.textContent).toContain('The void is quiet');
    expect(c.glow + c.glass + c.accentText).toBe(0);
  });

  it('/home populated — masthead carries the display; cards carry no gradient', () => {
    state.rooms = [ROOM, { ...ROOM, room: { id: 'r2', name: 'Sunday' }, unreadCount: 0, muted: false }];
    const host = render(<HomePage />);
    const c = counts(host);
    expect(c.display).toBe(1);
    expect(c.gradient).toBe(1);
    expect(host.textContent).toContain('Friday premieres');
    expect(host.textContent).toContain('2 rooms');
    expect(c.glow + c.glass + c.accentText).toBe(0);
  });

  it('/home loading — a masthead and skeletons, never a spinner', () => {
    state.pending = true;
    const host = render(<HomePage />);
    expect(counts(host).display).toBe(1);
    expect(host.querySelectorAll('.skeleton-shimmer').length).toBe(3);
    state.pending = false;
  });

  it('/settings — one display, sections on the solid ladder', () => {
    const c = counts(render(<SettingsPage />));
    expect(c.display).toBe(1);
    expect(c.glass + c.glow + c.accentText).toBe(0);
  });

  it('/legal — the document title is the display step', () => {
    const host = render(<LegalLayout><h1>Terms of Service</h1><p>Body.</p></LegalLayout>);
    expect(counts(host).display).toBe(1);
    expect(host.textContent).toContain('Terms of Service');
  });
});
