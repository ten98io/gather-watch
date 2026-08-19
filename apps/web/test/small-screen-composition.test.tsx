// @vitest-environment jsdom
/**
 * THE SMALL END OF THE VIEWPORT, AS ASSERTIONS.
 *
 * The re-composition raised type and spacing for a ~1440px canvas and the app
 * has essentially one breakpoint, so everything below 768 was inheriting
 * desktop numbers. Four of those had a measurable failure at 375×812, and each
 * one is a class pair rather than a layout — which is the only part a test in
 * this package can hold. A layout is not assertable here; a breakpoint class
 * is, and the class is what someone deletes.
 *
 * Measured on the running app before the fix, so the numbers below are
 * observations and not estimates:
 *
 *  · the masthead's caption line had 171px for ~250px of content and came down
 *    as "LIVE · HOST" over "· JMBT-MEP3-BKNB" — a separator leading a line;
 *  · the room settings dialog was 1171px tall, centred in a fixed 812px box,
 *    so 359px of it — its own title, and every destructive action — was off
 *    screen with nothing to scroll;
 *  · the queue's signature empty state was a 380px poster in a 252px port, so
 *    an EMPTY list arrived already scrolled with its plate above the origin;
 *  · the seek scrubber was 32px of hit area on a device that drags it.
 *
 * What is deliberately NOT asserted: pixels. `md:` is the boundary the whole
 * app already uses (`useMediaQuery('(min-width: 768px)')` in room-shell), and
 * a test that re-derived the widths would only be a second copy of Tailwind.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MediaRef, Member, Room } from '@gather/contracts';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia; useReducedMotion and useMediaQuery both read it.
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));

const { h, makeMember, makeRoom, playbackFor, queueItem, renderInRoom } = await import(
  './helpers/room-render'
);
const { RoomLayout } = await import('@/app/room/[id]/room-shell');
const { Dialog, DialogContent } = await import('@/components/ui/dialog');
const { Sheet, SheetContent } = await import('@/components/ui/sheet');
const { EmptyState } = await import('@/components/ui/empty-state');
const { Slider } = await import('@/components/ui/slider');
const { OrbitIcon } = await import('@/components/ui/icons');

const YT_REF: MediaRef = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

/** The server pass takes the mobile branch — `useMediaQuery` is false there —
 *  which is exactly the composition these cases are about. */
function renderLayout(room: Room, member: Member, mediaRef: MediaRef | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const items = mediaRef === null ? [] : [queueItem(mediaRef, 'Current item')];
  return renderInRoom(
    room,
    member,
    {
      playback: mediaRef === null ? null : playbackFor(mediaRef, 0),
      queue: { items, version: 1 },
    },
    h(QueryClientProvider, { client }, h(RoomLayout, { roomId: room.id })),
  );
}

/** The `class="…"` of the element carrying `marker`, from static markup. */
function classOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at, `no element carrying ${marker}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<', at);
  const tag = html.slice(open, html.indexOf('>', at) + 1);
  return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
}

describe('the room masthead is a composition below md, not a squeezed row', () => {
  const host = makeMember('host');

  it('gives the name and its caption line a row of their own', () => {
    const html = renderLayout(makeRoom('watch'), host, YT_REF);
    // `basis-full` is the wrap; `md:basis-0 md:grow` is the desktop row it
    // came from. Both, or the column is full width at every size.
    expect(html).toContain('basis-full md:order-none md:basis-0 md:grow');
  });

  it('puts the phone’s route to the rail in the toolbar row, not under it', () => {
    const html = renderLayout(makeRoom('watch'), host, YT_REF);
    // order-1 back arrow, order-2 this, order-3 the room controls, order-4 the
    // identity block: without the orders the identity block's `basis-full`
    // strands the controls on a third row of their own.
    expect(classOf(html, 'Chat &amp; queue')).toContain('order-2 grow md:order-none md:grow-0');
    expect(html).toContain('order-3 ml-auto');
  });

  it('holds the theater toggle to a touch target when its label is gone', () => {
    // Icon-only below `md`, and the control tokens raise only the HEIGHT on a
    // coarse pointer — so this one is 40px wide without the min-width.
    expect(classOf(renderLayout(makeRoom('watch'), host, YT_REF), 'Turn theater mode on')).toContain(
      'min-w-ctl-md',
    );
  });
});

describe('modals and sheets on a phone', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('caps a dialog at the viewport and scrolls the overflow inside it', () => {
    act(() => {
      root.render(
        h(Dialog, {
          open: true,
          onOpenChange: () => {},
          children: h(DialogContent, { 'aria-label': 'Tall', children: 'body' }),
        }),
      );
    });
    const panel = document.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    const cls = panel?.getAttribute('class') ?? '';
    // The cap is the wrapper's own `p-4` on each side, so the panel still
    // floats — what moves inside is the overflow.
    expect(cls).toContain('max-h-[calc(100dvh-2rem)]');
    expect(cls).toContain('overflow-y-auto');
  });

  it('spends the sheet’s height on the panel, not on a scrimmed stage', () => {
    act(() => {
      root.render(
        h(Sheet, {
          open: true,
          onOpenChange: () => {},
          children: h(SheetContent, { 'aria-label': 'Panes', children: 'body' }),
        }),
      );
    });
    const cls = document.querySelector('[role="dialog"]')?.getAttribute('class') ?? '';
    // A DEFINITE height (the panes inside need one), and one large enough for
    // the dock, the tab bar, a pane header and a signature empty state at once.
    expect(cls).toContain('h-[86dvh]');
    expect(cls).not.toContain('max-h-');
  });
});

describe('the composition rungs halve below md', () => {
  it('does not spend 128px of a phone pane on an empty list’s padding', () => {
    const html = renderToStaticMarkup(
      h(EmptyState, {
        variant: 'signature',
        icon: h(OrbitIcon, { size: 24 }),
        title: 'Nothing here',
      }),
    );
    // `section` 64 → `xxl` 32, another rung of the same ramp — and the desktop
    // rail keeps the rung it was drawn for.
    expect(classOf(html, 'min-h-full')).toContain('py-8 md:py-section');
  });
});

describe('a scrubber is a control a finger drags', () => {
  it('takes its hit area from the control token, not a flat step', () => {
    const html = renderToStaticMarkup(
      h(Slider, { value: 0, onValueChange: () => {}, 'aria-label': 'Seek' }),
    );
    // 32 under a mouse, 44 under a finger. The track is 4px drawn centred, so
    // the height is pure hit area and a flat `h-6` shipped 24px to both.
    expect(classOf(html, 'slider-aurora')).toContain('h-ctl-md');
  });
});
