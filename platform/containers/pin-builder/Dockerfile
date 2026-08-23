# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# The image digests make the language runtimes repeatable even if their tags
# are later moved. Android's Linux NDK toolchain is x86_64-only, so this image
# intentionally targets linux/amd64 (including under emulation on Apple Silicon).
ARG ANDROID_COMMAND_LINE_TOOLS_VERSION=15859902
ARG ANDROID_COMMAND_LINE_TOOLS_SHA256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
ARG ANDROID_PLATFORM_VERSION=34
ARG ANDROID_BUILD_TOOLS_VERSION=35.0.0
ARG ANDROID_NDK_VERSION=28.2.13676358
ARG ANDROID_NDK_ARCHIVE_URL=https://dl.google.com/android/repository/android-ndk-r28c-linux.zip
ARG ANDROID_NDK_ARCHIVE_ROOT=android-ndk-r28c
ARG ANDROID_NDK_ARCHIVE_SIZE=722261334
ARG ANDROID_NDK_ARCHIVE_SHA1=a7b54a5de87fecd125a17d54f73c446199e72a64
ARG ANDROID_NDK_ARCHIVE_SHA256=dfb20d396df28ca02a8c708314b814a4d961dc9074f9a161932746f815aa552f
ARG CARGO_NDK_VERSION=4.1.2
ARG CARGO_NDK_ARCHIVE_URL=https://github.com/bbqsrc/cargo-ndk/releases/download/v4.1.2/cargo-ndk-x86_64-unknown-linux-musl-v4.1.2.tgz
ARG CARGO_NDK_ARCHIVE_ROOT=cargo-ndk-x86_64-unknown-linux-musl-v4.1.2
ARG CARGO_NDK_ARCHIVE_SIZE=2736539
ARG CARGO_NDK_ARCHIVE_SHA256=dc148bebbfcd7d5355e9858530d5a69c20ce69cf3268c54b9f63c60cb4c9a966

# Download and extract the architecture-independent Android SDK contents on
# the native build platform. On an ARM contributor host this avoids running
# sdkmanager's large downloads under amd64 Java emulation. Both source images
# are multi-arch indexes pinned below to the same digests as the final image.
FROM --platform=$BUILDPLATFORM eclipse-temurin:17.0.14_7-jdk-jammy@sha256:23f74f7840a6948f9da3870876f475c4febeb365757891a6a9ebda38a42cf53f AS android_jdk_native
FROM --platform=$BUILDPLATFORM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS android_sdk_native
ARG ANDROID_COMMAND_LINE_TOOLS_VERSION
ARG ANDROID_COMMAND_LINE_TOOLS_SHA256
ARG ANDROID_PLATFORM_VERSION
ARG ANDROID_BUILD_TOOLS_VERSION
ARG ANDROID_NDK_VERSION
ARG ANDROID_NDK_ARCHIVE_URL
ARG ANDROID_NDK_ARCHIVE_ROOT
ARG ANDROID_NDK_ARCHIVE_SIZE
ARG ANDROID_NDK_ARCHIVE_SHA1
ARG ANDROID_NDK_ARCHIVE_SHA256
ENV JAVA_HOME=/opt/java/openjdk \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk
COPY --from=android_jdk_native /opt/java/openjdk /opt/java/openjdk
RUN set -eux; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
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
      > /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tar unzip; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    mkdir -p /opt/android-sdk/cmdline-tools; \
    curl --fail --location --silent --show-error \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_COMMAND_LINE_TOOLS_VERSION}_latest.zip" \
      --output /tmp/android-command-line-tools.zip; \
    echo "${ANDROID_COMMAND_LINE_TOOLS_SHA256}  /tmp/android-command-line-tools.zip" | sha256sum --check --strict; \
    mkdir -p /tmp/android-command-line-tools; \
    unzip -q /tmp/android-command-line-tools.zip -d /tmp/android-command-line-tools; \
    mv /tmp/android-command-line-tools/cmdline-tools "/opt/android-sdk/cmdline-tools/${ANDROID_COMMAND_LINE_TOOLS_VERSION}"; \
    rm -rf /tmp/android-command-line-tools /tmp/android-command-line-tools.zip
RUN set -eux; \
    yes | "/opt/android-sdk/cmdline-tools/${ANDROID_COMMAND_LINE_TOOLS_VERSION}/bin/sdkmanager" --sdk_root=/opt/android-sdk --licenses >/dev/null; \
    "/opt/android-sdk/cmdline-tools/${ANDROID_COMMAND_LINE_TOOLS_VERSION}/bin/sdkmanager" --sdk_root=/opt/android-sdk \
      "platforms;android-${ANDROID_PLATFORM_VERSION}" \
      "build-tools;${ANDROID_BUILD_TOOLS_VERSION}"; \
    test -d "/opt/android-sdk/platforms/android-${ANDROID_PLATFORM_VERSION}"; \
    test -d "/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS_VERSION}"; \
    /opt/java/openjdk/bin/java -version; \
    node --version; \
    "/opt/android-sdk/cmdline-tools/${ANDROID_COMMAND_LINE_TOOLS_VERSION}/bin/sdkmanager" --version
