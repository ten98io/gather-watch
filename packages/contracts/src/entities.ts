import { z } from 'zod';

// Branded ids
const brandedId = (min = 1) => z.string().min(min);

export const UserId = brandedId().brand<'UserId'>();
export type UserId = z.infer<typeof UserId>;

export const RoomId = brandedId().brand<'RoomId'>();
export type RoomId = z.infer<typeof RoomId>;

export const MessageId = brandedId().brand<'MessageId'>();
export type MessageId = z.infer<typeof MessageId>;

export const QueueItemId = brandedId().brand<'QueueItemId'>();
export type QueueItemId = z.infer<typeof QueueItemId>;

export const PlaylistId = brandedId().brand<'PlaylistId'>();
export type PlaylistId = z.infer<typeof PlaylistId>;

export const AssetId = brandedId().brand<'AssetId'>();
export type AssetId = z.infer<typeof AssetId>;

export const InviteCode = brandedId().min(4).max(16).brand<'InviteCode'>();
export type InviteCode = z.infer<typeof InviteCode>;

export const SessionId = brandedId().brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

// Epoch milliseconds
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

export const AccentColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export type AccentColor = z.infer<typeof AccentColor>;

export const User = z.object({
  id: UserId,
  email: z.string().email().nullable(), // null for guests
  displayName: z.string().min(1).max(80),
  avatarUrl: z.string().url().nullable(),
  accentColor: AccentColor,
  createdAt: Timestamp,
});
export type User = z.infer<typeof User>;

export const RoomPolicyLevel = z.enum(['host', 'mods', 'everyone']);
export type RoomPolicyLevel = z.infer<typeof RoomPolicyLevel>;

export const RoomPolicies = z.object({
  playbackControl: RoomPolicyLevel,
  queueControl: RoomPolicyLevel,
  chat: RoomPolicyLevel,
  maxPublishers: z.number().int().min(1).max(12),
  waitForAll: z.boolean(),
  /** Fraction of members that must vote to skip before the track is skipped
   *  automatically; 0 disables the auto-skip vote. */
  skipVoteThreshold: z.number().min(0).max(1).default(0.5),
});
export type RoomPolicies = z.infer<typeof RoomPolicies>;

export const RoomKind = z.enum(['watch', 'listen']);
export type RoomKind = z.infer<typeof RoomKind>;

/** Media relay topology for the room's WebRTC calls. */
export const RelayMode = z.enum(['mesh', 'cf-sfu', 'livekit']);
export type RelayMode = z.infer<typeof RelayMode>;

export const Room = z.object({
  id: RoomId,
  kind: RoomKind,
  name: z.string().min(1).max(120),
  inviteCode: InviteCode,
  ownerId: UserId,
  policies: RoomPolicies,
  relayMode: RelayMode.default('mesh'),
  /** Theater layout: stage-focused view with the shared media front and center. */
  theater: z.boolean().default(false),
  createdAt: Timestamp,
});
export type Room = z.infer<typeof Room>;

export const MemberRole = z.enum(['host', 'moderator', 'member', 'guest']);
export type MemberRole = z.infer<typeof MemberRole>;

export const Member = z.object({
  roomId: RoomId,
  userId: UserId,
  role: MemberRole,
  joinedAt: Timestamp,
  banned: z.boolean(),
});
export type Member = z.infer<typeof Member>;

export const MediaRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hls'), assetId: AssetId, url: z.string().url() }),
  z.object({ kind: z.literal('youtube'), videoId: z.string().min(1) }),
  z.object({ kind: z.literal('url'), url: z.string().url(), mime: z.string().min(1) }),
]);
export type MediaRef = z.infer<typeof MediaRef>;

export const PlaybackState = z.object({
  mediaRef: MediaRef.nullable(),
  // finite(): Infinity/NaN from a hostile client must never poison the
  // server-authoritative state that every client's drift math consumes.
  positionMs: z.number().finite().nonnegative(),
  rate: z.number().min(0.25).max(4),
  playing: z.boolean(),
  serverTs: Timestamp,
  seq: z.number().int().nonnegative(),
  queueIndex: z.number().int().nonnegative().nullable(),
});
export type PlaybackState = z.infer<typeof PlaybackState>;

