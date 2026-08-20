# @gather/extension — Gather for Chrome/Edge/Brave (MV3)

Mode A and Mode B on **any site**, from the browser — including DRM services
(Netflix, Prime Video, Disney+, Max, Hulu…) through everyone's own player and
own account. No capture of protected content, ever; the extension drives the
page's own `<video>` element, which is why DRM black-screens don't apply.

## What it does

- **Mode A (follow)**: connect the active tab to a room. The room's
  server-authoritative sync state is translated to the tab's main media
  element: play/pause, seek, rate — through the elastic controller in
  `src/driver.ts` (`ElasticDriver`), which applies the same learned-anchor
  bands as `@gather/sync-core` rather than frame-locking. That controller is
  **not** an implementation of the `PlaybackDriver` interface declared beside
  it: `ElasticDriver` exposes `tick`/`reset`/`state`/`setProfile`, and nothing
  in this repo says `implements PlaybackDriver`. Of the interface's members,
  `load()` stays deliberately unimplemented — the user navigates to their own
  copy, and Gather never navigates anybody's browser to paid content — while
  `setMuted`/`isMuted`/`setVolume` **are** implemented, through the overlay's
  audio lever (per-viewer LOCAL, guarded element writes; see the overlay
  bullet below). Read the interface as a target, as `docs/EXTENSION_FIRST.md`
  Part 2 already does. Works on any page with a `<video>/<audio>`; known providers
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
- **It moves the queue on by itself.** When the driven item ends, the worker
  sends `sync.advance { endedItemId }` on its own socket — it does not relay
  through a Gather tab, because a user who joined from the **popup** has no
  Gather tab and the room used to stall on the finished item. The intent names
  an item, never a destination: the server compare-and-sets it against the room
  and moves only to that item's successor as the server sees the queue.
  `src/advance.ts` resolves the id by media identity, not by raw
  `playback.queueIndex` (a remove or a reorder leaves that index naming a
  different row), and returns null rather than guessing — a wrong id would not
  merely fail, it would skip an item nobody skipped. It is a hand-kept mirror
  of `apps/web/lib/player/advance.ts` and `apps/mobile/src/sync/advance.ts`;
  keep the three in step.
- **In-page overlay** (`src/overlay/`): the room's chat, its people list, what
  is playing and what is up next — plus a **Skip** for a member the room's
  `playbackControl` policy admits, which sends the same `sync.advance` the
  worker sends when an item runs out, and a **volume lever** (mute toggle +
  slider in the now-playing block). Volume is per-viewer LOCAL state: the ask
  rides overlay → worker → elected frame → guarded element writes, the
  element's own telemetry settles the slider, and nothing about it ever
  crosses the room socket or the external event port. Injected into the content site's page in
  a closed shadow root, with the design tokens emitted from `@gather/design`.
  `docs/EXTENSION_FIRST.md` calls this "Model C" and defines it as injecting
  Gather's **chat/call/queue** UI: three of those four are here, **the call is
  not** (see *Honest limits* — there is no voice in the extension yet).
- **Find it where you are**: a member whose region can't play the queued item
  where it was queued gets a popup button that asks **their own default search
  engine** for the current item's title (`chrome.search.query`, new tab, on
  the click's own gesture); the user picks whichever site their region has,
  and the extension adopts that tab and syncs their copy from there. Gather
  never navigates for anyone and never proxies content — the user's engine,
  the user's pick, the user's own account on the site they land on.
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
  The share is a **conversation with the room**, not an announcement. The
  document asks for the roster on **every open** —
  `presence.update { state: 'watching', wantSnapshot: true }` — because the
  server volunteers one only to a presence entry it just created, and this
  person's already exists (their web tab made it, or the worker's 15 s beat
  did); without the ask no roster came back, `syncPeers` ran on an empty set,
  the mesh offered to nobody, and every extension share was a black stage for
  the whole room while the popup said it was sharing. It then reads the room's
  **answer** to `restream.start`: a refusal (`FORBIDDEN`, `ROOM_POLICY`,
  `QUOTA_EXCEEDED`, `CONFLICT`) stops the capture and hands the sharer the
  room's own sentence, and a `restream.state` that moves off this capture — a
  moderator's stop, a handoff — stops it too. `sharing: true` is claimed only
  once the room says the stage is ours, so this document is never its own
  exemption from the room's `maxPublishers` ceiling. Its audio is negotiated as
  **stereo Opus** at 128 kbps (`preferStereoOpus` munges the audio m-line, and
  only that one); Opus with no `fmtp` at all is the speech default — one
  channel, ~32 kbps — which is the difference between hearing the film and
  hearing that a film is playing.
