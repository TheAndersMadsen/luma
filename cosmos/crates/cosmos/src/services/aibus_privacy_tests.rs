//! Integration: authenticated stock privacy writes govern the real assistant
//! dispatchers and direct location RPCs. Fixtures are synthetic, not recordings.

use std::sync::{Arc, Mutex};

use cosmos_protocol::aibus as pb;
use cosmos_protocol::privacy::grpc::common;
use cosmos_protocol::privacy::grpc::r#pub as privacy_pb;
use pb::ai_bus_service_server::AiBusService;
use privacy_pb::public_privacy_service_server::PublicPrivacyService;
use tokio_stream::StreamExt;
use tonic::{Request, Status};

use super::AiBusMain;
use crate::assistant::bidi::BidiSession;
use crate::assistant::catalog::ToolContext;
use crate::assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolDef};
use crate::services::gates::Entitlement;
use crate::services::public_privacy::PublicPrivacy;
use crate::store::{AccountBlobKind, MemoryStore, SharedStore};

const WEARER: &str = "U:revived-privacy-pin";
const OTHER: &str = "U:other-privacy-pin";
const PRIVATE_PLACE: &str = "PRIVATE-ANCHOR-MARINA";

fn caller<T>(body: T, principal: &str) -> Request<T> {
    let mut request = Request::new(body);
    request.extensions_mut().insert(
        cosmos_core::AuthenticatedPrincipal::from_edge(principal).expect("fixture principal"),
    );
    request
}

async fn set_privacy(store: &SharedStore, principal: &str, name: &str, enabled: bool) {
    let privacy = PublicPrivacy::default().with_store(store.clone());
    let value = if enabled { "on" } else { "off" };
    privacy
        .update_settings(caller(
            privacy_pb::UpdateSettingsRequest {
                settings: vec![common::PrivacySetting {
                    name: name.to_owned(),
                    value: value.to_owned(),
                }],
            },
            principal,
        ))
        .await
        .expect("privacy write");
    let read = privacy
        .get_settings(caller(
            privacy_pb::GetSettingsRequest {
                names: vec![name.to_owned()],
            },
            principal,
        ))
        .await
        .expect("privacy read")
        .into_inner();
    assert_eq!(read.settings[0].value, value);
}

#[derive(Default)]
struct RecordingModel {
    calls: Mutex<Vec<(String, Vec<String>)>>,
}

#[tonic::async_trait]
impl ChatModel for RecordingModel {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        self.calls.lock().expect("fixture model calls").push((
            messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            tools.iter().map(|tool| tool.name.clone()).collect(),
        ));
        Ok(ChatResponse {
            content: Some("A short synthetic answer.".to_owned()),
            ..Default::default()
        })
    }
}

fn service(store: SharedStore, model: Arc<dyn ChatModel>) -> AiBusMain {
    AiBusMain {
        engine: Arc::new(crate::assistant::engine::Engine::new(model)),
        keys: Default::default(),
        directory: None,
        store,
        entitlements: Default::default(),
    }
}

fn situated_request() -> pb::SynapseUnderstandingRequest {
    pb::SynapseUnderstandingRequest {
        utterance: "Tell me a short joke.".to_owned(),
        location: Some(pb::Location { latitude: 35.0123, longitude: 27.0456 }),
        device_context: Some(pb::SynapseDeviceContext {
            reverse_geocoded_location: PRIVATE_PLACE.to_owned(),
            situation: Some(pb::SynapseUserSituation {
                location_string: PRIVATE_PLACE.to_owned(), latitude: 35.0123, longitude: 27.0456,
                location: Some(pb::Location { latitude: 35.0123, longitude: 27.0456 }),
                time_zone_id: "Europe/Copenhagen".to_owned(), ..Default::default()
            }),
            turns: vec![pb::SynapseChatTurn {
                identifier: "privacy-location-observation".to_owned(),
                content: Some(pb::synapse_chat_turn::Content::Observation(pb::SynapseObservationContent {
                    action_name: "GetCurrentLocation".to_owned(),
                    observation: r#"{"latitude":35.0123,"longitude":27.0456,"location":"PRIVATE-ANCHOR-MARINA"}"#.to_owned(),
                    ..Default::default()
                })), ..Default::default()
            }], ..Default::default()
        }), ..Default::default()
    }
}

