# Gather — Cloudflare cost model (verified 2026-08)

Every price here was taken from an official Cloudflare page on 2026-08-16 and
carries its URL. Anything not published is marked ASSUMED with its reasoning,
or "cannot be closed". Do not promote an assumption to a rate.

Rewritten 2026-08-18 to drop the free/premium framing this was first written
under — Gather has one tier now. **No figure changed**; the arithmetic below is
the same arithmetic, re-labelled by the engineering state it actually describes
(mesh / TURN / SFU) instead of by a plan that no longer exists. Where a number
only ever made sense as a plan boundary, it says so rather than being replaced.

## Verified rates

| Item | Rate | Unit | Source |
|---|---|---|---|
| Realtime TURN egress | $0.05 | per GB, CF → TURN client; ingress free; STUN free/unlimited | developers.cloudflare.com/realtime/turn/faq/ |
| Realtime SFU egress | $0.05 | per GB, CF → client; ingress free; **no** per-participant/minute price exists | developers.cloudflare.com/realtime/sfu/pricing/ |
| TURN + SFU together | billed **once**, not twice | — | same |
| Cloudflare free allowance | 1,000 GB/mo | **one pool shared** across TURN + SFU — "not two independent free tiers" | same |
| R2 storage | $0.015 | per GB-month (Standard); egress to Internet **$0** | developers.cloudflare.com/r2/pricing/ |
| R2 ops | $4.50 / $0.36 | per M Class A / Class B | same |
| Workers Paid | $5.00 | per month, account minimum | developers.cloudflare.com/workers/platform/pricing/ |
| Email Sending | 3,000/mo included, then $0.35 | per 1,000 emails; **requires Workers Paid**; not offered on Free | developers.cloudflare.com/email-service/platform/pricing/ |
| Email Routing (inbound) | $0, unlimited | all plans | same |
| DO requests | $0.15 | per M; WebSocket incoming billed 20:1, outgoing free | developers.cloudflare.com/durable-objects/platform/pricing/ |
| DO duration | $12.50 | per M GB-s, wall-clock × flat 128 MB; **hibernating objects not billed** | same |

Statuses: TURN GA (2024-09), SFU GA (2025-04), Email Sending **public beta**.
Realtime needs no paid plan that any page states (verified as absence, not as
guarantee). TURN does not run on the China network. Email daily send quota for
new accounts is **unpublished** ("conservative, scales with reputation") — the
launch-day risk for magic links, worth a support ticket before launch.

## What a room-hour costs

**There is one tier.** Gather has no plans, no paywall and nothing to upgrade
to — so nothing below is a price a user sees. These are operator costs, and
the three cases are three *engineering* states of the same room, chosen by
physics rather than by billing:

- **Mesh** — the default. Peers talk directly; we pay nothing.
- **Cloudflare TURN** — the *connectivity* fallback, entered per-link when a
  NAT will not let two peers meet. Chosen by the participants' ISPs, not by us.
- **Cloudflare Realtime SFU** — the *capacity* fallback, for when the host's
  uplink cannot fan a share out to everyone. Nothing selects it today (every
  stored room is `relayMode: 'mesh'`), so its arithmetic is a design budget.

Synced-source playback (internally "Mode A": each viewer's own device plays
the source) never puts content on our infrastructure at all, so the bill is
only sync + relay in every case.

- **Mesh, 6 people, voice, no share:** $0.002–$0.015/room-hr depending on
  NAT-relay rate *p* (ASSUMED 5–25% band; ~95% of cost is TURN). The 1,000 GB
  pool absorbs ~3,400–6,600 such hours/month before the first dollar.
- **SFU, 6 people, 1 hr screen share:** **≈ $0.22/room-hr**
  ($0.034 voice + $0.186 share). Voice-only: $0.034. Deterministic — the SFU
  cannot produce a NAT surprise.
- **Marginal share viewer:** $0.0371/viewer-hr. Voice on the SFU grows
  N(N−1); forward only top ~3 speakers to make it ~3N.

## The two structural conclusions

**1. The SFU never beats mesh on operator cost.** Same wire volume, different
billed fraction: mesh bills f×volume (f = relayed share, 0.05–0.30), SFU
bills 1×volume — a 3–20× markup. The SFU is bought for the *sharer's uplink*,
not for cost: mesh share demands (N−1)×1.54 Mbps from one home connection,
which crosses a mainstream ~10 Mbps uplink almost exactly at **N=6**. That
number is a property of home broadband, not a plan limit — there is no plan
to lift, so a room that outgrows one host's uplink has exactly one honest
answer, and buying the SFU for it is the whole reason the SFU is in the
design.

