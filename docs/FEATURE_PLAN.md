# Gather vs WatchParty — competitive position and feature plan

Written 2026-08-18. Compares Gather against `watchparty.me` / `howardchung/watchparty`,
`m1k1o/neko` (the engine underneath WatchParty's headline feature), and the wider
co-watching category. Every competitor claim below was checked against a primary source;
every Gather claim was checked against the code and carries a `file:line`.

The conclusion in one line: **Gather is not behind WatchParty on architecture — it is
ahead, and the category's graveyard proves it. Gather is behind on the fact that six of
its own finished server capabilities have no client, and that a first-time visitor cannot
get into a room without an email round-trip.**

> **STATUS 2026-08-20 — the first half of that sentence is retired.** The six
> no-client capabilities are wired: report (0.1), moderators (0.2), policies
> (0.3), leave (0.4), queue-insert resolution (0.6) and the restream gate (0.8)
> all carry client callers or server gates now — see the dated statuses in §4.
> The email round-trip stands, as the §7 identity decision, not as a gap.

---

## 1. The fork in the road

The two products solve the same problem in opposite directions, and the direction is the
whole story.

**WatchParty moves the content.** Its answer to "Netflix won't let you screen-share" is
the **VBrowser**: a real Chromium on a cloud VM (an `m1k1o/neko` container), streamed to
the whole room over WebRTC, one person holding keyboard and mouse. That works with
anything, needs no install, and one login serves the room. It also costs neko's documented
**4–8 CPU cores and 3–4 GB of RAM per room** for a single 1280x720@30 session — per *room*,
not per user — plus one WebRTC egress stream per viewer. That is why WatchParty has to
ration it: free users get 720p, 3-hour sessions, and "when capacity allows"; the $5/month
Plus tier buys 1080p, 24 hours, region choice and "anytime".

**Gather moves the clock.** Every member plays their own licensed copy, in their own
session, from their own region's CDN, with their own DRM licence
(`docs/CONTENT_MATCHING.md`). The room synchronizes play/pause/seek/position and nothing
else. Screen share, when it happens, is a peer-to-peer mesh with Cloudflare TURN as the
connectivity fallback — no server in the media path.

The cost difference is roughly an order of magnitude. `docs/COST_MODEL.md` prices a
6-person screen-share room-hour at **~$0.22 worst case**, and a mesh room at effectively
zero. Hyperbeam — the virtual-browser primitive sold as an API — publishes **$0.007 per
participant-minute**, which is **~$2.52** for the same six people for an hour.

### The graveyard votes for Gather's direction

| Product | What happened | Cause |
|---|---|---|
| **Rabbit** | Shut down July 2019, IP sold to Kast | Hosted shared browser sessions; hosting other people's pixels was unmonetizable |
| **Metastream** | Stopped publishing open source Aug 2024 | Could not get a Widevine licence; no revenue against rising DRM restrictions |
| **Giggl** | $2.2M from Craft Ventures, ~20k MAU — domain no longer resolves in DNS | — |
| **Hyperbeam** | Pivoted from consumer watch party to selling the virtual-computer API | The primitive was the business; the consumer product wasn't |
| **Kast** | Absorbed into Amaze (Apr 2025) to bolt on live shopping; `kast.gg` is a landing page | Screen-share-first, DRM black screens |
| **Buzzer** | $44M raised, B2C→B2B pivot, wound down | — |
| **Airtime** | Sean Parker / Shawn Fanning; now a B2B "video at work" tool | — |

And the first-party features died of indifference, not competition: **Prime Video Watch
Party** (removed ~Feb 2024, no announcement), **Disney+ GroupWatch** (18 Sept 2023),
**Twitch Watch Parties** (2 Apr 2024 — "usage… has declined over the years"), **YouTube's
Meet co-watch** (Aug 2025), **Plex Watch Together** (sunsetting to web-only). **Hulu Watch
Party** is the last native survivor and sits inside an app Disney is retiring during 2026.
**Netflix has never shipped one.**

What survives is Apple SharePlay (Apple devices, FaceTime-bound) and Spotify Jam (Premium
to host *and* to join remotely). Both are single-catalog and platform-locked. **The
cross-platform, mixed-catalog, everyone-brings-their-own-subscription room is unowned.**

That is the market Gather is in, and its architecture is the correct one for it. The plan
below never proposes reversing it.

---

## 2. Head-to-head

Legend: ● shipped · ◐ partial or unreachable · ○ absent

| | Gather | WatchParty | Note |
|---|:---:|:---:|---|
| **Getting in** ||||
| Room in one click, no account | ○ | ● | WP: "New Room" → `/watch/nonstop-cake-interpret`. Gather: `rooms/routes.ts:49` is `requireAccount` |
| Marketing / landing page | ● | ● | **Shipped 2026-08-20** — `apps/web/app/page.tsx` is now a real front door (hero + three product pillars); the redirect survives only for an already-live session |
| Guest join by link | ● | ● | `auth/routes.ts:146` — room-scoped, throwaway identity |
| Guest → account upgrade | ◐ | ● | Route live (`auth/routes.ts:148`), **zero client callers** — and as of 2026-08-20 the two screens no longer promise it (settings and join dropped the copy; §7 ruling retires the lane) |
| Link unfurls in a messenger | ○ | ● | No `openGraph` anywhere in `apps/web/app` — the growth mechanic previews as nothing |
| **Sources** ||||
| YouTube / Vimeo / SoundCloud | ● | ● | Full position-API sync |
| Any https page (long tail) | ● | ◐ | `{kind:'page'}` + the extension's generic driver — WP needs a VBrowser for this |
| Netflix / Disney+ / Max / Hulu / Prime / Crunchyroll etc. | ◐ | ◐ | Gather: extension drives each viewer's own player. WP: only inside a VBrowser, and DRM often blocks it there. **Demoted ● → ◐ 2026-08-20 per the §9 amendment**: the real-room login-and-drive pass is scripted (`WEB_SLIMMING.md` §Real-room verification) but has never been run |
| Spotify / Apple Music / Tidal / Deezer | ● | ○ | `EmbedProvider` — approximate sync, badged as such |
| Direct file URL / HLS / DASH | ◐ | ● | `{kind:'url'}` works; `{kind:'hls'}` is **unreachable** — it needs an `AssetId` from a deleted upload pipeline |
| Content search (paste-free) | ○ | ● | WP has a YouTube search box. Gather: pasting a URL is the only way to queue anything, on every client |
| Magnet / torrent | ○ | ● | Deliberate — see §5 |
| Local file to the room | ○ | ● | `packages/p2p/src/fileshare.ts` is **559 lines of finished, tested, unwired code** |
| Virtual browser | ○ | ● | Deliberate — see §5 |
| **In the room** ||||
| Synced play/pause/seek | ● | ● | Gather's is offset-aware and elastic; WP's catch-up is *disabled by default* (issue #993) |
| Playback rate | ● | ● | `sync.rate`, 0.25–4x, clamped and policy-gated |
| Queue + auto-advance | ● | ● | Gather's advance is a compare-and-set intent, no elected master |
| Vote-to-skip | ● | ○ | `skipVoteThreshold` — WP has no equivalent |
| Text chat | ● | ● | + attachments, GIFs, mentions, unfurl, pins, search, voice notes |
| **Chat anchored to media position** | ○ | ● | WP logs every action with its video timestamp and makes it clickable. Specced in `EXTENSION_FIRST.md`, `grep mediaPositionMs` is empty |
| Emoji reactions on messages | ● | ● | |
| Floating emote bursts | ● | ○ | `EmoteOverlay.tsx` |
| Voice + video call | ● | ● | Mesh, `TrackRole` = share / share-audio / cam / mic |
| Screen share | ● | ● | Both mesh-based; both cap around 6–8 viewers on the host's uplink |
| **Subtitles** | ◐ | ● | Gather: in-band only, native adapter only, no file, no language picker, no offset. WP has OpenSubtitles search *by file hash* |
| Theater mode | ● | ● | |
| Fullscreen control | ● | ● | **Shipped 2026-08-20** — theater and fullscreen are one local immersive mode (`ImmersiveStage.tsx`), with a transport-bar fullscreen control + F shortcut (`StagePane.tsx:146`). YouTube's own button stays disabled, now for a true reason (`lib/player/youtube.ts:144-151`) |
| Playback history | ● | ○ | `HISTORY_KEEP_PER_ROOM = 200` |
| **Room control** ||||
| Host / moderator / member / guest roles | ● | ◐ | Four roles exist and are enforced. **Wired 2026-08-20** — `PeoplePane.tsx:163,358` promotes/demotes moderators via `POST /members/role` |
| Kick / ban | ● | ● | Wired in `PeoplePane.tsx:128,141` |
| Change who can play/queue/chat | ● | ● | **Wired 2026-08-20** — room settings panel calls `api.rooms.updatePolicies` (`RoomMenu.tsx:189`), covering the three tiered policies, skip threshold and waitForAll |
| Leave a room | ● | ● | **Wired 2026-08-20** — `api.rooms.leaveRoom` from the room menu (`RoomMenu.tsx:203`; `room-shell.tsx:383`) |
| Invite rotation / revoke | ◐ | ● (password) | The built-in code is still permanent and nothing revokes. **2026-08-20:** the server can now mint expiring extra invites (`rooms/service.ts:534-551`; join honours `expiresAt`, `:260-262`) — but with **zero client callers**, so ◐ not ● |
| Permanent rooms | ● | ◐ | Gather: all rooms, always, free. WP: 1 free, 20 for subscribers |
| **Reach** ||||
| Desktop web | ● | ● | |
| Browser extension | ● | ○ | **WatchParty has no extension.** This is Gather's structural advantage |
| Native mobile | ◐ | ○ | Expo app at ~40% of web: no calls, no settings, no push, no screen share, no chat attachments |
| TV / cast | ◐ | ○ | Honest cast control shipped; Chromecast-as-participant designed, hardware spike pending |
| **Business** ||||
| Price | Free, one tier | Free + $5/mo | |
| Self-hostable | ● | ● | `infra/docker-compose.yml` |
| Product analytics | ○ | ◐ | **Zero.** No analytics, no error tracking, no feature flags, anywhere |
| Report button | ● | ◐ | **Wired 2026-08-20** — `ReportDialog.tsx:51` → `POST /report`, reachable from the message context menu (`MessageBubble.tsx:467`), the People pane (`PeoplePane.tsx:428`), room menu and stage; the `legal/abuse` promise is now true |
| Discord bot | ○ | ● | `/watch` returns a fresh room link — WP's main top-of-funnel |

---

## 3. Where Gather already wins

1. **The extension.** WatchParty has none. It is what makes DRM sites work legally, and
   it is the one thing a VM fleet cannot replicate: everyone keeps their own account,
   their own region, their own quality, their own captions.
2. **Cost structure.** ~$0.22/room-hour worst case against Hyperbeam's ~$2.52 equivalent.
   Gather can be free and stay free; WatchParty must ration its best feature.
3. **Accessibility, structurally.** Under screen-share co-watching every viewer is forced
   onto the host's caption setting, subtitle language, audio track and quality — and DRM
   commonly blanks the share entirely. Under synced-source playback each viewer keeps
   their own captions, audio description, language and speed. This is not a feature to
   add; it is a property of the architecture, and nobody in the category is saying it.
4. **Elastic sync that is honest about physics.** Sync drift is the single most-cited
   complaint against every extension product in the category, and WatchParty's own fix is
   *off by default*. Gather's offset-aware controller (2s deadband, learned per-viewer
   anchor, hard seek only past 12s) treats a stable offset as success rather than failure.
5. **Rooms never expire, everything is free.** WatchParty gates permanent rooms at 1 free
   / 20 paid. Gather's tombstone tests make the one-tier rule structural.
6. **Mobile and native apps exist at all.** Rave is the only competitor that took the
   couch seriously, and Apple removed it from the App Store.
7. **A real design system with enforced WCAG contrast** (`packages/design/test/palette.test.ts`
   fails the build). No competitor is within sight of this.

---

## 4. The plan

### Phase 0 — Connect what is already built (≈2–3 weeks, ~$0)

Six finished, tested server capabilities have **zero client callers**. This is the highest
value-per-hour work in the repo, and none of it needs a new idea.

*(2026-08-20: no longer true — the phase is essentially done. 0.1–0.4, 0.6 and
0.8 are wired; 0.7's static half landed; 0.5 is inverted by the §7 ruling and
0.9 has only its server half. Statuses per row below.)*

| # | Item | Where | Grade |
|---|---|---|---|
| 0.1 | ~~**Report button.** Wire `POST /report` into the message context menu and People pane.~~ **DONE 2026-08-20** — `ReportDialog.tsx:51` calls `api.reports.create` (`rest.ts:587-594`), reachable from the message context menu (`MessageBubble.tsx:467-479`), the People pane (`PeoplePane.tsx:428-431`), the room menu and the stage; covered by `apps/web/test/report-controls.test.tsx`. The pipeline is fed and the `legal/abuse` promise is true. | `packages/api-client/src/rest.ts`, `MessageBubble.tsx`, `PeoplePane.tsx` | S |
| 0.2 | ~~**Make moderators real.** One api-client method + one menu item.~~ **DONE 2026-08-20** — `PeoplePane.tsx:163` posts `/rooms/:id/members/role` (`rest.ts:373`); the row menu toggles moderator (`PeoplePane.tsx:358`). The `'mods'` tier is reachable. | `rest.ts`, `PeoplePane.tsx` | S |
| 0.3 | ~~**Room settings panel.** `PATCH /policies` has no caller.~~ **DONE 2026-08-20** — `RoomMenu.tsx:189` calls `api.rooms.updatePolicies` (`rest.ts:357`) with per-policy patch builders, the skip-vote threshold and the waitForAll toggle (`RoomMenu.tsx:52,142,351`). | `RoomMenu.tsx` | S |
| 0.4 | ~~**Leave a room.** The control is a link to `/home`.~~ **DONE 2026-08-20** — `RoomMenu.tsx:203` calls `api.rooms.leaveRoom` (`rest.ts:343`); `room-shell.tsx:383` records that leaving now lives in the room menu. | `RoomMenu.tsx` | S |
| 0.5 | **Guest → account upgrade.** Two screens tell guests to add an email; no client calls the live route. Every guest is permanently locked to one room and one browser. This is the funnel. *(Ruling inverted — see §7. STATUS 2026-08-20: the route is still live with zero callers, and the two screens no longer promise the upgrade — settings and the join screen both dropped the copy. Cutover status lives in the §7 box.)* | `settings/page.tsx`, `join-client.tsx` | S |
| 0.6 | ~~**Content resolution on queue insert.**~~ **DONE 2026-08-20** — `QueueService.add` background-enriches every insert through the metadata resolver (`queue/service.ts:198,221-263`): titles are replaced only past the `isPlaceholderTitle` guard (`:630`), the resolved `durationMs` wins over client hints and is pinned against later `sync.duration` reports, and the advance guard now *verifies* resolved rows instead of pricing a 20s skip (`services/api/test/queue-insert-resolution.test.ts`). HANDOFF open item 4 closed. | `QueuePane.tsx:366`, `queue/service.ts` | M |
| 0.7 | **Relayed-share bitrate cap.** The classifier and the applier are written, debounced and tested; no caller passes `capRelayedVideoKbps`. Today a share that falls back to TURN runs at full rate on our bill — $0.186/hr for 5 relayed viewers, `COST_MODEL` risk 1. Pick 300–500 kbps, pass it from both mesh constructors, add one line of UI copy. *(STATUS 2026-08-20: the static half as written here is DONE — 400 kbps passed from both surfaces (`call-mesh.ts:1172,1189`; `offscreen.ts` `SHARE_RELAYED_VIDEO_CAP_KBPS = 400`) and applied per relayed link in `mesh.ts:1669-1712` (`capFor`/`reconcileCaps`). The superseding dynamic governor of the §7 ruling is still unwired — `BitrateGovernor`/`LinkAdaptor` keep zero mesh callers.)* | `offscreen.ts`, `call-mesh.ts` | S |
| 0.8 | ~~**Server-gate `restream.start`.**~~ **DONE 2026-08-20** — `restream/service.ts:146` routes through `policyAllows(SHARE_POLICY, member.role)` after membership + ban (`:143`), `maxPublishers` is enforced server-side (`restream/service.ts:25,68`), and the contracts comment "(policy-gated)" (`ws.ts:279`) is now telling the truth (`restream/service.ts:58-61` says so in as many words). | `restream/service.ts`, `contracts/ws.ts` | S |
| 0.9 | **Invite rotation + revoke.** Codes are permanent and irrevocable; a kicked member keeps a working key forever, and rotation is the documented answer to un-bannable guests. Must go through the unique-index insert path. *(STATUS 2026-08-20: server half only — host/mods can mint extra invites with `expiresAt` through the unique-index path (`rooms/service.ts:534-551`) and join honours expiry (`:260-262`), but there are **zero client callers**, the built-in code is still permanent, nothing revokes an existing code, and the §7-widened user-relations layer is unbuilt.)* | `rooms/service.ts` | S |

### Phase 1 — The front door (≈3–4 weeks)

WatchParty's biggest advantage over Gather is not the VBrowser. It is that a stranger
clicks one button and is in a room. Gather requires an email round-trip before a room can
exist at all.

| # | Item | Why | Grade |
|---|---|---|---|
| 1.1 | **A landing page at `/`.** Today `/` is a redirect gate. There is no page that explains the product, no SEO surface, and no answer to "what is this" for anyone who isn't already signed in. The category's organic search is currently owned by SEO content farms funnelling to competing products — one of which publishes a *false* claim that Scener shut down. *(STATUS 2026-08-20: the landing page is DONE — `apps/web/app/page.tsx` is a real front door, redirecting only live sessions. Of the §7 admin-area ruling, a v1 console is live — `/admin` overview/metrics/reports/rooms/users/usage, checked server-side per request (`admin/routes.ts:34-48`) with a reports queue in `apps/web/app/admin/page.tsx` — but admin is an owner email allowlist (`config.adminEmails`), not a role, and the fresh magic-link step-up and audit log are not built.)* | The entire top of funnel | M |
| 1.2 | **Instant room, no account.** Let an anonymous visitor create a room and claim it later with an email. This is a policy change to `rooms/routes.ts:49` plus the 0.5 upgrade path, not new machinery. Weigh it against the abuse surface in 1.5. | Matching WatchParty's single biggest funnel advantage | M |
| 1.3 | **Open Graph metadata + a room preview image.** The invite link is the entire growth mechanic and it currently unfurls as nothing in every messaging app. | Free distribution | S |
| 1.4 | ~~**Onboarding: explain "everyone plays their own copy".** The core idea is never stated on any screen of any client.~~ **DONE 2026-08-20** — stated on the landing page pillars (`page.tsx`), in-room on the embed-tier badge ("Everyone plays their own copy… the room keeps you all on the same second", `StagePane.tsx:684`), in the extension-gate copy (`StagePane.tsx:617`), and in the store listing description (`manifest.json`). | Retention | S |
| 1.5 | **Abuse floor before 1.2 ships.** No CAPTCHA, no disposable-email filter, no per-email send throttle, no room-creation cap, and rate limiting is per-instance in-memory while Redis is already a hard dependency. Move the limiter to Redis first. | Prerequisite | S |
| 1.6 | **Product analytics + error tracking.** There is none, anywhere. There is currently no instrumented answer to "did the invite convert", "did anyone come back", "did that release break the room". Do not ship Phase 1 blind. | Prerequisite for every decision after this | S |

### Phase 2 — The features that make a room worth staying in (≈6–8 weeks)

| # | Item | Grade | Note |
|---|---|:---:|---|
| 2.1 | **Media-anchored chat timestamps.** Every message carries `mediaPositionMs`; clicking one seeks the room; messages ahead of *your* playhead are held with an "N messages ahead" affordance. Server half is one nullable field and one write. | M | Already specced in `EXTENSION_FIRST.md`, unbuilt. Highest product value per dollar on this list, and it is what WatchParty gets the most mileage from — with a spoiler shield they don't have. |
| 2.2 | **Subtitles, tier A.** `subtitleUrl` on `QueueItem`, appended as a `<track>`. The toggle and mode-setting loop already exist in `StagePane.tsx` and only ever see in-band tracks. | S | Tier B (OpenSubtitles lookup, incl. by file hash) is a follow-on. State the limits in the UI: it works for real media elements, not embeds. |
| 2.3 | **Content search in the queue.** Pasting a URL is the only way to add anything, on every client. | M | Builds on 0.6 |
| 2.4 | **Local-file playback over the mesh.** `packages/p2p/src/fileshare.ts` is a complete, tested chunked transfer with credit-based flow control and seek-window prioritisation, and the `file` DataChannel is already opened pre-negotiated on every peer link. Nothing outside its own test constructs it. | M | Two real problems first: the client assembles the whole file into one `Uint8Array` (a 2 GB movie is 2 GB of JS heap — needs OPFS + MSE), and chunk payloads are base64, a structural 33% inflation that is *worse* than a relayed screen share on a TURN link. Cap it or refuse it on relayed links. |
| 2.5 | ~~**Fullscreen.**~~ **DONE 2026-08-20**, as the §7 theater-mode spec: theater and fullscreen are one LOCAL immersive mode (`ImmersiveStage.tsx:6,52`) — fullscreen stage with browser fullscreen as the enhancement (`StagePane.tsx:146` + F shortcut), glass chat sidebar (`ImmersiveStage.tsx:139,198`), call pills docked to a configurable left/right edge (`:73-80,194`). YouTube's own button stays disabled for a now-true reason (`youtube.ts:144-151`). | S | Currently absent from every client, and the YouTube adapter disables the provider's own button. *(both claims retired above)* |
| 2.6 | **Audio-track selection** (HLS only, per-viewer, never room state). | S | `hls.js` exposes it; `NativeAdapter` already holds the instance. |
| 2.7 | **Notifications that exist.** `NotifyPort.invite` and `NotifyPort.roomStarted` are fully implemented with zero callers, and the Expo lane is stubbed on both ends so a mobile user who subscribes receives nothing. | S | `roomStarted` needs a server-side per-room cooldown or it is a spam cannon. |
| 2.8 | **Mobile WebView position bridge.** A mobile-only room on a YouTube item can never report its own ending, so the queue stalls forever (HANDOFF item 6). | M | Highest-value mobile work available; $0 cost. *(STATUS 2026-08-20: the bridge is still unbuilt, but the stall is no longer silent — the embed panel says the app cannot see the ending and offers a manual "It's finished — move on" report, and the native player reports endings and durations itself — `apps/mobile/src/components/Stage.tsx:184-231,394`, `sync/advance.ts`.)* |
| 2.9 | ~~**Multi-instance vote-skip and wait-for-all.** Both count `hub.localUserIds` — sockets on *this* instance — so the skip threshold silently halves with every replica added.~~ **DONE 2026-08-20** via N2 — see the N2 status in §9. | S | Latent today, a real bug the day the API scales. *(fixed — see N2)* |

### Phase 3 — Distribution (parallel, mostly not engineering)

| # | Item | Note |
|---|---|---|
| 3.1 | **Ship the extension to the Chrome Web Store.** *(updated 2026-08-20: the discovery path now exists — `<ExtensionGate>` is mounted in the page-kind stage, `extensionInstallUrl()` bottoms out at the honest `/extension` docs page, the manifest carries real icons and version 1.0.0. What remains is the submission itself: a developer account, the listing assets, and the real-room verification `WEB_SLIMMING.md` now scripts — the DRM claim must be logged before the listing makes it.)* |
| 3.2 | **Narrow the manifest first.** ***DONE 2026-08-20*** *(corrected same day after real-browser testing)*. The install demands exactly ONE host: Gather's own API origin, stamped into `host_permissions` at build (`stampManifest`/`stampedHostPermissions`, `apps/extension/src/buildTarget.ts:332-375`) — an extension bypasses CORS only for origins it holds, and the zero-host build made every worker API call fail as "Failed to fetch" (join, members, room, events; the faked-fetch suite could not see it). Every *site* is a runtime grant (`optional_host_permissions`), content.js reaches pages via a granted-origins registered script + activeTab injection, and the one declarative content script covers only the Gather origins (the announce). The no-remote-code rule stands: site adapters ship in the bundle (`packages/contracts/src/providers.ts`), never fetched at runtime — a hot-fix fetch is a store-removal offense. |
| 3.3 | **A Discord bot** (`/watch` → room link). WatchParty's Discord server has ~15,400 members and the bot is its main top-of-funnel. Discord Activities carry a 90/10 revenue share if that ever matters. |
| 3.4 | **DMCA designated agent registration** (~$6, renews every 3 years) + a published repeat-infringer policy. Gather does **not** currently hold §512(c) safe harbour. The engineering half of the pipeline is built; the paperwork half is not. Highest-value, lowest-cost item in the entire assessment. |
| 3.5 | ~~**Verify admin takedown actually breaks `GET /assets/:assetId/content`.**~~ **DONE 2026-08-20** via N4 — a takedown 404s the content route and clears the object, an asset takedown revokes the asset it names, and a revoked asset cannot be resurrected by replaying upload completion (`services/api/test/asset-revocation.test.ts:166,190,265`). Room deletion and GDPR erasure now revoke assets too (`rooms/routes.ts:230-236`; `compliance/erasure.ts:98-109` — "Assets are REVOKED, not orphaned"). |
| 3.6 | **Fix three legal-copy mismatches.** (a) `legal/abuse` states "Every message, user, room, and upload can be reported from inside the app (**Message → Report**, member list, room menu)" — none of those controls exist (0.1 fixes this, or the copy must). *(RESOLVED 2026-08-20 by 0.1 landing — the controls exist and the sentence is true.)* (b) `legal/privacy` says "no telemetry on what you watch", while `sync/service.ts:531-545` writes a per-user, per-title, timestamped `playback.history` row on every track change with no pruning. The code's own comment says it exists for GDPR export and is read only by `compliance/export.ts`, which is a defensible purpose — but it is still stored watch data about a named user, and a privacy policy that says the opposite is the wrong place to leave that unstated. *(STILL OPEN 2026-08-20 — the sentence stands at `legal/privacy/page.tsx:31` and the write now lives at `sync/service.ts:617-635`.)* (c) Terms say uploads count against a storage limit; only a flat per-file `ATTACHMENT_MAX_MB = 200` exists. *(STILL OPEN 2026-08-20 — `legal/terms/page.tsx:29-31` vs `chat/attachments.ts:32`.)* These are the pages a regulator or an app-store reviewer reads first. |
| 3.7 | **Verticals with existing intent**, in priority order: long-distance couples (Teleparty leads its own store listing with it), anime/Crunchyroll (no first-party watch party exists, and the search term is entirely captured by SEO farms), listening parties, and body-doubling/study rooms (Focusmate charges $8/mo for essentially this, 6M+ sessions completed). |

---

## 5. What not to build, and why

These look like gaps against WatchParty. They are decisions.

**The VBrowser.** *Avoid.* It contradicts the founding rule outright — "content never
touches our infrastructure" becomes false the moment a VM decodes and re-encodes to N
viewers. The exposure is direct public-performance liability, not secondary: *Warner Bros.
v. WTV Systems* (Zediva) rejected exactly the "we're just renting you a machine" framing,
and *ABC v. Aereo* rejected the one-copy-per-user architecture that saved Cablevision. A
VBrowser is a worse fact pattern than either — one machine, one copy, transmitted
simultaneously to viewers in different households, originating from our own servers. It
also resurrects the `services/media` shape that was deliberately deleted, adds
third-party-credential handling inside a shared browser, and costs 10x per room-hour. It
is the thing that killed Rabbit. WatchParty needed it because it has no extension; Gather
has one.

**Torrent / magnet playback.** *Avoid.* WebTorrent is client-side and costs us nothing in
bytes, so it is tempting — but BitTorrent uploads while it downloads, which makes normal
operation turn users into distributors with their home IPs publicly visible in the swarm.
That is a user-harm problem stacked on a liability problem, and *Cox v. Sony* (2026)
specifically preserved liability for services "specially tailored" to facilitate
infringement. Note that nothing has to be *blocked*: `{kind:'page'}` already accepts any
https URL, so the honest position is that we decline to add a magnet parser.

**Re-streaming any DRM surface.** *Avoid permanently.* This is Gather's single most
valuable legal asset — it is what lets the product do the thing WatchParty needed a VM
fleet to approximate. §1201 circumvention is a separate cause of action with no fair-use
defence and no safe harbour, and output protection means a capture attempt yields a black
rectangle anyway. Item 0.8 exists because the *enforcement* is currently weaker than the
docs claim.

**Room passwords.** ~~Build `joinPolicy: 'open' | 'closed'` instead.~~
**OVERRIDDEN by the owner in §7 and SHIPPED 2026-08-19** — read this entry as the record
of the trade, never as advice. The objection was that a password would be the product's
first stored credential — hashing, rotation and recovery to invent — to gate a resource
whose real key is already a 12-character code from a confusable-free alphabet, and that it
adds a step to a flow `DESIGN.md` §12 budgets at two. All of that was accepted and built
anyway: scrypt `salt:hash` server-side (`services/api/src/lib/tokens.ts`), host-only
`PATCH /rooms/:roomId/password`, rotation IS recovery (there is no reset flow), and the
gate is probe-proof — unknown code, missing password and wrong password all answer the
same `NOT_FOUND`. The wire carries `hasPassword`, never the hash. `DESIGN.md` §12 now
budgets a password-gated join at 3. `joinPolicy` was never built and does not exist.

**Public room discovery.** Not yet. The cost of discovery is moderation, and Gather has
almost none: no slowmode, no per-user chat mute, no auto-moderation, and (until 0.1 —
which landed 2026-08-20, so this one now exists) no report button. A hand-curated
featured list costs nothing and reverses nothing.

**Recording the room's content.** Recording your *own* screen share via `MediaRecorder` is
fine and client-side. Recording Mode A content is blacked out by output protection.
*Hosting* recordings is the one that bites: 1,000 hours of stored 1080p is ~1.35 TB ≈
$20/month forever and rising, against a product with no revenue. Item 2.1 delivers what
clips are actually for at $0.

**The SFU client lane** (HANDOFF item 5) is not a Phase 0–2 item. `COST_MODEL`'s
structural conclusion is that the SFU never beats mesh on operator cost, `CfSfuProvider`
has never run against real Cloudflare, and there is **no spend cap on Cloudflare
Realtime**. Item 0.7 buys most of the same protection for a day's work. Revisit when a
real room actually fails on host uplink and the meter in 1.6 can prove it.

---

## 6. Open decisions for the owner — answered 2026-08-18, see §7

1. **Does an anonymous visitor get to create a room (1.2)?** It is WatchParty's single
   biggest funnel advantage and Gather's single biggest funnel gap. It is also the door
   through which every abuse problem walks. 1.5 is the price of admission either way.
2. **What is the relayed-share cap number (0.7)?** `COST_MODEL` suggests 300–500 kbps.
   Until someone picks one, TURN egress is both unmetered and uncapped.
3. **Does the extension go to the Chrome Web Store now (3.1), narrowed (3.2), or later?**
   `WEB_SLIMMING.md` steps 4–5 are gated on it, and the doc currently overstates how done
   the funnel is.
4. **One tier forever, or is there a Phase 4 business?** The category's ceiling is
   $3–7/month and nobody has escaped it as a consumer product. The two proven escapes are
   selling the primitive (Hyperbeam, LiveLike) and attaching commerce to an assembled
   fandom (Stationhead — 20% of listeners converted to album buyers, UMG took a minority
   stake). Both are different companies from this one. Worth deciding deliberately rather
   than by default, because four tombstone test suites currently make the answer
   structural.

---

## 7. Owner decisions — recorded 2026-08-18

The owner reviewed §§4–6 in full. Rulings below; where a ruling reverses an
audit recommendation, the reversal is the decision and the original section
stays as the record of the trade. The one-line conclusion at the top changes
meaning accordingly: the email round-trip is now a **design decision**, not a
gap — the funnel work (1.1, 1.3, 1.4, 2.7) is what compensates for it.

### Identity: accounts only

No anonymous room creation (§6.1 → **no**), and the guest lane itself goes:
`POST /auth/guest` and the 0.5 upgrade path are to be removed, not wired.
Every join requires a signed-in account via magic link. Build the invite
deep-link to survive the sign-in round-trip (carry the invite code through
the magic-link flow and land the user back on the join page) so the accepted
friction — "reopen the invite after signing in" — mostly disappears.
1.2 (instant rooms) is rejected with it.

> **STATUS 2026-08-19 — NOT EXECUTED, and the codebase has moved the other
> way.** `POST /auth/guest` is live (`services/api/src/modules/auth/routes.ts`)
> and the sessions since this ruling have *extended* the guest lane rather than
> retiring it: guest refresh scope was hardened (a guest whose membership is
> gone can no longer refresh into an unscoped token), the room-password gate
> covers guests and accounts alike, and `apps/extension/README.md` documents
> popup guest join as a first-class identity path. The invite deep-link that
> was supposed to make the cutover painless does not survive the sign-in
> round-trip either.
>
> §9's own amendment already said the cutover must be gated on confirming the
> Cloudflare email quota and must keep the route **feature-flagged off rather
> than deleted** for one launch cycle. Neither the flag nor the deep-link
> exists, so nothing about the cutover is ready. Treat the ruling as standing
> intent and this box as the reason it has not happened — do not delete the
> guest lane until the deep-link lands and the quota is confirmed, or every
> invite in circulation breaks at once.
>
> **UPDATE 2026-08-20 — the deep-link now exists.** An invite survives the
> sign-in round-trip: the join screen hands `?next=/join/<code>` to `/login`
> (`join-client.tsx:198`), which validates it through `safeAfterSignIn` and
> honours it directly or via storage across the magic-link hop
> (`login/page.tsx`, `lib/after-signin.ts`, `auth/verify/page.tsx:54`).
> The screens that promised guest→account upgrade no longer do (settings and
> join both dropped the copy), while `POST /auth/guest` is still live and
> still unflagged (`auth/routes.ts:125`) and the popup guest join remains a
> first-class path. Remaining cutover blockers: the feature flag and the
> email-quota confirmation.

### Phase 0 rulings

| # | Ruling |
|---|---|
| 0.1–0.4, 0.6, 0.8 | **Go** as written |
| 0.5 | **Inverted** — delete the guest lane instead of wiring upgrade (see above) |
| 0.7 | **Superseded by dynamic adaptation** (owner, 2026-08-18). Not a fixed cap — wire the already-built `BitrateGovernor` + `LinkAdaptor` (`packages/p2p/src/adaptation.ts`, exported, tested, **zero mesh callers**) into the share sender per link. AIMD on observed loss/RTT, per-link, targeting a healthy 6–8-person mesh. The static `capRelayedVideoKbps` becomes a *ceiling on top of* the governor for relayed links only (`clearMaxBitrate` already anticipates a second writer). See §7 dynamic-bitrate note |
| 0.9 | **Go, widened**: rotation/revoke grows into a user-relations layer — friends, block, per-user report, invite tracking (sent/accepted), private vs public invite links. Partiful is the reference |

### Phase 1 rulings

All six **go**. Specifics:

- **1.1** lands as a role-gated `/admin` area behind the one existing sign-in:
  admin is a role on a normal account, every admin route is checked
  server-side per request, opening an admin session requires a fresh
  magic-link step-up with a shorter TTL, and every admin action is audit
  logged. Not a second credential system; not URL obscurity (hiding the path
  is not a control — the 403 is). v1 scope: marketing pages as code; the
  console covers the reports queue, user/room lookup, and invites. CMS-style
  editing is a later maybe. Move to a separate subdomain with separate
  cookies when there are employees.
- **1.3** takes Partiful-style invite/preview customization.
- **1.5** uses Cloudflare Turnstile + the Redis-backed limiter.

### Phase 2 rulings

| # | Ruling |
|---|---|
| 2.1 | **Rejected** by owner (dangling-anchor objection; the queue-item-id degrade answer was given; decision stands) |
| 2.2 | **Go, widened**: detect and surface the underlying player's capabilities (captions, rate, quality, audio tracks) per queue item, and define a fixed feature set Gather adds on top via extension driving or embed API |
| 2.3 | **Rejected** (no search box). The hard case behind it — a one-URL site with the player nested in iframes — is already half-solved: frame election finds and drives the buried player; selection needs a per-member click + readiness handshake (CONTENT_MATCHING); an extension-side visual theater can isolate the elected element in the user's own tab. Extracting the video into our own UI stays off the table (CSP + the re-hosting line) |
| 2.4 | **Go**, blockers first (OPFS+MSE assembly, binary chunks). Ambition recorded: dynamic peer relay/fan-out of room media — a member that receives a stream forwards it onward, path chosen adaptively, not hard-coded. Legitimate R&D: it is an extension of what the mesh already is. Adds per-hop latency and churn fragility; prototype behind a flag |
| 2.5 | **Becomes the theater-mode spec**: fullscreen stage; hover/click glass-effect sidebar for chat; call participants as floating circular tiles on a configurable left/right edge |
| 2.6 | Unaddressed — stays as written |
| 2.7 | **Go** (owner, 2026-08-18) — with sign-in mandatory, the invite push *is* the funnel. `roomStarted` needs a per-room cooldown first |
| 2.8 | **Deferred** |
| 2.9 | Explained; keep — multi-instance correctness, latent until a second replica |

### Phase 3 rulings

| # | Ruling |
|---|---|
| 3.1 | First step is a local load: `pnpm --filter ./apps/extension build` → chrome://extensions → Load unpacked → `dist/`. Dev artifact self-labels "(DEV)" and points at localhost |
| 3.2 | Explained; **required before any store submission**. The no-remote-code rule is standing policy from today: site adapters ship in the bundle, never fetched at runtime — a hot-fix fetch is a store-removal offense |
| 3.3 | **Deferred** |
| 3.4 | **Deferred to pre-production** — to be explained then; the ~$6 registration still predates "public" by definition |
| 3.5 | **Go** — verify takedown actually kills the capability URL |
| 3.6 | **Deferred to last**, after the platform is built |
| 3.7 | **Go** — research the verticals now; targeted campaigns later |

### §5 standing decisions

- **VBrowser: avoid — confirmed.** (The extension is the replacement; the
  mesh-VPN idea is assessed separately below and is *not* part of this
  confirmation.)
- **Torrent: avoid — confirmed.**
- **DRM capture / re-streaming: never — confirmed.** Nothing is ever captured
  or streamed by our servers; same-region rooms sync via extension driving.
- **Recording: avoid — confirmed.**
- **Room passwords: overridden — build them.** Optional room passphrase in
  room settings (simple or complex), argon2id/scrypt-hashed server-side, host
  can set/rotate/clear, no recovery flow — rotation *is* recovery. The join
  flow gains one gated step. §5's objections (first stored credential,
  flow-length budget) are noted and accepted by the owner.
