# syntax=docker/dockerfile:1.7

# ---- Stage 1: compile TypeScript to plain JS -------------------------------
FROM node:22-alpine AS build
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Remove dev-only dependencies (none currently needed at runtime, but the
# install above pulled vitest etc. — strip them so the runtime stage stays slim)
RUN npm prune --omit=dev


# ---- Stage 2: runtime image ------------------------------------------------
# caddy:2-alpine ships the static `caddy` binary plus an Alpine userland.
# Node.js comes from the Alpine repos so we can run the compiled orchestrator.
FROM caddy:2-alpine

RUN apk add --no-cache nodejs

WORKDIR /opt/portal
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json

# fs_overlay carries the entrypoint script and any other runtime assets.
COPY fs_overlay /

RUN chmod +x /usr/local/bin/portal /usr/local/bin/entrypoint

# Persistent Caddy data — preserve the original https-portal volume path so
# existing compose files keep working.
VOLUME /var/lib/https-portal

EXPOSE 80 443 443/udp

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:2019/config/ || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint"]
