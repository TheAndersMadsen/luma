use super::*;
use bytes::Bytes;
use http_body_util::BodyExt as _;
use librespot_playback::audio_backend::Sink as _;
use reqwest::Url;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};
use tempfile::tempdir;

struct TestHttpServer {
    origin: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestHttpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_test_http(app: Router) -> TestHttpServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    TestHttpServer { origin, task }
}

#[derive(Clone)]
struct ProviderRouteTestService {
    state: std::sync::Arc<ProviderRouteTestState>,
}

struct ProviderRouteTestState {
    renewed_url: String,
    stale_requests: std::sync::Arc<AtomicUsize>,
    gateway_requests: std::sync::Arc<AtomicUsize>,
    renewed_requests: std::sync::Arc<AtomicUsize>,
    gateway_release: tokio::sync::watch::Receiver<bool>,
    second_stale_release: tokio::sync::watch::Receiver<bool>,
}

impl tonic::server::NamedService for ProviderRouteTestService {
    const NAME: &'static str = "api";
}

impl tower::Service<http::Request<tonic::body::Body>> for ProviderRouteTestService {
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send + 'static>,
    >;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<tonic::body::Body>) -> Self::Future {
        let state = self.state.clone();
        Box::pin(async move {
            let path = request.uri().path().to_owned();
            let _ = request.into_body().collect().await;
            let response = match path.as_str() {
                "/api/stale" => {
                    let ordinal = state.stale_requests.fetch_add(1, Ordering::SeqCst) + 1;
                    if ordinal > 2 {
                        let mut release = state.second_stale_release.clone();
                        let _ = release.wait_for(|released| *released).await;
                    }
                    StatusCode::FORBIDDEN.into_response()
                }
                "/api/music-gateway/playback" => {
                    state.gateway_requests.fetch_add(1, Ordering::SeqCst);
                    let mut release = state.gateway_release.clone();
                    let _ = release.wait_for(|released| *released).await;
                    let mut response = Response::new(Body::from(
                        serde_json::json!({ "url": state.renewed_url }).to_string(),
                    ));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    );
                    response
                }
                "/api/renewed" => {
                    state.renewed_requests.fetch_add(1, Ordering::SeqCst);
                    let mut response = Response::new(Body::from("audio"));
                    response
                        .headers_mut()
                        .insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mp4"));
                    response
                }
                "/api/invalid-media" => {
                    let mut response = Response::new(Body::from("not audio"));
                    response
                        .headers_mut()
                        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
                    response
                }
                "/api/range-unsatisfied" => {
                    let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                    response
                        .headers_mut()
                        .insert(header::CONTENT_RANGE, HeaderValue::from_static("bytes */5"));
                    response
                }
                _ => StatusCode::NOT_FOUND.into_response(),
            };
            Ok(response)
        })
    }
}

struct ProviderRouteTestServer {
    address: SocketAddr,
    gateway_origin: String,
    stale_url: String,
    renewed_url: String,
    invalid_media_url: String,
    range_unsatisfied_url: String,
    certificate_der: Vec<u8>,
    stale_requests: std::sync::Arc<AtomicUsize>,
    gateway_requests: std::sync::Arc<AtomicUsize>,
    renewed_requests: std::sync::Arc<AtomicUsize>,
    gateway_release: tokio::sync::watch::Sender<bool>,
    second_stale_release: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ProviderRouteTestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_provider_route_test_server() -> ProviderRouteTestServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let port = address.port();
    let gateway_origin = format!("https://gateway.test:{port}");
    let stale_url = format!("https://r1---sn.test.googlevideo.com:{port}/api/stale");
    let renewed_url = format!("https://r2---sn.test.googlevideo.com:{port}/api/renewed");
    let invalid_media_url =
        format!("https://r1---sn.test.googlevideo.com:{port}/api/invalid-media");
    let range_unsatisfied_url =
        format!("https://r2---sn.test.googlevideo.com:{port}/api/range-unsatisfied");
    let stale_requests = std::sync::Arc::new(AtomicUsize::new(0));
    let gateway_requests = std::sync::Arc::new(AtomicUsize::new(0));
    let renewed_requests = std::sync::Arc::new(AtomicUsize::new(0));
    let (gateway_release, gateway_release_rx) = tokio::sync::watch::channel(false);
    let (second_stale_release, second_stale_release_rx) = tokio::sync::watch::channel(false);
    let state = std::sync::Arc::new(ProviderRouteTestState {
        renewed_url: renewed_url.clone(),
        stale_requests: stale_requests.clone(),
        gateway_requests: gateway_requests.clone(),
        renewed_requests: renewed_requests.clone(),
        gateway_release: gateway_release_rx,
        second_stale_release: second_stale_release_rx,
    });
    let rcgen::CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(vec![
        "gateway.test".into(),
        "r1---sn.test.googlevideo.com".into(),
        "r2---sn.test.googlevideo.com".into(),
    ])
    .unwrap();
    let certificate_der = cert.der().to_vec();
    let identity = tonic::transport::Identity::from_pem(cert.pem(), signing_key.serialize_pem());
    let task = tokio::spawn(async move {
        let incoming = async_stream::stream! {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => yield Ok::<_, std::io::Error>(stream),
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                }
            }
        };
        tonic::transport::Server::builder()
            .tls_config(tonic::transport::ServerTlsConfig::new().identity(identity))
            .unwrap()
            .add_service(ProviderRouteTestService { state })
            .serve_with_incoming(incoming)
            .await
            .unwrap();
    });

    ProviderRouteTestServer {
        address,
        gateway_origin,
        stale_url,
        renewed_url,
        invalid_media_url,
        range_unsatisfied_url,
        certificate_der,
        stale_requests,
        gateway_requests,
        renewed_requests,
        gateway_release,
        second_stale_release,
        task,
    }
}

