'use client';

/**
 * Composer — chat input row: typing signals, emoji, GIF picker, attachment
 * upload with progress, voice notes (MediaRecorder), @mention autocomplete,
 * and a debounced link-unfurl preview (server-side, SSRF-guarded). Sends
 * contracts chat.send ClientEvents; nothing optimistic — the server-ordered
 * chat.message event is the single source of truth.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, RoomId, UserId } from '@playin/contracts';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { uploadChatAttachment } from '@/lib/attachments';
import { firstUrl } from '@/lib/markdown-lite';
import { useRoomConnection } from '@/lib/room-context';
import { GifPicker } from './GifPicker';

const EMOJI_ROW = ['😀', '😂', '🔥', '❤️', '👍', '🎉', '😮', '😢'] as const;

export interface Mentionable {
  userId: UserId;
  displayName: string;
}

function VoiceButton({
  roomId,
  disabled,
  onRecorded,
}: {
  roomId: RoomId;
  disabled: boolean;
  onRecorded(attachment: Message['attachment']): void;
}) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef(0);

  const toggle = async (): Promise<void> => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const durationMs = Date.now() - startedAtRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const file = new File([blob], `voice-note.webm`, { type: blob.type });
        void uploadChatAttachment(roomId, file, { durationMs })
          .then(onRecorded)
          .catch((err: unknown) => {
            toast.error(err instanceof Error ? err.message : 'Voice note upload failed');
          });
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start();
      setRecording(true);
    } catch {
      toast.error('Microphone unavailable — check browser permissions');
    }
  };

  // MediaRecorder.onstop → state back to idle.
  useEffect(() => {
    if (!recording) return;
    const recorder = recorderRef.current;
    if (recorder === null) return;
    const prev = recorder.onstop;
    recorder.onstop = (e) => {
      prev?.call(recorder, e);
      setRecording(false);
    };
  }, [recording]);

  return (
    <Button
      variant={recording ? 'destructive' : 'ghost'}
      size="icon"
      aria-label={recording ? 'Stop recording' : 'Record voice note'}
      disabled={disabled}
      onClick={() => void toggle()}
    >
      {recording ? '⏺' : '🎤'}
    </Button>
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
  const [draft, setDraft] = useState('');
  const [gifOpen, setGifOpen] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [unfurl, setUnfurl] = useState<{
    url: string;
    title: string | null;
    siteName: string | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingSentRef = useRef(false);
  const typingStopHandle = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const send = (): void => {
    const body = draft.trim();
    if (body.length === 0) return;
    connection.chatSend({ body, replyTo: replyTo?.id ?? null, mentions });
    setDraft('');
    setMentions([]);
    setUnfurl(null);
    onCancelReply();
    stopTyping();
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
        toast.error(err instanceof Error ? err.message : 'Attachment upload failed');
      });
  };

  return (
    <div className="border-t border-border-glass bg-deep">
      {replyTo !== null && (
        <div className="flex items-center gap-2 border-t border-border-glass bg-glass px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-mid">
            Replying: {replyTo.deletedAt !== null ? 'Message deleted' : replyTo.body}
          </span>
          <button
            type="button"
            aria-label="Cancel reply"
            onClick={onCancelReply}
            className="px-1 text-low hover:text-hi"
          >
            ✕
          </button>
        </div>
      )}

      {unfurl !== null && (
        <div className="mx-3 mt-2 rounded-ctl border border-border-glass bg-glass px-3 py-2">
          <p className="truncate text-xs text-hi">{unfurl.title ?? unfurl.url}</p>
          {unfurl.siteName !== null && (
            <p className="text-[10px] text-low">{unfurl.siteName}</p>
          )}
        </div>
      )}

      {mentionCandidates.length > 0 && (
        <div className="mx-3 mt-2 overflow-hidden rounded-ctl border border-border-glass bg-raised">
          {mentionCandidates.map((m) => (
            <button
              key={m.userId}
              type="button"
              className="block w-full px-3 py-1.5 text-left text-sm text-hi hover:bg-glass"
              onClick={() => {
                setDraft((d) => d.replace(/@[\p{L}\p{N}_-]{0,40}$/u, `@${m.displayName} `));
                setMentions((prev) => (prev.includes(m.userId) ? prev : [...prev, m.userId]));
              }}
            >
              @{m.displayName}
            </button>
          ))}
        </div>
      )}

      {uploadPct !== null && (
        <div className="mx-3 mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full bg-aurora-1 transition-all" style={{ width: `${uploadPct}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-low">Uploading… {uploadPct}%</p>
        </div>
      )}

      {/* Emoji strip spans the full composer width; the input row below keeps
          the textarea roomy even in the 380px rail (audit fix). */}
      <div className="flex gap-0.5 overflow-x-auto px-2 pt-1.5">
        {EMOJI_ROW.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`Insert ${emoji}`}
            className="rounded px-0.5 text-base hover:bg-glass"
            onClick={() => {
              setDraft((d) => d + emoji);
              signalTyping();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-1.5 p-2 pt-0">
        <div className="flex gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Send a GIF"
            disabled={disabled}
            onClick={() => setGifOpen(true)}
          >
            GIF
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Attach a file"
            disabled={disabled || uploadPct !== null}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </Button>
          <VoiceButton
            roomId={roomId}
            disabled={disabled}
            onRecorded={(attachment) => {
              connection.chatSend({
                kind: 'voice',
                body: 'Voice note',
                attachment,
                replyTo: replyTo?.id ?? null,
              });
              onCancelReply();
            }}
          />
        </div>

        <textarea
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
          rows={Math.min(4, Math.max(1, draft.split('\n').length))}
          aria-label="Message"
          className="min-h-[40px] min-w-0 flex-1 resize-none rounded-ctl border border-border-glass bg-glass px-3 py-2 text-sm text-hi placeholder:text-low focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Button
          size="icon"
          aria-label="Send"
          disabled={disabled || draft.trim().length === 0}
          onClick={send}
        >
          ↑
        </Button>
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
