# Deploying Gather on Railway — runbook

Project: **Gather**. Data plane: **MongoDB Atlas** (external) + **Railway
Redis**. **Do not add Railway's Mongo template** — Mongo lives in Atlas.

## The deploy path is GitHub, not the CLI

Both services are repo-connected to `mustafagandhi/gather-watch` on branch
`main`, with config-as-code. **Pushing to `main` is the deploy**; Railway builds
and rolls both services with no CLI step. Everything in this runbook that says
"deploy the service" means "push, or click Deploy in the dashboard".

`railway up` still works and is a **local-source override**, not the path: it
uploads your working directory instead of the commit, so what it ships is
whatever is on your disk, tracked or not. Two traps come with the CLI and both
have cost time here:

- **`railway link` writes to `~`.** Linking is stored in the home-directory
  config, not the repo, so a shell in this checkout may be pointed at another
  project entirely. Re-check what is linked before any `up`.
- **`railway run` executes LOCALLY with Railway's env.** That is exactly right
  for admin scripts (see "Destructive tooling" below) — the connection string
  never reaches a shell history. It is exactly wrong as a connectivity test: the
  process dials from the operator's IP, not Railway's, so an Atlas allowlist
  gap, an egress-IP mismatch or a private-networking problem looks *fine* under
  `railway run` and still fails in the deployed container. Only `/readyz` on the
  deployed api answers that question.

## Current state (as of 2026-08-18): DEPLOYED and serving at gather.watch

| Resource | State |
|---|---|
| `api` + `web` services | **deployed**, zero-downtime deploys, config-as-code (`services/api/railway.json` → healthcheck `/readyz`; `apps/web/railway.json` → healthcheck `/`) |
| Redis | online, wired into `api` by reference variable — `/readyz` reports `"busMode":"redis"` |
| Mongo Atlas cluster | **new cluster** (the previous one was deleted). The database is fresh, and its indexes were built by the current code, so it has the partial-unique indexes rather than the old sparse ones |
| `attachments` Railway Bucket (`ams`) | **live** — chat attachments; wired into `api` by reference variables |
| `media` service | **DELETED** — users never upload streams, nothing transcodes, and `services/media` is gone from the repo too |
| Email | Cloudflare Email Service, sender domain `email.gather.watch` |
| Custom domains | `gather.watch` (web) + api domain, live |
| LiveKit | never used (its token route 404'd until 2026-08-16 and was never exercised); deleted from the repo |
| `mongodb-volume`, `mongodb-volume-yuCl` | detached leftovers — **delete if still present** (dashboard → volume → ⋯ → Delete); detached volumes still bill per GB |

There are exactly **two** Railway services to deploy. Anything else in the
project canvas is either a data store (Redis, the bucket) or a leftover.

Phase status:

- **Phase 1 — core app (`api` + `web`): DONE.** Kept below as the runbook for
  redeploying from scratch.
- **Phase 2 — media pipeline: SUPERSEDED.** The media service is deleted; the
  only storage is the `attachments` bucket (done). Original instructions
  removed — they can no longer be followed.
- **Phase 3 — relay keys: PARTLY PENDING.** LiveKit is gone. What remains is
  setting the Cloudflare **TURN** keys on `api`; the SFU keys are reserved
  names that nothing dials yet (see Phase 3 below).

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

CLI override (see the top of this file): `railway up --service api` from the
repo root builds from your local directory rather than the commit. The repo's
`.dockerignore` excludes `atlas-credentials.env` so local builds cannot bake
credentials into image layers — still, this is the escape hatch, not the path.

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

`/healthz` returns `{"ok":true}` — it is liveness only and never touches a
backend. `/readyz` returns `{"ok":true,"store":true,"bus":true,"busMode":"redis"}`
and is the one that matters: it pings Mongo *and* Redis, and it 503s with a
`reason` if either is silent **or** if the bus is in-memory in production (that
instance would be isolated from every other replica). A live api answering
`"busMode":"memory"` means `REDIS_URL` did not arrive.

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

## Phase 3 — Cloudflare TURN keys (pending; this is the live gap)

LiveKit is gone — no room ever successfully used it (its token route 404'd
until 2026-08-16 and was never exercised), and it is deleted from the repo.

**Theater mode is a layout, not a transport.** It collapses the rail and
floats the call tiles; it does not move the room onto a relay. Every stored
room is `relayMode: 'mesh'`, and nothing writes `'cf-sfu'`
(`services/api/test/rooms-ungated.test.ts` pins that, because the old theater
toggle used to flip it and hand the room a call path that is still a stub).

So the one deploy step that matters is the TURN pair (names from
`services/api/src/config.ts`):

```env
CF_TURN_KEY_ID=…
CF_TURN_API_TOKEN=…
```

Until these are set the API serves **STUN only** — there is no second relay to
fall back to, so peers behind a symmetric NAT simply cannot connect and voice
dropouts persist. The credentials are minted per user, short-lived, by
`services/api/src/modules/rtc/`, and handed out at
`GET /rtc/turn-credentials`.

```env
CF_SFU_APP_ID=…
CF_SFU_API_TOKEN=…
```

These two parse into `AppConfig` and are read by **nothing else** — the client
lane that would dial the Realtime SFU is not built. Setting them today changes
no behaviour; they are the reserved names for the deferred capacity fallback
(`docs/CAST_RELAY.md`, `docs/COST_MODEL.md`). There is no `ENABLE_SFU` flag;
if you see one in an older doc or an old Railway variable list, it is not a
config key and never was in this codebase.

TURN relay is unmetered — every account gets relay URLs whenever a relay is
configured. Egress is billed. Rates and the cost model: `docs/COST_MODEL.md`.

---

## Browser extension (ships outside Railway)

The extension talks to the API directly, and MV3 bundles can't read env at
runtime — the origin is inlined at build time. **Use `build:prod`, not `build`:**

```bash
GATHER_API_URL=https://<api-domain> \
  GATHER_WEB_ORIGINS=https://gather.watch,https://www.gather.watch \
  pnpm --filter ./apps/extension build:prod
```

`build:prod` refuses to emit without an https, non-loopback origin, and refuses
a web origin the manifest's `externally_connectable.matches` does not admit.
Plain `build` is the dev script: it has no such checks, defaults to
`http://localhost:4000`, and — even when handed a real origin — labels the
result **UNVERIFIED** in its banner, in `dist/BUILD.txt` and in the extension's
own name in `chrome://extensions`. An artifact pointing at localhost installs
cleanly, is detected by the web app, and then fails every call; that has shipped
once. See `apps/extension/README.md`.

Load `apps/extension/dist` via chrome://extensions → Load unpacked (or zip it
for the Web Store).

