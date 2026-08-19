import { ServerEvent, WS_AUTH_SUBPROTOCOL_PREFIX } from '@gather/contracts';
import type { ClientEvent, RoomId, WsEnvelope } from '@gather/contracts';
import { ClockEstimator } from '@gather/sync-core';
import { ApiError } from './errors';
import { SeqTracker } from './seq';
import { defaultClearTimeout, defaultSetTimeout, defaultWebSocketCtor } from './types';
import type {
  ClearTimeoutFn,
  SetTimeoutFn,
  TimeoutHandle,
  WebSocketCtor,
  WebSocketLike,
} from './types';

/** Lifecycle status of a {@link RoomSocket}. */
export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

// The subprotocol prefix itself lives in @gather/contracts (ws.ts) — the
// server reads it too, and contracts is the wire's single source of truth.

/* Close codes the hub uses to REJECT a socket (services/api/src/ws/hub.ts):
   4401 auth failures, 4403 forbidden/banned/scope, 4404 no room. Retrying any
   of them with the same credentials just hammers the server forever, so they
   end the session instead of feeding the backoff loop. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_FOUND = 4404;

/** Fallbacks for a close frame that carried no reason text. */
const CLOSE_FALLBACK_REASON: Record<number, string> = {
  [CLOSE_UNAUTHORIZED]: 'your session is no longer authorized for this room',
  [CLOSE_FORBIDDEN]: 'you no longer have access to this room',
  [CLOSE_NOT_FOUND]: 'this room no longer exists',
};

/** 4403/4404 are permanent for ANY credentials — never worth another attempt. */
function isPermanentCloseCode(code: number | undefined): boolean {
  return code === CLOSE_FORBIDDEN || code === CLOSE_NOT_FOUND;
}

/** Why the session ended for good; surfaced so the UI can say something true. */
export interface SocketCloseInfo {
  code: number;
  reason: string;
}

/** Fetches missed events after a sequence gap (typically wraps rest.events.replay). */
export type ReplayFetch = (roomId: RoomId, sinceSeq: number) => Promise<WsEnvelope[]>;

/** Options for {@link RoomSocket}. */
export interface RoomSocketOptions {
  /** Required replay backfill used to close sequence gaps. */
  replayFetch: ReplayFetch;
  /** WebSocket constructor; defaults to the platform WebSocket. */
  wsCtor?: WebSocketCtor;
  /** Heartbeat interval in ms. Defaults to 5000. */
  heartbeatMs?: number;
  /**
   * Consecutive unanswered clock.pings tolerated before the socket is treated
   * as half-open and forcibly reconnected. Defaults to 3 — at the default
   * 5s cadence that is ~15s of silence, well past any plausible RTT, so a
   * slow-but-alive connection is never killed (any pong resets the counter).
   */
  maxMissedPongs?: number;
  /** Clock source in ms. Defaults to a lazy Date.now. */
  now?: () => number;
  /** Random source in [0, 1) for backoff jitter. Defaults to a lazy Math.random. */
  rng?: () => number;
  /** Base reconnect backoff in ms. Defaults to 500. */
  backoffBaseMs?: number;
  /** Maximum reconnect backoff in ms. Defaults to 30000. */
  backoffMaxMs?: number;
  /** Exponential backoff factor. Defaults to 2. */
  backoffFactor?: number;
  /** Timer scheduler. Defaults to a lazy globalThis setTimeout. */
  setTimeoutFn?: SetTimeoutFn;
  /** Timer canceller. Defaults to a lazy globalThis clearTimeout. */
  clearTimeoutFn?: ClearTimeoutFn;
  /** Total replayFetch attempts per gap before giving up. Defaults to 3. */
  replayRetryAttempts?: number;
  /** Base delay between replay retries in ms; the delay before retry k is
   *  `replayRetryDelayMs * k`. Defaults to 500. */
  replayRetryDelayMs?: number;
  /**
   * Fired when a gap could not be backfilled after every retry: buffered
   * events past the gap are then emitted (availability over strict ordering)
   * and the events in [sinceSeq+1, first buffered seq) are LOST. Apps should
   * refetch room state (messages, sync) when this fires.
   */
  onGapLoss?: (info: { roomId: RoomId; sinceSeq: number }) => void;
  /**
   * Fired when the session ended for good (an auth/permission/not-found close
   * code, not a transport hiccup): no reconnect follows, so the app must show
   * the reason instead of a permanent "reconnecting…".
   */
  onTerminalClose?: (info: SocketCloseInfo) => void;
}

