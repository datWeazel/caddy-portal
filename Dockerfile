# syntax=docker/dockerfile:1.7

# ---- Stage 1: compile TypeScript to plain JS -------------------------------
# Runs on the build host's platform: the output is plain JS and the runtime
# dependencies are pure JS, so nothing here is architecture-specific. This
# also covers linux/arm/v7, for which node:24-alpine publishes no image.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies for the runtime image
RUN npm prune --omit=dev


# ---- Stage 2: fetch architecture-specific docker-gen binary ----------------
# Releases at https://github.com/nginx-proxy/docker-gen/releases publish two
# Linux flavours: glibc-linked `docker-gen-linux-*` and musl-linked
# `docker-gen-alpine-linux-*`. Our runtime is Caddy's alpine image (musl), so we
# pull the alpine variants. The arch names differ from buildx's TARGETPLATFORM:
# arm v7 is named `armhf` in the docker-gen releases.
FROM alpine:3.24 AS docker-gen
ARG TARGETPLATFORM
ARG DOCKER_GEN_VERSION=0.17.2

RUN apk add --no-cache wget tar ca-certificates && \
    case "${TARGETPLATFORM}" in \
      linux/amd64)  ARCH=amd64 ;; \
      linux/arm64)  ARCH=arm64 ;; \
      linux/arm/v7) ARCH=armhf ;; \
      *) echo "Unsupported TARGETPLATFORM: ${TARGETPLATFORM}" && exit 1 ;; \
    esac && \
    wget -q "https://github.com/nginx-proxy/docker-gen/releases/download/${DOCKER_GEN_VERSION}/docker-gen-alpine-linux-${ARCH}-${DOCKER_GEN_VERSION}.tar.gz" \
         -O /tmp/docker-gen.tar.gz && \
    tar -xzf /tmp/docker-gen.tar.gz -C /usr/local/bin docker-gen && \
    rm /tmp/docker-gen.tar.gz


# ---- Stage 3: runtime image ------------------------------------------------
# The Caddy alpine image ships the static `caddy` binary plus an Alpine
# userland. Pinned to an exact version: Caddy patch releases have changed
# request handling defaults before, so upgrades should arrive via PR.
FROM caddy:2.11.7-alpine

RUN apk add --no-cache nodejs

WORKDIR /opt/portal
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json
COPY --from=docker-gen /usr/local/bin/docker-gen /usr/local/bin/docker-gen

# fs_overlay carries entrypoint scripts and the docker-gen template
COPY fs_overlay /

RUN chmod +x /usr/local/bin/portal /usr/local/bin/entrypoint

# Persistent Caddy data — preserve the original https-portal volume path so
# existing compose files keep working.
VOLUME /var/lib/https-portal

EXPOSE 80 443 443/udp

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:2019/config/ || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint"]
