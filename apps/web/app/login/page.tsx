'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '@gather/api-client';
import { requestMagicLink } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/Logo';

export default function LoginPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user !== null) router.replace('/home');
  }, [user, loading, router]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await requestMagicLink(email.trim());
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

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="glass-panel w-full max-w-md p-8 shadow-glow">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={52} />
          <h1 className="font-display text-display font-bold">
            {sentTo === null ? 'Step inside' : 'Check your inbox'}
          </h1>
          <p className="text-sm text-mid">
            {sentTo === null
              ? 'Watch together, from anywhere. No password — we email you a magic link.'
              : `We sent a sign-in link to ${sentTo}. It expires shortly.`}
          </p>
        </div>

        {sentTo === null ? (
          <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-mid">Email</span>
              <Input
                type="email"
                required
                autoComplete="email"
                autoFocus
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            </label>
            {error !== null && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" disabled={pending || loading}>
              {pending ? 'Sending…' : 'Email me a magic link'}
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            {devLink !== null && (
              <a
                href={devLink}
                className="glass-raised block rounded-ctl p-3 text-center text-sm text-aurora-1 transition-colors hover:text-hi"
              >
                Dev build — open the magic link directly →
              </a>
            )}
            <Button
              variant="secondary"
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

      <nav aria-label="Legal" className="mt-6 flex gap-4 text-xs text-low">
        <Link className="transition-colors hover:text-mid" href="/legal/terms">
          Terms
        </Link>
        <Link className="transition-colors hover:text-mid" href="/legal/privacy">
          Privacy
        </Link>
        <Link className="transition-colors hover:text-mid" href="/legal/abuse">
          Abuse
        </Link>
      </nav>
    </main>
  );
}
