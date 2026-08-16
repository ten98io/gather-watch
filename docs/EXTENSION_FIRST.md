# Elastic sync + extension-first architecture

Owner direction, 2026-08-16: stop fighting for frame-lock, let each viewer
play smoothly at a stable offset; move playback control onto the user's own
device via the browser extension and native apps; web becomes the interface.

This document records the design **and three places where the physics does
not agree with the intuition**, because building on the wrong assumption
would be expensive.

---

## Part 1 — Elastic sync

### What already exists

`packages/sync-core/src/drift.ts` is a competent controller: deadband,
hysteresis, proportional rate-nudging, hard-seek escape. Its defaults are the
problem, not its design:

```
deadbandMs: 60      seekThresholdMs: 2000     rate clamp: 0.95–1.05
```

60ms is frame-lock. 2s hard-seek means any buffering hiccup triggers a seek —
and a seek is precisely what wrecks perceived quality (SoundCloud restarts
buffering; DRM players may renegotiate a licence and stall for seconds).

### The change: an offset-aware controller

Drift is currently `expectedMs − actualMs` against the room's projected
position. Add a learned per-viewer anchor:

```
drift = (expectedMs − anchorOffsetMs) − actualMs
```

- `anchorOffsetMs` is **learned, not configured**. It is established when a
  track starts or after a buffering event: if the viewer settles at a stable
  lag, adopt it instead of fighting it.
- It decays slowly toward 0 while conditions are good (so a viewer who fell
  behind on a bad connection quietly catches up over minutes, imperceptibly),
  and is hard-capped (≈15s).
- Re-anchor on: track change, host seek, tab wake, network recovery.

### Retuned bands

| Setting | Watch | Listen | Why |
|---|---|---|---|
| deadband | 2000ms | 1500ms | below this, do nothing at all |
| seek threshold | 12000ms | 8000ms | seek only when genuinely lost |
| rate clamp | 0.97–1.03 | 0.99–1.01 | see below |

