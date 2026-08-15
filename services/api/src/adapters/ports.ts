/**
 * Storage + bus ports for the Playin API. FROZEN SEAM — module workers and
 * both adapter pairs (Mongo/Memory, Redis/Memory) implement or consume these
 * interfaces; do not change shapes without an orchestrator-level decision.
 *
 * The query DSL is a portable subset of MongoDB's: MongoStore passes filters
 * through nearly verbatim (id → _id); MemoryStore interprets them. Keep every
 * filter inside this subset so both adapters stay equivalent.
 */
import type {
  Invite,
  MediaAsset,
  Member,
  Message,
  PlaybackState,
  Playlist,
  QueueItem,
  ReportTarget,
  RestreamState,
  Room,
  User,
} from '@playin/contracts';

// ── Query DSL ────────────────────────────────────────────────────────────────

/** Comparison operators. An object literal counts as an ops object only when
 *  EVERY key starts with '$'; anything else is matched as a literal value. */
export interface FilterOps<V> {
  $eq?: V;
  $ne?: V;
  $lt?: V;
  $lte?: V;
  $gt?: V;
  $gte?: V;
  $in?: readonly V[];
  $nin?: readonly V[];
  $exists?: boolean;
}

/** Top-level-field filter; all listed fields must match (implicit AND). */
export type Filter<T> = { [K in keyof T & string]?: T[K] | FilterOps<T[K]> };

export type SortSpec<T> = ReadonlyArray<readonly [keyof T & string, 1 | -1]>;

export interface FindOptions<T> {
  sort?: SortSpec<T>;
  limit?: number;
  skip?: number;
}

/**
 * One document collection. `id` is the primary key (unique in every
 * collection; MongoStore maps it to `_id`).
 *
 * Semantics both adapters MUST honor:
 * - insertOne throws AppError('CONFLICT') on any unique-index violation
 *   (see UNIQUE_INDEXES) including duplicate id.
 * - updateOne/updateMany apply a shallow $set-style merge of `patch`
 *   (top-level fields only; no unset). updateOne returns the updated doc or
 *   null when nothing matched. A patch that would violate a unique index
 *   throws AppError('CONFLICT').
 * - Multi-step read-modify-write is NOT transactional; callers needing
 *   atomicity must design around single-doc updates or nextSeq().
 */
export interface DocCollection<T extends { id: string }> {
  findById(id: string): Promise<T | null>;
  findOne(filter: Filter<T>): Promise<T | null>;
  findMany(filter: Filter<T>, opts?: FindOptions<T>): Promise<T[]>;
  count(filter: Filter<T>): Promise<number>;
  insertOne(doc: T): Promise<T>;
  updateOne(filter: Filter<T>, patch: Partial<T>): Promise<T | null>;
  updateMany(filter: Filter<T>, patch: Partial<T>): Promise<number>;
  deleteOne(filter: Filter<T>): Promise<boolean>;
  deleteMany(filter: Filter<T>): Promise<number>;
}

// ── Document types (contracts entities + server-only fields) ────────────────

export type UserDoc = User;

/** One signed-in device. Refresh tokens are stored hashed only. */
export interface SessionDoc {
  id: string;
  userId: string;
  device: string;
  createdAt: number;
  lastSeenAt: number;
  /** HMAC-SHA256 of the CURRENT refresh token. */
  refreshHash: string;
  /** Hashes of rotated-out refresh tokens; a match here = token reuse →
   *  the whole session is revoked (theft detection). */
  rotatedHashes: string[];
  revokedAt: number | null;
}

