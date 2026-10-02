//! Food logs: the sealed per-account log blob, its validation bounds, and the
//! compare-and-swap writes `CaptureService` food-log calls make.

use super::*;

const MAX_FOOD_LOGS: usize = 512;
const MAX_FOOD_LOG_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_FOOD_LOG_TOTAL_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_FOOD_LOG_SUMMARY_BYTES: usize = MAX_FOOD_LOG_TOTAL_BYTES + 64 * 1024;
const MAX_FOOD_ITEM_NAME_BYTES: usize = 256;
const MAX_FOOD_ITEM_BRAND_BYTES: usize = 128;
const MAX_FOOD_ITEM_SERVING_BYTES: usize = 64;
const MAX_FOOD_ITEM_REQUEST_UUID_BYTES: usize = 128;
const MAX_FOOD_NUTRIENTS: usize = 64;
const MAX_FOOD_NUMERIC_VALUE: f32 = 10_000_000.0;
const FOOD_LOG_CAS_RETRIES: usize = 32;
const FOOD_LOG_PLAINTEXT_KID: &str = "humane.common.food.FoodLog";
pub(super) const FOOD_LOG_SUMMARY_PLAINTEXT_KID: &str = "humane.common.food.FoodLogSummary";

#[derive(Clone, PartialEq, prost::Message)]
struct StoredFoodLog {
    #[prost(string, tag = "1")]
    memory_uuid: String,
    #[prost(int64, tag = "2")]
    created_seconds: i64,
    #[prost(int32, tag = "3")]
    created_nanos: i32,
    #[prost(message, optional, tag = "4")]
    sealed: Option<cosmos_protocol::common::encryption::EncryptedData>,
}

#[derive(Clone, PartialEq, prost::Message)]
struct StoredFoodLogs {
    #[prost(message, repeated, tag = "1")]
    entries: Vec<StoredFoodLog>,
}

pub(super) enum FoodLogSummaryProtection {
    Encrypted(String),
    Plaintext,
}

pub(super) fn food_log_start_time(
    timestamp: Option<prost_types::Timestamp>,
) -> Result<crate::store::SyncTime, Status> {
    let timestamp = timestamp.ok_or_else(|| Status::invalid_argument("start_time is required"))?;
    if !(MIN_PROTOBUF_TIMESTAMP_SECONDS..=MAX_PROTOBUF_TIMESTAMP_SECONDS)
        .contains(&timestamp.seconds)
        || !(0..=999_999_999).contains(&timestamp.nanos)
    {
        return Err(Status::invalid_argument("start_time is invalid"));
    }
    Ok(crate::store::SyncTime::from_parts(
        timestamp.seconds,
        timestamp.nanos,
    ))
}

fn valid_food_text(value: &str, maximum_bytes: usize, may_be_empty: bool) -> bool {
    value.len() <= maximum_bytes
        && (may_be_empty || !value.trim().is_empty())
        && !value.chars().any(char::is_control)
}

fn decode_valid_food_log(payload: &[u8]) -> Option<FoodLog> {
    if payload.len() > MAX_FOOD_LOG_PAYLOAD_BYTES {
        return None;
    }
    let log = FoodLog::decode(payload).ok()?;
    let item = log.food_item.as_ref()?;
    if !valid_food_text(&item.item_name, MAX_FOOD_ITEM_NAME_BYTES, false)
        || !valid_food_text(&item.brand, MAX_FOOD_ITEM_BRAND_BYTES, true)
        || !valid_food_text(
            &item.typical_serving_size,
            MAX_FOOD_ITEM_SERVING_BYTES,
            true,
        )
        || !valid_food_text(&item.request_uuid, MAX_FOOD_ITEM_REQUEST_UUID_BYTES, true)
        || item.nutrition_info.len() > MAX_FOOD_NUTRIENTS
        || !log.servings_consumed.is_finite()
        || log.servings_consumed <= 0.0
        || log.servings_consumed > MAX_FOOD_NUMERIC_VALUE
        || item.nutrition_info.iter().any(|nutrient| {
            NutrientType::try_from(nutrient.nutrient_type).is_err()
                || !nutrient.value.is_finite()
                || nutrient.value < 0.0
                || nutrient.value > MAX_FOOD_NUMERIC_VALUE
        })
    {
        return None;
    }
    Some(log)
}

pub(super) async fn save_food_log(
    store: &crate::store::SharedStore,
    principal: &str,
    memory_uuid: &str,
    created: crate::store::SyncTime,
    sealed: cosmos_protocol::common::encryption::EncryptedData,
) -> Result<(), Status> {
    for _ in 0..FOOD_LOG_CAS_RETRIES {
        let previous = store
            .get_account_blob(principal, crate::store::AccountBlobKind::FoodLogs)
            .await?;
        let mut logs = previous
            .as_deref()
            .and_then(|bytes| StoredFoodLogs::decode(bytes).ok())
            .unwrap_or_default();
        let entry = StoredFoodLog {
            memory_uuid: memory_uuid.to_owned(),
            created_seconds: created.seconds(),
            created_nanos: created.nanos(),
            sealed: Some(sealed.clone()),
        };
        if let Some(index) = logs
            .entries
            .iter()
            .position(|stored| stored.memory_uuid == memory_uuid)
        {
            logs.entries[index] = entry;
        } else {
            logs.entries.push(entry);
        }
        logs.entries
            .sort_by_key(|entry| (entry.created_seconds, entry.created_nanos));
        if logs.entries.len() > MAX_FOOD_LOGS {
            let remove = logs.entries.len() - MAX_FOOD_LOGS;
            logs.entries.drain(..remove);
        }
        if store
            .compare_and_swap_account_blob(
                principal,
                crate::store::AccountBlobKind::FoodLogs,
                previous.as_deref(),
                &logs.encode_to_vec(),
            )
            .await?
        {
            return Ok(());
        }
    }
    Err(Status::aborted("food log changed concurrently; retry"))
}

