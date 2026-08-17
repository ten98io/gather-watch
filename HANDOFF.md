# Session handoff — Gather

Read this first, then `docs/WEB_SLIMMING.md` (the one active migration) and
`docs/EXTENSION_FIRST.md` (the architecture it serves).

## Live state

**gather.watch is deployed and serving.** Railway project Gather: `api` + `web`
+ Redis, zero-downtime deploys (api gated on `/readyz`, web on `/`), config-as-code on both
services. The Railway media service is deleted — users never upload streams;
chat attachments use the `attachments` Railway Bucket (`ams`) via reference
variables, read through stable capability URLs (`/assets/:id/content` → 60s
presigned GET). Email: Cloudflare Email Service, sender `email.gather.watch`.
Mongo on Atlas. Repo `mustafagandhi/gather-watch`; brand **Gather**; packages
`@gather/*`. Stored rooms carry `relayMode` `'mesh'` (default) and `'cf-sfu'`
(theater); no room ever successfully used LiveKit — it is deleted from the
codebase (mesh + Cloudflare Realtime SFU + Cloudflare TURN are the topology).

## Shipped (verified)

- **Adaptive rooms** — the watch/listen choice is gone; `mediaKindFor(ref)`
  routes the stage composition per playing item (`room.kind` vestigial).
- **Extension-preferred driving** with local intent capture (your hand on the
  site's player speaks for you); web defers when the extension is present.
- **Mode B fully working** — the restream server module exists (the wire
  contract existed on both sides with no registered handler; now it has one),
  share feedback contract (one-sentence failures, 8s ack watchdog, capture
  torn down when the room ends the share), free-tier relay cap 400kbps.
- **One design system** in `packages/design` — WCAG guards incl. ink-on-fill
  (light-gradient exception recorded).
- **Cast, honestly**: always-visible control with honest states; Chromecast
  TV-participant designed in `docs/CAST_RELAY.md` (hardware spike pending);
  AirPlay = OS-mirroring guidance; server relay deferred. Client-side-first
  doctrine is binding.
- Elastic sync (`packages/sync-core`), web↔extension handoff channel with
  threat model, server-side metadata resolver, live member/room context (role
  changes flip gates without rejoin).

Costs: `docs/COST_MODEL.md` (verified rates; two lines cannot be closed).

## Open items

1. **TURN keys** (user action) — voice dropouts persist until set.
2. **$5 Cast spike** (user action) — Google Cast dev console registration
   gates the Chromecast TV-participant slice 1 (`docs/CAST_RELAY.md` §7).
3. **Relay-guard residuals** — task chip outstanding.
4. **Web-slimming steps 4–5** (delete web player adapters + web
   `getDisplayMedia`) — still gated on a real-room verification that the
   extension drives playback correctly. See `docs/WEB_SLIMMING.md` header.
5. **Mobile RN type defects** — hero regressed 34→28px; JetBrains Mono is
   unbundled so numeric readouts jitter.

## Traps discovered the hard way

- **`.next` contention.** A running dev server on :3000 holds `apps/web/.next`
  and `pnpm build` fails with `PageNotFoundError` on pages that plainly exist.
  Stop the dev server and remove `.next` before building. Contention, not
  breakage.
- **`pnpm build` before typechecking downstream.** `packages/contracts` and
  `api-client` are consumed via built `dist`; editing them without rebuilding
  typechecks web/api against stale `.d.ts`.
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
  must be boundary-aware or it corrupts `playing`/`isPlaying` identifiers.
- **No `git add -A` during agent waves.** Concurrent agents share the working
  tree; stage only your own scoped paths.
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
  class pair in `HOVER_REVEAL` is deliberate — do not "simplify" it away.
- **Empty `MONGO_URL`/`REDIS_URL` silently boot in-memory adapters** — the
  deploy looks healthy and loses all data on restart. `/readyz` is the probe
  that reflects the real store; the api's railway.json healthcheck uses it
  (web's gates on `/`).

## Environment notes

- Local dev: web :3000, api :4000 (`pnpm dev` also boots the legacy media
  service on :4500 — it is not deployed). `pnpm build` first (contracts/
  api-client ship via `dist`), then test/typecheck.
- Extension prod build (MV3 inlines the origin at build time):
  `GATHER_API_URL=https://<api-domain> pnpm --filter ./apps/extension build`,
  then chrome://extensions → Load unpacked → `apps/extension/dist`. Chrome
  137+ ignores `--load-extension`; there is no automated install path for a
  real profile, by Chrome's design.
- The web app finds the extension without configuration (content script
  announces its id on Gather origins); `NEXT_PUBLIC_GATHER_EXTENSION_ID` only
  pins it.

## Next session — starting prompt

```
Continue Gather (~/Desktop/playin, live at gather.watch). Read HANDOFF.md
first — live state, open items, and the traps list.

Everything is on main, deployed, gates green (build/typecheck/test/lint).
No branches, no in-flight agent work.

Pick up in this order:
1. If the TURN keys and/or the $5 Cast registration landed since last
   session, wire them: TURN needs only a redeploy to heal voice dropouts;
   Cast unlocks slice 1 of docs/CAST_RELAY.md (the hardware spike that
   go/no-goes the Chromecast TV-participant feature; slices 2+ follow).
2. Relay-guard residuals (the outstanding task chip): premium plan on the
   extension share path, two test-discrimination gaps, late-plan cap
   stickiness, unknown-link cap hole, copy location.
3. Web-slimming steps 4–5 (delete web player adapters + web
   getDisplayMedia): STILL GATED on verifying the extension drives a real
   room correctly end-to-end. Do that verification first — a real room, a
   real site, the installed extension — then the deletions per
   docs/WEB_SLIMMING.md. Note the blast radius recorded there: the
   adapters are not leaf files.
4. Mobile RN type defects: hero 34→28px regression and unbundled
   JetBrains Mono (numeric readouts jitter).

Backlog after those: voice in the extension overlay (offscreen getUserMedia,
reuses the Mode B plumbing), watch history, account linking + playlist
import, media-anchored chat's server half (mediaPositionMs on messages),
the ≤3-step flow audit.

Use Workflow agents with disjoint file scopes; prove fixes by mutation
(break → RED → restore); never git add -A while agents are in flight.
```
