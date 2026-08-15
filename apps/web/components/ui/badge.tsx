import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type BadgeVariant = 'default' | 'aurora' | 'success' | 'danger' | 'warn' | 'muted';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'glass-raised text-mid',
  aurora: 'aurora-gradient text-accent-ink',
  success: 'bg-[color-mix(in_oklch,var(--success)_18%,transparent)] text-success',
  danger: 'bg-[color-mix(in_oklch,var(--danger)_18%,transparent)] text-danger',
  warn: 'bg-[color-mix(in_oklch,var(--warn)_18%,transparent)] text-warn',
  muted: 'bg-glass text-low',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

/** Pill chip for plan badges, room kinds, unread counts. */
export function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium leading-5',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
