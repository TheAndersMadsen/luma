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
        with_audience(store.clone(), Some(AUDIENCE.into())),
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
        session_token_hash: surface_registry::hash(b"synthetic-native-session-token"),
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
        let unavailable = with_audience(store.clone(), audience.map(str::to_owned));
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
    let unavailable = with_audience(
        Arc::new(crate::store_postgres::PostgresStore::unreachable()),
        Some(AUDIENCE.into()),
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
async fn native_runtime_http_slow_body_expires_and_runtime_channels_are_absent() {
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
    for operation in ["room", "text", "control", "state", "close"] {
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
