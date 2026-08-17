use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{broadcast, Mutex};
use tonic::{Request, Response, Status};
use tracing::{error, warn};

use crate::api;
use crate::proto::aibus::{FunctionCall, FunctionResponse};
use crate::proto::common::encryption::LocationEnvelope;
use crate::storage::{Location, MediaStore};
use crate::tier_a::native_actions;

const NOTE_FILENAME: &str = "note.json";
const NOTE_FORMAT: &str = "penumbra.note";
const NOTE_FORMAT_VERSION: u8 = 1;
pub(crate) const MAX_NOTE_UTF8_BYTES: usize = 16 * 1024;
const MAX_TIME_ZONE_UTF8_BYTES: usize = 128;
const MAX_LOCATION_LABEL_UTF8_BYTES: usize = 4 * 1024;

/// Handles the stock Quick Action `FunctionExecution(CreateMemory)` path.
///
/// This handler deliberately lives on [`super::super::AiBus`] rather than in the
/// hot-swapped LLM handler tree: note creation is local device functionality
/// and must continue to work while provider settings are reloaded.
#[derive(Clone)]
pub struct FunctionExecutionHandler {
    store: Arc<Mutex<MediaStore>>,
    events_tx: broadcast::Sender<api::Event>,
}

#[derive(Serialize)]
struct StoredNote {
    format: &'static str,
    version: u8,
    text: String,
    created_at_epoch_seconds: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reverse_geocoded_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<Location>,
}

impl FunctionExecutionHandler {
    pub fn new(store: Arc<Mutex<MediaStore>>, events_tx: broadcast::Sender<api::Event>) -> Self {
        Self { store, events_tx }
    }

    pub async fn function_execution(
        &self,
        request: Request<FunctionCall>,
    ) -> Result<Response<FunctionResponse>, Status> {
        self.execute_call(request.into_inner())
            .await
            .map(Response::new)
    }

    /// Execute a decoded stock function call.
    ///
    /// This is public so the natural-language Understand planner can reuse the
    /// exact same validated, transactional note path without duplicating
    /// storage or event behavior.
    pub async fn execute_call(&self, call: FunctionCall) -> Result<FunctionResponse, Status> {
        let note = validate_call(call)?;
        let uuid = uuid::Uuid::new_v4().to_string();
        let created_at = note.created_at_epoch_seconds.to_string();
        let contents = serde_json::to_vec_pretty(&note)
            .map_err(|_| Status::internal("could not encode note"))?;

        let record = {
            let mut store = self.store.lock().await;

            let create_failed = match store
                .create_memory(
                    uuid.clone(),
                    "note",
                    "",
                    &created_at,
                    vec![NOTE_FILENAME.to_string()],
                    note.location.clone(),
                )
                .await
            {
                Ok(_) => false,
                Err(storage_error) => {
                    error!(error = %storage_error, "failed to create local note record");
                    true
                }
            };
            if create_failed {
                rollback_note(&mut store, &uuid).await;
                return Err(Status::internal("could not save note"));
            }

            let save_failed = match store.save_upload(&uuid, NOTE_FILENAME, &contents).await {
                Ok(()) => false,
                Err(storage_error) => {
                    error!(error = %storage_error, "failed to save local note body");
                    true
                }
            };
            if save_failed {
                rollback_note(&mut store, &uuid).await;
                return Err(Status::internal("could not save note"));
            }

            let completion_failed = match store.complete_memory(&uuid).await {
                Ok(true) => false,
                Ok(false) => {
                    error!("local note disappeared before completion");
                    true
                }
                Err(storage_error) => {
                    error!(error = %storage_error, "failed to complete local note");
                    true
                }
            };
            if completion_failed {
                rollback_note(&mut store, &uuid).await;
                return Err(Status::internal("could not save note"));
            }

            match store.get_memory(&uuid).await {
                Some(record) => record,
                None => {
                    error!("completed local note could not be reloaded");
                    rollback_note(&mut store, &uuid).await;
                    return Err(Status::internal("could not save note"));
                }
            }
        };

        let _ = self
            .events_tx
            .send(api::Event::MemoryCreated { memory: record });

        Ok(FunctionResponse {
            response: "Saved your note.".to_string(),
        })
    }
}

