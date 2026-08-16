# K3 BRIEF — Gather API `chat` module (full chat surface)

You are implementing the **chat feature module** of the Gather Fastify API. The repo is a
pnpm/turbo TS-strict ESM monorepo. The service skeleton (app factory, WS hub, adapters,
auth) is DONE and FROZEN — you only create new files in the two owned directories below
and must conform to the skeleton exactly.

This brief has THREE PHASES. Implement ONLY the phase named in the prompt that invoked you.

## Hard rules

- Work from the current directory = `services/api` of the repo. All paths below are
  relative to it.
- You may ONLY create/modify files under:
  - `src/modules/chat/` (module source)
  - `test/chat/` (tests)
  - NOTHING else. Do not touch `src/modules/index.ts`, contracts, adapters, plugins,
    other packages, package.json, or config files.
- Do NOT run package installs. Every dependency you need is already installed:
  `fastify`, `zod`, `@gather/contracts`, `web-push` (+ `@types/web-push`), `ws`, `vitest`.
- TypeScript is STRICT with `exactOptionalPropertyTypes: true` and
  `noUncheckedIndexedAccess: true`, `moduleResolution: bundler` (imports WITHOUT `.js`
  extension, e.g. `import { AppError } from '../../lib/errors'`).
- ESLint: `@typescript-eslint/no-unused-vars` is an error (prefix intentionally unused
  with `_`). No `any` unless eslint-disabled the way existing tests do.
- Match existing repo style: file-top block comments explaining the file's role,
  `AppError` for every expected failure, `parseWith(schema, value)` for request
  validation, no default exports except the module entry (`src/modules/chat/index.ts`
  exports default + named, mirroring `src/modules/auth/index.ts`).
- Verification commands (run them if you can; they must pass):
  - `CI=1 pnpm typecheck`   (tsc --noEmit)
  - `CI=1 pnpm test`        (vitest run — NEVER bare `vitest`)
  - `CI=1 pnpm lint`
- Tests must be honest: no stubbing the code under test, no `expect(true)`.

## Frozen skeleton — what you build against

### Contracts (package `@gather/contracts`, import everything from it)

Relevant entity schemas (zod, types inferred with the same names):

```ts
// Message (this IS the stored MessageDoc shape; StorePort.messages holds these)
Message = {
  id: MessageId; roomId: RoomId; authorId: UserId;
  kind: 'text'|'gif'|'attachment'|'voice'|'system';
  body: string;                    // max 8000, markdown-lite stored RAW (sanitization is a client render concern)
  gifUrl: string|null; attachment: MessageAttachment|null;
  replyTo: MessageId|null; mentions: UserId[];
  reactions: Record<string, UserId[]>;   // emoji -> userIds
  pinned: boolean; editedAt: number|null; deletedAt: number|null;
  seq: number;                     // per-room MESSAGE seq (see "seq scopes" below)
  createdAt: number;
}
MessageAttachment = { assetId; url; mime; name; sizeBytes; width: number|null; height: number|null; durationMs: number|null }
ReadCursor = { roomId; userId; lastReadSeq; at }
RoomPolicies.chat: 'host'|'mods'|'everyone'
MemberRole = 'host'|'moderator'|'member'|'guest'
MediaAsset = { id; ownerId; filename; mime; sizeBytes; status: 'uploading'|'processing'|'ready'|'failed';
               hlsUrl; thumbnailUrl; waveformUrl; durationMs; error; createdAt }  // url fields string|null
Entitlements (contracts) has attachmentMaxMb — billing module isn't built yet; see attachments.ts.
```

Client WS events (already validated by the hub BEFORE your handler runs — the handler
receives a fully-typed event):

```ts
'chat.send'      payload { kind: 'text'|'gif'|'attachment'|'voice'; body: string; gifUrl: string|null;
                           attachment: MessageAttachment|null; replyTo: MessageId|null; mentions: UserId[] }
                 // schema already enforces: text needs non-empty body; gif needs gifUrl;
                 // attachment/voice need attachment. kind 'system' is NOT in the client enum —
                 // the hub rejects it with a VALIDATION error frame before any handler runs.
'chat.edit'      payload { messageId; body: string /* min 1 max 8000 */ }
'chat.delete'    payload { messageId }
'chat.react'     payload { messageId; emoji: string /* 1..32 */; op: 'add'|'remove' }
'chat.typing'    payload { typing: boolean }
'chat.read'      payload { lastReadSeq: number }
'chat.delivered' payload { lastDeliveredSeq: number }
'emote.burst'    payload { emoji: string; xPct: 0..100; yPct: 0..100 }
```

Server WS events you emit (payload types):

```ts
'chat.message'   Message          // persisted
'chat.updated'   Message          // persisted
'chat.deleted'   { messageId, deletedAt }            // persisted
'chat.reaction'  { messageId, emoji, userId, op }    // persisted
'chat.typing'    { userId, typing }                  // EPHEMERAL
'chat.read'      ReadCursor                          // persisted
'chat.delivered' { userId, lastDeliveredSeq, at }    // persisted
'emote.burst'    { userId, emoji, xPct, yPct }       // EPHEMERAL
```

REST schemas (from contracts): `ListMessagesQuery { beforeSeq?, limit (1..100, default 50) }`,
`ListMessagesResponse = { items: Message[]; nextCursor: string|null }`,
`SearchMessagesQuery { q (1..200), limit (1..50 default 20) }`, `SearchMessagesResponse = { items }`,
`PinMessageBody { messageId, pinned }`, `PinMessageResponse { message }`,
`UnfurlBody { url }`, `UnfurlResponse { url, title, description, imageUrl, siteName }` (nullables),
`SearchGifsQuery { q (1..100), limit (1..50 default 20) }`,
`SearchGifsResponse { results: { id, url, previewUrl, width, height, title|null }[] }`,
`CreateUploadBody { filename, mime, sizeBytes>0 }`,
`CreateUploadResponse { assetId, uploadId, parts: { partNumber, url, startByte?, endByte? }[] }`,
`CompleteUploadBody { assetId, uploadId, parts: { partNumber, etag }[] }`.

