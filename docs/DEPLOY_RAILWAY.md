# Deploying Gather on Railway — step-by-step runbook

Project: **Gather-App** (already created and linked via `railway link`).
Data plane: **MongoDB Atlas** (external, existing) + **Railway Redis** (already
provisioned). **Do not add Railway's Mongo template** — Mongo lives in Atlas.

## Current state (as of 2026-08-16)

| Resource | State | Action |
|---|---|---|
| `web` / `api` / `media` services | created, never deployed | configure + deploy below |
| Redis | **online**, with volume | keep — wire `REDIS_URL` into `api` |
| `mongodb-volume`, `mongodb-volume-yuCl` | **detached leftovers** (0.8 GB + 0 GB) | **delete both** (dashboard → volume → ⋯ → Delete). Detached volumes still bill per GB. |
| LiveKit / TURN | not created | optional Phase 3 — calls work P2P without it |

The rollout is deliberately phased so each step is verifiable before the next:

- **Phase 1 — core app**: `api` + `web`. Rooms, chat, sync, YouTube/SoundCloud/
  Vimeo playback, calls (P2P mesh) all work.
- **Phase 2 — media pipeline**: Railway Bucket + `media` service. Enables
  uploads → HLS library.
- **Phase 3 — premium relay (optional)**: LiveKit/TURN on a UDP-capable box or
  LiveKit Cloud. Only needed for Theater-mode relayed calls.

---

## Phase 0 — one-time prep

### 0.1 Generate secrets (run locally, keep in a password manager)

```bash
openssl rand -base64 48   # JWT_SECRET
```

```bash
openssl rand -base64 48   # JWT_REFRESH_SECRET (must differ from JWT_SECRET)
```

```bash
npx web-push generate-vapid-keys   # VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Rules the code enforces: in `NODE_ENV=production` the api **refuses to boot**
unless `JWT_SECRET` and `JWT_REFRESH_SECRET` are set and ≥32 chars.
`JWT_SECRET` must be **byte-identical** on `api` and `media` (media validates
tokens the api mints).

### 0.2 Prepare Atlas

1. Atlas → Database Access: create/confirm the app user (username + password —
   these are what's in your local `atlas-credentials.env`).
2. Atlas → Network Access: Railway containers have no fixed egress IP by
   default. Either enable Railway **static outbound IPs** on the `api` and
   `media` services (service → Settings → Networking) and allowlist those, or
   allowlist `0.0.0.0/0` and rely on TLS + a strong password (common for
   Atlas + PaaS; rotate the password if you choose this).
3. Copy the **connection string** (Drivers → Node.js), and put the database
   name in the path. It should look like:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/gather?retryWrites=true&w=majority`

> ⚠️ Naming mismatch to watch: your local file uses `MONGODB_URI`, but the app
> reads **`MONGO_URL`**. On Railway the variable must be named `MONGO_URL`.
> If `MONGO_URL` is missing or empty the api boots on an **in-memory store**
> and silently loses everything on each restart — the `/readyz` healthcheck
> (now the deploy healthcheck) only protects you once the variable exists.

### 0.3 Connect the repo to Railway (recommended: GitHub auto-deploys)

For **each** of the three services (`web`, `api`, `media`):

1. Service → Settings → **Source**: connect your GitHub repo, branch `main`.
2. Settings → **Root Directory**: leave as `/` (repo root). The Dockerfiles
   copy the whole pnpm workspace; a subdirectory root breaks the build.
3. Settings → **Config-as-code** → path:
   - `web` → `apps/web/railway.json`
   - `api` → `services/api/railway.json`
   - `media` → `services/media/railway.json`
   Each file pins the right Dockerfile, healthcheck and restart policy.
4. (Optional, avoids rebuild storms) Settings → **Watch paths**:
   - `web`: `apps/web/**`, `packages/**`
   - `api`: `services/api/**`, `packages/**`
   - `media`: `services/media/**`, `packages/**`

CLI alternative (no GitHub): from the repo root,
`railway up --service api` builds from your local directory. The repo's
`.dockerignore` now excludes `atlas-credentials.env` so local builds cannot
bake credentials into image layers — still, prefer repo-connected deploys.

---

## Phase 1 — api + web

### 1.1 Configure `api` variables

Service `api` → **Variables** → Raw editor. Paste, then fill values:

```env
NODE_ENV=production
JWT_SECRET=<from 0.1>
JWT_REFRESH_SECRET=<from 0.1>
MONGO_URL=<Atlas connection string from 0.2>
ADMIN_EMAILS=mgandhi@crystal.re
VAPID_PUBLIC_KEY=<from 0.1>
VAPID_PRIVATE_KEY=<from 0.1>
VAPID_SUBJECT=mailto:mgandhi@crystal.re
```

