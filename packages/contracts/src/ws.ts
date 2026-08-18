import { z } from 'zod';
import { ApiError } from './errors';
import {
  MediaAsset,
  MediaRef,
  Member,
  Message,
  MessageAttachment,
  MessageId,
  PlaybackState,
  PresenceEntry,
  PresenceState,
  QueueItem,
  QueueItemId,
  QueueItemInput,
  ReadCursor,
  RestreamState,
  Room,
  RoomId,
  Timestamp,
  UserId,
  WebUrl,
} from './entities';

/**
 * The access token's ride on the WS upgrade: a Sec-WebSocket-Protocol value
 * of `gather.auth.<jwt>`. A browser WebSocket cannot set Authorization, and a
 * query-string credential lands in every access log between the client and
 * the process — the subprotocol slot is the one header a browser CAN write.
 * base64url JWTs are legal subprotocol syntax. The server reads this header
 * first and keeps accepting the legacy `?token=` query for
 * already-installed extension/mobile builds.
 */
export const WS_AUTH_SUBPROTOCOL_PREFIX = 'gather.auth.';

export const WsEnvelope = z.object({
  type: z.string(),
  roomId: RoomId,
  seq: z.number().int().nonnegative(), // server-assigned, monotonic per room; 0 for client->server
  ts: Timestamp,
  payload: z.unknown(),
});
export type WsEnvelope = z.infer<typeof WsEnvelope>;

const clientEvent = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), roomId: RoomId, seq: z.literal(0), ts: Timestamp, payload });

const serverEvent = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    type: z.literal(type),
    roomId: RoomId,
    seq: z.number().int().nonnegative(),
    ts: Timestamp,
    payload,
  });

// ---------- Client events ----------

/** Message kinds a client may send. 'system' is server-minted only and is
 *  excluded here so clients cannot schema-validly spoof system messages. */
export const ClientMessageKind = z.enum(['text', 'gif', 'attachment', 'voice']);
export type ClientMessageKind = z.infer<typeof ClientMessageKind>;

export const ClientChatSend = clientEvent(
  'chat.send',
  z
    .object({
      kind: ClientMessageKind,
      body: z.string().max(8000),
      // Message.gifUrl reads back as WebUrl — the write door MUST NOT be
      // looser, or one accepted `javascript:` value makes the whole chat
      // history unparseable for every member of the room.
      gifUrl: WebUrl.nullable(),
      attachment: MessageAttachment.nullable(),
      replyTo: MessageId.nullable(),
      mentions: z.array(UserId),
    })
    .superRefine((p, ctx) => {
      // Per-kind content requirement: an empty message is never valid.
      if (p.kind === 'text' && p.body.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'text message requires a non-empty body' });
      }
      if (p.kind === 'gif' && p.gifUrl === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gifUrl'], message: 'gif message requires gifUrl' });
      }
      if ((p.kind === 'attachment' || p.kind === 'voice') && p.attachment === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attachment'], message: `${p.kind} message requires attachment` });
      }
    }),
);
export type ClientChatSend = z.infer<typeof ClientChatSend>;

export const ClientChatEdit = clientEvent(
  'chat.edit',
  z.object({ messageId: MessageId, body: z.string().min(1).max(8000) }),
);
export type ClientChatEdit = z.infer<typeof ClientChatEdit>;

export const ClientChatDelete = clientEvent('chat.delete', z.object({ messageId: MessageId }));
export type ClientChatDelete = z.infer<typeof ClientChatDelete>;

export const ClientChatReact = clientEvent(
  'chat.react',
  z.object({
    messageId: MessageId,
    emoji: z.string().min(1).max(32),
    op: z.enum(['add', 'remove']),
  }),
);
export type ClientChatReact = z.infer<typeof ClientChatReact>;

export const ClientChatTyping = clientEvent('chat.typing', z.object({ typing: z.boolean() }));
export type ClientChatTyping = z.infer<typeof ClientChatTyping>;

/** Read-cursor advance. */
export const ClientChatRead = clientEvent(
  'chat.read',
  z.object({ lastReadSeq: z.number().int().nonnegative() }),
);
export type ClientChatRead = z.infer<typeof ClientChatRead>;

