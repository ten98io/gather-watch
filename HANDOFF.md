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

`main` was `734c54e` when this session began; the wave's uncommitted work was
triageable after all — it is repaired, tested and committed on top (see git
log). `dev` trails and is an ancestor, so a fast-forward is all it needs. Live
probes at handoff: api
`/readyz` → `{"ok":true,"store":true,"bus":true,"busMode":"redis"}`, web 200,
ws 101. **Run `git status` before trusting any of this.**

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

Gates at the end of this session (2026-08-20, second cycle), forced,
consecutive all-green runs: **35/35 tasks — build 8/8, typecheck 9/9, test
207 files / 2769 passed / 18 skipped, lint 9/9.** Build is 8 and not 9 because
`apps/mobile` has no `build` script. NOTE `apps/web/turbo.json` now orders
web's typecheck after web's OWN build: tsconfig includes `.next/types/**`,
`next build` wipes `.next` mid-run, and the parallel typecheck died with
TS6053 on routes that plainly exist — a 3-of-6 forced-run flake on
2026-08-20, now structurally gone. A standalone `turbo typecheck --force`
therefore also builds web; the combined gate run costs nothing extra.

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

## Shipped in the billing-removal session (verified against the code)

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

## Adversarial audit 2026-08-19 (this session; findings + fixes)

A full read of the security-bearing surface: bootstrap (CORS/trustProxy/
rate limits/error mapper), auth (magic links, session rotation, guest scope),
rooms (role gates, bans, invites, the password gate), the WS hub, sync/
restream/queue write paths, chat (attachments, unfurl, SSRF), rtc, admin,
compliance, the extension's external channel, and the web/mobile clients.
What was already strong stays unsaid; what follows is what the audit CHANGED
or deliberately did not.

Fixed, each with a test:

