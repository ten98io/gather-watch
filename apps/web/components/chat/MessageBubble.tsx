'use client';

/**
 * MessageBubble — one message in the log: byline, quote, markdown-lite body,
 * gif / attachment / voice rendering, reactions with counts, tombstones, and
 * the right-click action menu (react / reply / edit / delete / pin / report).
 *
 * ── It is not a bubble any more, and that is the point ────────────────────
 * The name is kept because it is the import every consumer and test already
 * writes. The SHAPE changed: two columns of opposed glass lozenges became one
 * editorial column — a 32px author gutter, a byline set in `label` + `caption`,
 * and the message body at `body`. Bubbles cost the log twice over. Mine-vs-
 * theirs alignment threw away the left margin every eye scans down, and a
 * lozenge per message meant a fast room repeated the author, the surface and
 * the border on every line. A run of six messages now reads as one block with
 * one byline over it, which is what a run of six messages IS.
 *
 * Consecutive-message grouping is decided by ChatPane (it owns the window and
 * therefore the previous message) and arrives as `groupStart`; the vertical
 * rhythm between runs lives there too, on the row wrapper, for the same reason.
 *
 * Actions live behind a context menu rather than a hover bar. The hover bar
 * cost a row of layout under every message the pointer crossed, so the log
 * reflowed as you moved through it, and it was unreachable without a pointer.
 * The menu opens on right-click, on long-press (touch), and on the keyboard
 * Menu key — the row carries `tabIndex` from `triggerProps` so that last one
 * has somewhere to land.
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import type { Message, MessageId, UserId } from '@gather/contracts';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuRow,
  useContextMenuTrigger,
} from '@/components/ui/context-menu';
import { PaperclipIcon, PinIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { HOVER_REVEAL } from '@/components/ui/media-row';
import { ReportDialog } from '@/components/report/ReportDialog';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import { parseMarkdownLite } from '@/lib/markdown-lite';
import { useRoomConnection } from '@/lib/room-context';
import { useReducedMotion } from '@/hooks/useReducedMotion';

const QUICK_REACTIONS = ['👍', '😂', '❤️', '🔥'] as const;

/**
 * The author gutter. One number, spent twice: the avatar's box on a group
 * start and the hover-revealed time on a continuation, so every line of a run
 * hangs off the same left edge whether or not anything is drawn in it.
 */
const GUTTER = 'w-8 shrink-0';

