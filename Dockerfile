# =============================================================================
# Stage 1 — Build dashboard (React + Vite)
# =============================================================================
FROM node:20-alpine AS dashboard-build

WORKDIR /app/dashboard

# Install deps first (separate layer — cached unless package.json changes)
COPY dashboard/package*.json ./
RUN npm ci

# Copy source and build
# vite.config.ts sets outDir: "../dist/dashboard" → output lands at /app/dist/dashboard
COPY dashboard/ ./
RUN npm run build

# =============================================================================
# Stage 2 — Build server (TypeScript → JS)
# =============================================================================
FROM node:20-alpine AS server-build

WORKDIR /app

# Install all deps (dev included — TypeScript compiler is a devDependency)
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build:server

# Strip dev dependencies so node_modules is production-only for the final image
RUN npm prune --production

# =============================================================================
# Stage 3 — Production image
# =============================================================================
FROM node:20-alpine

WORKDIR /app

# Copy compiled server
COPY --from=server-build /app/dist ./dist

# Copy built dashboard into the path the server expects
COPY --from=dashboard-build /app/dist/dashboard ./dist/dashboard

# Copy production node_modules
COPY --from=server-build /app/node_modules ./node_modules

# Copy package.json (needed by some runtime introspection)
COPY --from=server-build /app/package.json ./

# Create data directory for SQLite and set ownership before dropping privileges
RUN mkdir -p /app/data && chown -R node:node /app

# Entrypoint that fixes volume permissions then drops to node user
RUN printf '#!/bin/sh\nchown -R node:node /app/data\nexec su-exec node node dist/index.js\n' > /app/entrypoint.sh \
  && chmod +x /app/entrypoint.sh \
  && apk add --no-cache su-exec

EXPOSE 4100

# Healthcheck against the dedicated /health endpoint (no curl needed on Alpine)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget --spider -q http://localhost:4100/health || exit 1

CMD ["/app/entrypoint.sh"]
