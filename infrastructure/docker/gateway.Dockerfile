# DFR Gateway runtime image (DFR-M1-E02).
#
# Design constraints:
#   - **Non-root**: runs as the image's built-in `node` user (uid 1000);
#     no privileged account is created;
#   - **Zero extra runtime dependencies**: runs TS source directly with the
#     repository's own resolution hooks (scripts/ts-runtime), without
#     introducing tsx / ts-node / esbuild;
#   - **No credentials written anywhere**: credentials are always injected
#     via runtime environment variables, see docs/runbooks/m1-local.md;
#   - Pinned Node major version (alpine variant), so local and CI do not
#     drift apart.
#
# Multi-stage build (M1-E02 supply-chain supplement).
#
# Why multi-stage is required: pnpm/corepack are only used at **build time**
# to install dependencies; the runtime never invokes them (the entry is
# `node --experimental-strip-types ...`). If they stayed in the final image,
# the vulnerability scan would report 44 HIGH/CRITICAL findings — all from
# pnpm's own dependency tree (tar / minimatch / pacote / sigstore / glob …),
# with zero overlap with our runtime dependencies. Removing the build tools
# eliminates that batch of findings, shrinks the image, and reduces the
# supply-chain surface at once.
#
# Build (from the repository root; the context must be the repository root):
#   docker build -f infrastructure/docker/gateway.Dockerfile -t dfr-gateway:m1 .

# ---------- Stage 1: install dependencies only ----------
FROM node:22-alpine AS deps

WORKDIR /app

# Keep the pnpm version consistent with package.json's packageManager.
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# Install **production** dependencies only (`--prod`): this image runs TS
# source directly with Node's built-in type stripping, so it does not need
# the dev toolchain (typescript / eslint / vitest / redocly / @types/node).
# The only runtime dependencies needed are each workspace package's
# `dependencies` (viem / pg, etc.), which `--prod` keeps.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY adapters ./adapters
COPY apps ./apps
COPY sdk ./sdk

RUN pnpm install --frozen-lockfile --prod && pnpm store prune

# ---------- Stage 2: runtime (no pnpm / corepack) ----------
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# PostgreSQL 17 client: production backup/restore drills must be able to run
# `pg_dump` / `pg_restore` inside the runtime image, otherwise operations
# can only rely on the host happening to have a client of the same major
# version installed. The `postgresql17-client` in Alpine's default
# repositories aligns with the test/production PostgreSQL 17.
# Client only, no server; the image still runs as non-root.
RUN apk add --no-cache postgresql17-client

# Copy only the installed dependencies and source; **do not** copy
# corepack/pnpm. node_modules internally uses pnpm's relative symlinks, which
# still resolve correctly after a bulk copy.
COPY --from=deps --chown=node:node /app /app

# Then remove the package-management tools shipped with the official base
# image (npm / npx / corepack).
#
# The basis comes from SBOM scanning: `node:22-alpine` ships npm, whose
# dependency tree (brace-expansion / pacote / sigstore / ip-address /
# http-cache-semantics / picomatch) brings 11 HIGH/CRITICAL findings. These
# tools are **never invoked at runtime** — the entry is `node` itself.
# After removal the scan reports 0 HIGH/CRITICAL.
#
# Cost (accepted deliberately): no npm/npx remains in the container for ad-hoc
# troubleshooting. A production gateway image should not depend on installing
# things inside the container anyway; use the build stage `deps` or reproduce
# locally for interactive debugging.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack

# Run as non-root; grant no extra capabilities.
USER node

EXPOSE 8787

# Liveness probe: only checks that the process answers HTTP, not dependencies
# (dependency checks belong to /readyz).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DFR_GATEWAY_PORT||8787)+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node","--experimental-strip-types","--experimental-transform-types","--import","./scripts/ts-runtime/register.mjs","apps/gateway/src/main.ts"]
