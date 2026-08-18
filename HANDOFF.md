# Session handoff — Gather

Read this first, then `docs/WEB_SLIMMING.md` (the one active migration) and
`docs/EXTENSION_FIRST.md` (the architecture it serves).

## Live state

**gather.watch is deployed and serving.** Railway project Gather: `api` + `web`
+ Redis, zero-downtime deploys (api gated on `/readyz`, web on `/`),
config-as-code on both services. Chat attachments use the `attachments` Railway
Bucket (`ams`) via reference variables, read through stable capability URLs
(`GET /assets/:assetId/content` → 60s presigned GET). Email: Cloudflare Email
Service, sender `email.gather.watch`. Mongo on Atlas. Repo
`mustafagandhi/gather-watch`; brand **Gather**; packages `@gather/*`.

The workspace is nine packages: `apps/web`, `apps/extension`, `apps/mobile`,
`services/api`, and `packages/{contracts,api-client,sync-core,p2p,design}`.
There is no `services/media` — it was deleted this session, source and Railway
service both. (A `services/media/` directory may still sit on disk holding
`dist/`, `node_modules/` and `.turbo/` leftovers; it has no `package.json`, so
pnpm and turbo do not see it. Deleting the directory is safe housekeeping.)

Stored rooms carry `relayMode`; every room is `'mesh'` today. `'cf-sfu'` is
still in the schema (`packages/contracts/src/entities.ts` `RelayMode`) and in
the p2p provider (`packages/p2p/src/relay.ts`), but nothing writes it — theater
is a layout, not a transport. No room ever successfully used LiveKit; it is
deleted from the codebase. Mesh + Cloudflare TURN is the topology, with the
Cloudflare Realtime SFU present as a design option and no client lane built.

## The architecture in five sentences

Read these before changing anything; each one has an audit finding behind it.

1. **One tier. There is no paywall, and there is nothing to build one out of.**
   The billing module, `Plan`, `Entitlements`, Stripe, `services/media` and
   every gate that read them are DELETED. Three tombstones fail if any of it
   comes back: `services/api/test/no-billing.test.ts` (no checkout / portal /
   entitlements / webhook / usage-ingest route), `services/api/test/
   rooms-ungated.test.ts` (theater and the publisher ceiling are ungated), and
   `apps/web/test/no-paywall.test.ts` (no plan, tier, upgrade or billing copy
   anywhere a user can see). Attachments are one flat `ATTACHMENT_MAX_MB = 200`
   for everyone (`services/api/src/modules/chat/attachments.ts`) — no per-user
   lookup exists. If a doc, brief or comment tells you to add a plan, it is
   stale: fix the doc.
2. **Media topology is mesh → Cloudflare TURN → Cloudflare Realtime SFU.**
   Mesh is the default and costs us nothing; TURN is the *connectivity*
   fallback (a NAT chose it, not us); the SFU is the *capacity* fallback for
   when the host's uplink cannot fan a share out. Nothing selects the SFU
   today — `CF_SFU_APP_ID` / `CF_SFU_API_TOKEN` are parsed into `AppConfig` and
   read by nothing else. LiveKit and coturn are both gone;
   `TURN_STATIC_AUTH_SECRET` was removed from `config.ts`, `.env.example`,
   `turbo.json`'s `passThroughEnv` and `infra/README.md` on 2026-08-18 because
   nothing read it. Setting that variable now does **nothing**;
   `services/api/test/config-coturn.test.ts` pins the absence at the config
   layer so it cannot come back as a silently-ignored key. See
   `docs/COST_MODEL.md` for the arithmetic.
3. **Rooms are endless.** They are created with `expiresAt: null`
   (`services/api/src/modules/rooms/service.ts`) and no clock ever expires
   them. The idle sweep deletes only rooms that are **empty** and have been
   quiet for `IDLE_ROOM_TTL_MS` (30 days); a room with members is never reaped
   however long it has been silent. The old 4-hour TTL is gone —
   `services/api/test/rooms-lifecycle.test.ts` pins all of this.
4. **Content never touches our infrastructure.** The extension drives each
   viewer's own player against the real site; we sync positions, not bytes.
