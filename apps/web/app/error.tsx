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
 *
 * Composition matches app/not-found.tsx exactly, and that is the point: a
 * broken render and a dead link are both "this is not the page you wanted",
 * and two different-looking apologies read as two different products.
 */
import Link from 'next/link';
import { useEffect } from 'react';
import { Button, buttonClasses } from '@/components/ui/button';
import { OrbitIcon } from '@/components/ui/icons';
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
    <main className="grid min-h-dvh place-items-center px-6 py-12 md:py-chapter">
      {/* Composition rungs halve below `md` (see app/home/page.tsx). */}
      <div className="grain flex w-full max-w-xl flex-col items-center gap-8 rounded-stage bg-surface-1 px-8 py-section text-center md:py-canvas">
        <span
          aria-hidden
          className="grid h-14 w-14 place-items-center rounded-full bg-surface-2 text-low"
        >
          <OrbitIcon size={24} />
        </span>
        <div className="flex flex-col items-center gap-4">
          <p className="text-caption text-low">Unexpected error</p>
          <h1 className="font-display text-headline text-hi md:text-display">Something broke.</h1>
          <p className="max-w-md text-body text-mid">{describeBoundaryError(error)}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-4">
          {/* Retry first and quieter, home as the primary: retry is the cheap
              guess, and going home is the one that always works. One primary
              per region (DESIGN.md §8). */}
          <Button variant="secondary" size="lg" onClick={reset}>
            Retry
          </Button>
          <Link href="/home" className={buttonClasses({ size: 'lg' })}>
            Back to your rooms
          </Link>
        </div>
      </div>
    </main>
  );
}
