use serde::Serialize;

use crate::proto::aibus::SynapseUnderstandingRequest;
use crate::tier_a::native_actions;

const MAX_NUTRITION_REQUEST_BYTES: usize = 512;

#[derive(Debug, PartialEq, Eq)]
pub struct PlannedNutritionAction {
    pub action_name: &'static str,
    pub thought: &'static str,
    pub input_json: String,
}

#[derive(Serialize)]
struct NutritionAgentInput<'a> {
    #[serde(rename = "Request")]
    request: &'a str,
}

/// Enter the firmware's stock `ManageNutrition` agent for explicit food lookup,
/// tracking, and log-summary requests. Structured food tools remain owned by
/// the nested `food/4` agent; this top-level planner never invents nutrition
/// values or writes a log itself.
pub fn plan_nutrition_action(
    request: &SynapseUnderstandingRequest,
    runtime_gate_enabled: bool,
) -> Option<PlannedNutritionAction> {
    if !runtime_gate_enabled
        || request
            .device_context
            .as_ref()
            .is_none_or(|context| context.is_locked)
        || action_is_excluded(request, native_actions::MANAGE_NUTRITION)
    {
        return None;
    }

    let utterance = request.utterance.trim();
    if utterance.is_empty()
        || utterance.len() > MAX_NUTRITION_REQUEST_BYTES
        || utterance.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return None;
    }

    let normalized = normalize(utterance);
    if !is_explicit_nutrition_request(&normalized) {
        return None;
    }

    Some(PlannedNutritionAction {
        action_name: native_actions::MANAGE_NUTRITION,
        thought: "The user explicitly requested the stock nutrition agent",
        input_json: serde_json::to_string(&NutritionAgentInput { request: utterance }).ok()?,
    })
}

fn is_explicit_nutrition_request(value: &str) -> bool {
    if value.starts_with("i ate at ") || value.starts_with("i just ate at ") {
        return false;
    }
    starts_with_any(
        value,
        &[
            "i ate ",
            "i just ate ",
            "i drank ",
            "log that i ate ",
            "track that i ate ",
            "track my meal ",
            "track my food ",
            "log my meal ",
            "log my food ",
            "add this meal to my food log",
            "add this food to my food log",
            "what are the nutrition facts for ",
            "what is the nutrition information for ",
            "nutrition information for ",
            "nutrition facts for ",
            "how many calories are in ",
            "how many calories in ",
            "how much protein is in ",
            "how much protein in ",
            "how much sugar is in ",
            "how much sugar in ",
        ],
    ) || matches!(
        value,
        "what have i eaten today"
            | "what did i eat today"
            | "what have i eaten"
            | "show my food log"
            | "show me my food log"
            | "how many calories did i eat today"
            | "how many calories have i eaten today"
    ) || (value.starts_with("what have i eaten in the last ") && value.ends_with(" days"))
        || (value.starts_with("show my food log for the last ") && value.ends_with(" days"))
}

fn starts_with_any(value: &str, prefixes: &[&str]) -> bool {
    prefixes
        .iter()
        .any(|prefix| value == prefix.trim_end() || value.starts_with(prefix))
}

fn normalize(value: &str) -> String {
    let mut normalized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character.is_whitespace() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
    ] {
        if let Some(remainder) = normalized.strip_prefix(prefix) {
            normalized = remainder.to_string();
            break;
        }
    }
    normalized
}

fn action_is_excluded(request: &SynapseUnderstandingRequest, action_name: &str) -> bool {
    request
        .excluded_tools
        .iter()
        .any(|excluded| excluded.eq_ignore_ascii_case(action_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(utterance: &str) -> SynapseUnderstandingRequest {
        SynapseUnderstandingRequest {
            utterance: utterance.to_string(),
            device_context: Some(crate::proto::aibus::SynapseDeviceContext {
                is_locked: false,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn explicit_lookup_tracking_and_summary_requests_enter_stock_agent() {
        for utterance in [
            "I ate two eggs",
            "Please track my food: one banana",
            "How many calories are in an apple?",
            "What are the nutrition facts for oatmeal?",
            "What have I eaten today?",
            "Show my food log for the last 3 days",
        ] {
            let planned = plan_nutrition_action(&request(utterance), true).expect(utterance);
            assert_eq!(planned.action_name, native_actions::MANAGE_NUTRITION);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&planned.input_json).unwrap(),
                serde_json::json!({"Request": utterance})
            );
        }
    }

    #[test]
    fn ambiguous_conversation_and_medical_advice_fall_through() {
        for utterance in [
            "I had a question",
            "I ate at a restaurant yesterday and liked it",
            "Tell me about nutrition",
            "What diet should I follow for diabetes?",
            "Is sugar bad?",
            "Track package delivery",
            "",
        ] {
            assert!(
                plan_nutrition_action(&request(utterance), true).is_none(),
                "unexpected nutrition action for {utterance}"
            );
        }
    }

    #[test]
    fn lock_and_exclusion_boundaries_fail_closed() {
        let unknown = SynapseUnderstandingRequest {
            utterance: "I ate two eggs".to_string(),
            ..Default::default()
        };
        assert!(plan_nutrition_action(&unknown, true).is_none());

        let mut locked = request("I ate two eggs");
        locked.device_context = Some(crate::proto::aibus::SynapseDeviceContext {
            is_locked: true,
            ..Default::default()
        });
        assert!(plan_nutrition_action(&locked, true).is_none());

        let mut excluded = request("What have I eaten today?");
        excluded
            .excluded_tools
            .push(native_actions::MANAGE_NUTRITION.to_ascii_lowercase());
        assert!(plan_nutrition_action(&excluded, true).is_none());
    }

    #[test]
    fn authoritative_runtime_gate_blocks_every_stock_nutrition_entry() {
        for utterance in [
            "I ate two eggs",
            "What are the nutrition facts for oatmeal?",
            "Show my food log",
        ] {
            assert!(plan_nutrition_action(&request(utterance), false).is_none());
        }
    }
}