async fn wait_for_counter(counter: &AtomicUsize, expected: usize) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while counter.load(Ordering::SeqCst) < expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("test server did not observe the expected request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn music_gateway_total_deadline_includes_the_delayed_response_body() {
    let app = Router::new().route(
        "/playback",
        axum::routing::post(|| async {
            let body = async_stream::stream! {
                tokio::time::sleep(Duration::from_millis(80)).await;
                yield Ok::<Bytes, Infallible>(Bytes::from_static(br#"{"ok":true}"#));
            };
            Response::new(Body::from_stream(body))
        }),
    );
    let server = spawn_test_http(app).await;
    let client = Client::new();

    let timed_out = execute_music_gateway_request::<SpotifySaveResponse>(
        client.post(format!("{}/playback", server.origin)),
        "playback",
        Duration::from_millis(20),
    )
    .await;
    assert!(matches!(timed_out, Err(SpotifyError::Unavailable)));

    let response = execute_music_gateway_request::<SpotifySaveResponse>(
        client.post(format!("{}/playback", server.origin)),
        "playback",
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    assert!(response.ok);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn music_gateway_rejects_oversized_chunked_body_before_eof() {
    let app = Router::new().route(
        "/oversized",
        axum::routing::post(|| async {
            let body = async_stream::stream! {
                for _ in 0..3 {
                    yield Ok::<Bytes, Infallible>(Bytes::from(vec![b'x'; 1024 * 1024]));
                }
                std::future::pending::<()>().await;
            };
            Response::new(Body::from_stream(body))
        }),
    );
    let server = spawn_test_http(app).await;
    let client = Client::new();

    let rejected = tokio::time::timeout(
        Duration::from_secs(2),
        execute_music_gateway_request::<SpotifySaveResponse>(
            client.post(format!("{}/oversized", server.origin)),
            "playback",
            Duration::from_secs(30),
        ),
    )
    .await
    .expect("the size cap must reject a chunked body without waiting for EOF");

    assert!(matches!(rejected, Err(SpotifyError::Unavailable)));
}

/// A Center music gateway over HTTPS, since `MusicConfig` accepts only an
/// HTTPS origin. It answers every `/api/music-gateway/*` operation with `app`.
#[derive(Clone)]
struct TlsGatewayService(Router);

impl tonic::server::NamedService for TlsGatewayService {
    const NAME: &'static str = "api";
}

impl tower::Service<http::Request<tonic::body::Body>> for TlsGatewayService {
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<
        Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send + 'static>,
    >;

    fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<tonic::body::Body>) -> Self::Future {
        Box::pin(tower::ServiceExt::oneshot(self.0.clone(), request))
    }
}

async fn gateway_service_answering(
    app: Router,
) -> (SpotifyService, TestHttpServer, tempfile::TempDir) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["gateway.test".into()]).unwrap();
    let identity = tonic::transport::Identity::from_pem(cert.pem(), signing_key.serialize_pem());
    let task = tokio::spawn(async move {
        let incoming = async_stream::stream! {
            loop {
                yield listener.accept().await.map(|(stream, _)| stream);
            }
        };
        tonic::transport::Server::builder()
            .tls_config(tonic::transport::ServerTlsConfig::new().identity(identity))
            .unwrap()
            .add_service(TlsGatewayService(app))
            .serve_with_incoming(incoming)
            .await
            .unwrap();
    });
    let origin = format!("https://gateway.test:{}", address.port());
    let client = Client::builder()
        .no_proxy()
        .add_root_certificate(reqwest::Certificate::from_der(cert.der()).unwrap())
        .resolve("gateway.test", address)
        .build()
        .unwrap();
    let directory = tempdir().unwrap();
    let service = SpotifyService::new(
        MusicConfig {
            active_provider: MusicProvider::Tidal,
            gateway_url: Some(origin.clone()),
            gateway_token: Some("t".repeat(32)),
        },
        SpotifyConfig::default(),
        &directory.path().join("config.toml"),
        SocketAddr::from(([127, 0, 0, 1], 0)),
        client,
        EsimBridge::start(),
        Database::open(directory.path().join("activity.sqlite")).unwrap(),
    )
    .await;
    (service, TestHttpServer { origin, task }, directory)
}

// INFERRED Web API boundary failures: provider headers can stall, a body can
// stall after headers, or declared/chunked JSON can exceed the Pin's budget.
// These HTTP fixtures exercise the real client without a Spotify account.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spotify_api_http_rejects_declared_and_chunked_oversized_catalogs() {
    let oversized = serde_json::json!({ "padding": "a".repeat(2 * 1024 * 1024) });
    let app = Router::new()
        .route(
            "/api/ok",
            get(|| async { Json(serde_json::json!({ "items": [] })) }),
        )
        .route(
            "/api/declared",
            get(move || {
                let oversized = oversized.clone();
                async move { Json(oversized) }
            }),
        )
        .route(
            "/api/chunked",
            get(|| async {
                let stream = async_stream::stream! {
                    yield Ok::<Bytes, Infallible>(Bytes::from_static(b"{\"padding\":\""));
                    yield Ok::<Bytes, Infallible>(Bytes::from(vec![b'a'; 2 * 1024 * 1024]));
                    yield Ok::<Bytes, Infallible>(Bytes::from_static(b"\"}"));
                };
                Response::new(Body::from_stream(stream))
            }),
        );
    let (service, server, _directory) = gateway_service_answering(app).await;
    assert_eq!(
        service
            .api_json(service.inner.http.get(format!("{}/api/ok", server.origin)))
            .await
            .unwrap(),
        serde_json::json!({ "items": [] })
    );
    for route in ["declared", "chunked"] {
        let result = service
            .api_json(
                service
                    .inner
                    .http
                    .get(format!("{}/api/{route}", server.origin)),
            )
            .await;
        assert!(
            matches!(result, Err(SpotifyError::Unavailable)),
            "accepted oversized {route} catalog"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spotify_api_http_deadline_covers_headers_and_the_complete_body() {
    let app = Router::new()
        .route(
            "/api/ok",
            get(|| async { Json(serde_json::json!({ "items": [] })) }),
        )
        .route(
            "/api/headers",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Json(serde_json::json!({ "items": [] }))
            }),
        )
        .route(
            "/api/body",
            get(|| async {
                let stream = async_stream::stream! {
                    yield Ok::<Bytes, Infallible>(Bytes::from_static(b"{\"items\":"));
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    yield Ok::<Bytes, Infallible>(Bytes::from_static(b"[]}"));
                };
                Response::new(Body::from_stream(stream))
            }),
        );
    let (service, server, _directory) = gateway_service_answering(app).await;
    assert_eq!(
        service
            .api_json(service.inner.http.get(format!("{}/api/ok", server.origin)))
            .await
            .unwrap(),
        serde_json::json!({ "items": [] })
    );
    let request = |route: &str| {
        service.api_json(
            service
                .inner
                .http
                .get(format!("{}/api/{route}", server.origin)),
        )
    };
    let (headers, body) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(16), request("headers")),
        tokio::time::timeout(Duration::from_secs(16), request("body")),
    );
    assert!(
        matches!(headers, Ok(Err(SpotifyError::Unavailable))),
        "headers outlived the API deadline"
    );
    assert!(
        matches!(body, Ok(Err(SpotifyError::Unavailable))),
        "body outlived the API deadline"
    );
}

