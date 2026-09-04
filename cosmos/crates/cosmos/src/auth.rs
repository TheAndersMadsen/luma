//! Request authentication seam shared by every gRPC handler.
//!
//! The trust boundary is the mesh edge: Istio terminates the device mTLS
//! connection, verifies the DeviceUser certificate, and forwards an opaque
//! principal in request metadata. Workloads never see the raw certificate —
//! they trust only that edge-injected principal. In development-insecure mode
//! (loopback only) a synthetic principal stands in so handlers can run locally
//! without the mesh.

use axum::http;
use cosmos_core::{AuthenticatedDeviceIdentity, AuthenticatedPrincipal};
use tonic::{Request, Status};

use crate::config::Authentication;

/// Which authenticated front door resolved a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticationPlane {
    Device,
    Web,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedRequest {
    pub principal: AuthenticatedPrincipal,
    pub plane: AuthenticationPlane,
    /// Transport identity only. Absence must not be inferred from the account,
    /// request body, a claimed header, or the device authentication-plane label.
    pub device: Option<AuthenticatedDeviceIdentity>,
}

/// Resolves the caller principal for an incoming request, failing closed.
#[derive(Clone)]
pub struct RequestAuthenticator {
    authentication: Authentication,
    /// The web plane, when a deployment configures Keycloak/OIDC. A request
    /// containing a Bearer token is resolved here; everything else falls through to
    /// the device plane. `None` ⇒ no Bearer token is ever trusted.
    web: Option<std::sync::Arc<crate::web_auth::JwtVerifier>>,
}

impl RequestAuthenticator {
    pub fn new(authentication: Authentication) -> Self {
        Self {
            authentication,
            web: None,
        }
    }

    /// Attach the web (OIDC) plane. A device-only deployment omits this.
    pub fn with_web(mut self, web: std::sync::Arc<crate::web_auth::JwtVerifier>) -> Self {
        self.web = Some(web);
        self
    }

    /// Returns the authenticated principal, or a gRPC `Status` that fails
    /// closed without reflecting any client-supplied value.
    // `tonic::Status` is the required error type for gRPC handlers; boxing it
    // would break `?` propagation at every call site, so allow the large Err.
    #[allow(clippy::result_large_err)]
    pub fn authenticate<T>(&self, request: &Request<T>) -> Result<AuthenticatedPrincipal, Status> {
        self.authenticate_with_plane(request)
            .map(|authenticated| authenticated.principal)
    }

    /// Authenticate and retain whether the verified identity came from the web
    /// bearer plane or the device mTLS plane. Most handlers need only the shared
    /// wearer principal; privacy-preserving read projections also need to know
    /// which wire contract they are answering.
    #[allow(clippy::result_large_err)]
    pub fn authenticate_with_plane<T>(
        &self,
        request: &Request<T>,
    ) -> Result<AuthenticatedRequest, Status> {
        // Web plane FIRST: a Bearer token is a positive assertion of a web user,
        // and it is verified by signature — not trusted like a header. Only a
        // token that is PRESENT but INVALID is rejected here; a request with no
        // Bearer falls through to the device plane so one port serves both.
        if let Some(web) = &self.web {
            if let Some(value) = request
                .metadata()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
            {
                if let Some(token) = crate::web_auth::bearer_token(value) {
                    return web
                        .verify(token)
                        .map(|principal| AuthenticatedRequest {
                            principal,
                            plane: AuthenticationPlane::Web,
                            device: None,
                        })
                        .map_err(|error| Status::unauthenticated(error.to_string()));
                }
            }
        }

        match &self.authentication {
            Authentication::EdgeAuthenticated(edge) => {
                edge.authenticate_with_device(request).map_err(Status::from)
            }
            Authentication::DevelopmentInsecure => {
                AuthenticatedPrincipal::from_edge("development-insecure-principal")
                    .map(|principal| AuthenticatedRequest {
                        principal,
                        plane: AuthenticationPlane::Device,
                        device: None,
                    })
                    .map_err(|_| Status::internal("synthetic principal unavailable"))
            }
        }
    }
}

/// The principal [`AuthLayer`] resolved for this request.
///
/// Absent only if the request bypassed the layer, which would itself be a wiring
/// bug — callers should treat `None` as "deny", never as "anonymous".
pub fn principal<T>(request: &Request<T>) -> Option<&AuthenticatedPrincipal> {
    request.extensions().get::<AuthenticatedPrincipal>()
}

/// Full transport provenance resolved by [`AuthLayer`]. A principal-only
/// request intentionally has unknown provenance; do not reconstruct it from
/// headers or the account's string representation after authentication.
pub fn authenticated_request<T>(request: &Request<T>) -> Option<&AuthenticatedRequest> {
    request.extensions().get::<AuthenticatedRequest>()
}

