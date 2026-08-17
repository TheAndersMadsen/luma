use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest as _, Sha256};
use tokio::sync::Mutex;

use crate::proto::aibus::{
    synapse_chat_turn, SynapseSource, SynapseUnderstandingRequest, SynapseUser,
};
use crate::tier_a::native_actions;

const MAX_ACTION_CHARS: usize = 240;
const MAX_SEEN_MATCHES: usize = 256;
const MAX_PENDING_ACTIONS: usize = 32;
const AUTOMATION_DEDUPE_TTL: Duration = Duration::from_secs(5 * 60);
const PENDING_ACTION_TTL: Duration = Duration::from_secs(60);

/// The user-authored `Then` phrase from stock's volatile `SdkManager` map.
///
/// The image model never receives this value and can select only an opaque
/// condition ID. After an exact parent-linked match, Understand runs this
/// phrase through the same stock-compatible text planner cascade as a spoken
/// request. That keeps action schemas, keyguard rules, exclusions, provider
/// gates, and confirmation flows in one place instead of maintaining a second
/// visual-only action catalog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundedAutomationUtterance {
    text: String,
    fingerprint: String,
}

impl BoundedAutomationUtterance {
    pub fn parse(value: &str) -> Option<Self> {
        let text = normalize_spaces(value.trim());
        valid_action_text(&text).then(|| Self {
            fingerprint: text.to_lowercase(),
            text,
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

fn valid_action_text(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ACTION_CHARS
        && !value
            .chars()
            .any(|character| character == '\0' || character.is_control())
}

fn normalize_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchDecision {
    Fresh,
    Duplicate,
    Consumed,
    Capacity,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PendingKey {
    run_id: String,
    binding_digest: [u8; 32],
}

#[derive(Clone)]
struct PendingAction {
    utterance: BoundedAutomationUtterance,
    observation_digest: [u8; 32],
    created_at: Instant,
}

#[derive(Default)]
struct AutomationState {
    seen_matches: HashMap<[u8; 32], Instant>,
    pending: HashMap<PendingKey, PendingAction>,
}

/// Shared, in-memory one-shot handoff from AnalyzeImage to the immediately
/// parent-linked UnderstandScene observation pass.
#[derive(Clone, Default)]
pub struct VisionAutomationStore {
    inner: Arc<Mutex<AutomationState>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PendingActionResult {
    NoMatch,
    Blocked,
    Ready {
        utterance: BoundedAutomationUtterance,
        parent_identifier: String,
    },
}

impl VisionAutomationStore {
    pub async fn reserve_match(
        &self,
        run_id: &str,
        image: &[u8],
        condition: &str,
        utterance: &BoundedAutomationUtterance,
    ) -> MatchDecision {
        self.reserve_match_at(run_id, image, condition, utterance, Instant::now())
            .await
    }

    async fn reserve_match_at(
        &self,
        run_id: &str,
        image: &[u8],
        condition: &str,
        utterance: &BoundedAutomationUtterance,
        now: Instant,
    ) -> MatchDecision {
        let binding_digest = binding_digest(run_id, image, condition, utterance);
        let mut state = self.inner.lock().await;
        prune_state(&mut state, now);
        if state.seen_matches.contains_key(&binding_digest) {
            let key = PendingKey {
                run_id: run_id.to_string(),
                binding_digest,
            };
            return if state.pending.contains_key(&key) {
                MatchDecision::Duplicate
            } else {
                MatchDecision::Consumed
            };
        }
        // Never evict a live one-shot tombstone merely to accept a newer
        // match: doing so would let a flood replay the evicted run. Fail closed
        // until the bounded dedupe horizon naturally frees capacity.
        if state.seen_matches.len() >= MAX_SEEN_MATCHES {
            return MatchDecision::Capacity;
        }
        state.seen_matches.insert(binding_digest, now);
        MatchDecision::Fresh
    }

    pub async fn stage(
        &self,
        run_id: &str,
        image: &[u8],
        condition: &str,
        utterance: BoundedAutomationUtterance,
        observation: &str,
    ) {
        self.stage_at(
            run_id,
            image,
            condition,
            utterance,
            observation,
            Instant::now(),
        )
        .await;
    }

    async fn stage_at(
        &self,
        run_id: &str,
        image: &[u8],
        condition: &str,
        utterance: BoundedAutomationUtterance,
        observation: &str,
        now: Instant,
    ) {
        if run_id.is_empty() || run_id == "unknown" || observation.is_empty() {
            return;
        }
        let key = PendingKey {
            run_id: run_id.to_string(),
            binding_digest: binding_digest(run_id, image, condition, &utterance),
        };
        let pending = PendingAction {
            utterance,
            observation_digest: Sha256::digest(observation.as_bytes()).into(),
            created_at: now,
        };
        let mut state = self.inner.lock().await;
        prune_state(&mut state, now);
        state.pending.retain(|key, _| key.run_id != run_id);
        if state.pending.len() >= MAX_PENDING_ACTIONS {
            if let Some(oldest) = state
                .pending
                .iter()
                .min_by_key(|(_, pending)| pending.created_at)
                .map(|(key, _)| key.clone())
            {
                state.pending.remove(&oldest);
            }
        }
        state.pending.insert(key, pending);
    }

    /// Refresh an unconsumed pending action for an idempotent AnalyzeImage
    /// retry of the exact same run/image/rule. The provider may phrase the
    /// repeated observation differently, so bind the one-shot to the response
    /// actually returned by this retry. A retry after consumption cannot
    /// recreate the action and returns false.
    pub async fn retain_duplicate(
        &self,
        run_id: &str,
        image: &[u8],
        condition: &str,
        utterance: &BoundedAutomationUtterance,
        observation: &str,
    ) -> bool {
        let expected_key = PendingKey {
            run_id: run_id.to_string(),
            binding_digest: binding_digest(run_id, image, condition, utterance),
        };
        let observation_digest: [u8; 32] = Sha256::digest(observation.as_bytes()).into();
        let mut state = self.inner.lock().await;
        prune_state(&mut state, Instant::now());
        state
            .pending
            .retain(|key, _| key.run_id != run_id || key == &expected_key);
        let Some(pending) = state.pending.get_mut(&expected_key) else {
            return false;
        };
        pending.observation_digest = observation_digest;
        true
    }

    /// Revoke every unconsumed one-shot for this stock run.
    ///
    /// Returning whether anything was removed lets the Understand path
    /// distinguish an ordinary request made while visual actions are disabled
    /// from a continuation that must be halted after a live dashboard change.
    pub async fn revoke_pending(&self, run_id: &str) -> bool {
        let mut state = self.inner.lock().await;
        let before = state.pending.len();
        state.pending.retain(|key, _| key.run_id != run_id);
        state.pending.len() != before
    }

    pub async fn clear_pending(&self, run_id: &str) {
        let _ = self.revoke_pending(run_id).await;
    }

    pub async fn consume_for_request(
        &self,
        run_id: &str,
        request: &SynapseUnderstandingRequest,
    ) -> PendingActionResult {
        self.consume_for_request_at(run_id, request, Instant::now())
            .await
    }

    async fn consume_for_request_at(
        &self,
        run_id: &str,
        request: &SynapseUnderstandingRequest,
        now: Instant,
    ) -> PendingActionResult {
        let chain = immediate_vision_observation_chain(run_id, request);
        let mut state = self.inner.lock().await;
        let Some(key) = state
            .pending
            .keys()
            .find(|key| key.run_id == run_id)
            .cloned()
        else {
            return PendingActionResult::NoMatch;
        };
        // Removal and validation happen under one lock: no concurrent follow-up
        // can observe or execute the same pending action.
        let Some(pending) = state.pending.remove(&key) else {
            return PendingActionResult::NoMatch;
        };
        prune_state(&mut state, now);
        drop(state);

        let Some(chain) = chain else {
            return PendingActionResult::Blocked;
        };

        let observation_digest: [u8; 32] = Sha256::digest(chain.observation.as_bytes()).into();
        if now
            .checked_duration_since(pending.created_at)
            .is_none_or(|elapsed| elapsed >= PENDING_ACTION_TTL)
            || observation_digest != pending.observation_digest
        {
            return PendingActionResult::Blocked;
        }

        PendingActionResult::Ready {
            utterance: pending.utterance,
            parent_identifier: chain.parent_identifier.to_string(),
        }
    }
}

struct VisionObservationChain<'a> {
    observation: &'a str,
    parent_identifier: &'a str,
}

fn immediate_vision_observation_chain<'a>(
    run_id: &str,
    request: &'a SynapseUnderstandingRequest,
) -> Option<VisionObservationChain<'a>> {
    if run_id.is_empty() || run_id == "unknown" {
        return None;
    }
    let context = request.device_context.as_ref()?;
    let [.., user_turn, action_turn, observation_turn] = context.turns.as_slice() else {
        return None;
    };
    let synapse_chat_turn::Content::UserRequest(user_request) = user_turn.content.as_ref()? else {
        return None;
    };
    let synapse_chat_turn::Content::Action(action) = action_turn.content.as_ref()? else {
        return None;
    };
    let synapse_chat_turn::Content::Observation(observation) = observation_turn.content.as_ref()?
    else {
        return None;
    };

    if user_turn.user != SynapseUser::User as i32
        || action_turn.user != SynapseUser::Assistant as i32
        || observation_turn.user != SynapseUser::Assistant as i32
        || user_turn.identifier != run_id
        || user_request.request != request.utterance
        || action_turn.identifier.is_empty()
        || action_turn.parent_identifier != user_turn.identifier
        || action.action != native_actions::UNDERSTAND_SCENE
        || action.source != SynapseSource::Server as i32
        || !action.device_payload.is_empty()
        || observation_turn.identifier.is_empty()
        || observation_turn.parent_identifier != action_turn.identifier
        || observation.action_name != native_actions::UNDERSTAND_SCENE
        || observation.source != SynapseSource::Device as i32
        || observation.is_final
        || observation.observation.is_empty()
    {
        return None;
    }

    Some(VisionObservationChain {
        observation: &observation.observation,
        parent_identifier: &observation_turn.identifier,
    })
}

fn prune_state(state: &mut AutomationState, now: Instant) {
    state.seen_matches.retain(|_, instant| {
        now.checked_duration_since(*instant)
            .is_some_and(|elapsed| elapsed < AUTOMATION_DEDUPE_TTL)
    });
    state.pending.retain(|_, pending| {
        now.checked_duration_since(pending.created_at)
            .is_some_and(|elapsed| elapsed < PENDING_ACTION_TTL)
    });
}

fn binding_digest(
    run_id: &str,
    image: &[u8],
    condition: &str,
    utterance: &BoundedAutomationUtterance,
) -> [u8; 32] {
    let image_digest = Sha256::digest(image);
    digest_parts(&[
        run_id.as_bytes(),
        image_digest.as_slice(),
        condition.as_bytes(),
        utterance.fingerprint().as_bytes(),
    ])
}

fn digest_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.len().to_le_bytes());
        digest.update(part);
    }
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::aibus::{
        SynapseActionContent, SynapseChatTurn, SynapseDeviceContext, SynapseObservationContent,
        SynapseUserRequestContent,
    };

