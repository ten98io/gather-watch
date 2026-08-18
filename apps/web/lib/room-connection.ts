import { ApiError, RoomSocket, defaultClearTimeout, defaultSetTimeout } from '@gather/api-client';
import type {
  ClearTimeoutFn,
  ClockEstimator,
  RoomSocketOptions,
  SetTimeoutFn,
  SocketStatus,
  TimeoutHandle,
} from '@gather/api-client';
import type {
  ClientEvent,
  Member,
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
   * The signed-in member's id. The presence keepalive uses it to read this
   * member's CURRENT presence out of the room store, so the beat re-asserts
   * 'in-call'/'away' instead of overwriting them with an idle default.
   */
  userId?: UserId;
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
  /** Presence keepalive cadence. Default PRESENCE_KEEPALIVE_MS. */
  presenceKeepaliveMs?: number;
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
  /** Member rows by userId — the caller's row is seeded from the join
   *  response, then every row advances on member.updated (promotion,
   *  demotion, host transfer, ban). Identity is preserved when content is
   *  unchanged so gates keyed on the object stay quiet. */
  members: Record<UserId, Member>;
  playback: PlaybackState | null;
  queue: QueueState;
  /** Presence by userId (presence.state snapshots + presence.diff). */
  presence: Record<UserId, PresenceEntry>;
  /** Chat window, ascending by seq, capped at MAX_MESSAGES. */
  messages: Message[];
  /** True once the server returned a short (< 50) oldest page — nothing
   *  earlier exists, so the "Load earlier" affordance should hide. */
  chatHistoryExhausted: boolean;
  /**
   * Newest chat seq this member has actually LOOKED AT. The unread badge is
   * `messages after this that someone else wrote`, so it has to live here and
   * not in ChatPane: the pane is one tab of three and the whole point of the
   * badge is to be right about the time you were not on it. Advanced only by
   * {@link RoomConnection.markChatSeen}; monotonic.
   */
  chatSeenSeq: number;
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
  /** Bumped on member.updated / member.removed — People pane refetches the
   *  member list (the REST roster carries profiles the events do not). */
  membersVersion: number;
  lastError: string | null;
  /**
   * Set once the room has refused this session for good (kicked, banned, the
   * room is gone, the token is dead). Null while the connection is merely
   * down — a dropped wifi is not a refusal, and the two must not look alike.
   */
  closed: RoomClosedInfo | null;
}

/** Why the room ended this session: the ws close code and the server's text. */
export interface RoomClosedInfo {
  code: number;
  reason: string;
}

export const MAX_MESSAGES = 300;
export const TYPING_TTL_MS = 4000;
export const EMOTE_TTL_MS = 2500;
/**
 * Presence heartbeat cadence. The server expires any member whose presence is
 * older than 45s EVEN WITH THE SOCKET STILL OPEN (services/api …/presence.ts,
 * ttlMs) — and the roster it drops is what CallMesh reconciles peers from, so
 * a silent client tears its own call down. 15s survives two lost beats.
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
    room: null,
    members: {},
    playback: null,
    queue: initialQueueState(),
    presence: {},
    messages: [],
    chatHistoryExhausted: false,
    chatSeenSeq: 0,
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
    closed: null,
  };
}

/**
 * Structural equality over JSON-shaped values (server payloads). Reducers use
 * it to keep an object's identity when a re-delivered or re-seeded payload
 * carries no actual change — components key effects off these objects
 * (StagePane's extension handoff, room-shell's theater gate), so an
 * identical-content replacement must not fire them.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => jsonEqual(left[k], right[k]));
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

/**
 * Messages someone ELSE wrote after the last seq this member looked at.
 *
 * Deliberately a projection over state that outlives the chat pane, so the
 * count is right for exactly the window it exists to describe: the time the
 * pane was not the tab you were on.
 */
