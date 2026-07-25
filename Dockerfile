# Ops Dashboard v3 — zero-dependency Node server. No build step: the image just needs the
# runtime + this package's own files copied in.
FROM node:22-alpine

# v3.1 container-hardening (owner directive: Docker is the PRIMARY deployment mode, not just a
# verification checkbox — harden it for real). node:22-alpine ships NO git binary at all — every
# lib/git-status.mjs call is already try/catch-guarded (graceful degradation, confirmed by reading
# the source: execFileSync wrapped in gitSafe()'s try/catch), so a missing git does NOT crash the
# server, but the entire Git tab + the Overview's unpushed-commit KPI silently go empty for any
# LOCAL-mode container watching a bind-mounted repo. One line fixes real functionality, not just a
# theoretical gap — verified this session: git status/log/branch/tag all return real data
# in-container after this line, where they returned nothing before it.
RUN apk add --no-cache git

RUN addgroup -S opsdash && adduser -S opsdash -G opsdash
WORKDIR /app

COPY package.json VERSION ./
COPY server.mjs ./
COPY lib ./lib
COPY public ./public

# config.json / data/ are runtime state — created on first run inside the container, persisted via
# the compose volume mounts (see docker-compose.yml). Not baked into the image.
RUN mkdir -p /app/data && chown -R opsdash:opsdash /app

USER opsdash
EXPOSE 4650
ENV NODE_ENV=production

# v3.1 container-hardening — HEALTHCHECK. Alpine's busybox always ships `wget` (unlike `curl`,
# which is NOT present by default and would need its own apk line just for this).
#
# v3.2 DIAGNOSIS + FIX (a real bug, not theoretical): this originally targeted /api/state, which
# is gated by the SAME auth every business route uses. Any deployment with DASH_TOKEN set — which
# docker-compose.hub.yml REQUIRES — made this in-container `wget` (no Authorization header) get a
# 401, and wget treats a non-2xx response as a check FAILURE. Result: `docker inspect` reported
# "unhealthy" even though the server was perfectly alive and serving every route correctly —
# exactly the symptom observed in a prior session's test container. Fixed: targets GET /healthz
# (server.mjs), a dedicated, deliberately UNAUTHENTICATED liveness route that returns nothing
# sensitive (just {status,uptimeSec}) — liveness must never require the same credential as data
# access. --start-period bumped 10s -> 20s: a heavily-loaded deployment's first full project scan
# (findAgentFiles() across every enabled project, real transcripts up to several MB each) has
# measured as slow as several seconds per project in this codebase's own perf-bug history
# (CLOSE-OUT-v3.1.md); 20s gives real margin without materially delaying failure detection.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4650/healthz || exit 1

# repoPath is passed as the container CMD arg (see docker-compose.yml `command:`), defaulting to
# whatever's mounted at /workspace.
CMD ["node", "server.mjs", "/workspace"]
