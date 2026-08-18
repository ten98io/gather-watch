/**
 * Storage + bus ports for the Gather API. FROZEN SEAM — module workers and
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
  MediaRef,
  Member,
  Message,
  PlaybackState,
  Playlist,
  QueueItem,
  ReportTarget,
  RestreamState,
  Room,
  User,
} from '@gather/contracts';

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

/** Room + persisted realtime snapshots (last playback state for late joiners,
 *  shared queue, Mode B state).
 *
 *  lastActivityAt is SERVER-ONLY (never serialized to clients): the last time
 *  a persisted event was written for this room, throttled to one write per
 *  minute. The idle-room sweeper reads it to find abandoned rooms; it is
 *  optional because rooms stored before it existed do not carry it, and
 *  readers fall back to createdAt. */
export type RoomDoc = Omit<Room, 'hasPassword'> & {
  playback: PlaybackState | null;
  queue: { items: QueueItem[]; version: number };
  restream: RestreamState | null;
  lastActivityAt?: number;
  /** scrypt `salt:hash` of the room password, SERVER-ONLY: serializeRoom
   *  reduces it to `hasPassword` before anything crosses the wire. Optional
   *  because rooms stored before passwords existed do not carry it. */
  passwordHash?: string | null;
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

export interface ReportDoc {
  id: string;
  reporterId: string;
  target: ReportTarget;
  reason: string;
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * One thing a room played, in the room's own history.
 *
 * WHY THIS IS NOT A `usage` ROW. The sync module already writes a
 * `kind: 'playback.history'` sample into `usage`, and reusing it was the
 * cheaper option — but `usage` is a per-USER metering table and this is a
 * per-ROOM feature, and the three differences are not cosmetic:
 *   1. Shape. UsageDoc is (amount, unit, meta) — a title, artwork and the
 *      person who queued the item would live in an untyped `meta` blob, so
 *      every read would have to defensively re-parse it and drop rows it
 *      cannot understand. compliance/export.ts already does exactly that.
 *      A surface people look at cannot be built on a bag of maybes.
 *   2. Lifecycle. Metering rows are erased per USER (the GDPR purge runs
 *      `usage.deleteMany({ userId })`), which would punch holes in a SHARED
 *      room timeline everyone else can see; room history is erased with the
 *      ROOM, alongside its messages and events.
 *   3. Retention. `usage` grows for as long as an account exists. A room's
 *      history is capped per room (HISTORY_KEEP_PER_ROOM) — a feature people
 *      scroll has to have a bottom.
 * The `usage` row stays exactly as it was: it feeds the GDPR export, which is
 * a different question asked by a different person about a different scope.
 */
export interface PlaybackHistoryDoc {
  id: string;
  roomId: string;
  /** Per-room monotonic counter (`store.nextSeq('history:<roomId>')`), so the
   *  order and the page cursor survive two tracks starting in the same ms. */
  seq: number;
  mediaRef: MediaRef;
  title: string;
  artworkUrl: string | null;
  durationMs: number | null;
  /** Who put it in the queue; the person who started it when there was no
   *  queue row. */
  queuedBy: string;
  startedBy: string;
  playedAt: number;
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
 * One unique index over `keys`.
 *
 * `partialOnString` marks an index that must apply only to the rows that
 * actually HAVE a value, and it exists because Mongo's `sparse` does not mean
 * that. A sparse index omits a document only when the field is ABSENT; a field
 * that is present and holds BSON null IS indexed, under the key value null. So
 * a sparse UNIQUE index over a nullable field rejects the SECOND row ever
 * written with an explicit null — and every nullable field indexed here is
 * written exactly that way: `email: null` for every guest and every erased
 * account, `endpoint: null` for every expo push row, `expoPushToken: null` for
 * every web push row. On a fresh database that is a 409 for guest number two,
 * forever.
 *
 * A PARTIAL index filtered to `{ $type: 'string' }` is the construct that
 * actually means "unique among the rows that have a value": absent and null
 * both fall outside the filter, so neither is indexed and neither can collide.
 *
 * Single key only, by type. A compound partial index would have to answer what
 * happens when one key holds a string and another does not, and no index here
 * wants that question asked — so the type refuses to express it.
 */
export type UniqueIndexSpec =
  | { readonly keys: readonly string[]; readonly partialOnString?: undefined }
  | { readonly keys: readonly [string]; readonly partialOnString: true };

/** Keys of `Doc` that may hold null, or be absent entirely. */
type NullishKeyOf<Doc> = {
  [K in keyof Doc & string]-?: null extends Doc[K] ? K : undefined extends Doc[K] ? K : never;
}[keyof Doc & string];

/** Keys of `Doc` that ALWAYS hold a value. Only these are safe unfiltered. */
type TotalKeyOf<Doc> = Exclude<keyof Doc & string, NullishKeyOf<Doc>>;

/**
 * The unique indexes one collection may declare, checked against its document
 * type — so the bug this file exists to prevent cannot be DECLARED again, only
 * fixed once.
 *
 * A plain index may cover TOTAL fields only. Mongo indexes an absent-or-null
 * field under the key value null, so a nullable field under a plain unique
 * index rejects the second row that has no value. Nullable fields have to go
 * through `partialOnString`, which is why that arm accepts any key.
 *
 * Adding `{ keys: ['endpoint'] }` to pushSubs is now a type error at this
 * declaration rather than a 409 in production.
 */
export type UniqueIndexSpecFor<Doc> =
  | { readonly keys: ReadonlyArray<TotalKeyOf<Doc>>; readonly partialOnString?: undefined }
  | { readonly keys: readonly [keyof Doc & string]; readonly partialOnString: true };

/** Collections with no unique index beyond `id` simply have no entry; the
 *  index signature is what lets callers look one up by name. */
interface UniqueIndexTable {
  readonly users: ReadonlyArray<UniqueIndexSpecFor<UserDoc>>;
  readonly sessions: ReadonlyArray<UniqueIndexSpecFor<SessionDoc>>;
  readonly authTokens: ReadonlyArray<UniqueIndexSpecFor<AuthTokenDoc>>;
  readonly rooms: ReadonlyArray<UniqueIndexSpecFor<RoomDoc>>;
  readonly members: ReadonlyArray<UniqueIndexSpecFor<MemberDoc>>;
  readonly events: ReadonlyArray<UniqueIndexSpecFor<EventDoc>>;
  readonly playbackHistory: ReadonlyArray<UniqueIndexSpecFor<PlaybackHistoryDoc>>;
  readonly cursors: ReadonlyArray<UniqueIndexSpecFor<CursorDoc>>;
  readonly invites: ReadonlyArray<UniqueIndexSpecFor<InviteDoc>>;
  readonly pushSubs: ReadonlyArray<UniqueIndexSpecFor<PushSubDoc>>;
  readonly [collection: string]: ReadonlyArray<UniqueIndexSpec>;
}

/**
 * collection → its unique indexes. MongoStore ensures these as real indexes on
 * init(); MemoryStore enforces them on insert/update. Both read them through
 * indexKeyOf(), so there is one rule rather than two that drifted.
 */
export const UNIQUE_INDEXES: UniqueIndexTable = {
  users: [{ keys: ['email'], partialOnString: true }],
  sessions: [{ keys: ['refreshHash'] }],
  authTokens: [{ keys: ['tokenHash'] }],
  rooms: [{ keys: ['inviteCode'] }],
  members: [{ keys: ['roomId', 'userId'] }],
  events: [{ keys: ['roomId', 'seq'] }],
  playbackHistory: [{ keys: ['roomId', 'seq'] }],
  cursors: [{ keys: ['roomId', 'userId', 'kind'] }],
  invites: [{ keys: ['code'] }],
  pushSubs: [
    { keys: ['endpoint'], partialOnString: true },
    { keys: ['expoPushToken'], partialOnString: true },
  ],
};

/**
 * The key tuple `record` contributes to `spec`'s index, or null when the
 * document has NO entry in that index and so cannot collide with anything.
 * This is MongoDB's key-extraction rule written down once:
 *
 *   • partialOnString — indexed only while the field HOLDS A STRING. Absent,
 *     null and any non-string value fall outside the partialFilterExpression
 *     and produce no entry at all. An EMPTY string is a string: two rows
 *     holding '' do collide.
 *   • plain unique — every document is indexed, and an ABSENT field is indexed
 *     as null. Mongo does not distinguish "missing" from "explicitly null" in
 *     an index key, so two documents differing only that way DO collide.
 */
export function indexKeyOf(
  spec: UniqueIndexSpec,
  record: Readonly<Record<string, unknown>>,
): readonly unknown[] | null {
  if (spec.partialOnString === true) {
    const value = record[spec.keys[0]];
    return typeof value === 'string' ? [value] : null;
  }
  return spec.keys.map((key) => (record[key] === undefined ? null : record[key]));
}

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
  readonly playbackHistory: DocCollection<PlaybackHistoryDoc>;
  readonly cursors: DocCollection<CursorDoc>;
  readonly playlists: DocCollection<PlaylistDoc>;
  readonly assets: DocCollection<AssetDoc>;
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
  /**
   * Which adapter this actually is. /readyz reports it, and must read it from
   * the BUS rather than from REDIS_URL: buildApp accepts an injected bus, so a
   * mode derived from config can name something this process is not running.
   * 'memory' additionally means "not shared across instances" — whether that
   * is acceptable is a config question, answered in app.ts.
   */
  readonly mode: 'memory' | 'redis';
  publish(channel: string, message: unknown): Promise<void>;
  /** Returns an idempotent async unsubscribe. */
  subscribe(channel: string, handler: BusHandler): Promise<() => Promise<void>>;
  /**
   * Bus liveness (drives /readyz alongside StorePort.ping). MUST always
   * settle — a probe that hangs turns the healthcheck into a hang instead of a
   * failure — and MUST report reachability only. Whether an in-memory bus is
   * an ACCEPTABLE choice is a config question, answered in app.ts.
   */
  ping(): Promise<boolean>;
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
