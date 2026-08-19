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
          {/* Same `.scrim` as the dialog, and for the same reason: `bg-void/60`
              was a theme colour at an eyeballed alpha, which on Daylight is a
              near-white wash that suppresses nothing (DESIGN.md §2). A sheet
              and a dialog also have to dim the page IDENTICALLY — two modal
              surfaces that darken by different amounts read as two products. */}
          <motion.button
            type="button"
            aria-label="Close sheet"
            className="scrim absolute inset-0 cursor-default"
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
              // `h-`, not `max-h-`. A DEFINITE height is what the panes inside
              // need: with only a max-height the panel is sized by its content,
              // so `h-full` on a pane resolved to `auto`, the pane's own
              // `overflow-y-auto` region never became a scroller, and the
              // bottom of the queue (and of chat) ran off the bottom of the
              // phone where nothing could reach it.
              //
              // 72dvh → 86dvh, because the 28dvh it kept back was not a view
              // of the stage: a sheet is modal and `.scrim` is measured to
              // suppress everything under it (DESIGN.md §2), so those 227px
              // were dimmed, blurred and inert. Spent on the panel instead
              // they are what makes the call dock, the tab bar, the queue
              // header and a signature empty state fit on a 375×812 phone at
              // once — at 72dvh the empty QUEUE was a 380px poster in a 252px
              // port, so an empty list arrived already scrolled. What is left
              // is still a comfortable tap-to-dismiss target.
              'glass-panel absolute inset-x-0 bottom-0 flex h-[86dvh] flex-col rounded-b-none p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-e3',
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
