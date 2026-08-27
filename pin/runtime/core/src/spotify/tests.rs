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

#[test]
fn pin_speaker_profile_levels_and_limits_playback() {
    let config = pin_speaker_player_config();

    // The whole point of the profile: without normalisation every track
    // plays at its own master level, so loud masters jump in volume and
    // clip the Pin's small driver. `Dynamic` adds the limiter that keeps
    // those peaks off the rail.
    assert!(config.normalisation);
    assert_eq!(config.normalisation_method, NormalisationMethod::Dynamic);
    // Per-track levelling: the Pin plays individually requested songs, not
    // albums in order, so album-relative gain would leave quiet tracks
    // inaudible on this speaker.
    assert_eq!(config.normalisation_type, NormalisationType::Track);

    // No make-up gain. The platform's speaker calibration is selected by the
    // volume index (the `volume_listener` effect on the music stream), so
    // pre-boosting the signal spends the speaker-protection algorithm's
    // excursion/thermal headroom and buys ramp-down, not loudness.
    assert_eq!(
        config.normalisation_pregain_db, 0.0,
        "pre-boosting fights the platform's volume-indexed speaker calibration",
    );
    // The limiter exists to guard our own digital headroom, not the driver —
    // the driver is already protected in hardware — so the ceiling stays at
    // librespot's default rather than being tightened for "speaker safety".
    assert_eq!(
        config.normalisation_threshold_dbfs,
        PlayerConfig::default().normalisation_threshold_dbfs,
    );

    // Source quality, and the per-track WAV sink contract that gapless
    // playback would violate.
    assert_eq!(config.bitrate, Bitrate::Bitrate320);
    assert!(!config.gapless);
    assert!(!config.passthrough);

    // The sink converts f64 samples to s16; keep librespot's ditherer so
    // that truncation noise does not land on top of quiet passages.
    assert!(config.ditherer.is_some());
}

#[test]
fn music_gateway_requests_disable_intermediary_compression() {
    const SOURCE: &str = include_str!("mod.rs");
    assert!(SOURCE.contains("reqwest::header::ACCEPT_ENCODING"));
    assert!(SOURCE.contains("MUSIC_GATEWAY_ACCEPT_ENCODING"));
}

