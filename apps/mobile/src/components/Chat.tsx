/**
 * Chat — full participant surface: message list (inverted), composer with
 * typing indicators + read-cursor advance, replies (quote), edit/delete
 * (tombstone), per-emoji reactions with counts, markdown-lite rendering
 * (bold / italic / code / links). GIF/attachment/voice pickers are NOT faked
 * here — the composer sends text; media pickers are a documented follow-up
 * that will reuse rest.media uploads.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useStore } from 'zustand';
import type { Message, MessageId, UserId } from '@playin/contracts';
import type { RoomConnection } from '../room-connection';
import { palette, radii, spacing, type as typeScale, layout } from '../theme';

// ── markdown-lite (bold/italic/code/links) ──────────────────────────────────

type Span = { text: string; bold: boolean; italic: boolean; code: boolean; link: boolean };

const TOKEN_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|https?:\/\/[^\s]+)/g;

export function parseMarkdownLite(body: string): Span[] {
  const spans: Span[] = [];
  const plain = (text: string): void => {
    if (text.length > 0) spans.push({ text, bold: false, italic: false, code: false, link: false });
  };
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const idx = m.index;
    plain(body.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith('**')) {
      spans.push({ text: tok.slice(2, -2), bold: true, italic: false, code: false, link: false });
    } else if (tok.startsWith('*')) {
      spans.push({ text: tok.slice(1, -1), bold: false, italic: true, code: false, link: false });
    } else if (tok.startsWith('`')) {
      spans.push({ text: tok.slice(1, -1), bold: false, italic: false, code: true, link: false });
    } else {
      spans.push({ text: tok, bold: false, italic: false, code: false, link: true });
    }
    last = idx + tok.length;
  }
  plain(body.slice(last));
  return spans;
}

function MessageText(props: { body: string; mine: boolean }) {
  const spans = useMemo(() => parseMarkdownLite(props.body), [props.body]);
  return (
    <Text style={[styles.bubbleText, props.mine && styles.bubbleTextMine]}>
      {spans.map((s, i) => (
        <Text
          key={i}
          style={[
            s.bold && styles.bold,
            s.italic && styles.italic,
            s.code && styles.code,
            s.link && styles.link,
          ]}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

// ── message bubble ──────────────────────────────────────────────────────────

const QUICK_REACTIONS = ['👍', '😂', '❤️', '🔥'] as const;

function Bubble(props: {
  conn: RoomConnection;
  msg: Message;
  me: UserId;
  canModerate: boolean;
  replyTarget: Message | undefined;
  selected: boolean;
  onSelect: (id: MessageId | null) => void;
  onReply: (msg: Message) => void;
}) {
  const { conn, msg, me, replyTarget, selected } = props;
  const mine = msg.authorId === me;

  if (msg.deletedAt !== null) {
    return (
      <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
        <View style={[styles.bubble, styles.bubbleTombstone]}>
          <Text style={styles.tombstoneText}>Message deleted</Text>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      onLongPress={() => props.onSelect(selected ? null : msg.id)}
      style={[styles.bubbleRow, mine && styles.bubbleRowMine]}
    >
      <View style={{ maxWidth: '82%' }}>
        <View
          style={[
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            !mine && styles.authorEdge,
          ]}
        >
          {replyTarget !== undefined && (
            <View style={styles.quote}>
              <Text numberOfLines={2} style={styles.quoteText}>
                {replyTarget.deletedAt !== null ? 'Message deleted' : replyTarget.body}
              </Text>
            </View>
          )}
          <MessageText body={msg.body} mine={mine} />
          {msg.editedAt !== null && <Text style={styles.edited}>(edited)</Text>}
        </View>

        {Object.entries(msg.reactions).length > 0 && (
          <View style={[styles.reactionsRow, mine && styles.reactionsRowMine]}>
            {Object.entries(msg.reactions).map(([emoji, users]) => (
              <Pressable
                key={emoji}
                onPress={() =>
                  conn.chatReact(msg.id, emoji, users.includes(me) ? 'remove' : 'add')
                }
                style={[
                  styles.reactionChip,
                  users.includes(me) && styles.reactionChipActive,
                ]}
              >
                <Text style={styles.reactionText}>
                  {emoji} {users.length}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {selected && (
          <View style={styles.actionBar}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => {
                  const users = msg.reactions[emoji] ?? [];
                  conn.chatReact(msg.id, emoji, users.includes(me) ? 'remove' : 'add');
                  props.onSelect(null);
                }}
                style={styles.actionButton}
              >
                <Text style={styles.actionEmoji}>{emoji}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => {
                props.onReply(msg);
                props.onSelect(null);
              }}
              style={styles.actionButton}
            >
              <Text style={styles.actionLabel}>Reply</Text>
            </Pressable>
            {(mine || props.canModerate) && (
              <Pressable
                onPress={() => {
                  conn.chatDelete(msg.id);
                  props.onSelect(null);
                }}
                style={styles.actionButton}
              >
                <Text style={[styles.actionLabel, { color: palette.danger }]}>Delete</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}

// ── the tab itself ──────────────────────────────────────────────────────────

export function Chat(props: {
  conn: RoomConnection;
  me: UserId;
  canModerate: boolean;
  composerEnabled: boolean;
}) {
  const { conn, me } = props;
  const messages = useStore(conn.store, (s) => s.messages);
  const typing = useStore(conn.store, (s) => s.typing);
  const readCursors = useStore(conn.store, (s) => s.readCursors);

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [selectedId, setSelectedId] = useState<MessageId | null>(null);
  const [tick, setTick] = useState(0); // prunes typing indicator once a second
  const typingSentRef = useRef(false);
  const typingStopHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReadSentRef = useRef(0);

  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(h);
  }, []);

  // Read cursor: advance to the newest seq (throttled to one advance per seq).
  const latestSeq = messages.length > 0 ? messages[messages.length - 1]?.seq ?? 0 : 0;
  useEffect(() => {
    if (latestSeq > lastReadSentRef.current) {
      lastReadSentRef.current = latestSeq;
      conn.chatRead(latestSeq);
    }
  }, [conn, latestSeq]);

  const byId = useMemo(() => {
    const map = new Map<MessageId, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const reversed = useMemo(() => [...messages].reverse(), [messages]);

  const activeTypers = useMemo(() => {
    void tick;
    const now = Date.now();
    return Object.entries(typing)
      .filter(([userId, expiry]) => userId !== me && expiry > now)
      .map(([userId]) => userId);
  }, [typing, me, tick]);

  const seenByCount = useMemo(() => {
    const lastOwn = [...messages].reverse().find((m) => m.authorId === me);
    if (lastOwn === undefined) return 0;
    return Object.entries(readCursors).filter(
      ([userId, seq]) => userId !== me && seq >= lastOwn.seq,
    ).length;
  }, [messages, readCursors, me]);

  const onChangeDraft = (text: string): void => {
    setDraft(text);
    if (!typingSentRef.current) {
      typingSentRef.current = true;
      conn.chatTyping(true);
    }
    if (typingStopHandle.current !== null) clearTimeout(typingStopHandle.current);
    typingStopHandle.current = setTimeout(() => {
      typingSentRef.current = false;
      conn.chatTyping(false);
    }, 2500);
  };

  const send = (): void => {
    const body = draft.trim();
    if (body.length === 0) return;
    conn.chatSend({ body, replyTo: replyTo?.id ?? null });
    setDraft('');
    setReplyTo(null);
    typingSentRef.current = false;
    conn.chatTyping(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        data={reversed}
        inverted
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <Bubble
            conn={conn}
            msg={item}
            me={me}
            canModerate={props.canModerate}
            replyTarget={item.replyTo !== null ? byId.get(item.replyTo) : undefined}
            selected={selectedId === item.id}
            onSelect={setSelectedId}
            onReply={setReplyTo}
          />
        )}
        contentContainerStyle={styles.listContent}
      />

      {activeTypers.length > 0 && (
        <View style={styles.typingRow}>
          <TypingDots />
          <Text style={styles.typingText}>
            {activeTypers.length === 1 ? 'Someone is typing' : `${activeTypers.length} typing`}
          </Text>
        </View>
      )}

      {replyTo !== null && (
        <View style={styles.replyBar}>
          <Text numberOfLines={1} style={styles.replyBarText}>
            Replying: {replyTo.body}
          </Text>
          <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
            <Text style={styles.replyBarCancel}>✕</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={onChangeDraft}
          placeholder={props.composerEnabled ? 'Message the room…' : 'Chat is restricted'}
          placeholderTextColor={palette.textLow}
          editable={props.composerEnabled}
          multiline
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!props.composerEnabled || draft.trim().length === 0}
          onPress={send}
          style={[styles.sendButton, draft.trim().length === 0 && styles.sendDisabled]}
        >
          <Text style={styles.sendGlyph}>↑</Text>
        </Pressable>
      </View>

      {seenByCount > 0 && <Text style={styles.seen}>Seen by {seenByCount}</Text>}
    </KeyboardAvoidingView>
  );
}

function TypingDots() {
  // DESIGN.md §6: three dots, staggered 120 ms.
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setPhase((p) => (p + 1) % 4), 240);
    return () => clearInterval(h);
  }, []);
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.dot, phase === i && styles.dotActive]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  listContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleRow: { flexDirection: 'row', marginVertical: 3 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: {
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: palette.borderGlass,
  },
  bubbleMine: { backgroundColor: 'rgba(149,91,254,0.16)' },
  bubbleTheirs: { backgroundColor: palette.surfaceGlass },
  bubbleTombstone: { backgroundColor: 'transparent', borderStyle: 'dashed' },
  tombstoneText: { ...typeScale.label, color: palette.textLow, fontStyle: 'italic' },
  authorEdge: { borderLeftWidth: 2, borderLeftColor: palette.aurora1 },
  bubbleText: { ...typeScale.body, color: palette.textHi },
  bubbleTextMine: { color: palette.textHi },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  code: {
    fontFamily: 'Menlo',
    backgroundColor: 'rgba(255,255,255,0.08)',
    fontSize: 14,
  },
  link: { color: palette.focusRing, textDecorationLine: 'underline' },
  edited: { ...typeScale.label, color: palette.textLow, marginTop: 2 },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: palette.aurora2,
    paddingLeft: spacing.sm,
    marginBottom: spacing.xs,
    opacity: 0.8,
  },
  quoteText: { ...typeScale.label, color: palette.textMid },
  reactionsRow: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  reactionsRowMine: { justifyContent: 'flex-end' },
  reactionChip: {
    borderRadius: radii.pill,
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  reactionChipActive: { borderColor: palette.aurora1, backgroundColor: 'rgba(149,91,254,0.2)' },
  reactionText: { ...typeScale.label, color: palette.textHi },
  actionBar: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
    flexWrap: 'wrap',
  },
  actionButton: {
    minHeight: 36,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: palette.surfaceRaised,
    paddingHorizontal: spacing.sm,
  },
  actionEmoji: { fontSize: 18 },
  actionLabel: { ...typeScale.label, color: palette.textHi },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  typingText: { ...typeScale.label, color: palette.textLow },
  dots: { flexDirection: 'row', gap: 3 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.textLow, opacity: 0.4 },
  dotActive: { opacity: 1, backgroundColor: palette.aurora1 },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: palette.surfaceGlass,
    borderTopWidth: 1,
    borderTopColor: palette.borderGlass,
  },
  replyBarText: { ...typeScale.label, color: palette.textMid, flex: 1 },
  replyBarCancel: { color: palette.textLow, fontSize: 16, padding: spacing.xs },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: palette.borderGlass,
    backgroundColor: palette.bgDeep,
  },
  input: {
    flex: 1,
    ...typeScale.body,
    color: palette.textHi,
    backgroundColor: palette.surfaceGlass,
    borderWidth: 1,
    borderColor: palette.borderGlass,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 120,
  },
  sendButton: {
    width: layout.tap,
    height: layout.tap,
    borderRadius: radii.pill,
    backgroundColor: palette.aurora1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.35 },
  sendGlyph: { color: palette.accentInk, fontSize: 20, fontWeight: '700' },
  seen: {
    ...typeScale.label,
    color: palette.textLow,
    textAlign: 'right',
    paddingRight: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: palette.bgDeep,
  },
});
