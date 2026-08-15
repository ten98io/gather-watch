# Deploying Playin on Railway (Pro)

## Shape: modular monolith + specialized sidecars — NOT microservices

The control plane is **one deployable** (`api`) containing every domain module
(auth, rooms, chat, sync, presence, tokens). Services are split only where a
runtime physically demands it:

| Railway service | What | Why it's separate | Scaling |
|---|---|---|---|
| `web` | Next.js PWA (SSR + static) | Different runtime/scale profile than WS | Replicas, stateless |
| `api` | Fastify: REST + room WebSockets | The app itself — modular monolith | **Replicas, stateless** (Redis pub/sub fans out WS events across replicas) |
| `media` | ffmpeg → HLS worker | CPU spikes must never sit beside latency-sensitive WS | Vertical first; queue absorbs bursts |
| `livekit` | WebRTC SFU (Go binary) | Media plane ≠ control plane; own binary | One node; see global section |
| **Railway Bucket** | Native S3-compatible object storage (no container) | Launched Sept 2025 — replaces MinIO on Railway. $0.015/GB-mo, **S3 API ops and egress free & unlimited** | Managed |
| MongoDB | Railway managed template | State | Managed |
| Redis | Railway managed template | Presence, pub/sub, queues, rate limits | Managed |

Four app containers + managed data — coarse-grained on purpose. No service mesh, no
per-feature microservices; modules stay in-process behind interfaces, so a future
split is a deploy decision, not a rewrite. MinIO remains only in the generic
docker-compose self-host path; on Railway the S3 adapter simply points at the Bucket
(private + presigned URLs — matching the upload design).

## Railway specifics baked into the code

- Every service binds `0.0.0.0:$PORT` (Railway injects `PORT`) and serves `/healthz`.
- Internal calls use private networking (`api.railway.internal` etc.) — free, fast, IPv6.
- Each deployable carries a `railway.json` (dockerfile path, healthcheck path,
  restart policy, region).
- Secrets via Railway shared variables mirroring `.env.example`.
- **No public UDP on Railway** → LiveKit runs ICE-TCP (Railway TCP proxy on 7881) +
  embedded TURN over TLS. WebRTC works fully; media latency is somewhat higher than
  UDP. `LIVEKIT_URL` / `LIVEKIT_EXTERNAL_HOST` env overrides let you relocate the SFU
  to any UDP-capable box or LiveKit Cloud later — config change only, zero code.

## Global strategy (and the Cloudflare question)

**Cloudflare Workers cannot be this app's primary runtime.** Workers can't host an
SFU (no UDP sockets, no long-lived media relay), can't run ffmpeg HLS ladders (CPU-ms
limits, no native binaries), and can't run MongoDB/MinIO. A full-edge port would mean
a different product: Durable Objects + R2 + external Atlas + LiveKit Cloud — more
vendor lock-in, not less, and it abandons the self-hostable compose stack.

**What we do instead — hybrid edge:**

1. **Cloudflare as CDN in front of Railway** (proxied DNS): cache `_next/static/*`
   and all HLS segments/artwork at the edge (`Cache-Control: immutable` — segments
   never change). This is where global perceived performance actually lives: media
   bytes served from the nearest PoP. WS + API pass through uncached.
2. **Railway multi-region replicas (Pro feature)** for `web` and `api` when the user
   base spreads: api is stateless by design (Redis pub/sub), so replicas in
   `us-west`, `eu-west`, `southeast-asia` just work behind Railway's router.
3. **Media plane goes global last**: the SFU is the only true latency prisoner.
   When rooms span continents, flip `LIVEKIT_URL` to LiveKit Cloud (global edge
   mesh) or a small fleet of UDP-capable VPSes — the escape hatch is already wired.
4. *(Optional, later)* room WS fan-out could move to Cloudflare Durable Objects for
   edge-local chat latency — the contracts/WS protocol was designed transport-
   agnostic, so this stays possible without touching clients.

## First deploy checklist

1. `railway init` in repo → create web/api/media/livekit services from Dockerfiles.
2. Add Mongo + Redis templates; copy their URLs into shared variables.
3. Create a Railway Bucket; put its S3 endpoint/credentials into the `S3_*` variables
   (presigned-URL flows work unchanged; no MinIO service on Railway).
4. TCP proxy on `livekit` :7881; set `LIVEKIT_EXTERNAL_HOST` to the proxy host:port.
5. Generate `JWT_SECRET`, `JWT_REFRESH_SECRET`, VAPID keys; set SMTP creds.
6. Custom domain on `web` + `api` (or one domain, path-routed via web rewrites);
   turn on Cloudflare proxy + cache rules for `/media/*` and `_next/static/*`.
7. Healthchecks green → invite your first room.
