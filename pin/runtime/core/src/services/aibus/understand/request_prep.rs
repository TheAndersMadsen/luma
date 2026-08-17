//! Request preparation: lock/visual/context predicates, trusted-turn and
//! correlation validation, current-location observation promotion, and the
//! automation-utterance rewrite.

use super::*;

pub(super) fn request_device_lock_state(request: &SynapseUnderstandingRequest) -> DeviceLockState {
    match request.device_context.as_ref() {
        Some(context) if context.is_locked => DeviceLockState::Locked,
        Some(_) => DeviceLockState::Unlocked,
        None => DeviceLockState::Unknown,
    }
}

pub(super) fn request_is_confirmed_unlocked(request: &SynapseUnderstandingRequest) -> bool {
    request_device_lock_state(request) == DeviceLockState::Unlocked
}

pub(super) fn request_contains_visual_context(request: &SynapseUnderstandingRequest) -> bool {
    let Some(context) = request.device_context.as_ref() else {
        return false;
    };
    let Some(user_request) = context.turns.iter().rev().find_map(|turn| {
        let synapse_chat_turn::Content::UserRequest(user_request) = turn.content.as_ref()? else {
            return None;
        };
        Some(user_request)
    }) else {
        return false;
    };
    !user_request.image_data.is_empty()
        || user_request.vision_requested
            == synapse_user_request_content::VisionRequested::Vision as i32
}

