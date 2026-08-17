import { describe, it, expect } from 'vitest';
import {
  // errors
  ErrorCode,
  ErrorCodes,
  ApiError,
  makeApiError,
  // entities
  User,
  RoomPolicies,
  Room,
  Member,
  MediaRef,
  PlaybackState,
  QueueItem,
  QueueItemInput,
  Playlist,
  MediaAsset,
  MessageAttachment,
  Message,
  ReadCursor,
  DeliveredCursor,
  RelayMode,
  Plan,
  Entitlements,
  Subscription,
  PresenceEntry,
  Invite,
  Session,
  RestreamState,
  // ws
  WsEnvelope,
  IceCandidateInit,
  ClientChatSend,
  ClientChatEdit,
  ClientChatReact,
  ClientChatDelivered,
  ClientSyncSeek,
  ClientSyncRate,
  ClientSyncSetTrack,
  ClientSyncBuffering,
  ClientSyncClaimMaster,
  ClientWebrtcOffer,
  ClientWebrtcAnswer,
  ClientWebrtcIce,
  ClientRestreamHandoff,
  ClientQueueAdd,
  ClientQueueReorder,
  ClientPresenceUpdate,
  ClientEmoteBurst,
  ClientClockPing,
  ClientEvent,
  ServerChatMessage,
  ServerChatDeleted,
  ServerChatDelivered,
  ServerSyncState,
  ServerSyncWaiting,
  ServerSyncMasterChanged,
  ServerWebrtcOffer,
  ServerWebrtcAnswer,
  ServerWebrtcIce,
  ServerRestreamState,
  ServerQueueState,
  ServerPresenceState,
  ServerPresenceDiff,
  ServerEmoteBurst,
  ServerMediaStatus,
  ServerRoomUpdated,
  ServerMemberUpdated,
  ServerClockPong,
  ServerError,
  ServerEvent,
  // rest
  Ok,
  paginated,
  RequestMagicLinkBody,
  VerifyTokenResponse,
  RefreshResponse,
  GuestJoinBody,
  GuestJoinResponse,
  UpgradeGuestBody,
  ListSessionsResponse,
  RevokeSessionResponse,
  RevokeAllSessionsResponse,
  UpdateProfileBody,
  CreateRoomBody,
  GetRoomResponse,
  ListMyRoomsResponse,
  UpdatePoliciesBody,
  SetMemberRoleBody,
  CreateInviteBody,
  SetTheaterBody,
  SetTheaterResponse,
  ListMessagesQuery,
  UnfurlBody,
  CreateUploadBody,
  CreateUploadResponse,
  CompleteUploadBody,
  CreatePlaylistBody,
  AddToRoomQueueBody,
  ReplayEventsQuery,
  ReplayEventsResponse,
  TurnCredentialsResponse,
  CreateCheckoutSessionBody,
  CreateCheckoutSessionResponse,
  CreatePortalSessionResponse,
  GetEntitlementsResponse,
  PushSubscribeBody,
  SetRoomMuteBody,
  ReportBody,
  ReportResponse,
  MeExportResponse,
  DeleteMeResponse,
  SearchGifsQuery,
  SearchGifsResponse,
} from '../src';

const TS = 1755200000000;

// ---------- shared fixtures ----------

const user = {
  id: 'user_1',
  email: 'alice@example.com',
  displayName: 'Alice',
  avatarUrl: 'https://example.com/avatar.png',
  accentColor: '#a1b2c3',
  createdAt: TS,
};

const guestUser = { ...user, id: 'user_guest', email: null, avatarUrl: null };

const policies = {
  playbackControl: 'host',
  queueControl: 'mods',
  chat: 'everyone',
  maxPublishers: 6,
  waitForAll: false,
  skipVoteThreshold: 0.5,
};

const room = {
  id: 'room_1',
  kind: 'watch',
  name: 'Movie Night',
  inviteCode: 'abcd1234',
  ownerId: 'user_1',
  policies,
  relayMode: 'mesh',
  theater: false,
  expiresAt: null,
  createdAt: TS,
};

const member = {
  roomId: 'room_1',
  userId: 'user_1',
  role: 'member',
  joinedAt: TS,
  banned: false,
};

const hlsRef = { kind: 'hls', assetId: 'asset_1', url: 'https://cdn.example.com/v/master.m3u8' };
const youtubeRef = { kind: 'youtube', videoId: 'abc' };
const urlRef = { kind: 'url', url: 'https://cdn.example.com/a.mp3', mime: 'audio/mpeg' };

const playbackState = {
  mediaRef: youtubeRef,
  positionMs: 1234,
  rate: 1,
  playing: true,
  serverTs: TS,
  seq: 3,
  queueIndex: 0,
};

const queueItem = {
  id: 'q_1',
  mediaRef: youtubeRef,
  title: 'Cool video',
  durationMs: 60000,
  artworkUrl: 'https://example.com/art.png',
  addedBy: 'user_1',
  votesToSkip: [],
};

const queueItemInput = {
  mediaRef: youtubeRef,
  title: 'Cool video',
  durationMs: 60000,
  artworkUrl: 'https://example.com/art.png',
};

const playlist = {
  id: 'pl_1',
  ownerId: 'user_1',
  roomId: 'room_1',
  title: 'Favorites',
  items: [queueItem],
};

const assetReady = {
  id: 'asset_1',
  ownerId: 'user_1',
  filename: 'song.mp3',
  mime: 'audio/mpeg',
  sizeBytes: 1024,
  status: 'ready',
  hlsUrl: 'https://cdn.example.com/v/master.m3u8',
  thumbnailUrl: 'https://cdn.example.com/v/thumb.jpg',
  waveformUrl: 'https://cdn.example.com/v/wave.json',
  durationMs: 60000,
  error: null,
  createdAt: TS,
};

const assetFailed = {
  ...assetReady,
  status: 'failed',
  hlsUrl: null,
  thumbnailUrl: null,
  waveformUrl: null,
  durationMs: null,
  error: 'transcode exploded',
};

const attachment = {
  assetId: 'asset_1',
  url: 'https://cdn.example.com/files/pic.png',
  mime: 'image/png',
  name: 'pic.png',
  sizeBytes: 2048,
  width: 640,
  height: 480,
  durationMs: null,
};

const message = {
  id: 'msg_1',
  roomId: 'room_1',
  authorId: 'user_1',
  kind: 'text',
  body: 'hello room',
  gifUrl: null,
  attachment: null,
  replyTo: null,
  mentions: [],
  reactions: {},
  pinned: false,
  editedAt: null,
  deletedAt: null,
  seq: 1,
  createdAt: TS,
};

const readCursor = { roomId: 'room_1', userId: 'user_1', lastReadSeq: 7, at: TS };

const deliveredCursor = { roomId: 'room_1', userId: 'user_1', lastDeliveredSeq: 6, at: TS };

const entitlements = {
  plan: 'premium',
  maxPublishers: 12,
  maxShareViewers: 20,
  relayAllowed: true,
  turnCapGbMonth: 500,
  uploadQuotaGb: 100,
  attachmentMaxMb: 50,
};

const subscription = {
  status: 'active',
  stripeCustomerId: 'cus_123',
  currentPeriodEnd: '2026-09-01T00:00:00.000Z',
};

const presenceEntry = {
  userId: 'user_1',
  state: 'watching',
  micOn: true,
  camOn: false,
  sharing: false,
  lastSeenTs: TS,
};

