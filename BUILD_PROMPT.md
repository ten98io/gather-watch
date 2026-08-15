# Playin — Build Spec v3 (FULL SCOPE)

> The build bible. Worker briefs are cut from this document. No MVP trimming — every
> feature below ships. Decisions are locked; do not re-litigate them in worker output.

## Locked decisions

1. **Both playback modes ship.** Mode A (synced-source) and Mode B (re-stream from one
   initiating device, for non-DRM / user-made content). Rooms come in two flavors,
   **watch** and **listen**, both running the same sync engine with different UI skins.
2. **Stack is TypeScript everywhere** (freehand exercised — see rationale below).
   MongoDB stays. FastAPI replaced by Fastify: the sync engine, event reducers, and
   contracts are *one shared TS package* used by server, web, and mobile — impossible
   with a Python control plane.
3. **PWA + native, one monorepo.** Next.js PWA is the universal client (desktop +
   mobile browser). Expo/React Native app (single codebase → iOS + Android) ships for
   the native-only powers: background robustness, native AirPlay, ReplayKit/CallKit
   later. They share `contracts`, `sync-core`, and `api-client` packages — logic is
   written once.
4. **Full chat/call surface is a must** — texting, replies, edits, reactions, emotes,
   GIFs, attachments, voice notes, receipts, mentions, pins, search, unfurls, typing,
   presence; FaceTime-like calls with grid/speaker/PiP. All in scope, all in this build.
5. **K3 swarm codes, Claude reviews.** Verified working: `kimi -p "<brief>"` headless
   with default model `kimi-code/k3` (1M context) writes files autonomously.
   Claude (Fable/Opus) agents write briefs, review diffs, run gates, fix or bounce.

## Topology pivot — P2P-first (v3.1, BINDING — supersedes conflicting text below)

Owner directive (2026-08-15): the platform must be **lite on the provider** — user
devices carry the media and compute; the server handles persistence and coordination
only. Architecture accordingly:

### Default room topology: encrypted WebRTC mesh
- Every room runs a **full P2P mesh**: RTCPeerConnections pair-wise between
  participants, negotiated over the existing room WS (signaling events
  `webrtc.offer/answer/ice`, perfect-negotiation pattern). WebRTC's DTLS-SRTP means
  media is **end-to-end encrypted between peers by construction** — no middlebox
  ever sees plaintext. This is a headline feature, not an implementation detail.
- **Sync = master/follower over DataChannels**: the host is master clock by default;
  the master broadcasts sync beacons `{positionMs, rate, playing, masterTs, epoch}`
  at 1 Hz + on every mutation. Followers run sync-core's ClockEstimator against
  beacon timestamps (same math, different time source) and drift-correct locally.
  Deterministic re-election on master death (beacon silence > 3 s): lowest join-order
  connected peer wins; `epoch` increments prevent split-brain; server arbitrates ties
  and stores the last state snapshot for late joiners + persistence.
- **Mode B P2P**: the sharing device fans its capture out per-viewer (default cap 8
  viewers, configurable); bitrate adapts per-link via getStats + setParameters;
  the host sees an uplink-saturation warning. Host uplink is the physics ceiling —
  the UI says so honestly.
- **Calls**: mesh, default cap 6 simultaneous AV publishers per room.
- **Uploaded-content watching**: P2P file streaming — the owner's device serves
  chunks over DataChannels (backpressure + seek-window protocol); no server storage,
  works while the owner is present. The server HLS pipeline becomes an **optional
  module** (`ENABLE_MEDIA_PIPELINE`, default **off**) for always-available libraries.
- Mode A external sources (YouTube/direct URL) unchanged — bytes already come from
  the source's CDN, never from us; only the sync beacons ride the mesh.

### Server role (the whole point: tiny)
Auth, room/member state, WS signaling relay, **persistence with authoritative
ordering** (chat, reactions, playback history, logs, playlists, read cursors —
server assigns seq), presence, ephemeral TURN credentials (HMAC, coturn REST
convention), STUN server list. Chat stays server-ordered: its bytes are trivial and
history/consistency demand one writer. Mongo + Redis unchanged.

### TURN fallback: Cloudflare managed (owner decision — no self-hosted coturn)
~10–20 % of peer pairs (symmetric NAT/CGNAT, common on mobile) cannot connect
directly; they relay via **Cloudflare's managed TURN** ($0.05/GB after a 1,000
GB/month free tier, 330+ cities). The api mints short-lived TURN credentials through
Cloudflare's TURN-keys API — never expose the account token to clients. coturn stays
only in the generic docker-compose for self-hosters; Railway deployments run zero
TURN infrastructure. Free-plan TURN usage gets a per-account fair-use cap
(configurable, generous) so the free tier can't silently drain the budget.

