'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface TabsContextValue {
  value: string;
  onValueChange(value: string): void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (ctx === null) throw new Error('Tabs components must be used within <Tabs>');
  return ctx;
}

export interface TabsProps {
  value: string;
  onValueChange(value: string): void;
  children: ReactNode;
  className?: string;
}

/** Controlled tab set (Chat / Queue / People in the room rail). */
export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
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
        className,
      )}
    >
      {children}
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
  if (tabs.value !== value) return null;
  return (
    <div role="tabpanel" className={cn('min-h-0 flex-1', className)}>
      {children}
    </div>
  );
}