/** Delivered-cursor advance, mirroring chat.read. */
export const ClientChatDelivered = clientEvent(
  'chat.delivered',
  z.object({ lastDeliveredSeq: z.number().int().nonnegative() }),
);
export type ClientChatDelivered = z.infer<typeof ClientChatDelivered>;

export const ClientSyncPlay = clientEvent(
  'sync.play',
  z.object({ positionMs: z.number().finite().nonnegative().optional() }),
);
export type ClientSyncPlay = z.infer<typeof ClientSyncPlay>;

export const ClientSyncPause = clientEvent(
  'sync.pause',
  z.object({ positionMs: z.number().finite().nonnegative().optional() }),
);
export type ClientSyncPause = z.infer<typeof ClientSyncPause>;

export const ClientSyncSeek = clientEvent(
  'sync.seek',
  z.object({ positionMs: z.number().finite().nonnegative() }),
);
export type ClientSyncSeek = z.infer<typeof ClientSyncSeek>;

export const ClientSyncRate = clientEvent(
  'sync.rate',
  z.object({ rate: z.number().min(0.25).max(4) }),
);
export type ClientSyncRate = z.infer<typeof ClientSyncRate>;

export const ClientSyncSetTrack = clientEvent(
  'sync.setTrack',
  // Exactly one selector, discriminated on `kind`: by explicit mediaRef OR
  // by queue position.
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('media'), mediaRef: MediaRef }),
    z.object({ kind: z.literal('queue'), queueIndex: z.number().int().nonnegative() }),
  ]),
);
export type ClientSyncSetTrack = z.infer<typeof ClientSyncSetTrack>;

/**
 * "The item I was playing has ENDED — move the room on from it."
 *
 * NOT a request to drive. `sync.setTrack` says "put the room on THIS" and is
 * policy-gated; this says "the thing that was on is over", which is the queue
 * doing the one thing a queue is for, and the server takes it from any
 * non-banned member. Its own event type rather than a third `kind` on
 * `sync.setTrack` precisely BECAUSE the authority differs: one handler with
 * two gates inside it is the shape that has already produced a bypass here
 * (the master seat's claim gate drifting from the drive gate). Two names, two
 * gates, visible without following a branch.
 *
 * The server applies it as a COMPARE-AND-SET: only while the room is still on
 * `endedItemId`, otherwise silently nothing. So every client that was playing
 * may fire on 'ended' — the first lands, the rest are no-ops rather than
 * errors — and no seat, election or presence inference has to decide which one
 * of them was supposed to. Whoever is watching reports; nobody is nominated.
 *
 * BY ID, NEVER BY INDEX. `queueIndex` is a raw index into an array that every
 * remove and reorder rewrites, so "index 3 ended" can name a different track
 * by the time it arrives — a live bug in this repo, not a hypothesis. An item
 * id is stable under both, so the server's question ("are we still on the item
 * you meant?") is about the same object the client meant.
 */
export const ClientSyncAdvance = clientEvent(
  'sync.advance',
  z.object({ endedItemId: QueueItemId }),
);
export type ClientSyncAdvance = z.infer<typeof ClientSyncAdvance>;

export const ClientSyncWaitForAll = clientEvent(
  'sync.waitForAll',
  z.object({ enabled: z.boolean() }),
);
export type ClientSyncWaitForAll = z.infer<typeof ClientSyncWaitForAll>;

/** Buffering/ready report so the server can coordinate "wait-for-all". */
export const ClientSyncBuffering = clientEvent(
  'sync.buffering',
  z.object({ buffering: z.boolean() }),
);
export type ClientSyncBuffering = z.infer<typeof ClientSyncBuffering>;

// ── WebRTC signaling ──────────────────────────────────────────────────────────

/** Minimal RTCIceCandidateInit shape relayed between peers. */
export const IceCandidateInit = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().int().nonnegative().nullable(),
});
export type IceCandidateInit = z.infer<typeof IceCandidateInit>;

const webrtcSdpPayload = z.object({
  targetUserId: UserId,
  connectionId: z.string().min(1),
  sdp: z.string(),
});

