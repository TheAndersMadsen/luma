//! Process-local mirror of Android's authoritative `humane_food_enabled`
//! Settings.Global gate. The feature-flag API refreshes it and orders its own
//! Settings.Global writes through it.

use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

const FOOD_RUNTIME_GATE_MAX_AGE: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FoodRuntimeGateValue {
    Unknown,
    Disabled,
    Enabled,
}

#[derive(Clone, Copy, Debug)]
struct FoodRuntimeGateState {
    value: FoodRuntimeGateValue,
    observed_at: Option<Instant>,
    generation: u64,
}

#[derive(Debug, Default)]
struct FoodGatePublicationCoordinator {
    epoch: u64,
    active_mutation: Option<u64>,
}

struct FoodRuntimeGateInner {
    state: watch::Sender<FoodRuntimeGateState>,
    publication: StdMutex<FoodGatePublicationCoordinator>,
    max_age: Duration,
}

/// Process-local mirror of the authoritative Android Settings.Global food
/// gate. Unknown, disabled, and stale observations all fail closed. Refresh
/// and mutation tickets order asynchronous bridge results without retaining a
/// lock across Android or provider I/O.
#[derive(Clone)]
pub(crate) struct FoodRuntimeGate {
    inner: Arc<FoodRuntimeGateInner>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct FoodRuntimePermit {
    generation: u64,
}

pub(crate) struct FoodGateRefresh {
    gate: FoodRuntimeGate,
    epoch: u64,
}

pub(crate) struct FoodGateMutation {
    gate: FoodRuntimeGate,
    epoch: u64,
    finished: bool,
}

impl Default for FoodRuntimeGate {
    fn default() -> Self {
        Self::new(FOOD_RUNTIME_GATE_MAX_AGE)
    }
}

impl FoodRuntimeGate {
    fn new(max_age: Duration) -> Self {
        let (state, _) = watch::channel(FoodRuntimeGateState {
            value: FoodRuntimeGateValue::Unknown,
            observed_at: None,
            generation: 0,
        });
        Self {
            inner: Arc::new(FoodRuntimeGateInner {
                state,
                publication: StdMutex::new(FoodGatePublicationCoordinator::default()),
                max_age,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_max_age(max_age: Duration) -> Self {
        Self::new(max_age)
    }

    /// Reserve an ordered readback publication. A refresh started before a
    /// mutation can never overwrite the mutation's newer unknown/readback.
    pub(crate) fn begin_refresh(&self) -> Option<FoodGateRefresh> {
        let mut publication = self
            .inner
            .publication
            .lock()
            .expect("food gate publication coordinator poisoned");
        if publication.active_mutation.is_some() {
            return None;
        }
        publication.epoch = publication.epoch.saturating_add(1);
        Some(FoodGateRefresh {
            gate: self.clone(),
            epoch: publication.epoch,
        })
    }

    /// Invalidate every existing permit synchronously before the canonical API
    /// starts a Settings.Global write. Drop keeps the mirror unknown on every
    /// early-return or ambiguous bridge failure.
    pub(crate) fn begin_mutation(&self) -> FoodGateMutation {
        let mut publication = self
            .inner
            .publication
            .lock()
            .expect("food gate publication coordinator poisoned");
        publication.epoch = publication.epoch.saturating_add(1);
        let epoch = publication.epoch;
        publication.active_mutation = Some(epoch);
        // Keep the coordinator while changing the watch value. This is a
        // synchronous in-memory publication, not Android/provider I/O, and it
        // makes reservation plus invalidation one atomic ordering point.
        self.publish_state(None);
        drop(publication);
        FoodGateMutation {
            gate: self.clone(),
            epoch,
            finished: false,
        }
    }

    fn finish_refresh(&self, epoch: u64, value: Option<bool>) {
        let publication = self
            .inner
            .publication
            .lock()
            .expect("food gate publication coordinator poisoned");
        if publication.active_mutation.is_none() && publication.epoch == epoch {
            self.publish_state(value);
        }
    }

    fn finish_mutation(&self, epoch: u64, value: Option<bool>) {
        let mut publication = self
            .inner
            .publication
            .lock()
            .expect("food gate publication coordinator poisoned");
        if publication.active_mutation == Some(epoch) && publication.epoch == epoch {
            self.publish_state(value);
            publication.active_mutation = None;
        }
    }

    fn publish_state(&self, value: Option<bool>) {
        let value = match value {
            Some(true) => FoodRuntimeGateValue::Enabled,
            Some(false) => FoodRuntimeGateValue::Disabled,
            None => FoodRuntimeGateValue::Unknown,
        };
        let observed_at = (value != FoodRuntimeGateValue::Unknown).then(Instant::now);
        self.inner.state.send_modify(|state| {
            if state.value != value || value == FoodRuntimeGateValue::Unknown {
                state.generation = state.generation.saturating_add(1);
            }
            state.value = value;
            state.observed_at = observed_at;
        });
    }

    pub(crate) fn permit(&self) -> Option<FoodRuntimePermit> {
        let state = *self.inner.state.borrow();
        self.state_is_enabled_and_fresh(&state)
            .then_some(FoodRuntimePermit {
                generation: state.generation,
            })
    }

    pub(crate) fn permit_is_current(&self, permit: FoodRuntimePermit) -> bool {
        let state = *self.inner.state.borrow();
        state.generation == permit.generation && self.state_is_enabled_and_fresh(&state)
    }

    fn state_is_enabled_and_fresh(&self, state: &FoodRuntimeGateState) -> bool {
        state.value == FoodRuntimeGateValue::Enabled
            && state.observed_at.is_some_and(|observed_at| {
                Instant::now().saturating_duration_since(observed_at) <= self.inner.max_age
            })
    }

    /// Cancel provider/model work as soon as the mirror is invalidated, is
    /// disabled, or ages past its bounded lease. A final generation check also
    /// prevents an old positive future from publishing after revocation.
    pub(crate) async fn run_while_enabled<F>(
        &self,
        permit: FoodRuntimePermit,
        future: F,
    ) -> Option<F::Output>
    where
        F: Future,
    {
        tokio::pin!(future);
        let mut changes = self.inner.state.subscribe();
        loop {
            if !self.permit_is_current(permit) {
                return None;
            }
            let observed_at = changes.borrow_and_update().observed_at?;
            let deadline = observed_at + self.inner.max_age;
            tokio::select! {
                result = &mut future => {
                    return self.permit_is_current(permit).then_some(result);
                }
                changed = changes.changed() => {
                    if changed.is_err() {
                        return None;
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn enable_for_test(&self) {
        let refresh = self.begin_refresh().expect("no test mutation in progress");
        refresh.publish(Some(true));
    }
}

impl FoodGateRefresh {
    pub(crate) fn publish(self, value: Option<bool>) {
        self.gate.finish_refresh(self.epoch, value);
    }
}

impl FoodGateMutation {
    pub(crate) fn publish(mut self, value: Option<bool>) {
        self.gate.finish_mutation(self.epoch, value);
        self.finished = true;
    }
}

impl Drop for FoodGateMutation {
    fn drop(&mut self) {
        if !self.finished {
            self.gate.finish_mutation(self.epoch, None);
        }
    }
}

/// Stock-compatible Food AIBus handler.
///
/// Visual identification is produced by the operator-selected image model,
/// but nutrition values are accepted only from the separately consent-gated

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn runtime_gate_fails_closed_for_unknown_disabled_and_stale_observations() {
        let gate = FoodRuntimeGate::with_max_age(Duration::from_secs(5));
        assert!(gate.permit().is_none());

        gate.begin_refresh().unwrap().publish(Some(false));
        assert!(gate.permit().is_none());

        gate.begin_refresh().unwrap().publish(Some(true));
        let permit = gate.permit().expect("fresh enabled readback");
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(gate.permit().is_none());
        assert!(!gate.permit_is_current(permit));
    }
}
