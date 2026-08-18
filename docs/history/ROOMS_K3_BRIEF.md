> **HISTORICAL (moved 2026-08-18 from `services/api/src/modules/rooms/`).**
> This is the worker brief the rooms module's realtime half was built from. It
> is a record of *why* that code looks the way it does — presence TTL living in
> the module because the frozen `BusPort` has no TTL primitive, the mirror/ctl
> design with origin-id loopback skipping, and the compare-and-set master
> arbitration where the SERVER increments the epoch — and nothing more. **Do
> not build from it.** It is written in the imperative ("You are adding", "FILE
> SPECS") because it was an agent prompt; sitting in a live module directory it
> read as standing orders, which is why it moved.
>
> Three things in it are dead, and one of them would reintroduce a bug:
>
> - **§ws.ts `defaultState = room.kind === 'watch' ? 'watching' : 'listening'`**
>   — rooms are adaptive now: composition follows the playing item, not a kind
>   chosen at creation. `ws.ts` uses a flat `const defaultState = 'watching'`,
>   which is also the client's own idle default (`presenceIdleStateFor` in
>   apps/web). Restoring the branch would make the server and the clients
>   disagree about the same idle member.
> - **§HARD RULES "Create ONLY `presence.ts`, `master.ts`, `runtime.ts`,
>   `ws.ts`" / "NEVER touch any other file anywhere."** That was this wave's
>   scope, not a property of the module. `history.ts` (in-room playback history)
>   was added later and belongs there.
> - **The `/Users/mg/Desktop/playin/...` absolute paths** in §READ FIRST are one
>   machine's checkout. They resolve today only by coincidence.
>
> Everything else still describes live behaviour, including the CAS key-order
> constraint (`{ userId, epoch }`) that keeps the Mongo embedded-document match
> exact. Current docs: `README.md`, `HANDOFF.md`, `DESIGN.md`.

# K3 Brief — Gather API "rooms" module, part B (realtime: presence + master election)

Part A (serialize.ts, deps.ts, service.ts, routes.ts, index.ts) is DONE and in
this directory. You are adding the realtime surface. Repo root:
`/Users/mg/Desktop/playin`. Working directory: `services/api/src/modules/rooms`.

## HARD RULES
- Create ONLY: `presence.ts`, `master.ts`, `runtime.ts`, `ws.ts`.
  Modify ONLY: `index.ts` and `routes.ts` (small wiring edits described below).
- NEVER touch any other file anywhere. Contracts, adapters, hub, plugins,
  other modules: frozen. Do not touch `src/modules/index.ts`.
- No package installs. Self-check with `CI=1 pnpm --filter gather-api typecheck`
  and `CI=1 npx eslint src/modules/rooms` (from services/api).
- Match repo style (file-header comments, AppError, strict TS with
  exactOptionalPropertyTypes + noUncheckedIndexedAccess, no `any`).

## READ FIRST
- Every file already in this directory (especially deps.ts: roomCtlChannel,
  RoomCtlMessage; service.ts patterns).
- /Users/mg/Desktop/playin/services/api/src/modules/types.ts (Deps, HandlerMap, HandlerContext, EventWriter, HubApi)
- /Users/mg/Desktop/playin/services/api/src/ws/hub.ts — NOTE: hub-core already
  owns 'clock.ping' and all 'webrtc.*' handlers. Registering those again
  throws. This module registers ONLY 'presence.update' and 'sync.claimMaster'.
- /Users/mg/Desktop/playin/packages/contracts/src/ws.ts (ClientPresenceUpdate,
  ClientSyncClaimMaster, ServerPresenceState, ServerPresenceDiff,
  ServerSyncMasterChanged) and entities.ts (PresenceEntry, PresenceState).
