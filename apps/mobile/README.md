# @gather/mobile — Gather Expo app (iOS + Android, one codebase)

Expo SDK 53 line (expo ~53 / RN 0.79.7 / React 19), expo-router, strict TS.
Full participant: Mode A playback, chat, queue, presence, room management.
Calls and Mode-B hosting are documented boundaries (see below) — never faked.

## Run

```bash
pnpm install
pnpm build            # REQUIRED first: @gather/* resolve to dist via exports
pnpm --filter @gather/mobile start
```

Server URL: `EXPO_PUBLIC_API_URL` env (bundled at build time) →
`app.json expo.extra.apiUrl` → `http://localhost:4000` (matches services/api
default). WS is `<ws(s)://host>/ws` (one multiplexed room socket).

## Auth transport (verified against services/api)

- The api authenticates REST **and** WS exclusively via
  `Authorization: Bearer <accessToken>` (`services/api/src/plugins/auth.ts`
  reads only that header; WS takes the same access JWT as `?token=`).
  **Bearer is supported.**
- The only cookie is `gather_rt` (httpOnly, path=/auth) — the refresh token.
  RN has no cookie jar, so `src/api.ts#captureFetch` (a) scrapes `Set-Cookie`
  on `/auth/verify|/auth/guest|/auth/refresh`, (b) re-attaches
  `Cookie: gather_rt=…` on refresh, and (c) captures
  `accessToken`/`accessTokenExpiresAt` from the raw JSON body before the
  contracts zod schemas strip them. Tokens live in `expo-secure-store`.
- Deep link: scheme `gather` (app.json). Production magic links should target
  `gather://login?token=…` — expo-router parses it into the login screen,
  which verifies automatically. In dev the api echoes the link (`devLink`);
  the login screen also accepts a pasted token or full link.

## Boundaries (documented, not faked)

- **Calls (`src/components/CallBar.tsx`)**: call participants are real —
  presence from the room stream, rendered as orbs. **Joining** is the stub:
  pressing Join mints a token and then shows a boundary panel rather than
  pretending. Presence is never set to `in-call`, because that would fake a
  state other clients render. Integration point (native milestone): add
  `react-native-webrtc` plus its config plugins, then connect and publish mic.
- **Mode B viewing**: needs the same native module — `Stage` shows an honest
  panel while `restream.state.active`.
- **Mode B hosting from mobile**: iOS ReplayKit broadcast extension, a native
  milestone. Nothing is simulated.
- **YouTube playback**: renders via `react-native-webview` embed; NOT
  drift-corrected (no position sampling without a postMessage bridge). The UI
  says so. Direct/HLS sources are drift-corrected via sync-core.
- **`{ kind: 'page' }` items**: a page is a LINK, and only the browser
  extension can play one. There is no extension on mobile, so `PageStage`
  shows the item and where the link goes, and says plainly that it will not
  play here. **`Stage.tsx`'s kind switch is exhaustive on purpose** — a new
  `MediaRef` member must be decided there, not defaulted, because an unhandled
  kind lands on the native player and renders a black box with no message.
  That is exactly the bug the `page` kind shipped as. Deleting one `case` line
  is a two-second demonstration that the guard is live.
- **P2P beacons**: `useSyncEngine` references `@gather/p2p` **types only**
  (BeaconState) as the seam; sync beacons ride the WS until
  react-native-webrtc lands. No p2p runtime code ships.
- **Ambient glow**: static aurora wash; per-media colour sampling (DESIGN.md
  §5.1) is a follow-up. Motion uses core RN Animated (Reanimated deferred —
  install weight); reduced-motion handling is a follow-up.
- **Fonts**: `expo-font` is **not installed**, so Space Grotesk / Inter /
  JetBrains Mono are named by the theme and never loaded — RN falls back to the
  platform font, which is why `type.mono` numeric readouts jitter instead of
  sitting on tabular figures. Tracked in HANDOFF.
- **Hero type step**: RN has no viewport unit, so it takes the ramp's 28px
  floor. Mobile's pre-redesign `displayL` was 34px, so the hero visibly shrank.
  Tracked in HANDOFF.

## Theme

`src/theme.ts` is the **React Native adapter over `@gather/design`** — nothing
more. It owns the names mobile imports (`palette`, `paletteLight`, `type`,
`radii`, `spacing`, `motion`, `layout`, `auroraGradient`, `glow`, `theme`) plus
the two RN-shaped type steps the design package deliberately does not carry
(`type.bodyStrong`, `type.mono`).

**Every colour, radius, spacing, duration and type value is imported.** There
are no hex literals, and there is no OKLCH source in comments any more — a hex
literal in this file is the exact bug that let mobile ship `--text-low` at 0.58
long after web raised it to 0.65 for contrast. The WCAG maths moved to
`@gather/design` too, where a guard test walks the whole surface ladder: mobile
had the maths locally and still shipped a failing token, because nothing ran it
over every pair.

The old "accent-ink on the aurora gradient measures 3.3–3.8:1" note is
**closed**. `--accent-ink` was theme-relative and that is what broke it; the
ink for a filled control is now chosen per fill from two absolute inks, and a
label crossing the gradient takes the maximin `inkOnGradient`. See DESIGN.md
§2.1.

## Dependency justification (install weight audit)

| package | why |
|---|---|
| `@gather/{contracts,api-client,sync-core,design,p2p}` | workspace packages — contracts, transport, sync maths, tokens, p2p types |
| expo-router | file-based routing (binding stack) |
| expo-video | Mode A native playback + background audio |
| expo-secure-store | token storage (binding: auth) |
| expo-constants / expo-status-bar | config surface / status bar |
| expo-linear-gradient | the aurora gradient is a DESIGN.md binding token |
| react-native-webview | YouTube Mode A source (contracts MediaRef) |
| react-native-safe-area-context / -screens | expo-router peers |
| @react-navigation/native | expo-router peer |
| zustand | room realtime store (vanilla store + useStore) |
| @tanstack/react-query | REST screen state (parity with web stack) |
| zod | contracts peer |

NOT added (deferred native milestones): react-native-webrtc and its config
plugins, reanimated, gesture-handler, expo-notifications, expo-font.

## Tests

`pnpm --filter @gather/mobile test` (vitest, node env):
`tests/room-connection.test.ts` (gap recovery / dedupe / reducers / gap-loss
fallback), `tests/theme.test.ts` (WCAG + scale invariants),
`tests/voice-band.test.ts`. **No RN rendering tests** — that policy came from
the original worker brief (`docs/history/MOBILE_K3_BRIEF.md`) and is why mobile
components have no render coverage to this day.
