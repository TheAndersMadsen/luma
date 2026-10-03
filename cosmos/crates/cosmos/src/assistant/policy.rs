//! Deterministic policy at the model-to-device action boundary.
//!
//! Prompt text guides model behavior. It cannot be the authorization boundary.
//! This module independently checks the small set of consequential actions the
//! public catalog still exposes, and the action tools of the owner's MCP
//! servers. Confirmation is scoped to the exact generated question, so changing
//! the recipient or operation expires it automatically.

use std::collections::HashMap;

use cosmos_protocol::aibus as pb;
use serde_json::Value;

use super::catalog::{RESPOND_ACTION, RESPOND_FIELD};
use crate::services::gates::BlockingObservation;

/// Stock `KeyguardMonitor.maybeBlockAction`, applied when a call is about to
/// run rather than only when the catalog is offered.
///
/// A locked Pin is never offered a tool the catalog withholds on the keyguard,
/// but a model can still name one. Every transport asks this before running a
/// call, and a refusal replaces the call before any backend is reached. Stock
/// answers the same case with a non-final `KeyguardLockedObservation` that the
/// device turns into `InstructUnlockAction`
/// (`TaoEventRegistrar.convertAndDispatchGeneratedActionIfNeeded`).
pub fn keyguard_refusal(is_locked: bool, tool: &str) -> Option<BlockingObservation> {
    (is_locked && super::catalog::withheld_on_keyguard(tool))
        .then_some(BlockingObservation::KeyguardLocked)
}

/// `SynapseDeviceContext.is_locked` for this request: the device's own
/// `KeyguardManager.isKeyguardLocked()` when it built the request.
pub fn request_is_locked(request: &pb::SynapseUnderstandingRequest) -> bool {
    request
        .device_context
        .as_ref()
        .is_some_and(|context| context.is_locked)
}

const CONFIRMATION_REQUIRED: &[&str] = &[
    "AddIfThenEntry",
    "CallPerson",
    "ClearIfThenMap",
    "SetQuickMessagingContact",
    "TriggerBugReport",
    "TurnOnCellularRoaming",
];

/// The longest question about an MCP call that is still read out. A longer one
/// is not a short spoken question any more.
const MAX_MCP_QUESTION_CHARS: usize = 200;

/// What the model reads when it called an action that needs the wearer's
/// confirmation beside other calls in one step. The action is not run there:
/// a question ends the run, and its companions would be lost.
pub const CONFIRM_ON_ITS_OWN: &str = "Not run: this action needs the wearer's confirmation first. \
     Call it on its own, with no other tool, and Cosmos will ask the wearer.";

/// What a device function call for an MCP action tool answers. It carries no
/// conversation, so there is no reply of the wearer's that could confirm it.
pub const CONFIRMATION_NEEDS_A_CONVERSATION: &str =
    "That needs your confirmation. Ask your assistant for it by voice.";

