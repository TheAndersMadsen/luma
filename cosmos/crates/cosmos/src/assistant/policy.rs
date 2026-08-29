//! Deterministic policy at the model-to-device action boundary.
//!
//! Prompt text guides model behavior; it cannot be the authorization boundary.
//! This module independently checks the small set of consequential actions the
//! public catalog still exposes. Confirmation is scoped to the exact generated
//! question, so changing the recipient or operation expires it automatically.

use std::collections::HashMap;

use cosmos_protocol::aibus as pb;
use serde_json::Value;

use super::catalog::{RESPOND_ACTION, RESPOND_FIELD};

const CONFIRMATION_REQUIRED: &[&str] = &[
    "AddIfThenEntry",
    "CallPerson",
    "ClearIfThenMap",
    "SetQuickMessagingContact",
    "TriggerBugReport",
    "TurnOnCellularRoaming",
];

/// Return a question when this exact action has not already received a strict,
/// immediately preceding confirmation from the wearer.
pub fn confirmation_question(
    request: &pb::SynapseUnderstandingRequest,
    action: &str,
    input: &str,
) -> Option<String> {
    let question = question_for(action, input)?;
    if strict_assent(super::engine::current_utterance(request))
        && latest_respond(request.device_context.as_ref()).as_deref() == Some(question.as_str())
    {
        None
    } else {
        Some(question)
    }
}

/// Whether this clarification was already the preceding assistant response.
/// A second turn that still lacks the requested value should fail briefly
/// rather than trapping the wearer in the same question forever.
pub fn question_was_already_asked(
    request: &pb::SynapseUnderstandingRequest,
    question: &str,
) -> bool {
    latest_respond(request.device_context.as_ref()).as_deref() == Some(question)
}

fn question_for(action: &str, input: &str) -> Option<String> {
    if !CONFIRMATION_REQUIRED.contains(&action) {
        return None;
    }
    let value = serde_json::from_str::<Value>(input).unwrap_or(Value::Null);
    let question = match action {
        "CallPerson" => value
            .get("To")
            .and_then(first_text)
            .map(|target| format!("Call {target}?"))
            .unwrap_or_else(|| "Place this call?".to_owned()),
        "AddIfThenEntry" => "Create this automation?".to_owned(),
        "ClearIfThenMap" => "Remove all of your if-then automations?".to_owned(),
        "SetQuickMessagingContact" => "Change your quick messaging contacts?".to_owned(),
        "TriggerBugReport" => "Send a bug report from this Pin?".to_owned(),
        "TurnOnCellularRoaming" => {
            "Turn on cellular roaming? This may cause carrier charges.".to_owned()
        }
        _ => return None,
    };
    Some(question)
}

fn first_text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.as_array()?.iter().find_map(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn strict_assent(utterance: &str) -> bool {
    let normalized = utterance
        .trim()
        .trim_matches(|character: char| character.is_ascii_punctuation())
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "yes" | "yes please" | "confirm" | "confirmed"
    )
}

fn latest_respond(context: Option<&pb::SynapseDeviceContext>) -> Option<String> {
    let turns = &context?.turns;
    let by_id: HashMap<&str, &pb::SynapseChatTurn> = turns
        .iter()
        .map(|turn| (turn.identifier.as_str(), turn))
        .collect();
    let mut cursor = turns.last();
    for _ in 0..turns.len() {
        let turn = cursor?;
        if let Some(pb::synapse_chat_turn::Content::Action(action)) = turn.content.as_ref()
            && action.action == RESPOND_ACTION
        {
            let value = serde_json::from_str::<Value>(&action.input).ok()?;
            return value.get(RESPOND_FIELD)?.as_str().map(str::to_owned);
        }
        if turn.parent_identifier.is_empty() {
            break;
        }
        cursor = by_id.get(turn.parent_identifier.as_str()).copied();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(utterance: &str, prior_response: Option<&str>) -> pb::SynapseUnderstandingRequest {
        let turns = prior_response
            .map(|response| {
                vec![pb::SynapseChatTurn {
                    identifier: "confirm".to_owned(),
                    content: Some(pb::synapse_chat_turn::Content::Action(
                        pb::SynapseActionContent {
                            action: RESPOND_ACTION.to_owned(),
                            input: serde_json::json!({RESPOND_FIELD: response}).to_string(),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }]
            })
            .unwrap_or_default();
        pb::SynapseUnderstandingRequest {
            utterance: utterance.to_owned(),
            device_context: Some(pb::SynapseDeviceContext {
                turns,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn consequence_requires_one_scoped_confirmation() {
        let input = r#"{"To":["Dana"]}"#;
        assert_eq!(
            confirmation_question(&request("call Dana", None), "CallPerson", input),
            Some("Call Dana?".to_owned())
        );
        assert_eq!(
            confirmation_question(&request("yes", Some("Call Dana?")), "CallPerson", input),
            None
        );
    }

    #[test]
    fn ambiguous_assent_or_changed_arguments_never_authorize_an_action() {
        assert_eq!(
            confirmation_question(
                &request("go ahead", Some("Call Dana?")),
                "CallPerson",
                r#"{"To":["Dana"]}"#
            ),
            Some("Call Dana?".to_owned())
        );
        assert_eq!(
            confirmation_question(
                &request("yes", Some("Call Dana?")),
                "CallPerson",
                r#"{"To":["Alex"]}"#
            ),
            Some("Call Alex?".to_owned())
        );
    }

    #[test]
    fn reversible_controls_do_not_gain_confirmation_friction() {
        assert_eq!(
            confirmation_question(&request("pause", None), "PauseMusic", "{}"),
            None
        );
    }
}
