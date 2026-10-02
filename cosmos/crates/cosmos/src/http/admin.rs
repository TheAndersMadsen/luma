//! The operator console: admin-gated overview, provisioning, pairing,
//! device status and the ingestion hooks it drives (`COSMOS_ADMIN_TOKEN`).

use super::*;

/// Gate the operator console behind an operator token.
///
/// These handlers provision devices, release pairings and push to Pins, so
/// they are exactly the "management endpoint reachable without a purpose-scoped
/// credential" that a real HackerOne report against cosmos called out
/// (`webapi.prod.humane.cloud/*/manage/*` served operational data to any
/// authenticated session). Each requires `COSMOS_ADMIN_TOKEN`.
///
/// Fails CLOSED: if no token is configured, mutation is refused entirely rather
/// than left open. A management surface with no credential is the vulnerability,
/// so "not configured" must mean "locked", never "unguarded".
pub(super) fn require_admin(headers: &HeaderMap) -> Result<(), DemoError> {
    let Some(expected) = std::env::var("COSMOS_ADMIN_TOKEN")
        .ok()
        .filter(|token| !token.trim().is_empty())
    else {
        return Err(demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Operator administration is disabled: no COSMOS_ADMIN_TOKEN is configured.",
        ));
    };

    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();

    // Constant-time compare so a token cannot be recovered byte-by-byte from
    // response timing.
    let a = presented.as_bytes();
    let b = expected.as_bytes();
    let equal = a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0;
    if equal {
        Ok(())
    } else {
        Err(demo_error(
            StatusCode::UNAUTHORIZED,
            "A valid admin token is required.",
        ))
    }
}

// ---------------------------------------------------------------------------
// Operator console, onboarding devices and reviewing what the deployment holds.
// Every handler is admin-gated: minting an attestation credential enrolls a
// device. The Pin passcode is each account's own, set by its owner on the web
// plane (`account_api.rs`). The console never sees it.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub(super) struct AdminOverview {
    enrollment: AdminEnrollment,
    persistence: AdminPersistence,
    /// Devices provisioned from this console since the process started.
    provisioned_devices: usize,
    onboarding: AdminOnboarding,
}

#[derive(Serialize)]
struct AdminEnrollment {
    /// INFERRED Luma policy: the durable device allowed on this server.
    provisioned_device_id: Option<String>,
    /// Whether the deployment is admitting new devices.
    open: bool,
    /// Whether a device-attestation credential can be minted here.
    provisioning_configured: bool,
    /// Whether the DeviceUser-issuing CA is loaded, so a binding can complete.
    duc_ca_configured: bool,
    /// Where that verdict came from, in one short constant.
    ///
    /// The flag alone was a lie in every shipped environment: it read THIS
    /// process's `COSMOS_DUC_CA_*`, and the CA lives on the provisioning
    /// workload, so the console reported "No DeviceUser CA" while enrollment was
    /// perfectly configured, and could never have warned when it genuinely was
    /// not. This names which of the two answers you are looking at.
    duc_ca_detail: &'static str,
    user_id: String,
    display_name: String,
}

#[derive(Serialize)]
struct AdminPersistence {
    notes: usize,
    memories: usize,
    contacts: usize,
}

#[derive(Serialize, Clone)]
struct AdminOnboarding {
    /// Where a device dials the onboarding edge, when the operator has named it.
    endpoint: String,
    /// The `:authority`/SNI the edge routes on.
    authority: String,
}

fn onboarding_hint() -> AdminOnboarding {
    AdminOnboarding {
        endpoint: std::env::var("COSMOS_ONBOARDING_ENDPOINT").unwrap_or_default(),
        authority: std::env::var("COSMOS_ONBOARDING_AUTHORITY").unwrap_or_default(),
    }
}

