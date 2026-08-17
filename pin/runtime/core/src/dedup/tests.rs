use super::*;
use axum::routing::post;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower::ServiceExt;

const TEST_PATH: &str = "/test.Svc/Streamy";

fn dedup_state(paths: &[&str]) -> GrpcDedup {
    let mut dedup = GrpcDedup::new();
    for path in paths {
        dedup
            .routes
            .insert((*path).to_string(), Duration::from_millis(200));
    }
    dedup
}

fn request_key(path: &str, headers: &HeaderMap, body: &[u8]) -> DedupKey {
    let mut request = http::Request::builder()
        .method("POST")
        .uri(path)
        .body(())
        .unwrap();
    *request.headers_mut() = headers.clone();
    let (parts, _) = request.into_parts();
    dedup_key_for_request(path, &parts, body)
}

fn response_with_grpc_header(body: Body, status: &'static str) -> http::Response<Body> {
    let mut response = http::Response::new(body);
    response
        .headers_mut()
        .insert("grpc-status", http::HeaderValue::from_static(status));
    response
}

async fn contains_inflight(dedup: &GrpcDedup, key: &DedupKey) -> bool {
    dedup.inner.lock().await.inflight.contains_key(key)
}

async fn collect_data_and_trailers(
    mut body: Body,
) -> Result<(Bytes, Option<HeaderMap>), axum::Error> {
    let mut data = Vec::new();
    let mut trailers = None;
    while let Some(frame) = body.frame().await {
        let frame = frame?;
        if let Some(chunk) = frame.data_ref() {
            data.extend_from_slice(chunk);
        }
        if let Some(value) = frame.trailers_ref() {
            trailers = Some(value.clone());
        }
    }
    Ok((Bytes::from(data), trailers))
}

/// Regression guard for the permanent in-flight leak: if a leader request
/// is aborted (client RST_STREAM / cancellation) or panics before the
/// response body takes ownership, the `InflightGuard` must free the entry
/// so byte-identical follow-up requests are not coalesced onto a sender
/// that will never publish, hanging until process restart.
#[tokio::test]
async fn inflight_guard_frees_entry_on_abort_and_disarms_on_handoff() {
    let dedup = dedup_state(&[TEST_PATH]);
    let key = request_key(TEST_PATH, &HeaderMap::new(), b"body");

    // Abort path: register a leader + guard, then drop the guard.
    let entry = Arc::new(InflightResponse::new());
    dedup
        .inner
        .lock()
        .await
        .inflight
        .insert(key.clone(), entry.clone());
    let guard = InflightGuard::new(
        dedup.inner.clone(),
        key.clone(),
        entry,
        Duration::from_millis(200),
    );
    drop(guard);
    // The removal runs on a spawned task; poll briefly for it.
    for _ in 0..40 {
        if !contains_inflight(&dedup, &key).await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        !contains_inflight(&dedup, &key).await,
        "dropping the guard on abort must free the in-flight entry"
    );

    // Hand-off path: after `take()` transfers ownership to the response
    // body, dropping the guard must NOT remove the entry (the tee owns it).
    let entry = Arc::new(InflightResponse::new());
    dedup
        .inner
        .lock()
        .await
        .inflight
        .insert(key.clone(), entry.clone());
    let mut guard = InflightGuard::new(
        dedup.inner.clone(),
        key.clone(),
        entry,
        Duration::from_millis(200),
    );
    let finalizer = guard.take().expect("take() yields ownership once");
    assert!(guard.take().is_none(), "take() is idempotent");
    drop(guard);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        contains_inflight(&dedup, &key).await,
        "after hand-off the guard's drop must be a no-op"
    );
    finalizer.fail().await;
}

/// Wire-level regression guard: a deduped streaming response served
/// through the REAL `axum::serve` + HTTP/2 stack must deliver its first
/// DATA frame to a socket client while the handler stream is still open.
/// This is the full transport slice under the on-device symptom (interim
/// Understand turns arriving only at stream end).
#[tokio::test]
async fn deduped_streaming_responses_reach_the_wire_before_stream_end() {
    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let handler_body = std::sync::Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let handler_body = handler_body.clone();
                move || async move {
                    let body = handler_body.lock().await.take().expect("single invocation");
                    http::Response::new(body)
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup_state(&[TEST_PATH]),
            dedup_middleware,
        ));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind streaming latency listener");
    let address = listener.local_addr().expect("listener address");
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });

    frame_tx
        .send(Ok(Bytes::from_static(b"interim-frame")))
        .expect("send first frame");

    let client = reqwest::Client::builder()
        .http2_prior_knowledge()
        .build()
        .expect("h2 client");
    let response = client
        .post(format!("http://{address}{TEST_PATH}"))
        .body("req")
        .send()
        .await
        .expect("request");
    assert_eq!(response.version(), http::Version::HTTP_2);

    use futures::StreamExt as _;
    let mut chunks = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(2), chunks.next())
        .await
        .expect("first wire chunk must not wait for stream end")
        .expect("stream open")
        .expect("chunk ok");
    assert_eq!(&first[..], b"interim-frame");

    frame_tx
        .send(Ok(Bytes::from_static(b"terminal-frame")))
        .expect("send second frame");
    drop(frame_tx);
    let second = tokio::time::timeout(Duration::from_secs(2), chunks.next())
        .await
        .expect("second wire chunk delivered")
        .expect("stream open for second chunk")
        .expect("chunk ok");
    assert_eq!(&second[..], b"terminal-frame");

    server.abort();
    let _ = server.await;
}

/// Regression guard: the dedup middleware must forward streamed response
/// frames as they are produced. Buffering the stream to completion (the
/// old behavior) delayed every interim Understand turn to stream end,
/// which silently broke the stock progress-cue timing.
#[tokio::test]
async fn deduped_streaming_responses_forward_frames_before_stream_end() {
    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let body_stream = UnboundedReceiverStream::new(frame_rx);
    let handler_body = Body::from_stream(body_stream);
    let handler_body = std::sync::Arc::new(tokio::sync::Mutex::new(Some(handler_body)));
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let handler_body = handler_body.clone();
                move || async move {
                    let body = handler_body.lock().await.take().expect("single invocation");
                    http::Response::new(body)
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup_state(&[TEST_PATH]),
            dedup_middleware,
        ));

    frame_tx
        .send(Ok(Bytes::from_static(b"interim-frame")))
        .expect("send first frame");

    let response = router
        .oneshot(
            http::Request::builder()
                .method("POST")
                .uri(TEST_PATH)
                .body(Body::from(Bytes::from_static(b"req")))
                .unwrap(),
        )
        .await
        .unwrap();

    let mut body = response.into_body();
    // The first frame must arrive while the handler stream is still open;
    // with buffering this hangs until frame_tx drops and times out.
    let first = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .expect("first frame must not wait for stream end")
        .expect("stream must not be closed")
        .expect("frame must be ok");
    assert_eq!(
        first.data_ref().map(|data| &data[..]),
        Some(&b"interim-frame"[..])
    );

    // Complete the stream; the remaining frame and end must flow through.
    frame_tx
        .send(Ok(Bytes::from_static(b"terminal-frame")))
        .expect("send second frame");
    drop(frame_tx);
    let second = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .expect("second frame delivered")
        .expect("stream open for second frame")
        .expect("frame ok");
    assert_eq!(
        second.data_ref().map(|data| &data[..]),
        Some(&b"terminal-frame"[..])
    );
}

