use std::fmt;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures::StreamExt as _;
use hmac::{Hmac, Mac as _};
use rand::TryRng as _;
use reqwest::{Certificate, Client as HttpClient, Url};
use serde::Deserialize;
use sha2::Sha256;

use crate::config::{validate_codex_bridge_ca_pem, validate_codex_bridge_url, LlmConfig};

pub(crate) const BRIDGE_IDENTITY_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(5);
const CHALLENGE_NONCE_BYTES: usize = 32;
const CHALLENGE_PROOF_BYTES: usize = 32;
const CHALLENGE_PROOF_CHARS: usize = 43;
const MAX_CHALLENGE_RESPONSE_BYTES: usize = 256;
const CHALLENGE_DOMAIN: &[u8] = b"humane-system-hook/codex-bridge/identity/v1\0";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(test)]
pub(crate) const TEST_CA_PEM: &str = r#"-----BEGIN CERTIFICATE-----
MIIDNTCCAh2gAwIBAgIUYa88sZEnj7Lz8TFAJnXncoLnKmgwDQYJKoZIhvcNAQEL
BQAwKjEoMCYGA1UEAwwfUGVudW1icmFPUyBDb2RleCBCcmlkZ2UgVGVzdCBDQTAe
Fw0yNjA3MTMxNDI0MTdaFw0zNjA3MTAxNDI0MTdaMCoxKDAmBgNVBAMMH1BlbnVt
YnJhT1MgQ29kZXggQnJpZGdlIFRlc3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQCwt7ghwllRlBj8JEEmLNisQQcfBfe1oZjYGEAk+rQvZwMJ8dwi
j029XZF/n9N40mJ1cROEiYb+Fw43iu1NqqSOj8JHhi+u2N98l6ERkYrFuaFA92ep
NsyUp80sWSMeliDo1KFgK84M/XDhg0cx6CZHKPPabzEIZ1M1uXfMDoF3w47CJ6eX
CMOBcPCillrX4xj2Tl2K37lQELefa6cSWxZZGK4jnpZ18OTiWj8KzGDvH8MB4LOs
4HhcCOHQP9GrFFfsjN8iffOPQNVTeul+sqG6Qa4w02M8WRUakJRIpRHDawmmbNxu
b0DoscT5YgM9kMC07miwkp8EjZnKzlxeeHJdAgMBAAGjUzBRMB0GA1UdDgQWBBRK
5aoUdTxQGJFSx8StO6UI83lb7zAfBgNVHSMEGDAWgBRK5aoUdTxQGJFSx8StO6UI
83lb7zAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCnH6cORoHo
PBxOr+ephMNWt/kZZCxzm5lopMO6qCaK+RlpvdM2v07nSD6Pn2Cq+l0ETgjXlpfM
yJJqhJJYTeOdMJXQLCdrKETq4QQOE5odCErOUtfOJD9NngcPrztkd1HFEPZrfaC3
2e/Dpn2Ebbo1yGMiCn8ZGTQq+82Hej9/Obt253XTx6h4N6UIZpp8czJCO/+lnfdY
aJGu4cxKYnf2zO5aIfUDixlgYac4oXbLd1bQDvAX2meDQ6TFhMay8yMdtofq/sS/
1gO5OLhGw1BfUKmRKEtkJhQFZlGNnEIU8I6CcN4SUlparoUxSBQrqRmtb42Oc4nk
uUz+UkhCghMW
-----END CERTIFICATE-----"#;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BridgeIdentityError {
    InvalidConfiguration,
    Randomness,
    Transport,
    Unavailable,
    InvalidResponse,
}

impl fmt::Display for BridgeIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Codex bridge identity verification failed")
    }
}

impl std::error::Error for BridgeIdentityError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BridgeClientError {
    InvalidConfiguration,
    ClientConstruction,
}

impl fmt::Display for BridgeClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Codex bridge HTTP client configuration is invalid")
    }
}

impl std::error::Error for BridgeClientError {}