Error codes (`AppError(code, message)` from `../../lib/errors`, statuses):
UNAUTHORIZED 401, FORBIDDEN 403, NOT_FOUND 404, RATE_LIMITED 429, ROOM_POLICY 403,
VALIDATION 400, QUOTA_EXCEEDED 413, CONFLICT 409, INTERNAL 500.

### Module seam (`src/modules/types.ts`, FROZEN — import types from `'../types'`)

```ts
interface AuthContext { userId: UserId; sessionId: string; guest: boolean; guestRoomId: RoomId|null }
interface Deps { config: AppConfig; log: FastifyBaseLogger; store: StorePort; bus: BusPort; events: EventWriter; hub: HubApi }
interface EventWriter {
  emit(roomId, type, payload): Promise<ServerEventOf<T>>;      // persists + assigns EVENT seq + fans out
  emitEphemeral(roomId, type, payload): void;                  // seq 0, no persistence
  emitDirect(roomId, targetUserId, type, payload): void;       // seq 0, one user only
}
interface HandlerContext { deps: Deps; roomId: RoomId; auth: AuthContext; member: Member; reply(type, payload): void }
interface ModulePlugin { name: string; routes?: FastifyPluginAsync; wsHandlers?: HandlerMap }
```

Handlers may be async; thrown `AppError` becomes an ephemeral `error` event frame
`{ type:'error', seq:0, payload:{ code, message } }` on the offending socket (the hub does
this). Routes get deps via `app.deps`, identity via `requireAuth(request)` from
`'../../plugins/auth'`, validation via `parseWith` from `'../../plugins/error-mapper'`.

### Store port (`src/adapters/ports.ts`, FROZEN — import from `'../../adapters/ports'`)

- `store.messages: DocCollection<Message>`; `store.rooms`, `store.members`,
  `store.users`, `store.cursors`, `store.assets`, `store.subscriptions`, `store.pushSubs`.
- `DocCollection<T>`: `findById`, `findOne(filter)`, `findMany(filter, {sort?, limit?, skip?})`,
  `count`, `insertOne` (throws AppError CONFLICT on dup), `updateOne(filter, patch)` —
  SHALLOW top-level merge, returns updated doc or null — `deleteOne`, `deleteMany`.
  Filter DSL subset: literals + `$eq $ne $lt $lte $gt $gte $in $nin $exists`. Multi-step
  read-modify-write is NOT transactional.
- `store.nextSeq(scope): Promise<number>` — atomic per-scope counter, first call = 1.
- `store.searchMessages(roomId, query, limit)` — Mongo text index / memory substring
  fallback; excludes deleted; newest first. USE THIS for search, don't reimplement.
- `MemberDoc = Member & { id: string; muted: boolean }`, key `memberDocId(roomId, userId)`
  (exported helper). `muted` = per-room notification mute.
- `CursorDoc { id; roomId; userId; kind: 'read'|'delivered'; lastSeq; at }`, key
  `cursorDocId(roomId, userId, kind)` (exported helper).
- `AssetDoc = MediaAsset & { storageKey: string|null; uploadId: string|null }`.
- `SubscriptionDoc { id /* = userId */; userId; plan:'free'|'premium'; status:'active'|'past_due'|'canceled'|'none'; ... }`.
- `PushSubDoc { id; userId; platform:'web'|'expo'; endpoint: string|null; keys: {p256dh,auth}|null; expoPushToken: string|null; createdAt }`.
- `RoomDoc = Room & { playback; queue; restream; master }` — server-only snapshot fields;
  NEVER leak them in responses.

**Seq scopes (important design decision, follow exactly):**
- EVENT seq (envelope seq the hub broadcasts) is owned by `events.emit` — scope `room:${roomId}`. Never call nextSeq with that scope yourself.
- MESSAGE seq (`Message.seq`, used by ListMessages pagination and by read/delivered
  cursors) is a SEPARATE counter: `store.nextSeq('chat:' + roomId)`.

### Misc helpers

- `newId()` from `'../../lib/tokens'` → uuid string.
- `AppConfig` from `'../../config'`; fields you need: `config.tenorApiKey: string|null`,
  `config.vapid: { publicKey: string|null; privateKey: string|null; subject: string }`,
  `config.s3: { endpoint; accessKey; secretKey; bucket; publicBaseUrl }`.
- Branded ids: contracts ids are branded strings (`UserId` etc). When you build ids from
  plain strings, cast (`as UserId`) exactly like the skeleton does; `newId() as MessageId`.
- `exactOptionalPropertyTypes`: to add an optional key conditionally use spread:
  `...(notice === null ? {} : { notice })`.

---

## PHASE 1 — module source (`src/modules/chat/*.ts`)

Create exactly these files.

### 1. `src/modules/chat/mentions.ts`

```ts
export interface MentionCandidate { userId: UserId; displayName: string }
export function extractMentions(
  body: string,
  clientMentions: readonly UserId[],
  members: readonly MentionCandidate[],
): UserId[]
```
Server-side mention extraction (never trust the client list blindly):
1. Build a Set of member userIds.
2. Start with client-sent mentions filtered to actual members (dedup, keep order).
3. Add every `<@userId>` token in `body` (regex `/<@([^>\s]+)>/g`) whose id is a member.
4. Add every member whose displayName (length >= 2) appears as `@Name` in the body:
   case-insensitive regex `@` + escaped displayName + negative lookahead `(?![\w])`.
   Escape regex metachars in the name.
5. Return deduped array (first-seen order).

### 2. `src/modules/chat/limiter.ts`

```ts
/** Sliding-window rate limiter (in-memory, per key). */
export class SlidingWindowLimiter {
  constructor(max: number, windowMs: number)
  /** True = allowed (consumes a slot); false = limited. `now` injectable for tests. */
  allow(key: string, now?: number): boolean
}
```
Map<string, number[]> of timestamps; prune entries older than windowMs on each call;
delete empty keys so the map can't grow unbounded.

### 3. `src/modules/chat/notify.ts`

