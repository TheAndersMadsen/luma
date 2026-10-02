//! What every Cosmos web REST surface shares: who the caller is, the one
//! state those routers hold, and the Spring envelopes the recovered
//! humane.center client parses.
//!
//! The recovered `.Center` was a Next.js client of a Spring Boot `webapi`
//! (`capture`, `notable-events`, `device-assignments`, `ai-bus`, plus the
//! `account-service` scope). Each of those is its own module here
//! (`capture_api`, `notes_api`, `notable_api`, `account_api`), and every one
//! resolves the caller through [`principal_for`] / [`ApiState::account_for`],
//! so a wearer's Pin and browser read one partition and no router can drift
//! into trusting a header another one refuses.
//!
//! Plaintext reads and every write require [`RequestPlane::Web`]
//! ([`ApiState::web_account_for`]): a verified Keycloak Bearer.
//! `x-forwarded-client-cert` on its own identifies nobody outside the
//! development profile, and beside the edge token it is only the device plane.

use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use crate::keydirectory::SharedKeyDirectory;
use crate::store::SharedStore;

/// The account an unidentified request reads in the development profile.
///
/// The demo assistant writes notes under this exact CN, so on a loopback
/// developer stack with no login configured a "remember …" turn and this reader
/// see the same rows.
///
/// It is a FALLBACK, never the answer for an identified caller, and it exists
/// only where [`HttpTrust`] says this is the developer profile. Any other
/// deployment answers an unidentified request with 401: serving it from a fixed
/// account let an anonymous internet caller read a partition nobody had
/// authorised them to see. Serving every request from this constant was also
/// the bug [`principal_for`] exists to fix: a real Pin enrols as `U:<account>`
/// and writes there, while the dashboard read `U:operator`, so the wearer's
/// captures and the dashboard's view were two different partitions and neither
/// side reported anything wrong.
pub const DEMO_PRINCIPAL: &str = "V:01:D:web-demo:U:operator";

/// What this deployment believes on the HTTP plane, read from its own
/// configuration and never from the request.
///
/// `x-forwarded-client-cert` is a string any caller can type. Envoy makes it
/// trustworthy on the Pin's gRPC chains by rewriting it from the verified client
/// certificate, but those chains never reach this router: the public domain
/// terminates at Traefik, and anything on the internal network can dial ai-bus
/// directly. So the marker counts only beside a secret proving who asserted it:
/// the same `COSMOS_EDGE_TOKEN` the gRPC front door demands before it reads the
/// same header. That proof admits the device plane only. The web plane is a
/// verified Bearer and nothing else.
///
/// No `Debug`: it holds a secret, and nothing may print it.
#[derive(Clone, Default)]
pub(crate) struct HttpTrust {
    /// `COSMOS_AUTH_MODE=development-insecure`, the loopback-only developer
    /// profile `Config` refuses to start anywhere else. As on the gRPC plane in
    /// that mode, a caller-asserted identity is believed and an anonymous
    /// request reads [`DEMO_PRINCIPAL`].
    development: bool,
    /// `COSMOS_EDGE_TOKEN`: a trusted front door (the co-located Center BFF, or
    /// operator tooling inside the workload) asserted this device-plane
    /// principal.
    edge_token: Option<String>,
}

impl HttpTrust {
    pub(crate) fn from_env() -> Self {
        Self {
            development: std::env::var("COSMOS_AUTH_MODE")
                .is_ok_and(|mode| mode == "development-insecure"),
            edge_token: crate::config::configured_edge_token(),
        }
    }

    /// The loopback developer profile, for tests that exercise it on purpose.
    #[cfg(test)]
    pub(crate) fn development() -> Self {
        Self {
            development: true,
            ..Self::default()
        }
    }

    /// An internet-facing deployment holding this edge secret.
    #[cfg(test)]
    pub(crate) fn edge(edge_token: &str) -> Self {
        Self {
            development: false,
            edge_token: Some(edge_token.to_owned()),
        }
    }

    /// The plane a caller-asserted edge principal may speak for, or `None` when
    /// nothing proves who asserted it.
    fn edge_plane(&self, headers: &axum::http::HeaderMap) -> Option<RequestPlane> {
        if self.development
            || presents(
                headers,
                crate::config::EDGE_TOKEN_HEADER,
                self.edge_token.as_deref(),
            )
        {
            return Some(RequestPlane::Device);
        }
        None
    }
}

