# Web slimming: migrating playback out of the web app

> **STATUS (updated 2026-08-20): steps 1–3 done. Steps 4–5 NOT executed and
> must not be — the remaining gate is the real-room verification below.**
>
> The extension has `desktopCapture` and extension-preferred driving is wired.
> The install funnel became REACHABLE on 2026-08-20:
>
> - `extensionInstallUrl()` (`apps/web/lib/player/extension-driver.ts`) now
>   **always returns a URL**: the `NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL`
>   env wins, then the store listing derived from
>   `NEXT_PUBLIC_GATHER_EXTENSION_ID`, then the app's own honest docs page at
>   `/extension` (`apps/web/app/extension/page.tsx`), which ships with the app
>   and states plainly that the store listing does not exist yet. When the
>   listing lands, set the env on the web service and it wins everywhere.
> - `<ExtensionGate>` is **mounted** — in `StagePane`'s `page`-kind branch,
>   below `PageLinkStage`, only while the extension driver is not ready, and
>   only on browsers that could ever run an extension (handhelds render no
>   gate: its mobile branch would funnel to an app with no store listing).
>   When the gate carries its own install CTA the poster hands the install
>   conversation over (one offer, one gradient — DESIGN.md §2). No other
>   media kind is gated: the web still plays everything else itself until
>   step 4 actually executes.
> - The extension manifest carries real icons (16/32/48/128, generated from
>   the product mark by `apps/extension/scripts/gen-icons.mjs`) and version
>   1.0.0, and its permission profile is narrowed for store review
>   (`docs/FEATURE_PLAN.md` 3.2): no install-time host permissions —
>   activeTab + runtime grants instead.
>
> The deletions remain gated on the original ordering rule — **a real room, a
> real site, the installed extension, playback verified end to end** — which
> has still never been run. The protocol below is that verification; steps
> 4–5 stay frozen until a run records all-PASS. Confirmed still present:
> `apps/web/lib/player/{adapter,embed,native,soundcloud,vimeo,youtube}.ts` and
> the `getDisplayMedia` call in
> `apps/web/components/stage/ScreenShareStage.tsx`. Blast radius when it
> does: the adapters are not leaf files — `StagePane`, `ListenStage` and
> `PlayerControls` build on them, so step 4 rewrites the stage rather than
> deleting from it. This doc is deleted when steps 4–5 land.

Owner decision, 2026-08-16: execute removal options 1, 2 **and** 3 — delete the
web player adapters and the web screen-share path, so all playback and capture
runs through the extension (desktop) or the native app (mobile).

The decision hinged on one question: *can an extension share a full screen or
an app window?* **Yes.** `chrome.tabCapture` is tab-only, which is why today's
extension is narrower than the web app — but `chrome.desktopCapture`
(permission: `desktopCapture`) returns a stream id for **screen, window or
tab**, and an extension page or offscreen document can also call
`getDisplayMedia()` directly. So the extension can match and exceed what the
web app does today.

## THE ORDERING RULE (non-negotiable)

**Never remove a capability from the web before its extension replacement
exists and has been verified.** Every step below is gated on the previous one.
A half-executed migration leaves the product unable to play anything.

| Step | What | Gate before proceeding |
|---|---|---|
| 1 | Add `desktopCapture` screen/window/app sharing to the extension | Screen AND window capture verified working end-to-end in a room |
| 2 | Extension becomes preferred driver when installed; web defers to it | A room with the extension installed drives playback correctly |
| 3 | Build the install funnel (below) | The no-extension state is clear and actionable |
| 4 | Delete web player adapters + web `getDisplayMedia` | Full gates green |
| 5 | Delete verified-dead code, dedupe registries | Full gates green |

## What is actually being deleted (step 4-5)

**Deleted:**
- `apps/web/lib/player/{youtube,soundcloud,vimeo,native,embed,adapter}.ts` —
  the web-side playback adapters. Note the directory also holds
  `advance.ts`, `ducking.ts`, `extension-driver.ts`, `room-audio.ts` and
  `useSyncEngine.ts`, and **none of those five go** — they are the room, not
  the player.
- The `getDisplayMedia` path in
  `apps/web/components/stage/ScreenShareStage.tsx` (web screen-share),
  replaced by the extension's `desktopCapture`.
