# Multi-arch container image for the 1.0.0 self-hosted deployment (#191,
# ADR-51). Build with buildx so linux/arm64 (Raspberry Pi) and linux/amd64
# both get a correct better-sqlite3 native binary:
#
#   docker buildx build --platform linux/amd64,linux/arm64 -t draw:latest .
#
# The runtime is tsx (ADR-49): there is no compiled server JS. The image ships
# node + tsx + server/src + client/dist + the pruned node_modules (which holds
# the arch-matched better-sqlite3 .node), and runs `src/prod.ts`.

# ---- Builder: install per-arch deps and build the client -------------------
# Full (non-slim) image so better-sqlite3 can compile from source when no
# prebuilt binary exists for the target ABI. Under buildx this stage runs AS
# the target arch (native amd64, arm64 via QEMU), so the binary it produces
# matches the runtime stage below.
FROM node:22-bookworm AS builder

# Informational only — the real cross-arch build is buildx emulation, not
# cross-compilation. Handy in `docker buildx build --progress=plain` logs.
ARG TARGETPLATFORM
ARG BUILDPLATFORM
RUN echo "building for ${TARGETPLATFORM:-native} on ${BUILDPLATFORM:-native}"

WORKDIR /app

# Manifests first so `npm ci` is cached until a dependency actually changes.
# All workspace package.json files are needed to reproduce the lockfile tree.
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# Full install (incl. devDependencies): vite + tsc to build the client, and
# better-sqlite3's build toolchain. `npm ci` runs the native install script
# for this stage's architecture.
RUN npm ci

# Sources (the .dockerignore keeps node_modules, client/dist, data, tests and
# docs out of the context).
COPY . .

# Bundle the client to client/dist (vite). The server "build" is `tsc
# --noEmit` (ADR-49) — a type check that emits nothing — so there is nothing
# to compile for the server; tsx runs the TypeScript directly at runtime.
RUN npm run build -w client

# Drop devDependencies from node_modules. better-sqlite3, tsx, express &c. are
# runtime deps and survive with their compiled binary intact; client/dist is a
# file artifact and is untouched by prune.
RUN npm prune --omit=dev

# ---- Runtime: slim glibc image, non-root, tsx -------------------------------
# bookworm-slim = Debian glibc, matching the builder's ABI so the compiled
# better-sqlite3 binary loads. NOT alpine/musl (better-sqlite3 has no musl
# prebuild and we would have to build against musl).
FROM node:22-bookworm-slim AS runtime

# Deterministic identity for the running server. Ordinary local builds retain
# truthful defaults; release automation supplies the checked-out commit.
ARG DRAW_BUILD_CHANNEL=local
ARG DRAW_BUILD_SHA=

# tini as PID 1: forwards SIGTERM to the server for a clean, prompt shutdown
# and reaps any stray children. Makes the image behave well under a bare
# `docker run` too, not only with `--init`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # Serve the client build copied below (prod.ts fails loud if it is missing).
    CLIENT_DIR=/app/client/dist \
    # Expose on the container network — the whole point of the container
    # (ADR-49). Pair with DRAW_PASSWORD on a real LAN (ADR-50).
    HOST=0.0.0.0 \
    API_PORT=3001 \
    DRAW_BUILD_CHANNEL=${DRAW_BUILD_CHANNEL} \
    DRAW_BUILD_SHA=${DRAW_BUILD_SHA} \
    # All persistent state on the mounted volume, not the writable layer.
    DATA_DIR=/data

WORKDIR /app

# Pruned deps + sources + built client, owned by the unprivileged `node` user
# (uid 1000) that ships in the base image.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/server ./server
COPY --from=builder --chown=node:node /app/shared ./shared
COPY --from=builder --chown=node:node /app/client/dist ./client/dist

# The DATA_DIR mount point, pre-owned by `node` so a fresh named volume
# inherits that ownership (Docker seeds an empty volume from the image path).
RUN mkdir -p /data && chown node:node /data

VOLUME ["/data"]
EXPOSE 3001

USER node
WORKDIR /app/server

# Liveness against the existing /api/health, which sits ABOVE the password
# gate (app.ts) so this stays green even with DRAW_PASSWORD set. Uses node's
# global fetch — no curl/wget in the slim image. Hits loopback inside the
# container (the server binds 0.0.0.0, which includes it).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node","-e","const p=process.env.API_PORT||3001;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The ADR-49 production runtime, invoked as a single node process (tsx as an
# import loader) so tini can signal it directly — no npm/tsx wrapper layer in
# between. Equivalent to `npm start` (`tsx src/prod.ts`).
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/prod.ts"]