```ts
export interface MentionNotification { roomId: RoomId; messageId: MessageId; fromUserId: UserId; toUserIds: readonly UserId[]; preview: string }
export interface InviteNotification { roomId: RoomId; fromUserId: UserId; toUserId: UserId }
export interface RoomStartedNotification { roomId: RoomId; toUserIds: readonly UserId[] }
export interface NotifyPort {
  mention(n: MentionNotification): Promise<void>;
  invite(n: InviteNotification): Promise<void>;
  roomStarted(n: RoomStartedNotification): Promise<void>;
}
export type WebPushSend = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>;
export function createNotifier(deps: Pick<Deps, 'config'|'store'|'log'>, sendImpl?: WebPushSend): NotifyPort
```
- If `config.vapid.publicKey` or `privateKey` is null AND no `sendImpl` injected →
  return a no-op port (all methods resolve doing nothing).
- Otherwise: default `sendImpl` uses `import webPush from 'web-push'`;
  call `webPush.setVapidDetails(subject, publicKey, privateKey)` once in the factory,
  and send via `webPush.sendNotification({ endpoint, keys }, payload)`.
- Delivery helper: for each target userId → look up `members.findById(memberDocId(roomId, userId))`;
  skip when `member?.muted === true` (mention/roomStarted only — invite targets may not be
  members yet, skip the mute check for invite); fetch
  `pushSubs.findMany({ userId, platform: 'web' })`; for each sub with endpoint+keys,
  `await sendImpl(...)` inside try/catch: on error with `statusCode` 404 or 410 delete the
  sub (`pushSubs.deleteOne({ id: sub.id })`), otherwise `log.warn` and continue. NEVER throw.
- `mention`: drop `fromUserId` from targets. Payload = JSON.stringify of
  `{ kind:'mention', roomId, roomName, fromDisplayName, messageId, preview }` where
  roomName from `rooms.findById` (fallback ''), fromDisplayName from `users.findById`
  (fallback 'someone'), preview = `preview.slice(0, 140)`.
- `invite` payload `{ kind:'invite', roomId, roomName, fromDisplayName }`;
  `roomStarted` payload `{ kind:'room-started', roomId, roomName }`.

### 4. `src/modules/chat/unfurl.ts`  (SSRF-guarded OG fetch)

```ts
export interface ResolvedAddress { address: string; family: number }
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;
export interface UnfurlerOptions {
  allowPrivateAddresses?: boolean;  // default false — ONLY tests set true
  timeoutMs?: number;               // default 3000 (one deadline across all redirects)
  maxBytes?: number;                // default 512 * 1024
  maxRedirects?: number;            // default 3
  fetchImpl?: typeof fetch;         // default globalThis.fetch
  lookupImpl?: LookupFn;            // default node:dns/promises lookup(hostname, { all: true })
}
export type Unfurler = (url: string) => Promise<UnfurlResponse>;
export function createUnfurler(options?: UnfurlerOptions): Unfurler
export function isPrivateIp(ip: string): boolean
export function parseOgTags(html: string): { title: string|null; description: string|null; imageUrl: string|null; siteName: string|null }
```

`isPrivateIp` — FAIL CLOSED (anything unparseable counts as private). IPv4 private/reserved:
`0.*`, `10.*`, `100.64/10` (100.64–100.127), `127.*`, `169.254.*`, `172.16/12` (172.16–172.31),
`192.0.0.*`, `192.0.2.*`, `192.168.*`, `198.18/15` (198.18–198.19), `198.51.100.*`,
`203.0.113.*`, first octet >= 224. IPv6 (lowercase the input): `::`, `::1`, prefixes
`fc`/`fd` (fc00::/7), `fe8`/`fe9`/`fea`/`feb` (fe80::/10), `::ffff:` mapped → recurse on
the v4 tail, `64:ff9b:` prefix → private (NAT64 can smuggle v4). Everything else public.

Guard, applied to EVERY hop (initial URL and every redirect target):
1. `new URL(raw)`; protocol must be `http:` or `https:` else `AppError('VALIDATION','only http/https urls can be unfurled')`.
2. hostname `localhost` or `*.localhost` → reject.
3. If hostname is a literal IP (`net.isIP`) → `isPrivateIp` check.
   Else resolve with `lookupImpl` (wrap lookup failure → `AppError('VALIDATION','could not resolve host')`);
   the result must be non-empty and EVERY address must pass `isPrivateIp` — any private
   address rejects with `AppError('VALIDATION','url resolves to a private address')`.
   Skip checks 2–3 entirely when `allowPrivateAddresses`.
4. `fetchImpl(url, { redirect:'manual', signal, headers: { 'user-agent':'gather-unfurl/1.0', accept:'text/html,*/*;q=0.5' } })`.
5. Status 301/302/303/307/308 with a `location` header → resolve `new URL(location, current)`,
   count hops (over maxRedirects → `AppError('VALIDATION','too many redirects')`), loop back to step 1.
6. Other non-2xx → `AppError('VALIDATION', 'unfurl target returned ' + status)`.
7. Read the body through `response.body.getReader()` accumulating at most `maxBytes`
   bytes; once the cap is reached, `cancel()` the reader and parse the truncated buffer
   (a page bigger than the cap still unfurls from its first 512KB).
8. Timeout: one `AbortController` armed with `setTimeout(timeoutMs)` (unref'd, cleared in
   finally) covering the entire operation; on abort or network error →
   `AppError('VALIDATION','unfurl failed')` / `'unfurl timed out'` for abort.
9. If content-type header exists and doesn't include `text/html`, return all-null fields
   (with `url` = final URL).
10. Parse OG tags; return `{ url: finalUrl, title, description, imageUrl, siteName }`.
    `imageUrl` resolved against the final URL and must itself be http(s), else null.

`parseOgTags`: scan `<meta ...>` tags with a global regex; for each tag extract
`property`/`name` and `content` attributes (attribute order must not matter — extract the
two attributes with separate regexes against the tag text; quotes single or double).
Recognize `og:title`, `og:description`, `og:image`, `og:site_name`; fall back to
`<title>...</title>` text for title, and `<meta name="description">` for description.
Decode entities `&amp; &lt; &gt; &quot; &#39;` + numeric `&#NNN;`/`&#xHH;`.

### 5. `src/modules/chat/gifs.ts`

