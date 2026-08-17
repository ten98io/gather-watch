# @gather/mobile — Gather Expo app (iOS + Android, one codebase)

Expo SDK 53 line (expo ~53 / RN 0.79 / React 19), expo-router, strict TS.
Full participant: Mode A playback, chat, queue, presence, room management.
Calls / Mode-B hosting are documented scaffolds (see Boundaries below).

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
  `Authorization: Bearer <accessToken>` (`src/plugins/auth.ts` reads only that
  header; WS takes the same access JWT as `?token=`). **Bearer is supported.**
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

- **Calls (CallBar.tsx)**: The relayed-call join is a documented boundary (Cloudflare Realtime, native milestone).
  session needs a WebRTC native module + its config
  plugins (native milestone, install weight + no CI toolchains). Join mints
  a token and shows the boundary panel; presence is never spoofed.
- **Mode B viewing**: requires the same call module — Stage shows an honest
  panel while `restream.state.active`.
- **Mode B hosting from mobile**: iOS ReplayKit broadcast extension — per
  BUILD_PROMPT a native-milestone stub; nothing is simulated.
- **YouTube playback**: renders via `react-native-webview` embed; NOT
  drift-corrected (no position sampling without a postMessage bridge). The UI
  says so. Direct/HLS sources are drift-corrected via sync-core.
- **P2P beacons**: `useSyncEngine` references `@gather/p2p` **types only**
  (BeaconState) as the seam; sync beacons ride the WS until
  react-native-webrtc lands. No p2p runtime code ships.
- **Ambient glow**: static aurora wash; per-media color sampling (§5.1) is a
  follow-up. Motion uses core RN Animated (Reanimated deferred — install
  weight); reduced-motion handling is a follow-up.
- **Fonts**: Space Grotesk/Inter/JetBrains Mono via expo-font pending; theme
  type scale + weights already match DESIGN.md §3.
- **Known contrast note**: accent-ink on the aurora gradient measures
  3.3–3.8:1 (WCAG 3:1 UI level, under the 4.5:1 body bar). DESIGN.md owns
  this token pair — flagged for the design pass.

## Dependency justification (install weight audit)

| package | why |
|---|---|
| expo-router | file-based routing (binding stack) |
| expo-video | Mode A native playback + background audio |
| expo-secure-store | token storage (binding: auth) |
| expo-constants / expo-status-bar | config surface / status bar |
| expo-linear-gradient | aurora gradient is a DESIGN.md binding token |
| react-native-webview | YouTube Mode A source (contracts MediaRef) |
| react-native-safe-area-context / -screens | expo-router peers |
| zustand | room realtime store (vanilla store + useStore) |
| @tanstack/react-query | REST screen state (parity with web stack) |
| zod | contracts peer |

NOT added (deferred native milestones): the WebRTC native call module,
react-native-webrtc, reanimated, gesture-handler, expo-notifications.

## Tests

`vitest run` (node env): room-connection gap recovery / dedupe / reducers /
gap-loss fallback, theme WCAG + scale invariants. No RN rendering.

## Theme conversion

Hex tokens are exact OKLCH→sRGB conversions of DESIGN.md §2 (OKLab matrix +
sRGB gamma); the oklch source is kept in `src/theme.ts` comments.
