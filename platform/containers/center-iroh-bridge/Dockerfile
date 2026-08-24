# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS build

WORKDIR /workspace
COPY pin/bridge/Cargo.toml pin/bridge/Cargo.lock ./
COPY pin/bridge/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/workspace/target \
    cargo build --locked --release \
    && cp target/release/center-iroh-bridge /center-iroh-bridge

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

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
    && apt-get install --no-install-recommends --yes ca-certificates curl \
    && install -d --owner=65532 --group=65532 --mode=0700 /var/lib/center-iroh-bridge \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /center-iroh-bridge /usr/local/bin/center-iroh-bridge

USER 65532:65532
EXPOSE 18080
VOLUME ["/var/lib/center-iroh-bridge"]

# `/__status` reports the bridge process and its current connection state, but
# intentionally remains 200 while the physical Pin is offline.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "--fail", "--silent", "--show-error", "--max-time", "4", "http://127.0.0.1:18080/__status"]

ENTRYPOINT ["/usr/local/bin/center-iroh-bridge"]
