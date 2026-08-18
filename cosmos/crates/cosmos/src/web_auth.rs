//! The web authentication plane — Keycloak/OIDC Bearer tokens.
//!
//! Humane ran two front doors on one identity. The device plane is an mTLS
//! DeviceUser certificate the edge verifies (see `config.rs`). The web plane —
//! the Center dashboard — was **Keycloak**: the browser signs in, and every API
//! call carries `Authorization: Bearer <jwt>` issued by
//! `auth.humane.center/realms/humane`. The `sub` claim is the account user id.
//!
//! This verifies that token so the backend derives identity from a *signature it
//! checks*, not from a header the caller set. That distinction is the whole
//! authorization boundary: the Center forwards the user's token, it does not
//! assert who the user is. A verified `sub` becomes
//! [`AuthenticatedPrincipal::for_user`] — the same principal the user's enrolled
//! Pin resolves to, which is what lets one person see one set of data from both.
//!
//! ## Why the verify path is synchronous
//!
//! It runs inside the request authenticator, which is called from a Tower layer
//! on every RPC and is not async. Fetching JWKS per request would block that
//! layer. So the signing keys are fetched once at startup and refreshed by a
//! background task into an `RwLock`; `verify` only reads that cache and validates
//! the token — no network on the hot path.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use cosmos_core::AuthenticatedPrincipal;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;

/// How the operator configures the web plane. Absent ⇒ the plane is off and no
/// Bearer token is ever trusted.
#[derive(Clone, Debug)]
pub struct OidcConfig {
    /// The `iss` every token must contain, e.g. `https://auth.humane.center/realms/humane`.
    pub issuer: String,
    /// The `aud` a token must include (a Keycloak client id). Empty ⇒ audience
    /// is not checked, which Keycloak access tokens sometimes require.
    pub audience: Option<String>,
    /// Where to fetch the signing keys. Defaults to the realm's standard
    /// `.../protocol/openid-connect/certs` when only the issuer is given.
    pub jwks_uri: String,
}

