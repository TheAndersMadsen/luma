//! CaptureService, handles photo/video memory creation, upload, and deletion.

use std::sync::Arc;

use prost::Message;
use tokio::sync::Mutex;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use crate::api;
use crate::proto::capture::capture_service_server::CaptureService;
use crate::proto::capture::*;
use crate::proto::common::encryption as common;
use crate::proto::common::food::{FoodLog, FoodLogSummary, NutrientType};
use crate::storage::{Location, MediaStore};

const MIN_PROTOBUF_TIMESTAMP_SECONDS: i64 = -62_135_596_800;
const MAX_PROTOBUF_TIMESTAMP_SECONDS: i64 = 253_402_300_799;
const MAX_FOOD_LOGS: usize = 512;
const MAX_FOOD_LOG_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_FOOD_LOG_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_FOOD_LOG_SUMMARY_BYTES: usize = MAX_FOOD_LOG_TOTAL_BYTES + 64 * 1024;
const MAX_FOOD_ITEM_NAME_BYTES: usize = 256;
const MAX_FOOD_ITEM_BRAND_BYTES: usize = 128;
const MAX_FOOD_ITEM_SERVING_BYTES: usize = 64;
const MAX_FOOD_ITEM_REQUEST_UUID_BYTES: usize = 128;
const MAX_FOOD_NUTRIENTS: usize = 64;
const MAX_FOOD_NUMERIC_VALUE: f32 = 10_000_000.0;

pub struct CaptureServiceImpl {
    pub store: Arc<Mutex<MediaStore>>,
    /// Address the server is reachable at (e.g. "192.168.1.125:9090").
    pub server_addr: String,
    /// Broadcast sender for real-time events to the web portal.
    pub events_tx: tokio::sync::broadcast::Sender<api::Event>,
}

// ─── helpers ────────────────────────────────────────────────────────

/// Decode the explicitly marked local plaintext LocationEnvelope carried in
/// the stock encrypted_location field.
/// With the encryption hook active, EncryptedData.data contains the raw serialized
/// LocationEnvelope proto bytes instead of ciphertext.
fn decode_location(encrypted: &Option<common::EncryptedData>) -> Option<Location> {
    let enc = encrypted.as_ref()?;
    let envelope = common::LocationEnvelope::decode(enc.data.as_ref()).ok()?;
    Some(Location {
        latitude: envelope.latitude as f64,
        longitude: envelope.longitude as f64,
        accuracy: if envelope.accuracy != 0.0 {
            Some(envelope.accuracy)
        } else {
            None
        },
        human_readable: if envelope.human_readable.is_empty() {
            None
        } else {
            Some(envelope.human_readable)
        },
        full_address: if envelope.full_address.is_empty() {
            None
        } else {
            Some(envelope.full_address)
        },
    })
}

/// Format a prost Timestamp as an ISO 8601-ish string.
fn fmt_timestamp(ts: &Option<prost_types::Timestamp>) -> String {
    match ts {
        Some(t) => {
            // Simple formatting: seconds since epoch
            let secs = t.seconds;
            // Try to produce a readable date via chrono-free approach
            format!("{secs}")
        }
        None => chrono_now(),
    }
}

/// Current time as epoch seconds string (no chrono dependency).
fn chrono_now() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}

/// Validate a protobuf Timestamp and convert its instant to the first whole
/// epoch second that can contain a matching stored memory.
fn food_log_start_second(timestamp: Option<prost_types::Timestamp>) -> Result<i64, Status> {
    let timestamp = timestamp.ok_or_else(|| Status::invalid_argument("start_time is required"))?;
    if !(MIN_PROTOBUF_TIMESTAMP_SECONDS..=MAX_PROTOBUF_TIMESTAMP_SECONDS)
        .contains(&timestamp.seconds)
        || !(0..=999_999_999).contains(&timestamp.nanos)
    {
        return Err(Status::invalid_argument("start_time is invalid"));
    }
    if timestamp.nanos == 0 {
        Ok(timestamp.seconds)
    } else {
        Ok(timestamp.seconds + 1)
    }
}

