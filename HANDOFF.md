# Session handoff — Playin, 2026-08-16

Pick this up in a fresh session. Read this file first, then
`docs/WEB_SLIMMING.md` (the active migration) and `docs/EXTENSION_FIRST.md`
(the architecture it serves).

---

## ⚠️ READ THIS FIRST: the tree is mid-edit and UNVERIFIED

Two agent waves were running when the session ended and **did not finish**.
Their work is on disk but the final gate pass never ran.

**Do not assume the repo compiles. Verify before doing anything else:**

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

Last *known-green* state was the wave-1 checkpoint: turbo `test` 13/13
(incl. 166 API tests), `typecheck` 13/13, `lint` 9/9. Everything after that
is unverified.

There are **97 uncommitted files** (57 modified, 38 new, 2 deleted). Nothing
in this program has been committed. **Committing a checkpoint should be your
first action once gates pass** — this is many hours of agent work with no
restore point.

### What finished vs what did not

| Wave | Agent | State |
|---|---|---|
| Room overhaul | metadata resolver (server) | ✅ done |
| Room overhaul | design tokens + primitives | ✅ done |
| Room overhaul | call feed fix (B1) | ✅ done |
| Room overhaul | **play-button fix (B2)** | ❌ never ran |
| Room overhaul | **listen-room identity (B3)** + final gates | ❌ never ran |
| Extension overlay | **PlaybackDriver + elastic wiring** | ❌ incomplete |
| Extension overlay | **overlay UI** | ❌ never ran |
| Extension overlay | **hardening + gates** | ❌ never ran |

Because B3 never ran, **nobody ran the full gate pass** for the room work.
Because the overlay wave died in its first agent, `apps/extension/src/driver.ts`
may be partial or absent — check before building on it.

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
- Extension: build-time `PLAYIN_API_URL`, elastic sync controller in
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

## Next actions, in order

1. **Verify + commit** the current tree (see top of file).
2. **Finish the room overhaul**: the play-button fix (B2) and listen-room
   identity (B3) never ran. Briefs are in the workflow script at
   `~/.claude/projects/-Users-mg-Desktop-playin/<session>/workflows/scripts/playin-overhaul-1-*.js`
   — the B2/B3 agent prompts can be lifted verbatim.
3. **Finish the extension overlay wave** (driver contract → overlay UI →
   hardening). Script: `playin-overlay-wf_*.js`, same directory.
4. **Then the web slimming**, strictly in the order in
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
- Railway project **Playin-App** (workspace Ten98) is linked; services
  web/api/media exist, Redis online, never deployed. Two detached
  `mongodb-volume*` leftovers should be deleted (they still bill).
- Atlas Network Access still needs a decision: static outbound IPs on
  api/media, or `0.0.0.0/0` with a strong password.
- Extension prod build:
  `PLAYIN_API_URL=https://<api-domain> pnpm --filter ./apps/extension build`.
