# Playin

A self-hosted shared living-room: watch parties, listen-together sessions, video
calls, and an iMessage-grade chat — one room, every device.

- **Concept & feasibility matrix**: [CONCEPT.md](CONCEPT.md)
- **Binding build spec (full scope)**: [BUILD_PROMPT.md](BUILD_PROMPT.md)

## Quickstart (dev — zero services required)

```bash
pnpm install
cp .env.example .env
pnpm dev          # api :4000, web :3000 (in-memory Mongo/Redis adapters)
```

## Production (single host)

```bash
cp .env.example .env   # fill in real secrets
docker compose -f infra/docker-compose.yml up -d
```

## Workspace map

| Path | What |
|---|---|
| `apps/web` | Next.js 15 PWA |
| `apps/mobile` | Expo (iOS + Android) |
| `services/api` | Fastify control plane: auth, rooms, chat, sync, tokens |
| `services/media` | Upload → ffmpeg → HLS → MinIO pipeline |
| `packages/contracts` | Zod schemas — single source of truth for REST + WS |
| `packages/sync-core` | Isomorphic playback sync engine |
| `packages/api-client` | Typed REST/WS client (web + mobile) |
| `infra` | docker-compose, LiveKit, coturn, Caddy |