- **Public discovery: unaddressed — stays not-yet.**
- **SFU lane: stays parked.**

### Corrections to owner assumptions, recorded so this doc stays honest

**"Ideally we never need CF TURN/SFU."** The SFU, yes — nothing selects it
and nothing should until a metered room proves host-uplink failure (1.6).
TURN, no: 5–25% of real links (CGNAT, UDP-blocking firewalls, symmetric NAT)
cannot hole-punch — under WireGuard exactly as under WebRTC; Tailscale itself
ships the DERP relay fleet for precisely this. "No TURN" means those users'
calls and shares simply fail. TURN stays the connectivity fallback; it is the
cheap one ($0.002–0.015/room-hr).

**"Four Railway regions as connection hosts ≈ free."** Railway bills egress
(`docs/DEPLOY_RAILWAY.md`); a relay hosted there bills the same relayed
gigabytes as Cloudflare TURN plus four always-on services. The nominal-cost
claim is true if and only if the product stays mesh-first with relays as
rare fallback — which is the current architecture. Self-hosting TURN is a
price comparison to run later, not a way to make relayed bytes free.

### The mesh-VPN region-relay idea — assessed, engineering recommendation: against
Proposal (owner, 2026-08-18): extension and mobile apps as WireGuard-style
mesh clients so remote members egress from the session host's home network
and see the host-region catalog; framed as NAT-solving à la Tailscale and as
a DRM-unrelated free-internet feature.

