'use client';

/**
 * The route error boundary — the screen for an uncaught render throw anywhere
 * under the root layout.
 *
 * Before this file existed there was no boundary in the repo at all: a throw
 * in any pane unmounted the tree to Next's built-in screen, which is a stack
 * trace in development and a blank page in production. Neither says what
 * happened and neither offers a way back.
 *
 * The rule this screen keeps, and test/error-boundary.test.tsx enforces:
 * nothing from `error` is ever rendered. `error.message` is whatever threw —
 * a raw HTTP body, an internal path, a connection string — and `digest` is a
 * build hash that only means something inside a log search. Both are logged.
 * The person gets one sentence and two ways forward.
 */
import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { describeBoundaryError, logBoundaryError } from '@/lib/describe-error';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logBoundaryError('route', error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow">
        <span aria-hidden className="text-4xl">🌌</span>
        <h1 className="font-display text-2xl font-bold">Something broke</h1>
        <p className="text-sm text-mid">{describeBoundaryError(error)}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={reset}>Retry</Button>
          <Link href="/home">
            <Button>Back to your rooms</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
