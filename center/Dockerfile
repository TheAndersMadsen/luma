# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Compile on the builder's native CPU. Install production dependencies separately
# for the target CPU, so Sharp and other optional binaries match the final image.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
COPY platform/setup/install-pnpm.mjs ./platform/setup/
COPY platform/containers/pin-builder/toolchain.json ./platform/containers/pin-builder/
RUN bun --no-env-file platform/setup/install-pnpm.mjs /usr/local/lib/pnpm && ln -s /usr/local/lib/pnpm/pnpm /usr/local/bin/pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml bunfig.toml ./
COPY center/package.json ./center/
COPY center/adapters/spotify/package.json ./center/adapters/spotify/
COPY pin/device-installer/cli/package.json ./pin/device-installer/cli/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    chmod 0644 package.json pnpm-lock.yaml pnpm-workspace.yaml bunfig.toml \
      center/package.json center/adapters/spotify/package.json pin/device-installer/cli/package.json \
    && pnpm install --frozen-lockfile --filter luma-center

FROM base AS development
ENV NODE_ENV=development HOSTNAME=0.0.0.0 PORT=4000 COSMOS_CONTRACTS_DIR=/app/contracts
COPY --chown=1000:1000 center ./center
COPY --from=wire_contracts --chown=1000:1000 . ./contracts
RUN mkdir -p /app/center/.next /data && chown -R 1000:1000 /app /data
WORKDIR /app/center
USER 1000:1000
EXPOSE 4000
CMD ["pnpm", "dev"]

FROM base AS builder
COPY center ./center
ARG LUMA_RELEASE_ID
RUN pnpm --dir center build

FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime-dependencies
ARG TARGETARCH
WORKDIR /app
COPY platform/setup/install-pnpm.mjs ./platform/setup/
COPY platform/containers/pin-builder/toolchain.json ./platform/containers/pin-builder/
RUN bun --no-env-file platform/setup/install-pnpm.mjs /usr/local/lib/pnpm && ln -s /usr/local/lib/pnpm/pnpm /usr/local/bin/pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml bunfig.toml ./
COPY center/package.json ./center/
COPY center/adapters/spotify/package.json ./center/adapters/spotify/
COPY pin/device-installer/cli/package.json ./pin/device-installer/cli/
# pnpm selects target-specific optional binaries while running natively. Running
# its installer through CPU emulation can fail in the Rust I/O runtime.
RUN chmod 0644 package.json pnpm-lock.yaml pnpm-workspace.yaml bunfig.toml \
      center/package.json center/adapters/spotify/package.json pin/device-installer/cli/package.json; \
    case "$TARGETARCH" in \
      amd64) cpu=x64 ;; arm64) cpu=arm64 ;; \
      *) echo "unsupported Center architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && pnpm install --frozen-lockfile --prod --filter luma-center --cpu "$cpu" --os linux --libc glibc

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 HOSTNAME=0.0.0.0 PORT=4000 COSMOS_CONTRACTS_DIR=/app/contracts
RUN groupadd --system --gid 1001 center && mkdir -p /data && chown 1000:1001 /data
COPY --from=builder --chown=1000:1001 /app/center/.next/standalone ./
# Replace the traced builder dependencies with production packages for this CPU.
RUN rm -rf node_modules center/node_modules
COPY --from=runtime-dependencies --chown=1000:1001 /app/node_modules ./node_modules
COPY --from=runtime-dependencies --chown=1000:1001 /app/center/node_modules ./center/node_modules
COPY --from=builder --chown=1000:1001 /app/center/.next/static ./center/.next/static
COPY --from=builder --chown=1000:1001 /app/center/public ./center/public
COPY --from=builder --chown=1000:1001 /app/center/runtime ./center/runtime
COPY --from=wire_contracts --chown=1000:1001 . ./contracts
USER 1000:1001
EXPOSE 4000
CMD ["bun", "--no-env-file", "center/server.js"]