fn decode_valid_food_log(payload: &[u8]) -> Option<FoodLog> {
    if payload.len() > MAX_FOOD_LOG_PAYLOAD_BYTES {
        return None;
    }
    let food_log = FoodLog::decode(payload).ok()?;
    let food_item = food_log.food_item.as_ref()?;
    if !valid_bounded_text(&food_item.item_name, MAX_FOOD_ITEM_NAME_BYTES, false)
        || !valid_bounded_text(&food_item.brand, MAX_FOOD_ITEM_BRAND_BYTES, true)
        || !valid_bounded_text(
            &food_item.typical_serving_size,
            MAX_FOOD_ITEM_SERVING_BYTES,
            true,
        )
        || !valid_bounded_text(
            &food_item.request_uuid,
            MAX_FOOD_ITEM_REQUEST_UUID_BYTES,
            true,
        )
        || food_item.nutrition_info.len() > MAX_FOOD_NUTRIENTS
        || !food_log.servings_consumed.is_finite()
        || food_log.servings_consumed <= 0.0
        || food_log.servings_consumed > MAX_FOOD_NUMERIC_VALUE
        || food_item.nutrition_info.iter().any(|nutrient| {
            NutrientType::try_from(nutrient.nutrient_type).is_err()
                || !nutrient.value.is_finite()
                || nutrient.value < 0.0
                || nutrient.value > MAX_FOOD_NUMERIC_VALUE
        })
    {
        return None;
    }
    Some(food_log)
}

fn valid_bounded_text(value: &str, maximum_bytes: usize, may_be_empty: bool) -> bool {
    value.len() <= maximum_bytes
        && (may_be_empty || !value.trim().is_empty())
        && !value.chars().any(char::is_control)
}

/// Generate filenames for a capture burst based on memory type and counts.
#[allow(deprecated)]
fn generate_burst_files(
    memory_uuid: &str,
    burst_index: usize,
    num_files: usize,
    is_video: bool,
) -> CaptureBurst {
    let burst_uuid = uuid::Uuid::new_v4().to_string();
    let files: Vec<CaptureFile> = (0..num_files)
        .map(|file_idx| {
            let file_uuid = uuid::Uuid::new_v4().to_string();
            let ext = if is_video { "mp4" } else { "jpg" };
            let base = format!("{memory_uuid}_{burst_index}_{file_idx}");

            // The device reads these filenames from the CreateMemoryResponse and echoes
            // them back in UploadRequest RPCs.  Per the decompiled AssetUploadWorkerImpl:
            //   - Photos (JPG mode): only `secure_filename` (field 5) is used
            //   - Photos (YUV mode): only `secure_raw_data_filename` (field 6) is used
            //   - Videos: `secure_filename` (5) + `imu_data_filename` (8) + `video_timing_data_filename` (9)
            //   - `metadata_filename` (field 4) is never read by the upload code
            CaptureFile {
                id: 0,
                index: file_idx as i64,
                filename: String::new(),          // deprecated (field 3)
                metadata_filename: String::new(), // unused by device upload code (field 4)
                secure_filename: format!("{base}.{ext}"),
                secure_raw_data_filename: String::new(),
                uuid: file_uuid,
                imu_data_filename: if is_video {
                    format!("{base}_imu.bin")
                } else {
                    String::new()
                },
                video_timing_data_filename: if is_video {
                    format!("{base}_timing.bin")
                } else {
                    String::new()
                },
            }
        })
        .collect();

    CaptureBurst {
        id: 0,
        index: burst_index as i64,
        files,
        uuid: burst_uuid,
    }
}

/// Collect all filenames from a list of bursts.
fn collect_filenames(bursts: &[CaptureBurst]) -> Vec<String> {
    let mut names = Vec::new();
    for burst in bursts {
        for f in &burst.files {
            if !f.secure_filename.is_empty() {
                names.push(f.secure_filename.clone());
            }
            if !f.secure_raw_data_filename.is_empty() {
                names.push(f.secure_raw_data_filename.clone());
            }
            if !f.imu_data_filename.is_empty() {
                names.push(f.imu_data_filename.clone());
            }
            if !f.video_timing_data_filename.is_empty() {
                names.push(f.video_timing_data_filename.clone());
            }
        }
    }
    names
}

// ─── trait impl ─────────────────────────────────────────────────────

