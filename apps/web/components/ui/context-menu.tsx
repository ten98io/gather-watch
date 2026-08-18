'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * Cursor-anchored menu — the right-click surface.
 *
 * Distinct from <DropdownMenu>, which is anchored to a trigger element with
 * `position: absolute`. A context menu opens at a POINT, so it is fixed-
 * positioned and portalled to <body>: the chat log is an overflow-scroll
 * region, and an in-tree menu would be clipped by it near the edges.
 *
 * Input parity is the whole point of the primitive — a right-click-only
 * affordance is unreachable for two of the three input modes:
 *   - pointer:  contextmenu event
 *   - touch:    long-press (see useContextMenuTrigger); touch devices have no
 *               right button and never fire contextmenu on their own
 *   - keyboard: the Menu key / Shift+F10 fire `contextmenu` on the FOCUSED
 *               element, so the opener must be focusable for this to work
 */

/** Viewport point the menu opens at. */
export interface MenuPoint {
  x: number;
  y: number;
}

/** Gap kept between the menu and the viewport edge when clamping. */
const VIEWPORT_MARGIN = 8;
/** Press duration that counts as a long-press on touch. */
const LONG_PRESS_MS = 500;
/** Finger travel that cancels a long-press (a scroll, not a press). */
const LONG_PRESS_SLOP_PX = 10;

/**
 * Wires an element for all three ways a context menu can be summoned.
 * Spread `triggerProps` onto the element; it must be focusable for the
 * keyboard Menu key to reach it, so `tabIndex` is included.
 */
export function useContextMenuTrigger(): {
  point: MenuPoint | null;
  close(): void;
  triggerProps: {
    tabIndex: number;
    'aria-haspopup': 'menu';
    onContextMenu(e: { preventDefault(): void; clientX: number; clientY: number }): void;
    onPointerDown(e: ReactPointerEvent): void;
    onPointerUp(): void;
    onPointerMove(e: ReactPointerEvent): void;
    onPointerCancel(): void;
  };
} {
  const [point, setPoint] = useState<MenuPoint | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<MenuPoint | null>(null);

  const clearPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressOrigin.current = null;
  }, []);

  // A pending long-press must not outlive the component (unmount mid-press).
  useEffect(() => clearPress, [clearPress]);

  const close = useCallback(() => {
    setPoint(null);
  }, []);

  return {
    point,
    close,
    triggerProps: {
      tabIndex: 0,
      'aria-haspopup': 'menu',
      onContextMenu: (e) => {
        e.preventDefault();
        // Keyboard-summoned menus report (0,0) in some engines; anchoring
        // there would pin the menu to the screen corner, far from the
        // message it belongs to. Callers clamp, but a 0,0 origin is still
        // wrong enough to be worth treating as "no pointer position".
        setPoint({ x: e.clientX, y: e.clientY });
      },
      onPointerDown: (e) => {
        if (e.pointerType !== 'touch') return;
        pressOrigin.current = { x: e.clientX, y: e.clientY };
        const { clientX, clientY } = e;
        pressTimer.current = setTimeout(() => {
          pressTimer.current = null;
          setPoint({ x: clientX, y: clientY });
        }, LONG_PRESS_MS);
      },
      onPointerUp: clearPress,
      onPointerCancel: clearPress,
      onPointerMove: (e) => {
        const origin = pressOrigin.current;
        if (origin === null) return;
        const travelled =
          Math.abs(e.clientX - origin.x) > LONG_PRESS_SLOP_PX ||
          Math.abs(e.clientY - origin.y) > LONG_PRESS_SLOP_PX;
        if (travelled) clearPress();
      },
    },
  };
}

/**
 * The menu surface. Renders nothing when `point` is null.
 *
 * Closes on Escape, on a pointer press outside itself, and on scroll or
 * resize — a fixed-positioned menu would otherwise detach from the message it
 * describes the moment the log moves under it.
 */
export function ContextMenu({
  point,
  onClose,
  label,
  children,
  className,
}: {
  point: MenuPoint | null;
  onClose(): void;
  /** Accessible name — what the menu acts on, e.g. "Message actions". */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  // Focus returns here on close, so dismissing a menu never dumps the user
  // back at the top of the document.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Capture the opener only. Position is owned exclusively by the layout
  // effect below: this one runs AFTER it in the same commit, so assigning
  // `pos` here would overwrite the clamp with the raw, unclamped point.
  useEffect(() => {
    if (point !== null && typeof document !== 'undefined') {
      opener.current = document.activeElement as HTMLElement | null;
    }
  }, [point]);

  /**
   * Clamp into the viewport once the real size is known.
   *
   * Written imperatively, and deliberately so: the size can only be measured
   * after the element exists, but the element only exists once it has a
   * position — routing the correction through state deadlocks on that circle
   * (render needs pos, pos needs the ref, the ref needs a render). Rendering
   * at the raw point and correcting the style here breaks it, and
   * useLayoutEffect means the correction lands before paint, so nothing jumps.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (point === null || el === null) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const maxX = window.innerWidth - w - VIEWPORT_MARGIN;
    const maxY = window.innerHeight - h - VIEWPORT_MARGIN;
    el.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(point.x, maxX))}px`;
    el.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(point.y, maxY))}px`;
    el.focus({ preventScroll: true });
  }, [point]);

  useEffect(() => {
    if (point === null) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onMove = () => {
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    // `true` — scroll does not bubble, so the chat log's own scrolling is only
    // observable in the capture phase.
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [point, onClose]);

  // Restore focus to whatever opened the menu, once it is gone.
  useEffect(() => {
    if (point !== null) return;
    const el = opener.current;
    opener.current = null;
    el?.focus?.({ preventScroll: true });
  }, [point]);

  const onMenuKeyDown = (e: { key: string; preventDefault(): void }): void => {
    const el = ref.current;
    if (el === null) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    // Wraps: from the last item, ArrowDown returns to the first.
    const next = items[(at + step + items.length) % items.length];
    next?.focus();
  };

  if (!mounted || point === null) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
      // Raw point; the layout effect clamps it before paint.
      style={{ left: point.x, top: point.y }}
      // Same treatment as <DropdownMenuContent>: solid ladder surface, hairline,
      // neutral elevation. Two menu primitives that looked different was itself
      // part of the problem.
      className={cn(
        'fixed z-[70] min-w-44 rounded-card border border-hairline bg-surface-2 p-1 shadow-e2 outline-none',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

/** A row of icon-sized actions (quick reactions) above the item list. */
export function ContextMenuRow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap gap-1 border-b border-hairline px-1 pb-1.5">
      {children}
    </div>
  );
}

export function ContextMenuItem({
  children,
  onSelect,
  onClose,
  destructive = false,
  className,
}: {
  children: ReactNode;
  onSelect(): void;
  onClose(): void;
  destructive?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onSelect();
        onClose();
      }}
      className={cn(
        'flex min-h-ctl-sm w-full items-center gap-2 rounded-sm px-2.5 py-1 text-left text-label transition-colors duration-150',
        destructive ? 'text-danger hover:bg-surface-3' : 'text-mid hover:bg-surface-3 hover:text-hi',
        className,
      )}
    >
      {children}
    </button>
  );
}
