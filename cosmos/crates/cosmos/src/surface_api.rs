//! Strict bearer-authenticated owner registry, separate from public projections.
use crate::{
    backends::lookup::{LookupProviderIdentity, LookupService},
    store::SharedStore,
    surface_registry::{self, Mutation, RegistryError},
    web_auth::JwtVerifier,
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, RawQuery, State, rejection::JsonRejection},
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
    #[cfg(test)]
    lookup_config: Option<crate::integrations::SearchConfig>,
    #[cfg(test)]
    places_lookup_config: Option<(crate::integrations::MapsConfig, String)>,
}

impl ApiState {
    fn lookup_providers(&self, service: LookupService) -> Vec<LookupProviderIdentity> {
        match service {
            LookupService::Web => {
                #[cfg(test)]
                if let Some(config) = &self.lookup_config {
                    return crate::backends::search::lookup_providers_for_test(config);
                }
                crate::backends::search::lookup_providers()
            }
            LookupService::Places => {
                #[cfg(test)]
                if let Some((config, endpoint)) = &self.places_lookup_config {
                    return crate::backends::places::lookup_providers_for_test(config, endpoint);
                }
                crate::backends::places::lookup_providers()
            }
        }
    }
}

pub fn router(store: SharedStore) -> Router {
    with_verifier(store, crate::web_auth::configured_verifier())
}

fn with_verifier(store: SharedStore, verifier: Option<Arc<JwtVerifier>>) -> Router {
    with_pairing(store, verifier, crate::enrollment::pairing_store())
}

pub(crate) fn with_pairing(
    store: SharedStore,
    verifier: Option<Arc<JwtVerifier>>,
    pairing: Option<crate::enrollment::SharedEnrollmentStore>,
) -> Router {
    routes(ApiState {
        store,
        verifier,
        pairing,
        #[cfg(test)]
        lookup_config: None,
        #[cfg(test)]
        places_lookup_config: None,
    })
}

fn routes(api: ApiState) -> Router {
    Router::new()
        .route("/surface-api/v1/ledger", get(ledger))
        .route("/surface-api/v1/surfaces", get(list).post(approve))
        .route("/surface-api/v1/surfaces/:surface_id", delete(revoke))
        .route("/surface-api/v1/surfaces/:surface_id/leave", post(leave))
        .route("/surface-api/v1/pins", get(list_pins).post(approve_pin))
        .route("/surface-api/v1/pins/:surface_id", delete(revoke_pin))
        .route(
            "/surface-api/v1/native",
            get(list_native).post(approve_native),
        )
        .route("/surface-api/v1/native/:surface_id", delete(revoke_native))
        .route(
            "/surface-api/v1/native/enrollments/:enrollment_id",
            get(native_enrollment),
        )
        .route(
            "/surface-api/v1/surfaces/:surface_id/speech-disclosure",
            get(disclosure_policy).post(set_disclosure_policy),
        )
        .route(
            "/surface-api/v1/surfaces/:surface_id/private-display",
            get(private_policy).post(set_private_policy),
        )
        .route(
            "/surface-api/v1/surfaces/:surface_id/screen-context",
            get(screen_context_policy).post(set_screen_context_policy),
        )
        .route(
            "/surface-api/v1/surfaces/:surface_id/voice-input",
            get(native_voice_policy).post(set_native_voice_policy),
        )
        .route(
            "/surface-api/v1/pins/:surface_id/local-voice",
            get(voice_policy).post(set_voice_policy),
        )
        .layer(DefaultBodyLimit::max(1024))
        .route(
            "/surface-api/v1/surfaces/:surface_id/web-lookup",
            get(lookup_policy)
                .post(set_lookup_policy)
                .route_layer(Extension(LookupService::Web))
                .layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/surface-api/v1/surfaces/:surface_id/places-lookup",
            get(lookup_policy)
                .post(set_lookup_policy)
                .route_layer(Extension(LookupService::Places))
                .layer(DefaultBodyLimit::max(4096)),
        )
        // Host, application and root lists do not fit the owner body limit,
        // and an authored command entry list fits neither; both raise it for
        // their own route exactly as the lookup routes already do.
        .route(
            "/surface-api/v1/surfaces/:surface_id/device-actions",
            get(device_action_policy)
                .post(set_device_action_policy)
                .layer(DefaultBodyLimit::max(2048)),
        )
        .route(
            "/surface-api/v1/surfaces/:surface_id/device-commands",
            get(device_command_policy)
                .post(set_device_command_policy)
                .layer(DefaultBodyLimit::max(4096)),
        )
        .layer(axum::middleware::map_response(no_store))
        .with_state(api)
}

