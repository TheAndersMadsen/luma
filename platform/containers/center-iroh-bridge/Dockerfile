# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM --platform=$BUILDPLATFORM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS build
ARG BUILDARCH
ARG TARGETARCH

WORKDIR /workspace
RUN set -eux; \
    case "${BUILDARCH}" in amd64|arm64) ;; *) echo "unsupported build architecture: ${BUILDARCH}" >&2; exit 1 ;; esac; \
    case "${TARGETARCH}" in \
      amd64) rust_target=x86_64-unknown-linux-gnu; cross_packages='gcc-x86-64-linux-gnu libc6-dev-amd64-cross' ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu; cross_packages='gcc-aarch64-linux-gnu libc6-dev-arm64-cross' ;; \
      *) echo "unsupported bridge architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    rustup target add "${rust_target}" --toolchain 1.91.1; \
    if [ "${BUILDARCH}" != "${TARGETARCH}" ]; then \
      rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; \
      printf '%s\n' \
        'Types: deb' \
        'URIs: http://snapshot.debian.org/archive/debian/20260803T000000Z' \
        'Suites: bookworm bookworm-updates' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        > /etc/apt/sources.list.d/debian.sources; \
      apt-get update; \
      apt-get install --no-install-recommends --yes ${cross_packages}; \
      rm -rf /var/lib/apt/lists/*; \
    fi
COPY pin/bridge/Cargo.toml pin/bridge/Cargo.lock ./
COPY pin/bridge/src ./src
RUN --mount=type=cache,id=center-iroh-cargo-registry-${TARGETARCH},target=/usr/local/cargo/registry \
    --mount=type=cache,id=center-iroh-target-${TARGETARCH},target=/workspace/target \
    set -eux; \
    if [ "${BUILDARCH}" = "${TARGETARCH}" ]; then \
      cargo build --locked --release; \
      artifact=target/release/center-iroh-bridge; \
    else \
      case "${TARGETARCH}" in \
        amd64) \
          rust_target=x86_64-unknown-linux-gnu; \
          export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc; \
          export CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc; \
          export AR_x86_64_unknown_linux_gnu=x86_64-linux-gnu-ar \
          ;; \
        arm64) \
          rust_target=aarch64-unknown-linux-gnu; \
          export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc; \
          export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc; \
          export AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar \
          ;; \
      esac; \
      cargo build --locked --release --target "${rust_target}"; \
      artifact="target/${rust_target}/release/center-iroh-bridge"; \
    fi; \
    install -m 0755 "${artifact}" /center-iroh-bridge

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