- **One person, one share.** A room's stage names one host, and the server lets
  that host replace their own share without a word — so a second capture under
  the same user id collides with the first on the same lane and the room sees
  one of the two at random. Starting a share while this extension is already
  capturing, or while the room's stage already names you (your web tab is
  sharing), is refused **before the picker opens**.
- **Identity**: two ways in, and they are not equivalent.
  1. **Popup guest join** with an invite code — room-scoped, no account, joins
     as "Extension". Driving playback obeys the room's `playbackControl` policy
     like any guest (default `host` — the host drives; the extension follows).
     A password-protected room takes its password in the same card; unknown
     code, missing password and wrong password all come back as the same
     "Invite code not found — or the password is wrong." because the server
     deliberately prices probes as missing invites.
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
pnpm --filter ./apps/extension build:prod
```

That is the whole command: **the live deployment is the prod default**
(owner decision, 2026-08-20 — gather.watch is deployed and canonical, so
the defaults are `https://api.gather.watch` and the gather.watch web
origins, inlined and printed in the banner and `BUILD.txt`). For any OTHER
deployment, `GATHER_API_URL` / `GATHER_WEB_ORIGINS` override the defaults —
and whatever the origin came from, `build:prod` still refuses a loopback
host, a non-https one, and a web origin the manifest does not admit, before
it emits a single byte. The old defect cannot recur through this default:
that artifact came from the DEV script, silently, and worked for one
machine — this one is checked, labeled, and works for everyone.

Then Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
select `apps/extension/dist`. Open the site you want to watch, click the
Gather toolbar icon, paste the room code (`XXXX-XXXX-XXXX`), Connect —
Chrome will offer to let Gather stay on that site (say yes once and the site
keeps working across visits; decline and this tab still works until it
navigates away). Or just open the room on gather.watch in another tab and
let the handoff do it — then click the Gather icon on the content tab the
first time you use a new site, so the extension may reach it.

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

**The install grants no host access beyond Gather's own API origin**
(FEATURE_PLAN 3.2 — narrowed before any store submission). The build stamps
exactly ONE host permission, the baked-in API origin (`stampManifest` in
`src/buildTarget.ts`): an extension bypasses CORS only for origins it holds,
and with zero host access every worker call to the API — join, members,
room, events — died in preflight as "Failed to fetch", in the real browser
only, because the suite fakes fetch. `permissions`: `tabCapture` +
`desktopCapture` + `offscreen` (Mode B), `storage` (session state survives
service-worker death), `activeTab` + `scripting` (reach the tab you are on),
`alarms` (keepalive), `search` (the "find it where you are" button asks the
user's own default engine for the current item's title — never a
Gather-chosen destination). `optional_host_permissions: ["<all_urls>"]` —
every SITE is a runtime grant the user makes, never an install-time demand.
No `cookies` permission — the extension never reads one.

Content pages are reached three ways, in order of durability:

1. **Granted sites.** The worker keeps ONE dynamically registered content
   script (`gather-driver`, `src/siteAccess.ts` + `syncRegisteredScripts` in
   `background.ts`) whose matches equal the granted origins. Registered
   scripts behave exactly like the old declarative entry on those origins —
   every new document, every new frame (`allFrames`), about:blank/srcdoc
   player frames included (`matchOriginAsFallback`, the modern spelling of
   `match_about_blank`) — which is what preserves "the player iframe can
   appear at any time".
2. **This tab, right now.** Opening the popup IS the activeTab grant for that
   tab; Connect injects `content.js` into it. Two limits, accepted: activeTab
   does not reach cross-origin iframes on an ungranted page, and it dies on a
   cross-origin navigation. The popup's "Keep Gather on this site" is the
   durable fix.
3. **Everything at once.** "Allow all supported sites" in the popup requests
   the provider registry's `grantPatterns` (one Chrome dialog for the named
   streaming sites).

The one DECLARATIVE content script left covers exactly the five Gather web
origins — that is the extension-id announce the web app's detection relies
on, and the build fails if the manifest ever misses one of them. The build
also refuses to emit a manifest with missing icon files or a placeholder
version (`manifestShipErrors` in `src/buildTarget.ts`).

## Honest limits

- Mode A follows the room; it never fights DRM players' own controls — rate
  changes are skipped when a player rejects `playbackRate`, and the learned
  anchor absorbs the difference instead.
