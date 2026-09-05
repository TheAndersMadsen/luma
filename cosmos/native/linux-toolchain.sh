#!/usr/bin/env bash
set -euo pipefail
# Called inside the digest-pinned Rust/Trixie builder, never on production.
build_arch=${1:?build architecture required}
target_arch=${2:?target architecture required}
case "$build_arch" in amd64|arm64) ;; *) exit 2 ;; esac
case "$target_arch" in
  amd64) rust_target=x86_64-unknown-linux-gnu; cross_package=g++-x86-64-linux-gnu ;;
  arm64) rust_target=aarch64-unknown-linux-gnu; cross_package=g++-aarch64-linux-gnu ;;
  *) exit 2 ;;
esac
source /etc/os-release
test "$ID" = debian && test "$VERSION_ID" = 13
if [ "$build_arch" != "$target_arch" ]; then dpkg --add-architecture "$target_arch"; fi
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources
printf '%s\n' \
  'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260803T000000Z trixie main' \
  'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260803T000000Z trixie-backports main' \
  > /etc/apt/sources.list
apt-get update
packages=(clang-21 libclang-21-dev lld-21 cmake python3 "libglib2.0-dev:${target_arch}")
if [ "$build_arch" != "$target_arch" ]; then packages+=("$cross_package"); fi
apt-get install --no-install-recommends --yes "${packages[@]}"
rm -rf /var/lib/apt/lists/*
ln -sf /usr/bin/ld.lld-21 /usr/local/bin/ld.lld
rustup target add "$rust_target" --toolchain 1.91.1
