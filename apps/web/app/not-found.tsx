/**
 * The 404 screen.
 *
 * Deliberately never says "404": the number is the protocol's word, not a
 * person's, and it explains nothing to someone who followed a dead invite
 * link. The sentence says what happened; the button says where to go.
 *
 * Same shape as the room's closed notice (room-shell.tsx) so a wrong URL and
 * an ended session do not look like two different products.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow">
        <span aria-hidden className="text-4xl">🌌</span>
        <h1 className="font-display text-2xl font-bold">There’s nothing here</h1>
        <p className="text-sm text-mid">
          This page doesn’t exist — the link may be old, or the room it pointed at is gone.
        </p>
        <Link href="/home">
          <Button>Back to your rooms</Button>
        </Link>
      </div>
    </main>
  );
}