/// A concurrent duplicate is another live client of the same operation,
/// not a cache lookup that may wait for EOF. It must replay frames already
/// produced by the leader, then receive the live tail, while the handler is
/// still invoked exactly once.
#[tokio::test]
async fn concurrent_follower_replays_prefix_before_leader_stream_ends() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let invocations = Arc::new(AtomicUsize::new(0));
    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let handler_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let dedup = dedup_state(&[TEST_PATH]);
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let handler_body = handler_body.clone();
                let invocations = invocations.clone();
                move || {
                    let handler_body = handler_body.clone();
                    let invocations = invocations.clone();
                    async move {
                        invocations.fetch_add(1, Ordering::SeqCst);
                        let body = handler_body
                            .lock()
                            .await
                            .take()
                            .expect("dedup must invoke the streaming handler once");
                        response_with_grpc_header(body, "0")
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));

    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .header("x-ai-mic-run-id", "00000000-0000-4000-8000-000000000001")
            .body(Body::from(Bytes::from_static(b"same-request")))
            .unwrap()
    };

    let leader = router.clone().oneshot(request()).await.unwrap();
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
    let mut leader_body = leader.into_body();

    frame_tx
        .send(Ok(Bytes::from_static(b"interim-frame")))
        .expect("send prefix frame");
    let leader_first = tokio::time::timeout(Duration::from_secs(1), leader_body.frame())
        .await
        .expect("leader prefix must arrive while source remains open")
        .expect("leader stream open")
        .expect("leader prefix ok");
    assert_eq!(
        leader_first.data_ref().map(|data| &data[..]),
        Some(&b"interim-frame"[..])
    );

    let follower = tokio::time::timeout(Duration::from_secs(1), router.clone().oneshot(request()))
        .await
        .expect("follower response head must not wait for leader EOF")
        .expect("follower response");
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
    let mut follower_body = follower.into_body();
    let follower_first = tokio::time::timeout(Duration::from_secs(1), follower_body.frame())
        .await
        .expect("late follower must replay prefix before leader EOF")
        .expect("follower stream open")
        .expect("follower prefix ok");
    assert_eq!(
        follower_first.data_ref().map(|data| &data[..]),
        Some(&b"interim-frame"[..])
    );

    frame_tx
        .send(Ok(Bytes::from_static(b"terminal-frame")))
        .expect("send live tail");
    drop(frame_tx);

    for body in [&mut leader_body, &mut follower_body] {
        let tail = tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .expect("live tail delivered")
            .expect("stream open for tail")
            .expect("tail ok");
        assert_eq!(
            tail.data_ref().map(|data| &data[..]),
            Some(&b"terminal-frame"[..])
        );
        assert!(tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .expect("stream completion delivered")
            .is_none());
    }
    assert_eq!(invocations.load(Ordering::SeqCst), 1);

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-ai-mic-run-id",
        http::HeaderValue::from_static("00000000-0000-4000-8000-000000000001"),
    );
    let key = request_key(TEST_PATH, &headers, b"same-request");
    for _ in 0..40 {
        if dedup.inner.lock().await.cache.contains_key(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        dedup.inner.lock().await.cache.contains_key(&key),
        "successful EOF must populate the completed-response cache"
    );

    let replay = router.clone().oneshot(request()).await.unwrap();
    let replayed = replay
        .into_body()
        .collect()
        .await
        .expect("completed response replay")
        .to_bytes();
    assert_eq!(&replayed[..], b"interim-frameterminal-frame");
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropping_leader_body_does_not_abort_a_live_follower() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let invocations = Arc::new(AtomicUsize::new(0));
    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let handler_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let handler_body = handler_body.clone();
                let invocations = invocations.clone();
                move || {
                    let handler_body = handler_body.clone();
                    let invocations = invocations.clone();
                    async move {
                        invocations.fetch_add(1, Ordering::SeqCst);
                        http::Response::new(
                            handler_body
                                .lock()
                                .await
                                .take()
                                .expect("one shared handler invocation"),
                        )
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup_state(&[TEST_PATH]),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .header("x-ai-mic-run-id", "00000000-0000-4000-8000-000000000002")
            .body(Body::from(Bytes::from_static(b"same-request")))
            .unwrap()
    };

    let leader = router.clone().oneshot(request()).await.unwrap();
    let follower = router.clone().oneshot(request()).await.unwrap();
    drop(leader);

    frame_tx
        .send(Ok(Bytes::from_static(b"interim-frame")))
        .unwrap();
    frame_tx
        .send(Ok(Bytes::from_static(b"terminal-frame")))
        .unwrap();
    drop(frame_tx);

    let replayed = tokio::time::timeout(Duration::from_secs(1), follower.into_body().collect())
        .await
        .expect("surviving follower must complete")
        .expect("surviving follower body")
        .to_bytes();
    assert_eq!(&replayed[..], b"interim-frameterminal-frame");
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn old_generation_cannot_remove_or_cache_over_replacement_after_clear() {
    let dedup = dedup_state(&[TEST_PATH]);
    let key = request_key(TEST_PATH, &HeaderMap::new(), b"body");
    let old_entry = Arc::new(InflightResponse::new());
    assert!(old_entry.publish_head(&ResponseHead {
        status: http::StatusCode::OK,
        headers: HeaderMap::new(),
    }));
    dedup
        .inner
        .lock()
        .await
        .inflight
        .insert(key.clone(), old_entry.clone());
    let mut old_guard = InflightGuard::new(
        dedup.inner.clone(),
        key.clone(),
        old_entry.clone(),
        Duration::from_millis(200),
    );
    let old_finalizer = old_guard.take().unwrap();

    DedupHandle {
        inner: dedup.inner.clone(),
    }
    .clear()
    .await;

    let replacement = Arc::new(InflightResponse::new());
    dedup
        .inner
        .lock()
        .await
        .inflight
        .insert(key.clone(), replacement.clone());
    old_entry.finish(ReplayTerminal::Complete);
    old_finalizer
        .succeed(CompletedResponse {
            status: http::StatusCode::OK,
            headers: HeaderMap::new(),
            body: Bytes::new(),
            trailers: None,
            retained_bytes: 0,
        })
        .await;

    let inner = dedup.inner.lock().await;
    assert!(
        inner
            .inflight
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &replacement)),
        "old finalizer must not remove the replacement generation"
    );
    assert!(
        !inner.cache.contains_key(&key),
        "invalidated generation must not repopulate the cache"
    );
}

