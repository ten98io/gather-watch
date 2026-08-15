import { z } from 'zod';
import {
  AccentColor,
  AssetId,
  Entitlements,
  Invite,
  InviteCode,
  MediaAsset,
  Member,
  Message,
  MessageId,
  Playlist,
  PlaylistId,
  QueueItem,
  Room,
  RoomId,
  RoomKind,
  RoomPolicies,
  Session,
  Subscription,
  Timestamp,
  User,
  UserId,
} from './entities';
import { ServerEvent } from './ws';

// ---------- Shared ----------

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Paginated<T> = { items: T[]; nextCursor: string | null };

export const Ok = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof Ok>;

// ---------- auth ----------

export const RequestMagicLinkBody = z.object({ email: z.string().email() });
export type RequestMagicLinkBody = z.infer<typeof RequestMagicLinkBody>;

export const RequestMagicLinkResponse = Ok;
export type RequestMagicLinkResponse = z.infer<typeof RequestMagicLinkResponse>;

export const VerifyTokenBody = z.object({ token: z.string().min(1) });
export type VerifyTokenBody = z.infer<typeof VerifyTokenBody>;

export const VerifyTokenResponse = z.object({ user: User });
export type VerifyTokenResponse = z.infer<typeof VerifyTokenResponse>;

export const RefreshResponse = z.object({ user: User });
export type RefreshResponse = z.infer<typeof RefreshResponse>;

export const MeResponse = z.object({ user: User });
export type MeResponse = z.infer<typeof MeResponse>;

