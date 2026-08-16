'use client';

/**
 * ChatPane — the full room chat surface: server-ordered history with "load
 * earlier" pagination, live messages, markdown-lite, replies, edit/delete
 * tombstones, per-emoji reactions, typing dots, read receipts, pins rail,
 * full-text search, @mention highlight. All state from the shared
 * RoomConnection store; sends are ClientEvents (never optimistic).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Message, MessageId, RoomId, UserId } from '@gather/contracts';
import { api } from '@/lib/api';
import { canAct } from '@/lib/permissions';
import { useRoom, useRoomConnection } from '@/lib/room-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [tick, setTick] = useState(0); // prunes typing indicators once a second
  const lastReadSentRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, []);

  // Read cursor: advance to the newest seq (once per seq).
  const latestSeq = messages.length > 0 ? (messages[messages.length - 1]?.seq ?? 0) : 0;
  useEffect(() => {
    if (latestSeq > lastReadSentRef.current) {
      lastReadSentRef.current = latestSeq;
      connection.chatRead(latestSeq);
    }
  }, [connection, latestSeq]);

  // Stick to bottom for new messages unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el !== null && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

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
