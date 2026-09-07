//! Stock wire encoders. Durable runtime claims are the only dispatch authority.
use super::{Channel, RuntimeResult, SemanticIntent, runtime::AmbianceRuntime};
use crate::auth::AuthenticatedRequest;
use cosmos_protocol::aibus as pb;
use std::sync::Arc;
use tonic::Status;

pub async fn response(
    runtime: &AmbianceRuntime,
    auth: &AuthenticatedRequest,
    request: pb::SynapseUnderstandingRequest,
) -> Result<pb::SynapseUnderstandingResponse, Status> {
    response_started(runtime, auth, request, None).await
}

async fn response_started(
    runtime: &AmbianceRuntime,
    auth: &AuthenticatedRequest,
    request: pb::SynapseUnderstandingRequest,
    started: Option<tokio::sync::oneshot::Sender<super::TurnFence>>,
) -> Result<pb::SynapseUnderstandingResponse, Status> {
    // Client history, location, tool observations, prompts and definitions never
    // enter cognition. This transport provides only its current utterance.
    let RuntimeResult::Proposed(mut action) = runtime
        .stock_text_started(auth, request.utterance, started)
        .await?
    else {
        return Err(Status::failed_precondition("no dispatch proposed"));
    };
    // The cognitive guard hands off synchronously to this response-wide fence.
    // Cancellation after a committed speech claim keeps its unknown outcome;
    // it never retries that claim or turns enqueue into playback evidence.
    let mut cancellation = super::runtime::CancelOnDrop {
        store: runtime.store.clone(),
        principal: auth.principal.expose_for_authorization().to_owned(),
        fence: Some(super::TurnFence {
            turn_id: action.turn_id,
            generation: action.generation,
            worker: action.worker,
            origin_surface: crate::surface_registry::pin_surface_id(
                auth.principal.expose_for_authorization(),
                auth.device
                    .as_ref()
                    .ok_or_else(|| Status::permission_denied("authenticated Pin required"))?
                    .expose_for_authorization(),
            ),
        }),
    };
    if action.intent.channel() == Channel::VisualCard {
        action = runtime.display_confirmation(auth, &action).await?;
    }
    // A device action is not spoken; the runtime's own shared-safe sentence
    // is, and only after the device's report commits. The Pin never learns
    // the operation, the device kind or the reason.
    if action.intent.channel().is_action() {
        action = runtime.action_expression(auth, &action).await?;
    }
    let RuntimeResult::Dispatch(action) = runtime.stock_claim(auth, &action).await? else {
        return Err(Status::failed_precondition("dispatch not committed"));
    };
    runtime.finish_stock(auth, &action).await?;
    cancellation.fence = None;
    let SemanticIntent::InformationalSpeech { text } = action.intent else {
        return Err(Status::failed_precondition("unsupported stock output"));
    };
    Ok(pb::SynapseUnderstandingResponse {
        response: String::new(),
        is_final: true,
        body: Some(pb::synapse_understanding_response::Body::Turn(
            pb::SynapseChatTurn {
                user: pb::SynapseUser::Assistant as i32,
                identifier: action.id.to_string(),
                parent_identifier: String::new(),
                timestamp: Some(prost_types::Timestamp::from(std::time::SystemTime::now())),
                content: Some(pb::synapse_chat_turn::Content::Action(
                    pb::SynapseActionContent {
                        thought: String::new(),
                        action: "Respond".into(),
                        input: serde_json::json!({"Response":text}).to_string(),
                        device_payload: vec![],
                        source: pb::SynapseSource::Server as i32,
                    },
                )),
            },
        )),
    })
}

pub fn stream(
    runtime: Arc<AmbianceRuntime>,
    auth: AuthenticatedRequest,
    request: pb::SynapseUnderstandingRequest,
) -> impl futures_util::Stream<Item = Result<pb::SynapseUnderstandingResponse, Status>> + Send {
    futures_util::stream::once(async move { response(&runtime, &auth, request).await })
}

pub fn bidi<S>(
    runtime: Arc<AmbianceRuntime>,
    auth: AuthenticatedRequest,
    input: S,
) -> impl futures_util::Stream<Item = Result<pb::StreamingUnderstandResponse, Status>> + Send
where
    S: futures_util::Stream<Item = Result<pb::StreamingUnderstandRequest, Status>> + Send + 'static,
{
    use futures_util::StreamExt;
    futures_util::stream::unfold(
        (Box::pin(input), runtime, auth, None::<Status>),
        |(mut input, runtime, auth, mut deferred)| async move {
            if let Some(error) = deferred.take() {
                return Some((Err(error), (input, runtime, auth, None)));
            }
            let mut message = input.next().await?;
            loop {
                let request = match message {
                    Ok(pb::StreamingUnderstandRequest {
                        content:
                            Some(pb::streaming_understand_request::Content::UnderstandingRequest(
                                request,
                            )),
                    }) => request,
                    Ok(_) => {
                        return Some((
                            Err(Status::unimplemented(
                                "stock observations do not prove playback",
                            )),
                            (input, runtime, auth, None),
                        ));
                    }
                    Err(error) => return Some((Err(error), (input, runtime, auth, None))),
                };
                let (started_tx, mut started_rx) = tokio::sync::oneshot::channel();
                let mut pending =
                    Box::pin(response_started(&runtime, &auth, request, Some(started_tx)));
                let reply = tokio::select! {
                    biased;
                    next = input.next() => {
                        if let Some(next) = next {
                            let valid_text = matches!(&next, Ok(pb::StreamingUnderstandRequest { content: Some(pb::streaming_understand_request::Content::UnderstandingRequest(request)) }) if !request.utterance.trim().is_empty() && request.utterance.len() <= 4000);
                            if valid_text && runtime.check_stock(&auth).await.is_ok() {
                                drop(pending);
                                if let Ok(fence) = started_rx.try_recv() {
                                    let _ = runtime.cancel(auth.principal.expose_for_authorization(), &fence).await;
                                }
                                // Transport replacement only, never an inferred
                                // speaker correction or learned preference.
                                message = next;
                                continue;
                            }
                            deferred = Some(Status::unimplemented("input is not an admitted replacement turn"));
                            pending.as_mut().await
                        } else {
                            // Input half-close is not output cancellation.
                            pending.as_mut().await
                        }
                    }
                    reply = &mut pending => reply,
                };
                drop(pending);
                let result = reply.and_then(|reply| {
                    let Some(pb::synapse_understanding_response::Body::Turn(mut turn)) = reply.body
                    else {
                        return Err(Status::internal("invalid stock output"));
                    };
                    // Bidi's execution trigger is requires_response. It is not
                    // evidence of playback or an acknowledgment from the Pin.
                    if let Some(pb::synapse_chat_turn::Content::Action(action)) = &mut turn.content
                    {
                        action.source = pb::SynapseSource::Device as i32;
                    }
                    Ok(pb::StreamingUnderstandResponse {
                        content: Some(
                            pb::streaming_understand_response::Content::IntermediateEvent(
                                pb::IntermediateEvent {
                                    event: Some(turn),
                                    agent: "assistant".into(),
                                    requires_response: true,
                                },
                            ),
                        ),
                    })
                });
                return Some((result, (input, runtime, auth, deferred)));
            }
        },
    )
}
