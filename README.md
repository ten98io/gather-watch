# Gather

**Watch together. Listen together. From anywhere.**

Gather is a shared living-room: one room where a group watches, listens,
talks and texts together — media, call and chat as one session, live at
[gather.watch](https://gather.watch). The browser extension turns any site
into a watch party: everyone plays their own copy, Gather moves the clock.

## Quick start (dev — zero services required)

```bash
pnpm install
cp .env.example .env
pnpm dev          # api :4000, web :3000 (in-memory Mongo/Redis adapters)
```

Before typechecking or testing, run `pnpm build` once — `packages/contracts`
and `packages/api-client` are consumed via their built `dist`.

Deploying: see [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md).

Extension (Chrome/Edge): `pnpm --filter @gather/extension build`, then
chrome://extensions → Developer mode → Load unpacked → `apps/extension/dist`.

## Repo map

| Path | What |
|---|---|
| `apps/web` | Next.js PWA — the room interface |
| `apps/extension` | Chromium MV3 extension — the playback driver |
| `apps/mobile` | Expo (iOS + Android) |
| `services/api` | Fastify control plane: auth, rooms, chat, sync, billing |
| `services/media` | Legacy upload→HLS pipeline — not deployed |
| `packages/contracts` | Zod schemas — single source of truth for REST + WS |
| `packages/sync-core` | Isomorphic elastic playback-sync engine |
| `packages/api-client` | Typed REST/WS client (web + mobile + extension) |
| `packages/design` | The design system's tokens and guards |
| `packages/p2p` | WebRTC mesh primitives |
| `infra` | Self-host path: docker-compose, Caddy, coturn |

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
| [docs/history/](docs/history/) | Superseded plans (build spec, concept, UX overhaul) — historical only |
