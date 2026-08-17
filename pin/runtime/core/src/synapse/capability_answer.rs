//! Grounded answer for "what can you do".
//!
//! Experience-roadmap item 9a. Capability questions are the single most common
//! intent in the captured carry corpus — 3 of 17 distinct utterances — and the
//! real carry cloud routed every one to its `HumaneSupport` lookup. We had no
//! equivalent: nothing in the prompt describes this server's capabilities, so the
//! model improvised a list.
//!
//! An improvised list is not merely unmeasured, it is wrong by construction. The
//! model does not know which native actions THIS server exposes, so it can
//! promise the wearer something the Pin will refuse, or omit something it can
//! actually do. That is a correctness problem, and the repository's own rule for
//! durable fixes applies: move the guarantee out of the model's discretion and
//! into code.
//!
//! So the answer is **derived**, not authored. The set of capabilities comes from
//! the recovered action contract cross-referenced against
//! [`native_action_spec`] — i.e. what this server can genuinely dispatch today.
//! Only the noun for each category is written down; which categories appear is a
//! fact about the running catalog, and shrinks automatically if support does.

use std::collections::BTreeSet;

use super::catalog::native_action_spec;
use super::native_device_actions::action_is_excluded;
use crate::proto::aibus::SynapseUnderstandingRequest;
use crate::tier_a::native_actions;

/// The recovered stock action contract (committed; `action` + `experience` columns).
///
/// Test-only by design. Now that each phrase names the exact action it promises,
/// the production path resolves capabilities straight from the native catalog and
/// never parses this file. It is retained as the independent cross-check that the
/// curated mapping below still agrees with the recovered contract — the thing that
/// would otherwise drift silently.
#[cfg(test)]
const CONTRACT_TSV: &str = include_str!("../../../../contracts/tier-a/native-actions.tsv");

/// Wearer-facing capabilities: `(experience, spoken phrase, the action it promises)`.
///
/// Deliberately a curated subset. `CENTRAL`, `AGENT_SETTINGS`,
/// `MESSAGES_BACKGROUND`, `SYSTEM_NAVIGATION`, `TICKLE_PROTOTYPE` and
/// `UI_GALLERY` are internal plumbing — a wearer does not ask for them, and
/// naming them would pad a spoken answer that must stay short. Ordering is the
/// order spoken.
///
/// The third column is load-bearing and was added after a real defect: gating on
/// "any dispatchable action in this experience" meant a turn that excluded only
/// `PlayMusic` still offered *"play music"*, because `GetMusicQueue` survived in
/// the same experience. The wearer would then be refused the exact thing they had
/// just been invited to ask for.
///
/// So a phrase is spoken only when the action it actually names is dispatchable
/// for this request. Reads and secondary actions in the same experience no longer
/// keep a promise alive on their own.
const EXPERIENCE_WORDS: &[(&str, &str, &str)] = &[
    ("MUSIC", "play music", native_actions::PLAY_MUSIC),
    ("CLOCK", "set timers and alarms", native_actions::SET_TIMER),
    ("ANSWERS", "answer questions", native_actions::RESPOND),
    (
        "PHOTOGRAPHY",
        "take photos",
        native_actions::CAPTURE_PHOTOGRAPH,
    ),
    ("MESSAGES", "send messages", native_actions::COMPOSE_MESSAGE),
    ("DIALER", "make calls", native_actions::CALL_PERSON),
    (
        "CONTACTS",
        "look up contacts",
        native_actions::SEARCH_CONTACT,
    ),
    ("TRANSLATION", "translate", native_actions::TRANSLATE),
];

/// Experiences available for THIS request: dispatchable, wearer-facing, and not
/// switched off for this turn.
///
/// The per-request half matters as much as the catalog half. A capability list
/// built from the catalog alone reintroduces, one level down, exactly the bug
/// this module exists to prevent: it would promise "play music" on a turn whose
/// `excluded_tools` withholds music, or "take photos" while the keyguard is
/// locked and photography requires an unlocked device. Same rules the planner
/// applies (`action_is_excluded`, `requires_confirmed_unlock`), so the spoken
/// answer and the dispatcher cannot disagree.
pub fn available_experiences(
    request: Option<&SynapseUnderstandingRequest>,
) -> BTreeSet<&'static str> {
    EXPERIENCE_WORDS
        .iter()
        .filter(|(_, _, action)| action_is_offerable(request, action))
        .map(|(key, _, _)| *key)
        .collect()
}

