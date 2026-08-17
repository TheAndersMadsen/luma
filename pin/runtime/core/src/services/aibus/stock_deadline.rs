use std::collections::VecDeque;
#[cfg(test)]
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use tokio::sync::mpsc;
use tokio_stream::Stream;
use tonic::Status;
use tracing::{error, warn};

use crate::proto::aibus::{synapse_chat_turn, synapse_understanding_response, SynapseSource};
use crate::proto::aibus::{SynapseUnderstandingRequest, SynapseUnderstandingResponse};
use crate::synapse::capabilities::messaging::response_parent_id;
use crate::synapse::capabilities::music::response_action_allowed;
use crate::synapse::catalog::read_tool_spec;
#[cfg(test)]
use crate::tier_a::native_actions::PLAY_MUSIC;
use crate::tier_a::native_actions::RESPOND;

/// Shared cap for both unary and bidirectional stock response streams. The
/// structurally defensive the chat-turn loop maximum is 53 frames; 64 preserves bounded
/// headroom without making a legal run hit the circuit breaker.
pub(super) const MAX_RESPONSE_EVENTS: usize = 64;
const STOCK_RESPONSE_BUFFER: usize = 1;

/// Must stay aligned with AgenticSessionDeadlineHooks for the exact inspected
/// Ironman build. Keeping the value here lets Rust enforce the delivery margin
/// without depending on Android Hook sources at runtime.
#[cfg(test)]
pub(super) const HOOKED_IRONMAN_TIMEOUT: Duration = Duration::from_secs(90);

/// Penumbra's exact-firmware Hook extends Ironman's 25-second Ai Bus ceiling to
/// 90 seconds before the stock interpreter and wake-lock classes initialize.
/// This server budget covers the entire planner and response stream while
/// retaining ten seconds for the terminal response to cross gRPC and reach the
/// stock dispatcher. The agentic runtime has its own smaller 75-second circuit
/// breaker, and exact local actions normally return immediately.
pub(super) const STOCK_TURN_DEADLINE: Duration = Duration::from_secs(80);
pub(super) const TIMEOUT_FALLBACK: &str =
    "I couldn't finish that request in time. Please try again.";

#[cfg(test)]
pub(super) enum StockTurnOutcome {
    Completed(Vec<SynapseUnderstandingResponse>),
    TimedOut(SynapseUnderstandingResponse),
}

/// Apply the one stock deadline policy as a collect-then-return turn. Retained
/// only for the `#[cfg(test)]` deadline/cancellation contract helper; every
/// production endpoint now streams live via `deadline_guarded_stock_stream` so
/// interim progress cues are not buffered to stream end. `work` must include
/// both planner creation and full stream collection; dropping it on timeout
/// makes every not-yet-delivered action unobservable, and the only possible
/// timeout action is the fixed `Respond`.
#[cfg(test)]
pub(super) async fn run_stock_turn<F>(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
    endpoint: &'static str,
    deadline: Duration,
    work: F,
) -> Result<StockTurnOutcome, Status>
where
    F: Future<Output = Result<Vec<SynapseUnderstandingResponse>, Status>>,
{
    match tokio::time::timeout(deadline, work).await {
        Ok(result) => result.map(StockTurnOutcome::Completed),
        Err(_) => {
            warn!(
                endpoint,
                deadline_ms = deadline.as_millis(),
                "stock understanding exceeded deadline; returning safe fallback"
            );
            timeout_fallback_response(request, transport_run_id).map(StockTurnOutcome::TimedOut)
        }
    }
}

