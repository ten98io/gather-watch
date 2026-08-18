# Gather — Cast relay: the screen share on TVs (decided 2026-08-17)

Doctrine (owner, 2026-08-17, binding): **client-side wherever possible.** The
user's own devices do the computing; a server enters the media path only where
no client-side mechanism exists at all, and then only when verified arithmetic
justifies it. "Defer" and "cut" are legitimate verdicts below, and one of them
is used.

Scope: this doc decides how the host's **screen share** — internally "Mode B",
one member's tab/screen re-streamed to the room over the mesh — becomes
watchable on a TV. Everything else already has its answer: an item that is a
**real fetchable URL** (a direct `{ kind: 'url' }` or `{ kind: 'hls' }`
MediaRef) casts device-native today, because the page has a real
`HTMLMediaElement` for the picker to act on — Default Media Receiver /
AirPlay via `apps/web/lib/cast.ts`. Synced-source provider content ("Mode A")
casts through the site's own button, which the extension clicks. Provider/DRM
relay is permanently out of scope (ToS + output protection;
docs/EXTENSION_FIRST.md Part 3).

There is no "library" anywhere in this product — nobody uploads a stream and
nothing transcodes. Wherever an older draft said "library items", read "items
with a real URL".

Costs below are operator costs, not prices. Gather has one tier: there is no
plan to buy, so nothing here gates a feature behind payment.

Every external claim was verified against official pages on 2026-08-16/17 and
carries its source. Unpublished figures are marked as such. Do not promote an
assumption to a rate, or an absence to a seconds figure.

## Verdicts

| Path | Verdict | One line |
|---|---|---|
| Chromecast: receiver page joins the room as a WebRTC viewer | **Build** (primary) | No server in the media path; the TV is one more peer |
| AirPlay: per-platform mirroring hint | **Build** (it is copy) — **not written yet** | Mirroring is OS-owned with no API for anyone; guidance is the entire client-side surface |
| AirPlay: server-minted HLS via Cloudflare Stream Live | **Defer** | Requires an always-on transcoder for a multi-second experience mirroring already gives free |
| Native iOS `AVRoutePickerView` | Roadmap | The durable AirPlay fix lives there, not in the web ceiling |

---

## 1. Chromecast — the TV is a room participant

The design: a stripped, view-only gather.watch route runs **on the
Chromecast**, joins the room over WebRTC exactly like any viewer, and plays
the share. No relay, no transcode, no server in the media path, sub-second
like every other peer, nothing new for elastic sync to handle — the TV is
just a viewer that cannot fall behind on purpose.

### Delivery mechanism: CAF custom receiver, not the Presentation API

Two candidates, from the verified Cast platform facts:

- **Presentation API with a plain https URL** — zero registration, but it
  does not run our page on the Chromecast. Chrome renders the URL in an
  *offscreen tab on the sender's machine* and mirrors that rendering to the
  device: tab-mirroring quality and latency, re-encoded
  (developer.chrome.com/blog/present-web-pages-to-secondary-attached-displays;
  googlechrome.github.io/samples/presentation-api/). It also double-joins the
  room from the presenting machine — one extra mesh leg plus a local
  re-encode. That is mirroring in disguise, not a participant. Rejected as
  primary; retained as the old-hardware fallback (§6, slice 6).
- **CAF custom Web Receiver** — the only mechanism that actually runs our
  page on the device. Requires Google Cast SDK Developer Console
  registration: **$5 one-time, non-refundable**, per developer account;
  unpublished receivers load only on registered test devices (stated
  15-minute propagation wait plus a device power-cycle); publishing lead time
  is **unpublished** (developers.google.com/cast/docs/registration). **This
  is the primary.**

### The honest risk, stated before any code

Google's docs support exactly MPEG-DASH, HLS, SmoothStreaming, progressive
download, and HLS-in-MSE on the Web Receiver
(developers.google.com/cast/docs/media, …/web_receiver/streaming_protocols).
**WebRTC appears in no Google Cast document.** Our receiver plays a WebRTC
`MediaStream` through `srcObject` — undocumented behavior of the
Chromium-based Cast runtime. Two consequences:

1. **A hardware spike gates the feature.** Slice 1 is proving receive-only
   WebRTC + `srcObject` playback on a real Chromecast with Google TV before
   anything else is built. If it fails, this section falls back to the
   mirroring paths and the doc gets rewritten — an outcome that costs $5 and
   a day precisely because we test first.
