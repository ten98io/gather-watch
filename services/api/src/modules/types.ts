/**
 * Module plug-in seam. FROZEN — module workers (rooms/chat/sync/rtc/admin…)
 * build against these types and register through src/modules/index.ts with a
 * single additive line; nothing else in the skeleton may be touched.
 */
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ClientEvent, Member, RoomId, ServerEvent, UserId } from '@gather/contracts';
import type { AppConfig } from '../config';
import type { BusPort, StorePort } from '../adapters/ports';

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Verified identity attached to a request/socket by the auth plugin. */
export interface AuthContext {
  userId: UserId;
  sessionId: string;
  /** True for guest (invite-link) identities. */
  guest: boolean;
  /** Guests are room-scoped: the only room their token grants. Null for
   *  full accounts. */
  guestRoomId: RoomId | null;
}

// ── Event typing helpers ─────────────────────────────────────────────────────

export type ServerEventType = ServerEvent['type'];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;
export type ServerPayloadOf<T extends ServerEventType> = ServerEventOf<T>['payload'];

export type ClientEventType = ClientEvent['type'];
export type ClientEventOf<T extends ClientEventType> = Extract<ClientEvent, { type: T }>;

// ── Event writer (implemented in src/ws/events.ts) ──────────────────────────

export interface EventWriter {
  /**
   * Persist + fan out: assigns the room's next monotonic seq (store.nextSeq),
   * writes the envelope to the events collection, publishes on the room bus
   * channel (which delivers to local sockets too). Per-room emits are
   * serialized so publish order matches seq order on this instance.
   */
  emit<T extends ServerEventType>(
    roomId: RoomId,
    type: T,
    payload: ServerPayloadOf<T>,
  ): Promise<ServerEventOf<T>>;

  /** Broadcast without persistence; seq 0 (client treats as ephemeral). */
  emitEphemeral<T extends ServerEventType>(
    roomId: RoomId,
    type: T,
    payload: ServerPayloadOf<T>,
  ): void;

  /** Ephemeral, delivered only to `targetUserId`'s sockets (any instance). */
  emitDirect<T extends ServerEventType>(
    roomId: RoomId,
    targetUserId: UserId,
    type: T,
    payload: ServerPayloadOf<T>,
  ): void;
}

// ── Hub surface exposed to modules ───────────────────────────────────────────

export interface HubApi {
  /** Merge a module's wsHandlers; throws on duplicate event type. */
  registerModule(mod: ModulePlugin): void;
  /** Distinct userIds with ≥1 open socket in the room on THIS instance. */
  localUserIds(roomId: RoomId): UserId[];
  localConnectionCount(roomId: RoomId): number;
  /** Instance-local live gauges (ops/admin surface). */
  stats(): { connections: number; rooms: number };
  /** Close every socket this user has in the room on THIS instance
   *  (kick/ban flows must also revoke membership via the store). */
  disconnectUser(roomId: RoomId, userId: UserId, code?: number, reason?: string): void;
  /** Close every socket carrying this session on THIS instance — session
   *  revocation (logout / sign-out-everywhere / refresh-reuse) must not
   *  leave a compromised device with live realtime access. Other instances
   *  converge via the hub sweep's session re-validation. */
  disconnectSession(sessionId: string, code?: number, reason?: string): void;
}

// ── Shared dependencies ──────────────────────────────────────────────────────

export interface Deps {
  config: AppConfig;
  log: FastifyBaseLogger;
  store: StorePort;
  bus: BusPort;
  events: EventWriter;
  hub: HubApi;
}

// ── WS handler registry ──────────────────────────────────────────────────────

/** Per-event context handed to module WS handlers. */
export interface HandlerContext {
  deps: Deps;
  roomId: RoomId;
  auth: AuthContext;
  /** Membership row at connect time (role checks re-read the store when it
   *  matters — roles can change mid-connection). */
  member: Member;
  /** Send an ephemeral (seq 0) event to THIS socket only. */
  reply<T extends ServerEventType>(type: T, payload: ServerPayloadOf<T>): void;
}

export type WsHandler<T extends ClientEventType = ClientEventType> = (
  event: ClientEventOf<T>,
  ctx: HandlerContext,
) => void | Promise<void>;

export type HandlerMap = { [T in ClientEventType]?: WsHandler<T> };

// ── Module plug-in ───────────────────────────────────────────────────────────

/**
 * One feature module. `routes` is registered on the Fastify app (deps are on
 * `app.deps`, verified identity on `request.auth`); `wsHandlers` are merged
 * into the hub's dispatch registry. Handler errors (AppError or thrown) are
 * mapped to an ephemeral `error` event on the offending socket.
 */
export interface ModulePlugin {
  name: string;
  routes?: FastifyPluginAsync;
  wsHandlers?: HandlerMap;
}

// ── Fastify augmentation ─────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
  interface FastifyRequest {
    /** Set by the auth plugin; null when unauthenticated. */
    auth: AuthContext | null;
  }
}