/// Can a DeviceUser binding actually complete on this deployment?
///
/// This process is the wrong one to ask by inspection. `admin_overview` is
/// mounted only on the AI-bus workload, `COSMOS_DUC_CA_CERT`/`_KEY` are set only
/// on the provisioning workload, and the previous implementation read its own
/// environment, so the operator console reported "No DeviceUser CA" in every
/// shipped environment, pointing enrollment debugging at a prerequisite that was
/// fine. The neighbouring `provisioning_configured` chip is correct (its CA
/// really is on AI-bus), which made the wrong one look authoritative.
///
/// So ask the workload that holds the material, over the one channel that
/// already exists between containers: the gRPC health service on the peer port.
/// Provisioning publishes [`crate::enrollment::DUC_CA_HEALTH_SERVICE`] as
/// SERVING only after loading the CA for real, parsing the PEM and confirming
/// the key is the certificate's key, not merely observing that two variables are
/// non-empty. `Health/Check` is auth-exempt (`auth.rs` short-circuits it before
/// authentication), so this needs no shared admin token and no new route.
///
/// A local answer wins when this process does hold the material, which is the
/// single-process development shape.
async fn duc_ca_status() -> (bool, &'static str) {
    match crate::enrollment::duc_ca_readiness() {
        crate::enrollment::DucCaReadiness::Ready => (true, "loaded by this workload"),
        crate::enrollment::DucCaReadiness::Unusable => (
            false,
            "configured on this workload but unusable; see this workload's logs",
        ),
        // Not configured here is the NORMAL production shape, not an answer.
        crate::enrollment::DucCaReadiness::NotConfigured => probe_peer_duc_ca().await,
    }
}

async fn probe_peer_duc_ca() -> (bool, &'static str) {
    let workload = cosmos_core::Workload::Provisioning.as_str();
    let peer_port: u16 = std::env::var("COSMOS_PEER_GRPC_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(15051);
    let probe = async {
        let channel =
            tonic::transport::Endpoint::from_shared(format!("http://{workload}:{peer_port}"))
                .ok()?
                .connect_timeout(std::time::Duration::from_millis(1200))
                .connect()
                .await
                .ok()?;
        tonic_health::pb::health_client::HealthClient::new(channel)
            .check(tonic_health::pb::HealthCheckRequest {
                service: crate::enrollment::DUC_CA_HEALTH_SERVICE.to_owned(),
            })
            .await
            .ok()
    };
    match tokio::time::timeout(std::time::Duration::from_millis(1800), probe).await {
        Ok(Some(response)) => {
            if response.into_inner().status
                == tonic_health::pb::health_check_response::ServingStatus::Serving as i32
            {
                (true, "loaded by the provisioning workload")
            } else {
                (
                    false,
                    "the provisioning workload holds no usable DeviceUser CA",
                )
            }
        }
        // Reachable-but-unknown and unreachable are one answer here: we could
        // not establish it. Reporting that as "no CA" would be the same lie in a
        // new place, so the detail says which it is.
        _ => (
            false,
            "could not ask the provisioning workload; this verdict is unknown, not negative",
        ),
    }
}

pub(super) async fn admin_overview(
    headers: HeaderMap,
    State(state): State<HttpState>,
) -> Result<Json<AdminOverview>, DemoError> {
    require_admin(&headers)?;

    // Counts under the same principal the companion dashboard reads, so the
    // console reflects exactly the data a wearer would see.
    //
    // Counted in the store, not by downloading rows and calling `.len()` on
    // them: this screen is what an operator opens to check whether persistence
    // is working, and the row-download form additionally read (and, for notes,
    // decrypted) the wearer's whole history to produce three integers.
    let (notes, memories, contacts) =
        match state.demo.as_ref().map(|backend| backend.assistant.store()) {
            Some(store) => {
                let principal = crate::web_api::DEMO_PRINCIPAL;
                let notes = store.count_notes(principal).await.unwrap_or(0) as usize;
                let memories = store.count_memories(principal, &[]).await.unwrap_or(0) as usize;
                let contacts = store
                    .contacts(principal)
                    .await
                    .map(|snapshot| snapshot.contacts.len())
                    .unwrap_or(0);
                (notes, memories, contacts)
            }
            None => (0, 0, 0),
        };

    let (duc_ca_configured, duc_ca_detail) = duc_ca_status().await;

    Ok(Json(AdminOverview {
        enrollment: AdminEnrollment {
            provisioned_device_id: match crate::enrollment::pairing_store() {
                Some(store) => store.provisioned_device().await.map_err(|_| {
                    demo_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "The server's Pin could not be read; try again.",
                    )
                })?,
                None => None,
            },
            open: crate::enrollment::enrollment_open(),
            provisioning_configured: crate::provision::provisioning_configured(),
            duc_ca_configured,
            duc_ca_detail,
            user_id: crate::enrollment::enrolled_user_id(),
            display_name: crate::enrollment::configured_display_name(),
        },
        persistence: AdminPersistence {
            notes,
            memories,
            contacts,
        },
        provisioned_devices: crate::provision::provisioned_devices().len(),
        onboarding: onboarding_hint(),
    }))
}

