/**
 * RoomConnection — the app's realtime core, same contract as the web client:
 * one RoomSocket per room, server-authoritative state applied from the
 * multiplexed event stream, gap recovery via events.replay (handled inside
 * RoomSocket), and zustand store the screens subscribe to.
 *
 * This module is deliberately RN-free (no react / react-native imports) so
 * vitest can exercise it in a node environment with a fake WebSocket.
 */
import { RoomSocket } from '@playin/api-client';
import type {
  ClearTimeoutFn,
  ConnectOptions,
  RestClient,
  SetTimeoutFn,
  SocketStatus,
  WebSocketCtor,
} from '@playin/api-client';
import { applyServerState, initialQueueState } from '@playin/sync-core';
import type { QueueState } from '@playin/sync-core';
import type {
  Message,
  MessageId,
  PlaybackState,
  PresenceEntry,
  QueueItemInput,
  QueueItemId,
  RestreamState,
  Room,
  RoomId,
  UserId,
} from '@playin/contracts';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';

/** Ephemeral emote burst floating over the stage (never persisted). */
export interface EmoteBurst {
  id: number;
  userId: UserId;
  emoji: string;
  xPct: number;
  yPct: number;
  at: number;
}

export interface RoomState {
  status: SocketStatus;
  room: Room | null;
  playback: PlaybackState | null;
  queue: QueueState;
  /** Presence by userId (from presence.state snapshots + presence.diff). */
  presence: Record<UserId, PresenceEntry>;
  /** Chat window, ascending by seq, capped at MAX_MESSAGES. */
  messages: Message[];
  /** userId → typing-expiry timestamp (ms). */
  typing: Record<UserId, number>;
  readCursors: Record<UserId, number>;
  deliveredCursors: Record<UserId, number>;
  waitingOn: UserId[];
  master: { userId: UserId; epoch: number } | null;
  restream: RestreamState | null;
  emotes: EmoteBurst[];
  /** Bumped when a seq gap could not be backfilled — screens should refetch
   *  room state; messages are already reloaded by the connection itself. */
  gapLossCount: number;
  /** Bumped on member.updated — People tab refetches the member list. */
  membersVersion: number;
  lastError: string | null;
}

export const MAX_MESSAGES = 300;
export const TYPING_TTL_MS = 4000;
export const EMOTE_TTL_MS = 2500;

function initialRoomState(): RoomState {
  return {
    status: 'idle',
    room: null,
    playback: null,
    queue: initialQueueState(),
    presence: {},
    messages: [],
    typing: {},
    readCursors: {},
    deliveredCursors: {},
    waitingOn: [],
    master: null,
    restream: null,
    emotes: [],
    gapLossCount: 0,
    membersVersion: 0,
    lastError: null,
  };
}

export interface RoomConnectionOptions {
  /** Only the replay + message-history slices are used. */
  rest: Pick<RestClient, 'events' | 'messages'>;
  wsUrl: string;
  wsCtor?: WebSocketCtor;
  now?: () => number;
  rng?: () => number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  heartbeatMs?: number;
  /** Forwarded to RoomSocket (tests shrink these). */
  replayRetryAttempts?: number;
  replayRetryDelayMs?: number;
  /** Test hook: how long emote bursts stay on screen. Default EMOTE_TTL_MS. */
  emoteTtlMs?: number;
}