/// Tiny dependency-free FNV-1a for content-free log fingerprints only.
pub(super) fn fnv1a32(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

pub(super) fn should_run_ai_music_classifier(request: &SynapseUnderstandingRequest) -> bool {
    request_is_confirmed_unlocked(request) && is_ai_music_fallback_candidate(request)
}

#[derive(Debug)]
pub(super) enum CurrentLocationFetchState {
    NotRequested,
    Fresh(Location),
    Unavailable,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StockCurrentLocationObservation {
    pub(super) latitude: f64,
    pub(super) longitude: f64,
    #[serde(rename = "isStale")]
    pub(super) is_stale: bool,
}

/// Inspect the exact stock location-tool chain. Ironman's
/// `CentralActionHandler` returns a successful non-final observation as
/// `{"latitude":..., "longitude":..., "isStale":false}`.
///
/// Trust only current USER -> SERVER GetCurrentLocation -> DEVICE observation,
/// with both parent links intact. An older action cannot suppress a fresh
/// request; malformed, stale, out-of-range, or unlinked results never become
/// request coordinates. Once a trusted server action was issued, however, it
/// is not emitted again for that turn: a bad/missing result terminates safely
/// instead of restarting the stock action/observation loop.
pub(super) fn current_location_fetch_state(
    request: &SynapseUnderstandingRequest,
) -> CurrentLocationFetchState {
    let Some(context) = request.device_context.as_ref() else {
        return CurrentLocationFetchState::NotRequested;
    };
    let is_location_candidate = |turn: &SynapseChatTurn| match turn.content.as_ref() {
        Some(synapse_chat_turn::Content::Action(action)) => {
            action.action == native_actions::GET_CURRENT_LOCATION
        }
        Some(synapse_chat_turn::Content::Observation(observation)) => {
            observation.action_name == native_actions::GET_CURRENT_LOCATION
        }
        _ => false,
    };
    let Some((user_index, user_turn, user_request)) = context
        .turns
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, turn)| {
            let Some(synapse_chat_turn::Content::UserRequest(user_request)) = &turn.content else {
                return None;
            };
            Some((index, turn, user_request))
        })
    else {
        return if context.turns.iter().any(is_location_candidate) {
            CurrentLocationFetchState::Unavailable
        } else {
            CurrentLocationFetchState::NotRequested
        };
    };
    let user_identifier = user_turn.identifier.as_str();
    if user_turn.user != SynapseUser::User as i32
        || user_identifier.is_empty()
        || user_identifier.len() > MAX_CURRENT_TURN_IDENTIFIER_BYTES
        || user_identifier.trim() != user_identifier
        || user_identifier.chars().any(char::is_control)
        || !canonical_current_turn_matches(user_request, &request.utterance)
        || context
            .turns
            .iter()
            .enumerate()
            .any(|(index, turn)| index != user_index && turn.identifier == user_identifier)
    {
        return CurrentLocationFetchState::Unavailable;
    }

    let following_turns = &context.turns[user_index + 1..];
    let mut current_slice_identifiers = context.turns[..=user_index]
        .iter()
        .map(|turn| turn.identifier.as_str())
        .collect::<HashSet<_>>();
    for turn in following_turns {
        if turn.identifier.is_empty()
            || turn.identifier.len() > MAX_CURRENT_TURN_IDENTIFIER_BYTES
            || turn.identifier.trim() != turn.identifier
            || turn.identifier.chars().any(char::is_control)
            || !current_slice_identifiers.insert(turn.identifier.as_str())
        {
            return CurrentLocationFetchState::Unavailable;
        }
    }
    let action_candidates = following_turns
        .iter()
        .enumerate()
        .filter_map(|(index, turn)| match turn.content.as_ref() {
            Some(synapse_chat_turn::Content::Action(action))
                if action.action == native_actions::GET_CURRENT_LOCATION =>
            {
                Some((index, turn, action))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if action_candidates.is_empty()
        && !following_turns.iter().any(|turn| {
            matches!(
                turn.content.as_ref(),
                Some(synapse_chat_turn::Content::Observation(observation))
                    if observation.action_name == native_actions::GET_CURRENT_LOCATION
            )
        })
    {
        return CurrentLocationFetchState::NotRequested;
    }
    if action_candidates.len() != 1 {
        return CurrentLocationFetchState::Unavailable;
    }
    let (action_index, action_turn, action) = action_candidates[0];
    if action_turn.user != SynapseUser::Assistant as i32
        || action_turn.identifier.trim().is_empty()
        || action_turn.parent_identifier != user_turn.identifier
        || action.source != SynapseSource::Server as i32
        || !action.device_payload.is_empty()
    {
        return CurrentLocationFetchState::Unavailable;
    }

    // `TaoEventRegistrar.toContent(Observation)` does not populate
    // SynapseObservationContent.action_name for stock CentralActionHandler
    // observations. The action UUID parent link is the authoritative binding.
    // Accept that exact nameless stock shape. Collect every observation linked
    // to the action (plus explicitly named location observations) so conflicting
    // siblings and wrong-parent attempts fail closed below.
    let observation_candidates = following_turns
        .iter()
        .enumerate()
        .filter_map(|(index, turn)| match turn.content.as_ref() {
            Some(synapse_chat_turn::Content::Observation(observation))
                if observation.action_name == native_actions::GET_CURRENT_LOCATION
                    || turn.parent_identifier == action_turn.identifier =>
            {
                Some((index, turn, observation))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if observation_candidates.len() != 1 {
        return CurrentLocationFetchState::Unavailable;
    }

    let Some((observation_index, observation_turn, observation)) =
        observation_candidates.first().copied()
    else {
        return CurrentLocationFetchState::Unavailable;
    };
    if observation_index <= action_index
        || observation_turn.user != SynapseUser::Assistant as i32
        || observation_turn.identifier.trim().is_empty()
        || observation_turn.parent_identifier != action_turn.identifier
        || observation.source != SynapseSource::Device as i32
        || observation.is_final
        || !(observation.action_name.is_empty()
            || observation.action_name == native_actions::GET_CURRENT_LOCATION)
    {
        return CurrentLocationFetchState::Unavailable;
    }
    let Ok(parsed) =
        serde_json::from_str::<StockCurrentLocationObservation>(observation.observation.trim())
    else {
        return CurrentLocationFetchState::Unavailable;
    };
    let location = Location {
        latitude: parsed.latitude,
        longitude: parsed.longitude,
    };
    if parsed.is_stale || !valid_location(&location) {
        CurrentLocationFetchState::Unavailable
    } else {
        CurrentLocationFetchState::Fresh(location)
    }
}

pub(super) fn should_emit_current_location_action(request: &SynapseUnderstandingRequest) -> bool {
    request_is_confirmed_unlocked(request)
        && request_location(request).is_none()
        && matches!(
            current_location_fetch_state(request),
            CurrentLocationFetchState::NotRequested
        )
}

#[allow(deprecated)]
pub(super) fn promote_fresh_current_location_observation(
    request: &mut SynapseUnderstandingRequest,
) {
    if let CurrentLocationFetchState::Fresh(location) = current_location_fetch_state(request) {
        // The exact parent-linked stock observation is newer and more strongly
        // authenticated than any outer request location. Always replace the
        // latter so an agentic resume cannot accidentally use stale coordinates.
        request.location = Some(location);
        if let Some(context) = request.device_context.as_mut() {
            // A label has no fix identity. Never pair a label retained from an
            // older request with coordinates returned by this fresh stock
            // action observation.
            context.reverse_geocoded_location.clear();
            if let Some(situation) = context.situation.as_mut() {
                situation.location_string.clear();
            }
        }
    }
}

pub(super) fn trusted_current_user_request(
    request: &SynapseUnderstandingRequest,
) -> Option<(usize, &SynapseChatTurn, &SynapseUserRequestContent)> {
    let context = request.device_context.as_ref()?;
    let (index, turn, content) =
        context
            .turns
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, turn)| {
                let Some(synapse_chat_turn::Content::UserRequest(content)) = &turn.content else {
                    return None;
                };
                Some((index, turn, content))
            })?;
    let identifier = turn.identifier.as_str();
    (turn.user == SynapseUser::User as i32
        && !identifier.is_empty()
        && identifier.len() <= MAX_CURRENT_TURN_IDENTIFIER_BYTES
        && identifier.trim() == identifier
        && !identifier.chars().any(char::is_control)
        && canonical_current_turn_matches(content, &request.utterance)
        && !context
            .turns
            .iter()
            .enumerate()
            .any(|(candidate_index, candidate)| {
                candidate_index != index && candidate.identifier == identifier
            }))
    .then_some((index, turn, content))
}

pub(super) fn canonical_uuid_v4(value: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(value).ok()?;
    (parsed.get_version_num() == 4 && parsed.get_variant() == uuid::Variant::RFC4122)
        .then(|| parsed.hyphenated().to_string())
}

/// Produce one privacy-safe request correlation shared by the request marker,
/// Center activity, and agentic trace. A valid transport UUID is authoritative;
/// stock bidirectional clients omit that metadata, so their verified current
/// user-turn UUID is the fallback. Random generation is reserved for requests
/// that provide neither trusted value.
pub(super) fn effective_request_correlation(
    request: &SynapseUnderstandingRequest,
    transport_run_id: &str,
) -> String {
    canonical_uuid_v4(transport_run_id)
        .or_else(|| trusted_authorizing_user_id(request).and_then(canonical_uuid_v4))
        .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string())
}

/// Resolve the identifier used only for request-bound visual state. Unlike the
/// public/activity correlation, this may retain stock's opaque non-UUID root
/// identifier, but only after binding it to the exact current user request and
/// transport value. This prevents arbitrary metadata from selecting another
/// request's image or staged visual automation.
pub(super) fn validated_visual_state_id<'a>(
    request: &'a SynapseUnderstandingRequest,
    transport_run_id: &str,
) -> Option<&'a str> {
    let context = request.device_context.as_ref()?;
    let (current_turn, current_request) = context.turns.iter().rev().find_map(|turn| {
        let Some(synapse_chat_turn::Content::UserRequest(content)) = turn.content.as_ref() else {
            return None;
        };
        Some((turn, content))
    })?;
    let identifier = current_turn.identifier.as_str();
    if identifier.is_empty()
        || identifier.len() > 256
        || identifier.trim() != identifier
        || identifier.chars().any(char::is_control)
        || !canonical_current_turn_matches(current_request, &request.utterance)
    {
        return None;
    }

    let transport_is_absent = transport_run_id.is_empty() || transport_run_id == "unknown";
    let transport_matches = transport_run_id == identifier;
    if trusted_authorizing_user_id(request) == Some(identifier)
        && (transport_is_absent || transport_matches)
    {
        return Some(identifier);
    }

    None
}

pub(super) fn validated_inline_image_id<'a>(
    request: &'a SynapseUnderstandingRequest,
    transport_run_id: &str,
) -> Option<&'a str> {
    if let Some(identifier) = validated_visual_state_id(request, transport_run_id) {
        return Some(identifier);
    }

    let context = request.device_context.as_ref()?;
    let [current_turn] = context.turns.as_slice() else {
        return None;
    };
    let Some(synapse_chat_turn::Content::UserRequest(current_request)) =
        current_turn.content.as_ref()
    else {
        return None;
    };
    let identifier = current_turn.identifier.as_str();

    // Some legacy inline-image envelopes omit the turn's user enum. Preserve
    // that already-supported current-image shape only when the opaque transport
    // key exactly matches the sole root turn. This identifier is used only for
    // the inline bytes carried by that turn, never for a cache or staged action.
    (current_turn.user == 0
        && current_turn.parent_identifier.is_empty()
        && !identifier.is_empty()
        && identifier.len() <= 256
        && identifier.trim() == identifier
        && !identifier.chars().any(char::is_control)
        && !current_request.image_data.is_empty()
        && canonical_current_turn_matches(current_request, &request.utterance)
        && transport_run_id == identifier)
        .then_some(identifier)
}

