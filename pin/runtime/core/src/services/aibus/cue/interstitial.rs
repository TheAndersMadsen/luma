use prost::Message as _;
use serde_json::Value;
use tonic::{Request, Response, Status};
use tracing::info;

use super::super::envelope::unwrap_plaintext_data_for_kid;
use crate::config::spoken_progress_cues_enabled;
use crate::proto::{aibus::*, common::encryption::EncryptedData};
use crate::synapse::catalog::read_tool_spec;
use crate::tier_a::proto_kids;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_ACTION_STRINGS: usize = 32;
const MAX_ACTION_STRING_BYTES: usize = 4 * 1024;
const MAX_ACTION_NAME_BYTES: usize = 128;
const MAX_PROGRESS_SUBJECT_BYTES: usize = 48;
const MAX_PROGRESS_CUE_BYTES: usize = 96;

/// Answers stock's action-interstitial request with one short description of
/// the read that is actually running. It makes no model call and retains no
/// request state.
#[derive(Default)]
pub struct ActionInterstitialHandler;

impl ActionInterstitialHandler {
    pub const fn new() -> Self {
        Self
    }

    pub async fn encrypted_action_based_interstitial(
        &self,
        request: Request<EncryptedActionBasedInterstitialRequest>,
    ) -> Result<Response<EncryptedActionBasedInterstitialResponse>, Status> {
        let request = request.into_inner();
        let request_bytes = unwrap_plaintext_data_for_kid(
            &request.request,
            proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
            MAX_REQUEST_BYTES,
        )?;
        let request = ActionBasedInterstitialRequest::decode(request_bytes)
            .map_err(|_| Status::invalid_argument("bad ActionBasedInterstitialRequest"))?;
        let actions = bounded_actions(request.action_strings)?;
        let action_count = actions.len();
        let armed = spoken_progress_cues_enabled();
        let interstitial = interstitial_phrase(&actions, armed).unwrap_or_default();

        info!(
            action_count,
            armed,
            emitted = !interstitial.is_empty(),
            "<<< Returning action interstitial"
        );

        let response = ActionBasedInterstitialResponse { interstitial };
        Ok(Response::new(EncryptedActionBasedInterstitialResponse {
            response: Some(EncryptedData::new(
                proto_kids::ACTION_BASED_INTERSTITIAL_RESPONSE,
                response.encode_to_vec(),
            )),
        }))
    }
}

#[derive(Debug)]
struct ActionCue {
    name: String,
    arguments: Value,
}

/// Stock accumulates action strings across a run. A single entry is the first
/// cue opportunity; subsequent requests contain multiple entries and stay
/// silent, so a turn never repeats itself.
fn interstitial_phrase(actions: &[ActionCue], armed: bool) -> Option<String> {
    if !armed || actions.len() != 1 {
        return None;
    }
    cue_phrase_for_read_tool(&actions[0])
}

fn cue_phrase_for_read_tool(action: &ActionCue) -> Option<String> {
    read_tool_spec(&action.name)?;
    let arguments = &action.arguments;
    let cue = match action.name.as_str() {
        "knowledge_lookup" | "web_search" => {
            cue_with_subject(arguments, "query", "Looking up ", "Looking that up")
        }
        "place_search" => cue_with_subject(arguments, "query", "Finding ", "Finding that place"),
        "weather_at_place" => cue_with_subject(
            arguments,
            "location",
            "Checking the weather in ",
            "Checking the weather",
        ),
        "current_location" | "reverse_geocode" => "Checking the location".to_owned(),
        "current_weather" => cue_with_subject(
            arguments,
            "location",
            "Checking the weather in ",
            "Checking the local weather",
        ),
        "nearby_search" => progress_subject(arguments, "query")
            .map(|query| format!("Finding {query} nearby"))
            .unwrap_or_else(|| "Finding nearby places".to_owned()),
        "route" => cue_with_subject(
            arguments,
            "destination",
            "Finding directions to ",
            "Finding directions",
        ),
        "music_artist_top_tracks" => {
            cue_with_subject(arguments, "artist", "Finding songs by ", "Finding songs")
        }
        "music_catalog_search" => cue_with_subject(arguments, "query", "Finding ", "Finding music"),
        "current_music" => "Checking the current music".to_owned(),
        // Memory queries can contain private details; describe the store, not
        // the query, when speaking aloud.
        "memory_search" => "Checking saved memories".to_owned(),
        "food_lookup" => cue_with_subject(
            arguments,
            "query",
            "Checking nutrition for ",
            "Checking nutrition",
        ),
        _ => return None,
    };
    valid_progress_phrase(&cue).then_some(cue)
}

fn cue_with_subject(arguments: &Value, key: &str, prefix: &str, fallback: &str) -> String {
    progress_subject(arguments, key)
        .map(|subject| format!("{prefix}{subject}"))
        .unwrap_or_else(|| fallback.to_owned())
}

