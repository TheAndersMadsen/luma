# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Builder for the Linux client's shared Rust library. It runs on the host's own
# architecture with the digest-pinned Trixie Rust image and the same pinned
# native toolchain script the Cosmos image uses, so an ARM64 workstation
# cross-compiles for the owner's x86_64 Omarchy PC instead of emulating rustc.
# The checkout is mounted read-only at run time; nothing from it is baked in.
FROM rust:1.91.1-trixie@sha256:867f1d1162913c401378a8504fb17fe2032c760dc316448766f150a130204aad
ARG BUILDARCH
ARG CLIENT_ARCH=amd64
COPY linux-toolchain.sh /opt/cosmos-native/linux-toolchain.sh
RUN bash /opt/cosmos-native/linux-toolchain.sh "${BUILDARCH}" "${CLIENT_ARCH}"
# The verified libwebrtc tree lives in a Docker volume mounted here: its i386
# sysroot carries case-colliding header names that a macOS host filesystem
# cannot hold, so the archive is acquired and checked inside the builder. A
# fresh volume inherits this mode, which lets the operator's uid write it.
RUN install -d -m 1777 /opt/webrtc
ENV CXX=clang++-21 \
    LIBCLANG_PATH=/usr/lib/llvm-21/lib
WORKDIR /workspace/cosmos
ENTRYPOINT ["bash", "/workspace/platform/containers/linux-client/build.sh"]
