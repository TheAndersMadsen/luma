//! Integration: when the assistant may look through the Pin's camera.
//!
//! Stock `IntentRecognitionAction.visionRequested()` stamps every spoken
//! request `VISION` when the wearer used the vision gesture, `NO_VISION` when
//! they did not and "Vision with Gesture only" (`humane_vision_only_with_gesture`,
//! off by default) is on, and `UNSPECIFIED` otherwise, which leaves the look to
//! the assistant. These drive the real legacy dispatcher
//! (`AiBusMain::understand`), the bidirectional session and the text-only
//! adapter with a scripted model. Fixtures are synthetic.
//!
//! Ways this can fail, each pinned below:
//! 1. a plain spoken "what do you see?" (`UNSPECIFIED`) is not offered the
//!    camera, so the assistant says it cannot see;
//! 2. a `NO_VISION` request is offered it, against the wearer's setting;
//! 3. a run that already looked is offered it again and can capture frame
//!    after frame;
//! 4. a look in an older, finished run blocks the next run's look;
//! 5. the gesture turn loses its "aimed the pin" or prefetched-frame line;
//! 6. the two transports disagree on any of the above;
//! 7. a text-only caller, which cannot run a device action, is offered it.

use std::sync::{Arc, Mutex, MutexGuard};

use cosmos_protocol::aibus as pb;
use pb::ai_bus_service_server::AiBusService;
use pb::synapse_user_request_content::VisionRequested;
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Status};

use super::AiBusMain;
use crate::assistant::bidi::BidiSession;
use crate::assistant::catalog::ToolContext;
use crate::assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef};
use crate::services::gates::Entitlement;
use crate::store::MemoryStore;

const WEARER: &str = "U:look-pin";
const LOOK: &str = "UnderstandScene";
const RESPOND: &str = "Respond";
const QUESTION: &str = r#"{"Question":"What do you see?"}"#;
const SEEN: &str = "A red mug on a white desk.";
/// The engine's gesture line and its prefetched-frame suffix.
const AIMED: &str = "The wearer aimed the pin at something";
const FRAME: &str = "already captured a frame";
const UNRECOGNIZED: &str = "Unrecognized function name and/or arguments";

/// What one model step was shown.
struct Step {
    context: String,
    offered: Vec<String>,
}

impl Step {
    fn offers_look(&self) -> bool {
        self.offered.iter().any(|name| name == LOOK)
    }
}

/// A model that asks to look on its first step, then answers. One that
/// `insists` asks even when the run did not offer the camera, as a model told
/// to "always use UnderstandScene" does.
struct Looker {
    insists: bool,
    steps: Mutex<Vec<Step>>,
}

impl Looker {
    fn new(insists: bool) -> Arc<Self> {
        Arc::new(Self {
            insists,
            steps: Mutex::default(),
        })
    }

    fn steps(&self) -> MutexGuard<'_, Vec<Step>> {
        self.steps.lock().expect("model steps")
    }
}

#[tonic::async_trait]
impl ChatModel for Looker {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        let step = Step {
            context: messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            offered: tools.iter().map(|tool| tool.name.clone()).collect(),
        };
        let mut steps = self.steps();
        let look = steps.is_empty() && (self.insists || step.offers_look());
        steps.push(step);
        Ok(if look {
            ChatResponse {
                tool_call: Some(ToolCall {
                    name: LOOK.to_owned(),
                    arguments: QUESTION.to_owned(),
                }),
                ..Default::default()
            }
        } else {
            ChatResponse {
                content: Some(SEEN.to_owned()),
                ..Default::default()
            }
        })
    }
}

fn turn(id: &str, parent: &str, content: pb::synapse_chat_turn::Content) -> pb::SynapseChatTurn {
    pb::SynapseChatTurn {
        identifier: id.to_owned(),
        parent_identifier: parent.to_owned(),
        content: Some(content),
        ..Default::default()
    }
}

