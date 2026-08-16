/**
 * <ExtensionGate> — the install funnel that occupies the Stage when this
 * browser cannot play the room's video yet.
 *
 * The suite renders to static markup (`react-dom/server`) rather than to a
 * DOM: this package's vitest runs in the `node` environment with no jsdom and
 * no testing-library, and the component is deliberately hook-free so a string
 * of HTML is enough to assert every piece of user-visible copy. The one thing
 * markup cannot show — that the "check again" control is wired to
 * `onRecheck` — is covered by calling the component as the plain function it
 * is and walking the element tree it returns.
 *
 * The copy assertions are the point of the file: this screen is the whole
 * product for anyone opening a room link without the extension, and the two
 * ways it can fail are silence (a broken player, a spinner) and jargon.
 */
import * as React from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionGateProps, ExtensionGateStatus } from '@/components/extension/ExtensionGate';

// `tsconfig.json` sets `jsx: "preserve"` because Next compiles JSX itself (with
// React's automatic runtime). vitest's esbuild sees `preserve` and falls back
// to the CLASSIC runtime, so every compiled component in this package reaches
// for a free variable `React` at render time. Publishing it on globalThis
// before the component module is evaluated is what makes any .tsx renderable
// here; the dynamic import is only to beat the hoisting of static ones.
// Delete both the moment `vitest.config.ts` learns `esbuild: { jsx: 'automatic' }`.
(globalThis as unknown as { React: typeof React }).React = React;
const { ExtensionGate } = await import('@/components/extension/ExtensionGate');

const INSTALL = 'https://store.example/playin-extension';
const APP = 'https://apps.example/playin';

const ALL_STATUSES: readonly ExtensionGateStatus[] = ['detecting', 'not-installed', 'incompatible'];

/** Conditional spreads, not `...over`: `exactOptionalPropertyTypes` rejects an
 *  explicit `undefined` written over an optional prop. */
function props(over: Partial<ExtensionGateProps> = {}): ExtensionGateProps {
  return {
    status: over.status ?? 'not-installed',
    platform: over.platform ?? 'desktop',
    installUrl: over.installUrl ?? INSTALL,
    appUrl: over.appUrl ?? APP,
    ...(over.onRecheck !== undefined ? { onRecheck: over.onRecheck } : {}),
    ...(over.recheckPending !== undefined ? { recheckPending: over.recheckPending } : {}),
  };
}

function render(over: Partial<ExtensionGateProps> = {}): string {
  return renderToStaticMarkup(React.createElement(ExtensionGate, props(over)));
}

type UnknownElement = ReactElement<Record<string, unknown>>;

function isElement(node: unknown): node is UnknownElement {
  return typeof node === 'object' && node !== null && '$$typeof' in node && 'props' in node;
}

/** Depth-first over whatever a component returned, without rendering it. */
function walk(node: unknown, visit: (el: UnknownElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isElement(node)) return;
  visit(node);
  walk(node.props['children'], visit);
}

describe('ExtensionGate — the extension is missing', () => {
  it('names the thing to add and offers one way to add it', () => {
    const html = render({ status: 'not-installed' });
    expect(html).toContain('Add the Playin extension to watch together');
    expect(html).toContain('keeps everyone on the same second');
    expect(html).toContain('Add the extension');
    expect(html).toContain(`href="${INSTALL}"`);
  });

  it('leaves the room and never the store as the place you lose', () => {
    const html = render({ status: 'not-installed' });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('(opens in a new tab)');
  });
});

describe('ExtensionGate — the extension is too old', () => {
  it('asks for an update, not an install', () => {
    const html = render({ status: 'incompatible' });
    expect(html).toContain('Update the Playin extension');
    expect(html).toContain('older than this room needs');
    expect(html).toContain('Update the extension');
    expect(html).toContain(`href="${INSTALL}"`);
    expect(html).not.toContain('Add the extension');
  });
});

describe('ExtensionGate — still checking', () => {
  it('says so calmly and asks for nothing', () => {
    const html = render({ status: 'detecting' });
    expect(html).toContain('Looking for the Playin extension');
    expect(html).toContain('This takes a second.');
    expect(html).toContain('aria-busy="true"');
  });

  it('offers no action while there is nothing to act on', () => {
    const html = render({ status: 'detecting', onRecheck: () => undefined });
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('check again');
  });

  it('is not busy once the answer is in', () => {
    expect(render({ status: 'not-installed' })).toContain('aria-busy="false"');
  });
});

