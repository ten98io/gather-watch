# Playin — infra

One `docker compose` file = the full self-hosted production stack: Caddy (TLS
edge), Next.js web, Fastify API, media worker, MongoDB, Redis, LiveKit SFU,
coturn, MinIO.

```
infra/
  docker-compose.yml       # the whole stack
  Caddyfile                # TLS edge + reverse proxy (prod domain + localhost:8080 dev block)
  livekit.yaml             # LiveKit SFU config (rtc ports, room defaults, TURN integration)
  coturn/turnserver.conf   # TURN relay config (secret injected via CLI from .env)
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
| media      | 4500                         | —                       | health endpoint only; BullMQ/ffmpeg worker                 |
| mongo      | 27017                        | —                       | MongoDB 7 (volume `mongo_data`)                            |
| redis      | 6379                         | —                       | Redis 7 (pubsub + queues; volume `redis_data`)             |
| livekit    | 7880, 7881, 50000–50200/udp  | same                    | 7880 WS signalling, 7881 ICE/TCP fallback, UDP media range |
| coturn     | 3478 tcp+udp, 5349 tcp+udp, 49160–49200/udp | same     | STUN/TURN; 49160–49200 = relay range                       |
| minio      | 9000, 9001                   | 9000, 127.0.0.1:9001    | S3 API (public; presigned PUTs hit it directly) / admin console (loopback only) |

Cross-file invariants (change one → change all):

- LiveKit UDP range `50000–50200`: compose `livekit.ports` ⟷ `livekit.yaml`
  `rtc.port_range_start/end`.
- coturn relay range `49160–49200`: compose `coturn.ports` ⟷
  `turnserver.conf` `min-port`/`max-port`.
- Health endpoints are a contract with the app code: API serves
  `GET /healthz` → 200 on `:4000`; media worker serves `GET /healthz` → 200 on
  `:4500` (`MEDIA_PORT`). Compose gating and Docker HEALTHCHECKs both probe
  these.

## First boot

1. **Env.** At the repo root: `cp .env.example .env`, then set real values for
   `JWT_SECRET`, `JWT_REFRESH_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
   `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `TURN_STATIC_AUTH_SECRET` (long random
   string). Compose uses required-variable interpolation (`${VAR:?}`) for every
   credential, so a missing or empty value fails the deploy loudly instead of
   booting on the dev placeholders printed in this public repo.

   Leave `MONGO_URL`/`REDIS_URL` alone — compose pins the in-network
   `mongodb://mongo:27017/playin` and `redis://redis:6379` per service, so the
   empty dev defaults (in-memory adapters) can never leak into prod containers.
2. **Domain.** In `infra/Caddyfile`, replace `playin.example.com` with your
   domain (both the main block and, if used, the LiveKit subdomain block).
   Point DNS A/AAAA at the host. Update `APP_URL`, `S3_PUBLIC_BASE_URL`
   (`https://your.domain/media/playin-media`) and `LIVEKIT_URL` in `.env`.
   If you enable the (commented-out, opt-in) `rtc.turn_servers` block in
   `infra/livekit.yaml`, replace its `playin.example.com` host too — the
   Caddyfile step does not cover that file.
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
5. **Seed (optional).** Run the repo's seed script inside the api container:

   ```sh
   docker compose -f infra/docker-compose.yml --env-file .env exec api \
     pnpm --filter ./services/api run seed
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
- **coturn TLS (5349)** does not use Caddy's certs automatically. Plain
  3478/udp TURN works without it. To enable turns:, mount a cert/key pair into
  the coturn container and uncomment `cert=`/`pkey=` in `turnserver.conf`.
- getUserMedia/getDisplayMedia require a secure context — everything
  user-facing must be behind https in production (localhost is exempt in dev).

## LiveKit / TURN firewall notes

Open on the host firewall (inbound):

| Port(s)             | Proto   | Why                                                        |
| ------------------- | ------- | ---------------------------------------------------------- |
| 80, 443             | tcp (+443/udp) | Caddy: ACME + HTTPS/H3 for web, `/api`, `/ws`, `/media` |
| 7880                | tcp     | LiveKit WS signalling — only if NOT proxying via Caddy (see below) |
| 7881                | tcp     | LiveKit ICE/TCP fallback (clients on UDP-blocked networks)  |
| 50000–50200         | udp     | LiveKit WebRTC media                                        |
| 3478                | udp+tcp | coturn STUN/TURN                                            |
| 5349                | tcp     | coturn TURN over TLS (once certs are mounted)               |
| 49160–49200         | udp     | coturn relay range                                          |

- **Signalling TLS:** browsers on an https page need `wss://`. Either
  uncomment the `livekit.playin.example.com` block in the Caddyfile (then
  `LIVEKIT_URL=wss://livekit.playin.example.com`, and 7880 can stay closed to
  the internet), or terminate TLS on 7880 some other way. Raw `ws://host:7880`
  only works for plain-HTTP dev.
- **TURN credentials:** coturn runs `use-auth-secret` (time-limited HMAC creds
  derived from `TURN_STATIC_AUTH_SECRET`, injected by compose as a CLI flag —
  coturn configs can't read env vars; compose refuses to start without the
  secret). The API is expected to mint `timestamp:user` / HMAC pairs from the
  same secret when handing RTCConfiguration to clients. `livekit.yaml`'s
  static `turn_servers` handout is commented out by default (it cannot
  authenticate against `use-auth-secret`) — see the comment there before
  enabling it.
- **NAT:** `rtc.use_external_ip: true` in `livekit.yaml` makes LiveKit
  advertise the host's public IP from behind docker bridge networking. If the
  host itself is behind another NAT (home lab), forward the LiveKit+coturn
  ports on the outer router too.
- coturn can run with `network_mode: host` (Linux only) instead of explicit
  port mappings — preferable for large relay ranges, since docker
  userland-proxies every mapped port; swap the commented block in compose.

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
- **media** workers scale the same way (`--scale media=N`) — BullMQ
  coordinates job ownership through Redis.
- **web** (Next.js) is stateless; scale like api if it's ever the bottleneck
  (it usually isn't — Caddy gzips and the heavy traffic is media).
- **mongo/redis/minio** are single-node here by design (one-box self-host).
  Growing beyond one box means: Mongo replica set, Redis with a real password
  + persistence policy, MinIO distributed mode — at which point split this
  compose file rather than bending it.
- **livekit** vertical-scales a long way on one node (it's the SFU doing the
  heavy lifting; the 12-publisher room cap is app policy). Multi-node LiveKit
  requires its Redis-based routing config — out of scope for the one-box
  stack.
