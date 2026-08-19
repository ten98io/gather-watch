# Gather — infra

One `docker compose` file = the full self-hosted production stack: Caddy (TLS
edge), Next.js web, Fastify API, MongoDB, Redis, MinIO.

The media plane needs no self-hosted service. Calls and screen shares run as a
p2p **mesh**, with Cloudflare **TURN** as the relay for clients behind hostile
NATs — reached directly by clients, with the API minting short-lived
credentials. Cloudflare's Realtime **SFU** is in the design as the capacity
fallback and is not dialled by anything today (theater mode is a layout, not a
transport). Nothing here transcodes: content plays from its own source on each
viewer's device, or travels peer-to-peer as a screen share.

```
infra/
  docker-compose.yml       # the whole stack
  Caddyfile                # TLS edge + reverse proxy (prod domain + localhost:8080 dev block)
  README.md
```

Dockerfiles live with their services (`apps/web/Dockerfile`,
`services/api/Dockerfile`) and are all built from
the **repo root** context (simple full-workspace pnpm build — rationale
documented in each Dockerfile).

## Port map

| Service    | Container port(s)            | Published on host       | Purpose                                                    |
| ---------- | ---------------------------- | ----------------------- | ---------------------------------------------------------- |
| caddy      | 80, 443, 443/udp, 8080       | 80, 443, 443/udp, 127.0.0.1:8080 | TLS termination + reverse proxy; 8080 = plain-HTTP dev block (loopback only) |
| web        | 3000                         | — (via caddy)           | Next.js PWA                                                |
| api        | 4000                         | — (via caddy)           | Fastify REST + room WebSocket (`/api/*`, `/ws`)            |
| mongo      | 27017                        | —                       | MongoDB 7 (volume `mongo_data`)                            |
| redis      | 6379                         | —                       | Redis 7 (pubsub; volume `redis_data`)                      |
| minio      | 9000, 9001                   | 9000, 127.0.0.1:9001    | S3 API (public; presigned PUTs hit it directly) / admin console (loopback only) |

Cross-file invariant (change one → change all): health endpoints are a
contract with the app code — the API serves `GET /healthz` → 200 on `:4000`.
Compose gating and Docker HEALTHCHECKs both probe this.

## First boot

1. **Env.** At the repo root: `cp .env.example .env`, then set real values for
   `JWT_SECRET`, `JWT_REFRESH_SECRET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`.
   Two of those four fail loudly on their own: `S3_ACCESS_KEY` and
   `S3_SECRET_KEY` use compose's required-variable interpolation
   (`${VAR:?set … in .env}`) on the `minio` and `minio-init` services, so a
   missing value stops the stack rather than booting MinIO on the placeholders
   printed in this public repo. The two JWT secrets arrive via `env_file` and
   are enforced one layer up instead: the api runs with `NODE_ENV=production`,
   and `loadConfig` refuses to boot unless both are set and ≥32 chars. Either
   way, a placeholder never reaches a running container silently.

   For TURN relay in production, set `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN`
   (Cloudflare TURN keys). Without them the API serves STUN-only — there is no
   second relay to fall back to. See "TURN notes" below.

   Leave `MONGO_URL`/`REDIS_URL` alone — compose pins the in-network
   `mongodb://mongo:27017/gather` and `redis://redis:6379` per service, so the
   empty dev defaults (in-memory adapters) can never leak into prod containers.
2. **Domain.** In `infra/Caddyfile`, replace `gather.example.com` with your
   domain. Point DNS A/AAAA at the host. Set `APP_URL` in `.env` to that same
   public origin (`https://your.domain`, no trailing slash).

   **`APP_URL` is load-bearing at BUILD time, not just at runtime.** The web
   image inlines `NEXT_PUBLIC_API_URL` into the client bundle, and compose
   derives it as `${APP_URL}/api` (`infra/docker-compose.yml`, the `web`
   service's `build.args`). Compose fails the build with a named error if
   `APP_URL` is unset, because the alternative is an image that builds, goes
   green, and then calls `http://localhost:4000` from every visitor's browser.
   The matching half is in `infra/Caddyfile`: its `/api/*` block **strips the
   prefix** before forwarding to `api:4000`, because the API mounts every route
   at a bare path. Change one of those two and you must change the other.

   `S3_PUBLIC_BASE_URL` needs nothing: it parses into `AppConfig` and is read
   by no code path. Attachments are served through the API's own capability
   route (`GET /assets/:assetId/content` → a short-lived presigned GET), which
   is what keeps the bucket private. The Caddyfile's `/media/*` block and this
   variable are both there for a self-hoster who wants to expose their bucket
   directly; nothing in the product does.
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
plane (mesh WebRTC, Cloudflare TURN) never terminates on this host.

The API hands clients ICE servers from `GET /rtc/turn-credentials`. There are
exactly two outcomes:

1. **Cloudflare TURN** (`CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` set): the API
   mints short-lived credentials via Cloudflare's TURN-keys API, tagged per
   user for usage attribution. If that call fails for any reason the API logs
   it and falls through to (2) rather than erroring the join.
2. **STUN-only** (no relay; direct/NAT-traversable paths only) — this is what
   you get with no Cloudflare keys, so a client behind a symmetric NAT simply
   cannot connect.

There is **no self-hosted coturn option**. An earlier build accepted
`TURN_STATIC_AUTH_SECRET` and minted `timestamp:user` / HMAC-SHA1 pairs in the
coturn REST convention for a coturn you ran yourself; that strategy and its
config key were both deleted. Setting the variable today does nothing at all —
`services/api/test/config-coturn.test.ts` pins that absence at the config
layer, precisely so an operator can't set it and get a silently relay-less
deploy. Bringing coturn back means writing the strategy again, not restoring
an env var.

TURN relay is unmetered: every account gets relay URLs whenever a relay is
configured. Per-user credential tagging exists for attribution in your
provider's analytics, not to ration anyone.

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
- **there is no media service to scale.** The old transcoder container had a
  one-replica constraint (its job queue was an in-process promise chain — never
  BullMQ, and it never read `REDIS_URL` — so nothing coordinated job ownership
  and a second replica double-processed uploads). `services/media` is deleted:
  Gather never transcodes, because nobody uploads a stream. Playback is the
  source's own player, driven by the browser extension, or a peer-to-peer
  screen share. If a transcoder ever comes back, the one-replica rule comes
  back with it — it was a property of that queue, not of this compose file.
- **web** (Next.js) is stateless; scale like api if it's ever the bottleneck
  (it usually isn't — Caddy gzips and the heavy traffic is media).
- **mongo/redis/minio** are single-node here by design (one-box self-host).
  Growing beyond one box means: Mongo replica set, Redis with a real password
  + persistence policy, MinIO distributed mode — at which point split this
  compose file rather than bending it.