2. **Older hardware is written off now.** Gen 1–3 Chromecasts run a
   constrained legacy runtime; no document suggests WebRTC there and we will
   not claim it. Copy for those devices: *"This Chromecast is too old for
   live shares. Direct video links still cast normally."* Their working
   routes are Chrome's own **Cast tab** menu item — user-menu only, no web API can
   trigger tab mirroring (support.google.com/chromecast/answer/3228332;
   macOS 15+ additionally requires granting Chrome Screen Recording
   permission) — and the Presentation API fallback.

There is no stock-protocol bridge that dodges the risk: Cloudflare Stream's
WHIP/WHEP cannot emit HLS — "we do not yet support … streaming using WHIP and
playing using HLS or DASH" (developers.cloudflare.com/stream/webrtc-beta/) —
and WHEP is absent from every Cast media doc, so "SFU → WHEP → receiver" has
no supported leg on either end. Our own page joining as a peer is the only
client-side route that exists.

### How the TV joins

The receiver page is a new route (`/tv`): full-bleed share video, room name,
nothing interactive — no mic, no chat input, no queue. It joins over the
existing p2p stack as `role: "tv"`, subscribing to the share only; room voice
stays on personal devices in v1. Handoff: the sender launches the session via
the Web Sender SDK with our receiver app ID and passes
`{roomCode, guestToken}` over the Cast message bus
(`urn:x-cast:watch.gather.tv`). The Presentation API fallback passes the same
via `PresentationConnection.send()` — messaging works for https receiver
URLs; it is only `cast:APPID` presentation URLs that cannot message back
(googlechrome.github.io/samples/presentation-api/cast.html).

### The TV is a seat, not a free rider

- **On the mesh (every room today):** one more (N−1) leg at ~1.5 Mbps of the
  **sharer's** uplink. The mainstream ~10 Mbps uplink crosses the ceiling at
  N=6 (docs/COST_MODEL.md) — a TV takes one of the six chairs: **five humans
  plus the TV and the room is full.** That ceiling is the host's broadband, not
  a plan limit, which is exactly why the seat-count UI must count the TV and
  say so ("Your TV counts as a viewer"): there is nothing to upgrade to, so the
  honest number is the whole mitigation. The TV peer carries the same
  TURN-relay risk and pre-share ICE check as any other peer.
- **If the room is ever moved to the SFU:** one more subscriber at the verified
  $0.05/GB Realtime egress after the shared 1,000 GB/mo pool ≈
  **$0.0371/TV-hour** (docs/COST_MODEL.md;
  developers.cloudflare.com/realtime/sfu/pricing/). Deterministic and cheap; no
  special-casing. Nothing selects the SFU today.

---

## 2. AirPlay — the floor is guidance, and that is a feature

There is no API, for anyone. AirPlay mirroring is OS-owned end to end — mDNS
discovery, FairPlay handshake, hardware encode, direct LAN push — and the
only programmatic "start mirroring" Apple publishes anywhere is an MDM
command for enterprise-managed devices, not callable by any app a user
installs (developer.apple.com/documentation/devicemanagement/start_airplay_mirroring).
The web surface Apple does expose is per-`<video>`-element and requires a
URL-addressable source — "an mp4, mpeg-ts, or HTTP Live Streaming (HLS)" URL;
MSE/blob sources "by nature, are not compatible with AirPlay"
(webkit.org/blog/15036). The screen share is a WebRTC `MediaStream` on
`srcObject` — a blob source by construction. Per-element AirPlay of the share
is therefore impossible in any browser at this layer, permanently. What every
Apple user already has is OS mirroring, which shows the share, the room,
everything, at roughly real time, for free.

So the product ships one line of copy at the right moment, and that is the
entire client-side AirPlay feature. **Designed, not built** — re-verified
2026-08-18: `apps/web/components/stage/PlayerControls.tsx` carries the
always-visible cast control with its honest states (that part did ship
2026-08-17, and `apps/web/test/cast-affordance.test.ts` pins it), but neither
string below exists anywhere in the tree. Grep "Screen Mirroring" — nothing. It
lands with slice 5 (§6).