- ~~The duplicated provider registry in `apps/web/lib/providers.ts`.~~
  **Deduplicated ahead of step 5, 2026-08-20.** The registry now has ONE copy:
  `packages/contracts/src/providers.ts` (the superset — host regexes, DRM
  flags, cast descriptors, and per-provider `grantPatterns` feeding the
  extension's runtime permission requests). `apps/extension/src/providers.ts`
  is a re-export plus URL-parsing wrappers (contracts is environment-free and
  matches hostnames only); `apps/web/lib/providers.ts` derives its rows from
  it and keeps only `parseProviderUrl` and the web-only `generic` row. The
  `EmbedProvider` enum in `packages/contracts/src/entities.ts` is welded to
  the registry by test (`packages/contracts/test/providers-registry.test.ts`):
  a service is now added in ONE place, and the enum cannot drift from it.
  What step 5 still owes: nothing here — this line is done.

**Already done, ahead of step 5:** `mediaRefFromUrl` is gone from
`apps/web/lib/permissions.ts`, superseded by `apps/web/lib/providers.ts`
`parseProviderUrl`. **The file itself stays** — it now exports `canAct` and
`formatMs`, which `ChatPane`, `QueuePane`, `StagePane`, `ListenStage` and
`PlayerControls` all import. Do not delete `permissions.ts`.

**Explicitly NOT deleted** — these are the room, not playback:
chat, call/mesh, queue, presence, rooms CRUD, auth, admin, in-room playback
history, the sync engine (it now drives the extension instead of a local
adapter), and `apps/web/lib/cast.ts` (the Remote Playback path still applies
to media with a real fetchable URL).

## The consequence that must be handled: the install funnel

Once the web app cannot play anything itself, **a room link opens to a page
that does nothing** unless the visitor has the extension. That is the single
biggest risk in this migration, and it is a product problem, not a technical
one. Required before step 4 lands:

1. **Detect and state it plainly.** `apps/web/lib/extension-bridge.ts`
   `detectExtension()` already returns `{installed, compatible, version}`
   SSR-safely with a short timeout. The room must render a clear, friendly
   state: what Gather needs, why, and a one-click install link — never a
   broken player or a spinner.
   **DONE 2026-08-20**, the "honest docs page" way (the §9 amendment's interim
   ruling): `<ExtensionGate>` is mounted in the `page`-kind stage branch and
   `extensionInstallUrl()` bottoms out at `/extension`, a page that ships with
   the app and says plainly the store listing does not exist yet. When the
   Chrome Web Store listing lands (`docs/FEATURE_PLAN.md` 3.1),
   `NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL` on the web service switches
   every affordance to it in one deploy. What step 4 still owes here: the
   gate must widen from the `page`-kind branch to the whole stage when the
   adapters go — that widening is part of step 4 itself, not of this item.
2. **The room stays usable without it.** Chat, call, queue and presence must
   all work with no extension. You can be in the room, talking to friends,
   before you can watch. This keeps the link shareable.
3. **Mobile is not a degraded desktop.** Mobile browsers have no extensions.
   The mobile web app must route users to the native app (which implements
   `PlaybackDriver` against AVPlayer/ExoPlayer/WebView) rather than showing a
   desktop install prompt it cannot satisfy.
4. **Recheck after install.** `detectExtension({force: true})` re-checks
   without a reload, so the room comes alive the moment the extension is
   added.

## Docs consolidation (owner: option 1) — DONE, except ARCHITECTURE.md

Executed structure:

- `README.md` — entry point: what Gather is, quick start, ports and env, repo
  map, where to go next. No architecture detail. **Done.**
- `docs/ARCHITECTURE.md` — **the technical spine**: the room model, the two
  playback modes, the `PlaybackDriver` contract and its three
  implementations, sync (elastic), the data plane, the security boundaries.
  **Still not written** — `docs/EXTENSION_FIRST.md` carries the spine.
- `docs/EXTENSION_FIRST.md` — the extension architecture, protocol, threat
  model and casting reality. (Kept; current.)
- `docs/CONTENT_MATCHING.md` — cross-region/DRM content resolution. (Kept.)
- `docs/CAST_RELAY.md` — share-to-TV decision record. (Added 2026-08-17.)
- `docs/COST_MODEL.md` — verified Cloudflare rates. (Added; re-labelled
  2026-08-18 when the plan tiers went away.)
- `docs/DEPLOY_RAILWAY.md` — the deploy runbook. (Kept; done-phases marked.)
- `docs/WEB_SLIMMING.md` — this migration. Delete once complete.
- `DESIGN.md` — the design system; absorbed the UX overhaul's locked
  decisions and step budget as §11–12. **Done.**
- `docs/history/` — `BUILD_PROMPT.md`, `CONCEPT.md`, `UX_OVERHAUL.md` and the
  four worker briefs, each under a header naming what in it is dead. They
  describe superseded plans. **Done.**

**Known stale claims — all closed** (2026-08-18, re-verified against the code
the same day):
- ~~`infra/README.md` claims the media service uses **BullMQ**~~ — the claim
  is gone, and so is the service. `services/media` has no `package.json`, so
  neither pnpm nor turbo sees it; `infra/README`'s scaling notes say so, and
  keep the one-replica reasoning only as the reason it *would* apply again to
  a future transcoder.
- ~~`infra/README.md` references `pnpm --filter ./services/api run seed`,
  `.env.example` references `pnpm --filter api generate:vapid`~~ — both
  phantom-script references removed; neither file names a script that does not
  exist.
- ~~`infra/README.md` documents an external-coturn TURN strategy and
  `TURN_STATIC_AUTH_SECRET`~~ — the API has no code path for it; the config
  key is not even parsed (`services/api/test/config-coturn.test.ts`).
  infra/README now says so explicitly, and `turbo.json` no longer passes the
  variable through.
- ~~`apps/extension/public/manifest.json` will need `desktopCapture`~~ —
  done in step 1 (`manifest.json` `permissions` carries it, alongside
  `tabCapture`, `offscreen`, `storage`, `activeTab`, `scripting`, `alarms`).
- ~~Docs describe a paid tier, a media service, LiveKit or a 4-hour room
  TTL~~ — swept 2026-08-18. One tier, no `services/media`, mesh + Cloudflare
  TURN, `expiresAt: null` forever.
- ~~`README.md`, `HANDOFF.md` and `docs/DEPLOY_RAILWAY.md` give the production
  extension build as `GATHER_API_URL=… pnpm --filter … build`~~ — that is the
  **dev** script. `apps/extension/src/buildTarget.ts` labels the result
  UNVERIFIED because the https / loopback / manifest-subset checks never ran.
  All three now say `build:prod`, with `GATHER_WEB_ORIGINS`.
- ~~`docs/CAST_RELAY.md` §2 says the AirPlay mirroring guidance "shipped
  2026-08-17 in `PlayerControls.tsx`"~~ — the always-visible cast control
  shipped; the two platform-keyed copy rows did not, and neither string is in
  the tree. §2 now says designed-not-built and points at slice 5.
- ~~`HANDOFF.md` open items claim the settings uploads panel 404s and that a
  `page` item with no extension renders a blank stage~~ — both fixed in the
  code since. `apps/web/test/no-library.test.ts` and `PageLinkStage` in
  `StagePane.tsx` are the evidence.

## Inline documentation pass

Alongside the prose docs, every module changed in this program gets a file
header comment stating: what it owns, what it deliberately does not do, and
the non-obvious constraint a future reader would otherwise trip on (the
Tailwind hover-reveal ordering trap, the anchor re-arm stalemate guard, the
`sender.origin` re-check rule, the one-replica media constraint). Comments
state constraints, never narrate the code.

## Real-room verification — the gate for steps 4–5 (protocol)

Written 2026-08-20. This is the "real room, real site, installed extension,
end to end" pass the ordering rule has demanded since day one, made concrete.
Per `docs/FEATURE_PLAN.md` §9, the DRM pass must NAME the sites — the
head-to-head "extension drives DRM sites" claim stays demoted to ◐ until a
run is logged here. Budget ~45 minutes. Record results in "Verification
runs" below; steps 4–5 stay frozen until one run records all-PASS.

### Setup (10 min)

- [ ] `git pull`; record the HEAD hash and Chrome version.
- [ ] Build the PROD artifact:
      `GATHER_API_URL=https://api.gather.watch GATHER_WEB_ORIGINS=https://gather.watch,https://www.gather.watch pnpm --filter ./apps/extension build:prod`
- [ ] `cat apps/extension/dist/BUILD.txt` — must say **PRODUCTION BUILD**. DEV
      or UNVERIFIED: stop, wrong artifact.
- [ ] chrome://extensions → remove any old copy → Load unpacked →
      `apps/extension/dist`. Name has NO "(DEV)" suffix; the aurora icon
      renders (not the gray default).
- [ ] Two identities: your admin profile on gather.watch = DRIVER; a second
      browser/profile in the same room = WITNESS. "In sync" is judged by the
      witness, never by the driver's own screen.

### A. Handoff + a full-sync site (YouTube) — 10 min

- [ ] Open the room on gather.watch; the stage shows no install prompt
      (extension detected).
- [ ] Queue a YouTube URL; open youtube.com in another tab. First run on the
      site: click the Gather toolbar icon on that tab and accept "keep Gather
      on this site" when offered (the narrowed build reaches a site only
      after a grant or an icon click — that is the store-review trade).