#[derive(Deserialize)]
pub(super) struct ProvisionRequest {
    device_id: String,
    #[serde(default)]
    product: Option<String>,
}

#[derive(Serialize)]
pub(super) struct ProvisionResponse {
    device_id: String,
    subject: String,
    certificate_pem: String,
    private_key_pem: String,
    ca_certificate_pem: String,
    root_certificate_pem: String,
    onboarding: AdminOnboarding,
}

pub(super) async fn admin_provision(
    headers: HeaderMap,
    Json(body): Json<ProvisionRequest>,
) -> Result<Json<ProvisionResponse>, DemoError> {
    require_admin(&headers)?;
    let product = body.product.unwrap_or_default();
    let product = if product.trim().is_empty() {
        "00000001".to_owned()
    } else {
        product.trim().to_owned()
    };
    // Device ids are hex. Normalise case so "00AA" and "00aa" name one device.
    let device_id = body.device_id.trim().to_ascii_lowercase();

    match crate::provision::mint(&device_id, &product).await {
        Ok(bundle) => Ok(Json(ProvisionResponse {
            device_id: bundle.device_id,
            subject: bundle.subject,
            certificate_pem: bundle.certificate_pem,
            private_key_pem: bundle.private_key_pem,
            ca_certificate_pem: bundle.ca_certificate_pem,
            root_certificate_pem: bundle.root_certificate_pem,
            onboarding: onboarding_hint(),
        })),
        Err(crate::provision::ProvisionError::NotConfigured) => Err(demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provisioning is disabled: no attestation CA is configured on this deployment.",
        )),
        Err(crate::provision::ProvisionError::PinLimit) => Err(demo_error(
            StatusCode::CONFLICT,
            "This server already has a Pin. Only that same Pin can be provisioned again; removing its pairing does not free the slot.",
        )),
        Err(crate::provision::ProvisionError::Store) => Err(demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The server's Pin could not be saved. No activation file was issued; try again.",
        )),
        Err(crate::provision::ProvisionError::BadInput(message)) => {
            Err(demo_error(StatusCode::BAD_REQUEST, message))
        }
        Err(crate::provision::ProvisionError::Ca(detail)) => {
            tracing::error!("device provisioning failed: {detail}");
            Err(demo_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The attestation CA could not sign a device certificate; see server logs.",
            ))
        }
    }
}

#[derive(Deserialize)]
pub(super) struct EncryptedEnvelopeInput {
    pub(super) kid: String,
    pub(super) data_base64: String,
}

