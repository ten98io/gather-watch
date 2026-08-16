# @playin/extension — Playin for Chrome/Edge/Brave (MV3)

Mode A and Mode B on **any site**, from the browser — including DRM services
(Netflix, Prime Video, Disney+, Max, Hulu…) through everyone's own player and
own account. No capture of protected content, ever; the extension drives the
page's own `<video>` element, which is why DRM black-screens don't apply.

## What it does

- **Mode A (follow)**: connect the active tab to a room with the room code.
  The room's server-authoritative sync state is translated to the tab's main
  media element: play/pause, seek (deadband 400 ms, hard seek past 2 s), rate.
  Works on any page with a `<video>/<audio>`; known providers are badged.
  The content script runs in **every frame** (players usually live in an
  iframe), traverses open shadow roots, and re-detects on SPA route changes —
  YouTube and the streaming sites never reload. Each frame *claims*; the
  background elects exactly **one** driven frame per tab, so an ad slot or a
  muted hero loop can never steal the room's seeks.
- **Cast**: on sites with their own cast control (YouTube, YouTube Music,
  Spotify Connect) the extension presses **that** button for you, so casting
  happens inside the site's own licensed session. Where a site has no such
  control the button stays visible and says why — Playin never captures,
  mirrors or re-encodes protected video, which would black-frame anyway.
- **Mode B (share)**: captures the tab **with audio** via `chrome.tabCapture`
  (offscreen document) and fans it out as the room's mesh `share` track — the
  exact same `@playin/p2p` path the web app uses, so web/mobile viewers see it.
- **Guest identity**: connecting guest-joins as "Extension" (room-scoped, no
  account). Driving playback obeys the room's `playbackControl` policy like
  any guest (default `host` — the host drives; the extension follows).

## Build & load (dev)

```bash
pnpm install
pnpm --filter @playin/extension build     # → apps/extension/dist
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select
`apps/extension/dist`. Open the site you want to watch, click the Playin
toolbar icon, paste the room code (`XXXX-XXXX-XXXX`), Connect.

## Honest limits

- The extension targets the dev API (`http://localhost:4000`); the production
  API URL becomes a build-time constant when the deploy lands.
- Mode A follows the room; it never fights DRM players' own controls — rate
  changes are skipped when a player rejects `playbackRate`.
- MV3 kills the service worker when idle. The room lives in
  `chrome.storage.session` and is restored on wake, and a 30 s
  `chrome.alarms` keepalive revives the worker if nothing else does — so the
  worst case is a stale position for a few seconds, not a dead room.
- Frames in **closed** shadow roots are unreachable by design (no extension
  can pierce them), and a site that renders its player into a cross-origin
  frame we are not allowed to script stays undrivable.
- Pressing a site's cast button happens without user activation in the page,
  so a site that demands a real gesture for its cast prompt may ignore it.
  That surfaces as "nothing happened" — never as a capture fallback.
- Account-linked control (drive as a member, not a guest) lands with the
  externally-connectable handoff from the web app's settings page.
