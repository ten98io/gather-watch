import Link from 'next/link';
import type { ReactNode } from 'react';
import { Wordmark } from '@/components/Logo';

/**
 * The legal shell.
 *
 * These three pages are the only long-form reading in the product, and they
 * were set at 14px on a glass panel with heading sizes (`text-2xl`, `text-lg`)
 * that exist nowhere else in the system — Tailwind core leaking back in beside
 * a ramp that already has a step for every one of them. They are documents
 * now: `display` for the document's name, `title` for its sections, `body` for
 * the prose, and a measure narrow enough to actually read.
 *
 * The descendant selectors are the whole reason this file exists — each page
 * is plain semantic HTML, so the shell is the single place their typography is
 * decided and no page can drift from the other two.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 lg:px-10">
      <header className="flex flex-wrap items-center gap-6 py-6">
        <Link href="/" aria-label="Gather home">
          <Wordmark size={30} />
        </Link>
        <nav aria-label="Legal" className="ml-auto flex gap-6 text-label text-low">
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
      </header>

      {/* Composition rungs halve below `md` (see app/home/page.tsx). */}
      <main className="flex-1 pt-12 md:pt-chapter">
        <article
          className={[
            // No grain, deliberately: these are the only long-form READING
            // surfaces in the product, and §4 puts the texture on the void and
            // on quiet surfaces, never behind text.
            'flex flex-col gap-6 rounded-stage bg-surface-1 px-6 py-section text-body text-mid md:py-canvas lg:px-12',
            // The document's one display setting (§3: `display` names the one
            // thing a screen is about, and on a legal page that is the document).
            '[&_h1]:font-display [&_h1]:text-headline [&_h1]:text-hi [&_h1]:mb-2 md:[&_h1]:text-display',
            // The rhythm rides on the article's own `gap-6`: `mt-8` on top of it
            // puts 56px above a section head and 24 below. That asymmetry is the
            // point — a heading belongs to what follows it, not to what it ends.
            '[&_h2]:font-display [&_h2]:text-title [&_h2]:text-hi [&_h2]:mt-8',
            // Every page opens with an <em> standfirst, which is a dateline
            // rather than emphasis — set as one instead of italicised.
            '[&_em]:not-italic [&_em]:text-low',
            '[&_strong]:text-hi',
          ].join(' ')}
        >
          {children}
        </article>
      </main>

      <footer className="mt-8 border-t border-hairline py-8 text-label text-low md:mt-section">
        <Link className="transition-colors hover:text-hi" href="/home">
          Back to your rooms
        </Link>
      </footer>
    </div>
  );
}
