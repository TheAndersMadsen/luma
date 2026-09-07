use super::*;
use crate::{
    ambiance::native_connection::{Challenge, OpenRequest, signing_message},
    store::MemoryStore,
    surface_registry::{self, Mutation},
};
use axum::{body::Body, http::Request};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use tower::ServiceExt;

const AUDIENCE: &str = "https://native.test";
const SESSION_SECRET: [u8; 32] = [23; 32];

fn test_rooms(
    store: SharedStore,
    config: Option<crate::browser_rooms::Config>,
) -> Arc<crate::browser_rooms::Rooms> {
    let runtime = Arc::new(crate::ambiance::runtime::AmbianceRuntime::new(
        store,
        Arc::new(crate::assistant::llm::MockChatModel::new(Vec::new())),
        None,
    ));
    Arc::new(crate::browser_rooms::Rooms::new(runtime, config))
}

fn signing_key(scalar: u8) -> SigningKey {
    let mut bytes = [0u8; 32];
    bytes[31] = scalar;
    SigningKey::from_bytes(&bytes).unwrap()
}

async fn fixture() -> (Router, SharedStore, Uuid, Uuid) {
    let store: SharedStore = Arc::new(MemoryStore::default());
    let enrollment = Uuid::new_v4();
    let surface = surface_registry::native_surface_id("U:owner", enrollment);
    store
        .mutate_surface(
            "U:owner",
            surface,
            crate::store::native_test_approval(enrollment, 0),
        )
        .await
        .unwrap();
    (
        with_audience(
            store.clone(),
            Some(AUDIENCE.into()),
            test_rooms(store.clone(), None),
        ),
        store,
        enrollment,
        surface,
    )
}

