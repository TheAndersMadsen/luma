//! Clock-family fast-path planning: turning an already-classified stock clock
//! request into a concrete native action without a model round trip.

use super::*;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct PlannedClockFamilyAction {
    pub(super) action_name: &'static str,
    pub(super) input_json: String,
}

pub(super) fn plan_clock_family_action(
    request: &SynapseUnderstandingRequest,
) -> Option<PlannedClockFamilyAction> {
    let entry = classify_clock_family_entry(&request.utterance)?;
    let excluded = |candidate: &str| {
        request
            .excluded_tools
            .iter()
            .any(|name| name.eq_ignore_ascii_case(candidate))
    };
    if excluded(entry.action_name())
        || entry.nested_action_name().is_some_and(&excluded)
        || entry.continuation_action_name().is_some_and(excluded)
    {
        return None;
    }

    let (field_name, field_value) = entry.string_input();
    let input_json = serde_json::Value::Object(serde_json::Map::from_iter([(
        field_name.to_string(),
        serde_json::Value::String(field_value.to_string()),
    )]))
    .to_string();
    Some(PlannedClockFamilyAction {
        action_name: entry.action_name(),
        input_json,
    })
}
