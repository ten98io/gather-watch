# Deploying Gather on Railway — runbook

Project: **Gather** (linked via `railway link` — note: linking writes to the
home-directory config, not the repo; verify what's linked before `railway up`).
Data plane: **MongoDB Atlas** (external) + **Railway Redis**. **Do not add
Railway's Mongo template** — Mongo lives in Atlas.

## Current state (as of 2026-08-17): DEPLOYED and serving at gather.watch

| Resource | State |
|---|---|
| `api` + `web` services | **deployed**, zero-downtime deploys gated on `/readyz`, config-as-code (`services/api/railway.json`, `apps/web/railway.json`) |
| Redis | online, wired into `api` by reference variable |
| `attachments` Railway Bucket (`ams`) | **live** — chat attachments; wired into `api` by reference variables |
| `media` service | **DELETED** — users never upload streams; the upload→HLS pipeline is not deployed |
| Email | Cloudflare Email Service, sender domain `email.gather.watch` |
| Custom domains | `gather.watch` (web) + api domain, live |
| LiveKit | never used (its token route 404'd until 2026-08-16 and was never exercised); deleted from the repo |
| `mongodb-volume`, `mongodb-volume-yuCl` | detached leftovers — **delete if still present** (dashboard → volume → ⋯ → Delete); detached volumes still bill per GB |

Phase status:

- **Phase 1 — core app (`api` + `web`): DONE.** Kept below as the runbook for
  redeploying from scratch.
- **Phase 2 — media pipeline: SUPERSEDED.** The media service is deleted; the
  only storage is the `attachments` bucket (done). Original instructions
  removed — they can no longer be followed.
- **Phase 3 — LiveKit relay: REPLACED.** Theater relay is Cloudflare
  Realtime (`relayMode: 'cf-sfu'`); what remains is setting the Cloudflare
  TURN/SFU keys on `api` (see Phase 3 below).

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

### 0.2 Prepare Atlas

1. Atlas → Database Access: create/confirm the app user (username + password —
   these are what's in your local `atlas-credentials.env`).
2. Atlas → Network Access: Railway containers have no fixed egress IP by
   default. Either enable Railway **static outbound IPs** on the `api`
   service (service → Settings → Networking) and allowlist those, or
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

### 0.3 Connect the repo to Railway (DONE; recommended: GitHub auto-deploys)

For **each** of the two services (`web`, `api`):

1. Service → Settings → **Source**: connect your GitHub repo
   (`mustafagandhi/gather-watch`), branch `main`.
2. Settings → **Root Directory**: leave as `/` (repo root). The Dockerfiles
   copy the whole pnpm workspace; a subdirectory root breaks the build.
3. Settings → **Config-as-code** → path:
   - `web` → `apps/web/railway.json`
   - `api` → `services/api/railway.json`
   Each file pins the right Dockerfile, healthcheck and restart policy —
   this is what makes deploys zero-downtime, gated on `/readyz`.
4. (Optional, avoids rebuild storms) Settings → **Watch paths**:
   - `web`: `apps/web/**`, `packages/**`
   - `api`: `services/api/**`, `packages/**`

CLI alternative (no GitHub): from the repo root,
`railway up --service api` builds from your local directory. The repo's
`.dockerignore` now excludes `atlas-credentials.env` so local builds cannot
bake credentials into image layers — still, prefer repo-connected deploys.

---

## Phase 1 — api + web (DONE — kept as the from-scratch runbook)

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

Email + GIFs (configured in production — kept for recreation):

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
2. Create a room → paste a YouTube URL into the queue → it plays.
3. Open the room in a second browser/incognito via the invite code — playback
   position and play/pause must stay in sync; chat works; a 2-person call
   works (P2P mesh, no relay needed).
4. `https://<web-domain>/admin` should show the ops console (your email is in
   `ADMIN_EMAILS`).

**Stop here if anything fails** — see Troubleshooting below.

---

## Phase 2 — attachments bucket (DONE; media pipeline superseded)

The original Phase 2 (Railway Bucket + `media` service for uploads → HLS) is
gone: the media service is deleted and users never upload streams. What
exists instead, already configured:

- The **`attachments` Railway Bucket** (region `ams`), wired into `api` via
  reference variables. Chat attachments are read through stable capability
  URLs (`/assets/:id/content` → 60s presigned GET).
- To recreate: project canvas → Create → **Bucket**, then add its connection
  values to `api` by reference (Variables → New Variable → Add Reference).

---

## Phase 3 — Cloudflare Realtime relay for Theater mode (keys pending)

LiveKit is gone — no room ever successfully used it (its token route 404'd
until 2026-08-16 and was never exercised), and it is deleted from the
repo. Theater-mode relay is **Cloudflare Realtime** (`relayMode: 'cf-sfu'`;
mesh is the default). The one deploy step: set the Cloudflare TURN/SFU keys
on `api` (names from `services/api/src/config.ts`):

```env
CF_TURN_KEY_ID=…
CF_TURN_API_TOKEN=…
CF_SFU_APP_ID=…
CF_SFU_API_TOKEN=…
ENABLE_SFU=true
FREE_TURN_CAP_GB_PER_MONTH=20   # optional; default 20
```

Until the TURN keys are set, voice dropouts persist for peers that need a
relay. Rates and the cost model: `docs/COST_MODEL.md`.

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

## Custom domains (DONE — `gather.watch` is live)

1. `web` → Settings → Networking → Custom Domain (`gather.watch`), add the
   CNAME Railway shows at your DNS.
2. Same for `api`.
3. Update `NEXT_PUBLIC_API_URL` (web, triggers rebuild), `APP_URL` + `API_URL`
   (api), and redeploy both.
4. Optional edge caching: proxy the domains through Cloudflare and cache
   `/_next/static/*` (immutable). WS and API pass through uncached.

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
| Browser extension can't connect | It was built without `GATHER_API_URL` and is pointing at localhost — rebuild it (see above). |

## Architecture notes (unchanged decisions)

- **Modular monolith**: one `api` deployable holds every domain module; `web`
  is separate only because its runtime profile differs. `api` is stateless —
  Redis pub/sub fans WS events across replicas, so horizontal scaling is a
  slider, not a rewrite.
- **Mongo stays on Atlas** (owner decision 2026-08-16): no Railway Mongo
  template; the two detached `mongodb-volume*` leftovers should be deleted.
- **Cloudflare cannot replace this stack** (no UDP or long-lived sockets at
  the edge); it serves as CDN in front of Railway plus the Realtime TURN/SFU
  and Email services.