/// Live-forward the planner stream under the whole-turn deadline instead of
/// collecting it. Interim progress-cue turns therefore reach the stock client
/// as they are produced (stock records them and dispatches only the terminal
/// action), which a buffered collect-then-send path defeats by materializing
/// every frame at stream end.
///
/// The deadline invariant is preserved independently of downstream polling:
/// a spawned driver drops the underlying stream when time expires, while the
/// returned stream checks the same deadline before yielding every queued item.
/// A frame merely queued inside this process is therefore never mistaken for
/// one delivered to stock. Any undelivered frame is discarded at the deadline
/// and replaced with the one policy-checked terminal fallback.
pub(super) fn deadline_guarded_stock_stream(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
    endpoint: &'static str,
    deadline_at: tokio::time::Instant,
    stream: Pin<Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>>,
) -> Pin<Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>> {
    let fallback_request = request.clone();
    let transport_run_id = transport_run_id.to_string();
    let (tx, mut rx) = mpsc::channel(STOCK_RESPONSE_BUFFER);
    let supervisor_tx = tx.clone();
    let source_completed = Arc::new(AtomicBool::new(false));
    let driver_completed = source_completed.clone();
    let driver = super::understand::spawn_sensitive_task(async move {
        drive_deadline_guarded_stock_stream(deadline_at, stream, tx, driver_completed).await;
    });
    tokio::spawn(async move {
        if let Err(join_error) = driver.await {
            error!(
                endpoint,
                panicked = join_error.is_panic(),
                cancelled = join_error.is_cancelled(),
                "stock understanding stream task failed"
            );
            // Never wait behind a stalled client to report a failure. If the
            // sole slot is occupied, dropping this sender closes after the
            // already-queued frame instead of appending a stale status.
            let _ =
                supervisor_tx.try_send(Err(Status::internal("stock understanding stream failed")));
        }
    });
    Box::pin(async_stream::stream! {
        let deadline = tokio::time::sleep_until(deadline_at);
        tokio::pin!(deadline);
        let mut emitted = 0usize;
        let mut last_emitted_parent: Option<String> = None;
        let mut ready: VecDeque<Result<SynapseUnderstandingResponse, Status>> = VecDeque::new();
        let mut held_dispatch_candidate: Option<
            Result<SynapseUnderstandingResponse, Status>,
        > = None;
        loop {
            // If the producer reached EOF before the cutoff and every queued
            // frame has already been yielded, the turn completed normally.
            // Check before the biased timer so a delayed EOF poll cannot append
            // a timeout fallback after an already-delivered terminal action.
            let source_drained = source_completed.load(Ordering::Acquire) && rx.is_empty();
            if source_drained && ready.is_empty() && held_dispatch_candidate.is_none() {
                return;
            }
            if tokio::time::Instant::now() >= deadline_at {
                rx.close();
                while rx.try_recv().is_ok() {}
                yield timed_out_stock_stream_item(
                    &fallback_request,
                    &transport_run_id,
                    endpoint,
                    last_emitted_parent.as_deref(),
                    emitted,
                );
                return;
            }
            if !source_completed.load(Ordering::Acquire)
                && rx.is_closed()
                && rx.is_empty()
                && ready.is_empty()
            {
                // A failed producer whose fixed status could not be queued
                // must not promote its held native-looking frame.
                return;
            }
            if let Some(item) = ready.pop_front() {
                let is_error = item.is_err();
                if let Ok(response) = &item {
                    if let Some(synapse_understanding_response::Body::Turn(turn)) =
                        response.body.as_ref()
                    {
                        if !turn.identifier.is_empty() {
                            last_emitted_parent = Some(turn.identifier.clone());
                        }
                    }
                }
                emitted += 1;
                yield item;
                if is_error {
                    return;
                }
                continue;
            }
            if source_drained {
                if let Some(item) = held_dispatch_candidate.take() {
                    yield item;
                }
                return;
            }
            tokio::select! {
                biased;
                () = &mut deadline => {
                    // Stop the driver and discard anything it queued but the
                    // downstream transport never requested before the cutoff.
                    rx.close();
                    while rx.try_recv().is_ok() {}
                    yield timed_out_stock_stream_item(
                        &fallback_request,
                        &transport_run_id,
                        endpoint,
                        last_emitted_parent.as_deref(),
                        emitted,
                    );
                    return;
                }
                item = rx.recv() => match item {
                    Some(item) => {
                        if item.is_err() {
                            // The error itself proves the held candidate was
                            // not last. Preserve ordering, including all 64
                            // legal frames before a cap error on the 65th.
                            if let Some(previous) = held_dispatch_candidate.take() {
                                ready.push_back(previous);
                            }
                            ready.push_back(item);
                        } else if is_known_interim_stock_response(&item) {
                            if let Some(previous) = held_dispatch_candidate.take() {
                                ready.push_back(previous);
                            }
                            ready.push_back(item);
                        } else if let Some(previous) = held_dispatch_candidate.replace(item) {
                            // A following frame proves the prior candidate was
                            // not the terminal event of this response stream.
                            ready.push_back(previous);
                        }
                    }
                    None => continue,
                },
            }
        }
    })
}