Split the idea in two, because half of it survives:

- **Relaying *room media* among consenting members** (the 2.4 fan-out) is
  defensible R&D — an extension of what the mesh already is.
- **Relaying *general internet traffic* for region access** is recommended
  against:
  1. A browser extension cannot be a WireGuard client — MV3 has no UDP
     sockets and no TUN. Only native apps can carry it, and the extension is
     the one lane that exists everywhere.
  2. WireGuard does not traverse NAT; Tailscale = hole punching + DERP
     relays. Building this means building the relay fleet the idea was meant
     to avoid.
  3. The host's uplink becomes the room's CDN: a remote member's 1080p
     stream (~5 Mbps) transits the host's connection down *and* up. A
     10–20 Mbps home uplink carries 2–4 remote viewers and nothing else —
     the same wall that caps mesh screen share at N≈6, at higher bitrates.
  4. Geo-shifting is explicitly prohibited by every streaming ToS and
     actively detected; members risk their accounts, and the host's home IP
     originates every guest's traffic — the same user-harm shape §5 cites to
     reject torrents. A feature *built for* defeating regional licensing
     hands opposing counsel the "specially tailored" framing (*Cox v. Sony*)
     and spends the product's cleanest legal sentence: every viewer's access
     is exactly what their own subscription grants, in their own region.
  5. The aligned alternative is already designed: `docs/CONTENT_MATCHING.md`
     resolves the same title per member from their own regional catalog,
     with cross-platform fallback and graceful non-participation.

