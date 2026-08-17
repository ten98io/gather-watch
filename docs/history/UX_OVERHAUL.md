> **HISTORICAL (moved 2026-08-17).** This overhaul is executed. Its surviving
> decisions — the locked-decision table and the ≤3-step budget — now live in
> `DESIGN.md` §11–12, which is the binding copy. Note D3 evolved: the listen
> composition is now driven per playing item (`mediaKindFor`), not by a room
> kind, which no longer exists as a user choice.

# UX overhaul spec (supersedes the raw feedback list)

This is the executable version of the owner's 2026-08-16 feedback. It exists
because the raw list mixed three different kinds of work — **already built**,
**built but broken**, and **genuinely new** — and treating them the same way
would have rebuilt working code while leaving the real bugs in place.

## 0. Ground truth before any work starts

Already shipped (do **not** rebuild — verify, then fix only if broken):

| Asked for | Status | Where |
|---|---|---|
| Room CRUD + 4h free-plan expiry | Built, with activity reset + 60s sweeper | `rooms/service.ts` (`FREE_ROOM_TTL_MS`), commit `fc337c5` |
| `XXXX-XXXX-XXXX` invite codes | Built | `contracts/entities.ts:27`, `normalizeInviteCode` |
| Chat autocorrect | Built | Composer `autoCorrect`/`autoCapitalize`/`spellCheck` |
| Chromium MV3 extension, Mode A + Mode B | Built; prod URL now configurable | `apps/extension`, commits `add569b` + this session |
| Zoom-style call grid, theater-collapsible | Built but **not working** — see B1 | `components/call/CallGrid.tsx` |
| Listen-room skin | Built but **too weak** — see B3 | `components/stage/ListenStage.tsx` |

## 1. The three real bugs (highest priority, fix first)

### B1 — You join a call and see nobody
**Root cause:** `CallStrip.tsx:113` publishes presence as
`{ state: 'in-call', micOn: true, camOn: false }`. Camera is off for everyone,
so no video track is ever published; `CallGrid` then renders only audio chips.
Compounding it, `CallGrid` is a floating cluster (`absolute left-1/2 top-4`)
over the stage rather than a real grid, and it returns `null` whenever no
presence entry has `state === 'in-call'`.

**Fix:** camera stays **off by default** (privacy), but the empty state must
explain itself: your own tile always renders once you're in a call, showing a
prominent "Turn on camera" control. Tiles move to the **right rail above
chat** (decision D1). Never render a silent empty region — if people are in
the call, they each get a tile with avatar + speaking ring + mic state.

### B2 — Two play buttons (ours + YouTube's)
**Root cause:** `youtube.ts:112-120` already sets `controls: 0`, so YouTube's
control *bar* is gone. What remains is YouTube's **large centre play overlay**,
which `controls:0` does not remove in unstarted/paused states, colliding with
our own paused-backdrop ▶ ring and the transport bar's play button.

**Fix:** a full-stage transparent click shield above the iframe that owns all
pointer events and routes them to room-synced play/pause, so the provider's
overlay is never reachable or visible. Exactly **one** play affordance visible
at a time: the transport bar's button, plus the big centre ring only while
paused. Verify visually in the browser, not just in code.

### B3 — Watch and listen rooms look identical
**Root cause:** `ListenStage` does render for `kind === 'listen'`
(`StagePane.tsx:127,405`), but only the stage tile changes — header, rail,
transport bar and layout are byte-identical, so it doesn't read as a different
product.

**Fix:** see D3.

## 2. Locked decisions (owner, 2026-08-16)

- **D1 — Call layout:** video tiles live in the **right rail above chat**;
  the content stage is never covered. Theater mode collapses the rail; tiles
  become a small overlay the user can hide and restore.
- **D2 — Camera default:** mic on, camera off, with a prominent, obvious
  "Turn on camera" affordance (see B1). No pre-join device dialog — it would
  break the step budget.
- **D3 — Listen room gets its own identity:** centred large album art,
  dominant visualiser, up-next as a track list, accent colour extracted from
  the artwork, none of the video-stage furniture.
- **D4 — Refresh depth: all three levels.** Design-system pass **and** full
  visual redesign **and** bug/flow fixes. Reference points are the best-in-
  class consumer apps in this category (Spotify for listening; modern video
  apps for watching): heavy use of **artwork, posters, thumbnails and real
  titles** everywhere content appears.

## 3. The ≤3-step rule — made measurable

"Step" = one user-initiated interaction (click, tap, keypress-to-submit) from
the **room screen** (for in-room features) or the **home screen** (for
account-level features). Typing into a field that is already focused does not
count; opening a dialog does.

Every flow below must be measured *as it exists*, reported, and reduced to the
budget. Do not guess the current count — measure by walking the running app.

| Flow | Budget | Notes |
|---|---|---|
| Create a room | 3 | From home to a live room |
| Join by code | 2 | Paste code → in |
| Invite someone | 2 | Copy link/code |
| Add content to queue | 2 | Paste/pick → queued |
| Play a queued item | 1 | |
| Reorder / remove a queue item | 1 | Drag, or one click on hover |
| Join the call | 1 | |
| Turn camera/mic on | 1 | |
| Share your screen | 2 | Exception allowed: the browser's own picker |
| Cast to a TV | 2 | Exception allowed: OS/browser picker |
| Send a message / emoji / GIF | 1–2 | |
| Switch watch ↔ listen room kind | 3 | |
| Open watch history and replay | 2 | |
| Link a music/video account | 3 | Exception: the provider's OAuth screens |
| Delete / rename a room | 2 | |
| Upgrade to Premium | 3 | Exception: Stripe checkout |

**Sanctioned exceptions** (never counted against the budget): third-party
OAuth consent, browser/OS pickers (screen share, cast), Stripe checkout, and
destructive-action confirmations.

## 4. Metadata everywhere (enables D4)

The single biggest reason the UI looks empty today: **queue items carry no
real metadata.** `QueueItemInput` is filled client-side with
`durationMs: null`, `artworkUrl: null` and a URL-derived title like
`YouTube · dQw4w9WgXcQ`; the server stores it verbatim and never enriches it.

Required: a server-side metadata resolver reusing the existing SSRF-hardened,
DNS-pinned unfurler (`modules/chat/unfurl.ts`) plus provider oEmbed endpoints,
so every queue item, history entry, now-playing view and room card gets a real
**title, artwork/poster, duration and provider**. Client-supplied metadata is
a hint only — never trusted for display without validation.

## 5. Ambiguity resolved: "cast/share devices in Mode A or B"

Three distinct features were hiding in one line:

1. **Share your screen into the room** → Mode B (exists; re-stream, non-DRM
   only). Needs the flow simplified to ≤2 steps.
2. **Cast the room's content to a TV** → the transport bar's Cast/AirPlay
   controls (exist; unlabelled and easy to miss). Needs tooltips and
   discoverability.
3. **Share a phone/tablet screen** → mobile capture. Genuinely new; scope
   separately, do not silently fold into 1.

## 6. Non-goals

- No DRM circumvention, no re-streaming of protected surfaces (see
  `CONTENT_MATCHING.md`). Mode B stays non-DRM-only.
- No new runtime dependencies without an explicit decision.
- No rebuild of the six shipped items in §0.

## 7. Gates

`pnpm typecheck` and the full suite (596+ tests) green; every claimed UI fix
verified **in a running browser** with a screenshot, not by reading code;
step-counts measured and reported per flow in §3.