/// Only these frames are safe to forward before source EOF proves which action
/// is terminal. Observations cannot dispatch, and Chat-turn progress actions use a
/// registered read-tool name with a fixed empty payload. Every other action is
/// held back until another frame proves it interim or EOF proves it terminal.
fn is_known_interim_stock_response(item: &Result<SynapseUnderstandingResponse, Status>) -> bool {
    let Ok(response) = item else {
        return true;
    };
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body.as_ref() else {
        return true;
    };
    match turn.content.as_ref() {
        Some(synapse_chat_turn::Content::Observation(_)) => true,
        Some(synapse_chat_turn::Content::Action(action)) => {
            action.source == SynapseSource::Server as i32
                && action.thought.is_empty()
                && action.input == "{}"
                && action.device_payload.is_empty()
                && read_tool_spec(&action.action).is_some()
        }
        _ => true,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StockSendOutcome {
    Sent,
    Deadline,
    Disconnected,
}

async fn send_stock_event_before_deadline(
    tx: &mpsc::Sender<Result<SynapseUnderstandingResponse, Status>>,
    item: Result<SynapseUnderstandingResponse, Status>,
    deadline_at: tokio::time::Instant,
) -> StockSendOutcome {
    let deadline = tokio::time::sleep_until(deadline_at);
    tokio::pin!(deadline);
    tokio::select! {
        biased;
        () = &mut deadline => StockSendOutcome::Deadline,
        () = tx.closed() => StockSendOutcome::Disconnected,
        result = tx.send(item) => match result {
            Ok(()) => StockSendOutcome::Sent,
            Err(_) => StockSendOutcome::Disconnected,
        },
    }
}

fn timed_out_stock_stream_item(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
    endpoint: &'static str,
    last_emitted_parent: Option<&str>,
    emitted: usize,
) -> Result<SynapseUnderstandingResponse, Status> {
    warn!(
        endpoint,
        "stock understanding exceeded deadline; returning terminal fallback"
    );
    if emitted >= MAX_RESPONSE_EVENTS {
        Err(Status::resource_exhausted(
            "too many stock understanding events",
        ))
    } else {
        timeout_fallback_response_with_parent(request, transport_run_id, last_emitted_parent)
    }
}

async fn drive_deadline_guarded_stock_stream(
    deadline_at: tokio::time::Instant,
    mut stream: Pin<Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>>,
    tx: mpsc::Sender<Result<SynapseUnderstandingResponse, Status>>,
    source_completed: Arc<AtomicBool>,
) {
    let deadline = tokio::time::sleep_until(deadline_at);
    tokio::pin!(deadline);
    let mut emitted = 0usize;
    loop {
        tokio::select! {
            biased;
            () = &mut deadline => {
                drop(stream);
                return;
            }
            () = tx.closed() => return,
            item = stream.next() => match item {
                Some(item) => {
                    if emitted >= MAX_RESPONSE_EVENTS {
                        drop(stream);
                        let _ = send_stock_event_before_deadline(
                            &tx,
                            Err(Status::resource_exhausted(
                                "too many stock understanding events",
                            )),
                            deadline_at,
                        )
                        .await;
                        return;
                    }
                    let is_error = item.is_err();
                    match send_stock_event_before_deadline(&tx, item, deadline_at).await {
                        StockSendOutcome::Sent => {
                            emitted += 1;
                            if is_error {
                                return;
                            }
                        }
                        StockSendOutcome::Deadline => {
                            drop(stream);
                            return;
                        }
                        StockSendOutcome::Disconnected => return,
                    }
                }
                None => {
                    source_completed.store(true, Ordering::Release);
                    return;
                }
            }
        }
    }
}

pub(super) fn timeout_fallback_response(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
) -> Result<SynapseUnderstandingResponse, Status> {
    timeout_fallback_response_with_parent(request, transport_run_id, None)
}

/// Construct the fixed timeout response under the original request policy,
/// optionally chaining it to a turn this server already emitted. The explicit
/// parent is correlation only; it never replaces the current request as action
/// authority or bypasses its `Respond` exclusion.
pub(super) fn timeout_fallback_response_with_parent(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
    emitted_parent: Option<&str>,
) -> Result<SynapseUnderstandingResponse, Status> {
    if !response_action_allowed(request) {
        return Err(Status::deadline_exceeded("stock understanding timed out"));
    }

    // This is returned to stock and logged only as the content-free timeout
    // category above. It is intentionally not persisted as a completed model
    // answer or successful device activity.
    Ok(SynapseUnderstandingResponse::action_response(
        RESPOND,
        "The request exceeded the stock interaction deadline",
        &serde_json::json!({"Response": TIMEOUT_FALLBACK}).to_string(),
        emitted_parent.unwrap_or_else(|| response_parent_id(request, transport_run_id)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::proto::aibus::{
        SynapseChatTurn, SynapseDeviceContext, SynapseUser, SynapseUserRequestContent,
    };

    struct CancellationProbe(Arc<AtomicBool>);

    impl Drop for CancellationProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn request_with_user_turn() -> SynapseUnderstandingRequest {
        SynapseUnderstandingRequest {
            utterance: "slow request".into(),
            device_context: Some(SynapseDeviceContext {
                turns: vec![SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    identifier: "current-user".into(),
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        SynapseUserRequestContent {
                            request: "slow request".into(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn timeout_fallback_is_parent_linked_honest_and_policy_checked() {
        let request = request_with_user_turn();
        let response = timeout_fallback_response(&request, "transport-run").unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
            panic!("expected fallback action turn");
        };
        assert_eq!(turn.parent_identifier, "current-user");
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected fallback action");
        };
        assert_eq!(action.action, RESPOND);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
            serde_json::json!({"Response": TIMEOUT_FALLBACK})
        );

        let response = timeout_fallback_response_with_parent(
            &request,
            "transport-run",
            Some("last-emitted-turn"),
        )
        .unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
            panic!("expected explicitly parented fallback turn");
        };
        assert_eq!(turn.parent_identifier, "last-emitted-turn");

        let mut excluded = request;
        excluded.excluded_tools.push(
            RESPOND
                .chars()
                .enumerate()
                .map(|(index, character)| {
                    if index % 2 == 0 {
                        character.to_ascii_lowercase()
                    } else {
                        character.to_ascii_uppercase()
                    }
                })
                .collect(),
        );
        assert_eq!(
            timeout_fallback_response(&excluded, "transport-run")
                .unwrap_err()
                .code(),
            tonic::Code::DeadlineExceeded
        );
        assert_eq!(
            timeout_fallback_response_with_parent(
                &excluded,
                "transport-run",
                Some("last-emitted-turn"),
            )
            .unwrap_err()
            .code(),
            tonic::Code::DeadlineExceeded,
            "an explicit parent must not bypass the original request policy"
        );
    }

    #[tokio::test]
    async fn deadline_guarded_stream_forwards_frames_live_before_completion() {
        use crate::proto::aibus::SynapseUnderstandingResponse;
        let request = request_with_user_turn();
        let (tx, rx) =
            tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> =
            Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx));
        // Generous deadline: this test proves LIVE forwarding, not the timeout.
        let deadline_at = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut guarded =
            deadline_guarded_stock_stream(&request, "run", "Understand", deadline_at, inner);

        // An interim action turn is produced but the stream stays open.
        tx.send(Ok(SynapseUnderstandingResponse::action_response(
            "knowledge_lookup",
            "",
            "{}",
            "current-user",
        )))
        .unwrap();
        // It must arrive without waiting for the stream to end — buffering
        // (the old collect path) would hang here until `tx` drops.
        let first = tokio::time::timeout(Duration::from_secs(1), guarded.next())
            .await
            .expect("interim frame must forward before stream end")
            .expect("stream open")
            .expect("frame ok");
        let Some(synapse_understanding_response::Body::Turn(turn)) = first.body else {
            panic!("expected an interim action turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected action content");
        };
        assert_eq!(action.action, "knowledge_lookup");

        // The terminal frame flows through and the stream ends.
        tx.send(Ok(SynapseUnderstandingResponse::action_response(
            RESPOND,
            "",
            r#"{"Response":"done"}"#,
            "current-user",
        )))
        .unwrap();
        drop(tx);
        assert!(guarded.next().await.is_some(), "terminal frame delivered");
        assert!(guarded.next().await.is_none(), "stream ends after terminal");
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_cancels_an_unpolled_unary_stream_without_downstream_demand() {
        let request = request_with_user_turn();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_by_stream = cancelled.clone();
        let inner: Pin<
            Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>,
        > = Box::pin(async_stream::stream! {
            let _probe = CancellationProbe(cancelled_by_stream);
            futures::future::pending::<()>().await;
            yield Ok(SynapseUnderstandingResponse::default());
        });
        let deadline = Duration::from_secs(5);
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );

        // Deliberately do not poll `guarded`: a stalled HTTP/2 consumer must
        // not suspend the server's whole-turn circuit breaker.
        tokio::task::yield_now().await;
        tokio::time::advance(deadline).await;
        tokio::task::yield_now().await;
        assert!(
            cancelled.load(Ordering::SeqCst),
            "the deadline must drop planner work without downstream polling"
        );

        let fallback = guarded
            .next()
            .await
            .expect("an available output slot keeps the fixed fallback")
            .expect("fallback is valid");
        let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body else {
            panic!("expected timeout fallback turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected timeout fallback action");
        };
        assert_eq!(action.action, RESPOND);
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_discards_a_queued_native_action_that_downstream_never_polled() {
        let request = request_with_user_turn();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_by_stream = cancelled.clone();
        let inner: Pin<
            Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>,
        > = Box::pin(async_stream::stream! {
            let _probe = CancellationProbe(cancelled_by_stream);
            yield Ok(SynapseUnderstandingResponse::action_response(
                PLAY_MUSIC,
                "late action",
                r#"{"Track":"late"}"#,
                "current-user",
            ));
            futures::future::pending::<()>().await;
        });
        let deadline = Duration::from_secs(5);
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );

        // Let the driver fill the only output slot, then leave it unpolled to
        // model a connected client that has stopped consuming response data.
        tokio::task::yield_now().await;
        tokio::time::advance(deadline).await;
        tokio::task::yield_now().await;
        assert!(
            cancelled.load(Ordering::SeqCst),
            "deadline must drop planner work even while output is full"
        );

        let fallback = guarded
            .next()
            .await
            .expect("deadline fallback remains")
            .unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body else {
            panic!("expected timeout fallback turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected timeout fallback action");
        };
        assert_eq!(action.action, RESPOND);
        assert_eq!(turn.parent_identifier, "current-user");
        assert!(
            guarded.next().await.is_none(),
            "queued native action must never follow the deadline fallback"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn native_action_is_held_until_source_eof_and_replaced_if_deadline_wins() {
        let request = request_with_user_turn();
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_by_stream = cancelled.clone();
        let inner: Pin<
            Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>,
        > = Box::pin(async_stream::stream! {
            let _probe = CancellationProbe(cancelled_by_stream);
            yield Ok(SynapseUnderstandingResponse::action_response(
                PLAY_MUSIC,
                "",
                r#"{"Track":"not yet terminal"}"#,
                "current-user",
            ));
            futures::future::pending::<()>().await;
        });
        let deadline = Duration::from_secs(5);
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );
        {
            let next = guarded.next();
            tokio::pin!(next);

            tokio::select! {
                biased;
                item = next.as_mut() => panic!("native candidate escaped before source EOF: {item:?}"),
                () = tokio::task::yield_now() => {}
            }
            tokio::time::advance(deadline).await;
            let fallback = next.as_mut().await.unwrap().unwrap();
            let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body else {
                panic!("expected timeout fallback turn");
            };
            let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
                panic!("expected timeout fallback action");
            };
            assert_eq!(action.action, RESPOND);
            tokio::task::yield_now().await;
            assert!(cancelled.load(Ordering::SeqCst));
        }
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn completed_terminal_yielded_before_deadline_does_not_gain_a_late_fallback() {
        let request = request_with_user_turn();
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> = Box::pin(tokio_stream::iter(vec![Ok(
            SynapseUnderstandingResponse::action_response(
                PLAY_MUSIC,
                "",
                r#"{"Track":"on time"}"#,
                "current-user",
            ),
        )]));
        let deadline = Duration::from_secs(5);
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );

        let terminal = guarded.next().await.unwrap().unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = terminal.body else {
            panic!("expected on-time terminal turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected on-time terminal action");
        };
        assert_eq!(action.action, PLAY_MUSIC);

        // The producer has already reached EOF. Delaying the consumer's EOF
        // poll past the cutoff must not manufacture a second terminal.
        tokio::task::yield_now().await;
        tokio::time::advance(deadline).await;
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn completed_terminal_not_yielded_before_deadline_is_replaced_by_fallback() {
        let request = request_with_user_turn();
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> = Box::pin(tokio_stream::iter(vec![Ok(
            SynapseUnderstandingResponse::action_response(
                PLAY_MUSIC,
                "",
                r#"{"Track":"not delivered"}"#,
                "current-user",
            ),
        )]));
        let deadline = Duration::from_secs(5);
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );

        // The planner completes before the cutoff, but its terminal remains in
        // the internal queue because the transport never requested it.
        tokio::task::yield_now().await;
        tokio::time::advance(deadline).await;
        let fallback = guarded.next().await.unwrap().unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body else {
            panic!("expected timeout fallback turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected timeout fallback action");
        };
        assert_eq!(action.action, RESPOND);
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn source_that_completed_empty_before_deadline_stays_empty_on_a_late_first_poll() {
        let request = request_with_user_turn();
        let inner: Pin<
            Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>,
        > = Box::pin(tokio_stream::empty());
        let deadline = Duration::from_secs(5);
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );

        // The independently driven source reaches EOF before time expires,
        // even though the downstream stream has never been polled.
        tokio::task::yield_now().await;
        tokio::time::advance(deadline).await;
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test]
    async fn response_event_budget_forwards_the_full_53_frame_structure() {
        let request = request_with_user_turn();
        let frames = (0..53)
            .map(|index| {
                Ok(SynapseUnderstandingResponse::action_response(
                    RESPOND,
                    "",
                    r#"{"Response":"bounded"}"#,
                    &format!("parent-{index}"),
                ))
            })
            .collect::<Vec<_>>();
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> = Box::pin(tokio_stream::iter(frames));
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + Duration::from_secs(30),
            inner,
        );

        let mut delivered = 0usize;
        while let Some(frame) = guarded.next().await {
            frame.expect("all 53 structurally legal events must fit");
            delivered += 1;
        }
        assert_eq!(delivered, 53);
    }

    #[tokio::test]
    async fn response_event_budget_rejects_only_the_65th_frame() {
        let request = request_with_user_turn();
        let frames = (0..65)
            .map(|index| {
                Ok(SynapseUnderstandingResponse::action_response(
                    RESPOND,
                    "",
                    r#"{"Response":"bounded"}"#,
                    &format!("parent-{index}"),
                ))
            })
            .collect::<Vec<_>>();
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> = Box::pin(tokio_stream::iter(frames));
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + Duration::from_secs(30),
            inner,
        );

        for index in 0..64 {
            guarded
                .next()
                .await
                .unwrap_or_else(|| panic!("event {index} must remain within budget"))
                .unwrap_or_else(|status| panic!("event {index} failed early: {status}"));
        }
        let status = guarded.next().await.unwrap().unwrap_err();
        assert_eq!(status.code(), tonic::Code::ResourceExhausted);
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn expired_deadline_wins_over_an_already_ready_terminal_action() {
        let request = request_with_user_turn();
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> = Box::pin(tokio_stream::iter(vec![Ok(
            SynapseUnderstandingResponse::action_response(
                PLAY_MUSIC,
                "late action",
                r#"{"Track":"late"}"#,
                "current-user",
            ),
        )]));
        let deadline_at = tokio::time::Instant::now();
        tokio::time::advance(Duration::from_secs(1)).await;
        let mut guarded =
            deadline_guarded_stock_stream(&request, "run", "Understand", deadline_at, inner);

        let response = guarded.next().await.unwrap().unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
            panic!("expected timeout fallback turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected timeout Respond action");
        };
        assert_eq!(action.action, RESPOND);
        assert!(guarded.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_fallback_uses_the_last_successfully_forwarded_parent() {
        let request = request_with_user_turn();
        let (tx, rx) =
            tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
        let cue_action = SynapseUnderstandingResponse::action_response(
            "knowledge_lookup",
            "",
            "{}",
            "current-user",
        );
        let cue_action_id = match cue_action.body.as_ref() {
            Some(synapse_understanding_response::Body::Turn(turn)) => turn.identifier.clone(),
            _ => panic!("expected cue action turn"),
        };
        let cue_observation = SynapseUnderstandingResponse::observation_response(
            "knowledge_lookup",
            r#"{"status":"pending"}"#,
            &cue_action_id,
        );
        let cue_observation_id = match cue_observation.body.as_ref() {
            Some(synapse_understanding_response::Body::Turn(turn)) => turn.identifier.clone(),
            _ => panic!("expected cue observation turn"),
        };
        tx.send(Ok(cue_action)).unwrap();
        tx.send(Ok(cue_observation)).unwrap();

        let inner: Pin<Box<dyn Stream<Item = _> + Send>> =
            Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx));
        let deadline = Duration::from_secs(5);
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );
        assert!(guarded.next().await.unwrap().is_ok());
        assert!(guarded.next().await.unwrap().is_ok());

        tokio::time::advance(deadline).await;
        let fallback = guarded.next().await.unwrap().unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body else {
            panic!("expected timeout fallback turn");
        };
        assert_eq!(turn.parent_identifier, cue_observation_id);
        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn response_event_budget_rejects_a_timeout_fallback_after_64_forwarded_frames() {
        let request = request_with_user_turn();
        let (tx, rx) =
            tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
        for index in 0..64 {
            tx.send(Ok(SynapseUnderstandingResponse::action_response(
                "knowledge_lookup",
                "",
                "{}",
                &format!("parent-{index}"),
            )))
            .unwrap();
        }
        let deadline = Duration::from_secs(5);
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> =
            Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx));
        let mut guarded = deadline_guarded_stock_stream(
            &request,
            "run",
            "Understand",
            tokio::time::Instant::now() + deadline,
            inner,
        );
        for index in 0..64 {
            guarded
                .next()
                .await
                .unwrap_or_else(|| panic!("event {index} must remain within budget"))
                .unwrap();
        }

        tokio::time::advance(deadline).await;
        let status = guarded.next().await.unwrap().unwrap_err();
        assert_eq!(status.code(), tonic::Code::ResourceExhausted);
        assert!(guarded.next().await.is_none());
        drop(tx);
    }

    #[tokio::test]
    async fn deadline_guarded_stream_emits_one_terminal_fallback_on_overrun() {
        use crate::proto::aibus::SynapseUnderstandingResponse;
        let request = request_with_user_turn();
        let (tx, rx) =
            tokio::sync::mpsc::unbounded_channel::<Result<SynapseUnderstandingResponse, Status>>();
        let inner: Pin<Box<dyn Stream<Item = _> + Send>> =
            Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(rx));
        // An immediate deadline: the planner never yields a terminal action.
        let deadline_at = tokio::time::Instant::now();
        let mut guarded =
            deadline_guarded_stock_stream(&request, "run", "Understand", deadline_at, inner);

        // Keep the planner "alive" but silent; the guard must still fire.
        let fallback = guarded.next().await.expect("fallback emitted").unwrap();
        let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body else {
            panic!("expected fallback turn");
        };
        let Some(synapse_chat_turn::Content::Action(action)) = turn.content else {
            panic!("expected fallback action");
        };
        assert_eq!(action.action, RESPOND);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&action.input).unwrap(),
            serde_json::json!({"Response": TIMEOUT_FALLBACK})
        );
        // Exactly one terminal fallback, then end (planner stream dropped).
        assert!(guarded.next().await.is_none(), "one fallback then end");
        drop(tx);
    }
}