- [ ] Play/pause/seek from the WEB app → the tab follows within ~2 s, ONE
      seek per correction (a seek storm is a FAIL). NOTE: while a preroll or
      mid-roll AD holds the player, Gather deliberately does nothing — no
      drive, no advance, no duration report (`isInterstitialSource`) — and
      control resumes when the film returns. A quiet extension during an ad
      is correct behavior, not a failure.
- [ ] Your hand on the SITE's player: pause/scrub on youtube.com → the room
      follows (witness confirms). A pause→unpause fight is a FAIL.
- [ ] Overlay: chat both ways; the volume slider in the now-playing block
      moves the site's own player; mute works; the site's slider position is
      reflected back within ~1 s.
- [ ] Let the item END → the room auto-advances; the ended row shows a real
      duration afterward.

### B. Generic page (long tail) — 5 min

- [ ] Queue an arbitrary https page with a `<video>` (any article with an
      inline player). Open it, grant or icon-click, and the generic driver
      drives play/pause from the room. Witness confirms.

### C. DRM — Netflix, logged in — 10 min ★ the claim under test

- [ ] netflix.com, signed in, any title playing. Queue the page URL in the
      room (parses as a Netflix row).
- [ ] Room play/pause → Netflix follows. Room seek → lands (a licence
      round-trip pause of a few seconds is expected; repeated seeking is a
      FAIL).