Owner has the final call; this section records the engineering position.

---

## 8. Follow-up rulings — 2026-08-18 (bitrate + surface architecture)

### Dynamic bitrate note (supersedes the 0.7 fixed cap)

Owner: "dynamic bitrate for p2p, ideally small number of participants 6–8."

The controller is **already built and tested, and has zero mesh callers** — the
same finished-but-unwired pattern as the rest of Phase 0:

- `BitrateGovernor` (`packages/p2p/src/adaptation.ts`) — AIMD-style loss/RTT
  governor: multiplicative decrease (×0.7) on consecutive bad samples (loss
  >5% or RTT spike), gentle increase (×1.15) on good samples behind a 4 s
  cooldown; clamps 200 kbps–8 Mbps, start 2.5 Mbps.
- `LinkAdaptor` — drives the governor from a periodic poll and applies the
  target via `applyMaxBitrate` (`RTCRtpSender.setParameters` → every
  encoding's `maxBitrate`). Both are exported from the package and unit-tested.
- Path detection is live: `classifyLinkStats` + `MeshManager.pollStats`
  (`mesh.ts:443`) already poll `getStats` per link and classify direct vs
  TURN-relayed.

What is missing, in build order:

*(STATUS 2026-08-20: still true for the governor — `BitrateGovernor`/
`LinkAdaptor` keep zero mesh callers. What landed is the static side of item 4:
the mesh now owns per-link ceilings in `capFor`/`reconcileCaps`
(`mesh.ts:1669-1712`) — the relayed-share cap at 400 kbps from both surfaces,
and a per-receiver cam budget split (`capCamKbps / camReceiverCount`), so the
"one owner" arbitration point now has its cap writer in place.)*

1. **A `getStats` → `LinkSample` extractor** — the single biggest gap.
   `classifyLinkStats` reads only candidate types and throws every rate/quality
   metric away. Pull `rttMs` (candidate-pair `currentRoundTripTime`) and
   `lossFraction` (remote-inbound-rtp `packetsLost` delta ÷ packets sent) from
   the per-link report `pollStats` already holds, and also read
   `availableOutgoingBitrate` as a ceiling hint.
2. **Per-link controller lifecycle** — construct a governor+adaptor per share
   sender per peer in `addPeer`, reset on ICE restart / `failed`, tear down in
   `removePeer`. None of this exists on `MeshPeer` today.
3. **Poll cadence** — production polls every 5 s (`LINK_POLL_MS`); the governor
   assumes ~2 s and streak counts of 2–3. Run the share-link sampler faster or
   retune the streaks.
4. **Cap-vs-governor arbitration** — both write the same `encoding.maxBitrate`.
   One owner: effective max = `min(governorTarget, relayCap when relayed)`.
   `clearMaxBitrate`'s exact-value guard already anticipates a second writer.
5. **Aggregate uplink budget — the one that actually makes 6–8 work.** Each
   share link is its own encoder; a host sharing to 7 peers runs 7 encoders.
   Per-link governors alone would let each climb to 2.5 Mbps = ~17 Mbps uplink,
   which no home connection has. Add a device-uplink budget (est. or
   configured, ~8–10 Mbps) split fairly across active share links, and clamp
   each per-link governor to its slice. `COST_MODEL` puts the mesh-share uplink
   wall at N≈6 at full rate; this allocator is exactly what pushes it to 8 by
   lowering per-viewer bitrate as N grows (7 × ~1.2 Mbps ≈ 8.4 Mbps, viable).

Note the budget allocator and the 2.4 relay-fan-out idea are the **same
problem** — host uplink is the scarce resource. When fair per-viewer bitrate
would fall below acceptable, the honest next move is to offload a viewer to a
relay peer rather than degrade everyone. Build the budget first; it is the
signal that would *trigger* fan-out.

### Surface architecture: keep the extension; native is additive, not a replacement (§6.2 / owner "maybe drop the extension and switch to native app")

Investigated against the code. The framing does not survive contact with it:

- **The extension's load-bearing job cannot be done by a native app.** It
  drives the *site's own DRM player* inside the *user's own logged-in browser
  tab* (`mediaDriver.ts:259` writes `currentTime`/`play`/`playbackRate` on an
  element the extension does not own). A native app owns nothing in that tab.
  Its only replications are (a) embed Chromium + Widevine — the **local**
  VBrowser, which hits the Widevine-CDM licensing wall that killed Metastream
  and crosses the re-decode line §5 forbids; or (b) OS-level automation of the
  installed browser — fragile per-OS/per-browser, needs accessibility
  permissions, and if it drives Chrome it needs an extension anyway.
- **`page`-kind items and desktop screen capture are extension-only today**
  (`apps/mobile/.../Stage.tsx` PageStage boundary; `tabCapture`/
  `desktopCapture`/`offscreen` in the extension). Native would reimplement both
  from zero.
- **A desktop-native app is 100% greenfield** — no Electron/Tauri/CEF shell,
  window, tray, updater, code-signing, packaging, or native-messaging host
  exists. Months before it plays one frame.
- **The architecture already rejected the binary.** `PlaybackDriver`
  (`apps/extension/src/driver.ts`) is *one contract with three
  implementations* — web adapter, extension, mobile native — chosen per item
  at runtime. Playback surface is already pluggable; the extension is one lane,
  not the whole road.
- **The only thing native uniquely buys is raw UDP/TUN sockets** for the
  WireGuard region-relay — already recommended against (§7), and the region
  problem it targets is *already solved a different way* by the
  `CONTENT_MATCHING` ladder (each member plays their own regional copy). NAT is
  solved by TURN, which is what a WireGuard relay fleet would re-build anyway.

**Ruling:**
1. **Keep the extension.** It is the moat. Cut its *friction*, not its
   existence: narrow the manifest (3.2) to kill the `<all_urls>` install scare
   and the slow-review path — that addresses the real pain without losing the
   capability.
2. **Native investment goes to finishing mobile, not starting desktop.** The
   Expo app exists and its highest-value gaps (push token registration, call
   join via `react-native-webrtc`, attachments) are wired on the server already
   — that is where native energy pays off first.
3. **A desktop-native app is a later, additive surface** justified only by a
   concrete need (a dedicated TV/couch experience, or socket-level features).
   If the WireGuard/region-relay is ever pursued, the correct shape is a
   **native companion behind `chrome.runtime` nativeMessaging** — the extension
   stays the browser driver, a small native binary holds the socket. That is
   additive; it is not "dropping the extension."

Dropping the extension to enable WireGuard would trade the whole product's
legal moat for a feature that is recommended against. Not advised. Owner keeps
the final call; this is the engineering position.

---

## 9. Adversarial review of the whole approach — 2026-08-18

Owner asked for a full critique of the approach and the best solution. Method:
five independent critic lenses (architecture, cost/business, legal, funnel,
strategy) produced objections; each was then adversarially *refuted* against
the code and this decision log; only survivors count. Nine survived (4 real,
5 overstated); zero decisions were found wrong enough to reverse.

**The verdict on the architecture: keep it.** Accounts-only, extension-first
DRM, mesh-only P2P, no-VBrowser/no-SFU/no-region-VPN, one-tier — all held
under attack. Nothing in §§7–8 is reopened.

**The one finding that reprioritizes everything else:** three deferral
rationales in this plan ("predates public", "latent until a second replica",
3.5's bare Go) assume a pre-launch product. `DEPLOY_RAILWAY.md:29` says
otherwise: **DEPLOYED and serving at gather.watch**, zero-downtime rolling
deploys (two instances overlap on every push to main), real signups, real
attachments. The product is live; the plan must treat it as live.

### What that promotes to NOW (no phase gate)

| # | Item | Why now |
|---|---|---|
| N1 | **Register the DMCA §512(c) agent + repeat-infringer policy** (reverses the 3.4 deferral) + the 3.6(a) legal-copy fix | "Predates public" is factually false. ~$6, under an hour, best ROI in the doc. *(STATUS 2026-08-20: the 3.6(a) half is resolved — report controls shipped with 0.1 and the abuse-page sentence is true; the registration itself leaves no artifact in the repo and cannot be verified from code — unconfirmed.)* |
| N2 | ~~**Multi-instance vote-skip/wait-for-all fix** (promotes 2.9)~~ **DONE 2026-08-20** — landed as `PresenceTracker.presentUserIds()` (`rooms/presence.ts:271-299`; the doc's proposed name was `connectedUserIds`): `voteSkip` counts room-wide presence after an awaited `ensureRoster`, with a membership-count solo check (`queue/service.ts:326-353`), and waitForAll prunes buffering reporters against presence ∪ local sockets (`sync/service.ts:660-700`). Verified by `test/multi-instance-quorum.test.ts` + `test/multi-instance-roster.test.ts`. Known residue, recorded in code: the buffering SET stays process-local, so `sync.waiting` can under-report who is still waiting — it can no longer wrongly release a hold. | The rolling deploy overlaps two instances on *every push*; a reconnect during cutover splits the room and silently deletes off-instance votes today. |
| N3 | **Relay metering producer + static uplink ceiling** (promotes half of §8) | `fairUseRemainingGb` is hardcoded null (`rtc/service.ts:36`), `RELAY_USAGE_KINDS` has a reader and zero writers — live product, authenticated users, unmetered TURN. Static ceiling `min(relayCap, uplinkBudget / activeShareLinkCount)` needs only `peer.senders` — lands before the full AIMD pipeline. *(STATUS 2026-08-20: half done — the static ceilings landed (relayed-share cap 400 kbps both surfaces + per-receiver cam budget, `mesh.ts:1669-1712`); the metering producer did not — `fairUseRemainingGb` is still null (`rtc/service.ts:85-93`) and `RELAY_USAGE_KINDS` still has its one reader and zero writers (`compliance/export.ts:33,118`).)* |
| N4 | ~~**Asset-takedown gaps** (re-scopes 3.5 into three)~~ **DONE 2026-08-20** — (a) takedown 404s the content route and clears the object, and revocation is replay-proof (`test/asset-revocation.test.ts:166,190,265`); (b) GDPR erasure and room deletion now revoke assets (`compliance/erasure.ts:98-109` — "Assets are REVOKED, not orphaned"; `rooms/routes.ts:230-236`); (c) the staff path is the admin reports queue with a resolve action (`admin/routes.ts:117`, `apps/web/app/admin/page.tsx`) plus the takedown CLI (`src/cli/takedown.ts`) — an external complainant still cannot file directly (`POST /report` needs a verified identity), so the operator files the report under their own account and acts on it. | (a) test that takedown 404s the content route; (b) GDPR erasure + room deletion currently *never revoke assets*; (c) staff path to disable an asset from an external DMCA notice |
| N5 | Privacy-copy fix 3.6(b) + doc-honesty pass: output protection is defense-in-depth, not physics (Widevine L3 is software-only and capturable); the real Mode B backstop is architectural. Plus the 5-line `currentTime` try/catch in `mediaDriver.ts` matching the `playbackRate` guard | Doc edits + one guard; no dependencies. *(STATUS 2026-08-20: the guard is DONE — `mediaDriver.ts:277-286` wraps the `currentTime` write like the rate/volume guards. The privacy copy is NOT fixed (`legal/privacy/page.tsx:31` still says "no telemetry on what you watch" against the `playback.history` write at `sync/service.ts:617-635`), and the output-protection honesty pass is not evident — `EXTENSION_FIRST.md:315` / `CONTENT_MATCHING.md:16` still state the blackout without the L3 caveat.)* |

### Plan amendments (absorbed from surviving objections)

- **0.5 cutover gated:** confirm the Cloudflare email quota (support ticket —
  COST_MODEL names it the launch-day risk) **before** removing guest join;
  keep `POST /auth/guest` **feature-flagged off**, not deleted, through one
  launch cycle for same-day rollback. Ship a minimal 1.6 slice (invite-sent →
  delivered → first-play counters) *with* the cutover, not after — else the
  plan's own "don't ship blind" rule is violated on its riskiest identity change.
- **Extension distribution gets dates:** 3.2 (manifest narrowing) becomes the
  dated prerequisite of a dated 3.1a store submission. Phase 1 does NOT gate
  on it: lead marketing with install-free non-DRM sync ("any link, chat, call
  — free, no install"); hold "Netflix together" as a labeled install upsell.
  Interim: `extensionInstallUrl()` returns null and silently degrades — point
  it at an honest docs page; wire the orphaned `<ExtensionGate>` or delete it.
  *(STATUS 2026-08-20: the interim work is DONE — `extensionInstallUrl()`
  always answers with the honest `/extension` docs page
  (`apps/web/app/extension/page.tsx`, `StagePane.tsx:521`) and
  `<ExtensionGate>` is mounted in the page-kind stage (`StagePane.tsx:1603`).
  3.2 landed the same day; the 3.1a submission date is still unset.)*
- **DRM claims verified before store submission:** no repo artifact shows a
  real login-and-drive pass on Netflix/Disney+/Max/Hulu/Prime. Extend
  WEB_SLIMMING's real-room gate to name those sites; head-to-head ● demoted
  to ◐ for them until the pass is logged. *(STATUS 2026-08-20: the protocol
  is scripted — `WEB_SLIMMING.md` §Real-room verification names Netflix
  logged-in as "the claim under test" — but has still never been run; the §2
  demotion is now applied in the table.)*
- **Content-matching ladder becomes a graded item (~M, Phase 1/2)** — it was
  the one competitive-thesis component with no schedule. Build order:
  external-ID enrichment on `ResolvedMedia` (IMDb/TMDB, ISRC/UPC) → rung-2
  availability probe → readiness handshake on the wire → specific rung-5
  reason strings. Rung 3 (metadata search) deferred and, when built, scoped to
  closed catalogs only — never open/UGC platforms without a verified-uploader
  signal. One clarifying line added to §1's claim: the legal/competitive base
  is Mode A + the extension (built); the ladder raises match-rate, it is not
  what makes the architecture safe.
  *(2026-08-20 — a first slice of the ladder shipped: the "Find it where you
  are" search bridge. The extension popup opens the member's OWN default
  search engine on the current item's title via `chrome.search.query` and the
  worker adopts the tab they land on (`apps/extension/src/popup.ts:244-259,
  451-457`) — the manual recovery for the member whose region cannot play the
  queued item, ahead of the automated rungs. External-ID enrichment and the
  availability probe remain unbuilt.)*
- **COST_MODEL gets a base-infrastructure table** (Railway services + Redis +
  bucket + Atlas real tiers) — the "$5 + domain" floor priced only marginal
  relay bytes, not the stack that is actually running.

### Owner judgment calls surfaced (not engineering answers)

1. **§6 item 4 — monetization** silently never got a ruling while items 1–3
   did. Even "one tier forever, owner-subsidized" should be recorded as a
   ruling with the real cost floor attached.
2. **Minimum-viable-bitrate floor:** when the uplink budget runs out at N
   viewers, does the room hold at N−1, drop the newest to audio-only, or let
   everyone degrade toward 200 kbps? Must be stated in §8 before the
   allocator ships.
3. **Positioning until the store link exists:** lead non-DRM (recommended) or
   lead DRM-with-install-step.
4. **Guest route: flagged-off permanently or deleted after the quota clears.**
   Engineering recommends flagged-off through one launch cycle minimum.
