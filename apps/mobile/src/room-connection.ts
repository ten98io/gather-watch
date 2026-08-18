/**
 * RoomConnection — the app's realtime core, same contract as the web client:
 * one RoomSocket per room, server-authoritative state applied from the
 * multiplexed event stream, gap recovery via events.replay (handled inside
 * RoomSocket), and zustand store the screens subscribe to.
 *
 * This module is deliberately RN-free (no react / react-native imports) so
 * vitest can exercise it in a node environment with a fake WebSocket.
 */
import { RoomSocket } from '@gather/api-client';
import type {
  ClearTimeoutFn,
  ConnectOptions,
  RestClient,
  SetTimeoutFn,
  SocketStatus,
  TimeoutHandle,
  WebSocketCtor,
} from '@gather/api-client';
import { applyServerState, initialQueueState } from '@gather/sync-core';
import type { QueueState } from '@gather/sync-core';
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
} from '@gather/contracts';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { endedQueueItemId } from './sync/advance';

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
/**
 * Presence heartbeat cadence — mirrors the web client. The server expires any
 * member whose presence is older than 45s EVEN WITH THE SOCKET STILL OPEN
 * (services/api …/rooms/presence.ts, ttlMs), and discrete UI events alone
 * never reach that far; 15s survives two lost beats.
 */
export const PRESENCE_KEEPALIVE_MS = 15_000;

