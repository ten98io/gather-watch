# K3 Brief — billing module: Stripe + entitlements + usage metering

Gather is a self-hosted watch-party platform (pnpm + turbo monorepo, TS strict).
Read `/Users/mg/Desktop/playin/BUILD_PROMPT.md` — "Plans & monetization" and the
billing paragraph under the topology pivot are BINDING. The API skeleton
(Fastify 5, module-plugin seam) is complete and tested; you fill in ONE stub
module.

Working directory: `/Users/mg/Desktop/playin/services/api/src/modules/billing`.
Repo root: `/Users/mg/Desktop/playin`.

## ENVIRONMENT HARD RULES (non-obvious, follow exactly)

- Bash is SANDBOXED: in the workspace it cannot write file data, mkdir, rm, or
  install packages. Create/modify files ONLY with the Write/Edit tools.
- Run checks in a mirror:
  `rsync -a --delete --exclude='.git' --exclude='.turbo' /Users/mg/Desktop/playin/ /tmp/gates-billing/`
  then `cd /tmp/gates-billing`. After adding a dependency:
  `CI=1 pnpm install --store-dir /tmp/pnpm-store` in the mirror.
- Never write project files outside your owned paths.

## OWNERSHIP

- ONLY `services/api/src/modules/billing/`. You MAY add ONE dependency
  (`stripe`, current v17/18.x) to `services/api/package.json` via Edit.
- Everything else frozen. `src/modules/index.ts` already registers this module.

## READ FIRST

- `services/api/src/modules/types.ts` (ModulePlugin, Deps), `modules/rooms/service.ts`
  + `modules/chat/routes.ts` (patterns), `services/api/src/adapters/ports.ts`
  (`subscriptions`, `usage` collections + DocCollection semantics),
  `services/api/src/config.ts` (`config.stripe.*`),
  `services/api/src/lib/errors.ts`, `services/api/src/plugins/auth.ts`.
- Contracts: `packages/contracts/src/rest.ts` — `CreateCheckoutSessionBody`,
  `CreateCheckoutSessionResponse`, `CreatePortalSessionResponse`,
  `GetEntitlementsResponse`; the `rest` map at the bottom for route paths.
  Check `packages/contracts/src/entities.ts` for `Subscription` if present.

## BUILD

Replace placeholder `index.ts` (keep default-export shape, `name: 'billing'`).
Files: `routes.ts`, `service.ts` (Stripe client wrapper — injectable for tests),
`entitlements.ts`, `webhook.ts`, plus colocated `*.test.ts`.

1. `POST /billing/checkout-session` (auth, body `CreateCheckoutSessionBody`) →
   Stripe Checkout (subscription mode, price = `config.stripe.pricePremiumMonthly`,
   customer created/reused from the user's `subscriptions` row, success/cancel
   URLs from `config.appUrl`). → `CreateCheckoutSessionResponse`.
2. `POST /billing/portal-session` (auth) → Stripe billing portal session.
   404-ish AppError when the user has no Stripe customer yet.
3. `POST /billing/webhooks/stripe` — PUBLIC (no auth plugin requirement — check
   how auth plugin marks public routes; follow the pattern other public routes
   use, e.g. auth routes). CRITICAL: signature verification needs the RAW body.
   Fastify parses JSON globally — inspect how the app registers content parsers
   (`src/app.ts`) and, if there is no raw-body seam, register a route-level
   `config` + a custom parser scoped to this route's content type pattern ONLY
   inside your module (fastify `addContentTypeParser` inside your plugin scope
   is encapsulated). Handle: `checkout.session.completed`,
   `customer.subscription.updated`, `customer.subscription.deleted` → upsert
   `subscriptions` doc (plan/status/stripe ids/currentPeriodEnd/updatedAt).
   Invalid signature → 400 AppError. Unknown event types → 200 ignored.
4. `GET /billing/entitlements` (auth) → `GetEntitlementsResponse` built from the
   `subscriptions` row (absent = free plan defaults). NO Stripe calls here —
   billing state lives in Mongo; Stripe is only touched by checkout/portal/webhook.
5. Entitlement helper used by room policy evaluation later:
   `getCaps(deps, userId)` → `{ theaterMode: boolean; maxAvPublishers: number;
   maxShareViewers: number; turnUncapped: boolean; uploadQuotaGb: number }`
   (free: theaterMode false, 6 publishers, 8 viewers, turn capped, quota =
   `config.storageQuotaGb`; premium active: theaterMode true, 12/50+, uncapped,
   4x quota). Export it from the module for the orchestrator to wire into rooms.
6. `POST /billing/usage` (auth) — usage metering ingest: client getStats
   samples `{ roomId, kind, amount, unit, meta? }` → insert `usage` docs.
   Validate with zod locally (no contract exists — keep the body schema in your
   module and EXPORT it for a later contracts promotion). Rate-limit friendly:
   reject absurd amounts (negative, > 1 TB/day equivalents).

When `config.stripe.secretKey` is null: checkout/portal/webhook return
AppError('SERVICE_UNAVAILABLE' or similar existing code — check errors.ts for
the codes in use), entitlements still works (free defaults). Entitlements and
usage routes must NEVER import the Stripe SDK at module top level in a way that
breaks boot without keys — construct the client lazily.

## TESTS (vitest, memory store, fake Stripe client — inject it)

- entitlements: free default, premium active, canceled falls back to free.
- webhook: valid signature updates the subscription row (construct the payload +
  sign it with the webhook secret in-test), bad signature → 400, unknown event
  → ignored 200.
- usage: happy path insert; negative/absurd rejection.
- checkout/portal without Stripe configured → clean error, not a crash.

## ACCEPTANCE (mirror)

- `CI=1 pnpm --filter gather-api typecheck` clean
- `CI=1 npx eslint services/api/src/modules/billing` clean
- `CI=1 pnpm --filter gather-api test` green

## REPORT BACK

Files changed, routes, webhook raw-body approach (exact mechanism), the usage
body schema you defined (full zod source), gate results, anything to wire.
