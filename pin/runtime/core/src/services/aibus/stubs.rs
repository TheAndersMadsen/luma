use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use prost::Message as _;
use tokio::sync::Mutex;
use tokio::time::Instant;
use tokio_stream::Stream;
use tonic::{Request, Response, Status};
use tracing::info;

use crate::proto::{aibus::*, common::encryption::EncryptedData};
use crate::storage::{
    AibusUploadMetadata, AibusUploadStore, MediaStoreError, PendingUpload,
    MAX_AIBUS_CONTENT_TYPE_BYTES, MAX_AIBUS_LOGICAL_NAME_BYTES,
};
use crate::tier_a::proto_kids;

const DEFAULT_UPLOAD_TICKET_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING_UPLOAD_TICKETS: usize = 64;
const MAX_RETAINED_UPLOAD_TICKETS: usize = 1_024;
const LOCAL_UPLOAD_BUCKET: &str = "penumbra-local-aibus";

#[derive(Clone, Default)]
pub struct UploadFileHandler {
    inner: Option<Arc<UploadFileInner>>,
}

struct UploadFileInner {
    http_port: u16,
    store: Arc<AibusUploadStore>,
    ticket_ttl: Duration,
    max_pending_tickets: usize,
    max_retained_tickets: usize,
    tickets: Mutex<HashMap<String, UploadTicket>>,
}

#[derive(Debug, Clone, Copy)]
struct UploadTicket {
    use_case: i32,
    issued_at_unix_ms: u64,
    expires_at: Instant,
    state: UploadTicketState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadTicketState {
    Pending,
    Leased,
}

#[derive(Debug)]
pub enum UploadTicketError {
    InvalidTicket,
    NotFound,
    AlreadyClaimed,
    Expired,
    InvalidMetadata,
    Unavailable,
    Storage(MediaStoreError),
}

impl UploadFileHandler {
    pub fn new(http_port: u16, store: Arc<AibusUploadStore>) -> Self {
        Self::new_with_limits(
            http_port,
            store,
            DEFAULT_UPLOAD_TICKET_TTL,
            MAX_PENDING_UPLOAD_TICKETS,
            MAX_RETAINED_UPLOAD_TICKETS,
        )
    }

    fn new_with_limits(
        http_port: u16,
        store: Arc<AibusUploadStore>,
        ticket_ttl: Duration,
        max_pending_tickets: usize,
        max_retained_tickets: usize,
    ) -> Self {
        Self {
            inner: Some(Arc::new(UploadFileInner {
                http_port,
                store,
                ticket_ttl,
                max_pending_tickets,
                max_retained_tickets,
                tickets: Mutex::new(HashMap::new()),
            })),
        }
    }

    pub async fn upload_file(
        &self,
        request: Request<UploadFileRequest>,
    ) -> Result<Response<UploadFileResponse>, Status> {
        let use_case = request.into_inner().use_case;
        let key_prefix = match upload_file_request::UploadUseCase::try_from(use_case) {
            Ok(upload_file_request::UploadUseCase::IntentDebugging) => "intent-debugging",
            Ok(upload_file_request::UploadUseCase::LowPowerHandTracking) => {
                "low-power-hand-tracking"
            }
            Ok(upload_file_request::UploadUseCase::Unset) | Err(_) => {
                return Err(Status::invalid_argument(
                    "upload use_case must be INTENT_DEBUGGING or LOW_POWER_HAND_TRACKING",
                ));
            }
        };

        let inner = self
            .inner
            .as_ref()
            .ok_or_else(|| Status::unavailable("local AIBus upload storage is unavailable"))?;
        let now = Instant::now();
        let mut tickets = inner.tickets.lock().await;
        tickets.retain(|_, ticket| ticket.expires_at > now);
        let pending_tickets = tickets
            .values()
            .filter(|ticket| ticket.state == UploadTicketState::Pending)
            .count();
        if pending_tickets >= inner.max_pending_tickets {
            return Err(Status::resource_exhausted(
                "too many pending AIBus upload tickets",
            ));
        }
        if tickets.len() >= inner.max_retained_tickets {
            return Err(Status::resource_exhausted(
                "too many retained AIBus upload tickets",
            ));
        }

        let ticket = loop {
            let candidate = uuid::Uuid::new_v4().to_string();
            if !tickets.contains_key(&candidate) {
                break candidate;
            }
        };
        let issued_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        tickets.insert(
            ticket.clone(),
            UploadTicket {
                use_case,
                issued_at_unix_ms,
                expires_at: now + inner.ticket_ttl,
                state: UploadTicketState::Pending,
            },
        );
        drop(tickets);

        info!(use_case, "issued local AIBus upload ticket");
        Ok(Response::new(UploadFileResponse {
            // Stock sends diagnostic/hand-tracking bytes directly to this URL.
            // It must never inherit the LAN/dashboard/public authority.
            url: format!("http://127.0.0.1:{}/aibus-upload/{ticket}", inner.http_port),
            s3_key: format!("{key_prefix}/{ticket}"),
            bucket_name: LOCAL_UPLOAD_BUCKET.to_string(),
        }))
    }