/** Options for {@link RoomSocket.connect}. */
export interface ConnectOptions {
  /**
   * Seeds the sequence tracker when joining a NEW room (ignored for
   * reconnects to the same room, which keep the tracker for dedupe). Pass the
   * room's current tip (e.g. GetRoomResponse.lastEventSeq) so the first live
   * event is `next` instead of a gap that replays the room's entire history.
   */
  initialSeq?: number;
}

/**
 * Room websocket client with heartbeat-driven clock estimation, sequence
 * tracking with gap detection and replay backfill, send queueing while
 * disconnected, and exponential-backoff reconnect with jitter.
 */
export class RoomSocket {
  /**
   * Shared sync-core clock estimator fed by clock.ping/clock.pong heartbeats.
   * Use `clock.serverNow(nowMs)` to feed sync-core's expectedPositionMs.
   */
  readonly clock: ClockEstimator;

  private readonly wsBaseUrl: string;
  private readonly replayFetch: ReplayFetch;
  private readonly wsCtorOpt: WebSocketCtor | undefined;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly backoffFactor: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly replayRetryAttempts: number;
  private readonly replayRetryDelayMs: number;
  private readonly maxMissedPongs: number;
  private readonly onGapLoss: ((info: { roomId: RoomId; sinceSeq: number }) => void) | undefined;
  private readonly onTerminalClose: ((info: SocketCloseInfo) => void) | undefined;

  private readonly tracker = new SeqTracker(0);
  private statusValue: SocketStatus = 'idle';
  private socket: WebSocketLike | null = null;
  private wsCtor: WebSocketCtor | null = null;
  private currentRoomId: RoomId | null = null;
  private currentToken: string | null = null;
  private hasBeenOpen = false;
  private closeRequested = false;
  private reconnectAttempt = 0;
  private reconnectHandle: TimeoutHandle | null = null;
  private heartbeatHandle: TimeoutHandle | null = null;
  private sendQueue: string[] = [];
  /** Pings sent since the last clock.pong; reset by any pong and by open. */
  private missedPongs = 0;
  /** True once a 4401 has already bought its one token-refresh retry. */
  private authRetryUsed = false;
  /**
   * True once the CURRENT socket has carried a frame FROM the server. The hub
   * completes the WebSocket handshake and only then authorizes, closing an
   * unauthorized socket with 4401 after it is already open (see
   * services/api/src/ws/hub.ts) — so 'open' on its own proves nothing. Only a
   * server frame proves the session was really accepted, and only that refunds
   * the budgets (backoff attempts, the one-shot 4401 retry) that must survive
   * an open-then-rejected cycle.
   */
  private sessionProven = false;
  private closeInfoValue: SocketCloseInfo | null = null;
  private buffer: ServerEvent[] = [];
  private replaying = false;
  private replayRetryCancel: (() => void) | null = null;

  private readonly typedHandlers = new Map<string, Set<(ev: ServerEvent) => void>>();
  private readonly anyHandlers = new Set<(ev: ServerEvent) => void>();
  private readonly statusHandlers = new Set<(status: SocketStatus) => void>();