async fn bidi_exchange(
    store: SharedStore,
    principal: &str,
    model: Arc<dyn ChatModel>,
    request: pb::SynapseUnderstandingRequest,
) -> Vec<pb::SynapseChatTurn> {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    let out = BidiSession::spawn_with(
        model,
        Entitlement::Active,
        ToolContext {
            principal: Some(principal.to_owned()),
            store: Some(store),
            ..Default::default()
        },
        tokio_stream::wrappers::ReceiverStream::new(rx),
    );
    tx.send(Ok(pb::StreamingUnderstandRequest {
        content: Some(pb::streaming_understand_request::Content::UnderstandingRequest(request)),
    }))
    .await
    .expect("bidi request");
    drop(tx);
    out.filter_map(|message| message.ok())
        .filter_map(|message| match message.content {
            Some(pb::streaming_understand_response::Content::IntermediateEvent(event)) => {
                event.event
            }
            _ => None,
        })
        .collect()
        .await
}

#[tokio::test]
async fn privacy_location_setting_governs_both_assistant_transports() {
    let store = MemoryStore::shared();
    set_privacy(&store, WEARER, "location", false).await;
    for principal in [WEARER, OTHER] {
        for bidi in [false, true] {
            let model = Arc::new(RecordingModel::default());
            if bidi {
                bidi_exchange(store.clone(), principal, model.clone(), situated_request()).await;
            } else {
                let svc = service(store.clone(), model.clone());
                let responses = svc
                    .understand(caller(situated_request(), principal))
                    .await
                    .expect("understand")
                    .into_inner()
                    .collect::<Vec<_>>()
                    .await;
                assert!(responses.iter().all(Result::is_ok));
            }
            let calls = model.calls.lock().expect("model capture");
            assert!(
                !calls.is_empty(),
                "the actual dispatcher must reach the model"
            );
            let (context, offered) = &calls[0];
            assert_eq!(
                context.contains(PRIVATE_PLACE),
                principal == OTHER,
                "location prose privacy: {principal}, bidi={bidi}"
            );
            assert_eq!(
                context.contains("35.012"),
                principal == OTHER,
                "location coordinate privacy: {principal}, bidi={bidi}"
            );
            assert_eq!(
                offered.iter().any(|tool| tool == "GetCurrentLocation"),
                principal == OTHER,
                "location acquisition privacy: {principal}, bidi={bidi}"
            );
            assert!(
                context.contains("Europe/Copenhagen"),
                "privacy preserves useful time zone context"
            );
        }
    }
}

#[tokio::test]
async fn privacy_location_setting_blocks_raw_location_rpc_provider_paths() {
    let store = MemoryStore::shared();
    set_privacy(&store, WEARER, "location", false).await;
    let svc = service(store, Arc::new(RecordingModel::default()));
    let mut refused: Vec<Status> = Vec::new();
    refused.push(
        svc.encrypted_geo_locate(caller(pb::EncryptedGeoLocateRequest::default(), WEARER))
            .await
            .expect_err("geolocation refused"),
    );
    refused.push(
        svc.encrypted_reverse_geocode(caller(
            pb::EncryptedReverseGeocodeRequest::default(),
            WEARER,
        ))
        .await
        .expect_err("reverse geocoding refused"),
    );
    refused.push(
        svc.encrypted_navigation_directions(caller(
            pb::EncryptedNavigationDirectionsRequest::default(),
            WEARER,
        ))
        .await
        .expect_err("directions refused"),
    );
    refused.push(
        svc.encrypted_nearby_search(caller(pb::EncryptedNearbySearchRequest::default(), WEARER))
            .await
            .expect_err("nearby refused"),
    );
    refused.push(
        svc.encrypted_weather(caller(pb::EncryptedWeatherRequest::default(), WEARER))
            .await
            .expect_err("weather refused"),
    );
    for status in refused {
        assert_eq!(
            status.code(),
            tonic::Code::PermissionDenied,
            "privacy must be checked before payload decryption/provider access"
        );
        assert_eq!(status.message(), "location access is off");
    }
}

#[tokio::test]
async fn privacy_diagnostics_are_opt_in_content_free_and_use_both_transports() {
    let store = MemoryStore::shared();
    for enabled in [false, true] {
        set_privacy(&store, WEARER, "traces", enabled).await;
        for bidi in [false, true] {
            let model = Arc::new(RecordingModel::default());
            let request = pb::SynapseUnderstandingRequest {
                utterance: "PRIVATE-DIAGNOSTIC-UTTERANCE".to_owned(),
                ..Default::default()
            };
            if bidi {
                bidi_exchange(store.clone(), WEARER, model, request).await;
            } else {
                service(store.clone(), model)
                    .understand(caller(request, WEARER))
                    .await
                    .expect("understand")
                    .into_inner()
                    .collect::<Vec<_>>()
                    .await;
            }
            let saved = store
                .get_account_blob(WEARER, AccountBlobKind::PrivacyDiagnostics)
                .await
                .expect("diagnostics blob");
            assert_eq!(saved.is_some(), enabled, "diagnostics consent, bidi={bidi}");
            if let Some(saved) = saved {
                let text = String::from_utf8(saved).expect("diagnostics JSON");
                assert!(!text.contains("PRIVATE-DIAGNOSTIC") && !text.contains(WEARER));
                let data: serde_json::Value =
                    serde_json::from_str(&text).expect("diagnostics JSON");
                assert_eq!(data["transport"], if bidi { "bidi" } else { "legacy" });
                assert_eq!(data["outcome"], "answered");
            }
        }
    }
}