impl EncryptedEnvelopeInput {
    pub(super) fn decode(
        self,
    ) -> Result<cosmos_protocol::common::encryption::EncryptedData, DemoError> {
        let kid = self.kid.trim().to_owned();
        if kid.is_empty() || kid.len() > 256 {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "Every encrypted envelope requires a bounded key id.",
            ));
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(self.data_base64.trim())
            .map_err(|_| {
                demo_error(
                    StatusCode::BAD_REQUEST,
                    "Encrypted envelope data must be standard base64.",
                )
            })?;
        if data.is_empty() {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "Encrypted envelope data cannot be empty.",
            ));
        }
        Ok(cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation { kid },
            ),
            data,
        })
    }
}

#[derive(Deserialize)]
pub(super) struct WifiIngestionRequest {
    pub(super) account_sub: String,
    #[serde(default)]
    pub(super) secure_wifi_configs: Vec<EncryptedEnvelopeInput>,
}

/// Populate the encrypted Wi-Fi list the account service exposes to a Pin.
/// Plain SSIDs and passwords are intentionally not accepted by this boundary.
pub(super) async fn admin_wifi(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<WifiIngestionRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    if account_sub.is_empty()
        || !account_sub
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "A valid account_sub is required.",
        ));
    }
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    if body.secure_wifi_configs.len() > 128 {
        return Err(demo_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "At most 128 encrypted Wi-Fi configurations may be stored.",
        ));
    }
    let secure_wifi_configs = body
        .secure_wifi_configs
        .into_iter()
        .map(EncryptedEnvelopeInput::decode)
        .collect::<Result<Vec<_>, _>>()?;
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Wi-Fi ingestion is available only on the AI-bus workload.",
            )
        })?;
    let response = cosmos_protocol::account::ListSecureWifiConfigsResponse {
        secure_wifi_configs,
    };
    store
        .put_account_blob(
            principal.expose_for_authorization(),
            crate::store::AccountBlobKind::WifiConfigs,
            &response.encode_to_vec(),
        )
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not record encrypted Wi-Fi configurations.",
            )
        })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "stored": response.secure_wifi_configs.len(),
    })))
}

#[derive(Deserialize)]
pub(super) struct PartnerTokenIngestionRequest {
    pub(super) account_sub: String,
    pub(super) provider_name: String,
    pub(super) encrypted_token: EncryptedEnvelopeInput,
}

#[derive(Deserialize)]
pub(super) struct PartnerTokenDeletionRequest {
    account_sub: String,
    provider_name: String,
}

#[derive(Deserialize)]
pub(super) struct SubscriptionStateRequest {
    account_sub: String,
    status_code: i32,
    #[serde(default)]
    message: String,
}

pub(super) async fn admin_subscription(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<SubscriptionStateRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Subscription state is available only on the AI-bus workload.",
            )
        })?;
    crate::services::provisioning::put_subscription_state(
        &store,
        principal.expose_for_authorization(),
        cosmos_protocol::provisioning::SubscriptionStatus {
            status_code: body.status_code,
            message: body.message.trim().to_owned(),
        },
    )
    .await
    .map_err(|status| {
        demo_error(
            if status.code() == tonic::Code::InvalidArgument {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "Could not record the subscription state.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "status_code": body.status_code,
        "stored": true,
    })))
}

/// Link one already-encrypted provider token to an account. Raw OAuth tokens
/// are outside this API by construction.
pub(super) async fn admin_partner_token(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<PartnerTokenIngestionRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    if account_sub.is_empty()
        || !account_sub
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "A valid account_sub is required.",
        ));
    }
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    let provider_name = body.provider_name.trim().to_ascii_lowercase();
    let encrypted_token = body.encrypted_token.decode()?;
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Partner linking is available only on the AI-bus workload.",
            )
        })?;
    crate::services::partnerservices::put_encrypted_token(
        &store,
        principal.expose_for_authorization(),
        &provider_name,
        encrypted_token,
    )
    .await
    .map_err(|status| {
        demo_error(
            if status.code() == tonic::Code::InvalidArgument {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "Could not record the encrypted partner token.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "provider_name": provider_name,
        "stored": true,
    })))
}

