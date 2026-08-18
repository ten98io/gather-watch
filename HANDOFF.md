# Session handoff — Gather

Read this first, then `docs/WEB_SLIMMING.md` (the one active migration) and
`docs/EXTENSION_FIRST.md` (the architecture it serves).

## Live state

**gather.watch is deployed and serving.** Railway project Gather: `api` + `web`
+ Redis, zero-downtime deploys (api gated on `/readyz`, web on `/`),
config-as-code on both services.

**Deploys come from GitHub, not from the CLI.** Both services are repo-connected
to `mustafagandhi/gather-watch`; pushing to `main` (or `dev`) is what redeploys.
`railway up` still works as an escape hatch and is *not* the deploy path any
more — treat it as a local-source override, and remember `railway link` writes
to `~`, so check what is linked before using it.

`main` is `80395f6`; `dev` trails it by one commit (`b500e33`) and is an
ancestor, so a fast-forward is all it needs. Live probes at handoff: api
`/readyz` → `{"ok":true,"store":true,"bus":true,"busMode":"redis"}`, web 200,
ws 101. **Run `git status` before trusting any of this** — the last thing this
repo saw was a multi-agent wave, so the working tree may carry uncommitted work
that no single agent can vouch for.

Chat attachments use the `attachments` Railway Bucket (`ams`) via reference
variables, read through stable capability URLs (`GET /assets/:assetId/content`
→ 60 s presigned GET). Email: Cloudflare Email Service, sender
`email.gather.watch`. Mongo on Atlas — a **new cluster**, because the old one
was deleted; the database is fresh and its indexes were built by the current
code. Brand **Gather**; packages `@gather/*`.

The workspace is nine packages: `apps/web`, `apps/extension`, `apps/mobile`,
`services/api`, and `packages/{contracts,api-client,sync-core,p2p,design}`.
There is no `services/media` — source, Railway service and the leftover
directory are all gone.

Stored rooms carry `relayMode`; every room is `'mesh'` today
(`services/api/src/modules/rooms/service.ts` writes `'mesh'` at creation and
nothing ever writes anything else). `'cf-sfu'` is still in the schema
(`packages/contracts/src/entities.ts` `RelayMode`) and in the p2p provider
(`packages/p2p/src/relay.ts` `CfSfuProvider`), but nothing selects it — theater
is a layout, not a transport. No room ever successfully used LiveKit; it is
deleted from the codebase.

Gates at the end of this session, forced (not cached): **build 8/8, typecheck
14/14, test 157 files / 2004 passed / 18 skipped, lint 9/9.** Build is 8 and not
9 because `apps/mobile` has no `build` script. Typecheck and test are 14 because
both `dependsOn: ["^build"]`, so each run also builds the five `dist`-shipped
packages: 9 workspaces + 5 builds.

## The architecture in six sentences

Read these before changing anything; each one has an audit finding behind it.

1. **One tier. There is no paywall, and there is nothing to build one out of.**
   The billing module, `Plan`, `Entitlements`, Stripe, `services/media` and
   every gate that read them are DELETED. Four tombstones fail if any of it
   comes back: `services/api/test/no-billing.test.ts` (no checkout / portal /
   entitlements / webhook / usage-ingest route), `services/api/test/
   rooms-ungated.test.ts` (theater and the publisher ceiling are ungated),
   `packages/contracts/test/no-billing.test.ts` (no `Plan`, `Entitlements`,
   `Subscription`, checkout/portal bodies, `PAYMENT_REQUIRED` code or `billing`
   rest group on the wire) and `apps/web/test/no-paywall.test.ts` (no plan,
   tier, upgrade or billing copy anywhere a user can see). Attachments are one
   flat `ATTACHMENT_MAX_MB = 200` for everyone
   (`services/api/src/modules/chat/attachments.ts`) — no per-user lookup
   exists. If a doc, brief or comment tells you to add a plan, it is stale: fix
   the doc.
