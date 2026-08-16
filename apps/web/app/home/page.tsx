'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminOverviewResponse, CreateRoomResponse, normalizeInviteCode } from '@gather/contracts';
import { api, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/hooks/useTheme';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { Logo } from '@/components/Logo';

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
      toast.error('Could not create the room. Try again.');
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Create a room">
        <DialogTitle>New room</DialogTitle>
        <DialogDescription>A private room for your people. Invite-only by design.</DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="mt-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-mid">Room name</span>
            <Input
              required
              maxLength={120}
              autoFocus
              placeholder="Friday night premieres"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </label>
          <Button type="submit" size="lg" disabled={pending || name.trim().length === 0}>
            {pending ? 'Creating…' : 'Create room'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-8 px-4 py-6">
      <header className="flex items-center gap-3">
        <Link href="/home" className="flex items-center gap-2.5">
          <Logo size={34} />
          <span className="font-display text-lg font-bold tracking-tight">Gather</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={toggle}>
            <span aria-hidden>{theme === 'dark' ? '☾' : '☀'}</span>
          </Button>
          {user !== null && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Account menu">
                <Avatar
                  src={user.avatarUrl}
                  name={user.displayName}
                  accentColor={user.accentColor}
                  size={40}
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

      <section className="glass-panel flex flex-col gap-4 p-6">
        <h1 className="font-display text-2xl font-bold">Your rooms</h1>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button size="lg" onClick={() => {
            setCreateOpen(true);
          }}>
            + New room
          </Button>
          <form onSubmit={joinByCode} className="flex flex-1 gap-2">
            <Input
              aria-label="Invite code"
              placeholder="Join with a code"
              className="font-mono"
              maxLength={16}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
            <Button type="submit" variant="secondary" disabled={code.trim().length === 0}>
              Join
            </Button>
          </form>
        </div>
      </section>

      {roomsQuery.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading rooms">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : roomsQuery.isError ? (
        <div role="alert" className="glass-panel p-6 text-center text-sm text-mid">
          Couldn’t load your rooms.{' '}
          <button
            type="button"
            className="text-aurora-1 underline underline-offset-2"
            onClick={() => void roomsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      ) : roomsQuery.data.rooms.length === 0 ? (
        <div className="glass-panel flex flex-col items-center gap-3 p-10 text-center">
          <p className="font-display text-lg font-semibold text-hi">A quiet void</p>
          <p className="max-w-sm text-sm text-mid">
            Create a room or join one with an invite code — then watch or listen together,
            perfectly in sync.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {roomsQuery.data.rooms.map(({ room, unreadCount, memberCount, muted }) => (
            <li key={room.id}>
              <Link
                href={`/room/${room.id}`}
                className="glass-panel group block p-5 transition-all duration-200 hover:shadow-glow"
              >
                <h2 className="mb-3 font-display text-lg font-semibold leading-tight text-hi">
                  {room.name}
                </h2>
                <div className="flex items-center gap-3 text-xs text-low">
                  <span>{memberCount} {memberCount === 1 ? 'person' : 'people'}</span>
                  {muted && <span aria-label="Notifications muted">🔕</span>}
                  {unreadCount > 0 && (
                    <Badge variant="aurora" aria-label={`${unreadCount} unread messages`}>
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateRoomDialog open={createOpen} onOpenChange={setCreateOpen} />
    </main>
  );
}