export function unreadChatCount(
  messages: readonly Message[],
  chatSeenSeq: number,
  me: UserId,
): number {
  return messages.filter(
    (m) => m.seq > chatSeenSeq && m.authorId !== me && m.deletedAt === null,
  ).length;
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
  private readonly selfUserId: UserId | null;
  private readonly presenceKeepaliveMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private presenceKeepaliveHandle: TimeoutHandle | null = null;
  /** Everything this client has told the server about its own presence. */
  private lastPresenceSent: PresencePatch = {};
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
    this.selfUserId = opts.userId ?? null;
    this.presenceKeepaliveMs = opts.presenceKeepaliveMs ?? PRESENCE_KEEPALIVE_MS;
    this.setTimeoutFn = opts.socketOptions?.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn = opts.socketOptions?.clearTimeoutFn ?? defaultClearTimeout;
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
      onTerminalClose: (info) => {
        // The server refused this session for good (auth / removed / gone).
        // No reconnect follows, so the panes must be told why rather than
        // sitting on a "reconnecting…" that will never resolve — and a kick
        // has to read as a kick, not as the same "Offline" pill a lost wifi
        // shows. `closed` is the blocking-state signal; `lastError` stays as
        // the ambient one that any server error can also set.
        this.useRoomState.setState({ lastError: info.reason, closed: { ...info } });
      },
    });

    this.socket.onStatus((status) => {
      this.useStatus.setState(toConnectionStatus(status));
      if (status === 'open') {
        this.requestRoomSnapshot();
        this.startPresenceKeepalive();
      } else {
        this.stopPresenceKeepalive();
      }
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

  /**
   * Why the room refused this session, once it has (auth expired, removed,
   * room gone). Null while the connection is merely down — a 'closed' status
   * WITH a reason is final, without one it is an ordinary intentional close.
   */
  get closeInfo(): { code: number; reason: string } | null {
    return this.socket.closeInfo;
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
    // Re-entering clears the last refusal, the same way RoomSocket clears its
    // own closeInfo — otherwise the blocking notice would outlive the attempt
    // that is meant to replace it.
    if (this.useRoomState.getState().closed !== null) {
      this.useRoomState.setState({ closed: null });
    }
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
    this.stopPresenceKeepalive();
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
    this.useRoomState.setState((s) =>
      s.room !== null && jsonEqual(s.room, room) ? {} : { room },
    );
  }

  /**
   * Seeds a member row (the caller's own, from GetRoomResponse) into the
   * store; member.updated advances it from there so role changes take effect
   * without a rejoin.
   */
  seedMember(member: Member): void {
    this.useRoomState.setState((s) => {
      const prev = s.members[member.userId];
      if (prev !== undefined && jsonEqual(prev, member)) return {};
      return { members: { ...s.members, [member.userId]: member } };
    });
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
        // The backlog that was already there when you arrived is not unread —
        // "unread" means "arrived while you were here and looking elsewhere".
        // Only the FIRST load seeds the anchor; later calls must never rewind
        // or fast-forward a cursor the pane is maintaining.
        chatSeenSeq:
          s.chatSeenSeq === 0
            ? (messages[messages.length - 1]?.seq ?? 0)
            : s.chatSeenSeq,
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

  /**
   * "I have now seen chat up to `seq`." Advances the store's unread anchor and
   * sends the read receipt, once, for each new high-water mark.
   *
   * Both halves belong here rather than in ChatPane. The anchor has to outlive
   * the pane (it is what the unread badge is measured against while you are on
   * another tab), and the receipt has to be deduped against something that
   * outlives it too — a `useRef` in the pane re-armed on every remount and
   * re-sent a cursor the server already had.
   */
  markChatSeen(seq: number): void {
    if (seq <= 0 || seq <= this.useRoomState.getState().chatSeenSeq) return;
    this.useRoomState.setState({ chatSeenSeq: seq });
    try {
      this.chatRead(seq);
    } catch {
      // The anchor is local truth and has advanced either way; the receipt is
      // a courtesy to other members. RoomSocket QUEUES sends while the socket
      // is merely down, but throws outright before the first connect() has
      // resolved a token — and the chat pane can render inside that window.
      // Losing one receipt is nothing; taking down the room with it is not.
    }
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

  presenceUpdate(patch: PresencePatch): void {
    // Remembered so the keepalive can re-assert this member's real state even
    // before the server's own diff has come back into the store.
    this.lastPresenceSent = { ...this.lastPresenceSent, ...patch };
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

  // ── Presence keepalive ───────────────────────────────────────────────────

  /**
   * The one frame every open owes the server: this member's current presence
   * WITH `wantSnapshot`, so the reply carries the room back.
   *
   * A refresh is not a leave. Nothing evicts a reloading tab — but the
   * presence entry outlives the 1-5s reload (15s disconnect grace, 45s TTL),
   * so the server sees an ordinary heartbeat, `created` is false, and without
   * the flag it replies with NOTHING. The fresh store then stays at
   * initialRoomState(): empty queue, null playback, no restream, and an EMPTY
   * roster — which makes CallMesh.applyPresence([]) tear down every peer, so
   * from the other machines the guests really did get kicked. Replay cannot
   * cover this: it closes GAPS, and a reloaded client has no state to gap
   * from. The snapshot is the vehicle.
   *
   * Exactly one of these per open, and never on the periodic beats: each one
   * costs a full presence + sync + queue reply.
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
   * Beats presence while the socket is live. The server's presence TTL is
   * 45s and expiry is NOT gated on the socket being closed, so a member who
   * only ever sends discrete UI events (join call, mic toggle) silently rots
   * out of the roster — taking their WebRTC peers with them.
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
      if (this.closedIntentionally || this.status !== 'live') return;
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
   * row when we know our userId (it already reflects every surface — call,
   * share, away), else whatever we last sent. Null means "do not beat"
   * ('offline' would delete the entry we are trying to keep alive).
   */
  private presenceBeat(): PresencePatch | null {
    const mine =
      this.selfUserId === null ? undefined : this.useRoomState.getState().presence[this.selfUserId];
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
      // Version-guarded for the same reason applyServerState is seq-guarded.
      // The snapshot reply to our wantSnapshot ask is stamped seq 0, so the
      // tracker classifies it 'ephemeral' and applies it immediately — past
      // gap detection, buffering and replay. The server reads the room BEFORE
      // awaiting the presence heartbeat, so that reply can carry a queue that
      // is already stale by the time it lands; without this guard a track
      // added during the ask would vanish from the refreshed tab and, because
      // there is no seq gap, replay would never put it back.
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
        // A no-op diff must not produce a new object. The server's grace
        // handling re-publishes an entry whose visible fields are unchanged
        // (only server-side reachability moved), and a fresh `presence` map
        // re-renders every subscriber and re-runs the call mesh's peer
        // reconciliation for nothing — per member, per flap.
        const changed =
          ev.payload.removed.some((userId) => s.presence[userId] !== undefined) ||
          ev.payload.upserts.some((entry) => !jsonEqual(s.presence[entry.userId], entry));
        if (!changed) return {};
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
      set((s) =>
        s.room !== null && jsonEqual(s.room, ev.payload) ? {} : { room: ev.payload },
      );
    });

    this.socket.on('member.updated', (ev) => {
      set((s) => {
        const prev = s.members[ev.payload.userId];
        const members =
          prev !== undefined && jsonEqual(prev, ev.payload)
            ? s.members
            : { ...s.members, [ev.payload.userId]: ev.payload };
        // The version still bumps: the People pane refetches its roster (the
        // REST list carries profiles this event does not).
        return { members, membersVersion: s.membersVersion + 1 };
      });
    });

    this.socket.on('member.removed', (ev) => {
      // The server has emitted this since the roster fix; nothing on the
      // client listened, so a kick, a ban or someone leaving stayed invisible
      // until a manual refresh. Drop the row AND the presence entry (an
      // absent member is not a silent one), then bump the version — that is
      // what makes PeoplePane and CallSurface refetch.
      set((s) => {
        const { userId } = ev.payload;
        const members = { ...s.members };
        delete members[userId];
        const presence = { ...s.presence };
        delete presence[userId];
        return { members, presence, membersVersion: s.membersVersion + 1 };
      });
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
      // A bounce, not a goodbye: whatever the user typed or queued while the
      // socket was down must survive the swap, so the queue is preserved.
      this.socket.close({ preserveQueue: true });
      this.socket.connect(this.roomIdValue, token);
    } catch {
      // Token refresh failed; RoomSocket's backoff keeps retrying with the
      // previous token, and the next reconnecting transition retries this.
    } finally {
      this.tokenRefreshInFlight = false;
    }
  }
}
