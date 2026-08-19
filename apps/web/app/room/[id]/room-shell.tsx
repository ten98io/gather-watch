'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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
import { canAct } from '@/lib/permissions';
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
import { Button } from '@/components/ui/button';
import { ArrowLeftIcon, TheaterIcon } from '@/components/ui/icons';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger, UnreadCount } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import type { ConnectionStatus, RoomClosedInfo } from '@/lib/room-connection';

type RailTab = 'chat' | 'queue' | 'people';

const statusLabel: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  closed: 'Offline',
};

/**
 * One class string per status, never a stack. `cn` is a plain joiner, so two
 * background utilities on one span would both apply and CSS source order —
 * not this table — would pick the colour.
 *
 * `live` is the aurora gradient, and it is one of exactly three things in the
 * product allowed to be: the primary action, the brand mark, the live
 * indicator (DESIGN.md §2). It is the only gradient in the room's header, and
 * it is the reason the header can say "this room is on the air" in six pixels.
 */
const statusDot: Record<ConnectionStatus, string> = {
  connecting: 'bg-warn animate-pulse',
  live: 'aurora-gradient',
  reconnecting: 'bg-warn animate-pulse',
  closed: 'bg-danger',
};

/**
 * The room's heartbeat, in the room's own metadata line.
 *
 * It was a glass pill pinned to the top-left corner of the stage: permanent
 * chrome sitting on top of the one surface the whole product exists to show,
 * repeating a fact that belongs beside the room's name. Its own component so
 * that a reconnect re-renders six pixels and not the room.
 */
function RoomStatus() {
  const connection = useRoomConnection();
  const status = connection.useStatus();
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-pill', statusDot[status])} />
      {statusLabel[status]}
    </span>
  );
}

/**
 * One segment of the masthead's metadata line, carrying the separator that
 * introduces it.
 *
 * The dot has to live INSIDE the item it separates. As its own child of a
 * `flex-wrap` row it is a box the line may break after, and on a 375px
 * masthead it did: the metadata came down as "Live · Host", then a bullet
 * alone on the next row, then the invite code. A separator is punctuation,
 * not content, and punctuation does not get its own line — bound to the
 * segment, a wrap moves both or neither.
 */
function MetaItem({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-x-2">
      <span aria-hidden>·</span>
      {children}
    </span>
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
  unreadChat,
  floating = false,
}: {
  roomId: RoomId;
  tab: RailTab;
  onTabChange(t: RailTab): void;
  unreadChat: number;
  floating?: boolean;
}) {
  return (
    <aside
      aria-label="Room panel"
      className={cn(
        'flex w-rail shrink-0 flex-col overflow-hidden',
        // Mutually exclusive on purpose: cn() is a plain joiner, so a floating
        // rail that also kept `rounded-panel bg-surface-1` would paint a solid
        // panel over the picture instead of glass.
        //
        // The docked rail carries no shadow: it is RESTING on the page and
        // separates from the void by background step (§4). Only the floating
        // one has left the page, and `shadow-e2` is what a floating panel says
        // — the same pairing dialogs and sheets use.
        floating
          ? 'glass-panel absolute inset-y-4 right-4 z-20 shadow-e2'
          : 'rounded-panel bg-surface-1',
      )}
    >
      {/* Hairline: the dock and the tab nav are the same elevation step, which
          is the one case §4 allows an edge instead of a background step. */}
      <div className="shrink-0 border-b border-hairline">
        <CallDock roomId={roomId} />
      </div>
      <RailTabs roomId={roomId} tab={tab} onTabChange={onTabChange} unreadChat={unreadChat} />
    </aside>
  );
}

/**
 * Chat / Queue / People.
 *
 * The unread count comes down as a prop rather than up from ChatPane: panels
 * mount lazily, so on any visit that does not open Chat the one component that
 * publishes the count never exists (components/ui/tabs.tsx). The shell reads
 * the store, which outlives every panel, and hands the same number to this
 * trigger and to the mobile control that replaces the whole bar.
 */