#[test]
fn only_playback_gets_the_wider_music_gateway_budget() {
    assert_eq!(MUSIC_GATEWAY_TIMEOUT, Duration::from_secs(20));
    assert_eq!(MUSIC_GATEWAY_PLAYBACK_TIMEOUT, Duration::from_secs(50));
    assert_eq!(music_gateway_timeout("query"), MUSIC_GATEWAY_TIMEOUT);
    assert_eq!(music_gateway_timeout("save"), MUSIC_GATEWAY_TIMEOUT);
    assert_eq!(
        music_gateway_timeout("playback"),
        MUSIC_GATEWAY_PLAYBACK_TIMEOUT
    );
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

#[test]
fn provider_stream_deadlines_finish_before_the_stock_player_read_timeout() {
    let stock_player_read_timeout = Duration::from_secs(8);
    assert!(
        PROVIDER_STREAM_RESPONSE_HEADERS_TIMEOUT < stock_player_read_timeout,
        "fresh or stale provider headers must resolve before DefaultHttpDataSource times out",
    );
    assert!(
        PROVIDER_STREAM_IDLE_TIMEOUT < stock_player_read_timeout,
        "an idle provider body must fail before DefaultHttpDataSource times out",
    );
    assert!(
        PROVIDER_STREAM_RENEWAL_WAIT_TIMEOUT < stock_player_read_timeout,
        "a waiter must yield before DefaultHttpDataSource times out",
    );
    assert!(
        PROVIDER_STREAM_ROUTE_TIMEOUT < stock_player_read_timeout,
        "all work before loopback response headers must stay below the stock timeout",
    );
}

#[tokio::test]
async fn provider_stream_header_deadline_yields_before_the_stock_player_times_out() {
    let (request_entered_tx, request_entered_rx) = tokio::sync::oneshot::channel();
    let request_entered_tx = std::sync::Arc::new(std::sync::Mutex::new(Some(request_entered_tx)));
    let app = Router::new().route(
        "/never-answers",
        get(move || {
            if let Some(tx) = request_entered_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
            std::future::pending::<&'static str>()
        }),
    );
    let server = spawn_test_http(app).await;
    let client = Client::new();
    let request = tokio::spawn(async move {
        send_provider_stream_request(
            &client,
            &Method::GET,
            Url::parse(&format!("{}/never-answers", server.origin)).unwrap(),
            None,
            PROVIDER_STREAM_RESPONSE_HEADERS_TIMEOUT,
        )
        .await
    });
    request_entered_rx.await.unwrap();

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(8)).await;
    tokio::task::yield_now().await;

    assert!(
        request.is_finished(),
        "the loopback handler was still waiting when the stock player would time out",
    );
    assert!(request.await.unwrap().is_err());
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

#[tokio::test]
async fn detached_provider_stream_renewal_is_singleflight_and_updates_later_requests() {
    let ticket = "a".repeat(43);
    let stale_url = "https://r1---sn.example.googlevideo.com/videoplayback?id=stale";
    let renewed_url = "https://r2---sn.example.googlevideo.com/videoplayback?id=renewed";
    let registry = std::sync::Arc::new(Mutex::new(ProviderStreamRegistry::default()));
    registry
        .lock()
        .await
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:fixture".into(),
            stale_url,
        )
        .unwrap();
    let stale = registry.lock().await.get(&ticket).unwrap();
    let renewals = std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));
    let renewal_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (completed_tx, completed_rx) = tokio::sync::oneshot::channel();

    let first_registry = registry.clone();
    let first_count = renewal_count.clone();
    let first_stale = stale.clone();
    let first_completion = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        stale.clone(),
        std::future::ready(true),
        async move {
            first_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            release_rx.await.unwrap();
            assert!(first_registry
                .lock()
                .await
                .replace_url_or_current(&ticket, &first_stale, renewed_url)
                .is_some());
            let _ = completed_tx.send(());
            true
        },
    )
    .await
    .unwrap();

    let duplicate_count = renewal_count.clone();
    let duplicate_completion = spawn_provider_stream_renewal_once(
        renewals.clone(),
        "a".repeat(43),
        stale,
        std::future::ready(true),
        async move {
            duplicate_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(renewal_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        registry
            .lock()
            .await
            .get(&"a".repeat(43))
            .unwrap()
            .url
            .as_str(),
        stale_url,
    );

    release_tx.send(()).unwrap();
    completed_rx.await.unwrap();
    assert_eq!(
        wait_for_provider_stream_renewal(first_completion, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Succeeded,
    );
    assert_eq!(
        wait_for_provider_stream_renewal(duplicate_completion, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Succeeded,
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while renewals.lock().await.contains_key(&"a".repeat(43)) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("completed renewal must release its single-flight ticket");
    assert_eq!(
        registry
            .lock()
            .await
            .get(&"a".repeat(43))
            .unwrap()
            .url
            .as_str(),
        renewed_url,
    );
    assert_eq!(renewal_count.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn panicked_provider_stream_renewal_releases_its_singleflight_ticket() {
    let ticket = "a".repeat(43);
    let mut registry = ProviderStreamRegistry::default();
    registry
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:panic-fixture".into(),
            "https://r1---sn.example.googlevideo.com/videoplayback?id=panic-fixture",
        )
        .unwrap();
    let stale = registry.get(&ticket).unwrap();
    let renewals = std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));

    let panicked = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        stale.clone(),
        std::future::ready(true),
        async move {
            panic!("fixture renewal panic");
        },
    )
    .await
    .unwrap();
    assert_eq!(
        wait_for_provider_stream_renewal(panicked, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Failed,
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while renewals.lock().await.contains_key(&ticket) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("panicked renewal must release its single-flight ticket");

    let replacement = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        stale,
        std::future::ready(true),
        async move { true },
    )
    .await
    .expect("a later request must be able to renew after a worker panic");
    assert_eq!(
        wait_for_provider_stream_renewal(replacement, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Succeeded,
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while renewals.lock().await.contains_key(&ticket) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("replacement renewal must complete");
}

#[tokio::test]
async fn timed_out_and_failed_provider_stream_renewals_wake_and_clean_up() {
    let ticket = "a".repeat(43);
    let mut registry = ProviderStreamRegistry::default();
    registry
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:timeout-fixture".into(),
            "https://r1---sn.example.googlevideo.com/videoplayback?id=timeout-fixture",
        )
        .unwrap();
    let stale = registry.get(&ticket).unwrap();
    let renewals = std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();

    let completion = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        stale.clone(),
        std::future::ready(true),
        async move {
            release_rx.await.unwrap();
            false
        },
    )
    .await
    .unwrap();
    assert_eq!(
        wait_for_provider_stream_renewal(completion.clone(), Duration::from_millis(20),).await,
        ProviderStreamRenewalState::Pending,
    );
    assert!(renewals.lock().await.contains_key(&ticket));

    release_tx.send(()).unwrap();
    assert_eq!(
        wait_for_provider_stream_renewal(completion, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Failed,
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while renewals.lock().await.contains_key(&ticket) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("failed renewal must release its single-flight entry");

    let replacement = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        stale,
        std::future::ready(true),
        async move { true },
    )
    .await
    .expect("a timeout followed by failure must not leave a dead entry");
    assert_eq!(
        wait_for_provider_stream_renewal(replacement, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Succeeded,
    );
}

#[tokio::test]
async fn abandoned_provider_stream_renewal_is_replaced() {
    let ticket = "a".repeat(43);
    let mut registry = ProviderStreamRegistry::default();
    registry
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:abandoned-fixture".into(),
            "https://r1---sn.example.googlevideo.com/videoplayback?id=abandoned-fixture",
        )
        .unwrap();
    let stale = registry.get(&ticket).unwrap();
    let renewals = std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));
    let (abandoned_sender, abandoned_completion) =
        watch::channel(ProviderStreamRenewalState::Pending);
    renewals.lock().await.insert(
        ticket.clone(),
        ProviderStreamRenewal {
            stale: stale.clone(),
            flight: std::sync::Arc::new(()),
            completion: abandoned_completion,
        },
    );
    drop(abandoned_sender);

    let replacement = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        stale,
        std::future::ready(true),
        async move { true },
    )
    .await
    .expect("a closed pending flight must not block a replacement renewal");

    assert_eq!(
        wait_for_provider_stream_renewal(replacement, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Succeeded,
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while renewals.lock().await.contains_key(&ticket) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("replacement renewal must release the abandoned ticket");
}

#[tokio::test]
async fn provider_stream_new_snapshot_replaces_old_flight_without_losing_its_cleanup() {
    let ticket = "a".repeat(43);
    let stream_url =
        "https://r1---sn.example.googlevideo.com/videoplayback?id=reused-ticket-fixture";
    let mut registry = ProviderStreamRegistry::default();
    registry
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:old-track".into(),
            stream_url,
        )
        .unwrap();
    let old = registry.get(&ticket).unwrap();
    registry.clear();
    registry
        .insert(
            ticket.clone(),
            MusicProvider::YoutubeMusic,
            "youtube_music:new-track".into(),
            stream_url,
        )
        .unwrap();
    let new = registry.get(&ticket).unwrap();
    let renewals = std::sync::Arc::new(Mutex::new(std::collections::HashMap::new()));
    let (old_release, old_released) = tokio::sync::oneshot::channel();
    let old_completion = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        old,
        std::future::ready(true),
        async move {
            old_released.await.unwrap();
            true
        },
    )
    .await
    .unwrap();
    let old_flight = renewals.lock().await.get(&ticket).unwrap().flight.clone();
    let (new_release, new_released) = tokio::sync::oneshot::channel();
    let new_completion = spawn_provider_stream_renewal_once(
        renewals.clone(),
        ticket.clone(),
        new,
        std::future::ready(true),
        async move {
            new_released.await.unwrap();
            true
        },
    )
    .await
    .expect("the current stream snapshot must replace an obsolete flight");
    let new_flight = renewals.lock().await.get(&ticket).unwrap().flight.clone();
    assert!(!std::sync::Arc::ptr_eq(&old_flight, &new_flight));

    old_release.send(()).unwrap();
    assert_eq!(
        wait_for_provider_stream_renewal(old_completion, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Succeeded,
    );
    tokio::time::timeout(Duration::from_secs(1), async {
        while std::sync::Arc::strong_count(&old_flight) > 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the obsolete renewal task did not finish cleanup");
    assert!(renewals
        .lock()
        .await
        .get(&ticket)
        .is_some_and(|entry| std::sync::Arc::ptr_eq(&entry.flight, &new_flight)));

    new_release.send(()).unwrap();
    assert_eq!(
        wait_for_provider_stream_renewal(new_completion, Duration::from_secs(1)).await,
        ProviderStreamRenewalState::Succeeded,
    );
}

#[tokio::test]
async fn provider_stream_may_outlive_the_response_header_deadline_while_chunks_flow() {
    let (release_chunks, _) = tokio::sync::broadcast::channel(8);
    let app = Router::new().route(
        "/audio",
        get({
            let release_chunks = release_chunks.clone();
            move || {
                let mut release_chunks = release_chunks.subscribe();
                async move {
                    let body = async_stream::stream! {
                        yield Ok::<Bytes, Infallible>(Bytes::from_static(b"a"));
                        for _ in 0..5 {
                            release_chunks.recv().await.unwrap();
                            yield Ok::<Bytes, Infallible>(Bytes::from_static(b"a"));
                        }
                    };
                    Response::new(Body::from_stream(body))
                }
            }
        }),
    );
    let server = spawn_test_http(app).await;
    let client = Client::new();
    let response = send_provider_stream_request(
        &client,
        &Method::GET,
        Url::parse(&format!("{}/audio", server.origin)).unwrap(),
        None,
        PROVIDER_STREAM_RESPONSE_HEADERS_TIMEOUT,
    )
    .await
    .unwrap();

    let mut body = provider_stream_body(response, PROVIDER_STREAM_IDLE_TIMEOUT);
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    let mut received = first.to_vec();
    tokio::time::pause();
    let started = tokio::time::Instant::now();
    let flowing_gap = PROVIDER_STREAM_RESPONSE_HEADERS_TIMEOUT / 2;

    for _ in 0..5 {
        let mut next_frame = Box::pin(body.frame());
        assert!(matches!(futures::poll!(next_frame.as_mut()), Poll::Pending));

        tokio::time::advance(flowing_gap).await;
        assert_eq!(release_chunks.send(()).unwrap(), 1);

        let mut delivered = None;
        for _ in 0..10_000 {
            match futures::poll!(next_frame.as_mut()) {
                Poll::Ready(frame) => {
                    delivered = Some(frame);
                    break;
                }
                Poll::Pending => tokio::task::yield_now().await,
            }
        }
        let chunk = delivered
            .expect("provider chunk was not delivered while virtual time was frozen")
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap();
        received.extend_from_slice(&chunk);
    }

    assert_eq!(received, b"aaaaaa");
    assert!(
        tokio::time::Instant::now().duration_since(started)
            > PROVIDER_STREAM_RESPONSE_HEADERS_TIMEOUT * 2
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

#[test]
fn provider_stream_ranges_and_content_types_match_stock_player_reads() {
    for value in ["bytes=0-", "bytes=0-4095", "bytes=-4096"] {
        assert!(valid_music_range_value(value), "rejected {value}");
    }
    for value in ["bytes=-", "bytes=0-1,4-5", "items=0-1", "bytes=abc-def"] {
        assert!(!valid_music_range_value(value), "accepted {value}");
    }
    for value in [
        "audio/mp4",
        "audio/webm; codecs=opus",
        "video/mp4",
        "application/octet-stream",
    ] {
        let value = HeaderValue::from_str(value).unwrap();
        assert!(valid_music_stream_content_type(Some(&value)));
    }
    for value in ["text/html", "application/json", "video/webm"] {
        let value = HeaderValue::from_str(value).unwrap();
        assert!(!valid_music_stream_content_type(Some(&value)));
    }
    assert!(!valid_music_stream_content_type(None));
}

#[test]
fn every_non_spotify_playback_returns_only_a_pin_loopback_stream() {
    const SOURCE: &str = include_str!("mod.rs");
    assert!(SOURCE.contains("/internal/spotify/provider-stream/{ticket}"));
    assert!(!SOURCE.contains("/api/music-gateway/stream/"));
}

#[test]
fn artist_top_tracks_backoff_window_is_time_bounded() {
    let now = Instant::now();
    assert!(!artist_top_tracks_backoff_is_active(None, now));
    assert!(artist_top_tracks_backoff_is_active(
        Some(now + Duration::from_secs(1)),
        now,
    ));
    assert!(!artist_top_tracks_backoff_is_active(Some(now), now));
    assert!(!artist_top_tracks_backoff_is_active(
        Some(now),
        now + Duration::from_secs(1),
    ));
}

fn scored_track(id: &str, popularity: Option<u32>) -> SpotifyTrack {
    SpotifyTrack {
        id: id.into(),
        title: "Song".into(),
        artists: vec!["Artist".into()],
        album: "Album".into(),
        duration_ms: 200_000,
        track_number: 1,
        disc_number: 1,
        explicit: false,
        popularity,
    }
}

#[test]
fn popularity_order_describes_the_list_without_reordering_it() {
    // The second, provider-independent opinion on "is this really a ranking?".
    // A top-tracks page descends; a relevance-ordered search generally does
    // not. This must only ever DESCRIBE — the played track stays rank one.
    let descending = [
        scored_track("4uLU6hMCjMI75M1A2tKUQC", Some(90)),
        scored_track("0d28khcov6AiegSCpG5TuT", Some(90)),
        scored_track("1weenld61qoidwYuZ1GESA", Some(41)),
    ];
    assert_eq!(popularity_order(&descending), "descending");

    let jumbled = [
        scored_track("4uLU6hMCjMI75M1A2tKUQC", Some(41)),
        scored_track("0d28khcov6AiegSCpG5TuT", Some(90)),
    ];
    assert_eq!(popularity_order(&jumbled), "mixed");

    // An unscored track must make the answer `unknown`, never a free pass:
    // treating `None` as zero would report any unscored list as perfectly
    // descending, which is exactly the false reassurance this exists to avoid.
    let partly_scored = [
        scored_track("4uLU6hMCjMI75M1A2tKUQC", Some(90)),
        scored_track("0d28khcov6AiegSCpG5TuT", None),
    ];
    assert_eq!(popularity_order(&partly_scored), "unknown");
    assert_eq!(popularity_order(&[]), "descending");
}

#[test]
fn track_popularity_is_parsed_and_stays_absent_when_unscored() {
    // Spotify track objects contain a documented 0-100 `popularity`, the same
    // field `select_artist_id` already reads for artists. Parsing it gives the
    // ordering check a second, independent input.
    let scored = serde_json::json!({
        "tracks": { "items": [{
            "id": "4uLU6hMCjMI75M1A2tKUQC",
            "name": "Billie Jean",
            "artists": [{"name": "Michael Jackson"}],
            "album": {"name": "Thriller"},
            "duration_ms": 293_827,
            "popularity": 86
        }, {
            "id": "0d28khcov6AiegSCpG5TuT",
            "name": "Chicago",
            "artists": [{"name": "Michael Jackson"}],
            "album": {"name": "Xscape"},
            "duration_ms": 227_346
        }]}
    });
    let tracks = parse_track_array(scored.pointer("/tracks/items"), 10);
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0].popularity, Some(86));
    // A trimmed object that omits the field is unscored, not zero-scored.
    assert_eq!(tracks[1].popularity, None);
    // One unscored entry is enough to refuse a monotonicity claim.
    assert_eq!(popularity_order(&tracks), "unknown");

    // The provider's own documented ceiling. A nonsense value is clamped
    // rather than propagated into an ordering comparison.
    let absurd = serde_json::json!({"items": [{
        "id": "4uLU6hMCjMI75M1A2tKUQC",
        "name": "Song",
        "artists": [{"name": "Artist"}],
        "album": {"name": "Album"},
        "duration_ms": 200_000,
        "popularity": 4_000_000_000_u64
    }]});
    assert_eq!(
        parse_track_array(absurd.pointer("/items"), 10)[0].popularity,
        Some(100),
    );
}

/// Ranking provenance is decided inside `query`, on branches that each need a
/// live Spotify session and two provider round-trips, so the decision cannot be
/// exercised from a unit test. Pin it against the source instead: the property
/// that matters is that EVERY exit from the artist branch assigns a provenance
/// and every degraded exit also logs the operational marker. Deleting either
/// assignment turns this red, which is the failure the "Chicago" incident had
/// no way to detect.
#[test]
fn every_artist_ranking_exit_records_its_provenance() {
    // The scanned corpus is `mod.rs`, never this file, so the anchors below
    // cannot match themselves and let the guard pass vacuously.
    const SOURCE: &str = include_str!("mod.rs");
    const DEGRADED_PROVENANCE: &str =
        "ranking = SpotifyRankingProvenance::SearchRelevanceFallback;";
    const RANKED_PROVENANCE: &str = "ranking = SpotifyRankingProvenance::ProviderTopTracks;";
    const DEGRADED_MARKER: &str = "log_degraded_artist_ranking(";
    const FALLBACK_QUERY: &str = "artist_top_tracks_fallback_query(artist_name),";

    // Both degraded exits — the failure that OPENS the backoff window and
    // every request served during it. Only the first used to log at all,
    // which is why a fallback could go unrecorded for ten minutes.
    assert_eq!(
        SOURCE.matches(FALLBACK_QUERY).count(),
        2,
        "the artist branch should have exactly two relevance-search exits",
    );
    assert_eq!(
        SOURCE.matches(DEGRADED_PROVENANCE).count(),
        2,
        "every relevance-search exit must record the degraded provenance",
    );
    assert_eq!(
        SOURCE.matches(DEGRADED_MARKER).count(),
        3,
        "both degraded exits must emit the marker (plus its one definition)",
    );
    assert_eq!(
        SOURCE.matches(RANKED_PROVENANCE).count(),
        1,
        "the provider top-tracks exit must record the provider-ranked provenance",
    );
    // And the decision has to actually reach the response.
    assert!(SOURCE.contains("ranking_provenance: ranking,"));
    // Selection itself must stay untouched: measuring how often the degraded
    // path fires comes BEFORE changing which track plays.
    assert!(
        !SOURCE.contains("sort_by_key(|track| track.popularity"),
        "provenance is a measurement, not a licence to reorder results",
    );
}

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
fn credentials_round_trip_in_private_bounded_artifact() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("spotify-auth.json");
    let auth = stored_auth();
    persist_auth(&path, &auth).unwrap();
    let loaded = load_auth(&path).unwrap();
    assert_eq!(loaded.version, AUTH_VERSION);
    assert_eq!(loaded.credentials.auth_data, b"never-log-this-token");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
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

#[tokio::test]
async fn reused_player_load_binds_the_first_announced_request_id() {
    let track_id = SpotifyUri::from_uri("spotify:track:0d28khcov6AiegSCpG5TuT").unwrap();
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    sender
        .send(PlayerEvent::PlayRequestIdChanged {
            play_request_id: 42,
        })
        .unwrap();
    // A different request for the same URI must never satisfy this load.
    sender
        .send(PlayerEvent::Playing {
            play_request_id: 41,
            track_id: track_id.clone(),
            position_ms: 0,
        })
        .unwrap();
    sender
        .send(PlayerEvent::Playing {
            play_request_id: 42,
            track_id,
            position_ms: 0,
        })
        .unwrap();

    assert_eq!(
        await_player_load(&mut events, Duration::from_millis(50)).await,
        Ok(42)
    );
}

#[tokio::test]
async fn exact_unavailable_event_fails_without_invalidating_reusable_player() {
    let track_id = SpotifyUri::from_uri("spotify:track:0d28khcov6AiegSCpG5TuT").unwrap();
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    sender
        .send(PlayerEvent::PlayRequestIdChanged { play_request_id: 7 })
        .unwrap();
    sender
        .send(PlayerEvent::Unavailable {
            play_request_id: 7,
            track_id,
        })
        .unwrap();

    let failure = await_player_load(&mut events, Duration::from_millis(50))
        .await
        .unwrap_err();
    assert_eq!(failure, PlayerLoadFailure::Unavailable);
    assert!(!failure.invalidates_player());
    assert!(PlayerLoadFailure::Timeout.invalidates_player());
    assert!(PlayerLoadFailure::ChannelClosed.invalidates_player());
}

#[test]
fn pairing_finalization_never_publishes_partial_or_cancelled_state() {
    let mut finalization = PairingFinalization::default();
    assert!(!finalization.can_publish(false));

    finalization.local_auth_written = true;
    assert!(!finalization.can_publish(false));

    finalization.vault_confirmed = true;
    assert!(finalization.can_publish(false));
    assert!(!finalization.can_publish(true));
}

#[tokio::test]
async fn lifecycle_transitions_serialize_and_invalidate_stale_publication() {
    let lifecycle = Arc::new(LifecycleGate::default());
    let first_generation = lifecycle.begin_transition().await;
    let settings = SpotifyConfig {
        enabled: true,
        experimental_acknowledged: true,
        ..SpotifyConfig::default()
    };
    assert!(publication_allowed(
        first_generation,
        first_generation,
        &settings
    ));

    let waiting_lifecycle = lifecycle.clone();
    let mut waiter = tokio::spawn(async move { waiting_lifecycle.begin_transition().await });
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut waiter)
        .await
        .is_err());

    lifecycle.end_transition(first_generation).await;
    let second_generation = tokio::time::timeout(Duration::from_millis(100), waiter)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first_generation, second_generation);
    assert!(!publication_allowed(
        second_generation,
        first_generation,
        &settings
    ));
    lifecycle.end_transition(second_generation).await;
}

#[tokio::test]
async fn detached_transition_owner_survives_request_cancellation() {
    let lifecycle = Arc::new(LifecycleGate::default());
    let generation = lifecycle.begin_transition().await;
    let (started, started_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let owner = lifecycle.clone();
    let caller = tokio::spawn(async move {
        await_owned_transition(owner, generation, async move {
            let _ = started.send(());
            let _ = release_rx.await;
            Ok::<_, SpotifyError>(())
        })
        .await
    });
    started_rx.await.unwrap();

    caller.abort();
    let _ = caller.await;
    assert_eq!(
        lifecycle.state.lock().await.transition_generation,
        Some(generation)
    );

    let changed = lifecycle.changed.notified();
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_millis(100), changed)
        .await
        .unwrap();
    let next = lifecycle.begin_transition().await;
    assert_ne!(next, generation);
    lifecycle.end_transition(next).await;
}

#[tokio::test]
async fn detached_transition_owner_releases_after_operation_panic() {
    let lifecycle = Arc::new(LifecycleGate::default());
    let generation = lifecycle.begin_transition().await;
    let result = await_owned_transition(lifecycle.clone(), generation, async move {
        panic!("test panic inside lifecycle operation");
        #[allow(unreachable_code)]
        Ok::<_, SpotifyError>(())
    })
    .await;
    assert!(matches!(result, Err(SpotifyError::Unavailable)));
    assert!(lifecycle.state.lock().await.transition_generation.is_none());
}

#[tokio::test]
async fn concurrent_pairing_start_cannot_replace_or_invalidate_active_task() {
    let lifecycle = LifecycleGate::default();
    let generation = lifecycle.begin_pairing_transition().await.unwrap();
    let (cancel, _) = watch::channel(false);
    let handle = tokio::spawn(std::future::pending::<()>());
    {
        let mut state = lifecycle.state.lock().await;
        assert!(install_pairing_task(
            &mut state,
            PairingTask {
                generation,
                cancel,
                handle,
            },
        )
        .is_ok());
    }
    lifecycle.end_transition(generation).await;

    assert!(lifecycle.begin_pairing_transition().await.is_err());
    assert!(lifecycle.try_begin_reconnect_transition().await.is_err());
    assert_eq!(lifecycle.state.lock().await.generation, generation);
    {
        let mut state = lifecycle.state.lock().await;
        assert!(take_pairing_task_for_generation(&mut state, generation + 1).is_none());
        assert!(state.pairing_task.is_some());
    }

    let cancellation_generation = lifecycle.begin_transition().await;
    assert_ne!(generation, cancellation_generation);
    let task = lifecycle.state.lock().await.pairing_task.take().unwrap();
    task.cancel.send_replace(true);
    task.handle.abort();
    let _ = task.handle.await;
    lifecycle.end_transition(cancellation_generation).await;
}

#[test]
fn publication_guard_rechecks_both_enablement_gates() {
    let mut settings = SpotifyConfig {
        enabled: true,
        experimental_acknowledged: true,
        ..SpotifyConfig::default()
    };
    assert!(publication_allowed(7, 7, &settings));
    assert!(!publication_allowed(8, 7, &settings));
    settings.enabled = false;
    assert!(!publication_allowed(7, 7, &settings));
    settings.enabled = true;
    settings.experimental_acknowledged = false;
    assert!(!publication_allowed(7, 7, &settings));
}

#[test]
fn saved_session_restore_skips_only_live_or_pairing_states() {
    assert!(should_restore_saved_session(
        &RuntimeState::Ready {
            username: Some("user".into()),
        },
        false,
    ));
    assert!(should_restore_saved_session(
        &RuntimeState::Error {
            message: "connection closed".into(),
        },
        false,
    ));
    assert!(!should_restore_saved_session(
        &RuntimeState::Ready { username: None },
        true,
    ));
    // A disabled service can retain a durably vaulted credential. After it
    // is re-enabled, SignedOut must be allowed to attempt that credential;
    // load_auth still returns NotPaired when no credential actually exists.
    assert!(should_restore_saved_session(
        &RuntimeState::SignedOut,
        false
    ));
    assert!(!should_restore_saved_session(
        &RuntimeState::Pairing { expires_at: 1 },
        false,
    ));
}

#[test]
fn reconnect_backoff_is_exponential_and_capped() {
    assert_eq!(reconnect_backoff(1), Duration::from_secs(2));
    assert_eq!(reconnect_backoff(2), Duration::from_secs(4));
    assert_eq!(reconnect_backoff(3), Duration::from_secs(8));
    assert_eq!(reconnect_backoff(4), Duration::from_secs(16));
    assert_eq!(reconnect_backoff(5), Duration::from_secs(30));
    assert_eq!(reconnect_backoff(50), Duration::from_secs(30));
}

#[test]
fn reconnect_cooldown_blocks_repeated_attempts_until_due() {
    let now = tokio::time::Instant::now();
    assert!(reconnect_is_due(None, now));
    assert!(!reconnect_is_due(Some(now + Duration::from_secs(2)), now));
    assert!(reconnect_is_due(Some(now), now));
}

#[test]
fn only_transient_restore_failures_start_reconnect_backoff() {
    assert!(reconnect_failure_needs_backoff(&SpotifyError::Unavailable));
    assert!(reconnect_failure_needs_backoff(&SpotifyError::Persistence));
    assert!(!reconnect_failure_needs_backoff(&SpotifyError::Disabled));
    assert!(!reconnect_failure_needs_backoff(
        &SpotifyError::AcknowledgementRequired
    ));
    assert!(!reconnect_failure_needs_backoff(&SpotifyError::NotPaired));
    assert!(!reconnect_failure_needs_backoff(&SpotifyError::Pairing));
}

#[tokio::test]
async fn reconnect_transition_is_single_flight() {
    let lifecycle = LifecycleGate::default();
    let generation = lifecycle
        .try_begin_reconnect_transition()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        lifecycle.try_begin_reconnect_transition().await.unwrap(),
        None
    );
    lifecycle.end_transition(generation).await;
    assert!(lifecycle
        .try_begin_reconnect_transition()
        .await
        .unwrap()
        .is_some());
}