```ts
export interface GifSearchResult { results: SearchGifsResponse['results']; notice: string|null }
export async function searchGifs(
  args: { config: AppConfig; log: FastifyBaseLogger; fetchImpl?: typeof fetch },
  q: string, limit: number,
): Promise<GifSearchResult>
```
- `config.tenorApiKey === null` → `{ results: [], notice: 'gif search is disabled: TENOR_API_KEY is not configured' }`.
- Else GET `https://tenor.googleapis.com/v2/search?key=...&q=...&limit=...&media_filter=gif,tinygif`
  (encodeURIComponent the query). Non-OK response → `AppError('INTERNAL','gif search upstream failed')`.
  Map `results[]` defensively (unknown-typed JSON): id = String(r.id), url =
  `media_formats.gif.url`, previewUrl = `media_formats.tinygif.url ?? gif.url`,
  `[width, height] = media_formats.gif.dims`, title = `content_description ?? null`.
  Skip entries missing a usable url or positive integer dims. `notice: null`.

### 6. `src/modules/chat/attachments.ts`

```ts
export const FREE_ATTACHMENT_MAX_MB = 25;
export const PREMIUM_ATTACHMENT_MAX_MB = 200;
export async function attachmentMaxMb(store: StorePort, userId: string): Promise<number>
export function sanitizeFilename(name: string): string
export function presignPutUrl(s3: AppConfig['s3'], key: string, expiresSec?: number, now?: Date): string
export async function createAttachmentTicket(deps: Deps, roomId: RoomId, userId: UserId, body: CreateUploadBody): Promise<CreateUploadResponse>
export async function completeAttachment(deps: Deps, userId: UserId, body: CompleteUploadBody): Promise<{ asset: MediaAsset; url: string }>
```
- `attachmentMaxMb`: `subscriptions.findById(userId)`; premium+active → PREMIUM cap, else FREE.
  (The billing module will own real entitlements later; this constant pair is the
  documented interim source of truth for chat.)
- `sanitizeFilename`: replace every char outside `[A-Za-z0-9._-]` with `_`, truncate to
  100 chars; if the result is empty or only dots → `'file'`.
- `presignPutUrl` — AWS SigV4 **query presign** for a path-style PUT (MinIO-compatible),
  region `us-east-1`, service `s3`, implemented with `node:crypto` only:
  - `host` = URL(endpoint).host; canonicalUri = `/${bucket}/` + key segments each
    S3-uriEncoded (encodeURIComponent, then also %-encode `!'()*`).
  - amzDate `YYYYMMDDTHHMMSSZ` from `now` (default new Date()); dateStamp = first 8 chars.
  - credential = `${accessKey}/${dateStamp}/us-east-1/s3/aws4_request`.
  - Query params in this exact sorted order: `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=<uriEncoded credential>`, `X-Amz-Date`, `X-Amz-Expires=<expiresSec, default 900>`,
    `X-Amz-SignedHeaders=host`.
  - canonicalRequest = `PUT\n{canonicalUri}\n{canonicalQuery}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD`.
  - stringToSign = `AWS4-HMAC-SHA256\n{amzDate}\n{dateStamp}/us-east-1/s3/aws4_request\n{sha256hex(canonicalRequest)}`.
  - signingKey = HMAC chain `('AWS4'+secretKey) -> dateStamp -> 'us-east-1' -> 's3' -> 'aws4_request'`;
    signature = hex HMAC(stringToSign).
  - Return `${endpoint}/${bucket}/${encodedKey}?${canonicalQuery}&X-Amz-Signature=${signature}`.
- `createAttachmentTicket`: cap = await attachmentMaxMb; `sizeBytes > cap * 1024 * 1024` →
  `AppError('QUOTA_EXCEEDED', 'attachment exceeds the ' + cap + ' MB plan limit')`.
  assetId/uploadId = `newId()`; storageKey = `chat/${roomId}/${assetId}/${sanitizeFilename(filename)}`;
  insert AssetDoc `{ ...MediaAsset fields, status:'uploading', hlsUrl/thumbnailUrl/waveformUrl/durationMs/error: null, storageKey, uploadId }`.
  Return `{ assetId, uploadId, parts: [{ partNumber: 1, url: presignPutUrl(config.s3, storageKey), startByte: 0, endByte: sizeBytes }] }`.
- `completeAttachment`: findById → null = NOT_FOUND 'asset not found'; ownerId mismatch →
  FORBIDDEN; uploadId mismatch → VALIDATION 'uploadId does not match';
  status 'ready' already → idempotent success. Else update `{ status: 'ready' }`.
  url = `${config.s3.publicBaseUrl}/${storageKey}`. Serialize the asset to the contracts
  `MediaAsset` shape (pick fields explicitly — NEVER include storageKey/uploadId).

### 7. `src/modules/chat/service.ts`

`export class ChatService { constructor(private readonly deps: Deps, notifier?: NotifyPort) }`
(default `notifier = createNotifier(deps)`; keep the instance). Also holds
`typingLimiter = new SlidingWindowLimiter(1, 2000)` and
`emoteLimiter = new SlidingWindowLimiter(5, 1000)`.

Shared private helpers:
- `freshMember(roomId, userId)` → members.findById(memberDocId(...)); null → FORBIDDEN
  'not a member'; banned → FORBIDDEN 'banned'; returns MemberDoc.
- `getRoom(roomId)` → rooms.findById; null → NOT_FOUND 'room not found'.
- `roleSatisfies(level: RoomPolicyLevel, role: MemberRole)`: everyone → true;
  mods → host|moderator; host → host only.
- `requireChatPolicy(room, role)` → violation = `AppError('ROOM_POLICY', 'room policy does not allow you to chat')`.
- `isMod(role)` = host|moderator.
- `getMessage(roomId, messageId)` → messages.findById; null OR doc.roomId !== roomId →
  NOT_FOUND 'message not found'.

Public API (all role checks RE-READ the store via freshMember — roles change mid-connection):