export const UpdateProfileBody = z.object({
  displayName: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  accentColor: AccentColor.optional(),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const UpdateProfileResponse = z.object({ user: User });
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponse>;

export const GuestJoinBody = z.object({
  inviteCode: InviteCode,
  displayName: z.string().min(1).max(80),
});
export type GuestJoinBody = z.infer<typeof GuestJoinBody>;

export const GuestJoinResponse = z.object({
  user: User,
  room: Room,
  member: Member,
  /** Room's current event-stream tip; seed RoomSocket so late joiners
   *  start at the live position instead of gap-replaying full history. */
  lastEventSeq: z.number().int().nonnegative().optional(),
});
export type GuestJoinResponse = z.infer<typeof GuestJoinResponse>;

/** Attach an email to a guest identity: sends a magic link whose verify step
 *  merges the guest user (memberships, messages, read cursors preserved)
 *  into the verified account. */
export const UpgradeGuestBody = z.object({ email: z.string().email() });
export type UpgradeGuestBody = z.infer<typeof UpgradeGuestBody>;

export const UpgradeGuestResponse = Ok;
export type UpgradeGuestResponse = z.infer<typeof UpgradeGuestResponse>;

export const LogoutResponse = Ok;
export type LogoutResponse = z.infer<typeof LogoutResponse>;

export const ListSessionsResponse = z.object({ sessions: z.array(Session) });
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;

/** "Sign out everywhere": revokes every session except the current one. */
export const RevokeAllSessionsResponse = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeAllSessionsResponse = z.infer<typeof RevokeAllSessionsResponse>;

// ---------- rooms ----------

export const CreateRoomBody = z.object({ kind: RoomKind, name: z.string().min(1).max(120) });
export type CreateRoomBody = z.infer<typeof CreateRoomBody>;

export const CreateRoomResponse = z.object({ room: Room });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

export const GetRoomResponse = z.object({
  room: Room,
  member: Member,
  /** Room's current event-stream tip; seed RoomSocket connect(initialSeq)
   *  so joiners subscribe at the live position (no full-history replay). */
  lastEventSeq: z.number().int().nonnegative().optional(),
});
export type GetRoomResponse = z.infer<typeof GetRoomResponse>;

export const ListMyRoomsResponse = z.object({
  rooms: z.array(
    z.object({
      room: Room,
      unreadCount: z.number().int().nonnegative(),
      memberCount: z.number().int().nonnegative(),
      /** Per-room notification mute (see rest.push.setRoomMute). */
      muted: z.boolean().default(false),
    }),
  ),
});
export type ListMyRoomsResponse = z.infer<typeof ListMyRoomsResponse>;

export const JoinRoomBody = z.object({ inviteCode: InviteCode });
export type JoinRoomBody = z.infer<typeof JoinRoomBody>;

export const JoinRoomResponse = z.object({
  room: Room,
  member: Member,
  /** See GetRoomResponse.lastEventSeq. */
  lastEventSeq: z.number().int().nonnegative().optional(),
});
export type JoinRoomResponse = z.infer<typeof JoinRoomResponse>;

export const LeaveRoomResponse = Ok;
export type LeaveRoomResponse = z.infer<typeof LeaveRoomResponse>;

export const ListMembersResponse = z.object({
  members: z.array(z.object({ member: Member, user: User })),
});
export type ListMembersResponse = z.infer<typeof ListMembersResponse>;

export const UpdatePoliciesBody = RoomPolicies.partial();
export type UpdatePoliciesBody = z.infer<typeof UpdatePoliciesBody>;

export const UpdatePoliciesResponse = z.object({ room: Room });
export type UpdatePoliciesResponse = z.infer<typeof UpdatePoliciesResponse>;

export const TransferHostBody = z.object({ toUserId: UserId });
export type TransferHostBody = z.infer<typeof TransferHostBody>;

export const TransferHostResponse = Ok;
export type TransferHostResponse = z.infer<typeof TransferHostResponse>;

/** Promote/demote between moderator and member (host only). Host is assigned
 *  via transferHost; guests upgrade via rest.auth.upgradeGuest. */
export const SetMemberRoleBody = z.object({
  userId: UserId,
  role: z.enum(['moderator', 'member']),
});
export type SetMemberRoleBody = z.infer<typeof SetMemberRoleBody>;

export const SetMemberRoleResponse = z.object({ member: Member });
export type SetMemberRoleResponse = z.infer<typeof SetMemberRoleResponse>;

export const KickMemberBody = z.object({ userId: UserId });
export type KickMemberBody = z.infer<typeof KickMemberBody>;

export const KickMemberResponse = Ok;
export type KickMemberResponse = z.infer<typeof KickMemberResponse>;

export const BanMemberBody = z.object({ userId: UserId, banned: z.boolean() });
export type BanMemberBody = z.infer<typeof BanMemberBody>;

export const BanMemberResponse = Ok;
export type BanMemberResponse = z.infer<typeof BanMemberResponse>;

export const CreateInviteBody = z.object({ expiresAt: Timestamp.nullable().optional() });
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

export const CreateInviteResponse = z.object({ invite: Invite });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

/** Toggle the room's theater layout (host/mods). */
export const SetTheaterBody = z.object({ enabled: z.boolean() });
export type SetTheaterBody = z.infer<typeof SetTheaterBody>;

export const SetTheaterResponse = z.object({ room: Room });
export type SetTheaterResponse = z.infer<typeof SetTheaterResponse>;

// ---------- messages ----------

export const ListMessagesQuery = z.object({
  beforeSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListMessagesResponse = paginated(Message);
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

export const SearchMessagesQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchMessagesQuery = z.infer<typeof SearchMessagesQuery>;

export const SearchMessagesResponse = z.object({ items: z.array(Message) });
export type SearchMessagesResponse = z.infer<typeof SearchMessagesResponse>;

export const PinMessageBody = z.object({ messageId: MessageId, pinned: z.boolean() });
export type PinMessageBody = z.infer<typeof PinMessageBody>;

export const PinMessageResponse = z.object({ message: Message });
export type PinMessageResponse = z.infer<typeof PinMessageResponse>;

export const UnfurlBody = z.object({ url: z.string().url() });
export type UnfurlBody = z.infer<typeof UnfurlBody>;

export const UnfurlResponse = z.object({
  url: z.string().url(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  imageUrl: z.string().url().nullable(),
  siteName: z.string().nullable(),
});
export type UnfurlResponse = z.infer<typeof UnfurlResponse>;

// ---------- media ----------

export const CreateUploadBody = z.object({
  filename: z.string().min(1),
  mime: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
export type CreateUploadBody = z.infer<typeof CreateUploadBody>;

/**
 * Multipart upload session. `startByte`/`endByte` (exclusive) are the
 * authoritative byte range for each part. When a server omits them, clients
 * fall back to the documented convention `partSize = ceil(sizeBytes / parts.length)`,
 * part N covering `[(N-1) * partSize, min(sizeBytes, N * partSize))` — servers
 * sizing parts any other way MUST send explicit ranges (S3/MinIO enforce a
 * 5 MiB minimum for all but the last part).
 */
export const CreateUploadResponse = z.object({
  assetId: AssetId,
  uploadId: z.string().min(1),
  parts: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      url: z.string().url(),
      startByte: z.number().int().nonnegative().optional(),
      /** Exclusive end of the part's byte range. */
      endByte: z.number().int().positive().optional(),
    }),
  ),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const CompleteUploadBody = z.object({
  assetId: AssetId,
  uploadId: z.string().min(1),
  parts: z.array(
    z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }),
  ),
});
export type CompleteUploadBody = z.infer<typeof CompleteUploadBody>;

export const CompleteUploadResponse = z.object({ asset: MediaAsset });
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>;

export const ListLibraryQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListLibraryQuery = z.infer<typeof ListLibraryQuery>;

export const ListLibraryResponse = paginated(MediaAsset);
export type ListLibraryResponse = z.infer<typeof ListLibraryResponse>;

export const DeleteAssetResponse = Ok;
export type DeleteAssetResponse = z.infer<typeof DeleteAssetResponse>;

export const RenameAssetBody = z.object({ filename: z.string().min(1) });
export type RenameAssetBody = z.infer<typeof RenameAssetBody>;

export const RenameAssetResponse = z.object({ asset: MediaAsset });
export type RenameAssetResponse = z.infer<typeof RenameAssetResponse>;

// ---------- playlists ----------

export const CreatePlaylistBody = z.object({
  title: z.string().min(1).max(200),
  roomId: RoomId.nullable().optional(),
});
export type CreatePlaylistBody = z.infer<typeof CreatePlaylistBody>;

export const CreatePlaylistResponse = z.object({ playlist: Playlist });
export type CreatePlaylistResponse = z.infer<typeof CreatePlaylistResponse>;

export const UpdatePlaylistBody = z.object({
  title: z.string().min(1).max(200).optional(),
  items: z.array(QueueItem).optional(),
});
export type UpdatePlaylistBody = z.infer<typeof UpdatePlaylistBody>;

export const UpdatePlaylistResponse = z.object({ playlist: Playlist });
export type UpdatePlaylistResponse = z.infer<typeof UpdatePlaylistResponse>;

export const ListPlaylistsResponse = z.object({ playlists: z.array(Playlist) });
export type ListPlaylistsResponse = z.infer<typeof ListPlaylistsResponse>;

export const GetPlaylistResponse = z.object({ playlist: Playlist });
export type GetPlaylistResponse = z.infer<typeof GetPlaylistResponse>;

export const DeletePlaylistResponse = Ok;
export type DeletePlaylistResponse = z.infer<typeof DeletePlaylistResponse>;

export const AddToRoomQueueBody = z.object({ playlistId: PlaylistId, roomId: RoomId });
export type AddToRoomQueueBody = z.infer<typeof AddToRoomQueueBody>;

export const AddToRoomQueueResponse = z.object({ added: z.number().int().nonnegative() });
export type AddToRoomQueueResponse = z.infer<typeof AddToRoomQueueResponse>;

// ---------- events (replay) ----------

export const ReplayEventsQuery = z.object({ since: z.coerce.number().int().nonnegative() });
export type ReplayEventsQuery = z.infer<typeof ReplayEventsQuery>;

/** Replayed events are by definition server events — typed payloads, not
 *  loose WsEnvelopes, so the gap-recovery path stays fully validated. */
export const ReplayEventsResponse = z.object({ events: z.array(ServerEvent) });
export type ReplayEventsResponse = z.infer<typeof ReplayEventsResponse>;

// ---------- livekit ----------

export const LivekitTokenBody = z.object({ roomId: RoomId });
export type LivekitTokenBody = z.infer<typeof LivekitTokenBody>;

export const LivekitTokenResponse = z.object({
  url: z.string().url(),
  token: z.string().min(1),
});
export type LivekitTokenResponse = z.infer<typeof LivekitTokenResponse>;

// ---------- rtc ----------

/** Short-lived TURN credentials; `fairUseRemainingGb` is null when unmetered. */
export const TurnCredentialsResponse = z.object({
  iceServers: z.array(
    z.object({
      urls: z.array(z.string().min(1)),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
  ttlSeconds: z.number().int().nonnegative(),
  fairUseRemainingGb: z.number().finite().nonnegative().nullable(),
});
export type TurnCredentialsResponse = z.infer<typeof TurnCredentialsResponse>;

// ---------- billing ----------

export const CreateCheckoutSessionBody = z.object({ plan: z.literal('premium') });
export type CreateCheckoutSessionBody = z.infer<typeof CreateCheckoutSessionBody>;

export const CreateCheckoutSessionResponse = z.object({ url: z.string().url() });
export type CreateCheckoutSessionResponse = z.infer<typeof CreateCheckoutSessionResponse>;

export const CreatePortalSessionResponse = z.object({ url: z.string().url() });
export type CreatePortalSessionResponse = z.infer<typeof CreatePortalSessionResponse>;

export const GetEntitlementsResponse = z.object({
  entitlements: Entitlements,
  subscription: Subscription,
});
export type GetEntitlementsResponse = z.infer<typeof GetEntitlementsResponse>;

// ---------- push ----------

export const PushSubscribeBody = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('web'),
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
  z.object({ platform: z.literal('expo'), expoPushToken: z.string().min(1) }),
]);
export type PushSubscribeBody = z.infer<typeof PushSubscribeBody>;

export const PushSubscribeResponse = Ok;
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponse>;

export const PushUnsubscribeBody = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('web'), endpoint: z.string().url() }),
  z.object({ platform: z.literal('expo'), expoPushToken: z.string().min(1) }),
]);
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBody>;

export const PushUnsubscribeResponse = Ok;
export type PushUnsubscribeResponse = z.infer<typeof PushUnsubscribeResponse>;

/** Per-room notification mute; muted rooms suppress mention/invite/room-started
 *  pushes. Current state is exposed on ListMyRoomsResponse entries. */
export const SetRoomMuteBody = z.object({ roomId: RoomId, muted: z.boolean() });
export type SetRoomMuteBody = z.infer<typeof SetRoomMuteBody>;

export const SetRoomMuteResponse = Ok;
export type SetRoomMuteResponse = z.infer<typeof SetRoomMuteResponse>;

// ---------- safeguards & compliance ----------

/** Content report target (POST /report). */
export const ReportTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), messageId: MessageId, roomId: RoomId }),
  z.object({ kind: z.literal('user'), userId: UserId }),
  z.object({ kind: z.literal('room'), roomId: RoomId }),
  z.object({ kind: z.literal('asset'), assetId: AssetId }),
]);
export type ReportTarget = z.infer<typeof ReportTarget>;