#[tonic::async_trait]
impl CaptureService for CaptureServiceImpl {
    async fn declare_memory_create_intent(
        &self,
        request: Request<MemoryCreateIntentRequest>,
    ) -> Result<Response<MemoryCreateIntentResponse>, Status> {
        let req = request.into_inner();
        info!(
            memory_type = req.memory_type,
            ">>> Capture.DeclareMemoryCreateIntent"
        );
        Ok(Response::new(MemoryCreateIntentResponse {}))
    }

    #[allow(deprecated)]
    async fn create_memory(
        &self,
        request: Request<CreateMemoryRequest>,
    ) -> Result<Response<CreateMemoryResponse>, Status> {
        let req = request.into_inner();
        info!(">>> Capture.CreateMemory");

        match req.request {
            Some(create_memory_request::Request::PhotoMemoryRequest(photo)) => {
                let request_uuid = uuid::Uuid::new_v4().to_string();
                let num_bursts = photo.num_bursts.max(1) as usize;
                let num_per_burst = photo.num_pics_per_burst.max(1) as usize;

                let request_bursts: Vec<CaptureBurst> = (0..num_bursts)
                    .map(|bi| generate_burst_files(&request_uuid, bi, num_per_burst, false))
                    .collect();
                let request_filenames = collect_filenames(&request_bursts);
                let created_at = fmt_timestamp(&photo.device_created_time);

                // Decode the explicitly marked local plaintext location envelope.
                let location = decode_location(&photo.encrypted_location);
                if location.is_some() {
                    info!("photo location decoded");
                }

                // Create memory record + directory first (so thumbnail writes succeed)
                let mut store = self.store.lock().await;
                let record = store
                    .create_memory(
                        request_uuid.clone(),
                        "photo",
                        &photo.device_local_id,
                        &created_at,
                        request_filenames,
                        location,
                    )
                    .await
                    .map_err(|e| Status::internal(format!("storage error: {e}")))?;

                let memory_uuid = record.uuid.clone();
                let is_fresh_memory = memory_uuid == request_uuid;
                if is_fresh_memory {
                    // Save the plaintext JPEG bytes supplied by the local compatibility path.
                    for (i, thumb) in photo.thumbnails.iter().enumerate() {
                        if !thumb.data.is_empty() {
                            if let Err(e) = store.save_thumbnail(&memory_uuid, i, &thumb.data).await
                            {
                                warn!(error = %e, "failed to save thumbnail {i}");
                            }
                        }
                    }
                }
                let bursts: Vec<CaptureBurst> = (0..num_bursts)
                    .map(|bi| generate_burst_files(&memory_uuid, bi, num_per_burst, false))
                    .collect();

                // Notify web portal clients
                let _ = self.events_tx.send(api::Event::MemoryCreated {
                    memory: record.clone(),
                });

                Ok(Response::new(CreateMemoryResponse {
                    status: CreateMemoryResultStatus::Success as i32,
                    memory: Some(Memory {
                        id: memory_uuid.clone(),
                        uuid: memory_uuid,
                    }),
                    response: Some(create_memory_response::Response::PhotoMemoryResponse(
                        PhotoMemoryResponse { bursts },
                    )),
                }))
            }

            Some(create_memory_request::Request::VideoMemoryRequest(video)) => {
                let request_uuid = uuid::Uuid::new_v4().to_string();
                let num_videos = video.num_videos.max(1) as usize;
                let request_bursts = vec![generate_burst_files(&request_uuid, 0, num_videos, true)];
                let request_filenames = collect_filenames(&request_bursts);
                let created_at = fmt_timestamp(&video.device_created_time);

                let calibration = CalibrationData {
                    device_should_upload: false,
                    filename: String::new(),
                };

                let location = decode_location(&video.encrypted_location);
                if location.is_some() {
                    info!("video location decoded");
                }

                // Create memory record + directory first (so thumbnail write succeeds)
                let mut store = self.store.lock().await;
                let record = store
                    .create_memory(
                        request_uuid.clone(),
                        "video",
                        &video.device_local_id,
                        &created_at,
                        request_filenames,
                        location,
                    )
                    .await
                    .map_err(|e| Status::internal(format!("storage error: {e}")))?;
                let memory_uuid = record.uuid.clone();
                let is_fresh_memory = memory_uuid == request_uuid;

                if is_fresh_memory {
                    // Save thumbnail
                    if let Some(ref thumb) = video.thumbnail {
                        if !thumb.data.is_empty() {
                            if let Err(e) = store.save_thumbnail(&memory_uuid, 0, &thumb.data).await
                            {
                                warn!(error = %e, "failed to save video thumbnail");
                            }
                        }
                    }
                }
                let bursts = vec![generate_burst_files(&memory_uuid, 0, num_videos, true)];

                // Notify web portal clients
                let _ = self.events_tx.send(api::Event::MemoryCreated {
                    memory: record.clone(),
                });

                Ok(Response::new(CreateMemoryResponse {
                    status: CreateMemoryResultStatus::Success as i32,
                    memory: Some(Memory {
                        id: memory_uuid.clone(),
                        uuid: memory_uuid,
                    }),
                    response: Some(create_memory_response::Response::VideoMemoryResponse(
                        VideoMemoryResponse {
                            bursts,
                            calibration_data: Some(calibration),
                        },
                    )),
                }))
            }

            Some(create_memory_request::Request::FoodLogMemoryRequest(food)) => {
                let request_uuid = uuid::Uuid::new_v4().to_string();
                let created_at = fmt_timestamp(&food.device_created_time);

                let mut store = self.store.lock().await;
                let record = store
                    .create_memory(
                        request_uuid.clone(),
                        "food_log",
                        &food.device_local_id,
                        &created_at,
                        vec![],
                        None,
                    )
                    .await
                    .map_err(|e| Status::internal(format!("storage error: {e}")))?;
                let memory_uuid = record.uuid.clone();
                let is_fresh_memory = memory_uuid == request_uuid;

                if is_fresh_memory {
                    // If the food log data is present, save it
                    if let Some(ref data) = food.food_log {
                        if !data.data.is_empty() {
                            if let Err(e) = store
                                .save_upload(&memory_uuid, "food_log.bin", &data.data)
                                .await
                            {
                                warn!(error = %e, "failed to save food log data");
                            }
                        }
                    }
                }

                // Notify web portal clients
                let _ = self.events_tx.send(api::Event::MemoryCreated {
                    memory: record.clone(),
                });

                info!("<<< Capture.CreateMemory memory_type=food_log status=success");

                Ok(Response::new(CreateMemoryResponse {
                    status: CreateMemoryResultStatus::Success as i32,
                    memory: Some(Memory {
                        id: memory_uuid.clone(),
                        uuid: memory_uuid,
                    }),
                    response: Some(create_memory_response::Response::FoodLogMemoryResponse(
                        FoodLogMemoryResponse {},
                    )),
                }))
            }

            Some(create_memory_request::Request::NoteMemoryRequest(note)) => {
                let request_uuid = uuid::Uuid::new_v4().to_string();
                let created_at = chrono_now();

                let mut store = self.store.lock().await;
                let location = decode_location(&note.encrypted_location);

                let record = store
                    .create_memory(
                        request_uuid.clone(),
                        "note",
                        "",
                        &created_at,
                        vec![],
                        location,
                    )
                    .await
                    .map_err(|e| Status::internal(format!("storage error: {e}")))?;
                let memory_uuid = record.uuid.clone();
                let is_fresh_memory = memory_uuid == request_uuid;

                if is_fresh_memory {
                    // Save note data
                    if let Some(ref data) = note.encrypted_note {
                        if !data.data.is_empty() {
                            if let Err(e) = store
                                .save_upload(&memory_uuid, "note.bin", &data.data)
                                .await
                            {
                                warn!(error = %e, "failed to save note data");
                            }
                        }
                    }
                }

                // Notify web portal clients
                let _ = self.events_tx.send(api::Event::MemoryCreated {
                    memory: record.clone(),
                });

                Ok(Response::new(CreateMemoryResponse {
                    status: CreateMemoryResultStatus::Success as i32,
                    memory: Some(Memory {
                        id: memory_uuid.clone(),
                        uuid: memory_uuid,
                    }),
                    response: Some(create_memory_response::Response::NoteMemoryResponse(
                        NoteMemoryResponse {},
                    )),
                }))
            }

            None => Err(Status::invalid_argument("missing memory request oneof")),
        }
    }

