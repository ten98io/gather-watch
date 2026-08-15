import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-4 py-8">
      <header className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Playin home">
          <Logo size={30} />
          <span className="font-display text-lg font-bold">Playin</span>
        </Link>
        <nav aria-label="Legal" className="flex gap-4 text-sm text-low">
          <Link className="transition-colors hover:text-hi" href="/legal/terms">Terms</Link>
          <Link className="transition-colors hover:text-hi" href="/legal/privacy">Privacy</Link>
          <Link className="transition-colors hover:text-hi" href="/legal/abuse">Abuse</Link>
        </nav>
      </header>
      <article className="glass-panel prose-like flex flex-col gap-4 p-8 text-sm leading-relaxed text-mid [&_h1]:font-display [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-hi [&_h2]:font-display [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-hi [&_strong]:text-hi">
        {children}
      </article>
    </main>
  );
}
