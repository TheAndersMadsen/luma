//! Per-turn diagnostic trace: one durable record of how the agentic system
//! decided what to do.
//!
//! ## Why this exists
//!
//! The runtime already emits good ephemeral markers ("<<< hermes tool executed",
//! "<<< music target not grounded", …), but diagnosing a real complaint means
//! grepping six different markers out of logcat and reconstructing the turn by
//! hand — and logcat rolls, so the evidence for "it did the wrong thing five
//! minutes ago" is usually already gone. `LlmRequestLogger` persists, but it
//! records only `{role, characters}`: enough for latency, useless for "why did
//! it refuse".
//!
//! A turn trace is **one JSON line per turn** containing the ordered decision
//! chain. It answers, without a rebuild and without a live device:
//!   - what the model was asked and what it chose at each step
//!   - which tools ran, with what outcome and latency
//!   - **which gate refused, and on what shape of input** — the class of fact
//!     that took a live reproduction to recover the last time
//!   - what the wearer actually heard
//!
//! ## Privacy posture
//!
//! Shapes and counts are always safe to record. Free text (utterance, tool
//! arguments, spoken answer) is recorded **only** when `include_content` is
//! explicitly enabled, and that flag defaults to off at every level. The
//! existing bounded-shape markers took the same position deliberately; this
//! module keeps it rather than quietly widening it.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// How much of a turn a trace is allowed to hold. A runaway loop must not be
/// able to grow one record without bound.
const MAX_EVENTS_PER_TURN: usize = 256;

/// Free text is truncated to this many characters before it is recorded, and
/// only when content capture is on.
const MAX_RECORDED_TEXT_CHARS: usize = 512;

/// One step in the decision chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TraceEvent {
    /// A model call: what it cost and what it decided to do next.
    ModelStep {
        iteration: u32,
        provider: String,
        model: String,
        latency_ms: u64,
        prompt_chars: usize,
        completion_chars: usize,
        /// Tool names the model asked for. Empty means it answered in text.
        tool_calls: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// A tool execution and its outcome.
    ToolCall {
        ordinal: u32,
        tool: String,
        latency_ms: u64,
        ok: bool,
        /// Bounded outcome label (`ok`, `unavailable`, `invalid`, …).
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<String>,
    },
    /// A guard that allowed or refused something, and the shape it judged.
    ///
    /// This is the event the previous instrumentation was missing. A refusal
    /// must always say which gate fired and enough bounded shape to tell
    /// "nothing was extracted" apart from "something was extracted but did not
    /// satisfy the rule".
    GateDecision {
        gate: String,
        allowed: bool,
        /// Stable machine reason, e.g. `music_target_not_grounded`.
        reason: String,
        /// Bounded numeric shape, e.g. `targets=1 requested_words=2`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        shape: Vec<(String, i64)>,
    },
    /// How the turn ended.
    Terminal {
        /// `respond`, a native action name, `decline`, or `error`.
        outcome: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<String>,
        spoken_chars: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        spoken_text: Option<String>,
    },
    /// Something notable that does not fit above (kept deliberately rare).
    Note {
        marker: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        shape: Vec<(String, i64)>,
    },
}

/// The finished record written for one turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnTraceRecord {
    pub correlation: String,
    pub started_at: String,
    pub duration_ms: u64,
    pub utterance_chars: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utterance: Option<String>,
    pub events: Vec<TraceEvent>,
    /// True when the event list hit `MAX_EVENTS_PER_TURN` and stopped growing,
    /// so a truncated trace is never mistaken for a short turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// What a trace is permitted to record.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TracePolicy {
    /// Master switch. Off means every recording call is a cheap no-op.
    pub enabled: bool,
    /// Whether free text may be recorded. Independent of `enabled`, and off by
    /// default: shapes are diagnostic for most faults, text is not required.
    pub include_content: bool,
}

/// Collects the decision chain for a single turn.
///
/// Cloneable and cheap to pass down through the turn: all clones append to the
/// same buffer, so a tool executor deep in the call tree records into the same
/// trace as the loop that invoked it. When disabled it holds no buffer at all.
#[derive(Debug, Clone)]
pub struct TurnTracer {
    inner: Option<Arc<TracerInner>>,
}

#[derive(Debug)]
struct TracerInner {
    policy: TracePolicy,
    correlation: String,
    started_at: String,
    start: Instant,
    utterance_chars: usize,
    utterance: Option<String>,
    events: Mutex<Vec<TraceEvent>>,
    truncated: Mutex<bool>,
}

impl TurnTracer {
    /// A tracer that records nothing. Every method is a no-op and no buffer is
    /// allocated, so leaving calls in hot paths costs an `Option` check.
    pub fn disabled() -> Self {
        Self { inner: None }
    }