/// Return a question when this exact action has not already received a strict,
/// immediately preceding confirmation from the wearer.
///
/// The only inputs are the wearer's own live utterance and the question that
/// ended the preceding run. Tool output, retrieved text and saved notes are
/// never read here, so none of them can confirm an action.
pub fn confirmation_question(
    request: &pb::SynapseUnderstandingRequest,
    action: &str,
    input: &str,
) -> Option<String> {
    let question = if crate::mcp::is_tool_name(action) {
        // INFERRED: an MCP tool its server does not mark read-only changes
        // something the owner connected, so it asks like Luma's own
        // consequential actions unless the owner turned asking off.
        match mcp_question(&crate::mcp::asks_first(action)?, input) {
            Ok(question) => question,
            // Never read out, so no reply of the wearer's can confirm it.
            Err(not_run) => return Some(not_run),
        }
    } else {
        question_for(action, input)?
    };
    if strict_assent(super::engine::current_utterance(request))
        && preceding_run_respond(request.device_context.as_ref()).as_deref()
            == Some(question.as_str())
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
    preceding_run_respond(request.device_context.as_ref()).as_deref() == Some(question)
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

/// The question for one call to an MCP action tool: the tool, its server, and
/// every argument in full.
///
/// A confirmation is scoped to the exact question, so the question has to say
/// the whole call. Each argument is its name and its JSON value, in name
/// order, which reads back to one set of arguments only. `Err` is the
/// statement spoken instead when the call cannot be put that way: it is too
/// long to say, an argument name is not a plain word, or speech clean-up
/// (`catalog::speakable`) would change the text, so the wearer would hear
/// something other than what is compared. Such a call is not run.
fn mcp_question(tool: &crate::mcp::OfferedTool, input: &str) -> Result<String, String> {
    let action = format!(
        "{} on {}",
        tool.tool_name.replace('_', " "),
        tool.server_name
    );
    // What `McpStore::call` sends: an object, or no arguments at all.
    let arguments = match serde_json::from_str::<Value>(input) {
        Ok(Value::Object(arguments)) => arguments,
        _ => serde_json::Map::new(),
    };
    let mut named: Vec<(&String, &Value)> = arguments.iter().collect();
    named.sort_by_key(|(name, _)| *name);
    let plain_names = named.iter().all(|(name, _)| {
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    });
    let question = if named.is_empty() {
        format!("Run {action}?")
    } else {
        let details: Vec<String> = named
            .iter()
            .map(|(name, value)| format!("{name} {value}"))
            .collect();
        format!("Run {action}, with {}?", details.join(", "))
    };
    if plain_names
        && question.chars().count() <= MAX_MCP_QUESTION_CHARS
        && super::catalog::speakable(&question) == question
    {
        Ok(question)
    } else {
        Err(format!(
            "Running {action} needs your confirmation, and this request is too long or too \
             unusual to read out exactly, so I did not run it. In Center, {} can be allowed \
             to act without asking.",
            tool.server_name
        ))
    }
}

fn first_text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.as_array()?.iter().find_map(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn strict_assent(utterance: &str) -> bool {
    // Replace inner punctuation (a transcribed "Yes, please.") with spaces and
    // collapse whitespace, so punctuation between the words does not defeat the
    // match the way end-only trimming did.
    let spaced = utterance
        .chars()
        .map(|character| {
            if character.is_ascii_punctuation() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .to_ascii_lowercase();
    let normalized = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    matches!(
        normalized.as_str(),
        "yes" | "yes please" | "confirm" | "confirmed"
    )
}

/// The question that ended the wearer's preceding completed run, if that run
/// ended by asking it.
///
/// Stock replays the live request as the newest turn and as its own run root
/// (`TaoEventRegistrar.onTranscription` dispatches it with no parent), after
/// the earlier complete runs (`EventsSnapshot.linearize`). So the "yes" is the
/// last turn, and the question it answers ended the run listed just before it:
/// walking the live run's own parent chain can never reach the question. A
/// text-only follow-up that replays no live root instead ends in the preceding
/// run itself. Either way the question counts only when nothing else was
/// dispatched after it in that run.
fn preceding_run_end(context: &pb::SynapseDeviceContext) -> Option<&pb::SynapseChatTurn> {
    let turns = &context.turns;
    let by_id: HashMap<&str, &pb::SynapseChatTurn> = turns
        .iter()
        .map(|turn| (turn.identifier.as_str(), turn))
        .collect();
    let parent_of = |turn: &pb::SynapseChatTurn| {
        (!turn.parent_identifier.is_empty())
            .then(|| by_id.get(turn.parent_identifier.as_str()).copied())
            .flatten()
    };
    let newest = turns.last()?;
    Some(if closes_a_run(newest) {
        newest
    } else {
        // Walk the live run up to its root. The turn listed just before that
        // root ends the preceding completed run.
        let mut root = newest;
        for _ in 0..turns.len() {
            match parent_of(root) {
                Some(parent) => root = parent,
                None => break,
            }
        }
        let position = turns.iter().position(|turn| std::ptr::eq(turn, root))?;
        turns[..position].last()?
    })
}

/// Stock TaoEventRegistrar.onTranscription makes a new live root while
/// EventsSnapshot.linearize includes previous runs. INFERRED routing scope:
/// an older retained task must not steal a newer local conversation. Inspect
/// typed server-tool actions, never permission/question text. A pure local
/// acknowledgment of owner input inherits the preceding typed OS3 run. Stock
/// RespondActionHandler records that acknowledgment as a new Respond-only run.
/// INFERRED: only the exact OwnerInput grammar is transparent, not arbitrary
/// replies or other local actions.
pub(crate) fn preceding_run_contains_tool(
    context: Option<&pb::SynapseDeviceContext>,
    tool: &str,
) -> Option<bool> {
    let context = context?;
    let mut cursor = Some(preceding_run_end(context)?);
    let by_id: HashMap<&str, &pb::SynapseChatTurn> = context
        .turns
        .iter()
        .map(|turn| (turn.identifier.as_str(), turn))
        .collect();
    let mut respond_only = true;
    let mut saw_respond = false;
    for _ in 0..context.turns.len() {
        let Some(turn) = cursor else {
            return Some(false);
        };
        match turn.content.as_ref() {
            Some(pb::synapse_chat_turn::Content::Action(action))
                if action.action == tool && action.source == pb::SynapseSource::Server as i32 =>
            {
                return Some(true);
            }
            Some(pb::synapse_chat_turn::Content::Action(action)) => {
                saw_respond |= action.action == RESPOND_ACTION;
                respond_only &= action.action == RESPOND_ACTION;
            }
            Some(pb::synapse_chat_turn::Content::UserRequest(request)) => {
                if !respond_only
                    || !saw_respond
                    || !turn.parent_identifier.is_empty()
                    || super::llm::contextual_os3_follow_up(&request.request)
                        != Some(super::llm::Os3FollowUp::OwnerInput)
                {
                    return Some(false);
                }
                let position = context
                    .turns
                    .iter()
                    .position(|candidate| std::ptr::eq(candidate, turn))?;
                cursor = context.turns[..position]
                    .last()
                    .filter(|previous| closes_a_run(previous));
                respond_only = true;
                saw_respond = false;
                continue;
            }
            _ => {}
        }
        cursor = (!turn.parent_identifier.is_empty())
            .then(|| by_id.get(turn.parent_identifier.as_str()).copied())
            .flatten();
    }
    Some(false)
}

fn preceding_run_respond(context: Option<&pb::SynapseDeviceContext>) -> Option<String> {
    let context = context?;
    let turns = &context.turns;
    let by_id: HashMap<&str, &pb::SynapseChatTurn> = turns
        .iter()
        .map(|turn| (turn.identifier.as_str(), turn))
        .collect();
    let mut cursor = Some(preceding_run_end(context)?);
    for _ in 0..turns.len() {
        let turn = cursor?;
        match turn.content.as_ref() {
            Some(pb::synapse_chat_turn::Content::Action(action))
                if action.action == RESPOND_ACTION =>
            {
                let value = serde_json::from_str::<Value>(&action.input).ok()?;
                return value.get(RESPOND_FIELD)?.as_str().map(str::to_owned);
            }
            // Something else ran after the question, or the run never asked.
            Some(pb::synapse_chat_turn::Content::Action(_))
            | Some(pb::synapse_chat_turn::Content::UserRequest(_)) => return None,
            _ => {}
        }
        cursor = (!turn.parent_identifier.is_empty())
            .then(|| by_id.get(turn.parent_identifier.as_str()).copied())
            .flatten();
    }
    None
}

/// Whether a replayed turn closes a completed run: its terminal `Respond`, an
/// `End`, or the final observation the device records after either.
fn closes_a_run(turn: &pb::SynapseChatTurn) -> bool {
    match turn.content.as_ref() {
        Some(pb::synapse_chat_turn::Content::Action(action)) => action.action == RESPOND_ACTION,
        Some(pb::synapse_chat_turn::Content::End(_)) => true,
        Some(pb::synapse_chat_turn::Content::Observation(observation)) => observation.is_final,
        _ => false,
    }
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

    fn turn(
        identifier: &str,
        parent: &str,
        content: pb::synapse_chat_turn::Content,
    ) -> pb::SynapseChatTurn {
        pb::SynapseChatTurn {
            identifier: identifier.to_owned(),
            parent_identifier: parent.to_owned(),
            content: Some(content),
            ..Default::default()
        }
    }

    fn wearer(identifier: &str, text: &str) -> pb::SynapseChatTurn {
        turn(
            identifier,
            "",
            pb::synapse_chat_turn::Content::UserRequest(pb::SynapseUserRequestContent {
                request: text.to_owned(),
                ..Default::default()
            }),
        )
    }

    fn action(identifier: &str, parent: &str, name: &str, input: &str) -> pb::SynapseChatTurn {
        turn(
            identifier,
            parent,
            pb::synapse_chat_turn::Content::Action(pb::SynapseActionContent {
                action: name.to_owned(),
                input: input.to_owned(),
                ..Default::default()
            }),
        )
    }

    fn asked(identifier: &str, parent: &str, question: &str) -> pb::SynapseChatTurn {
        action(
            identifier,
            parent,
            RESPOND_ACTION,
            &serde_json::json!({RESPOND_FIELD: question}).to_string(),
        )
    }

    fn final_observation(identifier: &str, parent: &str) -> pb::SynapseChatTurn {
        turn(
            identifier,
            parent,
            pb::synapse_chat_turn::Content::Observation(pb::SynapseObservationContent {
                is_final: true,
                action_name: RESPOND_ACTION.to_owned(),
                ..Default::default()
            }),
        )
    }

    /// What a stock Pin sends: the earlier complete runs, each closed by its
    /// final observation (`EventsSnapshot.linearize`), then the live request as
    /// the newest turn and its own run root (`TaoEventRegistrar.onTranscription`
    /// dispatches it with no parent). The top-level utterance stays empty.
    fn stock_replay(
        mut earlier: Vec<pb::SynapseChatTurn>,
        live: &str,
    ) -> pb::SynapseUnderstandingRequest {
        earlier.push(wearer("live", live));
        pb::SynapseUnderstandingRequest {
            device_context: Some(pb::SynapseDeviceContext {
                turns: earlier,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn asked_to_call_dana() -> Vec<pb::SynapseChatTurn> {
        vec![
            wearer("u1", "call Dana"),
            asked("r1", "u1", "Call Dana?"),
            final_observation("o1", "r1"),
        ]
    }

    /// "Call Dana?" then "Yes" on a real Pin. The live "yes" is its own run
    /// root, so the question it answers is the one that ended the preceding
    /// run. Before, the walk stopped at the "yes" and every assent was met with
    /// the same question again, forever.
    #[test]
    fn a_stock_replayed_yes_confirms_the_preceding_runs_question() {
        let dana = r#"{"To":["Dana"]}"#;
        assert_eq!(
            confirmation_question(
                &stock_replay(asked_to_call_dana(), "Yes."),
                "CallPerson",
                dana
            ),
            None
        );
        assert!(question_was_already_asked(
            &stock_replay(asked_to_call_dana(), "Dana"),
            "Call Dana?"
        ));
        // Still exact: an ambiguous assent or a changed target asks again.
        assert_eq!(
            confirmation_question(
                &stock_replay(asked_to_call_dana(), "go ahead"),
                "CallPerson",
                dana
            ),
            Some("Call Dana?".to_owned())
        );
        assert_eq!(
            confirmation_question(
                &stock_replay(asked_to_call_dana(), "yes"),
                "CallPerson",
                r#"{"To":["Alex"]}"#
            ),
            Some("Call Alex?".to_owned())
        );
        // A later run in between: the "yes" no longer answers that question.
        let mut later = asked_to_call_dana();
        later.extend([
            wearer("u2", "what time is it"),
            asked("r2", "u2", "It is three o'clock."),
            final_observation("o2", "r2"),
        ]);
        assert_eq!(
            confirmation_question(&stock_replay(later, "yes"), "CallPerson", dana),
            Some("Call Dana?".to_owned())
        );
        // Something else dispatched after the question in that run.
        let mut after = asked_to_call_dana();
        after.push(action("a1", "o1", "SetTimer", "{}"));
        after.push(final_observation("o3", "a1"));
        assert_eq!(
            confirmation_question(&stock_replay(after, "yes"), "CallPerson", dana),
            Some("Call Dana?".to_owned())
        );
        // No earlier run at all.
        assert_eq!(
            confirmation_question(&stock_replay(Vec::new(), "yes"), "CallPerson", dana),
            Some("Call Dana?".to_owned())
        );
    }

    /// Only a locked request is refused, and only for a tool the catalog
    /// withholds on the keyguard. The refusal is stock's keyguard verdict.
    #[test]
    fn keyguard_refusal_follows_the_catalogs_keyguard_flags() {
        use crate::assistant::catalog::{FORGET_NOTE_TOOL, OS3_TOOL, UPDATE_NOTE_TOOL};
        for withheld in [
            OS3_TOOL,
            UPDATE_NOTE_TOOL,
            FORGET_NOTE_TOOL,
            "recall_memory",
            "recall_history",
            "CreateContact",
        ] {
            assert_eq!(
                keyguard_refusal(true, withheld),
                Some(BlockingObservation::KeyguardLocked),
                "{withheld}"
            );
            assert_eq!(keyguard_refusal(false, withheld), None, "{withheld}");
        }
        // CallPerson and ComposeMessage run too: the Pin's own KeyguardMonitor
        // lets an emergency number through and refuses the rest.
        for allowed in [
            "remember",
            "SetTimer",
            RESPOND_ACTION,
            "CallPerson",
            "ComposeMessage",
        ] {
            assert_eq!(keyguard_refusal(true, allowed), None, "{allowed}");
        }
        // A name the catalog does not define is not a keyguard question: the
        // transports bounce it as unrecognized.
        assert_eq!(keyguard_refusal(true, "made_up_tool"), None);
        assert_eq!(
            BlockingObservation::KeyguardLocked.synthesized_action(),
            "InstructUnlock"
        );
        // `KeyguardMonitor.maybeBlockAction`'s own observation, verbatim.
        assert_eq!(
            BlockingObservation::KeyguardLocked.observation_text(),
            "Device is locked, cannot perform Action."
        );
    }

    #[test]
    fn request_lock_state_comes_from_the_device_context() {
        let mut locked = request("x", None);
        assert!(!request_is_locked(&locked));
        locked.device_context.as_mut().unwrap().is_locked = true;
        assert!(request_is_locked(&locked));
        assert!(!request_is_locked(
            &pb::SynapseUnderstandingRequest::default()
        ));
    }

    #[test]
    fn reversible_controls_do_not_gain_confirmation_friction() {
        assert_eq!(
            confirmation_question(&request("pause", None), "PauseMusic", "{}"),
            None
        );
    }
}