#[tokio::test]
async fn immediate_success_duplicate_joins_until_atomic_cache_handoff() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let dedup = dedup_state(&[TEST_PATH]);
    let key = request_key(TEST_PATH, &HeaderMap::new(), b"success-handoff");
    let entry = Arc::new(InflightResponse::new());
    let mut headers = HeaderMap::new();
    headers.insert("grpc-status", http::HeaderValue::from_static("0"));
    assert!(entry.publish_head(&ResponseHead {
        status: http::StatusCode::OK,
        headers,
    }));
    assert_eq!(
        entry.publish_frame(&Frame::data(Bytes::from_static(b"completed-once"))),
        ReplayPublish::Published
    );
    let completed = entry
        .completed_response()
        .expect("one explicit success status is cacheable");
    dedup
        .inner
        .lock()
        .await
        .inflight
        .insert(key.clone(), entry.clone());
    let mut guard = InflightGuard::new(
        dedup.inner.clone(),
        key.clone(),
        entry.clone(),
        Duration::from_millis(200),
    );
    let finalizer = guard.take().expect("handoff finalizer");

    // This is the deterministic handoff barrier: EOF is visible to
    // followers, but the finalizer has not yet acquired `Inner` to replace
    // the in-flight pointer with the completed cache entry.
    entry.finish_cacheable();
    {
        let state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(state.terminal, ReplayTerminal::Complete);
        assert!(state.joinable);
    }

    let invocations = Arc::new(AtomicUsize::new(1));
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let invocations = invocations.clone();
                move || {
                    invocations.fetch_add(1, Ordering::SeqCst);
                    async { response_with_grpc_header(Body::from("unexpected-handler"), "0") }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .body(Body::from(Bytes::from_static(b"success-handoff")))
            .unwrap()
    };

    let joined = router
        .clone()
        .oneshot(request())
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .expect("completed in-flight replay")
        .to_bytes();
    assert_eq!(&joined[..], b"completed-once");
    assert_eq!(invocations.load(Ordering::SeqCst), 1);

    finalizer.succeed(completed).await;
    assert!(dedup.inner.lock().await.cache.contains_key(&key));
    let cached = router
        .oneshot(request())
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .expect("completed cache replay")
        .to_bytes();
    assert_eq!(&cached[..], b"completed-once");
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
}

#[test]
fn dedup_key_hashes_all_headers_canonically_without_retaining_request_bytes() {
    let mut first = HeaderMap::new();
    first.insert(
        "x-ai-mic-run-id",
        http::HeaderValue::from_static("00000000-0000-4000-8000-000000000003"),
    );
    first.insert(
        "authorization",
        http::HeaderValue::from_static("Bearer synthetic-a"),
    );
    first.insert("grpc-timeout", http::HeaderValue::from_static("1000m"));
    let mut reordered = HeaderMap::new();
    reordered.insert("grpc-timeout", http::HeaderValue::from_static("1000m"));
    reordered.insert(
        "authorization",
        http::HeaderValue::from_static("Bearer synthetic-a"),
    );
    reordered.insert(
        "x-ai-mic-run-id",
        http::HeaderValue::from_static("00000000-0000-4000-8000-000000000003"),
    );
    let first_key = request_key(TEST_PATH, &first, b"same-body");
    assert_eq!(first_key, request_key(TEST_PATH, &first, b"same-body"));
    assert_eq!(first_key, request_key(TEST_PATH, &reordered, b"same-body"));

    for (name, value) in [
        ("authorization", "Bearer synthetic-b"),
        ("grpc-timeout", "999m"),
        ("accept-language", "da-DK"),
        ("grpc-encoding", "gzip"),
    ] {
        let mut changed = first.clone();
        changed.insert(
            http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            http::HeaderValue::from_str(value).unwrap(),
        );
        assert_ne!(first_key, request_key(TEST_PATH, &changed, b"same-body"));
    }

    let mut duplicate_order = first.clone();
    duplicate_order.append("x-synthetic-metadata", http::HeaderValue::from_static("a"));
    duplicate_order.append("x-synthetic-metadata", http::HeaderValue::from_static("b"));
    let mut reversed_duplicates = first.clone();
    reversed_duplicates.append("x-synthetic-metadata", http::HeaderValue::from_static("b"));
    reversed_duplicates.append("x-synthetic-metadata", http::HeaderValue::from_static("a"));
    assert_ne!(
        request_key(TEST_PATH, &duplicate_order, b"same-body"),
        request_key(TEST_PATH, &reversed_duplicates, b"same-body")
    );
    assert_ne!(first_key, request_key(TEST_PATH, &first, b"different-body"));

    let contextual_key = |method: &str, uri: &str| {
        let mut request = http::Request::builder()
            .method(method)
            .uri(uri)
            .body(())
            .unwrap();
        *request.headers_mut() = first.clone();
        let (parts, _) = request.into_parts();
        dedup_key_for_request(TEST_PATH, &parts, b"same-body")
    };
    assert_ne!(
        contextual_key("POST", TEST_PATH),
        contextual_key("GET", TEST_PATH)
    );
    assert_ne!(
        contextual_key("POST", TEST_PATH),
        contextual_key("POST", &format!("{TEST_PATH}?variant=1"))
    );
}

