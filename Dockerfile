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
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------------------------------------------------------------------------
# web — the Next.js server
# ---------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/public ./public
COPY package.json next.config.ts proxy.ts tsconfig.json ./
COPY prisma ./prisma
COPY messages ./messages
COPY src ./src
EXPOSE 3000
USER node
CMD ["pnpm", "start"]

# ---------------------------------------------------------------------------
# worker — BullMQ processors, no HTTP surface
# ---------------------------------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json tsconfig.json ./
COPY prisma ./prisma
COPY messages ./messages
COPY src ./src
COPY scripts ./scripts
USER node
CMD ["pnpm", "worker"]
