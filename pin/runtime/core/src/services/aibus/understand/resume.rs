//! Suspended-turn persistence: the agentic resume store, the per-turn context
//! bundle, turn-trace flushing, and the local-weather trace store.

use super::*;

#[derive(Clone, Default)]
pub(super) struct AgenticResumeStore {
    pub(super) pending: Arc<Mutex<HashMap<String, PendingAgenticResume>>>,
}

pub(super) struct PendingAgenticResume {
    pub(super) stored_at: Instant,
    pub(super) original_utterance: String,
    pub(super) original_parent: String,
    pub(super) resume: AgenticResumeState,
    /// The suspended chat-turn transcript captured at preflight time. Present
    /// only when the preflight was produced inside a bidirectional streaming
    /// session; the legacy unary continuation never stores or consumes one
    /// and keeps its proven fresh-replan behavior.
    pub(super) chat_turn_suspension: Option<Box<ChatTurnSuspension>>,
}

/// Borrowed per-turn request context threaded through the AIBus orchestration
/// methods. Bundles the identity fields shared by every turn so each method
/// takes one `ctx` instead of five loose arguments; it is `Copy` so it can be
/// forwarded to nested calls without reborrowing.
#[derive(Clone, Copy)]
pub(super) struct TurnContext<'a> {
    pub(super) req: &'a SynapseUnderstandingRequest,
    pub(super) run_id: &'a str,
    pub(super) utterance: &'a str,
    pub(super) response_parent: &'a str,
    pub(super) is_vision: bool,
}

pub(super) enum AgenticResumeResult {
    // Boxed: `AgenticResumeState` carries a full `LoopState`, dwarfing the unit variants.
    // The second slot is the suspended chat-turn transcript; it is only ever
    // `Some` for a continuation claimed by a bidirectional streaming turn.
    Ready(Box<AgenticResumeState>, Option<Box<ChatTurnSuspension>>),
    Blocked,
    NoMatch,
}

/// Whether one understanding turn may capture or resume the in-session chat-turn
/// transcript. The transcript optimization is exclusive to the bidirectional
/// streaming endpoint (itself reachable only while the device-side
/// `synapse_bidirectional_streaming` flag is enabled — both `penumbra_default`
/// and `firmware_default` are off, so the trial default is an explicit
/// operator override; see `runtime/core/src/feature_flags.rs`): legacy
/// unary turns never capture a suspension and never receive one, so the
/// proven unary fresh-replan continuation is unchanged.
pub(super) enum ChatTurnSessionContinuity {
    /// Legacy unary turn (default): fresh chat-turn run; any staged suspension
    /// for this continuation was already dropped at claim time.
    Unary,
    /// A turn served by `BidirectionalStreamingUnderstand`. A device
    /// preflight may capture the live transcript, and a validated
    /// continuation carries the claimed suspension back to resume mid-plan.
    Streaming(Option<Box<ChatTurnSuspension>>),
}

/// Close out a turn trace and hand it to the rolling JSONL sink.
///
/// Resolves the directory the same way `main.rs` resolves the LLM request log,
/// so traces roll beside it under one retention policy. Cheap and inert when
/// tracing is off: `finish()` yields `None` and the logger is never built.
pub(super) fn flush_turn_trace_to(
    log_dir: Option<&str>,
    tracer: &crate::turn_trace::TurnTracer,
    policy: crate::turn_trace::TracePolicy,
) {
    let Some(record) = tracer.finish() else {
        return;
    };
    let directory = log_dir
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("logs"));
    crate::turn_trace_log::TurnTraceLogger::new(directory).record(policy, record);
}

