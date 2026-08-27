use std::collections::BTreeMap;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use futures::StreamExt as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

use super::ApiState;
use crate::config::MusicProvider;

pub(crate) const MAX_EGRESS_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_PROVIDER_REQUEST_BODY_BYTES: usize = 512 * 1024;
const MAX_PROVIDER_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const YOUTUBE_REQUEST_HOSTS: &[&str] = &[
    "www.youtube.com",
    "music.youtube.com",
    "youtube.com",
    "youtubei.googleapis.com",
    "jnn-pa.googleapis.com",
];
const REQUEST_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "content-type",
    "origin",
    "referer",
    "user-agent",
    "x-goog-api-format-version",
    "x-goog-api-key",
    "x-goog-authuser",
    "x-goog-visitor-id",
    "x-origin",
    "x-user-agent",
    "x-youtube-bootstrap-logged-in",
    "x-youtube-client-name",
    "x-youtube-client-version",
];
const RESPONSE_HEADERS: &[&str] = &["content-type", "content-length", "etag", "last-modified"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MusicEgressRequest {
    provider: MusicProvider,
    method: String,
    url: String,
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body_base64: Option<String>,
}

struct ValidatedEgressRequest {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Vec<u8>,
}

#[derive(Debug, Serialize)]
struct MusicEgressResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body_base64: String,
}

pub(crate) fn router() -> Router<ApiState> {
    Router::new().route("/egress", post(provider_egress))
}

fn allowed_youtube_url(url: &Url) -> bool {
    let Some(host) = url
        .host_str()
        .map(|value| value.trim_end_matches('.').to_ascii_lowercase())
    else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && YOUTUBE_REQUEST_HOSTS.contains(&host.as_str())
}

fn decode_canonical_base64(value: Option<&str>) -> Result<Vec<u8>, &'static str> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.len() > MAX_PROVIDER_REQUEST_BODY_BYTES.div_ceil(3) * 4 + 4 {
        return Err("music egress body is too large");
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "music egress body is invalid")?;
    if bytes.len() > MAX_PROVIDER_REQUEST_BODY_BYTES || STANDARD.encode(&bytes) != value {
        return Err("music egress body is invalid");
    }
    Ok(bytes)
}

fn validate_request(request: MusicEgressRequest) -> Result<ValidatedEgressRequest, &'static str> {
    if request.provider != MusicProvider::YoutubeMusic {
        return Err("music egress provider is unsupported");
    }
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "music egress method is invalid")?;
    if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
        return Err("music egress method is unsupported");
    }
    if request.url.len() > MAX_URL_BYTES {
        return Err("music egress URL is invalid");
    }
    let url = Url::parse(&request.url).map_err(|_| "music egress URL is invalid")?;
    if !allowed_youtube_url(&url) {
        return Err("music egress URL is not allowed");
    }
    let body = decode_canonical_base64(request.body_base64.as_deref())?;
    if method != Method::POST && !body.is_empty() {
        return Err("music egress body is not allowed for this method");
    }
    let mut headers = HeaderMap::new();
    let mut header_bytes = 0usize;
    for (name, value) in request.headers {
        if !REQUEST_HEADERS.contains(&name.as_str()) {
            return Err("music egress header is not allowed");
        }
        header_bytes = header_bytes
            .checked_add(name.len() + value.len())
            .ok_or("music egress headers are too large")?;
        if header_bytes > MAX_HEADER_BYTES || value.chars().any(char::is_control) {
            return Err("music egress headers are invalid");
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "music egress header is invalid")?;
        let value = HeaderValue::from_str(&value).map_err(|_| "music egress header is invalid")?;
        headers.insert(name, value);
    }
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    Ok(ValidatedEgressRequest {
        method,
        url,
        headers,
        body,
    })
}

pub(crate) fn validate_egress_payload(body: &[u8]) -> Result<(), &'static str> {
    if body.len() as u64 > MAX_EGRESS_REQUEST_BYTES {
        return Err("music egress request is too large");
    }
    let request: MusicEgressRequest =
        serde_json::from_slice(body).map_err(|_| "invalid music egress request")?;
    validate_request(request).map(|_| ())
}