RUN set -eux; \
    curl --fail --location --silent --show-error \
      "${ANDROID_NDK_ARCHIVE_URL}" \
      --output /tmp/android-ndk.zip; \
    test "$(stat --format='%s' /tmp/android-ndk.zip)" = "${ANDROID_NDK_ARCHIVE_SIZE}"; \
    echo "${ANDROID_NDK_ARCHIVE_SHA1}  /tmp/android-ndk.zip" | sha1sum --check --strict; \
    echo "${ANDROID_NDK_ARCHIVE_SHA256}  /tmp/android-ndk.zip" | sha256sum --check --strict; \
    mkdir -p /tmp/android-ndk /opt/android-sdk/ndk; \
    unzip -q /tmp/android-ndk.zip -d /tmp/android-ndk; \
    test "$(find /tmp/android-ndk -mindepth 1 -maxdepth 1 -type d -printf '%f\n')" = "${ANDROID_NDK_ARCHIVE_ROOT}"; \
    grep -Fx "Pkg.Revision = ${ANDROID_NDK_VERSION}" "/tmp/android-ndk/${ANDROID_NDK_ARCHIVE_ROOT}/source.properties"; \
    mv "/tmp/android-ndk/${ANDROID_NDK_ARCHIVE_ROOT}" "/opt/android-sdk/ndk/${ANDROID_NDK_VERSION}"; \
    test -f "/opt/android-sdk/ndk/${ANDROID_NDK_VERSION}/source.properties"; \
    test ! -e "/opt/android-sdk/ndk/${ANDROID_NDK_ARCHIVE_ROOT}"; \
    rm -rf /tmp/android-ndk /tmp/android-ndk.zip

# Keep the target-platform component manifest as inert input. Docker can copy
# it across stages without executing the x86_64 rustup binary under QEMU.
FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS rust_runtime

# rustup's x86_64 binary is unreliable under some ARM-host QEMU versions.
# Install the host-independent Android target on the native build platform,
# normalize it for the final x86_64 sysroot, and use cargo-ndk's upstream
# prebuilt x86_64 release asset instead of compiling it under emulation.
FROM --platform=$BUILDPLATFORM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS rust_target_native
ARG CARGO_NDK_VERSION
ARG CARGO_NDK_ARCHIVE_URL
ARG CARGO_NDK_ARCHIVE_ROOT
ARG CARGO_NDK_ARCHIVE_SIZE
ARG CARGO_NDK_ARCHIVE_SHA256
COPY --from=rust_runtime /usr/local/rustup/toolchains/1.91.1-x86_64-unknown-linux-gnu/lib/rustlib/components /tmp/x86-rust-components
RUN set -eux; \
    rustc --version; \
    rustup target add aarch64-linux-android --toolchain 1.91.1; \
    rust_sysroot="$(rustc --print sysroot)"; \
    grep -Fx rust-std-aarch64-linux-android "${rust_sysroot}/lib/rustlib/components"; \
    test -f "${rust_sysroot}/lib/rustlib/manifest-rust-std-aarch64-linux-android"; \
    mkdir -p /opt/rust-target/lib/rustlib; \
    cp -a "${rust_sysroot}/lib/rustlib/aarch64-linux-android" /opt/rust-target/lib/rustlib/; \
    cp -a "${rust_sysroot}/lib/rustlib/manifest-rust-std-aarch64-linux-android" /opt/rust-target/lib/rustlib/; \
    cp /tmp/x86-rust-components /opt/rust-target/lib/rustlib/components; \
    test "$(grep -Fxc rust-std-aarch64-linux-android /opt/rust-target/lib/rustlib/components)" = 0; \
    printf '%s\n' rust-std-aarch64-linux-android >> /opt/rust-target/lib/rustlib/components; \
    test "$(grep -Fxc rust-std-aarch64-linux-android /opt/rust-target/lib/rustlib/components)" = 1
