'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'gather:theme';

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Dark-default theme with localStorage persistence, applied via the
 * `data-theme` attribute on <html> (DESIGN.md §2). The inline script in
 * app/layout.tsx applies the stored theme before first paint; this hook is
 * the interactive counterpart for toggles.
 */
export function useTheme(): { theme: Theme; setTheme(theme: Theme): void; toggle(): void } {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    setThemeState(readTheme());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode etc. — theme still applies for the session.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