/// Build a bridge-only client. A private CA configured for the host bridge is
/// deliberately not installed in the shared client used by other providers.
pub(crate) fn build_bridge_http_client(
    config: &LlmConfig,
) -> Result<HttpClient, BridgeClientError> {
    validate_codex_bridge_url(&config.resolve_codex_bridge_url())
        .map_err(|_| BridgeClientError::InvalidConfiguration)?;

    let mut builder = HttpClient::builder()
        .tls_backend_native()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT);

    if let Some(ca_pem) = config.codex_bridge_ca_pem.as_deref() {
        validate_codex_bridge_ca_pem(ca_pem)
            .map_err(|_| BridgeClientError::InvalidConfiguration)?;
        let certificate = Certificate::from_pem(ca_pem.as_bytes())
            .map_err(|_| BridgeClientError::InvalidConfiguration)?;
        builder = builder.add_root_certificate(certificate);
    }

    builder
        .build()
        .map_err(|_| BridgeClientError::ClientConstruction)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeResponse {
    proof: String,
}

/// Prove that the bridge process knows the pairing token before a
/// caller sends that token or any operation-specific payload.
pub(crate) async fn verify_bridge_identity(
    client: &HttpClient,
    base_url: &str,
    token: &str,
) -> Result<(), BridgeIdentityError> {
    let mut nonce = [0_u8; CHALLENGE_NONCE_BYTES];
    let mut system_random = rand::rngs::SysRng;
    system_random
        .try_fill_bytes(&mut nonce)
        .map_err(|_| BridgeIdentityError::Randomness)?;
    verify_bridge_identity_with_nonce(client, base_url, token, &nonce).await
}

async fn verify_bridge_identity_with_nonce(
    client: &HttpClient,
    base_url: &str,
    token: &str,
    nonce: &[u8; CHALLENGE_NONCE_BYTES],
) -> Result<(), BridgeIdentityError> {
    let nonce_text = URL_SAFE_NO_PAD.encode(nonce);
    let mut endpoint = challenge_endpoint(base_url)?;
    endpoint.query_pairs_mut().append_pair("nonce", &nonce_text);
    let requested_endpoint = endpoint.clone();

    // Deliberately no Authorization header and no request body. The bearer and
    // operation payload are sent only after this proof verifies.
    let response = client
        .get(endpoint)
        .timeout(BRIDGE_IDENTITY_CHALLENGE_TIMEOUT)
        .send()
        .await
        .map_err(|_| BridgeIdentityError::Transport)?;
    if response.url() != &requested_endpoint {
        return Err(BridgeIdentityError::InvalidResponse);
    }
    if !response.status().is_success() {
        return Err(BridgeIdentityError::Unavailable);
    }

    let body = read_limited_challenge_response(response).await?;
    let response: ChallengeResponse =
        serde_json::from_slice(&body).map_err(|_| BridgeIdentityError::InvalidResponse)?;
    verify_challenge_proof(token, nonce, &response.proof)
}

fn challenge_endpoint(base_url: &str) -> Result<Url, BridgeIdentityError> {
    validate_codex_bridge_url(base_url).map_err(|_| BridgeIdentityError::InvalidConfiguration)?;
    let mut url =
        Url::parse(base_url.trim()).map_err(|_| BridgeIdentityError::InvalidConfiguration)?;
    url.set_query(None);
    url.set_fragment(None);
    let base_path = url.path().trim_end_matches('/');
    let path = if base_path.is_empty() {
        "/challenge".to_string()
    } else {
        format!("{base_path}/challenge")
    };
    url.set_path(&path);
    Ok(url)
}

