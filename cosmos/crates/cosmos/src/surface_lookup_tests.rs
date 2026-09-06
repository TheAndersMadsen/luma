use super::*;
use crate::{
    enrollment::EnrollmentStore,
    integrations::{MapsConfig, SearchConfig},
    store::{MemoryStore, Store},
};
use serde_json::Value;

fn lookup_config() -> SearchConfig {
    SearchConfig {
        searxng_base_url: Some("https://lookup.test".into()),
        serpapi_key: Some("fixture-only-serpapi-key".into()),
        ..Default::default()
    }
}

fn places_lookup_config() -> (MapsConfig, String) {
    (
        MapsConfig {
            google_maps_key: Some("fixture-only-google-maps-key".into()),
        },
        "https://maps.googleapis.com/maps/api/place/textsearch/json".into(),
    )
}

fn lookup_app(
    store: Arc<MemoryStore>,
    pairing: Option<crate::enrollment::SharedEnrollmentStore>,
    config: SearchConfig,
) -> Router {
    routes(ApiState {
        store,
        verifier: Some(verifier()),
        pairing,
        lookup_config: Some(config),
        places_lookup_config: Some(places_lookup_config()),
    })
}

async fn lookup_browser(app: &Router, owner: &str) -> (Uuid, Value) {
    let surface = Uuid::new_v4();
    let (status, approved) = call(
        app,
        "POST",
        "/surface-api/v1/surfaces",
        Some(owner),
        None,
        json!({"surfaceId": surface, "approval": surface_registry::BROWSER_APPROVAL}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(approved["surface"]["revision"], 1);
    (surface, approved)
}

fn lookup_path(surface: Uuid) -> String {
    service_lookup_path(surface, LookupService::Web)
}

fn service_lookup_path(surface: Uuid, service: LookupService) -> String {
    let name = match service {
        LookupService::Web => "web",
        LookupService::Places => "places",
    };
    format!("/surface-api/v1/surfaces/{surface}/{name}-lookup")
}

fn selected_provider(state: &Value, name: &str) -> Value {
    state["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider"] == name)
        .unwrap()
        .clone()
}

fn selected_service_provider(state: &Value, service: LookupService) -> Value {
    selected_provider(
        state,
        match service {
            LookupService::Web => "searxng",
            LookupService::Places => "google_places",
        },
    )
}

fn lookup_grant(provider: &Value, reviewed: &Value, expected_revision: u64) -> Value {
    service_lookup_grant(LookupService::Web, provider, reviewed, expected_revision)
}

fn service_lookup_grant(
    service: LookupService,
    provider: &Value,
    reviewed: &Value,
    expected_revision: u64,
) -> Value {
    let binding = &reviewed["binding"];
    assert!(
        binding["approvalRevision"]
            .as_u64()
            .is_some_and(|revision| revision > 0)
    );
    assert!(binding.get("incarnation").is_some());
    json!({
        "approval": crate::ambiance::lookup::owner_approval(service),
        "approvalRevision": binding["approvalRevision"],
        "approvalIncarnation": binding["incarnation"],
        "expectedRevision": expected_revision,
        "policy": {"provider": provider, "maximumClass": "shared_room"}
    })
}

async fn lookup_raw(
    app: &Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: String,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn ambiance_lookup_http_requires_verified_owner_and_configured_keys_grant_nothing() {
    let store = Arc::new(MemoryStore::default());
    let app = lookup_app(store.clone(), None, lookup_config());
    let owner = bearer("owner");
    let other = bearer("other");
    let (surface, browser) = lookup_browser(&app, &owner).await;
    let path = lookup_path(surface);
    let (status, initial) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(initial["approval"].is_null());
    assert_eq!(
        initial["binding"],
        json!({"approvalRevision":1,"incarnation":browser["connection"]["incarnation"]})
    );
    assert_eq!(initial["providers"].as_array().unwrap().len(), 2);
    assert!(!initial.to_string().contains("fixture-only-serpapi-key"));
    let grant = lookup_grant(&selected_provider(&initial, "serp_api"), &initial, 0);
    let connection_token = browser["connection"]["token"].as_str().unwrap();
    for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
        for method in ["GET", "POST"] {
            assert_eq!(
                call(
                    &app,
                    method,
                    &path,
                    authorization,
                    Some(connection_token),
                    grant.clone(),
                )
                .await,
                (StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}))
            );
        }
    }
    for method in ["GET", "POST"] {
        assert_eq!(
            call(&app, method, &path, Some(&other), None, grant.clone()).await,
            (StatusCode::NOT_FOUND, json!({"error": "not_found"}))
        );
        assert_eq!(
            lookup_raw(
                &app,
                method,
                &path,
                &[("authorization", &owner), ("authorization", &owner)],
                grant.to_string(),
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            lookup_raw(
                &app,
                method,
                &path,
                &[
                    ("x-forwarded-client-cert", "verified-owner"),
                    ("x-cosmos-surface-token", connection_token)
                ],
                grant.to_string(),
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let no_verifier = routes(ApiState {
        store,
        verifier: None,
        pairing: None,
        lookup_config: Some(lookup_config()),
        places_lookup_config: Some(places_lookup_config()),
    });
    assert_eq!(
        call(&no_verifier, "GET", &path, Some(&owner), None, json!(null)).await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "unavailable"})
        )
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &lookup_path(Uuid::new_v4()),
            Some(&owner),
            None,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/surface-api/v1/surfaces/not-a-uuid/web-lookup",
            Some(&owner),
            None,
            json!(null)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, "GET", &path, Some(&owner), None, json!(null))
            .await
            .1,
        initial
    );
}

