# @gather/extension — Gather for Chrome/Edge/Brave (MV3)

Mode A and Mode B on **any site**, from the browser — including DRM services
(Netflix, Prime Video, Disney+, Max, Hulu…) through everyone's own player and
own account. No capture of protected content, ever; the extension drives the
page's own `<video>` element, which is why DRM black-screens don't apply.

## What it does

- **Mode A (follow)**: connect the active tab to a room. The room's
  server-authoritative sync state is translated to the tab's main media
  element: play/pause, seek, rate — through the elastic controller in
  `src/driver.ts`, which implements the `PlaybackDriver` interface and applies
  the same learned-anchor bands as `@gather/sync-core` rather than
  frame-locking. Works on any page with a `<video>/<audio>`; known providers
  are badged, and the **generic** driver handles everything else, which is what
  makes a `{ kind: 'page' }` queue item playable at all.
  The content script runs in **every frame** (players usually live in an
  iframe), traverses open shadow roots, and re-detects on SPA route changes —
  YouTube and the streaming sites never reload. Each frame *claims*; the
  background elects exactly **one** driven frame per tab (`frameElection.ts`),
  so an ad slot or a muted hero loop can never steal the room's seeks.
- **Local intent capture**: your hand on the site's own player speaks for you.
  A pause you press on Netflix is read as room intent and published, rather
  than being fought by the next drive tick. The web app defers to the
  extension whenever it is present.
- **In-page overlay** (`src/overlay/`): the room's chat and people list
  injected into the content site's page, in a shadow root with the design
  tokens emitted from `@gather/design`. This is the "Model C" of
  `docs/EXTENSION_FIRST.md` — the only shape in which "watch Netflix together
  with chat" is a single-window experience.
- **Cast**: on sites with their own cast control (YouTube, YouTube Music,
  Spotify Connect) the extension presses **that** button for you, so casting
  happens inside the site's own licensed session. Where a site has no such
  control the button stays visible and says why — Gather never captures,
  mirrors or re-encodes protected video, which would black-frame anyway.
