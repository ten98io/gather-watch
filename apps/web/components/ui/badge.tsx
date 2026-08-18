import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type BadgeVariant = 'default' | 'aurora' | 'success' | 'danger' | 'warn' | 'muted';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-surface-2 text-mid',
  // No `text-accent-ink`: `.aurora-gradient` sets the ink measured against all
  // three of its own stops. Stating it here is what made this label 1.79:1 on
  // dark `--aurora-3`.
  aurora: 'aurora-gradient',
  success: 'bg-[color-mix(in_oklch,var(--success)_18%,transparent)] text-success',
  danger: 'bg-[color-mix(in_oklch,var(--danger)_18%,transparent)] text-danger',
  warn: 'bg-[color-mix(in_oklch,var(--warn)_18%,transparent)] text-warn',
  muted: 'bg-surface-2 text-low',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

/** Pill chip for plan badges, room kinds, unread counts.
 *
 *  `text-caption` (11/14/500/+0.06em, uppercase) rather than `text-xs`: DESIGN.md
 *  §3 assigns the caption step to badges by name, and `text-xs` was Tailwind
 *  core leaking back into a system that has its own ramp. The uppercase is what
 *  makes a two-character chip read as a label instead of as shouting text. */
export function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption tabular-nums',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