/// Whether `headers` carries exactly the configured secret under `name`. A
/// secret this deployment does not hold proves nothing, whatever is sent.
fn presents(headers: &axum::http::HeaderMap, name: &str, expected: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let presented = headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    crate::config::constant_time_eq(presented.as_bytes(), expected.as_bytes())
}

/// Whose data this request is asking for, under this process's [`HttpTrust`].
///
/// The same order of precedence the gRPC front door uses
/// (`auth::RequestAuthenticator::authenticate`), so one identity resolves the
/// same way whichever surface it arrives on:
///
/// 1. **A verified Bearer token**, the web plane. Signature-checked against
///    Keycloak's JWKS, so this is an assertion the server proved, not a header it
///    was handed. `sub` becomes `U:<sub>`.
/// 2. **An edge-asserted principal**, `x-forwarded-client-cert`, honoured only
///    beside the proof [`HttpTrust`] requires. A DeviceUser CN resolves through
///    `from_device_cn` to the same `U:<account>` the web login produces, which is
///    what makes one person's Pin and browser read one partition.
/// 3. **Nobody**, `Ok(None)`. The caller decides what that means. The capture
///    API serves the demo account only in the development profile.
///
/// An identity that is PRESENT but does not hold, a Bearer that does not
/// verify, or an edge principal with no proof beside it, is `Err`: the caller
/// claimed to be someone, so neither believing the claim nor falling back to
/// another account is safe.
///
/// `pub(crate)` because the assistant's HTTP surfaces must resolve identity the
/// SAME way. They used to insert a hardcoded `from_edge(DEMO_PRINCIPAL)` on
/// every turn, so "remember X" wrote into the demo partition while the wearer's
/// own `/notes` read `U:<sub>`, the exact partition split this function exists
/// to prevent, reintroduced one module over.
pub(crate) fn principal_for(
    headers: &axum::http::HeaderMap,
    verifier: Option<&crate::web_auth::JwtVerifier>,
) -> Result<Option<ResolvedPrincipal>, ()> {
    resolve_principal(headers, verifier, &HttpTrust::from_env())
}

pub(crate) fn resolve_principal(
    headers: &axum::http::HeaderMap,
    verifier: Option<&crate::web_auth::JwtVerifier>,
    trust: &HttpTrust,
) -> Result<Option<ResolvedPrincipal>, ()> {
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        // An asserted web identity is all-or-nothing. A malformed header, an
        // unavailable verifier, or a token that does not verify must never fall
        // through to the demo partition (which would disclose another account).
        // The caller answers 401. The log says which check failed, so an
        // operator can tell an expired sign-in from a misconfigured realm.
        let principal = verified_bearer(value, verifier).map_err(|reason| {
            tracing::warn!(reason, "rejected a web Bearer token");
        })?;
        return Ok(Some(ResolvedPrincipal {
            account: principal.expose_for_authorization().to_owned(),
            plane: RequestPlane::Web,
        }));
    }
    let Some(value) = headers.get(crate::config::EDGE_PRINCIPAL_HEADER) else {
        return Ok(None);
    };
    let plane = trust.edge_plane(headers).ok_or(())?;
    let value = value.to_str().map_err(|_| ())?;
    let subject = crate::config::edge_subject(value);
    let principal = cosmos_core::AuthenticatedPrincipal::from_device_cn(subject).map_err(|_| ())?;
    Ok(Some(ResolvedPrincipal {
        account: principal.expose_for_authorization().to_owned(),
        plane,
    }))
}

/// The account a presented `authorization` header proves, or which check it
/// failed. The reason is a fixed phrase: never the token, a claim value, or a
/// key, so it is safe to log.
fn verified_bearer(
    value: &axum::http::HeaderValue,
    verifier: Option<&crate::web_auth::JwtVerifier>,
) -> Result<cosmos_core::AuthenticatedPrincipal, &'static str> {
    let value = value
        .to_str()
        .map_err(|_| "authorization header is not text")?;
    let token =
        crate::web_auth::bearer_token(value).ok_or("authorization header is not a Bearer token")?;
    let verifier = verifier.ok_or("web sign-in is not configured on this workload")?;
    verifier
        .verify(token)
        .map_err(|error| bearer_rejection(&error))
}

