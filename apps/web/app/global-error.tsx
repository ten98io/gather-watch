'use client';

/**
 * The last boundary: a throw in the ROOT layout itself.
 *
 * Next replaces the whole document with this component, which is why it
 * renders its own <html> and <body> — the root layout, its font variables and
 * the pre-paint theme script are all exactly what failed, so none of them are
 * around to be inherited.
 *
 * Everything here is inline-styled for the same reason. The Tailwind layer and
 * the generated token sheet ride on the root layout's import graph; a screen
 * whose whole job is to work when that graph is broken cannot depend on it.
 * Each colour still reads its token first and falls back to the literal from
 * layout.tsx's `viewport.themeColor`, so it matches when the CSS did survive.
 *
 * No <Link>, no Button: the router and the component tree are the suspects.
 * A plain anchor and a plain button are the two controls that cannot fail.
 *
 * As with every boundary here, nothing off `error` reaches the markup — the
 * digest goes to the console so a bug report can still be traced.
 */
import { useEffect } from 'react';
import { describeBoundaryError, logBoundaryError } from '@/lib/describe-error';

const shell: React.CSSProperties = {
  minHeight: '100dvh',
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1rem',
  background: 'var(--bg-void, #17141f)',
  color: 'var(--text-hi, #f6f5fa)',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
  maxWidth: '28rem',
  width: '100%',
  padding: '2rem',
  textAlign: 'center',
  borderRadius: '1rem',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  background: 'rgba(255, 255, 255, 0.04)',
};

const control: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '2.75rem',
  padding: '0 1rem',
  borderRadius: '0.75rem',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  background: 'rgba(255, 255, 255, 0.06)',
  color: 'inherit',
  font: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logBoundaryError('global', error);
  }, [error]);

  return (
    <html lang="en" data-theme="dark">
      <body style={shell}>
        <main style={card}>
          <span aria-hidden style={{ fontSize: '2.25rem' }}>🌌</span>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Gather couldn’t load</h1>
          <p style={{ margin: 0, fontSize: '0.875rem', opacity: 0.75 }}>
            {describeBoundaryError(error)}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" style={control} onClick={reset}>Retry</button>
            <a href="/home" style={control}>Back to your rooms</a>
          </div>
        </main>
      </body>
    </html>
  );
}