- **Where it goes:** rows inside the always-visible cast control popover,
  shown only while a screen share is on stage, keyed by platform.
- **macOS copy:** *"To put this on your TV: menu bar → Control Center →
  Screen Mirroring."*
- **iPhone/iPad copy:** *"To put this on your TV: Control Center (swipe down
  from the top-right) → Screen Mirroring."*

Safari + a direct/HLS URL is unchanged: those sources are real URLs, so
the genuine AirPlay picker keeps working through the existing machinery
(`webkitShowPlaybackTargetPicker` / `remote.prompt()` in
`apps/web/lib/cast.ts`).

---

## 3. AirPlay — the server ceiling, judged coldly

A real AirPlay video session needs a fetchable HLS/mp4 URL. For a live share
only a server can mint one, and with today's Cloudflare Stream the path is
ugly in a specific, verifiable way:

1. A browser cannot speak RTMPS/SRT, and the one browser-native ingest —
   WHIP — cannot produce HLS out: "WHIP and WHEP must be used together — we
   do not yet support … streaming using WHIP and playing using HLS or DASH.
   (coming soon)" (developers.cloudflare.com/stream/webrtc-beta/).
2. Therefore we would run our own transcoder: a server process joins the room
   as a subscriber, re-encodes the share to H.264+AAC, and pushes RTMPS to a
   Stream live input. That is an always-on transcode service — banned in §5,
   and the doctrine admits a server only where nothing client-side exists.
   Something client-side does exist: §2.
3. HLS live playback **requires recording** — `recording.mode: "off"` means
   no playback at all, so the mode must be `"automatic"` and every cast-hour
   also consumes storage quota
   (developers.cloudflare.com/stream/stream-live/start-stream-live/).

Cost per cast-hour at published rates
(developers.cloudflare.com/stream/pricing/):

| Component | Rate | Per cast-hour |
|---|---|---|
| HLS delivery to the TV | $1 / 1,000 min delivered | $0.06 for one viewer — a floor, since preloading/buffering is billable |
| Forced recording | $5 / 1,000 min stored, prepaid quota | $0.30 of quota consumed; reclaimable only by API-deleting the recording after the stream (auto-expiry minimum is 30 days) |
| Ingest + encoding | "Ingress … and encoding are always free" | $0 |
| Our transcoder | not a Cloudflare line item | a dedicated encode process per active cast — the real cost, in compute and in being a service we must keep alive |

Latency, from published figures only: share to our transcoder <1s (WebRTC);
standard HLS has **no published glass-to-glass number anywhere in the Stream
docs** — it is governed by the 2–8s GOP; LL-HLS is open beta at "as little as
three seconds" (blog.cloudflare.com/cloudflare-stream-low-latency-hls-open-beta)
and also requires recording; and Apple publishes **no** latency statement for
HLS over AirPlay at all — its "two seconds or less" LL-HLS figure (WWDC20
session 10228) is for direct playback. Sum: several seconds, not quantifiable
from published data, against an OS mirror that is free and roughly real time.
The TV would sit seconds behind the room while live voice stays real time —
the exact spoiler geometry docs/EXTENSION_FIRST.md Part 1 exists to prevent.

