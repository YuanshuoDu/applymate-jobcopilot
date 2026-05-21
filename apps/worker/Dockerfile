# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

# Copy workspace config and lockfile
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY apps/worker/package.json apps/worker/tsconfig.json apps/worker/

# Install deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/src packages/shared/src/
COPY apps/worker/src apps/worker/src/

# Build
RUN pnpm --filter worker build

# Stage 2: Runtime
FROM node:22-slim AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

# Install only production deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile --prod

# Copy built output
COPY --from=builder /app/apps/worker/dist apps/worker/dist/

# CloakBrowser will be downloaded at first launch via the cloakbrowser npm postinstall
ENV CLOAK_MAX_WORKERS=1
ENV CLOAK_PROFILES_DIR=/data/cloak-profiles

RUN mkdir -p /data/cloak-profiles
VOLUME ["/data"]

CMD ["node", "apps/worker/dist/index.js"]
