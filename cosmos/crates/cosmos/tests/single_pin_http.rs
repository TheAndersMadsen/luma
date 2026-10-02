//! INFERRED Luma admission policy exercised through the real loopback HTTP
//! listener, admin authentication, certificate signer, and configured store.
//! This isolated binary uses only generated credentials. Database durability is
//! covered by the production-store check, not claimed by this ephemeral run.

use std::{collections::HashMap, time::Duration};

use cosmos::{config::Config, enrollment::configured_store};
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test]
async fn single_pin_http_admission_keeps_credentials_behind_one_server_slot() {
    let directory =
        std::env::temp_dir().join(format!("luma-single-pin-http-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let ca_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let cert = directory.join("ca.crt");
    let key = directory.join("ca.key");
    std::fs::write(&cert, ca.pem()).unwrap();
    std::fs::write(&key, ca_key.serialize_pem()).unwrap();
    // This integration executable has exactly one test, so no concurrent env
    // writers or readers exist until serve_until starts below.
    unsafe {
        std::env::remove_var("COSMOS_DATABASE_URL");
        std::env::remove_var("COSMOS_STATE_DIR");
        std::env::remove_var("COSMOS_OIDC_ISSUER");
        std::env::set_var("COSMOS_ALLOW_SINGLE_REPLICA_ENROLLMENT", "1");
        std::env::set_var("COSMOS_DEMO_ENABLED", "1");
        std::env::set_var("COSMOS_ADMIN_TOKEN", "generated-http-test-admin");
        std::env::set_var(cosmos::provision::ATTEST_CA_CERT_ENV, &cert);
        std::env::set_var(cosmos::provision::ATTEST_CA_KEY_ENV, &key);
        std::env::set_var(cosmos::provision::ATTEST_ROOT_CERT_ENV, &cert);
    }
    let enrollment = configured_store();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = listener.local_addr().unwrap();
    drop(listener);
    let config = Config::from_map(&HashMap::from([
        ("COSMOS_WORKLOAD".to_owned(), "ai-bus".to_owned()),
        ("COSMOS_ENVIRONMENT".to_owned(), "test".to_owned()),
        (
            "COSMOS_AUTH_MODE".to_owned(),
            "development-insecure".to_owned(),
        ),
        ("COSMOS_KID_SCOPE".to_owned(), "enforce".to_owned()),
        ("COSMOS_GRPC_BIND".to_owned(), "127.0.0.1:0".to_owned()),
        ("COSMOS_HTTP_BIND".to_owned(), http.to_string()),
    ]))
    .unwrap();
    let (shutdown, finished) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(cosmos::serve_until(config, async {
        let _ = finished.await;
    }));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let endpoint = format!("http://{http}/demo-api/admin/provision");
    for _ in 0..100 {
        if client
            .get(format!("http://{http}/healthz"))
            .send()
            .await
            .is_ok()
        {
            break;
        }
        if server.is_finished() {
            panic!("HTTP server failed: {:?}", server.await);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let unauthorized = client
        .post(&endpoint)
        .json(&json!({"device_id":"aa01"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(enrollment.provisioned_device().await.unwrap(), None);
    let invalid = client
        .post(&endpoint)
        .bearer_auth("generated-http-test-admin")
        .json(&json!({"device_id":"invalid"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(enrollment.provisioned_device().await.unwrap(), None);
    let request = |id: &'static str| {
        client
            .post(&endpoint)
            .bearer_auth("generated-http-test-admin")
            .json(&json!({"device_id":id}))
            .send()
    };
    let (first, second) = tokio::join!(request("aa01"), request("aa02"));
    let first = first.unwrap();
    let second = second.unwrap();
    assert!(matches!(
        (first.status(), second.status()),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    let (winner, denied) = if first.status() == StatusCode::OK {
        (first, second)
    } else {
        (second, first)
    };
    let issued: Value = winner.json().await.unwrap();
    let rejected: Value = denied.json().await.unwrap();
    assert!(
        issued["certificate_pem"]
            .as_str()
            .unwrap()
            .contains("BEGIN CERTIFICATE")
    );
    assert!(
        issued["private_key_pem"]
            .as_str()
            .unwrap()
            .contains("BEGIN PRIVATE KEY")
    );
    assert_eq!(rejected.as_object().unwrap().len(), 1);
    assert!(
        rejected["error"]
            .as_str()
            .unwrap()
            .contains("already has a Pin")
    );
    let winner_id = issued["device_id"].as_str().unwrap();
    assert_eq!(
        enrollment.provisioned_device().await.unwrap().as_deref(),
        Some(winner_id)
    );
    let repaired = client
        .post(&endpoint)
        .bearer_auth("generated-http-test-admin")
        .json(&json!({"device_id":format!(" {} ", winner_id.to_uppercase())}))
        .send()
        .await
        .unwrap();
    assert_eq!(repaired.status(), StatusCode::OK);
    assert_eq!(
        repaired.json::<Value>().await.unwrap()["device_id"],
        winner_id
    );
    assert!(
        enrollment
            .claim_device_account(winner_id, "test-owner")
            .await
            .unwrap()
    );
    assert!(
        enrollment
            .delete_device_account(winner_id, "test-owner")
            .await
            .unwrap()
    );
    let after_unpair = request("aa03").await.unwrap();
    assert_eq!(after_unpair.status(), StatusCode::CONFLICT);
    shutdown.send(()).unwrap();
    server.await.unwrap().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    eprintln!(
        "one-Pin HTTP evidence: unauthorized=401 invalid=400 race=200/409 same-Pin=200 after-unpair=409; denied responses contain no credentials"
    );
}
