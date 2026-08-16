# syntax=docker/dockerfile:1
# ── Gather media worker (in-process serial queue + ffmpeg → HLS → MinIO) ─────
# NOTE: processing is an in-process promise chain — run ONE replica per deploy.
# Scaling replicas breaks the serial-execution premise (no distributed lock).
# Build context MUST be the REPO ROOT (infra/docker-compose.yml sets
# `context: ..`), because this is a full-workspace pnpm build:
#
#   docker build -f services/media/Dockerfile .
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
RUN --mount=type=cache,id=s/ebb4dbbe-5d8e-4b25-9296-a754fc161d8e-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
# Build the media service plus its workspace dependencies.
# --fail-if-no-match: fail the image build loudly if the service package does
# not exist yet, instead of shipping a no-op container.
RUN pnpm --filter '{./services/media}...' --fail-if-no-match run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    MEDIA_PORT=4500 \
    FFMPEG_PATH=ffmpeg
# ffmpeg: the whole point of this image. curl: healthcheck probe.
RUN apk add --no-cache ffmpeg curl
COPY --from=builder --chown=node:node /app /app
RUN chown node:node /app
USER node
EXPOSE 4500
# Contract (see infra/README.md): the media worker serves a minimal
# GET /healthz → 200 on MEDIA_PORT (default 4500) alongside its queue loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:${MEDIA_PORT:-4500}/healthz || exit 1
# Expects services/media/package.json to define a `start` script (node dist/…).
CMD ["pnpm", "--filter", "./services/media", "--fail-if-no-match", "start"]
