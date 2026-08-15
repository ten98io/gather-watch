import Link from 'next/link';
import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/Logo';

export const metadata: Metadata = { title: 'Checkout canceled' };

export default function BillingCancelPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow">
        <Logo size={56} />
        <h1 className="font-display text-display font-bold">No charge made</h1>
        <p className="text-sm text-mid">
          Checkout was canceled. The Free plan is the full product — mesh physics limits and
          all — so nothing is lost by staying.
        </p>
        <div className="flex w-full gap-2">
          <Link href="/settings" className="flex-1">
            <Button variant="secondary" className="w-full">Settings</Button>
          </Link>
          <Link href="/home" className="flex-1">
            <Button className="w-full">Home</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
