/**
 * The 404 screen.
 *
 * Deliberately never says "404": the number is the protocol's word, not a
 * person's, and it explains nothing to someone who followed a dead invite
 * link. The sentence says what happened; the button says where to go.
 *
 * ── Why it is a plate and not a card (2026-08-19) ─────────────────────────
 * It was a 448px glass box with `shadow-glow` and a 🌌 set at 36px. All three
 * were wrong for the same reason: glass is for surfaces over moving video
 * (§4), glow is a signature moment (§5), and an emoji at display size is the
 * least professional thing a page whose job is to say "something went wrong,
 * calmly" can wear — `OrbitIcon` exists for exactly this. What is left is one
 * solid plate at stage radius, canvas breathing room, and the screen's one
 * display setting spent on the sentence it is about.
 *
 * The room's closed notice (`room-shell.tsx`) is the other screen with this
 * shape and it has not been re-composed yet; a wrong URL and an ended session
 * still ought to look like one product, so that file wants the same treatment.
 */
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/button';
import { OrbitIcon } from '@/components/ui/icons';

export default function NotFound() {
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
          <p className="text-caption text-low">Nothing at this address</p>
          <h1 className="font-display text-headline text-hi md:text-display">There’s nothing here.</h1>
          <p className="max-w-md text-body text-mid">
            This page doesn’t exist — the link may be old, or the room it pointed at is gone.
          </p>
        </div>
        {/* A `<Link>` wearing the button, not a `<Button>` inside a `<Link>`:
            an anchor around a button is two tab stops for one action. */}
        <Link href="/home" className={buttonClasses({ size: 'lg' })}>
          Back to your rooms
        </Link>
      </div>
    </main>
  );
}
