use std::pin::Pin;

use prost::Message;
use tokio_stream::Stream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{info, warn};

use crate::db::Database;
use crate::proto::events::device_events_history_service_server::DeviceEventsHistoryService;
use crate::proto::events::events_ingest_service_server::EventsIngestService;
use crate::proto::events::*;

// Tonic already limits a decoded request message to 4 MiB by default. These tighter
// acknowledgement limits prevent one malformed frame from causing an equally large
// response while remaining far above the Pin's normal notable-event batches.
const MAX_ACKNOWLEDGED_EVENTS_PER_FRAME: usize = 4_096;
const MAX_EVENT_IDENTIFIER_BYTES: usize = 128;
const MAX_EVENT_QUERY_RESULTS: usize = 2000;
const DEFAULT_EVENT_QUERY_RESULTS: usize = 100;
const MAX_EVENT_QUERY_TIME_SECONDS: i64 = 253_402_300_799;
const MIN_EVENT_QUERY_TIME_SECONDS: i64 = -62_135_596_800;

type EventAcknowledgementStream =
    Pin<Box<dyn Stream<Item = Result<IngestResponse, Status>> + Send + 'static>>;
type BatchAcknowledgementStream =
    Pin<Box<dyn Stream<Item = Result<IngestBatchResponse, Status>> + Send + 'static>>;

pub struct EventsIngestServiceImpl {
    pub db: Database,
}

#[tonic::async_trait]
impl EventsIngestService for EventsIngestServiceImpl {
    type IngestStream = EventAcknowledgementStream;

    async fn ingest(
        &self,
        request: Request<Streaming<NotableEvent>>,
    ) -> Result<Response<Self::IngestStream>, Status> {
        let mut incoming = request.into_inner();
        let db = self.db.clone();
        info!(">>> Events.Ingest stream opened");

        let acknowledgements = async_stream::try_stream! {
            while let Some(event) = incoming.message().await? {
                validate_identifier(event.event_identifier.as_ref())?;
                if event
                    .event_identifier
                    .as_ref()
                    .is_some_and(|identifier| !identifier.value.is_empty())
                {
                    let event_to_store = event.clone();
                    db.upsert_notable_event(&event_to_store).await.map_err(|error| {
                        Status::internal(format!("event persistence error: {error}"))
                    })?;
                }
                yield acknowledge_event(event)?;
            }
        };

        Ok(Response::new(Box::pin(acknowledgements)))
    }

    type IngestBatchStream = BatchAcknowledgementStream;

    async fn ingest_batch(
        &self,
        request: Request<Streaming<IngestBatchRequest>>,
    ) -> Result<Response<Self::IngestBatchStream>, Status> {
        let mut incoming = request.into_inner();
        let db = self.db.clone();
        info!(">>> Events.IngestBatch stream opened");

        let acknowledgements = async_stream::try_stream! {
                while let Some(batch) = incoming.message().await? {
                    let mut response = Vec::with_capacity(batch.events.len());
                    for event in batch.events {
                    validate_identifier(event.event_identifier.as_ref())?;
                    response.push(event.event_identifier.clone().unwrap_or_default());
                    if event
                        .event_identifier
                        .as_ref()
                        .is_some_and(|identifier| !identifier.value.is_empty())
                    {
                        db.upsert_notable_event(&event).await.map_err(|error| {
                            Status::internal(format!("event persistence error: {error}"))
                        })?;
                    }
                }
                yield IngestBatchResponse {
                    event_identifier: response,
                };
            }
        };

        Ok(Response::new(Box::pin(acknowledgements)))
    }
}

pub struct DeviceEventsHistoryServiceImpl {
    pub db: Database,
}