#[tokio::test]
async fn ambiance_lookup_http_service_tokens_providers_and_revisions_are_isolated() {
    let store = Arc::new(MemoryStore::default());
    let app = lookup_app(store.clone(), None, lookup_config());
    let owner = bearer("owner");
    let other = bearer("other");
    let (surface, _) = lookup_browser(&app, &owner).await;
    let web_path = service_lookup_path(surface, LookupService::Web);
    let places_path = service_lookup_path(surface, LookupService::Places);
    let (_, web) = call(&app, "GET", &web_path, Some(&owner), None, json!(null)).await;
    let (status, places) = call(&app, "GET", &places_path, Some(&owner), None, json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(places["binding"], web["binding"]);
    assert!(places["approval"].is_null());
    assert!(web["approval"].is_null());
    assert_eq!(places["providers"].as_array().unwrap().len(), 1);
    assert!(!places.to_string().contains("fixture-only-google-maps-key"));
    assert!(
        web["providers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|provider| provider["provider"] != "google_places")
    );
    let web_provider = selected_service_provider(&web, LookupService::Web);
    let places_provider = selected_service_provider(&places, LookupService::Places);

    for (service, other_service, path, other_path, reviewed, opposite_provider) in [
        (
            LookupService::Web,
            LookupService::Places,
            &web_path,
            &places_path,
            &web,
            &places_provider,
        ),
        (
            LookupService::Places,
            LookupService::Web,
            &places_path,
            &web_path,
            &places,
            &web_provider,
        ),
    ] {
        let provider = selected_service_provider(reviewed, service);
        let grant = service_lookup_grant(service, &provider, reviewed, 0);
        for method in ["GET", "POST"] {
            assert_eq!(
                call(&app, method, path, None, None, grant.clone()).await,
                (StatusCode::UNAUTHORIZED, json!({"error":"unauthorized"}))
            );
            assert_eq!(
                call(&app, method, path, Some(&other), None, grant.clone()).await,
                (StatusCode::NOT_FOUND, json!({"error":"not_found"}))
            );
        }
        let mut wrong_token = grant.clone();
        wrong_token["approval"] = json!(crate::ambiance::lookup::owner_approval(other_service));
        assert_eq!(
            call(&app, "POST", path, Some(&owner), None, wrong_token).await,
            (StatusCode::BAD_REQUEST, json!({"error":"invalid_request"}))
        );
        let wrong_provider = service_lookup_grant(service, opposite_provider, reviewed, 0);
        assert_eq!(
            call(&app, "POST", path, Some(&owner), None, wrong_provider).await,
            (StatusCode::CONFLICT, json!({"error":"provider_changed"}))
        );
        let (_, other_before) =
            call(&app, "GET", other_path, Some(&owner), None, json!(null)).await;
        let (status, saved) = call(&app, "POST", path, Some(&owner), None, grant.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["approval"]["revision"], 1);
        assert_eq!(saved["approval"]["policy"], grant["policy"]);
        assert_eq!(
            call(&app, "GET", other_path, Some(&owner), None, json!(null))
                .await
                .1,
            other_before
        );
        assert_eq!(
            call(&app, "POST", path, Some(&owner), None, grant).await,
            (StatusCode::CONFLICT, json!({"error":"revision_conflict"}))
        );
    }

    let (_, saved_places) = call(&app, "GET", &places_path, Some(&owner), None, json!(null)).await;
    let mut revoke_web = service_lookup_grant(LookupService::Web, &web_provider, &web, 1);
    revoke_web["policy"] = Value::Null;
    let (status, revoked_web) = call(&app, "POST", &web_path, Some(&owner), None, revoke_web).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(revoked_web["approval"]["revision"], 2);
    assert!(revoked_web["approval"]["policy"].is_null());
    assert_eq!(
        call(&app, "GET", &places_path, Some(&owner), None, json!(null))
            .await
            .1,
        saved_places
    );

    // Losing Maps configuration removes destinations, while retaining the
    // owner's ability to revoke the old Places grant independently of Web.
    let (_, endpoint) = places_lookup_config();
    let absent = routes(ApiState {
        store,
        verifier: Some(verifier()),
        pairing: None,
        lookup_config: Some(lookup_config()),
        places_lookup_config: Some((MapsConfig::default(), endpoint)),
    });
    let (_, unavailable_places) = call(
        &absent,
        "GET",
        &places_path,
        Some(&owner),
        None,
        json!(null),
    )
    .await;
    assert_eq!(unavailable_places["providers"], json!([]));
    assert_eq!(unavailable_places["approval"], saved_places["approval"]);
    let mut revoke_places =
        service_lookup_grant(LookupService::Places, &places_provider, &saved_places, 1);
    assert_eq!(
        call(
            &absent,
            "POST",
            &places_path,
            Some(&owner),
            None,
            revoke_places.clone()
        )
        .await,
        (StatusCode::CONFLICT, json!({"error":"provider_changed"}))
    );
    revoke_places["policy"] = Value::Null;
    let (status, revoked_places) = call(
        &absent,
        "POST",
        &places_path,
        Some(&owner),
        None,
        revoke_places,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(revoked_places["approval"]["revision"], 2);
    assert!(revoked_places["approval"]["policy"].is_null());
    assert_eq!(
        call(&absent, "GET", &web_path, Some(&owner), None, json!(null))
            .await
            .1,
        revoked_web
    );
}

#[tokio::test]
async fn ambiance_lookup_http_strict_schema_and_exact_4096_byte_limit() {
    for service in [LookupService::Web, LookupService::Places] {
        let app = lookup_app(Arc::new(MemoryStore::default()), None, lookup_config());
        let owner = bearer("owner");
        let (surface, _) = lookup_browser(&app, &owner).await;
        let path = service_lookup_path(surface, service);
        let (_, initial) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
        let grant = service_lookup_grant(
            service,
            &selected_service_provider(&initial, service),
            &initial,
            0,
        );
        let mut invalid = Vec::new();
        for field in [
            "approval",
            "approvalRevision",
            "approvalIncarnation",
            "expectedRevision",
            "policy",
        ] {
            let mut body = grant.clone();
            body.as_object_mut().unwrap().remove(field);
            invalid.push(body);
        }
        for (pointer, value) in [
            ("/approval", json!("approve")),
            ("/approvalRevision", json!(-1)),
            ("/approvalIncarnation", json!("not-a-uuid")),
            ("/approvalIncarnation", json!(42)),
            ("/expectedRevision", json!(0.5)),
            ("/expectedRevision", json!("0")),
            ("/policy/maximumClass", json!("public")),
            ("/policy/maximumClass", json!("private")),
            ("/policy/maximumClass", json!("sensitive")),
            ("/policy/maximumClass", json!("unknown")),
            ("/policy/provider/provider", json!("automatic")),
        ] {
            let mut body = grant.clone();
            *body.pointer_mut(pointer).unwrap() = value;
            invalid.push(body);
        }
        for pointer in ["", "/policy", "/policy/provider"] {
            let mut body = grant.clone();
            body.pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("principal".into(), json!("other"));
            invalid.push(body);
        }
        for body in invalid {
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, body).await,
                (StatusCode::BAD_REQUEST, json!({"error": "invalid_request"}))
            );
        }
        for body in [
            "{".to_owned(),
            grant.to_string().replace(
                "\"expectedRevision\":0",
                "\"expectedRevision\":18446744073709551616",
            ),
        ] {
            assert_eq!(
                lookup_raw(&app, "POST", &path, &[("authorization", &owner)], body)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let encoded = grant.to_string();
        assert!(encoded.len() < 1024);
        let oversized = format!("{encoded}{}", " ".repeat(4097 - encoded.len()));
        assert_eq!(oversized.len(), 4097);
        assert_eq!(
            lookup_raw(&app, "POST", &path, &[("authorization", &owner)], oversized).await,
            (StatusCode::BAD_REQUEST, json!({"error": "invalid_request"}))
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            initial
        );
        // Valid JSON whitespace distinguishes the transport limit from schema rejection
        // and proves that this route has not inherited the registry's 1024-byte cap.
        let exact = format!("{encoded}{}", " ".repeat(4096 - encoded.len()));
        assert_eq!(exact.len(), 4096);
        let (status, saved) =
            lookup_raw(&app, "POST", &path, &[("authorization", &owner)], exact).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["approval"]["revision"], 1);
        assert_eq!(saved["approval"]["policy"], grant["policy"]);
    }
}

#[tokio::test]
async fn ambiance_lookup_http_provider_identity_revision_cas_and_configuration_change() {
    let store = Arc::new(MemoryStore::default());
    let app = lookup_app(store.clone(), None, lookup_config());
    let owner = bearer("owner");
    let (surface, _) = lookup_browser(&app, &owner).await;
    let path = lookup_path(surface);
    let (_, initial) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
    let provider = selected_provider(&initial, "searxng");
    let grant = lookup_grant(&provider, &initial, 0);
    for field in ["endpoint", "configurationDigest", "provider"] {
        let mut changed = grant.clone();
        changed["policy"]["provider"][field] = match field {
            "endpoint" => json!("https://another-lookup.test/search"),
            "configurationDigest" => json!("0".repeat(64)),
            _ => json!("serp_api"),
        };
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, changed).await,
            (StatusCode::CONFLICT, json!({"error": "provider_changed"}))
        );
    }
    let (status, saved) = call(&app, "POST", &path, Some(&owner), None, grant.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        saved["approval"],
        json!({"approvalRevision":1,"revision":1,"policy":grant["policy"]})
    );
    assert_eq!(
        call(&app, "POST", &path, Some(&owner), None, grant).await,
        (StatusCode::CONFLICT, json!({"error": "revision_conflict"}))
    );
    let mut future_review = initial.clone();
    future_review["binding"]["approvalRevision"] = json!(2);
    assert_eq!(
        call(
            &app,
            "POST",
            &path,
            Some(&owner),
            None,
            lookup_grant(&provider, &future_review, 1)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let changed = lookup_app(
        store.clone(),
        None,
        SearchConfig {
            searxng_base_url: Some("https://changed-lookup.test".into()),
            ..lookup_config()
        },
    );
    assert_eq!(
        call(
            &changed,
            "POST",
            &path,
            Some(&owner),
            None,
            lookup_grant(&provider, &initial, 1)
        )
        .await,
        (StatusCode::CONFLICT, json!({"error": "provider_changed"}))
    );
    let (status, changed_state) =
        call(&changed, "GET", &path, Some(&owner), None, json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(changed_state["approval"], saved["approval"]);
    assert_ne!(selected_provider(&changed_state, "searxng"), provider);
    // The owner can explicitly choose the other configured provider; no implicit
    // provider switch is created by losing the originally selected configuration.
    let alternative = selected_provider(&changed_state, "serp_api");
    let update = lookup_grant(&alternative, &changed_state, 1);
    let (status, switched) =
        call(&changed, "POST", &path, Some(&owner), None, update.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(switched["approval"]["revision"], 2);
    assert_eq!(switched["approval"]["policy"], update["policy"]);
    let absent = lookup_app(store, None, SearchConfig::default());
    let (_, disabled) = call(&absent, "GET", &path, Some(&owner), None, json!(null)).await;
    assert_eq!(disabled["providers"], json!([]));
    assert_eq!(disabled["approval"], switched["approval"]);
    assert_eq!(
        call(
            &absent,
            "POST",
            &path,
            Some(&owner),
            None,
            lookup_grant(&alternative, &changed_state, 2)
        )
        .await,
        (StatusCode::CONFLICT, json!({"error":"provider_changed"}))
    );
    let mut revoke = lookup_grant(&alternative, &changed_state, 2);
    revoke["policy"] = Value::Null;
    let (status, revoked) = call(&absent, "POST", &path, Some(&owner), None, revoke).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        revoked["approval"],
        json!({"approvalRevision":1,"revision":3,"policy":null})
    );
    assert_eq!(revoked["providers"], json!([]));
}

#[tokio::test]
async fn ambiance_lookup_http_common_route_supports_browser_native_and_pin_without_cross_grants() {
    for service in [LookupService::Web, LookupService::Places] {
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let app = lookup_app(
            Arc::new(MemoryStore::default()),
            Some(pairing),
            lookup_config(),
        );
        let owner = bearer("owner");
        let (browser, _) = lookup_browser(&app, &owner).await;
        let (status, native) = call(
            &app,
            "POST",
            "/surface-api/v1/native",
            Some(&owner),
            None,
            native_approval(Uuid::new_v4()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let native = Uuid::parse_str(native["native"]["surfaceId"].as_str().unwrap()).unwrap();
        let (status, pin) = call(
            &app,
            "POST",
            "/surface-api/v1/pins",
            Some(&owner),
            None,
            json!({"deviceId":"aabb","approval":surface_registry::PIN_APPROVAL}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let pin = Uuid::parse_str(pin["pin"]["surfaceId"].as_str().unwrap()).unwrap();
        for surface in [browser, native, pin] {
            let path = service_lookup_path(surface, service);
            let (status, current) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
            assert_eq!(status, StatusCode::OK);
            assert!(current["approval"].is_null());
            let grant = service_lookup_grant(
                service,
                &selected_service_provider(&current, service),
                &current,
                0,
            );
            assert_eq!(current["binding"]["approvalRevision"], 1);
            if surface == browser {
                let incarnation =
                    Uuid::parse_str(current["binding"]["incarnation"].as_str().unwrap()).unwrap();
                assert!(!incarnation.is_nil());
            } else {
                assert!(current["binding"]["incarnation"].is_null());
                let mut missing = grant.clone();
                missing
                    .as_object_mut()
                    .unwrap()
                    .remove("approvalIncarnation");
                assert_eq!(
                    call(&app, "POST", &path, Some(&owner), None, missing)
                        .await
                        .0,
                    StatusCode::BAD_REQUEST
                );
                let mut wrong = grant.clone();
                wrong["approvalIncarnation"] = json!(Uuid::new_v4());
                assert_eq!(
                    call(&app, "POST", &path, Some(&owner), None, wrong).await.0,
                    StatusCode::CONFLICT
                );
                let mut future = grant.clone();
                future["approvalRevision"] = json!(2);
                assert_eq!(
                    call(&app, "POST", &path, Some(&owner), None, future)
                        .await
                        .0,
                    StatusCode::CONFLICT
                );
            }
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, grant.clone())
                    .await
                    .0,
                StatusCode::OK
            );
            let (_, saved) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
            assert_eq!(saved["approval"]["policy"], grant["policy"]);
        }
        // The common authority endpoint does not create cloud speech/local microphone
        // permission for the Pin, or expose a second per-profile lookup API.
        for kind in ["speech-disclosure", "local-voice"] {
            assert_eq!(
                call(
                    &app,
                    "GET",
                    &format!("/surface-api/v1/pins/{pin}/{kind}"),
                    Some(&owner),
                    None,
                    json!(null)
                )
                .await,
                (StatusCode::OK, json!({"approval":null}))
            );
        }
        for (profile, surface) in [("native", native), ("pins", pin)] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!(
                            "/surface-api/v1/{profile}/{surface}/{}-lookup",
                            match service {
                                LookupService::Web => "web",
                                LookupService::Places => "places",
                            }
                        ))
                        .header("authorization", &owner)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }
}

#[tokio::test]
async fn ambiance_lookup_http_pairing_loss_denies_grant_but_allows_revoke_and_requires_reapproval()
{
    for service in [LookupService::Web, LookupService::Places] {
        let store = Arc::new(MemoryStore::default());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let app = lookup_app(store.clone(), Some(pairing.clone()), lookup_config());
        let owner = bearer("owner");
        let pin = json!({"deviceId":"aabb","approval":surface_registry::PIN_APPROVAL});
        let (status, approved) = call(
            &app,
            "POST",
            "/surface-api/v1/pins",
            Some(&owner),
            None,
            pin.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let surface = Uuid::parse_str(approved["pin"]["surfaceId"].as_str().unwrap()).unwrap();
        let path = service_lookup_path(surface, service);
        let (_, initial) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
        let provider = selected_service_provider(&initial, service);
        assert_eq!(
            call(
                &app,
                "POST",
                &path,
                Some(&owner),
                None,
                service_lookup_grant(service, &provider, &initial, 0)
            )
            .await
            .0,
            StatusCode::OK
        );
        pairing.put_device_account("aabb", "other").await.unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                &path,
                Some(&owner),
                None,
                service_lookup_grant(service, &provider, &initial, 1)
            )
            .await,
            (StatusCode::NOT_FOUND, json!({"error":"not_found"}))
        );
        let unavailable = lookup_app(store, None, lookup_config());
        assert_eq!(
            call(
                &unavailable,
                "POST",
                &path,
                Some(&owner),
                None,
                service_lookup_grant(service, &provider, &initial, 1)
            )
            .await,
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error":"unavailable"})
            )
        );
        let mut revoke = service_lookup_grant(service, &provider, &initial, 1);
        revoke["policy"] = Value::Null;
        let (status, revoked) = call(&app, "POST", &path, Some(&owner), None, revoke.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            revoked["approval"],
            json!({"approvalRevision":1,"revision":2,"policy":null})
        );
        revoke["expectedRevision"] = json!(2);
        assert_eq!(
            call(&unavailable, "POST", &path, Some(&owner), None, revoke)
                .await
                .0,
            StatusCode::OK
        );
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let (status, reapproved) = call(
            &app,
            "POST",
            "/surface-api/v1/pins",
            Some(&owner),
            None,
            pin,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reapproved["pin"]["revision"], 2);
        let (_, current) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
        assert!(current["approval"].is_null());
        assert_eq!(
            call(
                &app,
                "POST",
                &path,
                Some(&owner),
                None,
                service_lookup_grant(service, &provider, &initial, 0)
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let (status, fresh) = call(
            &app,
            "POST",
            &path,
            Some(&owner),
            None,
            service_lookup_grant(service, &provider, &current, 0),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fresh["approval"]["approvalRevision"], 2);
        assert_eq!(fresh["approval"]["revision"], 1);
    }
}

#[tokio::test]
async fn ambiance_lookup_http_review_survives_heartbeat_but_not_browser_reapproval() {
    for service in [LookupService::Web, LookupService::Places] {
        let store = Arc::new(MemoryStore::default());
        let app = lookup_app(store.clone(), None, lookup_config());
        let owner = bearer("owner");
        let (surface, approved) = lookup_browser(&app, &owner).await;
        let path = service_lookup_path(surface, service);
        let (_, reviewed) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
        let provider = selected_service_provider(&reviewed, service);
        let incarnation =
            Uuid::parse_str(approved["connection"]["incarnation"].as_str().unwrap()).unwrap();
        let token_hash =
            surface_registry::hash(approved["connection"]["token"].as_str().unwrap().as_bytes());
        assert_eq!(
            reviewed["binding"],
            json!({"approvalRevision":1,"incarnation":incarnation})
        );
        let grant = service_lookup_grant(service, &provider, &reviewed, 0);

        for (incarnation, expected) in [
            (Value::Null, StatusCode::CONFLICT),
            (json!(Uuid::nil()), StatusCode::BAD_REQUEST),
            (json!(Uuid::new_v4()), StatusCode::CONFLICT),
        ] {
            let mut wrong = grant.clone();
            wrong["approvalIncarnation"] = incarnation;
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, wrong).await.0,
                expected
            );
        }
        let mut future = grant.clone();
        future["approvalRevision"] = json!(2);
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, future)
                .await
                .0,
            StatusCode::CONFLICT
        );

        // This is the actual registry mutation used by the room heartbeat; no legacy
        // REST presence route or fabricated replacement record is introduced here.
        let heartbeat = store
            .mutate_surface(
                "U:owner",
                surface,
                Mutation::State {
                    token_hash: token_hash.clone(),
                    incarnation,
                    sequence: 1,
                    visible: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(heartbeat.revision, 2);
        let (status, saved) = call(&app, "POST", &path, Some(&owner), None, grant).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["approval"]["revision"], 1);
        assert_eq!(saved["approval"]["policy"]["provider"], provider);
        assert_eq!(
            saved["binding"],
            json!({"approvalRevision":2,"incarnation":incarnation})
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            saved
        );

        let heartbeat = store
            .mutate_surface(
                "U:owner",
                surface,
                Mutation::State {
                    token_hash,
                    incarnation,
                    sequence: 2,
                    visible: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(heartbeat.revision, 3);
        let mut revoke = service_lookup_grant(service, &provider, &saved, 1);
        revoke["policy"] = Value::Null;
        let (status, revoked) = call(&app, "POST", &path, Some(&owner), None, revoke).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["approval"]["revision"], 2);
        assert!(revoked["approval"]["policy"].is_null());
        assert_eq!(
            revoked["binding"],
            json!({"approvalRevision":3,"incarnation":incarnation})
        );

        let (status, reapproved) = call(
            &app,
            "POST",
            "/surface-api/v1/surfaces",
            Some(&owner),
            None,
            json!({"surfaceId":surface,"approval":surface_registry::BROWSER_APPROVAL}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, current) = call(&app, "GET", &path, Some(&owner), None, json!(null)).await;
        assert!(current["approval"].is_null());
        assert_eq!(
            current["binding"],
            json!({
                "approvalRevision":reapproved["surface"]["revision"],
                "incarnation":reapproved["connection"]["incarnation"],
            })
        );
        assert_ne!(
            current["binding"]["incarnation"],
            reviewed["binding"]["incarnation"]
        );
        let stale = service_lookup_grant(service, &provider, &revoked, 0);
        let mut guessed_revision = stale.clone();
        guessed_revision["approvalRevision"] = current["binding"]["approvalRevision"].clone();
        for stale in [stale, guessed_revision] {
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, stale).await,
                (StatusCode::CONFLICT, json!({"error":"revision_conflict"}))
            );
        }
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            current
        );
        let (status, fresh) = call(
            &app,
            "POST",
            &path,
            Some(&owner),
            None,
            service_lookup_grant(service, &provider, &current, 0),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fresh["approval"]["revision"], 1);
        assert_eq!(fresh["binding"], current["binding"]);
    }
}