#[cfg(test)]
pub(crate) fn with_lookup_config_for_test(
    store: SharedStore,
    verifier: Option<Arc<JwtVerifier>>,
    pairing: Option<crate::enrollment::SharedEnrollmentStore>,
    config: crate::integrations::SearchConfig,
    places: Option<(crate::integrations::MapsConfig, String)>,
) -> Router {
    routes(ApiState {
        store,
        verifier,
        pairing,
        lookup_config: Some(config),
        places_lookup_config: places,
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
impl From<crate::ambiance::RuntimeError> for ApiError {
    fn from(error: crate::ambiance::RuntimeError) -> Self {
        use crate::ambiance::RuntimeError;
        match error {
            RuntimeError::Unavailable => Self(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            RuntimeError::InvalidOrigin | RuntimeError::NotFound => {
                Self(StatusCode::NOT_FOUND, "not_found")
            }
            RuntimeError::InvalidRequest => invalid(),
            RuntimeError::Stale | RuntimeError::Busy => {
                Self(StatusCode::CONFLICT, "revision_conflict")
            }
            RuntimeError::PolicyBlocked => Self(StatusCode::FORBIDDEN, "policy_blocked"),
        }
    }
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

/// How many ledger events one owner read may ask for.
const LEDGER_MAX: usize = crate::ambiance::account::LEDGER_LIMIT;

/// The tail of the owner's own ledger, oldest first. The chain carries no
/// request text and no reply content, so neither does this; it says where a
/// reply went, not what it said. The only query this route accepts is a whole
/// `limit` between one event and `LEDGER_MAX`: anything else is a bad request
/// rather than a silently different history.
async fn ledger(
    State(api): State<ApiState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let invalid = || ApiError(StatusCode::BAD_REQUEST, "invalid_limit");
    let limit = match query.as_deref() {
        None | Some("") => LEDGER_MAX,
        Some(query) => query
            .strip_prefix("limit=")
            .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(invalid)?,
    };
    if limit == 0 || limit > LEDGER_MAX {
        return Err(invalid());
    }
    let events = api.store.ledger_tail(&principal, limit).await?;
    let timeline = events
        .iter()
        .filter_map(|event| serde_json::from_value(event.clone()).ok())
        .collect::<Vec<_>>();
    let kinds = api
        .store
        .surfaces(&principal)
        .await?
        .iter()
        .map(|surface| {
            (
                surface.surface_id,
                crate::ambiance::account::kind(&surface.binding),
            )
        })
        .collect();
    let now = crate::surface_registry::now_ms();
    let turn = crate::ambiance::account::accountable(&timeline, Uuid::nil(), now);
    let account = crate::ambiance::account::compose(
        turn.as_ref(),
        &kinds,
        crate::ambiance::account::Language::English,
        now,
    );
    Ok(Json(json!({"events": events, "account": account})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinApproval {
    device_id: String,
    approval: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeApproval {
    enrollment_id: Uuid,
    public_key: String,
    platform: String,
    approval: String,
    expected_revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeRevocation {
    expected_revision: u64,
}

/// Liveness for the owner's device list. It is read from the runtime's own
/// connection state, never from a claim by the installation.
async fn native_presence(api: &ApiState, principal: &str, surface_id: Uuid) -> (bool, bool, bool) {
    match api
        .store
        .runtime(
            principal,
            crate::ambiance::RuntimeOperation::NativePresence { surface_id },
        )
        .await
    {
        Ok(crate::ambiance::RuntimeResult::NativePresence {
            connected,
            visible,
            private_display,
        }) => (connected, visible, private_display),
        _ => (false, false, false),
    }
}

async fn list_native(
    State(api): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let mut native = Vec::new();
    for surface in api
        .store
        .surfaces(&principal)
        .await?
        .into_iter()
        .filter(|surface| matches!(surface.binding, surface_registry::Binding::Native { .. }))
    {
        let view = surface.native_view()?;
        let (connected, visible, private_display) =
            native_presence(&api, &principal, view.surface_id).await;
        let mut row = serde_json::to_value(view)
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?;
        row["connected"] = json!(connected);
        row["visible"] = json!(visible);
        row["privateDisplay"] = json!(private_display);
        native.push(row);
    }
    Ok(Json(json!({"native": native})))
}

async fn approve_native(
    State(api): State<ApiState>,
    headers: HeaderMap,
    request: Result<Json<NativeApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request = body(request)?;
    if request.approval != surface_registry::NATIVE_APPROVAL
        || request.expected_revision >= surface_registry::MAX_NATIVE_REVISION
        || request.enrollment_id.is_nil()
        || !surface_registry::native_platform(&request.platform)
    {
        return Err(invalid());
    }
    crate::ambiance::native_connection::validate_public_key(&request.public_key)
        .map_err(|_| invalid())?;
    let surface_id = surface_registry::native_surface_id(&principal, request.enrollment_id);
    let surface = api
        .store
        .mutate_surface(
            &principal,
            surface_id,
            Mutation::ApproveNative {
                enrollment_id: request.enrollment_id,
                public_key: request.public_key,
                platform: request.platform,
                expected_revision: request.expected_revision,
            },
        )
        .await?;
    Ok(Json(json!({"native": surface.native_view()?})))
}

async fn native_enrollment(
    State(api): State<ApiState>,
    Path(enrollment_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let enrollment_id = id(&enrollment_id)?;
    let location = api
        .store
        .native_location(enrollment_id)
        .await?
        .filter(|location| location.principal == principal)
        .ok_or(RegistryError::NotFound)?;
    let surface = api
        .store
        .surface(&principal, location.surface_id)
        .await?
        .ok_or(RegistryError::NotFound)?;
    let native = surface.native_view()?;
    if native.enrollment_id != enrollment_id {
        return Err(RegistryError::NotFound.into());
    }
    Ok(Json(json!({"native": native})))
}

async fn revoke_native(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<NativeRevocation>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let request = body(request)?;
    if request.expected_revision >= surface_registry::MAX_NATIVE_REVISION {
        return Err(invalid());
    }
    let surface = api
        .store
        .mutate_surface(
            &principal,
            id(&surface_id)?,
            Mutation::RevokeNative {
                expected_revision: request.expected_revision,
            },
        )
        .await?;
    Ok(Json(json!({"native": surface.native_view()?})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisclosureApproval {
    approval: String,
    approval_revision: u64,
    expected_revision: u64,
    #[serde(deserialize_with = "required_policy")]
    policy: Option<crate::ambiance::disclosure::Policy>,
}

fn required_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::disclosure::Policy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateDisplayApproval {
    approval: String,
    approval_revision: u64,
    expected_revision: u64,
    #[serde(deserialize_with = "required_private_policy")]
    policy: Option<crate::ambiance::personal::Policy>,
}

fn required_private_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::personal::Policy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScreenContextApproval {
    approval: String,
    approval_revision: u64,
    expected_revision: u64,
    #[serde(deserialize_with = "required_screen_policy")]
    policy: Option<crate::ambiance::screen::Policy>,
}

fn required_screen_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::screen::Policy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeVoiceApproval {
    approval: String,
    approval_revision: u64,
    expected_revision: u64,
    #[serde(deserialize_with = "required_native_voice_policy")]
    policy: Option<crate::ambiance::native_voice::Policy>,
}

fn required_native_voice_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::native_voice::Policy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceActionApproval {
    approval: String,
    approval_revision: u64,
    expected_revision: u64,
    #[serde(deserialize_with = "required_action_policy")]
    policy: Option<crate::ambiance::action::Policy>,
}

fn required_action_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::action::Policy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceCommandApproval {
    approval: String,
    approval_revision: u64,
    expected_revision: u64,
    #[serde(deserialize_with = "required_command_policy")]
    policy: Option<crate::ambiance::action::CommandPolicy>,
}

fn required_command_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::action::CommandPolicy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

const LOCAL_VOICE_APPROVAL: &str = "approve-local-voice-intake-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LookupApproval {
    approval: String,
    approval_revision: u64,
    #[serde(deserialize_with = "required_lookup_incarnation")]
    approval_incarnation: Option<Uuid>,
    expected_revision: u64,
    #[serde(deserialize_with = "required_lookup_policy")]
    policy: Option<crate::ambiance::lookup::Policy>,
}

fn required_lookup_incarnation<'de, D>(deserializer: D) -> Result<Option<Uuid>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

fn required_lookup_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::lookup::Policy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

async fn lookup_policy(
    State(api): State<ApiState>,
    Extension(service): Extension<LookupService>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::LookupPolicy {
                service,
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::LookupPolicy { approval, binding } = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({
        "approval": approval,
        "binding": binding,
        "providers": api.lookup_providers(service),
    })))
}

async fn set_lookup_policy(
    State(api): State<ApiState>,
    Extension(service): Extension<LookupService>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<LookupApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != crate::ambiance::lookup::owner_approval(service) {
        return Err(invalid());
    }
    let providers = api.lookup_providers(service);
    if let Some(policy) = &request.policy {
        // The owner approves the exact displayed destination and request
        // profile. A provider key or an old configuration is not that grant.
        if policy.provider.provider.service() != service || !providers.contains(&policy.provider) {
            return Err(ApiError(StatusCode::CONFLICT, "provider_changed"));
        }
        let current = api
            .store
            .surface(&principal, surface_id)
            .await?
            .filter(|surface| !surface.revoked)
            .ok_or(RegistryError::NotFound)?;
        if let surface_registry::Binding::Pin { device_id } = current.binding {
            crate::pin_admission::paired_owner(api.pairing.as_ref(), &principal, &device_id)
                .await?;
        }
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetLookupPolicy {
                service,
                surface_id,
                approval_revision: request.approval_revision,
                approval_incarnation: request.approval_incarnation,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::LookupPolicy { approval, binding } = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(
        json!({"approval": approval, "providers": providers, "binding": binding}),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceApproval {
    approval: String,
    approval_revision: u64,
    expected_revision: u64,
    #[serde(deserialize_with = "required_voice_policy")]
    policy: Option<crate::ambiance::voice::Policy>,
}

fn required_voice_policy<'de, D>(
    deserializer: D,
) -> Result<Option<crate::ambiance::voice::Policy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

async fn voice_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::VoicePolicy {
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::VoicePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn set_voice_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<VoiceApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != LOCAL_VOICE_APPROVAL {
        return Err(invalid());
    }
    // Only the currently paired owner can grant local capture. Revocation
    // stays available after pairing loss, independent of provider permission.
    if request.policy.is_some() {
        let current = api
            .store
            .surface(&principal, surface_id)
            .await?
            .ok_or(RegistryError::NotFound)?;
        let surface_registry::Binding::Pin { device_id } = current.binding else {
            return Err(RegistryError::NotFound.into());
        };
        crate::pin_admission::paired_owner(api.pairing.as_ref(), &principal, &device_id).await?;
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetVoicePolicy {
                surface_id,
                approval_revision: request.approval_revision,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::VoicePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn disclosure_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::DisclosurePolicy {
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::DisclosurePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn set_disclosure_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<DisclosureApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != crate::ambiance::disclosure::OWNER_APPROVAL {
        return Err(invalid());
    }
    // Revoke remains possible after pairing loss. Creating or changing a Pin
    // grant requires the currently paired owner as well as this verified
    // bearer; a native installation's grant binds to its owner approval.
    if request.policy.is_some() {
        let current = api
            .store
            .surface(&principal, surface_id)
            .await?
            .ok_or(RegistryError::NotFound)?;
        match current.binding {
            surface_registry::Binding::Pin { device_id } => {
                crate::pin_admission::paired_owner(api.pairing.as_ref(), &principal, &device_id)
                    .await?;
            }
            surface_registry::Binding::Native { .. } => {}
            surface_registry::Binding::Browser => return Err(RegistryError::NotFound.into()),
        }
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetDisclosurePolicy {
                surface_id,
                approval_revision: request.approval_revision,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::DisclosurePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn private_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::PrivatePolicy {
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::PrivatePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

/// The owner's statement that one native installation may show private
/// replies while the owner is present and it is unlocked. It binds to the
/// installation's current approval revision; a TV is never eligible.
async fn set_private_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<PrivateDisplayApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != crate::ambiance::personal::OWNER_APPROVAL {
        return Err(invalid());
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetPrivatePolicy {
                surface_id,
                approval_revision: request.approval_revision,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::PrivatePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn screen_context_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::ScreenContextPolicy {
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::ScreenContextPolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

/// The owner's statement that one native installation's own screen text may
/// be offered to cognition with a request. The reply is private and can be
/// shown only on a personal surface; the permission binds to the
/// installation's current approval revision.
async fn set_screen_context_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<ScreenContextApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != crate::ambiance::screen::OWNER_APPROVAL {
        return Err(invalid());
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetScreenContextPolicy {
                surface_id,
                approval_revision: request.approval_revision,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::ScreenContextPolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn native_voice_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::NativeVoicePolicy {
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::NativeVoicePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

/// The owner's statement that one native installation may be spoken to, and
/// the class its speech is admitted at. The floor is never below `shared_room`
/// — an unknown actor in a room of unknown occupancy does not establish public
/// capture — and never above what that installation's own personal
/// declaration allows, so a shared screen cannot be given a private ear.
async fn set_native_voice_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<NativeVoiceApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != crate::ambiance::native_voice::OWNER_APPROVAL {
        return Err(invalid());
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetNativeVoicePolicy {
                surface_id,
                approval_revision: request.approval_revision,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::NativeVoicePolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn device_action_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::DeviceActionPolicy {
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::DeviceActionPolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

/// The owner's statement of what one native installation may be asked to do.
/// An operation its approved manifest does not declare is not writable here,
/// and the class is capped by that installation's own private-display
/// ceiling: an action permission spends a posture, it never raises one.
async fn set_device_action_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<DeviceActionApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != crate::ambiance::action::OWNER_APPROVAL {
        return Err(invalid());
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetDeviceActionPolicy {
                surface_id,
                approval_revision: request.approval_revision,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::DeviceActionPolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

async fn device_command_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::DeviceCommandPolicy {
                surface_id: id(&surface_id)?,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::DeviceCommandPolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
}

/// The commands the owner authored for one installation. There are no
/// parameters and no shell string: argv is fixed here, once, by a person.
async fn set_device_command_policy(
    State(api): State<ApiState>,
    Path(surface_id): Path<String>,
    headers: HeaderMap,
    request: Result<Json<DeviceCommandApproval>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let principal = owner(&headers, &api)?;
    let surface_id = id(&surface_id)?;
    let request = body(request)?;
    if request.approval != crate::ambiance::action::COMMAND_OWNER_APPROVAL {
        return Err(invalid());
    }
    let result = api
        .store
        .runtime(
            &principal,
            crate::ambiance::RuntimeOperation::SetDeviceCommandPolicy {
                surface_id,
                approval_revision: request.approval_revision,
                expected_revision: request.expected_revision,
                policy: request.policy,
            },
        )
        .await?;
    let crate::ambiance::RuntimeResult::DeviceCommandPolicy(approval) = result else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "unavailable"));
    };
    Ok(Json(json!({"approval": approval})))
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
    mod lookup_tests {
        include!("surface_lookup_tests.rs");
    }
    use super::*;
    use axum::{body::Body, http::Request};
    use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header};
    use tower::ServiceExt;

    fn native_approval(enrollment_id: Uuid) -> serde_json::Value {
        json!({
            "enrollmentId": enrollment_id,
            "publicKey": "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
            "platform": "macos",
            "approval": surface_registry::NATIVE_APPROVAL,
            "expectedRevision": 0
        })
    }

    #[tokio::test]
    async fn native_registry_http_owner_isolation_retries_and_revoked_lookup() {
        let store = Arc::new(crate::store::MemoryStore::default());
        let app = with_pairing(store, Some(verifier()), None);
        let owner = bearer("owner");
        let other = bearer("other");
        let root = "/surface-api/v1/native";
        let enrollment = Uuid::new_v4();
        let approval = native_approval(enrollment);
        let lookup = format!("{root}/enrollments/{enrollment}");
        let (status, approved) =
            call(&app, "POST", root, Some(&owner), None, approval.clone()).await;
        assert_eq!(status, StatusCode::OK);
        let expected_id = surface_registry::native_surface_id("U:owner", enrollment);
        assert_eq!(approved["native"]["surfaceId"], expected_id.to_string());
        assert_eq!(approved["native"]["revision"], 1);
        assert_eq!(approved["native"]["actorIdentity"], "unknown");
        assert_eq!(approved["native"]["trustLevel"], 0);
        assert_eq!(approved["native"]["renderVerified"], false);
        assert_eq!(approved["native"]["playbackVerified"], false);
        assert!(approved["native"].get("publicKey").is_none());
        assert!(approved.get("connection").is_none());
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, approval.clone()).await,
            (StatusCode::OK, approved.clone())
        );
        assert_eq!(
            call(&app, "GET", &lookup, Some(&owner), None, json!(null)).await,
            (StatusCode::OK, approved.clone())
        );
        let path = format!("{root}/{expected_id}");
        for (method, path, body) in [
            ("GET", lookup.as_str(), json!(null)),
            ("DELETE", path.as_str(), json!({"expectedRevision":1})),
        ] {
            assert_eq!(
                call(&app, method, path, Some(&other), None, body).await.0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            call(&app, "GET", root, Some(&other), None, json!(null))
                .await
                .1,
            json!({"native":[]})
        );
        assert_eq!(
            call(&app, "POST", root, Some(&other), None, approval.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        for profile in ["surfaces", "pins"] {
            let profile_root = format!("/surface-api/v1/{profile}");
            assert_eq!(
                call(&app, "GET", &profile_root, Some(&owner), None, json!(null))
                    .await
                    .1[profile],
                json!([])
            );
            assert_eq!(
                call(
                    &app,
                    "DELETE",
                    &format!("{profile_root}/{expected_id}"),
                    Some(&owner),
                    None,
                    json!(null)
                )
                .await
                .0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            call(
                &app,
                "DELETE",
                &path,
                Some(&owner),
                None,
                json!({"expectedRevision":0})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let (status, revoked) = call(
            &app,
            "DELETE",
            &path,
            Some(&owner),
            None,
            json!({"expectedRevision":1}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["native"]["revision"], 2);
        assert_eq!(revoked["native"]["revoked"], true);
        assert_eq!(
            call(
                &app,
                "DELETE",
                &path,
                Some(&owner),
                None,
                json!({"expectedRevision":1})
            )
            .await,
            (StatusCode::OK, revoked.clone())
        );
        assert_eq!(
            call(&app, "GET", root, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"native":[]})
        );
        assert_eq!(
            call(&app, "GET", &lookup, Some(&owner), None, json!(null)).await,
            (StatusCode::OK, revoked)
        );
        assert_eq!(
            call(&app, "GET", &lookup, Some(&other), None, json!(null))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, approval.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        let mut reapproval = approval.clone();
        reapproval["expectedRevision"] = 2.into();
        let (status, reapproved) =
            call(&app, "POST", root, Some(&owner), None, reapproval.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reapproved["native"]["revision"], 3);
        assert_eq!(reapproved["native"]["revoked"], false);
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, reapproval).await,
            (StatusCode::OK, reapproved.clone())
        );
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, approval)
                .await
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &app,
                "DELETE",
                &path,
                Some(&owner),
                None,
                json!({"expectedRevision":1})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(&app, "GET", &lookup, Some(&owner), None, json!(null))
                .await
                .1,
            reapproved
        );
    }

    #[tokio::test]
    async fn native_registry_http_strict_descriptor_and_verified_owner_only() {
        let app = with_pairing(
            Arc::new(crate::store::MemoryStore::default()),
            Some(verifier()),
            None,
        );
        let owner = bearer("owner");
        let root = "/surface-api/v1/native";
        let enrollment = Uuid::new_v4();
        let approval = native_approval(enrollment);
        let path = format!(
            "{root}/{}",
            surface_registry::native_surface_id("U:owner", enrollment)
        );
        let lookup = format!("{root}/enrollments/{enrollment}");
        for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
            for (method, path, body) in [
                ("POST", root, approval.clone()),
                ("GET", root, json!(null)),
                ("GET", lookup.as_str(), json!(null)),
                ("DELETE", path.as_str(), json!({"expectedRevision":1})),
            ] {
                assert_eq!(
                    call(&app, method, path, authorization, None, body).await.0,
                    StatusCode::UNAUTHORIZED
                );
            }
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
        for field in [
            "enrollmentId",
            "publicKey",
            "platform",
            "approval",
            "expectedRevision",
        ] {
            let mut missing = approval.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert_eq!(
                call(&app, "POST", root, Some(&owner), None, missing)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        for (field, value) in [
            ("enrollmentId", json!(Uuid::nil())),
            ("publicKey", json!("not-a-key")),
            (
                "publicKey",
                json!(format!("{}=", approval["publicKey"].as_str().unwrap())),
            ),
            ("platform", json!("ios")),
            ("approval", json!(surface_registry::BROWSER_APPROVAL)),
            ("expectedRevision", json!(-1)),
            (
                "expectedRevision",
                json!(surface_registry::MAX_NATIVE_REVISION),
            ),
            ("manifest", json!({})),
            ("principal", json!("U:other")),
            ("surfaceId", json!(Uuid::new_v4())),
            ("trustLevel", json!(5)),
            ("occupancy", json!("private")),
            ("actorIdentity", json!("owner")),
        ] {
            let mut invalid = approval.clone();
            invalid[field] = value;
            assert_eq!(
                call(&app, "POST", root, Some(&owner), None, invalid)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            call(&app, "GET", root, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"native":[]})
        );
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, approval.clone())
                .await
                .0,
            StatusCode::OK
        );
        for body in [
            json!({}),
            json!({"expectedRevision":1, "principal":"U:other"}),
            json!({"expectedRevision":-1}),
        ] {
            assert_eq!(
                call(&app, "DELETE", &path, Some(&owner), None, body)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let mut changed = approval;
        changed["platform"] = "linux".into();
        changed["expectedRevision"] = 1.into();
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, changed)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let browser = Uuid::new_v4();
        assert_eq!(
            call(
                &app,
                "POST",
                "/surface-api/v1/surfaces",
                Some(&owner),
                None,
                json!({"surfaceId": browser, "approval":surface_registry::BROWSER_APPROVAL})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("{root}/{browser}"),
                Some(&owner),
                None,
                json!({"expectedRevision":1})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }

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

    #[tokio::test]
    async fn ambiance_disclosure_http_owner_isolation_schema_cas_and_revocation() {
        use crate::enrollment::EnrollmentStore;
        let store = Arc::new(crate::store::MemoryStore::default());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let app = with_pairing(store, Some(verifier()), Some(pairing.clone()));
        let owner = bearer("owner");
        let other = bearer("other");
        let root = "/surface-api/v1/pins";
        let pin = json!({"deviceId":"aabb", "approval":surface_registry::PIN_APPROVAL});
        let (status, approved) = call(&app, "POST", root, Some(&owner), None, pin.clone()).await;
        assert_eq!(status, StatusCode::OK);
        let surface = approved["pin"]["surfaceId"].as_str().unwrap();
        let path = format!("/surface-api/v1/surfaces/{surface}/speech-disclosure");
        let grant = json!({
            "approval":crate::ambiance::disclosure::OWNER_APPROVAL,
            "approvalRevision":1,"expectedRevision":0,
            "policy":{"provider":{"provider":"azure_speech","region":"westeurope"},
                "maximumClass":"shared_room","transcription":false,"synthesis":true}
        });
        for authorization in [None, Some("Bearer invalid")] {
            for method in ["GET", "POST"] {
                assert_eq!(
                    call(&app, method, &path, authorization, None, grant.clone())
                        .await
                        .0,
                    StatusCode::UNAUTHORIZED
                );
            }
        }
        for method in ["GET", "POST"] {
            assert_eq!(
                call(&app, method, &path, Some(&other), None, grant.clone())
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval":null})
        );
        let mut missing = grant.clone();
        missing.as_object_mut().unwrap().remove("policy");
        let mut extra = grant.clone();
        extra["principal"] = "other".into();
        let mut region = grant.clone();
        region["policy"]["provider"]["region"] = "x".repeat(33).into();
        let mut nested = grant.clone();
        nested["policy"]["provider"]["endpoint"] = "https://invalid.test".into();
        let mut no_purpose = grant.clone();
        no_purpose["policy"]["synthesis"] = false.into();
        let mut wrong = grant.clone();
        wrong["approval"] = "approve".into();
        let mut oversized = grant.clone();
        oversized["approval"] = "x".repeat(2048).into();
        for invalid in [missing, extra, region, nested, no_purpose, wrong, oversized] {
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, invalid)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let (status, saved) = call(&app, "POST", &path, Some(&owner), None, grant.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            saved,
            json!({"approval":{"approvalRevision":1,"revision":1,"policy":grant["policy"]}})
        );
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            saved
        );
        pairing.put_device_account("aabb", "other").await.unwrap();
        let mut update = grant.clone();
        update["expectedRevision"] = 1.into();
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, update.clone())
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        update["policy"] = serde_json::Value::Null;
        let (status, revoked) = call(&app, "POST", &path, Some(&owner), None, update.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["approval"]["revision"], 2);
        assert!(revoked["approval"]["policy"].is_null());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        // Reapproval is a new authority revision; the old policy cannot survive.
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, pin).await.0,
            StatusCode::OK
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval":null})
        );
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        let mut new_grant = grant;
        new_grant["approvalRevision"] = 2.into();
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, new_grant)
                .await
                .0,
            StatusCode::OK
        );
    }

    /// The two device-action permissions are native-only statements about one
    /// installation, bound to its approval revision, with their own raised
    /// body limits and the same compare-and-swap shape as every other one.
    #[tokio::test]
    async fn ambiance_device_action_http_routes_bounds_and_revisions() {
        let store = Arc::new(crate::store::MemoryStore::default());
        let app = with_pairing(store, Some(verifier()), None);
        let owner = bearer("owner");
        let other = bearer("other");
        let approve = |platform: &'static str| {
            let mut descriptor = native_approval(Uuid::new_v4());
            descriptor["platform"] = platform.into();
            descriptor
        };
        let (status, mac) = call(
            &app,
            "POST",
            "/surface-api/v1/native",
            Some(&owner),
            None,
            approve("macos"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mac = mac["native"]["surfaceId"].as_str().unwrap().to_owned();
        let (status, tv) = call(
            &app,
            "POST",
            "/surface-api/v1/native",
            Some(&owner),
            None,
            approve("android_tv"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let tv = tv["native"]["surfaceId"].as_str().unwrap().to_owned();
        let actions = format!("/surface-api/v1/surfaces/{mac}/device-actions");
        let commands = format!("/surface-api/v1/surfaces/{mac}/device-commands");
        let grant = json!({
            "approval": crate::ambiance::action::OWNER_APPROVAL,
            "approvalRevision": 1, "expectedRevision": 0,
            "policy": {"maximumClass": "shared_room",
                "open": {"hosts": ["github.com"], "apps": [], "roots": []}}
        });
        let entries = json!({
            "approval": crate::ambiance::action::COMMAND_OWNER_APPROVAL,
            "approvalRevision": 1, "expectedRevision": 0,
            "policy": {"maximumClass": "shared_room", "offerOutputToCognition": false,
                "entries": [{"id": "project-tests", "label": "Project tests",
                    "argv": ["./revival", "check", "cosmos"],
                    "cwd": "/Users/owner/Projects", "mutates": true, "budgetMs": 900000}]}
        });
        for (path, body) in [(&actions, &grant), (&commands, &entries)] {
            for authorization in [None, Some("Bearer invalid")] {
                for method in ["GET", "POST"] {
                    assert_eq!(
                        call(&app, method, path, authorization, None, body.clone())
                            .await
                            .0,
                        StatusCode::UNAUTHORIZED
                    );
                }
            }
            for method in ["GET", "POST"] {
                assert_eq!(
                    call(&app, method, path, Some(&other), None, body.clone())
                        .await
                        .0,
                    StatusCode::NOT_FOUND
                );
            }
            assert_eq!(
                call(&app, "GET", path, Some(&owner), None, json!(null))
                    .await
                    .1,
                json!({"approval": null})
            );
        }
        let mut wrong = grant.clone();
        wrong["approval"] = crate::ambiance::screen::OWNER_APPROVAL.into();
        let mut extra = grant.clone();
        extra["policy"]["run"] = json!({"entries": []});
        let mut empty = grant.clone();
        empty["policy"] = json!({"maximumClass": "shared_room"});
        for invalid in [wrong, extra, empty] {
            assert_eq!(
                call(&app, "POST", &actions, Some(&owner), None, invalid)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        // A television declares no `action.open` and never holds one.
        let tv_actions = format!("/surface-api/v1/surfaces/{tv}/device-actions");
        assert_eq!(
            call(&app, "POST", &tv_actions, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let tv_commands = format!("/surface-api/v1/surfaces/{tv}/device-commands");
        assert_eq!(
            call(
                &app,
                "POST",
                &tv_commands,
                Some(&owner),
                None,
                entries.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        // Above the shared ceiling without a personal declaration is refused.
        let mut private = grant.clone();
        private["policy"]["maximumClass"] = "private".into();
        assert_eq!(
            call(&app, "POST", &actions, Some(&owner), None, private)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (status, saved) = call(&app, "POST", &actions, Some(&owner), None, grant.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(saved["approval"]["revision"], 1);
        // Compare-and-swap: the same write twice is a conflict.
        assert_eq!(
            call(&app, "POST", &actions, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        let (status, saved) = call(&app, "POST", &commands, Some(&owner), None, entries).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            saved["approval"]["policy"]["entries"][0]["id"],
            "project-tests"
        );
        // Each route raises the owner body limit only as far as its own
        // maximum policy needs: a full host, application and root list does
        // not fit the 1024-byte owner limit, and a full command entry list
        // does not fit the action route's 2048.
        let mut full = grant.clone();
        full["approvalRevision"] = 1.into();
        full["expectedRevision"] = 1.into();
        full["policy"]["open"] = json!({
            "hosts": (0..16).map(|i| format!("h{i:02}.example.com")).collect::<Vec<_>>(),
            "apps": (0..8).map(|i| json!({"id": format!("com.example.app{i}"), "label": format!("App {i}")})).collect::<Vec<_>>(),
            "roots": (0..4).map(|i| json!({"id": format!("root{i}"), "label": format!("Root {i}"), "path": format!("/Users/owner/Projects/root{i}")})).collect::<Vec<_>>()
        });
        assert!(serde_json::to_vec(&full).unwrap().len() > 1024);
        assert!(serde_json::to_vec(&full).unwrap().len() <= 2048);
        assert_eq!(
            call(&app, "POST", &actions, Some(&owner), None, full)
                .await
                .0,
            StatusCode::OK
        );
        let mut many = json!({
            "approval": crate::ambiance::action::COMMAND_OWNER_APPROVAL,
            "approvalRevision": 1, "expectedRevision": 1,
            "policy": {"maximumClass": "shared_room", "offerOutputToCognition": false,
                "entries": (0..8).map(|i| json!({
                    "id": format!("task-{i}"), "label": format!("Task {i}"),
                    "argv": ["./revival", "check", "cosmos", "--filter",
                        "ambiance_device_action_digest_matches_the_canonical_tuple",
                        "--include-ignored", "--no-capture", "--locked"],
                    "cwd": "/Users/owner/Documents/GitHub/ai-pin-revival",
                    "mutates": false, "budgetMs": 900000
                })).collect::<Vec<_>>()}
        });
        assert!(serde_json::to_vec(&many).unwrap().len() > 2048);
        assert!(serde_json::to_vec(&many).unwrap().len() <= 4096);
        assert_eq!(
            call(&app, "POST", &commands, Some(&owner), None, many.clone())
                .await
                .0,
            StatusCode::OK
        );
        many["policy"]["entries"] = json!([]);
        assert_eq!(
            call(&app, "POST", &commands, Some(&owner), None, many)
                .await
                .0,
            StatusCode::CONFLICT
        );
    }

    /// The owner's ledger read is theirs alone, bounded, and content-free: it
    /// is the only way Center can say where a reply went, and it must never
    /// become a way to read what was asked.
    #[tokio::test]
    async fn ambiance_ledger_http_is_owner_only_bounded_and_content_free() {
        use crate::enrollment::EnrollmentStore;
        let store = Arc::new(crate::store::MemoryStore::default());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let app = with_pairing(store, Some(verifier()), Some(pairing));
        let owner = bearer("owner");
        for authorization in [None, Some("Bearer invalid")] {
            assert_eq!(
                call(
                    &app,
                    "GET",
                    "/surface-api/v1/ledger",
                    authorization,
                    None,
                    json!(null)
                )
                .await
                .0,
                StatusCode::UNAUTHORIZED
            );
        }
        for limit in ["0", "301", "-1", "many"] {
            assert_eq!(
                call(
                    &app,
                    "GET",
                    &format!("/surface-api/v1/ledger?limit={limit}"),
                    Some(&owner),
                    None,
                    json!(null)
                )
                .await
                .0,
                StatusCode::BAD_REQUEST,
                "{limit}"
            );
        }
        assert_eq!(
            call(
                &app,
                "GET",
                "/surface-api/v1/ledger?until=now",
                Some(&owner),
                None,
                json!(null)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        // An owner with no history reads an empty chain, never an error.
        let (status, body) = call(
            &app,
            "GET",
            "/surface-api/v1/ledger",
            Some(&owner),
            None,
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["events"], json!([]));
        assert_eq!(
            body["account"],
            "Nothing to account for\n\nNo routing decision is available in the recent history."
        );
        // Approving a device writes to the chain; the owner reads exactly their
        // own events, oldest first, and another owner reads none of them.
        let enrollment = Uuid::new_v4();
        assert_eq!(
            call(
                &app,
                "POST",
                "/surface-api/v1/native",
                Some(&owner),
                None,
                native_approval(enrollment)
            )
            .await
            .0,
            StatusCode::OK
        );
        let (status, body) = call(
            &app,
            "GET",
            "/surface-api/v1/ledger?limit=50",
            Some(&owner),
            None,
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let events = body["events"].as_array().unwrap();
        assert!(!events.is_empty());
        let mut sequence = 0;
        for event in events {
            let next = event["sequence"].as_u64().unwrap();
            assert!(next > sequence, "oldest first");
            sequence = next;
            assert_eq!(event["principal"], "U:owner");
        }
        assert_eq!(
            call(
                &app,
                "GET",
                "/surface-api/v1/ledger",
                Some(&bearer("other")),
                None,
                json!(null)
            )
            .await
            .1["events"],
            json!([])
        );
    }

    /// The owner's screen-context permission is one owner statement about
    /// one installation, bound to its approval revision: strict body,
    /// exactly one policy class, compare-and-swap revisions, owner isolation,
    /// and loss on revocation or reapproval.
    #[tokio::test]
    async fn ambiance_screen_context_http_native_only_schema_cas_and_revocation() {
        use crate::enrollment::EnrollmentStore;
        let store = Arc::new(crate::store::MemoryStore::default());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let app = with_pairing(store, Some(verifier()), Some(pairing));
        let owner = bearer("owner");
        let other = bearer("other");
        let enrollment = Uuid::new_v4();
        let (status, approved) = call(
            &app,
            "POST",
            "/surface-api/v1/native",
            Some(&owner),
            None,
            native_approval(enrollment),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let surface = approved["native"]["surfaceId"].as_str().unwrap().to_owned();
        let path = format!("/surface-api/v1/surfaces/{surface}/screen-context");
        let grant = json!({
            "approval": crate::ambiance::screen::OWNER_APPROVAL,
            "approvalRevision": 1, "expectedRevision": 0,
            "policy": {"maximumClass": "private"}
        });
        for authorization in [None, Some("Bearer invalid")] {
            for method in ["GET", "POST"] {
                assert_eq!(
                    call(&app, method, &path, authorization, None, grant.clone())
                        .await
                        .0,
                    StatusCode::UNAUTHORIZED
                );
            }
        }
        for method in ["GET", "POST"] {
            assert_eq!(
                call(&app, method, &path, Some(&other), None, grant.clone())
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval": null})
        );
        // A Pin is not a native installation and never holds this permission.
        let (status, pin) = call(
            &app,
            "POST",
            "/surface-api/v1/pins",
            Some(&owner),
            None,
            json!({"deviceId": "aabb", "approval": surface_registry::PIN_APPROVAL}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let pin_path = format!(
            "/surface-api/v1/surfaces/{}/screen-context",
            pin["pin"]["surfaceId"].as_str().unwrap()
        );
        for method in ["GET", "POST"] {
            assert_eq!(
                call(&app, method, &pin_path, Some(&owner), None, grant.clone())
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
        }
        let mut missing = grant.clone();
        missing.as_object_mut().unwrap().remove("policy");
        let mut extra = grant.clone();
        extra["principal"] = "other".into();
        let mut shared = grant.clone();
        shared["policy"]["maximumClass"] = "shared_room".into();
        let mut near = grant.clone();
        near["policy"]["maximumClass"] = "near_user".into();
        let mut sensitive = grant.clone();
        sensitive["policy"]["maximumClass"] = "sensitive".into();
        let mut nested = grant.clone();
        nested["policy"]["apps"] = json!(["Settings"]);
        let mut wrong = grant.clone();
        wrong["approval"] = crate::ambiance::personal::OWNER_APPROVAL.into();
        let mut oversized = grant.clone();
        oversized["approval"] = "x".repeat(2048).into();
        for invalid in [
            missing, extra, shared, near, sensitive, nested, wrong, oversized,
        ] {
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, invalid)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let (status, saved) = call(&app, "POST", &path, Some(&owner), None, grant.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            saved,
            json!({"approval": {"approvalRevision": 1, "revision": 1, "policy": {"maximumClass": "private"}}})
        );
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        let mut stale = grant.clone();
        stale["approvalRevision"] = 2.into();
        stale["expectedRevision"] = 1.into();
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, stale).await.0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            saved
        );
        // The private-display permission is a separate statement; neither
        // implies the other.
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/surface-api/v1/surfaces/{surface}/private-display"),
                Some(&owner),
                None,
                json!(null)
            )
            .await
            .1,
            json!({"approval": null})
        );
        let mut revoke = grant.clone();
        revoke["expectedRevision"] = 1.into();
        revoke["policy"] = serde_json::Value::Null;
        let (status, revoked) = call(&app, "POST", &path, Some(&owner), None, revoke).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["approval"]["revision"], 2);
        assert!(revoked["approval"]["policy"].is_null());
        let mut regrant = grant.clone();
        regrant["expectedRevision"] = 2.into();
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, regrant)
                .await
                .0,
            StatusCode::OK
        );
        // Revoking the installation drops the permission with it, and the
        // reapproved installation starts without one at its new revision.
        assert_eq!(
            call(
                &app,
                "DELETE",
                &format!("/surface-api/v1/native/{surface}"),
                Some(&owner),
                None,
                json!({"expectedRevision": 1})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let mut reapproval = native_approval(enrollment);
        reapproval["expectedRevision"] = 2.into();
        let (status, reapproved) = call(
            &app,
            "POST",
            "/surface-api/v1/native",
            Some(&owner),
            None,
            reapproval,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reapproved["native"]["revision"], 3);
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval": null})
        );
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::CONFLICT,
            "a grant for the old revision is stale"
        );
        let mut current = grant;
        current["approvalRevision"] = 3.into();
        let (status, saved) = call(&app, "POST", &path, Some(&owner), None, current).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            saved,
            json!({"approval": {"approvalRevision": 3, "revision": 1, "policy": {"maximumClass": "private"}}})
        );
    }

    #[tokio::test]
    async fn ambiance_voice_http_separate_owner_permission_schema_cas_and_revocation() {
        use crate::enrollment::EnrollmentStore;
        let store = Arc::new(crate::store::MemoryStore::default());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let app = with_pairing(store, Some(verifier()), Some(pairing.clone()));
        let owner = bearer("owner");
        let other = bearer("other");
        let root = "/surface-api/v1/pins";
        let pin = json!({"deviceId":"aabb", "approval":surface_registry::PIN_APPROVAL});
        let (status, approved) = call(&app, "POST", root, Some(&owner), None, pin.clone()).await;
        assert_eq!(status, StatusCode::OK);
        let surface = approved["pin"]["surfaceId"].as_str().unwrap();
        let path = format!("{root}/{surface}/local-voice");
        let speech_path = format!("/surface-api/v1/surfaces/{surface}/speech-disclosure");
        let grant = json!({
            "approval":LOCAL_VOICE_APPROVAL,
            "approvalRevision":1,"expectedRevision":0,
            "policy":{"sourceFloor":"shared_room"}
        });
        for authorization in [None, Some("Bearer invalid")] {
            for method in ["GET", "POST"] {
                assert_eq!(
                    call(
                        &app,
                        method,
                        &path,
                        authorization,
                        Some(&"a".repeat(64)),
                        grant.clone()
                    )
                    .await
                    .0,
                    StatusCode::UNAUTHORIZED
                );
            }
        }
        for method in ["GET", "POST"] {
            assert_eq!(
                call(&app, method, &path, Some(&other), None, grant.clone())
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval":null})
        );
        let mut missing = grant.clone();
        missing.as_object_mut().unwrap().remove("policy");
        let mut extra = grant.clone();
        extra["principal"] = "other".into();
        let mut floor = grant.clone();
        floor["policy"]["sourceFloor"] = "public".into();
        let mut unknown_floor = grant.clone();
        unknown_floor["policy"]["sourceFloor"] = "trusted".into();
        let mut nested = grant.clone();
        nested["policy"]["cloudUpload"] = true.into();
        let mut wrong = grant.clone();
        wrong["approval"] = crate::ambiance::disclosure::OWNER_APPROVAL.into();
        let mut oversized = grant.clone();
        oversized["approval"] = "x".repeat(2048).into();
        for invalid in [
            missing,
            extra,
            floor,
            unknown_floor,
            nested,
            wrong,
            oversized,
        ] {
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, invalid)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let (status, saved) = call(&app, "POST", &path, Some(&owner), None, grant.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            saved,
            json!({"approval":{"approvalRevision":1,"revision":1,"policy":grant["policy"]}})
        );
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            saved
        );
        // Local intake approval must never create a cloud speech grant.
        assert_eq!(
            call(&app, "GET", &speech_path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval":null})
        );
        pairing.put_device_account("aabb", "other").await.unwrap();
        let mut update = grant.clone();
        update["expectedRevision"] = 1.into();
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, update.clone())
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        update["policy"] = serde_json::Value::Null;
        let (status, revoked) = call(&app, "POST", &path, Some(&owner), None, update).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(revoked["approval"]["revision"], 2);
        assert!(revoked["approval"]["policy"].is_null());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        assert_eq!(
            call(&app, "POST", root, Some(&owner), None, pin).await.0,
            StatusCode::OK
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval":null})
        );
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, grant.clone())
                .await
                .0,
            StatusCode::CONFLICT
        );
        let mut new_grant = grant;
        new_grant["approvalRevision"] = 2.into();
        assert_eq!(
            call(&app, "POST", &path, Some(&owner), None, new_grant)
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
    async fn surface_registry_http_approval_rotation_leave_revoke() {
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
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("{path}/state"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
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
                &format!("{path}/leave"),
                Some(&other),
                Some(token),
                json!({"incarnation":incarnation})
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{path}/leave"),
                Some(&owner),
                Some(token),
                json!({"incarnation":incarnation})
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

    /// The owner's voice-input permission is one owner statement about one
    /// installation: strict body, exactly the published approval name, the
    /// bounded class range, compare-and-swap revisions and owner isolation. A
    /// Pin is not a native installation and has its own local-voice route.
    #[tokio::test]
    async fn ambiance_native_voice_http_native_only_schema_and_class_bounds() {
        use crate::enrollment::EnrollmentStore;
        let store = Arc::new(crate::store::MemoryStore::default());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing.put_device_account("aabb", "owner").await.unwrap();
        let app = with_pairing(store, Some(verifier()), Some(pairing));
        let owner = bearer("owner");
        let other = bearer("other");
        let enrollment = Uuid::new_v4();
        let (status, approved) = call(
            &app,
            "POST",
            "/surface-api/v1/native",
            Some(&owner),
            None,
            native_approval(enrollment),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let surface = approved["native"]["surfaceId"].as_str().unwrap().to_owned();
        let path = format!("/surface-api/v1/surfaces/{surface}/voice-input");
        let allow = |class: &str| {
            json!({
                "approval": crate::ambiance::native_voice::OWNER_APPROVAL,
                "approvalRevision": 1, "expectedRevision": 0,
                "policy": {"sourceFloor": class}
            })
        };
        for authorization in [None, Some("Bearer invalid")] {
            for method in ["GET", "POST"] {
                assert_eq!(
                    call(
                        &app,
                        method,
                        &path,
                        authorization,
                        None,
                        allow("shared_room")
                    )
                    .await
                    .0,
                    StatusCode::UNAUTHORIZED
                );
            }
        }
        for method in ["GET", "POST"] {
            assert_eq!(
                call(
                    &app,
                    method,
                    &path,
                    Some(&other),
                    None,
                    allow("shared_room")
                )
                .await
                .0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            json!({"approval": null})
        );
        // Public is below the floor an unknown actor in an unknown room
        // establishes; near_user and private need a personal declaration this
        // installation does not hold; sensitive is not a routing posture the
        // owner may assert here at all.
        for class in ["public", "near_user", "private", "sensitive"] {
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, allow(class))
                    .await
                    .0,
                StatusCode::BAD_REQUEST,
                "{class}"
            );
        }
        // A body missing the policy key, or naming another approval, is not
        // this owner statement.
        for invalid in [
            json!({"approval": crate::ambiance::native_voice::OWNER_APPROVAL,
                   "approvalRevision": 1, "expectedRevision": 0}),
            json!({"approval": "approve-screen-context-v1",
                   "approvalRevision": 1, "expectedRevision": 0,
                   "policy": {"sourceFloor": "shared_room"}}),
            json!({"approval": crate::ambiance::native_voice::OWNER_APPROVAL,
                   "approvalRevision": 1, "expectedRevision": 0,
                   "policy": {"sourceFloor": "shared_room", "maximumClass": "private"}}),
        ] {
            assert_eq!(
                call(&app, "POST", &path, Some(&owner), None, invalid)
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let (status, granted) = call(
            &app,
            "POST",
            &path,
            Some(&owner),
            None,
            allow("shared_room"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            granted,
            json!({"approval": {"approvalRevision": 1, "revision": 1,
                                "policy": {"sourceFloor": "shared_room"}}})
        );
        assert_eq!(
            call(&app, "GET", &path, Some(&owner), None, json!(null))
                .await
                .1,
            granted
        );
        // Replaying the same write is a conflict, not a second grant.
        assert_eq!(
            call(
                &app,
                "POST",
                &path,
                Some(&owner),
                None,
                allow("shared_room")
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        // A Pin has its own local-voice permission; this route does not know it.
        let (status, pin) = call(
            &app,
            "POST",
            "/surface-api/v1/pins",
            Some(&owner),
            None,
            json!({"deviceId": "aabb", "approval": surface_registry::PIN_APPROVAL}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let pin_path = format!(
            "/surface-api/v1/surfaces/{}/voice-input",
            pin["pin"]["surfaceId"].as_str().unwrap()
        );
        for method in ["GET", "POST"] {
            assert_eq!(
                call(
                    &app,
                    method,
                    &pin_path,
                    Some(&owner),
                    None,
                    allow("shared_room")
                )
                .await
                .0,
                StatusCode::NOT_FOUND
            );
        }
    }
}
