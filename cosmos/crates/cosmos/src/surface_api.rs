//! Strict bearer-authenticated owner registry, separate from public projections.
use crate::{
    store::SharedStore,
    surface_registry::{self, Mutation, RegistryError},
    web_auth::JwtVerifier,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
struct ApiState {
    store: SharedStore,
    verifier: Option<Arc<JwtVerifier>>,
    pairing: Option<crate::enrollment::SharedEnrollmentStore>,
}

pub fn router(store: SharedStore) -> Router {
    with_verifier(store, crate::web_auth::configured_verifier())
}

fn with_verifier(store: SharedStore, verifier: Option<Arc<JwtVerifier>>) -> Router {
    with_pairing(store, verifier, crate::enrollment::pairing_store())
}

fn with_pairing(
    store: SharedStore,
    verifier: Option<Arc<JwtVerifier>>,
    pairing: Option<crate::enrollment::SharedEnrollmentStore>,
) -> Router {
    Router::new()
        .route("/surface-api/v1/surfaces", get(list).post(approve))
        .route("/surface-api/v1/surfaces/:surface_id", delete(revoke))
        .route("/surface-api/v1/surfaces/:surface_id/state", post(state))
        .route("/surface-api/v1/surfaces/:surface_id/leave", post(leave))
        .route("/surface-api/v1/pins", get(list_pins).post(approve_pin))
        .route("/surface-api/v1/pins/:surface_id", delete(revoke_pin))
        .layer(DefaultBodyLimit::max(1024))
        .layer(axum::middleware::map_response(no_store))
        .with_state(ApiState {
            store,
            verifier,
            pairing,
        })
}

async fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<RegistryError> for ApiError {
    fn from(error: RegistryError) -> Self {
        match error {
            RegistryError::Unavailable => Self(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            RegistryError::NotFound => Self(StatusCode::NOT_FOUND, "not_found"),
            RegistryError::InvalidConnection => Self(StatusCode::FORBIDDEN, "invalid_connection"),
            RegistryError::SequenceConflict => Self(StatusCode::CONFLICT, "sequence_conflict"),
            RegistryError::SurfaceLimit => Self(StatusCode::TOO_MANY_REQUESTS, "surface_limit"),
        }
    }
}
fn invalid() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "invalid_request")
}
fn owner(headers: &HeaderMap, state: &ApiState) -> Result<String, ApiError> {
    let unauthorized = || ApiError(StatusCode::UNAUTHORIZED, "unauthorized");
    if headers.get_all("authorization").iter().count() != 1 {
        return Err(unauthorized());
    }
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(crate::web_auth::bearer_token)
        .ok_or_else(unauthorized)?;
    let verifier = state
        .verifier
        .as_ref()
        .ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?;
    let principal = verifier.verify(token).map_err(|_| unauthorized())?;
    Ok(principal.expose_for_authorization().to_owned())
}
fn connection_hash(headers: &HeaderMap) -> Result<String, ApiError> {
    let invalid = || ApiError(StatusCode::FORBIDDEN, "invalid_connection");
    if headers.get_all("x-cosmos-surface-token").iter().count() != 1 {
        return Err(invalid());
    }
    let token = headers
        .get("x-cosmos-surface-token")
        .and_then(|v| v.to_str().ok())
        .filter(|v| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(invalid)?;
    Ok(surface_registry::hash(token.as_bytes()))
}
fn id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| invalid())
}
fn body<T>(value: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    value.map(|Json(v)| v).map_err(|_| invalid())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Approval {
    surface_id: Uuid,
    approval: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SurfaceState {
    incarnation: Uuid,
    sequence: u64,
    visible: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Leave {
    incarnation: Uuid,
}

async fn list(
    State(api): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    Ok(Json(
        json!({"surfaces": api.store.surfaces(&principal).await?.into_iter().filter(|surface| matches!(surface.binding, surface_registry::Binding::Browser)).collect::<Vec<_>>()}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinApproval {
    device_id: String,
    approval: String,
}

async fn list_pins(
    State(api): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let mut pins = Vec::new();
    for surface in api.store.surfaces(&principal).await? {
        if let surface_registry::Binding::Pin { device_id } = &surface.binding {
            match crate::pin_admission::paired_owner(api.pairing.as_ref(), &principal, device_id)
                .await
            {
                Ok(()) => pins.push(surface.pin_view(Some(true))?),
                Err(RegistryError::NotFound) => pins.push(surface.pin_view(Some(false))?),
                Err(RegistryError::Unavailable) => pins.push(surface.pin_view(None)?),
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(Json(json!({"pins": pins})))
}

async fn approve_pin(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Result<Json<PinApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request = body(request)?;
    if request.approval != surface_registry::PIN_APPROVAL {
        return Err(invalid());
    }
    let device = cosmos_core::AuthenticatedDeviceIdentity::from_edge(&request.device_id)
        .map_err(|_| invalid())?;
    let device_id = device.expose_for_authorization().to_owned();
    crate::pin_admission::paired_owner(api.pairing.as_ref(), &principal, &device_id).await?;
    let surface_id = surface_registry::pin_surface_id(&principal, &device_id);
    let surface = api
        .store
        .mutate_surface(&principal, surface_id, Mutation::ApprovePin { device_id })
        .await?;
    Ok(Json(json!({"pin": surface.pin_view(Some(true))?})))
}

async fn revoke_pin(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let current = api
        .store
        .surface(&principal, surface_id)
        .await?
        .ok_or(RegistryError::NotFound)?;
    let surface_registry::Binding::Pin { device_id } = &current.binding else {
        return Err(RegistryError::NotFound.into());
    };
    let current_paired =
        match crate::pin_admission::paired_owner(api.pairing.as_ref(), &principal, device_id).await
        {
            Ok(()) => Some(true),
            Err(RegistryError::NotFound) => Some(false),
            Err(RegistryError::Unavailable) => None,
            Err(error) => return Err(error.into()),
        };
    let surface = api
        .store
        .mutate_surface(&principal, surface_id, Mutation::RevokePin)
        .await?;
    Ok(Json(json!({"pin": surface.pin_view(current_paired)?})))
}
async fn approve(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Result<Json<Approval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request = body(request)?;
    if request.approval != surface_registry::BROWSER_APPROVAL {
        return Err(invalid());
    }
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let incarnation = Uuid::new_v4();
    let surface = api
        .store
        .mutate_surface(
            &principal,
            request.surface_id,
            Mutation::Approve {
                token_hash: surface_registry::hash(token.as_bytes()),
                incarnation,
            },
        )
        .await?;
    Ok(Json(
        json!({"connection": {"token": token, "incarnation": incarnation, "expiresAt": surface.connection_expires_at}, "surface": surface}),
    ))
}
async fn revoke(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface = api
        .store
        .mutate_surface(&principal, id(&surface_id)?, Mutation::Revoke)
        .await?;
    Ok(Json(json!({"surface": surface})))
}
async fn state(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<SurfaceState>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let token_hash = connection_hash(&headers)?;
    let request = body(request)?;
    let surface = api
        .store
        .mutate_surface(
            &principal,
            id(&surface_id)?,
            Mutation::State {
                token_hash,
                incarnation: request.incarnation,
                sequence: request.sequence,
                visible: request.visible,
            },
        )
        .await?;
    Ok(Json(json!({"surface": surface})))
}
async fn leave(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<Leave>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let token_hash = connection_hash(&headers)?;
    let request = body(request)?;
    let surface = api
        .store
        .mutate_surface(
            &principal,
            id(&surface_id)?,
            Mutation::Leave {
                token_hash,
                incarnation: request.incarnation,
            },
        )
        .await?;
    Ok(Json(json!({"surface": surface})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
    use tower::ServiceExt;

    #[tokio::test]
    async fn pin_admission_owner_can_revoke_while_pairing_is_unavailable() {
        let store: SharedStore = Arc::new(crate::store::MemoryStore::default());
        let principal = cosmos_core::AuthenticatedPrincipal::for_user("owner").unwrap();
        let principal = principal.expose_for_authorization();
        let id = surface_registry::pin_surface_id(principal, "aabb");
        store
            .mutate_surface(
                principal,
                id,
                Mutation::ApprovePin {
                    device_id: "aabb".into(),
                },
            )
            .await
            .unwrap();
        let app = with_pairing(store.clone(), Some(verifier()), None);
        let root = "/surface-api/v1/pins";
        let owner = bearer("owner");
        let (status, listed) = call(&app, "GET", root, Some(&owner), None, json!(null)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed["pins"].as_array().unwrap().len(), 1);
        assert!(listed["pins"][0]["currentPaired"].is_null());
        assert_eq!(
            call(
                &app,
                "POST",
                root,
                Some(&owner),
                None,
                json!({"deviceId":"aabb", "approval":surface_registry::PIN_APPROVAL})
            )
            .await
            .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let (status, revoked) = call(
            &app,
            "DELETE",
            &format!("{root}/{id}"),
            Some(&owner),
            None,
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["pin"]["revoked"], true);
        assert!(revoked["pin"]["currentPaired"].is_null());
        assert!(store.surface(principal, id).await.unwrap().unwrap().revoked);
    }

    #[tokio::test]
    async fn pin_admission_owner_api_requires_pairing_and_prevents_profile_confusion() {
        use crate::enrollment::EnrollmentStore;
        let store = Arc::new(crate::store::MemoryStore::default());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        pairing.put_device_account("ccdd", "other").await.unwrap();
        let app = with_pairing(store, Some(verifier()), Some(pairing.clone()));
        let owner = bearer("owner");
        let root = "/surface-api/v1/pins";
        let request = json!({"deviceId": "AABB", "approval": surface_registry::PIN_APPROVAL});
        for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
            assert_eq!(
                call(&app, "POST", root, authorization, None, request.clone())
                    .await
                    .0,
                StatusCode::UNAUTHORIZED
            );
        }
        for device in ["ccdd", "eeff"] {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    root,
                    Some(&owner),
                    None,
                    json!({"deviceId": device, "approval": surface_registry::PIN_APPROVAL})
                )
                .await
                .0,
                StatusCode::NOT_FOUND
            );
        }
        for field in [
            "manifest",
            "trustLevel",
            "principal",
            "occupancy",
            "surfaceId",
        ] {
            let mut elevated = request.clone();
            elevated[field] = "private".into();
            assert_eq!(
                call(&app, "POST", root, Some(&owner), None, elevated)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let (status, approved) =
            call(&app, "POST", root, Some(&owner), None, request.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(approved["pin"]["deviceId"], "aabb");
        assert_eq!(approved["pin"]["actorIdentity"], "unknown");
        assert!(approved.get("connection").is_none());
        let surface_id = approved["pin"]["surfaceId"].as_str().unwrap();
        let (_, again) = call(&app, "POST", root, Some(&owner), None, request).await;
        assert_eq!(again["pin"]["surfaceId"], surface_id);
        assert_eq!(again["pin"]["revision"], 2);
        let (_, browser_list) = call(
            &app,
            "GET",
            "/surface-api/v1/surfaces",
            Some(&owner),
            None,
            json!(null),
        )
        .await;
        assert_eq!(browser_list["surfaces"], json!([]));
        assert_eq!(
            call(
                &app,
                "POST",
                "/surface-api/v1/surfaces",
                Some(&owner),
                None,
                json!({"surfaceId": surface_id, "approval":surface_registry::BROWSER_APPROVAL})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (_, listed) = call(&app, "GET", root, Some(&owner), None, json!(null)).await;
        assert_eq!(listed["pins"].as_array().unwrap().len(), 1);
        pairing.put_device_account("aabb", "other").await.unwrap();
        assert_eq!(
            call(&app, "GET", root, Some(&owner), None, json!(null))
                .await
                .1["pins"][0]["currentPaired"],
            json!(false)
        );
        let path = format!("{root}/{surface_id}");
        assert_eq!(
            call(
                &app,
                "DELETE",
                &path,
                Some(&bearer("other")),
                None,
                json!(null)
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(&app, "DELETE", &path, Some(&owner), None, json!(null))
                .await
                .1["pin"]["revoked"],
            true
        );
        let unavailable = with_pairing(
            Arc::new(crate::store::MemoryStore::default()),
            Some(verifier()),
            None,
        );
        assert_eq!(
            call(&unavailable, "GET", root, Some(&owner), None, json!(null))
                .await
                .0,
            StatusCode::OK
        );
    }

    fn verifier() -> Arc<JwtVerifier> {
        let (_, public) = crate::web_auth::test_jwt_keypair();
        JwtVerifier::with_keys(
            crate::web_auth::OidcConfig {
                issuer: "https://surface.test".to_owned(),
                audience: Some("surface-test".to_owned()),
                jwks_uri: "unused".to_owned(),
            },
            [(
                "surface-test".to_owned(),
                DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(),
            )]
            .into(),
        )
    }
    fn bearer(subject: &str) -> String {
        let (private, _) = crate::web_auth::test_jwt_keypair();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("surface-test".to_owned());
        let token = jsonwebtoken::encode(&header, &json!({"sub": subject, "iss": "https://surface.test", "aud": "surface-test", "exp": surface_registry::now_ms()/1000+300}), &EncodingKey::from_rsa_pem(private.as_bytes()).unwrap()).unwrap();
        format!("Bearer {token}")
    }
    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(bearer) = bearer {
            request = request.header("authorization", bearer);
        }
        if let Some(token) = token {
            request = request.header("x-cosmos-surface-token", token);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
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
    async fn surface_registry_http_approval_state_rotation_leave_revoke() {
        let app = with_verifier(
            Arc::new(crate::store::MemoryStore::default()),
            Some(verifier()),
        );
        let owner = bearer("owner");
        let other = bearer("other");
        let root = "/surface-api/v1/surfaces";
        let id = Uuid::new_v4();
        let path = format!("{root}/{id}");
        let approval = json!({"surfaceId": id, "approval": surface_registry::BROWSER_APPROVAL});
        let (status, approved) =
            call(&app, "POST", root, Some(&owner), None, approval.clone()).await;
        assert_eq!(status, StatusCode::OK);
        let token = approved["connection"]["token"].as_str().unwrap();
        assert_eq!(token.len(), 64);
        let incarnation = &approved["connection"]["incarnation"];
        assert_eq!(approved["surface"]["available"], false);
        assert_eq!(approved["surface"]["renderVerified"], false);
        let state = json!({"incarnation": incarnation, "sequence": 1, "visible": true});
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{path}/state"),
                Some(&other),
                Some(token),
                state.clone()
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{path}/state"),
                Some(&owner),
                Some(&"f".repeat(64)),
                state.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let mut wrong = state.clone();
        wrong["incarnation"] = Uuid::new_v4().to_string().into();
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{path}/state"),
                Some(&owner),
                Some(token),
                wrong
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (status, shown) = call(
            &app,
            "POST",
            &format!("{path}/state"),
            Some(&owner),
            Some(token),
            state.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(shown["surface"]["available"], true);
        assert_eq!(shown["surface"]["occupancy"], "unknown");
        assert_eq!(shown["surface"]["trustLevel"], 0);
        let (_, duplicate) = call(
            &app,
            "POST",
            &format!("{path}/state"),
            Some(&owner),
            Some(token),
            state.clone(),
        )
        .await;
        assert_eq!(duplicate, shown);
        let mut conflict = state.clone();
        conflict["visible"] = false.into();
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{path}/state"),
                Some(&owner),
                Some(token),
                conflict
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let (_, listed) = call(&app, "GET", root, Some(&owner), None, json!(null)).await;
        assert_eq!(listed["surfaces"].as_array().unwrap().len(), 1);
        assert!(!listed.to_string().contains(token));
        assert!(!listed.to_string().contains("incarnation"));
        let (_, isolated) = call(&app, "GET", root, Some(&other), None, json!(null)).await;
        assert_eq!(isolated["surfaces"], json!([]));
        let (_, rotated) = call(&app, "POST", root, Some(&owner), None, approval).await;
        assert_ne!(rotated["connection"]["token"], token);
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{path}/state"),
                Some(&owner),
                Some(token),
                state
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let next_token = rotated["connection"]["token"].as_str().unwrap();
        let leave = json!({"incarnation": rotated["connection"]["incarnation"]});
        let (_, left) = call(
            &app,
            "POST",
            &format!("{path}/leave"),
            Some(&owner),
            Some(next_token),
            leave,
        )
        .await;
        assert_eq!(left["surface"]["connected"], false);
        assert_eq!(left["surface"]["revoked"], false);
        let (status, revoked) = call(&app, "DELETE", &path, Some(&owner), None, json!(null)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["surface"]["revoked"], true);
        assert_eq!(
            call(&app, "GET", root, Some(&owner), None, json!(null))
                .await
                .1["surfaces"],
            json!([])
        );
    }

    #[tokio::test]
    async fn surface_registry_http_rejects_untrusted_auth_and_manifest_self_upgrade() {
        let app = with_verifier(
            Arc::new(crate::store::MemoryStore::default()),
            Some(verifier()),
        );
        let root = "/surface-api/v1/surfaces";
        let owner = bearer("owner");
        let request =
            json!({"surfaceId": Uuid::new_v4(), "approval": surface_registry::BROWSER_APPROVAL});
        for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
            assert_eq!(
                call(&app, "POST", root, authorization, None, request.clone())
                    .await
                    .0,
                StatusCode::UNAUTHORIZED
            );
        }
        let forged = Request::builder()
            .method("GET")
            .uri(root)
            .header(
                crate::config::EDGE_PRINCIPAL_HEADER,
                "Subject=CN=V:01:D:aa:U:owner",
            )
            .header("x-cosmos-web-projection-token", "not-owner-bearer")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(forged).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        for field in ["manifest", "trustLevel", "occupancy", "principal"] {
            let mut elevated = request.clone();
            elevated[field] = "private".into();
            assert_eq!(
                call(&app, "POST", root, Some(&owner), None, elevated).await,
                (StatusCode::BAD_REQUEST, json!({"error":"invalid_request"}))
            );
        }
        let oversized = json!({"surfaceId": Uuid::new_v4(), "approval": "x".repeat(2048)});
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, oversized)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let unavailable = with_verifier(Arc::new(crate::store::MemoryStore::default()), None);
        assert_eq!(
            call(&unavailable, "GET", root, Some(&owner), None, json!(null))
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let unavailable = with_verifier(
            Arc::new(crate::store_postgres::PostgresStore::unreachable()),
            Some(verifier()),
        );
        assert_eq!(
            call(&unavailable, "POST", root, Some(&owner), None, request).await,
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error":"unavailable"})
            )
        );
    }
}