    async fn upload_file(
        &self,
        request: Request<UploadRequest>,
    ) -> Result<Response<UploadResponse>, Status> {
        let req = request.into_inner();
        info!(upload_type = req.upload_type, ">>> Capture.UploadFile");

        // Find which memory owns this filename
        let store = self.store.lock().await;
        let memory = store.find_memory_for_file(&req.filename).await;
        let uuid = match memory {
            Some(memory) => memory.uuid,
            None => {
                warn!("rejected upload request for an unexpected file");
                return Err(Status::invalid_argument("unexpected upload filename"));
            }
        };

        let url = format!(
            "http://{}/upload/{}/{}",
            self.server_addr, uuid, req.filename
        );

        Ok(Response::new(UploadResponse { url }))
    }

    async fn upload_complete(
        &self,
        request: Request<UploadCompleteRequest>,
    ) -> Result<Response<UploadCompleteResponse>, Status> {
        let req = request.into_inner();
        let uuid = &req.memory_uuid;
        let success = req.success;
        info!(
            success,
            retry = req.retry_number,
            ">>> Capture.UploadComplete"
        );

        let mut store = self.store.lock().await;
        if success == UploadCompletionStatus::UploadSuccess as i32 {
            match store.complete_memory(uuid).await {
                Ok(true) => {
                    info!("memory marked complete");
                    let _ = self
                        .events_tx
                        .send(api::Event::MemoryCompleted { uuid: uuid.clone() });
                }
                Ok(false) => warn!("memory not found for completion"),
                Err(_) => warn!("failed to complete memory"),
            }
            Ok(Response::new(UploadCompleteResponse {
                status: UploadCompleteStatus::ProcessingStarted as i32,
            }))
        } else {
            match store.fail_memory(uuid).await {
                Ok(()) => {
                    let _ = self
                        .events_tx
                        .send(api::Event::MemoryFailed { uuid: uuid.clone() });
                }
                Err(_) => warn!("failed to mark memory as failed"),
            }
            Ok(Response::new(UploadCompleteResponse {
                status: UploadCompleteStatus::Acknowledged as i32,
            }))
        }
    }