- [ ] Site-side pause/scrub → room follows.
- [ ] Popup on the tab says "protected — your own player".
- [ ] "This tab" share on the Netflix tab is REFUSED with the protected-site
      sentence BEFORE Chrome's picker opens.
- [ ] Record the exact title driven.

### D. Second DRM site (Disney+ or Prime Video), logged in — 5 min

- [ ] Repeat C's play/pause/seek/intent checks. Name the site and title.

### E. Screen/tab share (Mode B) — 10 min

- [ ] On a non-DRM tab: popup → "This tab" → witness sees the picture AND
      hears the tab's audio; a music source should sound like music, not
      like a phone call (stereo Opus).
- [ ] Stop from Chrome's own stop bar → popup buttons return within ~2 s.
- [ ] "A window" share works; stop from the popup works.
- [ ] With the web tab in the room's call (mic live): start an extension
      share → voice keeps flowing while the share plays (the sharer is in
      the room twice; both lanes hold).

### F. MV3 worker-recycle resilience — 5 min

- [ ] With a tab connected and idle ≥60 s (the worker recycles after ~30 s
      of quiet): seek from the room → the tab still follows.
- [ ] Let an item end AFTER such an idle window → the room still advances
      (the revived worker re-learned the queue via wantSnapshot).

### G. Popup guest join + password — 5 min

- [ ] A profile with NO gather.watch login: toolbar icon on the content tab →
      room code → Connect. Joins as "Extension"; overlay appears; chat works
      both ways; Skip obeys the room's playbackControl policy.
- [ ] A password-protected room: wrong password → the same "not found"
      sentence (probe-proof, by design); correct password → joins.

### Verification runs

| Date | HEAD | Chrome | A | B | C (title) | D (site/title) | E | F | G | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — | — | not yet run |