- MV3 kills the service worker when idle. The room lives in
  `chrome.storage.session` (TRUSTED_CONTEXTS-only, so no content script can
  read the token) and is restored on wake, and a 30 s `chrome.alarms` keepalive
  (`periodInMinutes: 0.5`) revives the worker if nothing else does — so the
  worst case is a stale position for a few seconds, not a dead room.
  A revived worker also **asks** for the room again rather than waiting to be
  told: it sends `presence.update { state: 'watching', wantSnapshot: true }` on
  the resumed path, the same door the web client uses after a refresh. Without
  that ask it beat into a presence entry that was still alive, no snapshot came
  back, and the worker held an unknown queue — which meant `sync.advance` (it
  names the item that ended) returned null rather than guessing, so an item
  finishing in that window was silently never reported.
- Frames in **closed** shadow roots are unreachable by design (no extension
  can pierce them), and a site that renders its player into a cross-origin
  frame we are not allowed to script stays undrivable.
- **What a tab is comes from the tab's URL, not from what a page told us.**
  `providerForUrl` is a pure classifier and `chrome.tabs.get` answers at any
  time, so the worker re-derives a tab's provider whenever it does not have
  one. The alternative shipped: the map was written only by a content script's
  report, MV3 recycled the worker every ~30s of quiet, and every already-open
  tab then read as *unclassified* — which is not "generic", because the DRM
  capture refusal is `if (provider is known && protected) refuse` and absent
  skipped it. "Share this tab" on Netflix started a capture and the room got a
  black rectangle with no explanation.
- Pressing a site's cast button happens without user activation in the page,
  so a site that demands a real gesture for its cast prompt may ignore it.
  That surfaces as "nothing happened" — never as a capture fallback.
- **The cast selectors are data** (`providers.ts`), so a reskinned site
  outdates them; that is the normal end of a selector's life, not an
  exceptional case. A miss says so in the popup and the sentence **stays** until
  the next press — the popup re-polls every 2 s, and a site Gather *can* cast
  from has no standing reason of its own, so a blanked slot read as a button
  that does nothing at all. When finding the button meant opening the site's
  own overflow menu, the same toggle closes it again rather than leaving it
  hanging open over the video.
- **An ad in the driven element is left alone — and a rare stall is the
  price.** A source whose duration is ≤2 minutes while the room's own clock
  is far past it is treated as not being the room's item
  (`isInterstitialSource`, `src/driver.ts`): it is not driven, its 'ended'
  never becomes `sync.advance` (one viewer's preroll must not skip the film
  for the whole room), and its duration never fills the room's fill-once
  duration row. The accepted trade: a SHORT genuine item in a room whose
  projection ran far past its end (stranded overnight on a finished clip)
  is also vetoed — recovery there is the overlay's Skip or a host seek.
- **A pause the page performs reads as your hand.** An ad SDK that pauses
  the content element to run an overlay ad (the standard IMA pattern) is
  indistinguishable from the user pressing pause, so the room pauses too —
  and resumes when the page resumes. Arguably the right group behavior
  (the room waits for the ad viewer); recorded here because no honest
  discriminator exists.
- **A per-site grant reaches frames on THAT site.** Registered content
  scripts match each frame's own URL, so granting a generic page does not
  reach a player iframe served from another origin. "Allow all supported
  sites" covers the known embed providers (a YouTube iframe on a blog is
  reachable once youtube.com is granted); an arbitrary third-party embed on
  an arbitrary page is not, until a frame-aware grant lands.
- **The popup's grant offer describes the tab it opened over.** The pattern
  list is computed at popup open (the permission ask must run synchronously
  inside the click), so a tab navigated to a different origin under an open
  popup can be offered the previous site. Grants are visible and revocable
  in Chrome's own UI; reopen the popup to re-read the tab.
- **No voice yet.** The extension carries the room's chat, its queue and its
  playback — not the call. Mic in the overlay (offscreen `getUserMedia`,
  reusing the screen-share plumbing) is backlog. Nothing in the overlay, the
  README or `src/overlay/mount.ts`'s header may describe Model C as delivered
  whole until it is.

## Security boundary

`src/external.ts` carries the full threat model for the web↔extension channel
in its header — read it before touching that file. The short version: only
browser-populated fields (`sender.origin`, `sender.tab.id`) are trusted, every
message re-checks the origin (never once per port), `apiOrigin` is
checked-and-discarded so a token can never be redirected, no message type takes
a URL to fetch, and no response ever contains a token, a cookie or a raw
hostname.
