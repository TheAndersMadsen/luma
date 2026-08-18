use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures::StreamExt as _;
use tokio::sync::mpsc;
#[cfg(test)]
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::Stream;
use tonic::metadata::MetadataMap;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use super::super::stock_deadline::{
    timeout_fallback_response_with_parent, MAX_RESPONSE_EVENTS, STOCK_TURN_DEADLINE,
};
#[cfg(test)]
use super::super::stock_deadline::{HOOKED_IRONMAN_TIMEOUT, TIMEOUT_FALLBACK};
use super::super::AiBusHanders;
use crate::proto::aibus::streaming_understand_request;
use crate::proto::aibus::streaming_understand_response;
use crate::proto::aibus::synapse_chat_turn;
use crate::proto::aibus::synapse_understanding_response;
use crate::proto::aibus::{
    IntermediateEvent, RunState, StreamingUnderstandRequest, StreamingUnderstandResponse,
    SynapseChatTurn, SynapseDeviceContext, SynapseUnderstandingRequest,
    SynapseUnderstandingResponse,
};
use crate::synapse::extract_run_id;
use crate::tier_a::operational_markers::STREAMING_UNDERSTAND_COMPLETED;
use crate::tier_a::operational_markers::STREAMING_UNDERSTAND_REQUEST;

/// Log/turn label for this endpoint. Also the deterministic discriminator the
/// understand pipeline uses to scope the in-session chat-turn transcript resume
/// to streaming turns only (the unary path never captures or consumes one).
pub(in crate::services::aibus) const BIDIRECTIONAL_UNDERSTAND_LOG_NAME: &str =
    "BidirectionalStreamingUnderstand";

pub(in crate::services::aibus) fn log_redacted_request(run_id: &str) {
    info!(
        target: "humane_server::services::aibus::understand",
        run_id = %run_id,
        "{}",
        STREAMING_UNDERSTAND_REQUEST
    );
}

const OUTPUT_BUFFER: usize = 8;
const MAX_STREAM_MESSAGES: usize = 64;
const MAX_RESUMED_TURNS: usize = 128;
const MAX_CONTEXT_TURNS: usize = 256;
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

type StreamingResponseStream =
    Pin<Box<dyn Stream<Item = Result<StreamingUnderstandResponse, Status>> + Send>>;

/// Internal response envelope. Producer-side deadline checks bound planner work
/// and queue admission, while this stamp guards the distinct delivery boundary:
/// a dispatchable response that sat unread in the channel may not escape after
/// its originating turn's deadline.
struct QueuedStreamingResponse {
    item: Result<StreamingUnderstandResponse, Status>,
    delivery: DeliveryPolicy,
}

enum DeliveryPolicy {
    Unguarded,
    BeforeDeadline {
        turn_sequence: u64,
        deliver_before: tokio::time::Instant,
        delivered_identifier: String,
        expired_terminal: Option<Box<Result<StreamingUnderstandResponse, Status>>>,
    },
    TimeoutTerminal {
        turn_sequence: u64,
    },
}

impl QueuedStreamingResponse {
    fn unguarded(item: Result<StreamingUnderstandResponse, Status>) -> Self {
        Self {
            item,
            delivery: DeliveryPolicy::Unguarded,
        }
    }

    fn interim(
        item: Result<StreamingUnderstandResponse, Status>,
        turn_sequence: u64,
        deliver_before: tokio::time::Instant,
        delivered_identifier: String,
    ) -> Self {
        Self {
            item,
            delivery: DeliveryPolicy::BeforeDeadline {
                turn_sequence,
                deliver_before,
                delivered_identifier,
                expired_terminal: None,
            },
        }
    }

    fn terminal(
        item: Result<StreamingUnderstandResponse, Status>,
        turn_sequence: u64,
        deliver_before: tokio::time::Instant,
        delivered_identifier: String,
        expired_terminal: Result<StreamingUnderstandResponse, Status>,
    ) -> Self {
        Self {
            item,
            delivery: DeliveryPolicy::BeforeDeadline {
                turn_sequence,
                deliver_before,
                delivered_identifier,
                expired_terminal: Some(Box::new(expired_terminal)),
            },
        }
    }

