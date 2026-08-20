'use client';

/**
 * The room boundary.
 *
 * Nesting, checked rather than assumed: `app/room/[id]/` has a page and no
 * layout of its own, so this file is the closest boundary to RoomShell and
 * Next hands it every throw from the room subtree — the panes, the stage, the
 * call surface — before the root `app/error.tsx` ever sees it. What that buys
 * is scope: Retry here re-renders the room, and the root boundary (with its
 * whole-app framing) stays for throws outside a room.
 *
 * What it does NOT buy is pane isolation. Without a layout to sit under, this
 * boundary replaces the entire room page, so one broken pane still takes the
 * other three with it. Isolating a pane needs a client ErrorBoundary wrapped
 * around each one inside room-shell.tsx; see the handoff note.
 *
 * Copy differs from the root boundary on purpose: someone whose room went
 * blank needs to know the room is what failed and their rooms are still
 * there — otherwise Retry looks like it might cost them the session.
 */
import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { describeBoundaryError, logBoundaryError } from '@/lib/describe-error';

export default function RoomError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logBoundaryError('room', error);
  }, [error]);

  // Composed as RoomNotice in room-shell.tsx is, deliberately: a reader who
  // hits both should not be able to tell that two different mechanisms caught
  // them. Type in a canvas of void — no card, no glass, no glow — with the way
  // out as the region's one aurora action.
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-section text-center md:py-canvas">
      <div className="flex w-full max-w-2xl flex-col items-center gap-6">
        <h1 className="font-display text-headline text-hi md:text-display">This room stopped working</h1>
        <div className="flex max-w-md flex-col gap-2">
          <p className="text-body text-mid">{describeBoundaryError(error)}</p>
          <p className="text-body text-low">
            The room itself is fine — rejoining picks up where it is now.
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button size="lg" variant="secondary" onClick={reset}>
            Try again
          </Button>
          <Link href="/home">
            <Button size="lg">Back to your rooms</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