#[test]
fn reconnect_cleanup_preserves_contextual_track_metadata() {
    let track = SpotifyTrack {
        id: "0d28khcov6AiegSCpG5TuT".into(),
        title: "Feel Good Inc.".into(),
        artists: vec!["Gorillaz".into()],
        album: "Demon Days".into(),
        duration_ms: 222_640,
        track_number: 6,
        disc_number: 1,
        explicit: false,
        popularity: None,
    };
    let mut runtime = Runtime {
        state: RuntimeState::Ready {
            username: Some("listener".into()),
        },
        playback_epoch: 0,
        session: None,
        player: None,
        sink_controller: None,
        playback_watcher: None,
        active_buffer: None,
        buffers: HashMap::new(),
        buffer_order: VecDeque::new(),
        tracks: HashMap::from([(track.id.clone(), track.clone())]),
        reconnect_failures: 2,
        reconnect_not_before: Some(tokio::time::Instant::now()),
        reconnect_error: Some("network changed".into()),
    };

    let resources = take_runtime_resources(
        &mut runtime,
        RuntimeState::Ready {
            username: Some("listener".into()),
        },
        false,
    );

    assert!(resources.0.is_none() && resources.1.is_none() && resources.2.is_none());
    assert_eq!(runtime.playback_epoch, 1);
    assert_eq!(runtime.tracks.get(&track.id), Some(&track));
    assert_eq!(runtime.reconnect_failures, 2);
}