    const IMAGE: &[u8] = &[0xff, 0xd8, 0xff, 0xdb];

    fn utterance(value: &str) -> BoundedAutomationUtterance {
        BoundedAutomationUtterance::parse(value).expect(value)
    }

    #[test]
    fn bounded_then_utterances_preserve_every_stock_prompt_family() {
        for value in [
            "play Feel Good Inc by Gorillaz",
            "take a picture",
            "text Alex saying hello",
            "call Alex",
            "take a note: buy coffee",
            "translate hello to French",
            "how many calories are in an apple",
            "what is the weather",
            "set a timer for five minutes",
        ] {
            assert_eq!(utterance(value).text(), value);
        }
        assert!(BoundedAutomationUtterance::parse("").is_none());
        assert!(BoundedAutomationUtterance::parse(&"x".repeat(MAX_ACTION_CHARS + 1)).is_none());
        assert!(BoundedAutomationUtterance::parse("take a photo\0").is_none());
    }

    #[test]
    fn fingerprints_are_case_and_whitespace_stable_but_text_is_preserved() {
        let first = utterance("  Play   Feel Good Inc  ");
        let second = utterance("play feel good inc");
        assert_eq!(first.text(), "Play Feel Good Inc");
        assert_eq!(first.fingerprint(), second.fingerprint());
    }

