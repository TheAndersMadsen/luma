use std::sync::{Arc, RwLock as StdRwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use prost::Message;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tonic::{Request, Response, Status};
use tracing::{error, info};

use crate::config::Config;
use crate::feature_flags::proto_assignments;
use crate::proto::featureflags::feature_flags_service_server::FeatureFlagsService;
use crate::proto::featureflags::*;

#[derive(Clone)]
pub struct FeatureFlagsServiceImpl {
    config: Arc<RwLock<Config>>,
    delivery_tracker: FeatureFlagDeliveryTracker,
}

impl FeatureFlagsServiceImpl {
    pub fn new(config: Arc<RwLock<Config>>, delivery_tracker: FeatureFlagDeliveryTracker) -> Self {
        Self {
            config,
            delivery_tracker,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FeatureFlagFetchReceipt {
    pub(crate) sequence: u64,
    pub(crate) assignment_set_hash: String,
    pub(crate) fetched_at_unix_ms: u64,
}

#[derive(Debug, Default)]
struct FeatureFlagDeliveryObservation {
    sequence: u64,
    latest_fetch: Option<FeatureFlagFetchReceipt>,
    recent_fetches: std::collections::VecDeque<FeatureFlagFetchReceipt>,
}

const MAX_RECENT_FETCH_RECEIPTS: usize = 32;

/// Process-local observation of the most recent successful stock
/// `FeatureFlags.GetFlags` response. This intentionally stops short of claiming
/// that WorkManager, the binder cache, or every consumer applied the values.
#[derive(Debug, Clone, Default)]
pub struct FeatureFlagDeliveryTracker {
    observation: Arc<StdRwLock<FeatureFlagDeliveryObservation>>,
}

impl FeatureFlagDeliveryTracker {
    pub(crate) fn record_fetch(&self, assignment_set_hash: String) {
        let fetched_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        let mut observation = match self.observation.write() {
            Ok(observation) => observation,
            Err(poisoned) => poisoned.into_inner(),
        };
        observation.sequence = observation.sequence.saturating_add(1);
        let receipt = FeatureFlagFetchReceipt {
            sequence: observation.sequence,
            assignment_set_hash,
            fetched_at_unix_ms,
        };
        observation.latest_fetch = Some(receipt.clone());
        observation.recent_fetches.push_back(receipt);
        while observation.recent_fetches.len() > MAX_RECENT_FETCH_RECEIPTS {
            observation.recent_fetches.pop_front();
        }
    }

    pub(crate) fn latest_sequence(&self) -> u64 {
        match self.observation.read() {
            Ok(observation) => observation.sequence,
            Err(poisoned) => poisoned.into_inner().sequence,
        }
    }

    #[cfg(test)]
    pub(crate) fn latest_fetch(&self) -> Option<FeatureFlagFetchReceipt> {
        match self.observation.read() {
            Ok(observation) => observation.latest_fetch.clone(),
            Err(poisoned) => poisoned.into_inner().latest_fetch.clone(),
        }
    }

    pub(crate) fn latest_matching_fetch(
        &self,
        assignment_set_hash: &str,
        after_sequence: Option<u64>,
    ) -> Option<FeatureFlagFetchReceipt> {
        let observation = match self.observation.read() {
            Ok(observation) => observation,
            Err(poisoned) => poisoned.into_inner(),
        };
        observation
            .recent_fetches
            .iter()
            .rev()
            .find(|receipt| {
                receipt.assignment_set_hash == assignment_set_hash
                    && after_sequence.is_none_or(|sequence| receipt.sequence > sequence)
            })
            .cloned()
    }
}

/// Stable digest of the complete assignment set returned to stock. Sorting by
/// the protobuf identity fields makes the digest independent of container
/// iteration order while preserving every typed wire value.
pub(crate) fn assignment_set_hash(assignments: &[FeatureFlagAssignment]) -> String {
    let mut sorted = assignments.to_vec();
    sorted.sort_by(|left, right| {
        left.flag_name
            .cmp(&right.flag_name)
            .then_with(|| left.flag_id.cmp(&right.flag_id))
    });

    let mut hasher = Sha256::new();
    hasher.update((sorted.len() as u64).to_be_bytes());
    for assignment in sorted {
        let encoded = assignment.encode_to_vec();
        hasher.update((encoded.len() as u64).to_be_bytes());
        hasher.update(encoded);
    }
    format!("{:x}", hasher.finalize())
}

#[tonic::async_trait]
impl FeatureFlagsService for FeatureFlagsServiceImpl {
    async fn get_flags(
        &self,
        _request: Request<DeviceFeatureFlagRequest>,
    ) -> Result<Response<DeviceFeatureFlagResponse>, Status> {
        info!(">>> FeatureFlags.GetFlags");

        // Build a complete snapshot while holding the read lock. The stock
        // worker treats every successful response as replacement state, so a
        // partial or accidental empty success would be destructive.
        let flags = {
            let config = self.config.read().await;
            proto_assignments(&config.feature_flags)
        }
        .map_err(|message| {
            error!(%message, "refusing invalid feature-flag response");
            Status::internal(message)
        })?;

        if flags.is_empty() {
            error!("refusing accidental empty feature-flag response");
            return Err(Status::internal(
                "refusing accidental empty feature-flag response",
            ));
        }

        let assignment_set_hash = assignment_set_hash(&flags);
        self.delivery_tracker
            .record_fetch(assignment_set_hash.clone());
        info!(
            count = flags.len(),
            %assignment_set_hash,
            "returning feature flag assignments"
        );
        Ok(Response::new(DeviceFeatureFlagResponse {
            assignment: flags,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feature_flags::{ConfiguredFeatureFlagValue, VISION_CUSTOM_GESTURE_KEY};
    use crate::proto::featureflags::feature_flag_assignment;
    use crate::tier_a::feature_flags::cloud as cloud_feature_keys;

    fn default_config() -> Config {
        let dir = tempfile::tempdir().unwrap();
        Config::load(&dir.path().join("missing.toml")).unwrap()
    }

    #[tokio::test]
    async fn reads_live_typed_assignments_from_shared_config() {
        let config = Arc::new(RwLock::new(default_config()));
        let delivery_tracker = FeatureFlagDeliveryTracker::default();
        let service = FeatureFlagsServiceImpl::new(config.clone(), delivery_tracker.clone());

        let initial = service
            .get_flags(Request::new(DeviceFeatureFlagRequest {}))
            .await
            .unwrap()
            .into_inner();
        // Assert the flag this test is about is delivered, not the total count:
        // the asserted-flag set is pinned by
        // `default_response_is_nonempty_and_preserves_vision`.
        assert!(initial
            .assignment
            .iter()
            .any(|assignment| assignment.flag_name == VISION_CUSTOM_GESTURE_KEY));

        config.write().await.feature_flags.overrides.insert(
            cloud_feature_keys::TOUCHCODE_TIMEOUT_MILLIS.into(),
            ConfiguredFeatureFlagValue::Int(7_500),
        );

        let updated = service
            .get_flags(Request::new(DeviceFeatureFlagRequest {}))
            .await
            .unwrap()
            .into_inner();
        // A newly configured override must appear in the live set. The exact
        // total is pinned by the asserted-flag guard in `feature_flags`, so
        // assert the delta rather than the count.
        assert!(updated.assignment.len() > initial.assignment.len());
        let timeout = updated
            .assignment
            .iter()
            .find(|assignment| assignment.flag_name == cloud_feature_keys::TOUCHCODE_TIMEOUT_MILLIS)
            .unwrap();
        assert_eq!(
            timeout.val,
            Some(feature_flag_assignment::Val::ValInt(7_500))
        );

        let receipt = delivery_tracker.latest_fetch().unwrap();
        assert_eq!(receipt.sequence, 2);
        assert_eq!(
            receipt.assignment_set_hash,
            assignment_set_hash(&updated.assignment)
        );
        assert!(receipt.fetched_at_unix_ms > 0);
    }

    #[test]
    fn assignment_set_hash_is_order_independent_and_value_sensitive() {
        let mut config = default_config();
        config.feature_flags.overrides.insert(
            cloud_feature_keys::TOUCHCODE_TIMEOUT_MILLIS.into(),
            ConfiguredFeatureFlagValue::Int(7_500),
        );
        let assignments = proto_assignments(&config.feature_flags).unwrap();
        let original_hash = assignment_set_hash(&assignments);

        let mut reversed = assignments.clone();
        reversed.reverse();
        assert_eq!(assignment_set_hash(&reversed), original_hash);

        let timeout = reversed
            .iter_mut()
            .find(|assignment| assignment.flag_name == cloud_feature_keys::TOUCHCODE_TIMEOUT_MILLIS)
            .unwrap();
        timeout.val = Some(feature_flag_assignment::Val::ValInt(7_501));
        assert_ne!(assignment_set_hash(&reversed), original_hash);
    }

    #[test]
    fn matching_receipt_survives_a_newer_fetch_for_an_older_snapshot() {
        let tracker = FeatureFlagDeliveryTracker::default();
        tracker.record_fetch("target".into());
        tracker.record_fetch("older-snapshot".into());

        assert_eq!(
            tracker.latest_fetch().unwrap().assignment_set_hash,
            "older-snapshot"
        );
        let target = tracker
            .latest_matching_fetch("target", Some(0))
            .expect("bounded history must retain the matching target receipt");
        assert_eq!(target.sequence, 1);
        assert!(tracker.latest_matching_fetch("target", Some(1)).is_none());
    }

    #[test]
    fn receipt_history_is_strictly_bounded() {
        let tracker = FeatureFlagDeliveryTracker::default();
        for sequence in 0..(MAX_RECENT_FETCH_RECEIPTS + 3) {
            tracker.record_fetch(format!("hash-{sequence}"));
        }

        assert!(tracker.latest_matching_fetch("hash-0", None).is_none());
        assert!(tracker
            .latest_matching_fetch(&format!("hash-{}", MAX_RECENT_FETCH_RECEIPTS + 2), None,)
            .is_some());
    }
}
