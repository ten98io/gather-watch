# Cross-region content matching (the "person A / person B" problem)

Two members of the same room, on the same platform, in different regions, often
cannot see the same catalog entry: the title may be absent, have a different
ID, a different cut, or different ad load. This doc fixes the design stance.

## The one rule that makes DRM sharing possible at all

**We never move the content — we move the clock.** Every member plays their
*own* licensed copy, through their *own* authenticated session, from their
*own* region's CDN, with their *own* DRM license. The room synchronizes only
the control plane: play/pause/seek/position. This is exactly what Mode A + the
extension already implement, and it is the same model Teleparty/Prime Watch
Party use. DRM is never decrypted, proxied, re-streamed, or region-spoofed —
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
3. **Metadata fallback search.** ID unavailable → search the member's catalog
   by metadata (title+year+S/E, or ISRC). Guard with a **duration check**
   (±2s for music, ±90s for video): a large delta means a different cut —
   match rejected or flagged, because different cuts break time-based sync.
4. **Cross-platform fallback.** Member has a *different* linked service that
   carries the title (matched via external IDs) → offer it. Same clock, any
   licensed source.
5. **Graceful non-participation.** No playable equivalent → the member stays
   fully in the room (call, chat, reactions, queue) and sees the room
   backdrop with "Not available in your region on <platform>" — never a
   broken player, never a re-stream of a protected surface. (Mode B
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
  client signals `adBreak` (detectable in Mode A: player state without
  position progress); the room either pauses everyone (default, small rooms)
  or lets others continue and hard-reseeks the member after the break.
- **What we will not build**: VPN/geo-spoofing, license proxying, stream
  ripping, capture of EME surfaces. Any of these would also poison the
  legitimate 95% of the product.

## Status

**Implemented today**: per-member local playback (web Mode A adapters +
the extension driver, which is preferred whenever it is installed), paused
backdrop, elastic drift-corrected sync, non-DRM-only Mode B. A `MediaRef` is
already an identity rather than a bare URL for the provider tiers that have one
(`youtube` videoId, `vimeo` videoId, `embed` provider + url) — the long tail
falls back to `{ kind: 'page', url }`, which is a URL and nothing more.

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
  runs, and the ±2 s / ±90 s duration check is not applied anywhere.
- **The readiness handshake** — nothing. No `canPlay | fallbackMatched |
  unavailable` report exists on the wire, so the host cannot see who would be
  left out before pressing play.
- **Ad-break signalling** — nothing. No `adBreak` client event exists.
- **Rung 5 (graceful non-participation)** — partly real. A member with no
  playable source sees an honest stage panel rather than a broken player, and
  chat/call/queue/presence all keep working. The *reason* shown is generic; it
  is not "not available in your region on X", because nothing has established
  that fact.

This doc is the **target design** for the rest. The gate is external-ID
enrichment on `ResolvedMedia` — without a shared key, none of rungs 2–4 can be
built honestly.