5. **"Mode A" and "Mode B" are internal names only, and users never see them.**
   Mode A = synced-source playback, each device playing the source itself.
   Mode B = one member's tab/screen re-streamed to the room over the mesh. The
   user-facing words are "watch together" and "screen share". The web stage
   component finished its rename this session:
   `apps/web/components/stage/ScreenShareStage.tsx` — `ModeBStage.tsx` no
   longer exists, and neither does `apps/web/test/mode-b-share.test.ts`
   (`screen-share-host.test.ts` replaced it). The internal vocabulary survives
   in prose and in some comments; that is a pending cross-cutting rename, not
   a bug.

## Shipped this session (verified against the code)

- **Billing removed, root and branch.** `services/api/src/modules/billing/*`,
  `services/api/test/premium-gate.test.ts`, `services/media/**` and the web
  billing pages (`apps/web/app/billing/{success,cancel}/page.tsx`) are gone;
  the three tombstone suites above replaced them.
- **Screen share has its server half.** `services/api/src/modules/restream/`
  now registers the handler the wire contract always assumed
  (`ClientRestreamStart` / `Stop` / `Handoff` → `ServerRestreamState`).
  Before this, pressing "Share screen" fell into the hub's unknown-event error
  path and no state came back. A share is NEVER bitrate-capped: the old
  400 kbps free-tier guard went out with billing, and it had been capping every
  share anyway once the plan lookup was gone. The replacement lever exists but
  is unset — see open item 4.
- **Mesh lanes.** `packages/p2p/src/mesh.ts` `MESH_LANES = ['share']`. One
  identity can hold more than one mesh (the room mesh plus the share mesh);
  before lanes, both used the same connection id and collided.
- **`TrackRole` is `'share' | 'share-audio' | 'cam' | 'mic'`**
  (`packages/p2p/src/types.ts`). `share-audio` is new — tab audio travels as
  its own track.
- **`MediaRef` gained `{ kind: 'page', url }`** (`packages/contracts/src/
  entities.ts`) — any https page is queueable. The extension drives whatever
  `<video>`/`<audio>` that page mounts, on each viewer's own device.
- **Refresh restores room state** via an explicit `wantSnapshot` on
  `presence.update` (`services/api/src/modules/rooms/ws.ts`), because a
  reconnect cannot be told apart from a no-op beat.
- **`member.removed` is emitted and reduced.** `ServerMemberRemoved` carries
  `{ userId, reason }` with `MEMBER_REMOVAL_CLOSE_TEXT` mapping reasons to
  close-frame text on both sides; always ephemeral (seq 0). Reduced on web and
  mobile.
- **Presence keepalive**, React error boundaries (`apps/web/app/error.tsx`,
  `apps/web/app/global-error.tsx`, `apps/web/app/room/[id]/error.tsx`), web push
  (`services/api/src/modules/push/`, `apps/web/public/sw.js`), chat unread
  badges, content **ducking** (`apps/web/lib/player/ducking.ts` — target 0.35,
  attack 120 ms) and the **adaptive sync band** (voice-active tightening in
  `packages/sync-core/src/drift.ts`).
- **In-room playback history replaced the library.**
  `services/api/src/modules/rooms/history.ts`, `GET /rooms/:roomId/history`,
  `HISTORY_KEEP_PER_ROOM = 200`, one row per track change. There is no library
  and no upload pipeline.
- **The extension signs as the real user.** The web app hands off the room id
  plus a room-scoped access token over the externally-connectable channel
  (`apps/extension/src/external.ts`), so the extension drives as the signed-in
  member rather than as a guest. It fetches TURN itself
  (`GET /rtc/turn-credentials` from `offscreen.ts`), and its generic driver is
  unblocked.
- **Design tokens retightened** — radii 6/8/10/14, light aurora lightened, the
  ink-on-fill system added. `DESIGN.md` §2–§4 carries the numbers.
- **One design system** in `packages/design` — WCAG guards including
  ink-on-fill and the gradient maximin.
- **Cast, honestly**: always-visible control with honest states; Chromecast
  TV-participant designed in `docs/CAST_RELAY.md` (hardware spike pending);
  AirPlay = OS-mirroring guidance; server relay deferred. Client-side-first
  doctrine is binding.
- **No worker brief sits in a live source directory any more.** All four
  (`chat`, `mobile`, `rooms`, `compliance`) are in `docs/history/` under a
  header that names what in them is dead and why they moved: they are written
  in the imperative and read as standing orders where they sat.

Costs: `docs/COST_MODEL.md` (verified rates; three lines cannot be closed).