  constructor(wsBaseUrl: string, opts: RoomSocketOptions) {
    this.wsBaseUrl = wsBaseUrl;
    this.replayFetch = opts.replayFetch;
    this.wsCtorOpt = opts.wsCtor;
    this.heartbeatMs = opts.heartbeatMs ?? 5000;
    this.now = opts.now ?? (() => Date.now());
    this.rng = opts.rng ?? (() => Math.random());
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30000;
    this.backoffFactor = opts.backoffFactor ?? 2;
    this.setTimeoutFn = opts.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? defaultClearTimeout;
    this.replayRetryAttempts = opts.replayRetryAttempts ?? 3;
    this.replayRetryDelayMs = opts.replayRetryDelayMs ?? 500;
    this.maxMissedPongs = opts.maxMissedPongs ?? 3;
    this.onGapLoss = opts.onGapLoss;
    this.onTerminalClose = opts.onTerminalClose;
    this.clock = new ClockEstimator();
  }

  /** Current lifecycle status. */
  get status(): SocketStatus {
    return this.statusValue;
  }

  /** Highest contiguous server sequence number seen for the current room. */
  get lastSeq(): number {
    return this.tracker.lastSeq;
  }

  /**
   * Set when the server refused the session for good (4401 after its one
   * retry, 4403, 4404); null while healthy or after an intentional close().
   */
  get closeInfo(): SocketCloseInfo | null {
    return this.closeInfoValue;
  }

  /**
   * Whether the clock estimator has a MEASURED offset yet. Until the first pong
   * lands `clock.offsetMs()` reads 0, which is indistinguishable from a genuine
   * zero offset, so anything that drives a correction (expectedPositionMs into
   * DriftController) must wait for this instead of correcting against a
   * placeholder. Everything else about the clock — sampleCount, reanchorCount,
   * state() — is on `clock` itself, which is public.
   */
  get clockReady(): boolean {
    return this.clock.hasEstimate();
  }

  /**
   * Connects to `roomId`. Idempotent while a session to the SAME room is
   * active; connecting to a different room while active throws CONFLICT
   * (call `close()` first) instead of silently staying on the old room.
   * After a `close()`, starts a fresh session; the sequence tracker is only
   * reset when the room changes so replay dedupes across manual reconnects.
   */
  connect(roomId: RoomId, token: string, opts?: ConnectOptions): void {
    if (
      this.statusValue === 'connecting' ||
      this.statusValue === 'open' ||
      this.statusValue === 'reconnecting'
    ) {
      if (this.currentRoomId === roomId) return;
      throw new ApiError(
        'CONFLICT',
        'already connected to a different room — close() before connecting elsewhere',
      );
    }
    const ctor = this.wsCtorOpt ?? defaultWebSocketCtor();
    if (ctor === undefined) {
      throw new ApiError('INTERNAL', 'no WebSocket implementation available');
    }
    this.wsCtor = ctor;
    if (this.currentRoomId !== roomId) {
      this.tracker.reset(opts?.initialSeq ?? 0);
      this.hasBeenOpen = false;
      this.buffer = [];
      // Envelopes queued for the previous room must never leak into this one.
      this.sendQueue = [];
    }
    this.currentRoomId = roomId;
    this.currentToken = token;
    this.closeRequested = false;
    this.closeInfoValue = null;
    // An explicit connect() is a deliberate new session with caller-supplied
    // credentials, so it always starts with a full retry budget. The infinite
    // loop this guards against lives in the INTERNAL reconnect path, which
    // never comes through here.
    this.authRetryUsed = false;
    this.reconnectAttempt = 0;
    this.missedPongs = 0;
    this.openSocket(false);
  }

  /**
   * Intentionally closes the session: no reconnect, status becomes 'closed'.
   * Queued-but-unsent envelopes are dropped — unless `preserveQueue` is set,
   * which an app uses when it is only BOUNCING the socket (token rotation)
   * and the user's unsent chat message or queue change must survive.
   */
  close(opts?: { preserveQueue?: boolean }): void {
    this.closeRequested = true;
    this.cancelReconnect();
    this.stopHeartbeat();
    if (opts?.preserveQueue !== true) {
      this.sendQueue = [];
    }
    this.replayRetryCancel?.();
    const sock = this.socket;
    this.socket = null;
    if (sock !== null) {
      try {
        sock.close();
      } catch {
        // Ignore errors from an already-broken socket.
      }
    }
    this.setStatus('closed');
  }