#[tokio::test]
async fn privacy_local_weather_explains_location_off_without_model_or_gps() {
    let store = MemoryStore::shared();
    set_privacy(&store, WEARER, "location", false).await;
    for bidi in [false, true] {
        let model = Arc::new(RecordingModel::default());
        let request = pb::SynapseUnderstandingRequest {
            utterance: "What is the weather here?".to_owned(),
            device_context: Some(pb::SynapseDeviceContext::default()),
            ..Default::default()
        };
        let turns = if bidi {
            bidi_exchange(store.clone(), WEARER, model.clone(), request).await
        } else {
            service(store.clone(), model.clone())
                .understand(caller(request, WEARER))
                .await
                .expect("understand")
                .into_inner()
                .filter_map(|reply| match reply.expect("reply").body {
                    Some(pb::synapse_understanding_response::Body::Turn(turn)) => Some(turn),
                    _ => None,
                })
                .collect()
                .await
        };
        assert!(
            model.calls.lock().unwrap().is_empty(),
            "closed privacy refusal must not need a model, bidi={bidi}"
        );
        let actions = turns
            .iter()
            .filter_map(|turn| match &turn.content {
                Some(pb::synapse_chat_turn::Content::Action(action)) => Some(action),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(
            !actions
                .iter()
                .any(|action| action.action == "GetCurrentLocation")
        );
        assert!(
            actions.iter().any(|action| action.action == "Respond"
                && action.input.contains("Location access is off")),
            "give a useful privacy answer, bidi={bidi}"
        );
    }
}

#[tokio::test]
async fn privacy_quick_action_notes_do_not_keep_automatic_location_when_off() {
    let store = MemoryStore::shared();
    set_privacy(&store, WEARER, "location", false).await;
    let svc = service(store.clone(), Arc::new(RecordingModel::default()));
    svc.function_execution(caller(
        pb::FunctionCall {
            name: "CreateMemory".to_owned(),
            utterance: "A private synthetic note.".to_owned(),
            location: Some(cosmos_protocol::common::encryption::LocationEnvelope {
                latitude: 35.0123,
                longitude: 27.0456,
                ..Default::default()
            }),
            ..Default::default()
        },
        WEARER,
    ))
    .await
    .expect("quick action note");
    let notes = store
        .recent_notes(WEARER, 10, None, None)
        .await
        .expect("saved notes");
    assert_eq!(notes.len(), 1);
    assert!(
        notes[0].location.is_none(),
        "new notes must not retain disabled automatic location"
    );
}

/// Synthetic model deliberately asks for a tool the privacy-filtered catalog
/// never offered. The real dispatchers must refuse without any GPS action.
struct ForcedLocationModel;

#[tonic::async_trait]
impl ChatModel for ForcedLocationModel {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        Ok(ChatResponse {
            tool_call: Some(crate::assistant::llm::ToolCall {
                name: "GetCurrentLocation".to_owned(),
                arguments: "{}".to_owned(),
            }),
            ..Default::default()
        })
    }
}

#[tokio::test]
async fn privacy_blocks_a_model_invented_location_action_on_both_transports() {
    let store = MemoryStore::shared();
    set_privacy(&store, WEARER, "location", false).await;
    for bidi in [false, true] {
        let model: Arc<dyn ChatModel> = Arc::new(ForcedLocationModel);
        let request = pb::SynapseUnderstandingRequest {
            utterance: "Tell me a short joke.".to_owned(),
            ..Default::default()
        };
        let turns: Vec<pb::SynapseChatTurn> = if bidi {
            bidi_exchange(store.clone(), WEARER, model, request).await
        } else {
            service(store.clone(), model)
                .understand(caller(request, WEARER))
                .await
                .unwrap()
                .into_inner()
                .filter_map(|reply| match reply.unwrap().body {
                    Some(pb::synapse_understanding_response::Body::Turn(turn)) => Some(turn),
                    _ => None,
                })
                .collect()
                .await
        };
        let actions = turns
            .iter()
            .filter_map(|turn| match &turn.content {
                Some(pb::synapse_chat_turn::Content::Action(action)) => Some(action),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(
            !actions
                .iter()
                .any(|action| action.action == "GetCurrentLocation"),
            "no emitted GPS action, bidi={bidi}"
        );
        assert!(
            actions.iter().any(|action| action.action == "Respond"
                && action.input.contains("Location access is off")),
            "useful privacy refusal, bidi={bidi}"
        );
    }
}

/// Actual dispatchers in a fresh process isolate the opt-in OS3 singleton.
/// Synthetic credentials never reach Rabbit: a held conversation key and
/// corrupt local sealed journal fail closed before any authentication request.
#[tokio::test]
async fn privacy_location_refusal_keeps_explicit_os3_forecast_priority() {
    const CHILD: &str = "LUMA_PRIVACY_OS3_PRIORITY_FIXTURE";
    const TEST: &str = "services::aibus_main::privacy_tests::privacy_location_refusal_keeps_explicit_os3_forecast_priority";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "synthetic")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated OS3 priority fixture: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(format!("luma-privacy-os3-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = crate::integrations::IntegrationsConfig::default();
    config.os3.enabled = true;
    config.os3.session_cookie = Some("session=synthetic-never-sent".to_owned());
    std::fs::write(
        directory.join("integrations.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    crate::integrations::install(directory.to_str()).unwrap();
    let store = MemoryStore::shared();
    set_privacy(&store, WEARER, "location", false).await;
    let keys = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
    keys.put(
        &format!("{WEARER}/os3/conversation"),
        [0x43; cosmos_crypto::AES_KEY_LEN],
    )
    .await
    .unwrap();
    store
        .put_account_blob(
            WEARER,
            AccountBlobKind::Os3Conversation,
            b"synthetic-corrupt-sealed-journal",
        )
        .await
        .unwrap();
    for utterance in [
        "Ask OS3 what is the weather here tomorrow?",
        "cancel OS3",
        "Can you cancel OS3?",
        "Stop the OS3 task?",
        "stop the OS3 task",
        "Please tell OS3 to cancel the current task!",
    ] {
        for bidi in [false, true] {
            let model = Arc::new(RecordingModel::default());
            let request = pb::SynapseUnderstandingRequest {
                utterance: utterance.to_owned(),
                ..Default::default()
            };
            let turns: Vec<pb::SynapseChatTurn> = if bidi {
                let (tx, rx) = tokio::sync::mpsc::channel(4);
                let stream = BidiSession::spawn_with(
                    model.clone(),
                    Entitlement::Active,
                    ToolContext {
                        principal: Some(WEARER.to_owned()),
                        store: Some(store.clone()),
                        key_directory: Some(keys.clone()),
                        ..Default::default()
                    },
                    tokio_stream::wrappers::ReceiverStream::new(rx),
                );
                tx.send(Ok(pb::StreamingUnderstandRequest {
                    content: Some(
                        pb::streaming_understand_request::Content::UnderstandingRequest(request),
                    ),
                }))
                .await
                .unwrap();
                drop(tx);
                stream
                    .filter_map(|message| match message.unwrap().content {
                        Some(pb::streaming_understand_response::Content::IntermediateEvent(
                            event,
                        )) => event.event,
                        _ => None,
                    })
                    .collect()
                    .await
            } else {
                let mut svc = service(store.clone(), model.clone());
                svc.directory = Some(keys.clone());
                svc.understand(caller(request, WEARER))
                    .await
                    .unwrap()
                    .into_inner()
                    .filter_map(|reply| match reply.unwrap().body {
                        Some(pb::synapse_understanding_response::Body::Turn(turn)) => Some(turn),
                        _ => None,
                    })
                    .collect()
                    .await
            };
            assert!(
                model.calls.lock().unwrap().is_empty(),
                "explicit command {utterance:?}, bidi={bidi} must not invoke a model"
            );
            let actions = turns
                .iter()
                .filter_map(|turn| match &turn.content {
                    Some(pb::synapse_chat_turn::Content::Action(action)) => Some(action),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert!(
                actions.iter().any(|action| action.action == "ask_os3"),
                "explicit OS3 remains first, bidi={bidi}"
            );
            assert!(
                actions
                    .iter()
                    .all(|action| action.action != "GetCurrentLocation")
            );
            assert!(
                actions.iter().any(|action| action.action == "Respond"
                    && action.input.contains("could not read or save")),
                "fixture must fail before HTTP, bidi={bidi}"
            );
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}