2. **Media topology is mesh → Cloudflare TURN → Cloudflare Realtime SFU.**
   Mesh is the default and costs us nothing; TURN is the *connectivity*
   fallback (a NAT chose it, not us); the SFU is the *capacity* fallback for
   when the host's uplink cannot fan a share out. **The SFU client lane is not
   built** — `CF_SFU_APP_ID` / `CF_SFU_API_TOKEN` are parsed into `AppConfig`
   (`services/api/src/config.ts`) and read by nothing else. RealtimeKit was
   evaluated and REJECTED: it cannot publish mic + share-video + share-audio
   from tracks we already captured, and per-participant-minute billing is the
   wrong shape for a product with no revenue per participant. LiveKit and
   coturn are both gone; `TURN_STATIC_AUTH_SECRET` was removed from
   `config.ts`, `.env.example`, `turbo.json`'s `passThroughEnv` and
   `infra/README.md` because nothing read it. Setting that variable now does
   **nothing**; `services/api/test/config-coturn.test.ts` pins the absence at
   the config layer so it cannot come back as a silently-ignored key. See
   `docs/COST_MODEL.md` for the arithmetic.
3. **Rooms are endless.** They are created with `expiresAt: null`
   (`services/api/src/modules/rooms/service.ts`) and no clock ever expires
   them. The idle sweep deletes only rooms that are **empty** and have been
   quiet for `IDLE_ROOM_TTL_MS` (30 days); a room with members is never reaped
   however long it has been silent. The old 4-hour TTL is gone —
   `services/api/test/rooms-lifecycle.test.ts` pins all of this.
4. **Content never touches our infrastructure.** The extension drives each
   viewer's own player against the real site; we sync positions, not bytes.
5. **Auto-advance is a compare-and-set intent, not an election.** Any client
   that watches an item end sends `sync.advance { endedItemId }`. It is
   **ungated** — no role check, no elected seat — and the server moves the room
   only while the room is still on that exact item, and only to that item's
   successor as the *server* sees the queue
   (`services/api/src/modules/sync/service.ts`). The master-seat election is
   deleted whole: `sync.claimMaster`, `SyncService.claimMaster`,
   `RoomDoc.master`, the `masterChanged` snapshot reply,
   `services/api/src/modules/rooms/master.ts` and p2p's `MasterElection` are all
   gone, pinned by `services/api/test/master-seat-removed.test.ts` and
   `packages/contracts/test/master-seat-removed.test.ts`.
6. **"Mode A" and "Mode B" are internal names only, and users never see them.**
   Mode A = synced-source playback, each device playing the source itself.
   Mode B = one member's tab/screen re-streamed to the room over the mesh. The
   user-facing words are "watch together" and "screen share". The web stage
   component is `apps/web/components/stage/ScreenShareStage.tsx`; `ModeBStage`
   no longer exists. The internal vocabulary survives in prose and in some
   comments; that is a pending cross-cutting rename, not a bug.

## Shipped this session (verified against the code)

- **Billing removed, root and branch.** `services/api/src/modules/billing/*`,
  `services/api/test/premium-gate.test.ts`, `services/media/**` and the web
  billing pages are gone; the four tombstone suites above replaced them.
- **The master seat is gone and `sync.advance` replaced it.** `sync.claimMaster`
  had zero producers once auto-advance moved to the intent, but what it left
  behind was a live, persisted, room-wide write any member could perform. The
  plausibility guard is described in open item 4 below — read it before
  trusting it.
- **Screen share has its server half.** `services/api/src/modules/restream/`
  registers `restream.start` and `restream.stop` → `ServerRestreamState`.
  Before this, pressing "Share screen" fell into the hub's unknown-event error
  path and no state came back. `restream.handoff` is declared on the wire and
  deliberately still **unhandled** — no client sends it, and an unhandled event
  gives the standard error reply instead of a silent success. A share is NEVER
  bitrate-capped: the old 400 kbps free-tier guard went out with billing, and
  it had been capping every share anyway once the plan lookup was gone. The
  replacement lever exists but is unset — see open item 3.
