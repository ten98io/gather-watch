import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Scroll container with the design system's thin aurora-tinted scrollbar. */
export function ScrollArea({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('overflow-y-auto overscroll-contain', className)} {...props} />;
}