Gates at the end of this session, forced (not cached): build 8/8, typecheck
14/14, test 1721 passed / 0 failed across 129 files, lint 9/9. The counts are
higher than the nine workspaces because `test` and `typecheck` both
`dependsOn: ["^build"]`, so each run also builds the five `dist`-shipped
packages.

## Open items

1. **TURN keys** (user action) — voice dropouts persist until `CF_TURN_KEY_ID`
   and `CF_TURN_API_TOKEN` are set on the `api` service. Cannot be verified
   from the repo.
2. **$5 Cast spike** (user action) — Google Cast dev console registration
   gates the Chromecast TV-participant slice 1 (`docs/CAST_RELAY.md` §7).
3. **Web-slimming steps 4–5** (delete web player adapters + web
   `getDisplayMedia`) — still gated on a real-room verification that the
   extension drives playback correctly. `apps/web/lib/player/{youtube,
   soundcloud,vimeo,native,embed,adapter}.ts` and the `getDisplayMedia` call
   in `apps/web/components/stage/ScreenShareStage.tsx` are all still present.
   See `docs/WEB_SLIMMING.md` header for the blast radius.
4. **Relayed-share bitrate cap is unset** (real money, one line of wiring).
   `packages/p2p/src/mesh.ts` already classifies each link `direct`/`relayed`
   and will cap the `share` sender on a relayed link — but only when a caller
   passes `capRelayedVideoKbps`, and no caller does. `apps/extension/src/
   offscreen.ts` threads the option through to the mesh and never sets it; the
   web mesh constructor does not offer it at all. So a share that falls back to
   TURN runs at full rate on our bill (~$0.186/hr for 5 relayed viewers,
   `docs/COST_MODEL.md` risk 1). Decide a number (the doc suggests
   300–500 kbps) and pass it from the web and extension mesh constructors.
5. **The settings uploads panel calls routes that no longer exist.**
   `apps/web/app/settings/page.tsx` runs `ChunkedUploader` against
   `api.media.createUpload` / `completeUpload` and lists `api.media.listLibrary`
   — but `services/api/src/modules/` has no media module, and the only routes
   served under those prefixes are `POST /media/resolve` (metadata) and
   `GET /assets/:assetId/content` (chat attachments). So the panel 404s on
   open. `packages/api-client/src/rest.ts` says so in a comment beside
   `media.listLibrary` and keeps the method anyway. The contracts, the client
   surface (`rest.ts`, `upload.ts`) and the `ChunkedUploader` tests are all
   still real and green — this is a live UI wired to a deleted backend.
   Decide: delete the panel and the client surface with it, or serve the
   routes. Do not leave it half-wired.
6. **A `page` item with no extension renders a blank stage** — confirmed, not
   suspected. In `apps/web/components/stage/StagePane.tsx`: `adapterKindFor`
   correctly returns `null` for `{ kind: 'page' }`, so every player branch is
   `hidden`; `EmptyStage` renders only when `mediaRef === null`; and
   `ExtensionDrivingStage` renders only when the extension is actually driving.
   That leaves "page item, no extension" with nothing on stage at all. The
   queue row's hint (`apps/web/test/queue-page-link.test.tsx`) and mobile's
   `PageStage` (`apps/mobile/src/components/Stage.tsx`) both say the right
   thing; the web stage is the hole. Fix is a stage branch, not an adapter
   change — do not make `adapterKindFor` return `'native'` for a page, which is
   the bug it was just fixed out of.
7. **Mobile RN type defects** — the hero step is 28px in `packages/design/src/
   scales.ts` (`maxFontSize: 56` is a web-only fluid ceiling; RN takes
   `fontSize`), so mobile's old 34px `displayL` regressed to 28. JetBrains Mono
   is unbundled — `apps/mobile` has no `expo-font` dependency, so `type.mono`
   names a face RN never loads and numeric readouts jitter on the fallback.

## Traps discovered the hard way

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
  only by luck (its allowlist meant it rendered *nothing* instead of crashing —
  silent, but not broken). So: grep `\.kind ===` as well as `switch`, and
  convert each chain you find to an exhaustive switch with a
  `default: { const unhandled: never = ref; }`. `apps/mobile/src/components/
  Stage.tsx` is the worked example, and deleting one of its `case` lines is a
  two-second demonstration that the guard is live. The same rule applies to
  `TrackRole` — `'share-audio'` was added this session.
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
- **Railway cache-mount ids** must be unique per service or Docker builds
  poison each other's pnpm store cache.
