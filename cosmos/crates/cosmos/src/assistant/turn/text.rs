//! Speakable-text selection and the bounded model-facing observation — the two
//! text seams every transport pushes a model result through.

use super::super::catalog;

/// The spoken text inside a model answer: the `RESPOND_FIELD` of a JSON body
/// when the model produced one, the raw text otherwise, and `None` for silence.
pub(crate) fn spoken_text(input: &str) -> Option<String> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(input) {
        if let Some(s) = v.get(catalog::RESPOND_FIELD).and_then(|v| v.as_str()) {
            return Some(s.to_owned());
        }
    }
    if input.is_empty() {
        None
    } else {
        Some(input.to_owned())
    }
}

/// The most an observation may hand the model.
///
/// The full text still reaches the recorded turn; this bound is only for the
/// prompt, because that text is paid for twice: once in prompt tokens and once
/// in the latency of processing them.
pub(crate) const MAX_MODEL_FACING_OBSERVATION: usize = 1_200;

/// The model-facing form of an observation, cut at a character boundary.
pub(crate) fn model_facing_observation(observation: &str) -> std::borrow::Cow<'_, str> {
    if observation.len() <= MAX_MODEL_FACING_OBSERVATION {
        return std::borrow::Cow::Borrowed(observation);
    }
    // Never slice mid-character: observations contain wearer text and tool output,
    // and a byte-offset cut on non-ASCII panics. Prefer the last sentence break
    // so the model is not handed a fragment.
    let mut end = MAX_MODEL_FACING_OBSERVATION;
    while end > 0 && !observation.is_char_boundary(end) {
        end -= 1;
    }
    let clipped = &observation[..end];
    let cut = clipped
        .rfind(". ")
        .map(|i| i + 1)
        .filter(|i| *i > MAX_MODEL_FACING_OBSERVATION / 2)
        .unwrap_or(end);
    // Marked, so the model knows the text was cut rather than treating a
    // truncated list as complete.
    std::borrow::Cow::Owned(format!("{}… [truncated]", &observation[..cut].trim_end()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoken_text_prefers_the_respond_field_of_a_json_body() {
        let json = format!(
            "{{\"{}\": \"the answer\", \"other\": 1}}",
            catalog::RESPOND_FIELD
        );
        assert_eq!(spoken_text(&json).as_deref(), Some("the answer"));
    }

    #[test]
    fn spoken_text_passes_plain_text_through_and_silence_as_none() {
        assert_eq!(spoken_text("plain words").as_deref(), Some("plain words"));
        assert_eq!(spoken_text(""), None);
        // JSON without the respond field is not silently swallowed: the raw
        // body is still the best available answer text.
        assert_eq!(spoken_text("{\"x\":1}").as_deref(), Some("{\"x\":1}"));
    }

    #[test]
    fn a_short_observation_is_borrowed_unchanged() {
        let short = "all good";
        assert!(matches!(
            model_facing_observation(short),
            std::borrow::Cow::Borrowed(s) if s == short
        ));
    }

    #[test]
    fn a_long_observation_is_cut_at_a_sentence_and_marked() {
        let sentence = "This is one sentence of the observation. ";
        let long = sentence.repeat(60);
        assert!(long.len() > MAX_MODEL_FACING_OBSERVATION);
        let cut = model_facing_observation(&long);
        assert!(cut.len() < long.len());
        assert!(cut.ends_with("… [truncated]"));
        // The cut lands after a sentence break, never mid-word.
        assert!(cut.trim_end_matches("… [truncated]").ends_with('.'));
    }

    #[test]
    fn a_long_non_ascii_observation_never_splits_a_character() {
        let long = "æøå ".repeat(600);
        assert!(long.len() > MAX_MODEL_FACING_OBSERVATION);
        // The property under test is that this does not panic on a boundary.
        let cut = model_facing_observation(&long);
        assert!(cut.ends_with("… [truncated]"));
    }
}