#[tokio::test]
async fn pairing_cancellation_is_sticky_before_waiter_runs() {
    let (cancel, mut cancel_rx) = watch::channel(false);
    cancel.send_replace(true);
    tokio::time::timeout(
        Duration::from_millis(50),
        wait_for_pairing_cancellation(&mut cancel_rx),
    )
    .await
    .unwrap();
    assert!(pairing_cancelled(&cancel_rx));
}

#[test]
fn parses_current_search_track_shape() {
    let body = serde_json::json!({
        "tracks": { "items": [{
            "id": "4uLU6hMCjMI75M1A2tKUQC",
            "name": "Never Gonna Give You Up",
            "artists": [{"name": "Rick Astley"}],
            "album": {"name": "Whenever You Need Somebody"},
            "duration_ms": 213573,
            "track_number": 1,
            "disc_number": 1,
            "explicit": false
        }]}
    });
    let tracks = parse_track_array(body.pointer("/tracks/items"), 10);
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].artists, vec!["Rick Astley"]);
}

#[test]
fn collection_contract_keeps_search_requests_at_ten() {
    assert_eq!(types::MAX_SEARCH_RESULTS, 10);
    assert_eq!(types::MAX_COLLECTION_RESULTS, 100);
    assert_eq!(search_page_size(100), 10);
    assert_eq!(search_page_size(7), 7);
    assert!(!uses_personal_top_tracks("top_hits"));
    assert!(uses_personal_top_tracks("featured"));
    assert!(!uses_personal_top_tracks("track"));

    let top_hits = SpotifyQueryRequest {
        kind: "top_hits".into(),
        primary: Some("Blue in Green".into()),
        secondary: Some("Miles Davis".into()),
        ids: Vec::new(),
        limit: 1,
    };
    assert_eq!(
        build_search_query(&top_hits),
        "Blue in Green artist:Miles Davis"
    );
}

