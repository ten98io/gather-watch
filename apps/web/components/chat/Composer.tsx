'use client';

/**
 * Composer — the messaging bar, standard layout (WhatsApp/Telegram/Discord
 * convention): [attach] [GIF] [message pill + emoji] [send ⇄ voice]. Above the
 * row, in order: reply banner, link-unfurl preview, @mention autocomplete,
 * upload progress. Typing signals, emoji popover, GIF picker, attachment
 * upload with progress, voice notes (MediaRecorder), and a debounced
 * link-unfurl preview (server-side, SSRF-guarded). Sends contracts chat.send
 * ClientEvents; nothing optimistic — the server-ordered chat.message event is
 * the single source of truth.
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

/** Auto-grow ceiling: 5 lines × 20px leading + 24px vertical padding. */
const MAX_TEXTAREA_PX = 5 * 20 + 24;
/** Anything taller than one line loses the full pill radius (text would clip). */
const SINGLE_LINE_PX = 48;

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
 * Compact emoji panel above the bar. Closes on Escape, on outside pointerdown,
 * and after a pick unless a modifier is held (multi-pick). Constrained to the
 * composer's own width so it never widens the 380px rail.
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
          className="glass-raised absolute bottom-full left-2 right-2 z-[60] mb-2 p-2 shadow-glow"
          {...motionProps}
        >
          <div className="grid grid-cols-8 gap-0.5">
            {EMOJI_GRID.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Insert ${emoji}`}
                className="flex h-9 items-center justify-center rounded-ctl text-lg leading-none transition-colors duration-150 hover:bg-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  const [multiline, setMultiline] = useState(false);
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
        toast.error(describeError(err, 'Could not send that voice note'));
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
        toast.error(describeError(err, 'Could not upload that file'));
      });
  };

  // Auto-size by scrollHeight so soft-wrapped lines grow the field too.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
    setMultiline(next > SINGLE_LINE_PX);
  }, [draft, recording]);

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

  return (
    <div className="border-t border-border-glass bg-deep">
      {replyTo !== null && (
        <div className="flex items-center gap-2 border-t border-border-glass bg-glass px-3 py-1.5">
          <span aria-hidden className="h-6 w-0.5 shrink-0 rounded-full bg-aurora-1" />
          <span className="min-w-0 flex-1 truncate text-xs text-mid">
            Replying: {replyTo.deletedAt !== null ? 'Message deleted' : replyTo.body}
          </span>
          <button
            type="button"
            aria-label="Cancel reply"
            onClick={onCancelReply}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-ctl text-low transition-colors duration-150 hover:bg-raised hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      {unfurl !== null && (
        <div className="mx-2 mt-2 rounded-ctl border border-border-glass bg-glass px-3 py-2">
          <p className="truncate text-xs text-hi">{unfurl.title ?? unfurl.url}</p>
          {unfurl.siteName !== null && (
            <p className="text-[10px] text-low">{unfurl.siteName}</p>
          )}
        </div>
      )}

      {mentionCandidates.length > 0 && (
        <div
          role="group"
          aria-label="Mention suggestions"
          className="mx-2 mt-2 overflow-hidden rounded-ctl border border-border-glass bg-raised p-1"
        >
          {mentionCandidates.map((m) => (
            <button
              key={m.userId}
              type="button"
              className="block w-full rounded-ctl px-2 py-1.5 text-left text-sm text-hi transition-colors duration-150 hover:bg-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

      {uploading && (
        <div className="mx-2 mt-2" role="status">
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full bg-aurora-1 transition-all" style={{ width: `${uploadPct}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-low">Uploading… {uploadPct}%</p>
        </div>
      )}

      {/* One standard input row: attach · GIF · field (+emoji) · send/voice. */}
      <div className="relative flex items-end gap-1 p-2">
        <EmojiPopover
          open={emojiOpen}
          triggerRef={emojiTriggerRef}
          onClose={closeEmoji}
          onPick={insertEmoji}
        />

        <Button
          variant="ghost"
          size="icon"
          aria-label="Attach a file"
          disabled={disabled || uploading || recording}
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon size={18} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Send a GIF"
          aria-haspopup="dialog"
          className="text-[11px] font-semibold tracking-tight"
          disabled={disabled || uploading || recording}
          onClick={() => setGifOpen(true)}
        >
          GIF
        </Button>

        <div
          className={cn(
            'flex min-w-0 flex-1 items-end border border-border-glass bg-glass transition-colors duration-150',
            'focus-within:ring-2 focus-within:ring-ring',
            multiline ? 'rounded-[22px]' : 'rounded-full',
            recording && 'border-danger',
          )}
        >
          {pendingVoice !== null ? (
            /* Review before sending. The take is already captured — the only
               ways out are Send and Discard, and neither is the default, so a
               recording is never published by inaction or a stray Enter. */
            <div className="flex min-h-[44px] flex-1 items-center gap-2 py-1 pl-3 pr-2">
              <audio
                src={pendingVoice.url}
                controls
                preload="metadata"
                aria-label={`Voice note, ${Math.round(pendingVoice.durationMs / 1000)} seconds — play it back before sending`}
                className="h-8 min-w-0 flex-1"
              />
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={discardPendingVoice}
                disabled={voiceSending}
              >
                Discard
              </Button>
              <Button
                size="sm"
                className="shrink-0"
                onClick={sendPendingVoice}
                disabled={voiceSending}
              >
                {voiceSending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          ) : recording ? (
            <div role="status" className="flex min-h-[44px] flex-1 items-center gap-2 pl-4 pr-2">
              <span
                aria-hidden
                className={cn('h-2 w-2 shrink-0 rounded-full bg-danger', !reduced && 'animate-pulse')}
              />
              <span className="truncate text-sm text-mid">Recording voice note…</span>
              <span className="ml-auto shrink-0 tabular-nums text-sm text-low">
                {Math.floor(elapsedMs / 60_000)}:
                {String(Math.floor((elapsedMs % 60_000) / 1000)).padStart(2, '0')}
              </span>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={cancelRecording}>
                Cancel
              </Button>
            </div>
          ) : (
            <>
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
                placeholder={disabled ? 'Chat is restricted' : 'Message…'}
                disabled={disabled}
                rows={1}
                aria-label="Message"
                autoCorrect="on"
                autoCapitalize="sentences"
                spellCheck
                className="min-w-0 flex-1 resize-none bg-transparent py-3 pl-4 pr-1 text-sm leading-5 text-hi placeholder:text-low focus:outline-none"
              />
              <button
                ref={emojiTriggerRef}
                type="button"
                aria-label="Emoji"
                aria-haspopup="dialog"
                aria-expanded={emojiOpen}
                disabled={disabled}
                onClick={() => {
                  if (emojiOpen) closeEmoji(true);
                  else setEmojiOpen(true);
                }}
                className={cn(
                  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors duration-150',
                  'disabled:pointer-events-none disabled:opacity-50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  emojiOpen ? 'text-hi' : 'text-mid hover:text-hi',
                )}
              >
                <SmileIcon size={20} />
              </button>
            </>
          )}
        </div>

        {recording ? (
          <Button
            variant="destructive"
            aria-label="Stop recording"
            className="shrink-0"
            onClick={stopRecording}
          >
            <StopCircleIcon size={18} />
            <span className="tabular text-xs font-semibold">{formatElapsed(elapsedMs)}</span>
          </Button>
        ) : hasDraft ? (
          <Button size="icon" aria-label="Send" disabled={disabled} onClick={send}>
            <SendIcon size={18} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Record voice note"
            disabled={disabled || uploading}
            onClick={() => void startRecording()}
          >
            <MicIcon size={20} />
          </Button>
        )}
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