    pub async fn begin_upload(
        &self,
        ticket: &str,
        logical_name: String,
        content_type: String,
    ) -> Result<PendingUpload, UploadTicketError> {
        if logical_name.trim().is_empty()
            || logical_name.len() > MAX_AIBUS_LOGICAL_NAME_BYTES
            || content_type.trim().is_empty()
            || content_type.len() > MAX_AIBUS_CONTENT_TYPE_BYTES
            || logical_name.chars().any(char::is_control)
            || content_type.chars().any(char::is_control)
        {
            return Err(UploadTicketError::InvalidMetadata);
        }
        let inner = self.inner.as_ref().ok_or(UploadTicketError::Unavailable)?;
        let claimed = self.claim_ticket(ticket).await?;
        inner
            .store
            .begin_upload(
                ticket,
                AibusUploadMetadata {
                    use_case: claimed.use_case,
                    logical_name,
                    content_type,
                    issued_at_unix_ms: claimed.issued_at_unix_ms,
                    bytes: 0,
                    sha256: [0; 32],
                },
            )
            .await
            .map_err(UploadTicketError::Storage)
    }

    async fn claim_ticket(&self, ticket: &str) -> Result<UploadTicket, UploadTicketError> {
        let parsed = uuid::Uuid::parse_str(ticket).map_err(|_| UploadTicketError::InvalidTicket)?;
        if parsed.hyphenated().to_string() != ticket {
            return Err(UploadTicketError::InvalidTicket);
        }
        let inner = self.inner.as_ref().ok_or(UploadTicketError::Unavailable)?;
        let mut tickets = inner.tickets.lock().await;
        let claimed = tickets.get_mut(ticket).ok_or(UploadTicketError::NotFound)?;
        if Instant::now() >= claimed.expires_at {
            tickets.remove(ticket);
            return Err(UploadTicketError::Expired);
        }
        if claimed.state == UploadTicketState::Leased {
            return Err(UploadTicketError::AlreadyClaimed);
        }
        claimed.state = UploadTicketState::Leased;
        let claimed = *claimed;
        Ok(claimed)
    }
}

#[derive(Default)]
pub struct StubHandler;

impl StubHandler {
    pub async fn server_stateful_understand(
        &self,
        _request: Request<ServerStatefulUnderstandRequest>,
    ) -> Result<Response<ServerStatefulUnderstandResponse>, Status> {
        info!(">>> ServerStatefulUnderstand (stub)");
        Ok(Response::new(ServerStatefulUnderstandResponse {}))
    }

    pub async fn encrypted_stream_ai_bus(
        &self,
        _request: Request<tonic::Streaming<EncryptedAiRequest>>,
    ) -> Result<
        Response<Pin<Box<dyn Stream<Item = Result<EncryptedAiResponse, Status>> + Send>>>,
        Status,
    > {
        info!(">>> EncryptedStreamAIBus (stub)");
        Ok(Response::new(Box::pin(tokio_stream::empty())))
    }

