'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '@gather/api-client';
import { formatInviteCode } from '@gather/contracts';
import type { InviteCode } from '@gather/contracts';
import { api, guestJoin } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/Logo';

/**
 * Guest join: pick a display name → POST /auth/guest (sets the httpOnly
 * refresh cookie + returns the room) → /room/[id]. Signed-in users join
 * through their account instead.
 */
export function JoinClient({ code }: { code: InviteCode }) {
  const router = useRouter();
  const { user, loading, setUser } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describe = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === 'NOT_FOUND') return 'This invite code is invalid or has expired.';
      if (err.code === 'FORBIDDEN') return 'You are banned from this room.';
      if (err.code === 'RATE_LIMITED') return 'Too many attempts — wait a minute and try again.';
    }
    return 'Could not join the room. Try again.';
  };

  const joinAsGuest = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await guestJoin({ inviteCode: code, displayName: displayName.trim() });
      setUser(res.user);
      router.replace(`/room/${res.room.id}`);
    } catch (err) {
      setError(describe(err));
      setPending(false);
    }
  };

  const joinAsMember = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.rooms.joinRoom({ inviteCode: code });
      router.replace(`/room/${res.room.id}`);
    } catch (err) {
      setError(describe(err));
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel w-full max-w-md p-8 shadow-glow">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={52} />
          <h1 className="font-display text-display font-bold">You’re invited</h1>
          <p className="font-mono text-sm tracking-widest text-aurora-1">{formatInviteCode(code)}</p>
        </div>

        {loading ? null : user !== null ? (
          <div className="flex flex-col gap-4">
            <p className="text-center text-sm text-mid">
              Joining as <span className="font-semibold text-hi">{user.displayName}</span>
            </p>
            <Button size="lg" disabled={pending} onClick={() => void joinAsMember()}>
              {pending ? 'Joining…' : 'Join the room'}
            </Button>
          </div>
        ) : (
          <form onSubmit={(e) => void joinAsGuest(e)} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-mid">Display name</span>
              <Input
                required
                minLength={1}
                maxLength={80}
                autoFocus
                placeholder="What should everyone call you?"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                }}
              />
            </label>
            <Button type="submit" size="lg" disabled={pending || displayName.trim().length === 0}>
              {pending ? 'Joining…' : 'Join as guest'}
            </Button>
            <p className="text-center text-xs text-low">
              Guests are room-scoped. You can attach an email later to keep your identity.
            </p>
          </form>
        )}

        {error !== null && (
          <p role="alert" className="mt-4 text-center text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