    pub fn new(
        policy: TracePolicy,
        correlation: &str,
        utterance: &str,
        started_at: String,
    ) -> Self {
        if !policy.enabled {
            return Self::disabled();
        }
        Self {
            inner: Some(Arc::new(TracerInner {
                policy,
                correlation: correlation.to_string(),
                started_at,
                start: Instant::now(),
                utterance_chars: utterance.chars().count(),
                utterance: policy.include_content.then(|| bounded_text(utterance)),
                events: Mutex::new(Vec::new()),
                truncated: Mutex::new(false),
            })),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.is_some()
    }

    /// True when free text may be recorded. Callers that would have to do work
    /// to produce the text (serialising arguments, say) should check this first
    /// rather than building a string the tracer will drop.
    pub fn records_content(&self) -> bool {
        self.inner
            .as_ref()
            .is_some_and(|inner| inner.policy.include_content)
    }

    /// Prepare free text for recording: `None` when content capture is off,
    /// otherwise the text bounded to a sane length.
    pub fn content(&self, text: &str) -> Option<String> {
        self.records_content().then(|| bounded_text(text))
    }

    pub fn record(&self, event: TraceEvent) {
        let Some(inner) = self.inner.as_ref() else {
            return;
        };
        let mut events = lock_recovering(&inner.events);
        if events.len() >= MAX_EVENTS_PER_TURN {
            *lock_recovering(&inner.truncated) = true;
            return;
        }
        events.push(event);
    }

    /// Record a guard decision. The common case — a refusal with bounded shape.
    pub fn gate(&self, gate: &str, allowed: bool, reason: &str, shape: &[(&str, i64)]) {
        if self.inner.is_none() {
            return;
        }
        self.record(TraceEvent::GateDecision {
            gate: gate.to_string(),
            allowed,
            reason: reason.to_string(),
            shape: shape.iter().map(|(k, v)| ((*k).to_string(), *v)).collect(),
        });
    }

    /// Finish the turn. Returns `None` when tracing was disabled.
    pub fn finish(&self) -> Option<TurnTraceRecord> {
        let inner = self.inner.as_ref()?;
        Some(TurnTraceRecord {
            correlation: inner.correlation.clone(),
            started_at: inner.started_at.clone(),
            duration_ms: inner.start.elapsed().as_millis() as u64,
            utterance_chars: inner.utterance_chars,
            utterance: inner.utterance.clone(),
            events: lock_recovering(&inner.events).clone(),
            truncated: *lock_recovering(&inner.truncated),
        })
    }
}

/// Take a lock, recovering from poisoning rather than propagating it.
///
/// Diagnostics must never turn one panic into two: if some other thread died
/// mid-turn, that is precisely the moment the trace is most worth having.
fn lock_recovering<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Bound free text to `MAX_RECORDED_TEXT_CHARS`, on a char boundary.
///
/// Deliberately char-based, not byte-based: this repository has shipped two
/// separate panics from byte-slicing user-influenced strings that turned out to
/// hold emoji or accented Latin.
fn bounded_text(text: &str) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth(MAX_RECORDED_TEXT_CHARS) {
        Some((boundary, _)) => format!("{}…", &trimmed[..boundary]),
        None => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(enabled: bool, content: bool) -> TracePolicy {
        TracePolicy {
            enabled,
            include_content: content,
        }
    }

    #[test]
    fn a_disabled_tracer_records_nothing_and_yields_no_record() {
        let tracer = TurnTracer::new(policy(false, true), "c1", "play some jazz", "t".into());
        tracer.gate("music_grounding", false, "not_grounded", &[("targets", 1)]);
        assert!(!tracer.is_enabled());
        assert!(tracer.finish().is_none());
    }

    #[test]
    fn shapes_are_recorded_without_content_by_default() {
        let tracer = TurnTracer::new(policy(true, false), "c2", "play the best one", "t".into());
        tracer.gate(
            "music_grounding",
            false,
            "music_target_not_grounded",
            &[("targets", 1), ("requested_words", 2)],
        );
        let record = tracer.finish().expect("enabled tracer yields a record");
        assert_eq!(record.utterance_chars, 17);
        assert!(
            record.utterance.is_none(),
            "content capture is off, so the utterance text must not be recorded"
        );
        match &record.events[0] {
            TraceEvent::GateDecision {
                gate,
                allowed,
                reason,
                shape,
            } => {
                assert_eq!(gate, "music_grounding");
                assert!(!allowed);
                assert_eq!(reason, "music_target_not_grounded");
                assert_eq!(shape[0], ("targets".to_string(), 1));
            }
            other => panic!("expected a gate decision, got {other:?}"),
        }
    }

    #[test]
    fn content_capture_records_text_only_when_enabled() {
        let tracer = TurnTracer::new(policy(true, true), "c3", "play some jazz", "t".into());
        assert!(tracer.records_content());
        assert_eq!(tracer.content("hello").as_deref(), Some("hello"));
        let record = tracer.finish().expect("record");
        assert_eq!(record.utterance.as_deref(), Some("play some jazz"));
    }

    #[test]
    fn clones_append_to_the_same_turn() {
        // A tool executor several layers down holds a clone; its events must
        // land in the same trace as the loop that called it.
        let tracer = TurnTracer::new(policy(true, false), "c4", "x", "t".into());
        let deep = tracer.clone();
        deep.gate("a", true, "ok", &[]);
        tracer.gate("b", false, "no", &[]);
        assert_eq!(tracer.finish().expect("record").events.len(), 2);
    }

    #[test]
    fn a_runaway_turn_is_truncated_and_says_so() {
        let tracer = TurnTracer::new(policy(true, false), "c5", "x", "t".into());
        for _ in 0..(MAX_EVENTS_PER_TURN + 25) {
            tracer.gate("g", true, "ok", &[]);
        }
        let record = tracer.finish().expect("record");
        assert_eq!(record.events.len(), MAX_EVENTS_PER_TURN);
        assert!(
            record.truncated,
            "a truncated trace must not look like a short turn"
        );
    }

    #[test]
    fn recorded_text_is_bounded_on_a_char_boundary() {
        // Multi-byte characters straddling the cut must not panic.
        let long = "é".repeat(MAX_RECORDED_TEXT_CHARS + 40);
        let tracer = TurnTracer::new(policy(true, true), "c6", &long, "t".into());
        let recorded = tracer.finish().expect("record").utterance.expect("text");
        assert!(recorded.ends_with('…'));
        assert_eq!(recorded.chars().count(), MAX_RECORDED_TEXT_CHARS + 1);
    }
}
