# K3 BRIEF — `queue` module for the Playin API (Fastify 5, TS strict ESM)

You are implementing ONE feature module inside an existing, frozen skeleton. Write ONLY the
files listed under "Files to write". Do NOT touch any other file. Do NOT run package installs.
Match the existing repo style exactly. A finished sibling module lives at
`/Users/mg/Desktop/playin/services/api/src/modules/sync/` — copy its structure, tone, and
strictness idioms.

IMPORTANT: this module is ALREADY registered in `src/modules/index.ts` (a placeholder
`index.ts` exists in this directory — OVERWRITE it with the real module). `buildApp` /
`makeApp()` pick it up automatically; tests must NEVER call `hub.registerModule` manually.

## Goal

Shared-queue WS handlers (`queue.add/remove/reorder/voteSkip`) with vote-skip threshold math
over presence-alive members, `queue.state` broadcasts with a version counter, plus the
playlists CRUD REST surface and `POST /playlists/add-to-queue`.

## Files to write (absolute paths)

1. `/Users/mg/Desktop/playin/services/api/src/modules/queue/index.ts` — ModulePlugin default
   export `{ name: 'queue', routes: queueRoutes, wsHandlers: {...} }` (OVERWRITE placeholder)
2. `/Users/mg/Desktop/playin/services/api/src/modules/queue/service.ts` — QueueService
3. `/Users/mg/Desktop/playin/services/api/src/modules/queue/routes.ts` — playlist routes
4. `/Users/mg/Desktop/playin/services/api/test/queue.test.ts` — vitest tests

## Conventions (binding — same as the sync module)