### Premium relay tier: Cloudflare Realtime SFU (plans below)
TURN cannot raise viewer counts — the host still uploads one copy per peer through a
relay. Removing the host-uplink ceiling requires an SFU: **Cloudflare Realtime SFU**
(same platform, same $0.05/GB + 1 TB free) is the premium engine. In "Theater mode"
the host publishes ONE copy to the nearest Cloudflare edge and the SFU fans out to
50+ viewers with per-viewer adaptation. `@playin/p2p` exposes a `RelayProvider`
abstraction: `mesh` (default) ↔ `cf-sfu` (premium) per room, switchable mid-session;
sync beacons ride DataChannels in both topologies with WS as last-resort transport.
LiveKit remains a third, self-host `RelayProvider` behind `ENABLE_SFU` (default off)
for sovereignty-minded deployments. Default deployment: zero media infrastructure.

### Plans & monetization (binding)
- **Free — full product, P2P physics**: every feature (both modes, calls, full chat,
  playlists, casting), E2E-encrypted mesh, mesh caps (6 AV publishers / 8 share
  viewers), Cloudflare TURN fallback under fair-use cap. Free is not a crippled demo;
  its ceiling is physics, not feature gates.
- **Premium (subscription)**: per-room **Theater mode** — Cloudflare SFU relay:
  50+ viewers, no host-uplink ceiling, smoother under packet loss, uncapped TURN,
  plus higher upload/attachment quotas. Room badge switches from "P2P · E2E" to
  "Relayed · Theater" so encryption semantics stay honest (SFU terminates DTLS).
- Billing: **Stripe** — checkout session + customer portal + webhooks
  (`services/api` billing module) driving an entitlements service (plan, caps,
  relay rights) checked at room-policy evaluation. Usage metering: session-minutes
  + client `getStats` samples persisted per room for cost attribution and fair-use
  enforcement. All billing state in Mongo; no Stripe calls in the hot path.

### New foundation package: `packages/p2p`
`@playin/p2p` — isomorphic mesh engine (injected RTCPeerConnection: browser native /
react-native-webrtc): pair-wise perfect negotiation over WS signaling; DataChannel
fabric (sync beacons, file chunks, emote fast-path); master election (join-order +
epoch); ICE restart + reconnect; stats-driven bitrate adaptation; TURN credential
refresh. Pure logic testable with mock RTC.

## Stack (pinned)

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo, TS strict everywhere |
| Web | Next.js 15 (App Router), Tailwind, shadcn/ui, Zustand, TanStack Query, `@livekit/components-react`, installable PWA |
| Mobile | Expo (latest SDK), expo-router, `@livekit/react-native`, expo-video/expo-audio |
| API | Node 22+, Fastify 5 + `@fastify/websocket`, Zod validation from contracts |
| Data | MongoDB 7 (official driver), Redis 7 (ioredis) — **both behind adapter interfaces with in-memory fallbacks** so dev/tests run with zero installed services |
| Media plane | **P2P WebRTC mesh (default, E2E-encrypted)** via `@playin/p2p`; coturn/managed TURN fallback; LiveKit OSS as opt-in SFU tier (`ENABLE_SFU`) |
| Media pipeline | Optional module (`ENABLE_MEDIA_PIPELINE`, default off): ffmpeg → HLS → S3; primary path is P2P file streaming from the owner's device |
| Auth | Magic-link email → JWT (httpOnly) + refresh rotation; guest join via invite link |
| Deploy | One `docker-compose.yml`: caddy, web, api, media, mongo, redis, livekit, coturn, minio |
| Tests | Vitest + mongodb-memory-server; Playwright e2e (two-context sync tests) |

## Architecture rules (unchanged from v2, binding)

1. Server-authoritative sync. Playback mutations stamped
   `{mediaId, positionMs, rate, playing, serverTs, seq}`. Clients estimate clock offset
   over WS (ping/5s, EWMA), correct drift by rate-nudge 0.95×–1.05×, hard-seek only
   past 2 s. Gate: ≤150 ms median drift across 4 simulated clients with ±80 ms jitter.
2. One multiplexed room WS: `{type, roomId, payload, seq}`; gap recovery via
   `GET /rooms/{id}/events?since=seq`. Chat, presence, sync, queue, receipts, emotes —
   all on this stream.
