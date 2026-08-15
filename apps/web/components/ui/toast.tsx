'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
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
      className="glass-panel pointer-events-auto flex max-w-sm items-center gap-3 px-4 py-3"
      role="status"
    >
      <span className={cn('text-sm', kindClasses[item.kind])}>{item.message}</span>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => {
          dismiss(item.id);
        }}
        className="ml-auto text-low transition-colors hover:text-hi"
      >
        ✕
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