    fn timeout_terminal(
        item: Result<StreamingUnderstandResponse, Status>,
        turn_sequence: u64,
    ) -> Self {
        Self {
            item,
            delivery: DeliveryPolicy::TimeoutTerminal { turn_sequence },
        }
    }

    #[cfg(test)]
    fn unwrap(self) -> StreamingUnderstandResponse {
        self.item.unwrap()
    }

    #[cfg(test)]
    fn unwrap_err(self) -> Status {
        self.item.unwrap_err()
    }
}

/// The tonic-facing delivery gate. Expired interim frames are discarded. An
/// expired dispatchable terminal is replaced by its precomputed policy-checked
/// timeout outcome, then the bidi session is closed so queued or future native
/// actions from that session cannot leak after the stale turn.
struct DeadlineGatedResponseStream {
    rx: mpsc::Receiver<QueuedStreamingResponse>,
    closed: bool,
    active_turn: Option<u64>,
    last_delivered_parent: Option<String>,
}

impl DeadlineGatedResponseStream {
    fn new(rx: mpsc::Receiver<QueuedStreamingResponse>) -> Self {
        Self {
            rx,
            closed: false,
            active_turn: None,
            last_delivered_parent: None,
        }
    }

    fn enter_turn(&mut self, turn_sequence: u64) {
        if self.active_turn != Some(turn_sequence) {
            self.active_turn = Some(turn_sequence);
            self.last_delivered_parent = None;
        }
    }
}

impl Stream for DeadlineGatedResponseStream {
    type Item = Result<StreamingUnderstandResponse, Status>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.closed {
            return Poll::Ready(None);
        }

        loop {
            let queued = match self.rx.poll_recv(cx) {
                Poll::Ready(Some(queued)) => queued,
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => return Poll::Pending,
            };
            match queued.delivery {
                DeliveryPolicy::Unguarded => return Poll::Ready(Some(queued.item)),
                DeliveryPolicy::TimeoutTerminal { turn_sequence } => {
                    self.enter_turn(turn_sequence);
                    let item = reparent_timeout_outcome(
                        queued.item,
                        self.last_delivered_parent.as_deref(),
                    );
                    return Poll::Ready(Some(item));
                }
                DeliveryPolicy::BeforeDeadline {
                    turn_sequence,
                    deliver_before,
                    delivered_identifier,
                    expired_terminal,
                } => {
                    self.enter_turn(turn_sequence);
                    if tokio::time::Instant::now() < deliver_before {
                        if !delivered_identifier.is_empty() {
                            self.last_delivered_parent = Some(delivered_identifier);
                        }
                        return Poll::Ready(Some(queued.item));
                    }

                    let Some(fallback) = expired_terminal else {
                        // This turn's interim event was never delivered while
                        // current. It carries no action authority and must not
                        // be replayed late or become fallback lineage.
                        continue;
                    };
                    let fallback =
                        reparent_timeout_outcome(*fallback, self.last_delivered_parent.as_deref());

                    // Closing the receiver wakes `tx.closed()` in setup,
                    // planner, send, or idle-input waits. The fixed
                    // fallback/error below is therefore the final possible
                    // output from this stale session.
                    self.rx.close();
                    self.closed = true;
                    return Poll::Ready(Some(fallback));
                }
            }
        }
    }
}

fn reparent_timeout_outcome(
    mut outcome: Result<StreamingUnderstandResponse, Status>,
    delivered_parent: Option<&str>,
) -> Result<StreamingUnderstandResponse, Status> {
    let (Ok(response), Some(delivered_parent)) = (&mut outcome, delivered_parent) else {
        return outcome;
    };
    let Some(streaming_understand_response::Content::IntermediateEvent(event)) =
        response.content.as_mut()
    else {
        return outcome;
    };
    let Some(turn) = event.event.as_mut() else {
        return outcome;
    };
    turn.parent_identifier = delivered_parent.to_string();
    outcome
}

