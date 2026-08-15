import { ApiError, RoomSocket } from '@playin/api-client';
import type {
  ClockEstimator,
  RoomSocketOptions,
  SocketStatus,
} from '@playin/api-client';
import type { ClientEvent, RoomId, ServerEvent } from '@playin/contracts';
import type { RestClient } from '@playin/api-client';
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
}

/**
 * The web client's realtime core: exactly ONE instance per room, created by
 * the room shell's RoomProvider and shared by every pane through
 * `@/lib/room-context`.
 *
 * It wraps `@playin/api-client`'s RoomSocket (heartbeat clock sync, seq
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

  private readonly api: RestClient;
  private readonly roomIdValue: RoomId;
  private readonly getToken: () => Promise<string | null>;
  private readonly initialSeq: number | undefined;
  private readonly socket: RoomSocket;
  private activeToken: string | null = null;
  private closedIntentionally = false;
  private tokenRefreshInFlight = false;

  constructor(opts: RoomConnectionOptions) {
    this.api = opts.api;
    this.roomIdValue = opts.roomId;
    this.getToken = opts.getToken ?? ensureAccessToken;
    this.initialSeq = opts.initialSeq;
    this.useStatus = create<ConnectionStatus>()(() => 'connecting');
    this.useLastSeq = create<number>()(() => opts.initialSeq ?? 0);

    this.socket = new RoomSocket(opts.wsBaseUrl ?? WS_URL, {
      ...opts.socketOptions,
      replayFetch: (roomId, sinceSeq) =>
        this.api.events.replay(roomId, sinceSeq).then((res) => res.events),
      onGapLoss: (info) => {
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