    async fn delete_memory(
        &self,
        request: Request<DeleteMemoryRequest>,
    ) -> Result<Response<DeleteMemoryResponse>, Status> {
        let req = request.into_inner();
        let uuid = &req.memory_uuid;
        info!(">>> Capture.DeleteMemory");

        let mut store = self.store.lock().await;
        match store.delete_memory(uuid).await {
            Ok(true) => {
                let _ = self.events_tx.send(api::Event::MemoryDeleted {
                    uuid: uuid.to_string(),
                });
                Ok(Response::new(DeleteMemoryResponse {
                    status: DeleteMemoryStatus::Success as i32,
                }))
            }
            Ok(false) => Ok(Response::new(DeleteMemoryResponse {
                status: DeleteMemoryStatus::NotFound as i32,
            })),
            Err(_) => {
                warn!("failed to delete memory");
                // THE ONE ARM WHOSE NUMBER CHANGES IN THE NEXT PIN RELEASE.
                // `Failure` was 3 in this tree and is now 4, because the
                // decompiled `humane.capture.DeleteMemoryStatus` puts
                // NOT_AUTHORIZED at 3, so every build before that correction
                // told a stock client a failed delete had been refused for
                // authorization, and Cosmos answered the identical outcome with
                // 4. The variant name is deliberately what moved, not the
                // literal: the enum declaration is the single place this can be
                // got wrong. See contracts/wire-divergence.json
                // (`stagedForRelease`) for what to check on the device.
                Ok(Response::new(DeleteMemoryResponse {
                    status: DeleteMemoryStatus::Failure as i32,
                }))
            }
        }
    }

    async fn get_capture_config(
        &self,
        _request: Request<GetCaptureConfigRequest>,
    ) -> Result<Response<GetCaptureConfigResponse>, Status> {
        info!(">>> Capture.GetCaptureConfig");
        Ok(Response::new(GetCaptureConfigResponse {
            // `observed`: stock CCAPS requests this value before invoking the
            // photography burst, and the shipped Cosmos path returns three.
            // Keep the local transport fallback wire-compatible so a remote
            // outage does not silently downgrade Best Shot to a single frame.
            num_photos_per_burst: 3,
            create_memory_retry_config: Some(CaptureRetryConfig {
                num_retries: 10,
                retry_interval_seconds: 30,
                policy: CaptureRetryPolicy::Exponential as i32,
            }),
            asset_upload_retry_config: Some(CaptureRetryConfig {
                num_retries: 10,
                retry_interval_seconds: 30,
                policy: CaptureRetryPolicy::Exponential as i32,
            }),
            delete_memory_retry_config: Some(CaptureRetryConfig {
                num_retries: 10,
                retry_interval_seconds: 30,
                policy: CaptureRetryPolicy::Exponential as i32,
            }),
        }))
    }