RUN set -eux; \
    curl --fail --location --silent --show-error \
      "${CARGO_NDK_ARCHIVE_URL}" \
      --output /tmp/cargo-ndk.tgz; \
    test "$(stat --format='%s' /tmp/cargo-ndk.tgz)" = "${CARGO_NDK_ARCHIVE_SIZE}"; \
    echo "${CARGO_NDK_ARCHIVE_SHA256}  /tmp/cargo-ndk.tgz" | sha256sum --check --strict; \
    mkdir -p /tmp/cargo-ndk /opt/cargo-ndk/bin; \
    tar -xzf /tmp/cargo-ndk.tgz -C /tmp/cargo-ndk; \
    test "$(find /tmp/cargo-ndk -mindepth 1 -maxdepth 1 -type d -printf '%f\n')" = "${CARGO_NDK_ARCHIVE_ROOT}"; \
    for executable in cargo-ndk cargo-ndk-env cargo-ndk-runner cargo-ndk-test; do \
      install -m 0755 "/tmp/cargo-ndk/${CARGO_NDK_ARCHIVE_ROOT}/${executable}" "/opt/cargo-ndk/bin/${executable}"; \
    done; \
    PATH="/opt/cargo-ndk/bin:${PATH}" cargo ndk --version; \
    rm -rf /tmp/cargo-ndk /tmp/cargo-ndk.tgz

FROM eclipse-temurin:17.0.14_7-jdk-jammy@sha256:23f74f7840a6948f9da3870876f475c4febeb365757891a6a9ebda38a42cf53f AS jdk_runtime
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS node_runtime
FROM rust_runtime

ARG TARGETARCH
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
ARG ANDROID_COMMAND_LINE_TOOLS_VERSION
ARG ANDROID_PLATFORM_VERSION
ARG ANDROID_BUILD_TOOLS_VERSION
ARG ANDROID_NDK_VERSION

LABEL org.opencontainers.image.title="Ai Pin Revival device builder" \
      org.opencontainers.image.description="Isolated, non-root host build environment for the Ai Pin device platform" \
      org.opencontainers.image.source="pin"

ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/opt/java/openjdk \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_NDK_HOME=/opt/android-sdk/ndk/${ANDROID_NDK_VERSION} \
    ANDROID_NDK_ROOT=/opt/android-sdk/ndk/${ANDROID_NDK_VERSION} \
    AI_PIN_ANDROID_PLATFORM_VERSION=${ANDROID_PLATFORM_VERSION} \
    AI_PIN_ANDROID_BUILD_TOOLS_VERSION=${ANDROID_BUILD_TOOLS_VERSION} \
    AI_PIN_ANDROID_NDK_VERSION=${ANDROID_NDK_VERSION} \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/cache/cargo \
    GRADLE_USER_HOME=/cache/gradle \
    NPM_CONFIG_CACHE=/cache/npm \
    ANDROID_USER_HOME=/cache/android \
    PATH=/opt/java/openjdk/bin:/opt/android-sdk/cmdline-tools/${ANDROID_COMMAND_LINE_TOOLS_VERSION}/bin:/opt/android-sdk/build-tools/${ANDROID_BUILD_TOOLS_VERSION}:/usr/local/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY --from=jdk_runtime /opt/java/openjdk /opt/java/openjdk
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

# Resolve builder packages from the dated Debian archives aligned with the
# digest-pinned Bookworm base, not mutable bookworm/security suite heads.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) ;; \
      *) echo "Ai Pin device builds require linux/amd64; got ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    test ! -e /usr/bin/node; \
    ln /usr/local/bin/node /usr/bin/node; \
    ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
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
      > /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      binutils \
      clang \
      cmake \
      curl \
      git \
      jq \
      libclang-dev \
      # protoc resolves google/protobuf/*.proto — the well-known types the aibus
      # protos import — from /usr/include, but Debian ships those files in
      # libprotobuf-dev, which is only a RECOMMENDS of protobuf-compiler. With
      # --no-install-recommends above, the compiler arrives without them and the
      # Rust build fails on "google/protobuf/timestamp.proto: File not found".
      libprotobuf-dev \
      libssl-dev \
      ninja-build \
      pkg-config \
      protobuf-compiler \
      python3 \
      rsync \
      unzip \
      zip; \
    rm -rf /var/lib/apt/lists/*; \
    if getent group "${BUILDER_GID}" >/dev/null; then \
      existing_group="$(getent group "${BUILDER_GID}" | cut -d: -f1)"; \
    else \
      groupadd --gid "${BUILDER_GID}" builder; \
      existing_group=builder; \
    fi; \
    useradd --create-home --uid "${BUILDER_UID}" --gid "${existing_group}" --shell /bin/bash builder; \
    mkdir -p /cache/android /cache/cargo /cache/gradle /cache/npm /state \
      /run/secrets/pin /run/private-assets; \
    chown -R builder:"${existing_group}" /cache /state

COPY --from=rust_target_native /opt/rust-target/ /usr/local/rustup/toolchains/1.91.1-x86_64-unknown-linux-gnu/
COPY --from=rust_target_native /opt/cargo-ndk/bin/ /usr/local/cargo/bin/

COPY --from=android_sdk_native /opt/android-sdk /opt/android-sdk

COPY --chmod=0555 --chown=0:0 platform/containers/pin-builder/entrypoint.sh /usr/local/bin/ai-pin-device-builder

USER builder
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/ai-pin-device-builder"]
CMD ["help"]