function RailTabs({
  roomId,
  tab,
  onTabChange,
  unreadChat,
}: {
  roomId: RoomId;
  tab: RailTab;
  onTabChange(t: RailTab): void;
  unreadChat: number;
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as RailTab)} className="min-h-0 flex-1">
      <TabsList aria-label="Room panels" className="px-4">
        <TabsTrigger value="chat" badge={unreadChat}>
          Chat
        </TabsTrigger>
        <TabsTrigger value="queue">Queue</TabsTrigger>
        <TabsTrigger value="people">People</TabsTrigger>
      </TabsList>
      <TabsContent value="chat" className="px-3 pb-3 pt-4">
        <ChatPane roomId={roomId} />
      </TabsContent>
      <TabsContent value="queue" className="px-3 pb-3 pt-4">
        <QueuePane roomId={roomId} />
      </TabsContent>
      <TabsContent value="people" className="px-3 pb-3 pt-4">
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
        <ul className="mt-6 flex flex-col gap-3">
          {SHORTCUTS.map(([key, action]) => (
            <li key={key} className="flex items-center justify-between gap-4">
              {/* Solid, not `glass-raised`: this sits inside a glass dialog and
                  §4 forbids stacking two glass layers. */}
              <kbd className="rounded-sm bg-surface-2 px-2 py-1 font-mono text-label text-hi">
                {key}
              </kbd>
              <span className="text-body text-mid">{action}</span>
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
  /**
   * Which pane the rail opens on — and it is no longer Chat.
   *
   * DESIGN.md §12 budgets "add content to queue" at 2, "play a queued item"
   * and "reorder / remove a queue item" at 1, and history-replay at 3. All
   * four begin by switching the rail to Queue, so opening on Chat spent a step
   * on every one of them and put the first over its budget outright.
   *
   * Chat is the pane that can ask for you: unread lands on its own trigger and
   * on the mobile control that stands in for the bar, so nothing is lost by
   * not landing there. The queue has no way to call out, and it is the room's
   * actual job — nothing reaches the stage until somebody puts it there.
   *
   * Fixed, not derived from what the room happens to hold. A default that
   * re-decided as the queue filled would move the panel out from under the
   * person who had just used it, which is the same twitch `theaterActive`
   * below exists to prevent.
   */
  const [tab, setTab] = useState<RailTab>('queue');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Theater layout: rail hidden by default, opens as a glass overlay. */
  const [railOpen, setRailOpen] = useState(false);
  /** The 'mods' tier, from the one place that defines it — the same predicate
   *  the panes use, and the same one the server's requireRole('host',
   *  'moderator') spells out on rename, policies, kick, ban and pin. */
  const canManage = canAct('mods', member.role);
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
  // room under a header still reading "Offline" — a word a dropped wifi uses
  // too. Say what actually happened instead.
  if (closed !== null) {
    const { title, detail } = closedNotice(closed);
    return <RoomNotice title={title} detail={detail} />;
  }

  return (
    <CallSessionProvider>
      <div className="flex h-dvh flex-col">
        {/*
          The room's masthead. The name is the largest thing in the product's
          chrome and everything that is merely ABOUT the room — live status,
          your role, the invite code — is one caption line above it.

          It read the other way round: a 14px name beside a mono invite chip
          that was the loudest element in the header, which told a reader the
          code mattered more than the room did. Nothing was deleted to fix
          that; the metadata simply moved to where metadata goes.

          Theater takes the header down a rung of the ramp rather than hiding
          it — the mode is "give the picture the room", and both branches set
          the same two properties so the plain joiner cannot pick.

          ── The phone composition, and why it is not the desktop one ──────
          One flex row cannot carry a back arrow, a 3-segment caption, the
          room's name and two controls in 343px. Sharing the row, the caption
          had 171px for ~250px of content and came down as "LIVE · HOST" over
          "· JMBT-MEP3-BKNB" — a separator leading a line, which is the wrap
          `MetaItem` exists to prevent, arriving one level up.

          So below `md` the header wraps into two rows by `order`, not by a
          second markup path: row 1 is the toolbar (back · the phone's route
          to the rail · the room controls), row 2 is the room's identity
          block at FULL width. The name goes from 171px to 343px, the caption
          stops wrapping at all, and the masthead is shorter than the ragged
          version it replaces. `md:order-none` hands every child back to DOM
          order, which is the desktop composition unchanged.
        */}
        <header
          className={cn(
            'flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 px-4',
            theaterActive ? 'py-4' : 'py-4 md:py-6',
          )}
        >
          {/* Navigation, and only that. It said "Leave room" while leaving a
              room had no control anywhere in the app — the membership survived,
              so /home grew a row per room ever opened and never lost one.
              Leaving is POST /rooms/:id/leave, and it lives in the room menu.
              The wording avoids RoomNotice's "Back to your rooms" button on
              purpose — room-closed-notice.test.ts tells the two screens apart
              by that string. */}
          <Link
            href="/home"
            aria-label="Your rooms"
            className="order-1 inline-flex h-ctl-md w-ctl-md shrink-0 items-center justify-center rounded-ctl text-low transition-colors duration-150 hover:bg-surface-2 hover:text-hi md:order-none"
          >
            <ArrowLeftIcon size={20} aria-hidden />
          </Link>
          {/* Row 2 on a phone, the middle of the row on a desktop. `basis-full`
              and `md:basis-0 md:grow` are the same property at two widths, so
              the later one wins by Tailwind's own source order — not by the
              plain joiner, which does not pick. */}
          <div className="order-4 min-w-0 basis-full md:order-none md:basis-0 md:grow">
            <p className="mb-1 flex flex-wrap items-center gap-x-2 text-caption text-low">
              <RoomStatus />
              {member.role !== 'member' && <MetaItem>{ROLE_LABEL[member.role]}</MetaItem>}
              <MetaItem>
                <span className="sr-only">Invite code</span>
                <span className="font-mono">{formatInviteCode(room.inviteCode)}</span>
              </MetaItem>
            </p>
            {/* The room's own name is the one thing on this screen that must
                survive, and at 375 `headline` did not let it: 28px in the
                107px left over beside three controls rendered "Desig…". One
                rung down is the whole fix — `title` is still the largest
                thing in the chrome, and a name a reader can finish beats a
                bigger name they cannot. It keeps that rung now that the row
                is full width: 343px of `title` finishes a name `headline`
                would still cut, and the phone's chrome stays a chrome. */}
            <h1 className="truncate font-display text-title text-hi md:text-headline">
              {room.name}
            </h1>
          </div>
          {/* One size for the whole cluster. Mixed `sm` and `md` beside a 28px
              title is most of what "small and timid" was.

              Both of these are icons with a word beside them, and below `md`
              the word is what goes: the `aria-label` already carries the name,
              so dropping it costs nothing a reader can hear and buys the room
              name the width it was being truncated for. */}
          <div className="order-3 ml-auto flex shrink-0 items-center gap-2 md:order-none md:ml-0">
            {canToggleTheater && (
              <Button
                variant={theaterActive ? 'secondary' : 'ghost'}
                size="md"
                // Icon-only below `md`, and `px-ctl-x-md` around a 16px glyph
                // is 40px — under the 44px §9 requires and gets everywhere
                // else for free, because the control tokens only raise the
                // HEIGHT on a coarse pointer. `min-w-ctl-md` is the same
                // token read as a width: 32 under a mouse, 44 under a finger.
                className="min-w-ctl-md"
                aria-pressed={theaterActive}
                aria-label={theaterActive ? 'Turn theater mode off' : 'Turn theater mode on'}
                onClick={toggleTheater}
              >
                <TheaterIcon size={16} aria-hidden />
                <span className="hidden md:inline">Theater</span>
              </Button>
            )}
            <RoomMenu room={room} canManage={canManage} />
          </div>
          {/* The phone's whole route to chat, the queue and the people in the
              room, so it sits in the toolbar row rather than taking 108px out
              of the room's name — `grow` is what fills the gap between the
              back arrow and the controls. It exists only below `md`;
              `md:order-none md:grow-0` is for the frame before `isDesktop`
              resolves, where the server has already rendered it. */}
          {!isDesktop && (
            <Button
              variant="secondary"
              size="md"
              className="order-2 grow md:order-none md:grow-0"
              onClick={() => {
                setSheetOpen(true);
              }}
            >
              Chat &amp; queue
              <UnreadCount count={unreadChat} />
            </Button>
          )}
        </header>

        {isDesktop ? (
          <div
            className={cn(
              'relative flex min-h-0 flex-1',
              // The gutter between the stage and the rail is the composition
              // (`section`, DESIGN.md §4) — void, with the ambient aurora and
              // the grain visible through it, which is the whole "the room
              // floats in space" line. It is only affordable once there is
              // width to spend: below `xl` a 64px gutter comes straight out of
              // the picture. Theater drops the frame entirely.
              theaterActive ? '' : 'gap-4 px-4 pb-4 xl:gap-section',
            )}
          >
            <main
              aria-label="Stage area"
              className={cn(
                'relative min-w-0 flex-1 overflow-hidden',
                // The stage is void on void, so the plate is drawn by its edge
                // and its corner. A hairline is what §4 allows where two
                // surfaces on the SAME step meet, which is exactly this one.
                theaterActive ? '' : 'rounded-stage border border-hairline',
              )}
            >
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
                size="md"
                // Whole class strings, not a shared prefix plus a differing
                // edge: `cn` is a plain joiner and `left-8 right-8` would pin
                // both edges of an absolutely positioned control at once.
                //
                // It sat at the bottom-right in both states, which put it on
                // top of the open panel's last row. The corner it can always
                // have is the one the other floating thing is not using: with
                // the panel open there is no CallOverlay on the left, and with
                // it closed the tiles are there and the right is free.
                className={
                  railOpen
                    ? 'absolute bottom-8 left-8 z-30'
                    : 'absolute bottom-8 right-8 z-30'
                }
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
              <Rail
                roomId={roomId}
                tab={tab}
                onTabChange={setTab}
                unreadChat={unreadChat}
                floating={theaterActive}
              />
            )}
          </div>
        ) : (
          <>
            <main className="relative min-h-0 flex-1" aria-label="Stage area">
              <StagePane roomId={roomId} />
              {!sheetOpen && <CallOverlay roomId={roomId} />}
            </main>
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetContent aria-label="Chat, queue and people">
                <div className="shrink-0 border-b border-hairline">
                  <CallDock roomId={roomId} />
                </div>
                <RailTabs
                  roomId={roomId}
                  tab={tab}
                  onTabChange={setTab}
                  unreadChat={unreadChat}
                />
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
 *
 * A dead end is still a composition. This was a small glass card with an emoji
 * on it floating in the middle of a black page — an apology, and one wearing
 * `shadow-glow`, which §5 reserves for signature moments. It is now type in a
 * canvas of void: one `display` line saying what happened (the one thing this
 * screen is about, and §3 allows exactly one per screen), one sentence, and
 * the way out as the region's single aurora action. No card, because there is
 * nothing here that needs to be a surface.
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
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-section text-center md:py-canvas">
      <div className="flex w-full max-w-2xl flex-col items-center gap-6">
        <h1 className="font-display text-headline text-hi md:text-display">{title}</h1>
        <p className="max-w-md text-body text-mid">{detail}</p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {onRetry !== undefined && (
            <Button size="lg" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          )}
          <Link href="/home">
            <Button size="lg">Back to your rooms</Button>
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
    // Cut like the frame it stands in for — the masthead's two lines, the
    // stage plate, the rail — so nothing re-shapes at the moment the room
    // lands. `radius="panel"` on the stage is the closest rung the primitive
    // offers; it has no `stage` step yet.
    return (
      <main className="flex h-dvh flex-col" aria-label="Loading room">
        {/* Cut like the masthead it stands in for, at both of its sizes: the
            band steps down below `md` exactly as the real header does, and
            below `md` it carries the toolbar row the real header wraps to —
            without it the identity block lands 44px higher than the room
            does, which is the re-shape this skeleton exists to prevent. */}
        <div className="flex shrink-0 flex-col gap-3 px-4 py-4 md:py-6">
          <Skeleton radius="ctl" className="h-ctl-md w-full md:hidden" />
          <div className="flex flex-col gap-2">
            <Skeleton radius="pill" className="h-3 w-40" />
            <Skeleton radius="ctl" className="h-7 w-56 md:h-8 md:w-64" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4 xl:gap-section">
          <Skeleton radius="panel" className="min-w-0 flex-1" />
          <Skeleton radius="panel" className="hidden w-rail shrink-0 md:block" />
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
