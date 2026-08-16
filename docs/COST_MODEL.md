# Gather — Cloudflare cost model (verified 2026-08)

Every price here was taken from an official Cloudflare page on 2026-08-16 and
carries its URL. Anything not published is marked ASSUMED with its reasoning,
or "cannot be closed". Do not promote an assumption to a rate.

## Verified rates

| Item | Rate | Unit | Source |
|---|---|---|---|
| Realtime TURN egress | $0.05 | per GB, CF → TURN client; ingress free; STUN free/unlimited | developers.cloudflare.com/realtime/turn/faq/ |
| Realtime SFU egress | $0.05 | per GB, CF → client; ingress free; **no** per-participant/minute price exists | developers.cloudflare.com/realtime/sfu/pricing/ |
| TURN + SFU together | billed **once**, not twice | — | same |
| Free allowance | 1,000 GB/mo | **one pool shared** across TURN + SFU — "not two independent free tiers" | same |
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

Mode A means content never touches our infrastructure; the bill is only
sync + voice relay (free tier) or SFU egress (premium).

- **Free tier, 6 people, voice, no share:** $0.002–$0.015/room-hr depending on
  NAT-relay rate *p* (ASSUMED 5–25% band; ~95% of cost is TURN). The 1,000 GB
  pool absorbs ~3,400–6,600 such hours/month before the first dollar.
- **Premium, 6 people, SFU, 1 hr screen share:** **≈ $0.22/room-hr**
  ($0.034 voice + $0.186 share). Voice-only: $0.034. Deterministic — the SFU
  cannot produce a NAT surprise.
- **Marginal share viewer:** $0.0371/viewer-hr. Voice on the SFU grows
  N(N−1); forward only top ~3 speakers to make it ~3N.

## The two structural conclusions

**1. The SFU never beats mesh on operator cost.** Same wire volume, different
billed fraction: mesh bills f×volume (f = relayed share, 0.05–0.30), SFU
bills 1×volume — a 3–20× premium. The SFU is bought for the *sharer's uplink*,
not for cost: mesh share demands (N−1)×1.54 Mbps from one home connection,
which crosses a mainstream ~10 Mbps uplink almost exactly at **N=6** — the
free-tier cap is therefore physics, not stinginess.

**2. Free-tier cost is stochastic, premium is deterministic.** All free-tier
variance is the relay rate *p*, which is a property of participants' networks
(CGNAT, VPNs, UDP-blocking firewalls), clusters per person, and is offset by
IPv6.

## Top risks, in order

1. **Free-tier Mode B falling back to TURN** — 5 relayed share streams cost
   $0.186/hr (≈ the full premium price) on the tier that pays nothing, fired
   by the user's ISP, ~1 in 8 Mode B rooms at p=12%. Mitigate: detect relay
   from ICE candidate type BEFORE the share starts, then refuse or cap the
   relayed encode at 300–500 kbps; hard-cap TURN GB per free account (no spend
   cap exists on Realtime — build one); never ship an uncapped "P2P failed →
   relay it" video fallback. TURN-over-TLS/443 works only on
   turn.cloudflare.com, not custom domains.
2. **DO hibernation defeated** (if the API ever moves to Workers): one
   abandoned room with a naive 30 s client keepalive burns 81% of the monthly
   duration allowance; 1,000 such rooms ≈ $4,000/mo. The one-line fix is
   `state.setWebSocketAutoResponse()` — auto-responses are explicitly not
   billed.
3. **R2 attachment accretion** — ~$14/mo of legacy storage per year at scale.
   Set a lifecycle policy now. Infrequent Access is a trap for this data
   (2.5× read ops, $0.01/GB retrieval, 30-day minimum).

## Cannot be closed from published data

1. **Billed legs when both mesh endpoints hold TURN allocations** (the normal
   symmetric-mesh case) — a clean 2× swing on the whole free tier. Measure it:
   one forced-relay 2-peer session for a known duration, read the meter.
2. **SFU protocol-overhead accounting** — TURN states overhead is metered; the
   SFU page says nothing. The 1.10–1.25× factors are engineering estimates.
3. **.watch registration price** — Cloudflare Registrar publishes no TLD
   table (at-cost policy only); read it from the dashboard.

Monthly floor at zero traffic: **$5.00** (Workers Paid, forced by Email
Sending on day one) + domain registration.