pub(super) async fn admin_delete_partner_token(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<PartnerTokenDeletionRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "A valid account_sub is required."))?;
    let provider_name = body.provider_name.trim().to_ascii_lowercase();
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Partner linking is available only on the AI-bus workload.",
            )
        })?;
    let removed = crate::services::partnerservices::delete_token(
        &store,
        principal.expose_for_authorization(),
        &provider_name,
    )
    .await
    .map_err(|status| {
        demo_error(
            if status.code() == tonic::Code::InvalidArgument {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "Could not unlink the provider.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "account_sub": account_sub,
        "provider_name": provider_name,
        "removed": removed,
    })))
}

#[derive(Deserialize)]
pub(super) struct PushRequest {
    account_sub: String,
    app_name: String,
    #[serde(default)]
    data_payload: Vec<u8>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    subtitle: String,
    /// Relative lifetime. Zero selects the one-day default.
    #[serde(default)]
    expiration_seconds: u64,
}

/// Queue one operator-authorized push and wake an active device stream.
///
/// `implemented`: this is a clone management surface, not a claimed Humane RPC.
/// The opaque `data_payload` remains caller-authored because each app's internal
/// payload schema is still `unknown`. The relay must not invent it.
pub(super) async fn admin_push(
    headers: HeaderMap,
    State(state): State<HttpState>,
    Json(body): Json<PushRequest>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let account_sub = body.account_sub.trim();
    let app_name = body.app_name.trim();
    if account_sub.is_empty()
        || !account_sub
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || app_name.is_empty()
        || app_name.len() > 256
    {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "A valid account_sub and app_name are required.",
        ));
    }
    let principal = AuthenticatedPrincipal::for_user(account_sub)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "account_sub is too long."))?;
    let lifetime = if body.expiration_seconds == 0 {
        86_400
    } else {
        body.expiration_seconds
    };
    if lifetime > 30 * 86_400 {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Push lifetime cannot exceed 30 days.",
        ));
    }
    let store = state
        .demo
        .as_ref()
        .map(|backend| backend.assistant.store())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Push ingestion is available only on the AI-bus workload.",
            )
        })?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let message_id = uuid::Uuid::new_v4().to_string();
    let notification_payload = (!body.title.is_empty()
        || !body.text.is_empty()
        || !body.subtitle.is_empty())
    .then_some(cosmos_protocol::common::push::NotificationPayload {
        title: body.title,
        text: body.text,
        subtitle: body.subtitle,
    });
    crate::services::pushrelay::enqueue(
        &store,
        principal.expose_for_authorization(),
        cosmos_protocol::common::push::PushMessage {
            app_name: app_name.to_owned(),
            message_id: message_id.clone(),
            expiration_timestamp: Some(prost_types::Timestamp {
                seconds: now.as_secs().saturating_add(lifetime) as i64,
                nanos: now.subsec_nanos() as i32,
            }),
            data_payload: body.data_payload,
            notification_payload,
        },
    )
    .await
    .map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Could not queue the push; persistence is unavailable.",
        )
    })?;
    Ok(Json(serde_json::json!({
        "message_id": message_id,
        "queued": true,
    })))
}

pub(super) async fn admin_devices(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let pairings = pairing_roster(crate::enrollment::pairing_store(), state.store.as_ref()).await?;
    Ok(Json(serde_json::json!({
        "devices": crate::provision::provisioned_devices(),
        "pairings": pairings,
        "note": "devices are credentials minted since this process started; pairings are the durable device-to-account roster",
    })))
}

