// @vitest-environment jsdom
/**
 * <ContextMenu> — the right-click surface that replaced the chat hover bar.
 *
 * This file runs in jsdom (per-file override; the package default is `node`)
 * because every behaviour worth asserting here is an EVENT behaviour: the menu
 * has no markup until a pointer position exists, and its whole job is to close
 * again on the four ways a user can dismiss it. Static markup cannot show any
 * of that.
 *
 * The regression this guards: a menu that opens but does not close is strictly
 * worse than the hover bar it replaced — the hover bar at least went away on
 * its own.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `tsconfig.json` sets `jsx: "preserve"` because Next compiles JSX itself, so
// vitest's esbuild falls back to the CLASSIC runtime and every compiled
// component reaches for a free `React`. Same workaround as
// test/extension-gate.test.ts — delete both the moment vitest.config.ts learns
// `esbuild: { jsx: 'automatic' }`.
(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ContextMenu, ContextMenuItem, useContextMenuTrigger } = await import(
  '@/components/ui/context-menu'
);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Re-asserted per test: react-dom reads this at act() call time, and a
  // module-level assignment alone left it unseen under this jsdom setup.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

/** A message-sized harness: a focusable trigger plus the menu it opens. */
function Harness({ onPick }: { onPick?: () => void }) {
  const { point, close, triggerProps } = useContextMenuTrigger();
  return (
    <div>
      <div {...triggerProps} data-testid="bubble">
        hello
      </div>
      <ContextMenu point={point} onClose={close} label="Message actions">
        <ContextMenuItem onSelect={() => onPick?.()} onClose={close}>
          Reply
        </ContextMenuItem>
      </ContextMenu>
    </div>
  );
}

function menu(): HTMLElement | null {
  return document.querySelector('[role="menu"]');
}

function bubble(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[data-testid="bubble"]');
  if (el === null) throw new Error('harness did not render a trigger');
  return el;
}

function rightClick(el: HTMLElement, x = 120, y = 140): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
}

describe('ContextMenu', () => {
  it('renders nothing until a right-click gives it a position', () => {
    act(() => root.render(<Harness />));
    expect(menu()).toBeNull();

    rightClick(bubble());
    expect(menu()).not.toBeNull();
    expect(menu()?.getAttribute('aria-label')).toBe('Message actions');
  });

  it('suppresses the browser menu so ours is the only one', () => {
    act(() => root.render(<Harness />));
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      bubble().dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('portals out of the trigger so the chat log cannot clip it', () => {
    act(() => root.render(<Harness />));
    rightClick(bubble());
    // Rendered into <body>, NOT inside the harness subtree.
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(menu()?.parentElement).toBe(document.body);
  });

  it('closes on Escape', () => {
    act(() => root.render(<Harness />));
    rightClick(bubble());
    expect(menu()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('closes on a press outside, but not on a press inside', () => {
    act(() => root.render(<Harness />));
    rightClick(bubble());

    const inside = menu()?.querySelector('[role="menuitem"]');
    if (inside == null) throw new Error('menu rendered no items');
    act(() => {
      inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(menu()).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
  });

  it('closes when the log scrolls — a fixed menu would otherwise drift off its message', () => {
    act(() => root.render(<Harness />));
    rightClick(bubble());
    expect(menu()).not.toBeNull();

    // Capture phase: scroll does not bubble, so a scrolling chat log is only
    // observable this way.
    act(() => {
      host.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).toBeNull();
  });

  it('runs the action and closes when an item is chosen', () => {
    const onPick = vi.fn();
    act(() => root.render(<Harness onPick={onPick} />));
    rightClick(bubble());

    const item = menu()?.querySelector<HTMLElement>('[role="menuitem"]');
    act(() => item?.click());

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('clamps into the viewport instead of opening off-screen', () => {
    act(() => root.render(<Harness />));
    // jsdom reports 0 for every offset size, so the clamp resolves to
    // `innerWidth - 0 - margin`. That still proves the branch runs and that a
    // far-corner click is pulled back inside, which is the actual regression.
    rightClick(bubble(), window.innerWidth + 500, window.innerHeight + 500);

    const el = menu();
    if (el === null) throw new Error('menu did not open');
    expect(parseFloat(el.style.left)).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(el.style.top)).toBeLessThanOrEqual(window.innerHeight);
  });

  it('leaves the trigger focusable so the keyboard Menu key has a target', () => {
    act(() => root.render(<Harness />));
    expect(bubble().getAttribute('tabindex')).toBe('0');
    expect(bubble().getAttribute('aria-haspopup')).toBe('menu');
  });
});
