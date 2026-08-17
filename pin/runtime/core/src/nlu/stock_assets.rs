//! Test-only access to stock assets held in the local reverse-engineering
//! workspace.
//!
//! `decompile-workspace/` is device-derived, untracked, and therefore absent on
//! a fresh clone and in CI. A test that needs one of those assets must skip
//! rather than fail: "cannot verify here" is not "the code is broken". Reading
//! them at runtime also keeps them out of the compile graph, so a missing
//! workspace can never break the build.

use std::path::PathBuf;

/// Stock assets as extracted from the `ironman` APK.
fn stock_asset_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../decompile-workspace/decompiled/ironman/resources/assets")
        .join(relative)
}

/// Bytes of a stock asset, or `None` when the workspace is absent.
pub(super) fn stock_asset_bytes(relative: &str) -> Option<Vec<u8>> {
    std::fs::read(stock_asset_path(relative)).ok()
}

/// UTF-8 text of a stock asset, or `None` when the workspace is absent.
pub(super) fn stock_asset_text(relative: &str) -> Option<String> {
    std::fs::read_to_string(stock_asset_path(relative)).ok()
}