- `async send(roomId, auth: AuthContext, payload: ClientChatSend['payload']): Promise<Message>`
  1. member = freshMember; room = getRoom; requireChatPolicy(room, member.role).
  2. kind 'voice' requires `attachment.durationMs` non-null → else VALIDATION
     'voice notes require attachment.durationMs'.
  3. If `replyTo` non-null: target must exist in this room (getMessage → remap NOT_FOUND
     to `AppError('VALIDATION','replyTo message not found')`).
  4. mentions: fetch room members (`members.findMany({ roomId })`), then users
     (`users.findById` per member — or one findMany with `$in` on ids) to build
     MentionCandidates; `extractMentions(body, payload.mentions, candidates)`.
  5. `seq = await store.nextSeq('chat:' + roomId)`; build Message (id = newId() as
     MessageId, reactions {}, pinned false, editedAt/deletedAt null, createdAt Date.now(),
     body stored RAW). insertOne, then `await events.emit(roomId, 'chat.message', message)`.
  6. Mention push, fire-and-forget (never block/throw):
     `void this.notifier.mention({...}).catch(log.warn)` with preview = body.
- `async edit(roomId, auth, messageId, body): Promise<Message>` — freshMember; message =
  getMessage; deleted → CONFLICT 'message was deleted'; author only (even host/mod cannot
  edit others) → FORBIDDEN 'only the author can edit a message'. Re-extract mentions from
  the new body (same as send, client list = existing mentions). Patch
  `{ body, mentions, editedAt: Date.now() }` via updateOne({ id }), emit 'chat.updated'
  with the updated doc. (No push on edit.)
- `async remove(roomId, auth, messageId)` — freshMember; message = getMessage; already
  deleted → idempotent return of `{ messageId, deletedAt: existing }` WITHOUT re-emitting.
  Allowed when author OR isMod(member.role) else FORBIDDEN. Tombstone patch:
  `{ body: '', gifUrl: null, attachment: null, mentions: [], reactions: {}, pinned: false, deletedAt: now }`;
  emit 'chat.deleted' `{ messageId, deletedAt: now }`.
- `async react(roomId, auth, messageId, emoji, op)` — freshMember; message = getMessage;
  deleted → CONFLICT. Compute next per-emoji set (add: append userId if absent; remove:
  filter; delete the key when empty). If NOTHING changed → return without emitting.
  Patch `{ reactions }`, emit 'chat.reaction' `{ messageId, emoji, userId, op }`.
- `typing(roomId, auth, typing: boolean): void` — `typing === true` must pass
  `typingLimiter.allow(roomId + ':' + auth.userId)` or be DROPPED silently;
  `typing === false` always passes (stop signals must not be lost). Relay
  `events.emitEphemeral(roomId, 'chat.typing', { userId, typing })`. No persistence.
- `emote(roomId, auth, payload): void` — `emoteLimiter.allow(...)` or DROP silently;
  `events.emitEphemeral(roomId, 'emote.burst', { userId, emoji, xPct, yPct })`.
- `async read(roomId, auth, lastReadSeq)` / `async delivered(roomId, auth, lastDeliveredSeq)`:
  - Clamp requested seq to the room's message tip (latest Message.seq via findMany sort
    seq desc limit 1; tip 0 when no messages).
  - Upsert CursorDoc at `cursorDocId(roomId, userId, kind)` FORWARD-ONLY: existing lastSeq >=
    requested → no-op (no event). Insert race: catch CONFLICT → re-read + updateOne.
  - On a read advance: emit persisted 'chat.read' with ReadCursor payload, THEN enforce the
    invariant **delivered >= read**: advance the delivered cursor to the same seq if it's
    behind, emitting 'chat.delivered' too.
  - On a delivered advance: emit 'chat.delivered' `{ userId, lastDeliveredSeq, at }`.
