'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { buttonClasses } from '@/components/ui/button';
import { Wordmark } from '@/components/Logo';

/**
 * The front door.
 *
 * It used to be a redirect gate: a pulsing logo on an empty void that bounced
 * you to /home or /login the instant the session probe settled. That meant the
 * product had no page saying what it IS — every shared link to the bare origin
 * landed on a spinner, and the first thing a new person ever saw was an auth
 * form. A sign-in box is not an introduction.
 *
 * The redirect SURVIVES for anyone who already has a session, so a returning
 * user still spends zero interactions getting to their rooms (DESIGN.md §12
 * measures from /home, and nothing here sits in front of it). What changed is
 * only what a signed-out visitor gets: this composition instead of a bounce.
 *
 * ── Why no skeleton and no spinner while auth settles ─────────────────────
 * The page renders immediately for everyone and the effect below replaces the
 * route once the probe answers. A signed-in user therefore sees this for the
 * length of one refresh call — which is the honest trade, because the
 * alternative is a hold screen, and a hold screen shown to EVERY visitor to
 * spare a returning one a glimpse of the landing page is the spinner wall
 * DESIGN.md §10 forbids.
 */

/**
 * What the product actually does, in three claims that are each true of the
 * shipped app rather than of a roadmap: sync-core drives one clock per room,
 * the call docks in the rail and never covers the stage (§11 D1), and there is
 * no public directory or tracking (see /legal/privacy).
 */
const PILLARS: readonly { over: string; title: string; body: string }[] = [
  {
    over: 'Playback',
    title: 'One clock',
    body: 'A seek, a pause or a skip lands for the whole room at the same moment — not just for whoever pressed it.',
  },
  {
    over: 'Presence',
    title: 'Beside the picture',
    body: 'Voice, video and chat dock in the rail. The call sits next to what you came to watch and never covers it.',
  },
  {
    over: 'Privacy',
    title: 'Invite-only',
    body: 'No public directory, no trackers, nothing to buy. A room is reachable only through a link one of you sent.',
  },
];

export default function RootPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading || user === null) return;
    router.replace('/home');
  }, [user, loading, router]);

  return (
    <div className="flex min-h-dvh flex-col px-6 lg:px-12">
      <header className="flex items-center py-6">
        <Wordmark size={30} />
      </header>

      {/* The one hero on the page, and the one display setting on this screen
          (DESIGN.md §3: `hero` is auth and marketing only, one per page). */}
      {/* Composition rungs halve below `md` (see app/home/page.tsx). */}
      <main className="flex flex-1 flex-col justify-center py-12 md:py-chapter">
        <p className="text-caption text-low">Self-hosted watch parties</p>
        <h1 className="mt-6 max-w-4xl font-display text-hero text-hi">
          A private cinema for the people you already know.
        </h1>
        <p className="mt-8 max-w-xl text-body text-mid">
          Synced playback, a call and a chat in one invite-only room. It runs on your own
          server, so the room is yours — there is no directory to be found in and no account
          level to buy.
        </p>
        {/* One primary action, and the only aurora in this region: the brand
            mark up in the header is the other sanctioned one (§2). */}
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link href="/login" className={buttonClasses({ size: 'lg' })}>
            Sign in
          </Link>
          <span className="text-label text-low">No password — we email you a link.</span>
        </div>
      </main>

      <section aria-label="What Gather does" className="grid gap-4 pb-8 md:grid-cols-3 md:pb-section">
        {PILLARS.map((pillar) => (
          <article key={pillar.title} className="rounded-panel bg-surface-1 p-8">
            <p className="text-caption text-low">{pillar.over}</p>
            <h2 className="mt-3 font-display text-title text-hi">{pillar.title}</h2>
            <p className="mt-2 text-body text-mid">{pillar.body}</p>
          </article>
        ))}
      </section>

      <footer className="flex flex-wrap items-center gap-6 border-t border-hairline py-8 text-label text-low">
        <span>Gather</span>
        <nav aria-label="Legal" className="flex gap-6">
          <Link className="transition-colors hover:text-hi" href="/legal/terms">
            Terms
          </Link>
          <Link className="transition-colors hover:text-hi" href="/legal/privacy">
            Privacy
          </Link>
          <Link className="transition-colors hover:text-hi" href="/legal/abuse">
            Abuse
          </Link>
        </nav>
      </footer>
    </div>
  );
}