// INFERRED aggregate failure modes: state/SDK waits may never finish, and
// time spent before HTTP (or between pages/retries) must not reset the budget.
// The TLS gateway fixture consumes time on both sides of that boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn public_query_and_diagnostic_search_share_one_total_deadline() {
    let app = Router::new().route(
        "/api/music-gateway/query",
        axum::routing::post(|| async {
            tokio::time::sleep(Duration::from_secs(19)).await;
            Json(serde_json::json!({
                "items": [], "is_user_playlist": false,
                "ranking_provenance": "not_ranked"
            }))
        }),
    );
    let (service, _server, _directory) = gateway_service_answering(app).await;
    let settings = service.inner.music_settings.write().await;
    let request = SpotifyQueryRequest {
        kind: "track".into(),
        primary: Some("fixture".into()),
        secondary: None,
        ids: Vec::new(),
        limit: 1,
    };
    let release = async {
        tokio::time::sleep(Duration::from_secs(3)).await;
        drop(settings);
    };
    let (query, diagnostic, _) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(21), service.query(request)),
        tokio::time::timeout(
            Duration::from_secs(21),
            diagnostic_search(&service, HashMap::from([("q".into(), "fixture".into())]))
        ),
        release,
    );
    assert!(
        matches!(query, Ok(Err(SpotifyError::Unavailable))),
        "public query reset its budget before gateway HTTP"
    );
    assert!(
        matches!(diagnostic, Ok(Err(SpotifyError::Unavailable))),
        "diagnostic search reset its budget before gateway HTTP"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_refusal_is_music_not_connected_rather_than_an_outage() {
    // Center answers 401 for "Connect YouTube Music in Center.", "Reconnect
    // TIDAL in Center." and a stale gateway bearer, and 403 when the provider
    // withholds the track. None of these is a streaming outage: the internal
    // query and playback routes must answer 401 so the hook raises the stock
    // "not connected" MusicProviderTokenNotFoundException.
    for refusal in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
        let app = Router::new().route(
            "/api/music-gateway/{operation}",
            axum::routing::post(move || async move { (refusal, "Reconnect TIDAL in Center.") }),
        );
        let (service, _gateway, _directory) = gateway_service_answering(app).await;

        let query = service
            .query(SpotifyQueryRequest {
                kind: "track".into(),
                primary: Some("One Dance Drake".into()),
                secondary: None,
                ids: Vec::new(),
                limit: 5,
            })
            .await;
        let Err(error) = query else {
            panic!("a refused gateway query must fail");
        };
        assert!(matches!(error, SpotifyError::NotPaired), "{refusal}");
        assert_eq!(error.status_code(), StatusCode::UNAUTHORIZED);

        let playback = service
            .playback(SpotifyPlaybackRequest {
                id: "tidal:12345".into(),
                duration_ms: 180_000,
            })
            .await;
        let Err(error) = playback else {
            panic!("a refused gateway playback must fail");
        };
        assert!(matches!(error, SpotifyError::NotPaired), "{refusal}");
        assert_eq!(error.status_code(), StatusCode::UNAUTHORIZED);
    }

    // A gateway or provider fault stays the retryable outage.
    let app = Router::new().route(
        "/api/music-gateway/{operation}",
        axum::routing::post(|| async { StatusCode::BAD_GATEWAY }),
    );
    let (service, _gateway, _directory) = gateway_service_answering(app).await;
    let playback = service
        .playback(SpotifyPlaybackRequest {
            id: "tidal:12345".into(),
            duration_ms: 180_000,
        })
        .await;
    assert!(matches!(playback, Err(SpotifyError::Unavailable)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provider_stream_route_detaches_one_stale_renewal_then_uses_renewed_url() {
    let server = spawn_provider_route_test_server().await;
    let client = Client::builder()
        .no_proxy()
        .add_root_certificate(reqwest::Certificate::from_der(&server.certificate_der).unwrap())
        .resolve("gateway.test", server.address)
        .resolve("r1---sn.test.googlevideo.com", server.address)
        .resolve("r2---sn.test.googlevideo.com", server.address)
        .build()
        .unwrap();
    let directory = tempdir().unwrap();
    let service = SpotifyService::new(
        MusicConfig {
            active_provider: MusicProvider::YoutubeMusic,
            gateway_url: Some(server.gateway_origin.clone()),
            gateway_token: Some("t".repeat(32)),
        },
        SpotifyConfig::default(),
        &directory.path().join("config.toml"),
        SocketAddr::from(([127, 0, 0, 1], 0)),
        client,
        EsimBridge::start(),
        Database::open(directory.path().join("activity.sqlite")).unwrap(),
    )
    .await;
    let ticket = "a".repeat(43);
    service
        .inner
        .provider_streams
        .lock()
        .await
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:fixture".into(),
            &server.stale_url,
        )
        .unwrap();

    let request = |service: SpotifyService, ticket: String| {
        tokio::spawn(async move {
            service
                .provider_stream_response(&ticket, Method::GET, &HeaderMap::new())
                .await
        })
    };
    let first = request(service.clone(), ticket.clone());

    wait_for_counter(&server.stale_requests, 1).await;
    wait_for_counter(&server.gateway_requests, 1).await;
    assert!(
        service
            .inner
            .provider_stream_renewals
            .lock()
            .await
            .contains_key(&ticket),
        "the renewal must remain detached after the stale response returns",
    );

    let second = request(service.clone(), ticket.clone());
    let third = request(service.clone(), ticket.clone());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        server.stale_requests.load(Ordering::SeqCst),
        1,
        "requests joining an active renewal must not refetch its stale URL",
    );

    first.abort();
    second.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert!(second.await.unwrap_err().is_cancelled());
    assert!(
        service
            .inner
            .provider_stream_renewals
            .lock()
            .await
            .contains_key(&ticket),
        "cancelling every original request must not cancel the detached renewal",
    );

    server.gateway_release.send(true).unwrap();
    let third_response = tokio::time::timeout(Duration::from_secs(1), third)
        .await
        .expect("a waiter did not observe the detached renewal")
        .unwrap();
    assert_eq!(third_response.status(), StatusCode::OK);
    assert_eq!(
        third_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes(),
        Bytes::from_static(b"audio"),
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while service
            .inner
            .provider_stream_renewals
            .lock()
            .await
            .contains_key(&ticket)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("completed renewal did not release its single-flight entry");
    assert_eq!(
        server.gateway_requests.load(Ordering::SeqCst),
        1,
        "concurrent waiters must share one detached gateway renewal",
    );
    assert_eq!(
        server.renewed_requests.load(Ordering::SeqCst),
        1,
        "the surviving waiter must fetch the renewed URL exactly once",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stock_retry_cadence_reaches_a_ten_second_detached_renewal() {
    let server = spawn_provider_route_test_server().await;
    server.second_stale_release.send(true).unwrap();
    let client = Client::builder()
        .no_proxy()
        .add_root_certificate(reqwest::Certificate::from_der(&server.certificate_der).unwrap())
        .resolve("gateway.test", server.address)
        .resolve("r1---sn.test.googlevideo.com", server.address)
        .resolve("r2---sn.test.googlevideo.com", server.address)
        .build()
        .unwrap();
    let directory = tempdir().unwrap();
    let service = SpotifyService::new(
        MusicConfig {
            active_provider: MusicProvider::YoutubeMusic,
            gateway_url: Some(server.gateway_origin.clone()),
            gateway_token: Some("t".repeat(32)),
        },
        SpotifyConfig::default(),
        &directory.path().join("config.toml"),
        SocketAddr::from(([127, 0, 0, 1], 0)),
        client,
        EsimBridge::start(),
        Database::open(directory.path().join("activity.sqlite")).unwrap(),
    )
    .await;
    let ticket = "c".repeat(43);
    service
        .inner
        .provider_streams
        .lock()
        .await
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:stock-retry-fixture".into(),
            &server.stale_url,
        )
        .unwrap();

    let gateway_release = server.gateway_release.clone();
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        gateway_release.send(true).unwrap();
    });
    let stock_network_ceiling = Duration::from_secs(8);
    let mut attempts = 0usize;
    let mut succeeded = false;

    for retry_delay in [
        Duration::ZERO,
        Duration::ZERO,
        Duration::from_secs(1),
        Duration::from_secs(2),
    ] {
        tokio::time::sleep(retry_delay).await;
        attempts += 1;
        let started = tokio::time::Instant::now();
        let response = service
            .provider_stream_response(&ticket, Method::GET, &HeaderMap::new())
            .await;
        assert!(
            started.elapsed() < stock_network_ceiling,
            "attempt {attempts} exceeded stock DefaultHttpDataSource's network ceiling",
        );
        if response.status() == StatusCode::OK {
            assert_eq!(
                response.into_body().collect().await.unwrap().to_bytes(),
                Bytes::from_static(b"audio"),
            );
            succeeded = true;
            break;
        }
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    assert!(
        succeeded,
        "stock exhausted its initial load plus three retries before renewal became observable",
    );
    assert_eq!(
        server.stale_requests.load(Ordering::SeqCst),
        1,
        "a retry must not refetch a URL already known to have an active renewal",
    );
    release.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_stream_route_preserves_content_range_on_416() {
    let server = spawn_provider_route_test_server().await;
    let client = Client::builder()
        .no_proxy()
        .add_root_certificate(reqwest::Certificate::from_der(&server.certificate_der).unwrap())
        .resolve("gateway.test", server.address)
        .resolve("r1---sn.test.googlevideo.com", server.address)
        .resolve("r2---sn.test.googlevideo.com", server.address)
        .build()
        .unwrap();
    let directory = tempdir().unwrap();
    let service = SpotifyService::new(
        MusicConfig {
            active_provider: MusicProvider::YoutubeMusic,
            gateway_url: Some(server.gateway_origin.clone()),
            gateway_token: Some("t".repeat(32)),
        },
        SpotifyConfig::default(),
        &directory.path().join("config.toml"),
        SocketAddr::from(([127, 0, 0, 1], 0)),
        client,
        EsimBridge::start(),
        Database::open(directory.path().join("activity.sqlite")).unwrap(),
    )
    .await;
    let ticket = "b".repeat(43);
    service
        .inner
        .provider_streams
        .lock()
        .await
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:range-fixture".into(),
            &server.range_unsatisfied_url,
        )
        .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(header::RANGE, HeaderValue::from_static("bytes=5-"));

    let response = service
        .provider_stream_response(&ticket, Method::GET, &headers)
        .await;

    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        response.headers().get(header::CONTENT_RANGE).unwrap(),
        "bytes */5",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_stream_route_renews_a_success_status_with_non_media_content() {
    let server = spawn_provider_route_test_server().await;
    server.gateway_release.send(true).unwrap();
    let client = Client::builder()
        .no_proxy()
        .add_root_certificate(reqwest::Certificate::from_der(&server.certificate_der).unwrap())
        .resolve("gateway.test", server.address)
        .resolve("r1---sn.test.googlevideo.com", server.address)
        .resolve("r2---sn.test.googlevideo.com", server.address)
        .build()
        .unwrap();
    let directory = tempdir().unwrap();
    let service = SpotifyService::new(
        MusicConfig {
            active_provider: MusicProvider::YoutubeMusic,
            gateway_url: Some(server.gateway_origin.clone()),
            gateway_token: Some("t".repeat(32)),
        },
        SpotifyConfig::default(),
        &directory.path().join("config.toml"),
        SocketAddr::from(([127, 0, 0, 1], 0)),
        client,
        EsimBridge::start(),
        Database::open(directory.path().join("activity.sqlite")).unwrap(),
    )
    .await;
    let ticket = "d".repeat(43);
    service
        .inner
        .provider_streams
        .lock()
        .await
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:invalid-media-fixture".into(),
            &server.invalid_media_url,
        )
        .unwrap();

    let response = service
        .provider_stream_response(&ticket, Method::GET, &HeaderMap::new())
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        Bytes::from_static(b"audio"),
    );
    assert_eq!(server.gateway_requests.load(Ordering::SeqCst), 1);
    assert_eq!(server.renewed_requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        service
            .inner
            .provider_streams
            .lock()
            .await
            .get(&ticket)
            .unwrap()
            .url
            .as_str(),
        server.renewed_url,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_stream_rejects_delayed_headers_and_an_idle_body() {
    let app = Router::new()
        .route(
            "/delayed-headers",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                "late"
            }),
        )
        .route(
            "/idle-body",
            get(|| async {
                let body = async_stream::stream! {
                    yield Ok::<Bytes, Infallible>(Bytes::from_static(b"first"));
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    yield Ok::<Bytes, Infallible>(Bytes::from_static(b"late"));
                };
                Response::new(Body::from_stream(body))
            }),
        );
    let server = spawn_test_http(app).await;
    let client = Client::new();

    assert!(send_provider_stream_request(
        &client,
        &Method::GET,
        Url::parse(&format!("{}/delayed-headers", server.origin)).unwrap(),
        None,
        Duration::from_millis(20),
    )
    .await
    .is_err());

    let response = send_provider_stream_request(
        &client,
        &Method::GET,
        Url::parse(&format!("{}/idle-body", server.origin)).unwrap(),
        None,
        Duration::from_millis(200),
    )
    .await
    .unwrap();
    let mut body = provider_stream_body(response, Duration::from_millis(30));
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(first.as_ref(), b"first");
    assert!(body.frame().await.unwrap().is_err());
}

/// Ranking provenance is decided inside `query`, on branches that each need a
/// live Spotify session and two provider round-trips, so the decision cannot be
/// exercised from a unit test. Pin it against the source instead: the property
/// that matters is that EVERY exit from the artist branch assigns a provenance
/// and every degraded exit also logs the operational marker. Deleting either
/// assignment turns this red, which is the failure the "Chicago" incident had
/// no way to detect.
fn enabled_spotify_settings() -> SpotifyConfig {
    SpotifyConfig {
        enabled: true,
        experimental_acknowledged: true,
        ..SpotifyConfig::default()
    }
}

fn ready_runtime(session: Session) -> Runtime {
    Runtime {
        state: RuntimeState::Ready {
            username: Some("listener".into()),
        },
        playback_epoch: 0,
        session: Some(session),
        player: None,
        sink_controller: None,
        playback_watcher: None,
        active_buffer: None,
        buffers: HashMap::new(),
        buffer_order: VecDeque::new(),
        tracks: HashMap::new(),
        reconnect_failures: 0,
        reconnect_not_before: None,
        reconnect_error: None,
    }
}

fn test_player(session: Session, controller: &SwitchableWavSinkController) -> Arc<Player> {
    let player_controller = controller.clone();
    Player::new(
        PlayerConfig {
            gapless: false,
            ..PlayerConfig::default()
        },
        session,
        Box::new(NoOpVolume),
        move || Box::new(player_controller.sink()),
    )
}

async fn assert_player_dropped(player: std::sync::Weak<Player>) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while player.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("stale Player must be stopped and dropped off the async worker");
}

