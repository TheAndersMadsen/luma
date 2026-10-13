# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Luma's pinned toolchain on top of a Google Scion harness image, so an agent
# can run the checks a contributor runs. `tools/scion/install` passes the
# digest-pinned Rust and Bun images from
# platform/containers/pin-builder/toolchain.json; pnpm is installed and
# verified by the script the Pin builder uses.
ARG HARNESS_IMAGE
ARG RUST_IMAGE
ARG BUN_IMAGE

FROM ${RUST_IMAGE} AS rust
# rust-toolchain.toml selects clippy and rustfmt, which the official image's
# minimal profile lacks. Installing them here keeps RUSTUP_HOME read-only for
# the agent.
RUN set -eux; \
    toolchain="$(rustup show active-toolchain | cut -d' ' -f1)"; \
    rustup component add clippy rustfmt --toolchain "${toolchain}"

FROM ${BUN_IMAGE} AS bun

FROM ${HARNESS_IMAGE}
ARG CLAUDE_CODE_VERSION=
USER root
ENV RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:${PATH}
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo/bin /usr/local/cargo/bin
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY platform/setup/install-pnpm.mjs /opt/luma/platform/setup/
COPY platform/containers/pin-builder/toolchain.json /opt/luma/platform/containers/pin-builder/
# ./luma resolves tools only from fixed directories (platform/cli/authority.js),
# so the Rust proxies are linked into /usr/local/bin. The Pin runtime core's
# build needs protoc and the protobuf well-known types, as in CI's pin-runtime
# job, and full Perl for its vendored OpenSSL. The agent works unprivileged:
# the harness image's sudo grants go.
RUN set -eux; \
    bun --no-env-file /opt/luma/platform/setup/install-pnpm.mjs /usr/local/lib/pnpm; \
    ln -sf /usr/local/lib/pnpm/pnpm /usr/local/bin/pnpm; \
    for tool in cargo cargo-clippy cargo-fmt clippy-driver rustc rustdoc rustfmt rustup; do \
      ln -sf "/usr/local/cargo/bin/${tool}" "/usr/local/bin/${tool}"; \
    done; \
    apt-get update; \
    apt-get install --no-install-recommends --yes protobuf-compiler libprotobuf-dev pkg-config perl; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /etc/sudoers.d/scion /etc/sudoers.d/scion-firewall; \
    chmod -R a+rX /usr/local/rustup /usr/local/cargo /usr/local/lib/pnpm
# The Claude harness rejects current model names on older Claude Code builds,
# so its image takes the release the installer resolved.
RUN set -eux; \
    if [ -n "${CLAUDE_CODE_VERSION}" ]; then \
      npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
      claude --version; \
    fi
RUN set -eux; \
    bun --version; pnpm --version; rustc --version; cargo --version; \
    cargo clippy --version; cargo fmt --version; protoc --version; \
    ! grep -rqs '^scion' /etc/sudoers /etc/sudoers.d