/// The durable Pin-to-account roster, each Pin with whether the account it is
/// paired to has it in lost-device block mode: `blocked` is null when that
/// account's block list cannot be read, so one unreadable list never hides the
/// roster.
pub(super) async fn pairing_roster(
    store: Option<crate::enrollment::SharedEnrollmentStore>,
    blocks: Option<&crate::store::SharedStore>,
) -> Result<Vec<serde_json::Value>, DemoError> {
    let pairings = store
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The durable device pairing store is not configured.",
            )
        })?
        .device_accounts()
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The durable device pairing roster is unavailable.",
            )
        })?;
    let mut roster = Vec::with_capacity(pairings.len());
    for pairing in pairings {
        let block = holder_block(blocks, &pairing.account_sub, &pairing.device_id).await;
        roster.push(serde_json::json!({
            "device_id": pairing.device_id,
            "account_sub": pairing.account_sub,
            "paired_at_epoch": pairing.paired_at_epoch,
            "blocked": block.as_ref().ok().map(Option::is_some),
            "blocked_at_epoch": block.ok().flatten().map(|block| block.blocked_at_epoch),
        }));
    }
    Ok(roster)
}

/// The lost-device block `holder`'s account has on `device_id`, if any
/// (`services::device_block`), or `Err` when that block list cannot be read,
/// which is never "not blocked".
async fn holder_block(
    blocks: Option<&crate::store::SharedStore>,
    holder: &str,
    device_id: &str,
) -> Result<Option<crate::services::device_block::DeviceBlock>, ()> {
    // No Pin can carry a principal for a sub `for_user` refuses, so no block
    // list applies to it.
    let Ok(principal) = AuthenticatedPrincipal::for_user(holder) else {
        return Ok(None);
    };
    crate::services::device_block::device_blocks(
        blocks.ok_or(())?,
        principal.expose_for_authorization(),
    )
    .await
    .map(|list| list.get(device_id).cloned())
    .map_err(|_| ())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReleasePairingQuery {
    /// The operator confirmed releasing a Pin that is in lost-device block
    /// mode or whose block list cannot be read.
    #[serde(default)]
    confirm_blocked: bool,
}

/// `DELETE /demo-api/admin/pairings/{device_id}[?confirm_blocked=true]`,
/// release a Pin's pairing, whichever account holds it.
///
/// A wearer releases only their own Pin (`account_api`), and pairing a Pin
/// another account holds is refused 409, so a Pin id claimed by the wrong
/// account would otherwise stay stuck: stock sent that case to support "to
/// unlink it from your account" (`factory_reset_instructions`). The operator is
/// that support here, behind the operator token like every route beside it.
///
/// A Pin its account has in lost-device block mode, or whose block list cannot
/// be read, is refused 409 unless the operator confirms: once released, another
/// account can pair it and set it up under a certificate that account's block
/// list governs.
pub(super) async fn admin_release_pairing(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ReleasePairingQuery>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    release_pairing(
        crate::enrollment::pairing_store(),
        state.store.as_ref(),
        &device_id,
        query.confirm_blocked,
    )
    .await
}

/// [`admin_release_pairing`] over explicit stores: `released` says whether
/// the Pin was paired, and `account_sub` whose it was.
///
/// Each removal is a compare-and-delete against the holder just read and
/// checked for block mode, so a pairing that changed in between is read and
/// checked again rather than removed blind.
pub(super) async fn release_pairing(
    store: Option<crate::enrollment::SharedEnrollmentStore>,
    blocks: Option<&crate::store::SharedStore>,
    raw_id: &str,
    confirm_blocked: bool,
) -> Result<Json<serde_json::Value>, DemoError> {
    const ATTEMPTS: usize = 4;
    let device_id = crate::account_api::device_id(raw_id)
        .ok_or_else(|| demo_error(StatusCode::BAD_REQUEST, "A Pin's device id is hexadecimal."))?;
    let store = store.ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The durable device pairing store is not configured.",
        )
    })?;
    let unavailable = || {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The durable device pairing roster is unavailable.",
        )
    };
    for _ in 0..ATTEMPTS {
        let Some(holder) = store
            .device_account(&device_id)
            .await
            .map_err(|_| unavailable())?
        else {
            return Ok(Json(serde_json::json!({
                "device_id": device_id,
                "released": false,
                "account_sub": null,
            })));
        };
        if !confirm_blocked && !matches!(holder_block(blocks, &holder, &device_id).await, Ok(None))
        {
            return Err(demo_error(
                StatusCode::CONFLICT,
                "This Pin is in lost-device block mode, or its block list cannot be read. Releasing \
                 it lets another account pair it without block mode; confirm to release it anyway.",
            ));
        }
        if store
            .delete_device_account(&device_id, &holder)
            .await
            .map_err(|_| unavailable())?
        {
            return Ok(Json(serde_json::json!({
                "device_id": device_id,
                "released": true,
                "account_sub": holder,
            })));
        }
    }
    Err(unavailable())
}