export const ReportBody = z.object({
  target: ReportTarget,
  reason: z.string().min(1).max(2000),
});
export type ReportBody = z.infer<typeof ReportBody>;

export const ReportResponse = z.object({ ok: z.literal(true), reportId: z.string().min(1) });
export type ReportResponse = z.infer<typeof ReportResponse>;

/** GDPR full JSON export (GET /me/export). */
export const MeExportResponse = z.object({
  exportedAt: Timestamp,
  user: User,
  rooms: z.array(Room),
  messages: z.array(Message),
  playlists: z.array(Playlist),
  assets: z.array(MediaAsset),
});
export type MeExportResponse = z.infer<typeof MeExportResponse>;

/** GDPR account delete (DELETE /me): cascade delete scheduled after a grace
 *  period; `purgeAt` is when the cascade actually executes. */
export const DeleteMeResponse = z.object({ ok: z.literal(true), purgeAt: Timestamp });
export type DeleteMeResponse = z.infer<typeof DeleteMeResponse>;

// ---------- gifs ----------

export const SearchGifsQuery = z.object({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchGifsQuery = z.infer<typeof SearchGifsQuery>;

export const SearchGifsResponse = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1),
      url: z.string().url(),
      previewUrl: z.string().url(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      title: z.string().nullable(),
    }),
  ),
});
export type SearchGifsResponse = z.infer<typeof SearchGifsResponse>;

