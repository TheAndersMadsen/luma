#!/usr/bin/env bash
# Runs inside the linux-client builder image. The checkout is mounted read-only
# at /workspace, Cargo state and caches are external bind mounts, the verified
# libwebrtc archive is acquired into the /opt/webrtc volume, and the only
# output is one shared library written to /out.
set -euo pipefail
export CARGO_HOME=/cache/cargo
export CARGO_TARGET_DIR=/state/target
export CARGO_TERM_COLOR=never
# The image carries exactly the pinned toolchain; naming it explicitly keeps the
# rustup proxy from trying to add the checkout's optional components to the
# read-only toolchain directory.
RUSTUP_TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"$/\1/p' /workspace/rust-toolchain.toml)"
test -n "$RUSTUP_TOOLCHAIN" || { echo "rust-toolchain.toml does not pin a channel" >&2; exit 1; }
export RUSTUP_TOOLCHAIN
rust_target=x86_64-unknown-linux-gnu
library=libcosmos_surface_client_ffi.so

test -d /workspace/cosmos/crates/surface-client-ffi || { echo "the checkout is not mounted at /workspace" >&2; exit 1; }
test -d /opt/webrtc -a -w /opt/webrtc || { echo "the libwebrtc volume is not mounted writable at /opt/webrtc" >&2; exit 1; }
test -d /out || { echo "the output directory is not mounted at /out" >&2; exit 1; }
mkdir -p "$CARGO_HOME" "$CARGO_TARGET_DIR"
cd /workspace/cosmos

# Digest-verified download on first use, then a byte-for-byte check of the
# materialized tree on every build (the same script CI and the Cosmos image use).
LK_CUSTOM_WEBRTC="$(python3 native/prepare.py --cache /opt/webrtc --target linux-x64)"
export LK_CUSTOM_WEBRTC
test -f "$LK_CUSTOM_WEBRTC/lib/libwebrtc.a" || { echo "verified libwebrtc inputs are missing under $LK_CUSTOM_WEBRTC" >&2; exit 1; }

if [ "$(dpkg --print-architecture)" != amd64 ]; then
  # Same cross-compilation environment as cosmos/Dockerfile for an amd64 target.
  export PKG_CONFIG_ALLOW_CROSS=1
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc
  export CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc
  export AR_x86_64_unknown_linux_gnu=x86_64-linux-gnu-ar
  export PKG_CONFIG_LIBDIR=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig
fi

cargo build --locked --release --package cosmos-surface-client-ffi --lib --target "$rust_target"
# Plain copy plus byte comparison: a bind mount from a macOS host refuses
# chmod for install(1) and may report a short copy, and the host stages the
# archive with its own permissions anyway.
built="$CARGO_TARGET_DIR/$rust_target/release/$library"
rm -f "/out/$library" "/out/$library.tmp"
cat "$built" > "/out/$library.tmp"
cmp "$built" "/out/$library.tmp"
mv "/out/$library.tmp" "/out/$library"
echo "built /out/$library for $rust_target ($(wc -c < "$built") bytes)"
