# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM --platform=$BUILDPLATFORM rust:1.91.1-trixie@sha256:867f1d1162913c401378a8504fb17fe2032c760dc316448766f150a130204aad AS build
ARG BUILDARCH
ARG TARGETARCH

WORKDIR /workspace/cosmos

# Compile on the build host instead of running rustc through QEMU. The latter
# currently crashes when an ARM64 host builds the AMD64 release image.
COPY native ./native
RUN bash native/linux-toolchain.sh "${BUILDARCH}" "${TARGETARCH}"
# Acquire data while building the authenticated image, never at service startup.
RUN python3 native/prepare_stt.py --directory /opt/cosmos/models
ENV CXX=clang++-21
ENV LIBCLANG_PATH=/usr/lib/llvm-21/lib

COPY Cargo.toml Cargo.lock ./
COPY .cargo ./.cargo
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

RUN --mount=type=cache,id=cosmos-cargo-registry-${TARGETARCH},target=/usr/local/cargo/registry \
    --mount=type=cache,id=cosmos-webrtc-${TARGETARCH},target=/opt/webrtc \
    --mount=type=cache,id=cosmos-whisper-source-${TARGETARCH},target=/opt/whisper \
    --mount=type=cache,id=cosmos-target-${TARGETARCH},target=/workspace/cosmos/target \
    set -eux; \
    case "${TARGETARCH}" in amd64) webrtc_arch=x64 ;; arm64) webrtc_arch=arm64 ;; esac; \
    LK_CUSTOM_WEBRTC="$(python3 native/prepare.py --cache /opt/webrtc --target "linux-${webrtc_arch}")"; \
    WHISPER_CPP_SOURCE="$(python3 native/prepare_whisper.py --cache /opt/whisper)"; \
    export LK_CUSTOM_WEBRTC WHISPER_CPP_SOURCE; \
    if [ "${BUILDARCH}" = "${TARGETARCH}" ]; then \
      cargo build --locked --release --bin cosmos; \
      artifact=/workspace/cosmos/target/release/cosmos; \
    else \
      export PKG_CONFIG_ALLOW_CROSS=1; \
      case "${TARGETARCH}" in \
        amd64) \
          rust_target=x86_64-unknown-linux-gnu; \
          export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc; \
          export CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc; \
          export PKG_CONFIG_LIBDIR=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig; \
          export AR_x86_64_unknown_linux_gnu=x86_64-linux-gnu-ar \
          ;; \
        arm64) \
          rust_target=aarch64-unknown-linux-gnu; \
          export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc; \
          export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc; \
          export PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig; \
          export AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar \
          ;; \
      esac; \
      cargo build --locked --release --bin cosmos --target "${rust_target}"; \
      artifact="/workspace/cosmos/target/${rust_target}/release/cosmos"; \
    fi; \
    install -m 0755 "${artifact}" /cosmos

# Codex subscription support uses OpenAI's official app-server binary. Keep
# Node and npm out of the runtime image; only the exact target-architecture
# vendor bundle is copied across. The layer is shared by every Cosmos workload,
# while only ai-bus starts it after an operator chooses Codex in Center.
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS codex
ARG TARGETARCH
RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.149.1 \
    && case "$TARGETARCH" in \
        amd64) package=codex-linux-x64; target=x86_64-unknown-linux-musl ;; \
        arm64) package=codex-linux-arm64; target=aarch64-unknown-linux-musl ;; \
        *) echo "unsupported Codex architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && install -d /opt/codex \
    && cp -a "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/$package/vendor/$target/." /opt/codex/

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS runtime

# Match the immutable 2026-08-24 base-image snapshot. Both dated archives expose
# signed Release files at this timestamp; HTTP avoids needing CA roots before
# the image installs ca-certificates, while apt still verifies Debian signatures.
# A digest-pinned base with mutable suites would resolve different package bytes.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
        'Types: deb' \
        'URIs: http://snapshot.debian.org/archive/debian/20260824T000000Z' \
        'Suites: trixie trixie-updates' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        '' \
        'Types: deb' \
        'URIs: http://snapshot.debian.org/archive/debian-security/20260824T000000Z' \
        'Suites: trixie-security' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
        'Check-Valid-Until: no' \
        > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        libstdc++6 \
        curl \
        socat \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /cosmos /usr/local/bin/cosmos
COPY --from=build /opt/cosmos/models/ggml-base.bin /opt/cosmos/models/ggml-base.bin
COPY --from=codex --chown=65532:65532 /opt/codex /opt/codex

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