    async fn report_photography_experience_status(
        &self,
        request: Request<ReportPhotographyExperienceStatusRequest>,
    ) -> Result<Response<ReportPhotographyExperienceStatusResponse>, Status> {
        let req = request.into_inner();
        info!(
            status = req.status,
            ">>> Capture.ReportPhotographyExperienceStatus"
        );
        Ok(Response::new(ReportPhotographyExperienceStatusResponse {}))
    }

    async fn get_food_log_summary(
        &self,
        request: Request<GetFoodLogSummaryRequest>,
    ) -> Result<Response<GetFoodLogSummaryResponse>, Status> {
        info!(">>> Capture.GetFoodLogSummary");
        let start_second = food_log_start_second(request.into_inner().start_time)?;
        let payloads = self
            .store
            .lock()
            .await
            .read_food_log_payloads_since(
                start_second,
                MAX_FOOD_LOGS,
                MAX_FOOD_LOG_PAYLOAD_BYTES,
                MAX_FOOD_LOG_TOTAL_BYTES,
            )
            .await
            .map_err(|_| Status::internal("food log storage read failed"))?;
        let payload_count = payloads.len();
        let food_logs = payloads
            .iter()
            .filter_map(|payload| decode_valid_food_log(payload))
            .collect::<Vec<_>>();
        let rejected_count = payload_count.saturating_sub(food_logs.len());
        let summary = FoodLogSummary { food_logs }.encode_to_vec();
        if summary.len() > MAX_FOOD_LOG_SUMMARY_BYTES {
            return Err(Status::resource_exhausted("food log summary is too large"));
        }
        if rejected_count > 0 {
            warn!(rejected_count, "ignored invalid food log payloads");
        }
        info!(
            included_count = payload_count.saturating_sub(rejected_count),
            "<<< Capture.GetFoodLogSummary"
        );
        Ok(Response::new(GetFoodLogSummaryResponse {
            food_log_summary: Some(common::EncryptedData {
                encryption_information: Some(common::EncryptionInformation {
                    kid: crate::tier_a::proto_kids::FOOD_LOG_SUMMARY.to_string(),
                }),
                data: summary,
            }),
        }))
    }

    async fn get_memory_share_link(
        &self,
        _request: Request<GetShareLinkRequest>,
    ) -> Result<Response<GetShareLinkResponse>, Status> {
        info!(">>> Capture.GetMemoryShareLink (stub)");
        Ok(Response::new(GetShareLinkResponse {
            share_link: String::new(),
        }))
    }

    async fn save_shared_memory(
        &self,
        _request: Request<SaveSharedMemoryRequest>,
    ) -> Result<Response<SaveSharedMemoryResponse>, Status> {
        info!(">>> Capture.SaveSharedMemory (stub)");
        Ok(Response::new(SaveSharedMemoryResponse {
            created_memory_uuid: String::new(),
        }))
    }