**Rate-nudging is much more audible in music than video.** A 5% rate change
shifts pitch by nearly a semitone — unacceptable in a listening room, barely
noticed in dialogue. Listen rooms therefore converge more slowly and rely
more on the anchor. Where the player rejects `playbackRate` (common on DRM
players — the extension's `mediaDriver` already try/catches it), the anchor
absorbs the difference and no correction is attempted at all.

Host **intent** events (play, pause, seek, track change) are never subject to
the comfort band — they apply immediately. The band governs *drift only*.

### Consequence A: chat must be anchored to media time

Decision taken: messages and reactions carry the sender's playback position,
and render for you when **your** playback reaches that position. Spoilers
become structurally impossible and the offset stops being visible. Requires:
a `mediaPositionMs` field on chat messages, client-side hold-and-release
keyed on local position, and an "N messages ahead" affordance so nothing is
silently withheld. Text, reactions and emotes only.

### Consequence B — THE CORRECTION: live call audio does not share the content's path

> Owner's assumption: *"the audio and video chat would also have a consistent
> delay as the content playback as the data takes the same path as the
> content."*

It does not, and this matters.

The content **never traverses the room**. Each viewer streams it from their
own source — YouTube's CDN, Netflix's CDN, a local file — which is exactly
what makes DRM sharing legal. The call is WebRTC between peers, ~50–150ms.
So the two paths are entirely independent: the call is effectively real-time
while viewers may be 8s apart in the content.

That means **live voice is the one spoiler vector media-anchored chat cannot
close.** If A is 8 seconds ahead and gasps, B hears the gasp 8 seconds early.

Delaying incoming call audio to re-align it does not rescue this: a
conversation with several seconds of one-way delay is not a conversation —
people talk over each other continuously. Anything past roughly 400ms
round-trip degrades turn-taking badly.

**Therefore the comfort band must be adaptive:**

- **Nobody on mic** → full elasticity (up to the ~10s cap). Smoothness wins;
  chat is anchored, so nothing spoils.
- **A call is live with people actually speaking** → converge tighter
  (target ≤1s) while voice is active, using rate-nudging only, never seeks.
  Reactions in a live call are inherently real-time; the content has to be
  close enough for them to make sense.
- Show this honestly in the UI as a room state ("Talking — staying in step"),
  not as a technical readout.

This is a genuine trade-off, not a bug: **you can have loose sync, or live
voice reactions, but not both at once.** Making the band follow mic activity
gets both, at different moments.

---

## Part 2 — Extension-first

### The goal

All heavy lifting — detection, playback control, media manipulation — runs on
the user's device through the extension (desktop) or native APIs (mobile).
The web app is the interface: content view, chat, call, queue.

### THE CORRECTION: where does the content actually render?

An extension can drive a player on *any* site, but it cannot move that video
into the Gather tab. Netflix, Disney+ and most large sites refuse to be
iframed (`X-Frame-Options`/CSP), and DRM playback is bound to its own origin.
So "the web is where they see the content" and "the extension drives any
site" cannot both be true in one tab. Three viable models:

| Model | How it looks | Works for DRM? |
|---|---|---|
| **A. Gather tab embeds the content** | today's web app | No — only embeddable sources |
| **B. Companion tab** | content in its own tab, Gather in another | Yes, but split attention |
| **C. Overlay (Teleparty model)** | extension injects Gather's chat/call/queue UI **into the content site's page** | **Yes** |

**Recommendation: C, with A retained.** The extension injects the room UI as
an overlay on whatever site the user is watching; the Gather web app remains
the room's home for browsing, queueing, and content it can play natively.
This is the only model where "watch Netflix together with chat and voice"
is a single-window experience, and it is what "browse-here-like" implies.

### One contract, three implementations

Define `PlaybackDriver` once (in `packages/contracts` or a new
`packages/playback`), implemented by:

1. **Web adapters** (existing YouTube/HLS/SoundCloud/Vimeo/native) — for
   content the web can play directly. Keeps a room link working instantly
   with no install.
2. **Extension content script** — generalised `findMainMedia` for arbitrary
   sites, plus per-site adapters where the generic path is insufficient.
3. **Mobile native** — AVPlayer / ExoPlayer / WebView behind the same
   interface.

Then "which surface drives playback" is a runtime decision per item, not an
architectural fork. Web-minimal becomes a *default*, not a rewrite, and the
first-run funnel survives.

### Extension gaps that block this today

Found by inspection this session — all must be fixed before the extension can
be the primary driver:

1. **`all_frames: false`** (`manifest.json:14`) — players inside iframes are
   invisible to the content script. This alone blocks a large share of sites.
2. **No web↔extension channel.** `externally_connectable` is declared but
   there is **no `onMessageExternal`/`onConnectExternal` listener anywhere**,
   and the web app contains no `chrome.runtime` code. The extension currently
   reaches rooms only by independently guest-joining. A real handoff (web
   hands the room + token to the extension, extension reports capability and
   telemetry back) is the missing keystone.
3. **Reconnect leaks** — `background.ts` calls `setInterval(driveTab, 1000)`
   per connect and never clears it; reconnects stack intervals.
4. **MV3 service-worker death** — session state is in-memory only; needs
   `chrome.storage.session` + alarms to survive worker termination.
5. **No Shadow DOM traversal, no SPA-navigation handling** (YouTube never
   reloads), no MSE/HLS-level detection.
6. Two divergent provider registries (web `capability` tiers vs extension
   `api|drm|generic` tiers) plus the contracts embed enum — adding a service
   means editing three places. Unify.

---

## Part 3 — Casting, honestly

> Owner: *"cast any media, any input and any output is the philosophy"* and
> *"share my screen actually just starts Mode B, not casting."*

The second point is correct and is a naming bug: **Share screen** starts a
Mode B re-stream *to room members*. It has nothing to do with sending video
to a TV. It will be renamed so it reads as share-to-room.

The first point runs into a hard limit that no amount of engineering removes:

- **Chromecast/AirPlay receive a URL** (or a mirrored tab). They work for
  direct MP4/HLS and for your own uploads — which is why the current buttons
  appear only for real `<video>` elements and silently vanish for YouTube,
  embeds and DRM.
- **DRM content cannot be cast by a third party.** Widevine/FairPlay licences
  are bound to the playback session; output protection blacks out mirrored or
  captured protected surfaces by design. This is the same wall as Mode B.
- **What *is* achievable**: on sites that have their own cast button
  (YouTube, Netflix, Spotify), the extension can *click that button on the
  user's behalf*. Casting then happens inside the site's own DRM-legal path.
  That is the realistic route to "cast anything", and it is per-site work.

So the honest philosophy is: **any input, any output — through the platform's
own sanctioned path.** Gather orchestrates; it never re-encodes or proxies
protected media.

Interim UI fix (independent of the pivot): show the cast control always, with
a plain-language reason when it cannot act ("YouTube casts from its own
player", "Protected content can't be cast from here"), instead of silently
disappearing.