    pub async fn encrypted_function_execution(
        &self,
        _request: Request<EncryptedFunctionCall>,
    ) -> Result<Response<EncryptedFunctionResponse>, Status> {
        info!(">>> EncryptedFunctionExecution (stub)");
        Ok(Response::new(EncryptedFunctionResponse {
            response: Some(EncryptedData::new(
                proto_kids::FUNCTION_RESPONSE,
                FunctionResponse::default().encode_to_vec(),
            )),
        }))
    }

    pub async fn action_execution_test(
        &self,
        _request: Request<ActionExecutionTestRequest>,
    ) -> Result<Response<ActionExecutionTestResponse>, Status> {
        info!(">>> ActionExecutionTest (stub)");
        Ok(Response::new(ActionExecutionTestResponse {}))
    }

    pub async fn transcription_repair_test(
        &self,
        _request: Request<TranscriptionRepairTestRequest>,
    ) -> Result<Response<TranscriptionRepairTestResponse>, Status> {
        info!(">>> TranscriptionRepairTest (stub)");
        Ok(Response::new(TranscriptionRepairTestResponse {}))
    }

    pub async fn translate(
        &self,
        _request: Request<EncryptedTranslateRequest>,
    ) -> Result<Response<EncryptedTranslateResponse>, Status> {
        info!(">>> Translate (stub)");
        Ok(Response::new(EncryptedTranslateResponse {
            response: Some(EncryptedData::stub(proto_kids::TRANSLATE_RESPONSE)),
        }))
    }
}

#[cfg(test)]
mod upload_file_contract_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use prost::Message as _;
    use tonic::{Code, Request};

    use super::{UploadFileHandler, UploadTicketError};
    use crate::proto::aibus::{
        upload_file_request::UploadUseCase, UploadFileRequest, UploadFileResponse,
    };
    use crate::storage::AibusUploadStore;

    #[derive(Clone, PartialEq, prost::Message)]
    struct AuditedStockUploadFileResponse {
        #[prost(string, tag = "1")]
        url: String,
        #[prost(string, tag = "2")]
        s3_key: String,
        #[prost(string, tag = "3")]
        bucket_name: String,
    }

    #[test]
    fn stock_upload_file_messages_keep_the_audited_wire_shape() {
        let request = UploadFileRequest {
            use_case: UploadUseCase::IntentDebugging as i32,
        };
        assert_eq!(request.encode_to_vec(), [0x08, 0x01]);
        let request = UploadFileRequest {
            use_case: UploadUseCase::LowPowerHandTracking as i32,
        };
        assert_eq!(request.encode_to_vec(), [0x08, 0x02]);

        let response = UploadFileResponse {
            url: "http://127.0.0.1:8080/aibus-upload/ticket".into(),
            s3_key: "intent-debugging/ticket".into(),
            bucket_name: "penumbra-local-aibus".into(),
        };
        let encoded = response.encode_to_vec();
        let decoded = AuditedStockUploadFileResponse::decode(encoded.as_slice()).unwrap();
        assert_eq!(decoded.url, response.url);
        assert_eq!(decoded.s3_key, response.s3_key);
        assert_eq!(decoded.bucket_name, response.bucket_name);
    }

    #[tokio::test]
    async fn upload_file_rejects_unset_and_unknown_use_cases() {
        let handler = UploadFileHandler::default();
        for use_case in [UploadUseCase::Unset as i32, 99] {
            let error = handler
                .upload_file(Request::new(UploadFileRequest { use_case }))
                .await
                .unwrap_err();
            assert_eq!(error.code(), Code::InvalidArgument);
        }
    }

    async fn test_handler(
        ttl: Duration,
        maximum_pending_tickets: usize,
        maximum_retained_tickets: usize,
    ) -> (tempfile::TempDir, UploadFileHandler) {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(AibusUploadStore::open(directory.path()).await.unwrap());
        let handler = UploadFileHandler::new_with_limits(
            8080,
            store,
            ttl,
            maximum_pending_tickets,
            maximum_retained_tickets,
        );
        (directory, handler)
    }