- **Mode B (share)**: captures **a tab, a window or a whole screen**, with
  audio, and fans it out as the room's mesh `share` (+ `share-audio`) track —
  the exact same `@gather/p2p` path the web app uses, so web and mobile viewers
  see it. A tab uses `chrome.tabCapture.getMediaStreamId`; a window or screen
  uses `chrome.desktopCapture.chooseDesktopMedia`. Either way the stream id is
  handed to the **offscreen document**, the only extension context allowed to
  call `getUserMedia` — the service worker never touches a `MediaStream`. The
  offscreen document also fetches its own TURN credentials from
  `GET /rtc/turn-credentials`.
  It builds its mesh in the **`share` lane** (`@gather/p2p`'s `MeshLane`),
  which is not optional: the sharer is in the room *twice* — their web tab
  holds the call, this document holds the capture, and both authenticate as
  the same user. A pair's `connectionId` is derived from both endpoint names
  with no round trip, so two unlaned meshes for one identity compute the
  **same** id and a viewer answers whichever spoke first: half the time you
  got the call with no picture, the other half the share with no voice. The
  lane is folded into the id, and an auxiliary mesh also builds no DataChannel
  fabric — the call keeps this person's sync, file and emote channels.
- **Identity**: two ways in, and they are not equivalent.
  1. **Popup guest join** with an invite code — room-scoped, no account, joins
     as "Extension". Driving playback obeys the room's `playbackControl` policy
     like any guest (default `host` — the host drives; the extension follows).
  2. **Handoff from the web app** over the externally-connectable channel
     (`src/external.ts`) — the web app passes the room id and a room-scoped
     access token, and the extension drives **as the signed-in member**, with
     that member's role. This is the normal path when you are already in the
     room on gather.watch.

## Build & load

> **There are two builds, and only one of them works for anybody else.**
> MV3 bundles cannot read env at runtime, so the API origin is **inlined at
> build time**. An artifact built without one points at `localhost:4000`: it
> installs cleanly, the web app finds it and reports "extension connected",
> and then every call it makes goes to a port on the builder's own machine.
> That artifact has been shipped once. Everything below exists so it cannot
> be again.

### The one that goes into a real browser

```bash
GATHER_API_URL=https://<api-domain> \
  GATHER_WEB_ORIGINS=https://gather.watch,https://www.gather.watch \
  pnpm --filter ./apps/extension build:prod
```

`build:prod` has **no default origin to fall back on**. It refuses to run
without `GATHER_API_URL`, refuses a loopback host, refuses a non-https one,
and refuses a web origin the manifest does not admit — before it emits a
single byte. The message names the fix each time.

Then Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
select `apps/extension/dist`. Open the site you want to watch, click the
Gather toolbar icon, paste the room code (`XXXX-XXXX-XXXX`), Connect. Or just
open the room on gather.watch in another tab and let the handoff do it.

### The dev one

```bash
pnpm install
pnpm --filter ./apps/extension build           # → apps/extension/dist
```

Still needs no configuration, still points at `http://localhost:4000`, and now
**says so three times** — you cannot mistake one artifact for the other:

- the build prints a `DEV BUILD` banner naming the baked-in origin;
- `dist/BUILD.txt` records mode, origin, allowlist and timestamp;
- the extension calls itself **“Gather — Watch Together (DEV)”** in
  `chrome://extensions`, and its `version_name` carries the origin.

### What gets inlined

Both defines live in `tsup.config.ts`, resolved by `src/buildTarget.ts` and
read by `src/config.ts`:

- `GATHER_API_URL` — the API origin *and*, derived from it, the room
  WebSocket URL and the single origin a room token may ever be sent to.
- `GATHER_WEB_ORIGINS` — the web origins allowed to drive this extension.
  Unset falls back to `DEFAULT_WEB_ORIGINS` (localhost:3000, 127.0.0.1:3000,
  gather.watch, www., app.). **It must stay a subset of
  `externally_connectable.matches` in `public/manifest.json`** — the manifest
  is the browser-level gate, this list is the second, in-code gate that every
  message and every port connect is re-checked against, and a manifest edit
  alone can never widen the real allowlist. The build now **checks that subset
  relation for you** and fails with the offending origin named.

`apps/extension/turbo.json` declares all three variables as build inputs, so
turbo can never replay a cached dev bundle for a production build — a cache
hit that would ship as an outage.

Chrome 137+ ignores `--load-extension`, so there is no automated install path
into a real profile — by Chrome's design, not an oversight.

## Permissions, and why each one

`tabCapture` + `desktopCapture` + `offscreen` (Mode B), `storage` (session
state survives service-worker death), `activeTab` + `scripting` (drive the tab
you are on), `alarms` (keepalive), `host_permissions: <all_urls>` (the content
script has to reach any site you might watch on). No `cookies` permission — the
extension never reads one.

## Honest limits

- Mode A follows the room; it never fights DRM players' own controls — rate
  changes are skipped when a player rejects `playbackRate`, and the learned
  anchor absorbs the difference instead.
- MV3 kills the service worker when idle. The room lives in
  `chrome.storage.session` (TRUSTED_CONTEXTS-only, so no content script can
  read the token) and is restored on wake, and a 30 s `chrome.alarms` keepalive
  revives the worker if nothing else does — so the worst case is a stale
  position for a few seconds, not a dead room.
- Frames in **closed** shadow roots are unreachable by design (no extension
  can pierce them), and a site that renders its player into a cross-origin
  frame we are not allowed to script stays undrivable.
- Pressing a site's cast button happens without user activation in the page,
  so a site that demands a real gesture for its cast prompt may ignore it.
  That surfaces as "nothing happened" — never as a capture fallback.
- **No voice yet.** The extension carries the room's chat and playback, not
  the call. Mic in the overlay (offscreen `getUserMedia`, reusing the
  screen-share plumbing) is backlog.

## Security boundary

`src/external.ts` carries the full threat model for the web↔extension channel
in its header — read it before touching that file. The short version: only
browser-populated fields (`sender.origin`, `sender.tab.id`) are trusted, every
message re-checks the origin (never once per port), `apiOrigin` is
checked-and-discarded so a token can never be redirected, no message type takes
a URL to fetch, and no response ever contains a token, a cookie or a raw
hostname.
