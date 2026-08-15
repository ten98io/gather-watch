'use client';

import { useEffect } from 'react';

/**
 * Registers /public/sw.js in production only (app-shell cache + push handler
 * stub). No-op during development so HMR is never intercepted.
 */
export function useServiceWorker(): void {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Registration failure must never break the app.
    });
  }, []);
}
