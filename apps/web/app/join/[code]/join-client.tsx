'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '@gather/api-client';
import { formatInviteCode } from '@gather/contracts';
import type { InviteCode, RoomId } from '@gather/contracts';
import { api, guestJoin } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/Logo';

/**
 * Why a failed join failed, in words that are true of THIS failure.
 *
 * Exported because two of these carry weight beyond the copy:
 *
 *  • FORBIDDEN IS NOT A SYNONYM FOR "BANNED". `POST /rooms/join` is
 *    `requireAccount`, which refuses every guest with 'full account required'
 *    before it even reads the invite code — and this function used to answer
 *    that with "You are banned from this room", inventing a moderation event
 *    that never happened. The server says which it is; read it.
 *  • CONFLICT is a unique-index violation from the store, and "Try again" is
 *    the one thing that never fixes one: the same name, retried, collides
 *    identically forever. Name the field the person has to change.
 *  • NOT_FOUND also covers a wrong room password: the server answers a bad
 *    passphrase with the same 'invite not found' it gives an unknown code, so
 *    the code's validity cannot be probed through the error shape — and the
 *    copy must not claim to know which of the two failed.
 */
export function describeJoinFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'NOT_FOUND')
      return 'This invite code is invalid, expired, or the password is wrong.';
    if (err.code === 'FORBIDDEN') {
      if (/banned/i.test(err.message)) {
        return 'A host or moderator banned you from this room.';
      }
      return 'This room is not open to the identity you are signed in with.';
    }
    if (err.code === 'CONFLICT') {
      return 'That display name is already taken in this room — pick another one.';
    }
    if (err.code === 'RATE_LIMITED') return 'Too many attempts — wait a minute and try again.';
  }
  return 'Could not join the room. Try again.';
}

/**
 * Guest join: pick a display name → POST /auth/guest (sets the httpOnly
 * refresh cookie + returns the room) → /room/[id]. Signed-in ACCOUNTS join
 * through their account instead.
 *
 * A GUEST IS NOT AN ACCOUNT, and that distinction is the whole of this file's
 * second job. A guest token is scoped to one room (`assertGuestScope`, and
 * `requireAccount` on the join route), so offering a guest the "Join the room"
 * button was offering a button that fails 100% of the time — and the failure
 * was then reported as a ban. What works instead is `POST /auth/guest`, which
 * takes no authentication at all and mints a fresh room-scoped guest. That is
 * the path this page gives them: let them proceed, and be honest about the
 * price, which is real — the new guest overwrites this browser's refresh
 * cookie and access token, so the room they are in now becomes unreachable
 * unless they attach an email to that identity first.
 *
 * And the cheap case first: a guest who re-opens their OWN room's link is sent
 * back into that room rather than handed a second throwaway identity in it.
 */
export function JoinClient({ code }: { code: InviteCode }) {
  const router = useRouter();
  const { user, loading, isGuest, setUser } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when this link is the invite of the room the guest is ALREADY in.
   * `GET /rooms` is `requireAuth` with no scope check, and serialized rooms
   * carry their invite code, so this costs one request and no new endpoint.
   * A failure here is not worth reporting: it only means we fall through to
   * the join path, which is where an unrecognised code belongs anyway.
   */
  const [ownRoomId, setOwnRoomId] = useState<RoomId | null>(null);

  useEffect(() => {
    if (!isGuest) return;
    let live = true;
    void api.rooms.listMyRooms().then(
      ({ rooms }) => {
        if (!live) return;
        const match = rooms.find(
          ({ room }) => room.inviteCode.toUpperCase() === code.toUpperCase(),
        );
        setOwnRoomId(match?.room.id ?? null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [isGuest, code]);

  const joinAsGuest = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await guestJoin({
        inviteCode: code,
        displayName: displayName.trim(),
        // exactOptionalPropertyTypes: never write an explicit undefined.
        ...(password.length > 0 ? { password } : {}),
      });
      setUser(res.user);
      router.replace(`/room/${res.room.id}`);
    } catch (err) {
      setError(describeJoinFailure(err));
      setPending(false);
    }
  };

  const joinAsMember = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.rooms.joinRoom({
        inviteCode: code,
        ...(password.length > 0 ? { password } : {}),
      });
      router.replace(`/room/${res.room.id}`);
    } catch (err) {
      setError(describeJoinFailure(err));
      setPending(false);
    }
  };

  /** A guest may only take the guest path; an account may only take its own. */
  const guestPath = user === null || isGuest;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel w-full max-w-md p-8 shadow-glow">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={52} />
          <h1 className="font-display text-display font-bold">You’re invited</h1>
          <p className="font-mono text-sm tracking-widest text-aurora-1">{formatInviteCode(code)}</p>
        </div>

        {loading ? null : ownRoomId !== null ? (
          <div className="flex flex-col gap-4">
            <p className="text-center text-sm text-mid">
              You’re already a guest in this room.
            </p>
            <Link href={`/room/${ownRoomId}`}>
              <Button size="lg" className="w-full">
                Open the room
              </Button>
            </Link>
          </div>
        ) : !guestPath ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void joinAsMember();
            }}
            className="flex flex-col gap-4"
          >
            <p className="text-center text-sm text-mid">
              Joining as <span className="font-semibold text-hi">{user?.displayName}</span>
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-mid">Room password (if required)</span>
              <Input
                type="password"
                placeholder="Only needed if the room has a password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? 'Joining…' : 'Join the room'}
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => void joinAsGuest(e)} className="flex flex-col gap-4">
            {isGuest && (
              <div className="rounded-panel bg-surface-2 p-4">
                <p className="text-sm font-medium text-hi">
                  A guest identity belongs to one room.
                </p>
                <p className="mt-1 text-sm text-mid">
                  You’re a guest elsewhere, so that identity can’t come with you. Joining here
                  creates a new guest and signs this browser out of your other room. Add an email
                  to that identity first if you want to keep it.
                </p>
              </div>
            )}
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
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-mid">Room password (if required)</span>
              <Input
                type="password"
                placeholder="Only needed if the room has a password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