- TS strict ESM, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`; imports without
  file extensions; single quotes; 2-space indent; trailing commas; file-top `/** */` docs.
- Expected failures: `throw new AppError(code, message)` from `../../lib/errors`
  (codes: UNAUTHORIZED, FORBIDDEN, NOT_FOUND, ROOM_POLICY, VALIDATION, CONFLICT, ...).
- REST validation: `parseWith(Schema, request.body)` from `../../plugins/error-mapper`.
- REST auth: `requireAuth(request)` from `../../plugins/auth` (returns `{ userId, ... }`).
- Ids: `newId()` from `../../lib/tokens`; cast to branded types (`as QueueItemId`).
- Reuse `policyAllows` from `../sync/policy` and (if needed) `serializeRoom` from
  `../sync/serialize`. Do NOT duplicate them.

## Frozen seams (read the actual files for full context)

- `src/modules/types.ts`: ModulePlugin, Deps, HandlerContext, EventWriter, HubApi.
  WS handler signature `(event, ctx) => Promise<void>`; `ctx.deps.events.emit(roomId, type,
  payload)` persists + broadcasts; `ctx.deps.hub.localUserIds(roomId)` = distinct userIds
  with an open socket in the room (this is the presence-alive set).
- `src/adapters/ports.ts`:
  - `RoomDoc.queue: { items: QueueItem[]; version: number }` — persist queue changes with
    `store.rooms.updateOne({ id: roomId }, { queue: next })` (shallow top-level merge).
  - `RoomDoc.playback: PlaybackState | null` (`playback.queueIndex: number | null`).
  - `store.playlists: DocCollection<PlaylistDoc>` where `PlaylistDoc = Playlist`.
  - `memberDocId(roomId, userId)` keys `store.members`.
- `@playin/contracts`:
  - `QueueItemInput = { mediaRef, title, durationMs: number|null, artworkUrl: string|null }`
  - `QueueItem = QueueItemInput & { id: QueueItemId, addedBy: UserId, votesToSkip: UserId[] }`
  - WS client payloads: `queue.add` `{ item: QueueItemInput }`; `queue.remove`
    `{ itemId: QueueItemId }`; `queue.reorder` `{ orderedIds: QueueItemId[] }` (min 1);
    `queue.voteSkip` `{ itemId: QueueItemId }`.
  - Server event `queue.state` payload: `{ items: QueueItem[], version: number }`.
  - `RoomPolicies.queueControl: 'host'|'mods'|'everyone'`;
    `RoomPolicies.skipVoteThreshold: number` (0–1; fraction of active members; 0 disables
    the auto-skip vote).
  - REST schemas: `CreatePlaylistBody { title, roomId?: RoomId|null }`,
    `UpdatePlaylistBody { title?, items?: QueueItem[] }`, `AddToRoomQueueBody
    { playlistId, roomId }`, responses `{ playlist }`, `{ playlists }`, `{ ok: true }`,
    `{ added: number }`.
- `@playin/sync-core` exports a pure `queueReducer(state, action)` + `QueueState`
  (`{ items: readonly QueueItem[]; version: number }`). USE IT for add/remove/reorder
  (ineffective actions return the SAME state reference — treat that as a no-op or error,
  see below). Do NOT use its voteSkip action — the server's vote math is different
  (fraction threshold + presence pruning); implement voteSkip in QueueService.

## Behavior spec

### QueueService (constructor `(private readonly deps: Deps)`; cache per-Deps in index.ts
with a WeakMap exactly like the sync module)

Common preamble (copy the sync module's `loadContext`): room `NOT_FOUND`; membership re-read
via `store.members.findById(memberDocId(roomId, userId))` → `FORBIDDEN` 'not a member' /
'banned'.

- **add(roomId, userId, input: QueueItemInput)**: gate
  `policyAllows(room.policies.queueControl, member.role)` else
  `AppError('ROOM_POLICY', 'queue control not allowed')`. Build the QueueItem
  (`id: newId() as QueueItemId`, `addedBy: userId`, `votesToSkip: []`), run
  `queueReducer({ items: room.queue.items, version: room.queue.version }, { type: 'add', item })`,
  persist `{ queue: { items: [...next.items], version: next.version } }`, then
  `await events.emit(roomId, 'queue.state', { items: [...next.items], version: next.version })`.
- **remove(roomId, userId, itemId)**: item must exist (`NOT_FOUND`, 'queue item not found').
  Allowed when `policyAllows(queueControl, role)` OR `item.addedBy === userId` (you may
  always retract your own submission); else ROOM_POLICY. Reducer `remove`, persist, emit.
- **reorder(roomId, userId, orderedIds)**: policy gate as add. Run reducer `reorder`; if the
  returned state is the SAME reference AND the requested order differs from the current
  order → `AppError('VALIDATION', 'orderedIds must be a permutation of the queue')`; if the
  order is identical to the current order → silent no-op (no bump, no emit). Otherwise
  persist + emit.
- **voteSkip(roomId, userId, itemId)**: ANY non-banned member (no policy gate — voting is
  the democratic path). Item must exist (NOT_FOUND).
  - `fraction = room.policies.skipVoteThreshold`
  - `active = new Set(deps.hub.localUserIds(roomId))` — presence-alive members. The voter is
    by construction connected, but add them defensively.
  - Prune: `votes = item.votesToSkip.filter((v) => active.has(v))`, then add `userId` if
    absent. If the pruned+added vote set equals the stored one AND the voter had already
    voted → silent no-op (no bump, no emit).
  - `required = Math.max(1, Math.ceil(fraction * active.size))`
  - Current item: `qi = room.playback?.queueIndex`; `currentItemId = (qi !== null &&
    qi !== undefined ? room.queue.items[qi]?.id : room.queue.items[0]?.id) ?? null`
    (with no playback snapshot the head of the queue counts as current).
  - If `fraction > 0 && item.id === currentItemId && votes.length >= required` (AT the
    threshold skips — this is the "exactly at threshold" edge) → remove the item from the
    queue; else → store the updated `votesToSkip` on the item. Either way version + 1,
    persist, emit `queue.state`.
  - `fraction === 0` disables auto-skip entirely: votes are still recorded (version bump +
    emit) but the item is never removed.

### routes.ts — `export const queueRoutes: FastifyPluginAsync` (paths are FULL, no prefix;
they must match @playin/api-client exactly)

All routes `requireAuth`. Playlist visibility/mutation is OWNER-ONLY (`FORBIDDEN`,
'not your playlist'); missing playlist → NOT_FOUND.

- `POST /playlists` — parseWith(CreatePlaylistBody); insert
  `{ id: newId() as PlaylistId, ownerId: auth.userId, roomId: body.roomId ?? null, title, items: [] }`;
  → `{ playlist }`.
- `GET /playlists` — caller's playlists → `{ playlists }`.
- `GET /playlists/:playlistId` — → `{ playlist }`.
- `PATCH /playlists/:playlistId` — parseWith(UpdatePlaylistBody); apply only provided
  fields (conditional spread — exactOptionalPropertyTypes); → `{ playlist }`.
- `DELETE /playlists/:playlistId` — → `{ ok: true }`.
- `POST /playlists/add-to-queue` — parseWith(AddToRoomQueueBody). Caller must own the
  playlist; must be a non-banned member of the room (FORBIDDEN otherwise); queueControl
  policy gate (ROOM_POLICY). Append COPIES of the playlist's items to the room queue with
  FRESH ids (`newId() as QueueItemId`), `addedBy: auth.userId`, `votesToSkip: []`,
  preserving order; bump `version` by exactly 1 for the whole batch; persist;
  `await app.deps.events.emit(roomId, 'queue.state', ...)`; → `{ added: items.length }`.
  Empty playlist → `{ added: 0 }` with NO version bump and NO emit.

## Test plan — `/Users/mg/Desktop/playin/services/api/test/queue.test.ts`

Copy the socket/test harness style from
`/Users/mg/Desktop/playin/services/api/test/sync.test.ts` (openSocket, nextOfType,
clientFrame, makeApp + listen on port 0, join() helper via signupUser + addMember). The
module is auto-registered — do NOT touch the hub. seedRoom policies:
`queueControl: 'everyone'`, `skipVoteThreshold: 0.5`. Adjust policies per test with
`store.rooms.updateOne({ id: roomId }, { policies: { ...room.policies, queueControl: 'host' } })`.

MUST cover, honestly:
1. **add/remove/reorder happy path**: host + member sockets. Member adds two items (policy
   'everyone') → both sockets get `queue.state` v1 then v2 with the items; store matches.
   Reorder to [b, a] → v3, order persisted. Remove own item → v4. A reorder with a bogus id
   set → error VALIDATION, version unchanged.
2. **queueControl gate**: set `queueControl: 'host'`; member `queue.add` → error frame
   `ROOM_POLICY`; store queue unchanged. Member still CAN remove their own previously-added
   item (owner-retract path) — seed that item first while policy was 'everyone' or insert
   directly into the room doc with `addedBy` = member.
3. **voteSkip exactly at threshold**: host + 3 members connected (4 active),
   skipVoteThreshold 0.5 → required 2. Seed one queue item directly on the room doc
   (playback null ⇒ head item is current). First vote → `queue.state` with
   `votesToSkip: [voter]`, item still present. Second vote (different member) → item
   REMOVED (2 of 4 = exactly the threshold).
4. **member leaves mid-vote**: host + members A, B, C connected (4 active), required 2.
   A votes (1 vote, stays). A's socket closes; wait for the hub to drop it (poll
   `deps.hub.localUserIds(roomId)` — makeApp returns `deps` — until A is gone). B votes →
   A's stale vote is PRUNED: item must STILL be present with `votesToSkip` == [B] (3 active
   → required 2, and only B counts). C votes → removed (B+C = 2 ≥ 2).
5. **threshold 0 disables auto-skip**: `skipVoteThreshold: 0`; two of two active members
   vote; item still present with both votes recorded.
6. **playlists CRUD**: create (assert shape), list, get, patch title + items, non-owner GET
   → 403, delete → ok, then GET → 404. Use `app.inject` with
   `headers: { authorization: 'Bearer ' + accessToken }`.
7. **add-to-queue**: playlist with 2 items → `{ added: 2 }`; room queue has 2 items with
   ids DIFFERENT from the playlist's item ids, `addedBy` = caller, `votesToSkip: []`,
   version bumped by exactly 1; an open socket in the room receives the `queue.state`
   broadcast. With `queueControl: 'host'` a member caller gets 403 (ROOM_POLICY).

## Acceptance (run from `/Users/mg/Desktop/playin/services/api`)

- `CI=1 pnpm exec tsc --noEmit` — zero errors.
- `CI=1 pnpm exec vitest run test/queue.test.ts` — all pass.
- `CI=1 pnpm exec vitest run` — the whole suite stays green (do not break sync/auth tests).
- NEVER bare `vitest` (watch mode); no installs; nothing interactive.
