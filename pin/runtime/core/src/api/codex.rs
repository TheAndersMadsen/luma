use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::StreamExt as _;
use reqwest::{Client as HttpClient, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::ApiState;
use crate::config::{validate_codex_bridge_token, validate_codex_bridge_url};
use crate::llm::codex_bridge::{
    build_bridge_http_client, verify_bridge_identity, BridgeIdentityError,
};

const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_USER_CODE_CHARS: usize = 64;
const MAX_VERIFICATION_URL_CHARS: usize = 2_048;
const MAX_BRIDGE_RESPONSE_BYTES: usize = 16 * 1024;
const OFFICIAL_DEVICE_AUTH_HOST: &str = "auth.openai.com";

pub fn router() -> Router<ApiState> {
    Router::new()
        .route("/codex/status", get(get_status))
        .route("/codex/login/device-code", post(start_device_code_login))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CodexStatusResponse {
    pub state: CodexStatusState,
    pub ready: bool,
    pub login_mode: Option<&'static str>,
    pub login_pending: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexStatusState {
    NotConfigured,
    Unreachable,
    Unauthorized,
    Unavailable,
    SignedOut,
    Ready,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DeviceCodeLoginResponse {
    pub verification_url: String,
    pub user_code: String,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatusResponse {
    ready: bool,
    login_mode: Option<String>,
    #[serde(default)]
    login_pending: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeDeviceCodeResponse {
    verification_url: String,
    user_code: String,
}

#[derive(Debug)]
enum ProxyError {
    InvalidConfiguration,
    Transport,
    Unauthorized,
    Unavailable,
    InvalidResponse,
}

async fn get_status(State(state): State<ApiState>) -> Json<CodexStatusResponse> {
    let Some((base_url, token, client)) = bridge_configuration(&state).await else {
        return Json(CodexStatusResponse {
            state: CodexStatusState::NotConfigured,
            ready: false,
            login_mode: None,
            login_pending: false,
        });
    };

    let response = match fetch_status(&client, &base_url, &token).await {
        Ok(status) => {
            let ready = status.ready && status.login_mode.as_deref() == Some("chatgpt");
            CodexStatusResponse {
                state: if ready {
                    CodexStatusState::Ready
                } else {
                    CodexStatusState::SignedOut
                },
                ready,
                login_mode: public_login_mode(status.login_mode.as_deref()),
                login_pending: status.login_pending,
            }
        }
        Err(ProxyError::Unauthorized) => CodexStatusResponse {
            state: CodexStatusState::Unauthorized,
            ready: false,
            login_mode: None,
            login_pending: false,
        },
        Err(ProxyError::Transport) => CodexStatusResponse {
            state: CodexStatusState::Unreachable,
            ready: false,
            login_mode: None,
            login_pending: false,
        },
        Err(ProxyError::InvalidConfiguration) => CodexStatusResponse {
            state: CodexStatusState::NotConfigured,
            ready: false,
            login_mode: None,
            login_pending: false,
        },
        Err(ProxyError::Unavailable | ProxyError::InvalidResponse) => CodexStatusResponse {
            state: CodexStatusState::Unavailable,
            ready: false,
            login_mode: None,
            login_pending: false,
        },
    };

    Json(response)
}

async fn start_device_code_login(State(state): State<ApiState>) -> Response {
    let Some((base_url, token, client)) = bridge_configuration(&state).await else {
        return error_response(
            StatusCode::CONFLICT,
            "Configure the Codex host bridge before starting sign-in.",
        );
    };

    match fetch_device_code(&client, &base_url, &token).await {
        Ok(response) => Json(response).into_response(),
        Err(ProxyError::InvalidConfiguration) => error_response(
            StatusCode::CONFLICT,
            "The Codex host bridge configuration is invalid.",
        ),
        Err(ProxyError::Unauthorized) => error_response(
            StatusCode::BAD_GATEWAY,
            "The Codex host bridge rejected its access token.",
        ),
        Err(ProxyError::Transport) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "The Codex host bridge could not be reached.",
        ),
        Err(ProxyError::Unavailable | ProxyError::InvalidResponse) => error_response(
            StatusCode::BAD_GATEWAY,
            "The Codex host bridge could not start sign-in.",
        ),
    }
}

async fn bridge_configuration(state: &ApiState) -> Option<(String, String, HttpClient)> {
    let config = state.shared_config.read().await;
    let token = config.llm.resolve_codex_bridge_token()?;
    if validate_codex_bridge_token(&token).is_err() {
        return None;
    }
    let client = build_bridge_http_client(&config.llm).ok()?;
    Some((config.llm.resolve_codex_bridge_url(), token, client))
}

async fn fetch_status(
    client: &HttpClient,
    base_url: &str,
    token: &str,
) -> Result<BridgeStatusResponse, ProxyError> {
    let endpoint = bridge_endpoint(base_url, "status")?;
    verify_bridge_identity(client, base_url, token)
        .await
        .map_err(proxy_identity_error)?;
    let response = client
        .get(endpoint)
        .bearer_auth(token)
        .timeout(STATUS_TIMEOUT)
        .send()
        .await
        .map_err(|_| ProxyError::Transport)?;

    match response.status() {
        StatusCode::UNAUTHORIZED => Err(ProxyError::Unauthorized),
        status if !status.is_success() => Err(ProxyError::Unavailable),
        _ => decode_limited_json(response).await,
    }
}

async fn fetch_device_code(
    client: &HttpClient,
    base_url: &str,
    token: &str,
) -> Result<DeviceCodeLoginResponse, ProxyError> {
    let endpoint = bridge_endpoint(base_url, "login/device-code")?;
    verify_bridge_identity(client, base_url, token)
        .await
        .map_err(proxy_identity_error)?;
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .timeout(LOGIN_TIMEOUT)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| ProxyError::Transport)?;

    match response.status() {
        StatusCode::UNAUTHORIZED => return Err(ProxyError::Unauthorized),
        status if !status.is_success() => return Err(ProxyError::Unavailable),
        _ => {}
    }

    let response = decode_limited_json::<BridgeDeviceCodeResponse>(response).await?;
    validate_device_code_response(response)
}

fn proxy_identity_error(error: BridgeIdentityError) -> ProxyError {
    match error {
        BridgeIdentityError::InvalidConfiguration => ProxyError::InvalidConfiguration,
        BridgeIdentityError::Transport => ProxyError::Transport,
        BridgeIdentityError::Unavailable => ProxyError::Unavailable,
        BridgeIdentityError::Randomness | BridgeIdentityError::InvalidResponse => {
            ProxyError::InvalidResponse
        }
    }
}

async fn decode_limited_json<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, ProxyError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BRIDGE_RESPONSE_BYTES as u64)
    {
        return Err(ProxyError::InvalidResponse);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ProxyError::Transport)?;
        if body.len().saturating_add(chunk.len()) > MAX_BRIDGE_RESPONSE_BYTES {
            return Err(ProxyError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ProxyError::InvalidResponse)
}

fn bridge_endpoint(base_url: &str, suffix: &str) -> Result<Url, ProxyError> {
    validate_codex_bridge_url(base_url).map_err(|_| ProxyError::InvalidConfiguration)?;
    let mut url = Url::parse(base_url.trim()).map_err(|_| ProxyError::InvalidConfiguration)?;

    let base_path = url.path().trim_end_matches('/');
    let path = if base_path.is_empty() {
        format!("/{suffix}")
    } else {
        format!("{base_path}/{suffix}")
    };
    url.set_path(&path);
    Ok(url)
}

fn validate_device_code_response(
    response: BridgeDeviceCodeResponse,
) -> Result<DeviceCodeLoginResponse, ProxyError> {
    let verification_url =
        Url::parse(&response.verification_url).map_err(|_| ProxyError::InvalidResponse)?;
    if response.verification_url.len() > MAX_VERIFICATION_URL_CHARS
        || verification_url.scheme() != "https"
        || verification_url.host_str() != Some(OFFICIAL_DEVICE_AUTH_HOST)
        || verification_url.port_or_known_default() != Some(443)
        || !matches!(verification_url.path(), "/device" | "/codex/device")
        || verification_url.query().is_some()
        || verification_url.fragment().is_some()
        || !verification_url.username().is_empty()
        || verification_url.password().is_some()
    {
        return Err(ProxyError::InvalidResponse);
    }

    let user_code = response.user_code.trim();
    if user_code.is_empty()
        || user_code.chars().count() > MAX_USER_CODE_CHARS
        || !user_code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(ProxyError::InvalidResponse);
    }

    Ok(DeviceCodeLoginResponse {
        verification_url: verification_url.to_string(),
        user_code: user_code.to_string(),
    })
}

fn public_login_mode(mode: Option<&str>) -> Option<&'static str> {
    match mode {
        Some("chatgpt") => Some("chatgpt"),
        Some("apiKey") | Some("apikey") => Some("api_key"),
        Some(_) => Some("other"),
        None => None,
    }
}

fn error_response(status: StatusCode, error: &'static str) -> Response {
    (status, Json(ErrorResponse { error })).into_response()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use axum::extract::{Json as AxumJson, Query};
    use axum::http::HeaderMap;
    use axum::routing::{get, post, MethodRouter};
    use serde_json::{json, Value};

    use super::*;
    use crate::llm::codex_bridge::challenge_proof_for_test;

    const TEST_TOKEN: &str = "unit-test-bridge-token-0123456789abcdef";

    fn valid_challenge_route(events: Option<Arc<Mutex<Vec<&'static str>>>>) -> MethodRouter {
        get(
            move |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| {
                let events = events.clone();
                async move {
                    assert!(headers.get("authorization").is_none());
                    if let Some(events) = events {
                        events.lock().unwrap().push("challenge");
                    }
                    let nonce = query.get("nonce").unwrap();
                    AxumJson(json!({
                        "proof": challenge_proof_for_test(TEST_TOKEN, nonce)
                    }))
                }
            },
        )
    }

    async fn test_server(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn endpoints_allow_https_remote_but_plain_http_only_on_loopback() {
        assert!(bridge_endpoint("http://127.0.0.1:8765", "status").is_ok());
        assert!(bridge_endpoint("http://[::1]:8765/bridge", "status").is_ok());
        assert!(bridge_endpoint("http://localhost:8765", "status").is_ok());
        assert!(bridge_endpoint("https://127.0.0.1:8765", "status").is_ok());
        assert!(bridge_endpoint("https://192.0.2.1:8765", "status").is_ok());
        assert!(bridge_endpoint("https://bridge.example.test:8765", "status").is_ok());
        assert!(bridge_endpoint("http://192.0.2.1:8765", "status").is_err());
        assert!(bridge_endpoint("http://user:secret@127.0.0.1:8765", "status").is_err());
        assert!(bridge_endpoint("https://0.0.0.0:8765", "status").is_err());
        assert!(bridge_endpoint("https://bridge.example.test:8765?q=1", "status").is_err());
        assert!(bridge_endpoint("https://bridge.example.test:8765#part", "status").is_err());
    }

    #[test]
    fn endpoint_preserves_a_bridge_base_path() {
        assert_eq!(
            bridge_endpoint("http://127.0.0.1:8765/bridge/", "login/device-code")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8765/bridge/login/device-code"
        );
    }

    #[tokio::test]
    async fn status_uses_bearer_auth_and_sanitizes_login_mode() {
        let observed = Arc::new(Mutex::new(None));
        let handler_observed = Arc::clone(&observed);
        let events = Arc::new(Mutex::new(Vec::new()));
        let handler_events = Arc::clone(&events);
        let app = Router::new()
            .route(
                "/challenge",
                valid_challenge_route(Some(Arc::clone(&events))),
            )
            .route(
                "/status",
                get(move |headers: HeaderMap| {
                    let observed = Arc::clone(&handler_observed);
                    let events = Arc::clone(&handler_events);
                    async move {
                        events.lock().unwrap().push("status");
                        *observed.lock().unwrap() = headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                        AxumJson(json!({
                            "ready": false,
                            "loginMode": "future-mode",
                            "loginPending": true
                        }))
                    }
                }),
            );
        let (base_url, server) = test_server(app).await;

        let response = fetch_status(&HttpClient::new(), &base_url, TEST_TOKEN)
            .await
            .unwrap();
        assert!(!response.ready);
        assert!(response.login_pending);
        assert_eq!(
            public_login_mode(response.login_mode.as_deref()),
            Some("other")
        );
        let expected_authorization = format!("Bearer {TEST_TOKEN}");
        assert_eq!(
            observed.lock().unwrap().as_deref(),
            Some(expected_authorization.as_str())
        );
        assert_eq!(*events.lock().unwrap(), ["challenge", "status"]);
        server.abort();
    }

    #[tokio::test]
    async fn login_returns_only_user_facing_fields() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let handler_events = Arc::clone(&events);
        let app = Router::new()
            .route(
                "/challenge",
                valid_challenge_route(Some(Arc::clone(&events))),
            )
            .route(
                "/login/device-code",
                post(move |AxumJson(_body): AxumJson<Value>| {
                    let events = Arc::clone(&handler_events);
                    async move {
                        events.lock().unwrap().push("login");
                        AxumJson(json!({
                            "loginId": "internal-login-id",
                            "verificationUrl": "https://auth.openai.com/device",
                            "userCode": "ABCD-EFGH"
                        }))
                    }
                }),
            );
        let (base_url, server) = test_server(app).await;

        let response = fetch_device_code(&HttpClient::new(), &base_url, TEST_TOKEN)
            .await
            .unwrap();
        assert_eq!(response.user_code, "ABCD-EFGH");
        assert_eq!(response.verification_url, "https://auth.openai.com/device");
        assert!(!serde_json::to_string(&response)
            .unwrap()
            .contains("internal-login-id"));
        assert_eq!(*events.lock().unwrap(), ["challenge", "login"]);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_oversized_bridge_responses() {
        let app = Router::new()
            .route("/challenge", valid_challenge_route(None))
            .route(
                "/status",
                get(|| async { "x".repeat(MAX_BRIDGE_RESPONSE_BYTES + 1) }),
            );
        let (base_url, server) = test_server(app).await;

        assert!(matches!(
            fetch_status(&HttpClient::new(), &base_url, TEST_TOKEN).await,
            Err(ProxyError::InvalidResponse)
        ));
        server.abort();
    }

    #[tokio::test]
    async fn wrong_challenge_proof_fails_before_authenticated_status_request() {
        let status_calls = Arc::new(Mutex::new(0_u32));
        let handler_status_calls = Arc::clone(&status_calls);
        let challenge_observed = Arc::new(Mutex::new(None));
        let handler_challenge_observed = Arc::clone(&challenge_observed);
        let app = Router::new()
            .route(
                "/challenge",
                get(
                    move |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| {
                        let observed = Arc::clone(&handler_challenge_observed);
                        async move {
                            *observed.lock().unwrap() =
                                Some((headers, query.get("nonce").unwrap().clone()));
                            AxumJson(json!({
                                "proof": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                            }))
                        }
                    },
                ),
            )
            .route(
                "/status",
                get(move || {
                    let calls = Arc::clone(&handler_status_calls);
                    async move {
                        *calls.lock().unwrap() += 1;
                        AxumJson(json!({ "ready": true, "loginMode": "chatgpt" }))
                    }
                }),
            );
        let (base_url, server) = test_server(app).await;

        assert!(matches!(
            fetch_status(&HttpClient::new(), &base_url, TEST_TOKEN).await,
            Err(ProxyError::InvalidResponse)
        ));
        assert_eq!(*status_calls.lock().unwrap(), 0);
        let (headers, nonce) = challenge_observed.lock().unwrap().take().unwrap();
        assert!(headers.get("authorization").is_none());
        assert!(!nonce.contains(TEST_TOKEN));
        assert!(!nonce.contains("status"));
        server.abort();
    }

    #[test]
    fn rejects_unsafe_device_code_responses() {
        let unsafe_url = BridgeDeviceCodeResponse {
            verification_url: "http://auth.example.test/device".into(),
            user_code: "ABCD-EFGH".into(),
        };
        assert!(matches!(
            validate_device_code_response(unsafe_url),
            Err(ProxyError::InvalidResponse)
        ));

        let untrusted_https_host = BridgeDeviceCodeResponse {
            verification_url: "https://auth.example.test/device".into(),
            user_code: "ABCD-EFGH".into(),
        };
        assert!(matches!(
            validate_device_code_response(untrusted_https_host),
            Err(ProxyError::InvalidResponse)
        ));

        let untrusted_path = BridgeDeviceCodeResponse {
            verification_url: "https://auth.openai.com/unrelated".into(),
            user_code: "ABCD-EFGH".into(),
        };
        assert!(matches!(
            validate_device_code_response(untrusted_path),
            Err(ProxyError::InvalidResponse)
        ));

        let unsafe_code = BridgeDeviceCodeResponse {
            verification_url: "https://auth.example.test/device".into(),
            user_code: "<script>".into(),
        };
        assert!(matches!(
            validate_device_code_response(unsafe_code),
            Err(ProxyError::InvalidResponse)
        ));
    }
}
