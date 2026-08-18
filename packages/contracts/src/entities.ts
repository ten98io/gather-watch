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

/** Display form of an invite code: 12-char codes render as XXXX-XXXX-XXXX;
 *  legacy shorter codes render as-is. The hyphen is presentation-only —
 *  join paths strip it. */
export function formatInviteCode(code: string): string {
  return code.length === 12 ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : code;
}

/** Normalize user input for join: strip hyphens/spaces, lowercase. */
export function normalizeInviteCode(input: string): string {
  return input.replace(/[-\s]/g, '').toLowerCase();
}

export const SessionId = brandedId().brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

// Epoch milliseconds
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

export const AccentColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export type AccentColor = z.infer<typeof AccentColor>;

/**
 * An https:// URL, checked by parsing rather than by pattern.
 * `z.string().url()` is a `new URL()` call in a try/catch, so it accepts
 * 'javascript:alert(1)', 'data:text/html,…' and 'file:///etc/passwd' happily.
 * Every place this is used holds a value the app hands to the browser as a
 * link to open, so the scheme belongs in the contract instead of in whichever
 * call site remembers to look.
 */
export const HttpsUrl = z
  .string()
  .url()
  // .url() has already parsed it, so this only has to decide the SCHEME, and
  // a literal prefix decides it conservatively: the WHATWG parser reads the
  // scheme from the very start of the string, so nothing beginning 'https://'
  // can parse as another protocol, while the exotica the parser tolerates
  // (leading spaces, embedded tabs) falls out as a rejection rather than as a
  // pass. Erring toward "no" is the right direction for a value we open.
  // Written as a prefix test, not `new URL().protocol`, because this package
  // compiles environment-free — lib ES2023, types [] — and claims no runtime
  // globals of its own.
  .refine((value) => /^https:\/\//i.test(value), { message: 'must be an https:// URL' });
export type HttpsUrl = z.infer<typeof HttpsUrl>;

/**
 * A URL a client will hand to the browser: http:// or https://, nothing else.
 *
 * The banned half is the whole point. Every field typed with this one is read
 * back out into an href, a src, a CSS url() or mediaSession artwork on
 * somebody else's page, and `z.string().url()` waves through 'javascript:',
 * 'data:', 'blob:', 'vbscript:' and 'file:' — schemes that are not links to
 * anything, they are code and local disk.
 *
 * Plain http is ALLOWED rather than banned because these are the fields that
 * carry object-storage links, and the S3 endpoint is http://localhost:9000 in
 * development (services/api/src/config.ts). Refusing the schemes that execute
 * is the security property; demanding TLS is a deployment question, and
 * folding the two together only means the rule gets loosened for dev and stops
 * protecting production too. Use HttpsUrl where https is genuinely required.
 */
export const WebUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'must be an http:// or https:// URL',
  });
export type WebUrl = z.infer<typeof WebUrl>;