async fn provider_egress(
    State(state): State<ApiState>,
    Json(request): Json<MusicEgressRequest>,
) -> Response {
    let request = match validate_request(request) {
        Ok(request) => request,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    match execute_provider_egress_request(&state.http_client, request, REQUEST_TIMEOUT).await {
        Ok(response) => Json(response).into_response(),
        Err(message) => (StatusCode::BAD_GATEWAY, message).into_response(),
    }
}

async fn execute_provider_egress_request(
    http_client: &reqwest::Client,
    request: ValidatedEgressRequest,
    timeout: Duration,
) -> Result<MusicEgressResponse, &'static str> {
    let mut upstream = http_client
        .request(request.method, request.url)
        .headers(request.headers)
        .timeout(timeout);
    if !request.body.is_empty() {
        upstream = upstream.body(request.body);
    }
    let response = upstream
        .send()
        .await
        .map_err(|_| "music provider egress was unavailable")?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_BODY_BYTES as u64)
    {
        return Err("music provider response was too large");
    }
    let status = response.status().as_u16();
    let headers = RESPONSE_HEADERS
        .iter()
        .filter_map(|name| {
            response
                .headers()
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|value| ((*name).to_owned(), value.to_owned()))
        })
        .collect::<BTreeMap<_, _>>();
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "music provider response failed")?;
        if body.len() + chunk.len() > MAX_PROVIDER_BODY_BYTES {
            return Err("music provider response was too large");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(MusicEgressResponse {
        status,
        headers,
        body_base64: STANDARD.encode(body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn request(url: &str) -> MusicEgressRequest {
        MusicEgressRequest {
            provider: MusicProvider::YoutubeMusic,
            method: "POST".into(),
            url: url.into(),
            headers: BTreeMap::from([
                ("content-type".into(), "application/json".into()),
                ("x-user-agent".into(), "bgutils/4.0.3".into()),
                ("x-youtube-client-name".into(), "67".into()),
            ]),
            body_base64: Some(STANDARD.encode(br#"{"videoId":"Zi_XLOBDo_Y"}"#)),
        }
    }

    #[test]
    fn youtube_player_request_is_closed_and_bounded() {
        let validated = validate_request(request(
            "https://youtubei.googleapis.com/youtubei/v1/player?key=public",
        ))
        .unwrap();
        assert_eq!(validated.method, Method::POST);
        assert_eq!(validated.url.host_str(), Some("youtubei.googleapis.com"));
        assert_eq!(validated.headers[ACCEPT_ENCODING], "identity");
        assert_eq!(validated.body, br#"{"videoId":"Zi_XLOBDo_Y"}"#);
    }

    #[test]
    fn music_egress_never_becomes_a_general_proxy() {
        for url in [
            "http://youtubei.googleapis.com/youtubei/v1/player",
            "https://youtubei.googleapis.com.evil.test/player",
            "https://user:password@youtubei.googleapis.com/player",
            "https://r1---sn.example.googlevideo.com/videoplayback?id=fixture",
            "https://example.test/",
        ] {
            assert!(validate_request(request(url)).is_err(), "accepted {url}");
        }
        let mut cookie = request("https://www.youtube.com/youtubei/v1/player");
        cookie.headers.insert("cookie".into(), "SID=secret".into());
        assert!(validate_request(cookie).is_err());

        let mut tidal = request("https://www.youtube.com/youtubei/v1/player");
        tidal.provider = MusicProvider::Tidal;
        assert!(validate_request(tidal).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn provider_deadline_allows_observed_latency_and_covers_the_complete_body() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(25));

        let body_started = Arc::new(AtomicBool::new(false));
        let app = Router::new()
            .route(
                "/stalled",
                post({
                    let body_started = body_started.clone();
                    move || {
                        let body_started = body_started.clone();
                        async move {
                            let body = async_stream::stream! {
                                yield Ok::<Bytes, Infallible>(Bytes::from_static(b"first"));
                                body_started.store(true, Ordering::SeqCst);
                                tokio::time::sleep(Duration::from_secs(3)).await;
                                yield Ok::<Bytes, Infallible>(Bytes::from_static(b"last"));
                            };
                            axum::response::Response::new(axum::body::Body::from_stream(body))
                        }
                    }
                }),
            )
            .route(
                "/complete",
                post(|| async {
                    let body = async_stream::stream! {
                        yield Ok::<Bytes, Infallible>(Bytes::from_static(b"first"));
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        yield Ok::<Bytes, Infallible>(Bytes::from_static(b"last"));
                    };
                    axum::response::Response::new(axum::body::Body::from_stream(body))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let request = |path: &str| ValidatedEgressRequest {
            method: Method::POST,
            url: format!("{origin}/{path}").parse().unwrap(),
            headers: HeaderMap::new(),
            body: Vec::new(),
        };
        let client = reqwest::Client::new();

        let timed_out =
            execute_provider_egress_request(&client, request("stalled"), Duration::from_secs(1))
                .await;
        assert!(
            body_started.load(Ordering::SeqCst),
            "response body never started"
        );
        assert_eq!(timed_out.unwrap_err(), "music provider response failed");

        let completed =
            execute_provider_egress_request(&client, request("complete"), Duration::from_secs(1))
                .await
                .unwrap();
        assert_eq!(
            STANDARD.decode(completed.body_base64).unwrap(),
            b"firstlast"
        );
        server.abort();
    }
}
