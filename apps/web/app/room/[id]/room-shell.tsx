'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@playin/api-client';
import { SetTheaterResponse } from '@playin/contracts';
import type { RoomId } from '@playin/contracts';
import { api, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from '@/components/ui/toast';
import { RoomProvider, useRoom, useRoomConnection } from '@/lib/room-context';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { StagePane } from '@/components/stage/StagePane'; // wave 2
import { ChatPane } from '@/components/chat/ChatPane'; // wave 2
import { QueuePane } from '@/components/queue/QueuePane'; // wave 2
import { CallStrip } from '@/components/call/CallStrip'; // wave 2
import { PeoplePane } from '@/components/people/PeoplePane'; // wave 2
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import type { ConnectionStatus } from '@/lib/room-connection';

type RailTab = 'chat' | 'queue' | 'people';

const statusLabel: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  closed: 'Offline',
};

/** Glass status pill over the stage — the room's heartbeat at a glance. */
function ConnectionPill() {
  const connection = useRoomConnection();
  const status = connection.useStatus();
  return (
    <div
      role="status"
      aria-live="polite"
      className="glass-raised pointer-events-none absolute left-4 top-4 z-20 flex items-center gap-2 rounded-full px-3 py-1.5"
    >
      <span
        aria-hidden
        className={cn(
          'h-2 w-2 rounded-full',
          status === 'live' && 'bg-success',
          status === 'connecting' && 'bg-warn animate-pulse',
          status === 'reconnecting' && 'bg-warn animate-pulse',
          status === 'closed' && 'bg-danger',
        )}
      />
      <span className="text-xs font-medium text-mid">{statusLabel[status]}</span>
    </div>
  );
}

/** Desktop: 380px glass right rail — CallStrip docked above Chat/Queue/People. */
function Rail({ roomId, tab, onTabChange }: { roomId: RoomId; tab: RailTab; onTabChange(t: RailTab): void }) {
  return (
    <aside className="glass-panel m-3 ml-0 flex w-[380px] shrink-0 flex-col overflow-hidden">
      <div className="border-b border-border-glass">
        <CallStrip roomId={roomId} />
      </div>
      <RailTabs roomId={roomId} tab={tab} onTabChange={onTabChange} />
    </aside>
  );
}

function RailTabs({ roomId, tab, onTabChange }: { roomId: RoomId; tab: RailTab; onTabChange(t: RailTab): void }) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as RailTab)} className="min-h-0 flex-1 p-3">
      <TabsList aria-label="Room panels">
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="queue">Queue</TabsTrigger>
        <TabsTrigger value="people">People</TabsTrigger>
      </TabsList>
      <TabsContent value="chat" className="pt-3">
        <ChatPane roomId={roomId} />
      </TabsContent>
      <TabsContent value="queue" className="pt-3">
        <QueuePane roomId={roomId} />
      </TabsContent>
      <TabsContent value="people" className="pt-3">
        <PeoplePane roomId={roomId} />
      </TabsContent>
    </Tabs>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['← / →', 'Seek 10 seconds'],
  ['C', 'Captions'],
  ['M', 'Mute'],
  ['?', 'This sheet'],
];