/// The wearer's spoken request as `TaoEventRegistrar.onTranscription` records
/// it: the root of its run, with the frame the gesture prefetched, if any.
fn spoken(id: &str, text: &str, vision: VisionRequested, frame: bool) -> pb::SynapseChatTurn {
    let mut request = pb::SynapseUserRequestContent {
        request: text.to_owned(),
        image_data: if frame {
            vec![0xff, 0xd8, 0xff, 0xd9]
        } else {
            Vec::new()
        },
        ..Default::default()
    };
    request.set_vision_requested(vision);
    pb::SynapseChatTurn {
        user: pb::SynapseUser::User as i32,
        ..turn(id, "", pb::synapse_chat_turn::Content::UserRequest(request))
    }
}

fn action(id: &str, parent: &str, name: &str, input: &str) -> pb::SynapseChatTurn {
    turn(
        id,
        parent,
        pb::synapse_chat_turn::Content::Action(pb::SynapseActionContent {
            action: name.to_owned(),
            input: input.to_owned(),
            source: pb::SynapseSource::Device as i32,
            ..Default::default()
        }),
    )
}

fn observation(id: &str, parent: &str, name: &str, text: &str) -> pb::SynapseChatTurn {
    turn(
        id,
        parent,
        pb::synapse_chat_turn::Content::Observation(pb::SynapseObservationContent {
            action_name: name.to_owned(),
            observation: text.to_owned(),
            source: pb::SynapseSource::Device as i32,
            ..Default::default()
        }),
    )
}

