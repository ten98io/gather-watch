// @vitest-environment jsdom
/**
 * The app's error boundaries — the screens nobody is supposed to see.
 *
 * Until these existed, ANY uncaught render throw inside the room tree took
 * the whole page with it: React unmounted to Next's default error screen,
 * which is a blank page in production and a stack trace in development.
 * Neither is a state a person can act on, and neither says what happened.
 *
 * This file runs in jsdom because a boundary is a RUNTIME behaviour — it only
 * exists in the moment a child throws. Static markup of the fallback proves
 * nothing about whether the fallback is ever reached, so `TestBoundary` below
 * mounts the real fallback the same way Next does (as the render of a class
 * boundary that caught) and then makes a child throw for real.
 *
 * The leak assertions are the load-bearing half. `error.message` on a route
 * boundary is whatever the server or a library threw — a raw HTTP body, a DSN
 * in a connection error, an internal path — and `digest` is a build-time hash
 * that means nothing to anyone outside a log search. Both get LOGGED and
 * neither gets RENDERED.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `tsconfig.json` sets `jsx: "preserve"` because Next compiles JSX itself, so
// vitest's esbuild falls back to the CLASSIC runtime and every compiled
// component reaches for a free `React`. Same workaround as
// test/context-menu.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RouteError = (await import('@/app/error')).default;
const GlobalError = (await import('@/app/global-error')).default;
const NotFound = (await import('@/app/not-found')).default;
const RoomError = (await import('@/app/room/[id]/error')).default;

/** Everything a boundary must never repeat back to the person looking at it. */
const SECRET_MESSAGE = 'ECONNREFUSED postgres://gather:hunter2@10.0.0.4:5432/gather';
const DIGEST = '3751840922';
const STACK = 'Error: boom\n    at RoomShell (/app/.next/server/chunks/4821.js:12:9)';

function poisoned(): Error & { digest?: string } {
  const err = new Error(SECRET_MESSAGE) as Error & { digest?: string };
  err.stack = STACK;
  err.digest = DIGEST;
  return err;
}

/** Every fragment of the poisoned error, in one list. */
const LEAKS = [SECRET_MESSAGE, DIGEST, 'ECONNREFUSED', 'hunter2', '5432', '.next/server', 'at RoomShell'];

function expectNoLeak(markup: string): void {
  for (const fragment of LEAKS) {
    expect(markup).not.toContain(fragment);
  }
}

/* ── the real thing: a child that throws, caught by a real boundary ──────── */

type Fallback = React.ComponentType<{ error: Error & { digest?: string }; reset: () => void }>;

/**
 * Stands in for Next's own boundary: catches, then RENDERS `fallback` as an
 * element with the caught error and a `reset` that re-mounts the children.
 *
 * `createElement`, not `fallback({...})` — the boundaries use `useEffect` to
 * log, and calling one as a plain function runs that hook with no owner
 * ("Invalid hook call"). Next mounts it as an element; so does this.
 */
class TestBoundary extends React.Component<
  { fallback: Fallback; children?: React.ReactNode },
  { error: (Error & { digest?: string }) | null }
> {
  override state: { error: (Error & { digest?: string }) | null } = { error: null };

  static getDerivedStateFromError(error: Error & { digest?: string }) {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (error !== null) {
      return React.createElement(this.props.fallback, {
        error,
        reset: () => {
          this.setState({ error: null });
        },
      });
    }
    return this.props.children;
  }
}

let shouldThrow = true;

function Exploding() {
  if (shouldThrow) throw poisoned();
  return <p data-testid="recovered">the room came back</p>;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Re-asserted per test: react-dom reads this at act() call time, and a
  // module-level assignment alone left it unseen under this jsdom setup.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  shouldThrow = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // React re-throws every caught error to console.error; the suite output is
  // not the place to relitigate a deliberate throw.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

function mount(fallback: Fallback): void {
  act(() => {
    root.render(
      <TestBoundary fallback={fallback}>
        <Exploding />
      </TestBoundary>,
    );
  });
}

function click(label: string): void {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('a render that throws', () => {
  it('lands on the route boundary instead of a blank page', () => {
    mount(RouteError as Fallback);
    expect(host.innerHTML).not.toBe('');
    expect(host.querySelector('[data-testid="recovered"]')).toBeNull();
    // A sentence, not a shrug: it has to say something happened.
    expect(host.textContent ?? '').toMatch(/[a-z]{3,}[^]*\./);
    expect((host.textContent ?? '').length).toBeGreaterThan(20);
  });

  it('offers a real way forward, and Retry actually re-renders the tree', () => {
    mount(RouteError as Fallback);
    // A link home is the escape hatch that works even when retry cannot.
    const home = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(home).toContain('/home');

    shouldThrow = false;
    click('Retry');
    expect(host.querySelector('[data-testid="recovered"]')).not.toBeNull();
  });

  it('never leaks the message, the stack or the digest into the markup', () => {
    mount(RouteError as Fallback);
    expectNoLeak(host.innerHTML);
  });

  it('logs the digest instead of rendering it, so a report can still be traced', () => {
    const logged: unknown[][] = [];
    (console.error as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void }).mockImplementation(
      (...args: unknown[]) => {
        logged.push(args);
      },
    );
    mount(RouteError as Fallback);
    const flat = logged.map((args) => args.map((a) => String(a)).join(' ')).join('\n');
    expect(flat).toContain(DIGEST);
    expectNoLeak(host.innerHTML);
  });
});

describe('the room boundary', () => {
  it('catches a throw from inside the room and keeps a way out', () => {
    mount(RoomError as Fallback);
    expect(host.innerHTML).not.toBe('');
    expect(host.querySelector('[data-testid="recovered"]')).toBeNull();
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/home');
    expectNoLeak(host.innerHTML);
  });

  it('says it was the room that broke, not the whole app', () => {
    mount(RoomError as Fallback);
    expect((host.textContent ?? '').toLowerCase()).toContain('room');
  });
});

/* ── the two screens that render without a boundary catching ─────────────── */

describe('the global boundary', () => {
  it('renders its own document, because the root layout is what failed', () => {
    const html = renderToStaticMarkup(
      <GlobalError error={poisoned()} reset={() => {}} />,
    );
    expect(html).toContain('<html');
    expect(html).toContain('<body');
    expectNoLeak(html);
  });

  it('still offers a way forward', () => {
    const html = renderToStaticMarkup(<GlobalError error={poisoned()} reset={() => {}} />);
    expect(html).toMatch(/Retry|Reload|Try again/);
  });
});

describe('not found', () => {
  it('says what happened in one plain sentence and points home', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('/home');
    expect(html).not.toMatch(/404|NEXT_NOT_FOUND/);
    expect(html.replace(/<[^>]+>/g, ' ').trim().length).toBeGreaterThan(20);
  });
});
