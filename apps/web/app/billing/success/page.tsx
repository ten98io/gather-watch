import Link from 'next/link';
import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/Logo';

export const metadata: Metadata = { title: 'Welcome to Premium' };

export default function BillingSuccessPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow-lg">
        <Logo size={56} />
        <h1 className="font-display text-display font-bold">Theater mode unlocked</h1>
        <p className="text-sm text-mid">
          Premium is active on your account — bigger rooms, more people on camera, higher
          upload limits. In Theater rooms the stage badge reads “Relayed · Theater” instead
          of “Private · device-to-device”.
        </p>
        <Link href="/home" className="w-full">
          <Button size="lg" className="w-full">Back to your rooms</Button>
        </Link>
      </div>
    </main>
  );
}
