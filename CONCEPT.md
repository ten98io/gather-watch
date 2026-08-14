# Playin — a shared living-room for the internet

One room where a group can watch, listen, talk, and text together — with the media, the
call, and the chat treated as one session instead of three apps taped together.

## The core architectural insight

"Watch/listen together from any source" is actually **two different products** with
different architectures. Playin must support both as explicit modes:

### Mode A — Synced-source (default)
Every participant's device plays the *same source locally* (YouTube embed, uploaded
file served as HLS, SoundCloud, direct media URL). The server only synchronizes a tiny
playback state machine: `{trackId, position, rate, playing, hostClock}`.

- Near-zero server bandwidth, perfect quality on every device.
- **Casting works for free**: each device owns a real `<video>/<audio>` element, so
  AirPlay (Safari/Remote Playback API), Chromecast, and Bluetooth all work natively.
- Survives tab switching and phone locking (background *playback* is allowed by every OS;
  background *capture* is not).
- Legal: no re-distribution of streams.

### Mode B — Re-stream (screen/tab share)
One desktop host captures a browser tab or screen **with audio** via `getDisplayMedia`
and publishes it through an SFU; everyone else subscribes like a video call.

- This is what covers "any source + system audio" — anything the host can play, minus DRM.
- Host must be desktop Chrome/Edge (tab-audio capture support). Quality bounded by uplink.
- **DRM is a hard wall**: Netflix/Disney+/Prime render black frames under capture
  (EME/HDCP). No hosted app can fix this. The honest answer for DRM services is a
  "companion co-watch" mode (everyone plays their own subscription; Playin syncs
  play/pause countdowns, chat, and call) — or a browser extension later.

Layered over both modes: video/voice call bubbles, and an iMessage-grade chat
(replies, reactions, typing, read receipts, media messages), all scoped to the room.

## Platform truth table (what's actually possible)

| Capability | Desktop Chrome/Edge | Desktop Safari | Android Chrome | iOS Safari / PWA | iOS native (later) |
|---|---|---|---|---|---|
| Watch synced source (Mode A) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Host tab/screen share w/ audio | ✅ (tab audio ✅) | ⚠️ screen only, no audio | ⚠️ screen, no system audio | ❌ | ✅ ReplayKit |
| Watch a re-stream (Mode B) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Video/voice call | ✅ | ✅ | ✅ | ✅ (foreground) | ✅ + CallKit |
| Keep call audio when locked/backgrounded | ✅ | ✅ | ✅ | ⚠️ audio-only, best-effort | ✅ |
| Keep *capturing* when backgrounded | ✅ | ⚠️ | ❌ | ❌ | ✅ ReplayKit |
| AirPlay out | ⚠️ media element only | ✅ | ❌ | ✅ (Mode A sources) | ✅ full |
| Chromecast out | ✅ Cast SDK (own receiver) | ❌ | ✅ | ❌ | ⚠️ |
| Bluetooth speakers | ✅ (OS-level, free) | ✅ | ✅ | ✅ | ✅ |

Design consequence: **Mode A is the universal path; Mode B is a desktop-hosted
superpower.** Mobile users are always full *participants*, sometimes not *hosts*.

## Architecture (fully self-hosted)

```
Next.js PWA ──┐
Expo iOS/Android ─REST/WS──► Fastify API ──► MongoDB (users, rooms, messages, playlists, media)
     │                          │   └──────► Redis (presence, pub/sub fanout, rate limits)
     │                          └── mints LiveKit access tokens (server-side only)
     └────WebRTC────► LiveKit SFU (self-hosted, OSS) + coturn (TURN)
Uploads ──► media service ──► ffmpeg → HLS ──► MinIO (S3) ──► caddy
```

- **TypeScript everywhere** (stack freehand exercised): the contracts, sync engine, and
  event reducers live in shared packages consumed by server, web, and mobile — written
  once, no drift. The control plane (Fastify) never touches media bytes — the SFU does.
- **LiveKit OSS**: self-hostable SFU with first-class Python server SDK (fits FastAPI),
  excellent React components, simulcast, screen-share-with-audio support built in.
- **Sync engine**: server-authoritative. Server timestamps state changes with its own
  clock; clients run NTP-ish offset estimation over WS and correct drift by rate-nudging
  (0.95×–1.05×) instead of seeking. Target drift ≤ 150 ms across participants.
- **MongoDB**: right shape for messages/rooms/playlists. Redis is non-negotiable for
  presence + multi-worker WS fanout.

## Client strategy: PWA **and** native, one monorepo

Answer to "PWA or native?": both, without duplicating logic.

- **PWA (Next.js 15 + Tailwind + shadcn/ui + LiveKit React)** is the universal client —
  desktop browsers, Android install + background audio, iOS Safari participation.
- **Native (Expo/React Native, single codebase → iOS + Android)** ships alongside for
  what web can't do on phones: rock-solid background/locked audio, native AirPlay
  route picker, push done right, and the later ReplayKit/CallKit powers.
- Both consume the same `contracts`, `sync-core`, and `api-client` packages — the sync
  engine and event logic are written exactly once.

## Build plan

Full scope in one program — every subsystem above ships together. The milestone
phasing was replaced at the owner's direction; see [BUILD_PROMPT.md](BUILD_PROMPT.md)
for the binding feature spec, quality gates, and the K3-swarm/Claude-review workflow.

## Honest constraints to keep on the box

- DRM content can never be re-streamed — black screen by design of EME/HDCP.
- iOS web cannot capture the screen, and no web app keeps *capturing* while backgrounded.
- Arbitrary WebRTC streams can't be AirPlayed/Cast from a web page; casting is a
  Mode A feature (real media elements) until there's a native app / Cast receiver.
- "Full iMessage/WhatsApp/FaceTime" is a multi-year surface — Playin ships the 20%
  used during a watch party (chat, reactions, calls), not E2EE messaging infrastructure.
