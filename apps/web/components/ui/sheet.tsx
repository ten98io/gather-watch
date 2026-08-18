'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useReducedMotion } from '@/hooks/useReducedMotion';

interface SheetContextValue {
  open: boolean;
  onOpenChange(open: boolean): void;
}

const SheetContext = createContext<SheetContextValue | null>(null);

function useSheet(): SheetContextValue {
  const ctx = useContext(SheetContext);
  if (ctx === null) throw new Error('Sheet components must be used within <Sheet>');
  return ctx;
}

export interface SheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

/** Bottom sheet — the mobile home of Chat/Queue/People (DESIGN.md §7). */
export function Sheet({ open, onOpenChange, children }: SheetProps) {
  return (
    <SheetContext.Provider value={{ open, onOpenChange }}>{children}</SheetContext.Provider>
  );
}

export function SheetContent({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  'aria-label': string;
}) {
  const { open, onOpenChange } = useSheet();
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70]">
          <motion.button
            type="button"
            aria-label="Close sheet"
            className="absolute inset-0 cursor-default bg-void/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.15 : 0.2 }}
            onClick={() => {
              onOpenChange(false);
            }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            className={cn(
              'glass-panel absolute inset-x-0 bottom-0 flex max-h-[72dvh] flex-col rounded-b-none p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-e3',
              className,
            )}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 48 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 48 }}
            transition={
              reducedMotion ? { duration: 0.15 } : { type: 'spring', stiffness: 260, damping: 30 }
            }
          >
            <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-border-glass" />
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
