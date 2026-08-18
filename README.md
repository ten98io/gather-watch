# Gather

**Watch together. Listen together. From anywhere.**

Gather is a shared living-room: one room where a group watches, listens,
talks and texts together — media, call and chat as one session, live at
[gather.watch](https://gather.watch). The browser extension turns any site
into a watch party: everyone plays their own copy, Gather moves the clock.

Gather is free and has one tier — no plans, no billing, no entitlements.
Rooms never expire.

## Quick start (dev — zero external services required)

```bash
pnpm install                      # pnpm 11, Node >= 22
cp .env.example .env
pnpm build                        # REQUIRED before typecheck/test — see below
pnpm dev                          # api :4000, web :3000
```

With `MONGO_URL` and `REDIS_URL` empty (the `.env.example` default) the api
boots on in-memory adapters, so nothing else has to be running. Sign-in with no
mail transport configured prints the magic link to the api log and surfaces it
in the dev UI.

`pnpm dev` starts **web and api only** — `apps/extension` and `apps/mobile`
have no `dev` task. Per-workspace commands use the package name or the path:

```bash
pnpm --filter @gather/web dev
pnpm --filter @gather/extension build
pnpm --filter @gather/mobile start
pnpm --filter ./services/api... test     # the {dir}... syntax is load-bearing
```

### Build before you typecheck or test

`contracts`, `api-client`, `sync-core`, `p2p` and `design` are all consumed
through their built `dist`. Editing one and typechecking a consumer without
rebuilding checks the **old** `.d.ts` and passes for the wrong reason. Root
`turbo` tasks handle this (`test` and `typecheck` both `dependsOn: ["^build"]`),
but a hand-run `tsc` in one workspace does not.

A cached turbo green (`FULL TURBO`) replayed a previous run — before a deploy,
re-run with `--force`.

## Ports and env

| Port | What |
|---|---|
| 3000 | `apps/web` (Next.js) |
| 4000 | `services/api` (Fastify REST + `/ws`) |

`.env.example` is the annotated list; every key is parsed in
`services/api/src/config.ts` and **an env var set to the empty string counts as
absent**. The ones that matter first:

| Var | Why |
|---|---|
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | required (≥32 chars) when `NODE_ENV=production`; the api refuses to boot otherwise |
| `MONGO_URL`, `REDIS_URL` | empty ⇒ in-memory adapters. Fine in dev, silent data loss in prod |
| `APP_URL` | the **only** allowed CORS origin, and the magic-link base |
| `NEXT_PUBLIC_API_URL` | web → api; inlined by Next at **build** time |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare TURN. Unset ⇒ STUN only, so peers behind symmetric NAT cannot connect |
| `ADMIN_EMAILS` | comma-separated; who may open `/admin`. Empty ⇒ closed to everyone |

Deploying: see [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md).
Self-hosting with docker compose: see [infra/README.md](infra/README.md).

## Extension (Chrome/Edge/Brave, MV3)

MV3 bundles cannot read env at runtime, so the API origin is inlined at build
time:

```bash
GATHER_API_URL=https://<api-domain> pnpm --filter @gather/extension build
```

Then chrome://extensions → Developer mode → Load unpacked →
`apps/extension/dist`. Omitting `GATHER_API_URL` keeps the `localhost:4000`
dev default. See [apps/extension/README.md](apps/extension/README.md).

## Repo map

| Path | What |
|---|---|
| `apps/web` | Next.js PWA — the room interface |
| `apps/extension` | Chromium MV3 extension — the playback driver |
| `apps/mobile` | Expo (iOS + Android) |
| `services/api` | Fastify control plane: auth, rooms, chat, queue, sync, restream, push, metadata, compliance, admin |
| `packages/contracts` | Zod schemas — single source of truth for REST + WS |
| `packages/sync-core` | Isomorphic elastic playback-sync engine |
| `packages/api-client` | Typed REST/WS client (web + mobile + extension) |
| `packages/design` | The design system's tokens, scales and WCAG guards |
| `packages/p2p` | WebRTC mesh primitives (mesh, lanes, relay provider) |
| `infra` | Self-host path: docker-compose, Caddy |

## Where each doc lives

| Doc | What it holds |
|---|---|
| [HANDOFF.md](HANDOFF.md) | Live state, open items, the traps list — read first when resuming |
| [DESIGN.md](DESIGN.md) | Binding design system, locked UX decisions, the ≤3-step budget |
| [docs/EXTENSION_FIRST.md](docs/EXTENSION_FIRST.md) | The architecture: elastic sync, extension-first playback, casting honestly |
| [docs/CONTENT_MATCHING.md](docs/CONTENT_MATCHING.md) | Cross-region/DRM content resolution |
| [docs/CAST_RELAY.md](docs/CAST_RELAY.md) | Getting a share onto a TV: Chromecast participant, AirPlay stance |
| [docs/COST_MODEL.md](docs/COST_MODEL.md) | Verified Cloudflare cost model |
| [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md) | The deploy runbook |
| [docs/WEB_SLIMMING.md](docs/WEB_SLIMMING.md) | Active migration: playback out of the web app (steps 4–5 pending) |
| [infra/README.md](infra/README.md) | The self-hosted compose stack, ports, TURN notes |
| [docs/history/](docs/history/) | Superseded plans and the four worker briefs the code was built from — historical only, never build from these |
