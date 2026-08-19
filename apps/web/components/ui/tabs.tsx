'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface TabsContextValue {
  value: string;
  onValueChange(value: string): void;
  /** tab value → count rendered on its trigger. 0/absent renders nothing. */
  badges: Readonly<Record<string, number>>;
  setBadge(value: string, count: number): void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

/**
 * The panel a component is rendering inside: which tab it belongs to, and
 * whether that tab is the SELECTED one. Inactive panels stay mounted (see
 * {@link TabsContent}), so "am I on screen?" is a real question a pane has to
 * be able to ask — the chat pane uses it to decide whether messages arriving
 * now count as read.
 *
 * The default says "on screen, belongs to no tab", so a pane rendered outside
 * any Tabs behaves exactly as it did before there were tabs.
 */
interface TabPanelContextValue {
  active: boolean;
  value: string | null;
}
const TabPanelContext = createContext<TabPanelContextValue>({ active: true, value: null });

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (ctx === null) throw new Error('Tabs components must be used within <Tabs>');
  return ctx;
}

/** True when this component's tab panel is the selected one. */
export function useTabPanelActive(): boolean {
  return useContext(TabPanelContext).active;
}

/**
 * Publish an unread count from inside a panel onto ITS {@link TabsTrigger}.
 *
 * The count is owned by whatever knows the domain (for chat, the room store),
 * never by the tab bar; the panel supplies the tab name, so no pane has to
 * hard-code one. Safe to call outside <Tabs>: it simply does nothing, and the
 * pane stays renderable on its own.
 *
 * This route is only live while the panel is mounted. A count that must be
 * right before its tab has ever been opened is passed to {@link TabsTrigger}
 * as `badge` instead, and wins over anything published here.
 */
export function useTabBadge(count: number): void {
  const setBadge = useContext(TabsContext)?.setBadge;
  const { value } = useContext(TabPanelContext);
  useEffect(() => {
    if (value !== null) setBadge?.(value, count);
  }, [setBadge, value, count]);
  // Separate effect so a changing count never flashes the badge to 0 first;
  // this one only ever runs on unmount.
  useEffect(
    () => () => {
      if (value !== null) setBadge?.(value, 0);
    },
    [setBadge, value],
  );
}

export interface TabsProps {
  value: string;
  onValueChange(value: string): void;
  children: ReactNode;
  className?: string;
}

