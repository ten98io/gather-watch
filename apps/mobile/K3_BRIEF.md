# K3 Brief — apps/mobile: Expo participant app (iOS + Android, one codebase)

Gather is a self-hosted watch-party platform (watch/listen rooms, synced playback,
calls, full chat). Monorepo at `/Users/mg/Desktop/playin` — pnpm + turbo, strict
TS. The api (`services/api`) and shared packages (`@gather/contracts`,
`@gather/sync-core`, `@gather/api-client`, `@gather/p2p`) are DONE and tested.
You are creating the Expo app from scratch — `apps/mobile/` does not exist.

Spec: `/Users/mg/Desktop/playin/BUILD_PROMPT.md` — "Mobile app (Expo, full
participant)" + "Client strategy" sections are binding. DESIGN.md is the visual
language (space-dark, aurora accents, glass) — translate to RN style objects,
not Tailwind.

## ENVIRONMENT HARD RULES (non-obvious, follow exactly)

- Bash is SANDBOXED in the workspace: no writing file data, no mkdir/rm, no
  package installs. Create/modify files ONLY with the Write/Edit tools (Write
  creates parent dirs).
- Run checks in a mirror:
  `rsync -a --delete --exclude='.git' --exclude='.turbo' /Users/mg/Desktop/playin/ /tmp/gates-mobile/`
  then `cd /tmp/gates-mobile && CI=1 pnpm install --no-frozen-lockfile --store-dir /tmp/pnpm-store`.
  Expo dep installs are heavy — do ONE install in the mirror, reuse it.
- NEVER touch anything outside `apps/mobile/`.

## READ FIRST

1. `BUILD_PROMPT.md` mobile + auth + rooms + chat sections.
2. `packages/api-client/src/rest.ts` (`RestClient`), `src/ws.ts` (`RoomSocket`),
   `packages/contracts/src/entities.ts` + `rest.ts` + `ws.ts`.
3. `packages/sync-core/src/index.ts` (what the sync engine exports) — the app
   must reuse it for drift-corrected playback, not reimplement it.
4. `services/api/src/modules/auth/routes.ts` — magic-link flow; on mobile the
   link opens via deep link (document the scheme) but for dev, allow pasting
   the token/link manually.

## OWN (create) — apps/mobile/

```
package.json (@gather/mobile; scripts: start=expo start, android, ios,
  typecheck=tsc --noEmit, lint=eslint . , test=vitest run)
tsconfig.json  app.json (Expo config: name Gather, scheme gather, plugins,
  background audio UIBackgroundModes for iOS, Android permissions+foreground
  service declaration for calls)  babel.config.js  metro.config.js (workspace
  monorepo config: watchFolders = repo root, nodeModulesPaths)  index entry
  per expo-router
app/  (expo-router)
  _layout.tsx        providers (QueryClient, auth), dark theme nav container
  index.tsx          redirect authed ? /home : /login
  login.tsx          email magic link + dev token paste
  home.tsx           my rooms list, create (watch|listen), join-by-code
  room/[id].tsx      the room screen — below
src/
  api.ts             RestClient configured for RN (credentials: 'omit' +
                     getAccessToken from secure store — CHECK
                     packages/api-client/src/rest.ts RestClientOptions for the
                     token seam; auth stores access token in expo-secure-store,
                     refresh via cookie is web-only — for mobile use the
                     Authorization Bearer path if the api supports it: READ
                     services/api/src/plugins/auth.ts and report what it accepts;
                     if Bearer is unsupported, use a tiny fetch wrapper that adds
                     the cookie manually from storage and DOCUMENT it)
  auth.tsx           AuthProvider/useAuth
  room-connection.ts same contract as web (subscribe/send/status) reusing
                     RoomSocket + events.replay gap recovery
  components/ Stage.tsx (Mode A: expo-video player for direct/HLS URLs;
                     YouTube → react-native-webview embed with a documented
                     limitation note), Chat.tsx (list + composer + reactions +
                     replies — markdown-lite, typing indicator), Queue.tsx,
                     People.tsx (presence list w/ speaking ring), CallBar.tsx
                     (join/leave call scaffold via Cloudflare Realtime — if
                     the WebRTC native module adds too much install weight, stub
                     the UI with a clear "native call module" boundary and
                     document; do NOT fake functionality)
  sync/ useSyncEngine.ts — wire sync-core's ClockEstimator + drift correction
                     to the player (beacons over WS initially; the p2p
                     DataChannel path is a documented TODO seam via
                     @gather/p2p types only — do not half-wire it)
  theme.ts           tokens from DESIGN.md translated (colors, radii, spacing,
                     type scale)
tests/               vitest node-env logic tests only (room-connection gap
                     recovery/dedupe, theme invariants) — no RN rendering.
```

Deps (pin current stable): expo SDK 53 line (`expo@^53`, `react@19`,
`react-native@0.79` line — if resolution fights, prefer Expo's recommended
set), `expo-router`, `expo-video`, `expo-secure-store`, `expo-constants`,
`expo-status-bar`, `react-native-safe-area-context`, `react-native-screens`,
`zustand`, `@tanstack/react-query`, `zod`, workspace packages. Add
`vitest` + `typescript` dev deps. Keep the set minimal — every extra native
module is install weight; justify any addition.

## QUALITY BAR / HONESTY

- Full participant: Mode A playback, chat, queue, presence, room management
  MUST be real code against the real contracts. Calls/Mode-B hosting may be
  scaffolded with honest boundaries (the spec itself marks ReplayKit as a
  documented stub, not faked).
- No `any`, strict TS. Typecheck must pass with Expo's TS base.
- metro.config.js must be correct for pnpm workspaces (symlinked packages).
- Do not run `expo prebuild`/native builds (no toolchains in CI).

## ACCEPTANCE (mirror /tmp/gates-mobile)

- `CI=1 pnpm --filter @gather/mobile typecheck` clean
- `CI=1 pnpm --filter @gather/mobile lint` clean
- `CI=1 pnpm --filter @gather/mobile test` green
- Full-repo `pnpm test` + `pnpm typecheck` still green

## REPORT BACK

File tree, what is fully wired vs scaffolded (exact list), the auth transport
finding (Bearer vs cookie on the api), metro/workspace decisions, deviations,
gate results, orchestrator TODOs.