/// gRPC path prefix of the standard health service, which must answer an
/// unauthenticated probe (kubelet/compose hold no DeviceUser certificate).
const HEALTH_PREFIX: &str = "/grpc.health.v1.Health/";

/// Tower layer that enforces [`AuthInterceptor`] across the WHOLE gRPC router,
/// excluding only health checks.
///
/// This is the workload's front door. Authenticating in individual handlers is
/// how 21 of 22 services end up reachable unauthenticated by anyone who can
/// address the workload port directly — the edge is the primary gate, but the
/// workload must not depend on being unreachable.
#[derive(Clone)]
pub struct AuthLayer {
    authenticator: RequestAuthenticator,
}

impl AuthLayer {
    pub fn new(authenticator: RequestAuthenticator) -> Self {
        Self { authenticator }
    }
}

impl<S> tower::Layer<S> for AuthLayer {
    type Service = AuthService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthService {
            inner,
            authenticator: self.authenticator.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AuthService<S> {
    inner: S,
    authenticator: RequestAuthenticator,
}

impl<S, ReqBody> tower::Service<http::Request<ReqBody>> for AuthService<S>
where
    S: tower::Service<http::Request<ReqBody>, Response = http::Response<tonic::body::BoxBody>>
        + Send
        + 'static,
    S::Future: Send + 'static,
    ReqBody: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
    >;

    fn poll_ready(
        &mut self,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: http::Request<ReqBody>) -> Self::Future {
        if request.uri().path().starts_with(HEALTH_PREFIX) {
            let future = self.inner.call(request);
            return Box::pin(future);
        }
        // Authenticate off the request metadata (headers) before the RPC is
        // dispatched. `tonic::Request::from_http` would consume the body, so the
        // headers are wrapped in a unit request purely to reuse the resolver.
        let headers = request.headers().clone();
        let mut probe = Request::new(());
        *probe.metadata_mut() = tonic::metadata::MetadataMap::from_headers(headers);
        match self.authenticator.authenticate_with_plane(&probe) {
            Ok(authenticated) => {
                let mut request = request;
                // Keep the existing account-only projection for handlers that
                // do not need origin evidence, without losing the typed source.
                request
                    .extensions_mut()
                    .insert(authenticated.principal.clone());
                request.extensions_mut().insert(authenticated);
                let future = self.inner.call(request);
                Box::pin(future)
            }
            Err(status) => Box::pin(async move { Ok(status.into_http()) }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn device_provenance_survives_the_full_auth_layer_without_web_identity_confusion() {
        use crate::config::{EDGE_PRINCIPAL_HEADER, EDGE_TOKEN_HEADER, EdgeAuthentication};
        use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, encode};
        use std::sync::{Arc, Mutex};
        use tower::{Layer, ServiceExt};

        let (private, public) = crate::web_auth::test_jwt_keypair();
        let issuer = "https://provenance.invalid";
        let web = crate::web_auth::JwtVerifier::with_keys(
            crate::web_auth::OidcConfig {
                issuer: issuer.to_owned(),
                audience: None,
                jwks_uri: "unused-in-test".to_owned(),
            },
            std::collections::HashMap::from([(
                "provenance-test".to_owned(),
                DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(),
            )]),
        );
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("provenance-test".to_owned());
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 300;
        let bearer = encode(
            &header,
            &serde_json::json!({ "iss": issuer, "sub": "web-owner", "exp": expiry }),
            &EncodingKey::from_rsa_pem(private.as_bytes()).unwrap(),
        )
        .unwrap();

        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let inner = tower::service_fn(move |request: http::Request<()>| {
            let request = Request::from_http(request);
            let authenticated = authenticated_request(&request)
                .expect("full extension survives the actual layer")
                .clone();
            assert_eq!(principal(&request), Some(&authenticated.principal));
            captured.lock().unwrap().push(authenticated);
            async {
                Ok::<_, std::convert::Infallible>(http::Response::new(tonic::body::empty_body()))
            }
        });
        let layer = AuthLayer::new(
            RequestAuthenticator::new(Authentication::EdgeAuthenticated(
                EdgeAuthentication::with_test_token("provenance-test-edge"),
            ))
            .with_web(web),
        );
        let service = layer.layer(inner);
        let request = |device: &str, bearer: Option<&str>| {
            let mut builder = http::Request::builder()
                .uri("/humane.service.aibus.AiBusService/Understand")
                .header(EDGE_TOKEN_HEADER, "provenance-test-edge")
                .header(
                    EDGE_PRINCIPAL_HEADER,
                    format!("Subject=\"CN=V:01:D:{device}:U:pin-owner,O=Humane\""),
                );
            if let Some(bearer) = bearer {
                builder = builder.header("authorization", format!("Bearer {bearer}"));
            }
            builder.body(()).unwrap()
        };
        for request in [
            request("abcd", None),
            request("dcba", None),
            request("abcd", Some(&bearer)),
        ] {
            service.clone().oneshot(request).await.unwrap();
        }
        let rejected = service
            .oneshot(request("abcd", Some("invalid-bearer")))
            .await
            .unwrap();
        assert_eq!(rejected.headers().get("grpc-status").unwrap(), "16");

        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.len(),
            3,
            "invalid bearer must not fall through to the Pin"
        );
        assert_eq!(seen[0].principal, seen[1].principal);
        assert_ne!(seen[0].device, seen[1].device);
        assert!(seen[0].device.is_some());
        assert_eq!(seen[2].plane, AuthenticationPlane::Web);
        assert!(
            seen[2].device.is_none(),
            "valid bearer wins even with verified XFCC"
        );
        assert_eq!(
            seen[2].principal,
            AuthenticatedPrincipal::for_user("web-owner").unwrap()
        );
        let debug = format!("{:?}", &*seen);
        for identity in ["abcd", "dcba", "pin-owner", "web-owner"] {
            assert!(
                !debug.contains(identity),
                "typed provenance Debug must redact identities"
            );
        }
    }

    #[test]
    fn device_provenance_is_unknown_in_development_and_principal_only_requests() {
        let authenticator = RequestAuthenticator::new(Authentication::DevelopmentInsecure);
        let mut request = Request::new(());
        request.metadata_mut().insert(
            crate::config::EDGE_PRINCIPAL_HEADER,
            "Subject=\"CN=V:01:D:abcd:U:owner\"".parse().unwrap(),
        );
        let authenticated = authenticator.authenticate_with_plane(&request).unwrap();
        assert!(authenticated.device.is_none());
        request.extensions_mut().insert(authenticated.principal);
        assert!(authenticated_request(&request).is_none());
    }

    #[test]
    fn the_layer_resolves_a_principal_downstream_handlers_can_read() {
        let authenticator = RequestAuthenticator::new(Authentication::DevelopmentInsecure);
        let resolved = authenticator
            .authenticate(&Request::new(()))
            .expect("development-insecure resolves a synthetic principal");
        let mut request = Request::new(());
        request.extensions_mut().insert(resolved);
        assert!(principal(&request).is_some());
    }

    /// End-to-end: a request containing a REAL Keycloak `Authorization: Bearer`
    /// token authenticates to `U:<sub>` — the exact partition the Center forwards
    /// a wearer into, and the same one their device reaches. The device base is
    /// `DevelopmentInsecure`, so if the web plane did NOT take precedence this
    /// would resolve to the synthetic principal and the assert would fail — which
    /// also proves the web-plane-first ordering. Ignored (needs a running IdP;
    /// see `deploy/keycloak`).
    #[tokio::test]
    #[ignore = "requires a running Keycloak; set KC_TEST_* (see deploy/keycloak)"]
    async fn a_bearer_request_authenticates_to_the_user_principal() {
        let issuer = std::env::var("KC_TEST_ISSUER").expect("KC_TEST_ISSUER");
        let jwks_uri = std::env::var("KC_TEST_JWKS").expect("KC_TEST_JWKS");
        let token = std::env::var("KC_TEST_TOKEN").expect("KC_TEST_TOKEN");
        let sub = std::env::var("KC_TEST_SUB").expect("KC_TEST_SUB");

        let verifier = crate::web_auth::JwtVerifier::connect(crate::web_auth::OidcConfig {
            issuer,
            audience: None,
            jwks_uri,
        })
        .await
        .expect("connect to live Keycloak");

        let authenticator =
            RequestAuthenticator::new(Authentication::DevelopmentInsecure).with_web(verifier);

        let mut request = Request::new(());
        request
            .metadata_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());

        let principal = authenticator
            .authenticate(&request)
            .expect("a live Bearer token authenticates");
        assert_eq!(
            principal.expose_for_authorization(),
            format!("U:{sub}"),
            "a Center-forwarded Bearer must resolve to the wearer's U:<sub> partition"
        );
    }

    // Edge-mode fail-closed (a direct hit on the workload port carries no XFCC
    // header) is covered by `config::tests::
    // edge_authentication_fails_closed_and_redacts_the_principal`; the
    // interceptor simply propagates that decision.
}
