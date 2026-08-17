# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# The image digests make the language runtimes repeatable even if their tags
# are later moved. Android's Linux NDK toolchain is x86_64-only, so this image
# intentionally targets linux/amd64 (including under emulation on Apple Silicon).
FROM eclipse-temurin:17.0.14_7-jdk-jammy@sha256:23f74f7840a6948f9da3870876f475c4febeb365757891a6a9ebda38a42cf53f AS jdk_runtime
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS node_runtime
FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33

ARG TARGETARCH
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
ARG ANDROID_COMMAND_LINE_TOOLS_VERSION=15859902
ARG ANDROID_COMMAND_LINE_TOOLS_SHA256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
ARG ANDROID_PLATFORM_VERSION=34
ARG ANDROID_BUILD_TOOLS_VERSION=35.0.0
ARG ANDROID_NDK_VERSION=28.2.13676358
ARG CARGO_NDK_VERSION=4.1.2

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

RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) ;; \
      *) echo "Ai Pin device builds require linux/amd64; got ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
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
    mkdir -p /opt/android-sdk/cmdline-tools; \
    curl --fail --location --silent --show-error \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_COMMAND_LINE_TOOLS_VERSION}_latest.zip" \
      --output /tmp/android-command-line-tools.zip; \
    echo "${ANDROID_COMMAND_LINE_TOOLS_SHA256}  /tmp/android-command-line-tools.zip" | sha256sum --check --strict; \
    mkdir -p /tmp/android-command-line-tools; \
    unzip -q /tmp/android-command-line-tools.zip -d /tmp/android-command-line-tools; \
    mv /tmp/android-command-line-tools/cmdline-tools "/opt/android-sdk/cmdline-tools/${ANDROID_COMMAND_LINE_TOOLS_VERSION}"; \
    rm -rf /tmp/android-command-line-tools /tmp/android-command-line-tools.zip; \
    yes | sdkmanager --sdk_root=/opt/android-sdk --licenses >/dev/null; \
    sdkmanager --sdk_root=/opt/android-sdk \
      "platforms;android-${ANDROID_PLATFORM_VERSION}" \
      "build-tools;${ANDROID_BUILD_TOOLS_VERSION}" \
      "ndk;${ANDROID_NDK_VERSION}"; \
    rustup target add aarch64-linux-android --toolchain 1.91.1; \
    CARGO_HOME=/usr/local/cargo cargo install cargo-ndk --version "${CARGO_NDK_VERSION}" --locked; \
    java -version; \
    node --version; \
    rustc --version; \
    cargo ndk --version; \
    sdkmanager --version

RUN set -eux; \
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

COPY --chown=${BUILDER_UID}:${BUILDER_GID} platform/containers/pin-builder/entrypoint.sh /usr/local/bin/ai-pin-device-builder
RUN chmod 0755 /usr/local/bin/ai-pin-device-builder

USER builder
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/ai-pin-device-builder"]
CMD ["help"]
