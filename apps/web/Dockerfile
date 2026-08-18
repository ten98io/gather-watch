# syntax=docker/dockerfile:1
# ── Gather web (Next.js 15) ───────────────────────────────────────────────────
# Build context MUST be the REPO ROOT (infra/docker-compose.yml sets
# `context: ..`), because this is a full-workspace pnpm build:
#
#   docker build -f apps/web/Dockerfile .
#
# STRATEGY — simple full-workspace build, NOT `turbo prune`, on purpose:
# turbo prune buys smaller build contexts and tighter cache keys, but costs a
# two-phase json/full copy dance and a pruned lockfile per app. With two small
# services sharing the same packages/* deps, the pruned graphs would be nearly
# identical to the full workspace anyway. Simple keeps both Dockerfiles
# uniform and boring; revisit only if context size or cache-miss build times
# become a real problem.
#
# The repo-root .dockerignore keeps .git, node_modules, build output and all
# .env* files out of this context — do not remove it.

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
RUN --mount=type=cache,id=s/bbe6d6c1-5dcf-4426-bb94-f7d023060230-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
# Build the web app plus its workspace dependencies (packages/*), in
# topological order. Directory filters avoid hardcoding package names.
# --fail-if-no-match: an image built before the app package exists must fail
# loudly at build time, not ship a no-op container that restart-loops.
ENV NEXT_TELEMETRY_DISABLED=1
# ── NEXT_PUBLIC_* ─────────────────────────────────────────────────────────────
# These are INLINED into the client bundle at `next build` time, so a value
# supplied at container start does nothing at all — Railway (and plain
# docker build) only reach the build through declared ARGs. An undeclared one
# does not fail: it silently ships whatever fallback the source has, which is
# how an image ends up telling every visitor's browser to call
# http://localhost:4000.
#
# EVERY variable the web app reads must be listed here. Adding a
# `process.env.NEXT_PUBLIC_*` read in apps/web without adding it below is the
# bug this block exists to prevent, and
# services/api/test/web-dockerfile-env.test.ts fails when the two drift.
#
#   NEXT_PUBLIC_API_URL                       REQUIRED — apps/web/lib/api.ts
#   NEXT_PUBLIC_GATHER_EXTENSION_ID           optional — pins the extension id
#                                             (apps/web/lib/extension-bridge.ts);
#                                             unset, the content script still
#                                             announces its own id
#   NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL  optional — install-funnel link
#                                             (apps/web/lib/player/extension-driver.ts);
#                                             unset, it is derived from the id
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_GATHER_EXTENSION_ID
ARG NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_GATHER_EXTENSION_ID=${NEXT_PUBLIC_GATHER_EXTENSION_ID} \
    NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL=${NEXT_PUBLIC_GATHER_EXTENSION_INSTALL_URL}
# Fail HERE, where the message can name the variable. The alternative is an
# image that builds, deploys, goes green, and is broken only in the browser.
RUN if [ -z "$NEXT_PUBLIC_API_URL" ]; then \
      echo "ERROR: build arg NEXT_PUBLIC_API_URL is required." >&2; \
      echo "  It is inlined into the client bundle at build time; without it the" >&2; \
      echo "  shipped site calls http://localhost:4000 from every visitor's browser." >&2; \
      echo "  docker build --build-arg NEXT_PUBLIC_API_URL=https://api.example.com ..." >&2; \
      exit 1; \
    fi
RUN pnpm --filter '{./apps/web}...' --fail-if-no-match run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache curl
# Whole built workspace (simple-build tradeoff: bigger image, zero surprises
# with pnpm's symlinked node_modules). node = the stock non-root user (uid 1000).
COPY --from=builder --chown=node:node /app /app
RUN chown node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/ || exit 1
# Expects apps/web/package.json to define a `start` script (`next start`).
CMD ["pnpm", "--filter", "./apps/web", "--fail-if-no-match", "start"]
