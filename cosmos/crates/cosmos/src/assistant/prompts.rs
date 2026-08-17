//! The clean-room prompt registry, embedded at compile time.
//!
//! `prompts/registry.json` holds this project's own authored prompts — content,
//! sha256, and an evidence grade per entry. It existed
//! for a long time without being wired to anything: the engine carried its own
//! hardcoded strings, so the registry was documentation that looked like
//! configuration.
//!
//! These are embedded with `include_str!` rather than read at runtime for two
//! reasons. The release image does not ship `prompts/` (only the compiled
//! binary), so a runtime read would fail in the container while passing every
//! local test — and a prompt that fails to load is a wearer's turn that fails.
//! Embedding also means the text is covered by the same build that runs the
//! tests, so it cannot drift from what was verified.
//!
//! Authorship: these are OURS. No Humane prompt prose is reproduced here — the
//! recovered stock sets informed the behavioural contract the engine enforces in
//! code, not the wording used to ask for it.

/// Safety rules that apply to every turn regardless of tool set.
///
/// Both close gaps a code guard cannot: the assistant reads attacker-controlled
/// text (search results, retrieved pages, message bodies) in the same channel it
/// reads the wearer's request, and it holds private context that must not leak
/// into logs, citations, or tool arguments.
pub const UNTRUSTED_CONTENT: &str =
    include_str!("../../../../prompts/content/safety/untrusted-content.prompt");
pub const PRIVACY: &str = include_str!("../../../../prompts/content/safety/privacy.prompt");

/// How to speak to someone listening through a small speaker.
pub const SPOKEN_OUTPUT: &str =
    include_str!("../../../../prompts/content/system/spoken-output.prompt");

/// The registry entries that are live, joined as one system block.
///
/// Ordered safety-first: an instruction that arrives later in a prompt does not
/// reliably outrank an earlier one, and the untrusted-content rule is the one
/// that must hold even when the rest of the turn is adversarial.
pub fn safety_block() -> String {
    format!("{}\n\n{}", UNTRUSTED_CONTENT.trim(), PRIVACY.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded text must actually be present and non-trivial.
    ///
    /// `include_str!` of a missing file is a compile error, but an EMPTY or
    /// truncated file compiles fine and silently removes the rule from every
    /// turn — a guard that disappears without anything going red.
    #[test]
    fn the_embedded_safety_rules_are_present_and_substantive() {
        for (name, text) in [
            ("untrusted-content", UNTRUSTED_CONTENT),
            ("privacy", PRIVACY),
            ("spoken-output", SPOKEN_OUTPUT),
        ] {
            assert!(
                text.trim().len() > 120,
                "{name} embedded empty or truncated — the rule would silently \
                 vanish from every turn",
            );
        }
        let block = safety_block();
        assert!(
            block.contains("not authority"),
            "the untrusted-content rule must lead"
        );
        assert!(
            block.contains("minimum private context"),
            "the privacy rule must be included"
        );
    }
}