- /Users/mg/Desktop/playin/services/api/src/adapters/ports.ts (RoomDoc.master:
  { userId: string; epoch: number } | null; BusPort semantics — pub/sub
  delivers to the publishing instance's own subscribers too, asynchronously).

## DESIGN CONTEXT (binding)
- BusPort is a frozen seam with no TTL primitive, so presence heartbeat TTL
  lives in this module: each app instance tracks entries it heard locally and
  mirrors remote instances' entries via `roomctl:` bus messages (RoomCtlMessage
  'hb'/'bye'/'kick' with `from` origin-id loopback skipping).
- Master-claim arbitration must survive races: a claim names the epoch it
  bases itself on; the SERVER increments. Compare-and-set on RoomDoc.master
  via `store.rooms.updateOne({ id, master: <exact previous value> }, ...)` —
  both adapters match embedded objects structurally, and this module always
  writes master objects with key order { userId, epoch } so the Mongo
  embedded-document match stays exact. A lost CAS = stale claim.

## FILE SPECS

### presence.ts
```ts
export interface PresenceTimings {
  /** Entry dropped when no heartbeat within this window. */ ttlMs: number;
  /** Sweep cadence. */ sweepMs: number;
  /** Socket-gone grace before the entry is dropped (host disconnect →
   *  election-eligibility broadcast). */ disconnectGraceMs: number;
}
export const DEFAULT_PRESENCE_TIMINGS: PresenceTimings =
  { ttlMs: 45_000, sweepMs: 5_000, disconnectGraceMs: 15_000 };

export class PresenceTracker {
  constructor(deps: Deps, timings?: Partial<PresenceTimings>)
  /** Adjust timings (tests use tiny values); restarts the sweep interval. */
  configure(timings: Partial<PresenceTimings>): void
  /** Merge a heartbeat; returns the entry and whether it was created. */
  heartbeat(roomId: RoomId, userId: UserId, patch: {
    state?: PresenceState; micOn?: boolean; camOn?: boolean; sharing?: boolean;
  }, defaultState: PresenceState): Promise<{ entry: PresenceEntry; created: boolean }>
  /** All known entries for the room (local + mirrored), stable order. */
  entries(roomId: RoomId): PresenceEntry[]
  /** Drop a user now (explicit offline / leave): diff + 'bye' broadcast. */
  removeUser(roomId: RoomId, userId: UserId): Promise<void>
  /** One TTL/disconnect pass; exposed for tests. */
  sweep(now?: number): Promise<void>
  close(): Promise<void>
}
```
Internal state: `Map<roomId, Map<userId, Tracked>>` with
`Tracked = { entry: PresenceEntry; expiresAt: number; local: boolean; disconnectedAt: number | null }`,
per-tracker `readonly originId = newId()`, `Map<roomId, unsubscribe>` for ctl
subscriptions, one lazily-started `setInterval(sweep, sweepMs).unref()`.

Behavior:
- `heartbeat`: ensure ctl subscription for the room. Upsert: create with
  `{ state: patch.state ?? defaultState, micOn/camOn/sharing: patch.x ?? false,
  lastSeenTs: now }`, else merge only provided fields + lastSeenTs. Set
  `expiresAt = now + ttlMs`, `local: true`, clear disconnectedAt. Publish
  `{ kind:'hb', roomId, entry, from: originId }` on roomCtlChannel(roomId).
  Emit `events.emitEphemeral(roomId, 'presence.diff', { upserts: [entry],
  removed: [] })` ONLY when created or a visible field changed
  (state/micOn/camOn/sharing — lastSeenTs alone is silent).
- ctl subscription handler (`raw` cast to RoomCtlMessage; ignore messages with
  `from === originId`):
  - 'hb': upsert a MIRROR entry (`local: false`, expiresAt = now + ttlMs) —
    but never downgrade an existing local entry to mirror; just refresh its
    entry fields and expiry. No client diff (the origin instance emitted it).
  - 'bye': drop the entry when present and NOT local; no client diff.
  - 'kick': `deps.hub.disconnectUser(roomId, userId, 4403, 'removed')` and drop
    any entry (local or mirror) silently.