async fn read_limited_challenge_response(
    response: reqwest::Response,
) -> Result<Vec<u8>, BridgeIdentityError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CHALLENGE_RESPONSE_BYTES as u64)
    {
        return Err(BridgeIdentityError::InvalidResponse);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BridgeIdentityError::Transport)?;
        if body.len().saturating_add(chunk.len()) > MAX_CHALLENGE_RESPONSE_BYTES {
            return Err(BridgeIdentityError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn verify_challenge_proof(
    token: &str,
    nonce: &[u8; CHALLENGE_NONCE_BYTES],
    proof: &str,
) -> Result<(), BridgeIdentityError> {
    if proof.len() != CHALLENGE_PROOF_CHARS {
        return Err(BridgeIdentityError::InvalidResponse);
    }
    let proof_bytes = URL_SAFE_NO_PAD
        .decode(proof)
        .map_err(|_| BridgeIdentityError::InvalidResponse)?;
    if proof_bytes.len() != CHALLENGE_PROOF_BYTES || URL_SAFE_NO_PAD.encode(&proof_bytes) != proof {
        return Err(BridgeIdentityError::InvalidResponse);
    }

    let mut mac = HmacSha256::new_from_slice(token.as_bytes())
        .map_err(|_| BridgeIdentityError::InvalidResponse)?;
    mac.update(CHALLENGE_DOMAIN);
    mac.update(nonce);
    mac.verify_slice(&proof_bytes)
        .map_err(|_| BridgeIdentityError::InvalidResponse)
}

#[cfg(test)]
pub(crate) fn challenge_proof_for_test(token: &str, nonce: &str) -> String {
    let nonce = URL_SAFE_NO_PAD.decode(nonce).unwrap();
    assert_eq!(nonce.len(), CHALLENGE_NONCE_BYTES);
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).unwrap();
    mac.update(CHALLENGE_DOMAIN);
    mac.update(&nonce);
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::OriginalUri;
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;

    use super::*;

    const TOKEN: &str = "unit-test-bridge-token-0123456789abcdef";
    const NONCE: [u8; CHALLENGE_NONCE_BYTES] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 31,
    ];
    const NONCE_TEXT: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const PROOF: &str = "JERTounjAunEGgqk4ZJDi8WSWbYnPeLD_sbDxbNzTNU";

    async fn test_server(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn proof_matches_the_node_protocol_vector_and_rejects_wrong_values() {
        assert!(verify_challenge_proof(TOKEN, &NONCE, PROOF).is_ok());
        assert_eq!(
            verify_challenge_proof(TOKEN, &NONCE, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            Err(BridgeIdentityError::InvalidResponse)
        );
        assert_eq!(
            verify_challenge_proof(TOKEN, &NONCE, "malformed"),
            Err(BridgeIdentityError::InvalidResponse)
        );
    }

    #[test]
    fn bridge_client_accepts_a_private_ca_only_for_https_bridge_configuration() {
        let config = LlmConfig {
            codex_bridge_url: Some("https://bridge.example.test:8765".into()),
            codex_bridge_ca_pem: Some(TEST_CA_PEM.into()),
            ..LlmConfig::default()
        };

        assert!(build_bridge_http_client(&config).is_ok());
    }

    #[test]
    fn bridge_client_rejects_invalid_private_ca_and_remote_plaintext() {
        let invalid_ca = LlmConfig {
            codex_bridge_url: Some("https://bridge.example.test:8765".into()),
            codex_bridge_ca_pem: Some("not a certificate".into()),
            ..LlmConfig::default()
        };
        assert_eq!(
            build_bridge_http_client(&invalid_ca).unwrap_err(),
            BridgeClientError::InvalidConfiguration
        );

        let remote_plaintext = LlmConfig {
            codex_bridge_url: Some("http://192.0.2.10:8765".into()),
            ..LlmConfig::default()
        };
        assert_eq!(
            build_bridge_http_client(&remote_plaintext).unwrap_err(),
            BridgeClientError::InvalidConfiguration
        );
    }

    #[tokio::test]
    async fn challenge_request_contains_only_the_fixed_nonce() {
        let observed = Arc::new(Mutex::new(None));
        let handler_observed = Arc::clone(&observed);
        let app = Router::new().route(
            "/challenge",
            get(move |headers: HeaderMap, OriginalUri(uri): OriginalUri| {
                let observed = Arc::clone(&handler_observed);
                async move {
                    *observed.lock().unwrap() = Some((headers, uri.to_string()));
                    Json(json!({ "proof": PROOF }))
                }
            }),
        );
        let (base_url, server) = test_server(app).await;

        verify_bridge_identity_with_nonce(&HttpClient::new(), &base_url, TOKEN, &NONCE)
            .await
            .unwrap();

        let (headers, target) = observed.lock().unwrap().take().unwrap();
        assert!(headers.get("authorization").is_none());
        assert_eq!(target, format!("/challenge?nonce={NONCE_TEXT}"));
        assert!(!target.contains(TOKEN));
        assert!(!target.contains("prompt-must-not-enter-challenge"));
        server.abort();
    }
}
