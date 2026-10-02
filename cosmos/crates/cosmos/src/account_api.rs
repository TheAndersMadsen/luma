//! The humane.center account settings surface.
//!
//! Only the OAuth scope name `account-service` survived in the recovered web
//! client (`K/API-REFERENCE.md` §1). Its paths did not. Luma serves the
//! wearer's own settings under `/account-service/*` (INFERRED paths) and the
//! recovered `device-assignments` service's `GET /device-assignments/devices`
//! (`getDeviceId`) here:
//!
//! - `GET/POST /account-service/profile`, the stock `AccountInfo` the Pin reads
//!   with `GetUserPersonalDetails`: preferred name and pronunciation (the
//!   recovered Details page's "Preferred name" and IPA "Pronunciation").
//! - `GET/POST /account-service/food-preferences`, the restrictions and daily
//!   intake goals `FoodPreferencesService` serves. No stock device process
//!   writes them. The food experience sends the wearer to .center for goals.
//! - `GET /account-service/food-intake?startTime&endTime`, the food log's
//!   totals over a window against those goals. Stock shows no totals. INFERRED.
//! - `GET /device-assignments/devices`, the wearer's paired Pins, the status
//!   each last reported, and whether it is in block mode.
//! - `POST/DELETE /device-assignments/devices/{id}/block`, block mode, the
//!   control the stock `blocked_device` copy sends the wearer to
//!   humane.center/devices for (`services::device_block`). INFERRED path.
//! - `POST /device-assignments/devices {deviceId}` and
//!   `DELETE /device-assignments/devices/{id}`, pair a Pin to, or release it
//!   from, the signed-in wearer's own account. A Pin another account holds is
//!   refused 409: stock sent a new owner to "initiate contact with support to
//!   unlink it from your account" (`factory_reset_instructions`). INFERRED paths.
//! - `GET/PUT /account-service/passcode`, whether the wearer set their Pin
//!   passcode, and setting or changing it (`enrollment::set_passcode`). The Pin
//!   asks for it during setup and sends a wearer without one to ".center"
//!   (`PincodeNode.onPincodeNotSet`). INFERRED path.
//! - `DELETE /account-service/account {confirm: "DELETE"}`, delete the
//!   account: everything Cosmos holds for it. Refused 409 while any of its Pins
//!   is in block mode, which deletion would lift. The recovered web client
//!   carried an `accountDeletion` flag (off in the snapshot) and no path.
//!   INFERRED.
//!
//! Every route answers only the web plane ([`ApiState::web_account_for`]): a
//! Pin is 403 and nobody is 401. Each reads and writes the SAME rows the
//! device-facing services use, through `services::account` and
//! `services::device_block`.
//!
//! ## Food restrictions stay sealed
//!
//! `FoodRestriction`s are stored as `EncryptedData`, the stock wire shape. The
//! cloud sealed what the web wrote, so Cosmos does too: under one AES key per
//! wearer that Cosmos mints into the key directory ([`restriction_kid`]), with
//! the payload type as AAD. A restriction sealed under any other key is kept
//! as it is and counted, never opened or dropped.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use cosmos_protocol::account as pb;
use cosmos_protocol::common::encryption::{EncryptedData, EncryptionInformation};
use cosmos_protocol::common::food::{NutrientType, NutrientUnit};
use prost::Message as _;
use serde::{Deserialize, Serialize};

use crate::enrollment::{DeviceAccountPairing, SharedEnrollmentStore};
use crate::keydirectory::{KeyDirectoryError, SharedKeyDirectory};
use crate::services::{account, device_block};
use crate::store::AccountBlobKind;
use crate::web_api::{ApiState, unavailable};

/// Where the device-to-account pairings are read: the enrollment store the
/// provisioning ceremony writes (`enrollment::pairing_store`).
type Pairings = Arc<dyn Fn() -> Option<SharedEnrollmentStore> + Send + Sync>;

#[derive(Clone)]
struct AccountState {
    api: ApiState,
    pairings: Pairings,
}

/// Mount the account routes over the shared web state.
pub(crate) fn router(state: ApiState) -> Router {
    routes(state, Arc::new(crate::enrollment::pairing_store))
}

fn routes(api: ApiState, pairings: Pairings) -> Router {
    Router::new()
        .route(
            "/account-service/profile",
            get(get_profile).post(save_profile),
        )
        .route(
            "/account-service/food-preferences",
            get(get_food_preferences).post(save_food_preferences),
        )
        .route("/account-service/food-intake", get(get_food_intake))
        .route("/account-service/privacy-details", get(get_privacy_details))
        .route(
            "/account-service/passcode",
            get(get_passcode).put(put_passcode),
        )
        .route("/account-service/account", delete(delete_account))
        .route(
            "/device-assignments/devices",
            get(list_devices).post(pair_device),
        )
        .route(
            "/device-assignments/devices/:device_id",
            delete(unpair_device),
        )
        .route(
            "/device-assignments/devices/:device_id/block",
            post(block_device).delete(unblock_device),
        )
        .with_state(AccountState { api, pairings })
}

fn bad_request(reason: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, reason).into_response()
}

fn too_large(reason: &'static str) -> Response {
    (StatusCode::PAYLOAD_TOO_LARGE, reason).into_response()
}

/// Text the wearer typed: trimmed, and refused if it carries a control
/// character or runs past `max_chars`.
fn typed(value: &str, max_chars: usize) -> Result<String, Response> {
    let value = value.trim();
    if value.chars().any(char::is_control) {
        return Err(bad_request("text cannot contain control characters"));
    }
    if value.chars().count() > max_chars {
        return Err(too_large("the text is too long"));
    }
    Ok(value.to_owned())
}

