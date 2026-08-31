use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::proto::aibus::{
    synapse_chat_turn, SynapseActionContent, SynapseChatTurn, SynapseDeviceContext,
    SynapseObservationContent, SynapseSource, SynapseUnderstandingRequest, SynapseUser,
};
use crate::synapse::capabilities::communications::has_mixed_communication_action_residue;
use crate::synapse::conversation::{canonical_current_turn_matches, selected_user_request_text};
use crate::tier_a::native_actions::{
    CANCEL_SEND_MESSAGE, COMPOSE_MESSAGE, CONFIRM_SEND_MESSAGE, UNDERSTAND_SCENE,
};
#[cfg(test)]
use crate::tier_a::native_actions::{GET_CURRENT_LOCATION, RESPOND};

const MAX_RECIPIENTS: usize = 8;
const MAX_RECIPIENT_BYTES: usize = 256;
const MAX_MESSAGE_BYTES: usize = 4_000;
const MAX_PENDING_TURNS: usize = 12;
const MAX_PENDING_AGE_SECONDS: i64 = 10 * 60;
const MAX_TURN_IDENTIFIER_BYTES: usize = 256;

#[derive(Debug, PartialEq, Eq)]
pub struct PlannedMessageAction {
    pub action_name: &'static str,
    pub thought: &'static str,
    pub input_json: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
struct ComposeMessageInput {
    #[serde(default, rename = "To")]
    to: Vec<String>,
    #[serde(default, rename = "Message")]
    message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// The `Awaiting` prefix names the state the compose flow is blocked on; it is
// meaningful state-machine naming, not redundant repetition of the type.
#[allow(clippy::enum_variant_names)]
enum PendingComposeState {
    AwaitingRecipient,
    AwaitingMessage,
    AwaitingConfirmation,
}

#[derive(Debug)]
struct PendingCompose<'a> {
    index: usize,
    turn: &'a SynapseChatTurn,
    input: ComposeMessageInput,
    state: PendingComposeState,
}

/// Recognize the small, safety-sensitive stock messaging state machine.
///
/// Composing only creates the stock `ComposeMessage` action. It deliberately
/// omits the device-only `EnableAutoSend` field, so the Messages experience
/// retains its normal confirmation step. Sending or cancelling is only
/// available when the request contains an explicit confirmation/cancellation
/// and its device context still contains a recent, unresolved compose action.
pub fn plan_message_action(request: &SynapseUnderstandingRequest) -> Option<PlannedMessageAction> {
    let pending = request
        .device_context
        .as_ref()
        .and_then(|context| find_pending_compose(context, &request.utterance));

    if let Some((pending, authoritative_utterance)) = pending {
        // Confirmation and cancellation must be considered before interpreting
        // an arbitrary utterance as the missing draft body or recipient.
        if let Some(intent) = confirmation_intent(authoritative_utterance) {
            return match intent {
                ConfirmationIntent::Confirm
                    if !action_is_excluded(request, CONFIRM_SEND_MESSAGE)
                        && confirmation_is_allowed(request, &pending.input) =>
                {
                    Some(PlannedMessageAction {
                        action_name: CONFIRM_SEND_MESSAGE,
                        thought: "The user explicitly confirmed the pending message",
                        input_json: "{}".to_string(),
                    })
                }
                ConfirmationIntent::Cancel
                    if !action_is_excluded(request, CANCEL_SEND_MESSAGE)
                        && cancellation_is_allowed(request) =>
                {
                    Some(PlannedMessageAction {
                        action_name: CANCEL_SEND_MESSAGE,
                        thought: "The user explicitly cancelled the pending message",
                        input_json: "{}".to_string(),
                    })
                }
                // Never reinterpret a blocked confirmation/cancellation as
                // message text or a contact name.
                _ => None,
            };
        }

        if edit_intent(authoritative_utterance) {
            if pending.input.to.is_empty() {
                return None;
            }
            return planned_compose(
                request,
                ComposeMessageInput {
                    to: pending.input.to,
                    message: String::new(),
                },
                "The user asked to edit the pending draft in the stock composer",
            );
        }

        // A complete or partial explicit compose command starts a fresh stock
        // draft even if an older draft is still represented in context.
        if let Some(input) = parse_compose_request(authoritative_utterance) {
            return planned_compose(
                request,
                input,
                "I should open the stock message composer for confirmation",
            );
        }

        return match pending.state {
            PendingComposeState::AwaitingMessage => {
                let message = parse_message_follow_up(authoritative_utterance)?;
                planned_compose(
                    request,
                    ComposeMessageInput {
                        to: pending.input.to,
                        message,
                    },
                    "The user supplied the message contents requested by the stock composer",
                )
            }
            PendingComposeState::AwaitingRecipient => {
                let recipients = parse_recipient_follow_up(authoritative_utterance)?;
                planned_compose(
                    request,
                    ComposeMessageInput {
                        to: recipients,
                        message: pending.input.message,
                    },
                    "The user supplied the recipients requested by the stock composer",
                )
            }
            PendingComposeState::AwaitingConfirmation => None,
        };
    }

    let input = parse_compose_request(&request.utterance)?;
    planned_compose(
        request,
        input,
        "I should open the stock message composer for confirmation",
    )
}

fn planned_compose(
    request: &SynapseUnderstandingRequest,
    input: ComposeMessageInput,
    thought: &'static str,
) -> Option<PlannedMessageAction> {
    if action_is_excluded(request, COMPOSE_MESSAGE) || !compose_is_allowed(request, &input) {
        return None;
    }

    Some(PlannedMessageAction {
        action_name: COMPOSE_MESSAGE,
        thought,
        input_json: serde_json::to_string(&input).ok()?,
    })
}

fn compose_is_allowed(request: &SynapseUnderstandingRequest, input: &ComposeMessageInput) -> bool {
    match request.device_context.as_ref() {
        Some(context) if !context.is_locked => true,
        Some(_) => is_complete_emergency_message(input),
        None => false,
    }
}

fn confirmation_is_allowed(
    request: &SynapseUnderstandingRequest,
    input: &ComposeMessageInput,
) -> bool {
    match request.device_context.as_ref() {
        Some(context) if !context.is_locked => true,
        Some(_) => is_complete_emergency_message(input),
        None => false,
    }
}

fn cancellation_is_allowed(request: &SynapseUnderstandingRequest) -> bool {
    request
        .device_context
        .as_ref()
        .is_some_and(|context| !context.is_locked)
}

fn is_complete_emergency_message(input: &ComposeMessageInput) -> bool {
    input.to.len() == 1 && input.to[0].trim() == "911" && !input.message.is_empty()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TrustedRequestChain<'a> {
    authorizing_user_id: &'a str,
    response_parent_id: &'a str,
}

fn valid_turn_identifier(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier.len() <= MAX_TURN_IDENTIFIER_BYTES
        && identifier.trim() == identifier
        && !identifier.chars().any(char::is_control)
}

/// Validate the current stock request independently from any older contextual
/// runs. The current user turn remains the authorization root, while each
/// resumed server action must hang from the most recent verified device
/// observation. Keeping those identities separate lets a multi-step stock
/// interaction continue without allowing an observation to become user
/// authority.
fn trusted_request_chain(request: &SynapseUnderstandingRequest) -> Option<TrustedRequestChain<'_>> {
    let context = request.device_context.as_ref()?;
    let current_user_index = context.turns.iter().rposition(|turn| {
        matches!(
            turn.content.as_ref(),
            Some(synapse_chat_turn::Content::UserRequest(_))
        )
    })?;
    let current_user = &context.turns[current_user_index];
    if !trusted_user_request_turn(current_user, Some(&request.utterance))
        || !valid_turn_identifier(&current_user.identifier)
    {
        return None;
    }

