'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { Logo } from '@/components/Logo';

/** Entry point: route to /home when signed in (guests included), else /login. */
export default function RootPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    router.replace(user === null ? '/login' : '/home');
  }, [user, loading, router]);

  return (
    <main className="flex min-h-dvh items-center justify-center">
      <Logo size={56} className="animate-pulse" />
      <span className="sr-only">Loading Playin…</span>
    </main>
  );
}