## Destructive tooling (dry-run by default)

Two CLIs ship with the api. Both print a plan and change nothing without
`--yes`, and both are meant to be run with the deployment's own credentials so
no connection string is ever pasted anywhere:

```bash
railway run --service api pnpm --filter gather-api exec tsx src/cli/reset-db.ts
railway run --service api pnpm --filter gather-api exec tsx src/cli/clear-bucket.ts
```

- `reset-db.ts` drops every collection — accounts, rooms, messages, events. It
  resolves the database name the way the app does (`dbNameFromUrl`), so it
  cannot target a different db than the one the api uses. **Restart the api
  afterwards:** indexes are created by `store.init()` at boot and nothing
  recreates them at runtime, so an api that booted against the old collections
  serves a database with no indexes — including the partial unique indexes on
  `users.email` and `pushSubs`, whose absence silently permits exactly the
  duplicate rows they exist to prevent.
- `clear-bucket.ts` deletes every attachment object. Run it **with** a database
  reset, not instead of one: the only record that an object exists is its
  `AssetDoc` in Mongo, so dropping the database alone orphans every object —
  unreferenced, unreachable, still billed, and with no record left of what to
  delete.

A third CLI, `src/cli/takedown.ts`, works the `POST /report` mailbox:
`takedown.ts list`, then `resolve <reportId>` (or `resolve <reportId>
--dismiss`). It is also destructive and has **no dry-run flag** — resolving a
report tombstones the message, or bans the user in every room and revokes their
sessions, or deletes the room and its invites, depending on the target kind.
`--dismiss` is the only way to close a report without touching the target.

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
  the edge); it serves as CDN in front of Railway, plus Realtime TURN and
  Email Service. The Realtime SFU is in the design, not in the deploy.
- **One tier, no billing.** There is no payment processor to configure, no
  webhook endpoint to register and no Stripe variable to set. Three tombstone
  suites fail if any of that comes back (`services/api/test/no-billing.test.ts`,
  `rooms-ungated.test.ts`, `apps/web/test/no-paywall.test.ts`).
- **Rooms never expire.** Nothing on the deploy needs a TTL, a cron or a
  cleanup job: the only sweep deletes rooms that are *empty* and 30 days
  quiet, and it runs in-process.