    fn chain_request(run_id: &str, observation_text: &str) -> SynapseUnderstandingRequest {
        let utterance = "what do you see";
        SynapseUnderstandingRequest {
            utterance: utterance.into(),
            device_context: Some(SynapseDeviceContext {
                is_locked: false,
                turns: vec![
                    SynapseChatTurn {
                        identifier: run_id.into(),
                        user: SynapseUser::User as i32,
                        content: Some(synapse_chat_turn::Content::UserRequest(
                            SynapseUserRequestContent {
                                request: utterance.into(),
                                ..Default::default()
                            },
                        )),
                        ..Default::default()
                    },
                    SynapseChatTurn {
                        identifier: "vision-action".into(),
                        parent_identifier: run_id.into(),
                        user: SynapseUser::Assistant as i32,
                        content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                            action: native_actions::UNDERSTAND_SCENE.into(),
                            source: SynapseSource::Server as i32,
                            ..Default::default()
                        })),
                        ..Default::default()
                    },
                    SynapseChatTurn {
                        identifier: "vision-observation".into(),
                        parent_identifier: "vision-action".into(),
                        user: SynapseUser::Assistant as i32,
                        content: Some(synapse_chat_turn::Content::Observation(
                            SynapseObservationContent {
                                observation: observation_text.into(),
                                action_name: native_actions::UNDERSTAND_SCENE.into(),
                                source: SynapseSource::Device as i32,
                                is_final: false,
                            },
                        )),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn pending_utterance_is_run_observation_and_parent_bound_then_consumed_atomically() {
        let store = VisionAutomationStore::default();
        let then_utterance = utterance("take a picture");
        store
            .stage("run-a", IMAGE, "a dog", then_utterance, "A dog is visible.")
            .await;

        let ready = store
            .consume_for_request("run-a", &chain_request("run-a", "A dog is visible."))
            .await;
        let PendingActionResult::Ready {
            utterance,
            parent_identifier,
        } = ready
        else {
            panic!("expected ready utterance");
        };
        assert_eq!(utterance.text(), "take a picture");
        assert_eq!(parent_identifier, "vision-observation");
        assert_eq!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "A dog is visible."))
                .await,
            PendingActionResult::NoMatch
        );
    }

