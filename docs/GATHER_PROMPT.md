# Gather — Session Starting Prompt

> **One sentence:** Gather is a shared living-room where groups watch, listen, talk and text together — media, call and chat as one session, live at [gather.watch](https://gather.watch).

## Before You Write Code

1. **Read HANDOFF.md** — live state, open items, the traps list. Read it first, every time.
2. **Run the gates with `--force`** — a cached `FULL TURBO` green proves nothing:
   ```bash
   pnpm build --force && pnpm typecheck --force && pnpm test --force && pnpm lint --force
   ```
   Numbers to beat: build 8/8, typecheck 14/14, test ~157 files / ~2000 passed / 18 skipped, lint 9/9.
3. **Check `git status`** — the working tree may carry uncommitted work from previous sessions.

## Architecture (six binding rules)

1. **One tier — no billing, no plans, no entitlements.** Rooms never expire. Any doc asking for a paywall is stale; fix the doc.
2. **Mesh → Cloudflare TURN → (deferred) Cloudflare Realtime SFU.** Mesh is default and free. TURN needs `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` on the API service. The SFU client lane is not built.
3. **Content never touches our infrastructure.** The extension drives each viewer's own player; we sync positions, not bytes.
4. **Auto-advance is compare-and-set intent, ungated.** Any client sends `sync.advance { endedItemId }`; the server moves the room only while still on that exact item.
5. **Mode A = synced-source playback, Mode B = screen share.** Users see "watch together" and "screen share". Internal vocabulary only.
6. **Web-slimming in progress:** steps 1–3 done, 4–5 gated on real-room verification. Web player adapters still exist.

## Tech Stack

| Layer | Technology |
|---|---|
| Web app | Next.js 15 PWA, Tailwind, shadcn/ui, Framer Motion |
| Extension | Chromium MV3, tsup, `tabCapture` + `desktopCapture` |
| Mobile | Expo (iOS + Android), React Native 0.79 |
| API | Fastify, MongoDB, Redis, WebSocket |
| Packages | `contracts`, `api-client`, `sync-core`, `p2p`, `design` (all ship via `dist/`) |

**Critical:** Edit a package → `pnpm build` it BEFORE typechecking downstream. Stale `.d.ts` gives false greens.

## Design System

- **Feeling:** private cinema drifting through a nebula. Cinematic, weightless, alive — never busy.
- **Tokens:** authored ONLY in `packages/design/src/tokens.ts`. Web reads CSS custom properties; mobile reads RN theme; extension reads shadow-root emitter.
- **Colors:** OKLCH, dark primary, light variant. Three aurora hues for gradients only. WCAG AA enforced by `packages/design/test/contrast.test.ts`.
- **Typography:** Space Grotesk (display), Inter (text), JetBrains Mono (codes). Fluid `hero` 28→56px; body 15px; fixed ramp elsewhere.
- **Glass:** RESERVED for surfaces floating over moving video (transport bar, modals, theater overlay). Everything else uses solid elevation ladder (`surface-0/1/2/3`).
- **Glow:** RESERVED for signature moments (artwork backdrop, presence orbs, emote bursts, sync pulse, aurora drift).
- **Shadow:** Three neutral elevation levels (`e1/e2/e3`) for ordinary chrome.
- **Motion:** Spring `stiffness 260, damping 30`. Micro 220ms, panel 300ms, max 400ms. Respect `prefers-reduced-motion`.
- **≤3-step budget:** every flow measured from room screen or home screen. See DESIGN.md §12.

## Open Items (prioritized)

### P0 — Small, high impact, close quickly
- [ ] **Mobile hero regression** (HANDOFF #10): `packages/design/src/scales.ts` `maxFontSize: 56` is web-only; RN needs `fontSize`. Mobile `displayL` regressed 34→28px.
- [ ] **JetBrains Mono unbundled** (HANDOFF #10): add `expo-font` dependency or stop naming the face.
- [ ] **AirPlay guidance copy** (HANDOFF #11): `docs/CAST_RELAY.md` §2 specifies two platform-keyed rows in the cast popover; `PlayerControls.tsx` has neither.
- [ ] **Bitrate cap unwired** (HANDOFF #3): pass `capRelayedVideoKbps` (300–500 kbps) from web + extension mesh constructors. `packages/p2p` classifies `direct`/`relayed` and will cap — no caller sets it.

### P1 — Medium, closes real gaps
- [ ] **Extension revived-session queue hole** (HANDOFF #7): worker recycle loses queue state. Ask for `wantSnapshot` on revive, same as web.
- [ ] **Room passwords** (HANDOFF #12): optional passphrase, argon2id/scrypt hashed server-side, host sets/rotates/clears. Join flow gains one step when enabled.
- [ ] **Theater mode** (HANDOFF #14): fullscreen stage, glass sidebar, floating call tiles. Spec finalized in DESIGN.md §11 D1.1.
- [ ] **Admin console v1** (HANDOFF #15): role-gated `/admin`, marketing pages as code, reports queue, user/room lookup. No second credential system.

### P2 — Large, foundational
- [ ] **Content-matching ladder** (HANDOFF #16): external-ID enrichment on `ResolvedMedia` → availability probe → readiness handshake. Gates cross-region access.
- [ ] **User-relations layer** (HANDOFF #13): friends, block, per-user report, invite tracking. Partiful is reference.
- [ ] **Mobile WebView postMessage bridge** (HANDOFF #6): embed items in RN WebView have no position API, so mobile-only rooms stall on finished items.
- [ ] **Duration resolution on queue insert** (HANDOFF #4): advance guard "prices" skips at 20s when `durationMs` is null. Resolve duration at insert time.

### External / gated
- [ ] **TURN keys** — needs `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` on Railway API service.
- [ ] **$5 Cast spike** — Google Cast dev console registration for Chromecast TV-participant.
- [ ] **Web-slimming steps 4–5** — delete web player adapters + `getDisplayMedia`, gated on real-room extension verification.

## Code Rules

- **Never `git add -A` while agents are in flight.** Stage only your scoped paths.
- **Two agents in one file = second write silently loses.** Use disjoint scopes.
- **Adding a union member?** `switch` fails loud; `if (.kind ===)` chains fail SILENT. Grep both. Use exhaustive switch with `const unhandled: never` default.
- **A mechanism with no producer is dead code passing tests.** Grep for what SENDS it, not what handles it.
- **No arbitrary values in new code.** Spacing: 4·8·12·16·24·32·48. Radii: 6·8·10·14. Use the design system.
- **No Prettier.** Match surrounding style by hand.
- **`exactOptionalPropertyTypes` is on.** Use conditional spreads, never `{ field: maybeUndefined }`.

## Test Notes

- Mongo contract pass is opt-in: `GATHER_TEST_MONGO_URL=mongodb://... pnpm --filter ./services/api test`
- Redis has no automatic real-instance test. Changes to `adapters/redis-bus.ts` are unverified until run by hand.
- A cached green is not proof. Re-run with `--force` before any deploy.

## Deploy Path

Pushing to `main` on `mustafagandhi/gather-watch` redeploys both Railway services (api + web). `railway up` is a local-source escape hatch, not the path.