Then add Redis by **reference** (Variables → New Variable → Add Reference):
pick the Redis service. Railway inserts something like:

```env
REDIS_URL=${{Redis.REDIS_URL}}
```

If the reference picker offers a **private/internal** URL variant, use it —
private networking is free and faster; the public proxy URL also works.

Leave `APP_URL` for step 1.4 (needs the web domain). Do **not** set
`PORT` — Railway injects it and the api reads it first.

Optional but recommended now:

```env
# Transactional email — Cloudflare Email Service, over its REST API.
# Both of these are required together; either one alone is ignored and the
# api falls back to SMTP, then to logging the link.
CF_EMAIL_ACCOUNT_ID=<cloudflare account id>
CF_EMAIL_API_TOKEN=<token with email-sending permission — SECRET>
#
# THE FROM ADDRESS MUST BE ON THE VERIFIED SENDING DOMAIN.
# The sender is `email.gather.watch`, which is deliberately NOT the app domain
# (`gather.watch`) — a subdomain keeps sending reputation off the domain the
# product lives on. A from address on the bare app domain is accepted by this
# config, passes every test, and is then REJECTED by Cloudflare at send time,
# so it fails in production only.
CF_EMAIL_FROM=Gather <no-reply@email.gather.watch>
#
# SMTP is the fallback, not the path. Keep it only if you want a second route.
# GIF picker (free key from Google/Tenor) — omit and GIFs just say "not configured"
TENOR_API_KEY=<key>
```

If you skip SMTP: sign-in still works — the magic link is printed in the api
**deploy logs** (`railway logs --service api`, look for the `/auth/verify`
URL). Fine for first-boot testing, not for real users.

### 1.2 Generate the api domain, then deploy

1. Service `api` → Settings → Networking → **Generate Domain** (port 4000).
   Copy it, e.g. `https://api-production-xxxx.up.railway.app`.
2. Deploy the service (push to `main`, or click Deploy, or `railway up
   --service api`).
3. Watch: Deployments → View logs. Success = config parse passes, then
   Railway's healthcheck on **`/readyz`** goes green (this endpoint pings
   Mongo — an Atlas allowlist mistake fails the deploy here, on purpose).
4. Verify from your machine:

```bash
curl https://<api-domain>/healthz && curl https://<api-domain>/readyz
```

Both should return `{"ok":true}`.

### 1.3 Configure `web`

Service `web` → Variables:

```env
NEXT_PUBLIC_API_URL=https://<api-domain from 1.2>
```

Notes:
- This is a **build-time** variable (Next.js inlines it). The web Dockerfile
  declares `ARG NEXT_PUBLIC_API_URL`, which is how Railway passes service
  variables into Docker builds. If you ever see the deployed site calling
  `localhost:4000`, the variable wasn't set **before** the build — set it and
  redeploy.
- No trailing slash. The WebSocket URL is derived from it automatically.

Settings → Networking → **Generate Domain** (port 3000). Copy it. Deploy.

### 1.4 Point the api at the web origin (CORS + links)

Back on `api` → Variables, add:

```env
APP_URL=https://<web-domain from 1.3>
API_URL=https://<api-domain>
```

`APP_URL` is the **only** allowed CORS origin and the base for magic-link
emails — if it doesn't exactly match the web origin, every browser call fails
preflight. Redeploy `api` (variable changes prompt a redeploy automatically).

### 1.5 Smoke-test Phase 1

1. Open `https://<web-domain>` → sign up with your email.
   - No SMTP yet? `railway logs --service api` and open the printed link.
2. Create a watch room → paste a YouTube URL into the queue → it plays.
3. Open the room in a second browser/incognito via the invite code — playback
   position and play/pause must stay in sync; chat works; a 2-person call
   works (P2P mesh, no LiveKit needed).
4. `https://<web-domain>/admin` should show the ops console (your email is in
   `ADMIN_EMAILS`).

**Stop here if anything fails** — see Troubleshooting below.

---

## Phase 2 — uploads/HLS (Railway Bucket + media service)

Skip this phase entirely if you don't need file uploads yet; everything else
works without it (upload/library UI reports itself unavailable).

### 2.1 Create a Railway Bucket

Project canvas → Create → **Bucket** (native S3-compatible storage; S3 API
ops and egress are free, storage billed per GB). Open the bucket's
**Connect** tab — it shows endpoint, access key, secret key, bucket name.

### 2.2 Configure `media` variables

```env
NODE_ENV=production
JWT_SECRET=<SAME value as api>
MONGO_URL=<SAME Atlas string as api>
ENABLE_MEDIA_PIPELINE=true
S3_ENDPOINT=<bucket endpoint>
S3_ACCESS_KEY=<bucket access key>
S3_SECRET_KEY=<bucket secret key>
S3_BUCKET=<bucket name>
S3_PUBLIC_BASE_URL=<bucket public base URL (Connect tab)>
APP_URL=https://<web-domain>
```