    #[tokio::test]
    async fn revoking_a_run_removes_only_its_unconsumed_followup() {
        let store = VisionAutomationStore::default();
        store
            .stage(
                "run-a",
                IMAGE,
                "a dog",
                utterance("take a picture"),
                "A dog is visible.",
            )
            .await;
        store
            .stage(
                "run-b",
                IMAGE,
                "a record",
                utterance("play Teardrop"),
                "A record is visible.",
            )
            .await;

        assert!(store.revoke_pending("run-a").await);
        assert!(!store.revoke_pending("run-a").await);
        assert_eq!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "A dog is visible."))
                .await,
            PendingActionResult::NoMatch
        );
        assert!(matches!(
            store
                .consume_for_request("run-b", &chain_request("run-b", "A record is visible."))
                .await,
            PendingActionResult::Ready { .. }
        ));
    }

    #[tokio::test]
    async fn wrong_observation_consumes_and_blocks_instead_of_retargeting() {
        let store = VisionAutomationStore::default();
        store
            .stage(
                "run-a",
                IMAGE,
                "a record",
                utterance("next track"),
                "Expected observation",
            )
            .await;
        assert_eq!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "Forged observation"))
                .await,
            PendingActionResult::Blocked
        );
        assert_eq!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "Expected observation"))
                .await,
            PendingActionResult::NoMatch
        );
    }

    #[tokio::test]
    async fn malformed_same_run_continuation_is_consumed_and_never_falls_through() {
        let store = VisionAutomationStore::default();
        store
            .stage(
                "run-a",
                IMAGE,
                "a record",
                utterance("resume music"),
                "Matched",
            )
            .await;
        let mut malformed = chain_request("run-a", "Matched");
        malformed
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .parent_identifier = "unrelated-action".into();
        assert_eq!(
            store.consume_for_request("run-a", &malformed).await,
            PendingActionResult::Blocked
        );
        assert_eq!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "Matched"))
                .await,
            PendingActionResult::NoMatch
        );
    }

    #[tokio::test]
    async fn a_different_run_cannot_consume_the_pending_action() {
        let store = VisionAutomationStore::default();
        store
            .stage(
                "run-a",
                IMAGE,
                "a record",
                utterance("pause music"),
                "Matched",
            )
            .await;
        assert_eq!(
            store
                .consume_for_request("run-b", &chain_request("run-b", "Matched"))
                .await,
            PendingActionResult::NoMatch
        );
        assert!(matches!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "Matched"))
                .await,
            PendingActionResult::Ready { .. }
        ));
    }

    #[tokio::test]
    async fn duplicate_analysis_keeps_only_an_existing_unconsumed_one_shot() {
        let store = VisionAutomationStore::default();
        let then_utterance = utterance("next track");
        assert_eq!(
            store
                .reserve_match("run-a", IMAGE, "a record", &then_utterance)
                .await,
            MatchDecision::Fresh
        );
        store
            .stage(
                "run-a",
                IMAGE,
                "a record",
                then_utterance.clone(),
                "Matched",
            )
            .await;
        assert_eq!(
            store
                .reserve_match("run-a", IMAGE, "a record", &then_utterance)
                .await,
            MatchDecision::Duplicate
        );
        assert!(
            store
                .retain_duplicate(
                    "run-a",
                    IMAGE,
                    "a record",
                    &then_utterance,
                    "Matched differently",
                )
                .await
        );
        assert!(matches!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "Matched differently"))
                .await,
            PendingActionResult::Ready { .. }
        ));

        // A later duplicate callback after consumption may not recreate it.
        assert_eq!(
            store
                .reserve_match("run-a", IMAGE, "a record", &then_utterance)
                .await,
            MatchDecision::Consumed
        );
        assert!(
            !store
                .retain_duplicate("run-a", IMAGE, "a record", &then_utterance, "Matched")
                .await
        );
        assert_eq!(
            store
                .consume_for_request("run-a", &chain_request("run-a", "Matched"))
                .await,
            PendingActionResult::NoMatch
        );
    }

    #[tokio::test]
    async fn lock_and_exclusion_policy_is_deferred_to_the_shared_action_planners() {
        for (run_id, locked, excluded) in [
            ("locked", true, Vec::new()),
            (
                "excluded",
                false,
                vec![native_actions::PLAY_MUSIC.to_ascii_uppercase()],
            ),
        ] {
            let store = VisionAutomationStore::default();
            let then_utterance = utterance("play Teardrop");
            store
                .stage(run_id, IMAGE, "album art", then_utterance, "Matched")
                .await;
            let mut request = chain_request(run_id, "Matched");
            request.device_context.as_mut().unwrap().is_locked = locked;
            request.excluded_tools = excluded;
            let PendingActionResult::Ready { utterance, .. } =
                store.consume_for_request(run_id, &request).await
            else {
                panic!("the downstream planner must decide action-specific policy");
            };
            assert_eq!(utterance.text(), "play Teardrop");
            assert_eq!(
                store.consume_for_request(run_id, &request).await,
                PendingActionResult::NoMatch
            );
        }
    }

    #[tokio::test]
    async fn pending_actions_expire_at_the_stock_context_horizon() {
        let store = VisionAutomationStore::default();
        let now = Instant::now();
        store
            .stage_at(
                "run-a",
                IMAGE,
                "album art",
                utterance("pause music"),
                "Matched",
                now,
            )
            .await;
        assert_eq!(
            store
                .consume_for_request_at(
                    "run-a",
                    &chain_request("run-a", "Matched"),
                    now + PENDING_ACTION_TTL + Duration::from_millis(1),
                )
                .await,
            PendingActionResult::Blocked
        );
        assert_eq!(
            store
                .consume_for_request_at(
                    "run-a",
                    &chain_request("run-a", "Matched"),
                    now + PENDING_ACTION_TTL + Duration::from_millis(2),
                )
                .await,
            PendingActionResult::NoMatch
        );
    }

    #[tokio::test]
    async fn exact_image_run_dedupe_does_not_suppress_a_new_stock_run() {
        let store = VisionAutomationStore::default();
        let then_utterance = utterance("next track");
        let now = Instant::now();
        assert_eq!(
            store
                .reserve_match_at("run-a", IMAGE, "a dog", &then_utterance, now)
                .await,
            MatchDecision::Fresh
        );
        assert_eq!(
            store
                .reserve_match_at("run-a", IMAGE, "a dog", &then_utterance, now)
                .await,
            MatchDecision::Consumed
        );
        assert_eq!(
            store
                .reserve_match_at("run-b", IMAGE, "a dog", &then_utterance, now)
                .await,
            MatchDecision::Fresh
        );
        assert_eq!(
            store
                .reserve_match_at(
                    "run-a",
                    IMAGE,
                    "a dog",
                    &then_utterance,
                    now + AUTOMATION_DEDUPE_TTL + Duration::from_millis(1),
                )
                .await,
            MatchDecision::Fresh
        );
    }

    #[tokio::test]
    async fn every_automation_state_partition_has_a_hard_capacity() {
        let store = VisionAutomationStore::default();
        let now = Instant::now();
        for index in 0..(MAX_SEEN_MATCHES + 20) {
            let run_id = format!("run-{index}");
            let condition = format!("condition-{index}");
            let expected = if index < MAX_SEEN_MATCHES {
                MatchDecision::Fresh
            } else {
                MatchDecision::Capacity
            };
            assert_eq!(
                store
                    .reserve_match_at(&run_id, IMAGE, &condition, &utterance("pause music"), now,)
                    .await,
                expected
            );
        }
        for index in 0..(MAX_PENDING_ACTIONS + 10) {
            store
                .stage_at(
                    &format!("pending-{index}"),
                    IMAGE,
                    "condition",
                    utterance("next track"),
                    "Matched",
                    now,
                )
                .await;
        }

        let state = store.inner.lock().await;
        assert!(state.seen_matches.len() <= MAX_SEEN_MATCHES);
        assert!(state.pending.len() <= MAX_PENDING_ACTIONS);
    }

    #[test]
    fn only_an_immediate_parent_linked_non_final_stock_observation_is_accepted() {
        let request = chain_request("run-a", "Matched");
        let chain = immediate_vision_observation_chain("run-a", &request).unwrap();
        assert_eq!(chain.parent_identifier, "vision-observation");

        let mut unlinked = request.clone();
        unlinked
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap()
            .parent_identifier = "other-action".into();
        assert!(immediate_vision_observation_chain("run-a", &unlinked).is_none());

        let mut final_observation = request;
        let turn = final_observation
            .device_context
            .as_mut()
            .unwrap()
            .turns
            .last_mut()
            .unwrap();
        let synapse_chat_turn::Content::Observation(observation) = turn.content.as_mut().unwrap()
        else {
            unreachable!()
        };
        observation.is_final = true;
        assert!(immediate_vision_observation_chain("run-a", &final_observation).is_none());

        let mut forged_roles = chain_request("run-a", "Matched");
        forged_roles.device_context.as_mut().unwrap().turns[0].user = SynapseUser::Assistant as i32;
        assert!(immediate_vision_observation_chain("run-a", &forged_roles).is_none());

        let mut payload_injected = chain_request("run-a", "Matched");
        let synapse_chat_turn::Content::Action(action) =
            payload_injected.device_context.as_mut().unwrap().turns[1]
                .content
                .as_mut()
                .unwrap()
        else {
            unreachable!()
        };
        action.device_payload = "untrusted".into();
        assert!(immediate_vision_observation_chain("run-a", &payload_injected).is_none());
    }
}