    // A duplicated current identifier or a descendant that reuses any older
    // identifier makes parent resolution ambiguous. Empty legacy identifiers
    // in unrelated completed history are ignored; none are accepted in the
    // current verified chain.
    if context.turns.iter().enumerate().any(|(index, turn)| {
        index != current_user_index && turn.identifier == current_user.identifier
    }) {
        return None;
    }
    let mut seen_identifiers = context.turns[..=current_user_index]
        .iter()
        .filter_map(|turn| {
            valid_turn_identifier(&turn.identifier).then_some(turn.identifier.as_str())
        })
        .collect::<HashSet<_>>();

    let mut response_parent_id = current_user.identifier.as_str();
    let mut pending_action_name: Option<&str> = None;
    for turn in &context.turns[current_user_index + 1..] {
        if !valid_turn_identifier(&turn.identifier)
            || !seen_identifiers.insert(turn.identifier.as_str())
        {
            return None;
        }

        match (&turn.content, pending_action_name) {
            (Some(synapse_chat_turn::Content::Action(action)), None)
                if turn.user == SynapseUser::Assistant as i32
                    && turn.parent_identifier == response_parent_id
                    && !action.action.trim().is_empty()
                    && action.source == SynapseSource::Server as i32
                    && action.device_payload.is_empty() =>
            {
                pending_action_name = Some(action.action.as_str());
            }
            (Some(synapse_chat_turn::Content::Observation(observation)), Some(action_name))
                if turn.user == SynapseUser::Assistant as i32
                    && turn.parent_identifier == response_parent_id
                    && observation.source == SynapseSource::Device as i32
                    && !observation.is_final
                    && (observation.action_name.is_empty()
                        || observation.action_name == action_name) =>
            {
                pending_action_name = None;
            }
            _ => return None,
        }
        response_parent_id = turn.identifier.as_str();
    }

    // An action without its device observation is not a request for another
    // server turn. Only the initial user root or a complete action/observation
    // pair can authorize resumed planning.
    if pending_action_name.is_some() {
        return None;
    }

    Some(TrustedRequestChain {
        authorizing_user_id: current_user.identifier.as_str(),
        response_parent_id,
    })
}

/// Return the user-controlled authorization root only when the current
/// parent-linked action/observation chain is fully trusted.
pub fn trusted_authorizing_user_id(request: &SynapseUnderstandingRequest) -> Option<&str> {
    trusted_request_chain(request).map(|chain| chain.authorizing_user_id)
}

/// Stock chat turns form a parent-linked event chain. Parent a new action to
/// the latest verified descendant, while authorization remains attached to the
/// current trusted user turn returned by [`trusted_authorizing_user_id`].
pub fn response_parent_id<'a>(
    request: &'a SynapseUnderstandingRequest,
    transport_run_id: &'a str,
) -> &'a str {
    trusted_request_chain(request)
        .map(|chain| chain.response_parent_id)
        .unwrap_or(transport_run_id)
}

fn action_is_excluded(request: &SynapseUnderstandingRequest, action_name: &str) -> bool {
    request
        .excluded_tools
        .iter()
        .any(|excluded| excluded.eq_ignore_ascii_case(action_name))
}

fn parse_compose_request(utterance: &str) -> Option<ComposeMessageInput> {
    let utterance = strip_polite_prefix(utterance.trim());

    // The stock handler safely accepts an entirely empty draft and responds by
    // asking for recipients. Keep this deliberately narrow so generic mentions
    // of messages do not enter the compose interaction.
    if normalize_confirmation(utterance) == "send a message" {
        return Some(ComposeMessageInput::default());
    }

    let command_prefixes = [
        "send a text message to ",
        "send a message to ",
        "send a text to ",
        "send text to ",
        "send message to ",
        "text message to ",
        "message ",
        "text ",
    ];

    let remainder = command_prefixes
        .iter()
        .find_map(|prefix| strip_prefix_ascii_case(utterance, prefix))?;

    if let Some((recipients, message)) = split_recipient_and_message(remainder) {
        let recipients = parse_recipients(recipients)?;
        let message = parse_message_follow_up(message)?;
        return Some(ComposeMessageInput {
            to: recipients,
            message,
        });
    }

    let normalized_remainder = remainder.trim().to_ascii_lowercase();
    if [
        " with the message",
        " with message",
        " that says",
        " saying",
        " and say",
        " say",
    ]
    .iter()
    .any(|delimiter| normalized_remainder.ends_with(delimiter))
    {
        return None;
    }

    // Recipient-only ComposeMessage is a real stock transition: the handler
    // creates the draft, resolves the recipient, and asks for message contents.
    let recipients = parse_recipients(remainder)?;
    Some(ComposeMessageInput {
        to: recipients,
        message: String::new(),
    })
}

fn parse_message_follow_up(value: &str) -> Option<String> {
    let message = trim_wrapping_quotes(value.trim()).trim().to_string();
    if message.is_empty()
        || message.len() > MAX_MESSAGE_BYTES
        || message.chars().any(|character| character == '\0')
    {
        return None;
    }
    Some(message)
}

fn parse_recipient_follow_up(value: &str) -> Option<Vec<String>> {
    let value = strip_prefix_ascii_case(value.trim(), "to ").unwrap_or(value.trim());
    parse_recipients(value)
}

fn strip_polite_prefix(mut utterance: &str) -> &str {
    const PREFIXES: &[&str] = &[
        "please ",
        "can you please ",
        "can you ",
        "could you please ",
        "could you ",
        "would you please ",
        "would you ",
    ];

    if let Some(remainder) = PREFIXES
        .iter()
        .find_map(|prefix| strip_prefix_ascii_case(utterance, prefix))
    {
        utterance = remainder.trim_start();
    }
    utterance
}

fn strip_prefix_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let candidate = value.get(..prefix.len())?;
    candidate
        .eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

fn split_recipient_and_message(value: &str) -> Option<(&str, &str)> {
    const DELIMITERS: &[&str] = &[
        " with the message ",
        " with message ",
        " that says ",
        " saying ",
        " and say ",
        " say ",
    ];

    for delimiter in DELIMITERS {
        if let Some(index) = find_ascii_case_insensitive(value, delimiter) {
            return Some((&value[..index], &value[index + delimiter.len()..]));
        }
    }

    value
        .find(':')
        .map(|index| (&value[..index], &value[index + 1..]))
}