**2. Mesh cost is stochastic; the SFU is deterministic.** All mesh variance is
the relay rate *p*, which is a property of participants' networks (CGNAT,
VPNs, UDP-blocking firewalls), clusters per person, and is offset by IPv6.
That is the real trade the SFU buys: not a cheaper hour, a *knowable* one.

### Why not a managed SDK: the billing shape, not the price

RealtimeKit was evaluated as the capacity fallback and **rejected**, on two
counts. The technical one is disqualifying on its own: it cannot publish mic +
share-video + share-audio from tracks we have already captured, and every one of
those three is a track this product has to carry (`TrackRole` in
`packages/p2p/src/types.ts`).

The commercial one is the reason not to look for a similar SDK either. Managed
SDKs price **per participant-minute** — a per-head meter — and Gather has one
free tier, so revenue per participant is exactly zero and the cost of a room
grows with the thing the product wants more of. Cloudflare Realtime's
egress-per-GB shape is the opposite: it is metered against bytes we choose to
send, which is a lever we hold (the relayed-share cap, forwarding only the top
speakers), and it starts inside a 1,000 GB/mo pool. A per-head meter has no such
lever. That is a structural mismatch, not a rate comparison, and it would not be
fixed by a cheaper per-minute price.

## Top risks, in order

1. **A mesh screen share falling back to TURN** — 5 relayed share streams cost
   $0.186/hr, which is the same $0.186 the SFU would have charged for that
   share, except we did not choose it: the user's ISP did, on the path we
   assumed was free, in ~1 in 8 sharing rooms at p=12%. Mitigate: detect relay
   from ICE candidate type BEFORE the share starts, then refuse or cap the
   relayed encode at 300–500 kbps; hard-cap TURN GB per account (no spend cap
   exists on Realtime — build one); never ship an uncapped "P2P failed →
   relay it" video fallback. TURN-over-TLS/443 works only on
   turn.cloudflare.com, not custom domains.

   **Status: the static ceiling is WIRED; the dynamic governor is not.**
   `packages/p2p/src/mesh.ts` classifies every link `direct`/`relayed` from ICE
   stats and bitrate-caps the `share` sender the moment a link goes relayed
   (uncapping it again when the link goes direct; voice is never capped). Both
   share producers now pass the cap — `apps/web/lib/call-mesh.ts`
   (`DEFAULT_CAP_RELAYED_VIDEO_KBPS`) and `apps/extension/src/offscreen.ts`
   (`SHARE_RELAYED_VIDEO_CAP_KBPS`), 400 kbps each — so a share that falls back
   to TURN no longer bills full rate per relayed viewer. The old 400 kbps guard
   this replaced was deleted along with billing, correctly: it gated on a plan
   lookup that no longer existed and was therefore capping every share
   unconditionally.

   What remains is the *dynamic* half: `BitrateGovernor` + `LinkAdaptor`
   (`packages/p2p/src/adaptation.ts`) are built, exported and unit-tested with
   **zero mesh callers**. The static cap is meant to become a ceiling on top of
   that governor for relayed links only. Build order in
   `docs/FEATURE_PLAN.md` §8.
2. **DO hibernation defeated** (if the API ever moves to Workers): one
   abandoned room with a naive 30 s client keepalive burns 81% of the monthly
   duration allowance; 1,000 such rooms ≈ $4,000/mo. The one-line fix is
   `state.setWebSocketAutoResponse()` — auto-responses are explicitly not
   billed.
3. **Attachment accretion** — ~$14/mo of legacy storage per year at scale, at
   the R2 rates above. Set a lifecycle policy now. Infrequent Access is a trap
   for this data (2.5× read ops, $0.01/GB retrieval, 30-day minimum).
   Note the R2 rows are a *comparison* today, not a bill: chat attachments
   live in the `attachments` Railway Bucket, whose pricing is not modelled
   here. The accretion shape is the same wherever the bytes sit; only the
   per-GB number would change, and this doc does not have Railway's.

## Cannot be closed from published data

1. **Billed legs when both mesh endpoints hold TURN allocations** (the normal
   symmetric-mesh case) — a clean 2× swing on the whole mesh estimate above,
   and therefore on the only number that is not already deterministic. Measure it:
   one forced-relay 2-peer session for a known duration, read the meter.
2. **SFU protocol-overhead accounting** — TURN states overhead is metered; the
   SFU page says nothing. The 1.10–1.25× factors are engineering estimates.
3. **.watch registration price** — Cloudflare Registrar publishes no TLD
   table (at-cost policy only); read it from the dashboard.

Monthly floor at zero traffic: **$5.00** (Workers Paid, forced by Email
Sending on day one) + domain registration.