  /**
   * Sends a client event. When open, it is sent immediately; otherwise it is
   * queued and flushed FIFO on the next open. Throws when connect() was
   * never called.
   */
  send<T extends ClientEvent['type']>(
    type: T,
    payload: Extract<ClientEvent, { type: T }>['payload'],
  ): void {
    if (this.currentRoomId === null) {
      throw new ApiError('INTERNAL', 'not connected');
    }
    const envelope = { type, roomId: this.currentRoomId, seq: 0, ts: this.now(), payload };
    const data = JSON.stringify(envelope);
    if (this.statusValue === 'open' && this.socket !== null) {
      this.socket.send(data);
    } else {
      this.sendQueue.push(data);
    }
  }

  /** Subscribes to a specific server event type. Returns an idempotent unsubscribe. */
  on<T extends ServerEvent['type']>(
    type: T,
    handler: (ev: Extract<ServerEvent, { type: T }>) => void,
  ): () => void {
    let set = this.typedHandlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.typedHandlers.set(type, set);
    }
    const h = handler as (ev: ServerEvent) => void;
    set.add(h);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(h);
    };
  }

  /** Subscribes to all server events. Returns an idempotent unsubscribe. */
  onAny(handler: (ev: ServerEvent) => void): () => void {
    this.anyHandlers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.anyHandlers.delete(handler);
    };
  }

  /** Subscribes to status changes. Returns an idempotent unsubscribe. */
  onStatus(handler: (status: SocketStatus) => void): () => void {
    this.statusHandlers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.statusHandlers.delete(handler);
    };
  }

  private openSocket(isReconnect: boolean): void {
    const ctor = this.wsCtor;
    const roomId = this.currentRoomId;
    const token = this.currentToken;
    if (ctor === null || roomId === null || token === null) return;
    const sep = this.wsBaseUrl.includes('?') ? '&' : '?';
    // The token travels as a Sec-WebSocket-Protocol subprotocol, NOT in the
    // URL: a query-string credential lands in every access log the request
    // touches (the api's own request log, edge proxies), and a WS URL cannot
    // carry an Authorization header — the subprotocol slot is the only header
    // a browser WebSocket can write. JWTs are base64url, which is legal
    // subprotocol syntax. The server keeps accepting the query form for
    // already-installed extension/mobile builds (services/api/src/ws/hub.ts).
    const url = this.wsBaseUrl + sep + 'roomId=' + encodeURIComponent(roomId);
    const sock = new ctor(url, [`${WS_AUTH_SUBPROTOCOL_PREFIX}${token}`]);
    this.socket = sock;
    this.sessionProven = false;
    this.setStatus(isReconnect ? 'reconnecting' : 'connecting');

    let settled = false;
    sock.onopen = () => {
      if (this.socket !== sock) return;
      this.handleOpen(sock);
    };
    sock.onmessage = (ev) => {
      if (this.socket !== sock) return;
      this.markSessionProven();
      this.handleMessage(ev);
    };
    sock.onerror = () => {
      if (settled) return;
      settled = true;
      this.handleSocketClose(sock);
    };
    sock.onclose = (ev) => {
      if (settled) {
        // onerror already drove the reconnect, but a permanent code arriving
        // behind it must still stop the retry loop instead of hammering the
        // server with credentials it has already rejected.
        if (!this.closeRequested && this.socket === null && isPermanentCloseCode(ev?.code)) {
          this.cancelReconnect();
          this.failTerminally(ev?.code as number, ev?.reason);
        }
        return;
      }
      settled = true;
      this.handleSocketClose(sock, ev);
    };
  }

  /**
   * First server frame on the current socket: this session is genuinely
   * established, not merely handshaken, so the budgets that must survive an
   * open-then-rejected cycle are refunded here rather than in handleOpen.
   */
  private markSessionProven(): void {
    if (this.sessionProven) return;
    this.sessionProven = true;
    this.reconnectAttempt = 0;
    this.authRetryUsed = false;
  }

  private handleOpen(sock: WebSocketLike): void {
    const wasReconnect = this.hasBeenOpen;
    this.hasBeenOpen = true;
    this.missedPongs = 0;
    // NOTE: reconnectAttempt and authRetryUsed are deliberately NOT reset here.
    // The hub rejects AFTER the handshake, so every rejected socket reaches
    // this method; refunding budgets on 'open' made "4401 buys one retry" an
    // infinite loop and pinned the backoff at its base delay forever.
    this.setStatus('open');
    const queued = this.sendQueue;
    this.sendQueue = [];
    for (let i = 0; i < queued.length; i += 1) {
      try {
        sock.send(queued[i] as string);
      } catch {
        // Socket died mid-flush: keep the unsent remainder queued (ahead of
        // anything queued meanwhile); onerror/onclose drives the reconnect.
        this.sendQueue = queued.slice(i).concat(this.sendQueue);
        break;
      }
    }
    this.startHeartbeat();
    if (wasReconnect) {
      void this.runReplay();
    }
  }

  private handleSocketClose(sock: WebSocketLike, ev?: { code?: number; reason?: string }): void {
    if (this.socket !== sock) return;
    this.socket = null;
    this.stopHeartbeat();
    if (this.closeRequested) {
      this.setStatus('closed');
      return;
    }
    const code = ev?.code;
    if (code !== undefined && this.rejectsRetry(code)) {
      this.failTerminally(code, ev?.reason);
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * Whether this close code means "stop trying". 4403/4404 are permanent for
   * any credentials. 4401 buys exactly ONE more attempt — the app rotates its
   * access token on the 'reconnecting' transition, so the retry can genuinely
   * succeed — and is terminal if the fresh token is refused too.
   */
  private rejectsRetry(code: number): boolean {
    if (isPermanentCloseCode(code)) return true;
    if (code !== CLOSE_UNAUTHORIZED) return false;
    if (this.authRetryUsed) return true;
    this.authRetryUsed = true;
    return false;
  }

  /**
   * Ends the session for good: no reconnect, no further heartbeats. The send
   * queue is kept — a later connect() with working credentials still owes the
   * user those envelopes.
   */
  private failTerminally(code: number, reason?: string): void {
    this.closeRequested = true;
    this.cancelReconnect();
    this.stopHeartbeat();
    this.replayRetryCancel?.();
    const text =
      reason !== undefined && reason !== ''
        ? reason
        : (CLOSE_FALLBACK_REASON[code] ?? 'the room refused this connection');
    const info: SocketCloseInfo = { code, reason: text };
    this.closeInfoValue = info;
    this.setStatus('closed');
    try {
      this.onTerminalClose?.(info);
    } catch {
      // A bad callback must not break the pipeline.
    }
  }

  private scheduleReconnect(): void {
    const n = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const raw = Math.min(this.backoffMaxMs, this.backoffBaseMs * this.backoffFactor ** n);
    const delay = Math.floor(raw * (0.5 + 0.5 * this.rng()));
    this.setStatus('reconnecting');
    this.reconnectHandle = this.setTimeoutFn(() => {
      this.reconnectHandle = null;
      if (this.closeRequested) return;
      this.openSocket(true);
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const tick = () => {
      if (this.statusValue !== 'open' || this.socket === null || this.currentRoomId === null) {
        return;
      }
      if (this.missedPongs >= this.maxMissedPongs) {
        // Half-open socket: pings keep leaving, no pong ever comes back and
        // the transport reports nothing — without this the UI says 'Live'
        // forever. Bounce it and let the normal backoff reconnect.
        this.forceReconnect();
        return;
      }
      const envelope = {
        type: 'clock.ping',
        roomId: this.currentRoomId,
        seq: 0,
        ts: this.now(),
        payload: { clientTs: this.now() },
      };
      try {
        this.socket.send(JSON.stringify(envelope));
        this.missedPongs += 1;
      } catch {
        // A broken socket surfaces via onerror/onclose.
      }
      this.heartbeatHandle = this.setTimeoutFn(tick, this.heartbeatMs);
    };
    // The first ping leaves NOW, not one heartbeat from now. Until a pong lands
    // the clock estimator has no offset at all, and every position the app
    // projects meanwhile is computed against a placeholder of 0 — which the
    // drift controller then "corrects". Waiting `heartbeatMs` spent that blind
    // window on every join AND every reconnect.
    //
    // Safe to call inline: the only caller is handleOpen, which has already set
    // status 'open' and cleared missedPongs, so this ping starts the streak at 1
    // and re-arms exactly one timer (stopHeartbeat above guarantees there is no
    // second chain). If an onStatus handler closed the socket underneath us, the
    // guard inside tick catches it and nothing is sent or armed.
    tick();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.clearTimeoutFn(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  /**
   * Drops a socket the watchdog declared dead and reconnects. The reference is
   * cleared BEFORE closing so the close callbacks (which see a stale `sock`)
   * cannot schedule a second reconnect.
   */
  private forceReconnect(): void {
    const sock = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    this.missedPongs = 0;
    if (sock !== null) {
      try {
        sock.close();
      } catch {
        // Ignore errors from an already-broken socket.
      }
    }
    this.scheduleReconnect();
  }

  private handleMessage(ev: { data: unknown }): void {
    if (typeof ev.data !== 'string') return;
    let raw: unknown;
    try {
      raw = JSON.parse(ev.data);
    } catch {
      return;
    }
    const parsed = ServerEvent.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    // A misrouted frame from another room must never reach the seq tracker:
    // one foreign high seq would poison gap detection for the whole session.
    if (this.currentRoomId === null || event.roomId !== this.currentRoomId) return;
    if (event.type === 'clock.pong') {
      // Any pong proves the socket is two-way alive — a slow connection must
      // never trip the watchdog, so this resets the whole streak.
      this.missedPongs = 0;
      this.clock.addSample({
        clientSendTs: event.payload.clientTs,
        serverTs: event.payload.serverTs,
        clientRecvTs: this.now(),
      });
    }
    if (event.seq > 0 && this.replaying) {
      this.buffer.push(event);
      return;
    }
    const cls = this.tracker.classify(event.seq);
    if (cls === 'ephemeral') {
      this.emit(event);
    } else if (cls === 'next') {
      this.tracker.advance(event.seq);
      this.emit(event);
    } else if (cls === 'gap') {
      this.buffer.push(event);
      void this.runReplay();
    }
    // 'duplicate' events are dropped silently.
  }

  /**
   * Backfills from the last contiguous seq, then drains the buffer. Replays
   * never run concurrently. A failing replayFetch is retried with linear
   * backoff (buffer and tracker untouched, so nothing is lost while the
   * endpoint recovers); only once every attempt is exhausted does the buffer
   * flush leniently — after surfacing the loss via onGapLoss.
   */
  private async runReplay(): Promise<void> {
    if (this.replaying) return;
    const roomId = this.currentRoomId;
    if (roomId === null) return;
    this.replaying = true;
    try {
      let failedAttempts = 0;
      for (;;) {
        const seqBefore = this.tracker.lastSeq;
        let envelopes: WsEnvelope[];
        try {
          envelopes = await this.replayFetch(roomId, this.tracker.lastSeq);
          failedAttempts = 0;
        } catch {
          failedAttempts += 1;
          if (failedAttempts >= this.replayRetryAttempts) {
            const sinceSeq = this.tracker.lastSeq;
            try {
              this.onGapLoss?.({ roomId, sinceSeq });
            } catch {
              // A bad callback must not break the pipeline.
            }
            this.flushBufferLenient();
            return;
          }
          await this.replaySleep(this.replayRetryDelayMs * failedAttempts);
          if (this.closeRequested || this.currentRoomId !== roomId) return;
          continue;
        }
        if (this.closeRequested || this.currentRoomId !== roomId) return;
        const sorted = [...envelopes].sort((a, b) => a.seq - b.seq);
        for (const env of sorted) {
          const parsed = ServerEvent.safeParse(env);
          if (!parsed.success) continue;
          const event = parsed.data;
          if (event.roomId !== roomId) continue;
          if (event.seq <= this.tracker.lastSeq) continue;
          this.tracker.advance(event.seq);
          this.emit(event);
        }
        if (!this.flushBufferStrict()) return;
        if (this.tracker.lastSeq === seqBefore) {
          // The store made no progress (missing seqs are gone, e.g. compacted
          // history): the gap is unrecoverable, not transient — surface it.
          const sinceSeq = this.tracker.lastSeq;
          try {
            this.onGapLoss?.({ roomId, sinceSeq });
          } catch {
            // A bad callback must not break the pipeline.
          }
          this.flushBufferLenient();
          return;
        }
      }
    } finally {
      this.replaying = false;
      if (!this.closeRequested && this.currentRoomId === roomId && this.buffer.length > 0) {
        void this.runReplay();
      }
    }
  }

  /** Cancellable retry sleep; close() resolves it immediately via replayRetryCancel. */
  private replaySleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.setTimeoutFn(() => {
        this.replayRetryCancel = null;
        resolve();
      }, ms);
      this.replayRetryCancel = () => {
        this.replayRetryCancel = null;
        this.clearTimeoutFn(handle);
        resolve();
      };
    });
  }

  /**
   * Drains the buffer in ascending seq order advancing past gaps. Used when
   * strict backfill cannot make progress (replay failure or a store that no
   * longer holds the missing seqs) — availability over strict ordering.
   */
  private flushBufferLenient(): void {
    const buffered = this.buffer;
    this.buffer = [];
    buffered.sort((a, b) => a.seq - b.seq);
    for (const event of buffered) {
      if (event.seq !== 0 && event.seq <= this.tracker.lastSeq) continue;
      this.tracker.advance(event.seq);
      this.emit(event);
    }
  }

  /**
   * Emits buffered events in ascending seq order while they remain
   * contiguous. Returns true when a gap still remains in the buffer.
   */
  private flushBufferStrict(): boolean {
    this.buffer.sort((a, b) => a.seq - b.seq);
    const remaining: ServerEvent[] = [];
    let gap = false;
    for (const event of this.buffer) {
      const cls = this.tracker.classify(event.seq);
      if (cls === 'duplicate') continue;
      if (cls === 'ephemeral') {
        this.emit(event);
      } else if (cls === 'next') {
        this.tracker.advance(event.seq);
        this.emit(event);
      } else {
        remaining.push(event);
        gap = true;
      }
    }
    this.buffer = remaining;
    return gap;
  }

  private emit(event: ServerEvent): void {
    const set = this.typedHandlers.get(event.type);
    if (set !== undefined) {
      for (const handler of [...set]) {
        try {
          handler(event);
        } catch {
          // A bad handler must not break the pipeline.
        }
      }
    }
    for (const handler of [...this.anyHandlers]) {
      try {
        handler(event);
      } catch {
        // A bad handler must not break the pipeline.
      }
    }
  }

  private setStatus(status: SocketStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const handler of [...this.statusHandlers]) {
      try {
        handler(status);
      } catch {
        // A bad handler must not break the pipeline.
      }
    }
  }
}