- **W1 — the WS access token rode the `?token=` query string**, which lands in
  every access log the upgrade request touches. New clients (web, extension,
  mobile — all share api-client's RoomSocket) send it as a
  `Sec-WebSocket-Protocol` value (`WS_AUTH_SUBPROTOCOL_PREFIX` in contracts);
  the hub reads the header first and keeps the query form for
  already-installed extension/mobile builds. The /ws route's automatic
  request logging is dropped to warn-and-up so even the legacy form no longer
  reaches OUR logs. `packages/api-client/test/ws.test.ts` pins "token never
  in the URL"; `services/api/test/ws-hub.test.ts` pins the subprotocol path
  authenticates and carries frames.
- **A2 — refresh rotation raced itself.** Two concurrent refreshes with one
  cookie both minted successors; only the last write stayed verifiable, so
  the loser held a credential that matched nothing. The rotation write is now
  a compare-and-set on the presented hash; the loser gets 401. Pinned in
  `services/api/test/auth.test.ts`.
- **A10 — a guest whose membership was gone refreshed into an UNSCOPED token.**
  `assertGuestScope` only confines a token with a non-null roomId, and a
  kicked guest's membership row is deleted — so their next refresh minted a
  guest credential with no scope. Refresh now refuses (401) for a guest with
  no live, non-banned guest membership. Pinned in auth.test.ts.
- **W3 — WS frames had ws's 100 MiB default maxPayload.** A room member could
  make every server parse a 100 MB frame per window. The ceiling is now 64 KB
  at the plugin; oversized frames die with a 1009 close before parse. Pinned
  in ws-hub.test.ts.
- **C1 — attachment mime was the uploader's unverified claim.** A `text/html`
  attachment served inline off a gather.watch link is a phishing page with our
  redirect in front of it. The content route now signs
  `response-content-disposition: attachment` into the presigned GET for any
  non-image/audio/video asset. Pinned in attachments.test.ts (inline for
  media, download for the rest).
- **B1 — the web app shipped no security headers.** next.config.ts now emits
  nosniff, strict-origin-when-cross-origin, frame-ancestors 'none' / XFO DENY,
  a Permissions-Policy scoped to camera/mic/display-capture/autoplay, and a
  pragmatic CSP (script-src keeps 'unsafe-inline' for the inline theme
  bootstrap and Next flight data — the nonce pipeline is the known follow-up).
  Pinned by `apps/web/test/security-headers.test.ts`, which exists because a
  config-file deletion otherwise fails silently at deploy.

Reviewed and deliberately NOT changed (decisions, not oversights):

- `GET /assets/:assetId/content` is unauthenticated BY DESIGN (capability URL,
  Discord/Slack model); the bucket stays private and the id is unguessable.
- `restream.start` is membership-gated but not role-gated — guests may share;
  that is the product's ungated-share doctrine, not a hole.
- `sync.advance`'s unknown-duration floor PRICES a skip rather than proving
  one (open item 4 — CLOSED 2026-08-20 by resolution on queue insert; the
  floor survives only for rows no resolver and no player has measured yet).
- Refresh reuse detection scans live sessions in memory — O(n) per failed
  refresh; fine at current scale, worth a `rotatedHashes` array-contains query
  if session counts grow.
- Magic-link requests are capped only by the auth rate tier (20/min/IP) —
  email-bombing a stranger is possible but bounded; a per-address cooldown is
  the follow-up if it ever bites.

## Shipped 2026-08-19 (this session; verified against the code)

- **Room passwords, end to end.** scrypt `salt:hash` in
  `services/api/src/lib/tokens.ts`; host-only `PATCH /rooms/:roomId/password`;
  the gate prices a probe as a missing invite (identical NOT_FOUND for unknown
  code / missing / wrong); guests and accounts both gated; the wire carries
  `hasPassword`, never the hash. Web join page, room settings and mobile guest
  join carry the field. `services/api/test/rooms-password.test.ts` pins all of
  it, including "rotation kills the old password".
- **`serializeRoom` is now ONE function.** The hand-picked copies in
  `auth/routes.ts`, `admin/routes.ts` and `sync/serialize.ts` (deleted) all
  import `rooms/serialize.ts` — three copies of a security boundary was the
  exact "two-half contract" trap on the traps list.
- **Relayed-share ceiling wired.** `capRelayedVideoKbps: 400` from both share
  producers (web `call-mesh.ts`, extension `offscreen.ts`); the mesh caps only
  relayed links' share sender. The extension test suite now pins the ceiling
  reaches the mesh; the dynamic governor (FEATURE_PLAN §8) remains open.
- **Extension revive asks for a snapshot.** `presence.update { wantSnapshot:
  true }` on the resumed path closes the recycled-worker's unknown-queue
  window; pinned by two new tests (asks on revive, never otherwise).
- **AirPlay mirroring hint** on the share stage, below the picture, Apple
  platforms only — placement correction from "cast popover" recorded in
  `docs/CAST_RELAY.md` §2, because StagePane withholds the transport during a
  share.
- **Mobile type ramp repaired.** `hero` carries `rnFontSize: 34` (the old
  displayL); `emitRnTypeRamp` reads `rnFontSize ?? fontSize` and the web fluid
  ceiling never leaks into RN; `type.mono` names no face until expo-font
  bundles one. Pinned in both the design and mobile suites.
- **The wave's corrupted tree repaired.** Duplicated hunks in join-client,
  RoomMenu, contracts/rest, rooms/serialize, background.ts, DESIGN.md and this
  file are resolved; the mangled `passwordHash`-on-the-wire design became
  server-only `RoomDoc.passwordHash` + wire `hasPassword`.

## Shipped 2026-08-20 (extension/store-readiness session; verified against the code)

- **Provider registry has ONE copy** — `packages/contracts/src/providers.ts`
  (the superset: host regexes, DRM flags, cast descriptors, and NEW
  `grantPatterns` — https-only Chrome match patterns per provider). The
  extension re-exports it; `apps/web/lib/providers.ts` derives its rows; the
  `EmbedProvider` enum is WELDED to the registry by
  `packages/contracts/test/providers-registry.test.ts`. Contracts stays
  environment-free: `providerForHost` takes hostnames, URL parsing stays
  app-side. Adding a service is one edit.
- **Manifest narrowed for store review (FEATURE_PLAN 3.2 DONE).** The install
  demands no host access beyond Gather's OWN API origin — stamped at build by
  `stampManifest`, because an extension bypasses CORS only for origins it
  holds, and zero host access made every worker API call die in preflight
  ("Failed to fetch", found by the owner in the real browser on 2026-08-20;
  the suite fakes fetch and cannot see this class). Otherwise:
  `optional_host_permissions: ["<all_urls>"]`, and content.js reaches sites
  three ways — (1) a registered content script (`gather-driver`) mirroring
  the granted origins (allFrames + matchOriginAsFallback + persist), (2)
  activeTab + `executeScript` on popup connect (and a rate-limited rescue
  injection when the popup opens over a driven tab with no elected frame),
  (3) popup grant buttons ("Keep Gather on this site" — https only — and
  "Allow all supported sites" from the registry's grantPatterns). The one
  declarative content script covers exactly the five Gather origins (the
  announce). `content.ts` has a boot sentinel — double injection is a no-op.
  Version 1.0.0, icons 16/32/48/128 wired (generator:
  `apps/extension/scripts/gen-icons.mjs`), and `manifestShipErrors`
  (buildTarget.ts) fails the build on missing icons, an announce origin the
  content script misses (checked against the BUILD's effective origins), a
  placeholder version, or a description over Chrome's 132-char cap.
- **The volume half of PlaybackDriver is implemented.** Overlay audio row
  (mute + slider in the now-playing block) → `overlay:volume`/`overlay:mute`
  (driven-tab gate) → `setAudio` at the elected frame (licence-gated like
  `drive`) → guarded writes in `mediaDriver.applyDecision`; telemetry carries
  volume/muted INTERNALLY only — the external event-port shape is unchanged,
  and volume never becomes room state. `load()` stays 'unsupported' by
  design. Auto-duck deliberately NOT built: the only signal the worker can
  see is presence `micOn`, and a mic left open would pin the film at 35%
  indefinitely — the duck waits for a speech signal (arrives with overlay
  voice).
- **The install funnel is REACHABLE (WEB_SLIMMING step 3 done).**
  `extensionInstallUrl()` bottoms out at `/extension` (an honest docs page
  that ships with the web app and says the store listing does not exist
  yet); `NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL` wins when set.
  `<ExtensionGate>` is MOUNTED — page-kind stage branch only, desktop only,
  and the poster hands its install CTA to the gate (one gradient per region).
- **Popup password field.** Guest join carries `password` only when typed;
  the one error sentence is "Invite code not found — or the password is
  wrong." (the server prices probes — unknown code, missing and wrong
  password are the same NOT_FOUND).
- **The 'players' adversarial audit completed** (it died mid-run last
  session) and its blocker is fixed: an ad swapped into the driven element
  could fabricate `sync.advance` (one viewer's preroll skipped the film for
  the whole room), poison the fill-once `sync.duration` with the ad's
  length, and get hard-seeked to its own end by the drive loop. All three
  are closed by ONE predicate — `isInterstitialSource` (driver.ts §5):
  duration ≤120 s while the room's projection is >45 s past it ⇒ not the
  room's item ⇒ not driven, end not reported, duration not filled. The
  worker's veto and the drive tick share the same `roomProjectedMs()` so
  they cannot diverge. ACCEPTED TRADE (documented in README): a short
  genuine item in a projection-overrun room is also vetoed; recovery is
  Skip or a host seek.
- **Tab-share classification is FRESH.** `planShare` classifies from a new
  `chrome.tabs.get` read at share time, never the tab-provider cache —
  without host permissions `tabs.onUpdated` omits `changeInfo.url`, so the
  cache can silently describe the previous site across a cross-origin
  navigation (YouTube→Netflix shared as unprotected, once). An
  unclassifiable tab share is refused before the picker.

New known limits, deliberate and documented in the README: a page-JS pause
reads as user intent (IMA overlay-ad pattern — the room pauses with you); a
per-site grant cannot reach a cross-origin player iframe (frame-aware grants
are backlog; "all supported sites" covers known embed providers); the
popup's grant offer snapshots the tab at popup open (gesture-synchronous
request requires it); a mute set during an ad does not transfer to the film.

**Same day, second cycle (owner-directed cleanup + milestone + adversarial):**
the owner's region vision recorded in `docs/CONTENT_MATCHING.md` (user finds
it → extension syncs it, already true; "find it where you are" via the
user's own default engine); the **search bridge** shipped (popup button →
`chrome.search.query`, `search` permission — the first CONTENT_MATCHING
slice); **0.6 completed** (see closed open item 4 — placeholder-guarded
titles, budgeted enrichment, adder duration hints discarded); **orphans
resolved** (section above); **docs truth-swept** and the Mode A/Mode B
vocabulary retired from docs prose; **FEATURE_PLAN milestone-verified
end-to-end** — Phase 0 is essentially done (0.1–0.4/0.6/0.8 were already
wired in earlier sessions; the plan just didn't know), the landing page and
theater mode exist, and the DRM head-to-head cell is honestly ◐ until the
verification run is logged. Real-browser testing by the owner caught the
one blocker the suite structurally cannot (fetch is faked): **zero host
permissions had removed the extension's CORS exemption for its own API** —
every call died as "Failed to fetch"; fixed by stamping the API origin as
the single install-time host permission (portless match pattern — patterns
with ports are invalid to Chrome).

## Open items

1. **TURN keys** (user action) — voice dropouts persist until `CF_TURN_KEY_ID`
   and `CF_TURN_API_TOKEN` are set on the `api` service. Cannot be verified
   from the repo.
2. **$5 Cast spike** (user action) — Google Cast dev console registration
   gates the Chromecast TV-participant slice 1 (`docs/CAST_RELAY.md` §7).
3. **Relayed-share bitrate: static ceiling LANDED, dynamic governor unwired**
   (real money). Both share producers now pass `capRelayedVideoKbps: 400` —
   `apps/web/lib/call-mesh.ts` (`DEFAULT_CAP_RELAYED_VIDEO_KBPS`, the
   `getCallMesh` default) and `apps/extension/src/offscreen.ts`
   (`SHARE_RELAYED_VIDEO_CAP_KBPS`) — so a share that falls back to TURN no
   longer bills full rate per relayed viewer. What remains is the owner's
   superseding decision: wire the already-built `BitrateGovernor` +
   `LinkAdaptor` (`packages/p2p/src/adaptation.ts`) into the share sender per
   link, in the `docs/FEATURE_PLAN.md` §8 build order; the static cap becomes
   a ceiling on top of the governor for relayed links only.
   `packages/p2p/src/mesh.ts` classifies each link `direct`/`relayed` and
   applies the cap to the `share` sender on relayed links only.
4. ~~The advance guard PRICES a skip rather than verifying one when
   `durationMs` is null.~~ **CLOSED 2026-08-20**, the way this item asked:
   duration resolution on queue insert. `QueueService.add` background-enriches
   every insert through the metadata resolver (title past the
   `isPlaceholderTitle` guard, artwork, `durationMs`), so resolved rows hit
   `endingIsPlausible`'s VERIFY branch (`services/api/test/
   queue-insert-resolution.test.ts` pins refuse-at-21s / accept-at-the-end on
   a resolved ten-minute row). Honest residuals, stated: only Vimeo's oEmbed
   carries a duration, so most rows still fill from the FIRST player report
   (`sync.duration`, fill-once, interstitial-vetoed extension-side) and are
   priced at the 20 s floor until one arrives; the adder's own duration hint
   is now DISCARDED at insert (a member-chosen number was a lever on the
   guard — review find, 2026-08-20); and enrichment is budgeted per user
   (20/min, mirroring the REST tier on the identical lookup) so the WS door
   cannot out-fetch `POST /media/resolve`.
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
7. ~~An extension session revived after an MV3 worker recycle has an unknown
   queue until the next mutation.~~ **CLOSED 2026-08-19.** A revived worker now
   sends `presence.update { state: 'watching', wantSnapshot: true }` on the
   resumed path (`apps/extension/src/background.ts` `openSession`), the same
   door the web uses on refresh; the version-guarded `queue.state`/`sync.state`
   reducers were already in place. Pinned by two tests in
   `apps/extension/test/background.test.ts` (asks on revive; never on a fresh
   join or an ordinary beat).
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
   `getDisplayMedia`) — still gated on the real-room verification, which is
   now a SCRIPTED PROTOCOL with a results table in `docs/WEB_SLIMMING.md`
   (~45 min, owner runs it: build prod artifact at HEAD, YouTube + generic
   page + Netflix logged-in + a second DRM site + shares + worker-recycle +
   popup/password join; the DRM sites are NAMED per FEATURE_PLAN §9). Steps
   4–5 stay frozen until one run records all-PASS. The adapters and the
   `getDisplayMedia` call are all still present; see the doc header for the
   blast radius.
10. ~~Mobile RN type defects~~ **CLOSED 2026-08-19.** The hero step carries an
    explicit `rnFontSize: 34` (`packages/design/src/scales.ts` — the old
    displayL, neither the 28px web floor nor the 56px fluid ceiling, which
    `emitRnTypeRamp` was about to start emitting for body too; it reads
    `rnFontSize ?? fontSize` and `maxFontSize` NEVER leaks into RN). Pinned in
    `packages/design/test/scales.test.ts` and `apps/mobile/tests/theme.test.ts`.
    The mono step names NO face — JetBrains Mono is unbundled and
    'ui-monospace' is a CSS generic RN does not know, so `type.mono` is body
    metrics alone until the README font milestone lands expo-font. The absence
    is pinned so an unresolvable face name cannot come back.
11. ~~AirPlay guidance copy is designed but not written.~~ **CLOSED
    2026-08-19**, with a placement correction recorded in `docs/CAST_RELAY.md`
    §2: StagePane withholds the whole transport bar during a share, so the
    "cast control popover" does not exist at the relevant moment. The two
    platform-keyed strings live in `CastHint`
    (`apps/web/components/stage/ScreenShareStage.tsx`), a bar BELOW the share
    picture, shown to viewers on Apple platforms only.
12. ~~Room passwords — owner decision, implementation pending.~~ **CLOSED
    2026-08-19.** Optional passphrase, scrypt-hashed server-side
    (`hashPassword`/`verifyPassword` in `services/api/src/lib/tokens.ts`,
    `salt:hash` composite, timing-safe compare). Host sets/rotates/clears via
    `PATCH /rooms/:roomId/password` (host only; rotation IS recovery — no
    reset flow). The gate is probe-proof: unknown code, missing password and
    wrong password all answer the same NOT_FOUND. Existing members rejoin
    without re-verifying (join stays idempotent). The hash is server-only
    (`RoomDoc.passwordHash`); the wire carries `hasPassword: boolean`, and
    `serializeRoom` is now the SINGLE Room serializer — the copies in
    auth/routes.ts, sync/serialize.ts (deleted) and admin/routes.ts all read
    it. Web join page + room settings + mobile guest join carry the field;
    the extension popup honestly redirects to the web app. Tests:
    `services/api/test/rooms-password.test.ts` (hashing, management, the
    gate, the leak pin).
13. **User-relations layer — 0.9 widened.** Friends, block, per-user report,
    invite tracking (sent/accepted), private vs public invite links. Partiful is
    the reference. This is a new module, not a wiring job — schema, API routes,
    and UI. Scope it as a follow-on to 0.1–0.4.
14. **Theater mode spec — 2.5 finalized.** Fullscreen stage; hover/click glass-
    effect sidebar for chat; call participants as floating circular tiles on a
    configurable left/right edge. Needs design tokens for floating tile layout
    and a `theater` layout mode in the stage shell. See `docs/FEATURE_PLAN.md`
    §7 Phase 2 rulings.
15. **Admin console — 1.1 scoped.** Role-gated `/admin` area: marketing pages as
    code; reports queue, user/room lookup, invites. Admin is a role on a normal
    account, every route is checked server-side per request, opening an admin
    session requires a fresh magic-link step-up with a shorter TTL, and every
    admin action is audit logged. Not a second credential system; not URL
    obscurity. v1 is code-first; CMS-style editing is a later maybe.
16. **Content-matching ladder — scheduled.** Cross-region/DRM content resolution
    (`docs/CONTENT_MATCHING.md`) is the primary answer to the region-access
    question; the VPN/relay path is deferred behind it. Build order: external-ID
    enrichment on `ResolvedMedia` → availability probe → readiness handshake on
    the wire → specific rung-5 reason strings. See `docs/FEATURE_PLAN.md` §9
    plan amendments.

**Closed since the last handoff** (do not go looking for them): the settings
uploads panel no longer calls deleted media routes — `ChunkedUploader` and
`media.listLibrary` are out of `apps/web`, with `apps/web/test/no-library.test.ts`
pinning it; and a `page` item with no extension now renders `PageLinkStage`
instead of a blank stage.

## Orphans — resolved 2026-08-20 (owner-authorized cleanup)

The long-standing orphan inventory got its decisions. THREE WERE DELETED —
do not go looking for them, and treat any doc that still calls them live as
stale:

- ~~`BeaconSender` / `BeaconFollower`~~ **DELETED** (`packages/p2p/src/beacon.ts`
  and its tests are gone). Built for the deleted master clock; git history
  keeps it if a latency optimisation ever wants the pattern back. The
  `BeaconState` TYPE survives in `packages/p2p/src/channels.ts` — mobile's
  `SyncTransport` seam still names it (type-only); retiring that arm is a
  future mobile edit.
- ~~`ChunkedUploader` + `media.createUpload` / `completeUpload`~~ **DELETED**
  from `packages/api-client`. Chat attachments never went through here
  (`POST /rooms/:roomId/attachments`); the CreateUpload/CompleteUpload
  SCHEMAS stay in contracts, pinned by `apps/web/test/no-library.test.ts`.
- ~~`ENABLE_MEDIA_PIPELINE`~~ **DELETED** from `services/api/src/config.ts`;
  `config-media-pipeline.test.ts` is the absence tombstone (the coturn
  pattern). `GET /admin/overview` hardcodes `mediaPipeline: false` because
  the contracts field and the web admin page still expect it — dropping the
  wire field is a small contracts+web follow-up.
- **`restream.handoff`** — KEPT, deliberately: declared on the wire,
  unhandled by the server, sent by no client. Intentional and documented in
  `services/api/src/modules/restream/index.ts`; noted so nobody "fixes" the
  error reply by silently succeeding.
- The two empty test directories the old list mentioned no longer exist.

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
- **`tabs.onUpdated` omits `changeInfo.url` for origins the extension has no
  host access to** — under the narrowed manifest that is MOST origins, so any
  cache keyed on a tab's URL can silently describe the previous site across
  a cross-origin navigation. Classify fresh at the moment of consequence
  (`resolveTabProviderFresh` for shares); the cache is for cheap paths only.
- **Registered content scripts do not inject into already-open documents.**
  On `permissions.onAdded` you must `executeScript` the open matching tabs
  yourself (the boot sentinel makes it idempotent) — and the same fact is
  why `/extension` tells people to RELOAD their room tab after a
  load-unpacked install.
- **activeTab does not reach cross-origin iframes on an ungranted page, and
  dies on cross-origin navigation.** Granted origins have neither limit.
  Anything that "worked when I clicked the icon" and died later is usually
  this.
- **The store caps the manifest `description` at 132 characters.** A
  165-char description passed every gate here and would have been rejected
  at upload; `manifestShipErrors` now counts it, with the icon-existence,
  announce-coverage and version checks beside it.
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
Continue Gather (~/Desktop/gather-watch, live at gather.watch). Read
HANDOFF.md first — live state, open items, and the traps list.

Everything is on main and deployed; dev trails and fast-forwards. Deploys
come from GitHub — pushing to main redeploys both Railway services.
`railway up` is a local-source escape hatch, not the path.

Before you change anything, re-run the gates yourself with --force
(build/typecheck/test/lint) and `git status`. The forced numbers to beat:
35/35 tasks — test 207 files / 2769 passed / 18 skipped. (web's typecheck
now orders after its own build — apps/web/turbo.json — so the old
.next/types TS6053 flake cannot recur; if you see it, something regressed.)

THE ONE GATE EVERYTHING WAITS ON: the owner runs the real-room verification
protocol in docs/WEB_SLIMMING.md (~45 min, scripted end to end: prod
artifact at HEAD, YouTube, a generic page, Netflix + one more DRM site
logged in, shares, worker-recycle, popup/password join). Record the results
in the doc's runs table. All-PASS unlocks web-slimming steps 4–5 (delete
the web player adapters + web getDisplayMedia — blast radius in the doc)
and makes the head-to-head DRM claim real. If a run happened since last
session, execute steps 4–5 per the doc. If it FAILED anywhere, fixing that
outranks everything below.

Then, in this order:
1. Chrome Web Store submission (FEATURE_PLAN 3.1 — 3.2's narrowing is DONE,
   the manifest is store-shaped: no host_permissions, icons, 1.0.0,
   description under the cap, build-time ship checks). What remains is the
   listing itself: developer account, store assets/screenshots, privacy
   disclosures — owner work with light support. When the listing exists,
   set NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL (and _ID) on the web
   service; /extension keeps working as the fallback.
2. Voice in the overlay (owner-wanted; the biggest missing Model C piece —
   the README's "No voice yet" limit). Mic publisher in the offscreen
   document reusing the share plumbing + mesh lanes; sinks in the overlay;
   AUDIENCE_ROLES cam/mic gate on presence 'in-call'. MIND THE RULE: the
   extension never writes presence STATE from a timer — extend the
   background.test.ts pin to any new presence writer. This also unlocks
   auto-duck: DuckEnvelope/VolumeMixer in apps/web/lib/player/ducking.ts
   are the pattern, the overlay volume lever is the actuator, and a real
   speech signal is what was missing.
3. TURN keys / $5 Cast registration if they landed (user actions): TURN
   needs CF_TURN_KEY_ID + CF_TURN_API_TOKEN on the api service; Cast
   unlocks docs/CAST_RELAY.md slice 1.
4. Dynamic bitrate adaptation (open item 3): wire BitrateGovernor +
   LinkAdaptor into the share sender per link, build order in
   FEATURE_PLAN §8; the static relayed cap becomes a ceiling on top.
5. Frame-aware site grants (new, from this session's review): a per-site
   grant cannot reach a cross-origin player iframe. A webNavigation-based
   frame enumeration at grant time (or an "allow everywhere" affordance)
   closes the long tail; design against the README's Honest limits entry.

Backlog after those: content-matching ladder rungs 2–4 (item 16 — the
search bridge shipped as the first slice; readiness handshake next),
user-relations layer (13), theater mode (14), admin console hardening (15),
mobile WebView postMessage bridge (6), external-ID enrichment on
ResolvedMedia, account linking + playlist import, media-anchored chat's
server half, the ≤3-step flow audit, the admin-overview mediaPipeline wire
field's contracts+web removal, and the Mode A/Mode B rename in the
remaining CODE comments (docs prose is done; 'modeB' capability strings in
protocol.ts are wire-compat, rename deliberately).

There is ONE tier: no billing, no plans, no entitlements. Any doc, brief or
comment that tells you to add one is stale — fix the doc, do not build it.
The seven files in docs/history/ are records of why the code looks the way it
does, never instructions; each one's header lists what in it is already dead.

The orphan inventory was RESOLVED 2026-08-20 (see "Orphans — resolved"):
BeaconSender/BeaconFollower, ChunkedUploader and ENABLE_MEDIA_PIPELINE are
deleted; restream.handoff is deliberately kept unhandled. Before deleting
anything ELSE that looks unused, the rule stands: verify producers and
callers first, and REPORT rather than delete when in doubt.

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
