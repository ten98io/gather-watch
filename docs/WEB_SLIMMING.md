# Web slimming: migrating playback out of the web app

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
  the web-side playback adapters.
- The `getDisplayMedia` path in `components/stage/ModeBStage.tsx` (web
  screen-share), replaced by the extension's `desktopCapture`.
- `apps/web/lib/permissions.ts` → `mediaRefFromUrl`. **Verified dead**: the
  only references are in its own test file; superseded by
  `lib/providers.ts` `parseProviderUrl`.
- The duplicated provider registry in `apps/web/lib/providers.ts` — the
  extension's registry is now the superset (17 ids, capability tiers, host
  regexes, DRM flags, cast descriptors). Web consumes a shared/derived copy;
  a service is added in ONE place.

**Explicitly NOT deleted** — these are the room, not playback:
chat, call/mesh, queue, presence, rooms CRUD, auth, billing, admin, history,
the sync engine (it now drives the extension instead of a local adapter), and
`lib/cast.ts` (the Remote Playback path still applies to media the app owns).

## The consequence that must be handled: the install funnel

Once the web app cannot play anything itself, **a room link opens to a page
that does nothing** unless the visitor has the extension. That is the single
biggest risk in this migration, and it is a product problem, not a technical
one. Required before step 4 lands:

1. **Detect and state it plainly.** `lib/extension-bridge.ts`
   `detectExtension()` already returns `{installed, compatible, version}`
   SSR-safely with a short timeout. The room must render a clear, friendly
   state: what Playin needs, why, and a one-click install link — never a
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

## Docs consolidation (owner: option 1)

Target structure:

- `README.md` — entry point: what Playin is, quick start, repo map, where to
  go next. No architecture detail.
- `docs/ARCHITECTURE.md` — **the technical spine**: the room model, the two
  playback modes, the `PlaybackDriver` contract and its three
  implementations, sync (elastic), the data plane, the security boundaries.
- `docs/EXTENSION_FIRST.md` — the extension architecture, protocol, threat
  model and casting reality. (Keep; it is current.)
- `docs/CONTENT_MATCHING.md` — cross-region/DRM content resolution. (Keep.)
- `docs/DEPLOY_RAILWAY.md` — the deploy runbook. (Keep.)
- `docs/WEB_SLIMMING.md` — this migration. Delete once complete.
- `DESIGN.md` — the design system; absorbs `docs/UX_OVERHAUL.md`'s decisions
  and the visual direction, keeping the flow/step-budget table.
- `docs/history/` — `BUILD_PROMPT.md` and `CONCEPT.md` move here, clearly
  marked historical. They describe an earlier plan and are actively
  misleading as current documentation.

**Known stale claims to fix while consolidating** (verified this session):
- `infra/README.md:28,161` claims the media service uses **BullMQ**. It does
  not — there is no BullMQ dependency and it never reads `REDIS_URL`; the
  queue is an in-process promise chain, which is exactly why it must run one
  replica.
- `infra/README.md:85` references `pnpm --filter ./services/api run seed` and
  `.env.example:74` references `pnpm --filter api generate:vapid`. **Neither
  script exists** (services/api has only build/dev/start/test/typecheck/lint).
- `apps/extension/public/manifest.json` will need `desktopCapture` added to
  `permissions` in step 1.

## Inline documentation pass

Alongside the prose docs, every module changed in this program gets a file
header comment stating: what it owns, what it deliberately does not do, and
the non-obvious constraint a future reader would otherwise trip on (the
Tailwind hover-reveal ordering trap, the anchor re-arm stalemate guard, the
`sender.origin` re-check rule, the one-replica media constraint). Comments
state constraints, never narrate the code.