#[tonic::async_trait]
impl DeviceEventsHistoryService for DeviceEventsHistoryServiceImpl {
    async fn query_events(
        &self,
        request: Request<DeviceEventQueryRequest>,
    ) -> Result<Response<EventsQueryResponse>, Status> {
        info!(">>> Events.QueryEvents");
        let request = request.into_inner();
        let filters = request.filters.unwrap_or_default();

        let event_start_time = query_time(&filters.event_start_time)?;
        let event_end_time = query_time(&filters.event_end_time)?;
        if let (Some(start), Some(end)) = (event_start_time, event_end_time) {
            if start > end {
                return Err(Status::invalid_argument(
                    "event_start_time must be before event_end_time",
                ));
            }
        }

        let mut max_results = request.max_results;
        if max_results == 0 {
            max_results = DEFAULT_EVENT_QUERY_RESULTS as i32;
        } else if max_results < 0 {
            return Err(Status::invalid_argument("max_results must be non-negative"));
        }
        let max_results: usize = <i32 as TryInto<usize>>::try_into(max_results)
            .map_err(|_| Status::invalid_argument("max_results is out of range"))?
            .min(MAX_EVENT_QUERY_RESULTS);
        let scan_limit = (max_results.saturating_mul(4)).max(DEFAULT_EVENT_QUERY_RESULTS);

        let payloads = self
            .db
            .list_notable_event_payloads(
                if filters.event_type.is_empty() {
                    None
                } else {
                    Some(&filters.event_type)
                },
                if filters.event_originator_id.is_empty() {
                    None
                } else {
                    Some(&filters.event_originator_id)
                },
                event_start_time,
                event_end_time,
                scan_limit,
            )
            .await
            .map_err(|error| Status::internal(format!("event query error: {error}")))?;

        let mut events = Vec::with_capacity(max_results);
        for payload in payloads {
            if events.len() >= max_results {
                break;
            }
            let event = NotableEvent::decode(payload.as_slice()).map_err(|error| {
                warn!(error = %error, "failed to decode stored notable event");
                Status::internal("stored notable event is corrupted")
            })?;
            if event_matches_filter(&event, filters.event_properties_filter.as_ref()) {
                events.push(event);
            }
        }

        Ok(Response::new(EventsQueryResponse { events }))
    }
}

fn acknowledge_event(event: NotableEvent) -> Result<IngestResponse, Status> {
    validate_identifier(event.event_identifier.as_ref())?;
    Ok(IngestResponse {
        event_identifier: event.event_identifier,
    })
}

fn acknowledge_batch(batch: IngestBatchRequest) -> Result<IngestBatchResponse, Status> {
    if batch.events.len() > MAX_ACKNOWLEDGED_EVENTS_PER_FRAME {
        return Err(Status::resource_exhausted(format!(
            "event batch exceeds {MAX_ACKNOWLEDGED_EVENTS_PER_FRAME} items"
        )));
    }

    let mut event_identifier = Vec::with_capacity(batch.events.len());
    for event in batch.events {
        validate_identifier(event.event_identifier.as_ref())?;
        event_identifier.push(event.event_identifier.unwrap_or_default());
    }
    Ok(IngestBatchResponse { event_identifier })
}

fn validate_identifier(identifier: Option<&Uuid>) -> Result<(), Status> {
    if identifier.is_some_and(|id| id.value.len() > MAX_EVENT_IDENTIFIER_BYTES) {
        return Err(Status::invalid_argument("event identifier is too long"));
    }
    Ok(())
}
fn query_time(timestamp: &Option<prost_types::Timestamp>) -> Result<Option<i64>, Status> {
    let timestamp = match timestamp {
        Some(timestamp) => timestamp,
        None => return Ok(None),
    };
    if timestamp.seconds < MIN_EVENT_QUERY_TIME_SECONDS
        || timestamp.seconds > MAX_EVENT_QUERY_TIME_SECONDS
        || !(0..=999_999_999).contains(&timestamp.nanos)
    {
        return Err(Status::invalid_argument("invalid event timestamp"));
    }
    Ok(Some(timestamp.seconds))
}