async fn rollback_note(store: &mut MediaStore, uuid: &str) {
    if let Err(storage_error) = store.delete_memory(uuid).await {
        warn!(error = %storage_error, "failed to roll back local note");
    }
}

fn validate_call(call: FunctionCall) -> Result<StoredNote, Status> {
    if call.name != native_actions::CREATE_MEMORY {
        return Err(Status::invalid_argument(
            "unsupported function; expected CreateMemory",
        ));
    }
    if call.is_locked {
        return Err(Status::permission_denied(
            "unlock the device before creating a note",
        ));
    }

    let text = call.utterance.trim();
    if text.is_empty() {
        return Err(Status::invalid_argument("note text cannot be blank"));
    }
    if text.len() > MAX_NOTE_UTF8_BYTES {
        return Err(Status::invalid_argument("note text is too long"));
    }

    let time_zone = optional_bounded_text(&call.time_zone, MAX_TIME_ZONE_UTF8_BYTES, "time zone")?;
    let reverse_geocoded_location = optional_bounded_text(
        &call.reverse_geocoded_location,
        MAX_LOCATION_LABEL_UTF8_BYTES,
        "reverse-geocoded location",
    )?;
    let location = call.location.map(validate_location).transpose()?;

    Ok(StoredNote {
        format: NOTE_FORMAT,
        version: NOTE_FORMAT_VERSION,
        text: text.to_string(),
        created_at_epoch_seconds: timestamp_seconds(call.timestamp.as_ref())?,
        time_zone,
        reverse_geocoded_location,
        location,
    })
}

fn optional_bounded_text(
    value: &str,
    max_utf8_bytes: usize,
    label: &'static str,
) -> Result<Option<String>, Status> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > max_utf8_bytes || trimmed.chars().any(char::is_control) {
        return Err(Status::invalid_argument(format!("invalid {label}")));
    }
    Ok(Some(trimmed.to_string()))
}

fn validate_location(location: LocationEnvelope) -> Result<Location, Status> {
    let latitude = f64::from(location.latitude);
    let longitude = f64::from(location.longitude);
    if !latitude.is_finite()
        || !longitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
    {
        return Err(Status::invalid_argument("invalid note location"));
    }

    let accuracy = if location.accuracy == 0.0 {
        None
    } else if location.accuracy.is_finite() && location.accuracy > 0.0 {
        Some(location.accuracy)
    } else {
        return Err(Status::invalid_argument("invalid note location accuracy"));
    };

    Ok(Location {
        latitude,
        longitude,
        accuracy,
        human_readable: optional_bounded_text(
            &location.human_readable,
            MAX_LOCATION_LABEL_UTF8_BYTES,
            "location label",
        )?,
        full_address: optional_bounded_text(
            &location.full_address,
            MAX_LOCATION_LABEL_UTF8_BYTES,
            "location address",
        )?,
    })
}

fn timestamp_seconds(timestamp: Option<&prost_types::Timestamp>) -> Result<i64, Status> {
    match timestamp {
        Some(timestamp)
            if timestamp.seconds >= 0 && (0..1_000_000_000).contains(&timestamp.nanos) =>
        {
            Ok(timestamp.seconds)
        }
        Some(_) => Err(Status::invalid_argument("invalid note timestamp")),
        None => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .map_err(|_| Status::internal("system clock is before Unix epoch")),
    }
}

#[cfg(test)]
mod tests {
    use prost::Message as _;
    use tempfile::TempDir;

    use super::*;
    use crate::db::Database;
    use crate::storage::MemoryStatus;

    struct TestContext {
        _temp_dir: TempDir,
        store: Arc<Mutex<MediaStore>>,
        handler: FunctionExecutionHandler,
        events: broadcast::Receiver<api::Event>,
    }

    async fn test_context() -> TestContext {
        let temp_dir = tempfile::tempdir().unwrap();
        let database = Database::open(temp_dir.path().join("notes.sqlite3")).unwrap();
        let store = Arc::new(Mutex::new(
            MediaStore::open(temp_dir.path().join("media"), database)
                .await
                .unwrap(),
        ));
        let (events_tx, events) = broadcast::channel(8);
        let handler = FunctionExecutionHandler::new(store.clone(), events_tx);
        TestContext {
            _temp_dir: temp_dir,
            store,
            handler,
            events,
        }
    }