fn find_ascii_case_insensitive(value: &str, needle: &str) -> Option<usize> {
    value
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn parse_recipients(value: &str) -> Option<Vec<String>> {
    let value = trim_wrapping_quotes(value.trim()).trim();
    if value.is_empty() {
        return None;
    }

    let parts = if value.contains(',') {
        value.split(',').collect::<Vec<_>>()
    } else if let Some(index) = find_ascii_case_insensitive(value, " and ") {
        vec![&value[..index], &value[index + " and ".len()..]]
    } else {
        vec![value]
    };

    if parts.is_empty() || parts.len() > MAX_RECIPIENTS {
        return None;
    }

    let recipients = parts
        .into_iter()
        .map(|part| {
            let part = part.trim().trim_end_matches(['.', '!']).trim_end();
            trim_wrapping_quotes(part).trim().to_string()
        })
        .collect::<Vec<_>>();

    if recipients.iter().any(|recipient| {
        recipient.is_empty()
            || recipient.len() > MAX_RECIPIENT_BYTES
            || recipient.chars().any(char::is_control)
            || has_mixed_communication_action_residue(recipient)
    }) {
        return None;
    }

    Some(recipients)
}

fn trim_wrapping_quotes(value: &str) -> &str {
    let value = value.trim();
    for (open, close) in [('"', '"'), ('\'', '\''), ('\u{201c}', '\u{201d}')] {
        if value.starts_with(open)
            && value.ends_with(close)
            && value.len() >= open.len_utf8() + close.len_utf8()
        {
            return &value[open.len_utf8()..value.len() - close.len_utf8()];
        }
    }
    value
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConfirmationIntent {
    Confirm,
    Cancel,
}

fn confirmation_intent(utterance: &str) -> Option<ConfirmationIntent> {
    if utterance
        .chars()
        .any(|character| matches!(character, '?' | '\u{00bf}' | '\u{061f}' | '\u{ff1f}'))
    {
        return None;
    }
    let normalized = normalize_confirmation(utterance);
    match normalized.as_str() {
        "yes" | "yes please" | "yes send it" | "send" | "send it" | "send it now" | "confirm"
        | "confirm send" | "confirm sending" | "go ahead" | "do it" | "ok" | "okay" => {
            Some(ConfirmationIntent::Confirm)
        }
        "no" | "no do not send it" | "no don't send it" | "cancel" | "cancel it"
        | "do not send" | "do not send it" | "don't send" | "don't send it" | "never mind"
        | "nevermind" | "stop" => Some(ConfirmationIntent::Cancel),
        _ => None,
    }
}

fn edit_intent(utterance: &str) -> bool {
    matches!(
        normalize_confirmation(utterance).as_str(),
        "edit"
            | "edit it"
            | "edit message"
            | "edit the message"
            | "change it"
            | "change the message"
            | "re-dictate"
            | "redictate"
            | "re dictate"
            | "dictate it again"
            | "let me edit it"
            | "let me say it again"
    )
}

fn normalize_confirmation(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace('\u{2019}', "'")
        .chars()
        .map(|character| match character {
            ',' | '.' | '!' | '?' => ' ',
            other => other,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn find_pending_compose<'a>(
    context: &'a SynapseDeviceContext,
    current_utterance: &str,
) -> Option<(PendingCompose<'a>, &'a str)> {
    let current_turn = context.turns.last()?;
    let synapse_chat_turn::Content::UserRequest(current_request) = current_turn.content.as_ref()?
    else {
        return None;
    };
    if !trusted_user_request_turn(current_turn, Some(current_utterance))
        || !valid_turn_identifier(&current_turn.identifier)
        || context.turns[..context.turns.len() - 1]
            .iter()
            .any(|turn| turn.identifier == current_turn.identifier)
    {
        return None;
    }
    let authoritative_utterance = selected_user_request_text(current_request);

    let mut pending: Option<PendingCompose<'_>> = None;
    let mut pending_tail_identifier: Option<&str> = None;

    for (index, turn) in context
        .turns
        .iter()
        .take(context.turns.len().saturating_sub(1))
        .enumerate()
    {
        match &turn.content {
            Some(synapse_chat_turn::Content::Action(action)) => match action.action.as_str() {
                COMPOSE_MESSAGE => {
                    let parent_is_trusted_compose_origin =
                        trusted_compose_origin(context, index, turn);
                    if trusted_server_action_turn(turn, action, COMPOSE_MESSAGE)
                        && parent_is_trusted_compose_origin
                    {
                        pending = prior_compose_input(&action.input).map(|input| PendingCompose {
                            index,
                            turn,
                            state: state_for_input(&input),
                            input,
                        });
                        pending_tail_identifier =
                            pending.as_ref().map(|_| turn.identifier.as_str());
                    } else {
                        pending = None;
                        pending_tail_identifier = None;
                    }
                }
                CONFIRM_SEND_MESSAGE | CANCEL_SEND_MESSAGE => {
                    // Any attempted terminal transition closes the local pending
                    // state. A well-formed one must also be linked to the exact
                    // compose tail, but malformed history must never make a later
                    // duplicate send easier.
                    pending = None;
                    pending_tail_identifier = None;
                }
                _ => {}
            },
            Some(synapse_chat_turn::Content::Observation(observation)) => {
                if let Some(compose) = pending.as_mut() {
                    let belongs_to_compose = pending_tail_identifier
                        .is_some_and(|identifier| turn.parent_identifier == identifier)
                        && trusted_device_observation_turn(turn, observation)
                        && (observation.action_name.is_empty()
                            || observation.action_name == COMPOSE_MESSAGE);
                    if belongs_to_compose {
                        if let Some(state) = observation_compose_state(&observation.observation) {
                            compose.state = state;
                            pending_tail_identifier = Some(turn.identifier.as_str());
                        } else if observation.is_final {
                            pending = None;
                            pending_tail_identifier = None;
                        } else {
                            pending_tail_identifier = Some(turn.identifier.as_str());
                        }
                    } else if observation
                        .action_name
                        .eq_ignore_ascii_case(COMPOSE_MESSAGE)
                    {
                        pending = None;
                        pending_tail_identifier = None;
                    }
                }
            }
            _ => {}
        }
    }

    let pending = pending?;
    let pending_tail_identifier = pending_tail_identifier?;
    if current_turn.parent_identifier != pending_tail_identifier {
        return None;
    }

    if context.turns.len().saturating_sub(pending.index) > MAX_PENDING_TURNS {
        return None;
    }

    pending_timestamp_is_recent(context, pending.turn).then_some((pending, authoritative_utterance))
}

/// A stock compose action normally hangs directly from the user request that
/// created it. Vision automation adds one narrowly trusted alternative:
///
/// user request -> server UnderstandScene -> device observation -> ComposeMessage
///
/// Require the vision prefix to be the immediately preceding, fully linked
/// chain. This keeps a stale, unrelated, or merely source-labelled observation
/// from granting a later confirmation permission to send a message.
fn trusted_compose_origin(
    context: &SynapseDeviceContext,
    compose_index: usize,
    compose_turn: &SynapseChatTurn,
) -> bool {
    if context.turns[..compose_index]
        .iter()
        .rev()
        .find(|candidate| candidate.identifier == compose_turn.parent_identifier)
        .is_some_and(|candidate| trusted_user_request_turn(candidate, None))
    {
        return true;
    }

    let [.., user_turn, vision_action_turn, vision_observation_turn] =
        &context.turns[..compose_index]
    else {
        return false;
    };
    let Some(synapse_chat_turn::Content::Action(vision_action)) = &vision_action_turn.content
    else {
        return false;
    };
    let Some(synapse_chat_turn::Content::Observation(vision_observation)) =
        &vision_observation_turn.content
    else {
        return false;
    };

    trusted_user_request_turn(user_turn, None)
        && trusted_server_action_turn(vision_action_turn, vision_action, UNDERSTAND_SCENE)
        && vision_action_turn.parent_identifier == user_turn.identifier
        && trusted_device_observation_turn(vision_observation_turn, vision_observation)
        && vision_observation_turn.parent_identifier == vision_action_turn.identifier
        && vision_observation.action_name == UNDERSTAND_SCENE
        && !vision_observation.is_final
        && !vision_observation.observation.trim().is_empty()
        && compose_turn.parent_identifier == vision_observation_turn.identifier
}

fn trusted_user_request_turn(turn: &SynapseChatTurn, expected_utterance: Option<&str>) -> bool {
    let Some(synapse_chat_turn::Content::UserRequest(user_request)) = &turn.content else {
        return false;
    };
    turn.user == SynapseUser::User as i32
        && !turn.identifier.is_empty()
        && expected_utterance
            .is_none_or(|expected| canonical_current_turn_matches(user_request, expected))
}

fn trusted_server_action_turn(
    turn: &SynapseChatTurn,
    action: &SynapseActionContent,
    expected_action: &str,
) -> bool {
    turn.user == SynapseUser::Assistant as i32
        && !turn.identifier.is_empty()
        && !turn.parent_identifier.is_empty()
        && action.action == expected_action
        && action.source == SynapseSource::Server as i32
        && action.device_payload.is_empty()
}

fn trusted_device_observation_turn(
    turn: &SynapseChatTurn,
    observation: &SynapseObservationContent,
) -> bool {
    turn.user == SynapseUser::Assistant as i32
        && !turn.identifier.is_empty()
        && !turn.parent_identifier.is_empty()
        && observation.source == SynapseSource::Device as i32
}

fn prior_compose_input(input_json: &str) -> Option<ComposeMessageInput> {
    let input = if input_json.trim().is_empty() {
        ComposeMessageInput::default()
    } else {
        serde_json::from_str::<ComposeMessageInput>(input_json).ok()?
    };

    valid_compose_input(&input).then_some(input)
}

fn valid_compose_input(input: &ComposeMessageInput) -> bool {
    input.to.len() <= MAX_RECIPIENTS
        && input.to.iter().all(|recipient| {
            recipient.len() <= MAX_RECIPIENT_BYTES
                && !recipient.trim().is_empty()
                && !recipient.chars().any(char::is_control)
        })
        && input.message.len() <= MAX_MESSAGE_BYTES
        && !input.message.chars().any(|character| character == '\0')
}

fn state_for_input(input: &ComposeMessageInput) -> PendingComposeState {
    if input.to.is_empty() {
        PendingComposeState::AwaitingRecipient
    } else if input.message.is_empty() {
        PendingComposeState::AwaitingMessage
    } else {
        PendingComposeState::AwaitingConfirmation
    }
}

/// Humane's stock Compose handler returns a final `SuccessObservation` even
/// while the composition interactor remains active. These are the handler's
/// observed lifecycle strings: two ask for missing fields, and two represent
/// a complete draft awaiting ConfirmSendMessage or CancelSendMessage. Other
/// final observations close the interaction.
fn observation_compose_state(observation: &str) -> Option<PendingComposeState> {
    let normalized = observation
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = normalized.trim_end_matches('.');

    match normalized {
        "draft was created, user has been asked to provide recipients" => {
            Some(PendingComposeState::AwaitingRecipient)
        }
        "draft has been created, next request will probably contain the message contents" => {
            Some(PendingComposeState::AwaitingMessage)
        }
        "draft has been created. it must be confirmed before it can be sent"
        | "draft was updated" => Some(PendingComposeState::AwaitingConfirmation),
        _ => None,
    }
}

fn pending_timestamp_is_recent(context: &SynapseDeviceContext, turn: &SynapseChatTurn) -> bool {
    let Some(action_timestamp) = turn
        .timestamp
        .as_ref()
        .filter(|timestamp| timestamp.seconds > 0)
    else {
        return true;
    };
    let Some(current_timestamp) = context
        .current_timestamp
        .as_ref()
        .filter(|timestamp| timestamp.seconds > 0)
    else {
        return true;
    };

    let age = current_timestamp.seconds - action_timestamp.seconds;
    (0..=MAX_PENDING_AGE_SECONDS).contains(&age)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::aibus::{
        synapse_chat_turn, SynapseActionContent, SynapseObservationContent, SynapseSource,
        SynapseUser, SynapseUserRequestContent,
    };
    use prost_types::Timestamp;

    fn request(utterance: &str) -> SynapseUnderstandingRequest {
        SynapseUnderstandingRequest {
            utterance: utterance.to_string(),
            device_context: Some(SynapseDeviceContext {
                is_locked: false,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn action_turn(identifier: &str, parent: &str, action: &str, seconds: i64) -> SynapseChatTurn {
        action_turn_with_input(identifier, parent, action, "", seconds)
    }

    fn action_turn_with_input(
        identifier: &str,
        parent: &str,
        action: &str,
        input: &str,
        seconds: i64,
    ) -> SynapseChatTurn {
        SynapseChatTurn {
            user: SynapseUser::Assistant as i32,
            timestamp: (seconds > 0).then_some(Timestamp { seconds, nanos: 0 }),
            identifier: identifier.to_string(),
            parent_identifier: parent.to_string(),
            content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                action: action.to_string(),
                input: input.to_string(),
                source: SynapseSource::Server as i32,
                ..Default::default()
            })),
        }
    }

    fn observation_turn(parent: &str, is_final: bool) -> SynapseChatTurn {
        observation_turn_with_text(parent, is_final, "message composer ready")
    }

    fn observation_turn_with_text(
        parent: &str,
        is_final: bool,
        observation: &str,
    ) -> SynapseChatTurn {
        SynapseChatTurn {
            user: SynapseUser::Assistant as i32,
            identifier: format!("observation-{parent}"),
            parent_identifier: parent.to_string(),
            content: Some(synapse_chat_turn::Content::Observation(
                SynapseObservationContent {
                    observation: observation.to_string(),
                    is_final,
                    action_name: String::new(),
                    source: SynapseSource::Device as i32,
                },
            )),
            ..Default::default()
        }
    }

    fn user_turn(identifier: &str, parent: &str, utterance: &str) -> SynapseChatTurn {
        user_turn_with_repair(identifier, parent, utterance, "")
    }

    fn user_turn_with_repair(
        identifier: &str,
        parent: &str,
        utterance: &str,
        repaired_utterance: &str,
    ) -> SynapseChatTurn {
        SynapseChatTurn {
            user: SynapseUser::User as i32,
            identifier: identifier.to_string(),
            parent_identifier: parent.to_string(),
            content: Some(synapse_chat_turn::Content::UserRequest(
                SynapseUserRequestContent {
                    request: utterance.to_string(),
                    repaired_request: repaired_utterance.to_string(),
                    ..Default::default()
                },
            )),
            ..Default::default()
        }
    }

    fn request_with_pending_compose(utterance: &str) -> SynapseUnderstandingRequest {
        request_with_compose_state(
            utterance,
            r#"{"To":["Alice"],"Message":"Hello"}"#,
            "message composer ready",
            false,
        )
    }

    fn request_with_compose_state(
        utterance: &str,
        input: &str,
        observation: &str,
        is_final: bool,
    ) -> SynapseUnderstandingRequest {
        let mut request = request(utterance);
        request.device_context = Some(SynapseDeviceContext {
            current_timestamp: Some(Timestamp {
                seconds: 1_100,
                nanos: 0,
            }),
            turns: vec![
                user_turn("root", "", "send a message"),
                action_turn_with_input("compose", "root", COMPOSE_MESSAGE, input, 1_000),
                observation_turn_with_text("compose", is_final, observation),
                user_turn("current-user", "observation-compose", utterance),
            ],
            ..Default::default()
        });
        request
    }

    fn request_with_vision_pending_compose(utterance: &str) -> SynapseUnderstandingRequest {
        let mut request = request(utterance);
        request.device_context = Some(SynapseDeviceContext {
            current_timestamp: Some(Timestamp {
                seconds: 1_100,
                nanos: 0,
            }),
            turns: vec![
                user_turn(
                    "vision-user",
                    "",
                    "if you see a parcel, text Alice saying it arrived",
                ),
                action_turn("vision-action", "vision-user", UNDERSTAND_SCENE, 990),
                SynapseChatTurn {
                    user: SynapseUser::Assistant as i32,
                    identifier: "vision-observation".to_string(),
                    parent_identifier: "vision-action".to_string(),
                    content: Some(synapse_chat_turn::Content::Observation(
                        SynapseObservationContent {
                            observation: "A parcel is visible by the door".to_string(),
                            is_final: false,
                            action_name: UNDERSTAND_SCENE.to_string(),
                            source: SynapseSource::Device as i32,
                        },
                    )),
                    ..Default::default()
                },
                action_turn_with_input(
                    "compose",
                    "vision-observation",
                    COMPOSE_MESSAGE,
                    r#"{"To":["Alice"],"Message":"It arrived"}"#,
                    1_000,
                ),
                observation_turn_with_text(
                    "compose",
                    true,
                    "Draft has been created. It must be confirmed before it can be sent",
                ),
                user_turn("current-user", "observation-compose", utterance),
            ],
            ..Default::default()
        });
        request
    }

    #[test]
    fn compose_uses_exact_stock_action_and_confirmation_gated_json() {
        let request =
            request("Please send a message to +45 42 49 35 91 saying Hello from the Pin!");
        let planned = plan_message_action(&request).expect("compose action");

        assert_eq!(planned.action_name, COMPOSE_MESSAGE);
        assert_eq!(
            planned.input_json,
            r#"{"To":["+45 42 49 35 91"],"Message":"Hello from the Pin!"}"#
        );
        assert!(!planned.input_json.contains("EnableAutoSend"));
    }

    #[test]
    fn compose_supports_multiple_recipients_and_quoted_message() {
        let request = request("text Alice and Bob: \"Dinner is at 7\"");
        let planned = plan_message_action(&request).expect("compose action");

        assert_eq!(
            planned.input_json,
            r#"{"To":["Alice","Bob"],"Message":"Dinner is at 7"}"#
        );
    }

    #[test]
    fn recipient_only_and_empty_stock_drafts_are_supported() {
        assert!(plan_message_action(&request("tell me about text messages")).is_none());
        assert!(plan_message_action(&request("send a message to Alice saying   ")).is_none());

        let recipient_only =
            plan_message_action(&request("text Alice")).expect("recipient-only compose");
        assert_eq!(
            recipient_only.input_json,
            r#"{"To":["Alice"],"Message":""}"#
        );

        let empty = plan_message_action(&request("send a message")).expect("empty draft");
        assert_eq!(empty.input_json, r#"{"To":[],"Message":""}"#);
        assert!(!empty.input_json.contains("EnableAutoSend"));
    }

    #[test]
    fn exact_checklist_draft_body_confirm_and_cancel_flow_is_preserved() {
        let recipient_only =
            plan_message_action(&request("Text Alex.")).expect("recipient-only checklist draft");
        assert_eq!(recipient_only.action_name, COMPOSE_MESSAGE);
        assert_eq!(recipient_only.input_json, r#"{"To":["Alex"],"Message":""}"#);

        let body_request = request_with_compose_state(
            "This is the second Pin test.",
            &recipient_only.input_json,
            "Draft has been created, next request will probably contain the message contents",
            true,
        );
        let with_body = plan_message_action(&body_request).expect("checklist body follow-up");
        assert_eq!(with_body.action_name, COMPOSE_MESSAGE);
        assert_eq!(
            with_body.input_json,
            r#"{"To":["Alex"],"Message":"This is the second Pin test."}"#
        );

        let confirm_request = request_with_compose_state(
            "Send it.",
            &with_body.input_json,
            "Draft has been created. It must be confirmed before it can be sent",
            true,
        );
        let confirm = plan_message_action(&confirm_request).expect("checklist confirmation");
        assert_eq!(confirm.action_name, CONFIRM_SEND_MESSAGE);
        assert_eq!(confirm.input_json, "{}");

        let full_draft = plan_message_action(&request(
            "Send a message to Alex saying this is a Pin test.",
        ))
        .expect("full checklist draft");
        let cancel_request = request_with_compose_state(
            "Cancel.",
            &full_draft.input_json,
            "Draft has been created. It must be confirmed before it can be sent",
            true,
        );
        let cancel = plan_message_action(&cancel_request).expect("checklist cancellation");
        assert_eq!(cancel.action_name, CANCEL_SEND_MESSAGE);
        assert_eq!(cancel.input_json, "{}");
    }

    #[test]
    fn compose_recipient_slots_reject_mixed_commands_but_explicit_bodies_remain_data() {
        for utterance in [
            "text Alice and take a photo",
            "send a message to Alice and call Bob",
            "text Alice or Bob",
            "text Alice & Bob",
            "text Alice while recording a video",
            "text Alice, then start a timer",
            "text Alice take photo",
        ] {
            assert!(
                plan_message_action(&request(utterance)).is_none(),
                "mixed recipient command escaped for {utterance:?}"
            );
        }

        let body = plan_message_action(&request("text Alice saying take a photo"))
            .expect("an explicit message body is data, not a second action");
        assert_eq!(
            body.input_json,
            r#"{"To":["Alice"],"Message":"take a photo"}"#
        );
    }

    #[test]
    fn stock_missing_message_observation_accepts_body_follow_up() {
        let request = request_with_compose_state(
            "Dinner is at seven",
            r#"{"To":["Alice"],"Message":""}"#,
            "Draft has been created, next request will probably contain the message contents",
            true,
        );

        let planned = plan_message_action(&request).expect("updated compose action");
        assert_eq!(planned.action_name, COMPOSE_MESSAGE);
        assert_eq!(
            planned.input_json,
            r#"{"To":["Alice"],"Message":"Dinner is at seven"}"#
        );
    }

    #[test]
    fn stock_missing_recipient_observation_accepts_recipient_follow_up() {
        let request = request_with_compose_state(
            "to Alice and Bob",
            r#"{"To":[],"Message":""}"#,
            "Draft was created, User has been asked to provide recipients",
            true,
        );

        let planned = plan_message_action(&request).expect("updated compose action");
        assert_eq!(planned.action_name, COMPOSE_MESSAGE);
        assert_eq!(planned.input_json, r#"{"To":["Alice","Bob"],"Message":""}"#);
    }

    #[test]
    fn recipient_follow_up_carries_forward_an_existing_message() {
        let request = request_with_compose_state(
            "Alice",
            r#"{"To":[],"Message":"Already dictated"}"#,
            "Draft was created, User has been asked to provide recipients",
            true,
        );

        let planned = plan_message_action(&request).expect("updated compose action");
        assert_eq!(
            planned.input_json,
            r#"{"To":["Alice"],"Message":"Already dictated"}"#
        );
    }

    #[test]
    fn explicit_edit_reopens_the_missing_message_state() {
        let request = request_with_compose_state(
            "re-dictate",
            r#"{"To":["Alice"],"Message":"Old text"}"#,
            "Draft has been created. It must be confirmed before it can be sent",
            true,
        );

        let planned = plan_message_action(&request).expect("edit compose action");
        assert_eq!(planned.action_name, COMPOSE_MESSAGE);
        assert_eq!(planned.input_json, r#"{"To":["Alice"],"Message":""}"#);
    }

    #[test]
    fn explicit_confirmation_requires_pending_compose() {
        assert!(plan_message_action(&request("send it")).is_none());

        let planned = plan_message_action(&request_with_pending_compose("Yes, send it!"))
            .expect("confirmation action");
        assert_eq!(planned.action_name, CONFIRM_SEND_MESSAGE);
        assert_eq!(planned.input_json, "{}");
    }

    #[test]
    fn explicit_confirmation_accepts_exact_vision_origin_compose_chain() {
        let planned = plan_message_action(&request_with_vision_pending_compose("Yes, send it!"))
            .expect("vision-origin confirmation action");
        assert_eq!(planned.action_name, CONFIRM_SEND_MESSAGE);
        assert_eq!(planned.input_json, "{}");

        // Merely having a vision-created draft never auto-sends it. The next
        // user request must still be an explicit confirmation.
        assert!(
            plan_message_action(&request_with_vision_pending_compose("what time is it?")).is_none()
        );
    }

    #[test]
    fn vision_origin_confirmation_rejects_every_malformed_provenance_link() {
        let rejected = |request: SynapseUnderstandingRequest, case: &str| {
            assert!(
                plan_message_action(&request).is_none(),
                "malformed vision compose context was accepted: {case}"
            );
        };

        let mut request = request_with_vision_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[0].user = SynapseUser::Assistant as i32;
        rejected(request, "vision root is not a user request");

        let mut request = request_with_vision_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[1].parent_identifier = "missing".into();
        rejected(request, "UnderstandScene skips its user request");

        let mut request = request_with_vision_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Action(action)) =
            request.device_context.as_mut().unwrap().turns[1]
                .content
                .as_mut()
        else {
            panic!("expected UnderstandScene action");
        };
        action.source = SynapseSource::Device as i32;
        rejected(request, "UnderstandScene is not a server action");

        let mut request = request_with_vision_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Action(action)) =
            request.device_context.as_mut().unwrap().turns[1]
                .content
                .as_mut()
        else {
            panic!("expected UnderstandScene action");
        };
        action.action = RESPOND.into();
        rejected(request, "vision action has the wrong action name");

        let mut request = request_with_vision_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[2].parent_identifier = "vision-user".into();
        rejected(request, "vision observation skips UnderstandScene");

        let mut request = request_with_vision_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Observation(observation)) =
            request.device_context.as_mut().unwrap().turns[2]
                .content
                .as_mut()
        else {
            panic!("expected vision observation");
        };
        observation.source = SynapseSource::Server as i32;
        rejected(request, "vision observation is not device sourced");

        let mut request = request_with_vision_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Observation(observation)) =
            request.device_context.as_mut().unwrap().turns[2]
                .content
                .as_mut()
        else {
            panic!("expected vision observation");
        };
        observation.action_name = RESPOND.into();
        rejected(request, "vision observation has the wrong action name");

        let mut request = request_with_vision_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Observation(observation)) =
            request.device_context.as_mut().unwrap().turns[2]
                .content
                .as_mut()
        else {
            panic!("expected vision observation");
        };
        observation.is_final = true;
        rejected(request, "vision observation is terminal");

        let mut request = request_with_vision_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Observation(observation)) =
            request.device_context.as_mut().unwrap().turns[2]
                .content
                .as_mut()
        else {
            panic!("expected vision observation");
        };
        observation.observation.clear();
        rejected(request, "vision observation is empty");

        let mut request = request_with_vision_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[3].parent_identifier =
            "vision-action".into();
        rejected(request, "ComposeMessage skips the vision observation");

        let mut request = request_with_vision_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns.insert(
            3,
            user_turn("interloper", "vision-observation", "unrelated"),
        );
        rejected(request, "vision prefix is not immediate");
    }

    #[test]
    fn confirmation_rejects_forged_or_unlinked_compose_history() {
        let rejected = |request: SynapseUnderstandingRequest, case: &str| {
            assert!(
                plan_message_action(&request).is_none(),
                "forged compose context was accepted: {case}"
            );
        };

        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[1].user = SynapseUser::User as i32;
        rejected(request, "compose action has user role");

        let mut request = request_with_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Action(action)) =
            request.device_context.as_mut().unwrap().turns[1]
                .content
                .as_mut()
        else {
            panic!("expected compose action");
        };
        action.source = SynapseSource::Device as i32;
        rejected(request, "compose action has device source");

        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[1]
            .identifier
            .clear();
        rejected(request, "compose action has no identifier");

        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[1].parent_identifier = "missing".into();
        rejected(request, "compose action has no linked user request");

        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[2].user = SynapseUser::User as i32;
        rejected(request, "compose observation has user role");

        let mut request = request_with_pending_compose("send it");
        let Some(synapse_chat_turn::Content::Observation(observation)) =
            request.device_context.as_mut().unwrap().turns[2]
                .content
                .as_mut()
        else {
            panic!("expected compose observation");
        };
        observation.source = SynapseSource::Server as i32;
        rejected(request, "compose observation has server source");

        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[2].parent_identifier = "root".into();
        rejected(request, "compose observation is not linked to action");

        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[3].parent_identifier = "compose".into();
        rejected(request, "confirmation user turn skips device observation");

        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().turns[3].user = SynapseUser::Assistant as i32;
        rejected(request, "confirmation turn has assistant role");

        let mut request = request_with_pending_compose("send it");
        let Some(synapse_chat_turn::Content::UserRequest(user_request)) =
            request.device_context.as_mut().unwrap().turns[3]
                .content
                .as_mut()
        else {
            panic!("expected current user request");
        };
        user_request.request = "unrelated replay".into();
        rejected(request, "current context utterance does not match request");
    }

    #[test]
    fn explicit_cancellation_requires_pending_compose() {
        let planned = plan_message_action(&request_with_pending_compose("No, don't send it."))
            .expect("cancel action");
        assert_eq!(planned.action_name, CANCEL_SEND_MESSAGE);
        assert_eq!(planned.input_json, "{}");
    }

    #[test]
    fn confirmation_and_cancel_win_over_missing_body_capture() {
        let missing_body = |utterance: &str| {
            request_with_compose_state(
                utterance,
                r#"{"To":["Alice"],"Message":""}"#,
                "Draft has been created, next request will probably contain the message contents",
                true,
            )
        };

        let confirm = plan_message_action(&missing_body("send it")).expect("confirmation action");
        assert_eq!(confirm.action_name, CONFIRM_SEND_MESSAGE);

        let cancel = plan_message_action(&missing_body("cancel")).expect("cancel action");
        assert_eq!(cancel.action_name, CANCEL_SEND_MESSAGE);
    }

    #[test]
    fn blocked_confirmation_is_not_reinterpreted_as_message_body() {
        let mut request = request_with_compose_state(
            "send it",
            r#"{"To":["Alice"],"Message":""}"#,
            "Draft has been created, next request will probably contain the message contents",
            true,
        );
        request
            .excluded_tools
            .push(CONFIRM_SEND_MESSAGE.to_string());

        assert!(plan_message_action(&request).is_none());
    }

    #[test]
    fn unrelated_follow_up_never_sends_pending_message() {
        assert!(plan_message_action(&request_with_pending_compose("what time is it?")).is_none());
    }

    #[test]
    fn final_observation_closes_pending_compose() {
        let mut request = request_with_pending_compose("send it");
        let context = request.device_context.as_mut().unwrap();
        context.turns[2] = observation_turn("compose", true);

        assert!(plan_message_action(&request).is_none());
    }

    #[test]
    fn stock_final_draft_observation_still_requires_confirmation() {
        let mut request = request_with_pending_compose("send it");
        let context = request.device_context.as_mut().unwrap();
        context.turns[2] = observation_turn("compose", true);
        let Some(synapse_chat_turn::Content::Observation(observation)) =
            context.turns[2].content.as_mut()
        else {
            panic!("expected observation");
        };
        observation.observation =
            "Draft has been created. It must be confirmed before it can be sent".to_string();

        let planned = plan_message_action(&request).expect("confirmation action");
        assert_eq!(planned.action_name, CONFIRM_SEND_MESSAGE);
    }

    #[test]
    fn prior_confirmation_prevents_duplicate_send() {
        let mut request = request_with_pending_compose("send it");
        let context = request.device_context.as_mut().unwrap();
        context.turns.insert(
            3,
            action_turn(
                "confirm",
                "observation-compose",
                CONFIRM_SEND_MESSAGE,
                1_050,
            ),
        );

        assert!(plan_message_action(&request).is_none());
    }

    #[test]
    fn stale_compose_cannot_be_confirmed() {
        let mut request = request_with_pending_compose("send it");
        request.device_context.as_mut().unwrap().current_timestamp = Some(Timestamp {
            seconds: 1_000 + MAX_PENDING_AGE_SECONDS + 1,
            nanos: 0,
        });

        assert!(plan_message_action(&request).is_none());
    }

    #[test]
    fn excluded_stock_action_is_honored() {
        let mut compose = request("message Alice saying hello");
        compose.excluded_tools.push(COMPOSE_MESSAGE.to_string());
        assert!(plan_message_action(&compose).is_none());

        let mut confirm = request_with_pending_compose("yes");
        confirm
            .excluded_tools
            .push(CONFIRM_SEND_MESSAGE.to_string());
        assert!(plan_message_action(&confirm).is_none());

        let mut follow_up = request_with_compose_state(
            "new body",
            r#"{"To":["Alice"],"Message":""}"#,
            "Draft has been created, next request will probably contain the message contents",
            true,
        );
        follow_up.excluded_tools.push(COMPOSE_MESSAGE.to_string());
        assert!(plan_message_action(&follow_up).is_none());
    }

    #[test]
    fn prior_device_only_fields_are_never_carried_forward() {
        let request = request_with_compose_state(
            "Safe body",
            r#"{"To":["Alice"],"Message":"","EnableAutoSend":true}"#,
            "Draft has been created, next request will probably contain the message contents",
            true,
        );

        let planned = plan_message_action(&request).expect("updated compose action");
        assert_eq!(
            planned.input_json,
            r#"{"To":["Alice"],"Message":"Safe body"}"#
        );
        assert!(!planned.input_json.contains("EnableAutoSend"));
    }

    #[test]
    fn malformed_or_oversized_prior_draft_is_not_resumed() {
        let malformed = request_with_compose_state(
            "body",
            "not-json",
            "Draft has been created, next request will probably contain the message contents",
            true,
        );
        assert!(plan_message_action(&malformed).is_none());

        let oversized_recipient = "a".repeat(MAX_RECIPIENT_BYTES + 1);
        let oversized_input = serde_json::json!({
            "To": [oversized_recipient],
            "Message": ""
        })
        .to_string();
        let oversized = request_with_compose_state(
            "body",
            &oversized_input,
            "Draft has been created, next request will probably contain the message contents",
            true,
        );
        assert!(plan_message_action(&oversized).is_none());
    }

    #[test]
    fn pending_compose_turn_bound_is_enforced_for_follow_ups() {
        let mut request = request_with_compose_state(
            "body",
            r#"{"To":["Alice"],"Message":""}"#,
            "Draft has been created, next request will probably contain the message contents",
            true,
        );
        let context = request.device_context.as_mut().unwrap();
        for index in 0..MAX_PENDING_TURNS {
            context.turns.insert(
                context.turns.len() - 1,
                user_turn(
                    &format!("intervening-{index}"),
                    "observation-compose",
                    "unrelated",
                ),
            );
        }

        assert!(plan_message_action(&request).is_none());
    }

    #[test]
    fn locked_context_blocks_private_drafts_and_cancel_but_keeps_emergency_compose() {
        let unknown = SynapseUnderstandingRequest {
            utterance: "text Alice saying hello".to_string(),
            ..Default::default()
        };
        assert!(plan_message_action(&unknown).is_none());

        let mut locked = request("text Alice saying hello");
        locked.device_context = Some(SynapseDeviceContext {
            is_locked: true,
            ..Default::default()
        });
        assert!(plan_message_action(&locked).is_none());

        let mut partial_emergency = request("text 911");
        partial_emergency.device_context = Some(SynapseDeviceContext {
            is_locked: true,
            ..Default::default()
        });
        assert!(plan_message_action(&partial_emergency).is_none());

        let mut complete_emergency = request("text 911 saying help");
        complete_emergency.device_context = Some(SynapseDeviceContext {
            is_locked: true,
            ..Default::default()
        });
        assert!(plan_message_action(&complete_emergency).is_some());

        let mut confirm = request_with_pending_compose("send it");
        confirm.device_context.as_mut().unwrap().is_locked = true;
        assert!(plan_message_action(&confirm).is_none());

        let mut cancel = request_with_pending_compose("cancel");
        cancel.device_context.as_mut().unwrap().is_locked = true;
        assert!(plan_message_action(&cancel).is_none());
    }

    #[test]
    fn action_parent_uses_current_user_root_for_a_fresh_verified_chain() {
        let pending_request = request_with_pending_compose("send it");
        assert_eq!(
            response_parent_id(&pending_request, "transport-run"),
            "current-user"
        );
        assert_eq!(
            trusted_authorizing_user_id(&pending_request),
            Some("current-user")
        );

        let mut mismatched = pending_request.clone();
        let Some(synapse_chat_turn::Content::UserRequest(user_request)) = mismatched
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .content
            .as_mut()
        else {
            panic!("expected current user request");
        };
        user_request.request = "different request".to_string();
        assert_eq!(
            response_parent_id(&mismatched, "transport-run"),
            "transport-run"
        );
        assert_eq!(trusted_authorizing_user_id(&mismatched), None);

        let mut trailing_observation = pending_request.clone();
        trailing_observation
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .push(observation_turn("compose", false));
        assert_eq!(
            response_parent_id(&trailing_observation, "transport-run"),
            "transport-run"
        );
        assert_eq!(trusted_authorizing_user_id(&trailing_observation), None);

        assert_eq!(
            response_parent_id(&request("hello"), "transport-run"),
            "transport-run"
        );
    }

    #[test]
    fn request_authority_uses_repaired_current_turn_then_raw_fallback() {
        let mut repaired = request_with_pending_compose("send it");
        repaired.device_context.as_mut().unwrap().turns[3] = user_turn_with_repair(
            "current-user",
            "observation-compose",
            "uncertain transcript",
            "Send it!",
        );
        assert_eq!(trusted_authorizing_user_id(&repaired), Some("current-user"));
        assert_eq!(
            plan_message_action(&repaired).map(|planned| planned.action_name),
            Some(CONFIRM_SEND_MESSAGE)
        );

        let mut raw_fallback = repaired.clone();
        raw_fallback.device_context.as_mut().unwrap().turns[3] =
            user_turn_with_repair("current-user", "observation-compose", "SEND it.", "   ");
        assert_eq!(
            trusted_authorizing_user_id(&raw_fallback),
            Some("current-user")
        );

        for punctuation_shift in ["Send it?", "Send? it", "Send @it"] {
            let mut shifted = raw_fallback.clone();
            shifted.device_context.as_mut().unwrap().turns[3] = user_turn_with_repair(
                "current-user",
                "observation-compose",
                "send it",
                punctuation_shift,
            );
            assert_eq!(trusted_authorizing_user_id(&shifted), None);
            assert!(plan_message_action(&shifted).is_none());
        }

        let mut raw_punctuation_shift = raw_fallback.clone();
        raw_punctuation_shift.device_context.as_mut().unwrap().turns[3] =
            user_turn_with_repair("current-user", "observation-compose", "send it?", "   ");
        assert_eq!(trusted_authorizing_user_id(&raw_punctuation_shift), None);
        assert!(plan_message_action(&raw_punctuation_shift).is_none());

        for interrogative in ["send it?", "confirm?", "do it?"] {
            let exact_interrogative = request_with_pending_compose(interrogative);
            assert_eq!(
                trusted_authorizing_user_id(&exact_interrogative),
                Some("current-user")
            );
            assert!(plan_message_action(&exact_interrogative).is_none());
        }

        let mut repaired_mismatch = raw_fallback.clone();
        repaired_mismatch.device_context.as_mut().unwrap().turns[3] = user_turn_with_repair(
            "current-user",
            "observation-compose",
            "send it",
            "cancel it",
        );
        assert_eq!(trusted_authorizing_user_id(&repaired_mismatch), None);
        assert!(plan_message_action(&repaired_mismatch).is_none());

        let mut control_bearing = raw_fallback;
        control_bearing.device_context.as_mut().unwrap().turns[3] = user_turn_with_repair(
            "current-user",
            "observation-compose",
            "unused transcript",
            "send\nit",
        );
        assert_eq!(trusted_authorizing_user_id(&control_bearing), None);
        assert!(plan_message_action(&control_bearing).is_none());
    }

    #[test]
    fn duplicated_current_turn_identifier_never_grants_request_authority() {
        let mut duplicated = request_with_pending_compose("send it");
        duplicated.device_context.as_mut().unwrap().turns[0].identifier = "current-user".into();
        assert_eq!(trusted_authorizing_user_id(&duplicated), None);
        assert!(plan_message_action(&duplicated).is_none());
        assert_eq!(
            response_parent_id(&duplicated, "transport-run"),
            "transport-run"
        );

        let mut control_identifier = request_with_pending_compose("send it");
        control_identifier
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .identifier = "current\nuser".into();
        assert!(plan_message_action(&control_identifier).is_none());
    }

    #[test]
    fn resumed_actions_parent_to_verified_observation_but_keep_user_authority() {
        let mut resumed = request_with_pending_compose("send it");
        let context = resumed.device_context.as_mut().unwrap();
        context.turns.push(action_turn(
            "location-action",
            "current-user",
            GET_CURRENT_LOCATION,
            1_101,
        ));
        context
            .turns
            .push(observation_turn("location-action", false));

        assert_eq!(trusted_authorizing_user_id(&resumed), Some("current-user"));
        assert_eq!(
            response_parent_id(&resumed, "transport-run"),
            "observation-location-action"
        );

        let context = resumed.device_context.as_mut().unwrap();
        context.turns.push(action_turn(
            "second-action",
            "observation-location-action",
            "GetBatteryStatus",
            1_102,
        ));
        context.turns.push(observation_turn("second-action", false));
        assert_eq!(trusted_authorizing_user_id(&resumed), Some("current-user"));
        assert_eq!(
            response_parent_id(&resumed, "transport-run"),
            "observation-second-action"
        );
    }

    #[test]
    fn malformed_or_untrusted_resume_chains_fail_closed() {
        let valid = || {
            let mut request = request_with_pending_compose("send it");
            let context = request.device_context.as_mut().unwrap();
            context.turns.push(action_turn(
                "location-action",
                "current-user",
                GET_CURRENT_LOCATION,
                1_101,
            ));
            context
                .turns
                .push(observation_turn("location-action", false));
            request
        };
        let rejected = |request: &SynapseUnderstandingRequest| {
            assert_eq!(trusted_authorizing_user_id(request), None);
            assert_eq!(
                response_parent_id(request, "transport-run"),
                "transport-run"
            );
        };

        let mut wrong_action_parent = valid();
        wrong_action_parent
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .iter_mut()
            .find(|turn| turn.identifier == "location-action")
            .unwrap()
            .parent_identifier = "older-run".into();
        rejected(&wrong_action_parent);

        let mut untrusted_action = valid();
        let Some(synapse_chat_turn::Content::Action(action)) = untrusted_action
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .iter_mut()
            .find(|turn| turn.identifier == "location-action")
            .unwrap()
            .content
            .as_mut()
        else {
            panic!("expected action");
        };
        action.source = SynapseSource::Device as i32;
        rejected(&untrusted_action);

        let mut mismatched_observation = valid();
        let Some(synapse_chat_turn::Content::Observation(observation)) = mismatched_observation
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .content
            .as_mut()
        else {
            panic!("expected observation");
        };
        observation.action_name = "DifferentAction".into();
        rejected(&mismatched_observation);

        let mut final_observation = valid();
        let Some(synapse_chat_turn::Content::Observation(observation)) = final_observation
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .content
            .as_mut()
        else {
            panic!("expected observation");
        };
        observation.is_final = true;
        rejected(&final_observation);

        let mut dangling_action = valid();
        dangling_action
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .push(action_turn(
                "dangling-action",
                "observation-location-action",
                "GetBatteryStatus",
                1_102,
            ));
        rejected(&dangling_action);

        let mut duplicate_identifier = valid();
        duplicate_identifier
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .identifier = "current-user".into();
        rejected(&duplicate_identifier);
    }
}
