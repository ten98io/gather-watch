'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { verifyToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/Logo';

type VerifyState = 'verifying' | 'failed';

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser } = useAuth();
  const [state, setState] = useState<VerifyState>('verifying');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React strict-mode double effect
    started.current = true;
    const token = params.get('token');
    if (token === null || token.length === 0) {
      setState('failed');
      return;
    }
    verifyToken(token)
      .then((session) => {
        setUser(session.user);
        router.replace('/home');
      })
      .catch(() => {
        setState('failed');
      });
  }, [params, router, setUser]);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-sm flex-col items-center gap-4 p-8 text-center shadow-glow">
        <Logo size={48} className={state === 'verifying' ? 'animate-pulse' : ''} />
        {state === 'verifying' ? (
          <>
            <h1 className="font-display text-xl font-semibold">Opening your link…</h1>
            <p className="text-sm text-mid">Signing you in.</p>
          </>
        ) : (
          <>
            <h1 className="font-display text-xl font-semibold">That link didn’t work</h1>
            <p className="text-sm text-mid">
              Magic links expire and can only be used once. Request a fresh one.
            </p>
            <Link href="/login" className="w-full">
              <Button className="w-full" size="lg">
                Back to sign in
              </Button>
            </Link>
          </>
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
