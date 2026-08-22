# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS build

WORKDIR /workspace/cosmos

COPY Cargo.toml Cargo.lock ./
# `[patch.crates-io]` redirects voprf to a vendored copy (opaque-ke 2.0.0 pins a
# prerelease that no longer compiles), so the build stage needs it too.
COPY vendor ./vendor
COPY crates ./crates
# Compose supplies only the canonical shared wire tree as a named context. It is
# placed beside Cosmos so the container build has the same relative layout as
# the source workspace without widening the ordinary Cosmos build context.
COPY --from=wire_contracts . /workspace/contracts/wire
# Schema migrations are compiled into the Cosmos binary with `include_str!`.
# Keep them in the build image only; runtime applies the embedded bytes.
COPY migrations ./migrations
# `assistant::prompts` embeds these with `include_str!`, so they must exist at
# COMPILE time. They are not needed in the runtime image — the text ends up
# inside the binary — but a build stage without them fails to compile, which is
# why the registry sat unwired.
COPY prompts ./prompts

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/workspace/cosmos/target \
    cargo build --locked --release --bin cosmos \
    && cp /workspace/cosmos/target/release/cosmos /cosmos

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runtime

# Match the immutable 2026-08-03 base-image snapshot. Both dated archives expose
# signed Release files at this timestamp; HTTP avoids needing CA roots before
# the image installs ca-certificates, while apt still verifies Debian signatures.
# A digest-pinned base with mutable suites would resolve different package bytes.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
        'Types: deb' \
        'URIs: http://snapshot.debian.org/archive/debian/20260803T000000Z' \
        'Suites: bookworm bookworm-updates' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        '' \
        'Types: deb' \
        'URIs: http://snapshot.debian.org/archive/debian-security/20260803T000000Z' \
        'Suites: bookworm-security' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        curl \
        socat \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /cosmos /usr/local/bin/cosmos

# Durable-state mountpoint (`COSMOS_STATE_DIR`). It must exist in the image AND be
# owned by the runtime uid: Docker seeds a fresh named volume from the image
# directory's ownership, so without this the volume would be created root-owned
# and the nonroot process could not write its channel-key snapshot — the fix
# would be inert at runtime while every test still passed.
RUN install -d -o 65532 -g 65532 -m 0700 /var/lib/cosmos

USER 65532:65532
WORKDIR /app

EXPOSE 50051 8080

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD ["curl", "--fail", "--silent", "--show-error", "--output", "/dev/null", "http://127.0.0.1:8080/readyz"]

ENTRYPOINT ["/usr/local/bin/cosmos"]
