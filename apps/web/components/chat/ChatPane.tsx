'use client';

/**
 * ChatPane — the full room chat surface: server-ordered history with "load
 * earlier" pagination, live messages, markdown-lite, replies, edit/delete
 * tombstones, per-emoji reactions, typing dots, read receipts, pins rail,
 * full-text search, @mention highlight. All state from the shared
 * RoomConnection store; sends are ClientEvents (never optimistic).
 *
 * ── The composition (2026-08-19) ──────────────────────────────────────────
 * The log is one editorial column, and its rhythm is the thing that was
 * missing: every gap used to be `gap-1.5`, so a run of six messages from one
 * person and six messages from six people occupied the same shape and read the
 * same. Runs are now separated by `xl` (24px) and lines inside a run by `xs`
 * (4px) — a 6:1 ratio, which is what makes a block read as a block without a
 * single border being drawn.
 *
 * That spacing lives HERE and not in <MessageBubble>, because a run is a fact
 * about a message and its PREDECESSOR, and this is the only component that
 * holds the window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Message, MessageId, RoomId, UserId } from '@gather/contracts';
import { api } from '@/lib/api';
import { canAct } from '@/lib/permissions';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { unreadChatCount } from '@/lib/room-connection';
import { Button } from '@/components/ui/button';
import { ChevronRightIcon, PinIcon, SearchIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTabBadge, useTabPanelActive } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import { Composer } from './Composer';
import type { Mentionable } from './Composer';
import { MessageBubble } from './MessageBubble';

/** Typing dots — three dots, staggered 120 ms (DESIGN.md §6). */
function TypingDots() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setPhase((p) => (p + 1) % 4), 240);
    return () => clearInterval(h);
  }, []);
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 w-1.5 rounded-full transition-opacity',
            // Flat `bg-accent`, not `bg-aurora-1`: the accent retints with the
            // artwork (DESIGN.md §2.1) and `aurora-1` is only ever a gradient
            // stop. Ternary because the two states set the same properties.
            phase === i ? 'bg-accent opacity-100' : 'bg-low opacity-40',
          )}
        />
      ))}
    </span>
  );
}

/**
 * The signature empty state.
 *
 * An empty room is every room's FIRST impression, and this surface used to
 * answer it with one 14px line of grey apology. It is now the one composed
 * moment the rail has: an invitation mark, an overline and a `headline`,
 * sitting in `section` (64px) of air.
 *
 * `headline` and not `display`: the room screen gets exactly one `display`
 * (DESIGN.md §3) and it belongs to the Stage, which is what the screen is
 * about. A rail that also shouted would be the old problem with bigger type.
 */
function EmptyLog() {
  return (
    // The composition rung halves below `md` (see app/home/page.tsx): on the
    // phone sheet this pane's port is ~200px, and 128px of it was padding.
    <div className="m-auto flex flex-col items-center px-6 py-8 text-center md:py-section">
      {/* Three dots — the typing indicator at rest. One lit, two waiting: the
          room is listening. Static, so reduced-motion has nothing to turn off. */}
      <span aria-hidden className="mb-8 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-accent" />
        <span className="h-2 w-2 rounded-full bg-surface-3" />
        <span className="h-2 w-2 rounded-full bg-surface-3" />
      </span>
      <p className="text-caption text-low">Room chat</p>
      <h2 className="mt-3 text-headline text-hi">Say the first thing.</h2>
    </div>
  );
}

