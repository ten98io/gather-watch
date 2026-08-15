'use client';

import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query. SSR-safe (returns false on the server).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onStoreChange);
      return () => {
        mql.removeEventListener('change', onStoreChange);
      };
    },
    () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
    () => false,
  );
}