// ---------- grouped discoverability map ----------

export const rest = {
  auth: {
    requestMagicLink: { body: RequestMagicLinkBody, response: RequestMagicLinkResponse },
    verifyToken: { body: VerifyTokenBody, response: VerifyTokenResponse },
    refresh: { response: RefreshResponse },
    me: { response: MeResponse },
    updateProfile: { body: UpdateProfileBody, response: UpdateProfileResponse },
    guestJoin: { body: GuestJoinBody, response: GuestJoinResponse },
    upgradeGuest: { body: UpgradeGuestBody, response: UpgradeGuestResponse },
    logout: { response: LogoutResponse },
    listSessions: { response: ListSessionsResponse },
    revokeAllSessions: { response: RevokeAllSessionsResponse },
  },
  rooms: {
    createRoom: { body: CreateRoomBody, response: CreateRoomResponse },
    getRoom: { response: GetRoomResponse },
    listMyRooms: { response: ListMyRoomsResponse },
    joinRoom: { body: JoinRoomBody, response: JoinRoomResponse },
    leaveRoom: { response: LeaveRoomResponse },
    listMembers: { response: ListMembersResponse },
    updatePolicies: { body: UpdatePoliciesBody, response: UpdatePoliciesResponse },
    transferHost: { body: TransferHostBody, response: TransferHostResponse },
    setMemberRole: { body: SetMemberRoleBody, response: SetMemberRoleResponse },
    kickMember: { body: KickMemberBody, response: KickMemberResponse },
    banMember: { body: BanMemberBody, response: BanMemberResponse },
    createInvite: { body: CreateInviteBody, response: CreateInviteResponse },
    setTheater: { body: SetTheaterBody, response: SetTheaterResponse },
  },
  messages: {
    listMessages: { query: ListMessagesQuery, response: ListMessagesResponse },
    searchMessages: { query: SearchMessagesQuery, response: SearchMessagesResponse },
    pinMessage: { body: PinMessageBody, response: PinMessageResponse },
    unfurl: { body: UnfurlBody, response: UnfurlResponse },
  },
  media: {
    createUpload: { body: CreateUploadBody, response: CreateUploadResponse },
    completeUpload: { body: CompleteUploadBody, response: CompleteUploadResponse },
    listLibrary: { query: ListLibraryQuery, response: ListLibraryResponse },
    deleteAsset: { response: DeleteAssetResponse },
    renameAsset: { body: RenameAssetBody, response: RenameAssetResponse },
  },
  playlists: {
    createPlaylist: { body: CreatePlaylistBody, response: CreatePlaylistResponse },
    updatePlaylist: { body: UpdatePlaylistBody, response: UpdatePlaylistResponse },
    listPlaylists: { response: ListPlaylistsResponse },
    getPlaylist: { response: GetPlaylistResponse },
    deletePlaylist: { response: DeletePlaylistResponse },
    addToRoomQueue: { body: AddToRoomQueueBody, response: AddToRoomQueueResponse },
  },
  events: {
    replayEvents: { query: ReplayEventsQuery, response: ReplayEventsResponse },
  },
  livekit: {
    livekitToken: { body: LivekitTokenBody, response: LivekitTokenResponse },
  },
  rtc: {
    turnCredentials: { response: TurnCredentialsResponse },
  },
  billing: {
    createCheckoutSession: { body: CreateCheckoutSessionBody, response: CreateCheckoutSessionResponse },
    createPortalSession: { response: CreatePortalSessionResponse },
    getEntitlements: { response: GetEntitlementsResponse },
  },
  push: {
    subscribe: { body: PushSubscribeBody, response: PushSubscribeResponse },
    unsubscribe: { body: PushUnsubscribeBody, response: PushUnsubscribeResponse },
    setRoomMute: { body: SetRoomMuteBody, response: SetRoomMuteResponse },
  },
  gifs: {
    searchGifs: { query: SearchGifsQuery, response: SearchGifsResponse },
  },
  report: {
    createReport: { body: ReportBody, response: ReportResponse },
  },
  gdpr: {
    exportMe: { response: MeExportResponse },
    deleteMe: { response: DeleteMeResponse },
  },
} as const;