/// Whether the specific action a phrase promises can be dispatched for this
/// request: it exists in the catalog, is not excluded for this turn, and is not
/// blocked by the keyguard.
fn action_is_offerable(request: Option<&SynapseUnderstandingRequest>, action: &str) -> bool {
    let Some(spec) = native_action_spec(action) else {
        return false;
    };
    if let Some(request) = request {
        if action_is_excluded(request, action) {
            return false;
        }
        let locked = request
            .device_context
            .as_ref()
            .is_some_and(|context| context.is_locked);
        if locked && spec.requires_confirmed_unlock() {
            return false;
        }
    }
    true
}

/// The whole decision for one request: is this a general capability question,
/// may this turn speak at all, and what should it say.
///
/// Composed here rather than at the call site because the call site is inside
/// `run_local_text_fast_path`, which needs a full service instance to drive — so
/// a bug in the composition could not be reached by any unit test. That is not
/// hypothetical: the `Respond`-exclusion check was originally written at the call
/// site and every test in this module stayed green while a request that had
/// disabled spoken turns would still have been answered aloud.
///
/// `understand.rs` now only asks this function and emits what it returns.
pub fn capability_response_for(request: &SynapseUnderstandingRequest) -> Option<String> {
    if !is_unqualified_capability_question(&request.utterance) {
        return None;
    }
    // `!action_is_excluded(request, native_actions::RESPOND)` — the same rule
    // `response_action_allowed` applies at the twelve other emission sites. A
    // request that excludes `Respond` is saying this turn may not speak.
    if action_is_excluded(request, native_actions::RESPOND) {
        return None;
    }
    capability_answer_for(Some(request))
}

/// The spoken answer, or `None` when nothing is dispatchable (never a sentence
/// claiming capabilities this server does not have).
pub fn capability_answer_for(request: Option<&SynapseUnderstandingRequest>) -> Option<String> {
    let supported = available_experiences(request);
    let phrases: Vec<&str> = EXPERIENCE_WORDS
        .iter()
        .filter(|(key, _, _)| supported.contains(key))
        .map(|(_, word, _)| *word)
        .collect();

    sentence_from(&phrases)
}

/// The wearer-facing length bound. `supervisor_prompt.rs` records that answers
/// beyond roughly this length are cut off mid-delivery by the stock narrator.
const MAX_SPOKEN_CHARS: usize = 200;

/// Build the spoken sentence, naming as many capabilities as actually fit.
///
/// An earlier version hard-capped this at four, which silently dropped half of
/// what the Pin can do — a wearer heard "ask for any of it" without ever learning
/// that messages, calls, contacts and translation were included. All eight fit in
/// 150 characters, so the cap was discarding real information to satisfy a
/// number rather than the constraint.
///
/// The bound is what matters, so the bound is what truncates: phrases are dropped
/// from the end only while the sentence would otherwise exceed
/// [`MAX_SPOKEN_CHARS`]. Split out from the caller so that behaviour is testable
/// with a synthetic list — the catalog currently fits, so truncation would
/// otherwise be unreachable logic that no test could exercise.
fn sentence_from(phrases: &[&str]) -> Option<String> {
    if phrases.is_empty() {
        return None;
    }

    let render = |items: &[&str]| -> String {
        match items {
            [only] => format!("I can {only}."),
            _ => {
                let (tail, head) = items.split_last().expect("non-empty");
                format!("I can {} and {tail} — ask for any of it.", head.join(", "),)
            }
        }
    };

    let mut kept = phrases.to_vec();
    while kept.len() > 1 && render(&kept).chars().count() > MAX_SPOKEN_CHARS {
        kept.pop();
    }

    let spoken = render(&kept);
    // A single phrase that still overruns is better said than truncated
    // mid-word; the caller's own bound test pins the normal case.
    Some(spoken)
}

