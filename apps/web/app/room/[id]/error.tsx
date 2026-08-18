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

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow">
        <span aria-hidden className="text-4xl">🌌</span>
        <h1 className="font-display text-2xl font-bold">This room stopped rendering</h1>
        <p className="text-sm text-mid">{describeBoundaryError(error)}</p>
        <p className="text-sm text-low">
          The room itself is fine — everyone else is still in it, and rejoining picks up where
          the room is now.
        </p>
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
