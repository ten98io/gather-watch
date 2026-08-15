'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface DropdownContextValue {
  open: boolean;
  setOpen(open: boolean): void;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

function useDropdown(): DropdownContextValue {
  const ctx = useContext(DropdownContext);
  if (ctx === null) throw new Error('DropdownMenu components must be used within <DropdownMenu>');
  return ctx;
}

/** Minimal glass dropdown (popover-style; DESIGN.md prefers popovers over modals). */
export function DropdownMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <DropdownContext.Provider value={{ open, setOpen }}>
      <div ref={rootRef} className="relative inline-block">
        {children}
      </div>
    </DropdownContext.Provider>
  );
}

export function DropdownMenuTrigger({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  const { open, setOpen } = useDropdown();
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={ariaLabel}
      onClick={() => {
        setOpen(!open);
      }}
      className={cn('inline-flex items-center', className)}
    >
      {children}
    </button>
  );
}

export function DropdownMenuContent({
  children,
  className,
  align = 'end',
}: {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'end';
}) {
  const { open } = useDropdown();
  if (!open) return null;
  return (
    <div
      role="menu"
      className={cn(
        'glass-panel absolute z-[60] mt-2 min-w-44 p-1.5 shadow-glow',
        align === 'end' ? 'right-0' : 'left-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  destructive = false,
  className,
}: {
  children: ReactNode;
  onSelect?(): void;
  destructive?: boolean;
  className?: string;
}) {
  const { setOpen } = useDropdown();
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onSelect?.();
        setOpen(false);
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-ctl px-3 py-2 text-left text-sm transition-colors duration-150',
        destructive ? 'text-danger hover:bg-glass' : 'text-mid hover:bg-glass hover:text-hi',
        className,
      )}
    >
      {children}
    </button>
  );
}