/** Controlled tab set (Chat / Queue / People in the room rail). */
export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const [badges, setBadges] = useState<Record<string, number>>({});
  const setBadge = useCallback((tab: string, count: number): void => {
    setBadges((prev) => {
      const next = count > 0 ? count : 0;
      if ((prev[tab] ?? 0) === next) return prev;
      return { ...prev, [tab]: next };
    });
  }, []);
  const ctx = useMemo(
    () => ({ value, onValueChange, badges, setBadge }),
    [value, onValueChange, badges, setBadge],
  );
  return (
    <TabsContext.Provider value={ctx}>
      <div className={cn('flex min-h-0 flex-col', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

/**
 * A count on a tab, and on whatever stands in for the whole tab bar when there
 * is no room for one (the room shell's mobile sheet opener).
 *
 * Deliberately NOT `<Badge variant="aurora">`, which is what it was. The aurora
 * gradient has a budget of three product-wide — the primary action, the brand
 * mark, the live indicator (DESIGN.md §2) — and an unread digit is none of
 * them; spending it here is how the gradient stopped meaning "this one". Flat
 * `--accent` is what "tinted" looks like, and it retints with the artwork for
 * free. The ink is measured against that fill and never against the theme
 * (§2.1), so it stays legible when a listen room rebinds `--accent`.
 *
 * Renders nothing at 0, so a quiet tab's accessible name is just its own name.
 */
export function UnreadCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden
        className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-pill bg-accent px-1 text-caption tabular-nums text-[var(--ink-on-accent)]"
      >
        {count > 99 ? '99+' : count}
      </span>
      {/* The digit alone says nothing out loud. Putting the words in the
          control's own content keeps its accessible name as "Chat 3 unread" —
          an aria-label here would replace the control's identity with a count. */}
      <span className="sr-only">{count} unread</span>
    </>
  );
}

/**
 * The tab bar.
 *
 * It was a segmented control — a pill of `--surface-glass` with the selected
 * segment raised in glass and lit by `shadow-glow`. Three things wrong with
 * that at once: glass is reserved for surfaces floating over moving video and
 * the rail is not one (§4), glow is reserved for signature moments and a tab is
 * not one (§5), and a segmented control is a FORM WIDGET — it says "pick a
 * value", when what these three do is move you between places. So it is a
 * masthead nav now: section names on the type ramp, sitting on the rail's one
 * hairline, with the active one carried by the accent edge §2 already spells
 * out for a selected row.
 *
 * `aria-label` is declared rather than spread from rest props on purpose: it
 * was being passed at the call site and silently dropped (TypeScript does not
 * check hyphenated JSX attributes against a component's props), so the tablist
 * had no accessible name at all.
 */
export function TabsList({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex shrink-0 items-end gap-6 border-b border-hairline', className)}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  badge,
  className,
}: {
  value: string;
  children: ReactNode;
  /**
   * Count to draw on this trigger, overriding anything the panel published
   * with {@link useTabBadge}.
   *
   * The published route only works while the panel exists, and a panel does
   * not exist until its tab is first selected ({@link TabsContent} mounts
   * lazily) — so the pane that owns the count is exactly the pane that is not
   * there to publish it. A count that has to be right BEFORE its tab is first
   * opened comes from whatever outlives every panel, and is passed in here.
   */
  badge?: number;
  className?: string;
}) {
  const tabs = useTabs();
  const selected = tabs.value === value;
  const count = badge ?? tabs.badges[value] ?? 0;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-state={selected ? 'active' : 'inactive'}
      onClick={() => {
        tabs.onValueChange(value);
      }}
      className={cn(
        // -mb-px lands the active edge ON the list's hairline rather than
        // beside it; the offset IS that hairline's width.
        'relative -mb-px inline-flex min-h-tap items-center gap-2 pb-3 pt-2',
        'font-display text-title transition-colors duration-150',
        // Mutually exclusive: cn() is a plain joiner, so a selected trigger
        // that also kept `text-low` would take whichever colour Tailwind
        // happened to emit second.
        selected ? 'text-hi' : 'text-low hover:text-mid',
        className,
      )}
    >
      {children}
      <UnreadCount count={count} />
      {/* The active edge (DESIGN.md §2): flat `--accent` at `layout.edge`,
          never a glow. On the light theme the accent is a 3:1 non-text colour,
          which is exactly what an edge is allowed to be. */}
      {selected && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-edge rounded-pill bg-accent" />
      )}
    </button>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const tabs = useTabs();
  const active = tabs.value === value;
  /**
   * Mount lazily, then keep it. This used to `return null` for every inactive
   * tab, which destroyed the pane on each switch — the chat pane lost its
   * exhausted-history flag, every extra page "load earlier" had paid for, an
   * open search box, a half-typed reply — and there was nothing left alive to
   * count unread messages with. Panes still mount no earlier than they used to
   * (nothing renders until its tab is first selected); they just stop being
   * thrown away afterwards.
   *
   * `hidden` is display:none, so a hidden panel keeps its STATE but not its
   * scroll offset — a pane that cares re-pins itself when it comes back (see
   * ChatPane's stick-to-bottom effect).
   */
  const everActive = useRef(false);
  if (active) everActive.current = true;
  const panel = useMemo(() => ({ active, value }), [active, value]);
  if (!active && !everActive.current) return null;
  return (
    <div
      role="tabpanel"
      hidden={!active}
      className={cn('min-h-0 flex-1', !active ? 'hidden' : '', className)}
    >
      <TabPanelContext.Provider value={panel}>{children}</TabPanelContext.Provider>
    </div>
  );
}