- `async listMessages(roomId, query: ListMessagesQuery): Promise<ListMessagesResponse>` —
  filter `{ roomId }` plus `seq: { $lt: beforeSeq }` when given; sort seq DESC,
  fetch `limit + 1`; if more than `limit` remain, slice and set nextCursor =
  String(last returned item's seq) else null. Tombstones ARE included.
- `async search(roomId, q, limit)` → `store.searchMessages(roomId, q, limit)`.
- `async pin(roomId, auth, messageId, pinned): Promise<Message>` — freshMember; MOD-GATED:
  `isMod(role)` else FORBIDDEN 'pinning requires moderator'. message = getMessage; deleted →
  CONFLICT. No-op pin state → return current doc without emitting. Patch `{ pinned }`,
  emit 'chat.updated'.
- `async listPinned(roomId): Promise<Message[]>` — findMany `{ roomId, pinned: true, deletedAt: null }`
  sort seq DESC.

### 8. `src/modules/chat/routes.ts`

`export const chatRoutes: FastifyPluginAsync` (registered without prefix, full paths).
Build `const service = new ChatService(app.deps)` — BUT the module must share ONE service
instance between routes and WS handlers (rate-limiter + notifier state): export from
`index.ts` a `serviceFor(deps: Deps): ChatService` backed by a `WeakMap<Deps, ChatService>`
and use it here too (`const service = serviceFor(app.deps)`).

Room-scope helper used by all room routes:
```ts
async function requireRoomMember(app, request, roomId): Promise<{ auth; room: RoomDoc; member: MemberDoc }>
```
`requireAuth(request)`; guests are room-scoped: `auth.guestRoomId !== null && auth.guestRoomId !== roomId`
→ FORBIDDEN 'guest token is room-scoped'; room null → NOT_FOUND; member null → FORBIDDEN
'not a member'; banned → FORBIDDEN 'banned'.

Routes:
- `GET /rooms/:roomId/messages` — member gate; `parseWith(ListMessagesQuery, request.query)`;
  → `service.listMessages` (returns `{ items, nextCursor }`).
- `GET /rooms/:roomId/messages/search` — member gate; SearchMessagesQuery → `{ items }`.
- `POST /rooms/:roomId/messages/pin` — member gate; PinMessageBody →
  `service.pin(...)` → `{ message }`.
- `GET /rooms/:roomId/pins` — member gate → `{ items: await service.listPinned(roomId) }`.
  (No contracts schema exists for a pin list yet — reuse the SearchMessagesResponse shape.)
- `POST /unfurl` — `requireAuth` only; UnfurlBody; module-level
  `const unfurl = createUnfurler()` (strict defaults, no private addresses) → UnfurlResponse.
- `GET /gifs/search` — `requireAuth`; SearchGifsQuery; `searchGifs({ config, log }, q, limit)`
  → `{ results, ...(notice === null ? {} : { notice }) }` (extra key allowed; response
  schemas strip it client-side).
- `POST /rooms/:roomId/attachments` — member gate + chat policy (re-use service helpers or
  inline: roleSatisfies(room.policies.chat, member.role) else ROOM_POLICY);
  `parseWith(CreateUploadBody, ...)` → `createAttachmentTicket` → CreateUploadResponse.
- `POST /rooms/:roomId/attachments/complete` — member gate; CompleteUploadBody →
  `completeAttachment(deps, auth.userId, body)` → `{ asset, url }` (url is an extra
  convenience key over CompleteUploadResponse).

### 9. `src/modules/chat/index.ts`

Mirrors `src/modules/auth/index.ts` but with wsHandlers. Exports:
`serviceFor(deps)` (WeakMap cache), named `chatModule`, `export default chatModule`.

```ts
const chatModule: ModulePlugin = {
  name: 'chat',
  routes: chatRoutes,
  wsHandlers: {
    'chat.send':      async (event, ctx) => { await serviceFor(ctx.deps).send(ctx.roomId, ctx.auth, event.payload); },
    'chat.edit':      async (event, ctx) => { await serviceFor(ctx.deps).edit(ctx.roomId, ctx.auth, event.payload.messageId, event.payload.body); },
    'chat.delete':    async (event, ctx) => { await serviceFor(ctx.deps).remove(ctx.roomId, ctx.auth, event.payload.messageId); },
    'chat.react':     async (event, ctx) => { await serviceFor(ctx.deps).react(ctx.roomId, ctx.auth, event.payload.messageId, event.payload.emoji, event.payload.op); },
    'chat.typing':    (event, ctx) => { serviceFor(ctx.deps).typing(ctx.roomId, ctx.auth, event.payload.typing); },
    'chat.read':      async (event, ctx) => { await serviceFor(ctx.deps).read(ctx.roomId, ctx.auth, event.payload.lastReadSeq); },
    'chat.delivered': async (event, ctx) => { await serviceFor(ctx.deps).delivered(ctx.roomId, ctx.auth, event.payload.lastDeliveredSeq); },
    'emote.burst':    (event, ctx) => { serviceFor(ctx.deps).emote(ctx.roomId, ctx.auth, event.payload); },
  },
};
```

Do NOT register the module in `src/modules/index.ts` — the orchestrator does that.

Phase 1 exit check: `CI=1 pnpm typecheck` and `CI=1 pnpm lint` pass (existing tests
still green: `CI=1 pnpm test`).

---

## PHASE 2 — tests part A (`test/chat/`)

Use the EXISTING shared helpers `test/helpers.ts` (`makeApp`, `testConfig`, `seedRoom`,
`addMember`, `signupUser`) — study `test/ws-hub.test.ts` for the socket test style and
copy its socket utilities into a new shared file:

### `test/chat/chat-helpers.ts`
Exports: `openSocket`, `nextMessage`, `collectMessages`, `closeCode`, `clientFrame`
(same implementations as ws-hub.test.ts), plus:
- `expectSilence(sock, ms=200)` → asserts nextMessage times out.
- `sendPayload(kind, overrides)` → builds a full chat.send payload
  `{ kind:'text', body:'hi', gifUrl:null, attachment:null, replyTo:null, mentions:[], ...overrides }`.
- `wsUrl(port, roomId, token)`.
- `async connectMember(app, store, port, email, roomId, role)` → signupUser + addMember +
  open socket; returns `{ user, accessToken, sock }`.
- `attachment(overrides)` → valid MessageAttachment fixture
  (`assetId:'a1', url:'https://cdn.example/a1.png', mime:'image/png', name:'a1.png', sizeBytes:123, width:null, height:null, durationMs:null`).

NOTE for chat module registration in tests: the orchestrator wires the module into
`src/modules/index.ts`; tests just use `makeApp()` and the handlers/routes are live.
Write tests assuming that (the orchestrator adds the line before running them).

App lifecycle per test file: same beforeEach/afterEach pattern as ws-hub.test.ts
(makeApp → listen on port 0 → track sockets → close app).

### `test/chat/lifecycle.test.ts`
- **send text broadcast + persistence**: two member sockets; A sends chat.send text with
  markdown-lite body `'**bold** _it_ `code` <script>x</script> https://ex.com'`; BOTH
  sockets receive `chat.message`; `Message.parse(frame.payload)` (import from contracts);
  body stored RAW (exact string equality); `payload.seq === 1`; authorId = A. Then REST
  `GET /rooms/:id/messages` shows it.
- **message seq increments**: second send → payload.seq 2.
- **reply**: send with `replyTo` = first message id → stored; `replyTo: 'nope'` →
  ephemeral error frame code VALIDATION.
- **gif**: kind gif with gifUrl null → error frame VALIDATION (hub schema); with
  `gifUrl:'https://media.tenor.com/x.gif'` → broadcast kind gif.
- **voice**: kind voice with attachment(durationMs:null) → error VALIDATION (service);
  with durationMs 4200 → broadcast kind voice, attachment.durationMs 4200.
- **system kind rejected at the schema**: raw frame kind 'system' → error frame VALIDATION.
- **edit**: author edits → both sockets get `chat.updated`; body updated; editedAt number;
  Message.parse passes. Editing a nonexistent message → error NOT_FOUND.
- **delete tombstone**: author deletes → `chat.deleted` with messageId + deletedAt; REST
  list shows the message with deletedAt set, body '', attachment null, reactions {};
  editing it now → error CONFLICT; reacting → error CONFLICT; second delete → NO second
  chat.deleted broadcast (expectSilence).
- **reactions**: A and B both react 👍 add → two chat.reaction frames; REST list shows
  reactions `{'👍': [A, B]}` (order-insensitive check); duplicate add from A → expectSilence;
  remove from A → frame op remove + doc shows only B; remove B → emoji key gone.
- **pagination**: seed 7 texts; REST limit=3 → seqs [7,6,5], nextCursor '5';
  beforeSeq=5&limit=3 → [4,3,2] cursor '2'; beforeSeq=2 → [1] cursor null.
- **mentions**: member with displayName set via
  `store.users.updateOne({ id }, { displayName: 'Bianca' })`; A sends `'@Bianca hello'` →
  message.mentions = [biancaId]; `<@userId>` token form also lands; client-sent mentions
  containing a NON-member id are filtered out; client-sent valid member id is kept.

### `test/chat/permissions.test.ts`
- **chat policy**: set `rooms.updateOne({ id }, { policies: { ...room.policies, chat:'mods' } })`
  (read the doc first; policies is replaced whole — shallow merge). member send → error
  frame ROOM_POLICY; moderator + host send OK. Policy 'host' → moderator blocked, host OK.
- **edit matrix**: author OK; host editing member's message → FORBIDDEN; moderator → FORBIDDEN.
- **delete matrix**: author OK; moderator OK; host OK; unrelated member → FORBIDDEN.
- **pin REST matrix**: member → 403; moderator → 200 + `chat.updated` broadcast with
  pinned true; host unpin → 200 pinned false; pin unknown message → 404; pin a deleted
  message → 409; non-member → 403; unauthenticated → 401.
- **pins list**: pin 2 of 3 messages → GET /rooms/:id/pins returns exactly those two,
  newest-seq first; deleting a pinned message removes it from the pins list.
- **guest room-scoping (REST)**: create guest via POST /auth/guest for room A (see
  ws-hub.test.ts); GET room B messages with the guest token → 403.
- **banned member**: ban via `members.updateOne`, REST list → 403.

### `test/chat/cursors.test.ts`
Seed 3 messages first (tip seq 3), then:
- **read advance broadcasts**: B sends chat.read lastReadSeq 2 → both sockets receive
  persisted `chat.read` (seq > 0) with payload `{ roomId, userId: B, lastReadSeq: 2, at }`
  AND a `chat.delivered` with lastDeliveredSeq 2 (invariant delivered >= read).
  Store check: cursors `cursorDocId(roomId, B, 'read')` lastSeq 2; delivered doc lastSeq 2.
- **delivered alone**: C sends chat.delivered 1 → exactly one chat.delivered frame for C,
  NO chat.read frame; store: delivered 1, no read cursor doc.
- **monotonic**: B re-sends chat.read 1 → expectSilence; store still 2.
- **delivered never regresses below read**: B sends chat.delivered 1 → expectSilence
  (delivered already 2 via invariant).
- **clamp to tip**: B sends chat.read 999 → broadcast lastReadSeq 3 (tip), store 3.
- **read > delivered upgrade path**: C (delivered 1, read 0) sends chat.read 3 →
  chat.read(3) AND chat.delivered(3) both broadcast.

Phase 2 exit: `CI=1 pnpm test` green, `CI=1 pnpm typecheck`, `CI=1 pnpm lint`.

---

## PHASE 3 — tests part B (`test/chat/`)

### `test/chat/search.test.ts`
- Seed messages `'alpha beta'`, `'Beta GAMMA'`, `'delta'`; delete the 2nd; search q='beta'
  → only the first (deleted excluded); case-insensitive (q='ALPHA' hits); limit respected
  (seed 3 matching, limit 2 → 2 results, newest first by seq); non-member → 403;
  q missing → 400.
- **gif fallback**: default testConfig (tenorApiKey null) → GET /gifs/search?q=cat → 200
  `{ results: [] }` with a `notice` string mentioning TENOR_API_KEY. Unauthenticated → 401.
- **tenor mapping unit test**: call `searchGifs` directly with
  `config: testConfig({ tenorApiKey: 'k' })`, a fake fetchImpl returning tenor-shaped JSON
  (2 good results + 1 missing media_formats — skipped); assert
  `SearchGifsResponse.parse({ results })` passes and the mapping (id/url/previewUrl/dims/title);
  assert the fetch URL contains `key=k` and the encoded query. Upstream 500 → rejects
  with AppError INTERNAL.

### `test/chat/unfurl.test.ts`
Route-level SSRF rejections (real route, default guard): POST /unfurl with each of
`http://169.254.169.254/latest/meta-data/`, `http://10.0.0.5/x`, `http://192.168.1.1/`,
`http://127.0.0.1:9/`, `http://localhost/x`, `http://[::1]/`, `http://100.64.0.1/` → ALL 400.
`ftp://example.com/x` → 400. Unauthenticated → 401.

Unit tests against `createUnfurler` (import from `../../src/modules/chat/unfurl`):
- Local fixture server (`node:http`, 127.0.0.1, port 0) + `allowPrivateAddresses: true`:
  - OG page (og:title/description/image/site_name, entities `&amp;` etc, single+double
    quotes, content-before-property attribute order on one tag) → all fields parsed,
    entities decoded, relative og:image resolved absolute.
  - Fallback: page with only `<title>` + `<meta name="description">`.
  - Redirect chain `/a` →302 relative `/b` →302 absolute → OG page: resolves, returned
    `url` is the FINAL url. Chain of 4 redirects → rejects 'too many redirects'.
  - Timeout: handler that never responds + `timeoutMs: 100` → rejects (message contains
    'timed', AppError VALIDATION).
  - Size cap: page whose og:title sits in the first 500 bytes followed by ~2MB of junk,
    `maxBytes: 1024` → resolves with the title (truncated parse works, no hang); an
    og:description placed AFTER the cap → description null (proves the cap).
- Injected-transport tests (no sockets): `lookupImpl` mapping
  `public.example → 93.184.216.34`, `internal.example → 10.0.0.9`; fake `fetchImpl`
  counting calls:
  - **redirect-to-private (IP literal)**: fetch#1 returns
    `new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/secret' } })`
    → rejects 'private', fetchImpl called exactly ONCE (the private hop is never fetched).
  - **redirect-to-private (DNS)**: location `http://internal.example/` → same outcome.
  - **DNS-private direct**: `http://internal.example/` rejects before any fetch (0 calls).
- `isPrivateIp` matrix: private → `10.0.0.1, 172.16.5.5, 172.31.255.255, 192.168.0.1,
  169.254.169.254, 127.0.0.1, 0.0.0.0, 100.64.1.1, 100.127.0.1, 192.0.0.8, 192.0.2.1,
  198.18.3.4, 198.51.100.7, 203.0.113.9, 224.0.0.1, 255.255.255.255, ::1, ::,
  fe80::1, fc00::1, fd12:3456::1, ::ffff:10.0.0.1, ::ffff:192.168.1.1, 64:ff9b::a00:1, not-an-ip`;
  public → `8.8.8.8, 1.1.1.1, 93.184.216.34, 100.128.0.1, 172.32.0.1, 198.20.0.1,
  2606:4700::1111, 2001:4860:4860::8888, ::ffff:8.8.8.8`.

### `test/chat/ratelimit.test.ts`
- `SlidingWindowLimiter` unit: max 5/1000ms with injected `now` — 5 allowed, 6th blocked,
  allowed again at now+1001; keys independent; max 1/2000ms blocks the 2nd at +1999,
  allows at +2001.
- **typing over WS**: A sends typing:true twice back-to-back → observer B receives exactly
  ONE chat.typing frame (then expectSilence); typing:false right after still delivered
  (stop bypasses the limiter); typing frames have seq 0; replay
  `GET /rooms/:id/events?since=0` contains NO chat.typing.
- **emote over WS**: A sends 6 emote.burst rapidly → B receives exactly 5, each seq 0,
  payload stamped `userId: A` with the sent emoji/xPct/yPct; replay contains NO
  emote.burst; a DIFFERENT user can still emote immediately (per-user key).

### `test/chat/attachments.test.ts`
- **ticket happy path**: member POST /rooms/:id/attachments
  `{ filename:'clip note.webm', mime:'audio/webm', sizeBytes: 1_000_000 }` → 200;
  `CreateUploadResponse.parse` passes; one part `{ partNumber: 1, startByte: 0, endByte: 1_000_000 }`;
  part.url contains `X-Amz-Signature=`, `X-Amz-Credential=`, `X-Amz-Expires=900`,
  `/gather-media/chat/`, and the sanitized name `clip_note.webm`; asset doc: status
  'uploading', ownerId = user, storageKey starts `chat/${roomId}/`, uploadId echoed.
- **presign unit**: `presignPutUrl(testConfig().s3, 'chat/r/a/f.png', 900, new Date('2026-08-15T00:00:00Z'))`
  → URL contains `X-Amz-Date=20260815T000000Z`, credential `20260815%2Fus-east-1%2Fs3%2Faw`,
  a 64-hex signature, and is stable across two calls (determinism).
- **sanitizeFilename unit**: `'../weird name!.png'` → `'.._weird_name_.png'`; `'...'` → `'file'`;
  `''` → `'file'`; 150-char name truncated to 100.
- **entitlements**: free member sizeBytes 26MB → 413 QUOTA_EXCEEDED; insert
  `subscriptions.insertOne({ id: userId, userId, plan:'premium', status:'active', stripeCustomerId:null, stripeSubscriptionId:null, currentPeriodEnd:null, updatedAt: Date.now() })`
  → 26MB now 200; 201MB → still 413 (premium cap).
- **chat policy applies to tickets**: policy chat:'mods' → member ticket → 403 ROOM_POLICY.
- **complete**: right uploadId → 200, asset.status 'ready', response asset has NO
  storageKey/uploadId keys, `url` = `${publicBaseUrl}/${storageKey}`; wrong uploadId → 400;
  another user's asset → 403; unknown asset → 404; second complete → 200 (idempotent).
- **voice e2e**: after complete, WS chat.send kind voice with attachment built from the
  asset url + durationMs 4200 → chat.message broadcast, persisted kind 'voice'.
- non-member ticket → 403; guest from another room → 403.

### `test/chat/notify.test.ts`
Unit tests around `createNotifier` (import from module) using a recorder
`sendImpl = async (sub, payload) => { calls.push({ endpoint: sub.endpoint, payload }) }`
(and a throwing variant). Build deps from `makeApp()` (use `deps` from the built app) but
override config: `testConfig({ vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:t@e.st' } })`.
- **no keys → no-op**: default testConfig (null keys), recorder passed BUT factory keys
  are null → createNotifier(deps) with no sendImpl → mention resolves, nothing thrown.
  (When sendImpl IS injected, the notifier is active regardless of keys — document this in
  the notify.ts comment: injected transport implies enabled; tests rely on it.)
  ← IMPORTANT: implement notify.ts exactly so: enabled = sendImpl provided OR both keys set.
- **mention fanout**: room with A(sender), B, C, D members; C muted
  (`members.updateOne({ roomId, userId: C }, { muted: true })`); pushSubs: B web
  (endpoint 'https://push.example/b', keys), C web, B expo (expoPushToken only, endpoint
  null — must be ignored), D none; mention toUserIds [B, C, D, A] → exactly ONE call, to
  B's endpoint; payload JSON: kind 'mention', roomId, roomName 'Test Room',
  fromDisplayName, messageId, preview truncated to 140 (pass a 200-char preview).
- **dead sub pruning**: sendImpl throws `{ statusCode: 410 }` → that pushSub row is
  deleted; a sendImpl throwing `new Error('boom')` → sub kept, mention still resolves.
- **service integration**: construct `new ChatService(deps, fakeNotifier)` directly with a
  recording NotifyPort; seed room + members via helpers; call
  `service.send(roomId, authContextFor(memberA), sendPayload('text', { body: '<@' + B + '> hi' }))`
  → fake mention called once with toUserIds [B] and fromUserId A; author-only mention
  (`<@A>` self-mention) → notifier NOT called (empty target list short-circuits — implement
  mention() to return early when no targets remain).
  Build AuthContext literally: `{ userId, sessionId: 's', guest: false, guestRoomId: null }`.

Phase 3 exit: `CI=1 pnpm test` green (ALL suites), `CI=1 pnpm typecheck`, `CI=1 pnpm lint`.
