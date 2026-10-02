//! Request authentication seam shared by every gRPC handler.
//!
//! The trust boundary is the mesh edge: Istio terminates the device mTLS
//! connection, verifies the DeviceUser certificate, and forwards an opaque
//! principal in request metadata. Workloads never see the raw certificate,
//! they trust only that edge-injected principal. In development-insecure mode
//! (loopback only) a synthetic principal stands in so handlers can run locally
//! without the mesh.

use axum::http;
use cosmos_core::AuthenticatedPrincipal;
use tonic::{Request, Status};

use crate::config::Authentication;

/// Which authenticated front door resolved a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticationPlane {
    Device,
    Web,
}

pub struct AuthenticatedRequest {
    pub principal: AuthenticatedPrincipal,
    pub plane: AuthenticationPlane,
}

/// Resolves the caller principal for an incoming request, failing closed.
#[derive(Clone)]
pub struct RequestAuthenticator {
    authentication: Authentication,
    /// The web plane, when a deployment configures Keycloak/OIDC. A request
    /// containing a Bearer token is resolved here. Everything else falls through to
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
    // `tonic::Status` is the required error type for gRPC handlers. Boxing it
    // would break `?` propagation at every call site, so allow the large Err.
    #[allow(clippy::result_large_err)]
    pub fn authenticate<T>(&self, request: &Request<T>) -> Result<AuthenticatedPrincipal, Status> {
        self.authenticate_with_plane(request)
            .map(|authenticated| authenticated.principal)
    }

    /// Authenticate and retain whether the verified identity came from the web
    /// bearer plane or the device mTLS plane. Most handlers need only the shared
    /// wearer principal. Privacy-preserving read projections also need to know
    /// which wire contract they are answering.
    #[allow(clippy::result_large_err)]
    pub fn authenticate_with_plane<T>(
        &self,
        request: &Request<T>,
    ) -> Result<AuthenticatedRequest, Status> {
        // Web plane FIRST: a Bearer token is a positive assertion of a web user,
        // and it is verified by signature, not trusted like a header. Only a
        // token that is PRESENT but INVALID is rejected here. A request with no
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
                        })
                        .map_err(|error| Status::unauthenticated(error.to_string()));
                }
            }
        }

        let principal = match &self.authentication {
            Authentication::EdgeAuthenticated(edge) => {
                edge.authenticate(request).map_err(Status::from)
            }
            Authentication::DevelopmentInsecure => {
                AuthenticatedPrincipal::from_edge("development-insecure-principal")
                    .map_err(|_| Status::internal("synthetic principal unavailable"))
            }
        }?;
        Ok(AuthenticatedRequest {
            principal,
            plane: AuthenticationPlane::Device,
        })
    }
}

/// The principal [`AuthLayer`] resolved for this request.
///
/// Absent only if the request bypassed the layer, which would itself be a wiring
/// bug, callers should treat `None` as "deny", never as "anonymous".
pub fn principal<T>(request: &Request<T>) -> Option<&AuthenticatedPrincipal> {
    request.extensions().get::<AuthenticatedPrincipal>()
}

/// gRPC path prefix of the standard health service, which must answer an
/// unauthenticated probe (kubelet/compose hold no DeviceUser certificate).
const HEALTH_PREFIX: &str = "/grpc.health.v1.Health/";

/// Tower layer that enforces [`AuthInterceptor`] across the WHOLE gRPC router,
/// excluding only health checks.
///
/// This is the workload's front door. Authenticating in individual handlers is
/// how 21 of 22 services end up reachable unauthenticated by anyone who can
/// address the workload port directly, the edge is the primary gate, but the
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
        match self.authenticator.authenticate(&probe) {
            Ok(principal) => {
                let mut request = request;
                request.extensions_mut().insert(principal);
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
    /// token authenticates to `U:<sub>`, the exact partition the Center forwards
    /// a wearer into, and the same one their device reaches. The device base is
    /// `DevelopmentInsecure`, so if the web plane did NOT take precedence this
    /// would resolve to the synthetic principal and the assert would fail, which
    /// also proves the web-plane-first ordering. Ignored (needs a running
    /// Keycloak built from `platform/containers/keycloak`).
    #[tokio::test]
    #[ignore = "requires a running Keycloak (platform/containers/keycloak); set KC_TEST_ISSUER, KC_TEST_JWKS, KC_TEST_TOKEN (a live access token) and KC_TEST_SUB"]
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
    // edge_authentication_fails_closed_and_redacts_the_principal`. The
    // interceptor simply propagates that decision.
}