describe('ExtensionGate — phones', () => {
  it('routes to the app instead of an install it cannot satisfy', () => {
    for (const status of ALL_STATUSES) {
      const html = render({ platform: 'mobile', status });
      expect(html).toContain('Watch together in the Playin app');
      expect(html).toContain('Get the Playin app');
      expect(html).toContain(`href="${APP}"`);
      expect(html).not.toContain(INSTALL);
      expect(html).not.toContain('Add the extension');
    }
  });

  it('never spins on a phone, whatever detection reports', () => {
    expect(render({ platform: 'mobile', status: 'detecting' })).toContain('aria-busy="false"');
  });

  it('offers no re-check, because no extension will ever appear', () => {
    const html = render({ platform: 'mobile', onRecheck: () => undefined });
    expect(html).not.toContain('check again');
  });
});

describe('ExtensionGate — the rest of the room', () => {
  it('says what still works in every state, on both platforms', () => {
    for (const platform of ['desktop', 'mobile'] as const) {
      for (const status of ALL_STATUSES) {
        expect(render({ platform, status })).toContain(
          'Chat, voice and the queue are working already',
        );
      }
    }
  });

  it('never implies the room itself is unavailable', () => {
    for (const status of ALL_STATUSES) {
      const html = render({ status }).toLowerCase();
      for (const forbidden of ['unavailable', 'not supported', 'unsupported', 'error']) {
        expect(html).not.toContain(forbidden);
      }
    }
  });
});

describe('ExtensionGate — plain language', () => {
  it('leaks none of the machinery into the copy', () => {
    const jargon = [
      'mv3',
      'manifest',
      'protocol',
      'desktopcapture',
      'chrome.runtime',
      'not_installed',
      'unsupported_version',
      'bridge',
      'undefined',
    ];
    for (const platform of ['desktop', 'mobile'] as const) {
      for (const status of ALL_STATUSES) {
        const html = render({ platform, status }).toLowerCase();
        for (const word of jargon) expect(html).not.toContain(word);
      }
    }
  });
});

describe('ExtensionGate — re-checking after an install', () => {
  it('shows the control only when the caller can act on it', () => {
    expect(render({ status: 'not-installed' })).not.toContain('check again');
    expect(render({ status: 'not-installed', onRecheck: () => undefined })).toContain(
      'I added it — check again',
    );
    expect(render({ status: 'incompatible', onRecheck: () => undefined })).toContain(
      'I updated it — check again',
    );
  });

  it('is a real button and reports that it is working', () => {
    const html = render({
      status: 'not-installed',
      onRecheck: () => undefined,
      recheckPending: true,
    });
    expect(html).toContain('<button');
    expect(html).toContain('disabled');
    expect(html).toContain('Checking…');
  });

  it('calls onRecheck, and is the only handler on the surface', () => {
    const onRecheck = vi.fn();
    const handlers: Array<() => void> = [];
    walk(ExtensionGate(props({ status: 'not-installed', onRecheck })), (el) => {
      const onClick = el.props['onClick'];
      if (typeof onClick === 'function') handlers.push(onClick as () => void);
    });
    expect(handlers).toHaveLength(1);
    handlers[0]?.();
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});

describe('ExtensionGate — accessibility', () => {
  it('is a named, politely announced region', () => {
    const html = render({ status: 'not-installed' });
    expect(html).toContain('<section');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Add the Playin extension to watch together"');
  });

  it('uses a link for a destination and a button for an action', () => {
    const html = render({ status: 'not-installed', onRecheck: () => undefined });
    // A link inside a button (or the reverse) would be two focus stops for one
    // control; the store action is an <a>, the re-check is a <button>.
    expect(html).not.toMatch(/<a[^>]*>[^<]*<button/);
    expect(html).not.toMatch(/<button[^>]*>[^<]*<a\s/);
    expect(html).toMatch(/<a[^>]+href="https:\/\/store\.example[^"]*"/);
    expect(html).toContain('type="button"');
  });
});
