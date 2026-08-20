# Cross-region content matching (the "person A / person B" problem)

Two members of the same room, on the same platform, in different regions, often
cannot see the same catalog entry: the title may be absent, have a different
ID, a different cut, or different ad load. This doc fixes the design stance.

## The one rule that makes DRM sharing possible at all

**We never move the content — we move the clock.** Every member plays their
*own* licensed copy, through their *own* authenticated session, from their
*own* region's CDN, with their *own* DRM license. The room synchronizes only
the control plane: play/pause/seek/position. This is exactly what
synced-source playback + the extension already implement, and it is the same
model Teleparty/Prime Watch Party use. DRM is never decrypted, proxied, re-streamed, or region-spoofed —
that line is legal (DMCA §1201 / EU InfoSoc art. 6), contractual (every
platform ToS), and technical (EME/CDM output protection blacks out any capture
of a protected surface).

Note the tolerance this design assumes is **not** frame-lock. Sync is elastic
(`packages/sync-core`): a 2 s deadband for video, 1.5 s for music, a learned
per-viewer anchor up to 15 s, and a hard seek only past 12 s / 8 s. Any
matching rule below that depends on sub-second agreement is asking for
something the room does not provide — see `docs/EXTENSION_FIRST.md` Part 1.

Consequence: "sharing DRM content cross-region" reduces to a **content
resolution problem** — given what the host queued, find the equivalent
playable item for each member — plus a **readiness handshake**.

## Resolution ladder (per member, evaluated client-side in their session)

1. **Canonical identity, not URLs.** A queue item is
   `(platform, canonicalId)` + metadata: title, year, season/episode or
   artist/album, duration, artwork, and external IDs when resolvable
   (IMDb/TMDB/EIDR for video; ISRC/UPC for music). Platform IDs are mostly
   global (Netflix title IDs, Spotify track IDs) — *availability* is what
   differs by region, not identity.