impl AgenticResumeStore {
    pub(super) fn stage(
        &self,
        action_identifier: &str,
        original_parent: &str,
        utterance: &str,
        resume: AgenticResumeState,
        chat_turn_suspension: Option<Box<ChatTurnSuspension>>,
    ) -> bool {
        if action_identifier.trim().is_empty()
            || original_parent.trim().is_empty()
            || resume.expected_action() != native_actions::GET_CURRENT_LOCATION
        {
            return false;
        }

        let now = Instant::now();
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.retain(|_, entry| now.duration_since(entry.stored_at) <= AGENTIC_RESUME_TTL);
        if pending.len() >= AGENTIC_RESUME_MAX_ENTRIES && !pending.contains_key(action_identifier) {
            if let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, entry)| entry.stored_at)
                .map(|(identifier, _)| identifier.clone())
            {
                pending.remove(&oldest);
            }
        }
        pending.insert(
            action_identifier.to_string(),
            PendingAgenticResume {
                stored_at: now,
                original_utterance: normalize_utterance(utterance),
                original_parent: original_parent.to_string(),
                resume,
                chat_turn_suspension,
            },
        );
        true
    }

    /// `streaming_claim` is true only when the continuation arrives on the
    /// bidirectional streaming endpoint; a unary continuation drops any stored
    /// transcript so its behavior stays identical to the pre-suspension path.
    pub(super) fn consume_for_request(
        &self,
        request: &SynapseUnderstandingRequest,
        location_state: &CurrentLocationFetchState,
        streaming_claim: bool,
    ) -> AgenticResumeResult {
        if request_device_lock_state(request) != DeviceLockState::Unlocked {
            return self.revoke_for_restricted_request(request);
        }
        let actions = current_user_location_actions(request);
        let marked_identifiers = agentic_location_marker_identifiers(request);
        if actions.is_empty() && marked_identifiers.is_empty() {
            return AgenticResumeResult::NoMatch;
        }

        let now = Instant::now();
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.retain(|_, entry| now.duration_since(entry.stored_at) <= AGENTIC_RESUME_TTL);

        let matching_identifiers = actions
            .iter()
            .filter(|(identifier, _)| pending.contains_key(*identifier))
            .map(|(identifier, _)| (*identifier).to_string())
            .collect::<Vec<_>>();
        let has_agentic_marker = !marked_identifiers.is_empty();
        if matching_identifiers.len() != 1 {
            if has_agentic_marker {
                for (identifier, _) in actions {
                    pending.remove(identifier);
                }
                for identifier in marked_identifiers {
                    pending.remove(identifier);
                }
                return AgenticResumeResult::Blocked;
            }
            return AgenticResumeResult::NoMatch;
        }

        let identifier = &matching_identifiers[0];
        let Some(entry) = pending.remove(identifier) else {
            return AgenticResumeResult::Blocked;
        };
        let Some((_, current_user, _)) = trusted_current_user_request(request) else {
            return AgenticResumeResult::Blocked;
        };
        if entry.original_parent != current_user.identifier
            || entry.original_utterance != normalize_utterance(&request.utterance)
        {
            return AgenticResumeResult::Blocked;
        }
        if matches!(location_state, CurrentLocationFetchState::Fresh(_)) {
            let suspension = if streaming_claim {
                entry.chat_turn_suspension
            } else {
                None
            };
            AgenticResumeResult::Ready(Box::new(entry.resume), suspension)
        } else {
            AgenticResumeResult::Blocked
        }
    }

    /// Remove a matching one-shot without inspecting or promoting its location
    /// observation. This closes the unlocked-preflight -> locked-continuation
    /// transition and prevents a later replay after the device unlocks again.
    pub(super) fn revoke_for_restricted_request(
        &self,
        request: &SynapseUnderstandingRequest,
    ) -> AgenticResumeResult {
        let identifiers = current_user_location_actions(request)
            .into_iter()
            .map(|(identifier, _)| identifier.to_string())
            .chain(
                agentic_location_marker_identifiers(request)
                    .into_iter()
                    .map(str::to_string),
            )
            .collect::<Vec<_>>();
        if identifiers.is_empty() {
            return AgenticResumeResult::NoMatch;
        }
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut removed = false;
        for identifier in identifiers {
            removed |= pending.remove(&identifier).is_some();
        }
        if removed {
            AgenticResumeResult::Blocked
        } else {
            AgenticResumeResult::NoMatch
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LocalWeatherTrace {
    pub(super) correlation: String,
    pub(super) next_ordinal: usize,
}

impl LocalWeatherTrace {
    pub(super) fn new() -> Self {
        Self {
            correlation: uuid::Uuid::new_v4().hyphenated().to_string(),
            next_ordinal: 1,
        }
    }

    pub(super) fn correlation(&self) -> &str {
        &self.correlation
    }

    pub(super) fn record_completed(&mut self, tool: &'static str) {
        if !matches!(
            tool,
            "current_location" | "reverse_geocode" | "current_weather" | "terminal"
        ) {
            debug_assert!(
                false,
                "local weather trace rejected a non-catalog milestone"
            );
            return;
        }
        let ordinal = self.next_ordinal;
        self.next_ordinal = self.next_ordinal.saturating_add(1);
        info!(
            correlation = %self.correlation,
            ordinal,
            tool,
            status = "completed",
            "{}",
            operational_markers::LOCAL_WEATHER_PHYSICAL_TRACE
        );
    }
}

#[derive(Clone, Default)]
pub(super) struct LocalWeatherTraceStore {
    pub(super) pending: Arc<Mutex<HashMap<String, PendingLocalWeatherTrace>>>,
}

pub(super) struct PendingLocalWeatherTrace {
    pub(super) stored_at: Instant,
    pub(super) original_utterance: String,
    pub(super) original_parent: String,
    pub(super) trace: LocalWeatherTrace,
}

pub(super) enum LocalWeatherTraceResult {
    Ready(LocalWeatherTrace),
    Blocked,
    NoMatch,
}

impl LocalWeatherTraceStore {
    pub(super) fn stage(
        &self,
        action_identifier: &str,
        original_parent: &str,
        utterance: &str,
    ) -> Option<String> {
        let action_identifier = action_identifier.trim();
        let original_parent = original_parent.trim();
        let original_utterance = normalize_utterance(utterance);
        if action_identifier.is_empty()
            || action_identifier.len() > 256
            || original_parent.is_empty()
            || original_parent.len() > 256
            || original_utterance.is_empty()
            || original_utterance.len() > 256
        {
            return None;
        }

        let now = Instant::now();
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.retain(|_, entry| now.duration_since(entry.stored_at) <= LOCAL_WEATHER_TRACE_TTL);
        if pending.len() >= LOCAL_WEATHER_TRACE_MAX_ENTRIES
            && !pending.contains_key(action_identifier)
        {
            if let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, entry)| entry.stored_at)
                .map(|(identifier, _)| identifier.clone())
            {
                pending.remove(&oldest);
            }
        }
        let trace = LocalWeatherTrace::new();
        let correlation = trace.correlation().to_string();
        pending.insert(
            action_identifier.to_string(),
            PendingLocalWeatherTrace {
                stored_at: now,
                original_utterance,
                original_parent: original_parent.to_string(),
                trace,
            },
        );
        Some(correlation)
    }

    pub(super) fn consume_for_request(
        &self,
        request: &SynapseUnderstandingRequest,
        location_state: &CurrentLocationFetchState,
    ) -> LocalWeatherTraceResult {
        if request_device_lock_state(request) != DeviceLockState::Unlocked {
            self.revoke_for_restricted_request(request);
            return LocalWeatherTraceResult::Blocked;
        }
        let actions = current_user_location_actions(request);
        if actions.is_empty() {
            return LocalWeatherTraceResult::NoMatch;
        }

        let now = Instant::now();
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.retain(|_, entry| now.duration_since(entry.stored_at) <= LOCAL_WEATHER_TRACE_TTL);
        let matching_identifiers = actions
            .iter()
            .filter(|(identifier, _)| pending.contains_key(*identifier))
            .map(|(identifier, _)| (*identifier).to_string())
            .collect::<Vec<_>>();
        if matching_identifiers.is_empty() {
            return LocalWeatherTraceResult::NoMatch;
        }
        if matching_identifiers.len() != 1 {
            for identifier in matching_identifiers {
                pending.remove(&identifier);
            }
            return LocalWeatherTraceResult::Blocked;
        }

        let identifier = &matching_identifiers[0];
        let exact_markers = local_weather_location_marker_identifiers(request);
        if !exact_markers.contains(&identifier.as_str()) {
            pending.remove(identifier);
            return LocalWeatherTraceResult::Blocked;
        }
        let Some(entry) = pending.remove(identifier) else {
            return LocalWeatherTraceResult::Blocked;
        };
        let Some((_, current_user, _)) = trusted_current_user_request(request) else {
            return LocalWeatherTraceResult::Blocked;
        };
        if entry.original_parent != current_user.identifier
            || entry.original_utterance != normalize_utterance(&request.utterance)
            || !matches!(location_state, CurrentLocationFetchState::Fresh(_))
        {
            return LocalWeatherTraceResult::Blocked;
        }
        LocalWeatherTraceResult::Ready(entry.trace)
    }

    pub(super) fn revoke_for_restricted_request(
        &self,
        request: &SynapseUnderstandingRequest,
    ) -> bool {
        let identifiers = current_user_location_actions(request)
            .into_iter()
            .map(|(identifier, _)| identifier.to_string())
            .collect::<Vec<_>>();
        if identifiers.is_empty() {
            return false;
        }
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut removed = false;
        for identifier in identifiers {
            removed |= pending.remove(&identifier).is_some();
        }
        removed
    }
}