fn event_matches_filter(event: &NotableEvent, filter: Option<&prost_types::Struct>) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    if filter.fields.is_empty() {
        return true;
    }
    let event_data = match event.event_data.as_ref() {
        Some(data) => data,
        None => return false,
    };
    filter
        .fields
        .iter()
        .all(|(key, value)| event_data.fields.get(key) == Some(value))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use prost::Message;
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, oneshot};
    use tokio_stream::wrappers::ReceiverStream;
    use tonic::transport::Server;

    use super::*;
    use crate::proto::events::events_ingest_service_client::EventsIngestServiceClient;
    use crate::proto::events::events_ingest_service_server::EventsIngestServiceServer;

    const EVENTS_PROTO: &str = include_str!("../../proto/humane/events/events.proto");

    #[derive(Clone, PartialEq, Message)]
    struct StockUuid {
        #[prost(string, tag = "1")]
        value: String,
    }

    #[derive(Clone, PartialEq, Message)]
    struct StockIngestResponse {
        #[prost(message, optional, tag = "1")]
        event_identifier: Option<StockUuid>,
    }

    #[derive(Clone, PartialEq, Message)]
    struct StockIngestBatchResponse {
        #[prost(message, repeated, tag = "1")]
        event_identifier: Vec<StockUuid>,
    }

    #[derive(Clone, PartialEq, Message)]
    struct StockEventsQueryResponse {
        #[prost(message, repeated, tag = "1")]
        events: Vec<StockNotableEvent>,
    }

    #[derive(Clone, PartialEq, Message)]
    struct StockEventFilters {
        #[prost(string, tag = "1")]
        event_type: String,
        #[prost(string, tag = "2")]
        event_originator_id: String,
        #[prost(message, optional, tag = "3")]
        event_start_time: Option<prost_types::Timestamp>,
        #[prost(message, optional, tag = "4")]
        event_end_time: Option<prost_types::Timestamp>,
        #[prost(message, optional, tag = "5")]
        event_properties_filter: Option<prost_types::Struct>,
    }

    #[derive(Clone, PartialEq, Message)]
    struct StockDeviceEventQueryRequest {
        #[prost(message, optional, tag = "1")]
        filters: Option<StockEventFilters>,
        #[prost(int32, tag = "2")]
        max_results: i32,
    }

    #[derive(Clone, PartialEq, Message)]
    struct StockNotableEvent {
        #[prost(message, optional, tag = "1")]
        event_identifier: Option<StockUuid>,
    }

    fn event(id: &str) -> NotableEvent {
        NotableEvent {
            event_identifier: Some(Uuid {
                value: id.to_owned(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn proto_matches_stock_streaming_and_history_contract() {
        assert!(EVENTS_PROTO
            .contains("rpc Ingest (stream NotableEvent) returns (stream IngestResponse);"));
        assert!(EVENTS_PROTO.contains(
            "rpc IngestBatch (stream IngestBatchRequest) returns (stream IngestBatchResponse);"
        ));
        assert!(EVENTS_PROTO
            .contains("rpc QueryEvents (DeviceEventQueryRequest) returns (EventsQueryResponse);"));

        for field in [
            "EventFilters filters = 1;",
            "int32 max_results = 2;",
            "string event_type = 1;",
            "string event_originator_id = 2;",
            "google.protobuf.Timestamp event_start_time = 3;",
            "google.protobuf.Timestamp event_end_time = 4;",
            "google.protobuf.Struct event_properties_filter = 5;",
            "repeated NotableEvent events = 1;",
        ] {
            assert!(EVENTS_PROTO.contains(field), "missing stock field: {field}");
        }
    }

    #[test]
    fn acknowledgement_frames_are_stock_wire_compatible() {
        let single = acknowledge_event(event("single-id")).expect("single acknowledgement");
        let stock_single = StockIngestResponse::decode(single.encode_to_vec().as_slice())
            .expect("stock-shaped single response decodes");
        assert_eq!(
            stock_single.event_identifier.map(|id| id.value),
            Some("single-id".to_owned())
        );

        let batch = acknowledge_batch(IngestBatchRequest {
            events: vec![event("first-id"), event("second-id")],
        })
        .expect("batch acknowledgement");
        let stock_batch = StockIngestBatchResponse::decode(batch.encode_to_vec().as_slice())
            .expect("stock-shaped batch response decodes");
        assert_eq!(
            stock_batch
                .event_identifier
                .into_iter()
                .map(|id| id.value)
                .collect::<Vec<_>>(),
            ["first-id", "second-id"]
        );
    }

    #[test]
    fn acknowledgement_frames_are_bounded_without_truncation() {
        let oversized = IngestBatchRequest {
            events: (0..=MAX_ACKNOWLEDGED_EVENTS_PER_FRAME)
                .map(|index| event(&index.to_string()))
                .collect(),
        };
        let status = acknowledge_batch(oversized).expect_err("oversized batch must fail");
        assert_eq!(status.code(), tonic::Code::ResourceExhausted);

        let status = acknowledge_event(event(&"x".repeat(MAX_EVENT_IDENTIFIER_BYTES + 1)))
            .expect_err("oversized identifier must fail");
        assert_eq!(status.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn stock_bidi_session_acknowledges_each_frame_and_cleanly_half_closes() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let directory = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(directory.path().join("events.sqlite")).unwrap();
        let incoming = async_stream::stream! {
            loop {
                match listener.accept().await {
                    Ok((socket, _)) => yield Ok::<_, std::io::Error>(socket),
                    Err(error) => {
                        yield Err(error);
                        break;
                    }
                }
            }
        };
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            Server::builder()
                .add_service(EventsIngestServiceServer::new(EventsIngestServiceImpl {
                    db: database,
                }))
                .serve_with_incoming_shutdown(incoming, async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("serve EventsIngest test service");
        });

        let mut client = EventsIngestServiceClient::connect(format!("http://{address}"))
            .await
            .expect("connect EventsIngest test client");
        let (requests_tx, requests_rx) = mpsc::channel(2);
        let mut responses = client
            .ingest_batch(ReceiverStream::new(requests_rx))
            .await
            .expect("open stock bidi session")
            .into_inner();

        requests_tx
            .send(IngestBatchRequest {
                events: vec![event("frame-one")],
            })
            .await
            .expect("send first frame");
        let first = tokio::time::timeout(Duration::from_secs(2), responses.message())
            .await
            .expect("first acknowledgement timed out")
            .expect("first acknowledgement failed")
            .expect("stream closed after first frame");
        assert_eq!(first.event_identifier[0].value, "frame-one");

        // Keeping the request sender alive must keep the response stream open,
        // without inventing an extra acknowledgement for the first frame.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), responses.message())
                .await
                .is_err(),
            "stream closed or emitted an extra acknowledgement before frame two"
        );

        requests_tx
            .send(IngestBatchRequest {
                events: vec![event("frame-two")],
            })
            .await
            .expect("send second frame");
        let second = tokio::time::timeout(Duration::from_secs(2), responses.message())
            .await
            .expect("second acknowledgement timed out")
            .expect("second acknowledgement failed")
            .expect("stream closed before second acknowledgement");
        assert_eq!(second.event_identifier[0].value, "frame-two");

        assert!(
            tokio::time::timeout(Duration::from_millis(100), responses.message())
                .await
                .is_err(),
            "stream closed or emitted more than one acknowledgement for frame two"
        );

        // Dropping the request sender is the client's HTTP/2 half-close. The server
        // must then finish its response side cleanly with no trailing frame.
        drop(requests_tx);
        let end = tokio::time::timeout(Duration::from_secs(2), responses.message())
            .await
            .expect("response stream did not close after request half-close")
            .expect("response stream ended with an error");
        assert!(end.is_none(), "unexpected trailing acknowledgement");

        let _ = shutdown_tx.send(());
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .expect("test server did not shut down")
            .expect("test server task panicked");
    }

    #[tokio::test]
    async fn history_query_returns_stock_wire_compatible_empty_success() {
        let directory = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(directory.path().join("events.sqlite")).unwrap();
        let request = DeviceEventQueryRequest {
            filters: Some(EventFilters {
                event_type: "song_played".to_owned(),
                event_originator_id: "music".to_owned(),
                event_start_time: Some(prost_types::Timestamp {
                    seconds: 1_700_000_000,
                    nanos: 0,
                }),
                event_end_time: Some(prost_types::Timestamp {
                    seconds: 1_700_086_400,
                    nanos: 0,
                }),
                event_properties_filter: Some(prost_types::Struct {
                    fields: Default::default(),
                }),
            }),
            max_results: 100,
        };
        let stock_request =
            StockDeviceEventQueryRequest::decode(request.encode_to_vec().as_slice())
                .expect("stock-shaped history request decodes");
        let stock_filters = stock_request.filters.expect("stock filters");
        assert_eq!(stock_filters.event_type, "song_played");
        assert_eq!(stock_filters.event_originator_id, "music");
        assert_eq!(stock_request.max_results, 100);
        assert_eq!(
            stock_filters.event_start_time.unwrap().seconds,
            1_700_000_000
        );
        assert_eq!(stock_filters.event_end_time.unwrap().seconds, 1_700_086_400);
        assert!(stock_filters.event_properties_filter.is_some());

        let response = DeviceEventsHistoryServiceImpl { db: database }
            .query_events(Request::new(request))
            .await
            .expect("history query succeeds")
            .into_inner();

        let stock = StockEventsQueryResponse::decode(response.encode_to_vec().as_slice())
            .expect("stock-shaped history response decodes");
        assert!(stock.events.is_empty());
    }
}
