# Multi-stage build for Spine on Cloud Run.
#
# Stage 1 builds the Vite frontend. Stage 2 is the runtime image —
# Node 20 + tsx for direct .ts execution, the full source tree, the
# built frontend, and the Kuzu DB baked in. Single container serves
# /api/*, /mcp, and / (static frontend) on $PORT.
#
# Build size is dominated by node_modules (~250MB) + the Kuzu DB
# (~200MB, varies). Cold start ~5–10s; set --min-instances=1 if you
# need hot.
#
# IMPORTANT: build this in an amd64 environment (Cloud Build does
# this by default). The kuzu native binding is arch-specific, so
# building on Apple Silicon and pushing direct to Cloud Run will
# fail at runtime. Use `gcloud builds submit` (per deploy.sh) or
# `docker buildx build --platform=linux/amd64`.

# ──────────────── Stage 1: build the Vite frontend ────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app

# Copy the workspace skeleton first so the install layer caches well.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/schema/package.json packages/schema/
COPY packages/graph/package.json packages/graph/
COPY packages/cache/package.json packages/cache/
COPY packages/resolver/package.json packages/resolver/
COPY packages/extractor/package.json packages/extractor/
COPY packages/adapters/package.json packages/adapters/

# Install everything (workspace deps included). Need devDeps here for
# the Vite build.
RUN npm install --include-workspace-root --no-audit --no-fund

# Copy sources and build.
COPY apps/web apps/web
COPY packages packages

RUN npm run -w @spine/web build


# ──────────────── Stage 2: runtime ────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Same skeleton install for runtime — keeps tsx available for direct
# .ts execution. We deliberately install with devDeps because the
# server runs TypeScript via tsx, and several workspace packages
# import other workspace packages by their .ts entry points.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/schema/package.json packages/schema/
COPY packages/graph/package.json packages/graph/
COPY packages/cache/package.json packages/cache/
COPY packages/resolver/package.json packages/resolver/
COPY packages/extractor/package.json packages/extractor/
COPY packages/adapters/package.json packages/adapters/
RUN npm install --include-workspace-root --no-audit --no-fund

# Server source.
COPY apps/api apps/api
COPY packages packages

# Built frontend from stage 1.
COPY --from=frontend-build /app/apps/web/dist apps/web/dist

# Kuzu DB baked into the image. ~200MB. Read-only at runtime in this
# deployment shape (Cloud Run filesystem is ephemeral; conflict
# resolution writes persist within the running instance and die at
# restart). For the hackathon demo this is the right tradeoff —
# graph state is reproducible from the dataset on disk.
COPY data/spine.db data/spine.db

# Cloud Run sets $PORT (default 8080). Default to that; SPINE_PORT
# wins if explicitly set.
ENV NODE_ENV=production
ENV PORT=8080
ENV SPINE_PORT=8080
ENV SPINE_DB=/app/data/spine.db
ENV SPINE_STATIC_DIR=/app/apps/web/dist

EXPOSE 8080

# Use tsx so we don't have a separate TypeScript build step in the
# image. tsx ships in devDependencies but the runtime install above
# keeps it.
CMD ["node", "--import=tsx", "apps/api/src/server.ts"]