/// Whether this is an UNQUALIFIED "what can you do".
///
/// The rule is taken from the captured corpus, which contains all three real
/// forms: *"hello what can you do"* and *"what else can you do"* are general,
/// but *"what can you do in terms of fitness"* is scoped to a topic and a generic
/// answer would be the wrong answer.
///
/// So the utterance must END with the capability phrase. That is the same hazard
/// item 1 hit with `GetCurrentTime` (*"what time is it in Tokyo"*): a trailing
/// qualifier changes the correct response, and matching a mere substring would
/// swallow it. A qualified form falls through to the model, which can address the
/// topic.
pub fn is_unqualified_capability_question(utterance: &str) -> bool {
    let normalized: String = utterance
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");

    // Strip only conversational filler. Anything else remaining in front means
    // the utterance carries other content and is not purely a capability
    // question.
    //
    // An earlier version accepted any utterance ENDING with the phrase, which
    // silently claimed compound commands: "call mom what can you do" and "take a
    // note what can you do" both matched, so the command would have been dropped
    // and replaced with a capability list. Same discipline as item 1's exact
    // anchors — be strict, and let anything ambiguous fall through to the model,
    // which can address the whole utterance.
    const FILLER: &[&str] = &[
        "hello", "hi", "hey", "so", "ok", "okay", "um", "uh", "well", "and", "please", "yeah",
    ];

    let mut words: Vec<&str> = normalized.split_whitespace().collect();
    while let Some(first) = words.first() {
        if FILLER.contains(first) {
            words.remove(0);
        } else {
            break;
        }
    }
    let stripped = words.join(" ");

    [
        "what can you do",
        "what else can you do",
        "what all can you do",
        "what can you help me with",
    ]
    .contains(&stripped.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three real utterances from the carry capture, and the distinction the
    /// matcher exists to make.
    #[test]
    fn the_captured_capability_questions_split_qualified_from_general() {
        for general in ["hello what can you do", "what else can you do"] {
            assert!(
                is_unqualified_capability_question(general),
                "{general:?} is a general capability question (observed in the carry capture)",
            );
        }
        assert!(
            !is_unqualified_capability_question("what can you do in terms of fitness"),
            "a topic-qualified question must fall through — a generic list is the WRONG \
             answer to it, the same way GetCurrentTime must not answer 'what time is it \
             in Tokyo' with local time",
        );
    }

    /// REGRESSION: an utterance carrying a real command must not be hijacked.
    ///
    /// The matcher originally accepted anything ENDING with the capability phrase,
    /// so "call mom what can you do" and "take a note what can you do" were both
    /// claimed — the command would have been dropped and the wearer given a
    /// capability list instead of the thing they asked for. Leading conversational
    /// filler is fine; leading content is not.
    #[test]
    fn compound_utterances_carrying_a_command_are_not_hijacked() {
        for compound in [
            "take a note what can you do",
            "play music and tell me what can you do",
            "set a timer then what can you do",
            "call mom what can you do",
            "remind me what can you do",
        ] {
            assert!(
                !is_unqualified_capability_question(compound),
                "{compound:?} carries a real command and must reach the planner, not be \
                 answered with a capability list",
            );
        }

        // Pure filler in front is still just a capability question.
        for filler_led in [
            "so what can you do",
            "hey what can you do",
            "ok what can you do",
        ] {
            assert!(
                is_unqualified_capability_question(filler_led),
                "{filler_led:?} is filler plus the question and must still match",
            );
        }
    }

    /// Hostile input must neither panic nor be mis-claimed.
    ///
    /// This repository's recurring defect is a byte-offset panic on non-ASCII
    /// text, so an utterance matcher is exactly where it would bite. This one
    /// never slices by byte offset — it filters chars and rejoins words — and this
    /// test pins that, along with the behaviour that matters: non-ASCII content in
    /// FRONT of the phrase is leading content, not filler, so it must fall through
    /// rather than be answered with an English capability list.
    #[test]
    fn hostile_and_non_ascii_utterances_are_handled_without_panicking() {
        for ignored in [
            "",
            "   ",
            "什么 what can you do",
            "¿qué what can you do?",
            &"hello ".repeat(5_000),
        ] {
            assert!(
                !is_unqualified_capability_question(ignored),
                "{:?} must not be claimed",
                ignored.chars().take(24).collect::<String>(),
            );
        }

        for matched in [
            "WHAT CAN YOU DO",
            "what   can    you     do",
            "what can you do?????",
            "what can you do 🎵",
        ] {
            assert!(
                is_unqualified_capability_question(matched),
                "{matched:?} is the question with only case, spacing, punctuation or an \
                 emoji varying, and must still match",
            );
        }
    }

    /// The gate that stops this from becoming another loose alias.
    #[test]
    fn ordinary_utterances_are_not_capability_questions() {
        for other in [
            "play some music",
            "what is the capital of france",
            "who are you",
            "what can you see",
            "how do i take a picture",
            "tell me what you did yesterday",
        ] {
            assert!(
                !is_unqualified_capability_question(other),
                "{other:?} must not be captured by the capability matcher",
            );
        }
    }

    /// Every curated experience must exist in the contract. A typo would
    /// otherwise silently drop a whole category from the spoken answer while
    /// every other test stayed green.
    #[test]
    fn every_curated_experience_exists_in_the_contract() {
        let in_contract: BTreeSet<&str> = CONTRACT_TSV
            .lines()
            .skip(1)
            .filter_map(|line| line.split('\t').nth(1))
            .filter(|experience| !experience.is_empty())
            .collect();

        for (key, _, _) in EXPERIENCE_WORDS {
            assert!(
                in_contract.contains(key),
                "{key} is not an experience in the recovered contract — a typo here \
                 silently removes a capability from the answer",
            );
        }
    }

    fn request_with(excluded: &[&str], locked: bool) -> SynapseUnderstandingRequest {
        SynapseUnderstandingRequest {
            utterance: "what can you do".to_string(),
            excluded_tools: excluded.iter().map(|e| e.to_string()).collect(),
            device_context: Some(crate::proto::aibus::SynapseDeviceContext {
                is_locked: locked,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// A capability the turn is withholding must not be spoken.
    ///
    /// This is the same bug the module exists to prevent, one level down: an
    /// answer built from the catalog alone would promise "play music" on a turn
    /// whose `excluded_tools` withholds every music action.
    #[test]
    fn excluded_tools_are_not_promised() {
        let music_actions: Vec<&str> = CONTRACT_TSV
            .lines()
            .skip(1)
            .filter_map(|line| {
                let mut c = line.split('\t');
                let (action, experience) = (c.next()?, c.next()?);
                (experience == "MUSIC" && native_action_spec(action).is_some()).then_some(action)
            })
            .collect();
        assert!(
            !music_actions.is_empty(),
            "fixture needs dispatchable music actions"
        );

        let request = request_with(&music_actions, false);
        let available = available_experiences(Some(&request));
        assert!(
            !available.contains("MUSIC"),
            "every music action is excluded on this turn, so music must not be offered",
        );

        let answer = capability_answer_for(Some(&request)).expect("other capabilities remain");
        assert!(
            !answer.contains("play music"),
            "the answer promised music while the turn excluded it: {answer:?}",
        );
    }

    /// A locked device must not be told about capabilities that need unlocking.
    #[test]
    fn keyguard_locked_hides_capabilities_that_require_unlock() {
        let unlocked = available_experiences(Some(&request_with(&[], false)));
        let locked = available_experiences(Some(&request_with(&[], true)));
        assert!(
            locked.is_subset(&unlocked),
            "locking must only ever remove capabilities, never add them",
        );
        assert!(
            locked.len() < unlocked.len(),
            "some curated experience requires an unlocked device, so locking must narrow \
             the answer — if this fails the keyguard check is not being applied",
        );
    }

    /// Every capability the server actually has must be named — the wearer cannot
    /// ask for what they were never told about.
    #[test]
    fn the_answer_names_every_available_capability_when_they_fit() {
        let available = available_experiences(None);
        let answer = capability_answer_for(None).expect("capabilities exist");
        for (key, word, _) in EXPERIENCE_WORDS {
            if available.contains(key) {
                assert!(
                    answer.contains(word),
                    "{key} is available but {word:?} is missing from the answer: {answer:?}",
                );
            }
        }
    }

    /// Truncation is driven by the length bound, not a magic count — and it has to
    /// be exercised with a synthetic list, because the real catalog fits inside the
    /// bound and would leave this path unreachable.
    #[test]
    fn the_sentence_truncates_only_to_respect_the_spoken_bound() {
        let short = ["play music", "take photos"];
        let rendered = sentence_from(&short).expect("non-empty");
        assert!(rendered.contains("play music") && rendered.contains("take photos"));

        let long: Vec<&str> = vec!["do something quite verbose indeed for a wearer"; 20];
        let truncated = sentence_from(&long).expect("non-empty");
        assert!(
            truncated.chars().count() <= MAX_SPOKEN_CHARS,
            "a long list must be trimmed to the bound, got {} chars",
            truncated.chars().count(),
        );
        assert!(
            truncated.starts_with("I can "),
            "truncation must not damage the sentence shape: {truncated:?}",
        );
    }

    /// Every phrase must name an action that really exists and really belongs to
    /// the experience it is listed under. A typo in the third column would
    /// silently remove that capability from the answer forever, and no other test
    /// here would notice.
    #[test]
    fn every_promised_action_exists_and_matches_its_experience() {
        for (key, word, action) in EXPERIENCE_WORDS {
            assert!(
                native_action_spec(action).is_some(),
                "{word:?} promises {action}, which is not in the native catalog — a typo \
                 here silently drops {key} from the answer",
            );
            let experience_of_action = CONTRACT_TSV.lines().skip(1).find_map(|line| {
                let mut c = line.split('\t');
                let (a, e) = (c.next()?, c.next()?);
                (a == *action).then_some(e)
            });
            assert_eq!(
                experience_of_action,
                Some(*key),
                "{action} is listed under {key} here but the contract disagrees",
            );
        }
    }

    /// REGRESSION: excluding the promised action alone must withdraw the promise.
    ///
    /// The first version gated on "any dispatchable action in this experience", so
    /// a turn excluding only `PlayMusic` still offered "play music" — kept alive by
    /// unrelated reads like `GetMusicQueue` — and the wearer would be refused the
    /// very thing they had just been invited to ask for.
    #[test]
    fn excluding_only_the_promised_action_withdraws_that_promise() {
        let request = request_with(&[native_actions::PLAY_MUSIC], false);
        let answer = capability_answer_for(Some(&request)).expect("other capabilities remain");
        assert!(
            !answer.contains("play music"),
            "PlayMusic is excluded, so music must not be offered even though other \
             MUSIC actions remain dispatchable: {answer:?}",
        );
        assert!(
            answer.contains("take photos"),
            "unrelated capabilities must be unaffected: {answer:?}",
        );
    }

    /// REGRESSION: a `Respond` exclusion must suppress the whole answer.
    ///
    /// This check originally lived at the call site in `run_local_text_fast_path`,
    /// which needs a full service instance to drive — so no test could reach it,
    /// and a request that had disabled spoken turns would still have been answered
    /// aloud. Moving the decision here is what makes it testable at all.
    #[test]
    fn a_respond_exclusion_suppresses_the_whole_capability_answer() {
        let ordinary = request_with(&[], false);
        assert!(
            capability_response_for(&ordinary).is_some(),
            "baseline: an ordinary capability question is answered",
        );

        let no_speech = request_with(&[native_actions::RESPOND], false);
        assert_eq!(
            capability_response_for(&no_speech),
            None,
            "this turn excluded Respond, so it must produce no spoken answer at all",
        );
    }

    /// A non-capability utterance must not be claimed by this path.
    #[test]
    fn the_composed_decision_ignores_unrelated_utterances() {
        let mut request = request_with(&[], false);
        request.utterance = "play some music".to_string();
        assert_eq!(capability_response_for(&request), None);
    }

    /// The answer must describe THIS server, not the full stock catalog.
    #[test]
    fn the_answer_is_derived_from_what_this_server_can_dispatch() {
        let supported = available_experiences(None);
        assert!(
            !supported.is_empty(),
            "this server dispatches native actions, so some experience must be supported",
        );

        let answer = capability_answer_for(None).expect("a supported experience yields an answer");
        assert!(answer.starts_with("I can "), "unexpected shape: {answer:?}");
        assert!(
            answer.len() <= 200,
            "answers over ~200 chars are cut off mid-delivery, got {} chars: {answer:?}",
            answer.len(),
        );

        // Nothing unsupported may be claimed.
        for (key, word, _) in EXPERIENCE_WORDS {
            if !supported.contains(key) {
                assert!(
                    !answer.contains(word),
                    "{key} is not dispatchable but the answer promises {word:?}",
                );
            }
        }
    }
}

#[cfg(test)]
mod inspect {
    use super::*;

    /// Not an assertion about wording — a printed record of what the derivation
    /// currently produces, so a reviewer can see the actual spoken sentence and
    /// which experiences backed it.
    #[test]
    fn show_the_derived_answer() {
        let supported = available_experiences(None);
        eprintln!("supported experiences: {supported:?}");
        eprintln!("answer: {:?}", capability_answer_for(None));
    }
}
