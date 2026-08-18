> **HISTORICAL (moved 2026-08-18 from `services/api/src/modules/compliance/`).**
> This is the worker brief the compliance module was built from. It is a record
> of *why* that code looks the way it does — the report endpoint being a mailbox
> rather than a moderator, anonymize-don't-hard-delete so message author ids stay
> referable, and the grace period the frozen `StorePort` had nowhere to persist
> — and nothing more. **Do not build from it.** It is written in the imperative
> ("you fill in ONE stub module", "BUILD") because it was an agent prompt;
> sitting in a live module directory it read as standing orders, which is why it
> moved.
>
> Four things in it are dead, and two of them would not even compile:
>
> - **§READ FIRST lists a `subscriptions` collection on `StorePort`.** There is
>   no such collection. Billing was deleted; see
>   `services/api/test/no-billing.test.ts`.
> - **§BUILD 2 tells the export to include "subscription".**
>   `MeExportResponse` has no such field — it is `exportedAt`, `user`, `rooms`,
>   `messages`, `playlists`, `assets`, and the optional `playbackHistory` /
>   `usage`. Adding one would fail the contract parse the export is validated
>   against.
> - **§BUILD 3 tells erasure to "delete … subscription row".** Nothing to
>   delete. `erasure.ts` cascades memberships, push subs, sessions and
>   playlists, tombstones authored messages and anonymizes the user doc.
> - **§BUILD 3's bracketed reasoning** — the "STOP", the "no — cleanest within
>   the frozen port" self-argument, the "if you found a place to track purgeAt"
>   hedge in §4 — is a decision being made out loud, not an instruction. It was
>   decided: `erasure.ts` keeps an in-process `pendingPurges` registry with an
>   unref'd sweeper, and its own header states that trade (the registry does not
>   survive a restart). Read the file, not the deliberation.
>
> §ENVIRONMENT HARD RULES (sandbox, `/tmp/gates-compliance` rsync mirror) was
> one agent's setup on one day; gates run in the repo now. Everything else still
> describes live behaviour. Current docs: `README.md`, `HANDOFF.md`.

# K3 Brief — compliance module: report + GDPR export/delete

Gather is a self-hosted watch-party platform (pnpm + turbo monorepo, TS strict).
Read the "Safeguards & compliance" section of
`/Users/mg/Desktop/playin/BUILD_PROMPT.md` — BINDING. The API skeleton (Fastify 5,
module-plugin seam) is complete and tested; you fill in ONE stub module.

Working directory: `/Users/mg/Desktop/playin/services/api/src/modules/compliance`.
Repo root: `/Users/mg/Desktop/playin`.

## ENVIRONMENT HARD RULES (non-obvious, follow exactly)

- Bash is SANDBOXED in the workspace: no writing file data, no mkdir/rm, no
  package installs. Create/modify files ONLY with the Write/Edit tools.
- Run checks in a mirror:
  `rsync -a --delete --exclude='.git' --exclude='.turbo' /Users/mg/Desktop/playin/ /tmp/gates-compliance/`
  then `cd /tmp/gates-compliance`. If you must add a dependency (prefer zero
  new deps), `CI=1 pnpm install --store-dir /tmp/pnpm-store` in the mirror.

## OWNERSHIP

ONLY `services/api/src/modules/compliance/`. No new dependencies unless truly
unavoidable. Everything else frozen; `src/modules/index.ts` already registers
this module.

## READ FIRST

- `services/api/src/modules/types.ts`, `modules/rooms/service.ts`,
  `modules/chat/routes.ts` (patterns), `services/api/src/adapters/ports.ts`
  (StorePort: `reports`, `users`, `sessions`, `members`, `messages`, `rooms`,
  `cursors`, `playlists`, `assets`, `pushSubs`, `subscriptions`, `usage`),
  `services/api/src/lib/errors.ts`, `services/api/src/plugins/auth.ts`.
- Contracts: `packages/contracts/src/rest.ts` — `ReportBody`, `ReportResponse`,
  `MeExportResponse`, `DeleteMeResponse`; the `rest` map for exact paths.

## BUILD

Replace placeholder `index.ts` (keep default-export shape, `name: 'compliance'`).
Files: `routes.ts`, `service.ts`, `export.ts`, `erasure.ts`, colocated tests.

1. `POST /report` (auth; body `ReportBody`) → persist a `reports` row,
   return `ReportResponse` with the report id. Validate that the target exists
   (user/room/message per `ReportTarget` discriminator). Rate-limit note: the
   global rate limit plugin already covers floods — do NOT add content filtering
   (spec forbids it); this endpoint is a mailbox, not a moderator.
2. `GET /me/export` (auth) → `MeExportResponse`: full JSON export of the user's
   data — profile, sessions (device/lastSeen only, never token hashes), rooms
   (memberships + rooms they host), messages they authored (include roomId,
   redact nothing of their own), playlists, assets, subscription, push subs
   (strip keys? NO — it's their data; include endpoint+keys), usage aggregates.
   Assemble from the store; shape must satisfy the contract exactly.
3. `DELETE /me` (auth) → schedule account erasure with a grace period:
   `DeleteMeResponse.purgeAt` = now + 7 days.
   - Immediately: revoke ALL sessions (set `revokedAt`), so tokens die.
   - Mark the user doc `deletionRequestedAt: now, purgeAt` — CHECK whether the
     `User` contract entity has these fields; if not, store the pending erasure
     in a way that fits (e.g. a `reports`-style internal doc is wrong — use the
     `users` doc with a patch ONLY if the store type allows extra server-side
     fields like AssetDoc does; `UserDoc = User` is exact, so instead track
     pending purges in `usage`? no — cleanest within the frozen port: delete
     immediately but keep the grace contract by... STOP. If the port truly has
     no place for purge scheduling, implement: anonymize + delete NOW except
     authored messages which get tombstoned, and document the deviation).
   - Erasure semantics (cascade): remove memberships (leave rooms; if host,
     run the same host-handoff path the rooms module uses on leave — if that's
     not exported, replicate minimal logic: transfer to longest-tenured
     moderator/member, else close room), delete push subs, sessions,
     subscription row, playlists; tombstone authored messages (deletedAt set,
     body cleared — follow the chat module's tombstone shape, read
     `modules/chat/service.ts`); anonymize the user doc (email null,
     displayName 'Deleted user', avatar null) rather than hard-deleting so
     foreign keys (message author ids) stay referable.
   - Auth edge: `DELETE /me` with a guest token → 403 (guests are room-scoped,
     ephemeral; there is no account to erase — or support it by deleting the
     guest user doc entirely; pick the contract-honoring option).
4. Pending-purge sweeper: an unref'd interval (5 min) that hard-purges users
   whose purgeAt passed (if you found a place to track purgeAt); otherwise omit
   and document.

## TESTS (vitest, memory store)

- report: each target kind, unknown target → 404, validation errors → 400.
- export: seeded user with data across collections → contract-valid payload,
  no `refreshHash` anywhere in the JSON string.
- delete: sessions revoked immediately, memberships removed, host handoff or
  room close, messages tombstoned, user anonymized; subsequent auth with old
  credentials fails.

## ACCEPTANCE (mirror)

- `CI=1 pnpm --filter gather-api typecheck` clean
- `CI=1 npx eslint services/api/src/modules/compliance` clean
- `CI=1 pnpm --filter gather-api test` green (existing suites must not break)

## REPORT BACK

Files changed, routes, deviations from contract (with exact reasons), how purge
scheduling was solved, gate results, anything to wire.