#[test]
fn playlist_reference_accepts_id_and_uri_only() {
    let id = "37i9dQZF1DWSw8liJZcPOI";
    assert_eq!(parse_playlist_reference(id).as_deref(), Some(id));
    assert_eq!(
        parse_playlist_reference(&format!("spotify:playlist:{id}")).as_deref(),
        Some(id)
    );
    assert_eq!(
        parse_playlist_reference(&format!("spotify:track:{id}")),
        None
    );
    assert_eq!(parse_playlist_reference("Morning music"), None);
}

#[test]
fn album_resolution_prefers_exact_artist_match_without_reordering_tracks() {
    let items = serde_json::json!([{
        "id": "0sNOF9WDwhWunNAHPD3Baj",
        "name": "Kind of Blue",
        "artists": [{"name": "Cover Artist"}]
    }, {
        "id": "1weenld61qoidwYuZ1GESA",
        "name": "Kind of Blue",
        "artists": [{"name": "Miles Davis"}]
    }]);
    assert_eq!(
        select_album_id(Some(&items), "kind of blue", Some("miles davis")).as_deref(),
        Some("1weenld61qoidwYuZ1GESA")
    );
}

#[test]
fn contextual_artist_resolution_requires_an_exact_unambiguous_catalog_identity() {
    let artists = serde_json::json!([{
        "id": "0123456789012345678901",
        "name": "Gorillaz Tribute",
        "popularity": 90
    }, {
        "id": "1234567890123456789012",
        "name": "Gorillaz",
        "popularity": 88
    }]);
    assert_eq!(
        select_artist_id(Some(&artists), " gorillaz ").as_deref(),
        Some("1234567890123456789012")
    );

    let ambiguous = serde_json::json!([{
        "id": "0123456789012345678901",
        "name": "Phoenix",
        "popularity": 50
    }, {
        "id": "1234567890123456789012",
        "name": "Phoenix",
        "popularity": 50
    }]);
    assert_eq!(select_artist_id(Some(&ambiguous), "Phoenix"), None);

    let ranked = serde_json::json!([{
        "id": "0123456789012345678901",
        "name": "Muse",
        "popularity": 40
    }, {
        "id": "1234567890123456789012",
        "name": "Muse",
        "popularity": 80
    }]);
    assert_eq!(
        select_artist_id(Some(&ranked), "Muse").as_deref(),
        Some("1234567890123456789012")
    );
}

