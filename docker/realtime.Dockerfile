# ========================================
# Base Stage: Alpine Linux with Bun
# ========================================
FROM oven/bun:1.4.2-alpine AS base

# libc6-compat for Bun native addons; curl for runtime health/egress helpers.
# apk upgrade pulls Alpine security fixes called out by container scans
# (curl/libcurl, libcrypto3/libssl3, musl, zlib) without floating the base tag.
RUN apk add --no-cache libc6-compat curl \
    && apk upgrade --no-cache

# ========================================
# Pruner Stage: Emit a minimal monorepo subset that @sim/realtime depends on
# ========================================
FROM base AS pruner
WORKDIR /app

COPY . .

RUN TURBO_VERSION="$(bun -e "console.log(require('./package.json').devDependencies.turbo)")" && \
    bunx --bun "turbo@${TURBO_VERSION}" prune @sim/realtime --docker

# ========================================
# Dependencies Stage: Install Dependencies
# ========================================
FROM base AS deps
WORKDIR /app

COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock

RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --linker=hoisted --omit=dev --ignore-scripts

# ========================================
# Runner Stage: Run the Socket Server
# ========================================
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3002 \
    HOSTNAME="0.0.0.0"

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

COPY --from=deps --chown=nextjs:nodejs /app ./
COPY --from=pruner --chown=nextjs:nodejs /app/out/full/ ./

USER nextjs

EXPOSE 3002

CMD ["bun", "apps/realtime/src/bootstrap.ts"]