pub(super) fn trusted_previous_user_request(
    request: &SynapseUnderstandingRequest,
) -> Option<(&SynapseChatTurn, &SynapseUserRequestContent)> {
    let context = request.device_context.as_ref()?;
    let (current_index, _, _) = trusted_current_user_request(request)?;
    let (turn, content) = context.turns[..current_index]
        .iter()
        .rev()
        .find_map(|turn| {
            let Some(synapse_chat_turn::Content::UserRequest(content)) = &turn.content else {
                return None;
            };
            Some((turn, content))
        })?;
    (turn.user == SynapseUser::User as i32 && !turn.identifier.trim().is_empty())
        .then_some((turn, content))
}

pub(super) fn current_grounding_key(request: &SynapseUnderstandingRequest, run_id: &str) -> String {
    trusted_current_user_request(request)
        .map(|(_, turn, _)| turn.identifier.trim().to_string())
        .unwrap_or_else(|| run_id.to_string())
}

pub(super) fn previous_grounding_key(request: &SynapseUnderstandingRequest) -> Option<String> {
    trusted_previous_user_request(request).map(|(turn, _)| turn.identifier.trim().to_string())
}

pub(super) fn note_function_call(
    request: &SynapseUnderstandingRequest,
    text: String,
) -> FunctionCall {
    let context = request.device_context.as_ref();
    let situation = context.and_then(|context| context.situation.as_ref());
    let confirmed_unlocked = request_is_confirmed_unlocked(request);
    let reverse_geocoded_location = if confirmed_unlocked {
        {
            context
                .map(|context| context.reverse_geocoded_location.trim().to_string())
                .unwrap_or_default()
        }
    } else {
        Default::default()
    };
    let location = confirmed_unlocked
        .then(|| request_location(request))
        .flatten()
        .map(|location| encryption::LocationEnvelope {
            latitude: location.latitude as f32,
            longitude: location.longitude as f32,
            human_readable: request_location_name(request).unwrap_or_default(),
            full_address: reverse_geocoded_location.clone(),
            accuracy: 0.0,
            stale_status: encryption::LocationStaleStatus::Undefined as i32,
            ..Default::default()
        });

    FunctionCall {
        name: native_actions::CREATE_MEMORY.to_string(),
        utterance: text,
        timestamp: context
            .and_then(|context| context.current_timestamp)
            .or_else(|| situation.and_then(|situation| situation.timestamp)),
        reverse_geocoded_location,
        time_zone: if confirmed_unlocked {
            {
                situation
                    .map(|situation| situation.time_zone_id.trim().to_string())
                    .unwrap_or_default()
            }
        } else {
            Default::default()
        },
        location,
        // FunctionExecution has only a boolean lock field. Treat Unknown as
        // locked so a context-free request cannot persist a note accidentally.
        is_locked: !confirmed_unlocked,
        ..Default::default()
    }
}

/// Resolve only an image that belongs to the current turn or to stock's exact
/// immediately preceding UnderstandScene parent chain. Unlike generic visual
/// chat, nutrition must never retarget an older image found elsewhere in the
/// conversation history.
pub(super) async fn exact_visual_nutrition_image(
    request: &SynapseUnderstandingRequest,
    inline_image_id: &str,
    visual_state_id: &str,
    image_store: &LiveImageStore,
) -> Option<Vec<u8>> {
    if !request_is_confirmed_unlocked(request) {
        return None;
    }
    if let Some(image) = linked_current_turn_image(request, inline_image_id) {
        return Some(image);
    }
    if let Some(image) = linked_previous_vision_inline_image(request, visual_state_id) {
        return Some(image);
    }
    let previous_run_id = linked_previous_vision_run_id(request, visual_state_id)?;
    image_store
        .get_capture_refresh(&previous_run_id)
        .await
        .map(|capture| capture.bytes)
}

pub(super) fn request_with_automation_utterance(
    request: &SynapseUnderstandingRequest,
    utterance: &str,
) -> SynapseUnderstandingRequest {
    let mut planned = request.clone();
    planned.utterance = utterance.to_string();
    planned
}