#[test]
fn contextual_artist_search_fallback_is_limited_to_transient_provider_failures() {
    assert!(artist_top_tracks_needs_search_fallback(
        &SpotifyError::Unavailable
    ));
    assert!(artist_top_tracks_needs_search_fallback(
        &SpotifyError::RateLimited
    ));

    for error in [
        SpotifyError::Disabled,
        SpotifyError::AcknowledgementRequired,
        SpotifyError::NotPaired,
        SpotifyError::Pairing,
        SpotifyError::AlreadyPaired,
        SpotifyError::InvalidRequest("invalid artist name"),
        SpotifyError::Persistence,
    ] {
        assert!(!artist_top_tracks_needs_search_fallback(&error));
    }
}

#[test]
fn contextual_artist_search_fallback_preserves_the_artist_qualifier() {
    assert_eq!(
        artist_top_tracks_fallback_query("  Gorillaz  "),
        "artist:Gorillaz"
    );
}

#[test]
fn truncated_metadata_playlist_is_never_reported_as_complete_without_enough_items() {
    assert!(!metadata_playlist_is_complete(true, 20, 80, 20, 50));
    assert!(metadata_playlist_is_complete(true, 50, 80, 50, 50));
    assert!(metadata_playlist_is_complete(true, 40, 40, 35, 50));
    assert!(metadata_playlist_is_complete(false, 20, 80, 20, 50));
    let incomplete_page = serde_json::json!({"total": 80});
    assert!(page_has_unseen_items(Some(&incomplete_page), 50));
    assert!(!page_has_unseen_items(Some(&incomplete_page), 80));
}