/** Insert ascending-by-seq, deduping by message id; caps the window. */
export function insertMessage(list: readonly Message[], msg: Message): Message[] {
  if (list.some((m) => m.id === msg.id)) return [...list];
  const next = [...list];
  let i = next.length;
  while (i > 0) {
    const prev = next[i - 1];
    if (prev === undefined || prev.seq <= msg.seq) break;
    i -= 1;
  }
  next.splice(i, 0, msg);
  return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

/** Applies a reaction op to a message's reactions map (immutably). */
export function applyReaction(
  msg: Message,
  emoji: string,
  userId: UserId,
  op: 'add' | 'remove',
): Message {
  const current = msg.reactions[emoji] ?? [];
  const has = current.includes(userId);
  let nextUsers: string[];
  if (op === 'add') {
    if (has) return msg;
    nextUsers = [...current, userId];
  } else {
    if (!has) return msg;
    nextUsers = current.filter((u) => u !== userId);
  }
  const reactions = { ...msg.reactions };
  if (nextUsers.length === 0) {
    delete reactions[emoji];
  } else {
    reactions[emoji] = nextUsers as UserId[];
  }
  return { ...msg, reactions };
}

export class RoomConnection {
  readonly store: StoreApi<RoomState>;
  readonly socket: RoomSocket;

  private readonly rest: Pick<RestClient, 'events' | 'messages'>;
  private readonly now: () => number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly emoteTtlMs: number;
  private emoteCounter = 0;
  private roomId: RoomId | null = null;

  constructor(opts: RoomConnectionOptions) {
    this.rest = opts.rest;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.emoteTtlMs = opts.emoteTtlMs ?? EMOTE_TTL_MS;
    this.store = createStore<RoomState>(() => initialRoomState());

    this.socket = new RoomSocket(opts.wsUrl, {
      replayFetch: async (roomId, sinceSeq) => {
        const res = await this.rest.events.replay(roomId, sinceSeq);
        return res.events;
      },
      onGapLoss: () => {
        this.store.setState((s) => ({ gapLossCount: s.gapLossCount + 1 }));
        // Strict ordering gave way to availability: rebuild the chat window
        // from the server so the UI never shows a silent hole.
        void this.loadRecentMessages().catch(() => undefined);
      },
      ...(opts.wsCtor !== undefined ? { wsCtor: opts.wsCtor } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
      ...(opts.setTimeoutFn !== undefined ? { setTimeoutFn: opts.setTimeoutFn } : {}),
      ...(opts.clearTimeoutFn !== undefined ? { clearTimeoutFn: opts.clearTimeoutFn } : {}),
      ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
      ...(opts.replayRetryAttempts !== undefined
        ? { replayRetryAttempts: opts.replayRetryAttempts }
        : {}),
      ...(opts.replayRetryDelayMs !== undefined
        ? { replayRetryDelayMs: opts.replayRetryDelayMs }
        : {}),
    });

    this.socket.onStatus((status) => this.store.setState({ status }));
    this.bindEvents();
  }

  /** The shared clock estimator (fed by socket heartbeats) for sync math. */
  get clock(): RoomSocket['clock'] {
    return this.socket.clock;
  }

  get currentRoomId(): RoomId | null {
    return this.roomId;
  }

  connect(roomId: RoomId, token: string, opts?: ConnectOptions): void {
    this.roomId = roomId;
    this.socket.connect(roomId, token, opts);
  }

  close(): void {
    this.socket.close();
    this.roomId = null;
    this.store.setState(initialRoomState());
  }

  /** Initial chat window (newest page, applied ascending). */
  async loadRecentMessages(): Promise<void> {
    const roomId = this.roomId;
    if (roomId === null) return;
    const page = await this.rest.messages.listMessages(roomId, { limit: 50 });
    const ascending = [...page.items].sort((a, b) => a.seq - b.seq);
    this.store.setState((s) => {
      let messages = s.messages;
      for (const msg of ascending) messages = insertMessage(messages, msg);
      return { messages: messages.slice(-MAX_MESSAGES) };
    });
  }

  // ── Send helpers (payloads typed against contracts ClientEvent) ──────────

  chatSend(input: {
    body: string;
    replyTo?: MessageId | null;
    mentions?: UserId[];
  }): void {
    this.socket.send('chat.send', {
      kind: 'text',
      body: input.body,
      gifUrl: null,
      attachment: null,
      replyTo: input.replyTo ?? null,
      mentions: input.mentions ?? [],
    });
  }

  chatEdit(messageId: MessageId, body: string): void {
    this.socket.send('chat.edit', { messageId, body });
  }

  chatDelete(messageId: MessageId): void {
    this.socket.send('chat.delete', { messageId });
  }

  chatReact(messageId: MessageId, emoji: string, op: 'add' | 'remove'): void {
    this.socket.send('chat.react', { messageId, emoji, op });
  }

  chatTyping(typing: boolean): void {
    this.socket.send('chat.typing', { typing });
  }

  chatRead(lastReadSeq: number): void {
    this.socket.send('chat.read', { lastReadSeq });
  }

  syncPlay(positionMs?: number): void {
    this.socket.send('sync.play', positionMs === undefined ? {} : { positionMs });
  }

  syncPause(positionMs?: number): void {
    this.socket.send('sync.pause', positionMs === undefined ? {} : { positionMs });
  }

  syncSeek(positionMs: number): void {
    this.socket.send('sync.seek', { positionMs });
  }

  syncRate(rate: number): void {
    this.socket.send('sync.rate', { rate });
  }

  syncSetTrackByQueue(queueIndex: number): void {
    this.socket.send('sync.setTrack', { kind: 'queue', queueIndex });
  }

  syncBuffering(buffering: boolean): void {
    this.socket.send('sync.buffering', { buffering });
  }

  queueAdd(item: QueueItemInput): void {
    this.socket.send('queue.add', { item });
  }

  queueRemove(itemId: QueueItemId): void {
    this.socket.send('queue.remove', { itemId });
  }

  queueReorder(orderedIds: QueueItemId[]): void {
    this.socket.send('queue.reorder', { orderedIds });
  }

  queueVoteSkip(itemId: QueueItemId): void {
    this.socket.send('queue.voteSkip', { itemId });
  }

  presenceUpdate(patch: {
    state?: PresenceEntry['state'];
    micOn?: boolean;
    camOn?: boolean;
    sharing?: boolean;
  }): void {
    this.socket.send('presence.update', patch);
  }

  emoteBurst(emoji: string, xPct: number, yPct: number): void {
    this.socket.send('emote.burst', { emoji, xPct, yPct });
  }

  // ── Server event reducers ────────────────────────────────────────────────

  private bindEvents(): void {
    const set = this.store.setState.bind(this.store);

    this.socket.on('chat.message', (ev) => {
      set((s) => ({ messages: insertMessage(s.messages, ev.payload) }));
    });

    this.socket.on('chat.updated', (ev) => {
      set((s) => ({
        messages: s.messages.map((m) => (m.id === ev.payload.id ? ev.payload : m)),
      }));
    });

    this.socket.on('chat.deleted', (ev) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === ev.payload.messageId
            ? { ...m, deletedAt: ev.payload.deletedAt, body: '', reactions: {} }
            : m,
        ),
      }));
    });

    this.socket.on('chat.reaction', (ev) => {
      const { messageId, emoji, userId, op } = ev.payload;
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId ? applyReaction(m, emoji, userId, op) : m,
        ),
      }));
    });

    this.socket.on('chat.typing', (ev) => {
      const { userId, typing } = ev.payload;
      set((s) => {
        const next = { ...s.typing };
        if (typing) {
          next[userId] = this.now() + TYPING_TTL_MS;
        } else {
          delete next[userId];
        }
        return { typing: next };
      });
    });

    this.socket.on('chat.read', (ev) => {
      const { userId, lastReadSeq } = ev.payload;
      set((s) => ({
        readCursors: {
          ...s.readCursors,
          [userId]: Math.max(lastReadSeq, s.readCursors[userId] ?? 0),
        },
      }));
    });

    this.socket.on('chat.delivered', (ev) => {
      const { userId, lastDeliveredSeq } = ev.payload;
      set((s) => ({
        deliveredCursors: {
          ...s.deliveredCursors,
          [userId]: Math.max(lastDeliveredSeq, s.deliveredCursors[userId] ?? 0),
        },
      }));
    });

    this.socket.on('sync.state', (ev) => {
      set((s) => ({ playback: applyServerState(s.playback, ev.payload) }));
    });

    this.socket.on('sync.waiting', (ev) => {
      set({ waitingOn: ev.payload.waitingOn });
    });

    this.socket.on('sync.masterChanged', (ev) => {
      set({ master: { userId: ev.payload.masterUserId, epoch: ev.payload.epoch } });
    });

    this.socket.on('queue.state', (ev) => {
      set({ queue: { items: ev.payload.items, version: ev.payload.version } });
    });

    this.socket.on('presence.state', (ev) => {
      const presence: Record<UserId, PresenceEntry> = {};
      for (const entry of ev.payload.entries) presence[entry.userId] = entry;
      set({ presence });
    });

    this.socket.on('presence.diff', (ev) => {
      set((s) => {
        const presence = { ...s.presence };
        for (const entry of ev.payload.upserts) presence[entry.userId] = entry;
        for (const userId of ev.payload.removed) delete presence[userId];
        return { presence };
      });
    });

    this.socket.on('restream.state', (ev) => {
      set({ restream: ev.payload });
    });

    this.socket.on('room.updated', (ev) => {
      set({ room: ev.payload });
    });

    this.socket.on('member.updated', () => {
      set((s) => ({ membersVersion: s.membersVersion + 1 }));
    });

    this.socket.on('emote.burst', (ev) => {
      const id = (this.emoteCounter += 1);
      const burst: EmoteBurst = { id, ...ev.payload, at: this.now() };
      set((s) => ({ emotes: [...s.emotes, burst] }));
      this.setTimeoutFn(() => {
        this.store.setState((s) => ({ emotes: s.emotes.filter((e) => e.id !== id) }));
      }, this.emoteTtlMs);
    });

    this.socket.on('error', (ev) => {
      set({ lastError: ev.payload.message });
    });
  }
}
