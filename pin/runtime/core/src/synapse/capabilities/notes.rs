use crate::proto::aibus::SynapseUnderstandingRequest;
use crate::tier_a::native_actions;

const MAX_NOTE_UTF8_BYTES: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct PlannedNote {
    pub text: String,
}

/// Recognize explicit natural-language note commands after the stock local
/// interpreters have missed.
///
/// Stock notes normally arrive through the Notes Quick Action as a direct
/// `FunctionExecution(CreateMemory)` call. This planner intentionally accepts
/// only imperative phrases that also contain the complete note body. It never
/// guesses from ordinary uses of "note" or "remember" and it never writes
/// while the device is locked.
pub fn plan_note(request: &SynapseUnderstandingRequest) -> Option<PlannedNote> {
    if request
        .device_context
        .as_ref()
        .is_none_or(|context| context.is_locked)
        || request.excluded_tools.iter().any(|tool| {
            tool.eq_ignore_ascii_case(native_actions::CREATE_MEMORY)
                || tool.eq_ignore_ascii_case(native_actions::MANAGE_MEMORY)
        })
    {
        return None;
    }

    let command = strip_polite_prefix(request.utterance.trim());
    let body = [
        "take a note that ",
        "take a note to ",
        "take a note saying ",
        "take a note:",
        "take a note ",
        "make a note that ",
        "make a note to ",
        "make a note saying ",
        "make a note:",
        "make a note ",
        "create a note that ",
        "create a note to ",
        "create a note saying ",
        "create a note:",
        "create a note ",
        "write down that ",
        "write down ",
        "note that ",
    ]
    .iter()
    .find_map(|prefix| strip_prefix_ascii_case(command, prefix))?
    .trim()
    .trim_matches(|character: char| matches!(character, ',' | ':' | ';'))
    .trim();

    if body.is_empty()
        || body.len() > MAX_NOTE_UTF8_BYTES
        || body
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return None;
    }

    Some(PlannedNote {
        text: body.to_string(),
    })
}

fn strip_polite_prefix(mut value: &str) -> &str {
    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
    ] {
        if let Some(remainder) = strip_prefix_ascii_case(value, prefix) {
            value = remainder.trim_start();
            break;
        }
    }
    value
}

fn strip_prefix_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let candidate = value.get(..prefix.len())?;
    candidate
        .eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::aibus::SynapseDeviceContext;

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

    #[test]
    fn explicit_full_note_commands_preserve_the_dictated_body() {
        for (utterance, expected) in [
            ("Take a note: Buy coffee beans", "Buy coffee beans"),
            (
                "Please make a note that the car is on level three",
                "the car is on level three",
            ),
            (
                "Write down call Alice after lunch",
                "call Alice after lunch",
            ),
            (
                "Note that Wi-Fi worked after reboot",
                "Wi-Fi worked after reboot",
            ),
        ] {
            assert_eq!(plan_note(&request(utterance)).unwrap().text, expected);
        }
    }

    #[test]
    fn incomplete_informational_or_ambiguous_phrases_do_not_write() {
        for utterance in [
            "Take a note",
            "How do I take a note?",
            "Tell me about note taking",
            "That is an interesting note",
            "Remember when we visited Copenhagen?",
            "Write down",
            "Please note",
        ] {
            assert!(plan_note(&request(utterance)).is_none(), "{utterance}");
        }
    }

    #[test]
    fn lock_state_and_exclusions_block_note_creation() {
        let unknown = SynapseUnderstandingRequest {
            utterance: "Take a note buy coffee".to_string(),
            ..Default::default()
        };
        assert!(plan_note(&unknown).is_none());

        let mut locked = request("Take a note buy coffee");
        locked.device_context = Some(SynapseDeviceContext {
            is_locked: true,
            ..Default::default()
        });
        assert!(plan_note(&locked).is_none());

        let mut excluded = request("Take a note buy coffee");
        excluded
            .excluded_tools
            .push(native_actions::CREATE_MEMORY.to_ascii_lowercase());
        assert!(plan_note(&excluded).is_none());
    }
}
