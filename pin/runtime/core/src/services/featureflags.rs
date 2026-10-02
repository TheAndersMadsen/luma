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