export const User = z.object({
  id: UserId,
  email: z.string().email().nullable(), // null for guests
  displayName: z.string().min(1).max(80),
  avatarUrl: WebUrl.nullable(),
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

/** @deprecated kept for stored docs and old clients; drives nothing. The
 *  stage adapts to what is PLAYING, not to a room-level kind. */
export const RoomKind = z.enum(['watch', 'listen']);
export type RoomKind = z.infer<typeof RoomKind>;

/** Media relay topology for the room's WebRTC calls: p2p mesh (what every
 *  room uses today) or a Cloudflare Realtime SFU. Stored docs may carry either
 *  value — older rooms were flipped to 'cf-sfu' by the theater toggle, which no
 *  longer touches transport at all. */
export const RelayMode = z.enum(['mesh', 'cf-sfu']);
export type RelayMode = z.infer<typeof RelayMode>;

export const Room = z.object({
  id: RoomId,
  /** @deprecated kept for stored docs and old clients; drives nothing. */
  kind: RoomKind,
  name: z.string().min(1).max(120),
  inviteCode: InviteCode,
  ownerId: UserId,
  policies: RoomPolicies,
  relayMode: RelayMode.default('mesh'),
  /** Theater layout: stage-focused view with the shared media front and center. */
  theater: z.boolean().default(false),
  /** @deprecated Rooms no longer expire on a clock — new rooms are always
   *  null (= persists) and nothing sets this. Kept for stored docs and old
   *  clients; abandoned rooms are reclaimed server-side by emptiness, never
   *  while anyone is present, so there is nothing to count down to. */
  expiresAt: Timestamp.nullable().default(null),
  createdAt: Timestamp,
  /** Whether joining this room requires its password. The hash itself is
   *  server-only (RoomDoc.passwordHash) and never crosses the wire. */
  hasPassword: z.boolean().default(false),
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

/**
 * The four services whose OFFICIAL embed player Gather is allowed to host in
 * an iframe. Closed on purpose — see EMBED_PROVIDER_HOSTS.
 */
export const EmbedProvider = z.enum(['spotify', 'applemusic', 'tidal', 'deezer']);
export type EmbedProvider = z.infer<typeof EmbedProvider>;

/**
 * Each embed provider pinned to the one origin its player is served from.
 *
 * Because `provider` is a CLOSED enum of four services, the host is knowable
 * rather than arbitrary: an embedUrl that is not an https URL on the
 * provider's own host is not an embed, it is something else wearing an
 * embed's name. That distinction was load-bearing — embedUrl was
 * `z.string().url()`, rooms default to `queueControl: 'everyone'` so any guest
 * can queue, and the value lands in `iframe.src` on every viewer's page
 * (apps/web/lib/player/embed.ts). 'javascript:…' passes `z.string().url()`.
 *
 * Every value keeps its trailing '/' ON PURPOSE. Without it the prefix
 * 'https://open.spotify.com' also matches
 * 'https://open.spotify.com@evil.example/x', where everything before the last
 * '@' is USERINFO and the browser resolves evil.example. The '/' forces the
 * authority to have ENDED, which also rejects the sibling tricks —
 * 'https://open.spotify.com.evil.example/x' and 'https://notopen.spotify.com/x'
 * — and the tab-smuggled 'https://open.spotify.com\t@evil.example/x', which the
 * URL parser resolves to evil.example after stripping the tab.
 *
 * Typed as Record<EmbedProvider, …> so a fifth provider added to the enum is a
 * COMPILE error here rather than a silently unpinned host.
 */
export const EMBED_PROVIDER_HOSTS: Record<EmbedProvider, string> = {
  spotify: 'https://open.spotify.com/',
  applemusic: 'https://embed.music.apple.com/',
  tidal: 'https://embed.tidal.com/',
  deezer: 'https://widget.deezer.com/',
};

/**
 * `value` starts with `prefix`, compared case-insensitively. Scheme and host
 * are the only case-insensitive parts of a URL and both sit inside these
 * prefixes, so folding case is right here and would be wrong one character
 * later. A slice compare rather than a built regex: the hosts are data, and
 * data spliced into a pattern is a metacharacter waiting to happen.
 */
function startsWithFold(value: string, prefix: string): boolean {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

const MediaRefKinds = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hls'), assetId: AssetId, url: WebUrl }),
  z.object({
    kind: z.literal('youtube'),
    videoId: z.string().min(1),
    /** The link came from music.youtube.com. The video id space is shared, so
     *  without this flag the origin is lost and a YT Music track cannot be
     *  told from a YouTube video downstream. Optional: absent on old items. */
    music: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('url'), url: WebUrl, mime: z.string().min(1) }),
  /** SoundCloud track/playlist URL — full sync via the official Widget API. */
  z.object({ kind: z.literal('soundcloud'), url: WebUrl }),
  /** Vimeo video id — full sync via the official player.js postMessage API. */
  z.object({ kind: z.literal('vimeo'), videoId: z.string().min(1) }),
  /**
   * Official embed players without a position API (Spotify, Apple Music,
   * Tidal, Deezer): transport commands are issued simultaneously, so sync is
   * approximate — never drift-corrected. Clients must badge it as such.
   * DRM services (Netflix/Prime/Disney+/Max/Hulu) are NOT MediaRefs — they
   * ride the browser-extension content-script path (everyone's own player).
   */
  z.object({
    kind: z.literal('embed'),
    provider: EmbedProvider,
    /** https alone is only half the rule; the other half needs `provider`
     *  alongside it and so lives in MediaRef's superRefine below. */
    embedUrl: HttpsUrl,
    title: z.string().min(1).nullable(),
  }),
  /**
   * ANY web page — the long tail no registry can ever finish enumerating.
   * There is no embed and no position API here: the room carries the LINK,
   * and each viewer's browser extension drives whatever <video>/<audio> that
   * page mounts on their own device (the `generic` provider in
   * apps/extension/src/providers.ts). A viewer without the extension sees the
   * item and the link, and nothing plays for them — which is what the UI must
   * say, because the alternative is a queue row that silently does nothing.
   */
  z.object({ kind: z.literal('page'), url: HttpsUrl }),
]);

/**
 * MediaRef = the kinds above, plus the one rule that needs two fields at once:
 * an `embed` must carry its embedUrl on ITS OWN provider's host.
 *
 * The pairing sits on the union rather than on the field because a zod field
 * refine cannot see a sibling — and it sits on the UNION rather than on the
 * embed object because `z.discriminatedUnion` in zod 3 takes ZodObjects only.
 * Hanging `.superRefine()` on an option yields a ZodEffects, and the union
 * then throws "Cannot read properties of undefined (reading 'kind')" while
 * building its discriminator map, i.e. every MediaRef parse in the product
 * dies rather than the bad embed. Verified against zod 3.25.76.
 */
export const MediaRef = MediaRefKinds.superRefine((ref, ctx) => {
  if (ref.kind !== 'embed') return;
  const origin = EMBED_PROVIDER_HOSTS[ref.provider];
  if (!startsWithFold(ref.embedUrl, origin)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['embedUrl'],
      message: `must be an https:// URL on ${origin}`,
    });
  }
});
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
  artworkUrl: WebUrl.nullable(),
  addedBy: UserId,
  votesToSkip: z.array(UserId),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const QueueItemInput = z.object({
  mediaRef: MediaRef,
  title: z.string().min(1).max(300),
  durationMs: z.number().int().nonnegative().nullable(),
  artworkUrl: WebUrl.nullable(),
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
  hlsUrl: WebUrl.nullable(),
  thumbnailUrl: WebUrl.nullable(),
  waveformUrl: WebUrl.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  createdAt: Timestamp,
});
export type MediaAsset = z.infer<typeof MediaAsset>;

export const MessageKind = z.enum(['text', 'gif', 'attachment', 'voice', 'system']);
export type MessageKind = z.infer<typeof MessageKind>;

export const MessageAttachment = z.object({
  assetId: AssetId,
  /** Not a formality: `chat.send` carries a whole MessageAttachment FROM the
   *  client (ws.ts) and the server stores it as given, so this string is
   *  attacker-chosen and the web renders a non-media attachment as
   *  `<a href={att.url} target="_blank">` — the one sink where 'javascript:'
   *  still runs on click in every current browser. */
  url: WebUrl,
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
  gifUrl: WebUrl.nullable(),
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
 * host's shared screen/tab track (over the room's relay — mesh or cf-sfu)
 * instead of Mode A mediaRef playback; when inactive they fall back to the
 * current PlaybackState.
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