impl OidcConfig {
    /// Read the web-plane config from the environment. Returns `None` when
    /// `COSMOS_OIDC_ISSUER` is unset — the plane stays off and fails closed.
    pub fn from_env() -> Option<Self> {
        let issuer = std::env::var("COSMOS_OIDC_ISSUER")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        let jwks_uri = std::env::var("COSMOS_OIDC_JWKS_URI")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                format!(
                    "{}/protocol/openid-connect/certs",
                    issuer.trim_end_matches('/')
                )
            });
        let audience = std::env::var("COSMOS_OIDC_AUDIENCE")
            .ok()
            .filter(|value| !value.trim().is_empty());
        Some(Self {
            issuer,
            audience,
            jwks_uri,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WebAuthError {
    #[error("malformed bearer token")]
    Malformed,
    #[error("token names no signing key")]
    NoKid,
    #[error("unknown signing key")]
    UnknownKey,
    #[error("token failed verification: {0}")]
    Invalid(String),
    #[error("token subject is not a usable principal")]
    BadSubject,
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
}

/// A single JWKS key, the subset needed to build an RSA verifier.
#[derive(Deserialize)]
struct Jwk {
    kid: String,
    #[serde(default)]
    kty: String,
    n: Option<String>,
    e: Option<String>,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

/// The verifier this process built at startup, if the web plane is configured.
///
/// The gRPC services receive it by construction (`RequestAuthenticator::with_web`).
/// The HTTP surfaces cannot: their router is built before the verifier exists and
/// takes no such parameter, so they read it here instead of threading a new
/// argument through every constructor. Set once at startup and never replaced —
/// a verifier swapped mid-run would change who a live request resolves to.
static INSTALLED: std::sync::OnceLock<Arc<JwtVerifier>> = std::sync::OnceLock::new();

/// Publish the process's verifier. Called once, from startup.
pub fn install_verifier(verifier: Arc<JwtVerifier>) {
    let _ = INSTALLED.set(verifier);
}

/// The process's verifier, or `None` when the web plane is off — in which case a
/// Bearer token is not *rejected*, it simply cannot identify anyone, and the
/// caller falls back to whatever plane it was already using.
pub fn configured_verifier() -> Option<Arc<JwtVerifier>> {
    INSTALLED.get().cloned()
}

/// Verifies Keycloak Bearer tokens against a cached, background-refreshed JWKS.
pub struct JwtVerifier {
    config: OidcConfig,
    keys: Arc<RwLock<HashMap<String, DecodingKey>>>,
}

impl JwtVerifier {
    /// Build a verifier and warm its key cache. Errors if the initial JWKS
    /// cannot be fetched — starting the web plane with no keys would fail every
    /// token, so refuse loudly instead.
    pub async fn connect(config: OidcConfig) -> Result<Arc<Self>, String> {
        let keys = fetch_jwks(&config.jwks_uri)
            .await
            .map_err(|error| format!("initial JWKS fetch from {}: {error}", config.jwks_uri))?;
        let verifier = Arc::new(Self {
            config,
            keys: Arc::new(RwLock::new(keys)),
        });
        verifier.clone().spawn_refresher();
        Ok(verifier)
    }

    /// Build a verifier from an explicit key set, for tests — no network.
    #[cfg(test)]
    pub(crate) fn with_keys(config: OidcConfig, keys: HashMap<String, DecodingKey>) -> Arc<Self> {
        Arc::new(Self {
            config,
            keys: Arc::new(RwLock::new(keys)),
        })
    }

    /// Refresh the JWKS in the background so key rotation is picked up without a
    /// restart. A failed refresh keeps the previous keys rather than emptying the
    /// cache — a transient JWKS outage must not lock every user out.
    fn spawn_refresher(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(600));
            interval.tick().await; // the first tick is immediate; skip it, cache is warm
            loop {
                interval.tick().await;
                match fetch_jwks(&self.config.jwks_uri).await {
                    Ok(fresh) if !fresh.is_empty() => {
                        if let Ok(mut guard) = self.keys.write() {
                            *guard = fresh;
                        }
                    }
                    Ok(_) => tracing::warn!("JWKS refresh returned no keys; keeping current set"),
                    Err(error) => {
                        tracing::warn!(%error, "JWKS refresh failed; keeping current set")
                    }
                }
            }
        });
    }

    /// Verify a raw bearer token and return the authenticated principal.
    ///
    /// Synchronous by design (see the module docs): decode the header for its
    /// `kid`, look the key up in the warm cache, then validate signature, issuer,
    /// audience and expiry. Any failure is a closed door.
    pub fn verify(&self, token: &str) -> Result<AuthenticatedPrincipal, WebAuthError> {
        let header = decode_header(token).map_err(|_| WebAuthError::Malformed)?;
        let kid = header.kid.ok_or(WebAuthError::NoKid)?;
        let key = {
            let guard = self.keys.read().map_err(|_| WebAuthError::UnknownKey)?;
            guard.get(&kid).cloned().ok_or(WebAuthError::UnknownKey)?
        };

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.config.issuer]);
        match &self.config.audience {
            Some(audience) => validation.set_audience(&[audience]),
            // Keycloak access tokens frequently omit a matching `aud`; only
            // enforce it when the operator names one to enforce.
            None => validation.validate_aud = false,
        }

        let data = decode::<Claims>(token, &key, &validation)
            .map_err(|error| WebAuthError::Invalid(error.to_string()))?;
        AuthenticatedPrincipal::for_user(&data.claims.sub).map_err(|_| WebAuthError::BadSubject)
    }
}

/// Fetch a JWKS document and turn its RSA keys into verifiers, keyed by `kid`.
async fn fetch_jwks(jwks_uri: &str) -> Result<HashMap<String, DecodingKey>, String> {
    let jwks: Jwks = reqwest::Client::new()
        .get(jwks_uri)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    Ok(keys_from_jwks(jwks))
}

fn keys_from_jwks(jwks: Jwks) -> HashMap<String, DecodingKey> {
    let mut map = HashMap::new();
    for jwk in jwks.keys {
        if jwk.kty != "RSA" {
            continue;
        }
        if let (Some(n), Some(e)) = (jwk.n.as_deref(), jwk.e.as_deref()) {
            if let Ok(key) = DecodingKey::from_rsa_components(n, e) {
                map.insert(jwk.kid, key);
            }
        }
    }
    map
}

