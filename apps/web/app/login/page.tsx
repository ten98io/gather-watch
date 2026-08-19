'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '@gather/api-client';
import { requestMagicLink } from '@/lib/api';
import { DEFAULT_AFTER_SIGNIN, rememberAfterSignIn, safeAfterSignIn } from '@/lib/after-signin';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Wordmark } from '@/components/Logo';

/**
 * Read `?next=` once, at mount.
 *
 * NOT `useSearchParams`: that hook forces the route past the nearest Suspense
 * boundary into client rendering, and this page has real static content — the
 * wordmark, the display setting, the statement under it — that a signed-out
 * visitor should get in the HTML rather than after hydration. `next` is not
 * needed until the form is submitted, which is long after that.
 *
 * The lazy initialiser cannot desync hydration, because `next` reaches no
 * markup on the first render: the only sentence it changes lives in the
 * "Sent" branch, which needs a submit to exist.
 */
function useNextParam(): string | null {
  const [next] = useState<string | null>(() =>
    typeof window === 'undefined'
      ? null
      : safeAfterSignIn(new URLSearchParams(window.location.search).get('next')),
  );
  return next;
}

/**
 * Sign in.
 *
 * ── Why this is two columns and not a card ────────────────────────────────
 * It was a 448px glass card centred on an empty void with a 40px glow under
 * it — the shape every SaaS auth screen has, and one that says nothing about
 * the product it is the door to. The re-composition splits the screen: the
 * left column is what this place IS and carries the one display setting on the
 * screen, the right column is the mechanism. Below `lg` the two stack in that
 * order, so the statement still arrives first.
 *
 * `text-display` and not `text-hero`: `hero` is spent once in the product, on
 * the front door at `/`. A screen that exists to take one email address should
 * not open at 88px.
 *
 * ── The round trip ────────────────────────────────────────────────────────
 * An invite link is how most people meet Gather, and someone who already has
 * an account has to leave the invite to sign in. `?next=` is what brings them
 * back: it is honoured directly when the session turns out to be live already,
 * and otherwise handed to lib/after-signin.ts, because the magic link's URL is
 * built by the server and cannot carry it. Validation lives there — this file
 * never navigates to a string it has not passed through `safeAfterSignIn`.
 */
export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const next = useNextParam();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user !== null) router.replace(next ?? DEFAULT_AFTER_SIGNIN);
  }, [user, loading, router, next]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await requestMagicLink(email.trim());
      // Only once the link is actually out. Remembering on mount would divert
      // a sign-in the person then abandoned, on their next visit.
      rememberAfterSignIn(next);
      setSentTo(email.trim());
      setDevLink(res.devLink);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'RATE_LIMITED'
          ? 'Too many attempts — wait a minute and try again.'
          : 'Could not send the link. Check the address and try again.',
      );
    } finally {
      setPending(false);
    }
  };

  /** The only destination this screen names out loud, and the only one that
   *  can be named honestly — `/join/<code>` is the one route whose purpose a
   *  path alone reveals. */
  const returningToInvite = next !== null && next.startsWith('/join/');

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[1.1fr_1fr]">
      <section className="flex flex-col justify-between px-6 py-8 lg:px-12 lg:py-10">
        <Link href="/" aria-label="Gather home">
          <Wordmark size={30} />
        </Link>

        {/* Composition rungs halve below `md` (see app/home/page.tsx). */}
        <div className="py-12 md:py-chapter">
          <p className="text-caption text-low">{sentTo === null ? 'Sign in' : 'Sent'}</p>
          <h1 className="mt-5 max-w-lg font-display text-headline text-hi md:text-display">
            {sentTo === null ? 'Step inside.' : 'Check your inbox.'}
          </h1>
          <p className="mt-6 max-w-md text-body text-mid">
            {sentTo === null
              ? 'Gather has no passwords to forget. Give us the address you want the room invites to land at, and we email you a link that signs this browser in.'
              : `The link is on its way to ${sentTo}. It expires shortly, and opening it signs you in${
                  // Say where it lands, because the person did not come here
                  // for a sign-in screen — they came for an invitation, and
                  // "you'll be back where you were" is the reassurance that
                  // stops them hunting for the link a second time.
                  returningToInvite ? ' and puts you back at the invitation.' : ' here.'
                }`}
          </p>
        </div>

        <nav aria-label="Legal" className="flex gap-6 text-label text-low">
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
      </section>

      <section className="flex items-center px-6 pb-12 lg:px-12 lg:py-10">
        {/* No grain. DESIGN.md §4 allows it on the void and on large QUIET
            surfaces — a stage plate, a full-bleed empty state, a sheet — and a
            plate carrying a form and its label is none of those. The texture is
            already under this whole screen, on the void behind it. */}
        <div className="w-full rounded-stage bg-surface-1 p-8 lg:max-w-md lg:p-10">
          {sentTo === null ? (
            <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-6">
              <label className="flex flex-col gap-2">
                <span className="text-label text-mid">Email address</span>
                <Input
                  type="email"
                  required
                  inputSize="lg"
                  autoComplete="email"
                  autoFocus
                  invalid={error !== null}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                />
              </label>
              {error !== null && (
                <p role="alert" className="text-label text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={pending || loading}>
                {pending ? 'Sending…' : 'Email me a link'}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-6">
              {devLink !== null && (
                // The accent is a RING here, never the text colour: on Daylight
                // `--accent` clears the 3:1 non-text bar and not the 4.5:1 text
                // bar, so `text-aurora-1` — what this link used to be — was a
                // failing colour on half the product (DESIGN.md §2).
                <a
                  href={devLink}
                  className="block rounded-ctl bg-surface-2 p-4 text-center text-label text-hi ring-1 ring-accent transition-colors hover:bg-surface-3"
                >
                  Dev build — open the magic link directly →
                </a>
              )}
              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                onClick={() => {
                  setSentTo(null);
                  setDevLink(null);
                }}
              >
                Use a different email
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