const webrtcIcePayload = z.object({
  targetUserId: UserId,
  connectionId: z.string().min(1),
  candidate: IceCandidateInit,
});

export const ClientWebrtcOffer = clientEvent('webrtc.offer', webrtcSdpPayload);
export type ClientWebrtcOffer = z.infer<typeof ClientWebrtcOffer>;

export const ClientWebrtcAnswer = clientEvent('webrtc.answer', webrtcSdpPayload);
export type ClientWebrtcAnswer = z.infer<typeof ClientWebrtcAnswer>;

export const ClientWebrtcIce = clientEvent('webrtc.ice', webrtcIcePayload);
export type ClientWebrtcIce = z.infer<typeof ClientWebrtcIce>;

// ── Mode B (re-stream) ────────────────────────────────────────────────────────

/** Start re-streaming: the sender becomes the sharing host (policy-gated). */
export const ClientRestreamStart = clientEvent('restream.start', z.object({}));
export type ClientRestreamStart = z.infer<typeof ClientRestreamStart>;

/** Stop re-streaming (host or moderator). */
export const ClientRestreamStop = clientEvent('restream.stop', z.object({}));
export type ClientRestreamStop = z.infer<typeof ClientRestreamStop>;

/** Hand the share off to another member (they become the sharing host). */
export const ClientRestreamHandoff = clientEvent(
  'restream.handoff',
  z.object({ toUserId: UserId }),
);
export type ClientRestreamHandoff = z.infer<typeof ClientRestreamHandoff>;

export const ClientQueueAdd = clientEvent('queue.add', z.object({ item: QueueItemInput }));
export type ClientQueueAdd = z.infer<typeof ClientQueueAdd>;

export const ClientQueueRemove = clientEvent('queue.remove', z.object({ itemId: QueueItemId }));
export type ClientQueueRemove = z.infer<typeof ClientQueueRemove>;

export const ClientQueueReorder = clientEvent(
  'queue.reorder',
  z.object({ orderedIds: z.array(QueueItemId).min(1) }),
);
export type ClientQueueReorder = z.infer<typeof ClientQueueReorder>;

export const ClientQueueVoteSkip = clientEvent(
  'queue.voteSkip',
  z.object({ itemId: QueueItemId }),
);
export type ClientQueueVoteSkip = z.infer<typeof ClientQueueVoteSkip>;

export const ClientPresenceUpdate = clientEvent(
  'presence.update',
  z.object({
    state: PresenceState.optional(),
    micOn: z.boolean().optional(),
    camOn: z.boolean().optional(),
    sharing: z.boolean().optional(),
    /**
     * "Send the room back to me." A page refresh is NOT a leave: the presence
     * entry outlives the 1-5s reload, so the server sees an ordinary
     * heartbeat and replies with nothing — and the reloaded tab sits on an
     * empty queue, no playback and an EMPTY roster (which then tears down
     * every call peer). Saying so explicitly is the only reliable signal:
     * a bare/empty heartbeat is indistinguishable from a no-op keepalive.
     *
     * Set on the FIRST presence.update of every socket open, never on the
     * periodic beats — each one costs a full presence + sync + queue reply.
     */
    wantSnapshot: z.boolean().optional(),
  }),
);
export type ClientPresenceUpdate = z.infer<typeof ClientPresenceUpdate>;

export const ClientEmoteBurst = clientEvent(
  'emote.burst',
  z.object({
    emoji: z.string().min(1).max(32),
    xPct: z.number().min(0).max(100),
    yPct: z.number().min(0).max(100),
  }),
);
export type ClientEmoteBurst = z.infer<typeof ClientEmoteBurst>;

export const ClientClockPing = clientEvent('clock.ping', z.object({ clientTs: Timestamp }));
export type ClientClockPing = z.infer<typeof ClientClockPing>;

