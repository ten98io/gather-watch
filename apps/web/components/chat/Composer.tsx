'use client';

/**
 * Composer — the messaging surface: a field you write in, with its tools on a
 * row beneath it. Typing signals, emoji popover, GIF picker, attachment upload
 * with progress, voice notes (MediaRecorder), and a debounced link-unfurl
 * preview (server-side, SSRF-guarded). Sends contracts chat.send ClientEvents;
 * nothing optimistic — the server-ordered chat.message event is the single
 * source of truth.
 *
 * ── Why the row became a plate (2026-08-19) ───────────────────────────────
 * It was one horizontal line — [attach] [GIF] [pill + emoji] [send] — and four
 * controls crowded around a 380px rail's worth of field left the writing space
 * as the smallest thing in the composer. The field now owns the top of a plate
 * and the four tools sit under it, so the surface reads as somewhere to write
 * rather than as a toolbar that happens to accept text. Nothing about the flow
 * moved: typing into an already-focused field is not a step, and Enter still
 * sends (DESIGN.md §12 — "send a message" stays at 1).
 *
 * The plate also absorbs everything that MODIFIES the message you are about to
 * send — the reply you are answering, the link that will unfurl — because those
 * are part of the draft. What is merely happening (an upload, a mention
 * suggestion) stays outside it.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Message, RoomId, UserId } from '@gather/contracts';
import { Button } from '@/components/ui/button';
import {
  MicIcon,
  PaperclipIcon,
  SendIcon,
  SmileIcon,
  StopCircleIcon,
  XIcon,
} from '@/components/ui/icons';
import { toast } from '@/components/ui/toast';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { api } from '@/lib/api';
import { uploadChatAttachment } from '@/lib/attachments';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/describe-error';
import { firstUrl } from '@/lib/markdown-lite';
import { useRoomConnection } from '@/lib/room-context';
import { GifPicker } from './GifPicker';

/** Emoji popover grid, 8 per row. Row 1 is the legacy always-visible strip. */
const EMOJI_GRID = [
  '😀', '😂', '🔥', '❤️', '👍', '🎉', '😮', '😢',
  '🤣', '😊', '😍', '😎', '🤔', '😅', '🙌', '👏',
  '🙏', '💯', '✨', '🥳', '😴', '😭', '😡', '👀',
] as const;

/**
 * Auto-grow ceiling: five lines at the `body` step's 26px leading, plus the
 * field's own 16px of vertical padding. Tied to the ramp on purpose — the old
 * 20px here was `text-sm`'s leading, and it outlived the size it came from.
 */
const MAX_TEXTAREA_PX = 5 * 26 + 16;

/** Shorter than this and it was a mis-tap, not a message. */
const MIN_VOICE_MS = 400;