#[test]
fn completed_cache_requires_exactly_one_explicit_success_status() {
    let empty = HeaderMap::new();
    assert!(!grpc_application_status_is_cacheable(&empty, None));

    let mut header_success = HeaderMap::new();
    header_success.insert("grpc-status", http::HeaderValue::from_static("0"));
    assert!(grpc_application_status_is_cacheable(&header_success, None));

    let mut trailer_success = HeaderMap::new();
    trailer_success.insert("grpc-status", http::HeaderValue::from_static("0"));
    assert!(grpc_application_status_is_cacheable(
        &empty,
        Some(&trailer_success)
    ));
    assert!(matches!(
        grpc_application_status([&empty, &trailer_success]),
        GrpcApplicationStatus::Success
    ));

    let mut duplicate_header = HeaderMap::new();
    duplicate_header.append("grpc-status", http::HeaderValue::from_static("0"));
    duplicate_header.append("grpc-status", http::HeaderValue::from_static("0"));
    assert!(!grpc_application_status_is_cacheable(
        &duplicate_header,
        None
    ));
    assert!(!grpc_application_status_is_cacheable(
        &header_success,
        Some(&trailer_success)
    ));

    let mut trailer_failure = HeaderMap::new();
    trailer_failure.insert("grpc-status", http::HeaderValue::from_static("7"));
    assert!(!grpc_application_status_is_cacheable(
        &header_success,
        Some(&trailer_failure)
    ));

    let mut malformed = HeaderMap::new();
    malformed.insert("grpc-status", http::HeaderValue::from_static("success"));
    assert!(!grpc_application_status_is_cacheable(&malformed, None));

    let mut duplicate_trailer = HeaderMap::new();
    duplicate_trailer.append("grpc-status", http::HeaderValue::from_static("0"));
    duplicate_trailer.append("grpc-status", http::HeaderValue::from_static("7"));
    assert!(!grpc_application_status_is_cacheable(
        &empty,
        Some(&duplicate_trailer)
    ));
}

