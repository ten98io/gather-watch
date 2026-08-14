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

## Stack (pinned)

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo, TS strict everywhere |
| Web | Next.js 15 (App Router), Tailwind, shadcn/ui, Zustand, TanStack Query, `@livekit/components-react`, installable PWA |
| Mobile | Expo (latest SDK), expo-router, `@livekit/react-native`, expo-video/expo-audio |
| API | Node 22+, Fastify 5 + `@fastify/websocket`, Zod validation from contracts |
| Data | MongoDB 7 (official driver), Redis 7 (ioredis) — **both behind adapter interfaces with in-memory fallbacks** so dev/tests run with zero installed services |
| Media plane | LiveKit OSS (self-hosted SFU) + coturn; server-side token minting via `livekit-server-sdk` |
| Media pipeline | ffmpeg → HLS ladder → MinIO (S3 API); BullMQ queue w/ in-process fallback |
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
  services/api/        services/media/
  packages/contracts/  packages/sync-core/  packages/api-client/
  infra/               # docker-compose.yml, livekit.yaml, coturn, caddy, seed
  docs/
```

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