    fn call(utterance: impl Into<String>) -> FunctionCall {
        FunctionCall {
            name: native_actions::CREATE_MEMORY.to_string(),
            utterance: utterance.into(),
            ..Default::default()
        }
    }

    #[test]
    fn function_response_uses_stock_response_tag_one() {
        let bytes = FunctionResponse {
            response: "ok".to_string(),
        }
        .encode_to_vec();

        assert_eq!(bytes, vec![0x0a, 0x02, b'o', b'k']);
    }

    #[tokio::test]
    async fn creates_one_complete_note_with_location_metadata_and_event() {
        let mut context = test_context().await;
        let response = context
            .handler
            .execute_call(FunctionCall {
                timestamp: Some(prost_types::Timestamp {
                    seconds: 1_721_000_000,
                    nanos: 123,
                }),
                reverse_geocoded_location: "Copenhagen, Denmark".to_string(),
                time_zone: "Europe/Copenhagen".to_string(),
                location: Some(LocationEnvelope {
                    longitude: 12.5683,
                    latitude: 55.6761,
                    human_readable: "Copenhagen".to_string(),
                    full_address: "Copenhagen, Denmark".to_string(),
                    accuracy: 8.5,
                    ..Default::default()
                }),
                ..call("  Buy coffee beans  ")
            })
            .await
            .unwrap();

        assert_eq!(response.response, "Saved your note.");

        let (memories, note_json) = {
            let store = context.store.lock().await;
            let memories = store.list_memories().await;
            assert_eq!(memories.len(), 1);
            let opened = store
                .open_media_file(&memories[0].uuid, NOTE_FILENAME)
                .await
                .unwrap();
            let mut bytes = Vec::with_capacity(opened.len as usize);
            use tokio::io::AsyncReadExt as _;
            tokio::fs::File::from_std(opened.file)
                .read_to_end(&mut bytes)
                .await
                .unwrap();
            let note_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            (memories, note_json)
        };

        let memory = &memories[0];
        assert_eq!(memory.memory_type, "note");
        assert_eq!(memory.created_at, "1721000000");
        assert_eq!(memory.status, MemoryStatus::Complete);
        assert_eq!(memory.files, vec![NOTE_FILENAME]);
        let location = memory.location.as_ref().unwrap();
        assert!((location.latitude - 55.6761).abs() < 0.001);
        assert!((location.longitude - 12.5683).abs() < 0.001);
        assert_eq!(location.accuracy, Some(8.5));
        assert_eq!(location.human_readable.as_deref(), Some("Copenhagen"));

        assert_eq!(note_json["format"], NOTE_FORMAT);
        assert_eq!(note_json["version"], NOTE_FORMAT_VERSION);
        assert_eq!(note_json["text"], "Buy coffee beans");
        assert_eq!(note_json["time_zone"], "Europe/Copenhagen");
        assert_eq!(
            note_json["reverse_geocoded_location"],
            "Copenhagen, Denmark"
        );
        assert_eq!(note_json["location"]["human_readable"], "Copenhagen");

        match context.events.recv().await.unwrap() {
            api::Event::MemoryCreated {
                memory: event_memory,
            } => {
                assert_eq!(event_memory.uuid, memory.uuid);
                assert_eq!(event_memory.status, MemoryStatus::Complete);
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_invalid_calls_without_mutating_storage() {
        let context = test_context().await;

        let invalid = [
            FunctionCall {
                name: "createMemory".to_string(),
                utterance: "wrong name".to_string(),
                ..Default::default()
            },
            call("   \n\t  "),
            call("é".repeat(MAX_NOTE_UTF8_BYTES / 2 + 1)),
        ];

        for request in invalid {
            let status = context.handler.execute_call(request).await.unwrap_err();
            assert_eq!(status.code(), tonic::Code::InvalidArgument);
        }

        let status = context
            .handler
            .execute_call(FunctionCall {
                is_locked: true,
                ..call("secret")
            })
            .await
            .unwrap_err();
        assert_eq!(status.code(), tonic::Code::PermissionDenied);

        assert!(context.store.lock().await.list_memories().await.is_empty());
    }
}