/**
 * Clock only, for the gutter. `formatTimestamp` widens to "Mon 14:05" or
 * "Jan 5" once a message is older than today, and none of those fit 32px —
 * a continuation line only needs to say WHEN inside its run, and the run's
 * byline above it already carries the day.
 */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MessageBody({ body }: { body: string }) {
  const spans = parseMarkdownLite(body);
  return (
    <p className="whitespace-pre-wrap break-words text-body text-hi">
      {spans.map((s, i) =>
        s.link ? (
          /* `text-hi` + an accent underline, NOT `text-ring`. The focus ring is
             a 3:1 non-text token: as link ink on the light theme it measured
             4.53:1 on `--surface-1`, 3.97 on `--surface-2` and 3.52 on
             `--surface-3`, all under the 4.5:1 text bar. DESIGN.md §2 gives the
             fix for exactly this — the text takes `--text-hi` and the accent
             moves to an adjacent non-text mark. */
          <a
            key={i}
            href={s.text}
            target="_blank"
            rel="noopener noreferrer"
            className="text-hi underline decoration-accent underline-offset-2 hover:decoration-2"
          >
            {s.text}
          </a>
        ) : (
          <span
            key={i}
            className={cn(
              s.bold && 'font-bold',
              s.italic && 'italic',
              // `bg-surface-3`, not `bg-white/10`: a colour literal outside
              // packages/design is the drift the token package exists to stop.
              s.code && 'rounded-sm bg-surface-3 px-1 font-mono text-label',
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
    return <audio controls src={att.url} className="mt-2 h-8 w-full max-w-xs" />;
  }
  if (att.mime.startsWith('image/')) {
    return (
      // Chat attachments come from our own media service; next/image adds no
      // value for arbitrary user uploads.
      <img src={att.url} alt={att.name} className="mt-2 max-h-64 max-w-full rounded-card" />
    );
  }
  if (att.mime.startsWith('video/')) {
    return <video controls src={att.url} className="mt-2 max-h-64 max-w-full rounded-card" />;
  }
  return (
    <a
      href={att.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'mt-2 inline-flex max-w-full items-center gap-2 rounded-ctl bg-surface-2 px-3 py-2',
        'text-label text-hi transition-colors duration-150 hover:bg-surface-3',
      )}
    >
      <PaperclipIcon size={14} />
      <span className="truncate">{att.name}</span>
      <span className="shrink-0 tabular text-low">{Math.round(att.sizeBytes / 1024)} KB</span>
    </a>
  );
}

export function MessageBubble({
  msg,
  me,
  authorName,
  authorAvatar = null,
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
  /** Author's avatar, drawn in the gutter on a group start. */
  authorAvatar?: string | null;
  authorAccent: string | null;
  canModerate: boolean;
  /** First message of an author run — shows the avatar and the byline. */
  groupStart: boolean;
  replyTarget: Message | undefined;
  replyTargetName: string | undefined;
  /** I am @mentioned — the row takes a step up plus an accent edge. */
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
  const [reporting, setReporting] = useState(false);
  const mine = msg.authorId === me;
  const time = formatTimestamp(msg.createdAt);
  const stamp = new Date(msg.createdAt).toISOString();

  if (msg.deletedAt !== null) {
    // Through the same two columns as a live message, with an empty gutter:
    // a tombstone that indents differently reads as a different KIND of event.
    return (
      <div className="flex gap-3 px-2 py-1">
        <span aria-hidden className={GUTTER} />
        <p className="text-label italic text-low">Message deleted</p>
      </div>
    );
  }

  if (msg.kind === 'system') {
    /* A room event is not a message and is not set like one: centred, at
       `caption`, between two hairlines so it reads as a rule across the log
       rather than as something somebody said. */
    return (
      <div className="flex items-center gap-3 px-2 py-2" role="status">
        <span aria-hidden className="h-px flex-1 bg-hairline" />
        <span className="text-caption text-low">{msg.body}</span>
        <span aria-hidden className="h-px flex-1 bg-hairline" />
      </div>
    );
  }

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduced ? { duration: 0.15 } : { type: 'spring', stiffness: 260, damping: 30 }}
      {...triggerProps}
      // Roving tab stop: the log owns which message is reachable, so a
      // 300-message window costs ONE tab stop, not 300. Overrides the
      // hook's default of 0 — order matters, this must follow the spread.
      tabIndex={tabIndex}
      data-msg-focusable=""
      // `role="article"` is what makes the label below an accessible NAME.
      // A bare <div aria-label> has the generic role, and a name on a generic
      // element is dropped by every screen reader — so the label that carries
      // the author on a grouped continuation line (the whole reason grouping
      // is safe to do) was being written and never read.
      role="article"
      // The run boundary, stated in the DOM. It is what the byline and the
      // 24px-vs-4px rhythm are both drawn from, so it is worth being able to
      // read back without inferring it from a class name.
      {...(groupStart ? { 'data-group-start': '' } : {})}
      aria-label={`Message from ${authorName}. Press the menu key for actions.`}
      className={cn(
        'group relative flex gap-3 rounded-card px-2 py-1',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // Mutually exclusive, because cn() is a plain joiner and the later
        // class does not win: a mentioned row is already a step up, so its
        // hover has to be the step above that one.
        highlighted ? 'bg-surface-2 hover:bg-surface-3' : 'hover:bg-surface-2',
      )}
    >
      {highlighted && (
        <span aria-hidden className="absolute inset-y-1 left-0 w-edge rounded-pill bg-accent" />
      )}

      <div className={GUTTER}>
        {groupStart ? (
          /* Decorative: the row is named "Message from Robin" and the byline
             beside the orb says "Robin" again — a third announcement is not
             information. The accent ring is still doing its job, which is to
             tell authors apart by EYE down a fast log. */
          <Avatar
            decorative
            src={authorAvatar}
            name={authorName}
            accentColor={authorAccent}
            size={32}
          />
        ) : (
          /* The run's other lines carry their time here instead — revealed on
             hover, and ALWAYS visible where there is no hover to give
             (HOVER_REVEAL, DESIGN.md §10). Repeating it on every line is the
             noise grouping exists to remove. */
          <time
            dateTime={stamp}
            className={cn('block pt-1 text-right tabular text-caption text-low', HOVER_REVEAL)}
          >
            {clock(msg.createdAt)}
          </time>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {groupStart && (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-label text-hi">{mine ? 'You' : authorName}</span>
            <time dateTime={stamp} className="shrink-0 tabular text-caption text-low">
              {time}
            </time>
          </div>
        )}

        {msg.pinned && (
          <span className="mt-1 flex items-center gap-1 text-caption text-low">
            <PinIcon size={12} />
            Pinned
          </span>
        )}

        {replyTarget !== undefined && (
          <button
            type="button"
            onClick={() => onJump?.(replyTarget.id)}
            className={cn(
              'mt-1 block w-full truncate rounded-sm bg-surface-2 px-2 py-1 text-left',
              'text-label text-low transition-colors duration-150 hover:bg-surface-3',
            )}
          >
            {replyTargetName !== undefined && <span className="text-hi">{replyTargetName} </span>}
            {replyTarget.deletedAt !== null ? 'Message deleted' : replyTarget.body.slice(0, 120)}
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
            className="mt-1 flex flex-col gap-2"
          >
            <Input
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              aria-label="Edit message"
              autoFocus
            />
            <div className="flex items-center gap-2">
              {/* `secondary`, not the default primary: the composer's Send is
                  this region's one aurora action (DESIGN.md §2, §8), and a
                  second gradient beside it makes both mean "a button". */}
              <Button size="sm" variant="secondary" type="submit">
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            {msg.kind === 'gif' && msg.gifUrl !== null ? (
              <img
                src={msg.gifUrl}
                alt={msg.body || 'GIF'}
                className="mt-1 max-h-48 max-w-full rounded-card"
              />
            ) : (
              msg.body.length > 0 && (
                <div className="mt-1">
                  <MessageBody body={msg.body} />
                </div>
              )
            )}
            <AttachmentView msg={msg} />
            {msg.editedAt !== null && (
              <span className="mt-1 block text-caption text-low">Edited</span>
            )}
          </>
        )}

        {Object.keys(msg.reactions).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.entries(msg.reactions).map(([emoji, users]) => {
              const reacted = users.includes(me);
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => connection.chatReact(msg.id, emoji, reacted ? 'remove' : 'add')}
                  className={cn(
                    // `h-ctl-sm`, not a Tailwind step: a reaction is a control
                    // and 24px of it was unhittable with a thumb. The token is
                    // 28px under a mouse and 44px under a finger (DESIGN.md
                    // §4, §9), so the log stays dense where density is free.
                    'inline-flex h-ctl-sm items-center gap-1 rounded-pill border px-2',
                    'text-label transition-colors duration-150',
                    // Ternary, not two additive classes: `border` and `bg` are
                    // one decision with two states.
                    reacted
                      ? 'border-accent bg-surface-3 text-hi'
                      : 'border-hairline bg-surface-2 text-low hover:text-hi',
                  )}
                  aria-label={`React ${emoji}, ${users.length}`}
                  aria-pressed={reacted}
                >
                  {/* The emoji is content and the count is metadata, so they
                      are not set at the same step: `body` on the glyph (13px
                      emoji is a smudge), `label` — inherited — on the number. */}
                  <span aria-hidden className="text-body">
                    {emoji}
                  </span>
                  <span className="tabular">{users.length}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Editing owns the row outright — offering Edit/Delete on top of an
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
                  // Square on the control token, so the picker is 28px under a
                  // mouse and 44px under a finger like every other control.
                  className="w-ctl-sm px-0"
                  onClick={() => {
                    connection.chatReact(msg.id, emoji, reacted ? 'remove' : 'add');
                    close();
                  }}
                >
                  {/* On the child, not on the Button: the size class already
                      carries `text-label`, and two font-size utilities on one
                      element are resolved by CSS source order, not by cn(). */}
                  <span className="text-body">{emoji}</span>
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
                  .catch(() => toast.error('Couldn’t update the pin'));
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
          {/* Reporting is open to everyone the message is not FROM — there is
              nothing to escalate about your own words, and moderating is a
              separate power from telling the operator. */}
          {!mine && (
            <ContextMenuItem onSelect={() => setReporting(true)} onClose={close}>
              Report
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}

      {/* Outside the menu on purpose — the menu unmounts as it closes, and a
          dialog owned by it would go with it before it ever painted — and
          mounted only while it is open: the log holds MAX_MESSAGES (300)
          rows, and <Dialog> opens a portal per instance. */}
      {reporting && (
        <ReportDialog
          open
          onOpenChange={setReporting}
          target={{ kind: 'message', messageId: msg.id, roomId: msg.roomId }}
          subject="this message"
        />
      )}
    </motion.div>
  );
}