- **Mesh lanes.** `packages/p2p/src/mesh.ts` `MESH_LANES = ['share']`, and
  `apps/extension/src/offscreen.ts` sets `lane: 'share'` on the capture mesh —
  the producer, without which the mechanism was dead code passing its own
  tests. One identity can hold more than one mesh (the sharer's web tab holds
  the call, the offscreen document holds the capture); before lanes both
  computed the same `connectionId` and collided.
- **`TrackRole` is `'share' | 'share-audio' | 'cam' | 'mic'`**
  (`packages/p2p/src/types.ts`). `share-audio` is new — tab audio travels as
  its own track, and its sink does not require joining the call
  (`apps/web/test/share-audio-sink.test.tsx`). The camera toggle mutes via
  `replaceTrack` (`packages/p2p/test/camera-toggle.test.ts`).
- **`MediaRef` gained `{ kind: 'page', url }`** (`packages/contracts/src/
  entities.ts`) — any https page is queueable. The extension drives whatever
  `<video>`/`<audio>` that page mounts, on each viewer's own device. A viewer
  **without** the extension is told so honestly rather than shown a blank
  stage: `PageLinkStage` in `apps/web/components/stage/StagePane.tsx` and
  `PageStage` in `apps/mobile/src/components/Stage.tsx`.
- **Mongo unique indexes are PARTIAL, never sparse.**
  `services/api/src/adapters/mongo-store.ts` emits
  `partialFilterExpression: { <key>: { $type: 'string' } }` and never `sparse`,
  because a sparse unique index *does* index an explicit `null` — which made
  the second guest ever to join collide forever. Init also tolerates a database
  that still carries the old sparse index rather than crashing on error 85/86.
- **Realtime hardening**: presence keepalive; `member.removed` emitted and
  reduced on web and mobile (`ServerMemberRemoved { userId, reason }` with
  `MEMBER_REMOVAL_CLOSE_TEXT` mapping reasons onto the 4403 close frame, always
  ephemeral at seq 0); refresh restores state via an explicit `wantSnapshot` on
  `presence.update` (`services/api/src/modules/rooms/ws.ts`), because a
  reconnect cannot be told apart from a no-op beat; a pong watchdog; honoured
  close codes; bus liveness in `/readyz` (`busMode` is reported, and an
  in-memory bus in production is a 503 because that instance is isolated);
  `trustProxy` in production.
- **In-room playback history replaced the library.**
  `services/api/src/modules/rooms/history.ts`, `GET /rooms/:roomId/history`,
  `HISTORY_KEEP_PER_ROOM = 200`, one row per track change. There is no library
  and no upload pipeline — `apps/web/test/no-library.test.ts` is the tombstone.
- **The extension signs as the real user.** The web app hands off the room id
  plus a room-scoped access token over the externally-connectable channel
  (`apps/extension/src/external.ts`), so the extension drives as the signed-in
  member rather than as a guest. It fetches TURN itself
  (`GET /rtc/turn-credentials` from `offscreen.ts`), and its generic driver is
  unblocked.
- **Design tokens retightened** — radii 6/8/10/14, light aurora lightened, the
  ink-on-fill system added. `DESIGN.md` §2–§4 carries the numbers.
- **New destructive-tooling CLIs, dry-run by default**:
  `services/api/src/cli/reset-db.ts` and `services/api/src/cli/clear-bucket.ts`.
  Both print what they would do and require `--yes` to act.
- **Cast, honestly**: always-visible control with honest states; Chromecast
  TV-participant designed in `docs/CAST_RELAY.md` (hardware spike pending);
  AirPlay = OS-mirroring guidance (**designed, not yet written into the UI**);
  server relay deferred. Client-side-first doctrine is binding.
- **No worker brief sits in a live source directory.** All four (`chat`,
  `mobile`, `rooms`, `compliance`) are in `docs/history/` under a header naming
  what in them is dead and why they moved: they are written in the imperative
  and read as standing orders where they sat.

Costs: `docs/COST_MODEL.md` (verified rates; three lines cannot be closed).

## Open items

1. **TURN keys** (user action) — voice dropouts persist until `CF_TURN_KEY_ID`
   and `CF_TURN_API_TOKEN` are set on the `api` service. Cannot be verified
   from the repo.
