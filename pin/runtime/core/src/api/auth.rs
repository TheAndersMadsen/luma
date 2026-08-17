use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use subtle::ConstantTimeEq as _;
use tokio::sync::RwLock;

use crate::config::{Config, MAX_ADMIN_TOKEN_BYTES, MIN_ADMIN_TOKEN_BYTES};

/// Authentication state for the administration API. Environment configuration
/// is captured once so a process-wide token cannot change underneath a running
/// server. This type intentionally has no `Debug` implementation.
#[derive(Clone)]
pub(crate) struct AdminAuthState {
    shared_config: Arc<RwLock<Config>>,
    environment_token: Option<Arc<[u8]>>,
}

impl AdminAuthState {
    pub(crate) fn new(shared_config: Arc<RwLock<Config>>) -> Self {
        Self {
            shared_config,
            environment_token: std::env::var("PENUMBRA_ADMIN_TOKEN")
                .ok()
                .map(|token| Arc::<[u8]>::from(token.into_bytes())),
        }
    }

    #[cfg(test)]
    fn without_environment(shared_config: Arc<RwLock<Config>>) -> Self {
        Self {
            shared_config,
            environment_token: None,
        }
    }

    #[cfg(test)]
    fn with_environment(shared_config: Arc<RwLock<Config>>, token: &str) -> Self {
        Self {
            shared_config,
            environment_token: Some(Arc::<[u8]>::from(token.as_bytes())),
        }
    }

    async fn authorizes(&self, headers: &HeaderMap) -> bool {
        let Some(presented) = presented_bearer_token(headers) else {
            return false;
        };

        if let Some(expected) = self.environment_token.as_deref() {
            return constant_time_token_eq(presented, expected);
        }

        let config = self.shared_config.read().await;
        config
            .server
            .admin_token
            .as_deref()
            .is_some_and(|expected| constant_time_token_eq(presented, expected.as_bytes()))
    }

    /// Runs outside the CORS layer so tower-http cannot turn arbitrary raw
    /// OPTIONS requests into unauthenticated success responses. Genuine CORS
    /// preflights continue inward for the CORS layer to answer.
    pub(crate) async fn require_auth_for_api_options(
        State(state): State<AdminAuthState>,
        request: Request,
        next: Next,
    ) -> Response {
        let is_guarded_options = request.method() == Method::OPTIONS
            && is_api_path(request.uri().path())
            && !is_real_cors_preflight(&request);

        if !is_guarded_options || state.authorizes(request.headers()).await {
            next.run(request).await
        } else {
            unauthorized()
        }
    }
}

/// Protect every `/api` route except the exact public health discovery path.
/// Syntactically valid browser preflights are answered by the outer CORS layer;
/// the exemption here keeps that behavior fail-safe if layer behavior changes.
pub(crate) async fn require_admin_auth(
    State(state): State<AdminAuthState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let is_public = path == "/api/health" || is_real_cors_preflight(&request);

    if !is_api_path(path) || is_public {
        return next.run(request).await;
    }

    if state.authorizes(request.headers()).await {
        next.run(request).await
    } else {
        unauthorized()
    }
}

fn is_api_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

fn is_real_cors_preflight(request: &Request) -> bool {
    if request.method() != Method::OPTIONS {
        return false;
    }

    let Some(origin) = single_graphic_header(request.headers(), header::ORIGIN.as_str()) else {
        return false;
    };
    let Some(requested_method) = single_graphic_header(
        request.headers(),
        header::ACCESS_CONTROL_REQUEST_METHOD.as_str(),
    ) else {
        return false;
    };

    !origin.is_empty() && Method::from_bytes(requested_method).is_ok()
}

fn single_graphic_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a [u8]> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() || !value.as_bytes().iter().all(u8::is_ascii_graphic) {
        return None;
    }
    Some(value.as_bytes())
}

fn unauthorized() -> Response {
    StatusCode::UNAUTHORIZED.into_response()
}

fn presented_bearer_token(headers: &HeaderMap) -> Option<&[u8]> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }

    let bytes = value.as_bytes();
    if bytes.len() < 7 || !bytes[..6].eq_ignore_ascii_case(b"bearer") || bytes[6] != b' ' {
        return None;
    }

    let token = &bytes[7..];
    ((MIN_ADMIN_TOKEN_BYTES..=MAX_ADMIN_TOKEN_BYTES).contains(&token.len())
        && token.iter().all(u8::is_ascii_graphic))
    .then_some(token)
}

