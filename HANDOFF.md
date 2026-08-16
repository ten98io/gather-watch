# Session handoff — Gather, 2026-08-16

Pick this up in a fresh session. Read this file first, then
`docs/WEB_SLIMMING.md` (the active migration) and `docs/EXTENSION_FIRST.md`
(the architecture it serves).

---

## Status: the room work is VERIFIED and on `main`

The previous session's tree was never actually broken — the build failure was
`.next` contention, exactly as suspected. With the dev server stopped and
`apps/web/.next` removed, everything passes:

| Gate | Result |
|---|---|
| `pnpm build` | 8/8 |
| `pnpm typecheck` | 13/13 |
| `pnpm test` | 13/13 — **882 tests** |
| `pnpm lint` | 9/9 |

`main` now carries all of it (the wave-1/2 checkpoint, plus B3). Always run
`pnpm build` **first** — contracts/api-client are consumed via built `dist`.

**Stop the dev server before building.** A running :3000 holds `.next` and
produces `PageNotFoundError` on pages that plainly exist (`/join/[code]`,
`/icon.svg`). That is contention, not breakage.

### What finished vs what did not

| Wave | Agent | State |
|---|---|---|
| Room overhaul | metadata resolver (server) | ✅ done |
| Room overhaul | design tokens + primitives | ✅ done |
| Room overhaul | call feed fix (B1) | ✅ done |
| Room overhaul | play-button fix (B2) | ✅ done — the old table was wrong |
| Room overhaul | listen-room identity (B3) | ✅ done + browser-verified |
| Extension overlay | **PlaybackDriver + elastic wiring** | ❌ incomplete |
| Extension overlay | **overlay UI** | ❌ never ran |
| Extension overlay | **hardening + gates** | ❌ never ran |

**B2 was already complete** despite being listed as "never ran": `StageShield`
in `StagePane.tsx` implements the whole brief — one control surface over every
full-sync provider, covering YouTube's centre overlay in *both* the unstarted
and paused states, exactly one play affordance, the "Tap to start watching
together" recovery for refused autoplay, and policy gating. All four adapters
report ms correctly (SoundCloud's widget is natively ms; YouTube and Vimeo
convert from seconds; `embed` is the documented approximate tier).

`apps/extension/src/driver.ts` is present but partial — it carries a
`pendingRealign` field that nothing reads, left by the agent that died.

Deleted-and-replaced (intentional): `components/call/CallGrid.tsx` and
`CallStrip.tsx` were collapsed into a new `components/call/` directory.

---

## Where the work stands

### Shipped and green (wave 1, verified)
- Chat composer rebuilt as a standard messaging bar (emoji popover, send/mic
  swap, real SVG icons).
- Queue rows: artwork, real titles, hover grabber with HTML5 drag-and-drop
  plus a touch fallback, hover delete.
- Player bar: one row, tooltips on every control, proper slider styling.
- ~30 jargon leaks removed; `lib/describe-error.ts` + `lib/labels.ts` now
  gate all user-facing error and enum copy.
- Extension: build-time `GATHER_API_URL`, elastic sync controller in
  `packages/sync-core`, `all_frames` + frame election, SPA/shadow-DOM
  detection, MV3 session persistence + alarms keepalive, site-native cast
  clicking, and the **web↔extension handoff channel** with a documented
  threat model (11 attack classes).

### On disk but unverified
- Server-side metadata resolver (`services/api/src/modules/metadata/`,
  `src/lib/safe-fetch.ts`) — oEmbed + OpenGraph behind the DNS-pinned SSRF
  guard, patching queue items and re-broadcasting.
- `PAYMENT_REQUIRED`/402 error code so the premium upsell is reachable.
- Design primitives: `Artwork`, `MediaRow`, `NowPlaying`, `ArtworkBackdrop`,
  `EmptyState`, `lib/artwork-color.ts`, surface-ladder tokens.
- Unified call surface (rail tiles + camera prompt).

---

## Locked decisions (do not relitigate)

| # | Decision | Source |
|---|---|---|
| D1 | Call tiles live in the **right rail above chat**, never over the stage; theater collapses to a hideable overlay | `docs/UX_OVERHAUL.md` |
| D2 | Camera **off** by default, with a prominent "Turn on camera" affordance on your own tile | same |
| D3 | Listen rooms get a **distinct layout**: centred artwork, dominant visualiser, track-list up-next, artwork-derived accent | same |
| D4 | Full depth: design-system pass **and** visual redesign **and** bug/flow fixes; Spotify-class, artwork-forward | same |
| — | Sync is **elastic**: learn a per-viewer offset, don't fight it; tighten only when voice is live | `docs/EXTENSION_FIRST.md` |
| — | Chat is **media-time anchored** (spoiler-proof); live voice stays real-time | same |
| — | Extension is the playback driver; overlay UI injects onto content sites (Teleparty model) | same |
| — | Web playback adapters + web screen-share **will be deleted**, gated on the ordering rule | `docs/WEB_SLIMMING.md` |
| — | Mongo stays on **Atlas**; Redis on Railway | `docs/DEPLOY_RAILWAY.md` |
| — | ≤3 steps for any flow, with a named exception list | `docs/UX_OVERHAUL.md` §3 |

---

## Installing the extension (it now actually runs)

