# syntax=docker/dockerfile:1
# ── Playin API (Fastify 5 — REST + room WebSocket) ───────────────────────────
# Build context MUST be the REPO ROOT (infra/docker-compose.yml sets
# `context: ..`), because this is a full-workspace pnpm build:
#
#   docker build -f services/api/Dockerfile .
#
# STRATEGY — simple full-workspace build, NOT `turbo prune`, on purpose: with
# three small services sharing the same packages/* deps, pruned graphs would be
# nearly identical to the full workspace; simple keeps all Dockerfiles uniform.
# See apps/web/Dockerfile for the full rationale.

FROM node:22-alpine AS base
# corepack-free by design: pin pnpm via npm instead.
RUN npm i -g pnpm@11

# ── Build stage ───────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY . .
# Belt-and-braces: .dockerignore already excludes .env*, but secrets must
# never survive into a layer even if the ignore file is edited or bypassed.
RUN rm -f .env .env.*
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
# Build the API plus its workspace dependencies (contracts, sync-core, …).
# --fail-if-no-match: fail the image build loudly if the service package does
# not exist yet, instead of shipping a no-op container.
RUN pnpm --filter ./services/api... --fail-if-no-match run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=4000
RUN apk add --no-cache curl
COPY --from=builder --chown=node:node /app /app
USER node
EXPOSE 4000
# Contract (see infra/README.md): the API serves GET /healthz → 200.
# infra/docker-compose.yml runs the same probe for depends_on conditions.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/healthz || exit 1
# Expects services/api/package.json to define a `start` script (node dist/…).
CMD ["pnpm", "--filter", "./services/api", "--fail-if-no-match", "start"]
