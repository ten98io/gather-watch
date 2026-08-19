import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Which rung of the radius ladder the placeholder is cut with.
 *
 * A prop rather than a `className` override, because `cn` is a plain joiner:
 * `rounded-card rounded-panel` does not resolve to the second one, it resolves
 * to whichever Tailwind emitted later — so a placeholder standing in for a
 * panel silently kept the card's corner. Conflicting utilities have to be
 * mutually exclusive, and this is the exclusion.
 */
export type SkeletonRadius = 'ctl' | 'card' | 'panel' | 'pill';

const radiusClasses: Record<SkeletonRadius, string> = {
  ctl: 'rounded-ctl',
  card: 'rounded-card',
  panel: 'rounded-panel',
  pill: 'rounded-pill',
};

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  radius?: SkeletonRadius;
}

/** Aurora-shimmer placeholder (DESIGN.md §8: skeletons, never spinner walls).
 *  A placeholder has to be cut like the thing it replaces — otherwise the
 *  layout visibly re-shapes at the moment the content lands. */
export function Skeleton({ className, radius = 'card', ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn('skeleton-shimmer', radiusClasses[radius], className)}
      {...props}
    />
  );
}
