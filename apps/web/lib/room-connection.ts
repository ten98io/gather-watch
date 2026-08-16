import { ApiError, RoomSocket } from '@gather/api-client';
import type {
  ClockEstimator,
  RoomSocketOptions,
  SocketStatus,
} from '@gather/api-client';
import type {
  ClientEvent,
  Message,
  MessageId,
  PlaybackState,
  PresenceEntry,
  QueueItemInput,
  QueueItemId,
  RestreamState,
  Room,
  RoomId,
  ServerEvent,
  UserId,
} from '@gather/contracts';
import type { RestClient } from '@gather/api-client';
import { applyServerState, initialQueueState } from '@gather/sync-core';
import type { QueueState } from '@gather/sync-core';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { WS_URL, ensureAccessToken } from './api';

/** Zustand hook-store handle (brief contract names it `UseStore`). */
export type UseStore<T> = UseBoundStore<StoreApi<T>>;

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

/** Maps the socket lifecycle onto the four-state room connection status. */
export function toConnectionStatus(status: SocketStatus): ConnectionStatus {
  switch (status) {
    case 'open':
      return 'live';
    case 'reconnecting':
      return 'reconnecting';
    case 'closed':
      return 'closed';
    case 'idle':
    case 'connecting':
      return 'connecting';
  }
}

/** Test/dependency hooks forwarded to the wrapped {@link RoomSocket}. */
export type RoomConnectionSocketOptions = Pick<
  RoomSocketOptions,
  | 'wsCtor'
  | 'now'
  | 'rng'
  | 'setTimeoutFn'
  | 'clearTimeoutFn'
  | 'heartbeatMs'
  | 'backoffBaseMs'
  | 'backoffMaxMs'
  | 'backoffFactor'
  | 'replayRetryAttempts'
  | 'replayRetryDelayMs'
>;

export interface RoomConnectionOptions {
  /** REST client — used for the event-replay backfill after a seq gap. */
  api: RestClient;
  roomId: RoomId;
  /**
   * Access-token provider. Defaults to the web auth store's
   * {@link ensureAccessToken} (in-memory token, httpOnly-cookie refresh).
   */
  getToken?: () => Promise<string | null>;
  /** Websocket base URL; defaults to WS_URL derived from NEXT_PUBLIC_API_URL. */
  wsBaseUrl?: string;
  /**
   * Seed the sequence tracker with the room's event tip (from
   * GetRoomResponse/GuestJoinResponse `lastEventSeq`) so the first live event
   * is `next`, not a full-history gap replay.
   */
  initialSeq?: number;
  /** Fired when a seq gap could not be backfilled — refetch room state. */
  onGapLoss?: (info: { roomId: RoomId; sinceSeq: number }) => void;
  /** Socket overrides (tests, custom timers). */
  socketOptions?: RoomConnectionSocketOptions;
  /** Test hook: how long emote bursts stay on screen. Default EMOTE_TTL_MS. */
  emoteTtlMs?: number;
}

/* ── Room state (server-authoritative projection for the panes) ─────────────
   Mirrors apps/mobile/src/room-connection.ts — same reducers, same constants,
   so web and native render the same room from the same event stream. */

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
  /** Live room entity — updated by room.updated (theater toggle, policies). */
  room: Room | null;
  playback: PlaybackState | null;
  queue: QueueState;
  /** Presence by userId (presence.state snapshots + presence.diff). */
  presence: Record<UserId, PresenceEntry>;
  /** Chat window, ascending by seq, capped at MAX_MESSAGES. */
  messages: Message[];
  /** True once the server returned a short (< 50) oldest page — nothing
   *  earlier exists, so the "Load earlier" affordance should hide. */
  chatHistoryExhausted: boolean;
  /** userId → typing-expiry timestamp (ms). */
  typing: Record<UserId, number>;
  readCursors: Record<UserId, number>;
  deliveredCursors: Record<UserId, number>;
  waitingOn: UserId[];
  master: { userId: UserId; epoch: number } | null;
  restream: RestreamState | null;
  emotes: EmoteBurst[];
  /** Bumped when a seq gap could not be backfilled — panes should refetch. */
  gapLossCount: number;
  /** Bumped on member.updated — People pane refetches the member list. */
  membersVersion: number;
  lastError: string | null;
}