    async fn get_share_link_contents(
        &self,
        _request: Request<GetShareLinkContentsRequest>,
    ) -> Result<Response<GetShareLinkContentsResponse>, Status> {
        info!(">>> Capture.GetShareLinkContents (stub)");
        Ok(Response::new(GetShareLinkContentsResponse {
            decrypted_thumbnail_bytes: vec![],
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::proto::common::food::{FoodItem, NutritionInfo};

    async fn test_service() -> (CaptureServiceImpl, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("media.sqlite")).unwrap();
        let store = MediaStore::open(directory.path().join("media"), database)
            .await
            .unwrap();
        let (events_tx, _) = tokio::sync::broadcast::channel(8);
        (
            CaptureServiceImpl {
                store: Arc::new(Mutex::new(store)),
                server_addr: "127.0.0.1:9090".into(),
                events_tx,
            },
            directory,
        )
    }

    fn valid_food_log(name: &str) -> FoodLog {
        FoodLog {
            food_item: Some(FoodItem {
                item_name: name.into(),
                nutrition_info: vec![NutritionInfo {
                    nutrient_type: NutrientType::Calories as i32,
                    value: 120.0,
                }],
                ..Default::default()
            }),
            servings_consumed: 1.0,
        }
    }

    async fn add_payload(
        service: &CaptureServiceImpl,
        memory_type: &str,
        created_at: i64,
        payload: &[u8],
    ) {
        let mut store = service.store.lock().await;
        let uuid = uuid::Uuid::new_v4().to_string();
        store
            .create_memory(
                uuid.clone(),
                memory_type,
                "device",
                &created_at.to_string(),
                Vec::new(),
                None,
            )
            .await
            .unwrap();
        store
            .save_upload(&uuid, "food_log.bin", payload)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn capture_config_keeps_best_shot_as_a_three_frame_burst() {
        let (service, _directory) = test_service().await;

        let config = service
            .get_capture_config(Request::new(GetCaptureConfigRequest {}))
            .await
            .unwrap()
            .into_inner();

        assert_eq!(config.num_photos_per_burst, 3);
    }

    #[test]
    fn stock_photo_and_video_bursts_advertise_the_files_the_device_uploads() {
        let photo = generate_burst_files("memory", 0, 1, false);
        let photo_file = &photo.files[0];
        assert_eq!(photo_file.secure_filename, "memory_0_0.jpg");
        assert!(photo_file.imu_data_filename.is_empty());
        assert!(photo_file.video_timing_data_filename.is_empty());
        assert_eq!(collect_filenames(&[photo]), ["memory_0_0.jpg"]);

        let video = generate_burst_files("memory", 0, 1, true);
        let video_file = &video.files[0];
        assert_eq!(video_file.secure_filename, "memory_0_0.mp4");
        assert_eq!(video_file.imu_data_filename, "memory_0_0_imu.bin");
        assert_eq!(
            video_file.video_timing_data_filename,
            "memory_0_0_timing.bin"
        );
        assert_eq!(
            collect_filenames(&[video]),
            [
                "memory_0_0.mp4",
                "memory_0_0_imu.bin",
                "memory_0_0_timing.bin"
            ]
        );
    }

    #[test]
    fn stock_food_log_wire_layouts_are_preserved() {
        let log = FoodLog {
            food_item: Some(FoodItem {
                item_name: "x".into(),
                ..Default::default()
            }),
            servings_consumed: 0.0,
        };
        assert_eq!(log.encode_to_vec(), [0x0a, 0x03, 0x12, 0x01, b'x']);
        assert_eq!(
            FoodLogSummary {
                food_logs: vec![log]
            }
            .encode_to_vec(),
            [0x0a, 0x05, 0x0a, 0x03, 0x12, 0x01, b'x']
        );
    }

    #[tokio::test]
    async fn food_log_summary_reads_only_matching_valid_memories_and_exact_kid() {
        let (service, _directory) = test_service().await;
        add_payload(
            &service,
            "food_log",
            99,
            &valid_food_log("older private meal").encode_to_vec(),
        )
        .await;
        let expected = valid_food_log("included private meal");
        add_payload(&service, "food_log", 100, &expected.encode_to_vec()).await;
        add_payload(
            &service,
            "photo",
            101,
            &valid_food_log("wrong memory type").encode_to_vec(),
        )
        .await;
        add_payload(&service, "food_log", 102, &[0xff, 0xff]).await;

        let response = service
            .get_food_log_summary(Request::new(GetFoodLogSummaryRequest {
                start_time: Some(prost_types::Timestamp {
                    seconds: 100,
                    nanos: 0,
                }),
            }))
            .await
            .unwrap()
            .into_inner()
            .food_log_summary
            .unwrap();
        assert_eq!(
            response.encryption_information.unwrap().kid,
            crate::tier_a::proto_kids::FOOD_LOG_SUMMARY
        );
        assert_eq!(
            FoodLogSummary::decode(response.data.as_slice()).unwrap(),
            FoodLogSummary {
                food_logs: vec![expected]
            }
        );
    }
}
