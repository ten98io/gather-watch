# Elastic sync + extension-first architecture

Owner direction, 2026-08-16: stop fighting for frame-lock, let each viewer
play smoothly at a stable offset; move playback control onto the user's own
device via the browser extension and native apps; web becomes the interface.

This document records the design **and three places where the physics does
not agree with the intuition**, because building on the wrong assumption
would be expensive.

---

## Part 1 — Elastic sync — **SHIPPED**

### The problem this replaced

`packages/sync-core/src/drift.ts` was already a competent controller —
deadband, hysteresis, proportional rate-nudging, hard-seek escape. Its
*defaults* were the problem, not its design:

```
deadbandMs: 60      seekThresholdMs: 2000     rate clamp: 0.95–1.05
```

60ms is frame-lock. 2s hard-seek means any buffering hiccup triggers a seek —
and a seek is precisely what wrecks perceived quality (SoundCloud restarts
buffering; DRM players may renegotiate a licence and stall for seconds).

Those numbers still exist, but only as an explicitly-named preset,
`STRICT_SYNC`, for the one case they are right for: a single device driving
two of its own players. Nothing in a room uses it.

### The change, as built: an offset-aware controller

Drift used to be `expectedMs − actualMs` against the room's projected
position. It is now measured against a learned per-viewer anchor:

```
drift = (expectedMs − anchorOffsetMs) − actualMs
```

- `anchorOffsetMs` is **learned, not configured** (`anchorEnabled`,
  `anchorAdoptAfterMs` 3 s, `anchorStabilityMs` 400 ms). It is established
  when a track starts or after a buffering event: if the viewer settles at a
  stable lag, adopt it instead of fighting it.
- It decays slowly toward 0 while conditions are good — 20 ms/s for video,
  10 ms/s for music, so an 8 s anchor evaporates over ~6.7 minutes,
  imperceptibly — and is hard-capped at `anchorMaxMs` 15 s.
- Re-anchor on track change, host seek, tab wake, network recovery
  (`anchorRearmAfterMs` 8 s).

### Retuned bands

Bands follow the **playing item's media kind** (video vs music — rooms are
adaptive; there is no watch/listen room split). The two presets are
`WATCH_ELASTIC` and `LISTEN_ELASTIC`; the names are historical, they are
selected per item.

| Setting | Video (`WATCH_ELASTIC`) | Music (`LISTEN_ELASTIC`) | Why |
|---|---|---|---|
| deadband | 2000ms | 1500ms | below this, do nothing at all |
| release (hysteresis) | 500ms | 400ms | leaving the band is stickier than entering it |
| seek threshold | 12000ms | 8000ms | seek only when genuinely lost |
| rate clamp | 0.97–1.03 | 0.99–1.01 | see below |
| anchor decay | 20 ms/s | 10 ms/s | every ms music sheds is paid for in audible rate |