2. **$5 Cast spike** (user action) — Google Cast dev console registration
   gates the Chromecast TV-participant slice 1 (`docs/CAST_RELAY.md` §7).
3. **Relayed-share bitrate cap is unset** (real money, one line of wiring).
   `packages/p2p/src/mesh.ts` already classifies each link `direct`/`relayed`
   and will cap the `share` sender on a relayed link — but only when a caller
   passes `capRelayedVideoKbps`, and no caller does.
   `apps/extension/src/offscreen.ts` threads the option through to the mesh and
   never sets it (`apps/extension/test/offscreen.test.ts` asserts it stays
   `undefined`); the
   web mesh constructor (`apps/web/lib/call-mesh.ts`) does not offer it at all.
   So a share that falls back to TURN runs at full rate on our bill
   (~$0.186/hr for 5 relayed viewers, `docs/COST_MODEL.md` risk 1). Decide a
   number (the doc suggests 300–500 kbps) and pass it from both constructors.
4. **The advance guard PRICES a skip rather than verifying one when
   `durationMs` is null.** `endingIsPlausible` in
   `services/api/src/modules/sync/service.ts` has two branches and they are not
   equally strong. With a known duration it genuinely verifies: the room's own
   media clock, projected to now, must have reached the end minus a grace, so
   the cost of a false skip is the item's whole remaining runtime. With
   `durationMs === null` — nullable on `QueueItem` and null for most YouTube
   rows, so this is the *common* case — there is no end to aim at, and the
   branch instead demands `projected >= ADVANCE_UNKNOWN_DURATION_FLOOR_MS`
   (20 s). That is a price, not a proof: a member can walk a queue of unresolved
   rows at 20 s each. Fail-open is the deliberate, correct direction (a false
   refuse strands the whole room on a finished item), but do not read the guard
   as authorization. Closing it needs duration resolution on queue insert, not
   a bigger floor.
5. **The CF Realtime SFU client lane is not built.** The capacity fallback
   exists as a config surface (`CF_SFU_APP_ID` / `CF_SFU_API_TOKEN`) and a
   provider class (`packages/p2p/src/relay.ts` `CfSfuProvider`), and nothing
   dials it. A room whose host's uplink cannot fan the share out has no
   fallback today; it just degrades. Setting the two variables changes no
   behaviour. There is no `ENABLE_SFU` flag and never was in this codebase.
6. **A mobile-only room on a YouTube/embed item cannot report its own ending.**
   `apps/mobile/src/components/Stage.tsx` sends `sync.advance` from the native
   (expo-video) player's end signal, unconditionally. A YouTube or embed item
   plays in a `react-native-webview` with **no position API**, so there is no
   end signal to send. In a room where every member is on mobile and the item
   is an embed, the queue stalls on a finished item. The fix is the
   postMessage bridge into the WebView, not another producer on the native
   path.
7. **An extension session revived after an MV3 worker recycle has an unknown
   queue until the next mutation.** `apps/extension/src/background.ts` mirrors
   session state into `chrome.storage.session`, but the room's queue arrives
   with the join snapshot — and a revived worker beats into a presence entry
   that is still alive, so no snapshot comes back. `sync.advance` names an
   item, so an unknown queue means an ending in that window is silently not
   reported. The same recycle leaves `playback` null and stops the worker
   driving at all, so it is not a *new* blind spot, but it is a real one.
   Asking for a snapshot on revive (the `wantSnapshot` door the web already
   uses) is the obvious fix.