/** A finished recording waiting for the user to send or discard it. */
interface PendingVoice {
  file: File;
  durationMs: number;
  /** Object URL for local playback; revoked when the take goes away. */
  url: string;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export interface Mentionable {
  userId: UserId;
  displayName: string;
}

/**
 * Compact emoji panel above the plate. Closes on Escape, on outside
 * pointerdown, and after a pick unless a modifier is held (multi-pick).
 * Constrained to the composer's own width so it never widens the 380px rail.
 */
function EmojiPopover({
  open,
  triggerRef,
  onClose,
  onPick,
}: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** restoreFocus: put the caret back in the message field (not on outside clicks). */
  onClose(restoreFocus: boolean): void;
  onPick(emoji: string): void;
}) {
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) === true) return;
      // The trigger toggles itself — let its click handler own that case.
      if (triggerRef.current?.contains(target) === true) return;
      onClose(false);
    };
    // Capture phase: Escape closes the popover without also reaching the
    // document-level Escape handlers of the mobile Sheet / any open Dialog.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, triggerRef]);

  // The panel sits earlier in the DOM than its trigger (it is absolutely
  // positioned over the row), so move focus into it to keep the tab order sane.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [open]);

  const motionProps = reduced
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.15 },
      }
    : {
        initial: { opacity: 0, y: 6, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 4, scale: 0.98 },
        transition: { type: 'spring' as const, stiffness: 260, damping: 30 },
      };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label="Emoji picker"
          /* `shadow-e2`, not `shadow-glow`. A picker is chrome that floats, and
             glow is a signature moment (DESIGN.md §5) — a 40px aurora halo
             under an emoji grid is the toy tell §4 exists to stop. Solid ladder
             rather than glass for the same reason: nothing is playing behind
             the rail. */
          className="absolute bottom-full left-0 right-0 z-[60] mb-2 rounded-card border border-hairline bg-surface-2 p-2 shadow-e2"
          {...motionProps}
        >
          <div className="grid grid-cols-8 gap-1">
            {EMOJI_GRID.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Insert ${emoji}`}
                className={cn(
                  'flex h-ctl-md items-center justify-center rounded-ctl text-body leading-none',
                  'transition-colors duration-150 hover:bg-surface-3',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
                onClick={(e) => {
                  onPick(emoji);
                  if (!(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) onClose(true);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Composer({
  roomId,
  disabled,
  replyTo,
  onCancelReply,
  mentionables,
}: {
  roomId: RoomId;
  disabled: boolean;
  replyTo: Message | null;
  onCancelReply(): void;
  mentionables: Mentionable[];
}) {
  const connection = useRoomConnection();
  const reduced = useReducedMotion();
  const [draft, setDraft] = useState('');
  const [gifOpen, setGifOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [unfurl, setUnfurl] = useState<{
    url: string;
    title: string | null;
    siteName: string | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const emojiTriggerRef = useRef<HTMLButtonElement | null>(null);
  const typingSentRef = useRef(false);
  const typingStopHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  // ── @mention autocomplete ──
  const mentionMatch = /@([\p{L}\p{N}_-]{0,40})$/u.exec(draft);
  const mentionCandidates = useMemo(() => {
    if (mentionMatch === null) return [];
    const q = (mentionMatch[1] ?? '').toLowerCase();
    return mentionables
      .filter((m) => m.displayName.toLowerCase().includes(q))
      .slice(0, 5);
  }, [mentionMatch, mentionables]);
  const [mentions, setMentions] = useState<UserId[]>([]);

  // ── unfurl preview (debounced; composer-side, spec §Chat) ──
  useEffect(() => {
    const url = firstUrl(draft);
    if (url === null) {
      setUnfurl(null);
      return;
    }
    const handle = setTimeout(() => {
      api.messages
        .unfurl({ url })
        .then((res) => setUnfurl({ url: res.url, title: res.title, siteName: res.siteName }))
        .catch(() => setUnfurl(null));
    }, 600);
    return () => clearTimeout(handle);
  }, [draft]);

  const signalTyping = (): void => {
    if (!typingSentRef.current) {
      typingSentRef.current = true;
      connection.chatTyping(true);
    }
    if (typingStopHandle.current !== null) clearTimeout(typingStopHandle.current);
    typingStopHandle.current = setTimeout(() => {
      typingSentRef.current = false;
      connection.chatTyping(false);
    }, 2500);
  };

  const stopTyping = (): void => {
    if (typingStopHandle.current !== null) clearTimeout(typingStopHandle.current);
    if (typingSentRef.current) {
      typingSentRef.current = false;
      connection.chatTyping(false);
    }
  };

  /* ── voice notes (MediaRecorder → review → the attachment upload path) ──
     Stopping the recorder does NOT send. A take lands in `pendingVoice` and
     waits: play it back, then send or discard. iMessage and WhatsApp both work
     this way, and for the same reason — a voice note is the one message kind
     you cannot re-read before committing to it, so the only chance to catch a
     bad take is after the recorder stops and before anyone else hears it. */
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef(0);
  /** A finished take awaiting the user's decision. Never auto-sends. */
  const [pendingVoice, setPendingVoice] = useState<PendingVoice | null>(null);
  const [voiceSending, setVoiceSending] = useState(false);
  /** Set while stopping to discard, so onstop knows not to keep the take. */
  const discardOnStopRef = useRef(false);
  // Late-resolving sends (voice upload) must use the reply target as it stands
  // when they land, not as it stood when recording started.
  const replyToRef = useRef(replyTo);
  useEffect(() => {
    replyToRef.current = replyTo;
  }, [replyTo]);

  useEffect(() => {
    if (!recording) return;
    const handle = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
    return () => clearInterval(handle);
  }, [recording]);

  // Unmount: drop the pending typing-stop timer and release the microphone.
  useEffect(
    () => () => {
      unmountedRef.current = true;
      if (typingStopHandle.current !== null) clearTimeout(typingStopHandle.current);
      const recorder = recorderRef.current;
      if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
    },
    [],
  );

  const startRecording = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        const discarded = discardOnStopRef.current;
        discardOnStopRef.current = false;
        // Composer went away (mobile sheet closed): mic released, take dropped.
        if (unmountedRef.current) return;
        setRecording(false);
        if (discarded) return;
        const durationMs = Date.now() - startedAtRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        // A take under ~0.4s is a mis-tap, not a message. Dropping it silently
        // is friendlier than shipping an empty bubble or scolding the user.
        if (blob.size === 0 || durationMs < MIN_VOICE_MS) return;
        setPendingVoice({
          file: new File([blob], 'voice-note.webm', { type: blob.type }),
          durationMs,
          url: URL.createObjectURL(blob),
        });
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      recorder.start();
      setRecording(true);
    } catch {
      toast.error('Microphone unavailable — check browser permissions');
    }
  };

  const stopRecording = (): void => {
    recorderRef.current?.stop();
  };

  /** Abandon the take mid-recording — the slide-to-cancel gesture's target. */
  const cancelRecording = (): void => {
    discardOnStopRef.current = true;
    recorderRef.current?.stop();
  };

  const discardPendingVoice = (): void => {
    setPendingVoice((prev) => {
      if (prev !== null) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  const sendPendingVoice = (): void => {
    const take = pendingVoice;
    if (take === null || voiceSending) return;
    setVoiceSending(true);
    void uploadChatAttachment(roomId, take.file, { durationMs: take.durationMs })
      .then((attachment) => {
        connection.chatSend({
          kind: 'voice',
          body: 'Voice note',
          attachment,
          replyTo: replyToRef.current?.id ?? null,
        });
        onCancelReply();
        // Only drop the take once it is actually sent — a failed upload must
        // leave it on screen so the recording is not lost with nothing to retry.
        URL.revokeObjectURL(take.url);
        setPendingVoice(null);
      })
      .catch((err: unknown) => {
        toast.error(describeError(err, 'Couldn’t send that voice note'));
      })
      .finally(() => {
        if (!unmountedRef.current) setVoiceSending(false);
      });
  };

  // Never leak the object URL if the composer goes away mid-review.
  useEffect(
    () => () => {
      if (pendingVoice !== null) URL.revokeObjectURL(pendingVoice.url);
    },
    [pendingVoice],
  );

  const send = (): void => {
    const body = draft.trim();
    if (disabled || body.length === 0) return;
    // Mentions go stale when their @DisplayName text is edited out of the
    // draft — only send the ones the body still names.
    const live = mentions.filter((id) => {
      const target = mentionables.find((m) => m.userId === id);
      return target !== undefined && body.includes(`@${target.displayName}`);
    });
    connection.chatSend({ body, replyTo: replyTo?.id ?? null, mentions: live });
    setDraft('');
    setMentions([]);
    setUnfurl(null);
    onCancelReply();
    stopTyping();
    // The send button unmounts (it swaps back to the mic) — keep the caret in
    // the field so the next message can be typed straight away.
    textareaRef.current?.focus({ preventScroll: true });
  };

  const pickFile = (file: File): void => {
    setUploadPct(0);
    uploadChatAttachment(roomId, file, {
      onProgress: (f) => setUploadPct(Math.round(f * 100)),
    })
      .then((attachment) => {
        setUploadPct(null);
        connection.chatSend({
          kind: 'attachment',
          body: file.name,
          attachment,
          replyTo: replyTo?.id ?? null,
        });
        onCancelReply();
      })
      .catch((err: unknown) => {
        setUploadPct(null);
        toast.error(describeError(err, 'Couldn’t upload that file'));
      });
  };

  // Auto-size by scrollHeight so soft-wrapped lines grow the field too.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
  }, [draft, recording, pendingVoice]);

  const closeEmoji = useCallback((restoreFocus: boolean): void => {
    setEmojiOpen(false);
    if (restoreFocus) textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const insertEmoji = (emoji: string): void => {
    if (disabled) return;
    setDraft((d) => d + emoji);
    signalTyping();
  };

  // Chat can be restricted mid-session — never leave the picker hanging open.
  useEffect(() => {
    if (disabled) setEmojiOpen(false);
  }, [disabled]);

  const uploading = uploadPct !== null;
  const hasDraft = draft.trim().length > 0;
  const reviewing = pendingVoice !== null;

  return (
    <div className="border-t border-hairline px-3 pb-3 pt-2">
      {uploading && (
        <div className="mb-2" role="status">
          <div className="h-1 overflow-hidden rounded-pill bg-surface-3">
            {/* Flat `bg-accent`: a progress fill is a tint, not the brand mark
                (DESIGN.md §2 — the gradient's budget is three, and none of them
                is this). */}
            <div className="h-full bg-accent transition-all" style={{ width: `${uploadPct}%` }} />
          </div>
          <p className="mt-1 text-caption text-low">Uploading {uploadPct}%</p>
        </div>
      )}

      <div className="relative">
        <EmojiPopover
          open={emojiOpen}
          triggerRef={emojiTriggerRef}
          onClose={closeEmoji}
          onPick={insertEmoji}
        />

        {mentionCandidates.length > 0 && (
          /* Floated over the log rather than pushed into the flow: a list that
             grows and shrinks under the caret as you type used to shove the
             whole composer up and down mid-word. */
          <div
            role="group"
            aria-label="Mention suggestions"
            className="absolute bottom-full left-0 right-0 z-[60] mb-2 overflow-hidden rounded-card border border-hairline bg-surface-2 p-1 shadow-e2"
          >
            {mentionCandidates.map((m) => (
              <button
                key={m.userId}
                type="button"
                className={cn(
                  'block w-full rounded-sm px-2 py-1.5 text-left text-label text-hi',
                  'transition-colors duration-150 hover:bg-surface-3',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
                onClick={() => {
                  setDraft((d) => d.replace(/@[\p{L}\p{N}_-]{0,40}$/u, `@${m.displayName} `));
                  setMentions((prev) => (prev.includes(m.userId) ? prev : [...prev, m.userId]));
                  textareaRef.current?.focus();
                }}
              >
                @{m.displayName}
              </button>
            ))}
          </div>
        )}

        {/* The plate. One background step above the rail plus a hairline — the
            same two things <Input> is made of, so a field is a field wherever
            it appears. The border is a ternary, not two additive classes:
            cn() is a plain joiner. */}
        <div
          className={cn(
            'rounded-card border bg-surface-2 transition-colors duration-150',
            'focus-within:ring-2 focus-within:ring-ring',
            recording ? 'border-danger' : 'border-hairline',
          )}
        >
          {replyTo !== null && (
            <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
              <span aria-hidden className="h-4 w-edge shrink-0 rounded-pill bg-accent" />
              <span className="min-w-0 flex-1 truncate text-label text-low">
                <span className="text-caption text-low">Replying </span>
                {replyTo.deletedAt !== null ? 'Message deleted' : replyTo.body}
              </span>
              <button
                type="button"
                aria-label="Cancel reply"
                onClick={onCancelReply}
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-low',
                  'transition-colors duration-150 hover:bg-surface-3 hover:text-hi',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                <XIcon size={14} />
              </button>
            </div>
          )}

          {pendingVoice !== null ? (
            /* Review before sending. The take is already captured — the only
               ways out are Send and Discard, and neither is the default, so a
               recording is never published by inaction or a stray Enter. */
            <div className="px-3 pt-3">
              <audio
                src={pendingVoice.url}
                controls
                preload="metadata"
                aria-label={`Voice note, ${Math.round(pendingVoice.durationMs / 1000)} seconds — play it back before sending`}
                className="h-8 w-full"
              />
            </div>
          ) : recording ? (
            <div role="status" className="flex items-center gap-2 px-3 pt-3">
              <span
                aria-hidden
                className={cn('h-2 w-2 shrink-0 rounded-full bg-danger', !reduced && 'animate-pulse')}
              />
              <span className="truncate text-body text-hi">Recording a voice note</span>
              <span className="ml-auto shrink-0 tabular text-label text-low">
                {formatElapsed(elapsedMs)}
              </span>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                signalTyping();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={disabled ? 'Chat is restricted' : 'Message the room…'}
              disabled={disabled}
              rows={1}
              aria-label="Message"
              autoCorrect="on"
              autoCapitalize="sentences"
              spellCheck
              className={cn(
                // `min-h-tap` and not a height: the effect below drives
                // `style.height` off scrollHeight, and one line of `body` in
                // this padding measures 42px — two short of the floor §9 sets
                // for a target on a phone. min-height constrains an inline
                // height, so the field starts at 44 and still grows.
                'block min-h-tap w-full resize-none bg-transparent px-3 pb-1 pt-3',
                'text-body text-hi placeholder:text-low focus:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            />
          )}

          {unfurl !== null && !reviewing && !recording && (
            <div className="mx-3 mt-2 rounded-sm bg-surface-3 px-2 py-1.5">
              <p className="truncate text-label text-hi">{unfurl.title ?? unfurl.url}</p>
              {unfurl.siteName !== null && (
                <p className="truncate text-caption text-low">{unfurl.siteName}</p>
              )}
            </div>
          )}

          {/* The tool row. Three modes, and each one is exhaustive: whatever the
              plate is showing, this row carries the only two things you can do
              with it. */}
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            {reviewing ? (
              <>
                <Button variant="ghost" size="sm" onClick={discardPendingVoice} disabled={voiceSending}>
                  Discard
                </Button>
                <Button size="sm" className="ml-auto" onClick={sendPendingVoice} disabled={voiceSending}>
                  {voiceSending ? 'Sending…' : 'Send'}
                </Button>
              </>
            ) : recording ? (
              <>
                <Button variant="ghost" size="sm" onClick={cancelRecording}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="icon"
                  aria-label="Stop recording"
                  className="ml-auto"
                  onClick={stopRecording}
                >
                  <StopCircleIcon size={18} />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Attach a file"
                  disabled={disabled || uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon size={18} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Send a GIF"
                  aria-haspopup="dialog"
                  className="text-caption"
                  disabled={disabled || uploading}
                  onClick={() => setGifOpen(true)}
                >
                  GIF
                </Button>
                <Button
                  ref={emojiTriggerRef}
                  variant="ghost"
                  size="icon"
                  aria-label="Emoji"
                  aria-haspopup="dialog"
                  aria-expanded={emojiOpen}
                  disabled={disabled}
                  className={emojiOpen ? 'bg-surface-3' : ''}
                  onClick={() => {
                    if (emojiOpen) closeEmoji(true);
                    else setEmojiOpen(true);
                  }}
                >
                  <SmileIcon size={18} />
                </Button>
                {hasDraft ? (
                  /* The room's ONE aurora action (DESIGN.md §2, §8). Everything
                     else in the composer is ghost, which is what lets this one
                     mean "this is the action". */
                  <Button
                    size="icon"
                    aria-label="Send"
                    className="ml-auto"
                    disabled={disabled}
                    onClick={send}
                  >
                    <SendIcon size={18} />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Record voice note"
                    className="ml-auto"
                    disabled={disabled || uploading}
                    onClick={() => void startRecording()}
                  >
                    <MicIcon size={18} />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) pickFile(file);
          e.target.value = '';
        }}
      />

      <GifPicker
        open={gifOpen}
        onOpenChange={setGifOpen}
        onPick={(gif) => {
          connection.chatSend({
            kind: 'gif',
            body: gif.title ?? '',
            gifUrl: gif.url,
            replyTo: replyTo?.id ?? null,
          });
          onCancelReply();
        }}
      />
    </div>
  );
}
