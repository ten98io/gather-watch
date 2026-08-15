'use client';

import { useMediaQuery } from './useMediaQuery';

/**
 * DESIGN.md §6: when true, kill ambient/parallax/drift motion and keep only
 * opacity fades ≤ 150 ms. Framer Motion consumers should pass reduced
 * transition configs; CSS is handled globally in globals.css.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