/** Single-use email tokens: magic links and guest-upgrade links. */
export interface AuthTokenDoc {
  id: string;
  kind: 'magic-link' | 'guest-upgrade';
  email: string;
  tokenHash: string;
  /** Guest user to merge into the verified account (guest-upgrade only). */
  upgradeFromUserId: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

/** Room + persisted realtime snapshots (master-election state, last playback
 *  state for late joiners, shared queue, Mode B state). */
export type RoomDoc = Room & {
  playback: PlaybackState | null;
  queue: { items: QueueItem[]; version: number };
  restream: RestreamState | null;
  master: { userId: string; epoch: number } | null;
};

/** id = memberDocId(roomId, userId). `muted` = per-room notification mute. */
export type MemberDoc = Member & { id: string; muted: boolean };

export function memberDocId(roomId: string, userId: string): string {
  return `${roomId}:${userId}`;
}

export type MessageDoc = Message;

/** Persisted server event envelope. id = `${roomId}:${seq}`. */
export interface EventDoc {
  id: string;
  roomId: string;
  seq: number;
  type: string;
  ts: number;
  payload: unknown;
}

export function eventDocId(roomId: string, seq: number): string {
  return `${roomId}:${seq}`;
}

/** id = cursorDocId(roomId, userId, kind). */
export interface CursorDoc {
  id: string;
  roomId: string;
  userId: string;
  kind: 'read' | 'delivered';
  lastSeq: number;
  at: number;
}

export function cursorDocId(
  roomId: string,
  userId: string,
  kind: CursorDoc['kind'],
): string {
  return `${roomId}:${userId}:${kind}`;
}

export type PlaylistDoc = Playlist;

/** Contracts asset + object-storage bookkeeping for the media module. */
export type AssetDoc = MediaAsset & {
  storageKey: string | null;
  uploadId: string | null;
};

/** Billing state per user. id = userId (one subscription per account). */
export interface SubscriptionDoc {
  id: string;
  userId: string;
  plan: 'free' | 'premium';
  status: 'active' | 'past_due' | 'canceled' | 'none';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** ISO datetime, mirrors contracts Subscription.currentPeriodEnd. */
  currentPeriodEnd: string | null;
  updatedAt: number;
  /** Stripe `event.created` (epoch SECONDS) of the last applied webhook —
   *  ordering guard: Stripe does not guarantee delivery order, and a delayed
   *  retry of subscription.updated(active) must not resurrect a canceled
   *  plan. Absent on rows written before this guard existed. */
  lastStripeEventTs?: number;
}

export interface ReportDoc {
  id: string;
  reporterId: string;
  target: ReportTarget;
  reason: string;
  createdAt: number;
  resolvedAt: number | null;
}

/** Metering sample (session-minutes, TURN bytes, getStats aggregates…). */
export interface UsageDoc {
  id: string;
  userId: string;
  roomId: string | null;
  kind: string;
  amount: number;
  unit: string;
  at: number;
  meta: Record<string, unknown> | null;
}

/** id = invite code. Extra invite codes beyond the room's built-in one. */
export type InviteDoc = Invite & { id: string };

/** Web-push / Expo push registration. */
export interface PushSubDoc {
  id: string;
  userId: string;
  platform: 'web' | 'expo';
  /** Web push endpoint URL (web) — unique when present. */
  endpoint: string | null;
  keys: { p256dh: string; auth: string } | null;
  expoPushToken: string | null;
  createdAt: number;
}

// ── Unique indexes (enforced by BOTH adapters) ───────────────────────────────

/**
 * collection → list of unique key tuples. 'sparse' keys skip docs where the
 * field is null. MongoStore ensures these as real indexes on init();
 * MemoryStore enforces them on insert/update.
 */
export const UNIQUE_INDEXES: Record<string, ReadonlyArray<{ keys: readonly string[]; sparse?: boolean }>> = {
  users: [{ keys: ['email'], sparse: true }],
  sessions: [{ keys: ['refreshHash'] }],
  authTokens: [{ keys: ['tokenHash'] }],
  rooms: [{ keys: ['inviteCode'] }],
  members: [{ keys: ['roomId', 'userId'] }],
  events: [{ keys: ['roomId', 'seq'] }],
  cursors: [{ keys: ['roomId', 'userId', 'kind'] }],
  invites: [{ keys: ['code'] }],
  pushSubs: [{ keys: ['endpoint'], sparse: true }, { keys: ['expoPushToken'], sparse: true }],
};

// ── Store port ───────────────────────────────────────────────────────────────

export interface StorePort {
  /** Connect and ensure indexes. Must be called before any other method. */
  init(): Promise<void>;
  close(): Promise<void>;
  /** Backing-store liveness (drives /readyz). */
  ping(): Promise<boolean>;

  readonly users: DocCollection<UserDoc>;
  readonly sessions: DocCollection<SessionDoc>;
  readonly authTokens: DocCollection<AuthTokenDoc>;
  readonly rooms: DocCollection<RoomDoc>;
  readonly members: DocCollection<MemberDoc>;
  readonly invites: DocCollection<InviteDoc>;
  readonly messages: DocCollection<MessageDoc>;
  readonly events: DocCollection<EventDoc>;
  readonly cursors: DocCollection<CursorDoc>;
  readonly playlists: DocCollection<PlaylistDoc>;
  readonly assets: DocCollection<AssetDoc>;
  readonly subscriptions: DocCollection<SubscriptionDoc>;
  readonly reports: DocCollection<ReportDoc>;
  readonly usage: DocCollection<UsageDoc>;
  readonly pushSubs: DocCollection<PushSubDoc>;

  /**
   * Atomic monotonic counter per scope; first call for a scope returns 1.
   * Event seq scope convention: `room:${roomId}`.
   */
  nextSeq(scope: string): Promise<number>;

  /** Full-text message search within a room (Mongo text index; MemoryStore
   *  falls back to case-insensitive substring match). Excludes deleted
   *  messages; newest first. */
  searchMessages(roomId: string, query: string, limit: number): Promise<MessageDoc[]>;
}

// ── Bus port ─────────────────────────────────────────────────────────────────

export type BusHandler = (message: unknown) => void;

/**
 * Cross-instance pub/sub. Delivery is at-most-once, fire-and-forget, and —
 * exactly like Redis pub/sub — the PUBLISHING instance's own subscribers DO
 * receive the message. MemoryBus must mirror that (deliver asynchronously to
 * local subscribers) so single-instance dev behaves like multi-instance prod.
 */
export interface BusPort {
  publish(channel: string, message: unknown): Promise<void>;
  /** Returns an idempotent async unsubscribe. */
  subscribe(channel: string, handler: BusHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Bus channel carrying a room's server events. */
export function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}

/**
 * Message shape published on roomChannel(): a fully-formed ServerEvent
 * envelope plus optional targeting. `targetUserId` set ⇒ deliver only to that
 * user's sockets (WebRTC signaling relay); absent ⇒ broadcast to the room.
 */
export interface RoomBusMessage {
  event: unknown;
  targetUserId: string | null;
}