function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Keyboard shortcuts">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>The room is fully keyboard-driven (DESIGN.md §9).</DialogDescription>
        <ul className="mt-4 flex flex-col gap-2">
          {SHORTCUTS.map(([key, action]) => (
            <li key={key} className="flex items-center justify-between gap-4 text-sm">
              <kbd className="glass-raised rounded-md px-2 py-1 font-mono text-xs text-hi">{key}</kbd>
              <span className="text-mid">{action}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function RoomLayout({ roomId }: { roomId: RoomId }) {
  const { room, member } = useRoom();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [tab, setTab] = useState<RailTab>('chat');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Theater layout: rail hidden by default, opens as a glass overlay. */
  const [railOpen, setRailOpen] = useState(false);
  const canToggleTheater = member.role === 'host' || member.role === 'moderator';

  const toggleTheater = (): void => {
    void apiFetch(`/rooms/${roomId}/theater`, {
      method: 'POST',
      body: { enabled: !room.theater },
      schema: SetTheaterResponse,
    })
      .then(() => toast.success(room.theater ? 'Theater off' : 'Theater on'))
      .catch((err: unknown) => {
        // Surface the server's reason — premium gate, role policy, etc.
        const msg = err instanceof ApiError ? err.message : 'Could not toggle theater mode';
        if (err instanceof ApiError && err.code === 'FORBIDDEN' && /premium/i.test(msg)) {
          toast.error('Theater mode is a premium feature — upgrade to enable it');
        } else {
          toast.error(msg);
        }
      });
  };

  const shortcuts = useMemo(
    () => [
      {
        key: '?',
        handler: () => {
          setShortcutsOpen(true);
        },
      },
    ],
    [],
  );
  useKeyboardShortcuts(shortcuts);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/home" aria-label="Leave room" className="text-low transition-colors hover:text-hi">
          ←
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold">{room.name}</h1>
        <Badge variant={room.kind === 'watch' ? 'aurora' : 'default'}>
          {room.kind === 'watch' ? 'Watch' : 'Listen'}
        </Badge>
        <Badge variant="muted" className="font-mono">{room.inviteCode}</Badge>
        {member.role !== 'member' && <Badge variant="default">{member.role}</Badge>}
        {canToggleTheater && (
          <Button
            variant={room.theater ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={room.theater}
            onClick={toggleTheater}
          >
            🎭 Theater
          </Button>
        )}
        {!isDesktop && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSheetOpen(true);
            }}
          >
            Chat &amp; queue
          </Button>
        )}
      </header>

      {isDesktop ? (
        <div className="relative flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1" aria-label="Stage area">
            <ConnectionPill />
            <StagePane roomId={roomId} />
          </main>
          {room.theater ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                className="absolute bottom-4 right-4 z-30"
                onClick={() => setRailOpen((v) => !v)}
                aria-expanded={railOpen}
              >
                {railOpen ? 'Hide panel' : 'Chat & queue'}
              </Button>
              {railOpen && (
                <div className="absolute inset-y-0 right-0 z-20 w-[392px]">
                  <Rail roomId={roomId} tab={tab} onTabChange={setTab} />
                </div>
              )}
            </>
          ) : (
            <Rail roomId={roomId} tab={tab} onTabChange={setTab} />
          )}
        </div>
      ) : (
        <>
          <main className="relative min-h-0 flex-1" aria-label="Stage area">
            <ConnectionPill />
            <StagePane roomId={roomId} />
          </main>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent aria-label="Chat, queue and people" className="min-h-[50dvh]">
              <RailTabs roomId={roomId} tab={tab} onTabChange={setTab} />
              <div className="mt-2 border-t border-border-glass">
                <CallStrip roomId={roomId} />
              </div>
            </SheetContent>
          </Sheet>
        </>
      )}

      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

function RoomError({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const apiError = error instanceof ApiError ? error : null;
  const banned =
    apiError !== null && apiError.code === 'FORBIDDEN' && /banned/i.test(apiError.message);
  const title =
    apiError?.code === 'NOT_FOUND'
      ? 'This room has drifted away'
      : banned
        ? 'You are banned from this room'
        : apiError?.code === 'FORBIDDEN'
          ? 'This room is not yours to enter'
          : 'The room could not be reached';
  const detail =
    apiError?.code === 'NOT_FOUND'
      ? 'The invite link may be stale, or the room was deleted.'
      : banned
        ? 'A host or moderator banned this account from the room.'
        : apiError?.code === 'FORBIDDEN'
          ? 'Ask a member for a fresh invite link.'
          : 'Check your connection and try again.';
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow">
        <span aria-hidden className="text-4xl">🌌</span>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <p className="text-sm text-mid">{detail}</p>
        <div className="flex gap-2">
          {apiError === null && (
            <Button variant="secondary" onClick={onRetry}>Retry</Button>
          )}
          <Link href="/home">
            <Button>Back to your rooms</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * Room shell: resolves membership via GET /rooms/:id, then mounts a single
 * RoomProvider (one RoomConnection shared by every pane via room-context).
 */
export function RoomShell({ roomId }: { roomId: RoomId }) {
  const router = useRouter();
  const { user, loading } = useAuth();

  const roomQuery = useQuery({
    queryKey: ['room', roomId],
    queryFn: () => api.rooms.getRoom(roomId),
    enabled: !loading && user !== null,
    retry: false,
  });

  useEffect(() => {
    if (!loading && user === null) router.replace('/login');
  }, [user, loading, router]);

  if (loading || user === null || roomQuery.isPending) {
    return (
      <main className="flex h-dvh flex-col gap-3 p-4" aria-label="Loading room">
        <Skeleton className="h-10 w-full" />
        <div className="flex min-h-0 flex-1 gap-3">
          <Skeleton className="min-w-0 flex-1" />
          <Skeleton className="hidden w-[380px] md:block" />
        </div>
      </main>
    );
  }

  if (roomQuery.isError) {
    return (
      <RoomError
        error={roomQuery.error}
        onRetry={() => void roomQuery.refetch()}
      />
    );
  }

  const { room, member, lastEventSeq } = roomQuery.data;
  return (
    <RoomProvider room={room} member={member} lastEventSeq={lastEventSeq}>
      <RoomLayout roomId={roomId} />
    </RoomProvider>
  );
}