/** The log while the member directory is still in flight — rows, not a spinner. */
function LogSkeleton() {
  return (
    /* `px-2 py-1` mirrors a message row exactly — the log container supplies
       the rest — so the rows that arrive land where the placeholders were
       instead of stepping sideways as the directory resolves. */
    <div className="flex flex-col gap-6 px-2 py-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton radius="pill" className="h-8 w-8 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton radius="ctl" className="h-3 w-24" />
            <Skeleton radius="ctl" className={i === 1 ? 'h-4 w-3/4' : 'h-4 w-full'} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PinsRail({ pinned, onJump }: { pinned: Message[]; onJump(id: MessageId): void }) {
  const [open, setOpen] = useState(false);
  if (pinned.length === 0) return null;
  return (
    <div className="border-b border-hairline px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-caption text-low transition-colors duration-150 hover:text-hi"
        aria-expanded={open}
      >
        <PinIcon size={12} />
        {pluralize(pinned.length, 'pinned message')}
        <ChevronRightIcon
          size={12}
          className={cn('ml-auto transition-transform duration-150', open && 'rotate-90')}
        />
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1">
          {pinned.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onJump(m.id)}
                className={cn(
                  'w-full truncate rounded-sm bg-surface-2 px-2 py-1 text-left text-label',
                  'text-low transition-colors duration-150 hover:bg-surface-3 hover:text-hi',
                )}
              >
                {m.body}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChatPane({ roomId }: { roomId: RoomId }) {
  const connection = useRoomConnection();
  const { room, member } = useRoom();
  const messages = connection.useRoomState((s) => s.messages);
  const typing = connection.useRoomState((s) => s.typing);
  const readCursors = connection.useRoomState((s) => s.readCursors);
  const me = member.userId;

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const historyExhausted = connection.useRoomState((s) => s.chatHistoryExhausted);
  const chatSeenSeq = connection.useRoomState((s) => s.chatSeenSeq);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [tick, setTick] = useState(0); // prunes typing indicators once a second
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  /**
   * Roving tab stop over the message log. Message actions live behind a
   * context menu, and the keyboard Menu key fires `contextmenu` on the FOCUSED
   * element — so messages must be focusable. Making all 300 focusable would
   * bury the composer behind 300 tab stops, so exactly one message is in the
   * tab order and Arrow keys move it. Index is into the rendered `messages`
   * window; -1 until the user first arrows in.
   */
  const [rovingIndex, setRovingIndex] = useState(-1);

  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, []);

  /**
   * Read cursor and unread badge, which are the same fact seen from two sides.
   *
   * This pane is one of three tabs and is no longer torn down when you leave
   * it (components/ui/tabs.tsx keeps inactive panels mounted), so "the newest
   * message arrived" and "you have seen the newest message" stopped being the
   * same event: rendering off-screen is not reading. Seen advances only while
   * this is the tab on screen; everything past the seen mark, from anyone else,
   * is what the Chat trigger counts.
   */
  const paneActive = useTabPanelActive();
  const latestSeq = messages.length > 0 ? (messages[messages.length - 1]?.seq ?? 0) : 0;
  useEffect(() => {
    if (paneActive) connection.markChatSeen(latestSeq);
  }, [connection, latestSeq, paneActive]);
  const unread = useMemo(
    () => unreadChatCount(messages, chatSeenSeq, me),
    [messages, chatSeenSeq, me],
  );
  useTabBadge(paneActive ? 0 : unread);

  /**
   * Stick to bottom for new messages unless the user scrolled up.
   *
   * Keyed on the NEWEST SEQ, never on `messages.length`. The window is capped
   * at MAX_MESSAGES (300) by insertMessage, so past that point every new
   * message shifts the window without changing its length — a length
   * dependency freezes at 300 and this effect stops running for the rest of
   * the session. Messages keep arriving and rendering; the viewport just stops
   * following them, which reads exactly like a dead socket and survives every
   * transport fix. seq is monotonic, so it moves on every message forever.
   *
   * Also keyed on `paneActive`. A hidden panel is display:none, where
   * scrollHeight is 0 and the browser keeps no scroll offset — so writing the
   * offset while away is a no-op that leaves the log parked at the top the
   * moment it is shown again. Re-running on the way back is what puts you at
   * the newest message, which is where someone who just cleared an unread
   * badge is going.
   *
   * Deliberately a plain effect, not useLayoutEffect: this is a client
   * component that Next still renders on the server, where useLayoutEffect
   * warns. The one-frame settle is the cheaper trade.
   */
  useEffect(() => {
    if (!paneActive) return;
    const el = listRef.current;
    if (el !== null && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [latestSeq, paneActive]);

  /**
   * The rows the tab stop can actually land on, as indexes into `messages`.
   *
   * Tombstones and system events render WITHOUT `data-msg-focusable` — they
   * carry no actions — so a position in `messages` is not a position in what
   * is focusable, and the two were being used as if they were: onListKeyDown
   * counts rendered rows while the tab stop was resolved against the message
   * window. One system event anywhere in the window shifted the two apart, so
   * arrowing moved the tab stop onto a different message than the one focus
   * was on; and when the NEWEST message was a system event — "Robin joined",
   * the most ordinary last line a room has — the default resolved to a row
   * that renders no tab stop at all. Tab out of the composer then skipped the
   * log entirely, and the Arrow keys only act on focus that is already inside
   * it, so nothing could put it back.
   *
   * One index space fixes both: `rovingIndex` is a position in THIS list, and
   * this list is the `[data-msg-focusable]` rows in document order.
   */
  const focusableIndexes = useMemo(
    () =>
      messages.reduce<number[]>((acc, m, i) => {
        if (m.kind !== 'system' && m.deletedAt === null) acc.push(i);
        return acc;
      }, []),
    [messages],
  );

  /**
   * The one message in the tab order. Defaults to the newest reachable row —
   * Tab from the composer should land on what just arrived, not on
   * 300-messages-ago — and is clamped so a pruned or paginated window can
   * never strand the tab stop on an index that no longer renders.
   */
  const activeMessageIndex =
    focusableIndexes.length === 0
      ? -1
      : (focusableIndexes[
          rovingIndex < 0
            ? focusableIndexes.length - 1
            : Math.min(rovingIndex, focusableIndexes.length - 1)
        ] ?? -1);

  /**
   * Arrow-key navigation between messages. Only acts when focus is already on
   * a message — otherwise Arrow keys inside the edit input, a link, or the
   * search field would be stolen from the control the user is actually in.
   */
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const el = listRef.current;
    if (el === null) return;
    const items = [...el.querySelectorAll<HTMLElement>('[data-msg-focusable]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    e.preventDefault();
    // Clamped, not wrapping: arrowing off the end of a chat log should stop at
    // the newest message, not jump back to the oldest.
    const next = Math.min(items.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    setRovingIndex(next);
    items[next]?.focus();
  };

  const onScroll = (): void => {
    const el = listRef.current;
    if (el === null) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // Member directory: author names, avatars + mention candidates (shared query
  // cache key with PeoplePane).
  const membersQuery = useQuery({
    queryKey: ['members', roomId],
    queryFn: () => api.rooms.listMembers(roomId),
  });
  const directory = useMemo(() => {
    const map = new Map<UserId, { name: string; accent: string | null; avatar: string | null }>();
    for (const { user } of membersQuery.data?.members ?? []) {
      map.set(user.id, {
        name: user.displayName,
        accent: user.accentColor,
        avatar: user.avatarUrl,
      });
    }
    return map;
  }, [membersQuery.data]);
  const mentionables: Mentionable[] = useMemo(
    () =>
      (membersQuery.data?.members ?? [])
        .filter(({ user }) => user.id !== me)
        .map(({ user }) => ({ userId: user.id, displayName: user.displayName })),
    [membersQuery.data, me],
  );

  const byId = useMemo(() => {
    const map = new Map<MessageId, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    const oldest = messages[0];
    if (oldest === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.messages.listMessages(roomId, {
        beforeSeq: oldest.seq,
        limit: 50,
      });
      const ascending = [...page.items].sort((a, b) => a.seq - b.seq);
      if (ascending.length < 50) {
        connection.useRoomState.setState({ chatHistoryExhausted: true });
      }
      if (ascending.length === 0) {
        return;
      }
      connection.useRoomState.setState((s) => {
        let next = s.messages;
        for (const msg of ascending) {
          if (!next.some((m) => m.id === msg.id)) next = [msg, ...next];
        }
        return { messages: next };
      });
    } catch {
      // A failed page is retried by the next click.
    } finally {
      setLoadingMore(false);
    }
  }, [connection, messages, loadingMore, roomId]);

  const activeTypers = useMemo(() => {
    void tick;
    const now = Date.now();
    return Object.entries(typing)
      .filter(([userId, expiry]) => userId !== me && expiry > now)
      .map(([userId]) => directory.get(userId as UserId)?.name ?? 'Someone');
  }, [typing, me, tick, directory]);

  const seenByCount = useMemo(() => {
    const lastOwn = [...messages].reverse().find((m) => m.authorId === me);
    if (lastOwn === undefined) return 0;
    return Object.entries(readCursors).filter(
      ([userId, seq]) => userId !== me && seq >= lastOwn.seq,
    ).length;
  }, [messages, readCursors, me]);

  const pinned = useMemo(() => messages.filter((m) => m.pinned && m.deletedAt === null), [messages]);

  const jumpTo = useCallback((id: MessageId): void => {
    listRef.current
      ?.querySelector(`[data-message="${id}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  const searchQuery = useQuery({
    queryKey: ['chat-search', roomId, searchQ],
    queryFn: () => api.messages.searchMessages(roomId, { q: searchQ, limit: 20 }),
    enabled: searchOpen && searchQ.trim().length > 0,
  });

  const composerEnabled = canAct(room.policies.chat, member.role);
  const canModerate = member.role === 'host' || member.role === 'moderator';

  return (
    <section aria-label="Chat" data-room={roomId} className="flex h-full min-h-0 flex-col">
      {/* Header. An overline and one control — the tab above already says
          "Chat", so repeating the word here would be furniture.

          The count is shown only once the server has said there is nothing
          earlier, because that is the only time it is TRUE. `messages` is the
          window, capped at MAX_MESSAGES (300) and paged in by hand, so in any
          room with history it counts what has been loaded rather than what was
          said — and past the cap it reads "300 messages" for the rest of the
          session no matter how much is said after it. */}
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-caption text-low">
          {historyExhausted && messages.length > 0 ? pluralize(messages.length, 'message') : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search chat"
          aria-pressed={searchOpen}
          // Held open: the ladder says "this control is on", which `aria-pressed`
          // alone cannot draw. Ghost's own `text-mid` stays — a text colour here
          // would lose to it on source order, since cn() is a plain joiner.
          className={searchOpen ? 'bg-surface-2' : ''}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <SearchIcon size={16} />
        </Button>
      </div>

      {searchOpen && (
        <div className="border-b border-hairline px-3 py-3">
          <Input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search messages…"
            aria-label="Search messages"
          />
          {searchQ.trim().length > 0 && (
            <ul className="mt-2 max-h-48 overflow-y-auto">
              {(searchQuery.data?.items ?? []).map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      jumpTo(m.id);
                      setSearchOpen(false);
                    }}
                    className={cn(
                      'w-full truncate rounded-sm px-2 py-1.5 text-left text-label text-low',
                      'transition-colors duration-150 hover:bg-surface-2 hover:text-hi',
                    )}
                  >
                    <span className="text-hi">{directory.get(m.authorId)?.name ?? 'Unknown'} </span>
                    {m.body}
                  </button>
                </li>
              ))}
              {searchQuery.isSuccess && (searchQuery.data?.items.length ?? 0) === 0 && (
                <li className="px-2 py-2 text-label text-low">Nothing matches that.</li>
              )}
            </ul>
          )}
        </div>
      )}

      <PinsRail pinned={pinned} onJump={jumpTo} />

      {/* message list — aria-live polite for incoming chat (§9) */}
      <div
        ref={listRef}
        onScroll={onScroll}
        onKeyDown={onListKeyDown}
        aria-live="polite"
        // `px-1`, not `px-2`: each row carries its own `px-2`, so the column
        // hangs at 12px — the same left edge as the header, the pins rail, the
        // search field and the composer. It was 16px, which is the kind of
        // four-pixel disagreement nobody can name and everybody can see. The
        // 4px that is left over is what keeps a hovered row reading as a plate
        // inside the rail rather than as a band across it.
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-3"
      >
        {!historyExhausted && messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadEarlier()}
            disabled={loadingMore}
            className="mb-4 self-center"
          >
            {loadingMore ? 'Loading…' : 'Load earlier messages'}
          </Button>
        )}
        {messages.length === 0 && (membersQuery.isPending ? <LogSkeleton /> : <EmptyLog />)}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const groupStart =
            prev === undefined ||
            prev.authorId !== m.authorId ||
            m.createdAt - prev.createdAt > 5 * 60_000;
          const replyTarget = m.replyTo !== null ? byId.get(m.replyTo) : undefined;
          const author = directory.get(m.authorId);
          return (
            <div
              key={m.id}
              data-message={m.id}
              // The rhythm: a new run opens with `xl`, a continuation with `xs`.
              // Mutually exclusive — cn() is a plain joiner and `mt-6 mt-1` is
              // decided by Tailwind's source order, not by the later class.
              className={groupStart ? 'mt-6 first:mt-0' : 'mt-1'}
            >
              <MessageBubble
                msg={m}
                me={me}
                authorName={author?.name ?? 'Unknown'}
                authorAvatar={author?.avatar ?? null}
                authorAccent={author?.accent ?? null}
                canModerate={canModerate}
                groupStart={groupStart}
                replyTarget={replyTarget}
                replyTargetName={
                  replyTarget !== undefined
                    ? (directory.get(replyTarget.authorId)?.name ?? undefined)
                    : undefined
                }
                highlighted={m.mentions.includes(me)}
                tabIndex={i === activeMessageIndex ? 0 : -1}
                onReply={setReplyTo}
                onJump={jumpTo}
              />
            </div>
          );
        })}
        {activeTypers.length > 0 && (
          <div className="mt-4 flex items-center gap-2 px-2">
            <TypingDots />
            <span className="truncate text-label text-low">
              {activeTypers.length === 1
                ? `${activeTypers[0]} is typing`
                : `${activeTypers.length} people are typing`}
            </span>
          </div>
        )}
      </div>

      {seenByCount > 0 && (
        <p className="px-3 pb-1 text-right text-caption text-low">Seen by {seenByCount}</p>
      )}

      <Composer
        roomId={roomId}
        disabled={!composerEnabled}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        mentionables={mentionables}
      />
    </section>
  );
}