/// Serve the stock two-way Synapse endpoint using the same planner as unary
/// `Understand`. Ironman waits until an event has `requires_response=true`, so
/// every non-empty response batch marks exactly its final event. A final device
/// observation closes the server side of the stream, which is how the stock
/// client resolves its pending future with no additional action.
pub(in crate::services::aibus) async fn bidirectional_streaming_understand(
    handlers: Arc<AiBusHanders>,
    request: Request<tonic::Streaming<StreamingUnderstandRequest>>,
) -> Result<Response<StreamingResponseStream>, Status> {
    let metadata = request.metadata().clone();
    let input = request.into_inner();
    let (tx, rx) = mpsc::channel(OUTPUT_BUFFER);

    let session_tx = tx.clone();
    drop(spawn_streaming_session_task(tx, async move {
        run_session(handlers, metadata, input, &session_tx).await
    }));

    Ok(Response::new(Box::pin(DeadlineGatedResponseStream::new(
        rx,
    ))))
}

/// Run one bidirectional session under a supervised task. The sensitive-task
/// wrapper suppresses an in-poll panic payload at the delegating process hook,
/// and the supervisor copies neither that payload nor JoinError text into logs
/// or client status. When output capacity remains the client receives a fixed
/// internal status; a full or disconnected output fails closed without waiting
/// to enqueue a stale status.
fn spawn_streaming_session_task<F>(
    tx: mpsc::Sender<QueuedStreamingResponse>,
    session: F,
) -> tokio::task::JoinHandle<()>
where
    F: Future<Output = Result<(), Status>> + Send + 'static,
{
    let session = super::super::understand::spawn_sensitive_task(session);
    tokio::spawn(async move {
        match session.await {
            Ok(Ok(())) => {}
            Ok(Err(status)) => {
                warn!(code = ?status.code(), "bidirectional understand session failed");
                // Reporting must never outlive the failed session while waiting
                // for response capacity. If the client is not reading (or has
                // disconnected), dropping this sender closes the stream after
                // any already-queued frames drain.
                let _ = tx.try_send(QueuedStreamingResponse::unguarded(Err(status)));
            }
            Err(join_error) => {
                warn!(
                    panicked = join_error.is_panic(),
                    cancelled = join_error.is_cancelled(),
                    "bidirectional understand session task failed"
                );
                let _ = tx.try_send(QueuedStreamingResponse::unguarded(Err(Status::internal(
                    "bidirectional understand session failed",
                ))));
            }
        }
    })
}