    async fn issue_ticket(handler: &UploadFileHandler) -> String {
        let response = handler
            .upload_file(Request::new(UploadFileRequest {
                use_case: UploadUseCase::IntentDebugging as i32,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(response.bucket_name, "penumbra-local-aibus");
        assert!(response.s3_key.starts_with("intent-debugging/"));
        assert!(response
            .url
            .starts_with("http://127.0.0.1:8080/aibus-upload/"));
        response.url.rsplit('/').next().unwrap().to_string()
    }

    #[tokio::test]
    async fn upload_ticket_is_random_one_use_and_shared_by_clones() {
        let (_directory, handler) = test_handler(Duration::from_secs(60), 8, 32).await;
        let first = issue_ticket(&handler).await;
        let second = issue_ticket(&handler).await;
        assert_ne!(first, second);

        let clone = handler.clone();
        let upload = clone
            .begin_upload(
                &first,
                "debug/session.json".into(),
                "application/json".into(),
            )
            .await
            .unwrap();
        upload.abort().await;
        assert!(matches!(
            handler
                .begin_upload(
                    &first,
                    "debug/session.json".into(),
                    "application/json".into(),
                )
                .await,
            Err(UploadTicketError::AlreadyClaimed)
        ));
    }

    #[tokio::test]
    async fn invalid_metadata_does_not_consume_ticket() {
        let (_directory, handler) = test_handler(Duration::from_secs(60), 8, 32).await;
        let ticket = issue_ticket(&handler).await;
        assert!(matches!(
            handler
                .begin_upload(&ticket, "bad\nname".into(), "application/json".into())
                .await,
            Err(UploadTicketError::InvalidMetadata)
        ));
        let upload = handler
            .begin_upload(
                &ticket,
                "debug/session.json".into(),
                "application/json".into(),
            )
            .await
            .unwrap();
        upload.abort().await;
    }

    #[tokio::test]
    async fn expired_and_exhausted_tickets_fail_closed() {
        let (_directory, expiring) = test_handler(Duration::ZERO, 1, 4).await;
        let ticket = issue_ticket(&expiring).await;
        assert!(matches!(
            expiring
                .begin_upload(
                    &ticket,
                    "debug/session.json".into(),
                    "application/json".into(),
                )
                .await,
            Err(UploadTicketError::Expired)
        ));

        let (_directory, bounded) = test_handler(Duration::from_secs(60), 1, 4).await;
        issue_ticket(&bounded).await;
        let error = bounded
            .upload_file(Request::new(UploadFileRequest {
                use_case: UploadUseCase::LowPowerHandTracking as i32,
            }))
            .await
            .unwrap_err();
        assert_eq!(error.code(), Code::ResourceExhausted);
    }

    #[tokio::test]
    async fn leased_tombstones_do_not_consume_pending_capacity_but_remain_bounded() {
        let (_directory, handler) = test_handler(Duration::from_secs(60), 1, 2).await;
        let first = issue_ticket(&handler).await;
        let upload = handler
            .begin_upload(
                &first,
                "debug/session.json".into(),
                "application/json".into(),
            )
            .await
            .unwrap();
        upload.abort().await;
        issue_ticket(&handler).await;

        let (_directory, retained) = test_handler(Duration::from_secs(60), 2, 1).await;
        let first = issue_ticket(&retained).await;
        let upload = retained
            .begin_upload(
                &first,
                "debug/session.json".into(),
                "application/json".into(),
            )
            .await
            .unwrap();
        upload.abort().await;
        let error = retained
            .upload_file(Request::new(UploadFileRequest {
                use_case: UploadUseCase::IntentDebugging as i32,
            }))
            .await
            .unwrap_err();
        assert_eq!(error.code(), Code::ResourceExhausted);
    }
}