8. **The Mongo and Redis halves of the test suite have no AUTOMATIC signal.**
   Both real backends produced a production bug this session that a green suite
   could not see: the sparse-vs-partial unique index (every second guest
   collided forever) and the Redis subscriber-mode `PING` reply shape (a
   healthy bus failed `/readyz`). What exists now:
   `services/api/test/store.contract.test.ts` runs one contract against every
   `StorePort` adapter, and `store-index-spec.test.ts` /
   `redis-ping-shape.test.ts` pin the two *shapes* — a structural pin (we ask
   Mongo for the right index) is not an execution (that Mongo then behaves as
   documented). The real-server pass is **opt-in and skipped by default**:

   ```bash
   GATHER_TEST_MONGO_URL=mongodb://127.0.0.1:27017 pnpm --filter ./services/api test
   ```

   There is no `mongodb-memory-server` in the lockfile, no `mongod` in the test
   setup, and no Redis equivalent of that flag at all. So: treat any change to
   `adapters/mongo-store.ts` as unverified until that variable has been set,
   and any change to `adapters/redis-bus.ts` as unverified until it has run
   against a real Redis by hand.
9. **Web-slimming steps 4–5** (delete web player adapters + web
   `getDisplayMedia`) — still gated on a real-room verification that the
   extension drives playback correctly. `apps/web/lib/player/{youtube,
   soundcloud,vimeo,native,embed,adapter}.ts` and the `getDisplayMedia` call at
   `apps/web/components/stage/ScreenShareStage.tsx:113` are all still present.
   See `docs/WEB_SLIMMING.md` header for the blast radius.
10. **Mobile RN type defects** — the hero step is 28 px in `packages/design/src/
    scales.ts` (`maxFontSize: 56` is a web-only fluid ceiling; RN takes
    `fontSize`), so mobile's old 34 px `displayL` regressed to 28. JetBrains
    Mono is unbundled — `apps/mobile` has no `expo-font` dependency, so
    `type.mono` names a face RN never loads and numeric readouts jitter on the
    fallback.