Settings → Networking → Generate Domain (port 4500). Deploy, then:

```bash
curl https://<media-domain>/readyz
```

> ⚠️ `media` must run **exactly one replica** (its ffmpeg job queue is
> in-process and serial — replicas would double-process jobs). Don't scale it
> horizontally; give it more CPU/RAM instead.

### 2.3 Flip the api's media flags

On `api` → Variables, add the same `S3_*` block **plus**:

```env
ENABLE_MEDIA_PIPELINE=true
STORAGE_QUOTA_GB=10
```

Redeploy `api`. Upload a small mp4 in a room → it should appear in the
library and play as HLS.

---

## Phase 3 (optional) — LiveKit relay for Theater mode

Railway has no public UDP, so the SFU is the one piece that prefers another
home. Options, in order of effort:

1. **LiveKit Cloud** (fastest): create a project, set on `api`:
   `LIVEKIT_URL=wss://<project>.livekit.cloud`,
   `LIVEKIT_INTERNAL_URL=https://<project>.livekit.cloud`,
   `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` from the dashboard.
2. **Any small UDP-capable VPS** running `livekit-server` with
   `infra/livekit.yaml` (+ coturn with `infra/coturn/turnserver.conf` and
   `TURN_STATIC_AUTH_SECRET` set on both the box and the api).
3. **LiveKit on Railway over ICE-TCP** (works, higher latency): deploy the
   `livekit/livekit-server` image as a new service, TCP proxy on 7881, set
   `LIVEKIT_EXTERNAL_HOST` to the proxy host:port.

Without Phase 3, calls run pure P2P mesh (fine to ~4-6 people) and the
premium Theater relay toggle reports itself unavailable — nothing else breaks.

### Stripe (only when selling Premium)

```env
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…   # webhook endpoint: https://<api-domain>/billing/webhook
STRIPE_PRICE_PREMIUM_MONTHLY=price_…
```

---

## Browser extension (ships outside Railway)

The extension talks to the API directly, and MV3 bundles can't read env at
runtime — the origin is inlined at build time:

```bash
GATHER_API_URL=https://<api-domain> pnpm --filter ./apps/extension build
```

Load `apps/extension/dist` via chrome://extensions → Load unpacked (or zip it
for the Web Store). Omitting `GATHER_API_URL` keeps the localhost dev default.

## Custom domains (when ready)

1. `web` → Settings → Networking → Custom Domain (e.g. `gather.watch`), add the
   CNAME Railway shows at your DNS.
2. Same for `api` (e.g. `api.gather.watch`).
3. Update `NEXT_PUBLIC_API_URL` (web, triggers rebuild), `APP_URL` + `API_URL`
   (api), and redeploy both.
4. Optional edge caching: proxy the domains through Cloudflare and cache
   `/_next/static/*` and HLS segments (immutable). WS and API pass through
   uncached.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| api deploy fails healthcheck, logs show config VALIDATION error | Missing/short JWT secrets, or malformed variable — the error lists every offending var by name. |
| api deploy fails healthcheck, boot logs fine | `/readyz` can't reach Atlas → Network Access allowlist (0.2), or bad `MONGO_URL` credentials. |
| Site loads, every action fails, console shows CORS errors | `APP_URL` on api ≠ exact web origin (scheme + host, no trailing slash). |
| Site tries to call `http://localhost:4000` | `NEXT_PUBLIC_API_URL` wasn't set at build time → set it, redeploy `web`. |
| Sign-in email never arrives | SMTP vars unset/wrong → magic link is in `railway logs --service api`. |
| Data vanished after a redeploy | `MONGO_URL`/`REDIS_URL` empty at boot → api ran on in-memory adapters. Set them; check `/readyz`. |
| Uploads say unavailable | `ENABLE_MEDIA_PIPELINE` must be `true` on **both** api and media, S3 vars on both. |
| Browser extension can't connect | It was built without `GATHER_API_URL` and is pointing at localhost — rebuild it (see below). |

## Architecture notes (unchanged decisions)

- **Modular monolith + sidecars**: one `api` deployable holds every domain
  module; `web`, `media` are separate only because their runtime profiles
  differ. `api` is stateless — Redis pub/sub fans WS events across replicas,
  so horizontal scaling is a slider, not a rewrite. `media` is the one
  single-replica service.
- **Mongo stays on Atlas** (owner decision 2026-08-16): no Railway Mongo
  template; the two detached `mongodb-volume*` leftovers should be deleted.
- **Cloudflare cannot replace this stack** (no UDP/ffmpeg/long-lived sockets
  at the edge); it remains useful strictly as a CDN in front of Railway.
