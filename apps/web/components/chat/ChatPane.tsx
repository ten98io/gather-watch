'use client';

/**
 * ChatPane — the full room chat surface: server-ordered history with "load
 * earlier" pagination, live messages, markdown-lite, replies, edit/delete
 * tombstones, per-emoji reactions, typing dots, read receipts, pins rail,
 * full-text search, @mention highlight. All state from the shared
 * RoomConnection store; sends are ClientEvents (never optimistic).
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
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTabBadge, useTabPanelActive } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
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
            phase === i ? 'bg-aurora-1 opacity-100' : 'bg-low opacity-40',
          )}
        />
      ))}
    </span>
  );
}

function PinsRail({ pinned, onJump }: { pinned: Message[]; onJump(id: MessageId): void }) {
  const [open, setOpen] = useState(false);
  if (pinned.length === 0) return null;
  return (
    <div className="border-b border-border-glass bg-glass px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-mid hover:text-hi"
        aria-expanded={open}
      >
        📌 {pinned.length} pinned {open ? '▾' : '▸'}
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1">
          {pinned.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onJump(m.id)}
                className="w-full truncate text-left text-xs text-low hover:text-hi"
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
   * The one message in the tab order. Defaults to the newest — Tab from the
   * composer should land on what just arrived, not on 300-messages-ago — and
   * is clamped so a pruned or paginated window can never strand the tab stop
   * on an index that no longer renders.
   */
  const activeMessageIndex =
    messages.length === 0
      ? -1
      : rovingIndex < 0
        ? messages.length - 1
        : Math.min(rovingIndex, messages.length - 1);

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

  // Member directory: author names + mention candidates (shared query cache
  // key with PeoplePane).
  const membersQuery = useQuery({
    queryKey: ['members', roomId],
    queryFn: () => api.rooms.listMembers(roomId),
  });
  const directory = useMemo(() => {
    const map = new Map<UserId, { name: string; accent: string | null }>();
    for (const { user } of membersQuery.data?.members ?? []) {
      map.set(user.id, { name: user.displayName, accent: user.accentColor });
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
      {/* header: search toggle */}
      <div className="flex items-center gap-2 border-b border-border-glass px-3 py-1.5">
        <span className="flex-1 text-xs font-medium text-low">
          {messages.length} message{messages.length === 1 ? '' : 's'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Search chat"
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        >
          🔍
        </Button>
      </div>

      {searchOpen && (
        <div className="border-b border-border-glass p-2">
          <Input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search messages…"
            aria-label="Search messages"
          />
          {searchQ.trim().length > 0 && (
            <ul className="mt-1 max-h-40 overflow-y-auto">
              {(searchQuery.data?.items ?? []).map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      jumpTo(m.id);
                      setSearchOpen(false);
                    }}
                    className="w-full truncate rounded px-2 py-1 text-left text-xs text-mid hover:bg-glass"
                  >
                    {directory.get(m.authorId)?.name ?? '?'}: {m.body}
                  </button>
                </li>
              ))}
              {searchQuery.isSuccess && (searchQuery.data?.items.length ?? 0) === 0 && (
                <li className="px-2 py-1 text-xs text-low">No matches.</li>
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
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2"
      >
        {!historyExhausted && messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadEarlier()}
            disabled={loadingMore}
            className="self-center"
          >
            {loadingMore ? 'Loading…' : 'Load earlier messages'}
          </Button>
        )}
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            {membersQuery.isPending ? (
              <>
                <Skeleton className="h-8 w-3/4" />
                <Skeleton className="h-8 w-1/2" />
              </>
            ) : (
              <p className="text-sm text-low">No messages yet — say hi 👋</p>
            )}
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const groupStart =
            prev === undefined ||
            prev.authorId !== m.authorId ||
            m.createdAt - prev.createdAt > 5 * 60_000;
          const replyTarget = m.replyTo !== null ? byId.get(m.replyTo) : undefined;
          return (
            <div key={m.id} data-message={m.id}>
              <MessageBubble
                msg={m}
                me={me}
                authorName={directory.get(m.authorId)?.name ?? 'Unknown'}
                authorAccent={directory.get(m.authorId)?.accent ?? null}
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
          <div className="flex items-center gap-2 px-1 pt-1">
            <TypingDots />
            <span className="text-xs text-low">
              {activeTypers.length === 1
                ? `${activeTypers[0]} is typing`
                : `${activeTypers.length} people are typing`}
            </span>
          </div>
        )}
      </div>

      {seenByCount > 0 && (
        <p className="px-3 pb-1 text-right text-[10px] text-low">Seen by {seenByCount}</p>
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
