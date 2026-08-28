//! Shared policy for one latency-sensitive foreground assistant run.
//!
//! Legacy server streaming and bidirectional streaming have different wire
//! mechanics, but they must not invent separate deadline, route, or telemetry
//! semantics. This module is the small interface both transports cross.

use std::time::{Duration, Instant};

use super::llm::ModelProvenance;

/// Normal foreground budget. Stock currently gives the server more headroom,
/// but 22 seconds is the product target and preserves time to settle on-device.
pub const FOREGROUND_BUDGET: Duration = Duration::from_secs(22);
/// Ceiling for one model round trip inside the whole-run budget.
pub const MODEL_STEP_LIMIT: Duration = Duration::from_secs(15);
/// Do not start work when there is not enough time to emit a terminal frame.
pub const TERMINAL_RESERVE: Duration = Duration::from_millis(750);
/// A remaining interval below this is useful only for a terminal response.
pub const MIN_USEFUL_REMAINING: Duration = Duration::from_millis(500);
/// Personal context is an optimization, not permission to consume the turn.
pub const CONTEXT_LOAD_LIMIT: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Transport {
    Legacy,
    Bidi,
}

impl Transport {
    fn label(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Bidi => "bidi",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteClass {
    /// Closed server workflow; no model reasoning is credited.
    D1,
    /// One bounded semantic model-led task.
    A1,
    /// Bounded compound task with multiple dependent or parallel operations.
    A2,
}

impl RouteClass {
    fn label(self) -> &'static str {
        match self {
            Self::D1 => "d1",
            Self::A1 => "a1",
            Self::A2 => "a2",
        }
    }
}

/// Content-free state for one production-plane foreground run.
///
/// Dropping it records exactly one bounded telemetry event, including runs
/// superseded or abandoned before a terminal action. It contains no utterance,
/// tool arguments, observations, wearer identity, or device identifier.
pub struct ForegroundRun {
    transport: Transport,
    route: RouteClass,
    started: Instant,
    deadline: Instant,
    model_steps: usize,
    tool_calls: usize,
    model: ModelProvenance,
    terminal: &'static str,
}

impl ForegroundRun {
    pub fn production(transport: Transport, route: RouteClass) -> Self {
        Self::with_budget(transport, route, FOREGROUND_BUDGET)
    }

    pub fn with_budget(transport: Transport, route: RouteClass, budget: Duration) -> Self {
        let started = Instant::now();
        Self {
            transport,
            route,
            started,
            deadline: started + budget,
            model_steps: 0,
            tool_calls: 0,
            model: ModelProvenance {
                provider: "unreported".to_owned(),
                model: "unreported".to_owned(),
                speed: "unreported".to_owned(),
                effort: "unreported".to_owned(),
            },
            terminal: "interrupted",
        }
    }

    pub fn with_model(mut self, model: ModelProvenance) -> Self {
        self.model = model;
        self
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub fn model_timeout(&self) -> Duration {
        self.remaining()
            .saturating_sub(TERMINAL_RESERVE)
            .min(MODEL_STEP_LIMIT)
    }

    pub fn context_timeout(&self) -> Duration {
        self.model_timeout().min(CONTEXT_LOAD_LIMIT)
    }

    pub fn note_model_step(&mut self) {
        self.model_steps = self.model_steps.saturating_add(1);
    }

    pub fn note_tool_calls(&mut self, count: usize) {
        self.tool_calls = self.tool_calls.saturating_add(count);
        if self.route == RouteClass::A1 && self.tool_calls > 1 {
            self.route = RouteClass::A2;
        }
    }

    pub fn finish(&mut self, terminal: &'static str) {
        self.terminal = terminal;
    }

    pub fn supersede(&mut self) {
        self.terminal = "superseded";
    }
}

impl Drop for ForegroundRun {
    fn drop(&mut self) {
        let model_steps = match self.model_steps {
            0 => "0",
            1 => "1",
            2 => "2",
            _ => "3_plus",
        };
        let model_invoked = if self.model_steps == 0 {
            "false"
        } else {
            "true"
        };
        crate::metrics::record_agent_run(crate::metrics::AgentRunMetric {
            transport: self.transport.label(),
            route: self.route.label(),
            model_invoked,
            model_steps,
            model_provider: &self.model.provider,
            model: &self.model.model,
            model_speed: &self.model.speed,
            reasoning_effort: &self.model.effort,
            terminal: self.terminal,
            elapsed: self.started.elapsed(),
        });
        tracing::info!(
            planner_plane = "cosmos_remote",
            transport = self.transport.label(),
            route_class = self.route.label(),
            model_invoked,
            model_steps,
            tool_calls = self.tool_calls,
            model_provider = self.model.provider,
            model = self.model.model,
            model_speed = self.model.speed,
            reasoning_effort = self.model.effort,
            terminal = self.terminal,
            elapsed_ms = self.started.elapsed().as_millis(),
            "assistant foreground run completed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_foreground_run_shares_one_absolute_budget_and_only_upgrades_to_compound() {
        let mut run =
            ForegroundRun::with_budget(Transport::Legacy, RouteClass::A1, Duration::from_secs(2));
        assert!(run.remaining() <= Duration::from_secs(2));
        assert!(run.model_timeout() <= Duration::from_millis(1_250));
        run.note_model_step();
        run.note_tool_calls(1);
        assert_eq!(run.route, RouteClass::A1);
        run.note_tool_calls(1);
        assert_eq!(run.route, RouteClass::A2);
        run.finish("answered");
    }

    #[test]
    fn deterministic_runs_cannot_be_misreported_as_model_reasoning() {
        let run =
            ForegroundRun::with_budget(Transport::Bidi, RouteClass::D1, Duration::from_secs(1));
        assert_eq!(run.model_steps, 0);
        assert_eq!(run.route, RouteClass::D1);
    }
}