```bash
pnpm --filter @gather/extension build
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load
unpacked** → pick `apps/extension/dist`.

There is no automated path for your everyday browser and that is deliberate on
Chrome's part: **Chrome 137+ ignores `--load-extension` outright** (verified —
a probe extension left no trace in the profile). The CDP
`Extensions.loadUnpacked` method still works, but only against a Chrome started
with `--remote-debugging-port` and `--enable-unsafe-extension-debugging`, which
is fine for a throwaway verification profile and not something to do to your
real browser.

The web app finds the extension **without any configuration**: the content
script announces its id on Gather origins. `NEXT_PUBLIC_GATHER_EXTENSION_ID`
only pins it (build-time id wins over the announcement).

Verified end-to-end in a real Chrome, not just in tests:

| Check | Result |
|---|---|
| service worker starts | no exceptions, no console errors |
| content script announces its id | id matches the loaded extension |
| `hello` over the external channel | `ok`, protocol v1 |
| advertised capabilities | includes the new `modeB.desktop` |

**Not yet verified:** an actual screen/window capture reaching a room. That
needs a real display and a second peer; a headless profile has no picker. It is
the remaining gate on WEB_SLIMMING step 1.

## Next actions, in order

1. ~~Verify + commit the current tree.~~ Done — gates green, merged to `main`.
2. ~~Finish the room overhaul (B2, B3).~~ Done — B2 was already complete; B3
   was built and verified in a real browser.
3. **Finish the extension overlay wave** (driver contract → overlay UI →
   hardening). The script is
   `~/.claude/projects/-Users-mg-Desktop-gather/2583c315-*/workflows/scripts/gather-elastic-extension-wf_2780b452-bb4.js`
   — note there is **no** `gather-overlay-wf_*.js`; that filename in the old
   handoff was wrong.
4. **Web slimming is PART DONE.** Step 1 (`desktopCapture`) and step 3 (the
   install funnel component + the `useExtensionDriver` hook) are built,
   adversarially reviewed, and their defects fixed. What remains:
   - **Step 2 is not wired.** Nothing in the running app mounts `ExtensionGate`
     or calls `useExtensionDriver` — `StagePane.tsx` has no reference to
     either. The pieces exist; the integration does not.
   - **Steps 4-5 (the deletions) are BLOCKED by the ordering rule**, and the
     block is real, not caution. The rule gates deletion on "a room with the
     extension installed drives playback correctly", and the extension is not
     yet a verified playback driver — the overlay wave (item 3 above) never
     finished. Deleting `lib/player/*` today would leave the product unable to
     play anything.
   - Note the blast radius when it is time: the adapters are not leaf files.
     `StagePane`, `ListenStage` and `PlayerControls` all build on them, and the
     listen room's visualiser taps `NativeAdapter.mediaElement` directly, so
     step 4 rewrites the stage rather than deleting from it.
5. **Then the rest of the web slimming**, strictly in the order in
   `docs/WEB_SLIMMING.md`: add `desktopCapture` → extension-preferred
   driving → install funnel → deletions → responsive pass → docs
   consolidation.

Open backlog beyond that: watch history, account linking + playlist import,
any-site extraction (the metadata resolver is its server half), the flow
audit against the ≤3-step budget, media-anchored chat's **server** half
(a `mediaPositionMs` field on chat messages).

---

## Traps discovered the hard way

- **`pnpm build` before typechecking downstream.** `packages/contracts` and
  `api-client` are consumed via built `dist`; editing them without rebuilding
  makes web/api typecheck against stale `.d.ts`.
- **Concurrent agents on one file.** Two agents editing `apps/extension`
  nearly lost each other's work. Give each agent a disjoint file scope, or
  sequence them. Verify merges with targeted greps afterwards.
- **Tailwind hover-reveal ordering.** The unscoped `group-focus-within:` rule
  emits *before* the `@media(hover:hover)` block and loses to it. `QueuePane`
  carries both an unscoped and a media-scoped class on purpose — do not
  "simplify" the duplicate away.
- **`cn()` is a plain joiner, not `tailwind-merge`.** It has no conflict
  resolution, so passing both `relative` and `absolute` emits both and CSS
  source order decides — Tailwind emits `.relative` *after* `.absolute`, so
  `absolute` silently loses. Make conflicting utilities mutually exclusive
  (ternary), never additive.
- **`justify-center` on an `overflow-y-auto` box clips unreachably.** Once the
  content is taller than the port, the overflow goes off the *top* and the
  scrollbar cannot reach it. Split the scroll port from the centring: put
  `overflow-y-auto` on the outer element and `min-h-full … justify-center` on
  an inner column.
- **The repo has no Prettier config** — Prettier is not its formatter. Running
  `npx prettier --write` rewrites files to double quotes against house style.
  Match surrounding style by hand.
- **`exactOptionalPropertyTypes` is on.** Spreading `{ field: maybeUndefined }`
  writes explicit `undefined` over real values; use conditional spreads.
- **Media service must run exactly one replica** — its ffmpeg queue is an
  in-process promise chain. (`infra/README.md`'s BullMQ claim is wrong and is
  slated for correction.)
- **The premium gate threw `FORBIDDEN`/403**, so the 402 upgrade branch was
  unreachable. Fixed on disk; verify the test passes.
- **Empty `MONGO_URL`/`REDIS_URL` silently boot in-memory adapters** — the
  deploy looks healthy and loses all data on restart. `/readyz` is the probe
  that actually reflects the store; the api railway.json now uses it.

---

## Environment notes

- All three services run locally: web :3000, api :4000, media :4500.
- Railway project **Gather-App** (workspace Ten98) is linked; services
  web/api/media exist, Redis online, never deployed. Two detached
  `mongodb-volume*` leftovers should be deleted (they still bill).
- Atlas Network Access still needs a decision: static outbound IPs on
  api/media, or `0.0.0.0/0` with a strong password.
- Extension prod build:
  `GATHER_API_URL=https://<api-domain> pnpm --filter ./apps/extension build`.