/** The slice of its own presence a client may assert. */
export interface PresencePatch {
  state?: PresenceEntry['state'];
  micOn?: boolean;
  camOn?: boolean;
  sharing?: boolean;
}

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
  /** Presence keepalive cadence. Default PRESENCE_KEEPALIVE_MS. */
  presenceKeepaliveMs?: number;
  /**
   * The signed-in member's id. When set, the presence keepalive re-asserts
   * this member's CURRENT presence from the store instead of the last patch
   * this client sent.
   */
  userId?: UserId;
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
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly emoteTtlMs: number;
  private readonly presenceKeepaliveMs: number;
  private readonly selfUserId: UserId | null;
  private presenceKeepaliveHandle: TimeoutHandle | null = null;
  /** Everything this client has told the server about its own presence. */
  private lastPresenceSent: PresencePatch = {};
  private emoteCounter = 0;
  private roomId: RoomId | null = null;
  /** The last item whose end this client reported. See {@link reportEndedItem}. */
  private advancedItemId: QueueItemId | null = null;

  constructor(opts: RoomConnectionOptions) {
    this.rest = opts.rest;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
    this.emoteTtlMs = opts.emoteTtlMs ?? EMOTE_TTL_MS;
    this.presenceKeepaliveMs = opts.presenceKeepaliveMs ?? PRESENCE_KEEPALIVE_MS;
    this.selfUserId = opts.userId ?? null;
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

    this.socket.onStatus((status) => {
      this.store.setState({ status });
      if (status === 'open') {
        this.requestRoomSnapshot();
        this.startPresenceKeepalive();
      } else {
        this.stopPresenceKeepalive();
      }
    });
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
    this.stopPresenceKeepalive();
    this.socket.close();
    this.roomId = null;
    this.lastPresenceSent = {};
    // A different room's items are different items; the guard must not carry.
    this.advancedItemId = null;
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

  /**
   * "The item I was playing has ENDED; move the room on from it." Mirrors the
   * web helper — see apps/web/lib/room-connection.ts for why this names the
   * finished item instead of the next one, and why every member may send it.
   *
   * A phone is the reason this exists at all. Under the master seat a host
   * watching on mobile held the room's one advancer slot while mounting no
   * advancer, so the queue stopped at the end of the first item; the seat is
   * gone, and this is the half that lets mobile carry its own weight.
   *
   * The raw send. {@link reportEndedItem} is what the player calls — it works
   * out WHICH item ended and fires once for it.
   */
  syncAdvance(endedItemId: QueueItemId): void {
    this.socket.send('sync.advance', { endedItemId });
  }

  /**
   * This device's player ran out: name the item and tell the room, once.
   *
   * Called from the sync engine's end guard (src/sync/useSyncEngine.ts), which
   * is the phone's only end-of-item signal. Without this call a room being
   * watched on a phone alone emits no ending from anywhere and the queue stops
   * on its first item — the stall this method exists to close.
   *
   * IT RESOLVES THE ITEM FROM THE STORE, not from an argument. The screen
   * holds no truth the connection does not already have, and reading both the
   * queue and the playback snapshot at the same instant is what keeps the id
   * and the index talking about the same moment.
   *
   * FIRES ONCE PER ITEM, by remembering the last id it reported rather than a
   * set of every id it ever has. A set could never leave an item the room came
   * BACK to (a replay, a reorder that restored a slot); one id cannot latch,
   * because the following item's id is a different one. Duplicates are
   * harmless anyway — the server compare-and-sets and drops a report for an
   * item the room has already left — so this is tidiness, not correctness, and
   * a loop is the only thing it must genuinely prevent.
   */
  reportEndedItem(): void {
    const { playback, queue } = this.store.getState();
    const endedItemId = endedQueueItemId({
      queueIndex: playback?.queueIndex ?? null,
      items: queue.items,
      mediaRef: playback?.mediaRef ?? null,
    });
    // Null is a real answer: nothing in the queue matches what just ended, so
    // there is no item to move the room on from. See sync/advance.ts.
    if (endedItemId === null) return;
    if (this.advancedItemId === endedItemId) return;
    this.advancedItemId = endedItemId;
    this.syncAdvance(endedItemId);
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

  presenceUpdate(patch: PresencePatch): void {
    // Remembered so the keepalive can re-assert this member's real state even
    // before the server's own diff has come back into the store.
    this.lastPresenceSent = { ...this.lastPresenceSent, ...patch };
    this.socket.send('presence.update', patch);
  }

  emoteBurst(emoji: string, xPct: number, yPct: number): void {
    this.socket.send('emote.burst', { emoji, xPct, yPct });
  }

  // ── Presence keepalive ───────────────────────────────────────────────────

  /**
   * The one frame every open owes the server: this member's current presence
   * WITH `wantSnapshot`, so the reply carries the room back. Mirrors the web
   * client.
   *
   * Backgrounding the app (or any reconnect) is not a leave, and the presence
   * entry outlives it — so the server sees an ordinary heartbeat, `created`
   * is false, and without the flag it replies with NOTHING, leaving the
   * screen on an empty queue, no playback and an empty roster. Exactly one
   * per open: the periodic beats must stay cheap.
   */
  private requestRoomSnapshot(): void {
    // 'offline' would ask the server to DELETE the entry (and reply nothing),
    // so a member who last said offline still rejoins as a watcher.
    const patch = this.presenceBeat() ?? { state: 'watching' as const };
    // Remembered like any other assertion — minus the flag, which belongs to
    // this frame alone and must not leak into the keepalive beats.
    this.lastPresenceSent = { ...this.lastPresenceSent, ...patch };
    this.socket.send('presence.update', { ...patch, wantSnapshot: true });
  }

  /**
   * Beats presence while the socket is open. The server's presence TTL is 45s
   * and expiry is NOT gated on the socket being closed, so a client that only
   * sends discrete UI events silently rots out of the roster.
   *
   * The beat carries the member's CURRENT state, never an empty payload: an
   * empty presence.update means "send me the roster" server-side and would
   * make every beat cost a full presence.state + sync.state + queue.state
   * reply. An unchanged state is silent — the tracker only diffs when a
   * client-visible field actually changes.
   */
  private startPresenceKeepalive(): void {
    this.stopPresenceKeepalive();
    const tick = () => {
      this.presenceKeepaliveHandle = null;
      if (this.store.getState().status !== 'open') return;
      const patch = this.presenceBeat();
      if (patch !== null) this.presenceUpdate(patch);
      this.presenceKeepaliveHandle = this.setTimeoutFn(tick, this.presenceKeepaliveMs);
    };
    // The first beat waits a full interval: requestRoomSnapshot() has just
    // sent this member's current state on the open frame, so an immediate
    // beat would be the same assertion twice.
    this.presenceKeepaliveHandle = this.setTimeoutFn(tick, this.presenceKeepaliveMs);
  }

  private stopPresenceKeepalive(): void {
    if (this.presenceKeepaliveHandle !== null) {
      this.clearTimeoutFn(this.presenceKeepaliveHandle);
      this.presenceKeepaliveHandle = null;
    }
  }

  /**
   * This member's presence as the server should still see it: the store's own
   * row when we know our userId, else whatever we last sent. Null means "do
   * not beat" ('offline' would delete the entry we are keeping alive).
   */
  private presenceBeat(): PresencePatch | null {
    const mine =
      this.selfUserId === null ? undefined : this.store.getState().presence[this.selfUserId];
    if (mine !== undefined) {
      if (mine.state === 'offline') return null;
      return { state: mine.state, micOn: mine.micOn, camOn: mine.camOn, sharing: mine.sharing };
    }
    const sent = this.lastPresenceSent;
    if (sent.state === 'offline') return null;
    // Never an empty payload — that is the server's roster-snapshot request.
    return { ...sent, state: sent.state ?? 'watching' };
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

    this.socket.on('queue.state', (ev) => {
      // Version-guarded, mirroring web. The snapshot reply to the wantSnapshot
      // ask is seq 0 (applied immediately, no gap detection), and the server
      // reads the room before awaiting the heartbeat — so a late reply can
      // carry an older queue than the broadcast that already landed.
      set((s) => (ev.payload.version < s.queue.version
        ? {}
        : { queue: { items: ev.payload.items, version: ev.payload.version } }));
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

    this.socket.on('member.removed', (ev) => {
      // The server has emitted this since the roster fix; nothing on the
      // client listened, so a kick, a ban or someone leaving stayed invisible
      // until a manual refresh. Clear the presence entry (an absent member is
      // not a silent one) and bump the version — that is what makes the
      // People tab refetch the roster.
      set((s) => {
        const presence = { ...s.presence };
        delete presence[ev.payload.userId];
        return { presence, membersVersion: s.membersVersion + 1 };
      });
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