fn iso(epoch_seconds: i64) -> Option<String> {
    sqlx::types::chrono::DateTime::from_timestamp(epoch_seconds, 0)
        .map(|time| time.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

// ── Profile ─────────────────────────────────────────────────────────────────

/// Luma's bound on each profile field. The recovered page states none.
const MAX_PROFILE_CHARS: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileDto {
    /// Empty when the wearer has not set one.
    preferred_name: String,
    /// IPA, as the recovered Details page asked for it. Empty when unset.
    pronunciation: String,
    /// Sealed bio data rides beside the name. It is never opened here.
    has_secure_bio_data: bool,
}

impl From<pb::PersonalDetailsResponse> for ProfileDto {
    fn from(details: pb::PersonalDetailsResponse) -> Self {
        let info = details.account_info.unwrap_or_default();
        Self {
            preferred_name: info.preferred_name,
            pronunciation: info.pronunciation,
            has_secure_bio_data: details
                .secure_bio_data
                .is_some_and(|sealed| !sealed.data.is_empty()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileWrite {
    preferred_name: String,
    pronunciation: String,
}

/// INFERRED: wearer-only latest location/diagnostic view for privacy consent.
async fn get_privacy_details(State(state): State<AccountState>, headers: HeaderMap) -> Response {
    let account = match state.api.web_account_for(&headers) {
        Ok(account) => account,
        Err(status) => return status.into_response(),
    };
    match crate::services::public_privacy::privacy_details(
        &state.api.store,
        &state.api.keys,
        &account.account,
    )
    .await
    {
        Ok(details) => Json(details).into_response(),
        Err(_) => unavailable(),
    }
}

/// `GET /account-service/profile`.
async fn get_profile(State(state): State<AccountState>, headers: HeaderMap) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    match account::personal_details(&state.api.store, &account).await {
        Ok(details) => Json(ProfileDto::from(details)).into_response(),
        Err(_) => unavailable(),
    }
}

/// `POST /account-service/profile {preferredName, pronunciation}`, the
/// Details page's edit. An empty field clears it.
async fn save_profile(
    State(state): State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<ProfileWrite>, JsonRejection>,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Ok(Json(write)) = body else {
        return bad_request("expected a JSON {preferredName, pronunciation} object");
    };
    let info = match (
        typed(&write.preferred_name, MAX_PROFILE_CHARS),
        typed(&write.pronunciation, MAX_PROFILE_CHARS),
    ) {
        (Ok(preferred_name), Ok(pronunciation)) => pb::AccountInfo {
            preferred_name,
            pronunciation,
        },
        (Err(refused), _) | (_, Err(refused)) => return refused,
    };
    match account::put_account_info(&state.api.store, &account, info).await {
        Ok(details) => Json(ProfileDto::from(details)).into_response(),
        Err(_) => unavailable(),
    }
}

// ── Food preferences ────────────────────────────────────────────────────────

/// Luma's bounds on one write. The recovered client states none.
const MAX_RESTRICTIONS: usize = 64;
const MAX_RESTRICTION_NAME_CHARS: usize = 100;
const MAX_GOAL_VALUE: f32 = 1_000_000.0;
const MAX_UUID_CHARS: usize = 64;

/// The payload type a web-written restriction is sealed with.
const RESTRICTION_AAD: &[u8] = b"humane.account.FoodRestriction";

/// The key Cosmos seals one wearer's web-written restrictions under. Named
/// after the account like Center's own `<principal>/center/ephemeral` kid, so
/// the key directory attributes it to its wearer.
fn restriction_kid(account: &str) -> String {
    format!("{account}/account-service/food-restrictions")
}

fn kid_of(sealed: &EncryptedData) -> &str {
    sealed
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .unwrap_or_default()
}

/// `humane.account.FoodRestriction`, by enum name.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FoodRestrictionDto {
    /// Absent or empty on a new restriction. Cosmos assigns one.
    #[serde(default)]
    uuid: String,
    name: String,
    restriction_type: String,
    severity: String,
}

/// `humane.account.NutrientGoal`: `min`/`max` present exactly when set.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NutrientGoalDto {
    #[serde(default)]
    uuid: String,
    #[serde(rename = "type")]
    nutrient: String,
    unit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoodPreferencesDto {
    restrictions: Vec<FoodRestrictionDto>,
    daily_intake_goals: Vec<NutrientGoalDto>,
    /// Restrictions sealed under a key this surface does not hold. They stay
    /// stored and are never shown or dropped.
    sealed_restrictions: usize,
}

/// Either half may be left out to keep it as stored. Each present half
/// replaces the whole list, as the stock set RPCs do.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FoodPreferencesWrite {
    restrictions: Option<Vec<FoodRestrictionDto>>,
    daily_intake_goals: Option<Vec<NutrientGoalDto>>,
}

fn restriction_dto(restriction: pb::FoodRestriction) -> FoodRestrictionDto {
    FoodRestrictionDto {
        restriction_type: pb::RestrictionType::try_from(restriction.restriction_type)
            .unwrap_or_default()
            .as_str_name()
            .to_owned(),
        severity: pb::Severity::try_from(restriction.severity)
            .unwrap_or_default()
            .as_str_name()
            .to_owned(),
        uuid: restriction.uuid,
        name: restriction.name,
    }
}

fn goal_dto(goal: pb::NutrientGoal) -> NutrientGoalDto {
    NutrientGoalDto {
        nutrient: NutrientType::try_from(goal.r#type)
            .unwrap_or_default()
            .as_str_name()
            .to_owned(),
        unit: NutrientUnit::try_from(goal.unit)
            .unwrap_or_default()
            .as_str_name()
            .to_owned(),
        min: goal.is_min_set.then_some(goal.min_value),
        max: goal.is_max_set.then_some(goal.max_value),
        uuid: goal.uuid,
    }
}

/// A caller-supplied id, or a new one.
fn item_uuid(uuid: &str) -> Result<String, Response> {
    let uuid = uuid.trim();
    if uuid.is_empty() {
        return Ok(uuid::Uuid::new_v4().to_string());
    }
    if uuid.chars().count() > MAX_UUID_CHARS
        || !uuid
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(bad_request("an id is letters, digits and dashes"));
    }
    Ok(uuid.to_owned())
}

fn parse_restrictions(
    restrictions: Vec<FoodRestrictionDto>,
) -> Result<Vec<pb::FoodRestriction>, Response> {
    if restrictions.len() > MAX_RESTRICTIONS {
        return Err(too_large("too many food restrictions"));
    }
    restrictions
        .into_iter()
        .map(|restriction| {
            let name = typed(&restriction.name, MAX_RESTRICTION_NAME_CHARS)?;
            if name.is_empty() {
                return Err(bad_request("every food restriction needs a name"));
            }
            let restriction_type =
                pb::RestrictionType::from_str_name(&restriction.restriction_type)
                    .ok_or_else(|| bad_request("restrictionType is a RestrictionType name"))?;
            let severity = pb::Severity::from_str_name(&restriction.severity)
                .ok_or_else(|| bad_request("severity is a Severity name"))?;
            Ok(pb::FoodRestriction {
                uuid: item_uuid(&restriction.uuid)?,
                name,
                restriction_type: restriction_type as i32,
                severity: severity as i32,
            })
        })
        .collect()
}

fn parse_goals(goals: Vec<NutrientGoalDto>) -> Result<pb::DailyIntakeGoals, Response> {
    let mut parsed: Vec<pb::NutrientGoal> = Vec::with_capacity(goals.len());
    for goal in goals {
        let nutrient = NutrientType::from_str_name(&goal.nutrient)
            .filter(|nutrient| *nutrient != NutrientType::Undefined)
            .ok_or_else(|| bad_request("type is a NutrientType name"))?;
        let unit = NutrientUnit::from_str_name(&goal.unit)
            .filter(|unit| *unit != NutrientUnit::Unknown)
            .ok_or_else(|| bad_request("unit is a NutrientUnit name"))?;
        if parsed
            .iter()
            .any(|existing| existing.r#type == nutrient as i32)
        {
            return Err(bad_request("one goal per nutrient"));
        }
        let bounded = |value: Option<f32>| match value {
            Some(value) if !(0.0..=MAX_GOAL_VALUE).contains(&value) => {
                Err(bad_request("a goal is a number from 0 to 1,000,000"))
            }
            other => Ok(other),
        };
        let (min, max) = (bounded(goal.min)?, bounded(goal.max)?);
        if min.is_none() && max.is_none() {
            return Err(bad_request("a goal sets a minimum, a maximum, or both"));
        }
        if let (Some(min), Some(max)) = (min, max)
            && min > max
        {
            return Err(bad_request("a goal's minimum is above its maximum"));
        }
        parsed.push(pb::NutrientGoal {
            uuid: item_uuid(&goal.uuid)?,
            r#type: nutrient as i32,
            unit: unit as i32,
            is_min_set: min.is_some(),
            min_value: min.unwrap_or_default(),
            is_max_set: max.is_some(),
            max_value: max.unwrap_or_default(),
        });
    }
    Ok(pb::DailyIntakeGoals {
        nutrient_goals: parsed,
    })
}

/// The restrictions under this wearer's web key, opened, and how many stored
/// envelopes could not be.
async fn open_restrictions(
    keys: &SharedKeyDirectory,
    account: &str,
    stored: &[EncryptedData],
) -> Result<(Vec<pb::FoodRestriction>, usize), KeyDirectoryError> {
    let kid = restriction_kid(account);
    let mut opened = Vec::with_capacity(stored.len());
    let mut sealed = 0;
    for envelope in stored {
        if kid_of(envelope) != kid {
            sealed += 1;
            continue;
        }
        let plaintext = match keys
            .open(&cosmos_crypto::EncryptedData {
                kid: kid.clone(),
                data: envelope.data.clone(),
            })
            .await
        {
            Ok(plaintext) => plaintext,
            Err(KeyDirectoryError::OpenFailed) => None,
            Err(error) => return Err(error),
        };
        let restriction = plaintext
            .filter(|_| {
                cosmos_crypto::envelope_aad(&envelope.data).is_ok_and(|aad| aad == RESTRICTION_AAD)
            })
            .and_then(|plaintext| pb::FoodRestriction::decode(plaintext.as_slice()).ok());
        match restriction {
            Some(restriction) => opened.push(restriction),
            None => sealed += 1,
        }
    }
    Ok((opened, sealed))
}

/// Seal each restriction under this wearer's web key, minting the key the
/// first time.
async fn seal_restrictions(
    keys: &SharedKeyDirectory,
    account: &str,
    restrictions: &[pb::FoodRestriction],
) -> Result<Vec<EncryptedData>, KeyDirectoryError> {
    if restrictions.is_empty() {
        return Ok(Vec::new());
    }
    let kid = restriction_kid(account);
    if !keys.holds(&kid).await? {
        let mut key = [0u8; cosmos_crypto::AES_KEY_LEN];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
        keys.put(&kid, key).await?;
    }
    let mut sealed = Vec::with_capacity(restrictions.len());
    for restriction in restrictions {
        let envelope = keys
            .seal(&kid, &restriction.encode_to_vec(), RESTRICTION_AAD)
            .await?
            // The key went between minting and sealing. Nothing was written.
            .ok_or(KeyDirectoryError::OpenFailed)?;
        sealed.push(EncryptedData {
            encryption_information: Some(EncryptionInformation { kid: envelope.kid }),
            data: envelope.data,
        });
    }
    Ok(sealed)
}

async fn food_preferences(state: &AccountState, account: &str) -> Response {
    let (stored, goals) = match (
        account::food_restrictions(&state.api.store, account).await,
        account::daily_intake_goals(&state.api.store, account).await,
    ) {
        (Ok(stored), Ok(goals)) => (stored, goals),
        _ => return unavailable(),
    };
    let Ok((restrictions, sealed_restrictions)) =
        open_restrictions(&state.api.keys, account, &stored).await
    else {
        return unavailable();
    };
    Json(FoodPreferencesDto {
        restrictions: restrictions.into_iter().map(restriction_dto).collect(),
        daily_intake_goals: goals.nutrient_goals.into_iter().map(goal_dto).collect(),
        sealed_restrictions,
    })
    .into_response()
}

/// `GET /account-service/food-preferences`.
async fn get_food_preferences(State(state): State<AccountState>, headers: HeaderMap) -> Response {
    match state.api.web_caller(&headers) {
        Ok(account) => food_preferences(&state, &account).await,
        Err(refused) => refused,
    }
}

/// `POST /account-service/food-preferences {restrictions?, dailyIntakeGoals?}`.
async fn save_food_preferences(
    State(state): State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<FoodPreferencesWrite>, JsonRejection>,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Ok(Json(write)) = body else {
        return bad_request("expected a JSON {restrictions, dailyIntakeGoals} object");
    };
    let restrictions = match write.restrictions.map(parse_restrictions).transpose() {
        Ok(restrictions) => restrictions,
        Err(refused) => return refused,
    };
    let goals = match write.daily_intake_goals.map(parse_goals).transpose() {
        Ok(goals) => goals,
        Err(refused) => return refused,
    };
    if let Some(restrictions) = restrictions {
        let Ok(sealed) = seal_restrictions(&state.api.keys, &account, &restrictions).await else {
            return unavailable();
        };
        let kid = restriction_kid(&account);
        let replaced = account::update_blob(
            &state.api.store,
            &account,
            AccountBlobKind::FoodRestrictions,
            |mut stored: pb::EncryptedGetFoodRestrictionsResponse| {
                // Keep what another key sealed. Replace what this surface wrote.
                stored
                    .secure_restrictions
                    .retain(|envelope| kid_of(envelope) != kid);
                stored.secure_restrictions.extend(sealed.iter().cloned());
                stored
            },
        )
        .await;
        if replaced.is_err() {
            return unavailable();
        }
    }
    if let Some(goals) = goals
        && account::put_daily_intake_goals(&state.api.store, &account, Some(goals))
            .await
            .is_err()
    {
        return unavailable();
    }
    food_preferences(&state, &account).await
}

// ── Devices ─────────────────────────────────────────────────────────────────

/// One of the wearer's Pins.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAssignmentDto {
    device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    serial_number: Option<String>,
    /// When it was paired to this account. Absent for a blocked Pin whose
    /// pairing has since been removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    paired_at: Option<String>,
    /// Block mode: every call from this Pin is refused with the stock
    /// `unauthorized-device` trailer, which locks it.
    blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_at: Option<String>,
    /// The status it last reported, when it has reported one.
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<DeviceStatusDto>,
    /// A status is stored and cannot be read. Not the same as "never reported".
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    status_unreadable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStatusDto {
    reported_at: String,
    battery_percent: u8,
    battery_charging: bool,
    firmware_version: String,
    os_version: String,
    wifi_networks: Vec<ReportedNetworkDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportedNetworkDto {
    ssid: String,
    authorization_type: String,
    connected: bool,
}

/// The signed snapshot `POST /device-status/v1/report` stores (`http/admin.rs`
/// `DeviceStatusSnapshot`), read back.
#[derive(Deserialize)]
struct ReportedStatus {
    serial_number: String,
    firmware_version: String,
    os_version: String,
    battery_percent: u8,
    battery_charging: bool,
    reported_at_epoch: i64,
    #[serde(default)]
    wifi_networks: Vec<ReportedNetwork>,
}

#[derive(Deserialize)]
struct ReportedNetwork {
    ssid: String,
    #[serde(default)]
    authorization_type: String,
    #[serde(default)]
    connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DevicesDto {
    devices: Vec<DeviceAssignmentDto>,
}

/// Where one Pin's reported status is stored: `http/admin.rs`
/// `device_status_storage_owner`, the account plus a device suffix so two Pins
/// on one account never overwrite each other.
fn status_owner(account: &str, device_id: &str) -> String {
    format!("{account}#device:{device_id}")
}

/// A device id from a path: the lowercase hex a DeviceUser CN carries.
pub(crate) fn device_id(raw: &str) -> Option<String> {
    let raw = raw.trim();
    ((1..=64).contains(&raw.len()) && raw.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| raw.to_ascii_lowercase())
}

async fn assignment(
    state: &AccountState,
    account: &str,
    device_id: String,
    pairing: Option<&DeviceAccountPairing>,
    block: Option<&device_block::DeviceBlock>,
) -> Result<DeviceAssignmentDto, ()> {
    let stored = state
        .api
        .store
        .get_account_blob(
            &status_owner(account, &device_id),
            AccountBlobKind::DeviceStatus,
        )
        .await
        .map_err(|_| ())?;
    let reported = stored
        .as_deref()
        .map(serde_json::from_slice::<ReportedStatus>);
    let status_unreadable = matches!(reported, Some(Err(_)));
    let reported = reported.and_then(Result::ok);
    Ok(DeviceAssignmentDto {
        device_id,
        serial_number: reported
            .as_ref()
            .map(|status| status.serial_number.clone())
            .filter(|serial| !serial.is_empty()),
        paired_at: pairing.and_then(|pairing| iso(pairing.paired_at_epoch)),
        blocked: block.is_some(),
        blocked_at: block.and_then(|block| iso(block.blocked_at_epoch)),
        status: reported.and_then(|status| {
            Some(DeviceStatusDto {
                reported_at: iso(status.reported_at_epoch)?,
                battery_percent: status.battery_percent,
                battery_charging: status.battery_charging,
                firmware_version: status.firmware_version,
                os_version: status.os_version,
                wifi_networks: status
                    .wifi_networks
                    .into_iter()
                    .map(|network| ReportedNetworkDto {
                        ssid: network.ssid,
                        authorization_type: network.authorization_type,
                        connected: network.connected,
                    })
                    .collect(),
            })
        }),
        status_unreadable,
    })
}

/// `GET /device-assignments/devices`, the Pins paired to this account, oldest
/// pairing first, then any Pin still in block mode after its pairing went, so
/// block mode can always be turned off.
async fn list_devices(State(state): State<AccountState>, headers: HeaderMap) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Some(pairings) = (state.pairings)() else {
        return unavailable();
    };
    let Ok(roster) = pairings.device_accounts().await else {
        return unavailable();
    };
    let Ok(blocks) = device_block::device_blocks(&state.api.store, &account).await else {
        return unavailable();
    };
    let sub = account.strip_prefix("U:");
    let mine: Vec<&DeviceAccountPairing> = roster
        .iter()
        .filter(|pairing| Some(pairing.account_sub.as_str()) == sub)
        .collect();
    let mut devices = Vec::with_capacity(mine.len());
    for pairing in &mine {
        let block = blocks.get(&pairing.device_id);
        match assignment(
            &state,
            &account,
            pairing.device_id.clone(),
            Some(pairing),
            block,
        )
        .await
        {
            Ok(device) => devices.push(device),
            Err(()) => return unavailable(),
        }
    }
    for (device_id, block) in blocks.iter() {
        if mine.iter().any(|pairing| &pairing.device_id == device_id) {
            continue;
        }
        match assignment(&state, &account, device_id.clone(), None, Some(block)).await {
            Ok(device) => devices.push(device),
            Err(()) => return unavailable(),
        }
    }
    Json(DevicesDto { devices }).into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockDto {
    device_id: String,
    blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_at: Option<String>,
}

/// `POST /device-assignments/devices/{id}/block`, the wearer marks a Pin lost.
///
/// The block is kept under the wearer's own account, so it can only ever
/// refuse that wearer's Pins. A Pin whose pairing was removed but whose
/// certificate still names this account can be blocked too.
async fn block_device(
    State(state): State<AccountState>,
    headers: HeaderMap,
    Path(raw_id): Path<String>,
) -> Response {
    set_block(state, headers, raw_id, true).await
}

/// `DELETE /device-assignments/devices/{id}/block`, block mode off. The Pin's
/// next served call clears its lock state.
async fn unblock_device(
    State(state): State<AccountState>,
    headers: HeaderMap,
    Path(raw_id): Path<String>,
) -> Response {
    set_block(state, headers, raw_id, false).await
}

async fn set_block(
    state: AccountState,
    headers: HeaderMap,
    raw_id: String,
    block: bool,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Some(device_id) = device_id(&raw_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let reasons = [pb::UnauthorizedStatusCode::DeviceLostOrStolen];
    match device_block::set_block(
        &state.api.store,
        &account,
        &device_id,
        block.then_some(reasons.as_slice()),
    )
    .await
    {
        Ok(blocks) => Json(BlockDto {
            blocked_at: blocks
                .get(&device_id)
                .and_then(|block| iso(block.blocked_at_epoch)),
            blocked: blocks.get(&device_id).is_some(),
            device_id,
        })
        .into_response(),
        Err(_) => unavailable(),
    }
}

// ── Pairing ─────────────────────────────────────────────────────────────────

/// The Keycloak `sub` a web principal names, as the enrollment store keys it.
///
/// It is written verbatim into the DeviceUser certificate's CN
/// `V:01:D:<device>:U:<sub>`, so it must not carry a `:` or any other separator
/// that would forge a CN field. A Keycloak UUID `sub` always passes.
fn enrollment_account(account: &str) -> Option<&str> {
    account.strip_prefix("U:").filter(|sub| {
        !sub.is_empty()
            && sub
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

/// The enrollment store, or the honest refusal: without one shared with the
/// provisioning workload, a pairing or passcode written here would never be
/// read by the ceremony.
fn enrollment_store(state: &AccountState) -> Result<SharedEnrollmentStore, Response> {
    (state.pairings)().ok_or_else(unavailable)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairWrite {
    device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedDto {
    device_id: String,
    paired: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnpairedDto {
    device_id: String,
    removed: bool,
}

/// `POST /device-assignments/devices {deviceId}`, pair a Pin to the signed-in
/// wearer's own account, so it enrolls into their partition with their
/// passcode. The account is the caller's, never a request field.
async fn pair_device(
    State(state): State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<PairWrite>, JsonRejection>,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Ok(Json(write)) = body else {
        return bad_request("expected a JSON {deviceId} object");
    };
    let Some(device_id) = device_id(&write.device_id) else {
        return bad_request("deviceId is a Pin's hexadecimal device id");
    };
    let Some(sub) = enrollment_account(&account) else {
        return bad_request("this account's id cannot be written into a Pin's certificate");
    };
    let store = match enrollment_store(&state) {
        Ok(store) => store,
        Err(refused) => return refused,
    };
    // INFERRED Luma admission policy, shared with credential issuance. A web
    // pairing cannot bypass the server's one-Pin limit.
    match store.reserve_provisioned_device(&device_id).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                "this server already has a Pin; only that same Pin can be paired",
            )
                .into_response();
        }
        Err(_) => return unavailable(),
    }
    match store.claim_device_account(&device_id, sub).await {
        Ok(true) => Json(PairedDto {
            device_id,
            paired: true,
        })
        .into_response(),
        Ok(false) => (
            StatusCode::CONFLICT,
            "this Pin is paired to another account; its owner has to remove it first",
        )
            .into_response(),
        Err(_) => unavailable(),
    }
}

/// `DELETE /device-assignments/devices/{id}`, release one of the wearer's own
/// Pins. Compare-and-delete: a Pin another account holds is never released,
/// and answers `removed: false` exactly like one that was never paired.
async fn unpair_device(
    State(state): State<AccountState>,
    headers: HeaderMap,
    Path(raw_id): Path<String>,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Some(device_id) = device_id(&raw_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(sub) = account.strip_prefix("U:") else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let store = match enrollment_store(&state) {
        Ok(store) => store,
        Err(refused) => return refused,
    };
    match store.delete_device_account(&device_id, sub).await {
        Ok(removed) => Json(UnpairedDto { device_id, removed }).into_response(),
        Err(_) => unavailable(),
    }
}

// ── Pin passcode ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct PasscodeDto {
    set: bool,
}

/// Never `Debug`: it carries the passcode.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PasscodeWrite {
    passcode: String,
}

/// `GET /account-service/passcode`, whether the wearer has set one. The
/// passcode itself is not stored, so it can never be read back.
async fn get_passcode(State(state): State<AccountState>, headers: HeaderMap) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Some(sub) = enrollment_account(&account) else {
        return Json(PasscodeDto { set: false }).into_response();
    };
    let store = match enrollment_store(&state) {
        Ok(store) => store,
        Err(refused) => return refused,
    };
    match crate::enrollment::passcode_is_set(store.as_ref(), sub).await {
        Ok(set) => Json(PasscodeDto { set }).into_response(),
        Err(_) => unavailable(),
    }
}

/// `PUT /account-service/passcode {passcode}`, set or change the Pin
/// passcode: four digits. The old one stops working at once. A Pin already
/// set up keeps its lock-screen code until its next setup, as stock said
/// ("…which will apply to your Ai Pin after a factory reset"). INFERRED: no
/// old passcode is asked for, the signed-in session is the authority, as it
/// is for every other account write here.
async fn put_passcode(
    State(state): State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<PasscodeWrite>, JsonRejection>,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Ok(Json(write)) = body else {
        return bad_request("expected a JSON {passcode} object");
    };
    let Some(sub) = enrollment_account(&account) else {
        return bad_request("this account's id cannot be written into a Pin's certificate");
    };
    let store = match enrollment_store(&state) {
        Ok(store) => store,
        Err(refused) => return refused,
    };
    match crate::enrollment::set_passcode(store.as_ref(), sub, &write.passcode).await {
        Ok(()) => Json(PasscodeDto { set: true }).into_response(),
        Err(crate::enrollment::PasscodeError::Invalid) => {
            bad_request("a passcode is exactly four digits")
        }
        Err(crate::enrollment::PasscodeError::Store) => unavailable(),
    }
}

// ── Account deletion ────────────────────────────────────────────────────────

/// The phrase the wearer types to confirm, sent explicitly so a stray request
/// can never delete an account.
const DELETE_CONFIRMATION: &str = "DELETE";

/// Why an account with a Pin in block mode cannot be deleted yet.
const LOST_PIN_BLOCKS_DELETION: &str = "Unmark your lost Pin first: an account cannot be deleted \
     while one of its Pins is in block mode, because deleting it would unlock that Pin.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteAccountWrite {
    confirm: String,
}

/// `DELETE /account-service/account {confirm: "DELETE"}`, remove everything
/// Cosmos holds for the signed-in wearer: stored capture bytes, the keys their
/// Pin escrowed and Center minted (every kid naming their user), every store
/// row (`Store::purge_account`), their Pin pairings and their passcode.
///
/// Each step is idempotent, so a failure part-way answers 500 and a retry
/// finishes the job; `{deleted: true}` is sent only when every step held. The
/// sign-in identity is Keycloak's and is not removed here.
///
/// An account with any Pin in block mode is refused 409 before anything is
/// removed. The block list is one of the account's rows, so deleting the
/// account would lift block mode and unlock a lost Pin whose certificate still
/// names it. The wearer turns block mode off first. A list that cannot be read
/// is an outage, never "nothing blocked".
async fn delete_account(
    State(state): State<AccountState>,
    headers: HeaderMap,
    body: Result<Json<DeleteAccountWrite>, JsonRejection>,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    if !matches!(&body, Ok(Json(write)) if write.confirm == DELETE_CONFIRMATION) {
        return bad_request("send {\"confirm\": \"DELETE\"} to delete the account");
    }
    let Some(sub) = account.strip_prefix("U:").map(str::to_owned) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let pairings = match enrollment_store(&state) {
        Ok(store) => store,
        Err(refused) => return refused,
    };
    match device_block::device_blocks(&state.api.store, &account).await {
        Ok(blocks) if !blocks.is_empty() => {
            return (StatusCode::CONFLICT, LOST_PIN_BLOCKS_DELETION).into_response();
        }
        Ok(_) => {}
        Err(_) => return unavailable(),
    }
    if let Some(objects) = &state.api.objects
        && !objects.remove_principal(&account).await
    {
        return crate::web_api::delete_failed();
    }
    if purge_keys(&state.api.keys, &sub).await.is_err() {
        return crate::web_api::delete_failed();
    }
    if state.api.store.purge_account(&account).await.is_err() {
        return crate::web_api::delete_failed();
    }
    if purge_enrollment(pairings.as_ref(), &sub).await.is_err() {
        return crate::web_api::delete_failed();
    }
    Json(crate::web_api::DeletedDto { deleted: true }).into_response()
}

/// Remove every key-directory entry whose kid names `sub`: the Pin's krypton
/// kids (`d=…;u=<sub>;…`) and Center's `U:<sub>/…` kids.
async fn purge_keys(keys: &SharedKeyDirectory, sub: &str) -> Result<(), KeyDirectoryError> {
    for kid in keys.kids().await? {
        if crate::services::public_privacy::kid_user_id(&kid) == Some(sub) {
            keys.remove(&kid).await?;
        }
    }
    Ok(())
}

/// Release every Pin paired to `sub` and forget its passcode record.
async fn purge_enrollment(
    store: &dyn crate::enrollment::EnrollmentStore,
    sub: &str,
) -> crate::enrollment::Stored<()> {
    for pairing in store.device_accounts().await? {
        if pairing.account_sub == sub {
            store.delete_device_account(&pairing.device_id, sub).await?;
        }
    }
    store.delete_passcode_record(sub).await?;
    Ok(())
}

// ── Food intake ─────────────────────────────────────────────────────────────
//
// INFERRED. Stock shows the wearer no daily totals: `FoodNotableEventUtilities`
// (humane_food) can sum `humane.foodIntake` event properties but nothing calls
// it, the food agent's `GetFoodLog` tool hands the model a per-serving table
// (`FoodManager.createTable`) and leaves the arithmetic to it, and the recovered
// humane.center has no goals page. So Cosmos totals the one food log both
// planes read (`services::capture::open_food_logs`), and Center only renders.
//
// `FoodServiceWrapper.trackFoodItemConsumption` logs the catalogue `FoodItem`
// unscaled beside `servings_consumed`, so a food adds `value × servings`. A
// logged value is counted in the unit stock gives that nutrient
// (`FoodUtils.getUnitForNutrient`), and is converted to the goal's unit when
// both are weights. Energy is never compared with a weight.

/// `GET /account-service/food-intake?startTime&endTime`: RFC 3339 instants,
/// both inclusive. `startTime` is required, because the wearer's day starts at
/// a local midnight only the caller knows; `endTime` may be left open.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoodIntakeQuery {
    start_time: Option<String>,
    end_time: Option<String>,
}

/// A total against its goal. Absent when there is no goal to compare with.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum GoalStatus {
    Under,
    Met,
    Over,
}

/// One nutrient's total over the window, beside the wearer's goal for it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NutrientIntakeDto {
    #[serde(rename = "type")]
    nutrient: &'static str,
    /// The unit of `consumed`, `min` and `max`: the goal's, when the logged
    /// amounts convert to it, else the one stock counts the nutrient in.
    unit: &'static str,
    /// Rounded to a tenth of `unit` before it is compared, so a shown total and
    /// its status never disagree.
    consumed: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<GoalStatus>,
    /// Logged foods with no figure for this nutrient: they add nothing to it.
    unreported: usize,
    /// A goal is set in a unit the total cannot be converted to, so it is not
    /// compared.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    goal_unit_mismatch: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoodIntakeDto {
    /// Foods logged in the window.
    logged: usize,
    /// Calories first, then every other nutrient a goal covers, in goal order.
    nutrients: Vec<NutrientIntakeDto>,
}

/// Stock `FoodUtils.getUnitForNutrient`: the unit a logged value is counted in.
fn logged_unit(nutrient: NutrientType) -> NutrientUnit {
    match nutrient {
        NutrientType::Calories => NutrientUnit::Kcal,
        NutrientType::Calcium
        | NutrientType::Cholesterol
        | NutrientType::Iron
        | NutrientType::Potassium
        | NutrientType::Sodium
        | NutrientType::VitaminC => NutrientUnit::Milligrams,
        NutrientType::VitaminA => NutrientUnit::Micrograms,
        _ => NutrientUnit::Grams,
    }
}

/// Grams in one `unit`; `None` for energy.
fn grams_in(unit: NutrientUnit) -> Option<f64> {
    match unit {
        NutrientUnit::Grams => Some(1.0),
        NutrientUnit::Milligrams => Some(1e-3),
        NutrientUnit::Micrograms => Some(1e-6),
        NutrientUnit::Kcal | NutrientUnit::Unknown => None,
    }
}

/// How much of `to` one `from` is, when the two measure the same thing.
fn per_unit(from: NutrientUnit, to: NutrientUnit) -> Option<f64> {
    if from == to {
        return Some(1.0);
    }
    Some(grams_in(from)? / grams_in(to)?)
}

fn goal_status(consumed: f64, min: Option<f32>, max: Option<f32>) -> Option<GoalStatus> {
    if min.is_none() && max.is_none() {
        return None;
    }
    // A goal is the stock `float`: 60.7 is kept a hair above 60.7. Compared at
    // that precision, a total shown equal to its goal meets it.
    let consumed = consumed as f32;
    Some(if min.is_some_and(|min| consumed < min) {
        GoalStatus::Under
    } else if max.is_some_and(|max| consumed > max) {
        GoalStatus::Over
    } else {
        GoalStatus::Met
    })
}

fn nutrient_intake(
    logs: &[cosmos_protocol::common::food::FoodLog],
    goals: &pb::DailyIntakeGoals,
    nutrient: NutrientType,
) -> NutrientIntakeDto {
    let goal = goals
        .nutrient_goals
        .iter()
        .find(|goal| goal.r#type == nutrient as i32);
    let own = logged_unit(nutrient);
    let comparable = goal.and_then(|goal| {
        let unit = NutrientUnit::try_from(goal.unit).ok()?;
        Some((goal, unit, per_unit(own, unit)?))
    });
    let (unit, per) = comparable.map_or((own, 1.0), |(_, unit, per)| (unit, per));
    let mut consumed = 0.0;
    let mut unreported = 0;
    for log in logs {
        // The last figure for a nutrient wins, as in `createTable`'s map.
        let figure = log.food_item.as_ref().and_then(|item| {
            item.nutrition_info
                .iter()
                .rev()
                .find(|info| info.nutrient_type == nutrient as i32)
        });
        match figure {
            Some(info) => {
                consumed += f64::from(info.value) * f64::from(log.servings_consumed) * per;
            }
            None => unreported += 1,
        }
    }
    let consumed = (consumed * 10.0).round() / 10.0;
    let (min, max) = comparable.map_or((None, None), |(goal, _, _)| {
        (
            goal.is_min_set.then_some(goal.min_value),
            goal.is_max_set.then_some(goal.max_value),
        )
    });
    NutrientIntakeDto {
        nutrient: nutrient.as_str_name(),
        unit: unit.as_str_name(),
        consumed,
        min,
        max,
        status: goal_status(consumed, min, max),
        unreported,
        goal_unit_mismatch: goal.is_some() && comparable.is_none(),
    }
}

fn food_intake(
    logs: &[cosmos_protocol::common::food::FoodLog],
    goals: &pb::DailyIntakeGoals,
) -> FoodIntakeDto {
    let mut nutrients = vec![NutrientType::Calories];
    for goal in &goals.nutrient_goals {
        if let Ok(nutrient) = NutrientType::try_from(goal.r#type)
            && nutrient != NutrientType::Undefined
            && !nutrients.contains(&nutrient)
        {
            nutrients.push(nutrient);
        }
    }
    FoodIntakeDto {
        logged: logs.len(),
        nutrients: nutrients
            .into_iter()
            .map(|nutrient| nutrient_intake(logs, goals, nutrient))
            .collect(),
    }
}

/// `GET /account-service/food-intake?startTime&endTime`.
async fn get_food_intake(
    State(state): State<AccountState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<FoodIntakeQuery>,
) -> Response {
    let account = match state.api.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let (Ok(Some(start)), Ok(end)) = (
        crate::capture_api::instant(query.start_time.as_deref()),
        crate::capture_api::instant(query.end_time.as_deref()),
    ) else {
        return bad_request("startTime is required, and both bounds are RFC 3339 instants");
    };
    if end.is_some_and(|end| end < start) {
        return bad_request("endTime is before startTime");
    }
    let logs = match crate::services::capture::open_food_logs(
        &state.api.store,
        &state.api.keys,
        &account,
        start,
        end,
    )
    .await
    .and_then(crate::services::capture::FoodLogWindow::complete)
    {
        Ok(opened) => opened
            .into_iter()
            .map(|entry| entry.log)
            .collect::<Vec<_>>(),
        Err(status) => {
            if status.code() == tonic::Code::FailedPrecondition {
                crate::web_api::key_directory_miss(
                    &state.api.keys,
                    "food-intake",
                    "a food-log entry could not be opened",
                );
            }
            // A day missing a meal would under-count it: an outage, never a total.
            return unavailable();
        }
    };
    let Ok(goals) = account::daily_intake_goals(&state.api.store, &account).await else {
        return unavailable();
    };
    Json(food_intake(&logs, &goals)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_api::DEMO_PRINCIPAL;
    use crate::web_api::test_support::*;
    use axum::http::Method;
    use serde_json::json;

    fn app_with(
        store: crate::store::SharedStore,
        keys: SharedKeyDirectory,
        pairings: SharedEnrollmentStore,
    ) -> Router {
        routes(
            ApiState::for_tests(
                store,
                keys,
                DEMO_PRINCIPAL,
                internet_facing(),
                Some(test_verifier()),
                None,
            ),
            Arc::new(move || Some(pairings.clone())),
        )
    }

    /// A request from alice's Pin behind the edge: the device plane.
    fn pin_of(account: &str) -> Vec<(&'static str, String)> {
        let [xfcc, ..] = edge_subjects(account);
        vec![
            (crate::config::EDGE_PRINCIPAL_HEADER, xfcc),
            (crate::config::EDGE_TOKEN_HEADER, EDGE_TOKEN.to_owned()),
        ]
    }

    // INFERRED owner-only view: privacy consent has an observable outcome,
    // without returning another account's location or any diagnostic content.
    #[tokio::test]
    async fn privacy_details_are_web_only_and_never_cross_accounts() {
        let store = fresh();
        let app = app_with(
            store,
            fresh_keys(),
            crate::enrollment::MemoryEnrollmentStore::shared(),
        );
        let uri = "/account-service/privacy-details";
        assert_eq!(
            send(&app, Method::GET, uri, &[], None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(&app, Method::GET, uri, &pin_of("alice"), None).await.0,
            StatusCode::FORBIDDEN
        );
        for account in ["alice", "bob"] {
            let (status, body) =
                send(&app, Method::GET, uri, &[bearer_header(account)], None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["lastLocationEnabled"], false);
            assert_eq!(body["diagnosticsEnabled"], false);
            assert!(body["lastLocation"].is_null());
            assert!(body["diagnostics"].is_null());
        }
    }

    #[tokio::test]
    async fn privacy_details_show_verified_location_and_content_free_outcome_only_to_owner() {
        use cosmos_protocol::common::encryption::{
            EncryptedData, EncryptionInformation, LocationEnvelope,
        };
        use prost::Message;
        let store = fresh();
        let keys = fresh_keys();
        let kid = "U:alice/center/ephemeral/privacy";
        let key = [0x35; cosmos_crypto::AES_KEY_LEN];
        keys.put(kid, key).await.unwrap();
        let settings = cosmos_protocol::privacy::grpc::r#pub::GetSettingsResponse {
            settings: ["last_location", "traces"]
                .into_iter()
                .map(
                    |name| cosmos_protocol::privacy::grpc::common::PrivacySettingInfo {
                        name: name.into(),
                        value: "on".into(),
                        ..Default::default()
                    },
                )
                .collect(),
        };
        store
            .put_account_blob(
                "U:alice",
                AccountBlobKind::PrivacySettings,
                &settings.encode_to_vec(),
            )
            .await
            .unwrap();
        let location = LocationEnvelope {
            latitude: 52.1,
            longitude: 21.2,
            human_readable: "Fixture location".into(),
            stalestatus: 1,
            timestamp: Some(prost_types::Timestamp {
                seconds: 1_790_000_000,
                nanos: 123_000_000,
            }),
            ..Default::default()
        };
        let sealed = cosmos_crypto::seal(
            kid,
            &key,
            &location.encode_to_vec(),
            b"humane.common.encryption.LocationEnvelope",
        )
        .unwrap();
        crate::services::public_privacy::record_last_location(
            &store,
            &keys,
            "U:alice",
            &EncryptedData {
                encryption_information: Some(EncryptionInformation { kid: kid.into() }),
                data: sealed.data,
            },
        )
        .await
        .unwrap();
        crate::services::public_privacy::record_diagnostic(
            &store, "U:alice", "weather", "legacy", "complete", 123,
        )
        .await
        .unwrap();
        let app = app_with(
            store.clone(),
            keys,
            crate::enrollment::MemoryEnrollmentStore::shared(),
        );
        let uri = "/account-service/privacy-details";
        let (status, body) = send(&app, Method::GET, uri, &[bearer_header("alice")], None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["lastLocation"]["humanReadable"], "Fixture location");
        assert_eq!(body["lastLocation"]["staleStatus"], "stale");
        assert_eq!(body["lastLocation"]["timestamp"], 1_790_000_000_123_i64);
        assert_eq!(body["diagnostics"]["elapsedMs"], 123);
        assert_eq!(
            body["diagnostics"].as_object().unwrap().len(),
            5,
            "no prompt, account, provider result or coordinates in diagnostics"
        );
        let (_, bob) = send(&app, Method::GET, uri, &[bearer_header("bob")], None).await;
        assert!(bob["lastLocation"].is_null());
        assert!(bob["diagnostics"].is_null());
        assert!(
            !store
                .get_account_blob("U:alice", AccountBlobKind::LastLocation)
                .await
                .unwrap()
                .unwrap()
                .windows(b"Fixture location".len())
                .any(|bytes| bytes == b"Fixture location"),
            "location remains sealed at rest"
        );
    }

    /// Every route is the signed-in wearer's own: a Pin is 403, nobody is 401,
    /// and one wearer never sees another's Pins, statuses or blocks.
    #[tokio::test]
    async fn devices_route_is_web_plane_and_principal_scoped() {
        let store = fresh();
        let pairings = crate::enrollment::MemoryEnrollmentStore::shared();
        pairings
            .claim_device_account("a1b2c3", "alice")
            .await
            .unwrap();
        pairings
            .claim_device_account("0badcafe", "bob")
            .await
            .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        store
            .put_account_blob(
                &status_owner("U:alice", "a1b2c3"),
                AccountBlobKind::DeviceStatus,
                &serde_json::to_vec(&json!({
                    "device_id": "a1b2c3",
                    "serial_number": "SN-1",
                    "firmware_version": "1.2",
                    "os_version": "14",
                    "battery_percent": 80,
                    "battery_charging": true,
                    "reported_at_epoch": now,
                    "wifi_networks": [{"ssid": "Home", "authorization_type": "WPA2", "connected": true}]
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let app = app_with(store.clone(), fresh_keys(), pairings);

        for (method, uri) in [
            (Method::GET, "/device-assignments/devices"),
            (Method::POST, "/device-assignments/devices/a1b2c3/block"),
            (Method::DELETE, "/device-assignments/devices/a1b2c3/block"),
            (Method::GET, "/account-service/profile"),
            (Method::GET, "/account-service/food-preferences"),
        ] {
            let (status, _) = send(&app, method.clone(), uri, &pin_of("alice"), None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri} from a Pin");
            let (status, _) = send(&app, method.clone(), uri, &[], None).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {uri} from nobody"
            );
        }

        let alice = [bearer_header("alice")];
        let (status, body) = send(
            &app,
            Method::GET,
            "/device-assignments/devices",
            &alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let devices = body["devices"].as_array().unwrap();
        assert_eq!(devices.len(), 1, "only alice's Pin: {body}");
        assert_eq!(devices[0]["deviceId"], "a1b2c3");
        assert_eq!(devices[0]["serialNumber"], "SN-1");
        assert_eq!(devices[0]["blocked"], false);
        assert_eq!(devices[0]["status"]["batteryPercent"], 80);
        assert_eq!(devices[0]["status"]["wifiNetworks"][0]["ssid"], "Home");
        assert!(devices[0]["pairedAt"].as_str().unwrap().ends_with('Z'));

        // Marking it lost is what the block layer refuses.
        let (status, body) = send(
            &app,
            Method::POST,
            "/device-assignments/devices/A1B2C3/block",
            &alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deviceId"], "a1b2c3");
        assert_eq!(body["blocked"], true);
        let blocks = device_block::device_blocks(&store, "U:alice")
            .await
            .unwrap();
        assert_eq!(
            blocks.get("a1b2c3").unwrap().reasons,
            vec![pb::UnauthorizedStatusCode::DeviceLostOrStolen as i32]
        );
        let (_, body) = send(
            &app,
            Method::GET,
            "/device-assignments/devices",
            &alice,
            None,
        )
        .await;
        assert_eq!(body["devices"][0]["blocked"], true);

        // Bob sees only his own Pin, and his block list is untouched.
        let (_, body) = send(
            &app,
            Method::GET,
            "/device-assignments/devices",
            &[bearer_header("bob")],
            None,
        )
        .await;
        let devices = body["devices"].as_array().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0]["deviceId"], "0badcafe");
        assert_eq!(devices[0]["blocked"], false);
        assert!(devices[0].get("status").is_none());
        assert!(
            device_block::device_blocks(&store, "U:bob")
                .await
                .unwrap()
                .iter()
                .next()
                .is_none()
        );

        // A Pin still blocked after its pairing went stays listed, so block
        // mode can be turned off. Then it is gone.
        send(
            &app,
            Method::POST,
            "/device-assignments/devices/beef/block",
            &alice,
            None,
        )
        .await;
        let (_, body) = send(
            &app,
            Method::GET,
            "/device-assignments/devices",
            &alice,
            None,
        )
        .await;
        assert_eq!(body["devices"][1]["deviceId"], "beef");
        assert!(body["devices"][1].get("pairedAt").is_none());
        let (status, body) = send(
            &app,
            Method::DELETE,
            "/device-assignments/devices/beef/block",
            &alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["blocked"], false);
        let (_, body) = send(
            &app,
            Method::GET,
            "/device-assignments/devices",
            &alice,
            None,
        )
        .await;
        assert_eq!(body["devices"].as_array().unwrap().len(), 1);

        // Only a device id is ever blocked.
        let (status, _) = send(
            &app,
            Method::POST,
            "/device-assignments/devices/not-a-device/block",
            &alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// Pairing is the wearer's own web write: a Pin goes to the caller's own
    /// account, a Pin another account holds is refused, nobody but its owner can
    /// release it, and neither a Pin nor an anonymous caller can do either.
    #[tokio::test]
    async fn pairing_is_the_wearers_own_and_cannot_take_another_accounts_pin() {
        let pairings = crate::enrollment::MemoryEnrollmentStore::shared();
        let app = app_with(fresh(), fresh_keys(), pairings.clone());
        let pair = |id: &str| Some(json!({ "deviceId": id }));

        for (method, uri) in [
            (Method::POST, "/device-assignments/devices"),
            (Method::DELETE, "/device-assignments/devices/a1b2c3"),
            (Method::GET, "/account-service/passcode"),
            (Method::PUT, "/account-service/passcode"),
            (Method::DELETE, "/account-service/account"),
        ] {
            let (status, _) =
                send(&app, method.clone(), uri, &pin_of("alice"), pair("a1b2c3")).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri} from a Pin");
            let (status, _) = send(&app, method.clone(), uri, &[], pair("a1b2c3")).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {uri} from nobody"
            );
        }
        assert_eq!(pairings.device_account("a1b2c3").await.unwrap(), None);

        let alice = [bearer_header("alice")];
        let bob = [bearer_header("bob")];
        let (status, body) = send(
            &app,
            Method::POST,
            "/device-assignments/devices",
            &alice,
            pair("A1B2C3"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deviceId": "a1b2c3", "paired": true}));
        let (status, _) = send(
            &app,
            Method::POST,
            "/device-assignments/devices",
            &alice,
            pair("beef"),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "one Pin for the entire server"
        );
        assert_eq!(
            pairings.device_account("a1b2c3").await.unwrap().as_deref(),
            Some("alice"),
            "the account is the caller's, never a request field"
        );
        let (_, listed) = send(
            &app,
            Method::GET,
            "/device-assignments/devices",
            &alice,
            None,
        )
        .await;
        assert_eq!(listed["devices"][0]["deviceId"], "a1b2c3");

        // Pairing it again is harmless. Bob cannot take it or release it.
        let (status, _) = send(
            &app,
            Method::POST,
            "/device-assignments/devices",
            &alice,
            pair("a1b2c3"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = send(
            &app,
            Method::POST,
            "/device-assignments/devices",
            &bob,
            pair("a1b2c3"),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, body) = send(
            &app,
            Method::DELETE,
            "/device-assignments/devices/a1b2c3",
            &bob,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["removed"], false);
        assert_eq!(
            pairings.device_account("a1b2c3").await.unwrap().as_deref(),
            Some("alice")
        );

        // Only a device id is ever paired.
        for bad in [
            json!({"deviceId": "not-a-pin"}),
            json!({"device_id": "a1b2c3"}),
        ] {
            let (status, _) = send(
                &app,
                Method::POST,
                "/device-assignments/devices",
                &alice,
                Some(bad),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }

        // Its owner releases it. Then bob may pair it.
        let (_, body) = send(
            &app,
            Method::DELETE,
            "/device-assignments/devices/a1b2c3",
            &alice,
            None,
        )
        .await;
        assert_eq!(body, json!({"deviceId": "a1b2c3", "removed": true}));
        let (status, _) = send(
            &app,
            Method::POST,
            "/device-assignments/devices",
            &bob,
            pair("a1b2c3"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            pairings.device_account("a1b2c3").await.unwrap().as_deref(),
            Some("bob")
        );
    }

    /// The Pin passcode is set from the web into the wearer's own account, is
    /// never stored or answered in plaintext, and only four digits are taken.
    #[tokio::test]
    async fn the_passcode_is_set_per_account_and_never_returned() {
        let pairings = crate::enrollment::MemoryEnrollmentStore::shared();
        let app = app_with(fresh(), fresh_keys(), pairings.clone());
        let alice = [bearer_header("alice")];

        let (status, body) =
            send(&app, Method::GET, "/account-service/passcode", &alice, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"set": false}));

        for bad in [
            json!({"passcode": "123"}),
            json!({"passcode": "12a4"}),
            json!({"passcode": 1234}),
            json!({"pin": "1234"}),
        ] {
            let (status, _) = send(
                &app,
                Method::PUT,
                "/account-service/passcode",
                &alice,
                Some(bad),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }
        assert!(pairings.passcode_record("alice").await.unwrap().is_none());

        let (status, body) = send(
            &app,
            Method::PUT,
            "/account-service/passcode",
            &alice,
            Some(json!({"passcode": "4821"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"set": true}), "the passcode is never echoed");
        let (_, body) = send(&app, Method::GET, "/account-service/passcode", &alice, None).await;
        assert_eq!(body, json!({"set": true}));

        let record = pairings.passcode_record("alice").await.unwrap().unwrap();
        assert!(!record.windows(4).any(|window| window == b"4821"));
        assert!(
            pairings.passcode_record("bob").await.unwrap().is_none(),
            "set under the caller's own account only"
        );
        let (_, body) = send(
            &app,
            Method::GET,
            "/account-service/passcode",
            &[bearer_header("bob")],
            None,
        )
        .await;
        assert_eq!(body, json!({"set": false}));

        // A change replaces the record.
        send(
            &app,
            Method::PUT,
            "/account-service/passcode",
            &alice,
            Some(json!({"passcode": "9999"})),
        )
        .await;
        assert_ne!(
            pairings.passcode_record("alice").await.unwrap().unwrap(),
            record
        );
    }

    /// Deleting the account removes everything Cosmos holds for that wearer,
    /// store rows, their Pins' status rows, capture bytes, escrowed and minted
    /// keys, pairings and the passcode, and nothing of anyone else's. It needs
    /// the typed confirmation, and a Pin cannot ask for it.
    #[tokio::test]
    async fn deleting_the_account_removes_that_wearer_and_nobody_else() {
        use crate::store::{NewNote, NoteSource};

        let store = fresh();
        let keys = fresh_keys();
        let pairings = crate::enrollment::MemoryEnrollmentStore::shared();
        let objects = crate::services::capture::CaptureObjectStore::for_tests();
        let app = routes(
            ApiState::for_tests(
                store.clone(),
                keys.clone(),
                DEMO_PRINCIPAL,
                internet_facing(),
                Some(test_verifier()),
                Some(objects.clone()),
            ),
            Arc::new({
                let pairings = pairings.clone();
                move || Some(pairings.clone())
            }),
        );

        for (sub, device) in [("alice", "a1b2c3"), ("bob", "0badcafe")] {
            let principal = format!("U:{sub}");
            store
                .create_note(&principal, NewNote::text(NoteSource::Web, "a note"))
                .await
                .unwrap();
            store
                .put_account_blob(&principal, AccountBlobKind::PersonalDetails, b"details")
                .await
                .unwrap();
            store
                .put_account_blob(
                    &status_owner(&principal, device),
                    AccountBlobKind::DeviceStatus,
                    b"{}",
                )
                .await
                .unwrap();
            keys.put(
                &format!("{principal}/account-service/food-restrictions"),
                [1; 16],
            )
            .await
            .unwrap();
            keys.put(&format!("d={device};u={sub};s=1;a=1;00;01"), [2; 16])
                .await
                .unwrap();
            let path = objects
                .object_path_for_tests(&principal, "memory/burst/frame.bin")
                .unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"frame").unwrap();
            pairings.claim_device_account(device, sub).await.unwrap();
            crate::enrollment::set_passcode(pairings.as_ref(), sub, "1234")
                .await
                .unwrap();
        }
        keys.put("unattributable-kid", [3; 16]).await.unwrap();

        let alice = [bearer_header("alice")];
        for body in [None, Some(json!({"confirm": "delete"})), Some(json!({}))] {
            let (status, _) = send(
                &app,
                Method::DELETE,
                "/account-service/account",
                &alice,
                body,
            )
            .await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "the typed confirmation is required"
            );
        }
        assert_eq!(
            store.count_notes("U:alice").await.unwrap(),
            1,
            "nothing went"
        );

        let (status, body) = send(
            &app,
            Method::DELETE,
            "/account-service/account",
            &alice,
            Some(json!({"confirm": "DELETE"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": true}));

        // Alice: nothing left.
        assert_eq!(store.count_notes("U:alice").await.unwrap(), 0);
        assert_eq!(
            store
                .get_account_blob("U:alice", AccountBlobKind::PersonalDetails)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .get_account_blob(
                    &status_owner("U:alice", "a1b2c3"),
                    AccountBlobKind::DeviceStatus
                )
                .await
                .unwrap(),
            None
        );
        assert!(
            !keys
                .holds("U:alice/account-service/food-restrictions")
                .await
                .unwrap()
        );
        assert!(!keys.holds("d=a1b2c3;u=alice;s=1;a=1;00;01").await.unwrap());
        assert!(
            !objects
                .object_path_for_tests("U:alice", "memory/burst/frame.bin")
                .unwrap()
                .exists()
        );
        assert_eq!(pairings.device_account("a1b2c3").await.unwrap(), None);
        assert!(pairings.passcode_record("alice").await.unwrap().is_none());

        // Bob, and a kid naming nobody: untouched.
        assert_eq!(store.count_notes("U:bob").await.unwrap(), 1);
        assert!(
            store
                .get_account_blob(
                    &status_owner("U:bob", "0badcafe"),
                    AccountBlobKind::DeviceStatus
                )
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            keys.holds("U:bob/account-service/food-restrictions")
                .await
                .unwrap()
        );
        assert!(keys.holds("d=0badcafe;u=bob;s=1;a=1;00;01").await.unwrap());
        assert!(keys.holds("unattributable-kid").await.unwrap());
        assert!(
            objects
                .object_path_for_tests("U:bob", "memory/burst/frame.bin")
                .unwrap()
                .exists()
        );
        assert_eq!(
            pairings
                .device_account("0badcafe")
                .await
                .unwrap()
                .as_deref(),
            Some("bob")
        );
        assert!(pairings.passcode_record("bob").await.unwrap().is_some());

        // Deleting what is already gone is still a success.
        let (status, _) = send(
            &app,
            Method::DELETE,
            "/account-service/account",
            &alice,
            Some(json!({"confirm": "DELETE"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    /// A lost Pin is never unlocked by deleting its account. The block list is
    /// one of the account's rows, so while any Pin is in block mode, paired or
    /// not, deletion is refused 409 and nothing is removed. Once the wearer
    /// unmarks it, the same request deletes the account.
    #[tokio::test]
    async fn an_account_with_a_lost_pin_is_not_deleted_until_the_pin_is_unmarked() {
        use crate::store::{NewNote, NoteSource};

        assert!(LOST_PIN_BLOCKS_DELETION.starts_with("Unmark your lost Pin first"));
        let store = fresh();
        let pairings = crate::enrollment::MemoryEnrollmentStore::shared();
        let app = app_with(store.clone(), fresh_keys(), pairings.clone());
        store
            .create_note("U:alice", NewNote::text(NoteSource::Web, "a note"))
            .await
            .unwrap();
        pairings
            .claim_device_account("a1b2c3", "alice")
            .await
            .unwrap();
        crate::enrollment::set_passcode(pairings.as_ref(), "alice", "1234")
            .await
            .unwrap();
        let alice = [bearer_header("alice")];
        let delete = || {
            send(
                &app,
                Method::DELETE,
                "/account-service/account",
                &alice,
                Some(json!({"confirm": "DELETE"})),
            )
        };

        // A lost Pin still paired, then one whose pairing already went: both
        // keep the account.
        for released in [false, true] {
            if released {
                let (status, _) = send(
                    &app,
                    Method::DELETE,
                    "/device-assignments/devices/a1b2c3",
                    &alice,
                    None,
                )
                .await;
                assert_eq!(status, StatusCode::OK);
            }
            let (status, _) = send(
                &app,
                Method::POST,
                "/device-assignments/devices/a1b2c3/block",
                &alice,
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK);

            let (status, _) = delete().await;
            assert_eq!(status, StatusCode::CONFLICT, "released: {released}");
            assert_eq!(store.count_notes("U:alice").await.unwrap(), 1);
            assert!(
                device_block::device_blocks(&store, "U:alice")
                    .await
                    .unwrap()
                    .get("a1b2c3")
                    .is_some(),
                "the block survives"
            );
            assert!(pairings.passcode_record("alice").await.unwrap().is_some());
        }

        let (status, _) = send(
            &app,
            Method::DELETE,
            "/device-assignments/devices/a1b2c3/block",
            &alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = delete().await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": true}));
        assert_eq!(store.count_notes("U:alice").await.unwrap(), 0);
    }

    /// A block list that cannot be read is an outage, never "nothing blocked":
    /// the deletion is refused 503 and nothing is removed, block list included.
    #[tokio::test]
    async fn an_unreadable_block_list_never_lets_an_account_be_deleted() {
        use crate::store::{NewNote, NoteSource};

        let store = fresh();
        let pairings = crate::enrollment::MemoryEnrollmentStore::shared();
        let app = app_with(store.clone(), fresh_keys(), pairings.clone());
        store
            .create_note("U:alice", NewNote::text(NoteSource::Web, "a note"))
            .await
            .unwrap();
        pairings
            .claim_device_account("a1b2c3", "alice")
            .await
            .unwrap();
        store
            .put_account_blob("U:alice", AccountBlobKind::DeviceBlocks, b"not json")
            .await
            .unwrap();

        let (status, _) = send(
            &app,
            Method::DELETE,
            "/account-service/account",
            &[bearer_header("alice")],
            Some(json!({"confirm": "DELETE"})),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(store.count_notes("U:alice").await.unwrap(), 1);
        assert_eq!(
            pairings.device_account("a1b2c3").await.unwrap().as_deref(),
            Some("alice")
        );
        assert_eq!(
            store
                .get_account_blob("U:alice", AccountBlobKind::DeviceBlocks)
                .await
                .unwrap()
                .as_deref(),
            Some(&b"not json"[..])
        );
    }
}
