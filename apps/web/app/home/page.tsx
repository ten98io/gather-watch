'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminOverviewResponse, CreateRoomResponse, normalizeInviteCode } from '@gather/contracts';
import { api, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/hooks/useTheme';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BellOffIcon, MoonIcon, OrbitIcon, PlusIcon, SunIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { Wordmark } from '@/components/Logo';

function CreateRoomDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      // No mode choice: every room is just a room — the stage adapts to what
      // plays. Posted without `kind`; the server defaults the deprecated
      // stored field. (apiFetch rather than the RestClient: its body type
      // still requires the parsed `kind`.)
      const { room } = await apiFetch('/rooms', {
        method: 'POST',
        body: { name: name.trim() },
        schema: CreateRoomResponse,
      });
      await queryClient.invalidateQueries({ queryKey: ['rooms'] });
      router.push(`/room/${room.id}`);
    } catch {
      toast.error('Couldn’t create the room. Try again.');
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Create a room">
        <DialogTitle>New room</DialogTitle>
        <DialogDescription>
          A private space with one queue and one clock. Nobody can find it — you invite them.
        </DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="mt-8 flex flex-col gap-6">
          <label className="flex flex-col gap-2">
            <span className="text-label text-mid">Room name</span>
            <Input
              required
              maxLength={120}
              autoFocus
              inputSize="lg"
              placeholder="Friday night premieres"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </label>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={pending || name.trim().length === 0}
          >
            {pending ? 'Creating…' : 'Create room'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The page's one display setting (DESIGN.md §3) plus whatever action belongs
 * beside it. Rendered on every state EXCEPT the empty one, which is its own
 * poster and carries the display step itself — so the screen never has two.
 */
function Masthead({ overline, children }: { overline: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="text-caption text-low">{overline}</p>
        <h1 className="mt-4 font-display text-headline text-hi md:text-display">Your rooms</h1>
      </div>
      {children}
    </div>
  );
}

/** The invite-code field. Two steps from here to inside a room (§12). */
function JoinByCode({
  code,
  onCodeChange,
  onSubmit,
  className,
}: {
  code: string;
  onCodeChange(next: string): void;
  onSubmit(e: FormEvent): void;
  className?: string;
}) {
  return (
    <form onSubmit={onSubmit} className={className}>
      <Input
        aria-label="Invite code"
        placeholder="Invite code"
        className="font-mono uppercase"
        inputSize="lg"
        maxLength={16}
        value={code}
        onChange={(e) => {
          onCodeChange(e.target.value);
        }}
      />
      <Button type="submit" variant="secondary" size="lg" disabled={code.trim().length === 0}>
        Join
      </Button>
    </form>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState('');

  const roomsQuery = useQuery({
    queryKey: ['rooms'],
    queryFn: () => api.rooms.listMyRooms(),
    enabled: user !== null,
  });

  /** Admin probe: the Owner console menu entry renders only when the API
   *  confirms this account is on ADMIN_EMAILS (403 otherwise). */
  const adminProbe = useQuery({
    queryKey: ['admin-probe'],
    queryFn: () => apiFetch('/admin/overview', { schema: AdminOverviewResponse }),
    enabled: user !== null,
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!loading && user === null) router.replace('/login');
  }, [user, loading, router]);

  const joinByCode = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeInviteCode(code);
    if (normalized.length === 0) return;
    router.push(`/join/${encodeURIComponent(normalized)}`);
  };

  const rooms = roomsQuery.data?.rooms ?? [];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-6 lg:px-10">
      <header className="flex items-center gap-4 py-6">
        <Link href="/home" aria-label="Gather home">
          <Wordmark size={30} />
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === 'dark' ? 'Switch to Daylight' : 'Switch to dark'}
            onClick={toggle}
          >
            {theme === 'dark' ? <MoonIcon size={18} /> : <SunIcon size={18} />}
          </Button>
          {user !== null && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Account menu">
                <Avatar
                  src={user.avatarUrl}
                  name={user.displayName}
                  accentColor={user.accentColor}
                  size={36}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  onSelect={() => {
                    router.push('/settings');
                  }}
                >
                  Settings
                </DropdownMenuItem>
                {adminProbe.isSuccess && (
                  <DropdownMenuItem
                    onSelect={() => {
                      router.push('/admin');
                    }}
                  >
                    Owner console
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  destructive
                  onSelect={() => {
                    void logout().then(() => {
                      router.replace('/login');
                    });
                  }}
                >
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {/* The rhythm is the composition: `chapter` above the masthead, `section`
          between it and the grid, `lg` inside the grid. Uniform gaps are what
          told the reader that nothing here mattered more than anything else
          (DESIGN.md §4).

          THE COMPOSITION RUNGS HALVE BELOW `md`, and every halved value is
          another rung of the same ramp: `section` 64 → `xxl` 32 (`gap-8`),
          `chapter` 96 → `xxxl` 48 (`pt-12`), `canvas` 128 → `section` 64. The
          three of them were drawn for a ~1440px canvas; spent unchanged on a
          375px one they are not editorial whitespace, they are a dead band —
          96px of nothing above a masthead is a quarter of the screen. This is
          the pattern every surface in the app uses; it is written out here
          once and stated in one line everywhere else. */}
      <main className="flex flex-1 flex-col gap-8 pt-12 md:gap-section md:pt-chapter">
        {roomsQuery.isPending ? (
          <>
            <Masthead overline="Loading" />
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading rooms">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <Skeleton radius="panel" className="h-40" />
                </li>
              ))}
            </ul>
          </>
        ) : roomsQuery.isError ? (
          <>
            <Masthead overline="Offline" />
            <div role="alert" className="rounded-panel bg-surface-1 p-8">
              <p className="text-body text-mid">
                Couldn’t load your rooms — check your connection.
              </p>
              <Button
                variant="secondary"
                className="mt-6"
                onClick={() => void roomsQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          </>
        ) : rooms.length === 0 ? (
          /* THE SIGNATURE EMPTY STATE. An empty home is the first impression
             every new account gets, and it used to be two grey sentences in a
             glass box. It is now the whole screen: a stage-radius plate at
             canvas scale, the grain the rest of the product wears, and the
             page's one display setting spent on the thing the screen is
             actually about. It carries the ONLY primary action here, which is
             why the masthead's is not rendered in this branch — one aurora per
             region, and no CTA said twice on one screen (§2, §8). */
          <section className="grain flex flex-col items-center gap-8 rounded-stage bg-surface-1 px-6 py-section text-center md:py-canvas">
            <span
              aria-hidden
              className="grid h-14 w-14 place-items-center rounded-full bg-surface-2 text-low"
            >
              <OrbitIcon size={24} />
            </span>
            <div className="flex flex-col items-center gap-4">
              <p className="text-caption text-low">Your rooms</p>
              <h1 className="font-display text-headline text-hi md:text-display">The void is quiet.</h1>
              <p className="max-w-md text-body text-mid">
                A room is a private space with one queue, one clock and the people you invite.
                Make the first one — you can bring them in from inside it.
              </p>
            </div>
            <Button
              size="lg"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              <PlusIcon size={16} />
              Create a room
            </Button>
            <div className="w-full max-w-sm border-t border-hairline pt-8">
              <p className="mb-4 text-label text-low">Someone sent you a code?</p>
              <JoinByCode
                code={code}
                onCodeChange={setCode}
                onSubmit={joinByCode}
                className="flex gap-2"
              />
            </div>
          </section>
        ) : (
          <>
            <Masthead overline={`${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'}`}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <Button
                  size="lg"
                  onClick={() => {
                    setCreateOpen(true);
                  }}
                >
                  <PlusIcon size={16} />
                  New room
                </Button>
                <span aria-hidden className="hidden h-8 w-px bg-hairline sm:block" />
                <JoinByCode
                  code={code}
                  onCodeChange={setCode}
                  onSubmit={joinByCode}
                  className="flex gap-2 sm:w-64"
                />
              </div>
            </Masthead>

            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {rooms.map(({ room, unreadCount, memberCount, muted }) => (
                <li key={room.id}>
                  {/* A card is a resting surface: it separates by background
                      STEP, not by a border and not by a shadow (DESIGN.md §4).
                      The `hover:shadow-glow` this used to carry put a signature
                      moment under an ordinary list item. */}
                  <Link
                    href={`/room/${room.id}`}
                    className="flex h-full flex-col justify-between gap-8 rounded-panel bg-surface-1 p-6 transition-colors duration-150 hover:bg-surface-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-display text-title text-hi">{room.name}</h2>
                      {unreadCount > 0 && (
                        // Flat `--accent`, not `.aurora-gradient`: the gradient
                        // has a budget of three and an unread count is not one
                        // of them (§2). `--ink-on-accent` is the ink measured
                        // against that fill, so this survives a room retinting
                        // the accent to its artwork.
                        <span
                          aria-label={`${unreadCount} unread messages`}
                          className="inline-flex shrink-0 items-center rounded-pill bg-accent px-2 py-0.5 text-caption tabular-nums text-[var(--ink-on-accent)]"
                        >
                          {unreadCount > 99 ? '99+' : unreadCount}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-label text-low">
                      <span>
                        {memberCount} {memberCount === 1 ? 'person' : 'people'}
                      </span>
                      {muted && (
                        <>
                          <span aria-hidden>·</span>
                          <BellOffIcon size={14} />
                          <span className="sr-only">Notifications muted</span>
                        </>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>

      <footer className="mt-8 flex flex-wrap items-center gap-6 border-t border-hairline py-8 text-label text-low md:mt-section">
        <nav aria-label="Legal" className="flex gap-6">
          <Link className="transition-colors hover:text-hi" href="/legal/terms">
            Terms
          </Link>
          <Link className="transition-colors hover:text-hi" href="/legal/privacy">
            Privacy
          </Link>
          <Link className="transition-colors hover:text-hi" href="/legal/abuse">
            Abuse
          </Link>
        </nav>
      </footer>

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