async fn run_session(
    handlers: Arc<AiBusHanders>,
    metadata: MetadataMap,
    mut input: tonic::Streaming<StreamingUnderstandRequest>,
    tx: &mpsc::Sender<QueuedStreamingResponse>,
) -> Result<(), Status> {
    let mut state = StreamingSessionState::default();
    let transport_run_id = extract_run_id(&metadata);
    let mut accepted_messages = 0usize;

    loop {
        let next = wait_for_session_input(tx, input.message()).await?;
        let Some(message) = accept_session_message_within_limit(next, &mut accepted_messages)?
        else {
            return Ok(());
        };

        match state.accept(message)? {
            InputAction::Wait => continue,
            InputAction::OrphanedObservation(_observation) => {
                // Stage 2 will consult the resume store here and, on a matched
                // staged claim, continue the suspended plan instead of closing.
                // Until then, closing is the correct and safe resolution: it is
                // the same terminal `onCompleted` that the empty-batch and
                // final-observation paths use to release the stock client's
                // pending future with no dispatched action. Crucially it is NOT
                // `Wait`, which would block on the next message while stock's
                // untimed `responseFuture.get()` hangs to the ~60s ceiling.
                info!(
                    "<<< BidirectionalStreamingUnderstand closed on orphaned observation \
                     (no active plan; poison-guard)"
                );
                return Ok(());
            }
            InputAction::Close => {
                info!("{}", STREAMING_UNDERSTAND_COMPLETED);
                return Ok(());
            }
            InputAction::Understand(request) => {
                let fallback_request = request.clone();
                let deadline_at = tokio::time::Instant::now() + STOCK_TURN_DEADLINE;
                // Bound planner SETUP with the same whole-turn budget, matching
                // the unary `setup_deadline_guarded_turn`. `understand_inner`
                // performs eager work before yielding its stream (and, on the
                // non-progress path, runs the agentic loop inline), so a hung
                // setup must not slip past the deadline into the stock client's
                // untimed `responseFuture.get()` — that is the streaming-timeout
                // poison. The remaining budget then guards stream consumption
                // inside `stream_understanding_turn` via the same `deadline_at`.
                let setup = handlers.understand.understand_inner(
                    metadata.clone(),
                    *request,
                    BIDIRECTIONAL_UNDERSTAND_LOG_NAME,
                );
                tokio::pin!(setup);
                let deadline = tokio::time::sleep_until(deadline_at);
                tokio::pin!(deadline);
                let plain_stream = tokio::select! {
                    biased;
                    () = &mut deadline => {
                        warn!(
                            endpoint = "BidirectionalStreamingUnderstand",
                            "stock understanding setup exceeded deadline; attempting terminal fallback"
                        );
                        // Attempt one terminal fallback frame without waiting
                        // for output capacity (or preserve the terminal error
                        // when stock excluded `Respond`), then close.
                        finish_timed_out_turn(
                            &fallback_request,
                            &transport_run_id,
                            tx,
                            0,
                            None,
                        )?;
                        return Ok(());
                    }
                    () = tx.closed() => return Ok(()),
                    result = &mut setup => result?,
                };
                match stream_understanding_turn(
                    &mut state,
                    &fallback_request,
                    &transport_run_id,
                    tx,
                    deadline_at,
                    plain_stream,
                )
                .await?
                {
                    TurnControl::Continue => {}
                    TurnControl::Close => return Ok(()),
                }
            }
        }
    }
}

/// Count a message only after it actually arrives. Reaching the exact limit is
/// valid: the session may wait for an observation or close cleanly after its
/// 64th message. Only an actual 65th message crosses the circuit breaker.
fn accept_session_message_within_limit<T>(
    next: Option<T>,
    accepted_messages: &mut usize,
) -> Result<Option<T>, Status> {
    let Some(message) = next else {
        return Ok(None);
    };
    if *accepted_messages >= MAX_STREAM_MESSAGES {
        return Err(Status::resource_exhausted(
            "too many bidirectional understand messages",
        ));
    }
    *accepted_messages += 1;
    Ok(Some(message))
}