- **`railway link` writes to `~`** — linking runs against the home-directory
  config, not the repo; re-check which project/service is linked before `up`.
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

## Environment notes

- Local dev: web :3000, api :4000. Nothing boots on :4500 any more —
  `services/media` is gone. `pnpm build` first (contracts, api-client,
  sync-core, p2p and design all ship via `dist`), then test/typecheck.
- `pnpm dev` runs web and api only; `apps/extension` and `apps/mobile` have no
  `dev` task (extension builds, mobile has `start`).
- Extension prod build (MV3 inlines the origin at build time):
  `GATHER_API_URL=https://<api-domain> pnpm --filter ./apps/extension build`,
  then chrome://extensions → Load unpacked → `apps/extension/dist`. The web
  origins the extension will talk to are inlined the same way
  (`GATHER_WEB_ORIGINS=…`) and must stay a subset of the manifest's
  `externally_connectable.matches`. Chrome 137+ ignores `--load-extension`;
  there is no automated install path for a real profile, by Chrome's design.
- The web app finds the extension without configuration (content script
  announces its id on Gather origins); `NEXT_PUBLIC_GATHER_EXTENSION_ID` only
  pins it.

## Next session — starting prompt

```
Continue Gather (~/Desktop/playin, live at gather.watch). Read HANDOFF.md
first — live state, open items, and the traps list.

Everything is on main and deployed. Before you change anything, re-run the
gates yourself with --force (build/typecheck/test/lint) and `git status` —
the last thing this repo saw was a multi-agent wave, so confirm the tree is
clean rather than taking a previous session's word for it.

Pick up in this order:
1. If the TURN keys and/or the $5 Cast registration landed since last
   session, wire them: TURN needs only CF_TURN_KEY_ID + CF_TURN_API_TOKEN on
   the api service and a redeploy to heal voice dropouts; Cast unlocks slice
   1 of docs/CAST_RELAY.md (the hardware spike that go/no-goes the Chromecast
   TV-participant feature; slices 2+ follow).
2. The blank stage for a `page` item with no extension (open item 6) — the
   smallest real user-facing bug on the list. Add the stage branch; do not
   touch adapterKindFor.
3. Web-slimming steps 4–5 (delete web player adapters + web
   getDisplayMedia): STILL GATED on verifying the extension drives a real
   room correctly end-to-end. Do that verification first — a real room, a
   real site, the installed extension — then the deletions per
   docs/WEB_SLIMMING.md. Note the blast radius recorded there: the
   adapters are not leaf files.
4. Relayed-share bitrate cap (open item 4): pick a number and pass
   capRelayedVideoKbps from the web and extension mesh constructors. The
   classification and the cap logic already exist in packages/p2p; nothing
   sets the option, so a TURN-relayed share bills us at full rate.
5. Settings uploads panel (open item 5): it calls media routes the API
   does not serve, so it 404s on open. Delete it and the client surface
   behind it, or serve the routes — not half of each.
6. Mobile RN type defects (open item 7): hero 34→28px regression and
   unbundled JetBrains Mono (add expo-font, or stop naming the face).

Backlog after those: voice in the extension overlay (offscreen getUserMedia,
reuses the screen-share plumbing), account linking + playlist import,
media-anchored chat's server half (mediaPositionMs on messages), the ≤3-step
flow audit, and the Mode A/Mode B → synced-source/screen-share rename in the
remaining prose and comments (internal vocabulary only; users never see it).

There is ONE tier: no billing, no plans, no entitlements. Any doc, brief or
comment that tells you to add one is stale — fix the doc, do not build it.
The seven files in docs/history/ are records of why the code looks the way it
does, never instructions; each one's header lists what in it is already dead.

Use Workflow agents with DISJOINT file scopes — two agents in one file means
the second write silently loses the first. Prove fixes by mutation (break →
RED → restore); never git add -A while agents are in flight. Before a deploy,
re-run the gates with --force: a cached FULL TURBO green replayed old output
and proves nothing. And rebuild any of contracts/api-client/sync-core/p2p/
design you edited BEFORE typechecking downstream — they ship via dist, so an
unbuilt edit gives you a green that checked the old .d.ts. Adding a union
member breaks exhaustive switches loudly and falls through if-chains
SILENTLY; grep `.kind ===` as well as `switch`.
```
