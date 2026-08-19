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
import { Button, buttonClasses } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Wordmark } from '@/components/Logo';

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
 * The room passphrase field.
 *
 * It stays on THIS screen and is never a second page: DESIGN.md §12 budgets a
 * password-gated join at 3 interactions precisely because the passphrase is a
 * field fill on the invite screen rather than a navigation. It is also always
 * rendered rather than revealed, because nothing here can know whether the room
 * has one — the server answers a wrong passphrase and an unknown invite code
 * with the same NOT_FOUND, and there is no invite-preview endpoint, so a
 * "does this room need a password?" probe would be a lie dressed as a question.
 *
 * `autoComplete="off"`: this is the ROOM's passphrase, not the person's, and a
 * password manager offering their account password here would be filling the
 * wrong secret into a field that is sent to a room's members.
 */
function RoomPassword({ value, onChange }: { value: string; onChange(next: string): void }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-label text-mid">Room password</span>
      <Input
        type="password"
        inputSize="lg"
        autoComplete="off"
        placeholder="Only if this room has one"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </label>
  );
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
 *
 * ── The composition (2026-08-19) ──────────────────────────────────────────
 * This is how every second person ever arrives at Gather, and it was a 448px
 * card with a glow. The invite is now the screen: the page's one display
 * setting says what happened, the code is set beside it as an object rather
 * than as a violet caption, and the form sits on its own plate underneath. The
 * code used to be `text-aurora-1`, which is a 3:1 colour and forbidden as text
 * on Daylight (DESIGN.md §2) — the accent is carried by the chip's ring now.
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

  /**
   * The way out for someone who already HAS an account.
   *
   * Without it this screen offered exactly one identity to a signed-out
   * visitor — a throwaway guest — so a member opening an invite either took a
   * second, room-scoped identity under their own name or navigated away and
   * lost the code. `?next=` is what makes leaving safe: /login hands it to
   * lib/after-signin.ts and /auth/verify lands them back on this invitation.
   *
   * It is a LINK and not a second button, deliberately. §8 allows one primary
   * per screen region and it is spent on the action most people here want; a
   * second aurora beside it would make both read as "a button".
   */
  const signInHref = `/login?next=${encodeURIComponent(`/join/${code}`)}`;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6">
      <header className="py-6">
        <Link href="/" aria-label="Gather home">
          <Wordmark size={30} />
        </Link>
      </header>

      {/* Composition rungs halve below `md` (see app/home/page.tsx). */}
      <main className="flex flex-1 flex-col justify-center gap-8 py-12 md:gap-section md:py-chapter">
        <div>
          <p className="text-caption text-low">Invitation</p>
          <h1 className="mt-4 font-display text-headline text-hi md:text-display">You’re invited.</h1>
          <p className="mt-8">
            <span className="inline-block rounded-ctl bg-surface-2 px-4 py-2 font-mono text-title text-hi ring-1 ring-accent">
              {formatInviteCode(code)}
            </span>
          </p>
        </div>

        {/* No grain: this plate carries a form. §4 keeps the texture for the
            void and for large quiet surfaces, and the void already has it. */}
        <div className="rounded-stage bg-surface-1 p-8">
          {loading ? null : ownRoomId !== null ? (
            <div className="flex flex-col gap-6">
              <p className="text-body text-mid">
                You’re already a guest here — the identity you have still works.
              </p>
              <Link
                href={`/room/${ownRoomId}`}
                className={buttonClasses({ size: 'lg', className: 'w-full' })}
              >
                Open the room
              </Link>
            </div>
          ) : !guestPath ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void joinAsMember();
              }}
              className="flex flex-col gap-6"
            >
              <p className="text-body text-mid">
                Joining as <span className="text-hi">{user?.displayName}</span>
              </p>
              <RoomPassword value={password} onChange={setPassword} />
              <Button type="submit" size="lg" className="w-full" disabled={pending}>
                {pending ? 'Joining…' : 'Join the room'}
              </Button>
            </form>
          ) : (
            <form onSubmit={(e) => void joinAsGuest(e)} className="flex flex-col gap-6">
              {isGuest && (
                <div className="rounded-card bg-surface-2 p-5">
                  <p className="text-body text-hi">A guest identity belongs to one room.</p>
                  <p className="mt-2 text-body text-mid">
                    You’re a guest elsewhere, so that identity can’t come with you. Joining here
                    creates a new guest and signs this browser out of your other room. Add an
                    email to that identity first if you want to keep it.
                  </p>
                </div>
              )}
              <label className="flex flex-col gap-2">
                <span className="text-label text-mid">Display name</span>
                <Input
                  required
                  minLength={1}
                  maxLength={80}
                  autoFocus
                  inputSize="lg"
                  placeholder="What should everyone call you?"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                  }}
                />
              </label>
              <RoomPassword value={password} onChange={setPassword} />
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={pending || displayName.trim().length === 0}
              >
                {pending ? 'Joining…' : 'Join as guest'}
              </Button>
              <div className="flex flex-col gap-2 border-t border-hairline pt-6 text-label text-low">
                <p>Guests are room-scoped. Attach an email later to keep the identity.</p>
                <p>
                  Already have an account?{' '}
                  {/* Underlined, not merely coloured: it is inline in a
                      sentence, and colour alone is not an affordance (WCAG
                      1.4.1). The rule firms up on hover rather than the text
                      changing colour, so nothing moves. */}
                  <Link
                    href={signInHref}
                    className="text-hi underline decoration-hairline underline-offset-4 transition-colors hover:decoration-current"
                  >
                    Sign in instead
                  </Link>{' '}
                  — you’ll land back on this invitation.
                </p>
              </div>
            </form>
          )}

          {error !== null && (
            <p role="alert" className="mt-6 text-label text-danger">
              {error}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
