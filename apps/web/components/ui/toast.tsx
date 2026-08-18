'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { XIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

export type ToastKind = 'default' | 'success' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastStore {
  toasts: ToastItem[];
  push(toast: Omit<ToastItem, 'id'>): void;
  dismiss(id: number): void;
}

const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],
  push: (toast) => {
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id: Date.now() + Math.random() }] }));
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Sonner-style imperative API: toast("..."), toast.success("..."), toast.error("..."). */
export const toast = Object.assign(
  (message: string) => {
    useToastStore.getState().push({ kind: 'default', message });
  },
  {
    success: (message: string) => {
      useToastStore.getState().push({ kind: 'success', message });
    },
    error: (message: string) => {
      useToastStore.getState().push({ kind: 'error', message });
    },
    dismiss: (id: number) => {
      useToastStore.getState().dismiss(id);
    },
  },
);

const kindClasses: Record<ToastKind, string> = {
  default: 'text-hi',
  success: 'text-success',
  error: 'text-danger',
};

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      dismiss(item.id);
    }, 4200);
    return () => {
      window.clearTimeout(handle);
    };
  }, [item.id, dismiss]);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      className="glass-panel pointer-events-auto flex max-w-sm items-center gap-3 px-4 py-3 shadow-e2"
      /* A failure interrupts; a confirmation waits its turn. `polite` on the
         container is right for "Invite code copied", but it let a failure
         sentence be dropped entirely when nothing paused before the 4.2s
         auto-dismiss — a silent failure, which is the thing describeError
         exists to prevent. role + aria-live together: the pair is what gets
         announced consistently across screen readers. */
      role={item.kind === 'error' ? 'alert' : 'status'}
      aria-live={item.kind === 'error' ? 'assertive' : 'polite'}
    >
      <span className={cn('text-body', kindClasses[item.kind])}>{item.message}</span>
      {/* Icon, not `✕`. DESIGN.md §8 is explicit — icons come from
          components/ui/icons.tsx and emoji are content, never controls — and a
          glyph rendered as a control is not only off-system, it inherits the
          font's own weight and baseline, so it never optically centres in the
          hit area the way a 16px stroked icon does. */}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => {
          dismiss(item.id);
        }}
        className="-mr-1 ml-auto grid h-ctl-sm w-ctl-sm shrink-0 place-items-center rounded-sm text-low transition-colors duration-150 hover:bg-surface-2 hover:text-hi"
      >
        <XIcon size={16} />
      </button>
    </motion.div>
  );
}

/** Bottom-center glass toasts (DESIGN.md §8). Mounted once in Providers. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[90] flex flex-col items-center gap-2 px-4"
    >
      <AnimatePresence initial={false}>
        {toasts.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