/// A Pin request replaying `turns`, the shape `SynapseInterpreter.buildRequest`
/// sends: the earlier runs still in context, then this run from its root.
fn pin_request(text: &str, turns: Vec<pb::SynapseChatTurn>) -> pb::SynapseUnderstandingRequest {
    pb::SynapseUnderstandingRequest {
        utterance: text.to_owned(),
        device_context: Some(pb::SynapseDeviceContext {
            turns,
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn spoken_request(
    text: &str,
    vision: VisionRequested,
    frame: bool,
) -> pb::SynapseUnderstandingRequest {
    pin_request(text, vec![spoken("run", text, vision, frame)])
}

#[derive(Clone, Copy, Debug)]
enum Transport {
    Legacy,
    Bidi,
}

const TRANSPORTS: [Transport; 2] = [Transport::Legacy, Transport::Bidi];

/// What one turn sent down to the Pin.
#[derive(Default)]
struct Sent {
    turns: Vec<pb::SynapseChatTurn>,
    /// The actions the Pin is told to execute: the legacy stream's final
    /// action, and every bidi event that `requires_response`.
    executed: Vec<pb::SynapseActionContent>,
}

impl Sent {
    fn executes(&self, name: &str) -> bool {
        self.executed.iter().any(|action| action.action == name)
    }

    fn observed(&self, text: &str) -> bool {
        self.turns.iter().any(|turn| {
            matches!(
                &turn.content,
                Some(pb::synapse_chat_turn::Content::Observation(observation))
                    if observation.observation == text
            )
        })
    }
}

fn as_action(turn: &pb::SynapseChatTurn) -> Option<&pb::SynapseActionContent> {
    match &turn.content {
        Some(pb::synapse_chat_turn::Content::Action(action)) => Some(action),
        _ => None,
    }
}

fn legacy_service(model: Arc<Looker>) -> AiBusMain {
    AiBusMain {
        engine: Arc::new(crate::assistant::engine::Engine::new(model)),
        keys: Default::default(),
        directory: None,
        store: MemoryStore::shared(),
        entitlements: Default::default(),
    }
}

fn as_wearer<T>(body: T) -> Request<T> {
    let mut request = Request::new(body);
    request
        .extensions_mut()
        .insert(cosmos_core::AuthenticatedPrincipal::from_edge(WEARER).expect("fixture principal"));
    request
}

/// Run one request to completion. A bidi look is never answered here, so its
/// session ends on the closed request side after asking the Pin to look.
async fn send(
    transport: Transport,
    model: Arc<Looker>,
    request: pb::SynapseUnderstandingRequest,
) -> Sent {
    let mut sent = Sent::default();
    match transport {
        Transport::Legacy => {
            let replies = legacy_service(model)
                .understand(as_wearer(request))
                .await
                .expect("understand")
                .into_inner()
                .collect::<Vec<_>>()
                .await;
            for reply in replies {
                let reply = reply.expect("a reply");
                if let Some(pb::synapse_understanding_response::Body::Turn(turn)) = reply.body {
                    if reply.is_final
                        && let Some(action) = as_action(&turn)
                    {
                        sent.executed.push(action.clone());
                    }
                    sent.turns.push(turn);
                }
            }
        }
        Transport::Bidi => {
            let (tx, mut out) = bidi(model);
            tx.send(understanding(request)).await.expect("request");
            drop(tx);
            while let Some(message) = out.next().await {
                record_event(&mut sent, message);
            }
        }
    }
    sent
}

type Inbound = mpsc::Sender<Result<pb::StreamingUnderstandRequest, Status>>;

fn bidi(
    model: Arc<Looker>,
) -> (
    Inbound,
    ReceiverStream<Result<pb::StreamingUnderstandResponse, Status>>,
) {
    let (tx, rx) = mpsc::channel(16);
    let out = BidiSession::spawn_with(
        model,
        Entitlement::Active,
        ToolContext::default(),
        ReceiverStream::new(rx),
    );
    (tx, out)
}

fn understanding(
    request: pb::SynapseUnderstandingRequest,
) -> Result<pb::StreamingUnderstandRequest, Status> {
    Ok(pb::StreamingUnderstandRequest {
        content: Some(pb::streaming_understand_request::Content::UnderstandingRequest(request)),
    })
}

/// Record one bidi message; returns the action the Pin must now execute.
fn record_event(
    sent: &mut Sent,
    message: Result<pb::StreamingUnderstandResponse, Status>,
) -> Option<(String, pb::SynapseActionContent)> {
    let Some(pb::streaming_understand_response::Content::IntermediateEvent(event)) =
        message.expect("a bidi message").content
    else {
        return None;
    };
    let turn = event.event?;
    let executed = event
        .requires_response
        .then(|| as_action(&turn).cloned())
        .flatten()
        .map(|action| (turn.identifier.clone(), action));
    if let Some((_, action)) = &executed {
        sent.executed.push(action.clone());
    }
    sent.turns.push(turn);
    executed
}

#[tokio::test]
async fn a_spoken_look_reaches_the_pin_camera_on_both_transports() {
    for transport in TRANSPORTS {
        let model = Looker::new(false);
        let sent = send(
            transport,
            model.clone(),
            spoken_request("Tell me what you see.", VisionRequested::Unspecified, false),
        )
        .await;
        let steps = model.steps();
        assert!(
            steps[0].offers_look(),
            "{transport:?}: the camera is offered"
        );
        assert!(
            !steps[0].context.contains(AIMED),
            "{transport:?}: a spoken request was not aimed with the gesture"
        );
        let look = sent
            .executed
            .iter()
            .find(|action| action.action == LOOK)
            .unwrap_or_else(|| panic!("{transport:?}: the Pin is asked to look"));
        let input: serde_json::Value = serde_json::from_str(&look.input).expect("look input");
        assert_eq!(input["Question"], "What do you see?", "{transport:?}");
    }
}

#[tokio::test]
async fn vision_with_gesture_only_withholds_the_camera_on_both_transports() {
    for transport in TRANSPORTS {
        let model = Looker::new(true);
        let sent = send(
            transport,
            model.clone(),
            spoken_request("Tell me what you see.", VisionRequested::NoVision, false),
        )
        .await;
        let steps = model.steps();
        assert!(
            !steps[0].offers_look(),
            "{transport:?}: the camera is withheld"
        );
        assert!(
            !sent.executes(LOOK),
            "{transport:?}: the Pin is never asked to look"
        );
        assert!(
            sent.observed(UNRECOGNIZED),
            "{transport:?}: the insisted look is bounced back to the model"
        );
        assert!(
            sent.executes(RESPOND),
            "{transport:?}: the wearer still hears an answer"
        );
    }
}

#[tokio::test]
async fn the_vision_gesture_is_stated_on_both_transports() {
    for transport in TRANSPORTS {
        for frame in [false, true] {
            let model = Looker::new(false);
            let sent = send(
                transport,
                model.clone(),
                spoken_request("What is this?", VisionRequested::Vision, frame),
            )
            .await;
            let steps = model.steps();
            assert!(steps[0].offers_look(), "{transport:?}, frame={frame}");
            assert!(
                steps[0].context.contains(AIMED),
                "{transport:?}, frame={frame}: the gesture reaches the model"
            );
            assert_eq!(
                steps[0].context.contains(FRAME),
                frame,
                "{transport:?}: the prefetched frame is stated only when it exists"
            );
            assert!(sent.executes(LOOK), "{transport:?}, frame={frame}");
        }
    }
}

#[tokio::test]
async fn one_look_per_run_on_both_transports() {
    // The hop after the look: the Pin replays the run with the look and its
    // observation and asks for the next step.
    let looked = pin_request(
        "What is this?",
        vec![
            spoken("run", "What is this?", VisionRequested::Vision, false),
            action("look", "run", LOOK, QUESTION),
            observation("seen", "look", LOOK, SEEN),
        ],
    );
    // A finished run that looked, still in context, then a new spoken run.
    let earlier = pin_request(
        "And now what do you see?",
        vec![
            spoken("old", "What is this?", VisionRequested::Unspecified, false),
            action("old-look", "old", LOOK, QUESTION),
            observation("old-seen", "old-look", LOOK, SEEN),
            action(
                "old-answer",
                "old-seen",
                RESPOND,
                r#"{"Response":"A mug."}"#,
            ),
            spoken(
                "new",
                "And now what do you see?",
                VisionRequested::Unspecified,
                false,
            ),
        ],
    );
    for transport in TRANSPORTS {
        let model = Looker::new(false);
        let sent = send(transport, model.clone(), looked.clone()).await;
        {
            let steps = model.steps();
            assert!(
                !steps[0].offers_look(),
                "{transport:?}: the run already looked"
            );
            assert!(
                !steps[0].context.contains(AIMED),
                "{transport:?}: the gesture line ends with the look"
            );
        }
        assert!(!sent.executes(LOOK), "{transport:?}: no second capture");

        let model = Looker::new(false);
        let sent = send(transport, model.clone(), earlier.clone()).await;
        assert!(
            model.steps()[0].offers_look(),
            "{transport:?}: an older run's look does not block this one"
        );
        assert!(sent.executes(LOOK), "{transport:?}");
    }
}

#[tokio::test]
async fn bidi_looks_once_per_stream() {
    let model = Looker::new(false);
    let (tx, mut out) = bidi(model.clone());
    tx.send(understanding(spoken_request(
        "Tell me what you see.",
        VisionRequested::Unspecified,
        false,
    )))
    .await
    .expect("request");
    let mut sent = Sent::default();
    let look_id = loop {
        let message = out.next().await.expect("the session asks the Pin to look");
        if let Some((id, action)) = record_event(&mut sent, message)
            && action.action == LOOK
        {
            break id;
        }
    };
    tx.send(Ok(pb::StreamingUnderstandRequest {
        content: Some(pb::streaming_understand_request::Content::Observation(
            observation("pin-seen", &look_id, LOOK, SEEN),
        )),
    }))
    .await
    .expect("observation");
    loop {
        let message = out.next().await.expect("the session answers");
        if let Some((_, action)) = record_event(&mut sent, message)
            && action.action == RESPOND
        {
            break;
        }
    }
    drop(tx);
    let steps = model.steps();
    assert_eq!(steps.len(), 2, "one look, then the answer");
    assert!(steps[1].context.contains(SEEN), "the answer reads the look");
    assert!(
        !steps[1].offers_look(),
        "the camera is not offered again in the run that looked"
    );
    assert_eq!(
        sent.executed
            .iter()
            .filter(|action| action.action == LOOK)
            .count(),
        1
    );
}

#[tokio::test]
async fn the_text_only_adapter_never_offers_the_camera() {
    let model = Looker::new(false);
    legacy_service(model.clone())
        .server_stateful_understand(as_wearer(pb::ServerStatefulUnderstandRequest {
            response_format: pb::server_stateful_understand_request::ResponseFormat::Text as i32,
            userrequest: Some(
                pb::server_stateful_understand_request::Userrequest::Transcription(
                    "Tell me what you see.".to_owned(),
                ),
            ),
        }))
        .await
        .expect("a text answer");
    let steps = model.steps();
    assert!(!steps.is_empty(), "the adapter reaches the model");
    assert!(steps.iter().all(|step| !step.offers_look()));
}
