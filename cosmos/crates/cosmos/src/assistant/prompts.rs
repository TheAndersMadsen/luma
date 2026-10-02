//! The clean-room prompt registry, embedded at compile time.
//!
//! `prompts/registry.json` holds this project's own authored prompts, content,
//! sha256, and an evidence grade per entry. It existed
//! for a long time without being wired to anything: the engine carried its own
//! hardcoded strings, so the registry was documentation that looked like
//! configuration.
//!
//! These are embedded with `include_str!` rather than read at runtime for two
//! reasons. The release image does not ship `prompts/` (only the compiled
//! binary), so a runtime read would fail in the container while passing every
//! local test, and a prompt that fails to load is a wearer's turn that fails.
//! Embedding also means the text is covered by the same build that runs the
//! tests, so it cannot drift from what was verified.
//!
//! Authorship: these are OURS. No Humane prompt prose is reproduced here, the
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

/// How to speak to someone listening through a small speaker. A registry
/// `candidate`, not yet joined into any live block.
#[cfg(test)]
pub const SPOKEN_OUTPUT: &str =
    include_str!("../../../../prompts/content/system/spoken-output.prompt");
pub const PLAN_TURN: &str =
    include_str!("../../../../prompts/content/orchestration/plan-turn.prompt");
pub const CONFIRM_ACTION: &str =
    include_str!("../../../../prompts/content/orchestration/confirm-action.prompt");

/// The registry entries that are live, joined as one system block.
///
/// Ordered safety-first: an instruction that arrives later in a prompt does not
/// reliably outrank an earlier one, and the untrusted-content rule is the one
/// that must hold even when the rest of the turn is adversarial.
pub fn safety_block() -> String {
    format!("{}\n\n{}", UNTRUSTED_CONTENT.trim(), PRIVACY.trim())
}

/// Foreground planning and confirmation guidance shared by every tool set.
pub fn orchestration_block() -> String {
    format!("{}\n\n{}", PLAN_TURN.trim(), CONFIRM_ACTION.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded text must actually be present and non-trivial.
    ///
    /// `include_str!` of a missing file is a compile error, but an EMPTY or
    /// truncated file compiles fine and silently removes the rule from every
    /// turn, a guard that disappears without anything going red.
    #[test]
    fn the_embedded_safety_rules_are_present_and_substantive() {
        for (name, text) in [
            ("untrusted-content", UNTRUSTED_CONTENT),
            ("privacy", PRIVACY),
            ("spoken-output", SPOKEN_OUTPUT),
            ("plan-turn", PLAN_TURN),
            ("confirm-action", CONFIRM_ACTION),
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
        let orchestration = orchestration_block();
        assert!(orchestration.contains("typed capability"));
        assert!(orchestration.contains("select the matching typed capability"));
        assert!(orchestration.contains("Cosmos will ask for confirmation"));
    }

    /// `prompts/registry.json` records a sha256 per prompt file, and
    /// `prompts/registry_tool.py validate` checks them, but no gate ran that
    /// tool: a one-word edit to `core.prompt` left its recorded hash stale for
    /// weeks. This makes `./luma check cosmos` hold the registry to its files,
    /// so editing a `.prompt` means updating its registry entry too.
    #[test]
    fn every_registered_prompt_matches_its_recorded_hash() {
        use sha2::{Digest, Sha256};
        let registry: serde_json::Value =
            serde_json::from_str(include_str!("../../../../prompts/registry.json"))
                .expect("the prompt registry is JSON");
        let cosmos = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let prompts = registry["prompts"].as_array().expect("registry prompts");
        assert!(!prompts.is_empty());
        for prompt in prompts {
            let path = prompt["path"].as_str().expect("a prompt path");
            let bytes = std::fs::read(cosmos.join(path))
                .unwrap_or_else(|error| panic!("{path} is registered but unreadable: {error}"));
            let actual: String = Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert_eq!(
                prompt["sha256"].as_str(),
                Some(actual.as_str()),
                "{path} changed without its prompts/registry.json hash \
                 (python3 cosmos/prompts/registry_tool.py hashes)"
            );
        }
    }
}
