/**
 * <EmptyState> — icon, one sentence, at most one action (DESIGN.md §4).
 * Every empty list uses it; a bare "Nothing here" paragraph is not acceptable
 * because an empty region with no way out reads as a broken screen.
 *
 * The action slot takes exactly one control. If a surface needs two, the second
 * one belongs somewhere else.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  /** An icon from components/ui/icons.tsx, sized 20–24. Never an emoji. */
  icon: ReactNode;
  /** One short sentence naming what is missing. */
  title: string;
  /** Optional second sentence saying how to fill it. */
  description?: string;
  /** At most one primary action. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-4 py-8 text-center',
        className,
      )}
    >
      <span
        aria-hidden
        className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-low"
      >
        {icon}
      </span>
      <p className="text-body text-hi">{title}</p>
      {description !== undefined && (
        <p className="max-w-xs text-label text-low">{description}</p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}