async fn wait_for_session_input<F, T>(
    tx: &mpsc::Sender<QueuedStreamingResponse>,
    next: F,
) -> Result<Option<T>, Status>
where
    F: Future<Output = Result<Option<T>, Status>>,
{
    let idle = tokio::time::sleep(SESSION_IDLE_TIMEOUT);
    tokio::pin!(idle);
    tokio::pin!(next);
    tokio::select! {
        biased;
        () = tx.closed() => Ok(None),
        () = &mut idle => Err(Status::deadline_exceeded(
            "bidirectional understand session idle",
        )),
        result = &mut next => result,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum TurnControl {
    Continue,
    Close,
}

#[derive(Debug, PartialEq, Eq)]
enum SendOutcome {
    Sent,
    Deadline,
    Disconnected,
}

/// Live-forward one stock planning turn to the bidirectional client instead of
/// buffering it. Real interim turns reach the stock session as they are
/// produced; its `onNext` accumulates them into `eventsQueue` and completes the
/// pending future only on the single `requires_response` frame (verified
/// against decompiled `SynapseBidirectionalStreamingSession.onNext`). Synthetic
/// read-tool cue turns are forbidden: stock records every such turn in the
/// conversation graph, and the current Hook intentionally installs no bridge.
///
/// A one-frame lookahead preserves the delimiter invariant: every turn but the
/// last is emitted with `requires_response = false`; the last turn of the run is
/// the dispatchable terminal and carries `requires_response = true`. The one
/// exception is a stream that produced interim turns but no dispatchable
/// terminal: `understand_inner` may emit a close-sentinel (`is_final = true`, no
/// turn) so the held interim is flushed and the turn closes with no dispatch,
/// never promoting a non-terminal turn to the terminal. The whole-turn deadline
/// still bounds the run — on overrun the planner stream is dropped (so no
/// not-yet-emitted native action escapes) and a terminal `Respond` fallback is
/// attempted without waiting for response capacity. A full or disconnected
/// output fails closed; stock excluding `Respond` remains a terminal error.
async fn stream_understanding_turn(
    state: &mut StreamingSessionState,
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
    tx: &mpsc::Sender<QueuedStreamingResponse>,
    deadline_at: tokio::time::Instant,
    plain_stream: Pin<Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>>,
) -> Result<TurnControl, Status> {
    let turn_sequence = state.begin_delivery_turn();
    let sleep = tokio::time::sleep_until(deadline_at);
    tokio::pin!(sleep);
    let mut stream = plain_stream;
    // The most recent turn, held back until we know whether another follows: the
    // last turn of the run is the dispatchable terminal and must be the only
    // `requires_response = true` frame.
    let mut held: Option<SynapseChatTurn> = None;
    let mut emitted = 0usize;
    loop {
        tokio::select! {
            biased;
            () = &mut sleep => {
                // Drop the planner before the fallback so no late native action
                // can be observed after it; if output capacity remains, the
                // fallback is the only dispatchable terminal frame.
                //
                // `held` is deliberately discarded rather than promoted. A turn
                // is only known to be the terminal once the stream ends, so a
                // turn still held at the deadline may be a progress cue —
                // promoting it here would dispatch a cue as the answer, the
                // exact defect the close-sentinel exists to prevent. The cost is
                // a microsecond-wide race in which a just-produced terminal is
                // replaced by the timeout apology; that is the safe direction to
                // fail, so do not "optimize" this into promoting `held`.
                drop(stream);
                return finish_timed_out_turn(
                    request,
                    transport_run_id,
                    tx,
                    emitted,
                    Some(turn_sequence),
                );
            }
            () = tx.closed() => return Ok(TurnControl::Close),
            item = stream.next() => {
                match item {
                    Some(item) => {
                        let response = item?;
                        // Close-sentinel (`is_final`, no turn body): a cue-bearing
                        // run ended with no dispatchable terminal. Flush the held
                        // cue as interim and close — a trailing cue must never
                        // become the terminal.
                        if response.is_final {
                            match flush_held_interim(
                                state,
                                tx,
                                held.take(),
                                &mut emitted,
                                turn_sequence,
                                deadline_at,
                            )
                            .await?
                            {
                                SendOutcome::Sent => {}
                                SendOutcome::Deadline => {
                                    drop(stream);
                                    return finish_timed_out_turn(
                                        request,
                                        transport_run_id,
                                        tx,
                                        emitted,
                                        Some(turn_sequence),
                                    );
                                }
                                SendOutcome::Disconnected => return Ok(TurnControl::Close),
                            }
                            info!(
                                "<<< BidirectionalStreamingUnderstand produced no device action"
                            );
                            return Ok(TurnControl::Close);
                        }
                        // Only turn bodies become wire events (heartbeats and
                        // other non-turn responses are dropped, as the buffered
                        // path did). A terminal error (e.g. stock excluded
                        // `Respond` at timeout) propagates unchanged.
                        let Some(synapse_understanding_response::Body::Turn(turn)) = response.body
                        else {
                            continue;
                        };
                        match flush_held_interim(
                            state,
                            tx,
                            held.take(),
                            &mut emitted,
                            turn_sequence,
                            deadline_at,
                        )
                        .await?
                        {
                            SendOutcome::Sent => {}
                            SendOutcome::Deadline => {
                                drop(stream);
                                return finish_timed_out_turn(
                                    request,
                                    transport_run_id,
                                    tx,
                                    emitted,
                                    Some(turn_sequence),
                                );
                            }
                            SendOutcome::Disconnected => return Ok(TurnControl::Close),
                        }
                        held = Some(turn);
                    }
                    None => {
                        // The planner stream ended. The held turn, if any, is the
                        // terminal; with none, the run produced no device action
                        // and closing resolves the stock future with no dispatch.
                        return match held {
                            Some(terminal) => {
                                if emitted >= MAX_RESPONSE_EVENTS {
                                    return Err(Status::resource_exhausted(
                                        "too many bidirectional understanding turns",
                                    ));
                                }
                                match send_intermediate_event(
                                    tx,
                                    terminal.clone(),
                                    true,
                                    turn_sequence,
                                    deadline_at,
                                    Some(expired_terminal_response(
                                        request,
                                        transport_run_id,
                                    )),
                                )
                                .await
                                {
                                    SendOutcome::Sent => {
                                        state.record_turns(std::slice::from_ref(&terminal));
                                        Ok(TurnControl::Continue)
                                    }
                                    SendOutcome::Deadline => {
                                        drop(stream);
                                        finish_timed_out_turn(
                                            request,
                                            transport_run_id,
                                            tx,
                                            emitted,
                                            Some(turn_sequence),
                                        )
                                    }
                                    SendOutcome::Disconnected => Ok(TurnControl::Close),
                                }
                            }
                            None => {
                                info!(
                                    "<<< BidirectionalStreamingUnderstand produced no device action"
                                );
                                Ok(TurnControl::Close)
                            }
                        };
                    }
                }
            }
        }
    }
}

/// Forward a previously held turn as an interim (`requires_response = false`)
/// event once the lookahead confirms it is not the run's terminal, recording it
/// for session context and bounding the interim-event count.
async fn flush_held_interim(
    state: &mut StreamingSessionState,
    tx: &mpsc::Sender<QueuedStreamingResponse>,
    held: Option<SynapseChatTurn>,
    emitted: &mut usize,
    turn_sequence: u64,
    deadline_at: tokio::time::Instant,
) -> Result<SendOutcome, Status> {
    if let Some(prev) = held {
        if *emitted >= MAX_RESPONSE_EVENTS {
            return Err(Status::resource_exhausted(
                "too many bidirectional understanding turns",
            ));
        }
        match send_intermediate_event(tx, prev.clone(), false, turn_sequence, deadline_at, None)
            .await
        {
            SendOutcome::Sent => {
                state.record_turns(std::slice::from_ref(&prev));
                *emitted += 1;
            }
            outcome => return Ok(outcome),
        }
    }
    Ok(SendOutcome::Sent)
}

/// Send one `IntermediateEvent` frame. `requires_response` is set only on a
/// run's terminal turn, which is how the stock client delimits the batch it
/// dispatches.
async fn send_intermediate_event(
    tx: &mpsc::Sender<QueuedStreamingResponse>,
    turn: SynapseChatTurn,
    requires_response: bool,
    turn_sequence: u64,
    deadline_at: tokio::time::Instant,
    expired_terminal: Option<Result<StreamingUnderstandResponse, Status>>,
) -> SendOutcome {
    let delivered_identifier = turn.identifier.clone();
    let response = intermediate_event_response(turn, requires_response);
    let queued = match expired_terminal {
        Some(fallback) => QueuedStreamingResponse::terminal(
            Ok(response),
            turn_sequence,
            deadline_at,
            delivered_identifier,
            fallback,
        ),
        None => QueuedStreamingResponse::interim(
            Ok(response),
            turn_sequence,
            deadline_at,
            delivered_identifier,
        ),
    };
    let deadline = tokio::time::sleep_until(deadline_at);
    tokio::pin!(deadline);
    tokio::select! {
        biased;
        () = &mut deadline => SendOutcome::Deadline,
        () = tx.closed() => SendOutcome::Disconnected,
        result = tx.send(queued) => {
            match result {
                Ok(()) => SendOutcome::Sent,
                Err(_) => SendOutcome::Disconnected,
            }
        }
    }
}

/// Build the only output permitted when a normally dispatchable terminal was
/// queued on time but not consumed by the stock client until after its turn
/// deadline. The fallback is derived solely from the original current-turn
/// request and transport run. The delivery gate may then parent it to the last
/// interim it actually yielded, never one that merely entered the queue.
fn expired_terminal_response(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
) -> Result<StreamingUnderstandResponse, Status> {
    let response = timeout_fallback_response_with_parent(request, transport_run_id, None)?;
    let Some(synapse_understanding_response::Body::Turn(turn)) = response.body else {
        return Err(Status::internal(
            "stock timeout fallback did not contain an action turn",
        ));
    };
    Ok(intermediate_event_response(turn, true))
}

fn intermediate_event_response(
    turn: SynapseChatTurn,
    requires_response: bool,
) -> StreamingUnderstandResponse {
    StreamingUnderstandResponse {
        content: Some(streaming_understand_response::Content::IntermediateEvent(
            IntermediateEvent {
                event: Some(turn),
                agent: String::new(),
                requires_response,
            },
        )),
    }
}

/// End an overdue turn without ever waiting for response capacity. If the
/// bounded output channel is full, no terminal can be delivered before the
/// deadline; closing is safer than allowing either the original action or the
/// timeout fallback to arrive late.
fn finish_timed_out_turn(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
    tx: &mpsc::Sender<QueuedStreamingResponse>,
    emitted: usize,
    turn_sequence: Option<u64>,
) -> Result<TurnControl, Status> {
    warn!(
        endpoint = "BidirectionalStreamingUnderstand",
        "stock understanding exceeded deadline; attempting terminal fallback"
    );
    if emitted >= MAX_RESPONSE_EVENTS {
        return Err(Status::resource_exhausted(
            "too many bidirectional understanding turns",
        ));
    }
    let fallback = timeout_fallback_response_with_parent(request, transport_run_id, None)?;
    if let Some(synapse_understanding_response::Body::Turn(turn)) = fallback.body {
        let response = Ok(intermediate_event_response(turn, true));
        let queued = match turn_sequence {
            Some(turn_sequence) => {
                QueuedStreamingResponse::timeout_terminal(response, turn_sequence)
            }
            None => QueuedStreamingResponse::unguarded(response),
        };
        match tx.try_send(queued) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                warn!(
                    endpoint = "BidirectionalStreamingUnderstand",
                    "response channel full at deadline; closing without a late fallback"
                );
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
    }
    // Closing keeps the stock client from retaining this timed-out session for
    // the ten-minute idle window.
    Ok(TurnControl::Close)
}

#[derive(Default)]
struct StreamingSessionState {
    request: Option<SynapseUnderstandingRequest>,
    initial_run_state: Option<RunState>,
    next_delivery_turn: u64,
}

enum InputAction {
    Wait,
    // Boxed: an understanding request is ~450 bytes; the other variants are unit
    // or a single boxed turn.
    Understand(Box<SynapseUnderstandingRequest>),
    /// An observation arrived on a session that never carried an understanding
    /// request. In the live flow this is only the terminal narration-completed
    /// signal re-entering the ladder (flag-on): stock opens a fresh bidi session
    /// containing just the observation and blocks on an untimed `responseFuture`.
    /// `run_session` must resolve that future at once — never `Wait` — or the
    /// turn hangs to the stock AI_MIC_THINKING ceiling (the streaming-timeout
    /// poison). The boxed turn is carried so a later staged-resume claim can be
    /// matched against it before the session closes.
    OrphanedObservation(Box<SynapseChatTurn>),
    Close,
}

impl StreamingSessionState {
    fn begin_delivery_turn(&mut self) -> u64 {
        let turn_sequence = self.next_delivery_turn;
        self.next_delivery_turn = self.next_delivery_turn.saturating_add(1);
        turn_sequence
    }

    fn accept(&mut self, message: StreamingUnderstandRequest) -> Result<InputAction, Status> {
        match message.content {
            Some(streaming_understand_request::Content::InitialRunState(run_state)) => {
                if self.request.is_some() {
                    return Err(Status::failed_precondition(
                        "initial run state must precede the understanding request",
                    ));
                }
                validate_run_state(&run_state)?;
                self.initial_run_state = Some(run_state);
                Ok(InputAction::Wait)
            }
            Some(streaming_understand_request::Content::UnderstandingRequest(mut request)) => {
                if let Some(run_state) = self.initial_run_state.take() {
                    prepend_run_state(&mut request, run_state);
                }
                trim_context(&mut request);
                self.request = Some((*request).clone());
                Ok(InputAction::Understand(request))
            }
            Some(streaming_understand_request::Content::Observation(observation)) => {
                let is_final = match observation.content.as_ref() {
                    Some(synapse_chat_turn::Content::Observation(content)) => content.is_final,
                    _ => {
                        return Err(Status::invalid_argument(
                            "streaming observation must contain observation content",
                        ));
                    }
                };
                if self.request.is_none() {
                    // No plan was ever established on this session, so there is
                    // nothing to fold this observation into. The live flow that
                    // reaches here is the terminal narration-completed re-entry;
                    // `run_session` resolves the stock client's pending future by
                    // closing the stream (optionally matching a staged resume
                    // first) rather than waiting for a request that never comes.
                    return Ok(InputAction::OrphanedObservation(Box::new(observation)));
                }
                let request = self.request.as_mut().unwrap();
                context_mut(request).turns.push(observation);
                trim_context(request);
                if is_final {
                    Ok(InputAction::Close)
                } else {
                    Ok(InputAction::Understand(Box::new(request.clone())))
                }
            }
            None => Err(Status::invalid_argument(
                "streaming understand request has no content",
            )),
        }
    }

    fn record_turns(&mut self, turns: &[SynapseChatTurn]) {
        let Some(request) = self.request.as_mut() else {
            return;
        };
        context_mut(request).turns.extend_from_slice(turns);
        trim_context(request);
    }
}

fn validate_run_state(run_state: &RunState) -> Result<(), Status> {
    let turn_count = run_state
        .agent_to_runs
        .values()
        .flat_map(|runs| &runs.runs)
        .map(|run| run.events.len())
        .sum::<usize>();
    if turn_count > MAX_RESUMED_TURNS {
        return Err(Status::resource_exhausted(
            "initial bidirectional run state is too large",
        ));
    }
    Ok(())
}

fn prepend_run_state(request: &mut SynapseUnderstandingRequest, run_state: RunState) {
    let mut agents = run_state.agent_to_runs.into_iter().collect::<Vec<_>>();
    agents.sort_by(|left, right| left.0.cmp(&right.0));

    let mut resumed = agents
        .into_iter()
        .flat_map(|(_, runs)| runs.runs)
        .flat_map(|run| run.events)
        .collect::<Vec<_>>();
    if resumed.is_empty() {
        return;
    }

    let context = context_mut(request);
    let mut identifiers = context
        .turns
        .iter()
        .filter_map(|turn| (!turn.identifier.is_empty()).then_some(turn.identifier.clone()))
        .collect::<HashSet<_>>();
    resumed
        .retain(|turn| turn.identifier.is_empty() || identifiers.insert(turn.identifier.clone()));
    resumed.append(&mut context.turns);
    context.turns = resumed;
}

fn context_mut(request: &mut SynapseUnderstandingRequest) -> &mut SynapseDeviceContext {
    request
        .device_context
        .get_or_insert_with(SynapseDeviceContext::default)
}

fn trim_context(request: &mut SynapseUnderstandingRequest) {
    let Some(context) = request.device_context.as_mut() else {
        return;
    };
    if context.turns.len() > MAX_CONTEXT_TURNS {
        context
            .turns
            .drain(..context.turns.len() - MAX_CONTEXT_TURNS);
    }
}

#[cfg(test)]
#[path = "streaming/tests.rs"]
mod tests;