fn bearer_rejection(error: &crate::web_auth::WebAuthError) -> &'static str {
    use crate::web_auth::WebAuthError;
    match error {
        WebAuthError::Malformed => "token is not a well-formed JWT",
        WebAuthError::NoKid => "token names no signing key",
        WebAuthError::UnknownKey => "token is signed by a key the JWKS does not hold",
        WebAuthError::BadSubject => "token sub is not a usable account",
        WebAuthError::NoSubject => {
            "token has no sub claim; the Keycloak client needs the basic scope"
        }
        WebAuthError::Invalid(error) => {
            use jsonwebtoken::errors::ErrorKind;
            match error.kind() {
                ErrorKind::ExpiredSignature => "token expired",
                ErrorKind::InvalidIssuer => "token issuer is not COSMOS_OIDC_ISSUER",
                ErrorKind::InvalidAudience => "token audience is not COSMOS_OIDC_AUDIENCE",
                ErrorKind::InvalidSignature => "token signature does not verify",
                ErrorKind::ImmatureSignature => "token is not valid yet",
                ErrorKind::InvalidAlgorithm => "token is not signed with RS256",
                ErrorKind::MissingRequiredClaim(_) => "token lacks a required claim",
                _ => "token failed validation",
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequestPlane {
    Web,
    Device,
    Fallback,
}

pub(crate) struct ResolvedPrincipal {
    pub(crate) account: String,
    pub(crate) plane: RequestPlane,
}

/// The whole web surface over one state: what `http/mod.rs` mounts, and what every
/// router's tests exercise. Each service's routes live in its own module.
pub(crate) fn router(state: ApiState) -> axum::Router {
    crate::capture_api::router(state.clone())
        .merge(crate::notes_api::router(state.clone()))
        .merge(crate::notable_api::router(state.clone()))
        .merge(crate::music_api::router(state.clone()))
        .merge(crate::feature_flags_api::router(state.clone()))
        .merge(crate::account_api::router(state))
}

/// The one state every web router holds. The store handed in MUST be the same
/// instance the device-facing gRPC services write to, or the web shows nothing
/// the Pin saved.
#[derive(Clone)]
pub(crate) struct ApiState {
    pub(crate) store: SharedStore,
    pub(crate) keys: SharedKeyDirectory,
    pub(crate) objects: Option<Arc<crate::services::capture::CaptureObjectStore>>,
    /// The development profile's fallback account. See [`DEMO_PRINCIPAL`].
    pub(crate) principal: Arc<str>,
    pub(crate) trust: HttpTrust,
    pub(crate) web_verifier: Option<Arc<crate::web_auth::JwtVerifier>>,
}

impl ApiState {
    /// This deployment's web state: its configured Keycloak verifier and its
    /// configured capture object store.
    pub(crate) fn new(
        store: SharedStore,
        keys: SharedKeyDirectory,
        principal: impl Into<Arc<str>>,
        trust: HttpTrust,
    ) -> Self {
        Self {
            store,
            keys,
            objects: crate::services::capture::configured_object_store(),
            principal: principal.into(),
            trust,
            web_verifier: crate::web_auth::configured_verifier(),
        }
    }

    /// The verifier and object sink are parameters so a test can mount a
    /// router over a temporary root and its own signing key. The routes that
    /// write to storage were otherwise unreachable under `cargo test`, which
    /// runs with no storage configured.
    #[cfg(test)]
    pub(crate) fn for_tests(
        store: SharedStore,
        keys: SharedKeyDirectory,
        principal: impl Into<Arc<str>>,
        trust: HttpTrust,
        web_verifier: Option<Arc<crate::web_auth::JwtVerifier>>,
        objects: Option<Arc<crate::services::capture::CaptureObjectStore>>,
    ) -> Self {
        Self {
            store,
            keys,
            objects,
            principal: principal.into(),
            trust,
            web_verifier,
        }
    }

    /// The caller, only when they arrived on the web plane: a verified Bearer.
    /// Every plaintext read and every write
    /// goes through this. An identified device or developer-fallback caller is
    /// `403`, an unidentified one `401`, and neither ever reaches the demo
    /// partition.
    pub(crate) fn web_account_for(
        &self,
        headers: &axum::http::HeaderMap,
    ) -> Result<ResolvedPrincipal, StatusCode> {
        match self.account_for(headers)? {
            resolved if resolved.plane == RequestPlane::Web => Ok(resolved),
            _ => Err(StatusCode::FORBIDDEN),
        }
    }

    /// [`Self::account_for`]'s account, or the refusal a handler returns as is.
    pub(crate) fn caller(&self, headers: &axum::http::HeaderMap) -> Result<String, Response> {
        self.account_for(headers)
            .map(|resolved| resolved.account)
            .map_err(IntoResponse::into_response)
    }

    /// [`Self::web_account_for`]'s account, or the refusal a handler returns as is.
    pub(crate) fn web_caller(&self, headers: &axum::http::HeaderMap) -> Result<String, Response> {
        self.web_account_for(headers)
            .map(|resolved| resolved.account)
            .map_err(IntoResponse::into_response)
    }

    /// Whose data to serve for this request: the identified caller. Only the
    /// development profile serves the fallback account to a caller who
    /// identified nobody. Everywhere else that request is 401, like a claimed
    /// identity that did not hold.
    pub(crate) fn account_for(
        &self,
        headers: &axum::http::HeaderMap,
    ) -> Result<ResolvedPrincipal, StatusCode> {
        match resolve_principal(headers, self.web_verifier.as_deref(), &self.trust) {
            Ok(Some(principal)) => Ok(principal),
            Ok(None) if self.trust.development => Ok(ResolvedPrincipal {
                account: self.principal.to_string(),
                plane: RequestPlane::Fallback,
            }),
            Ok(None) | Err(()) => Err(StatusCode::UNAUTHORIZED),
        }
    }
}

// ── Spring Data Page<T> envelope ────────────────────────────────────────────
// Field names are Spring's own, verbatim, so a client written against the real
// webapi deserializes this unchanged.

#[derive(Serialize)]
pub(crate) struct SortInfo {
    empty: bool,
    sorted: bool,
    unsorted: bool,
}

impl SortInfo {
    /// Every list here is server-sorted newest-first, so the sort is always the
    /// `userCreatedAt,DESC` the `.Center` client asked for.
    fn sorted() -> Self {
        Self {
            empty: false,
            sorted: true,
            unsorted: false,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pageable {
    page_number: i64,
    page_size: i64,
    sort: SortInfo,
    offset: i64,
    paged: bool,
    unpaged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page<T> {
    content: Vec<T>,
    pageable: Pageable,
    last: bool,
    total_elements: i64,
    total_pages: i64,
    size: i64,
    number: i64,
    sort: SortInfo,
    first: bool,
    number_of_elements: i64,
    empty: bool,
}

#[derive(Deserialize)]
pub(crate) struct PageQuery {
    pub(crate) page: Option<i64>,
    pub(crate) size: Option<i64>,
    // The `.Center` client's `sort=userCreatedAt,DESC` is ignored like any
    // unknown parameter: the store already returns that order.
}

/// Default and maximum page sizes. The max bounds a client that asks for
/// everything at once from turning one request into an unbounded serialization.
pub(crate) const DEFAULT_PAGE_SIZE: i64 = 20;
pub(crate) const MAX_PAGE_SIZE: i64 = 200;

impl PageQuery {
    /// The window this request asks for: `(page, size, offset)`.
    ///
    /// Resolved BEFORE the store is asked anything, because the window is what
    /// bounds the read. It used to be applied after a full listing had already
    /// been materialised and decrypted, which is why `?size=1` cost exactly what
    /// `?size=200` cost, and the health probe issues the `size=1` one.
    pub(crate) fn window(&self) -> (i64, i64, i64) {
        let page = self.page.unwrap_or(0).max(0);
        let size = self
            .size
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE);
        (page, size, page.saturating_mul(size))
    }
}

/// Wrap rows the STORE already sliced in the Spring envelope.
///
/// `total` is the store's own count of everything the filter matches, not
/// `content.len()`: an empty final page still has to report how many rows exist,
/// and `last`/`totalPages` are derived from it.
pub(crate) fn page_of<T>(content: Vec<T>, total: i64, page: i64, size: i64) -> Page<T> {
    let offset = page.saturating_mul(size);
    // Ceiling division without the unstable `div_ceil`. `size` is clamped >= 1.
    let total_pages = (total + size - 1) / size;
    let number_of_elements = content.len() as i64;

    Page {
        empty: content.is_empty(),
        pageable: Pageable {
            page_number: page,
            page_size: size,
            sort: SortInfo::sorted(),
            offset,
            paged: true,
            unpaged: false,
        },
        // `last` is a property of the page position, true when this page reaches
        // or passes the final element, including the empty page past the end.
        last: offset + number_of_elements >= total,
        total_elements: total,
        total_pages,
        size,
        number: page,
        sort: SortInfo::sorted(),
        first: page == 0,
        number_of_elements,
        content,
    }
}

/// The answer both delete routes give: did a row actually go?
///
/// One boolean and nothing else. It is `snake_case` on the wire (`deleted`),
/// a single word, so unlike the `Page<T>` envelope there is no camelCase form to
/// get wrong, and it is the ONLY 200 body these routes produce. A failed delete
/// is a failure status, never `{"deleted": false}`: `false` is a claim about the
/// wearer's data ("you had no such row"), and answering it over an outage tells
/// them an erasure happened that did not.
#[derive(Serialize)]
pub(crate) struct DeletedDto {
    pub(crate) deleted: bool,
}

/// A store outage is a 503, never an empty page. An empty page is a *claim*, "you
/// have no captures", and rendering an outage as that claim tells the wearer
/// their memories are gone. Same rule the store trait's `Written` distinction exists for.
pub(crate) fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, "the store is unavailable").into_response()
}

/// Say why something sealed could not be opened.
///
/// The key directory's contract (`keydirectory`) puts this obligation on its
/// callers: "a note we cannot open is simply not searchable" is only honest if
/// somebody records that it happened. Five call sites here and in the services
/// used to return "not found" / `sealed: true` / `continue` with no trace at
/// all, so an ImportKeys that never ran, a directory that is process-local
/// because `COSMOS_DATABASE_URL` is unset, and a corrupt envelope were one silent
/// answer.
///
/// `shared` is the field that separates those: false means this process's
/// directory is memory-only, so a key imported by the AI-bus workload is simply
/// not visible here. The **kid is deliberately not logged**, it carries the
/// wearer's device and user ids, the same reason `services/events.rs` reports
/// only the decoder class.
pub(crate) fn key_directory_miss(keys: &SharedKeyDirectory, subject: &str, what: &str) {
    tracing::warn!(subject = %subject, shared = keys.is_shared(), "{what}");
}

/// How many per-record side reads a page overlaps.
///
/// Each capture on a page costs one `read_best_frame` filesystem read and each
/// note one channel-key lookup, and both used to run strictly one after another,
/// a serial `for … .await` over every row the wearer owned. Bounded rather
/// than unbounded because both can reach a database pool (`max_connections` is
/// 8): a page must not be able to starve the pool it shares with the device
/// plane.
pub(crate) const PAGE_SIDE_READ_CONCURRENCY: usize = 8;

/// A delete the store could not complete.
///
/// **Never** `200 {"deleted": false}`. That body says "you had no such row", so
/// answering an outage with it closes the wearer's page on an erasure that never
/// happened, the exact failure the store's `Ok(false)`/`Err` split exists to
/// prevent, thrown away at the last hop.
///
/// 500 rather than the reads' 503: the delete contract the companion is written
/// against pins this status, and both sides code against it. Either way it is an
/// error the caller must surface, not a silent success.
pub(crate) fn delete_failed() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "the delete could not be carried out",
    )
        .into_response()
}

/// Request builders and identities every web router's tests share, so the
/// surfaces are exercised through one definition of "a signed-in wearer", "a
/// Pin behind the edge" and "nobody".
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::store::MemoryStore;
    use axum::{Router, body::Body, http::Request};
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, encode};
    use std::collections::HashMap;
    use tower::ServiceExt;

    /// A FRESH, isolated store per test. `MemoryStore::shared()` is a process
    /// singleton, so calling it here would bleed state between tests.
    pub(crate) fn fresh() -> SharedStore {
        std::sync::Arc::new(MemoryStore::default())
    }

    pub(crate) fn fresh_keys() -> SharedKeyDirectory {
        std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory())
    }

    pub(crate) const EDGE_TOKEN: &str = "edge-test-token";

    /// The header Center once sent to upgrade an edge principal to the web
    /// plane. Retired: tests send it to prove it opens nothing.
    pub(crate) const RETIRED_PROJECTION_HEADER: &str = "x-cosmos-web-projection-token";

    /// An internet-facing deployment: the edge secret configured, no developer
    /// profile.
    pub(crate) fn internet_facing() -> HttpTrust {
        HttpTrust::edge(EDGE_TOKEN)
    }

    pub(crate) fn headers_of(pairs: &[(&'static str, &str)]) -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, value.parse().unwrap());
        }
        headers
    }

    /// The three shapes an edge principal arrives in: Envoy's full XFCC, a bare
    /// DeviceUser CN, and the account principal itself. Assembled rather than
    /// written out, so the source never contains a literal DeviceUser subject
    /// (`verify/hygiene.py`).
    pub(crate) fn edge_subjects(account: &str) -> [String; 3] {
        let device_cn = format!("V:01:D:pin1:U:{account}");
        [
            format!("By=spiffe://cosmos.local/edge;Subject=\"CN={device_cn}\""),
            device_cn,
            format!("U:{account}"),
        ]
    }

    pub(crate) const TEST_KID: &str = "capture-api-test-key";
    pub(crate) const TEST_ISSUER: &str = "https://auth.humane.center/realms/humane";
    pub(crate) fn test_verifier() -> Arc<crate::web_auth::JwtVerifier> {
        let (_, public_pem) = crate::web_auth::test_jwt_keypair();
        let mut keys = HashMap::new();
        keys.insert(
            TEST_KID.to_owned(),
            DecodingKey::from_rsa_pem(public_pem.as_bytes()).unwrap(),
        );
        crate::web_auth::JwtVerifier::with_keys(
            crate::web_auth::OidcConfig {
                issuer: TEST_ISSUER.to_owned(),
                audience: None,
                jwks_uri: "unused-in-test".to_owned(),
            },
            keys,
        )
    }

    pub(crate) fn bearer_for(sub: &str) -> String {
        let (private_pem, _) = crate::web_auth::test_jwt_keypair();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(TEST_KID.to_owned());
        encode(
            &header,
            &serde_json::json!({
                "sub": sub,
                "iss": TEST_ISSUER,
                "exp": 4_102_444_800_i64,
            }),
            &EncodingKey::from_rsa_pem(private_pem.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    pub(crate) async fn get_with_bearer(
        app: &Router,
        uri: &str,
        bearer: &str,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {bearer}"),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// A GET containing an edge-injected principal, the way Envoy presents one.
    pub(crate) async fn get_as(
        app: &Router,
        uri: &str,
        device_cn: &str,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(
                        crate::config::EDGE_PRINCIPAL_HEADER,
                        format!("By=spiffe://cosmos.local/edge;Subject=\"CN={device_cn}\""),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    pub(crate) async fn get(app: &Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    pub(crate) async fn get_with(
        app: &Router,
        uri: &str,
        headers: &[(&'static str, &str)],
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder().uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// A DELETE containing an edge-injected principal, the way Envoy presents one.
    pub(crate) async fn delete_as(
        app: &Router,
        uri: &str,
        device_cn: &str,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(axum::http::Method::DELETE)
                    .uri(uri)
                    .header(
                        crate::config::EDGE_PRINCIPAL_HEADER,
                        format!("By=spiffe://cosmos.local/edge;Subject=\"CN={device_cn}\""),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// Any method, any headers, an optional JSON body: the shape a web write
    /// arrives in.
    pub(crate) async fn send(
        app: &Router,
        method: axum::http::Method,
        uri: &str,
        headers: &[(&str, String)],
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, value.as_str());
        }
        let body = match body {
            Some(json) => {
                request = request.header(axum::http::header::CONTENT_TYPE, "application/json");
                Body::from(serde_json::to_vec(&json).unwrap())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// The `authorization` header of a signed-in wearer.
    pub(crate) fn bearer_header(sub: &str) -> (&'static str, String) {
        ("authorization", format!("Bearer {}", bearer_for(sub)))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    /// WHO SENT THE MARKER DECIDES WHAT IT IS WORTH.
    ///
    /// `x-forwarded-client-cert` is a string anybody can type, and Traefik used
    /// to hand the internet's copy straight to this router. So on an
    /// internet-facing deployment a bare marker, or one beside a wrong secret, is
    /// refused rather than believed. The edge token admits it to the device
    /// plane as the account the CN names, and nothing upgrades it to the web
    /// plane: Center's old projection token is retired and proves nothing.
    #[test]
    fn an_edge_principal_counts_only_beside_the_secret_that_proves_its_sender() {
        use crate::config::{EDGE_PRINCIPAL_HEADER, EDGE_TOKEN_HEADER};
        let trust = internet_facing();

        for subject in edge_subjects("wearer-42") {
            let forged = headers_of(&[(EDGE_PRINCIPAL_HEADER, &subject)]);
            assert!(
                resolve_principal(&forged, None, &trust).is_err(),
                "{subject} alone must not identify anyone"
            );
            for (name, wrong) in [
                (EDGE_TOKEN_HEADER, "wrong-token"),
                (RETIRED_PROJECTION_HEADER, "projection-test-token"),
                (EDGE_TOKEN_HEADER, ""),
            ] {
                let guessed = headers_of(&[(EDGE_PRINCIPAL_HEADER, &subject), (name, wrong)]);
                assert!(
                    resolve_principal(&guessed, None, &trust).is_err(),
                    "{name}: {wrong:?} must not prove {subject}"
                );
            }

            let device = resolve_principal(
                &headers_of(&[
                    (EDGE_PRINCIPAL_HEADER, &subject),
                    (EDGE_TOKEN_HEADER, EDGE_TOKEN),
                ]),
                None,
                &trust,
            )
            .unwrap()
            .unwrap();
            assert_eq!(device.account, "U:wearer-42");
            assert_eq!(device.plane, RequestPlane::Device);

            let retired = resolve_principal(
                &headers_of(&[
                    (EDGE_PRINCIPAL_HEADER, &subject),
                    (EDGE_TOKEN_HEADER, EDGE_TOKEN),
                    (RETIRED_PROJECTION_HEADER, "projection-test-token"),
                ]),
                None,
                &trust,
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                retired.plane,
                RequestPlane::Device,
                "the retired projection header must not upgrade {subject} to the web plane"
            );

            // A deployment holding no secret has nothing a caller could present.
            let unconfigured =
                headers_of(&[(EDGE_PRINCIPAL_HEADER, &subject), (EDGE_TOKEN_HEADER, "")]);
            assert!(resolve_principal(&unconfigured, None, &HttpTrust::default()).is_err());
        }

        // Identifying nobody is not an error here. The surface decides.
        assert!(
            resolve_principal(&axum::http::HeaderMap::new(), None, &trust)
                .unwrap()
                .is_none()
        );
    }

    /// A refused Bearer is logged with the check it failed, so an operator can
    /// tell an expired sign-in from a realm that leaves `sub` out of its tokens.
    /// Each case is a real jsonwebtoken failure, which pins the prefixes
    /// `bearer_rejection` reads.
    #[test]
    fn bearer_rejections_name_the_failed_check() {
        use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
        let verifier = test_verifier();
        let mint = |kid: &str, claims: serde_json::Value| {
            let (private_pem, _) = crate::web_auth::test_jwt_keypair();
            let mut header = Header::new(Algorithm::RS256);
            header.kid = Some(kid.to_owned());
            let token = encode(
                &header,
                &claims,
                &EncodingKey::from_rsa_pem(private_pem.as_bytes()).unwrap(),
            )
            .unwrap();
            axum::http::HeaderValue::from_str(&format!("Bearer {token}")).unwrap()
        };
        let far = 4_102_444_800_i64;
        let check = |value: &axum::http::HeaderValue| {
            verified_bearer(value, Some(&verifier))
                .err()
                .unwrap_or("accepted")
        };

        assert_eq!(
            check(&mint(
                TEST_KID,
                serde_json::json!({ "sub": "alice", "iss": TEST_ISSUER, "exp": far })
            )),
            "accepted"
        );
        for (claims, reason) in [
            (
                serde_json::json!({ "iss": TEST_ISSUER, "exp": far }),
                "token has no sub claim; the Keycloak client needs the basic scope",
            ),
            (
                serde_json::json!({ "sub": "alice", "iss": TEST_ISSUER, "exp": 1_000 }),
                "token expired",
            ),
            (
                serde_json::json!({ "sub": "alice", "iss": "https://other.example/realms/humane", "exp": far }),
                "token issuer is not COSMOS_OIDC_ISSUER",
            ),
            (
                serde_json::json!({ "sub": "alice", "iss": TEST_ISSUER }),
                "token lacks a required claim",
            ),
        ] {
            assert_eq!(check(&mint(TEST_KID, claims)), reason);
        }
        assert_eq!(
            check(&mint(
                "rotated-away",
                serde_json::json!({ "sub": "alice", "iss": TEST_ISSUER, "exp": far })
            )),
            "token is signed by a key the JWKS does not hold"
        );
        for (header, reason) in [
            ("Bearer not-a-jwt", "token is not a well-formed JWT"),
            (
                "Basic YWxpY2U6c2VjcmV0",
                "authorization header is not a Bearer token",
            ),
        ] {
            assert_eq!(check(&axum::http::HeaderValue::from_static(header)), reason);
        }
        assert_eq!(
            verified_bearer(&axum::http::HeaderValue::from_static("Bearer x.y.z"), None).err(),
            Some("web sign-in is not configured on this workload")
        );
        // No reason carries anything from the token.
        let token = mint(
            TEST_KID,
            serde_json::json!({ "iss": TEST_ISSUER, "exp": far }),
        );
        assert!(!check(&token).contains(TEST_ISSUER));
    }

    /// The developer profile keeps the loopback stack working without secrets:
    /// a bare marker is believed on the device plane, exactly as the gRPC plane
    /// synthesises a principal under `development-insecure`.
    #[test]
    fn the_developer_profile_believes_a_bare_edge_principal() {
        for subject in edge_subjects("wearer-42") {
            let headers = headers_of(&[(crate::config::EDGE_PRINCIPAL_HEADER, &subject)]);
            let device = resolve_principal(&headers, None, &HttpTrust::development())
                .unwrap()
                .unwrap();
            assert_eq!(device.account, "U:wearer-42");
            assert_eq!(device.plane, RequestPlane::Device);
        }
    }

    /// Plaintext and writes answer only the web plane: a signed-in wearer is
    /// served, a Pin behind the edge is refused with 403, and nobody is 401,
    /// never the demo partition, even in the development profile.
    #[test]
    fn web_account_for_admits_only_the_web_plane() {
        use crate::config::{EDGE_PRINCIPAL_HEADER, EDGE_TOKEN_HEADER};
        for trust in [internet_facing(), HttpTrust::development()] {
            let state = ApiState::for_tests(
                fresh(),
                fresh_keys(),
                DEMO_PRINCIPAL,
                trust,
                Some(test_verifier()),
                None,
            );
            let bearer = format!("Bearer {}", bearer_for("alice"));
            let web = state
                .web_account_for(&headers_of(&[("authorization", &bearer)]))
                .expect("a verified Bearer is the web plane");
            assert_eq!(web.account, "U:alice");

            let [xfcc, ..] = edge_subjects("alice");
            let device = headers_of(&[
                (EDGE_PRINCIPAL_HEADER, &xfcc),
                (EDGE_TOKEN_HEADER, EDGE_TOKEN),
            ]);
            assert_eq!(
                state.web_account_for(&device).err(),
                Some(StatusCode::FORBIDDEN)
            );
            for projected in [
                headers_of(&[
                    (EDGE_PRINCIPAL_HEADER, &xfcc),
                    (RETIRED_PROJECTION_HEADER, "projection-test-token"),
                ]),
                headers_of(&[
                    (EDGE_PRINCIPAL_HEADER, &xfcc),
                    (EDGE_TOKEN_HEADER, EDGE_TOKEN),
                    (RETIRED_PROJECTION_HEADER, "projection-test-token"),
                ]),
            ] {
                assert!(
                    state.web_account_for(&projected).is_err(),
                    "the retired projection header opens no plaintext"
                );
            }
        }
        let development = ApiState::for_tests(
            fresh(),
            fresh_keys(),
            DEMO_PRINCIPAL,
            HttpTrust::development(),
            None,
            None,
        );
        assert_eq!(
            development
                .web_account_for(&axum::http::HeaderMap::new())
                .err(),
            Some(StatusCode::FORBIDDEN),
            "the developer fallback reads, but never writes or sees plaintext"
        );
        let internet = ApiState::for_tests(
            fresh(),
            fresh_keys(),
            DEMO_PRINCIPAL,
            internet_facing(),
            None,
            None,
        );
        assert_eq!(
            internet
                .web_account_for(&axum::http::HeaderMap::new())
                .err(),
            Some(StatusCode::UNAUTHORIZED)
        );
    }
}
