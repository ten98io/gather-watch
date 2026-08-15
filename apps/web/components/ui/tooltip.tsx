import type { ReactElement, ReactNode } from 'react';
import { cloneElement, isValidElement } from 'react';
import { cn } from '@/lib/cn';

export interface TooltipProps {
  content: string;
  children: ReactNode;
  className?: string;
}

/**
 * CSS-only tooltip on hover/focus; also injects `aria-label` into a single
 * element child so the label is available to assistive tech.
 */
export function Tooltip({ content, children, className }: TooltipProps) {
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-label': content,
      })
    : children;
  return (
    <span className={cn('group relative inline-flex', className)}>
      {child}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute -top-9 left-1/2 z-[65] -translate-x-1/2 whitespace-nowrap',
          'glass-raised rounded-ctl px-2.5 py-1 text-xs text-hi opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100 group-focus-within:opacity-100',
        )}
      >
        {content}
      </span>
    </span>
  );
}