**Rate-nudging is much more audible in music than video.** A 5% rate change
shifts pitch by nearly a semitone — unacceptable while music plays, barely
noticed in dialogue. Music items therefore converge more slowly and rely
more on the anchor. Where the player rejects `playbackRate` (common on DRM
players — the extension's `mediaDriver` already try/catches it), the anchor
absorbs the difference and no correction is attempted at all.

Host **intent** events (play, pause, seek, track change) are never subject to
the comfort band — they apply immediately. The band governs *drift only*.

### Where the controller runs: all three clients, not just the extension

`DriftController`, the presets and `voiceActiveFrom` live in
`packages/sync-core` and are isomorphic on purpose. All three clients build the
same controller from the same presets:

| Client | Where |
|---|---|
| Web | `apps/web/lib/player/useSyncEngine.ts` — `profile === 'listen' ? LISTEN_ELASTIC : WATCH_ELASTIC`, `setVoiceActive` fed from `voiceActiveFrom(presence)` in `components/call/CallSurface.tsx` |
| Mobile | `apps/mobile/src/sync/useSyncEngine.ts` — the same two presets; `src/sync/voice.ts` wraps `voiceActiveFrom` |
| Extension | `apps/extension/src/driver.ts` — imports `DriftController` and all three presets from `@gather/sync-core`, wraps them in its own `ElasticDriver`, and keeps a local `voiceActiveFrom` because its presence rows are leaner than contracts' |

Only the *presence shape* is hand-copied; the *maths* is never duplicated. So
the elastic band and its voice tightening are a property of the room, not of the
extension — a web-only room and a mobile-only room get the same behaviour.

(`STRICT_SYNC` is exported and appears in the extension's `SYNC_PRESETS` map,
but nothing selects the `'strict'` profile: `profileForContent` returns only
`'watch'` or `'listen'`. It remains available, unused.)

### Consequence A: chat must be anchored to media time — **NOT BUILT**

Decision taken: messages and reactions carry the sender's playback position,
and render for you when **your** playback reaches that position. Spoilers
become structurally impossible and the offset stops being visible. Requires:
a `mediaPositionMs` field on chat messages, client-side hold-and-release
keyed on local position, and an "N messages ahead" affordance so nothing is
silently withheld. Text, reactions and emotes only.

**Status: none of it exists.** `grep -rn mediaPositionMs packages/contracts
services/api apps/web` is empty — `Message` carries no position, so there is
nothing for a client to hold on. It is on the backlog (HANDOFF). The server
half is the gate: without the field on the wire, the client behaviour cannot
even be prototyped honestly.

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

**Therefore the comfort band must be adaptive — and it is (SHIPPED):**

- **Nobody on mic** → full elasticity (up to the ~10s cap). Smoothness wins.
  (Chat is *not* yet anchored — see Consequence A — so this is the state where
  a spoiler can still reach you by text. That is a real gap, not a design
  choice.)
- **A call is live with people actually speaking** → converge tighter while
  voice is active, using rate-nudging only, never seeks. The controller carries
  a `voiceActive` input and blends toward the tight band rather than switching
  (`blend` in `packages/sync-core/src/drift.ts`), so the transition itself is
  not audible. Reactions in a live call are inherently real-time; the content
  has to be close enough for them to make sense.
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

`PlaybackDriver` is **defined, but not yet shared**: it lives in
`apps/extension/src/driver.ts` (with the elastic corrector beside it), not in
`packages/contracts` or a `packages/playback`. So the interface exists and the
extension implements it; web and mobile satisfy the same shape by hand. Lifting
it into a package is the honest completion of this section and has not
happened. The three implementations:

1. **Web adapters** (existing YouTube/HLS/SoundCloud/Vimeo/native) — for
   content the web can play directly. Keeps a room link working instantly
   with no install. (Slated for deletion once the extension is verified as
   the driver in a real room — `docs/WEB_SLIMMING.md` steps 4–5.)
2. **Extension content script** — generalised `findMainMedia` for arbitrary
   sites, plus per-site adapters where the generic path is insufficient.
3. **Mobile native** — AVPlayer / ExoPlayer / WebView behind the same
   interface.

Then "which surface drives playback" is a runtime decision per item, not an
architectural fork. Web-minimal becomes a *default*, not a rewrite, and the
first-run funnel survives.

### Moving to the next item is a claim, not a seat

Once several surfaces can drive, "who advances the queue when an item ends?"
looks like it wants an elected device. It does not, and the election that was
built for it has been deleted.

Any client that *sees* an item end sends `sync.advance { endedItemId }` — a
statement of fact about its own playback, not a destination. It is **ungated**:
no role check, no seat. The server compare-and-sets it
(`services/api/src/modules/sync/service.ts`): it moves the room only while the
room is still on that exact item, and only to that item's successor as the
*server* sees the queue, so a remove or a reorder cannot be raced into a skip. A
room with a laptop and a phone in it produces two reports and one move. Each
client resolves the id the same way — `apps/web/lib/player/advance.ts`,
`apps/mobile/src/sync/advance.ts`, `apps/extension/src/advance.ts`, three
hand-mirrored copies of the same rule — and returns null rather than guessing
when it cannot name the item honestly.

The guard against abuse is plausibility, not authorization, and it is only as
strong as the item's metadata: with a known `durationMs` the room's own media
clock must have reached the end (a real verification, priced at the item's
remaining runtime), and with `durationMs === null` — the common case for
YouTube rows — it degrades to a 20 s floor, which prices a skip rather than
refusing it. Fail-open is deliberate: a false refuse strands the whole room on a
finished item, silently. See HANDOFF open item 4.

### Extension gaps (historical — RESOLVED except the last)

Found by inspection 2026-08-16; kept as the record of what had to be true
before the extension could be the primary driver. All verified fixed in the
tree (2026-08-17) except item 6:

1. ~~`all_frames: false`~~ — now `true`, with frame election
   (`frameElection.ts`).
2. ~~No web↔extension channel~~ — `background.ts` handles
   `onMessageExternal`/`onConnectExternal` (`external.ts` protocol), with a
   documented threat model; the content script announces the extension id on
   Gather origins so the web needs no configuration.
3. ~~Reconnect leaks~~ — the drive timer is a single tracked handle, cleared
   before re-arm.
4. ~~MV3 service-worker death~~ — session state mirrors into
   `chrome.storage.session`; alarms keep-alive re-arms the drive timer.
5. ~~No Shadow DOM traversal / SPA handling~~ — shadow-root traversal in
   `content.ts`, SPA navigation watch in `spaWatch.ts`.
6. **Still open:** the provider registry is written down **three** times —
   `apps/web/lib/providers.ts`, `apps/extension/src/providers.ts`, and the
   `embed` provider enum in `packages/contracts/src/entities.ts`. The two
   registries have since converged on the same 17 ids plus a `generic`
   fallback and the same `capability` vocabulary (`full-sync | approximate |
   extension | generic`); the extension's is the superset, carrying host
   regexes, DRM flags, cast descriptors and a derived `tier`
   (`api | drm | generic`, from `tierFor()`). So the *vocabularies* no longer
   diverge — the duplication does, and adding a service still means editing
   more than one place. Unification is `docs/WEB_SLIMMING.md` step 5, gated
   with the deletions.

---

## Part 3 — Casting, honestly

> Owner: *"cast any media, any input and any output is the philosophy"* and
> *"share my screen actually just starts Mode B, not casting."*

The second point is correct and was a naming bug: **Share screen** starts a
Mode B re-stream *to room members*. It has nothing to do with sending video
to a TV. The copy now says so — the dialog is titled "Share your screen with
the room" (`apps/web/components/stage/ScreenShareStage.tsx`) — and casting is
a separate, always-visible control. Getting a share onto an actual TV is
`docs/CAST_RELAY.md`, and it is a different mechanism entirely.

The first point runs into a hard limit that no amount of engineering removes:

- **Chromecast/AirPlay receive a URL** (or a mirrored tab). They work for a
  direct MP4/HLS source — a real URL a receiver can fetch on its own — which
  is why the current buttons appear only for real `<video>` elements and
  silently vanish for YouTube, embeds and DRM.
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

UI fix (shipped 2026-08-17): the cast control is always visible, with a
plain-language reason when it cannot act ("YouTube casts from its own
player", "Protected content can't be cast from here"), instead of silently
disappearing. The share-on-TV design lives in `docs/CAST_RELAY.md`.
