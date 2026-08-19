'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { useReducedMotion } from '@/hooks/useReducedMotion';

interface DialogContextValue {
  open: boolean;
  onOpenChange(open: boolean): void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (ctx === null) throw new Error('Dialog components must be used within <Dialog>');
  return ctx;
}

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

/** Modal dialog — glass panel over a dimmed void (DESIGN.md: no modal
 *  overload; reserve for destructive confirms like account deletion). */
export function Dialog({ open, onOpenChange, children }: DialogProps) {
  return (
    <DialogContext.Provider value={{ open, onOpenChange }}>
      {children}
    </DialogContext.Provider>
  );
}

export function DialogContent({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  'aria-label': string;
}) {
  const { open, onOpenChange } = useDialog();
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
  const motionProps = reducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
    : {
        initial: { opacity: 0, y: 12, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 8, scale: 0.98 },
        transition: { type: 'spring' as const, stiffness: 260, damping: 30 },
      };
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          {/* `.scrim`, not a hand-rolled wash. `bg-void/70` was a theme colour
              at an eyeballed alpha, and on Daylight that is a near-WHITE at
              70% — the page behind stayed fully readable, so a dialog was
              modal in the DOM and to nobody looking at it. `--scrim` is one
              absolute near-black measured against everything the page can
              show (DESIGN.md §2). */}
          <motion.button
            type="button"
            aria-label="Close dialog"
            className="scrim absolute inset-0 cursor-default"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.15 : 0.2 }}
            onClick={() => {
              onOpenChange(false);
            }}
          />
          {/* A dialog is centred in a FIXED box, so anything taller than the
              viewport hangs off both ends of it with nothing to scroll: the
              room settings panel measured 1171px on a 375×812 phone, which put
              its own title and every one of its destructive actions out of
              reach. The cap is the wrapper's `p-4` on each side, so the panel
              still floats; the overflow moves inside it, where a phone can
              reach the bottom of a long form and a desktop never sees the
              scroller at all. `overscroll-contain` keeps that scroll from
              handing off to the page underneath once it bottoms out. */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            className={cn(
              'glass-panel relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-md',
              'overflow-y-auto overscroll-contain p-8 shadow-e3',
              className,
            )}
            {...motionProps}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** `text-headline` from the ramp, not `text-xl font-semibold` and no longer
 *  `text-title`: DESIGN.md §3 assigns the 28px step to "room name, page titles,
 *  dialog titles" by name, and `title` is the step for a section INSIDE one.
 *  A dialog names itself; at 20px it was the same size as the section heads on
 *  the page it had just covered, which is why a modal did not read as a place
 *  you had arrived at. The ramp carries the weight and tracking — restating
 *  either is how the product ended up with three "header" treatments. */
export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('font-display text-headline text-hi', className)}>{children}</h2>;
}

export function DialogDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cn('mt-2 max-w-prose text-body text-mid', className)}>{children}</p>;
}
