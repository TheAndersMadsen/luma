//! Embedded Ai Pin Setup SPA.
//!
//! Setup is compiled ahead of time and packed into a deterministic JSON file
//! by `platform/containers/pin-builder/embed-setup-assets.mjs`. The pack is linked into the Rust
//! executable, so the dashboard never reads a laptop path or an arbitrary
//! device file at runtime.

use std::collections::HashMap;
use std::sync::OnceLock;

use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use bytes::Bytes;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

const SETUP_ASSET_PACK: &[u8] = include_bytes!("../../assets/setup-assets.json");
const SETUP_BASE_PATH: &str = "/setup/";
const MAX_ASSET_COUNT: usize = 64;
const MAX_ASSET_PATH_BYTES: usize = 256;
const MAX_ASSET_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES: usize = 4 * 1024 * 1024;

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; connect-src 'self' http: https: ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetPack {
    schema_version: u8,
    base_path: String,
    bundle_sha256: String,
    assets: Vec<PackedAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackedAsset {
    path: String,
    sha256: String,
    content_base64: String,
}

#[derive(Clone)]
struct EmbeddedAsset {
    body: Bytes,
    content_type: HeaderValue,
}

struct SetupAssets {
    by_path: HashMap<String, EmbeddedAsset>,
}

static SETUP_ASSETS: OnceLock<Result<SetupAssets, String>> = OnceLock::new();

pub(super) fn router() -> Router {
    Router::new()
        .route("/", get(root_redirect))
        .route("/setup", get(setup_redirect))
        .route("/setup/", get(setup_index))
        .route("/setup/{*path}", get(setup_path))
}

async fn root_redirect() -> Redirect {
    Redirect::permanent(SETUP_BASE_PATH)
}

async fn setup_redirect() -> Redirect {
    Redirect::permanent(SETUP_BASE_PATH)
}

async fn setup_index() -> Response {
    serve_embedded("index.html")
}

async fn setup_path(Path(path): Path<String>) -> Response {
    if !valid_request_path(&path) {
        return StatusCode::BAD_REQUEST.into_response();
    }

    if embedded_assets()
        .ok()
        .and_then(|assets| assets.by_path.get(&path))
        .is_some()
    {
        return serve_embedded(&path);
    }

    // Vite emits a client-side SPA. Only extensionless routes beneath the
    // Explicit Setup and legacy Center namespaces may fall back to the index.
    // Missing files,
    // API paths, and anything outside this router remain ordinary 404s.
    if is_spa_route(&path) {
        serve_embedded("index.html")
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

fn serve_embedded(path: &str) -> Response {
    let assets = match embedded_assets() {
        Ok(assets) => assets,
        Err(error) => {
            tracing::error!(error, "embedded Setup asset pack is invalid");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let Some(asset) = assets.by_path.get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut response = Response::new(Body::from(asset.body.clone()));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, asset.content_type.clone());
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&asset.body.len().to_string()).expect("asset length is valid"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    if path.ends_with(".html") {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        );
    }
    response
}

fn embedded_assets() -> Result<&'static SetupAssets, &'static str> {
    SETUP_ASSETS
        .get_or_init(load_asset_pack)
        .as_ref()
        .map_err(String::as_str)
}

/// The exact embedded Setup asset paths (relative to `/setup/`), for the
/// remote-Center catalog. Keys live in the `'static` asset table, so no leak or
/// allocation of the path strings is needed. Empty if the pack failed to load.
#[cfg(feature = "iroh")]
pub(crate) fn asset_paths() -> Vec<&'static str> {
    embedded_assets()
        .map(|assets| assets.by_path.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

fn load_asset_pack() -> Result<SetupAssets, String> {
    let pack: AssetPack = serde_json::from_slice(SETUP_ASSET_PACK)
        .map_err(|error| format!("asset manifest parse failed: {error}"))?;
    if pack.schema_version != 1 {
        return Err("unsupported asset manifest schema".into());
    }
    if pack.base_path != SETUP_BASE_PATH {
        return Err("asset manifest base path mismatch".into());
    }
    if pack.assets.is_empty() || pack.assets.len() > MAX_ASSET_COUNT {
        return Err("asset manifest count is outside bounds".into());
    }

    let mut by_path = HashMap::with_capacity(pack.assets.len());
    let mut total_bytes = 0_usize;
    let mut bundle_hasher = Sha256::new();
    for packed in pack.assets {
        if !valid_manifest_path(&packed.path) {
            return Err("asset manifest contains an invalid path".into());
        }
        let content_type = content_type_for_path(&packed.path)
            .ok_or_else(|| "asset manifest contains an unsupported file type".to_string())?;
        let body = base64::engine::general_purpose::STANDARD
            .decode(packed.content_base64)
            .map_err(|_| "asset manifest contains invalid base64".to_string())?;
        if body.len() > MAX_ASSET_BYTES {
            return Err("embedded Setup asset exceeds per-file limit".into());
        }
        total_bytes = total_bytes
            .checked_add(body.len())
            .ok_or_else(|| "embedded Setup asset size overflow".to_string())?;
        if total_bytes > MAX_TOTAL_ASSET_BYTES {
            return Err("embedded Setup asset pack exceeds total limit".into());
        }
        let actual_sha256 = sha256_hex(&body);
        if !valid_sha256(&packed.sha256) || actual_sha256 != packed.sha256 {
            return Err("embedded Setup asset digest mismatch".into());
        }

        bundle_hasher.update(packed.path.as_bytes());
        bundle_hasher.update([0]);
        bundle_hasher.update(&body);
        bundle_hasher.update([0]);

        if by_path
            .insert(
                packed.path,
                EmbeddedAsset {
                    body: Bytes::from(body),
                    content_type: HeaderValue::from_static(content_type),
                },
            )
            .is_some()
        {
            return Err("asset manifest contains a duplicate path".into());
        }
    }

    let actual_bundle_sha256 = lower_hex(&bundle_hasher.finalize());
    if !valid_sha256(&pack.bundle_sha256) || actual_bundle_sha256 != pack.bundle_sha256 {
        return Err("embedded Setup bundle digest mismatch".into());
    }
    let index = by_path
        .get("index.html")
        .ok_or_else(|| "asset manifest is missing index.html".to_string())?;
    let index_text = std::str::from_utf8(&index.body)
        .map_err(|_| "embedded Setup index is not UTF-8".to_string())?;
    if !index_text.contains("/setup/") {
        return Err("embedded Setup index does not target /setup/".into());
    }

    Ok(SetupAssets { by_path })
}

fn valid_request_path(path: &str) -> bool {
    valid_path(path, false)
}

fn valid_manifest_path(path: &str) -> bool {
    valid_path(path, true)
}

fn valid_path(path: &str, require_file: bool) -> bool {
    if path.is_empty()
        || path.len() > MAX_ASSET_PATH_BYTES
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path.bytes().any(|byte| !byte.is_ascii_graphic())
    {
        return false;
    }
    let mut has_file_segment = false;
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return false;
        }
        has_file_segment = true;
    }
    has_file_segment
        && (!require_file
            || path
                .rsplit('/')
                .next()
                .is_some_and(|name| name.contains('.')))
}

fn is_spa_route(path: &str) -> bool {
    valid_request_path(path)
        && path
            .rsplit('/')
            .next()
            .is_some_and(|segment| !segment.contains('.'))
}

fn content_type_for_path(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1;
    match extension {
        "html" => Some("text/html; charset=utf-8"),
        "js" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(bytes: &[u8]) -> String {
    lower_hex(&Sha256::digest(bytes))
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Method, Request};
    use tower::ServiceExt as _;

    use super::*;

    async fn response(path: &str) -> Response {
        router()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[test]
    fn embedded_pack_is_valid_and_contains_runtime_assets() {
        let assets = load_asset_pack().unwrap();
        assert!(assets.by_path.contains_key("index.html"));
        assert!(assets
            .by_path
            .keys()
            .any(|path| path.starts_with("assets/") && path.ends_with(".js")));
        assert!(assets
            .by_path
            .keys()
            .any(|path| path.starts_with("assets/") && path.ends_with(".css")));
        assert!(!assets.by_path.keys().any(|path| path.ends_with(".map")));
    }

    #[tokio::test]
    async fn root_and_setup_redirect_to_setup_directory() {
        for path in ["/", "/setup"] {
            let response = response(path).await;
            assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
            assert_eq!(
                response.headers().get(header::LOCATION),
                Some(&HeaderValue::from_static("/setup/"))
            );
        }
    }

    #[tokio::test]
    async fn index_and_assets_have_exact_mime_and_security_headers() {
        let index_response = response("/setup/").await;
        assert_eq!(index_response.status(), StatusCode::OK);
        assert_eq!(
            index_response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/html; charset=utf-8"))
        );
        assert_eq!(
            index_response.headers().get(header::X_CONTENT_TYPE_OPTIONS),
            Some(&HeaderValue::from_static("nosniff"))
        );
        assert!(index_response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .is_some());
        let body = to_bytes(index_response.into_body(), MAX_ASSET_BYTES)
            .await
            .unwrap();
        assert!(std::str::from_utf8(&body)
            .unwrap()
            .contains("/setup/assets/"));

        let js_path = embedded_assets()
            .unwrap()
            .by_path
            .keys()
            .find(|path| path.ends_with(".js"))
            .unwrap();
        let response = response(&format!("/setup/{js_path}")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/javascript; charset=utf-8"))
        );
        assert!(response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .is_none());
    }

    #[tokio::test]
    async fn spa_fallback_is_scoped_and_missing_files_stay_missing() {
        assert_eq!(
            response("/setup/gallery/item").await.status(),
            StatusCode::OK
        );
        assert_eq!(
            response("/setup/assets/not-present.js").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            response("/etc/passwd").await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            response("/api/settings").await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn traversal_and_ambiguous_paths_are_never_assets_or_spa_routes() {
        for path in [
            "/setup/../index.html",
            "/setup/%2e%2e/index.html",
            "/setup/assets%2f..%2findex.html",
            "/setup/assets%5c..%5cindex.html",
            "/setup//gallery",
        ] {
            let response = response(path).await;
            assert!(
                matches!(
                    response.status(),
                    StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND
                ),
                "unexpected status for {path}: {}",
                response.status()
            );
        }
    }

    #[tokio::test]
    async fn non_get_methods_are_not_accepted_for_static_content() {
        let response = router()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/setup/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
