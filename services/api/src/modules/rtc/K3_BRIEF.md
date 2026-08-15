# K3 Brief — rtc module: LiveKit tokens + TURN credentials

Playin is a self-hosted watch-party platform (pnpm + turbo monorepo, TS strict).
The full build spec is `/Users/mg/Desktop/playin/BUILD_PROMPT.md` — read the
"Topology pivot" and "Architecture rules" sections. The API skeleton (Fastify 5,
module-plugin seam) is complete and tested; you are filling in ONE stub module.

Working directory: `/Users/mg/Desktop/playin/services/api/src/modules/rtc`.
Repo root: `/Users/mg/Desktop/playin`.

## ENVIRONMENT HARD RULES (read carefully — non-obvious)

- The Bash tool is SANDBOXED: in the workspace it cannot write file data,
  mkdir, rm, or run package installs (they fail or hang). The ONLY way to
  create/modify files in the workspace is the Write/Edit tools. Use them for
  every file.
- To run checks: mirror the repo and work in the mirror:
  `rsync -a --delete --exclude='.git' --exclude='.turbo' /Users/mg/Desktop/playin/ /tmp/gates-rtc/`
  then `cd /tmp/gates-rtc`. If you added a dependency to a package.json, first
  `CI=1 pnpm install --store-dir /tmp/pnpm-store` in the mirror (network works).
- Never write project files anywhere outside your owned paths. /tmp scratch is fine.

## OWNERSHIP

- Create/modify ONLY inside `services/api/src/modules/rtc/`.
- You MAY edit `services/api/package.json` ONLY to add dependencies (via Edit tool).
- NOTHING else. Contracts, adapters, hub, plugins, other modules: frozen.
  `src/modules/index.ts` already registers this module — do not touch it.

## READ FIRST

- `services/api/src/modules/types.ts` (ModulePlugin, Deps, AuthContext) and
  `services/api/src/modules/rooms/service.ts` (service patterns, AppError usage,
  membership checks) and `services/api/src/modules/chat/routes.ts` (route style).
- `services/api/src/adapters/ports.ts` — StorePort (`usage`, `subscriptions`
  collections), AppError semantics.
- `services/api/src/config.ts` — `config.livekit.*`, `config.turnStaticAuthSecret`,
  `config.cloudflare.{turnKeyId,turnApiToken}`, `config.freeTurnCapGbPerMonth`.
- Contracts (single source of truth — conform exactly):
  `packages/contracts/src/rest.ts`: `LivekitTokenBody`, `LivekitTokenResponse`,
  `TurnCredentialsResponse`. Look at the `rest` export map at the bottom for the
  intended route paths/methods.
- `services/api/src/lib/errors.ts` and `services/api/src/plugins/auth.ts`
  (how `request.auth` is populated; which routes need auth).

## BUILD

Replace the placeholder `index.ts` with a real module (keep the same default-export
shape, `name: 'rtc'`). Suggested files: `index.ts`, `routes.ts`, `service.ts`,
`K3_BRIEF.md` stays. Tests: `services/api/test/rtc.test.ts` — WAIT, test dir is
outside your ownership; instead put colocated tests in your module dir
(`rtc.test.ts` next to sources, vitest picks up `src/**/*.test.ts` — verify the
vitest include pattern in the mirror first; if it doesn't, say so in your report
and put tests under `services/api/test/` anyway as the sole exception).

Routes (auth required; guests included when they belong to the room):

1. `POST /rtc/livekit-token` body `LivekitTokenBody` → `LivekitTokenResponse`.
   - 404 when room doesn't exist; 403 when the requester is not a member of the
     room (guests: `auth.guestRoomId` must equal the room).
   - Mint a LiveKit AccessToken (dep: `livekit-server-sdk` — add to
     services/api/package.json, pin a current v2.x) with identity = userId,
     room = roomId, `canPublish`/`canSubscribe` per room policy
     (`maxPublishers` is enforced client/livekit-side; token grants subscribe
     always, publish always for members), TTL = min(6h, config default 6h).
   - Response also carries the public `livekit.url` from config and the room's
     effective relay mode.
2. `GET /rtc/turn-credentials` → `TurnCredentialsResponse`.
   - If `config.cloudflare.turnKeyId` + `turnApiToken` set: call Cloudflare's
     TURN-keys API `POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials`
     with bearer token via global fetch, map `{ iceServers }` through; on any
     network/API failure, log + fall through to the next strategy.
   - Else if `config.turnStaticAuthSecret` set: mint coturn REST credentials
     (username = `<unixExpiry>:<userId>`, credential = base64 HMAC-SHA1 of the
     username with the secret), TTL 6h, URIs from a sensible default list
     (turn/turns host derived from config or `localhost:3478` in dev).
   - Else: STUN-only list (`stun:stun.l.google.com:19302`).
   - Fair-use: free-plan TURN relay is capped at `config.freeTurnCapGbPerMonth`
     per account. Sum the user's `usage` docs with `kind: 'turn-bytes'` for the
     current calendar month; when over cap AND the user has no active premium
     `subscriptions` row, omit relay URLs (return STUN + TURN-over-TCP/TLS only
     if that's what the strategy produced minus `relay`-only transports — the
     honest interpretation: strip `turn:`/`turns:` URIs, keep stun) and include
     a `capped: true`-style signal IF the contract allows; otherwise conform to
     the contract exactly and note the deviation in your report.

## TESTS (vitest, memory adapters, no network — stub global fetch)

- LiveKit token: happy path decodes to the right room/identity/TTL (verify with
  the SDK's verifier or decode the JWT payload); non-member → 403; unknown room → 404.
- TURN: Cloudflare path (mock fetch success + failure fallback), HMAC path
  (verify credential against the secret), STUN-only default, fair-use cap
  behavior with seeded usage rows.

## ACCEPTANCE (run in /tmp/gates-rtc mirror)

- `CI=1 pnpm install --store-dir /tmp/pnpm-store` (after dep add)
- `CI=1 pnpm --filter playin-api typecheck` clean
- `CI=1 npx eslint services/api/src/modules/rtc` clean
- `CI=1 pnpm --filter playin-api test` green (your tests + all existing suites)

## REPORT BACK

Files created/changed, routes implemented, contract deviations (if any), gate
results, anything the orchestrator must wire (e.g. .env.example additions —
do NOT edit .env.example yourself).