fn constant_time_token_eq(presented: &[u8], expected: &[u8]) -> bool {
    let mut presented_padded = [0_u8; MAX_ADMIN_TOKEN_BYTES];
    let mut expected_padded = [0_u8; MAX_ADMIN_TOKEN_BYTES];

    let presented_copy_len = presented.len().min(MAX_ADMIN_TOKEN_BYTES);
    let expected_copy_len = expected.len().min(MAX_ADMIN_TOKEN_BYTES);
    presented_padded[..presented_copy_len].copy_from_slice(&presented[..presented_copy_len]);
    expected_padded[..expected_copy_len].copy_from_slice(&expected[..expected_copy_len]);

    let same_length = (presented.len() as u64).ct_eq(&(expected.len() as u64));
    let same_content = presented_padded.ct_eq(&expected_padded);
    bool::from(same_length & same_content)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt as _;
    use tower_http::cors::{Any, CorsLayer};

    use super::*;

    fn app(token: Option<&str>) -> Router {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.server.admin_token = token.map(str::to_string);
        let auth = AdminAuthState::without_environment(Arc::new(RwLock::new(config)));

        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::OPTIONS])
            .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

        Router::new()
            .merge(super::super::setup::router())
            .route("/api/health", get(|| async { StatusCode::OK }))
            .route("/api/protected", get(|| async { StatusCode::OK }))
            .route("/upload/example", get(|| async { StatusCode::OK }))
            .fallback(|| async { StatusCode::NOT_FOUND })
            .layer(from_fn_with_state(auth.clone(), require_admin_auth))
            .layer(cors)
            .layer(from_fn_with_state(
                auth,
                AdminAuthState::require_auth_for_api_options,
            ))
    }

    async fn status(app: Router, path: &str, authorization: Option<&str>) -> StatusCode {
        let mut builder = HttpRequest::builder().uri(path);
        if let Some(value) = authorization {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        app.oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn public_health_setup_and_non_api_uploads_do_not_require_a_token() {
        let token = "a".repeat(MIN_ADMIN_TOKEN_BYTES);
        assert_eq!(
            status(app(Some(&token)), "/api/health", None).await,
            StatusCode::OK
        );
        assert_eq!(
            status(app(Some(&token)), "/upload/example", None).await,
            StatusCode::OK
        );
        assert_eq!(
            status(app(Some(&token)), "/setup/", None).await,
            StatusCode::OK
        );
        assert_eq!(
            status(app(Some(&token)), "/setup/assets/does-not-exist.js", None).await,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn protected_routes_require_an_exact_bearer_token() {
        let token = "a".repeat(MIN_ADMIN_TOKEN_BYTES);
        let bearer = format!("Bearer {token}");
        assert_eq!(
            status(app(Some(&token)), "/api/protected", None).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(
                app(Some(&token)),
                "/api/protected",
                Some("Bearer wrong-token-that-is-long-enough")
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(app(Some(&token)), "/api/protected", Some(&bearer)).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn missing_server_token_fails_closed_and_unknown_api_paths_are_protected() {
        let token = "a".repeat(MIN_ADMIN_TOKEN_BYTES);
        let bearer = format!("Bearer {token}");
        assert_eq!(
            status(app(None), "/api/protected", Some(&bearer)).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(app(Some(&token)), "/api/not-a-route", None).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(app(Some(&token)), "/api/not-a-route", Some(&bearer)).await,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn environment_token_is_authoritative_over_the_persisted_token() {
        let file_token = "f".repeat(MIN_ADMIN_TOKEN_BYTES);
        let environment_token = "e".repeat(MIN_ADMIN_TOKEN_BYTES);
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::load(&dir.path().join("missing.toml")).unwrap();
        config.server.admin_token = Some(file_token.clone());
        let auth =
            AdminAuthState::with_environment(Arc::new(RwLock::new(config)), &environment_token);
        let protected = Router::new()
            .route("/api/protected", get(|| async { StatusCode::OK }))
            .layer(from_fn_with_state(auth, require_admin_auth));

        assert_eq!(
            status(
                protected.clone(),
                "/api/protected",
                Some(&format!("Bearer {file_token}")),
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status(
                protected,
                "/api/protected",
                Some(&format!("Bearer {environment_token}")),
            )
            .await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn production_layering_allows_preflight_but_protects_other_api_requests() {
        let token = "a".repeat(MIN_ADMIN_TOKEN_BYTES);
        let preflight = HttpRequest::builder()
            .method(Method::OPTIONS)
            .uri("/api/protected")
            .header(header::ORIGIN, "https://center.example")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "authorization")
            .body(Body::empty())
            .unwrap();
        let preflight_response = app(Some(&token)).oneshot(preflight).await.unwrap();
        assert_eq!(preflight_response.status(), StatusCode::OK);
        assert!(preflight_response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .unwrap()
            .to_str()
            .unwrap()
            .split(',')
            .any(|value| value.trim().eq_ignore_ascii_case("authorization")));

        let raw_options = HttpRequest::builder()
            .method(Method::OPTIONS)
            .uri("/api/protected")
            .body(Body::empty())
            .unwrap();
        let raw_options_response = app(Some(&token)).oneshot(raw_options).await.unwrap();
        assert_eq!(raw_options_response.status(), StatusCode::UNAUTHORIZED);
        assert!(axum::body::to_bytes(raw_options_response.into_body(), 1)
            .await
            .unwrap()
            .is_empty());

        let unauthenticated = HttpRequest::builder()
            .uri("/api/protected")
            .header(header::ORIGIN, "https://center.example")
            .body(Body::empty())
            .unwrap();
        let unauthenticated_response = app(Some(&token)).oneshot(unauthenticated).await.unwrap();
        assert_eq!(unauthenticated_response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            unauthenticated_response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&header::HeaderValue::from_static("*")),
        );
        assert!(
            axum::body::to_bytes(unauthenticated_response.into_body(), 1)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn duplicate_authorization_headers_are_rejected() {
        let token = "a".repeat(MIN_ADMIN_TOKEN_BYTES);
        let mut headers = HeaderMap::new();
        headers.append(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        headers.append(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        assert!(presented_bearer_token(&headers).is_none());
    }

    #[test]
    fn equality_checks_length_and_all_token_bytes() {
        let token = vec![b'a'; MIN_ADMIN_TOKEN_BYTES];
        assert!(constant_time_token_eq(&token, &token));

        let mut different = token.clone();
        different[MIN_ADMIN_TOKEN_BYTES - 1] = b'b';
        assert!(!constant_time_token_eq(&token, &different));
        assert!(!constant_time_token_eq(&token, &token[..token.len() - 1]));
    }
}