/// Independently implemented device-status projection used by the restored
/// Center. No stock endpoint for these fields was observed, so this deliberately
/// lives outside the Humane RPC namespace.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct DeviceStatusSnapshot {
    device_id: String,
    serial_number: String,
    firmware_version: String,
    os_version: String,
    battery_percent: u8,
    battery_charging: bool,
    reported_at_epoch: u64,
    #[serde(default)]
    wifi_networks: Vec<DeviceWifiNetwork>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DeviceWifiNetwork {
    ssid: String,
    #[serde(default)]
    authorization_type: String,
    #[serde(default)]
    connected: bool,
}

#[derive(Deserialize)]
pub(super) struct SignedDeviceStatusReport {
    /// Exact UTF-8 JSON bytes covered by `signature_der`.
    payload: String,
    certificate_der: String,
    signature_der: String,
}

pub(super) fn device_status_storage_owner(
    principal: &AuthenticatedPrincipal,
    device_id: &str,
) -> String {
    // Account authorization is resolved before this point. The device suffix is
    // an internal storage namespace so multiple Pins on one wearer account do
    // not overwrite or impersonate each other's latest snapshot.
    format!(
        "{}#device:{device_id}",
        principal.expose_for_authorization()
    )
}

fn device_status_ca_der() -> Result<Vec<u8>, DemoError> {
    let path = std::env::var("COSMOS_DEVICE_STATUS_CA_CERT").map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device status trust is not configured.",
        )
    })?;
    let bytes = std::fs::read(path).map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device status trust is unavailable.",
        )
    })?;
    let mut reader = std::io::BufReader::new(bytes.as_slice());
    rustls_pemfile::certs(&mut reader)
        .next()
        .transpose()
        .ok()
        .flatten()
        .map(|der| der.as_ref().to_vec())
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Device status trust is invalid.",
            )
        })
}