export const MAX_MESSAGES = 300;
export const TYPING_TTL_MS = 4000;
export const EMOTE_TTL_MS = 2500;

function initialRoomState(): RoomState {
  return {
    room: null,
    playback: null,
    queue: initialQueueState(),
    presence: {},
    messages: [],
    chatHistoryExhausted: false,
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

/**
 * The web client's realtime core: exactly ONE instance per room, created by
 * the room shell's RoomProvider and shared by every pane through
 * `@/lib/room-context`.
 *
 * It wraps `@gather/api-client`'s RoomSocket (heartbeat clock sync, seq
 * tracking, gap replay, send queueing, backoff reconnect) rather than
 * rebuilding that machinery, and adds:
 *  - cookie/JWT auth: token acquisition + rotation on reconnect,
 *  - zustand status/lastSeq stores for React,
 *  - whole-event `send`/`subscribe` ergonomics over contracts types.
 *
 * Zero loss/dupes: persisted events (seq > 0) are deduped and gap-backfilled
 * by the socket's SeqTracker + `api.events.replay`; ephemeral events (seq 0)
 * pass straight through and are never replayed.
 */
export class RoomConnection {
  /** Zustand store: live connection status. */
  readonly useStatus: UseStore<ConnectionStatus>;
  /** Zustand store: highest contiguous persisted server seq seen. */
  readonly useLastSeq: UseStore<number>;
  /** Zustand store: server-authoritative room state for the panes. */
  readonly useRoomState: UseStore<RoomState>;

  private readonly api: RestClient;
  private readonly roomIdValue: RoomId;
  private readonly getToken: () => Promise<string | null>;
  private readonly initialSeq: number | undefined;
  private readonly socket: RoomSocket;
  private readonly emoteTtlMs: number;
  private activeToken: string | null = null;
  private closedIntentionally = false;
  private tokenRefreshInFlight = false;
  private emoteCounter = 0;

  constructor(opts: RoomConnectionOptions) {
    this.api = opts.api;
    this.roomIdValue = opts.roomId;
    this.getToken = opts.getToken ?? ensureAccessToken;
    this.initialSeq = opts.initialSeq;
    this.emoteTtlMs = opts.emoteTtlMs ?? EMOTE_TTL_MS;
    this.useStatus = create<ConnectionStatus>()(() => 'connecting');
    this.useLastSeq = create<number>()(() => opts.initialSeq ?? 0);
    this.useRoomState = create<RoomState>()(() => initialRoomState());

    this.socket = new RoomSocket(opts.wsBaseUrl ?? WS_URL, {
      ...opts.socketOptions,
      replayFetch: (roomId, sinceSeq) =>
        this.api.events.replay(roomId, sinceSeq).then((res) => res.events),
      onGapLoss: (info) => {
        this.useRoomState.setState((s) => ({ gapLossCount: s.gapLossCount + 1 }));
        // Strict ordering gave way to availability: rebuild the chat window
        // from the server so the UI never shows a silent hole.
        void this.loadRecentMessages().catch(() => undefined);
        opts.onGapLoss?.(info);
      },
    });

    this.socket.onStatus((status) => {
      this.useStatus.setState(toConnectionStatus(status));
      if (status === 'reconnecting') {
        void this.rotateTokenForReconnect();
      }
    });
    this.socket.onAny((ev) => {
      if (ev.seq > 0 && ev.seq > this.useLastSeq.getState()) {
        this.useLastSeq.setState(ev.seq);
      }
    });
    this.bindRoomState();
  }

  get roomId(): RoomId {
    return this.roomIdValue;
  }

  get status(): ConnectionStatus {
    return this.useStatus.getState();
  }

  get lastSeq(): number {
    return this.useLastSeq.getState();
  }

  /** Shared sync-core clock estimator (fed by socket heartbeats). */
  get clock(): ClockEstimator {
    return this.socket.clock;
  }

  /** The wrapped socket, for advanced panes (typed `on`, raw status). */
  get rawSocket(): RoomSocket {
    return this.socket;
  }

  /**
   * Acquires an access token and opens the socket (heartbeat clock pings are
   * started by RoomSocket on open). Safe to call again after `close()`.
   */
  async connect(): Promise<void> {
    this.closedIntentionally = false;
    const token = await this.getToken();
    if (token === null) {
      throw new ApiError(
        'UNAUTHORIZED',
        'an access token is required to open a room connection',
      );
    }
    this.activeToken = token;
    if (this.initialSeq === undefined) {
      this.socket.connect(this.roomIdValue, token);
    } else {
      this.socket.connect(this.roomIdValue, token, { initialSeq: this.initialSeq });
    }
  }

  /** Intentional close: no reconnect; queued sends are dropped. */
  close(): void {
    this.closedIntentionally = true;
    this.socket.close();
  }

  /** Send a typed client event (queued while the socket is down). */
  send(event: ClientEvent): void {
    this.socket.send(event.type, event.payload);
  }

  /** Fires for every server event (persisted + ephemeral). Idempotent unsubscribe. */
  subscribe(cb: (ev: ServerEvent) => void): () => void {
    return this.socket.onAny(cb);
  }

  /** Typed subscription to one server event type. */
  on<T extends ServerEvent['type']>(
    type: T,
    cb: (ev: Extract<ServerEvent, { type: T }>) => void,
  ): () => void {
    return this.socket.on(type, cb);
  }

  /** Seeds the live room entity (from GetRoomResponse) into the room store. */
  seedRoom(room: Room): void {
    this.useRoomState.setState({ room });
  }

  /** Initial chat window (newest page, applied ascending). Idempotent. */
  async loadRecentMessages(): Promise<void> {
    const page = await this.api.messages.listMessages(this.roomIdValue, { limit: 50 });
    const ascending = [...page.items].sort((a, b) => a.seq - b.seq);
    this.useRoomState.setState((s) => {
      let messages = s.messages;
      for (const msg of ascending) messages = insertMessage(messages, msg);
      return {
        messages: messages.slice(-MAX_MESSAGES),
        // A short newest page means the window already holds everything.
        chatHistoryExhausted: ascending.length < 50,
      };
    });
  }

  // ── Send helpers (payloads typed against contracts ClientEvent) ──────────

  chatSend(input: {
    body: string;
    kind?: 'text' | 'gif' | 'attachment' | 'voice';
    gifUrl?: string | null;
    attachment?: Message['attachment'];
    replyTo?: MessageId | null;
    mentions?: UserId[];
  }): void {
    this.socket.send('chat.send', {
      kind: input.kind ?? 'text',
      body: input.body,
      gifUrl: input.gifUrl ?? null,
      attachment: input.attachment ?? null,
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

  restreamStart(): void {
    this.socket.send('restream.start', {});
  }

  restreamStop(): void {
    this.socket.send('restream.stop', {});
  }

  // ── Server event reducers ────────────────────────────────────────────────

  private bindRoomState(): void {
    const set = this.useRoomState.setState.bind(this.useRoomState);

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
            ? { ...m, deletedAt: ev.payload.deletedAt, body: '', gifUrl: null, attachment: null, reactions: {} }
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
          next[userId] = Date.now() + TYPING_TTL_MS;
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
      const burst: EmoteBurst = { id, ...ev.payload, at: Date.now() };
      set((s) => ({ emotes: [...s.emotes, burst] }));
      setTimeout(() => {
        this.useRoomState.setState((s) => ({ emotes: s.emotes.filter((e) => e.id !== id) }));
      }, this.emoteTtlMs);
    });

    this.socket.on('error', (ev) => {
      set({ lastError: ev.payload.message });
    });
  }

  /**
   * Reconnects carry the token captured at connect(); when it has rotated
   * (access tokens are short-lived), bounce the socket so the next attempt
   * authenticates with the fresh token. RoomSocket keeps the seq tracker
   * across same-room connects, so replay dedupe is preserved.
   */
  private async rotateTokenForReconnect(): Promise<void> {
    if (this.tokenRefreshInFlight || this.closedIntentionally) return;
    this.tokenRefreshInFlight = true;
    try {
      const token = await this.getToken();
      if (token === null || token === this.activeToken || this.closedIntentionally) {
        return;
      }
      this.activeToken = token;
      this.socket.close();
      this.socket.connect(this.roomIdValue, token);
    } catch {
      // Token refresh failed; RoomSocket's backoff keeps retrying with the
      // previous token, and the next reconnecting transition retries this.
    } finally {
      this.tokenRefreshInFlight = false;
    }
  }
}
