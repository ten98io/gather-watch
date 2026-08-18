'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@gather/api-client';
import {
  SetTheaterResponse,
  formatInviteCode,
  memberRemovalReasonFromCloseText,
} from '@gather/contracts';
import type { RoomId } from '@gather/contracts';
import { api, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { describeError } from '@/lib/describe-error';
import { ROLE_LABEL } from '@/lib/labels';
import { toast } from '@/components/ui/toast';
import { RoomMenu } from '@/components/room/RoomMenu';
import { RoomProvider, useRoom, useRoomConnection } from '@/lib/room-context';
import { unreadChatCount } from '@/lib/room-connection';
import { mediaKindFor } from '@/lib/media-kind';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { StagePane } from '@/components/stage/StagePane'; // wave 2
import { ChatPane } from '@/components/chat/ChatPane'; // wave 2
import { QueuePane } from '@/components/queue/QueuePane'; // wave 2
import { PeoplePane } from '@/components/people/PeoplePane'; // wave 2
import { CallDock, CallOverlay, CallSessionProvider } from '@/components/call/CallSurface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeftIcon, TheaterIcon } from '@/components/ui/icons';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import type { ConnectionStatus, RoomClosedInfo } from '@/lib/room-connection';

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

/**
 * Desktop right rail (380px): the ONE call surface docked above
 * Chat/Queue/People. Solid `surface-1` normally — glass is reserved for things
 * that float over moving video, which the rail only does in theater mode
 * (`floating`), where it overlays the stage.
 *
 * Theater is a PROP, never a different element. This used to be rendered by
 * two branches — `<Rail>` in one and a `<>…</>` fragment in the other — at the
 * same child slot, and React cannot reconcile a fragment against a component:
 * every theater flip destroyed the whole rail and built it again, taking the
 * call dock's `<video>` tiles, chat's scroll position and the queue with it.
 * One element, one slot, props for the rest.
 */
function Rail({
  roomId,
  tab,
  onTabChange,
  floating = false,
}: {
  roomId: RoomId;
  tab: RailTab;
  onTabChange(t: RailTab): void;
  floating?: boolean;
}) {
  return (
    <aside
      aria-label="Room panel"
      className={cn(
        'm-3 ml-0 flex w-rail shrink-0 flex-col overflow-hidden',
        // Mutually exclusive on purpose: cn() is a plain joiner, so a floating
        // rail that also kept `rounded-panel bg-surface-1` would paint a solid
        // panel over the picture instead of glass.
        floating
          ? 'glass-panel absolute inset-y-0 right-0 z-20'
          : 'rounded-panel bg-surface-1',
      )}
    >
      {/* Hairline: the dock and the tabs are the same elevation step. */}
      <div className="border-b border-hairline">
        <CallDock roomId={roomId} />
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
        <DialogDescription>The room is fully keyboard-driven.</DialogDescription>
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

/** Exported for the test suite; the page mounts it via <RoomShell> only. */
export function RoomLayout({ roomId }: { roomId: RoomId }) {
  const { room, member } = useRoom();
  const connection = useRoomConnection();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [tab, setTab] = useState<RailTab>('chat');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Theater layout: rail hidden by default, opens as a glass overlay. */
  const [railOpen, setRailOpen] = useState(false);
  const canManage = member.role === 'host' || member.role === 'moderator';
  /** What the stage is showing right now — the room has no mode of its own.
   *  Selecting the classified kind (a primitive) keeps this render quiet
   *  across the position-only playback updates every sync tick sends. */
  const stageKind = connection.useRoomState((s) => mediaKindFor(s.playback?.mediaRef ?? null));
  /** Set only when the room refused this session for good — never by a
   *  dropped connection, which reconnects on its own. */
  const closed = connection.useRoomState((s) => s.closed);
  /**
   * Unread chat, for the mobile surface.
   *
   * The desktop badge is published by ChatPane onto its own TabsTrigger, which
   * is exactly the mechanism a phone does not have: the tab bar lives inside a
   * closed <Sheet>, SheetContent renders NOTHING while it is closed, and
   * TabsContent mounts lazily — so before the first open there is no chat
   * component in the tree at all, and after every close there is none again.
   * A phone could take chat all evening and never once say so, then wipe the
   * backlog the instant the sheet opened onto Chat.
   *
   * So the shell reads it itself, off the store that outlives every pane. The
   * SELECTOR RETURNS THE NUMBER, not the message array: this component renders
   * the stage, and re-rendering it on every position tick — or on every
   * message, unread or not — is the cost the rail was careful to avoid.
   */
  const unreadChat = connection.useRoomState((s) =>
    unreadChatCount(s.messages, s.chatSeenSeq, member.userId),
  );
  /**
   * Theater is the USER'S LATCH, not a property of the playing item.
   *
   * It used to be `room.theater && stageKind === 'video'`, re-derived from
   * whatever was on the stage — so a mixed queue re-laid-out the entire room
   * once per item, hiding and re-showing the rail as it flowed video → music →
   * video while nobody touched anything. A layout that changes under you
   * because a song came on is not a mode, it is a twitch.
   *
   * So the flag itself decides the layout, and the ITEM decides only whether
   * the control is worth offering: theater is turned ON over a picture, where
   * filling the room means something. It stays offered while it is on, whatever
   * is playing — a switch that can be flipped one way and not the other is a
   * trap, and the queue can move to music while theater is on.
   */
  const theaterActive = room.theater;
  const canToggleTheater = canManage && (stageKind === 'video' || theaterActive);

  const toggleTheater = (): void => {
    void apiFetch(`/rooms/${roomId}/theater`, {
      method: 'POST',
      body: { enabled: !room.theater },
      schema: SetTheaterResponse,
    })
      .then(() => toast.success(room.theater ? 'Theater off' : 'Theater on'))
      .catch((err: unknown) => {
        // Curated copy only — the raw server body is never shown.
        toast.error(describeError(err, 'Could not switch theater mode'));
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

  /** Theater collapses the rail; the call tiles float over the stage instead. */
  const railCollapsed = theaterActive && !railOpen;

  // The room ended this session for good (kicked, banned, room gone, token
  // dead). No reconnect is coming, so the panes below would sit on a stale
  // room behind a status pill that says nothing — say what happened instead.
  if (closed !== null) {
    const { title, detail } = closedNotice(closed);
    return <RoomNotice title={title} detail={detail} />;
  }

  return (
    <CallSessionProvider>
      <div className="flex h-dvh flex-col">
        <header className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Link
            href="/home"
            aria-label="Leave room"
            className="text-low transition-colors hover:text-hi"
          >
            <ArrowLeftIcon size={20} aria-hidden />
          </Link>
          <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold">{room.name}</h1>
          <Badge variant="muted" className="hidden font-mono sm:inline-flex">
            {formatInviteCode(room.inviteCode)}
          </Badge>
          {member.role !== 'member' && <Badge variant="default">{ROLE_LABEL[member.role]}</Badge>}
          <RoomMenu room={room} canManage={canManage} />
          {canToggleTheater && (
            <Button
              variant={theaterActive ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={theaterActive}
              aria-label={theaterActive ? 'Turn theater mode off' : 'Turn theater mode on'}
              onClick={toggleTheater}
            >
              <TheaterIcon size={16} aria-hidden />
              Theater
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
              {unreadChat > 0 && (
                <>
                  <Badge variant="aurora" aria-hidden className="shrink-0">
                    {unreadChat > 99 ? '99+' : unreadChat}
                  </Badge>
                  {/* Same shape as TabsTrigger: the digit says nothing out
                      loud, and an aria-label here would replace the button's
                      identity with a count. */}
                  <span className="sr-only">{unreadChat} unread</span>
                </>
              )}
            </Button>
          )}
        </header>

        {isDesktop ? (
          <div className="relative flex min-h-0 flex-1">
            <main className="relative min-w-0 flex-1" aria-label="Stage area">
              <ConnectionPill />
              <StagePane roomId={roomId} />
              {/* Theater: the rail is gone, so the tiles float along the left
                  edge — never over the middle of the picture — and can be
                  hidden for the session. */}
              {railCollapsed && <CallOverlay roomId={roomId} />}
            </main>
            {/* Its own slot, so it can appear and disappear without moving the
                rail below it out of position. */}
            {theaterActive && (
              <Button
                variant="secondary"
                size="sm"
                className="absolute bottom-4 right-4 z-30"
                onClick={() => setRailOpen((v) => !v)}
                aria-expanded={railOpen}
              >
                {railOpen ? 'Hide panel' : 'Chat & queue'}
              </Button>
            )}
            {/* ONE rail, in ONE slot, for every layout it has. Theater changes
                what it looks like, never what it is: docked → floating is a
                prop change React can reconcile, so the call tiles keep their
                tracks and chat keeps its scroll across the flip. It is absent
                only when it is genuinely off screen — theater with the panel
                closed, where CallOverlay above carries the tiles instead. */}
            {!railCollapsed && (
              <Rail roomId={roomId} tab={tab} onTabChange={setTab} floating={theaterActive} />
            )}
          </div>
        ) : (
          <>
            <main className="relative min-h-0 flex-1" aria-label="Stage area">
              <ConnectionPill />
              <StagePane roomId={roomId} />
              {!sheetOpen && <CallOverlay roomId={roomId} />}
            </main>
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetContent aria-label="Chat, queue and people" className="min-h-[50dvh]">
                <div className="border-b border-hairline">
                  <CallDock roomId={roomId} />
                </div>
                <RailTabs roomId={roomId} tab={tab} onTabChange={setTab} />
              </SheetContent>
            </Sheet>
          </>
        )}

        <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </CallSessionProvider>
  );
}

/**
 * The room's one blocking state: a headline, a plain sentence, and a way out.
 * Both the join failure and a session the room ended mid-visit land here, so
 * they read as the same kind of dead end rather than two inventions.
 */
function RoomNotice({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass-panel flex w-full max-w-md flex-col items-center gap-4 p-8 text-center shadow-glow">
        <span aria-hidden className="text-4xl">🌌</span>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <p className="text-sm text-mid">{detail}</p>
        <div className="flex gap-2">
          {onRetry !== undefined && (
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
 * One plain sentence for why the room ended this session. A kick has to read
 * as a kick: until now the only consumer of a terminal close was a stage
 * watchdog, so a removed member saw an "Offline" pill — identical to dropped
 * wifi. The server sends prose on the close frame ('kicked', 'banned',
 * 'room deleted', …); this turns it into something a person would say, and
 * never shows the code.
 */
export function closedNotice(info: RoomClosedInfo): { title: string; detail: string } {
  // Keyed on the contract enum, not on the prose: the close frame carries a
  // free-text string, and matching literals here against literals in the API
  // meant an edit to either one degraded this to the generic sentence with
  // every test still passing.
  switch (memberRemovalReasonFromCloseText(info.reason)) {
    case 'kicked':
      return {
        title: 'You were removed from this room',
        detail: 'A host or moderator removed you.',
      };
    case 'banned':
      return {
        title: 'You were banned from this room',
        detail: 'A host or moderator banned this account.',
      };
    case 'left':
      return { title: 'You left this room', detail: 'You are no longer a member here.' };
    case 'roomDeleted':
      return { title: 'This room is gone', detail: 'A host deleted the room.' };
    default:
      break;
  }
  if (info.code === 4404) {
    return { title: 'This room is gone', detail: 'The room no longer exists.' };
  }
  if (info.code === 4401) {
    return { title: 'Your session ended', detail: 'Sign in again to come back.' };
  }
  if (info.code === 4403) {
    // The hub's own refusals — 'not a member', 'guest token is room-scoped' —
    // are not removals, so they carry no reason we can name.
    return {
      title: 'This room is not open to you',
      detail: 'Ask a member for a fresh invite link.',
    };
  }
  return { title: 'You are no longer in this room', detail: 'Your access to this room ended.' };
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
  // A curated API error is final; only an unrecognised failure is worth a retry.
  return (
    <RoomNotice title={title} detail={detail} {...(apiError === null ? { onRetry } : {})} />
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
