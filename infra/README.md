# Gather — infra

One `docker compose` file = the full self-hosted production stack: Caddy (TLS
edge), Next.js web, Fastify API, media worker, MongoDB, Redis, MinIO.

The media plane needs no self-hosted service: calls run p2p mesh (default) or
Cloudflare Realtime SFU (premium Theater mode), with Cloudflare TURN as the
relay for clients behind hostile NATs — all reached directly by clients, with
the API minting short-lived credentials.

```
infra/
  docker-compose.yml       # the whole stack
  Caddyfile                # TLS edge + reverse proxy (prod domain + localhost:8080 dev block)
  README.md
```

Dockerfiles live with their services (`apps/web/Dockerfile`,
`services/api/Dockerfile`, `services/media/Dockerfile`) and are all built from
the **repo root** context (simple full-workspace pnpm build — rationale
documented in each Dockerfile).

## Port map

| Service    | Container port(s)            | Published on host       | Purpose                                                    |
| ---------- | ---------------------------- | ----------------------- | ---------------------------------------------------------- |
| caddy      | 80, 443, 443/udp, 8080       | 80, 443, 443/udp, 127.0.0.1:8080 | TLS termination + reverse proxy; 8080 = plain-HTTP dev block (loopback only) |
| web        | 3000                         | — (via caddy)           | Next.js PWA                                                |
| api        | 4000                         | — (via caddy)           | Fastify REST + room WebSocket (`/api/*`, `/ws`)            |
| media      | 4500                         | —                       | health endpoint only; ffmpeg worker (in-process queue — run ONE replica) |
| mongo      | 27017                        | —                       | MongoDB 7 (volume `mongo_data`)                            |
| redis      | 6379                         | —                       | Redis 7 (pubsub; volume `redis_data`)                      |
| minio      | 9000, 9001                   | 9000, 127.0.0.1:9001    | S3 API (public; presigned PUTs hit it directly) / admin console (loopback only) |

Cross-file invariant (change one → change all): health endpoints are a
contract with the app code — the API serves `GET /healthz` → 200 on `:4000`;
the media worker serves `GET /healthz` → 200 on `:4500` (`MEDIA_PORT`).
Compose gating and Docker HEALTHCHECKs both probe these.

## First boot

1. **Env.** At the repo root: `cp .env.example .env`, then set real values for
   `JWT_SECRET`, `JWT_REFRESH_SECRET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`.
   Compose uses required-variable interpolation (`${VAR:?}`) for every
   credential, so a missing or empty value fails the deploy loudly instead of
   booting on the dev placeholders printed in this public repo.

   For TURN relay in production, set `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN`
   (Cloudflare TURN keys). Without them the API falls back to
   `TURN_STATIC_AUTH_SECRET` (an EXTERNAL coturn you run yourself — none ships
   in this compose file) and finally to STUN-only.

   Leave `MONGO_URL`/`REDIS_URL` alone — compose pins the in-network
   `mongodb://mongo:27017/gather` and `redis://redis:6379` per service, so the
   empty dev defaults (in-memory adapters) can never leak into prod containers.
2. **Domain.** In `infra/Caddyfile`, replace `gather.example.com` with your
   domain. Point DNS A/AAAA at the host. Update `APP_URL` and
   `S3_PUBLIC_BASE_URL` (`https://your.domain/media/gather-media`) in `.env`.
3. **Launch** from the repo root (the `--env-file` flag is required — compose
   interpolation otherwise looks for `infra/.env`):

   ```sh
   docker compose -f infra/docker-compose.yml --env-file .env up -d --build
   ```

   Boot order is enforced by healthcheck conditions: mongo/redis/minio become
   healthy → `minio-init` creates the bucket and sets anonymous-download on the
   `public/` prefix → api starts → web → caddy.
4. **Verify.**

   ```sh
   docker compose -f infra/docker-compose.yml --env-file .env ps        # all Up/healthy
   curl -fsS http://localhost:8080/api/healthz                          # via caddy dev block
   ```

A repo-root `.dockerignore` is committed (the compose build context is the
repo root) — it keeps `.git`, `node_modules`, build output and **all `.env*`
files** out of every image. Do not remove it: without it, `COPY . .` would
bake the populated root `.env` (all production secrets) into the builder and
runtime layers of all three images. The builder stages also `rm -f .env .env.*`
as a belt-and-braces guard.

## Certificates

- **Caddy is the only TLS terminator.** It auto-provisions and renews Let's
  Encrypt certs for every site block with a real domain — requirements: DNS
  resolves to this host, ports 80+443 open. Certs persist in the `caddy_data`
  volume; keep it, or you'll re-issue (and risk LE rate limits) on every boot.
- While testing DNS/infra, avoid rate limits with the staging CA — add inside
  the site block: `tls { ca https://acme-staging-v02.api.letsencrypt.org/directory }`.
- The `http://localhost:8080` dev block is deliberately plain HTTP (no
  self-signed cert noise). Firewall 8080 in production.
- getUserMedia/getDisplayMedia require a secure context — everything
  user-facing must be behind https in production (localhost is exempt in dev).

## TURN notes

Only 80/443 (tcp, +443/udp for HTTP/3) need to be open inbound — the media
plane (mesh WebRTC, Cloudflare SFU, Cloudflare TURN) never terminates on this
host.

The API hands clients ICE servers from `GET /rtc/turn-credentials` with a
strategy chain:

1. **Cloudflare TURN** (`CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` set): the API
   mints short-lived credentials via Cloudflare's TURN-keys API, tagged per
   user for usage attribution.
2. **External coturn** (`TURN_STATIC_AUTH_SECRET` set): time-limited
   `timestamp:user` / HMAC-SHA1 credential pairs in the coturn REST
   convention — for a coturn instance you operate outside this compose stack.
3. **STUN-only** fallback (no relay; direct/NAT-traversable paths only).

Free-plan TURN relay is fair-use capped per account
(`FREE_TURN_CAP_GB_PER_MONTH`); over the cap the API strips `turn:`/`turns:`
URLs and keeps STUN.

## Scaling notes

- **api is stateless** — all cross-instance coordination (room WS fan-out,
  presence, sync events) goes through Redis pub/sub, and durable state lives
  in Mongo. Scale it with:

  ```sh
  docker compose -f infra/docker-compose.yml --env-file .env up -d --scale api=3
  ```

  Caddy's `reverse_proxy api:4000` resolves via Docker's DNS; with multiple
  replicas add all upstreams or use Caddy's dynamic upstreams
  (`dynamic a { name api port 4000 }`) so it re-resolves. No sticky sessions
  needed: a reconnecting WS client replays missed events via
  `GET /rooms/{id}/events?since=seq` regardless of which replica it lands on.
- **media must run exactly ONE replica.** Its job queue is an in-process
  promise chain — there is no BullMQ (and it never reads `REDIS_URL`), so
  nothing coordinates job ownership across replicas; a second replica would
  double-process uploads. Scale it vertically, or build real queue
  coordination first.
- **web** (Next.js) is stateless; scale like api if it's ever the bottleneck
  (it usually isn't — Caddy gzips and the heavy traffic is media).
- **mongo/redis/minio** are single-node here by design (one-box self-host).
  Growing beyond one box means: Mongo replica set, Redis with a real password
  + persistence policy, MinIO distributed mode — at which point split this
  compose file rather than bending it.
