'use client';

/**
 * The magic link, opened.
 *
 * ── What this screen is FOR, and what it got wrong ────────────────────────
 * It is the hinge of the sign-in round trip, and it used to end every one of
 * them at /home. That is invisible on the flow it was written for — someone
 * who went to /login on purpose — and it silently breaks the flow that
 * actually matters: an invite link is how most people meet Gather, and
 * somebody who already has an account had to leave the invitation to sign in
 * and was then landed somewhere else, with the code they arrived with gone.
 * `takeAfterSignIn()` is the other half of that journey (lib/after-signin.ts);
 * the destination is validated there, and this file navigates to nothing else.
 *
 * It is consumed ONCE, before the token is even sent, and re-emitted into the
 * failure branch's href. That ordering is deliberate: a link that expired
 * sends the person back to /login for a fresh one, and if the destination were
 * left in storage instead, the second request — which has no `?next=` of its
 * own — would clear it and drop them at /home after all.
 *
 * ── The composition ───────────────────────────────────────────────────────
 * It was a 384px glass card with `shadow-glow`, `text-xl font-semibold` and
 * `text-sm` — glass with no video under it (§4), glow outside a signature
 * moment (§5), and two Tailwind core sizes that are not on the ramp at all
 * (§3). It is now the same plate as app/not-found.tsx and app/error.tsx,
 * because a dead link, a broken render and an expired sign-in are one family
 * of "this is not where you meant to be" and three different apologies read as
 * three different products.
 *
 * The mark is the only thing that differs between the two states, and it is
 * doing work rather than decorating: the brand orb while the token is in
 * flight (this is us, working), the orbit glyph its siblings use once it has
 * failed. Its pulse needs no reduced-motion guard here — the global rule in
 * globals.css collapses every animation to one 0.01ms iteration.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { verifyToken } from '@/lib/api';
import { DEFAULT_AFTER_SIGNIN, takeAfterSignIn } from '@/lib/after-signin';
import { useAuth } from '@/lib/auth';
import { buttonClasses } from '@/components/ui/button';
import { OrbitIcon } from '@/components/ui/icons';
import { Logo } from '@/components/Logo';

type VerifyState = 'verifying' | 'failed';

/** `/login`, carrying the destination forward when there is one to carry. */
function retryHref(destination: string): string {
  return destination === DEFAULT_AFTER_SIGNIN
    ? '/login'
    : `/login?next=${encodeURIComponent(destination)}`;
}

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser } = useAuth();
  const [state, setState] = useState<VerifyState>('verifying');
  const [retry, setRetry] = useState('/login');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React strict-mode double effect
    started.current = true;
    // Read before anything can fail, so both branches agree on where this
    // journey was going.
    const destination = takeAfterSignIn();
    setRetry(retryHref(destination));
    const token = params.get('token');
    if (token === null || token.length === 0) {
      setState('failed');
      return;
    }
    verifyToken(token)
      .then((session) => {
        setUser(session.user);
        router.replace(destination);
      })
      .catch(() => {
        setState('failed');
      });
  }, [params, router, setUser]);

  const verifying = state === 'verifying';
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12 md:py-chapter">
      {/* Composition rungs halve below `md` (see app/home/page.tsx). */}
      <div className="grain flex w-full max-w-xl flex-col items-center gap-8 rounded-stage bg-surface-1 px-8 py-section text-center md:py-canvas">
        {verifying ? (
          <Logo size={56} className="animate-pulse" />
        ) : (
          <span
            aria-hidden
            className="grid h-14 w-14 place-items-center rounded-full bg-surface-2 text-low"
          >
            <OrbitIcon size={24} />
          </span>
        )}
        <div className="flex flex-col items-center gap-4">
          <p className="text-caption text-low">{verifying ? 'Signing you in' : 'Link expired'}</p>
          <h1 className="font-display text-headline text-hi md:text-display">
            {verifying ? 'One moment.' : 'That link is spent.'}
          </h1>
          {/* Nothing while the token is in flight: the overline and heading
              already say what is happening, and narrating the mechanism
              ("handing this browser a session") helped nobody. */}
          {!verifying && (
            <p className="max-w-md text-body text-mid">
              Sign-in links work once and expire quickly — ask for a new one and it picks up
              where you left off.
            </p>
          )}
        </div>
        {/* Nothing to press while the token is in flight: a control that only
            repeats what the page is already doing is noise, and this state
            lasts one request. */}
        {!verifying && (
          <Link href={retry} className={buttonClasses({ size: 'lg' })}>
            Send me a new link
          </Link>
        )}
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyInner />
    </Suspense>
  );
}