fn stored_auth() -> StoredAuth {
    StoredAuth {
        version: AUTH_VERSION,
        device_id: Uuid::new_v4().to_string(),
        credentials: Credentials::with_access_token("never-log-this-token"),
    }
}

#[test]
fn stored_auth_debug_surface_never_contains_secret() {
    let auth = stored_auth();
    let status = format!("version={} device={}", auth.version, auth.device_id);
    assert!(!status.contains("never-log-this-token"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_before_player_install_rejects_the_stale_epoch() {
    let session = Session::new(SessionConfig::default(), None);
    let lease = PlaybackLease {
        epoch: 0,
        session_id: session.session_id(),
    };
    let settings = Arc::new(RwLock::new(enabled_spotify_settings()));
    let runtime = Arc::new(Mutex::new(ready_runtime(session.clone())));
    let controller = SwitchableWavSinkController::new();
    let player = test_player(session, &controller);
    let stale_player = Arc::downgrade(&player);
    let player_ready = Arc::new(tokio::sync::Barrier::new(2));
    let teardown_done = Arc::new(tokio::sync::Barrier::new(2));

    let install_task = {
        let settings = settings.clone();
        let runtime = runtime.clone();
        let controller = controller.clone();
        let player_ready = player_ready.clone();
        let teardown_done = teardown_done.clone();
        tokio::spawn(async move {
            // Player::new has completed, but publication is deliberately
            // held until teardown wins and advances the epoch.
            player_ready.wait().await;
            teardown_done.wait().await;
            let settings = settings.read().await;
            let mut runtime = runtime.lock().await;
            let installed =
                install_player_if_current(&mut runtime, &settings, &lease, &player, &controller);
            drop(runtime);
            if !installed {
                stop_stale_player(player);
            }
            installed
        })
    };

    player_ready.wait().await;
    let resources = {
        let mut runtime = runtime.lock().await;
        take_runtime_resources(&mut runtime, RuntimeState::SignedOut, true)
    };
    SpotifyService::shutdown_runtime_resources(resources).await;
    teardown_done.wait().await;

    assert!(!install_task.await.unwrap());
    let runtime = runtime.lock().await;
    assert_eq!(runtime.playback_epoch, 1);
    assert!(matches!(runtime.state, RuntimeState::SignedOut));
    assert!(runtime.session.is_none());
    assert!(runtime.player.is_none());
    assert!(runtime.sink_controller.is_none());
    drop(runtime);
    assert_player_dropped(stale_player).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_after_playing_before_publish_rejects_the_stale_buffer() {
    let directory = tempdir().unwrap();
    let session = Session::new(SessionConfig::default(), None);
    let lease = PlaybackLease {
        epoch: 0,
        session_id: session.session_id(),
    };
    let settings = Arc::new(RwLock::new(enabled_spotify_settings()));
    let controller = SwitchableWavSinkController::new();
    let player = test_player(session.clone(), &controller);
    let stale_player = Arc::downgrade(&player);
    let buffer = PlaybackBuffer::create(directory.path(), "stale-ticket".into(), 1_000).unwrap();
    let route_generation = controller.stage(buffer.clone()).unwrap();
    let mut sink = controller.sink();
    sink.start().unwrap();
    let mut initial_runtime = ready_runtime(session);
    initial_runtime.player = Some(player.clone());
    initial_runtime.sink_controller = Some(controller.clone());
    let runtime = Arc::new(Mutex::new(initial_runtime));
    let playing_observed = Arc::new(tokio::sync::Barrier::new(2));
    let teardown_done = Arc::new(tokio::sync::Barrier::new(2));

    let publish_task = {
        let settings = settings.clone();
        let runtime = runtime.clone();
        let controller = controller.clone();
        let buffer = buffer.clone();
        let playing_observed = playing_observed.clone();
        let teardown_done = teardown_done.clone();
        tokio::spawn(async move {
            // This barrier represents the exact Playing event. Teardown
            // then wins before the detached task can publish its URL.
            playing_observed.wait().await;
            teardown_done.wait().await;
            let watcher = tokio::spawn(std::future::pending::<()>());
            let pending = PendingPlaybackPublication {
                ticket: "stale-ticket".into(),
                buffer,
                watcher,
            };
            let publication = {
                let settings = settings.read().await;
                let mut runtime = runtime.lock().await;
                publish_playback_if_current(
                    &mut runtime,
                    &settings,
                    &lease,
                    &player,
                    &controller,
                    pending,
                )
            };
            let Err(pending) = publication else {
                return false;
            };
            pending.watcher.abort();
            let cancelled = controller.cancel(route_generation);
            pending.buffer.finish(true);
            stop_stale_player(player);
            cancelled
        })
    };

    playing_observed.wait().await;
    let resources = {
        let mut runtime = runtime.lock().await;
        take_runtime_resources(&mut runtime, RuntimeState::SignedOut, true)
    };
    SpotifyService::shutdown_runtime_resources(resources).await;
    teardown_done.wait().await;

    assert!(publish_task.await.unwrap());
    let runtime = runtime.lock().await;
    assert_eq!(runtime.playback_epoch, 1);
    assert!(matches!(runtime.state, RuntimeState::SignedOut));
    assert!(runtime.active_buffer.is_none());
    assert!(runtime.playback_watcher.is_none());
    assert!(!runtime.buffers.contains_key("stale-ticket"));
    assert!(runtime.buffer_order.is_empty());
    assert!(!controller.is_active(route_generation));
    drop(runtime);
    assert_player_dropped(stale_player).await;
}

#[test]
fn internal_control_requires_loopback_and_exact_private_token() {
    let token = "a".repeat(BRIDGE_TOKEN_CHARS);
    let loopback: SocketAddr = "127.0.0.1:10".parse().unwrap();
    let remote: SocketAddr = "192.0.2.4:10".parse().unwrap();
    let mut headers = HeaderMap::new();

    assert!(!internal_control_authorized(
        &loopback,
        &headers,
        Some(&token)
    ));
    headers.insert(BRIDGE_TOKEN_HEADER, token.parse().unwrap());
    assert!(internal_control_authorized(
        &loopback,
        &headers,
        Some(&token)
    ));
    assert!(!internal_control_authorized(
        &remote,
        &headers,
        Some(&token)
    ));
    assert!(!internal_control_authorized(&loopback, &headers, None));

    headers.append(BRIDGE_TOKEN_HEADER, token.parse().unwrap());
    assert!(!internal_control_authorized(
        &loopback,
        &headers,
        Some(&token)
    ));
}