- `removeUser`: if tracked, delete + emitEphemeral presence.diff
  `{ upserts: [], removed: [userId] }` + publish 'bye'. Unsubscribe ctl and
  clean the room map when it becomes empty.
- `sweep(now = Date.now())`, per entry:
  - mirror entries: drop silently when `now >= expiresAt`.
  - local entries: if the user has no local socket
    (`!deps.hub.localUserIds(roomId).includes(userId)`): first sweep sets
    `disconnectedAt = now`; once `now - disconnectedAt >= disconnectGraceMs`
    → removeUser (this diff IS the election-eligibility broadcast: clients
    see the master/host vanish and the deterministic election spec picks the
    claimant). If sockets exist again, reset `disconnectedAt = null`.
  - local entries with `now >= expiresAt` (stale heartbeats, socket may still
    be open) → removeUser.
- `close()`: clear interval, unsubscribe everything, clear maps.
- Header comment MUST explain why TTL lives here (frozen BusPort has no TTL)
  and the mirror/ctl design.

### master.ts
```ts
export async function claimMaster(deps: Deps, roomId: RoomId, userId: UserId, claimEpoch: number): Promise<void>
```
- `room = store.rooms.findById(roomId)` → AppError('NOT_FOUND', 'room not found') when null.
- `stored = room.master`; `storedEpoch = stored?.epoch ?? 0`.
- `claimEpoch !== storedEpoch` → AppError('CONFLICT',
  `stale epoch claim: current epoch is ${storedEpoch}`).
- CAS: `store.rooms.updateOne({ id: roomId, master: stored ?? null },
  { master: { userId, epoch: storedEpoch + 1 } })`. Null result (lost race)
  → same CONFLICT AppError with the re-read current epoch.
- On success: `await deps.events.emit(roomId, 'sync.masterChanged',
  { masterUserId: userId, epoch: storedEpoch + 1 })`.
- Header: epoch is monotonic per room BECAUSE every transition is a CAS from
  the exact previous master value; the server, not the client, increments.

### runtime.ts
```ts
export interface RoomsRuntime { presence: PresenceTracker; close(): Promise<void>; }
export function getRoomsRuntime(deps: Deps): RoomsRuntime
```
WeakMap<Deps, RoomsRuntime>-memoized (one runtime per app instance; tests
reach the same instance through `deps` and call
`getRoomsRuntime(deps).presence.configure(...)`).

### ws.ts
```ts
export const roomsWsHandlers: HandlerMap = { 'presence.update': ..., 'sync.claimMaster': ... };
```
- 'presence.update': `room = store.rooms.findById(ctx.roomId)` → NOT_FOUND
  AppError when null. `defaultState = room.kind === 'watch' ? 'watching' :
  'listening'`. If `event.payload.state === 'offline'` → `presence.removeUser`
  and return. Else `{ created } = presence.heartbeat(...)` — pass ONLY defined
  payload fields (exactOptionalPropertyTypes). When `created`, reply the full
  roster to THIS socket: `ctx.reply('presence.state', { entries:
  presence.entries(ctx.roomId) })` (late joiners get state; everyone else
  already got the diff).
- 'sync.claimMaster': `await claimMaster(ctx.deps, ctx.roomId,
  ctx.auth.userId, event.payload.epoch)` — thrown AppError('CONFLICT') becomes
  the ephemeral error event via the hub's handler catch (that IS the "stale
  epoch rejected with error event" contract).

### index.ts (edit)
Add `wsHandlers: roomsWsHandlers` to the module object; keep default export.

### routes.ts (edit)
Inside `roomsRoutes`, after `const service = ...`: create the runtime and stop
it with the app:
```ts
const runtime = getRoomsRuntime(app.deps);
app.addHook('onClose', async () => { await runtime.close(); });
```

## ACCEPTANCE
- `CI=1 pnpm --filter gather-api typecheck` clean; eslint clean on this dir.
- `CI=1 pnpm --filter gather-api test` still green (existing suites must not break).
- Only the six named files touched.