3. LiveKit tokens minted server-side only, scoped room+identity, TTL ≤ 6 h.
4. `packages/contracts` (Zod) is the single source of truth. Server validates with it,
   clients derive types from it. No hand-written duplicate types anywhere.
5. Mode A uses real `<video>/<audio>` elements → AirPlay (Remote Playback API /
   `webkitShowPlaybackTargetPicker`), Chromecast sender (default media receiver plays
   the HLS/MP4 URL directly), Bluetooth for free, MediaSession lock-screen controls.
6. Adapters for Mode A sources implement one interface: `load, play, pause, seekTo,
   setRate, positionMs(), durationMs(), events`. Ship: HLS(hls.js)/native, YouTube
   iframe, direct URL. SoundCloud widget optional behind the same interface.

## Full feature spec

### Identity & auth
Magic-link email sign-in (dev transport: link printed to API log + surfaced in UI);
JWT session in httpOnly cookie, refresh rotation, multi-device sessions; guest join
via invite link (display name only, room-scoped identity, upgradeable to account);
profile: display name, avatar (upload → MinIO), accent color; account settings page.

### Rooms
Create watch|listen room; invite via short code + link; roles host/moderator/member/
guest; host handoff (explicit + auto on disconnect after grace); kick/ban; per-room
policies: who controls playback, who queues, chat permissions, max AV publishers;
member list with live state (watching/listening/in-call/muted/away); room persists
with full history; user home lists their rooms + unread badges.

### Playback — Mode A (synced source)
Sources: uploaded media (HLS), YouTube, direct URL (mp4/mp3/m3u8). Controls
play/pause/seek/rate/track-change gated by room policy. Late joiners snap to live
position. Buffering coordination: "wait-for-all" toggle (host) vs free-run. Drift
HUD (debug). Automatic audio ducking while a call participant speaks.

### Playback — Mode B (re-stream)
Desktop Chrome/Edge host captures tab/screen **with audio** (`getDisplayMedia`) →
LiveKit screen-share track; all devices (web + mobile) subscribe as viewers. Host
badge, stop/handoff, viewer count, uplink quality indicator. Pre-flight DRM warning
(protected content renders black — by OS/browser design, not a bug). Non-DRM and
user-made content only.

### Listen mode
Music-first skin on the same engine: collaborative playlists (CRUD, reorder, save to
library), shared queue with vote-to-skip (majority configurable), album art +
waveform seek bar, gapless-ish track advance driven by sync engine.

### Chat (full surface, room-scoped)
Text with markdown-lite (bold/italic/code/links); emoji picker; **GIFs** (Tenor API
when key configured + GIF upload fallback); attachments image/video/audio/file via
presigned MinIO uploads with progress; voice notes (MediaRecorder → upload, inline
waveform player); replies (WhatsApp-style quote); edit + delete (tombstone);
per-emoji reactions with counts; typing indicators; delivered/read receipts (per-user
room read cursor, avatars on last-read); @mentions with highlight + notification;
pinned messages rail; full-text search (Mongo text index) with jump-to-message;
server-side link unfurls (OG fetch, SSRF-guarded); **emote bursts** — ephemeral
floating reactions over the player, not persisted; infinite scroll pagination;
unread separators and badges.

### Calls (FaceTime-like, in-room)
Voice + video via LiveKit; grid + active-speaker views; PiP overlay while media
plays; mic/cam toggles, device pickers, mute states mirrored into presence; screen
share inside a call = Mode B plumbing; background blur (LiveKit track processors)
where supported; browser echo cancellation + noise suppression constraints on.

### Casting & output
Mode A per-device: AirPlay picker (Safari/Remote Playback API), Cast sender (Chrome,
default receiver, casts the HLS/MP4 URL), Bluetooth via OS. MediaSession lock-screen
metadata + transport controls (web + PWA). Mobile native player exposes AirPlay
route picker + true background audio.

### Notifications & presence
Web Push (mentions, invites, room-started) with per-room mute; Expo push on mobile;
unread counts on home; presence heartbeats with away detection.

### Media library & pipeline
Chunked upload → MinIO; ffmpeg worker: HLS ladder (1080p/720p + audio-only rendition),
thumbnails, audio waveform JSON; per-user library (list/delete/rename); per-user
storage quota (configurable, default 10 GB); processing status via WS events.

### Mobile app (Expo, full participant)
All room features: Mode A playback (expo-video/expo-audio, native AirPlay, background
audio + lock-screen controls), Mode B viewing, calls, full chat, queue/playlists,
push notifications. Hosting Mode B from mobile is native-milestone scaffolding only
(iOS ReplayKit stub documented, not faked).

