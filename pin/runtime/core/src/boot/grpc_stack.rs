//! Router-stack helpers shared by the HTTP and gRPC listeners: the fallback
//! for unmatched routes and the UNIMPLEMENTED-status log tap. The tests here
//! pin the axum/h2/tonic stack the composition root serves.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use tracing::warn;

/// Catches any request that doesn't match a registered HTTP or gRPC route.
/// Logs a warning and returns HTTP 404.
pub(crate) async fn fallback_handler(request: axum::extract::Request) -> impl IntoResponse {
    warn!(
        method = %request.method(),
        content_type = request.headers().get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("none"),
        "unhandled request. No matching route"
    );
    (StatusCode::NOT_FOUND, "not found")
}

/// Middleware that inspects gRPC responses for UNIMPLEMENTED status (code 12)
/// and logs a warning when one is detected.
pub(crate) async fn log_grpc_unimplemented(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;

    // gRPC status code 12 = UNIMPLEMENTED.
    // Tonic sets this in the `grpc-status` header for routing-level rejections.
    if let Some(status) = response.headers().get("grpc-status") {
        if status.as_bytes() == b"12" {
            warn!(path = %path, "gRPC UNIMPLEMENTED. method not registered");
        }
    }

    response
}