/// Take a deleted food-log capture's entry out of the stored food log, so
/// `GetFoodLogSummary` and the web's food log stop counting a meal the wearer
/// deleted. Idempotent: an entry already gone is success.
pub(super) async fn remove_food_log(
    store: &crate::store::SharedStore,
    principal: &str,
    memory_uuid: &str,
) -> Result<(), Status> {
    for _ in 0..FOOD_LOG_CAS_RETRIES {
        let previous = store
            .get_account_blob(principal, crate::store::AccountBlobKind::FoodLogs)
            .await?;
        let Some(mut logs) = previous
            .as_deref()
            .and_then(|bytes| StoredFoodLogs::decode(bytes).ok())
        else {
            return Ok(());
        };
        let before = logs.entries.len();
        logs.entries
            .retain(|entry| entry.memory_uuid != memory_uuid);
        if logs.entries.len() == before {
            return Ok(());
        }
        if store
            .compare_and_swap_account_blob(
                principal,
                crate::store::AccountBlobKind::FoodLogs,
                previous.as_deref(),
                &logs.encode_to_vec(),
            )
            .await?
        {
            return Ok(());
        }
    }
    Err(Status::aborted("food log changed concurrently; retry"))
}

/// One logged `humane.common.food.FoodLog`, opened.
pub(crate) struct OpenedFoodLog {
    pub(crate) memory_uuid: String,
    /// When the Pin logged it (`FoodLogMemoryRequest.device_created_time`).
    pub(crate) logged: crate::store::SyncTime,
    pub(crate) log: FoodLog,
    pub(super) protection: FoodLogSummaryProtection,
}

/// What [`open_food_logs`] read from one window: the entries it opened, and
/// how many were sealed under a channel key this deployment does not hold.
pub(crate) struct FoodLogWindow {
    pub(crate) opened: Vec<OpenedFoodLog>,
    pub(crate) sealed: usize,
}

impl FoodLogWindow {
    /// Every entry in the window, or the refusal a total must give. A summary
    /// or intake total missing a meal would under-count the day, so one entry
    /// Cosmos cannot open makes the total an outage, never a smaller number.
    /// A listing instead shows what it could open and counts the rest.
    pub(crate) fn complete(self) -> Result<Vec<OpenedFoodLog>, Status> {
        if self.sealed > 0 {
            return Err(Status::failed_precondition(
                "the food-log channel key is not established",
            ));
        }
        Ok(self.opened)
    }
}

/// The wearer's logged food from `start` up to `end` (inclusive, when given),
/// oldest first, opened.
///
/// The one reader of the stored food log: `GetFoodLogSummary` (the Pin's food
/// experience) and the web's `GET /capture/food-log` and food-intake reads all
/// come through here, so the Pin and humane.center can never disagree about
/// what was eaten. An entry sealed under a channel key this deployment does not
/// hold is counted in [`FoodLogWindow::sealed`], never silently dropped. The
/// totals refuse through [`FoodLogWindow::complete`].
pub(crate) async fn open_food_logs(
    store: &crate::store::SharedStore,
    keys: &crate::keydirectory::SharedKeyDirectory,
    principal: &str,
    start: crate::store::SyncTime,
    end: Option<crate::store::SyncTime>,
) -> Result<FoodLogWindow, Status> {
    let stored = store
        .get_account_blob(principal, crate::store::AccountBlobKind::FoodLogs)
        .await?
        .as_deref()
        .and_then(|bytes| StoredFoodLogs::decode(bytes).ok())
        .unwrap_or_default();
    let mut logs = Vec::new();
    let mut sealed_entries = 0usize;
    let mut total_bytes = 0usize;
    for entry in stored.entries {
        let logged = crate::store::SyncTime::from_parts(entry.created_seconds, entry.created_nanos);
        if logged < start || end.is_some_and(|end| logged > end) {
            continue;
        }
        let Some(sealed) = entry.sealed else { continue };
        let kid = sealed
            .encryption_information
            .as_ref()
            .map(|information| information.kid.clone())
            .unwrap_or_default();
        let (opened, protection) = if kid == FOOD_LOG_PLAINTEXT_KID {
            (sealed.data, FoodLogSummaryProtection::Plaintext)
        } else {
            let Some(opened) = keys
                .open(&cosmos_crypto::EncryptedData {
                    kid: kid.clone(),
                    data: sealed.data,
                })
                .await
                .map_err(|error| crate::keydirectory::grpc_status(&error))?
            else {
                sealed_entries += 1;
                continue;
            };
            (opened, FoodLogSummaryProtection::Encrypted(kid))
        };
        total_bytes = total_bytes.saturating_add(opened.len());
        if total_bytes > MAX_FOOD_LOG_TOTAL_BYTES {
            return Err(Status::resource_exhausted("food log summary is too large"));
        }
        if let Some(log) = decode_valid_food_log(&opened) {
            logs.push(OpenedFoodLog {
                memory_uuid: entry.memory_uuid,
                logged,
                log,
                protection,
            });
        }
    }
    Ok(FoodLogWindow {
        opened: logs,
        sealed: sealed_entries,
    })
}