2. **Exact-ID availability probe.** Each member's client (extension in their
   session, or embed adapter) checks "can I play this ID here?". Music
   platforms have native relinking (e.g. Spotify `market=from_token` returns
   the playable equivalent for the member's market) — use it.
   **If the answer is no, the path is Rungs 3 → 4 → 5 — never a VPN or proxy.**
   VPN/geo-spoofing is explicitly out of scope: platforms detect and block
   commercial VPNs, it violates every platform's ToS (account ban risk), and
   it exposes Gather to the "specially tailored" liability framing (*Cox v.
   Sony*).
3. **Metadata fallback search.** ID unavailable → search the member's catalog
   by metadata (title+year+S/E, or ISRC). Guard with a **duration check**
   (±2s for music, ±90s for video): a large delta means a different cut —
   match rejected or flagged, because different cuts break time-based sync.
4. **Cross-platform fallback.** Member has a *different* linked service that
   carries the title (matched via external IDs) → **offer it in the UI.**
   Example: "Not available on Netflix in your region — **available on
   Disney+**". The member clicks "Watch on Disney+ instead" → the matched title
   is queued on their regional platform → sync starts from their local player.
   Same clock, any licensed source. The host sees who has a fallback match
   before pressing play (readiness handshake, below). This is the primary
   answer to the region-gap problem and is why a VPN is unnecessary for the
   majority of cases.
5. **Graceful non-participation.** No playable equivalent → the member stays
   fully in the room (call, chat, reactions, queue) and sees the room
   backdrop with "Not available in your region on <platform>" — never a
   broken player, never a re-stream of a protected surface. (Screen-share
   re-streaming stays non-DRM-only by design.)

## Readiness handshake (pre-play, room-visible)

Before the host hits play on a DRM item, every member's client reports
`canPlay | fallbackMatched(id) | unavailable`. The room UI shows readiness the
way call UIs show mute state. The host sees who would be left out *before*
starting, not after. Members with a fallback match are synced against their
local equivalent's timeline.

## Known wrinkles

- **Different regional edits**: caught by the duration check; we warn and
  exclude time-sync rather than silently drift. Percentage-based sync is
  wrong (credits/edit offsets) — do not use it.
- **Ad-supported tiers**: ad breaks freeze one member's timeline. The member
  client signals `adBreak` (detectable in synced-source playback: player state
  without position progress); the room either pauses everyone (default, small
  rooms) or lets others continue and hard-reseeks the member after the break.
- **What we will not build**: VPN/geo-spoofing, license proxying, stream
  ripping, capture of EME surfaces. Any of these would also poison the
  legitimate 95% of the product. **VPN is not a fallback for Rung 2 "no" —
  the designed fallback is Rungs 3→4→5.**

## Custom platforms and the long tail

The extension's generic driver (`findMainMedia`) already works on any HTTPS
page with a `<video>` element via `{ kind: 'page', url }`. This means users
can technically queue arbitrary sites — including unlicensed aggregators.

**Gather's position:** do not block, do not endorse, do not optimize for.
- **Do not block:** the generic driver is the long-tail fallback for legitimate
  niche platforms and personal media servers.
- **Do not endorse:** unlicensed aggregators (e.g. yuppow-style iframe players)
  are unreliable, ad-heavy, frequently break the generic driver, and carry the
  same liability as torrent facilitation if promoted.
- **Do not optimize for:** no per-site adapters, no special-cased selectors, no
  featured placement for unlicensed sources.

The `{ kind: 'page', url }` path renders an honest stage panel telling the user
what is needed (the extension) rather than a broken player. That is the extent
of first-class support for the long tail.

## Owner direction — recorded 2026-08-20

The owner restated the vision in their own words and it confirms this doc's
stance rather than changing it: *a viewer in a different region who doesn't
have the content on the same platform should be helped to find the same
content in their region on a different site — using the person's default
search engine — or the user finds the content themselves, the extension
detects the player, and syncs it. We never violate DRM-protected site policy
or stream the content; we only sync it in real time.*

Mapping, agreed:

- **"User finds it, extension syncs it" already works.** There is
  deliberately no URL-match gate on the driven tab: the room queues one
  link, a member opens their *own* copy on any site, and the extension
  drives whatever player is in front of them against the room clock.
  Different cuts sit at a fixed offset the learned anchor absorbs;
  interstitial ads are vetoed rather than fought (2026-08-20). The missing
  polish is this doc's readiness handshake.
- **"Find it in their region via their default search engine"** gets a
  concrete mechanism: `chrome.search.query()` (MV3, `search` permission)
  runs a query through the user's ACTUAL default engine in a new tab, on a
  user gesture. The affordance is a **"Find it where you are"** button in
  the extension (popup first): one click → their engine opens with
  `<title> (<year>) watch` → they pick the site their region has → the
  extension adopts that tab and syncs it. User-initiated only — the
  extension never navigates for anyone (external.ts doctrine), and no URL
  is ever taken from a page or a peer.
- **Prerequisite:** knowing the title. **DONE 2026-08-20** — queue inserts
  background-enrich through the same resolver behind `POST /media/resolve`
  (FEATURE_PLAN 0.6): real titles past the placeholder guard, artwork, and
  durations that turn the server's advance guard from pricing into
  verifying. Budgeted per user to the REST tier; the adder's own duration
  hint is discarded (it was a lever on the guard).
- **Build order:** ~~0.6 resolution on insert~~ → ~~the search button~~
  (both shipped 2026-08-20; the popup's "Find it where you are" asks the
  user's default engine via `chrome.search.query`) → the readiness
  handshake (`canPlay | fallbackMatched | unavailable`) → external-ID
  enrichment + rung-4 cross-platform offers.

## Status

**Implemented today**: per-member local playback (web synced-source adapters +
the extension driver, which is preferred whenever it is installed), paused
backdrop, elastic drift-corrected sync, non-DRM-only screen share. A
`MediaRef` is already an identity rather than a bare URL for the provider
tiers that have one (`youtube` videoId, `vimeo` videoId, `embed` provider +
url) — the long tail falls back to `{ kind: 'page', url }`, which is a URL
and nothing more.

**Rung 1 is half-built; rungs 2–4 are not built at all.**

- **Rung 1 (canonical identity + metadata)** — the server-side resolver exists:
  `POST /media/resolve` (`services/api/src/modules/metadata/`) turns a pasted
  link or a `MediaRef` into `ResolvedMedia { title, artworkUrl, durationMs,
  providerId, providerName, authorName, canonicalId, canonicalUrl, source }`,
  via keyless oEmbed with an Open Graph fallback, through the hardened fetcher.
  So `(platform, canonicalId)`, duration and artwork are already on the wire.
  What is **missing** is external-ID enrichment: nothing resolves IMDb, TMDB,
  EIDR, ISRC or UPC, so the cross-platform match in rung 4 has no key to match
  on.
- **Rungs 2–4 (availability probe, metadata fallback search, cross-platform
  fallback)** — nothing. No client reports "can I play this here?", no search
  runs, the ±2 s / ±90 s duration check is not applied anywhere, and the
  cross-platform suggestion UI ("Watch on Disney+ instead") does not exist.
- **The readiness handshake** — nothing. No `canPlay | fallbackMatched |
  unavailable` report exists on the wire, so the host cannot see who would be
  left out before pressing play, and members cannot see cross-platform fallback
  offers.
- **Ad-break signalling** — nothing. No `adBreak` client event exists.
- **Rung 5 (graceful non-participation)** — partly real. A member with no
  playable source sees an honest stage panel rather than a broken player, and
  chat/call/queue/presence all keep working. The *reason* shown is generic; it
  is not "not available in your region on X", because nothing has established
  that fact.

This doc is the **target design** for the rest. The gate is external-ID
enrichment on `ResolvedMedia` — without a shared key, none of rungs 2–4 can be
built honestly.