fn progress_subject(arguments: &Value, key: &str) -> Option<String> {
    let raw = arguments.get(key)?.as_str()?;
    let cleaned = raw
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '.' | ',' | '?' | '!' | ':' | ';' | '"' | '“' | '”'
            )
    });
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.len() <= MAX_PROGRESS_SUBJECT_BYTES {
        return Some(cleaned.to_owned());
    }

    let mut end = MAX_PROGRESS_SUBJECT_BYTES.saturating_sub('…'.len_utf8());
    while end > 0 && !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    let shortened = cleaned[..end].trim_end();
    (!shortened.is_empty()).then(|| format!("{shortened}…"))
}

fn valid_progress_phrase(cue: &str) -> bool {
    !cue.is_empty()
        && cue.len() <= MAX_PROGRESS_CUE_BYTES
        && cue.trim() == cue
        && !cue.chars().any(char::is_control)
}

fn bounded_actions(action_strings: Vec<String>) -> Result<Vec<ActionCue>, Status> {
    if action_strings.len() > MAX_ACTION_STRINGS {
        return Err(Status::invalid_argument("too many interstitial actions"));
    }

    action_strings
        .into_iter()
        .map(|raw| {
            if raw.len() > MAX_ACTION_STRING_BYTES {
                return Err(Status::invalid_argument(
                    "interstitial action JSON is too large",
                ));
            }
            let Value::Object(object) = serde_json::from_str::<Value>(&raw)
                .map_err(|_| Status::invalid_argument("invalid interstitial action JSON"))?
            else {
                return Err(Status::invalid_argument("invalid interstitial action JSON"));
            };
            if object.len() != 1 {
                return Err(Status::invalid_argument("invalid interstitial action JSON"));
            }
            let (name, arguments) = object.into_iter().next().expect("one action");
            if name.is_empty() || name.len() > MAX_ACTION_NAME_BYTES || !arguments.is_object() {
                return Err(Status::invalid_argument("invalid interstitial action JSON"));
            }
            Ok(ActionCue { name, arguments })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use prost::Message;
    use tonic::Code;

    use super::*;
    use crate::tier_a::native_actions;

    fn encrypted_request(
        kid: &str,
        inner: impl Message,
    ) -> EncryptedActionBasedInterstitialRequest {
        EncryptedActionBasedInterstitialRequest {
            request: Some(EncryptedData::new(kid, inner.encode_to_vec())),
        }
    }

    fn action_json(action: &str, parameters: &str) -> String {
        format!(r#"{{"{action}":{parameters}}}"#)
    }

    fn action(action: &str, parameters: &str) -> ActionCue {
        bounded_actions(vec![action_json(action, parameters)])
            .unwrap()
            .remove(0)
    }

    fn cue(action_name: &str, parameters: &str) -> Option<String> {
        cue_phrase_for_read_tool(&action(action_name, parameters))
    }

    async fn response_for(actions: &[String]) -> ActionBasedInterstitialResponse {
        let inner = ActionBasedInterstitialRequest {
            action_strings: actions.to_vec(),
        };
        let response = ActionInterstitialHandler::new()
            .encrypted_action_based_interstitial(Request::new(encrypted_request(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                inner,
            )))
            .await
            .unwrap()
            .into_inner()
            .response
            .unwrap();
        assert_eq!(
            response.encryption_information.as_ref().unwrap().kid,
            proto_kids::ACTION_BASED_INTERSTITIAL_RESPONSE
        );
        ActionBasedInterstitialResponse::decode(response.data.as_slice()).unwrap()
    }

    #[test]
    fn handler_is_stateless_and_stock_wire_layout_is_unchanged() {
        assert_eq!(std::mem::size_of::<ActionInterstitialHandler>(), 0);
        assert_eq!(
            ActionBasedInterstitialRequest {
                action_strings: vec!["x".into(), "y".into()],
            }
            .encode_to_vec(),
            [0x0a, 0x01, b'x', 0x0a, 0x01, b'y']
        );
        assert_eq!(
            ActionBasedInterstitialResponse {
                interstitial: "x".into(),
            }
            .encode_to_vec(),
            [0x0a, 0x01, b'x']
        );
    }

    #[test]
    fn cues_describe_the_selected_work() {
        assert_eq!(
            cue("weather_at_place", r#"{"location":"Hvidovre"}"#).as_deref(),
            Some("Checking the weather in Hvidovre")
        );
        assert_eq!(
            cue("web_search", r#"{"query":"FC København result"}"#).as_deref(),
            Some("Looking up FC København result")
        );
        assert_eq!(
            cue("nearby_search", r#"{"query":"coffee"}"#).as_deref(),
            Some("Finding coffee nearby")
        );
        assert_eq!(
            cue("route", r#"{"destination":"Hovedbanegården"}"#).as_deref(),
            Some("Finding directions to Hovedbanegården")
        );
    }

    #[test]
    fn memory_queries_and_non_read_actions_are_not_spoken() {
        assert_eq!(
            cue("memory_search", r#"{"query":"private detail"}"#).as_deref(),
            Some("Checking saved memories")
        );
        for name in [
            native_actions::RESPOND,
            native_actions::PLAY_MUSIC,
            "remember_fact",
            "play_music",
            "unknown",
        ] {
            assert_eq!(cue_phrase_for_read_tool(&action(name, "{}")), None);
        }
    }

    #[test]
    fn every_registered_read_tool_has_a_bounded_cue() {
        for spec in crate::synapse::catalog::READ_TOOL_CATALOG {
            let phrase = cue(spec.name, "{}")
                .unwrap_or_else(|| panic!("read tool '{}' has no progress cue", spec.name));
            assert!(
                valid_progress_phrase(&phrase),
                "invalid cue for {}",
                spec.name
            );
        }
    }

    #[test]
    fn the_gate_and_action_count_suppress_unwanted_cues() {
        let web = action("web_search", r#"{"query":"weather"}"#);
        assert_eq!(interstitial_phrase(&[web], false), None);
        let first = action("web_search", r#"{"query":"weather"}"#);
        let repeat = action("web_search", r#"{"query":"weather"}"#);
        assert_eq!(interstitial_phrase(&[first, repeat], true), None);
        assert_eq!(interstitial_phrase(&[], true), None);
    }

    #[test]
    fn subjects_are_normalized_and_bounded() {
        assert_eq!(
            cue("web_search", r#"{"query":"  weather\n in   Hvidovre? "}"#).as_deref(),
            Some("Looking up weather in Hvidovre")
        );
        let long = "ø".repeat(100);
        let phrase = cue(
            "web_search",
            &serde_json::json!({"query": long}).to_string(),
        )
        .unwrap();
        assert!(phrase.ends_with('…'));
        assert!(phrase.len() <= MAX_PROGRESS_CUE_BYTES);
        assert!(!phrase.contains('\n'));
    }

    #[tokio::test]
    async fn shipped_default_returns_a_decryptable_empty_interstitial() {
        const { assert!(!crate::config::DEFAULT_SPOKEN_PROGRESS_CUES) };
        assert!(!crate::config::spoken_progress_cues_enabled());
        let response = response_for(&[action_json(
            "weather_at_place",
            r#"{"location":"Hvidovre"}"#,
        )])
        .await;
        assert!(response.interstitial.is_empty());
    }

    #[tokio::test]
    async fn handler_rejects_bad_envelopes_and_action_json() {
        let wrong_kid = ActionInterstitialHandler::new()
            .encrypted_action_based_interstitial(Request::new(encrypted_request(
                proto_kids::LOADING_MESSAGE_REQUEST,
                ActionBasedInterstitialRequest::default(),
            )))
            .await
            .unwrap_err();
        assert_eq!(wrong_kid.code(), Code::InvalidArgument);

        let malformed = EncryptedActionBasedInterstitialRequest {
            request: Some(EncryptedData::new(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                vec![0x0a, 0x02, b'{'],
            )),
        };
        assert_eq!(
            ActionInterstitialHandler::new()
                .encrypted_action_based_interstitial(Request::new(malformed))
                .await
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );

        let oversized = EncryptedActionBasedInterstitialRequest {
            request: Some(EncryptedData::new(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                vec![0; MAX_REQUEST_BYTES + 1],
            )),
        };
        assert_eq!(
            ActionInterstitialHandler::new()
                .encrypted_action_based_interstitial(Request::new(oversized))
                .await
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );

        for invalid in [
            "not-json".to_owned(),
            "[]".to_owned(),
            "{}".to_owned(),
            r#"{"one":{},"two":{}}"#.to_owned(),
            r#"{"web_search":[]}"#.to_owned(),
            format!(r#"{{"{}":{{}}}}"#, "x".repeat(MAX_ACTION_NAME_BYTES + 1)),
            "x".repeat(MAX_ACTION_STRING_BYTES + 1),
        ] {
            let request = ActionBasedInterstitialRequest {
                action_strings: vec![invalid],
            };
            assert_eq!(
                ActionInterstitialHandler::new()
                    .encrypted_action_based_interstitial(Request::new(encrypted_request(
                        proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                        request,
                    )))
                    .await
                    .unwrap_err()
                    .code(),
                Code::InvalidArgument
            );
        }
    }

    #[tokio::test]
    async fn handler_rejects_too_many_actions() {
        let request = ActionBasedInterstitialRequest {
            action_strings: vec![action_json("web_search", "{}"); MAX_ACTION_STRINGS + 1],
        };
        assert_eq!(
            ActionInterstitialHandler::new()
                .encrypted_action_based_interstitial(Request::new(encrypted_request(
                    proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                    request,
                )))
                .await
                .unwrap_err()
                .code(),
            Code::InvalidArgument
        );
    }
}