#[tokio::test]
async fn different_run_ids_do_not_share_completed_responses() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let invocations = Arc::new(AtomicUsize::new(0));
    let router =
        axum::Router::new()
            .route(
                TEST_PATH,
                post({
                    let invocations = invocations.clone();
                    move || {
                        let invocation = invocations.fetch_add(1, Ordering::SeqCst) + 1;
                        async move {
                            response_with_grpc_header(Body::from(invocation.to_string()), "0")
                        }
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                dedup_state(&[TEST_PATH]),
                dedup_middleware,
            ));
    let request = |run_id: &'static str| {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .header("x-ai-mic-run-id", run_id)
            .body(Body::from(Bytes::from_static(b"same-request")))
            .unwrap()
    };

    let first = router
        .clone()
        .oneshot(request("00000000-0000-4000-8000-000000000007"))
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let second = router
        .clone()
        .oneshot(request("00000000-0000-4000-8000-000000000008"))
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let first_replay = router
        .oneshot(request("00000000-0000-4000-8000-000000000007"))
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();

    assert_eq!(&first[..], b"1");
    assert_eq!(&second[..], b"2");
    assert_eq!(&first_replay[..], b"1");
    assert_eq!(invocations.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn source_error_removes_inflight_without_caching() {
    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let handler_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let dedup = dedup_state(&[TEST_PATH]);
    let router =
        axum::Router::new()
            .route(
                TEST_PATH,
                post({
                    let handler_body = handler_body.clone();
                    move || async move {
                        http::Response::new(handler_body.lock().await.take().unwrap())
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                dedup.clone(),
                dedup_middleware,
            ));
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-ai-mic-run-id",
        http::HeaderValue::from_static("00000000-0000-4000-8000-000000000005"),
    );
    let request = http::Request::builder()
        .method("POST")
        .uri(TEST_PATH)
        .header("x-ai-mic-run-id", "00000000-0000-4000-8000-000000000005")
        .body(Body::from(Bytes::from_static(b"error-request")))
        .unwrap();
    let key = request_key(TEST_PATH, &headers, b"error-request");
    let response = router.oneshot(request).await.unwrap();

    frame_tx
        .send(Err(std::io::Error::other("synthetic source failure")))
        .unwrap();
    drop(frame_tx);
    assert!(response.into_body().collect().await.is_err());
    for _ in 0..40 {
        if !dedup.inner.lock().await.inflight.contains_key(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let inner = dedup.inner.lock().await;
    assert!(!inner.inflight.contains_key(&key));
    assert!(!inner.cache.contains_key(&key));
}

#[tokio::test]
async fn dropping_all_subscribers_cancels_without_caching() {
    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let handler_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let dedup = dedup_state(&[TEST_PATH]);
    let router =
        axum::Router::new()
            .route(
                TEST_PATH,
                post({
                    let handler_body = handler_body.clone();
                    move || async move {
                        http::Response::new(handler_body.lock().await.take().unwrap())
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                dedup.clone(),
                dedup_middleware,
            ));
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-ai-mic-run-id",
        http::HeaderValue::from_static("00000000-0000-4000-8000-000000000006"),
    );
    let request = http::Request::builder()
        .method("POST")
        .uri(TEST_PATH)
        .header("x-ai-mic-run-id", "00000000-0000-4000-8000-000000000006")
        .body(Body::from(Bytes::from_static(b"cancel-request")))
        .unwrap();
    let key = request_key(TEST_PATH, &headers, b"cancel-request");
    let response = router.oneshot(request).await.unwrap();
    drop(response);

    for _ in 0..80 {
        if !dedup.inner.lock().await.inflight.contains_key(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let inner = dedup.inner.lock().await;
    assert!(!inner.inflight.contains_key(&key));
    assert!(!inner.cache.contains_key(&key));
    drop(inner);
    drop(frame_tx);
}

#[test]
fn replay_history_enforces_frame_limit_without_retaining_overflow() {
    let entry = InflightResponse::new();
    assert!(entry.publish_head(&ResponseHead {
        status: http::StatusCode::OK,
        headers: HeaderMap::new(),
    }));
    for _ in 0..MAX_REPLAY_FRAMES {
        assert_eq!(
            entry.publish_frame(&Frame::data(Bytes::new())),
            ReplayPublish::Published
        );
    }
    assert_eq!(
        entry.publish_frame(&Frame::data(Bytes::new())),
        ReplayPublish::Failed
    );
    let state = entry
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(state.frames.len(), MAX_REPLAY_FRAMES);
    assert_eq!(state.terminal, ReplayTerminal::Failed);
    drop(state);
    assert!(
        entry.completed_response().is_none(),
        "a frame-limit breach must never become cacheable"
    );
}

#[test]
fn replay_history_copies_slices_into_exact_size_allocations() {
    let entry = InflightResponse::new();
    assert!(entry.publish_head(&ResponseHead {
        status: http::StatusCode::OK,
        headers: HeaderMap::new(),
    }));
    let backing = Bytes::from(vec![b'x'; 1024 * 1024]);
    let slice = backing.slice(128..256);
    let source_ptr = slice.as_ptr();
    assert_eq!(
        entry.publish_frame(&Frame::data(slice.clone())),
        ReplayPublish::Published
    );

    let state = entry
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let ReplayFrame::Data(recorded) = &state.frames[0] else {
        panic!("expected recorded data frame");
    };
    assert_eq!(recorded.len(), slice.len());
    assert_ne!(
        recorded.as_ptr(),
        source_ptr,
        "replay must not retain a much larger sliced backing allocation"
    );
    assert_eq!(state.retained_bytes, slice.len());
}

#[test]
fn replay_metadata_deep_copies_sliced_values_and_preserves_duplicates() {
    let first_backing = Bytes::from(vec![b'a'; 1024 * 1024]);
    let second_backing = Bytes::from(vec![b'b'; 1024 * 1024]);
    let first_slice = first_backing.slice(128..256);
    let second_slice = second_backing.slice(512..640);
    let mut first = http::HeaderValue::from_maybe_shared(first_slice).unwrap();
    first.set_sensitive(true);
    let first_ptr = first.as_bytes().as_ptr();
    let second = http::HeaderValue::from_maybe_shared(second_slice).unwrap();
    let second_ptr = second.as_bytes().as_ptr();
    let mut headers = HeaderMap::new();
    headers.append("x-sliced", first);
    headers.append("x-sliced", second);
    let head = ResponseHead {
        status: http::StatusCode::OK,
        headers,
    };
    let entry = InflightResponse::new();
    assert!(entry.publish_head(&head));

    let trailer_backing = Bytes::from(vec![b'c'; 1024 * 1024]);
    let trailer_slice = trailer_backing.slice(256..384);
    let trailer = http::HeaderValue::from_maybe_shared(trailer_slice).unwrap();
    let trailer_ptr = trailer.as_bytes().as_ptr();
    let mut trailers = HeaderMap::new();
    trailers.append("x-sliced-trailer", trailer);
    assert_eq!(
        entry.publish_frame(&Frame::trailers(trailers)),
        ReplayPublish::Published
    );

    let state = entry
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let copied_head = state.head.as_ref().unwrap();
    let copied_values = copied_head
        .headers
        .get_all("x-sliced")
        .iter()
        .collect::<Vec<_>>();
    assert_eq!(copied_values.len(), 2);
    assert_eq!(copied_values[0].as_bytes(), &[b'a'; 128]);
    assert_eq!(copied_values[1].as_bytes(), &[b'b'; 128]);
    assert!(copied_values[0].is_sensitive());
    assert_ne!(copied_values[0].as_bytes().as_ptr(), first_ptr);
    assert_ne!(copied_values[1].as_bytes().as_ptr(), second_ptr);
    let ReplayFrame::Trailers(copied_trailers) = &state.frames[0] else {
        panic!("expected copied trailers");
    };
    let copied_trailer = &copied_trailers["x-sliced-trailer"];
    assert_eq!(copied_trailer.as_bytes(), &[b'c'; 128]);
    assert_ne!(copied_trailer.as_bytes().as_ptr(), trailer_ptr);
}

#[tokio::test]
async fn global_replay_budget_survives_clear_and_bypasses_without_buffering() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    assert_eq!(
        MAX_INFLIGHT_RETAINED_BYTES,
        MAX_INFLIGHT_ENTRIES * MAX_REPLAY_RETAINED_BYTES
    );
    let dedup = dedup_state(&[TEST_PATH]);
    let mut held_old_generations = Vec::new();
    {
        let mut inner = dedup.inner.lock().await;
        for index in 0..MAX_INFLIGHT_ENTRIES {
            let reservation = dedup
                .replay_budget
                .try_reserve()
                .expect("budget admits configured entry count");
            let entry = Arc::new(InflightResponse::with_reservation(reservation));
            inner.inflight.insert(
                DedupKey {
                    path: TEST_PATH.to_string(),
                    digest: [index as u8; 32],
                },
                entry.clone(),
            );
            held_old_generations.push(entry);
        }
    }
    assert!(dedup.replay_budget.try_reserve().is_none());
    DedupHandle {
        inner: dedup.inner.clone(),
    }
    .clear()
    .await;
    {
        let state = dedup
            .replay_budget
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(state.entries, MAX_INFLIGHT_ENTRIES);
        assert_eq!(state.reserved_bytes, MAX_INFLIGHT_RETAINED_BYTES);
    }

    let invocations = Arc::new(AtomicUsize::new(0));
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let invocations = invocations.clone();
                move || {
                    let invocation = invocations.fetch_add(1, Ordering::SeqCst) + 1;
                    async move { format!("direct-{invocation}") }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .body(Body::from(Bytes::from_static(b"budget-bypass")))
            .unwrap()
    };

    for expected in [b"direct-1".as_slice(), b"direct-2".as_slice()] {
        let body = router
            .clone()
            .oneshot(request())
            .await
            .unwrap()
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(&body[..], expected);
    }
    assert_eq!(invocations.load(Ordering::SeqCst), 2);
    let inner = dedup.inner.lock().await;
    assert!(inner.inflight.is_empty());
    assert!(inner.cache.is_empty());
    drop(inner);

    drop(held_old_generations);
    let state = dedup
        .replay_budget
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(state.entries, 0);
    assert_eq!(state.reserved_bytes, 0);
}

#[tokio::test]
async fn unreadable_request_bodies_fail_closed_without_invoking_handler() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let invocations = Arc::new(AtomicUsize::new(0));
    let dedup = dedup_state(&[TEST_PATH]);
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let invocations = invocations.clone();
                move || {
                    invocations.fetch_add(1, Ordering::SeqCst);
                    async { "must-not-run" }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));

    let oversized = router
        .clone()
        .oneshot(
            http::Request::builder()
                .method("POST")
                .uri(TEST_PATH)
                .body(Body::from(vec![0; MAX_REQUEST_BODY_BYTES + 1]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized.status(), http::StatusCode::OK);
    assert_eq!(oversized.headers()["grpc-status"], "8");
    assert_eq!(
        oversized.headers()[http::header::CONTENT_TYPE],
        "application/grpc"
    );
    assert!(oversized
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .is_empty());

    let failed_body = Body::from_stream(tokio_stream::iter([Err::<Bytes, _>(
        std::io::Error::other("synthetic request body failure"),
    )]));
    let failed = router
        .oneshot(
            http::Request::builder()
                .method("POST")
                .uri(TEST_PATH)
                .body(failed_body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(failed.status(), http::StatusCode::OK);
    assert_eq!(failed.headers()["grpc-status"], "13");
    assert!(failed
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .is_empty());
    assert_eq!(invocations.load(Ordering::SeqCst), 0);
    let inner = dedup.inner.lock().await;
    assert!(inner.inflight.is_empty());
    assert!(inner.cache.is_empty());
}

#[tokio::test]
async fn cached_replay_preserves_explicit_success_grpc_trailers() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let invocations = Arc::new(AtomicUsize::new(0));
    let dedup = dedup_state(&[TEST_PATH]);
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let invocations = invocations.clone();
                move || {
                    invocations.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let mut trailers = HeaderMap::new();
                        trailers.insert("grpc-status", http::HeaderValue::from_static("0"));
                        http::Response::new(Body::new(TraileredBody {
                            data: Some(Bytes::from_static(b"partial")),
                            trailers: Some(trailers),
                        }))
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .body(Body::from(Bytes::from_static(b"trailer-response")))
            .unwrap()
    };

    let first = router.clone().oneshot(request()).await.unwrap();
    let (first_data, first_trailers) = collect_data_and_trailers(first.into_body())
        .await
        .expect("live trailer response");
    assert_eq!(&first_data[..], b"partial");
    assert_eq!(first_trailers.unwrap()["grpc-status"], "0");
    let key = request_key(TEST_PATH, &HeaderMap::new(), b"trailer-response");
    for _ in 0..40 {
        if dedup.inner.lock().await.cache.contains_key(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }

    let replay = router.oneshot(request()).await.unwrap();
    let (replay_data, replay_trailers) = collect_data_and_trailers(replay.into_body())
        .await
        .expect("cached trailer response");
    assert_eq!(&replay_data[..], b"partial");
    assert_eq!(replay_trailers.unwrap()["grpc-status"], "0");
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn missing_status_is_shared_live_but_not_cached() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let first_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let invocations = Arc::new(AtomicUsize::new(0));
    let dedup = dedup_state(&[TEST_PATH]);
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let first_body = first_body.clone();
                let invocations = invocations.clone();
                move || {
                    let first_body = first_body.clone();
                    let invocation = invocations.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if invocation == 0 {
                            http::Response::new(
                                first_body
                                    .lock()
                                    .await
                                    .take()
                                    .expect("first status-less body is invoked once"),
                            )
                        } else {
                            http::Response::new(Body::from("retried-missing"))
                        }
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .body(Body::from(Bytes::from_static(b"missing-status")))
            .unwrap()
    };

    let leader = router.clone().oneshot(request()).await.unwrap();
    let follower = router.clone().oneshot(request()).await.unwrap();
    frame_tx
        .send(Ok(Bytes::from_static(b"status-less-live")))
        .unwrap();
    drop(frame_tx);

    for response in [leader, follower] {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("status-less live response remains shareable")
            .to_bytes();
        assert_eq!(&body[..], b"status-less-live");
    }
    assert_eq!(invocations.load(Ordering::SeqCst), 1);

    let key = request_key(TEST_PATH, &HeaderMap::new(), b"missing-status");
    for _ in 0..40 {
        if !dedup.inner.lock().await.inflight.contains_key(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(!dedup.inner.lock().await.cache.contains_key(&key));

    let retry = router
        .oneshot(request())
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .expect("status-less completion must invoke the handler again")
        .to_bytes();
    assert_eq!(&retry[..], b"retried-missing");
    assert_eq!(invocations.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn nonzero_trailer_status_is_shared_live_but_not_cached() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Frame<Bytes>, std::io::Error>>();
    let first_body = Arc::new(tokio::sync::Mutex::new(Some(Body::new(
        http_body_util::StreamBody::new(UnboundedReceiverStream::new(frame_rx)),
    ))));
    let (retry_tx, retry_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Frame<Bytes>, std::io::Error>>();
    let retry_body = Arc::new(tokio::sync::Mutex::new(Some(Body::new(
        http_body_util::StreamBody::new(UnboundedReceiverStream::new(retry_rx)),
    ))));
    let invocations = Arc::new(AtomicUsize::new(0));
    let dedup = dedup_state(&[TEST_PATH]);
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let first_body = first_body.clone();
                let retry_body = retry_body.clone();
                let invocations = invocations.clone();
                move || {
                    let first_body = first_body.clone();
                    let retry_body = retry_body.clone();
                    let invocation = invocations.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if invocation == 0 {
                            http::Response::new(
                                first_body
                                    .lock()
                                    .await
                                    .take()
                                    .expect("first failure body is invoked once"),
                            )
                        } else {
                            http::Response::new(
                                retry_body
                                    .lock()
                                    .await
                                    .take()
                                    .expect("fresh retry body is invoked once"),
                            )
                        }
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .body(Body::from(Bytes::from_static(b"nonzero-trailer")))
            .unwrap()
    };

    let leader = router.clone().oneshot(request()).await.unwrap();
    let follower = router.clone().oneshot(request()).await.unwrap();
    frame_tx
        .send(Ok(Frame::data(Bytes::from_static(b"failed-live"))))
        .unwrap();
    let mut trailers = HeaderMap::new();
    trailers.insert("grpc-status", http::HeaderValue::from_static("7"));
    frame_tx.send(Ok(Frame::trailers(trailers))).unwrap();

    let mut leader_body = leader.into_body();
    let mut follower_body = follower.into_body();
    for body in [&mut leader_body, &mut follower_body] {
        let data = tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .expect("live failure data must not wait for source EOF")
            .expect("live failure data frame")
            .expect("live failure data is readable");
        assert_eq!(
            data.data_ref().map(|data| &data[..]),
            Some(&b"failed-live"[..])
        );
        let trailers = tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .expect("live failure trailers must not wait for source EOF")
            .expect("live failure trailer frame")
            .expect("live failure trailers are readable");
        assert_eq!(trailers.trailers_ref().unwrap()["grpc-status"], "7");
    }
    assert_eq!(invocations.load(Ordering::SeqCst), 1);

    // The old source deliberately remains open after publishing its
    // failure trailers. Admission must already be closed, so this retry
    // starts a fresh generation without waiting for the old producer EOF.
    let retry = tokio::time::timeout(Duration::from_secs(1), router.oneshot(request()))
        .await
        .expect("trailer failure retry must not wait for old source EOF")
        .unwrap();
    assert_eq!(invocations.load(Ordering::SeqCst), 2);
    let key = request_key(TEST_PATH, &HeaderMap::new(), b"nonzero-trailer");
    let replacement = dedup
        .inner
        .lock()
        .await
        .inflight
        .get(&key)
        .cloned()
        .expect("fresh retry generation is active");

    drop(frame_tx);
    for body in [&mut leader_body, &mut follower_body] {
        assert!(tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .expect("old live response completes after its source EOF")
            .is_none());
    }
    for _ in 0..40 {
        tokio::task::yield_now().await;
    }
    assert!(dedup
        .inner
        .lock()
        .await
        .inflight
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, &replacement)));

    retry_tx
        .send(Ok(Frame::data(Bytes::from_static(b"retried"))))
        .unwrap();
    let mut retry_trailers = HeaderMap::new();
    retry_trailers.insert("grpc-status", http::HeaderValue::from_static("7"));
    retry_tx.send(Ok(Frame::trailers(retry_trailers))).unwrap();
    drop(retry_tx);
    let (data, trailers) = collect_data_and_trailers(retry.into_body())
        .await
        .expect("fresh retry response");
    assert_eq!(&data[..], b"retried");
    assert_eq!(trailers.unwrap()["grpc-status"], "7");
    for _ in 0..40 {
        if !dedup.inner.lock().await.inflight.contains_key(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(!dedup.inner.lock().await.cache.contains_key(&key));
}

#[tokio::test]
async fn nonzero_header_status_is_live_but_not_cached() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let first_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let (retry_tx, retry_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let retry_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(retry_rx),
    ))));
    let invocations = Arc::new(AtomicUsize::new(0));
    let dedup = dedup_state(&[TEST_PATH]);
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let first_body = first_body.clone();
                let retry_body = retry_body.clone();
                let invocations = invocations.clone();
                move || {
                    let first_body = first_body.clone();
                    let retry_body = retry_body.clone();
                    let invocation = invocations.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let body = if invocation == 0 {
                            first_body
                                .lock()
                                .await
                                .take()
                                .expect("first header failure body is invoked once")
                        } else {
                            retry_body
                                .lock()
                                .await
                                .take()
                                .expect("fresh header retry body is invoked once")
                        };
                        response_with_grpc_header(body, "13")
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .body(Body::from(Bytes::from_static(b"trailers-only-error")))
            .unwrap()
    };

    let first = router.clone().oneshot(request()).await.unwrap();
    assert_eq!(first.headers()["grpc-status"], "13");

    // The first producer is still open, but the nonzero response header is
    // already observable and must make a duplicate a fresh generation.
    let retry = tokio::time::timeout(Duration::from_secs(1), router.oneshot(request()))
        .await
        .expect("header failure retry must not wait for old source EOF")
        .unwrap();
    assert_eq!(retry.headers()["grpc-status"], "13");
    assert_eq!(invocations.load(Ordering::SeqCst), 2);
    let key = request_key(TEST_PATH, &HeaderMap::new(), b"trailers-only-error");
    let replacement = dedup
        .inner
        .lock()
        .await
        .inflight
        .get(&key)
        .cloned()
        .expect("fresh header retry generation is active");

    frame_tx
        .send(Ok(Bytes::from_static(b"old-live-body")))
        .unwrap();
    drop(frame_tx);
    let (old_data, old_trailers) = collect_data_and_trailers(first.into_body()).await.unwrap();
    assert_eq!(&old_data[..], b"old-live-body");
    assert!(old_trailers.is_none());
    for _ in 0..40 {
        tokio::task::yield_now().await;
    }
    assert!(dedup
        .inner
        .lock()
        .await
        .inflight
        .get(&key)
        .is_some_and(|current| Arc::ptr_eq(current, &replacement)));

    drop(retry_tx);
    let (data, retry_trailers) = collect_data_and_trailers(retry.into_body()).await.unwrap();
    assert!(data.is_empty());
    assert!(
        retry_trailers.is_none(),
        "a fresh header failure must not gain synthetic success trailers"
    );
    for _ in 0..40 {
        if !dedup.inner.lock().await.inflight.contains_key(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(!dedup.inner.lock().await.cache.contains_key(&key));
}

#[test]
fn completed_cache_enforces_global_retained_byte_limit_oldest_first() {
    let mut inner = Inner {
        inflight: HashMap::new(),
        cache: HashMap::new(),
        next_cache_sequence: 0,
    };
    let shared_body = Bytes::from(vec![0; MAX_REPLAY_RETAINED_BYTES]);
    let now = Instant::now();
    let key = |index: u8| DedupKey {
        path: TEST_PATH.to_string(),
        digest: [index; 32],
    };
    for index in 0..5 {
        insert_completed_response(
            &mut inner,
            key(index),
            CompletedResponse {
                status: http::StatusCode::OK,
                headers: HeaderMap::new(),
                body: shared_body.clone(),
                trailers: None,
                retained_bytes: MAX_REPLAY_RETAINED_BYTES,
            },
            Duration::from_secs(60),
            now,
        );
    }
    assert_eq!(inner.cache.len(), 4);
    assert!(cache_retained_bytes(&inner) <= MAX_CACHE_RETAINED_BYTES);
    assert!(!inner.cache.contains_key(&key(0)));
    assert!(inner.cache.contains_key(&key(4)));
}

#[tokio::test]
async fn clear_preserves_already_accepted_leader_and_follower_streams() {
    let (frame_tx, frame_rx) =
        tokio::sync::mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let handler_body = Arc::new(tokio::sync::Mutex::new(Some(Body::from_stream(
        UnboundedReceiverStream::new(frame_rx),
    ))));
    let dedup = dedup_state(&[TEST_PATH]);
    let router =
        axum::Router::new()
            .route(
                TEST_PATH,
                post({
                    let handler_body = handler_body.clone();
                    move || async move {
                        http::Response::new(handler_body.lock().await.take().unwrap())
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                dedup.clone(),
                dedup_middleware,
            ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .body(Body::from(Bytes::from_static(b"accepted-before-clear")))
            .unwrap()
    };

    let leader = router.clone().oneshot(request()).await.unwrap();
    let follower = router.oneshot(request()).await.unwrap();
    DedupHandle {
        inner: dedup.inner.clone(),
    }
    .clear()
    .await;
    frame_tx
        .send(Ok(Bytes::from_static(b"still-live")))
        .unwrap();
    drop(frame_tx);

    for response in [leader, follower] {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("accepted subscriber remains deterministic after clear")
            .to_bytes();
        assert_eq!(&body[..], b"still-live");
    }
    for _ in 0..40 {
        let inner = dedup.inner.lock().await;
        if inner.inflight.is_empty() && inner.cache.is_empty() {
            break;
        }
        drop(inner);
        tokio::task::yield_now().await;
    }
    let inner = dedup.inner.lock().await;
    assert!(inner.inflight.is_empty());
    assert!(inner.cache.is_empty());
}

#[tokio::test]
async fn clear_while_leader_handler_is_running_does_not_panic_or_cache_old_generation() {
    let dedup = dedup_state(&[TEST_PATH]);
    let handle = DedupHandle {
        inner: dedup.inner.clone(),
    };
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let entered_tx = Arc::new(std::sync::Mutex::new(Some(entered_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let entered_tx = entered_tx.clone();
                let release = release.clone();
                move || {
                    let entered_tx = entered_tx.clone();
                    let release = release.clone();
                    async move {
                        if let Some(entered_tx) = entered_tx
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .take()
                        {
                            let _ = entered_tx.send(());
                        }
                        release.notified().await;
                        http::Response::new(Body::from("completed-after-clear"))
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = http::Request::builder()
        .method("POST")
        .uri(TEST_PATH)
        .body(Body::from(Bytes::from_static(b"clear-race")))
        .unwrap();

    let request_task = tokio::spawn(router.oneshot(request));
    entered_rx.await.expect("handler entered");
    handle.clear().await;
    release.notify_one();

    let response = request_task
        .await
        .expect("clearing an active leader must not panic")
        .expect("leader response");
    let body = response
        .into_body()
        .collect()
        .await
        .expect("accepted leader remains live after clear")
        .to_bytes();
    assert_eq!(&body[..], b"completed-after-clear");
    for _ in 0..40 {
        let inner = dedup.inner.lock().await;
        if inner.inflight.is_empty() && inner.cache.is_empty() {
            break;
        }
        drop(inner);
        tokio::task::yield_now().await;
    }
    let inner = dedup.inner.lock().await;
    assert!(inner.inflight.is_empty());
    assert!(
        inner.cache.is_empty(),
        "the generation invalidated by clear must never repopulate cache"
    );
}

#[tokio::test]
async fn oversized_response_fails_live_without_cache_and_same_key_can_retry() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let invocations = Arc::new(AtomicUsize::new(0));
    let dedup = dedup_state(&[TEST_PATH]);
    let router = axum::Router::new()
        .route(
            TEST_PATH,
            post({
                let invocations = invocations.clone();
                move || {
                    let invocation = invocations.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let body = if invocation == 0 {
                            http::Response::new(Body::from(vec![
                                b'x';
                                MAX_REPLAY_RETAINED_BYTES + 1
                            ]))
                        } else {
                            http::Response::new(Body::from("retry-ok"))
                        };
                        response_with_grpc_header(body.into_body(), "0")
                    }
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            dedup.clone(),
            dedup_middleware,
        ));
    let request = || {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .header("x-ai-mic-run-id", "00000000-0000-4000-8000-000000000009")
            .body(Body::from(Bytes::from_static(b"bounded-response")))
            .unwrap()
    };

    assert!(
        router
            .clone()
            .oneshot(request())
            .await
            .unwrap()
            .into_body()
            .collect()
            .await
            .is_err(),
        "a response over the replay byte cap must fail closed"
    );
    for _ in 0..40 {
        if dedup.inner.lock().await.inflight.is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    {
        let inner = dedup.inner.lock().await;
        assert!(inner.inflight.is_empty());
        assert!(inner.cache.is_empty(), "oversized partial response cached");
    }

    let retry = router
        .clone()
        .oneshot(request())
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .expect("same key can retry after bounded failure")
        .to_bytes();
    assert_eq!(&retry[..], b"retry-ok");
    let replay = router
        .oneshot(request())
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .expect("successful retry is cacheable")
        .to_bytes();
    assert_eq!(&replay[..], b"retry-ok");
    assert_eq!(invocations.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn completed_cache_is_globally_bounded_and_expired_entries_are_eagerly_pruned() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let invocations = Arc::new(AtomicUsize::new(0));
    let mut dedup = GrpcDedup::new();
    dedup
        .routes
        .insert(TEST_PATH.to_string(), Duration::from_secs(10));
    let router =
        axum::Router::new()
            .route(
                TEST_PATH,
                post({
                    let invocations = invocations.clone();
                    move || {
                        let invocation = invocations.fetch_add(1, Ordering::SeqCst);
                        async move {
                            response_with_grpc_header(Body::from(invocation.to_string()), "0")
                        }
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                dedup.clone(),
                dedup_middleware,
            ));
    let request = |run_id: String| {
        http::Request::builder()
            .method("POST")
            .uri(TEST_PATH)
            .header("x-ai-mic-run-id", run_id)
            .body(Body::from(Bytes::from_static(b"unique-cache-key")))
            .unwrap()
    };

    for index in 0..=MAX_CACHE_ENTRIES {
        router
            .clone()
            .oneshot(request(format!("bounded-cache-{index:03}")))
            .await
            .unwrap()
            .into_body()
            .collect()
            .await
            .unwrap();
        for _ in 0..40 {
            if dedup.inner.lock().await.inflight.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            dedup.inner.lock().await.inflight.is_empty(),
            "each completion must be finalized before ordering the next insertion"
        );
    }
    let mut newest_headers = HeaderMap::new();
    newest_headers.insert(
        "x-ai-mic-run-id",
        http::HeaderValue::from_static("bounded-cache-064"),
    );
    let newest_key = request_key(TEST_PATH, &newest_headers, b"unique-cache-key");
    for _ in 0..80 {
        let inner = dedup.inner.lock().await;
        if inner.inflight.is_empty() && inner.cache.contains_key(&newest_key) {
            break;
        }
        drop(inner);
        tokio::task::yield_now().await;
    }
    {
        let inner = dedup.inner.lock().await;
        assert_eq!(inner.cache.len(), MAX_CACHE_ENTRIES);
        let mut oldest_headers = HeaderMap::new();
        oldest_headers.insert(
            "x-ai-mic-run-id",
            http::HeaderValue::from_static("bounded-cache-000"),
        );
        assert!(
            !inner.cache.contains_key(&request_key(
                TEST_PATH,
                &oldest_headers,
                b"unique-cache-key"
            )),
            "deterministic oldest entry must be evicted first"
        );
        assert!(inner.cache.contains_key(&newest_key));
    }

    let mut short_ttl_dedup = GrpcDedup::new();
    short_ttl_dedup
        .routes
        .insert(TEST_PATH.to_string(), Duration::from_millis(10));
    let short_ttl_router = axum::Router::new()
        .route(
            TEST_PATH,
            post(|| async { response_with_grpc_header(Body::from("expiring"), "0") }),
        )
        .layer(axum::middleware::from_fn_with_state(
            short_ttl_dedup.clone(),
            dedup_middleware,
        ));
    for run_id in ["expiry-a", "expiry-b"] {
        short_ttl_router
            .clone()
            .oneshot(request(run_id.to_string()))
            .await
            .unwrap()
            .into_body()
            .collect()
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(25)).await;
    short_ttl_router
        .oneshot(request("expiry-c".to_string()))
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap();
    for _ in 0..40 {
        if short_ttl_dedup.inner.lock().await.cache.len() <= 1 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(
        short_ttl_dedup.inner.lock().await.cache.len(),
        1,
        "one new request must globally prune unrelated expired keys"
    );
}