export const ClientEvent = z.discriminatedUnion('type', [
  ClientChatSend,
  ClientChatEdit,
  ClientChatDelete,
  ClientChatReact,
  ClientChatTyping,
  ClientChatRead,
  ClientChatDelivered,
  ClientSyncPlay,
  ClientSyncPause,
  ClientSyncSeek,
  ClientSyncRate,
  ClientSyncSetTrack,
  ClientSyncAdvance,
  ClientSyncWaitForAll,
  ClientSyncBuffering,
  ClientWebrtcOffer,
  ClientWebrtcAnswer,
  ClientWebrtcIce,
  ClientRestreamStart,
  ClientRestreamStop,
  ClientRestreamHandoff,
  ClientQueueAdd,
  ClientQueueRemove,
  ClientQueueReorder,
  ClientQueueVoteSkip,
  ClientPresenceUpdate,
  ClientEmoteBurst,
  ClientClockPing,
]);
export type ClientEvent = z.infer<typeof ClientEvent>;

// ---------- Server events ----------

export const ServerChatMessage = serverEvent('chat.message', Message);
export type ServerChatMessage = z.infer<typeof ServerChatMessage>;

export const ServerChatUpdated = serverEvent('chat.updated', Message);
export type ServerChatUpdated = z.infer<typeof ServerChatUpdated>;

export const ServerChatDeleted = serverEvent(
  'chat.deleted',
  z.object({ messageId: MessageId, deletedAt: Timestamp }),
);
export type ServerChatDeleted = z.infer<typeof ServerChatDeleted>;

export const ServerChatReaction = serverEvent(
  'chat.reaction',
  z.object({
    messageId: MessageId,
    emoji: z.string().min(1).max(32),
    userId: UserId,
    op: z.enum(['add', 'remove']),
  }),
);
export type ServerChatReaction = z.infer<typeof ServerChatReaction>;

export const ServerChatTyping = serverEvent(
  'chat.typing',
  z.object({ userId: UserId, typing: z.boolean() }),
);
export type ServerChatTyping = z.infer<typeof ServerChatTyping>;

export const ServerChatRead = serverEvent('chat.read', ReadCursor);
export type ServerChatRead = z.infer<typeof ServerChatRead>;

/** Delivered receipt broadcast, mirroring chat.read. */
export const ServerChatDelivered = serverEvent(
  'chat.delivered',
  z.object({
    userId: UserId,
    lastDeliveredSeq: z.number().int().nonnegative(),
    at: Timestamp,
  }),
);
export type ServerChatDelivered = z.infer<typeof ServerChatDelivered>;

export const ServerSyncState = serverEvent('sync.state', PlaybackState);
export type ServerSyncState = z.infer<typeof ServerSyncState>;

/** Wait-for-all coordination: playback is held while `waitingOn` members
 *  buffer; an empty list means everyone is ready and playback proceeds. */
export const ServerSyncWaiting = serverEvent(
  'sync.waiting',
  z.object({ waitingOn: z.array(UserId) }),
);
export type ServerSyncWaiting = z.infer<typeof ServerSyncWaiting>;

/** Server-relayed WebRTC signaling: the client's payload plus its sender. */
export const ServerWebrtcOffer = serverEvent(
  'webrtc.offer',
  webrtcSdpPayload.extend({ fromUserId: UserId }),
);
export type ServerWebrtcOffer = z.infer<typeof ServerWebrtcOffer>;

export const ServerWebrtcAnswer = serverEvent(
  'webrtc.answer',
  webrtcSdpPayload.extend({ fromUserId: UserId }),
);
export type ServerWebrtcAnswer = z.infer<typeof ServerWebrtcAnswer>;

export const ServerWebrtcIce = serverEvent(
  'webrtc.ice',
  webrtcIcePayload.extend({ fromUserId: UserId }),
);
export type ServerWebrtcIce = z.infer<typeof ServerWebrtcIce>;

/** Authoritative Mode B state: who is sharing, viewer count, uplink health.
 *  Clients switch between mediaRef playback and the host's shared
 *  screen/tab track based on `payload.active`. */
export const ServerRestreamState = serverEvent('restream.state', RestreamState);
export type ServerRestreamState = z.infer<typeof ServerRestreamState>;

export const ServerQueueState = serverEvent(
  'queue.state',
  z.object({ items: z.array(QueueItem), version: z.number().int().nonnegative() }),
);
export type ServerQueueState = z.infer<typeof ServerQueueState>;

