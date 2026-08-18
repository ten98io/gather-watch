'use client';

/**
 * MessageBubble — one chat message: quote, markdown-lite body, gif /
 * attachment / voice rendering, reactions with counts, tombstones, and the
 * right-click action menu (react / reply / edit / delete / pin). Author accent
 * leading edge on group starts (DESIGN.md §8); bubbles pop in with a spring.
 *
 * Actions live behind a context menu rather than a hover bar. The hover bar
 * cost a row of layout under every message the pointer crossed, so the log
 * reflowed as you moved through it, and it was unreachable without a pointer.
 * The menu opens on right-click, on long-press (touch), and on the keyboard
 * Menu key — the bubble carries `tabIndex` from `triggerProps` so that last
 * one has somewhere to land.
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import type { Message, MessageId, UserId } from '@gather/contracts';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuRow,
  useContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { parseMarkdownLite } from '@/lib/markdown-lite';
import { useRoomConnection } from '@/lib/room-context';
import { useReducedMotion } from '@/hooks/useReducedMotion';

const QUICK_REACTIONS = ['👍', '😂', '❤️', '🔥'] as const;

export function MessageBody({ body }: { body: string }) {
  const spans = parseMarkdownLite(body);
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-hi">
      {spans.map((s, i) =>
        s.link ? (
          <a
            key={i}
            href={s.text}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ring underline"
          >
            {s.text}
          </a>
        ) : (
          <span
            key={i}
            className={cn(
              s.bold && 'font-bold',
              s.italic && 'italic',
              s.code && 'rounded bg-white/10 px-1 font-mono text-[13px]',
            )}
          >
            {s.text}
          </span>
        ),
      )}
    </p>
  );
}

function AttachmentView({ msg }: { msg: Message }) {
  const att = msg.attachment;
  if (att === null) return null;
  if (msg.kind === 'voice' || att.mime.startsWith('audio/')) {
    // Inline voice/audio player (spec: voice notes with inline playback).
    return (
      <audio controls src={att.url} className="mt-1 w-64 max-w-full" />
    );
  }
  if (att.mime.startsWith('image/')) {
    return (
      // Chat attachments come from our own media service; next/image adds no
      // value for arbitrary user uploads.
      <img
        src={att.url}
        alt={att.name}
        className="mt-1 max-h-64 max-w-full rounded-ctl"
      />
    );
  }
  if (att.mime.startsWith('video/')) {
    return <video controls src={att.url} className="mt-1 max-h-64 max-w-full rounded-ctl" />;
  }
  return (
    <a
      href={att.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 block rounded-ctl bg-white/5 px-3 py-2 text-sm text-ring underline"
    >
      📎 {att.name} ({Math.round(att.sizeBytes / 1024)} KB)
    </a>
  );
}

export function MessageBubble({
  msg,
  me,
  authorName,
  authorAccent,
  canModerate,
  groupStart,
  replyTarget,
  replyTargetName,
  highlighted,
  tabIndex,
  onReply,
  onJump,
}: {
  msg: Message;
  me: UserId;
  authorName: string;
  authorAccent: string | null;
  canModerate: boolean;
  /** First message of an author run — shows name + accent edge. */
  groupStart: boolean;
  replyTarget: Message | undefined;
  replyTargetName: string | undefined;
  /** I am @mentioned — aurora highlight (spec: mentions with highlight). */
  highlighted: boolean;
  /** Roving tab stop: 0 for the log's one reachable message, -1 otherwise. */
  tabIndex: number;
  onReply(msg: Message): void;
  onJump?(messageId: MessageId): void;
}) {
  const connection = useRoomConnection();
  const reduced = useReducedMotion();
  const { point, close, triggerProps } = useContextMenuTrigger();
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(msg.body);
  const mine = msg.authorId === me;

  if (msg.deletedAt !== null) {
    return (
      <div className={cn('flex', mine && 'justify-end')}>
        <div className="rounded-card border border-dashed border-border-glass px-3 py-1.5">
          <span className="text-xs italic text-low">Message deleted</span>
        </div>
      </div>
    );
  }

  if (msg.kind === 'system') {
    return (
      <p className="py-1 text-center text-xs italic text-low" role="status">
        {msg.body}
      </p>
    );
  }

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduced ? { duration: 0.15 } : { type: 'spring', stiffness: 260, damping: 30 }}
      className={cn('group flex flex-col', mine && 'items-end')}
    >
      {groupStart && !mine && (
        <span className="mb-0.5 ml-1 text-xs text-low">{authorName}</span>
      )}
      <div
        {...triggerProps}
        // Roving tab stop: the log owns which message is reachable, so a
        // 300-message window costs ONE tab stop, not 300. Overrides the
        // hook's default of 0 — order matters, this must follow the spread.
        tabIndex={tabIndex}
        data-msg-focusable=""
        aria-label={`Message from ${authorName}. Press the menu key for actions.`}
        className={cn(
          'relative max-w-[85%] rounded-card border border-border-glass px-3 py-2',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          mine ? 'bg-[rgba(149,91,254,0.16)]' : 'glass-raised',
          !mine && groupStart && 'border-l-2',
          highlighted && 'ring-1 ring-aurora-3',
        )}
        style={
          !mine && groupStart && authorAccent !== null
            ? { borderLeftColor: authorAccent }
            : undefined
        }
      >
        {msg.pinned && (
          <span className="absolute -top-2 right-2 rounded-full bg-raised px-1.5 text-[10px] text-low">
            📌
          </span>
        )}
        {replyTarget !== undefined && (
          <button
            type="button"
            onClick={() => onJump?.(replyTarget.id)}
            className="mb-1 block w-full border-l-2 border-aurora-2 pl-2 text-left opacity-80"
          >
            <span className="text-xs text-mid">
              {replyTargetName !== undefined ? `${replyTargetName}: ` : ''}
              {replyTarget.deletedAt !== null ? 'Message deleted' : replyTarget.body.slice(0, 120)}
            </span>
          </button>
        )}
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const body = editDraft.trim();
              if (body.length > 0) connection.chatEdit(msg.id, body);
              setEditing(false);
            }}
            className="flex items-center gap-2"
          >
            <input
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              className="w-56 rounded-ctl border border-border-glass bg-glass px-2 py-1 text-sm text-hi"
              aria-label="Edit message"
              autoFocus
            />
            <Button size="sm" type="submit">Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </form>
        ) : (
          <>
            {msg.kind === 'gif' && msg.gifUrl !== null ? (
              <img src={msg.gifUrl} alt={msg.body || 'GIF'} className="max-h-48 max-w-full rounded-ctl" />
            ) : (
              msg.body.length > 0 && <MessageBody body={msg.body} />
            )}
            <AttachmentView msg={msg} />
            {msg.editedAt !== null && <span className="mt-0.5 block text-[10px] text-low">(edited)</span>}
          </>
        )}
      </div>

      {Object.keys(msg.reactions).length > 0 && (
        <div className={cn('mt-1 flex flex-wrap gap-1', mine && 'justify-end')}>
          {Object.entries(msg.reactions).map(([emoji, users]) => (
            <button
              key={emoji}
              type="button"
              onClick={() =>
                connection.chatReact(msg.id, emoji, users.includes(me) ? 'remove' : 'add')
              }
              className={cn(
                'rounded-full border border-border-glass bg-glass px-2 py-0.5 text-xs text-hi',
                users.includes(me) && 'border-aurora-1 bg-[rgba(149,91,254,0.2)]',
              )}
              aria-label={`React ${emoji}, ${users.length}`}
            >
              {emoji} {users.length}
            </button>
          ))}
        </div>
      )}

      {/* Editing owns the bubble outright — offering Edit/Delete on top of an
          open editor is two ways to change one message at the same time. */}
      {!editing && (
        <ContextMenu point={point} onClose={close} label="Message actions">
          <ContextMenuRow>
            {QUICK_REACTIONS.map((emoji) => {
              const users = msg.reactions[emoji] ?? [];
              const reacted = users.includes(me);
              return (
                <Button
                  key={emoji}
                  variant="secondary"
                  size="sm"
                  role="menuitem"
                  aria-pressed={reacted}
                  aria-label={reacted ? `Remove ${emoji} reaction` : `React ${emoji}`}
                  className="h-8 w-9 px-0 text-sm"
                  onClick={() => {
                    connection.chatReact(msg.id, emoji, reacted ? 'remove' : 'add');
                    close();
                  }}
                >
                  {emoji}
                </Button>
              );
            })}
          </ContextMenuRow>
          <ContextMenuItem onSelect={() => onReply(msg)} onClose={close}>
            Reply
          </ContextMenuItem>
          {mine && msg.kind === 'text' && (
            <ContextMenuItem
              onSelect={() => {
                setEditDraft(msg.body);
                setEditing(true);
              }}
              onClose={close}
            >
              Edit
            </ContextMenuItem>
          )}
          {canModerate && (
            <ContextMenuItem
              onSelect={() => {
                void api.messages
                  .pinMessage(msg.roomId, { messageId: msg.id, pinned: !msg.pinned })
                  .catch(() => toast.error('Could not update the pin'));
              }}
              onClose={close}
            >
              {msg.pinned ? 'Unpin' : 'Pin'}
            </ContextMenuItem>
          )}
          {(mine || canModerate) && (
            <ContextMenuItem
              destructive
              onSelect={() => connection.chatDelete(msg.id)}
              onClose={close}
            >
              Delete
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}
    </motion.div>
  );
}
