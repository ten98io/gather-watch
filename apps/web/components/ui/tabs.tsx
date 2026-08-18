'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Badge } from './badge';

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

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="tablist"
      className={cn('flex shrink-0 gap-1 rounded-ctl bg-glass p-1', className)}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const tabs = useTabs();
  const selected = tabs.value === value;
  const badge = tabs.badges[value] ?? 0;
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
        'h-9 flex-1 rounded-[10px] px-3 text-sm font-medium transition-all duration-200',
        selected ? 'glass-raised text-hi shadow-glow' : 'text-low hover:text-mid',
        badge > 0 ? 'inline-flex items-center justify-center gap-1.5' : '',
        className,
      )}
    >
      {children}
      {badge > 0 && (
        <>
          <Badge variant="aurora" aria-hidden className="shrink-0">
            {badge > 99 ? '99+' : badge}
          </Badge>
          {/* The digit alone says nothing out loud. Putting the words in the
              button's own content keeps the accessible name as "Chat 3 unread"
              — an aria-label here would replace the tab's identity with a
              count. */}
          <span className="sr-only">{badge} unread</span>
        </>
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