export const ServerPresenceState = serverEvent(
  'presence.state',
  z.object({ entries: z.array(PresenceEntry) }),
);
export type ServerPresenceState = z.infer<typeof ServerPresenceState>;

export const ServerPresenceDiff = serverEvent(
  'presence.diff',
  z.object({ upserts: z.array(PresenceEntry), removed: z.array(UserId) }),
);
export type ServerPresenceDiff = z.infer<typeof ServerPresenceDiff>;

export const ServerEmoteBurst = serverEvent(
  'emote.burst',
  z.object({
    userId: UserId,
    emoji: z.string().min(1).max(32),
    xPct: z.number().min(0).max(100),
    yPct: z.number().min(0).max(100),
  }),
);
export type ServerEmoteBurst = z.infer<typeof ServerEmoteBurst>;

export const ServerMediaStatus = serverEvent('media.status', MediaAsset);
export type ServerMediaStatus = z.infer<typeof ServerMediaStatus>;

export const ServerRoomUpdated = serverEvent('room.updated', Room);
export type ServerRoomUpdated = z.infer<typeof ServerRoomUpdated>;

export const ServerMemberUpdated = serverEvent('member.updated', Member);
export type ServerMemberUpdated = z.infer<typeof ServerMemberUpdated>;

/** Why a member stopped being part of the room's roster. */
export const MemberRemovalReason = z.enum(['left', 'kicked', 'banned', 'roomDeleted']);
export type MemberRemovalReason = z.infer<typeof MemberRemovalReason>;

/** The prose the server puts on the 4403 close frame when it removes someone,
 *  and the only place the client is allowed to learn it from.
 *
 *  A WebSocket close reason is a free-text string, not the enum — so the two
 *  sides were string-coupled through nothing but two copies of the same
 *  literals, and editing one would have silently degraded the removed
 *  member's screen back to the generic "your access ended" sentence with
 *  every test still green. One table, both sides. */
export const MEMBER_REMOVAL_CLOSE_TEXT: Record<MemberRemovalReason, string> = {
  left: 'left',
  kicked: 'kicked',
  banned: 'banned',
  roomDeleted: 'room deleted',
};

/** The inverse of MEMBER_REMOVAL_CLOSE_TEXT: the reason behind a close frame,
 *  or null when the socket closed for anything else (the hub's own 4403s —
 *  'not a member', 'guest token is room-scoped' — land here). */
export function memberRemovalReasonFromCloseText(text: string): MemberRemovalReason | null {
  for (const reason of MemberRemovalReason.options) {
    if (MEMBER_REMOVAL_CLOSE_TEXT[reason] === text) return reason;
  }
  return null;
}

/** A member is gone from the roster (left, kicked, banned, room deleted), so
 *  every remaining client refreshes its member list.
 *
 *  ALWAYS emitted ephemerally (seq 0). A client built before this type exists
 *  fails ServerEvent.safeParse and returns without advancing its SeqTracker;
 *  a persisted seq would then read as a gap on every later event and drag
 *  that client into a full replay on every kick. Seq 0 frames are dropped
 *  harmlessly instead. */
export const ServerMemberRemoved = serverEvent(
  'member.removed',
  z.object({ userId: UserId, reason: MemberRemovalReason }),
);
export type ServerMemberRemoved = z.infer<typeof ServerMemberRemoved>;

export const ServerClockPong = serverEvent(
  'clock.pong',
  z.object({ clientTs: Timestamp, serverTs: Timestamp }),
);
export type ServerClockPong = z.infer<typeof ServerClockPong>;

export const ServerError = serverEvent('error', ApiError);
export type ServerError = z.infer<typeof ServerError>;

export const ServerEvent = z.discriminatedUnion('type', [
  ServerChatMessage,
  ServerChatUpdated,
  ServerChatDeleted,
  ServerChatReaction,
  ServerChatTyping,
  ServerChatRead,
  ServerChatDelivered,
  ServerSyncState,
  ServerSyncWaiting,
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
  ServerMemberRemoved,
  ServerClockPong,
  ServerError,
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
