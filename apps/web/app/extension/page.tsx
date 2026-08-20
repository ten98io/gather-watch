import Link from 'next/link';
import type { Metadata } from 'next';
import { Wordmark } from '@/components/Logo';

export const metadata: Metadata = { title: 'The Gather extension' };

/**
 * /extension — where every "Add the extension" affordance in the product
 * lands until there is a store listing to land on (docs/FEATURE_PLAN.md §9
 * amendments: `extensionInstallUrl()` must point at an honest docs page
 * rather than silently degrade). It ships with the app, which is what lets
 * the funnel promise a link that always exists.
 *
 * Copy rules, same bar as <ExtensionGate>: plain sentences, no machinery
 * vocabulary, and nothing may overstate what exists — the store listing does
 * not, and this page says so. The one sanctioned exception is the
 * load-unpacked walkthrough, which may name chrome://extensions because that
 * is the literal thing to type.
 *
 * The document shell is the legal layout's, restated: same measure, same
 * ramp, same descendant selectors, because this is the product's fourth
 * long-form reading surface and it must not invent a fifth typography.
 */
export default function ExtensionPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 lg:px-10">
      <header className="flex flex-wrap items-center gap-6 py-6">
        <Link href="/" aria-label="Gather home">
          <Wordmark size={30} />
        </Link>
      </header>

      <main className="flex-1 pt-12 md:pt-chapter">
        <article
          className={[
            'flex flex-col gap-6 rounded-stage bg-surface-1 px-6 py-section text-body text-mid md:py-canvas lg:px-12',
            '[&_h1]:font-display [&_h1]:text-headline [&_h1]:text-hi [&_h1]:mb-2 md:[&_h1]:text-display',
            '[&_h2]:font-display [&_h2]:text-title [&_h2]:text-hi [&_h2]:mt-8',
            '[&_em]:not-italic [&_em]:text-low',
            '[&_strong]:text-hi',
            '[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:flex [&_ol]:flex-col [&_ol]:gap-2',
          ].join(' ')}
        >
          <h1>The Gather extension</h1>
          <p>
            <em>
              It is not on the Chrome Web Store yet. The moment the listing is live, this
              page will link straight to it.
            </em>
          </p>

          <h2>What it does</h2>
          <p>
            A Gather room keeps everyone on the same second. For most links the room’s own
            player does that by itself — no install, nothing to add. The extension is for
            everything else: it drives your own player, in your own tab, on any site you
            already use — including the ones that protect their video, like Netflix or
            Disney+. Everyone plays their own copy, signed in to their own account, and the
            room keeps you all in step.
          </p>
          <p>
            It also lets you share a tab, a window or your whole screen with the room, and
            it carries the room with you — so the people you’re watching with stay in reach
            while you’re on the other site.
          </p>

          <h2>Where to get it</h2>
          <p>
            Nowhere public, for now — the store listing doesn’t exist yet, and we won’t
            pretend otherwise. Until it does, everything the room can play by itself works
            without the extension, and so do chat, voice and the queue. You can be in a room
            with your friends right now.
          </p>

          <h2>If the team gave you a build</h2>
          <p>
            A build from the team can be loaded straight into Chrome on a computer:
          </p>
          <ol>
            <li>
              Open <strong>chrome://extensions</strong> in Chrome.
            </li>
            <li>
              Turn on <strong>Developer mode</strong>, top right.
            </li>
            <li>
              Click <strong>Load unpacked</strong> and pick the build’s{' '}
              <strong>dist</strong> folder.
            </li>
          </ol>
          <p>
            Then reload your room’s tab — Gather notices the extension as the page loads
            (there’s a “check again” button too, if the room got there first).
          </p>
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