const invite = { code: 'abcd1234', roomId: 'room_1', createdBy: 'user_1', expiresAt: null };

// envelope bases
const clientEnv = { roomId: 'room_1', seq: 0, ts: TS };
const serverEnv = { roomId: 'room_1', seq: 42, ts: TS };

// ---------- errors ----------

describe('errors', () => {
  it('ErrorCode accepts a known code', () => {
    expect(ErrorCode.parse('UNAUTHORIZED')).toBe('UNAUTHORIZED');
  });

  it('ErrorCode rejects an unknown code', () => {
    expect(ErrorCode.safeParse('NOPE').success).toBe(false);
  });

  it('ErrorCodes maps keys to identical values', () => {
    expect(ErrorCodes.RATE_LIMITED).toBe('RATE_LIMITED');
  });

  it('makeApiError without refType parses and has no refType key', () => {
    const err = makeApiError('VALIDATION', 'bad');
    expect(ApiError.parse(err)).toEqual(err);
    expect('refType' in err).toBe(false);
  });

  it('makeApiError with refType includes it', () => {
    const err = makeApiError('CONFLICT', 'x', 'message');
    expect(ApiError.parse(err)).toEqual({ code: 'CONFLICT', message: 'x', refType: 'message' });
  });
});

// ---------- entities ----------

describe('entities', () => {
  it('User roundtrips', () => {
    expect(User.parse(user)).toEqual(user);
  });

  it('User accepts a guest with email: null', () => {
    expect(User.parse(guestUser)).toEqual(guestUser);
  });

  it('User rejects a bad email', () => {
    expect(User.safeParse({ ...user, email: 'not-an-email' }).success).toBe(false);
  });

  it('RoomPolicies roundtrips', () => {
    expect(RoomPolicies.parse(policies)).toEqual(policies);
  });

  it('RoomPolicies rejects maxPublishers 0', () => {
    expect(RoomPolicies.safeParse({ ...policies, maxPublishers: 0 }).success).toBe(false);
  });

  it('RoomPolicies defaults skipVoteThreshold to 0.5 when missing', () => {
    const { skipVoteThreshold: _omitted, ...withoutThreshold } = policies;
    expect(RoomPolicies.parse(withoutThreshold)).toEqual(policies);
  });

  it('RoomPolicies rejects skipVoteThreshold 1.5 and -0.1', () => {
    expect(RoomPolicies.safeParse({ ...policies, skipVoteThreshold: 1.5 }).success).toBe(false);
    expect(RoomPolicies.safeParse({ ...policies, skipVoteThreshold: -0.1 }).success).toBe(false);
  });

  it('Room roundtrips', () => {
    expect(Room.parse(room)).toEqual(room);
  });

  it('Room defaults relayMode to mesh and theater to false when missing', () => {
    const { relayMode: _relay, theater: _theater, ...withoutDefaults } = room;
    expect(Room.parse(withoutDefaults)).toEqual(room);
  });

  it("Room rejects relayMode 'p2p-magic'", () => {
    expect(Room.safeParse({ ...room, relayMode: 'p2p-magic' }).success).toBe(false);
    // Exactly the two shipped topologies — the deleted self-host third relay
    // must not creep back in (no stored doc ever carried it: rooms are
    // created 'mesh', the theater toggle writes 'cf-sfu').
    expect(RelayMode.options).toEqual(['mesh', 'cf-sfu']);
  });

  it("Room rejects kind 'party'", () => {
    expect(Room.safeParse({ ...room, kind: 'party' }).success).toBe(false);
  });

  it('Room still requires the deprecated kind (stored docs and old clients read it)', () => {
    const { kind: _kind, ...withoutKind } = room;
    expect(Room.safeParse(withoutKind).success).toBe(false);
  });

  it('Member roundtrips', () => {
    expect(Member.parse(member)).toEqual(member);
  });

  it("Member rejects role 'admin'", () => {
    expect(Member.safeParse({ ...member, role: 'admin' }).success).toBe(false);
  });

  it.each([
    ['hls', hlsRef],
    ['youtube', youtubeRef],
    ['url', urlRef],
  ] as const)('MediaRef roundtrips kind %s', (_kind, ref) => {
    expect(MediaRef.parse(ref)).toEqual(ref);
  });

  it("MediaRef rejects unknown kind 'spotify'", () => {
    expect(MediaRef.safeParse({ kind: 'spotify' }).success).toBe(false);
  });

  it('MediaRef rejects hls missing url', () => {
    expect(MediaRef.safeParse({ kind: 'hls', assetId: 'asset_1' }).success).toBe(false);
  });

  it('PlaybackState roundtrips', () => {
    expect(PlaybackState.parse(playbackState)).toEqual(playbackState);
  });

  it('PlaybackState accepts mediaRef: null', () => {
    const idle = { ...playbackState, mediaRef: null, queueIndex: null };
    expect(PlaybackState.parse(idle)).toEqual(idle);
  });

  it('PlaybackState rejects rate 10', () => {
    expect(PlaybackState.safeParse({ ...playbackState, rate: 10 }).success).toBe(false);
  });

  it('PlaybackState rejects positionMs Infinity (adversarial client)', () => {
    expect(PlaybackState.safeParse({ ...playbackState, positionMs: Infinity }).success).toBe(false);
    expect(PlaybackState.safeParse({ ...playbackState, positionMs: NaN }).success).toBe(false);
  });

  it('QueueItem roundtrips', () => {
    expect(QueueItem.parse(queueItem)).toEqual(queueItem);
  });

  it('QueueItem rejects empty title', () => {
    expect(QueueItem.safeParse({ ...queueItem, title: '' }).success).toBe(false);
  });

  it('QueueItemInput roundtrips', () => {
    expect(QueueItemInput.parse(queueItemInput)).toEqual(queueItemInput);
  });

  it('QueueItemInput rejects empty title', () => {
    expect(QueueItemInput.safeParse({ ...queueItemInput, title: '' }).success).toBe(false);
  });

  it('Playlist roundtrips', () => {
    expect(Playlist.parse(playlist)).toEqual(playlist);
  });

  it('Playlist accepts roomId: null', () => {
    const personal = { ...playlist, roomId: null };
    expect(Playlist.parse(personal)).toEqual(personal);
  });

  it("MediaAsset roundtrips status 'ready' with urls", () => {
    expect(MediaAsset.parse(assetReady)).toEqual(assetReady);
  });

  it("MediaAsset roundtrips status 'failed' with error and null urls", () => {
    expect(MediaAsset.parse(assetFailed)).toEqual(assetFailed);
  });

  it("MediaAsset rejects status 'done'", () => {
    expect(MediaAsset.safeParse({ ...assetReady, status: 'done' }).success).toBe(false);
  });

  it('MessageAttachment roundtrips', () => {
    expect(MessageAttachment.parse(attachment)).toEqual(attachment);
  });

  it('MessageAttachment rejects sizeBytes -1', () => {
    expect(MessageAttachment.safeParse({ ...attachment, sizeBytes: -1 }).success).toBe(false);
  });

  it('Message roundtrips a text message with empty reactions', () => {
    expect(Message.parse(message)).toEqual(message);
  });

  it('Message roundtrips with reactions', () => {
    const reacted = { ...message, reactions: { '👍': ['user_1'] } };
    expect(Message.parse(reacted)).toEqual(reacted);
  });

  it('Message rejects negative seq', () => {
    expect(Message.safeParse({ ...message, seq: -1 }).success).toBe(false);
  });

  it('ReadCursor roundtrips', () => {
    expect(ReadCursor.parse(readCursor)).toEqual(readCursor);
  });

  it('ReadCursor rejects negative lastReadSeq', () => {
    expect(ReadCursor.safeParse({ ...readCursor, lastReadSeq: -1 }).success).toBe(false);
  });

  it('DeliveredCursor roundtrips', () => {
    expect(DeliveredCursor.parse(deliveredCursor)).toEqual(deliveredCursor);
  });

  it('DeliveredCursor rejects negative lastDeliveredSeq', () => {
    expect(DeliveredCursor.safeParse({ ...deliveredCursor, lastDeliveredSeq: -1 }).success).toBe(false);
  });

  it("Plan accepts 'free' and 'premium' and rejects 'gold'", () => {
    expect(Plan.parse('free')).toBe('free');
    expect(Plan.parse('premium')).toBe('premium');
    expect(Plan.safeParse('gold').success).toBe(false);
  });

  it('Entitlements roundtrips', () => {
    expect(Entitlements.parse(entitlements)).toEqual(entitlements);
  });

  it('Entitlements accepts turnCapGbMonth: null (unmetered)', () => {
    const unmetered = { ...entitlements, turnCapGbMonth: null };
    expect(Entitlements.parse(unmetered)).toEqual(unmetered);
  });

  it('Entitlements rejects Infinity turnCapGbMonth and negative uploadQuotaGb', () => {
    expect(Entitlements.safeParse({ ...entitlements, turnCapGbMonth: Infinity }).success).toBe(false);
    expect(Entitlements.safeParse({ ...entitlements, uploadQuotaGb: -1 }).success).toBe(false);
    expect(Entitlements.safeParse({ ...entitlements, maxPublishers: 1.5 }).success).toBe(false);
  });

  it('Subscription roundtrips', () => {
    expect(Subscription.parse(subscription)).toEqual(subscription);
  });

  it('Subscription accepts a none status with null fields', () => {
    const none = { status: 'none', stripeCustomerId: null, currentPeriodEnd: null };
    expect(Subscription.parse(none)).toEqual(none);
  });

  it("Subscription rejects status 'trialing' and a non-ISO currentPeriodEnd", () => {
    expect(Subscription.safeParse({ ...subscription, status: 'trialing' }).success).toBe(false);
    expect(Subscription.safeParse({ ...subscription, currentPeriodEnd: 'next tuesday' }).success).toBe(false);
  });

  it('PresenceEntry roundtrips', () => {
    expect(PresenceEntry.parse(presenceEntry)).toEqual(presenceEntry);
  });

  it("PresenceEntry rejects state 'zzz'", () => {
    expect(PresenceEntry.safeParse({ ...presenceEntry, state: 'zzz' }).success).toBe(false);
  });

  it('Invite roundtrips with expiresAt: null', () => {
    expect(Invite.parse(invite)).toEqual(invite);
  });

  it('Invite rejects a too-short code', () => {
    expect(Invite.safeParse({ ...invite, code: 'ab' }).success).toBe(false);
  });

  it('Session roundtrips', () => {
    const session = { id: 'sess_1', device: 'Safari on macOS', createdAt: TS, lastSeenAt: TS, current: true };
    expect(Session.parse(session)).toEqual(session);
  });

  it('RestreamState roundtrips active and inactive', () => {
    const active = { active: true, hostUserId: 'user_1', startedAt: TS, viewerCount: 3, uplinkQuality: 'good' };
    const inactive = { active: false, hostUserId: null, startedAt: null, viewerCount: 0, uplinkQuality: null };
    expect(RestreamState.parse(active)).toEqual(active);
    expect(RestreamState.parse(inactive)).toEqual(inactive);
  });

  it("RestreamState rejects uplinkQuality 'awesome' and negative viewerCount", () => {
    const active = { active: true, hostUserId: 'user_1', startedAt: TS, viewerCount: 3, uplinkQuality: 'good' };
    expect(RestreamState.safeParse({ ...active, uplinkQuality: 'awesome' }).success).toBe(false);
    expect(RestreamState.safeParse({ ...active, viewerCount: -1 }).success).toBe(false);
  });
});

