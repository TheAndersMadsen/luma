//! Response framing: the understanding stream plumbing — activity outcomes,
//! timeout fallback frames, frame forwarding, the sensitive-setup guard, and
//! stream encryption.

use super::*;

pub(super) fn action_activity_outcome(action_name: &str, input_json: &str) -> String {
    let trimmed = input_json.trim();
    let is_empty_input = trimmed.is_empty()
        || matches!(
            serde_json::from_str::<serde_json::Value>(trimmed),
            Ok(serde_json::Value::Object(ref map)) if map.is_empty(),
        )
        || matches!(
            serde_json::from_str::<serde_json::Value>(trimmed),
            Ok(serde_json::Value::Null),
        );

    if is_empty_input {
        format!("Action: {action_name}")
    } else {
        format!("Action: {action_name} {trimmed}")
    }
}

/// Stock Answers records the optional `Request` carried by a terminal Respond
/// beside its `Response`. Supplying both makes the encrypted Ai Mic event a
/// faithful question/answer pair; omitting the request leaves Center with only
/// what the Pin spoke back and makes the wearer's original prompt unsearchable.
pub(super) fn respond_action_input(utterance: &str, response: &str) -> String {
    serde_json::json!({"Request": utterance, "Response": response}).to_string()
}

/// A one-frame stream carrying the fixed timeout fallback, for the rare case
/// where planner setup itself overruns the whole-turn deadline.
pub(super) fn single_timeout_fallback_stream(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
) -> Result<UnderstandingStream, Status> {
    let fallback = timeout_fallback_response(request, transport_run_id)?;
    Ok(Box::pin(tokio_stream::once(Ok(fallback))))
}

/// Drain the observer's unbounded frame channel into the bounded response
/// channel. The bounded channel(1) limits the handoff to one queued frame and
/// applies backpressure between this forwarder and the response stream.
///
/// The `frame_tx.closed()` arm is load-bearing for cancellation: when the
/// response stream is dropped (the client disconnects, or the bidirectional
/// deadline fires) while the planner is parked emitting nothing, this wakes
/// immediately and drops `unbounded_rx`, so the planner's `unbounded_tx.closed()`
/// guard cancels the in-flight run at once. A plain `while recv()` loop would
/// only notice on the next send, leaving a silent planner running to its own
/// circuit breaker.
pub(super) async fn forward_frames_to_response_stream(
    mut unbounded_rx: tokio::sync::mpsc::UnboundedReceiver<
        Result<SynapseUnderstandingResponse, Status>,
    >,
    frame_tx: tokio::sync::mpsc::Sender<Result<SynapseUnderstandingResponse, Status>>,
) {
    loop {
        tokio::select! {
            biased;
            () = frame_tx.closed() => break,
            frame = unbounded_rx.recv() => match frame {
                Some(frame) => {
                    if frame_tx.send(frame).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
        }
    }
}

tokio::task_local! {
    /// Marks only futures whose panic payload could contain untrusted turn or
    /// provider data. The process hook below delegates every unmarked panic to
    /// the hook that was installed before this module initialized.
    static REDACT_SENSITIVE_PANIC_PAYLOAD: ();
}

/// Stable Rust exposes only process-global panic-hook replacement. Install one
/// permanent delegating hook, once, before any marked task starts; never swap a
/// hook around an async request. While a marked future is being polled (or
/// dropped), Tokio's task-local scope is still active when the hook runs, so the
/// payload is suppressed. The task supervisor emits the fixed, content-free
/// failure log after unwinding.
pub(super) fn install_sensitive_task_panic_hook() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            if REDACT_SENSITIVE_PANIC_PAYLOAD.try_with(|_| ()).is_ok() {
                return;
            }
            previous(panic_info);
        }));
    });
}

/// Spawn a task whose in-poll panic payload must never reach the inherited
/// process hook. Task-local state intentionally does not grant this property to
/// child tasks or blocking threads; sensitive work must remain in this future.
pub(in crate::services::aibus) fn spawn_sensitive_task<F>(
    future: F,
) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    install_sensitive_task_panic_hook();
    tokio::spawn(REDACT_SENSITIVE_PANIC_PAYLOAD.scope((), future))
}

pub(super) struct AbortSensitiveTaskOnDrop(tokio::task::AbortHandle);

impl Drop for AbortSensitiveTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Run request setup in a supervised task so both planner branches have the
/// same panic-redaction and cancellation boundary. Dropping this future aborts
/// the child instead of detaching provider or planner work after a disconnect.
/// `None` means the deadline elapsed; the caller remains responsible for its
/// policy-checked fallback.
pub(super) async fn sensitive_setup_before_deadline<F, T>(
    future: F,
    deadline_at: tokio::time::Instant,
    endpoint: &'static str,
) -> Result<Option<T>, Status>
where
    F: Future<Output = Result<T, Status>> + Send + 'static,
    T: Send + 'static,
{
    let mut setup = spawn_sensitive_task(future);
    let _abort_on_drop = AbortSensitiveTaskOnDrop(setup.abort_handle());
    match tokio::time::timeout_at(deadline_at, &mut setup).await {
        Ok(Ok(result)) => result.map(Some),
        Ok(Err(join_error)) => {
            error!(
                endpoint,
                panicked = join_error.is_panic(),
                cancelled = join_error.is_cancelled(),
                "stock understanding setup task failed"
            );
            Err(Status::internal("stock understanding setup failed"))
        }
        Err(_) => {
            setup.abort();
            let _ = setup.await;
            Ok(None)
        }
    }
}

/// Preserve a spawned planner's failure result long enough to deliver it to the
/// response stream. This supervisor records only boolean failure fields and
/// copies neither the `JoinError` nor its panic payload into the fixed status or
/// this structured log.
pub(super) async fn report_planner_task_failure(
    planner: tokio::task::JoinHandle<()>,
    frames: tokio::sync::mpsc::UnboundedSender<Result<SynapseUnderstandingResponse, Status>>,
) {
    if let Err(join_error) = planner.await {
        error!(
            panicked = join_error.is_panic(),
            cancelled = join_error.is_cancelled(),
            "chat-turn planner task failed"
        );
        let _ = frames.send(Err(Status::internal("understanding planner task failed")));
    }
}

pub(super) fn encrypt_understanding_stream(
    stream: UnderstandingStream,
) -> EncryptedUnderstandingStream {
    Box::pin(stream.map(|item| {
        item.map(|plain_response| EncryptedSynapseUnderstandingResponse {
            response: Some(EncryptedData::new(
                proto_kids::SYNAPSE_UNDERSTANDING_RESPONSE,
                plain_response.encode_to_vec(),
            )),
        })
    }))
}