#[test]
fn playlist_parser_skips_episodes_but_rejects_malformed_declared_tracks() {
    let episode = serde_json::json!({"item": {"type": "episode"}});
    assert!(parse_playlist_entry(&episode).unwrap().is_none());

    let malformed = serde_json::json!({
        "item": {
            "type": "track",
            "id": "4uLU6hMCjMI75M1A2tKUQC",
            "name": "Missing documented fields"
        }
    });
    assert!(matches!(
        parse_playlist_entry(&malformed),
        Err(SpotifyError::Unavailable)
    ));
}

#[test]
fn retry_after_is_bounded_and_radio_fallback_is_explicit() {
    let mut headers = HeaderMap::new();
    headers.insert("retry-after", "5".parse().unwrap());
    assert_eq!(retry_after_delay(&headers), Some(Duration::from_secs(5)));
    headers.insert("retry-after", "6".parse().unwrap());
    assert_eq!(retry_after_delay(&headers), None);

    let seed = SpotifyTrack {
        id: "4uLU6hMCjMI75M1A2tKUQC".into(),
        title: "Seed Song".into(),
        artists: vec!["Seed Artist".into()],
        album: "Album".into(),
        duration_ms: 120_000,
        track_number: 1,
        disc_number: 1,
        explicit: false,
        popularity: None,
    };
    assert_eq!(
        radio_fallback_query(Some(&seed), None, None),
        "artist:Seed Artist Seed Song"
    );
    assert_eq!(radio_fallback_query(None, None, None), "top hits");
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