11. **AirPlay guidance copy is designed but not written.** `docs/CAST_RELAY.md`
    §2 specifies two platform-keyed rows inside the cast popover; no such copy
    exists in `apps/web/components/stage/PlayerControls.tsx` (grep "Screen
    Mirroring" — nothing). The always-visible cast control with honest states
    *did* ship; the mirroring hint did not.

**Closed since the last handoff** (do not go looking for them): the settings
uploads panel no longer calls deleted media routes — `ChunkedUploader` and
`media.listLibrary` are out of `apps/web`, with `apps/web/test/no-library.test.ts`
pinning it; and a `page` item with no extension now renders `PageLinkStage`
instead of a blank stage.

## Orphans — reported, not deleted

Each of these is live, compiling, tested code with **no production caller**. None
is a bug today; each is a decision someone has to make on purpose, and a wrong
deletion is worse than a surviving orphan. Listed so the next reader does not
mistake any of them for a working path.

- **`BeaconSender` / `BeaconFollower`** (`packages/p2p/src/beacon.ts`) — the
  DataChannel sync-beacon pipeline. Nothing outside the package constructs
  either; the file says so itself ("there is no longer an election to wire this
  to: MasterElection was deleted"), and `apps/mobile/src/sync/useSyncEngine.ts`
  calls it a documented seam. It was built for the master clock, and the master
  clock is gone. Either wire it as a latency optimisation over the
  server-authoritative state, or delete it — do not leave a reader believing
  beacons are in the path.
- **`ChunkedUploader` + `media.createUpload` / `completeUpload`**
  (`packages/api-client`) — the multipart upload session. The API serves no
  `/media/uploads` route (that was `services/media`), and `apps/web` no longer
  calls it. `rest.ts` says exactly this in a comment beside the two methods.
  Chat attachments do **not** go through here; they use
  `POST /rooms/:roomId/attachments` and only borrow the schemas.
- **`restream.handoff`** — declared on the wire, deliberately unhandled by the
  server, sent by no client. Intentional and documented in
  `services/api/src/modules/restream/index.ts`; noted here so nobody "fixes" the
  error reply by silently succeeding.
- **`ENABLE_MEDIA_PIPELINE`** — parsed into `AppConfig` and reported by
  `GET /admin/overview` as `mediaPipeline`. Nothing else reads it, and there is
  no pipeline left to enable.
- **Two empty directories**, `services/api/test/chat/` and
  `services/api/test/rooms/`. The chat suite lives flat
  (`test/chat-wiring.test.ts`, `test/chat-attachment-validation.test.ts`,
  `test/attachments.test.ts`, `src/modules/chat/unfurl.test.ts`), so the nested
  layout `docs/history/CHAT_K3_BRIEF.md` prescribes was never populated.

## Traps discovered the hard way

- **A mechanism with no PRODUCER is dead code that passes its own tests.**
  Shipped twice: mesh lanes with nothing setting `lane`, and the master seat
  with nothing serializing it to clients. Both had unit tests, both were green,
  neither did anything. Before you call a mechanism done, grep for the thing
  that *sends* it — not the thing that handles it.
- **Changing ONE HALF of a two-half contract ships a blocker behind a green
  suite.** An ungated claim against a gated drive froze every default room:
  each half was individually correct and tested. If a predicate exists in two
  places, make it ONE function called from both.
- **`pnpm build` before typechecking downstream.** FIVE packages ship via
  built `dist` — `contracts`, `api-client`, `sync-core`, `p2p`, `design`.
  Editing any of them without rebuilding typechecks web/api/mobile/extension
  against stale `.d.ts`, and the result is a FALSE GREEN: typecheck passes
  against the old types while the source you just wrote is never checked at
  all. Build the package you edited first, then typecheck anything downstream.
- **A cached turbo green is not proof.** `FULL TURBO` means turbo replayed a
  previous run's output because the input hashes matched — it did not run
  anything. That is fine mid-loop and dangerous before a deploy, because the
  hash does not cover everything that can break a deploy. Re-run the gates with
  `--force` before you ship, and quote the forced run, not the cached one.
- **Adding a union member has a loud half and a SILENT half.** Every
  exhaustive `switch` on the discriminant fails typecheck and walks you to each
  site — that half takes care of itself. The dangerous half is the `if`-chains:
  `adapterKindFor` was one, the new `page` `MediaRef` kind fell off its end as
  the default, and the web stage pointed a `<video>` at an HTML document with
  nothing red anywhere. Mobile's `Stage.tsx` had the same shape and failed safe
  only by luck. So: grep `\.kind ===` as well as `switch`, and convert each
  chain you find to an exhaustive switch with a
  `default: { const unhandled: never = ref; }`. `apps/mobile/src/components/
  Stage.tsx` is the worked example, and deleting one of its `case` lines is a
  two-second demonstration that the guard is live. The same rule applies to
  `TrackRole` — `'share-audio'` was added this session.
- **The test suite has no AUTOMATIC signal for real Mongo or real Redis.** The
  Mongo contract pass exists but is gated on `GATHER_TEST_MONGO_URL` and is
  skipped unless you set it; Redis has no such flag. See open item 8 — both
  blind spots produced a production bug this session.
- **Mongo `sparse` unique indexes index explicit `null`.** `sparse` omits a
  document only when the field is *absent*; a document that stores `null`
  explicitly is indexed, so the second such document collides with the first,
  forever. Use `partialFilterExpression` with a `$type` test instead —
  `services/api/src/adapters/mongo-store.ts` is the pattern, and
  `store-index-spec.test.ts` pins it.
- **`railway run` executes LOCALLY with Railway's env.** It dials from the
  operator's IP, not Railway's — so an Atlas allowlist or an egress-IP problem
  will look fine under `railway run` and fail in the deployed container.
- **`railway link` writes to `~`** — linking runs against the home-directory
  config, not the repo; re-check which project/service is linked before `up`.
  And `up` is not the deploy path any more: pushing to GitHub is.
- **Agents working in parallel must have disjoint file scopes.** Two agents
  editing one file in the same wave means the second write silently loses the
  first. Scope every agent to paths no other agent owns, and never
  `git add -A` while a wave is in flight — stage only your own scoped paths.
- **In a concurrent agent wave, a red gate may not be yours.** Before
  debugging a failure, `git status --short` the failing path: an untracked
  test file is another agent mid-TDD, and its RED is the point. Quote which
  files failed and whether they are in your scope, not just the exit code.
- **`.next` contention.** A running dev server on :3000 holds `apps/web/.next`
  and `pnpm build` fails with `PageNotFoundError` on pages that plainly exist.
  Stop the dev server and remove `.next` before building. Contention, not
  breakage.
- **`cn()` is a plain joiner, not `tailwind-merge`.** No conflict resolution:
  passing both `relative` and `absolute` emits both and CSS source order
  decides (`absolute` silently loses). Make conflicting utilities mutually
  exclusive (ternary), never additive.
- **`exactOptionalPropertyTypes` is on.** Spreading `{ field: maybeUndefined }`
  writes explicit `undefined` over real values; use conditional spreads.
- **No Prettier.** The repo has no Prettier config; `npx prettier --write`
  rewrites to double quotes against house style. Match surrounding style by
  hand.
- **`playin` is a prefix of `playing`.** Any rename/grep for the old brand
  must be boundary-aware or it corrupts `playing`/`isPlaying` identifiers. The
  checkout directory is still `~/Desktop/playin`; the product is Gather.
- **Vitest `include` history is `.ts`-only.** Adding `.tsx` tests silently
  runs zero of them unless the glob covers `.tsx`.
- **The extension has two builds and only one is shippable.** `build` is the
  dev script: with `GATHER_API_URL` set it labels the artifact
  **UNVERIFIED**, because the https, loopback and manifest-subset checks never
  ran. `build:prod` is the one that goes into a real browser
  (`apps/extension/src/buildTarget.ts`). An artifact pointing at
  `localhost:4000` installs cleanly, is detected by the web app, and then fails
  every call — that artifact has shipped once.
- **Railway cache-mount ids** must be unique per service or Docker builds
  poison each other's pnpm store cache.
- **`pnpm --filter {dir}...` braces**: the `{dir}` + `...` filter syntax is
  load-bearing — `./apps/web` alone skips workspace dependents/dependencies.
- **Tailwind hover-reveal ordering.** The unscoped `group-focus-within:` rule
  emits before the `@media(hover:hover)` block and loses to it; the duplicated
  class pair in `HOVER_REVEAL` (`apps/web/components/ui/media-row.tsx`) is
  deliberate — do not "simplify" it away.
- **Empty `MONGO_URL`/`REDIS_URL` silently boot in-memory adapters** — the
  deploy looks healthy and loses all data on restart. An env var set to the
  empty string counts as ABSENT everywhere in `services/api/src/config.ts`.
  `/readyz` is the probe that reflects the real store; the api's railway.json
  healthcheck uses it (web's gates on `/`).
- **When in doubt about deleting something, REPORT it.** A wrong deletion is
  far worse than a surviving orphan — and this repo has already deleted a
  production Mongo cluster once.

## Environment notes

- Local dev: web :3000, api :4000. Nothing boots on :4500 any more —
  `services/media` is gone. `pnpm build` first (contracts, api-client,
  sync-core, p2p and design all ship via `dist`), then test/typecheck.
- `pnpm dev` runs web and api only; `apps/extension` and `apps/mobile` have no
  `dev` task (extension builds, mobile has `start`).
- Extension prod build (MV3 inlines the origin at build time — there is no
  runtime env):

  ```bash
  GATHER_API_URL=https://<api-domain> \
    GATHER_WEB_ORIGINS=https://gather.watch,https://www.gather.watch \
    pnpm --filter ./apps/extension build:prod
  ```

  then chrome://extensions → Load unpacked → `apps/extension/dist`.
  `GATHER_WEB_ORIGINS` must stay a subset of the manifest's
  `externally_connectable.matches`; the build checks that for you and names the
  offending origin. Chrome 137+ ignores `--load-extension`; there is no
  automated install path for a real profile, by Chrome's design.
- The web app finds the extension without configuration (content script
  announces its id on Gather origins); `NEXT_PUBLIC_GATHER_EXTENSION_ID` only
  pins it.

## Next session — starting prompt

```
Continue Gather (~/Desktop/playin, live at gather.watch). Read HANDOFF.md
first — live state, open items, and the traps list.

Everything is on main (80395f6) and deployed; dev trails by one commit and
fast-forwards. Deploys come from GitHub — pushing to main redeploys both
Railway services. `railway up` is a local-source escape hatch, not the path.

Before you change anything, re-run the gates yourself with --force
(build/typecheck/test/lint) and `git status` — the last thing this repo saw
was a multi-agent wave, so confirm the tree is clean rather than taking a
previous session's word for it. The forced numbers to beat: build 8/8,
typecheck 14/14, test 157 files / 2004 passed / 18 skipped, lint 9/9.

Pick up in this order:
1. If the TURN keys and/or the $5 Cast registration landed since last
   session, wire them: TURN needs only CF_TURN_KEY_ID + CF_TURN_API_TOKEN on
   the api service and a redeploy to heal voice dropouts; Cast unlocks slice
   1 of docs/CAST_RELAY.md (the hardware spike that go/no-goes the Chromecast
   TV-participant feature; slices 2+ follow).
2. Relayed-share bitrate cap (open item 3): pick a number and pass
   capRelayedVideoKbps from the web and extension mesh constructors. The
   classification and the cap logic already exist in packages/p2p; nothing
   sets the option, so a TURN-relayed share bills us at full rate.
3. The extension's revived-session queue hole (open item 7): ask for a
   snapshot on revive, the way the web asks with wantSnapshot. Small, and it
   closes a silent auto-advance gap.
4. AirPlay guidance copy (open item 11): docs/CAST_RELAY.md §2 specifies the
   two platform-keyed rows; PlayerControls.tsx has neither. This is copy in
   an existing popover, not a feature.
5. Web-slimming steps 4–5 (delete web player adapters + web
   getDisplayMedia): STILL GATED on verifying the extension drives a real
   room correctly end-to-end. Do that verification first — a real room, a
   real site, the installed extension — then the deletions per
   docs/WEB_SLIMMING.md. Note the blast radius recorded there: the adapters
   are not leaf files.
6. Mobile RN type defects (open item 10): hero 34→28px regression and
   unbundled JetBrains Mono (add expo-font, or stop naming the face).

Backlog after those: the mobile WebView postMessage bridge (open item 6 — a
mobile-only room on an embed cannot report its own endings), duration
resolution on queue insert so the advance guard verifies instead of prices
(open item 4), voice in the extension overlay (offscreen getUserMedia,
reuses the screen-share plumbing), account linking + playlist import,
media-anchored chat's server half (mediaPositionMs on messages), the ≤3-step
flow audit, and the Mode A/Mode B → synced-source/screen-share rename in the
remaining prose and comments (internal vocabulary only; users never see it).

There is ONE tier: no billing, no plans, no entitlements. Any doc, brief or
comment that tells you to add one is stale — fix the doc, do not build it.
The seven files in docs/history/ are records of why the code looks the way it
does, never instructions; each one's header lists what in it is already dead.

Read the "Orphans" section before deleting anything that looks unused —
BeaconSender/BeaconFollower, ChunkedUploader, restream.handoff and
ENABLE_MEDIA_PIPELINE are all live, tested code with no production caller.
Each needs a decision, not a reflex.

Use Workflow agents with DISJOINT file scopes — two agents in one file means
the second write silently loses the first. Prove fixes by mutation (break →
RED → restore); never git add -A while agents are in flight. Before a deploy,
re-run the gates with --force: a cached FULL TURBO green replayed old output
and proves nothing. And rebuild any of contracts/api-client/sync-core/p2p/
design you edited BEFORE typechecking downstream — they ship via dist, so an
unbuilt edit gives you a green that checked the old .d.ts. Adding a union
member breaks exhaustive switches loudly and falls through if-chains
SILENTLY; grep `.kind ===` as well as `switch`. And a mechanism with no
PRODUCER is dead code that passes its own tests — grep for what SENDS it.

The suite has no AUTOMATIC signal for real Mongo or real Redis. The Mongo
contract pass is gated on GATHER_TEST_MONGO_URL and skipped by default; Redis
has no equivalent. Anything you change in
services/api/src/adapters/{mongo-store,redis-bus}.ts is unverified until it
has run against a real instance.
```