### Ops
Health/readiness endpoints; pino structured logs; per-route + per-WS-event rate
limits; metrics counters endpoint; seed script with demo users/rooms/media.

## Non-functional gates
- Sync drift ≤150 ms median (property test, 4 clients, ±80 ms jitter).
- Rooms: ≥100 chat participants, ≤12 simultaneous AV publishers.
- WS reconnect replays missed events with zero loss/dupes (seq-verified test).
- `pnpm i && pnpm test` green from clean checkout with **no services installed**
  (memory adapters). `docker compose up` = full production stack.
- `tsc --noEmit` + eslint clean across every workspace; Vitest ≥85% on sync-core and
  chat/sync server modules.
- No secrets in repo; `.env.example` exhaustive; LiveKit keys server-side only.

## Repo layout
```
playin/
  apps/web/            apps/mobile/
  services/api/        services/media/      # media = optional module
  packages/contracts/  packages/sync-core/  packages/api-client/  packages/p2p/
  infra/               # docker-compose.yml, livekit.yaml, coturn, caddy, seed
  docs/
```

## Deployment target — Railway (Pro plan)

Primary deploy is **Railway Pro**; docker-compose remains for generic self-hosting.

- Topology: Railway services `web`, `api`, `media`, `livekit`, `minio` (volume) +
  Railway-managed **MongoDB** and **Redis**. Every service binds `0.0.0.0:$PORT`
  (Railway injects PORT) and exposes `/healthz` for Railway healthchecks.
- Internal traffic uses Railway private networking (`*.railway.internal`); public
  domains only on web, api (wss), livekit, and the minio public-media path.
- **UDP constraint (hard)**: Railway has no public UDP ingress. LiveKit therefore runs
  ICE-TCP (7881 via Railway TCP proxy) + embedded TURN over TLS; no separate coturn
  service on Railway. Clients force relay/TCP transparently. Provide
  `LIVEKIT_URL`/`LIVEKIT_EXTERNAL_HOST` overrides so the SFU can later move to any
  UDP-capable box (or LiveKit Cloud) with zero code changes — config only.
- Each deployable ships a `railway.json` (dockerfile path, healthcheck, restart
  policy, region). Deploy guide: `docs/DEPLOY_RAILWAY.md`.

## Safeguards & compliance (extreme-abuse-only — NEVER degrade normal use)

Anti-abuse, tuned so legitimate users never notice: burst-friendly rate limits on
REST + WS (block floods, not enthusiasm); magic-link request throttling; rooms are
invite-only with no public directory (abuse surface stays small by design); owner/mod
kick+ban (already spec'd); `POST /report` content-report endpoint + admin takedown
CLI; upload quota (default 10 GB) and max-file-size caps; session revocation on
password^H^H^H device compromise ("sign out everywhere"). Explicitly NOT built: chat
content filtering, media scanning, telemetry on what users play. Private rooms stay
private.

Compliance surface: `/legal/terms`, `/legal/privacy`, `/legal/abuse` (DMCA + abuse
contact) pages; GDPR endpoints — `GET /me/export` (full JSON export) and
`DELETE /me` (account + cascade delete with grace period); cookies limited to auth
(no trackers — a notice line, no consent-banner circus); WCAG 2.1 AA per DESIGN.md
(keyboard nav, focus rings, AA contrast, `prefers-reduced-motion`, HLS subtitle/CC
track support in the player).

## Design direction (binding for all client UI)

`DESIGN.md` at repo root is the binding design system for web + mobile. The bar is
"out of this world", literally: cinematic space-dark theme, aurora accents, glass
surfaces, ambient glow sampled from the playing media, physics-feeling motion —
while staying WCAG 2.1 AA and honoring reduced-motion. No stock admin-dashboard look.

## Swarm workflow (binding)
- **Orchestrator (Claude, main session)**: cuts worker briefs from this spec with
  explicit file ownership (disjoint paths — workers never share a directory), runs
  integration, owns `packages/contracts` changes.
- **Workers (K3)**: `kimi -p "<brief>"` headless in their owned directory. A brief =
  goal, owned paths, contract types to conform to, test command that must pass.
- **Reviewers (Claude subagents)**: review worker diffs against this spec, run gates,
  adversarially test (reconnect, clock skew, duplicate seq, authz bypass), file
  findings; fixes happen as new briefs or direct patches — never silent hand-edits
  without a finding recorded.
- **Merge rule**: gates green + reviewer approval, else bounce with findings.