// ---------- ws client ----------

describe('ws client', () => {
  const chatSendPayload = {
    kind: 'text',
    body: 'hi there',
    gifUrl: null,
    attachment: null,
    replyTo: null,
    mentions: [],
  };

  it('ClientEvent accepts a full chat.send envelope with seq 0', () => {
    const evt = { type: 'chat.send', ...clientEnv, payload: chatSendPayload };
    expect(ClientEvent.parse(evt)).toEqual(evt);
  });

  it('chat.* client accepts chat.edit', () => {
    const evt = { type: 'chat.edit', ...clientEnv, payload: { messageId: 'msg_1', body: 'edited' } };
    expect(ClientChatEdit.parse(evt)).toEqual(evt);
  });

  it('chat.* client rejects a bad react op', () => {
    const evt = {
      type: 'chat.react',
      ...clientEnv,
      payload: { messageId: 'msg_1', emoji: '👍', op: 'toggle' },
    };
    expect(ClientChatReact.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent rejects chat.send with seq 5 (client seq must be literal 0)', () => {
    const evt = { type: 'chat.send', roomId: 'room_1', seq: 5, ts: TS, payload: chatSendPayload };
    expect(ClientEvent.safeParse(evt).success).toBe(false);
    expect(ClientChatSend.safeParse(evt).success).toBe(false);
  });

  it("chat.send rejects kind 'system' (server-minted only)", () => {
    const evt = {
      type: 'chat.send',
      ...clientEnv,
      payload: { ...chatSendPayload, kind: 'system' },
    };
    expect(ClientChatSend.safeParse(evt).success).toBe(false);
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });

  it('chat.send rejects an empty text message', () => {
    const evt = {
      type: 'chat.send',
      ...clientEnv,
      payload: { ...chatSendPayload, body: '   ' },
    };
    expect(ClientChatSend.safeParse(evt).success).toBe(false);
  });

  it('chat.send requires gifUrl for kind gif and attachment for kind voice', () => {
    const gifMissing = {
      type: 'chat.send',
      ...clientEnv,
      payload: { ...chatSendPayload, kind: 'gif', body: '' },
    };
    expect(ClientChatSend.safeParse(gifMissing).success).toBe(false);
    const gifOk = {
      type: 'chat.send',
      ...clientEnv,
      payload: { ...chatSendPayload, kind: 'gif', body: '', gifUrl: 'https://media.example.com/x.gif' },
    };
    expect(ClientChatSend.parse(gifOk)).toEqual(gifOk);
    const voiceMissing = {
      type: 'chat.send',
      ...clientEnv,
      payload: { ...chatSendPayload, kind: 'voice', body: '' },
    };
    expect(ClientChatSend.safeParse(voiceMissing).success).toBe(false);
  });

  it('ClientEvent accepts chat.delivered', () => {
    const evt = { type: 'chat.delivered', ...clientEnv, payload: { lastDeliveredSeq: 12 } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientChatDelivered.parse(evt)).toEqual(evt);
  });

  it('chat.delivered client rejects a negative lastDeliveredSeq', () => {
    const evt = { type: 'chat.delivered', ...clientEnv, payload: { lastDeliveredSeq: -1 } };
    expect(ClientChatDelivered.safeParse(evt).success).toBe(false);
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts sync.seek', () => {
    const evt = { type: 'sync.seek', ...clientEnv, payload: { positionMs: 5000 } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientSyncSeek.parse(evt)).toEqual(evt);
  });

  it('sync.* client rejects rate 99', () => {
    const evt = { type: 'sync.rate', ...clientEnv, payload: { rate: 99 } };
    expect(ClientEvent.safeParse(evt).success).toBe(false);
    expect(ClientSyncRate.safeParse(evt).success).toBe(false);
  });

  it('ClientSyncSetTrack accepts the mediaRef branch', () => {
    const evt = { type: 'sync.setTrack', ...clientEnv, payload: { kind: 'media', mediaRef: youtubeRef } };
    expect(ClientSyncSetTrack.parse(evt)).toEqual(evt);
  });

  it('ClientSyncSetTrack accepts the queueIndex branch', () => {
    const evt = { type: 'sync.setTrack', ...clientEnv, payload: { kind: 'queue', queueIndex: 2 } };
    expect(ClientSyncSetTrack.parse(evt)).toEqual(evt);
  });

  it('ClientSyncSetTrack rejects an empty payload', () => {
    const evt = { type: 'sync.setTrack', ...clientEnv, payload: {} };
    expect(ClientSyncSetTrack.safeParse(evt).success).toBe(false);
  });

  it("ClientSyncSetTrack rejects an unknown kind and a queue branch without queueIndex", () => {
    const badKind = { type: 'sync.setTrack', ...clientEnv, payload: { kind: 'media', queueIndex: 2 } };
    expect(ClientSyncSetTrack.safeParse(badKind).success).toBe(false);
    const missingIndex = { type: 'sync.setTrack', ...clientEnv, payload: { kind: 'queue' } };
    expect(ClientSyncSetTrack.safeParse(missingIndex).success).toBe(false);
    expect(ClientEvent.safeParse(missingIndex).success).toBe(false);
  });

  it('sync.seek rejects positionMs Infinity', () => {
    const evt = { type: 'sync.seek', ...clientEnv, payload: { positionMs: Infinity } };
    expect(ClientSyncSeek.safeParse(evt).success).toBe(false);
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts sync.buffering', () => {
    const evt = { type: 'sync.buffering', ...clientEnv, payload: { buffering: true } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientSyncBuffering.parse(evt)).toEqual(evt);
  });

  it('ClientEvent accepts sync.claimMaster', () => {
    const evt = { type: 'sync.claimMaster', ...clientEnv, payload: { epoch: 7 } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientSyncClaimMaster.parse(evt)).toEqual(evt);
  });

  it('sync.claimMaster rejects a negative or non-finite epoch', () => {
    const negative = { type: 'sync.claimMaster', ...clientEnv, payload: { epoch: -1 } };
    expect(ClientSyncClaimMaster.safeParse(negative).success).toBe(false);
    expect(ClientEvent.safeParse(negative).success).toBe(false);
    const infinite = { type: 'sync.claimMaster', ...clientEnv, payload: { epoch: Infinity } };
    expect(ClientSyncClaimMaster.safeParse(infinite).success).toBe(false);
  });

  it('IceCandidateInit roundtrips with nullable fields', () => {
    const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    expect(IceCandidateInit.parse(candidate)).toEqual(candidate);
    const bare = { candidate: '', sdpMid: null, sdpMLineIndex: null };
    expect(IceCandidateInit.parse(bare)).toEqual(bare);
  });

  it('ClientEvent accepts webrtc.offer and webrtc.answer', () => {
    const offer = {
      type: 'webrtc.offer',
      ...clientEnv,
      payload: { targetUserId: 'user_2', connectionId: 'conn_1', sdp: 'v=0 o=...' },
    };
    const answer = {
      type: 'webrtc.answer',
      ...clientEnv,
      payload: { targetUserId: 'user_2', connectionId: 'conn_1', sdp: 'v=0 a=...' },
    };
    expect(ClientEvent.parse(offer)).toEqual(offer);
    expect(ClientWebrtcOffer.parse(offer)).toEqual(offer);
    expect(ClientEvent.parse(answer)).toEqual(answer);
    expect(ClientWebrtcAnswer.parse(answer)).toEqual(answer);
  });

  it('webrtc.offer rejects a missing connectionId', () => {
    const evt = { type: 'webrtc.offer', ...clientEnv, payload: { targetUserId: 'user_2', sdp: 'v=0' } };
    expect(ClientWebrtcOffer.safeParse(evt).success).toBe(false);
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts webrtc.ice with a candidate', () => {
    const evt = {
      type: 'webrtc.ice',
      ...clientEnv,
      payload: {
        targetUserId: 'user_2',
        connectionId: 'conn_1',
        candidate: { candidate: 'candidate:1 ...', sdpMid: '0', sdpMLineIndex: 0 },
      },
    };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientWebrtcIce.parse(evt)).toEqual(evt);
  });

  it('webrtc.ice rejects a missing candidate', () => {
    const evt = {
      type: 'webrtc.ice',
      ...clientEnv,
      payload: { targetUserId: 'user_2', connectionId: 'conn_1' },
    };
    expect(ClientWebrtcIce.safeParse(evt).success).toBe(false);
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts restream.start, restream.stop and restream.handoff', () => {
    const start = { type: 'restream.start', ...clientEnv, payload: {} };
    const stop = { type: 'restream.stop', ...clientEnv, payload: {} };
    const handoff = { type: 'restream.handoff', ...clientEnv, payload: { toUserId: 'user_2' } };
    expect(ClientEvent.parse(start)).toEqual(start);
    expect(ClientEvent.parse(stop)).toEqual(stop);
    expect(ClientEvent.parse(handoff)).toEqual(handoff);
    expect(ClientRestreamHandoff.parse(handoff)).toEqual(handoff);
  });

  it('restream.handoff rejects a missing toUserId', () => {
    const evt = { type: 'restream.handoff', ...clientEnv, payload: {} };
    expect(ClientRestreamHandoff.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts queue.add with a QueueItemInput', () => {
    const evt = { type: 'queue.add', ...clientEnv, payload: { item: queueItemInput } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientQueueAdd.parse(evt)).toEqual(evt);
  });

  it('queue.* client rejects queue.reorder with empty orderedIds', () => {
    const evt = { type: 'queue.reorder', ...clientEnv, payload: { orderedIds: [] } };
    expect(ClientQueueReorder.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts presence.update with only { micOn: true }', () => {
    const evt = { type: 'presence.update', ...clientEnv, payload: { micOn: true } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientPresenceUpdate.parse(evt)).toEqual(evt);
  });

  it('presence.update rejects a bad state', () => {
    const evt = { type: 'presence.update', ...clientEnv, payload: { state: 'floating' } };
    expect(ClientPresenceUpdate.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts emote.burst', () => {
    const evt = { type: 'emote.burst', ...clientEnv, payload: { emoji: '🎉', xPct: 50, yPct: 10 } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientEmoteBurst.parse(evt)).toEqual(evt);
  });

  it('ClientEvent rejects emote.burst with xPct 150', () => {
    const evt = { type: 'emote.burst', ...clientEnv, payload: { emoji: '🎉', xPct: 150, yPct: 10 } };
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });

  it('ClientEvent accepts clock.ping', () => {
    const evt = { type: 'clock.ping', ...clientEnv, payload: { clientTs: TS } };
    expect(ClientEvent.parse(evt)).toEqual(evt);
    expect(ClientClockPing.parse(evt)).toEqual(evt);
  });

  it('clock.ping rejects a negative clientTs', () => {
    const evt = { type: 'clock.ping', ...clientEnv, payload: { clientTs: -1 } };
    expect(ClientClockPing.safeParse(evt).success).toBe(false);
  });

  it("ClientEvent rejects unknown type 'chat.zap'", () => {
    const evt = { type: 'chat.zap', ...clientEnv, payload: {} };
    expect(ClientEvent.safeParse(evt).success).toBe(false);
  });
});

// ---------- ws server ----------

describe('ws server', () => {
  it('ServerEvent accepts chat.message with a full Message payload', () => {
    const evt = { type: 'chat.message', ...serverEnv, payload: message };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerChatMessage.parse(evt)).toEqual(evt);
  });

  it('chat.* server rejects chat.deleted without messageId', () => {
    const evt = { type: 'chat.deleted', ...serverEnv, payload: { deletedAt: TS } };
    expect(ServerChatDeleted.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts sync.state', () => {
    const evt = { type: 'sync.state', ...serverEnv, payload: playbackState };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerSyncState.parse(evt)).toEqual(evt);
  });

  it('ServerEvent rejects sync.state with missing serverTs', () => {
    const { serverTs: _omitted, ...noServerTs } = playbackState;
    const evt = { type: 'sync.state', ...serverEnv, payload: noServerTs };
    expect(ServerEvent.safeParse(evt).success).toBe(false);
    expect(ServerSyncState.safeParse(evt).success).toBe(false);
  });

  it('sync.state rejects positionMs Infinity (server state stays finite)', () => {
    const evt = { type: 'sync.state', ...serverEnv, payload: { ...playbackState, positionMs: Infinity } };
    expect(ServerEvent.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts sync.waiting with a waitingOn list', () => {
    const evt = { type: 'sync.waiting', ...serverEnv, payload: { waitingOn: ['user_1', 'user_2'] } };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerSyncWaiting.parse(evt)).toEqual(evt);
  });

  it('sync.waiting accepts an empty waitingOn (everyone ready)', () => {
    const evt = { type: 'sync.waiting', ...serverEnv, payload: { waitingOn: [] } };
    expect(ServerSyncWaiting.parse(evt)).toEqual(evt);
  });

  it('ServerEvent accepts chat.delivered', () => {
    const evt = {
      type: 'chat.delivered',
      ...serverEnv,
      payload: { userId: 'user_1', lastDeliveredSeq: 12, at: TS },
    };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerChatDelivered.parse(evt)).toEqual(evt);
  });

  it('chat.delivered server rejects a missing at', () => {
    const evt = {
      type: 'chat.delivered',
      ...serverEnv,
      payload: { userId: 'user_1', lastDeliveredSeq: 12 },
    };
    expect(ServerChatDelivered.safeParse(evt).success).toBe(false);
    expect(ServerEvent.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts sync.masterChanged', () => {
    const evt = {
      type: 'sync.masterChanged',
      ...serverEnv,
      payload: { masterUserId: 'user_1', epoch: 7 },
    };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerSyncMasterChanged.parse(evt)).toEqual(evt);
  });

  it('sync.masterChanged rejects a negative epoch', () => {
    const evt = {
      type: 'sync.masterChanged',
      ...serverEnv,
      payload: { masterUserId: 'user_1', epoch: -1 },
    };
    expect(ServerSyncMasterChanged.safeParse(evt).success).toBe(false);
    expect(ServerEvent.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts relayed webrtc.offer/answer/ice with fromUserId', () => {
    const offer = {
      type: 'webrtc.offer',
      ...serverEnv,
      payload: { targetUserId: 'user_2', connectionId: 'conn_1', sdp: 'v=0 o=...', fromUserId: 'user_1' },
    };
    const answer = {
      type: 'webrtc.answer',
      ...serverEnv,
      payload: { targetUserId: 'user_2', connectionId: 'conn_1', sdp: 'v=0 a=...', fromUserId: 'user_1' },
    };
    const ice = {
      type: 'webrtc.ice',
      ...serverEnv,
      payload: {
        targetUserId: 'user_2',
        connectionId: 'conn_1',
        candidate: { candidate: 'candidate:1 ...', sdpMid: null, sdpMLineIndex: null },
        fromUserId: 'user_1',
      },
    };
    expect(ServerEvent.parse(offer)).toEqual(offer);
    expect(ServerWebrtcOffer.parse(offer)).toEqual(offer);
    expect(ServerEvent.parse(answer)).toEqual(answer);
    expect(ServerWebrtcAnswer.parse(answer)).toEqual(answer);
    expect(ServerEvent.parse(ice)).toEqual(ice);
    expect(ServerWebrtcIce.parse(ice)).toEqual(ice);
  });

  it('webrtc.ice server rejects a missing candidate', () => {
    const evt = {
      type: 'webrtc.ice',
      ...serverEnv,
      payload: { targetUserId: 'user_2', connectionId: 'conn_1', fromUserId: 'user_1' },
    };
    expect(ServerWebrtcIce.safeParse(evt).success).toBe(false);
    expect(ServerEvent.safeParse(evt).success).toBe(false);
  });

  it('webrtc.offer server rejects a missing fromUserId', () => {
    const evt = {
      type: 'webrtc.offer',
      ...serverEnv,
      payload: { targetUserId: 'user_2', connectionId: 'conn_1', sdp: 'v=0' },
    };
    expect(ServerWebrtcOffer.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts restream.state with a RestreamState payload', () => {
    const evt = {
      type: 'restream.state',
      ...serverEnv,
      payload: { active: true, hostUserId: 'user_1', startedAt: TS, viewerCount: 4, uplinkQuality: 'degraded' },
    };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerRestreamState.parse(evt)).toEqual(evt);
  });

  it('restream.state rejects a missing viewerCount', () => {
    const evt = {
      type: 'restream.state',
      ...serverEnv,
      payload: { active: true, hostUserId: 'user_1', startedAt: TS, uplinkQuality: 'good' },
    };
    expect(ServerRestreamState.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts queue.state', () => {
    const evt = { type: 'queue.state', ...serverEnv, payload: { items: [queueItem], version: 3 } };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerQueueState.parse(evt)).toEqual(evt);
  });

  it('queue.state rejects a negative version', () => {
    const evt = { type: 'queue.state', ...serverEnv, payload: { items: [], version: -1 } };
    expect(ServerQueueState.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts presence.diff', () => {
    const evt = {
      type: 'presence.diff',
      ...serverEnv,
      payload: { upserts: [presenceEntry], removed: ['user_2'] },
    };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerPresenceDiff.parse(evt)).toEqual(evt);
  });

  it('presence.state rejects an entry with a bad state', () => {
    const evt = {
      type: 'presence.state',
      ...serverEnv,
      payload: { entries: [{ ...presenceEntry, state: 'zzz' }] },
    };
    expect(ServerPresenceState.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts emote.burst', () => {
    const evt = {
      type: 'emote.burst',
      ...serverEnv,
      payload: { userId: 'user_1', emoji: '🔥', xPct: 0, yPct: 100 },
    };
    expect(ServerEmoteBurst.parse(evt)).toEqual(evt);
  });

  it('emote.burst server rejects yPct 200', () => {
    const evt = {
      type: 'emote.burst',
      ...serverEnv,
      payload: { userId: 'user_1', emoji: '🔥', xPct: 0, yPct: 200 },
    };
    expect(ServerEmoteBurst.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts media.status, room.updated and member.updated', () => {
    const media = { type: 'media.status', ...serverEnv, payload: assetReady };
    const roomEvt = { type: 'room.updated', ...serverEnv, payload: room };
    const memberEvt = { type: 'member.updated', ...serverEnv, payload: member };
    expect(ServerMediaStatus.parse(media)).toEqual(media);
    expect(ServerRoomUpdated.parse(roomEvt)).toEqual(roomEvt);
    expect(ServerMemberUpdated.parse(memberEvt)).toEqual(memberEvt);
    expect(ServerEvent.parse(media)).toEqual(media);
    expect(ServerEvent.parse(roomEvt)).toEqual(roomEvt);
    expect(ServerEvent.parse(memberEvt)).toEqual(memberEvt);
  });

  it('media.status rejects a bad asset payload', () => {
    const evt = { type: 'media.status', ...serverEnv, payload: { ...assetReady, status: 'done' } };
    expect(ServerMediaStatus.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts clock.pong', () => {
    const evt = { type: 'clock.pong', ...serverEnv, payload: { clientTs: TS, serverTs: TS + 5 } };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerClockPong.parse(evt)).toEqual(evt);
  });

  it('clock.pong rejects a missing serverTs', () => {
    const evt = { type: 'clock.pong', ...serverEnv, payload: { clientTs: TS } };
    expect(ServerClockPong.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent accepts error with an ApiError payload', () => {
    const evt = { type: 'error', ...serverEnv, payload: { code: 'ROOM_POLICY', message: 'nope' } };
    expect(ServerEvent.parse(evt)).toEqual(evt);
    expect(ServerError.parse(evt)).toEqual(evt);
  });

  it("ServerEvent rejects error with code 'NOPE'", () => {
    const evt = { type: 'error', ...serverEnv, payload: { code: 'NOPE', message: 'x' } };
    expect(ServerEvent.safeParse(evt).success).toBe(false);
  });

  it('ServerEvent rejects an unknown type', () => {
    const evt = { type: 'room.exploded', ...serverEnv, payload: {} };
    expect(ServerEvent.safeParse(evt).success).toBe(false);
  });

  it('parsed ServerEvent exposes numeric seq for gap detection', () => {
    const parsed = ServerEvent.parse({ type: 'clock.pong', ...serverEnv, payload: { clientTs: TS, serverTs: TS } });
    expect(parsed.seq).toBe(42);
    expect(typeof parsed.seq).toBe('number');
  });
});

describe('WsEnvelope', () => {
  it('accepts a generic envelope with any payload', () => {
    const env = { type: 'anything.goes', roomId: 'room_1', seq: 9, ts: TS, payload: { arbitrary: [1, 2] } };
    expect(WsEnvelope.parse(env)).toEqual(env);
  });

  it('rejects a negative seq', () => {
    const env = { type: 'anything.goes', roomId: 'room_1', seq: -1, ts: TS, payload: null };
    expect(WsEnvelope.safeParse(env).success).toBe(false);
  });
});

// ---------- rest ----------

describe('rest.auth', () => {
  it('RequestMagicLinkBody accepts a valid email', () => {
    const body = { email: 'alice@example.com' };
    expect(RequestMagicLinkBody.parse(body)).toEqual(body);
  });

  it('RequestMagicLinkBody rejects a bad email', () => {
    expect(RequestMagicLinkBody.safeParse({ email: 'nope' }).success).toBe(false);
  });

  it('GuestJoinBody roundtrips', () => {
    const body = { inviteCode: 'abcd1234', displayName: 'Guesty' };
    expect(GuestJoinBody.parse(body)).toEqual(body);
  });

  it('UpdateProfileBody accepts {} (all optional)', () => {
    expect(UpdateProfileBody.parse({})).toEqual({});
  });

  it('UpdateProfileBody accepts { avatarUrl: null }', () => {
    expect(UpdateProfileBody.parse({ avatarUrl: null })).toEqual({ avatarUrl: null });
  });

  it("UpdateProfileBody rejects accentColor 'blue'", () => {
    expect(UpdateProfileBody.safeParse({ accentColor: 'blue' }).success).toBe(false);
  });

  it('UpgradeGuestBody accepts an email and rejects a non-email', () => {
    expect(UpgradeGuestBody.parse({ email: 'guest@example.com' })).toEqual({
      email: 'guest@example.com',
    });
    expect(UpgradeGuestBody.safeParse({ email: 'nope' }).success).toBe(false);
  });

  it('ListSessionsResponse roundtrips a device list', () => {
    const res = {
      sessions: [
        { id: 'sess_1', device: 'Safari on macOS', createdAt: TS, lastSeenAt: TS, current: true },
        { id: 'sess_2', device: 'Gather on iPhone', createdAt: TS, lastSeenAt: TS, current: false },
      ],
    };
    expect(ListSessionsResponse.parse(res)).toEqual(res);
  });

  it('RevokeAllSessionsResponse rejects a negative revoked count', () => {
    expect(RevokeAllSessionsResponse.parse({ revoked: 3 })).toEqual({ revoked: 3 });
    expect(RevokeAllSessionsResponse.safeParse({ revoked: -1 }).success).toBe(false);
  });

  it('VerifyTokenResponse roundtrips with and without access-token fields', () => {
    const bare = { user };
    expect(VerifyTokenResponse.parse(bare)).toEqual(bare);
    const withToken = { user, accessToken: 'jwt-a', accessTokenExpiresAt: TS };
    expect(VerifyTokenResponse.parse(withToken)).toEqual(withToken);
    expect(VerifyTokenResponse.safeParse({ user, accessToken: '' }).success).toBe(false);
  });

  it('RefreshResponse accepts the optional access-token fields', () => {
    const res = { user, accessToken: 'jwt-b', accessTokenExpiresAt: TS };
    expect(RefreshResponse.parse(res)).toEqual(res);
  });

  it('GuestJoinResponse roundtrips with access-token fields', () => {
    const res = {
      user: guestUser,
      room,
      member,
      lastEventSeq: 7,
      accessToken: 'jwt-g',
      accessTokenExpiresAt: TS,
    };
    expect(GuestJoinResponse.parse(res)).toEqual(res);
  });

  it('RevokeSessionResponse roundtrips', () => {
    expect(RevokeSessionResponse.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe('rest.rooms', () => {
  it("CreateRoomBody still accepts the deprecated kind 'listen' (deployed clients send it)", () => {
    const body = { kind: 'listen', name: 'Chill beats' };
    expect(CreateRoomBody.parse(body)).toEqual(body);
  });

  it("CreateRoomBody defaults kind to 'watch' when omitted", () => {
    expect(CreateRoomBody.parse({ name: 'Movie Night' })).toEqual({
      kind: 'watch',
      name: 'Movie Night',
    });
  });

  it('CreateRoomBody rejects a bad kind', () => {
    expect(CreateRoomBody.safeParse({ kind: 'party', name: 'x' }).success).toBe(false);
  });

  it('UpdatePoliciesBody accepts a partial { chat: "mods" }', () => {
    expect(UpdatePoliciesBody.parse({ chat: 'mods' })).toEqual({ chat: 'mods' });
  });

  it('UpdatePoliciesBody rejects { maxPublishers: 0 }', () => {
    expect(UpdatePoliciesBody.safeParse({ maxPublishers: 0 }).success).toBe(false);
  });

  it('CreateInviteBody accepts {}', () => {
    expect(CreateInviteBody.parse({})).toEqual({});
  });

  it('CreateInviteBody accepts { expiresAt: null }', () => {
    expect(CreateInviteBody.parse({ expiresAt: null })).toEqual({ expiresAt: null });
  });

  it('SetMemberRoleBody accepts moderator/member and rejects host/guest', () => {
    expect(SetMemberRoleBody.parse({ userId: 'user_2', role: 'moderator' })).toEqual({
      userId: 'user_2',
      role: 'moderator',
    });
    expect(SetMemberRoleBody.parse({ userId: 'user_2', role: 'member' })).toEqual({
      userId: 'user_2',
      role: 'member',
    });
    expect(SetMemberRoleBody.safeParse({ userId: 'user_2', role: 'host' }).success).toBe(false);
    expect(SetMemberRoleBody.safeParse({ userId: 'user_2', role: 'guest' }).success).toBe(false);
  });

  it('GetRoomResponse accepts an optional lastEventSeq', () => {
    const bare = { room, member };
    expect(GetRoomResponse.parse(bare)).toEqual(bare);
    const seeded = { room, member, lastEventSeq: 120 };
    expect(GetRoomResponse.parse(seeded)).toEqual(seeded);
  });

  it('ListMyRoomsResponse defaults muted to false', () => {
    const res = { rooms: [{ room, unreadCount: 2, memberCount: 5 }] };
    expect(ListMyRoomsResponse.parse(res)).toEqual({
      rooms: [{ room, unreadCount: 2, memberCount: 5, muted: false }],
    });
  });

  it('SetTheaterBody roundtrips', () => {
    const body = { enabled: true };
    expect(SetTheaterBody.parse(body)).toEqual(body);
  });

  it('SetTheaterBody rejects a non-boolean enabled', () => {
    expect(SetTheaterBody.safeParse({ enabled: 'yes' }).success).toBe(false);
    expect(SetTheaterBody.safeParse({}).success).toBe(false);
  });

  it('SetTheaterResponse roundtrips', () => {
    const res = { room: { ...room, theater: true } };
    expect(SetTheaterResponse.parse(res)).toEqual(res);
  });
});

describe('rest.messages', () => {
  it('ListMessagesQuery applies the default limit on {}', () => {
    expect(ListMessagesQuery.parse({})).toEqual({ limit: 50 });
  });

  it('ListMessagesQuery coerces string query params to numbers', () => {
    expect(ListMessagesQuery.parse({ beforeSeq: '10', limit: '5' })).toEqual({
      beforeSeq: 10,
      limit: 5,
    });
  });

  it("ListMessagesQuery rejects { limit: '0' }", () => {
    expect(ListMessagesQuery.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('UnfurlBody accepts a real url', () => {
    const body = { url: 'https://example.com/article' };
    expect(UnfurlBody.parse(body)).toEqual(body);
  });

  it('UnfurlBody rejects a non-url', () => {
    expect(UnfurlBody.safeParse({ url: 'not a url' }).success).toBe(false);
  });
});

describe('rest.media', () => {
  it('CreateUploadBody roundtrips', () => {
    const body = { filename: 'song.mp3', mime: 'audio/mpeg', sizeBytes: 1024 };
    expect(CreateUploadBody.parse(body)).toEqual(body);
  });

  it('CreateUploadBody rejects sizeBytes 0', () => {
    expect(
      CreateUploadBody.safeParse({ filename: 'song.mp3', mime: 'audio/mpeg', sizeBytes: 0 }).success,
    ).toBe(false);
  });

  it('CompleteUploadBody roundtrips', () => {
    const body = {
      assetId: 'asset_1',
      uploadId: 'upload_1',
      parts: [{ partNumber: 1, etag: 'etag-abc' }],
    };
    expect(CompleteUploadBody.parse(body)).toEqual(body);
  });

  it('CompleteUploadBody rejects an empty etag', () => {
    expect(
      CompleteUploadBody.safeParse({
        assetId: 'asset_1',
        uploadId: 'upload_1',
        parts: [{ partNumber: 1, etag: '' }],
      }).success,
    ).toBe(false);
  });

  it('CreateUploadResponse accepts parts with and without explicit byte ranges', () => {
    const withRanges = {
      assetId: 'asset_1',
      uploadId: 'upload_1',
      parts: [
        { partNumber: 1, url: 'https://s3.example.com/p1', startByte: 0, endByte: 5242880 },
        { partNumber: 2, url: 'https://s3.example.com/p2', startByte: 5242880, endByte: 6000000 },
      ],
    };
    expect(CreateUploadResponse.parse(withRanges)).toEqual(withRanges);
    const bare = {
      assetId: 'asset_1',
      uploadId: 'upload_1',
      parts: [{ partNumber: 1, url: 'https://s3.example.com/p1' }],
    };
    expect(CreateUploadResponse.parse(bare)).toEqual(bare);
  });
});

describe('rest.playlists', () => {
  it('CreatePlaylistBody roundtrips without roomId', () => {
    const body = { title: 'My playlist' };
    expect(CreatePlaylistBody.parse(body)).toEqual(body);
  });

  it('CreatePlaylistBody roundtrips with roomId', () => {
    const body = { title: 'Room playlist', roomId: 'room_1' };
    expect(CreatePlaylistBody.parse(body)).toEqual(body);
  });

  it('CreatePlaylistBody rejects an empty title', () => {
    expect(CreatePlaylistBody.safeParse({ title: '' }).success).toBe(false);
  });

  it('AddToRoomQueueBody roundtrips', () => {
    const body = { playlistId: 'pl_1', roomId: 'room_1' };
    expect(AddToRoomQueueBody.parse(body)).toEqual(body);
  });
});

describe('rest.events', () => {
  it("ReplayEventsQuery coerces { since: '100' } to 100", () => {
    expect(ReplayEventsQuery.parse({ since: '100' })).toEqual({ since: 100 });
  });

  it("ReplayEventsQuery rejects { since: '-1' }", () => {
    expect(ReplayEventsQuery.safeParse({ since: '-1' }).success).toBe(false);
  });

  it('ReplayEventsResponse accepts a typed server event', () => {
    const res = {
      events: [{ type: 'chat.message', roomId: 'room_1', seq: 12, ts: TS, payload: message }],
    };
    expect(ReplayEventsResponse.parse(res)).toEqual(res);
  });

  it('ReplayEventsResponse rejects a sync.state envelope with a bogus payload', () => {
    const res = {
      events: [{ type: 'sync.state', roomId: 'room_1', seq: 12, ts: TS, payload: { totally: 'bogus' } }],
    };
    expect(ReplayEventsResponse.safeParse(res).success).toBe(false);
  });

  it('ReplayEventsResponse rejects an unknown event type', () => {
    const res = {
      events: [{ type: 'made.up', roomId: 'room_1', seq: 12, ts: TS, payload: {} }],
    };
    expect(ReplayEventsResponse.safeParse(res).success).toBe(false);
  });
});

describe('rest.rtc', () => {
  it('TurnCredentialsResponse roundtrips with full TURN credentials', () => {
    const res = {
      iceServers: [
        { urls: ['stun:stun.example.com'] },
        { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' },
      ],
      ttlSeconds: 3600,
      fairUseRemainingGb: 12.5,
    };
    expect(TurnCredentialsResponse.parse(res)).toEqual(res);
  });

  it('TurnCredentialsResponse accepts fairUseRemainingGb: null', () => {
    const res = {
      iceServers: [{ urls: ['stun:stun.example.com'] }],
      ttlSeconds: 3600,
      fairUseRemainingGb: null,
    };
    expect(TurnCredentialsResponse.parse(res)).toEqual(res);
  });

  it('TurnCredentialsResponse rejects a negative ttlSeconds and Infinity fairUseRemainingGb', () => {
    const base = { iceServers: [{ urls: ['stun:stun.example.com'] }], ttlSeconds: 3600, fairUseRemainingGb: 1 };
    expect(TurnCredentialsResponse.safeParse({ ...base, ttlSeconds: -1 }).success).toBe(false);
    expect(TurnCredentialsResponse.safeParse({ ...base, fairUseRemainingGb: Infinity }).success).toBe(false);
  });
});

describe('rest.billing', () => {
  it("CreateCheckoutSessionBody accepts { plan: 'premium' }", () => {
    const body = { plan: 'premium' };
    expect(CreateCheckoutSessionBody.parse(body)).toEqual(body);
  });

  it("CreateCheckoutSessionBody rejects { plan: 'free' }", () => {
    expect(CreateCheckoutSessionBody.safeParse({ plan: 'free' }).success).toBe(false);
  });

  it('CreateCheckoutSessionResponse roundtrips and rejects a bad url', () => {
    const res = { url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
    expect(CreateCheckoutSessionResponse.parse(res)).toEqual(res);
    expect(CreateCheckoutSessionResponse.safeParse({ url: 'nope' }).success).toBe(false);
  });

  it('CreatePortalSessionResponse roundtrips', () => {
    const res = { url: 'https://billing.stripe.com/p/session/xyz' };
    expect(CreatePortalSessionResponse.parse(res)).toEqual(res);
  });

  it('GetEntitlementsResponse roundtrips', () => {
    const res = { entitlements, subscription };
    expect(GetEntitlementsResponse.parse(res)).toEqual(res);
  });

  it('GetEntitlementsResponse rejects a bogus subscription status', () => {
    const res = { entitlements, subscription: { ...subscription, status: 'trial' } };
    expect(GetEntitlementsResponse.safeParse(res).success).toBe(false);
  });
});

describe('rest.report + rest.gdpr', () => {
  it('ReportBody accepts each target kind', () => {
    const targets = [
      { kind: 'message', messageId: 'msg_1', roomId: 'room_1' },
      { kind: 'user', userId: 'user_2' },
      { kind: 'room', roomId: 'room_1' },
      { kind: 'asset', assetId: 'asset_1' },
    ] as const;
    for (const target of targets) {
      const body = { target, reason: 'abusive content' };
      expect(ReportBody.parse(body)).toEqual(body);
    }
  });

  it("ReportBody rejects target kind 'vibe' and an empty reason", () => {
    expect(
      ReportBody.safeParse({ target: { kind: 'vibe' }, reason: 'x' }).success,
    ).toBe(false);
    expect(
      ReportBody.safeParse({ target: { kind: 'user', userId: 'user_2' }, reason: '' }).success,
    ).toBe(false);
  });

  it('ReportResponse roundtrips', () => {
    const res = { ok: true, reportId: 'rep_1' };
    expect(ReportResponse.parse(res)).toEqual(res);
  });

  it('MeExportResponse roundtrips a full export', () => {
    const res = {
      exportedAt: TS,
      user,
      rooms: [room],
      messages: [message],
      playlists: [playlist],
      assets: [assetReady],
    };
    expect(MeExportResponse.parse(res)).toEqual(res);
  });

  it('MeExportResponse roundtrips playbackHistory and usage', () => {
    const res = {
      exportedAt: TS,
      user,
      rooms: [room],
      messages: [message],
      playlists: [playlist],
      assets: [assetReady],
      playbackHistory: [
        {
          roomId: 'room_1',
          mediaRef: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
          positionMs: 4200,
          at: TS,
        },
      ],
      usage: [{ month: '2026-08', relayGb: 1.25 }],
    };
    expect(MeExportResponse.parse(res)).toEqual(res);
  });

  it('MeExportResponse rejects a malformed usage month', () => {
    const base = {
      exportedAt: TS,
      user,
      rooms: [room],
      messages: [message],
      playlists: [playlist],
      assets: [assetReady],
    };
    expect(
      MeExportResponse.safeParse({ ...base, usage: [{ month: '2026-13', relayGb: 1 }] }).success,
    ).toBe(false);
    expect(
      MeExportResponse.safeParse({ ...base, usage: [{ month: '08-2026', relayGb: 1 }] }).success,
    ).toBe(false);
  });

  it('DeleteMeResponse requires a purgeAt grace deadline', () => {
    expect(DeleteMeResponse.parse({ ok: true, purgeAt: TS })).toEqual({ ok: true, purgeAt: TS });
    expect(DeleteMeResponse.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('rest.push', () => {
  it('PushSubscribeBody accepts the web branch', () => {
    const body = {
      platform: 'web',
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    };
    expect(PushSubscribeBody.parse(body)).toEqual(body);
  });

  it('PushSubscribeBody accepts the expo branch', () => {
    const body = { platform: 'expo', expoPushToken: 'ExponentPushToken[abc]' };
    expect(PushSubscribeBody.parse(body)).toEqual(body);
  });

  it("PushSubscribeBody rejects { platform: 'sms' }", () => {
    expect(PushSubscribeBody.safeParse({ platform: 'sms' }).success).toBe(false);
  });

  it('SetRoomMuteBody roundtrips', () => {
    const body = { roomId: 'room_1', muted: true };
    expect(SetRoomMuteBody.parse(body)).toEqual(body);
  });

  it('SetRoomMuteBody rejects a missing muted flag', () => {
    expect(SetRoomMuteBody.safeParse({ roomId: 'room_1' }).success).toBe(false);
  });
});

describe('rest.gifs', () => {
  it('SearchGifsQuery applies defaults', () => {
    expect(SearchGifsQuery.parse({ q: 'cats' })).toEqual({ q: 'cats', limit: 20 });
  });

  it('SearchGifsQuery rejects an empty q', () => {
    expect(SearchGifsQuery.safeParse({ q: '' }).success).toBe(false);
  });

  it('SearchGifsResponse accepts one result', () => {
    const res = {
      results: [
        {
          id: 'gif_1',
          url: 'https://media.example.com/cats.gif',
          previewUrl: 'https://media.example.com/cats-preview.gif',
          width: 480,
          height: 270,
          title: 'cats',
        },
      ],
    };
    expect(SearchGifsResponse.parse(res)).toEqual(res);
  });
});

describe('rest.shared', () => {
  it('Ok parses { ok: true }', () => {
    expect(Ok.parse({ ok: true })).toEqual({ ok: true });
  });

  it('Ok rejects { ok: false }', () => {
    expect(Ok.safeParse({ ok: false }).success).toBe(false);
  });

  it('paginated(Message) accepts a page with nextCursor: null', () => {
    const page = { items: [message], nextCursor: null };
    expect(paginated(Message).parse(page)).toEqual(page);
  });
});
