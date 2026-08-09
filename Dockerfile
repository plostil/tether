# Tether signaling broker image. Build from the repo root:
#   docker build -t tether-broker .
#
# The broker has ZERO external runtime dependencies; @tether/protocol is a
# workspace package resolved by symlink. We run the TypeScript directly on
# Node 24 (native type-stripping), so there is no build/transpile step.

# ---- deps: create the workspace symlinks (no external packages to fetch) ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/reference-cli/package.json apps/reference-cli/package.json
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/protocol ./packages/protocol
COPY apps/server ./apps/server

EXPOSE 8080
USER node

# Lightweight liveness probe against /health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
