import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Aurora-shimmer placeholder (DESIGN.md §8: skeletons, never spinner walls). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('skeleton-shimmer rounded-card', className)}
      {...props}
    />
  );
}