async fn response(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let bytes = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn call(app: &Router, operation: &str, body: Value) -> (StatusCode, Value) {
    response(
        app,
        Request::builder()
            .method("POST")
            .uri(format!("/runtime-api/v1/native/{operation}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
    )
    .await
}

fn signed_open(challenge: &Challenge, key: &SigningKey) -> OpenRequest {
    let mut request = OpenRequest {
        enrollment_id: challenge.enrollment_id,
        challenge_id: challenge.challenge_id,
        epoch: Uuid::new_v4(),
        expected_incarnation: challenge.current_incarnation,
        session_token_hash: surface_registry::hash(&SESSION_SECRET),
        signature: String::new(),
    };
    let signature: Signature = key.sign(&signing_message(challenge, &request).unwrap());
    request.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
    request
}

fn open_value(request: &OpenRequest) -> Value {
    json!({
        "enrollmentId": request.enrollment_id,
        "challengeId": request.challenge_id,
        "epoch": request.epoch,
        "expectedIncarnation": request.expected_incarnation,
        "sessionTokenHash": request.session_token_hash,
        "signature": request.signature
    })
}

fn verified_owner_bearer() -> String {
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
    let (private, public) = crate::web_auth::test_jwt_keypair();
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("native-owner-test".into());
    let token = jsonwebtoken::encode(
        &header,
        &json!({
            "sub":"owner", "iss":"https://owner.test", "aud":"native-owner-test",
            "exp":surface_registry::now_ms()/1000+300
        }),
        &EncodingKey::from_rsa_pem(private.as_bytes()).unwrap(),
    )
    .unwrap();
    let verifier = crate::web_auth::JwtVerifier::with_keys(
        crate::web_auth::OidcConfig {
            issuer: "https://owner.test".into(),
            audience: Some("native-owner-test".into()),
            jwks_uri: "unused".into(),
        },
        [(
            "native-owner-test".into(),
            DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(),
        )]
        .into(),
    );
    assert_eq!(
        verifier.verify(&token).unwrap().expose_for_authorization(),
        "U:owner"
    );
    format!("Bearer {token}")
}

#[tokio::test]
async fn native_runtime_http_configured_audience_ignores_headers_and_signed_retry_is_stable() {
    let (app, _, enrollment, surface) = fixture().await;
    let request = Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/native/challenge")
        .header("content-type", "application/json")
        .header("host", "untrusted.test")
        .header("x-forwarded-host", "other.test")
        .header("forwarded", "host=other.test;proto=http")
        .header("authorization", verified_owner_bearer())
        .body(Body::from(json!({"enrollmentId":enrollment}).to_string()))
        .unwrap();
    let (status, issued) = response(&app, request).await;
    assert_eq!(status, StatusCode::OK);
    let challenge: Challenge = serde_json::from_value(issued["challenge"].clone()).unwrap();
    assert_eq!(challenge.audience, AUDIENCE);
    assert_eq!(challenge.surface_id, surface);
    assert_eq!(URL_SAFE_NO_PAD.decode(&challenge.nonce).unwrap().len(), 32);
    assert!(!challenge.challenge_id.is_nil());
    assert_eq!(
        call(&app, "challenge", json!({"enrollmentId":enrollment})).await,
        (StatusCode::OK, issued)
    );
    let request = signed_open(&challenge, &signing_key(1));
    let (status, opened) = call(&app, "open", open_value(&request)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(opened["duplicate"], false);
    assert_eq!(opened["connection"]["surfaceId"], surface.to_string());
    assert_eq!(opened["connection"]["approvalRevision"], 1);
    assert!(opened["connection"].get("token").is_none());
    assert!(opened["connection"].get("sessionTokenHash").is_none());
    let (status, retried) = call(&app, "open", open_value(&request)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retried["duplicate"], true);
    assert_eq!(retried["connection"], opened["connection"]);
}

#[tokio::test]
async fn native_runtime_http_failed_signatures_and_owner_bearer_do_not_consume_challenge() {
    let (app, _, enrollment, _) = fixture().await;
    let (_, issued) = call(&app, "challenge", json!({"enrollmentId":enrollment})).await;
    let challenge: Challenge = serde_json::from_value(issued["challenge"].clone()).unwrap();
    let valid = signed_open(&challenge, &signing_key(1));
    let wrong_key = signed_open(&challenge, &signing_key(2));
    let mut malformed = open_value(&valid);
    malformed["signature"] = "not-a-signature".into();
    let mut changed_token = open_value(&valid);
    changed_token["sessionTokenHash"] = surface_registry::hash(b"changed-native-token").into();
    for rejected in [open_value(&wrong_key), malformed, changed_token] {
        assert_eq!(
            call(&app, "open", rejected).await,
            (StatusCode::NOT_FOUND, json!({"error":"not_found"}))
        );
    }
    let mut unsigned = open_value(&valid);
    unsigned["signature"] = "".into();
    let owner_only = Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/native/open")
        .header("content-type", "application/json")
        .header("authorization", verified_owner_bearer())
        .header(
            crate::config::EDGE_PRINCIPAL_HEADER,
            "Subject=CN=V:01:D:aa:U:owner",
        )
        .body(Body::from(unsigned.to_string()))
        .unwrap();
    assert_eq!(response(&app, owner_only).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        call(&app, "open", open_value(&valid)).await.0,
        StatusCode::OK
    );
    let mut different = valid.clone();
    different.session_token_hash = surface_registry::hash(b"another-native-token");
    let signature: Signature =
        signing_key(1).sign(&signing_message(&challenge, &different).unwrap());
    different.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
    assert_eq!(
        call(&app, "open", open_value(&different)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "open", open_value(&valid)).await.1["duplicate"],
        true
    );
}

#[tokio::test]
async fn native_runtime_http_unknown_revoked_and_missing_configuration_fail_closed() {
    let (app, store, enrollment, surface) = fixture().await;
    for audience in [
        None,
        Some("http://native.test"),
        Some("https://native.test/path"),
        Some("not-an-origin"),
    ] {
        let unavailable = with_audience(
            store.clone(),
            audience.map(str::to_owned),
            test_rooms(store.clone(), None),
        );
        for operation in ["challenge", "open"] {
            assert_eq!(
                call(&unavailable, operation, json!({"enrollmentId":enrollment})).await,
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error":"unavailable"})
                )
            );
        }
    }
    let (_, issued) = call(&app, "challenge", json!({"enrollmentId":enrollment})).await;
    let challenge: Challenge = serde_json::from_value(issued["challenge"].clone()).unwrap();
    let valid = signed_open(&challenge, &signing_key(1));
    let mut unknown = open_value(&valid);
    unknown["enrollmentId"] = json!(Uuid::new_v4());
    assert_eq!(call(&app, "open", unknown).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        call(&app, "challenge", json!({"enrollmentId":Uuid::new_v4()}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    store
        .mutate_surface(
            "U:owner",
            surface,
            Mutation::RevokeNative {
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        call(&app, "challenge", json!({"enrollmentId":enrollment})).await,
        (StatusCode::NOT_FOUND, json!({"error":"not_found"}))
    );
    assert_eq!(
        call(&app, "open", open_value(&valid)).await,
        (StatusCode::NOT_FOUND, json!({"error":"not_found"}))
    );
    let unavailable_store: SharedStore =
        Arc::new(crate::store_postgres::PostgresStore::unreachable());
    let unavailable = with_audience(
        unavailable_store.clone(),
        Some(AUDIENCE.into()),
        test_rooms(unavailable_store, None),
    );
    assert_eq!(
        call(
            &unavailable,
            "challenge",
            json!({"enrollmentId":enrollment})
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn native_runtime_http_body_schema_and_content_type_are_bounded() {
    let (app, _, enrollment, _) = fixture().await;
    for body in [
        json!({}),
        json!({"enrollmentId":Uuid::nil()}),
        json!({"enrollmentId":enrollment,"principal":"U:owner"}),
    ] {
        assert_eq!(
            call(&app, "challenge", body).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for (size, expected) in [
        (MAX_BODY_BYTES, StatusCode::OK),
        (MAX_BODY_BYTES + 1, StatusCode::BAD_REQUEST),
    ] {
        let mut encoded = json!({"enrollmentId":enrollment}).to_string();
        encoded.push_str(&" ".repeat(size - encoded.len()));
        let request = Request::builder()
            .method("POST")
            .uri("/runtime-api/v1/native/challenge")
            .header("content-type", "application/json")
            .body(Body::from(encoded))
            .unwrap();
        assert_eq!(response(&app, request).await.0, expected);
    }
    for content_type in [None, Some("text/plain"), Some("application/octet-stream")] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/runtime-api/v1/native/challenge");
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        assert_eq!(
            response(
                &app,
                request
                    .body(Body::from(json!({"enrollmentId":enrollment}).to_string()))
                    .unwrap()
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let repeated_type = Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/native/challenge")
        .header("content-type", "application/json")
        .header("content-type", "application/json")
        .body(Body::from(json!({"enrollmentId":enrollment}).to_string()))
        .unwrap();
    assert_eq!(
        response(&app, repeated_type).await.0,
        StatusCode::BAD_REQUEST
    );
    let malformed = Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/native/challenge")
        .header("content-type", "application/json")
        .body(Body::from("{"))
        .unwrap();
    assert_eq!(response(&app, malformed).await.0, StatusCode::BAD_REQUEST);
    let (_, issued) = call(&app, "challenge", json!({"enrollmentId":enrollment})).await;
    let challenge: Challenge = serde_json::from_value(issued["challenge"].clone()).unwrap();
    let valid = signed_open(&challenge, &signing_key(1));
    for field in [
        "principal",
        "audience",
        "publicKey",
        "surfaceId",
        "manifest",
    ] {
        let mut extra = open_value(&valid);
        extra[field] = "untrusted".into();
        assert_eq!(call(&app, "open", extra).await.0, StatusCode::BAD_REQUEST);
    }
    for field in [
        "enrollmentId",
        "challengeId",
        "epoch",
        "sessionTokenHash",
        "signature",
    ] {
        let mut missing = open_value(&valid);
        missing.as_object_mut().unwrap().remove(field);
        assert_eq!(call(&app, "open", missing).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        call(&app, "open", open_value(&valid)).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn native_runtime_http_inflight_limit_bounds_slow_bodies_and_recovers() {
    let (app, _, enrollment, _) = fixture().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let mut pending = Vec::new();
    for _ in 0..MAX_INFLIGHT {
        let notify = started.clone();
        let body = Body::from_stream(futures_util::stream::poll_fn(move |_| {
            notify.notify_one();
            std::task::Poll::Pending::<Option<Result<axum::body::Bytes, std::io::Error>>>
        }));
        let request = Request::builder()
            .method("POST")
            .uri("/runtime-api/v1/native/challenge")
            .header("content-type", "application/json")
            .body(body)
            .unwrap();
        let app = app.clone();
        pending.push(tokio::spawn(
            async move { app.oneshot(request).await.unwrap() },
        ));
        tokio::time::timeout(std::time::Duration::from_secs(1), started.notified())
            .await
            .unwrap();
    }
    assert_eq!(
        call(&app, "challenge", json!({"enrollmentId":enrollment})).await,
        (StatusCode::TOO_MANY_REQUESTS, json!({"error":"busy"}))
    );
    assert_eq!(
        call(&app, "open", json!({})).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        response(&app, room_request(&native_bearer(), &json!({})))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    for task in pending {
        task.abort();
        let _ = task.await;
    }
    assert_eq!(
        call(&app, "challenge", json!({"enrollmentId":enrollment}))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn native_runtime_http_slow_body_expires_and_rest_input_channels_are_absent() {
    let (app, _, enrollment, _) = fixture().await;
    let pending = Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >());
    let request = Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/native/challenge")
        .header("content-type", "application/json")
        .body(pending)
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(6), response(&app, request))
        .await
        .unwrap();
    assert_eq!(result.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        call(&app, "challenge", json!({"enrollmentId":enrollment}))
            .await
            .0,
        StatusCode::OK
    );
    for operation in ["text", "control", "state", "close"] {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/runtime-api/v1/native/{operation}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
    }
}

async fn open_connection(app: &Router, enrollment: Uuid) -> Value {
    let (status, issued) = call(app, "challenge", json!({"enrollmentId":enrollment})).await;
    assert_eq!(status, StatusCode::OK);
    let challenge: Challenge = serde_json::from_value(issued["challenge"].clone()).unwrap();
    let request = signed_open(&challenge, &signing_key(1));
    let (status, opened) = call(app, "open", open_value(&request)).await;
    assert_eq!(status, StatusCode::OK);
    json!({
        "enrollmentId": enrollment,
        "approvalRevision": opened["connection"]["approvalRevision"],
        "incarnation": opened["connection"]["incarnation"],
        "epoch": opened["connection"]["epoch"],
    })
}

fn room_request(bearer: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/native/room")
        .header("content-type", "application/json")
        .header("authorization", bearer)
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn native_bearer() -> String {
    format!("Bearer {}", URL_SAFE_NO_PAD.encode(SESSION_SECRET))
}

#[tokio::test]
async fn native_runtime_http_room_authenticates_raw_secret_not_digest_or_owner() {
    let (app, store, enrollment, surface) = fixture().await;
    let body = open_connection(&app, enrollment).await;
    // Valid raw bytes reach the deliberately unconfigured room service.
    assert_eq!(
        response(&app, room_request(&native_bearer(), &body)).await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"unavailable"})
        )
    );
    let digest = surface_registry::hash(&SESSION_SECRET);
    let digest_bytes: Vec<u8> = (0..digest.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&digest[at..at + 2], 16).unwrap())
        .collect();
    for bearer in [
        verified_owner_bearer(),
        format!("Bearer {digest}"),
        format!("Bearer {}", URL_SAFE_NO_PAD.encode(&digest_bytes)),
        format!("Bearer {}", URL_SAFE_NO_PAD.encode([24u8; 32])),
        format!("{}=", native_bearer()),
        URL_SAFE_NO_PAD.encode(SESSION_SECRET),
    ] {
        assert_eq!(
            response(&app, room_request(&bearer, &body)).await.0,
            StatusCode::NOT_FOUND
        );
    }
    let mut duplicate = room_request(&native_bearer(), &body);
    duplicate
        .headers_mut()
        .append("authorization", native_bearer().parse().unwrap());
    assert_eq!(response(&app, duplicate).await.0, StatusCode::NOT_FOUND);
    let mut missing = room_request(&native_bearer(), &body);
    missing.headers_mut().remove("authorization");
    assert_eq!(response(&app, missing).await.0, StatusCode::NOT_FOUND);
    for (field, value, expected) in [
        ("enrollmentId", json!(Uuid::new_v4()), StatusCode::NOT_FOUND),
        ("incarnation", json!(Uuid::new_v4()), StatusCode::CONFLICT),
        ("epoch", json!(Uuid::new_v4()), StatusCode::NOT_FOUND),
        ("approvalRevision", json!(2), StatusCode::NOT_FOUND),
    ] {
        let mut changed = body.clone();
        changed[field] = value;
        assert_eq!(
            response(&app, room_request(&native_bearer(), &changed))
                .await
                .0,
            expected
        );
    }
    store
        .mutate_surface(
            "U:owner",
            surface,
            Mutation::RevokeNative {
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        response(&app, room_request(&native_bearer(), &body))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn native_runtime_http_room_schema_bounds_and_configuration_precede_join() {
    let (app, store, enrollment, _) = fixture().await;
    let body = open_connection(&app, enrollment).await;
    for (field, value) in [
        ("enrollmentId", json!(Uuid::nil())),
        ("incarnation", json!(Uuid::nil())),
        ("epoch", json!(Uuid::nil())),
        ("approvalRevision", json!(0)),
        (
            "approvalRevision",
            json!(surface_registry::MAX_NATIVE_REVISION + 1),
        ),
        ("surfaceId", json!(Uuid::new_v4())),
        ("principal", json!("U:owner")),
        (
            "sessionTokenHash",
            json!(surface_registry::hash(&SESSION_SECRET)),
        ),
    ] {
        let mut changed = body.clone();
        changed[field] = value;
        assert_eq!(
            response(&app, room_request(&native_bearer(), &changed))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    for field in ["enrollmentId", "approvalRevision", "incarnation", "epoch"] {
        let mut missing = body.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert_eq!(
            response(&app, room_request(&native_bearer(), &missing))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut encoded = body.to_string();
    encoded.push_str(&" ".repeat(MAX_BODY_BYTES + 1 - encoded.len()));
    let mut oversized = room_request(&native_bearer(), &body);
    *oversized.body_mut() = Body::from(encoded);
    assert_eq!(response(&app, oversized).await.0, StatusCode::BAD_REQUEST);
    let unavailable = with_audience(store.clone(), None, test_rooms(store, None));
    assert_eq!(
        response(&unavailable, room_request(&native_bearer(), &body))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_BROWSER_TEST_INPUT with an isolated localhost SFU"]
async fn native_runtime_http_live_room_uses_current_connection_without_renewal() {
    let input: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("COSMOS_RTC_BROWSER_TEST_INPUT").unwrap()).unwrap(),
    )
    .unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"));
    let (app, store, enrollment, surface) = fixture().await;
    let body = open_connection(&app, enrollment).await;
    let rooms = test_rooms(
        store.clone(),
        Some(
            crate::browser_rooms::Config::new(
                url.into(),
                url.into(),
                input["key"].as_str().unwrap().into(),
                input["secret"].as_str().unwrap().into(),
            )
            .unwrap(),
        ),
    );
    let app = with_audience(store.clone(), Some(AUDIENCE.into()), rooms);
    let proof = NativeProof {
        surface_id: surface,
        incarnation: serde_json::from_value(body["incarnation"].clone()).unwrap(),
        token_hash: surface_registry::hash(&SESSION_SECRET),
    };
    let RuntimeResult::NativeCurrent(before) = store
        .runtime(
            "U:owner",
            RuntimeOperation::CheckNative {
                connection: proof.clone(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("native connection must be current")
    };
    let (status, opened) = response(&app, room_request(&native_bearer(), &body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(opened["epoch"], body["epoch"]);
    assert_eq!(opened["version"], 1);
    assert_eq!(opened["runtimeParticipant"], "runtime");
    assert!(Uuid::parse_str(opened["participant"].as_str().unwrap()).is_ok());
    assert!(
        !opened
            .to_string()
            .contains(&URL_SAFE_NO_PAD.encode(SESSION_SECRET))
    );
    assert!(!opened.to_string().contains(&proof.token_hash));
    let (status, repeated) = response(&app, room_request(&native_bearer(), &body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(repeated["participant"], opened["participant"]);
    assert_eq!(repeated["runtimeEpoch"], opened["runtimeEpoch"]);
    let RuntimeResult::NativeCurrent(after) = store
        .runtime(
            "U:owner",
            RuntimeOperation::CheckNative { connection: proof },
        )
        .await
        .unwrap()
    else {
        panic!("native connection must remain current")
    };
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    store
        .mutate_surface(
            "U:owner",
            surface,
            Mutation::RevokeNative {
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        response(&app, room_request(&native_bearer(), &body))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

fn voice_request(bearer: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/runtime-api/v1/native/voice")
        .header("content-type", "application/json")
        .header("authorization", bearer)
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// The route only ever receives audio a person's own press produced: there is
/// no frame, command or field anywhere in this contract that asks a client to
/// listen. What it does own is the order of the checks: the owner's permission
/// for this exact installation comes first, and it is its own refusal so a
/// client can say what has to change instead of retrying.
#[tokio::test]
async fn native_runtime_http_voice_refuses_a_press_the_owner_never_allowed() {
    let (app, store, enrollment, surface) = fixture().await;
    let connection = open_connection(&app, enrollment).await;
    let audio = URL_SAFE_NO_PAD.encode(vec![0u8; 32_000]);
    let body = |audio: &str, capture_ms: i64, sample_rate: u32| {
        json!({
            "enrollmentId": connection["enrollmentId"],
            "approvalRevision": connection["approvalRevision"],
            "incarnation": connection["incarnation"],
            "epoch": connection["epoch"],
            "stamp": {
                "epoch": connection["epoch"],
                "sequence": 2,
                "instanceId": Uuid::new_v4(),
            },
            "capture": {
                "attestation": ["push_to_talk", "capture_indicator"],
                "captureMs": capture_ms,
            },
            "audio": {
                "encoding": "pcm_s16le",
                "sampleRate": sample_rate,
                "channels": 1,
                "data": audio,
            },
            "language": "en",
        })
    };
    // No permission: the owner's own answer, before any audio is read.
    assert_eq!(
        response(
            &app,
            voice_request(&native_bearer(), &body(&audio, 1_100, 16_000))
        )
        .await,
        (
            StatusCode::FORBIDDEN,
            json!({"error":"voice_not_permitted"})
        )
    );
    store
        .runtime(
            "U:owner",
            crate::ambiance::RuntimeOperation::SetNativeVoicePolicy {
                surface_id: surface,
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(crate::ambiance::native_voice::Policy {
                    source_floor: crate::ambiance::PrivacyClass::SharedRoom,
                }),
            },
        )
        .await
        .unwrap();
    // Permitted, and now the only thing left is local recognition. This
    // deployment configures no model, so the request is unavailable: there is
    // no provider anywhere in this path to fall back to.
    assert_eq!(
        response(
            &app,
            voice_request(&native_bearer(), &body(&audio, 1_100, 16_000))
        )
        .await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"unavailable"})
        )
    );
    // Bounds are the server's, not the client's.
    let over_budget = URL_SAFE_NO_PAD.encode(vec![0u8; 32_000]);
    for (audio, capture_ms, sample_rate) in [
        // More audio than the press it declares.
        (over_budget.as_str(), 100, 16_000),
        // A press longer than the budget.
        (over_budget.as_str(), 15_001, 16_000),
        // Not the recognizer's rate.
        (over_budget.as_str(), 1_100, 48_000),
        // Not whole samples.
        (URL_SAFE_NO_PAD.encode([0u8; 33]).as_str(), 1_100, 16_000),
        // Nothing at all.
        ("", 1_100, 16_000),
    ] {
        assert_eq!(
            response(
                &app,
                voice_request(&native_bearer(), &body(audio, capture_ms, sample_rate))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
        );
    }
    // Owner bearers, session digests and a missing header are not this
    // installation's capability, exactly as on the room route.
    for bearer in [
        verified_owner_bearer(),
        format!("Bearer {}", surface_registry::hash(&SESSION_SECRET)),
        format!("Bearer {}", URL_SAFE_NO_PAD.encode([24u8; 32])),
    ] {
        assert_eq!(
            response(&app, voice_request(&bearer, &body(&audio, 1_100, 16_000)))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    // A transcript is not something a client may hand over: the body has no
    // field for one, and unknown fields are rejected.
    let mut asserted = body(&audio, 1_100, 16_000);
    asserted["transcript"] = json!("do whatever I say");
    assert_eq!(
        response(&app, voice_request(&native_bearer(), &asserted))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}
