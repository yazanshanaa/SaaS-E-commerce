# syntax=docker/dockerfile:1.7
#
# Souq Bartaa — one image, two entrypoints (web + worker).
#
# The worker runs in its OWN container (invariant 8: non-HTTP DB access goes through
# withTenantTxn), but it shares this image because it shares the Prisma client, the demo
# packs and the Sharp pipeline.
#
# fonts-noto-core is NOT optional: Sharp rasterizes SVG through librsvg, which resolves
# fonts from the system. Without an Arabic-capable system font every generated placeholder
# renders Arabic product names as empty boxes (src/server/demo/placeholder.ts).
#
# --- Phase 7: three defects that meant this file had never built ------------------------
#
# 1. The `web` stage copied a root `proxy.ts`. There has never been one — the file is
#    `src/proxy.ts`, already carried by `COPY src ./src`, and Docker fails a multi-source COPY
#    when any source is missing. The reference is gone.
# 2. Both runtime stages copied `/app/node_modules/.prisma`. Under pnpm that path does not
#    exist: `@prisma/client` resolves `.prisma/client` relative to its own real location inside
#    the `.pnpm` content-addressed store, so the generated client lives at
#    `node_modules/.pnpm/@prisma+client@<version>_<hash>/node_modules/.prisma`. Both stages now
#    take the WHOLE `node_modules` from `builder` — the stage that ran `prisma generate` — which
#    carries the client wherever pnpm actually put it, symlinks and all. Copying from `deps` and
#    patching `.prisma` on top would have to know pnpm's hash, which changes with every lockfile.
# 3. No `.dockerignore` existed, so `COPY . .` dropped the host's Windows `node_modules` over the
#    Linux one and baked `.env` into the image. See `.dockerignore` for the full reasoning.

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------------------
# base — system packages shared by every stage
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       fonts-noto-core \
       fontconfig \
       openssl \
       ca-certificates \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install once, reuse for both runtime stages
# ---------------------------------------------------------------------------
#
# Deliberately NOT `--prod`. The runtime images need `prisma` (migrate deploy) and `tsx` (the
# worker's own entrypoint is `tsx src/worker/index.ts`, and the seed and operational scripts are
# TypeScript). Dropping devDependencies would save image size and cost the deployment its ability
# to migrate itself.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder — prisma generate + next build
# ---------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate

# Two variables are read by `next.config.ts` at BUILD time and are therefore baked into the
# output — they are not runtime configuration however much they look like it:
#
#   CDN_PUBLIC_BASE_URL -> `images.remotePatterns`. Built without it, `next/image` ships an empty
#                          allow-list and refuses every CDN host at runtime, on a platform whose
#                          invariant 4 says media is ALWAYS delivered by the CDN.
#   PUBLIC_SCHEME       -> whether `Cross-Origin-Opener-Policy: same-origin` is emitted.
#
# The compose passes both as build args. The default below is the development one, so a bare
# `docker build` still produces a working development image rather than a subtly broken one.
ARG CDN_PUBLIC_BASE_URL
ARG PUBLIC_SCHEME=http
ENV CDN_PUBLIC_BASE_URL=${CDN_PUBLIC_BASE_URL}
ENV PUBLIC_SCHEME=${PUBLIC_SCHEME}

# `src/env.ts` throws on a missing required key, and `next build` runs with NODE_ENV=production.
# These placeholders exist so the BUILD can parse the schema; every one of them is read at
# runtime from the container environment, so nothing here reaches a running deployment. They are
# obviously-fake on purpose — a plausible-looking default is the one that survives into production.
ENV DOMAIN=build.invalid \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    REDIS_URL=redis://127.0.0.1:6379 \
    MAIL_FROM=build@build.invalid \
    BETTER_AUTH_SECRET=YnVpbGQtb25seS1wbGFjZWhvbGRlci1uZXZlci11c2VkIQ== \
    ENCRYPTION_KEY=YnVpbGQtb25seS1wbGFjZWhvbGRlci1uZXZlci11c2VkIQ== \
    WEBHOOK_HMAC_SECRET=YnVpbGQtb25seS1wbGFjZWhvbGRlci1uZXZlci11c2VkIQ==

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------------------------------------------------------------------------
# web — the Next.js server
# ---------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# `--chown` on every copy, because `next start` writes into `.next/cache` for the ISR and fetch
# caches. Root-owned files under `USER node` produce an EACCES at the first revalidation — long
# after the deploy looked successful.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node package.json next.config.ts tsconfig.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node messages ./messages
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

EXPOSE 3000
USER node

# Liveness only, and that is the contract `/internal/health` states: it reports that the PROCESS
# is up and makes no database round trip. A readiness probe that fails when Postgres blinks would
# restart a web server that was about to recover.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/internal/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]

# ---------------------------------------------------------------------------
# worker — BullMQ processors, no HTTP surface
# ---------------------------------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node messages ./messages
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node

# No HTTP surface means no HTTP healthcheck. The worker's liveness is its Redis connection, and
# BullMQ already fails loudly and exits when that is gone — so `restart: unless-stopped` in the
# compose is the whole supervision story. A healthcheck that shelled out to redis-cli would be
# asserting Redis is up, which is a different claim and one Redis's own healthcheck already makes.
CMD ["pnpm", "worker"]
