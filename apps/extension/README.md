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
- Account-linked control (drive as a member, not a guest) lands with the
  externally-connectable handoff from the web app's settings page.