export const QueueItem = z.object({
  id: QueueItemId,
  mediaRef: MediaRef,
  title: z.string().min(1).max(300),
  durationMs: z.number().int().nonnegative().nullable(),
  artworkUrl: z.string().url().nullable(),
  addedBy: UserId,
  votesToSkip: z.array(UserId),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const QueueItemInput = z.object({
  mediaRef: MediaRef,
  title: z.string().min(1).max(300),
  durationMs: z.number().int().nonnegative().nullable(),
  artworkUrl: z.string().url().nullable(),
});
export type QueueItemInput = z.infer<typeof QueueItemInput>;

export const Playlist = z.object({
  id: PlaylistId,
  ownerId: UserId,
  roomId: RoomId.nullable(),
  title: z.string().min(1).max(200),
  items: z.array(QueueItem),
});
export type Playlist = z.infer<typeof Playlist>;

export const MediaAssetStatus = z.enum(['uploading', 'processing', 'ready', 'failed']);
export type MediaAssetStatus = z.infer<typeof MediaAssetStatus>;

export const MediaAsset = z.object({
  id: AssetId,
  ownerId: UserId,
  filename: z.string().min(1),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  status: MediaAssetStatus,
  hlsUrl: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  waveformUrl: z.string().url().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  createdAt: Timestamp,
});
export type MediaAsset = z.infer<typeof MediaAsset>;

export const MessageKind = z.enum(['text', 'gif', 'attachment', 'voice', 'system']);
export type MessageKind = z.infer<typeof MessageKind>;

export const MessageAttachment = z.object({
  assetId: AssetId,
  url: z.string().url(),
  mime: z.string().min(1),
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const Message = z.object({
  id: MessageId,
  roomId: RoomId,
  authorId: UserId,
  kind: MessageKind,
  body: z.string().max(8000),
  gifUrl: z.string().url().nullable(),
  attachment: MessageAttachment.nullable(),
  replyTo: MessageId.nullable(),
  mentions: z.array(UserId),
  reactions: z.record(z.string(), z.array(UserId)), // emoji -> userIds
  pinned: z.boolean(),
  editedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  seq: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const ReadCursor = z.object({
  roomId: RoomId,
  userId: UserId,
  lastReadSeq: z.number().int().nonnegative(),
  at: Timestamp,
});
export type ReadCursor = z.infer<typeof ReadCursor>;

export const DeliveredCursor = z.object({
  roomId: RoomId,
  userId: UserId,
  lastDeliveredSeq: z.number().int().nonnegative(),
  at: Timestamp,
});
export type DeliveredCursor = z.infer<typeof DeliveredCursor>;

export const PresenceState = z.enum(['watching', 'listening', 'in-call', 'away', 'offline']);
export type PresenceState = z.infer<typeof PresenceState>;

export const PresenceEntry = z.object({
  userId: UserId,
  state: PresenceState,
  micOn: z.boolean(),
  camOn: z.boolean(),
  sharing: z.boolean(),
  lastSeenTs: Timestamp,
});
export type PresenceEntry = z.infer<typeof PresenceEntry>;

export const Invite = z.object({
  code: InviteCode,
  roomId: RoomId,
  createdBy: UserId,
  expiresAt: Timestamp.nullable(),
});
export type Invite = z.infer<typeof Invite>;

/** One signed-in device session (multi-device sessions + "sign out everywhere"). */
export const Session = z.object({
  id: SessionId,
  /** Human-readable device label derived from the user agent / platform. */
  device: z.string().min(1).max(200),
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  /** True for the session that made the listSessions request. */
  current: z.boolean(),
});
export type Session = z.infer<typeof Session>;

/** Host uplink health while re-streaming (Mode B). */
export const UplinkQuality = z.enum(['good', 'degraded', 'poor']);
export type UplinkQuality = z.infer<typeof UplinkQuality>;

/**
 * Room-level Mode B (re-stream) state. When `active`, clients render the
 * host's LiveKit screen-share track instead of Mode A mediaRef playback;
 * when inactive they fall back to the current PlaybackState.
 */
export const RestreamState = z.object({
  active: z.boolean(),
  /** Sharing host; null when inactive. */
  hostUserId: UserId.nullable(),
  startedAt: Timestamp.nullable(),
  viewerCount: z.number().int().nonnegative(),
  /** Host uplink quality indicator; null when inactive or unknown. */
  uplinkQuality: UplinkQuality.nullable(),
});
export type RestreamState = z.infer<typeof RestreamState>;

// ---------- billing ----------

export const Plan = z.enum(['free', 'premium']);
export type Plan = z.infer<typeof Plan>;

/** What the account's plan allows; the server enforces these caps. */
export const Entitlements = z.object({
  plan: Plan,
  maxPublishers: z.number().int().nonnegative(),
  maxShareViewers: z.number().int().nonnegative(),
  relayAllowed: z.boolean(),
  /** Monthly TURN relay cap in GB; null when unmetered. */
  turnCapGbMonth: z.number().finite().nonnegative().nullable(),
  uploadQuotaGb: z.number().finite().nonnegative(),
  attachmentMaxMb: z.number().finite().nonnegative(),
});
export type Entitlements = z.infer<typeof Entitlements>;

export const Subscription = z.object({
  status: z.enum(['active', 'past_due', 'canceled', 'none']),
  stripeCustomerId: z.string().min(1).nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
});
export type Subscription = z.infer<typeof Subscription>;