fn verify_device_status_report(
    body: &SignedDeviceStatusReport,
) -> Result<DeviceStatusSnapshot, DemoError> {
    let base64 = base64::engine::general_purpose::STANDARD;
    let certificate_der = base64.decode(&body.certificate_der).map_err(|_| {
        demo_error(
            StatusCode::UNAUTHORIZED,
            "Invalid device certificate encoding.",
        )
    })?;
    let signature_der = base64.decode(&body.signature_der).map_err(|_| {
        demo_error(
            StatusCode::UNAUTHORIZED,
            "Invalid device signature encoding.",
        )
    })?;
    let ca_der = device_status_ca_der()?;
    let (_, leaf) = x509_parser::parse_x509_certificate(&certificate_der)
        .map_err(|_| demo_error(StatusCode::UNAUTHORIZED, "Invalid device certificate."))?;
    let (_, ca) = x509_parser::parse_x509_certificate(&ca_der).map_err(|_| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Invalid status trust root.",
        )
    })?;
    leaf.verify_signature(Some(ca.public_key()))
        .map_err(|_| demo_error(StatusCode::UNAUTHORIZED, "Untrusted device certificate."))?;
    crate::enrollment::verify_attestation_signature(
        &certificate_der,
        Some(body.payload.as_bytes()),
        &signature_der,
    )
    .map_err(|_| demo_error(StatusCode::UNAUTHORIZED, "Invalid device status signature."))?;

    let mut status: DeviceStatusSnapshot = serde_json::from_str(&body.payload)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "Invalid device status payload."))?;
    status.device_id = status.device_id.trim().to_ascii_lowercase();
    let certificate_device = crate::enrollment::attestation_certificate_device_id(&certificate_der)
        .ok_or_else(|| {
            demo_error(
                StatusCode::UNAUTHORIZED,
                "Certificate has no device identity.",
            )
        })?;
    if status.device_id != certificate_device {
        return Err(demo_error(
            StatusCode::UNAUTHORIZED,
            "Status device does not match its certificate.",
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if status.reported_at_epoch.abs_diff(now) > 10 * 60 {
        return Err(demo_error(
            StatusCode::UNAUTHORIZED,
            "Stale device status report.",
        ));
    }
    if status.battery_percent > 100 || status.wifi_networks.len() > 128 {
        return Err(demo_error(
            StatusCode::BAD_REQUEST,
            "Invalid device status values.",
        ));
    }
    for network in &status.wifi_networks {
        if network.ssid.len() > 256 || network.authorization_type.len() > 64 {
            return Err(demo_error(
                StatusCode::BAD_REQUEST,
                "Invalid Wi-Fi metadata.",
            ));
        }
    }
    Ok(status)
}

pub(super) async fn device_status_report(
    State(state): State<HttpState>,
    Json(body): Json<SignedDeviceStatusReport>,
) -> Result<Json<serde_json::Value>, DemoError> {
    let status = verify_device_status_report(&body)?;
    let enrollment = crate::enrollment::pairing_store().ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device pairing is unavailable.",
        )
    })?;
    let account_sub = enrollment
        .device_account(&status.device_id)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Device pairing is unavailable.",
            )
        })?
        .ok_or_else(|| demo_error(StatusCode::FORBIDDEN, "This device is not paired."))?;
    let principal = AuthenticatedPrincipal::for_user(&account_sub)
        .map_err(|_| demo_error(StatusCode::FORBIDDEN, "Device account is invalid."))?;
    let bytes = serde_json::to_vec(&status)
        .map_err(|_| demo_error(StatusCode::BAD_REQUEST, "Invalid device status."))?;
    let owner = device_status_storage_owner(&principal, &status.device_id);
    state
        .store
        .as_ref()
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?
        .put_account_blob(&owner, crate::store::AccountBlobKind::DeviceStatus, &bytes)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?;
    Ok(Json(serde_json::json!({"ok": true})))
}

pub(super) async fn admin_device_status(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, DemoError> {
    require_admin(&headers)?;
    let device_id = device_id.trim().to_ascii_lowercase();
    let enrollment = crate::enrollment::pairing_store().ok_or_else(|| {
        demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Device pairing is unavailable.",
        )
    })?;
    let account_sub = enrollment
        .device_account(&device_id)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Device pairing is unavailable.",
            )
        })?
        .ok_or_else(|| demo_error(StatusCode::NOT_FOUND, "Device is not paired."))?;
    let principal = AuthenticatedPrincipal::for_user(&account_sub)
        .map_err(|_| demo_error(StatusCode::NOT_FOUND, "Device account is invalid."))?;
    let owner = device_status_storage_owner(&principal, &device_id);
    let stored = state
        .store
        .as_ref()
        .ok_or_else(|| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?
        .get_account_blob(&owner, crate::store::AccountBlobKind::DeviceStatus)
        .await
        .map_err(|_| {
            demo_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Status storage is unavailable.",
            )
        })?;
    let Some(bytes) = stored else {
        return Err(demo_error(
            StatusCode::NOT_FOUND,
            "No status has been reported yet.",
        ));
    };
    let status: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| demo_error(StatusCode::SERVICE_UNAVAILABLE, "Stored status is invalid."))?;
    Ok(Json(status))
}
