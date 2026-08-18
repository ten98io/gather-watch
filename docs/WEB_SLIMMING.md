# Web slimming: migrating playback out of the web app

> **STATUS (re-verified 2026-08-18): steps 1–3 done, steps 4–5 NOT executed.**
> The extension has `desktopCapture`, extension-preferred driving is wired, and
> the install funnel exists. What remains is the deletions themselves (web
> player adapters + web `getDisplayMedia`, then dead-code/registry dedupe),
> and they are **gated, not merely unfinished**: the ordering rule requires a
> real room with the extension installed to drive playback correctly,
> verified end-to-end, before any web playback path is removed. That
> verification has not happened. Confirmed still present today:
> `apps/web/lib/player/{adapter,embed,native,soundcloud,vimeo,youtube}.ts` and
> the `getDisplayMedia` call at
> `apps/web/components/stage/ScreenShareStage.tsx:113`. Blast radius when it
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
- The duplicated provider registry in `apps/web/lib/providers.ts`. The two
  lists now carry the same 17 provider ids plus a `generic` fallback and the
  same `capability` vocabulary (`full-sync | approximate | extension |
  generic`); the extension's is the superset because it additionally carries
  host regexes, DRM flags, cast descriptors and a derived
  `tier` (`api | drm | generic`, via `tierFor()`). Web should consume a
  shared/derived copy so a service is added in ONE place — three places today,
  counting the `embed` provider enum in `packages/contracts/src/entities.ts`.

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
