use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::info;

use super::super::envelope::unwrap_plaintext_data_for_kid;
use crate::proto::aibus::{
    EncryptedLoadingMessageRequest, EncryptedLoadingMessageResponse, LoadingMessageRequest,
    LoadingMessageResponse,
};
use crate::proto::common::encryption::EncryptedData;
use crate::tier_a::{operational_markers, proto_kids};

const MAX_LOADING_REQUEST_BYTES: usize = 256 * 1024;
const MAX_UTTERANCE_BYTES: usize = 16 * 1024;
const PHYSICAL_LOADING_RUN_ID_PREFIX: &str = "physical-loading-";

/// Validates the stock loading-message envelope and emits only a closed,
/// deterministic category cue. The handler owns no model, cache, referent, or
/// generation state, and it never repeats a subject from the utterance.
#[derive(Default)]
pub struct LoadingMessageHandler;

impl LoadingMessageHandler {
    pub const fn new() -> Self {
        Self
    }

    pub async fn encrypted_loading_message(
        &self,
        request: Request<EncryptedLoadingMessageRequest>,
    ) -> Result<Response<EncryptedLoadingMessageResponse>, Status> {
        let physical_correlation = physical_loading_correlation(request.metadata());
        let request = request.into_inner();
        let request_bytes = unwrap_plaintext_data_for_kid(
            &request.request,
            proto_kids::LOADING_MESSAGE_REQUEST,
            MAX_LOADING_REQUEST_BYTES,
        )?;
        let request = LoadingMessageRequest::decode(request_bytes)
            .map_err(|_| Status::invalid_argument("bad LoadingMessageRequest"))?;
        validate_utterance(&request.utterance)?;

        // Do not log or forward utterance, turns, lock state, or response prose.
        // The optional marker is accepted only from the content-free physical
        // harness namespace below.
        let (response, decision) = loading_message_for(&request.utterance, request.is_unlocked);
        info!(
            emitted = decision.cue.is_some(),
            source = decision.source,
            reason = decision.reason,
            correlation = physical_correlation.as_deref().unwrap_or("none"),
            message = operational_markers::BOUNDED_LOADING_MESSAGE
        );

        Ok(Response::new(EncryptedLoadingMessageResponse {
            response: Some(EncryptedData::new(
                proto_kids::LOADING_MESSAGE_RESPONSE,
                response.encode_to_vec(),
            )),
        }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LoadingDecision {
    cue: Option<&'static str>,
    source: &'static str,
    reason: &'static str,
}

fn loading_message_for(
    utterance: &str,
    is_unlocked: bool,
) -> (LoadingMessageResponse, LoadingDecision) {
    let decision = loading_decision(utterance, is_unlocked);
    let response = match decision.cue {
        Some(cue) => LoadingMessageResponse {
            loading_message: format!("{cue}..."),
            verbal_message: format!("{cue}."),
        },
        None => LoadingMessageResponse::default(),
    };
    (response, decision)
}

fn loading_decision(utterance: &str, is_unlocked: bool) -> LoadingDecision {
    if !is_unlocked {
        return LoadingDecision {
            cue: None,
            source: "policy",
            reason: "locked",
        };
    }

    let normalized = utterance.to_lowercase();
    let words = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let has = |candidates: &[&str]| candidates.iter().any(|candidate| words.contains(candidate));
    let media_subject = has(&[
        "music",
        "song",
        "songs",
        "track",
        "tracks",
        "album",
        "albums",
        "playlist",
        "playlists",
        "playback",
    ]);
    if media_subject
        && has(&[
            "pause", "paused", "hold", "resume", "stop", "skip", "next", "previous",
        ])
    {
        return LoadingDecision {
            cue: None,
            source: "deterministic",
            reason: "playback_control",
        };
    }
    if has(&[
        "weather",
        "forecast",
        "umbrella",
        "rain",
        "raining",
        "snow",
        "snowing",
        "temperature",
        "wind",
        "windy",
    ]) {
        return LoadingDecision {
            cue: Some("Checking the weather"),
            source: "deterministic",
            reason: "weather",
        };
    }
    if media_subject
        || (has(&["queue"]) && has(&["hit", "hits", "pop", "dance", "artist", "band", "singer"]))
    {
        return LoadingDecision {
            cue: Some("Finding music"),
            source: "deterministic",
            reason: "music",
        };
    }
    LoadingDecision {
        cue: None,
        source: "deterministic",
        reason: "unclassified",
    }
}

/// Accept only the harness-owned, content-free UUID marker. Arbitrary stock
/// run ids are deliberately collapsed to `none` so logs cannot acquire user,
/// prompt, location, or conversation identifiers through request metadata.
fn physical_loading_correlation(metadata: &tonic::metadata::MetadataMap) -> Option<String> {
    let value = metadata.get("x-ai-mic-run-id")?.to_str().ok()?;
    let suffix = value.strip_prefix(PHYSICAL_LOADING_RUN_ID_PREFIX)?;
    let parsed = uuid::Uuid::parse_str(suffix).ok()?;
    (parsed.get_version() == Some(uuid::Version::Random)
        && parsed.get_variant() == uuid::Variant::RFC4122
        && parsed.hyphenated().to_string() == suffix)
        .then(|| value.to_string())
}

fn validate_utterance(utterance: &str) -> Result<(), Status> {
    if utterance.trim().is_empty()
        || utterance.len() > MAX_UTTERANCE_BYTES
        || utterance.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return Err(Status::invalid_argument(
            "loading-message utterance is invalid",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use prost::Message;
    use tonic::Code;

    use super::*;
    use crate::proto::aibus::{
        synapse_chat_turn, SynapseChatTurn, SynapseUser, SynapseUserRequestContent,
    };

    fn encrypted_request(kid: &str, inner: impl Message) -> EncryptedLoadingMessageRequest {
        EncryptedLoadingMessageRequest {
            request: Some(EncryptedData::new(kid, inner.encode_to_vec())),
        }
    }

    async fn response_for(utterance: &str, is_unlocked: bool) -> LoadingMessageResponse {
        let inner = LoadingMessageRequest {
            utterance: utterance.into(),
            is_unlocked,
            turns: Vec::new(),
        };
        let response = LoadingMessageHandler::new()
            .encrypted_loading_message(Request::new(encrypted_request(
                proto_kids::LOADING_MESSAGE_REQUEST,
                inner,
            )))
            .await
            .unwrap()
            .into_inner()
            .response
            .unwrap();
        assert_eq!(
            response.encryption_information.as_ref().unwrap().kid,
            proto_kids::LOADING_MESSAGE_RESPONSE
        );
        LoadingMessageResponse::decode(response.data.as_slice()).unwrap()
    }

    #[test]
    fn handler_has_no_model_cache_or_referent_state() {
        assert_eq!(std::mem::size_of::<LoadingMessageHandler>(), 0);
    }

    #[test]
    fn stock_loading_messages_have_the_reconstructed_wire_shape() {
        let request = LoadingMessageRequest {
            utterance: "hello".into(),
            is_unlocked: true,
            turns: Vec::new(),
        };
        assert_eq!(
            request.encode_to_vec(),
            [0x0a, 0x05, b'h', b'e', b'l', b'l', b'o', 0x10, 0x01]
        );
        let response = LoadingMessageResponse {
            loading_message: "x".into(),
            verbal_message: "y".into(),
        };
        assert_eq!(
            response.encode_to_vec(),
            [0x0a, 0x01, b'x', 0x12, 0x01, b'y']
        );
    }

    #[tokio::test]
    async fn loading_cues_classify_music_and_weather_without_generic_filler() {
        for (utterance, loading, verbal) in [
            (
                "Queue the definitive dance-floor hit from the King of Pop.",
                "Finding music...",
                "Finding music.",
            ),
            (
                "Will I need an umbrella before dinner?",
                "Checking the weather...",
                "Checking the weather.",
            ),
        ] {
            let response = response_for(utterance, true).await;
            assert_eq!(response.loading_message, loading);
            assert_eq!(response.verbal_message, verbal);
        }

        for (utterance, is_unlocked) in [
            ("Put the current track on hold for a moment.", true),
            ("Use what you remember about my commute.", false),
            ("Tell me something interesting.", true),
        ] {
            let response = response_for(utterance, is_unlocked).await;
            assert!(response.loading_message.is_empty());
            assert!(response.verbal_message.is_empty());
        }
    }

    #[test]
    fn loading_decisions_expose_only_closed_truthful_provenance() {
        assert_eq!(
            loading_decision("find a song", true),
            LoadingDecision {
                cue: Some("Finding music"),
                source: "deterministic",
                reason: "music",
            }
        );
        assert_eq!(
            loading_decision("pause the current track", true),
            LoadingDecision {
                cue: None,
                source: "deterministic",
                reason: "playback_control",
            }
        );
        assert_eq!(
            loading_decision("private wearer request", false),
            LoadingDecision {
                cue: None,
                source: "policy",
                reason: "locked",
            }
        );
    }

    #[tokio::test]
    async fn stale_history_lock_state_and_retries_never_change_loading_output() {
        let handler = LoadingMessageHandler::new();
        let stale_turn = SynapseChatTurn {
            user: SynapseUser::User as i32,
            identifier: "synthetic-stale-turn".into(),
            content: Some(synapse_chat_turn::Content::UserRequest(
                SynapseUserRequestContent {
                    request: "synthetic stale context".into(),
                    ..Default::default()
                },
            )),
            ..Default::default()
        };

        let mut encoded_responses = Vec::new();
        for is_unlocked in [false, true] {
            let request = LoadingMessageRequest {
                utterance: "synthetic current request".into(),
                is_unlocked,
                turns: vec![stale_turn.clone()],
            };
            let response = handler
                .encrypted_loading_message(Request::new(encrypted_request(
                    proto_kids::LOADING_MESSAGE_REQUEST,
                    request,
                )))
                .await
                .unwrap()
                .into_inner()
                .response
                .unwrap();
            let decoded = LoadingMessageResponse::decode(response.data.as_slice()).unwrap();
            assert!(decoded.loading_message.is_empty());
            assert!(decoded.verbal_message.is_empty());
            encoded_responses.push(response.data);
        }
        assert_eq!(encoded_responses[0], encoded_responses[1]);
    }

    #[tokio::test]
    async fn handler_rejects_wrong_kid_malformed_proto_and_oversize_envelope() {
        let valid = LoadingMessageRequest {
            utterance: "synthetic request".into(),
            is_unlocked: true,
            turns: Vec::new(),
        };
        let wrong_kid = LoadingMessageHandler::new()
            .encrypted_loading_message(Request::new(encrypted_request(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                valid,
            )))
            .await
            .unwrap_err();
        assert_eq!(wrong_kid.code(), Code::InvalidArgument);

        let malformed = EncryptedLoadingMessageRequest {
            request: Some(EncryptedData::new(
                proto_kids::LOADING_MESSAGE_REQUEST,
                vec![0x0a, 0x02, b'x'],
            )),
        };
        let malformed = LoadingMessageHandler::new()
            .encrypted_loading_message(Request::new(malformed))
            .await
            .unwrap_err();
        assert_eq!(malformed.code(), Code::InvalidArgument);

        let oversized = EncryptedLoadingMessageRequest {
            request: Some(EncryptedData::new(
                proto_kids::LOADING_MESSAGE_REQUEST,
                vec![0; MAX_LOADING_REQUEST_BYTES + 1],
            )),
        };
        let oversized = LoadingMessageHandler::new()
            .encrypted_loading_message(Request::new(oversized))
            .await
            .unwrap_err();
        assert_eq!(oversized.code(), Code::InvalidArgument);
    }

    #[tokio::test]
    async fn handler_rejects_invalid_or_unbounded_utterances() {
        for utterance in [
            String::new(),
            "   ".into(),
            "invalid\0utterance".into(),
            "invalid\u{0001}utterance".into(),
            "x".repeat(MAX_UTTERANCE_BYTES + 1),
        ] {
            let request = LoadingMessageRequest {
                utterance,
                is_unlocked: true,
                turns: Vec::new(),
            };
            let status = LoadingMessageHandler::new()
                .encrypted_loading_message(Request::new(encrypted_request(
                    proto_kids::LOADING_MESSAGE_REQUEST,
                    request,
                )))
                .await
                .unwrap_err();
            assert_eq!(status.code(), Code::InvalidArgument);
        }
    }

    #[test]
    fn physical_loading_correlation_accepts_only_canonical_random_uuid_markers() {
        let marker = "physical-loading-123e4567-e89b-42d3-a456-426614174000";
        let mut metadata = tonic::metadata::MetadataMap::new();
        metadata.insert("x-ai-mic-run-id", marker.parse().unwrap());
        assert_eq!(
            physical_loading_correlation(&metadata).as_deref(),
            Some(marker)
        );

        for rejected in [
            "PRIVATE_PROMPT_OR_CONTACT",
            "physical-loading-123e4567-e89b-12d3-a456-426614174000",
            "physical-loading-123e4567-e89b-42d3-0456-426614174000",
            "physical-loading-123E4567-E89B-42D3-A456-426614174000",
            "release-smoke-123e4567-e89b-42d3-a456-426614174000",
        ] {
            let mut metadata = tonic::metadata::MetadataMap::new();
            metadata.insert("x-ai-mic-run-id", rejected.parse().unwrap());
            assert_eq!(physical_loading_correlation(&metadata), None, "{rejected}");
        }
    }
}