/// Generate one process-local JWT keypair for tests. Keeping the private half
/// ephemeral avoids shipping a private key fixture in the source tree.
#[cfg(test)]
pub(crate) fn test_jwt_keypair() -> &'static (String, String) {
    use rsa::RsaPrivateKey;
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
    use std::sync::OnceLock;

    static KEYS: OnceLock<(String, String)> = OnceLock::new();
    KEYS.get_or_init(|| {
        let private = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)
            .expect("generate process-local JWT test key");
        let private_pem = private
            .to_pkcs8_pem(LineEnding::LF)
            .expect("encode JWT test private key")
            .to_string();
        let public_pem = private
            .to_public_key()
            .to_public_key_pem(LineEnding::LF)
            .expect("encode JWT test public key");
        (private_pem, public_pem)
    })
}

/// Pull a raw bearer token out of an `authorization` header value, if present.
pub fn bearer_token(header_value: &str) -> Option<&str> {
    header_value
        .strip_prefix("Bearer ")
        .or_else(|| header_value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};

    const TEST_KID: &str = "test-key-1";
    fn verifier(audience: Option<&str>) -> Arc<JwtVerifier> {
        let (_, public_pem) = test_jwt_keypair();
        let mut keys = HashMap::new();
        keys.insert(
            TEST_KID.to_owned(),
            DecodingKey::from_rsa_pem(public_pem.as_bytes()).unwrap(),
        );
        JwtVerifier::with_keys(
            OidcConfig {
                issuer: "https://auth.humane.center/realms/humane".to_owned(),
                audience: audience.map(str::to_owned),
                jwks_uri: "unused-in-test".to_owned(),
            },
            keys,
        )
    }

    fn mint(claims: serde_json::Value) -> String {
        let (private_pem, _) = test_jwt_keypair();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(TEST_KID.to_owned());
        encode(
            &header,
            &claims,
            &EncodingKey::from_rsa_pem(private_pem.as_bytes()).unwrap(),
        )
        .unwrap()
    }

    /// What one wearer-authenticated gRPC call pays for identity, measured.
    ///
    /// `#[ignore]`d and assertion-free: it prints a number so a claim about the
    /// auth path can be checked rather than argued. Run it with
    ///
    /// ```sh
    /// cargo test --release -p cosmos --lib bearer_verification_cost \
    ///   -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "benchmark: prints timings, asserts nothing"]
    fn bearer_verification_cost() {
        use std::time::Instant;
        let verifier = verifier(None);
        let token = mint(serde_json::json!({
            "iss": "https://auth.humane.center/realms/humane",
            "sub": "11111111-2222-3333-4444-555555555555",
            "exp": exp(),
        }));
        // Warm: first call touches lazily-initialised crypto state.
        verifier.verify(&token).expect("valid token");

        const ITERATIONS: u32 = 2_000;
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            std::hint::black_box(verifier.verify(&token)).expect("valid token");
        }
        let per_verify = start.elapsed() / ITERATIONS;
        println!("JwtVerifier::verify (RS256):     {per_verify:?}");
        println!(
            "per authenticated gRPC call:     {:?} (AuthLayer + handler both verify)",
            per_verify * 2
        );
    }

    fn exp() -> i64 {
        // Fixed future timestamp — the harness forbids wall-clock reads.
        4_102_444_800 // 2100-01-01
    }

    /// End-to-end against a REAL Keycloak, not the throwaway keypair: fetch the
    /// live JWKS, verify a live access token, and confirm it resolves to
    /// `U:<sub>`. Ignored by default (needs a running IdP); driven by env from
    /// `deploy/keycloak` — see that dir's notes for the one-liner that mints the
    /// token. This is the test that proves the plane accepts tokens a browser
    /// login actually produces, key rotation and `aud: account` included.
    #[tokio::test]
    #[ignore = "requires a running Keycloak; set KC_TEST_* (see deploy/keycloak)"]
    async fn a_live_keycloak_token_resolves_to_the_user_principal() {
        let issuer = std::env::var("KC_TEST_ISSUER").expect("KC_TEST_ISSUER");
        let jwks_uri = std::env::var("KC_TEST_JWKS").expect("KC_TEST_JWKS");
        let token = std::env::var("KC_TEST_TOKEN").expect("KC_TEST_TOKEN");
        let expected_sub = std::env::var("KC_TEST_SUB").expect("KC_TEST_SUB");

        let verifier = JwtVerifier::connect(OidcConfig {
            issuer,
            audience: None, // Keycloak access tokens use aud: account, not the client.
            jwks_uri,
        })
        .await
        .expect("connect + warm JWKS from live Keycloak");

        let principal = verifier.verify(&token).expect("live token verifies");
        assert_eq!(
            principal.expose_for_authorization(),
            format!("U:{expected_sub}"),
            "a live Keycloak login must resolve to the same U:<sub> partition a device does"
        );
    }

    #[test]
    fn a_valid_keycloak_token_resolves_to_the_user_principal() {
        let sub = "a035ad28-f32c-4086-bec1-8bb2343a4019";
        let token = mint(serde_json::json!({
            "sub": sub,
            "iss": "https://auth.humane.center/realms/humane",
            "exp": exp(),
        }));
        let principal = verifier(None).verify(&token).expect("valid token");
        assert_eq!(
            principal.expose_for_authorization(),
            format!("U:{sub}"),
            "the principal must be the account user, so web and device share it",
        );
    }

    #[test]
    fn a_token_from_the_wrong_issuer_is_refused() {
        let token = mint(serde_json::json!({
            "sub": "x", "iss": "https://evil.example/realms/humane", "exp": exp(),
        }));
        assert!(matches!(
            verifier(None).verify(&token),
            Err(WebAuthError::Invalid(_))
        ));
    }

    #[test]
    fn an_expired_token_is_refused() {
        let token = mint(serde_json::json!({
            "sub": "x", "iss": "https://auth.humane.center/realms/humane", "exp": 1_000_000_000,
        }));
        assert!(matches!(
            verifier(None).verify(&token),
            Err(WebAuthError::Invalid(_))
        ));
    }

    /// A token signed by a DIFFERENT key must not verify — the whole point of
    /// JWKS is that only the issuer's key is trusted.
    #[test]
    fn a_token_signed_by_an_unknown_key_is_refused() {
        // Verifier trusts TEST_KID; mint a token claiming a different kid.
        let (private_pem, _) = test_jwt_keypair();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("some-other-key".to_owned());
        let token = encode(
            &header,
            &serde_json::json!({ "sub": "x", "iss": "https://auth.humane.center/realms/humane", "exp": exp() }),
            &EncodingKey::from_rsa_pem(private_pem.as_bytes()).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            verifier(None).verify(&token),
            Err(WebAuthError::UnknownKey)
        ));
    }

    #[test]
    fn audience_is_enforced_only_when_configured() {
        let with_aud = mint(serde_json::json!({
            "sub": "x", "iss": "https://auth.humane.center/realms/humane",
            "aud": "center", "exp": exp(),
        }));
        // Configured to require "center": passes.
        assert!(verifier(Some("center")).verify(&with_aud).is_ok());
        // Configured to require "other": rejected.
        assert!(verifier(Some("other")).verify(&with_aud).is_err());
        // No audience configured: not checked.
        assert!(verifier(None).verify(&with_aud).is_ok());
    }

    #[test]
    fn garbage_is_not_a_token() {
        assert!(matches!(
            verifier(None).verify("not.a.jwt"),
            Err(WebAuthError::Malformed)
        ));
    }

    #[test]
    fn bearer_is_stripped_case_insensitively_and_trimmed() {
        assert_eq!(bearer_token("Bearer abc"), Some("abc"));
        assert_eq!(bearer_token("bearer  abc "), Some("abc"));
        assert_eq!(bearer_token("Basic abc"), None);
        assert_eq!(bearer_token("Bearer "), None);
    }
}