**Verdict: DEFER.** Not because the Cloudflare bill is big — $0.36/cast-hour
of metered cost is nothing — but because the price of admission is an
always-on transcode service, a storage-quota hard-failure mode ("if you run
out … you will not be able to … start new live streams"), and
worse-than-mirroring latency we cannot even put a number on. Revisit on
either trigger:

- users actually ask for it (there are no paying users to ask — this trigger
  used to read "a paying user asks", which was the plan-tier version of the
  same test; the test is demand, and demand is now measured in support
  tickets), or
- Cloudflare ships WHIP-in → HLS-out (their "coming soon"), which deletes the
  transcoder from the design entirely: the sharer's browser WHIPs directly
  (H.264 constrained-baseline is in Stream's WebRTC codec list), Stream mints
  the HLS URL, and the only residue is the recording charge. That version
  might pass doctrine. The current one does not.

---

## 4. The durable AirPlay fix is the native iOS app

The roadmap iOS app closes this gap properly: `AVRoutePickerView` gives a
real, in-app AirPlay button; direct/HLS items play through a real
`AVPlayer` on an HLS/mp4 URL and AirPlay as first-class video; and the app
sits above Safari's per-element restrictions, so whatever share-to-TV path is
built there is judged against native APIs, not the web ceiling. That is why
§3 can be deferred without product guilt: the web was never going to be where
AirPlay is won, and straining it now buys a worse version of what the app
does later.

---

## 5. Not built

| Not built | Why — permanent |
|---|---|
| Provider relay (proxying or re-streaming YouTube/Netflix/Spotify content) | Content never traverses our infra — ToS, and the entire point of synced-source playback |
| DRM anything (capture, decrypt, re-encode, cast of protected surfaces) | Output protection blacks it out by design; also the law |
| Programmatic mirroring (tab or screen, any OS) | No API exists for anyone: Chrome's "Cast tab" is user-menu only; AirPlay mirroring is Control-Center only; the sole programmatic hook is an enterprise MDM command |
| Always-on transcode service | A server in the media path with a standing bill, for outcomes clients already get; §3's deferral is the only door, and it stays shut until a trigger fires |

---

## 6. Implementation slices, in order

1. **Hardware spike (go/no-go).** Registered test device + a static receiver
   page; prove receive-only WebRTC and `srcObject` playback in the Cast
   runtime on a Chromecast with Google TV. Gated on owner action A (§7). No
   repo dependencies; a throwaway page is fine.
2. **Receiver route — new, no collisions, can start immediately.**
   `apps/web/app/tv/page.tsx` (+ `tv-client.tsx`): view-only join over the
   existing stack — `apps/web/lib/room-connection.ts`,
   `apps/web/lib/call-mesh.ts` — with the share render path lifted from
   `apps/web/components/stage/ScreenShareStage.tsx` (render only, no controls).
3. **`role: "tv"` participant.** `packages/contracts` (participant role) and
   room state, so seat counting and labels are honest; mesh accounting counts
   the TV as a full leg (§1).
4. **CAF shell + handoff.** The receiver page feature-detects
   `cast.framework`, starts `CastReceiverContext`, reads
   `{roomCode, guestToken}` from `urn:x-cast:watch.gather.tv`; sender-side
   session helpers in `apps/web/lib/cast.ts` — the on-demand `cast_sender.js`
   loader already exists there; add our receiver app ID beside
   `DEFAULT_MEDIA_RECEIVER_APP_ID`, which direct-URL items keep using unchanged.
5. **Player-bar cast UI.** The live-triage wave (shipped 2026-08-17) made
   the cast control always-visible with honest states; this slice **extends
   that control, it does not duplicate it**: a "Watch on Chromecast" action
   that launches the CAF session when a share is live, the two AirPlay
   guidance rows (§2), and the old-device fallback line (§1). Extend
   `apps/web/test/cast-affordance.test.ts` for the new states.
6. **Presentation API fallback (low priority).** Same `/tv` URL via
   `new PresentationRequest(url)` for gen 1–3 devices, labeled honestly
   ("Mirrored — quality depends on this computer"). Ship only if support
   tickets earn it.

---

## 7. Owner actions

| Action | Cost | Lead time | When |
|---|---|---|---|
| A. Google Cast SDK Developer Console account (cast.google.com/publish) | $5 one-time, non-refundable (developers.google.com/cast/docs/registration) | minutes | Now — it gates slice 1 |
| B. Register test Chromecast(s) in the console | $0 | stated 15-minute wait + device power-cycle, per device | With slice 1 |
| C. Publish the receiver app (name, URLs, sender IDs, 512×512 icon; title ≤50 chars, description ≤80) | $0 beyond A | **unpublished** — budget unknown lead time; start the listing the day the spike passes | Before GA |
| D. Cloudflare Stream enablement / storage prepay | — | — | **Do not.** §3 is deferred; enabling Stream now buys a subscription quota for a path we decided not to build |

## Cannot be closed from published data

1. **Whether the Cast runtime plays WebRTC at all** — absent from every
   Google doc; only the slice-1 hardware spike answers it.
2. **Receiver publishing lead time** — Google publishes no figure; treat GA
   scheduling as unknown until C completes once.
3. **Standard-HLS glass-to-glass latency and the AirPlay-hop latency** — no
   published figures exist; never quote seconds for either.
4. **Stream WebRTC beta billing** — "not published for the beta period";
   irrelevant unless §3 revives, at which point verify with Cloudflare first.
