//! Each account's own Settings → Features choices.
//!
//! humane.center kept these per account, not one set for the whole cloud:
//!
//! - The Pin asks for its flags with an empty `DeviceFeatureFlagRequest` on its
//!   device-credential channel (`FeatureFlagSyncWorker.fetchFlagsFromServer`,
//!   `ChannelFactory(GatewayType.API, …, DeviceCredentialKeyManagersFactory)`).
//!   The only input the cloud's answer had was which Pin, and so which
//!   account, was asking.
//! - A `humane.feature-flags` push makes the receiving Pin fetch its flags at
//!   once (`CentralPushReceiver.handleMessage` →
//!   `FeatureFlagSyncScheduler.scheduleImmediateFlagSync`). Otherwise it fetches
//!   once a day (`FeatureFlagSyncScheduler.SYNC_INTERVAL`). A push goes to one
//!   account's Pins, which is how a change on the web reached that wearer's Pin
//!   right away.
//! - humane.center listed Features in the wearer's own Settings → Ai Pin group
//!   (`menu-features-link`, `/settings/account/features`), beside My Ai Pin,
//!   Services, Contacts and Privacy, and its `center` Keycloak client asked for
//!   the `feature-flags` scope, so the wearer's own token reached the flag
//!   service. Its web-side flags were per-user allowlists
//!   (`healthPage.split(",").includes(session.user.id)` in the recovered
//!   `api-client.js`), and its release notes shipped Vision Q&A to a "Beta
//!   program only".
//!
//! Which features that page offered and the calls it made were not recovered,
//! so [`FEATURES`] and the web routes in `feature_flags_api` are INFERRED: they
//! are the stock `FeatureFlagManager.Feature` keys with a known Pin consumer.
//!
//! The values `services::feature_flags` builds stay the evidence (what live
//! cosmos served, or what this deployment hosts). A choice is stored beside
//! them, one `FeatureFlagOverrides` blob per account, never edited into them,
//! so clearing it restores this server's default exactly.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::store::{AccountBlobKind, SharedStore, StoreError};

/// A flag value, mirroring the three arms the device's `requireType` accepts.
/// Sending the wrong arm makes the stock client throw, so the type is preserved
/// across a choice rather than inferred from the new value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum FlagValue {
    Bool(bool),
    Int(i64),
    Text(String),
}

impl FlagValue {
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Bool(_) => "bool",
            Self::Int(_) => "int",
            Self::Text(_) => "text",
        }
    }
}

/// One account's choices, by stock `flag_name`.
pub type Overrides = BTreeMap<String, FlagValue>;

/// A feature a wearer may choose for their own Pins, and what Center shows
/// about it.
pub struct Feature {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    /// `observed` (captured from live cosmos), `derived` (read from the stock
    /// consumer) or `implemented` (what Luma's Pin runtime does with it).
    pub evidence: &'static str,
    /// `next_sync`, or `next_sync_restart` when a stock consumer caches it.
    pub delivery: &'static str,
    pub warning: Option<&'static str>,
}

impl Feature {
    /// INFERRED web policy: the observed Touchcode assignment has no stock
    /// consumer. `TouchcodeManager.setActive` must remain available for recovery;
    /// its timeout is independently read by `scheduleOrExtendAutoFinish`.
    pub fn editable(&self) -> bool {
        self.key != "touchcode_enabled"
    }
}

/// The features Settings → Features offers (INFERRED, see the module doc).
///
/// Editable keys have a stock consumer. The observed Touchcode assignment is
/// read-only. Retaining it lets the wearer clear an older ignored choice.
/// The flags this deployment
/// decides for itself stay out: the speech flags follow its speech
/// integration, `synapse_bidirectional_streaming` follows
/// `COSMOS_BIDIRECTIONAL_STREAMING`, and the rest have no Pin consumer or no
/// safe value.
pub const FEATURES: &[Feature] = &[
    Feature {
        key: "touchcode_enabled",
        label: "Touchcode unlock",
        description: "Touchcode remains available to unlock protected Pin actions.",
        category: "Everyday Pin",
        evidence: "observed",
        delivery: "next_sync",
        warning: None,
    },
    Feature {
        key: "touchcode_timeout_millis",
        label: "Touchcode timeout",
        description: "Milliseconds before an in-progress Touchcode gesture finishes.",
        category: "Everyday Pin",
        evidence: "derived",
        delivery: "next_sync",
        warning: Some("Use a non-negative Java integer. Zero expires immediately."),
    },
    Feature {
        key: "vision_custom_gesture_enabled",
        label: "Custom vision gesture",
        description: "Enables the stock vision gesture entry point.",
        category: "Everyday Pin",
        evidence: "observed",
        delivery: "next_sync",
        warning: None,
    },
    Feature {
        key: "quick_actions_remapping_enabled",
        label: "Quick-action remapping",
        description: "Enables stock Settings and voice routes for remapping Notes, Messages, and Interpreter.",
        category: "Everyday Pin",
        evidence: "observed",
        delivery: "next_sync_restart",
        warning: Some(
            "Restart Ironman after changing this so its cached recognizer map is rebuilt.",
        ),
    },
    Feature {
        key: "music_interstitials_enabled",
        label: "Music announcements",
        description: "Lets stock music actions narrate the current selection.",
        category: "Everyday Pin",
        evidence: "observed",
        delivery: "next_sync",
        warning: None,
    },
    Feature {
        key: "tickle",
        label: "The Tickle",
        description: "Enables the hidden stock Tickle phrases and experience.",
        category: "Everyday Pin",
        evidence: "observed",
        delivery: "next_sync",
        warning: Some(
            "Prototype experience; transcript-to-activity behavior is implemented, but subjective audio quality remains unverified.",
        ),
    },
    Feature {
        key: "cmu_ultra_enabled",
        label: "Catch Me Up Ultra accessory path",
        description: "Controls stock ANCS onboarding and notification parsing for a paired phone.",
        category: "Everyday Pin",
        evidence: "derived",
        delivery: "next_sync_restart",
        warning: Some(
            "Restart Ironman after either change to guarantee its cached Bluetooth parser state.",
        ),
    },
    Feature {
        key: "cmu_ultra_chime_enabled",
        label: "Catch Me Up chime",
        description: "Enables an eligible notification's stock sound, LED, and haptic alert outside its cooldown.",
        category: "Everyday Pin",
        evidence: "derived",
        delivery: "next_sync",
        warning: Some("Requires Catch Me Up Ultra accessory path to be on."),
    },
    Feature {
        key: "vision_actions_enabled",
        label: "Vision actions",
        description: "Includes matching saved if-you-see-then rules as untrusted context during Cosmos image analysis.",
        category: "Experiments",
        evidence: "implemented",
        delivery: "next_sync_restart",
        warning: Some(
            "Experimental. Camera images go to the assistant provider configured on your server. Existing action permissions and confirmations still apply. Restart your Pin to update its voice commands.",
        ),
    },
    Feature {
        key: "fitness_tracker_enabled",
        label: "Fitness tracker",
        description: "Gates new stock activity-tracker starts and Luma's bounded local session history.",
        category: "Experiments",
        evidence: "implemented",
        delivery: "next_sync_restart",
        warning: Some(
            "Sensitive health/activity data. Restart Ironman to rebuild the full stock voice catalog.",
        ),
    },
    Feature {
        key: "fitness_tracker_extra_data_enabled",
        label: "Fitness extra sensor data",
        description: "Adds raw motion, step, context, and location rows to the optional local session CSV.",
        category: "Privacy & data",
        evidence: "derived",
        delivery: "next_sync",
        warning: Some(
            "Sensitive and high-volume. Requires Fitness tracker and takes full effect on the next session.",
        ),
    },
    Feature {
        key: "esim_qr_scanner_enabled",
        label: "eSIM QR scanner",
        description: "Shows the stock eSIM QR scanner in cellular settings.",
        category: "System & recovery",
        evidence: "derived",
        delivery: "next_sync",
        warning: None,
    },
    Feature {
        key: "network_reset_enabled",
        label: "Network reset",
        description: "Shows the stock confirmed network-reset surface when About is opened.",
        category: "System & recovery",
        evidence: "derived",
        delivery: "next_sync",
        warning: Some(
            "Destructive surface. This flag exposes the UI but never executes a reset by itself.",
        ),
    },
];

/// The feature a wearer may choose under `key`, if any.
pub fn feature(key: &str) -> Option<&'static Feature> {
    FEATURES.iter().find(|feature| feature.key == key)
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    overrides: Overrides,
}

/// A read-modify-write that keeps losing to other writers gives up here.
const UPDATE_ATTEMPTS: usize = 16;

async fn read(
    store: &SharedStore,
    account: &str,
) -> Result<(Option<Vec<u8>>, Overrides), StoreError> {
    let raw = store
        .get_account_blob(account, AccountBlobKind::FeatureFlagOverrides)
        .await?;
    let overrides = match raw.as_deref() {
        None => Overrides::new(),
        Some(bytes) => match serde_json::from_slice::<Stored>(bytes) {
            Ok(stored) => stored.overrides,
            // Serving this server's defaults is always safe, and the next
            // choice the wearer makes replaces the record.
            Err(_) => {
                tracing::warn!(
                    "an account's feature choices could not be read; serving the defaults"
                );
                Overrides::new()
            }
        },
    };
    Ok((raw, overrides))
}

/// The account's choices. An outage is an error, never "no choices".
pub async fn for_account(store: &SharedStore, account: &str) -> Result<Overrides, StoreError> {
    Ok(read(store, account).await?.1)
}

/// Change the account's choices atomically. `change` sees the choices as they
/// stand and may refuse. A refusal writes nothing and is returned as it is.
/// A concurrent write to the same account is re-read and `change` runs again,
/// so two choices made at once are both kept.
pub async fn update<T, E>(
    store: &SharedStore,
    account: &str,
    change: impl Fn(&mut Overrides) -> Result<T, E>,
) -> Result<Result<T, E>, StoreError> {
    for _ in 0..UPDATE_ATTEMPTS {
        let (raw, mut overrides) = read(store, account).await?;
        let outcome = match change(&mut overrides) {
            Ok(outcome) => outcome,
            Err(refused) => return Ok(Err(refused)),
        };
        let bytes =
            serde_json::to_vec(&Stored { overrides }).map_err(|_| StoreError::Unavailable)?;
        if store
            .compare_and_swap_account_blob(
                account,
                AccountBlobKind::FeatureFlagOverrides,
                raw.as_deref(),
                &bytes,
            )
            .await?
        {
            return Ok(Ok(outcome));
        }
    }
    Err(StoreError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;

    fn fresh() -> SharedStore {
        std::sync::Arc::new(MemoryStore::default())
    }

    async fn choose(store: &SharedStore, account: &str, key: &str, value: FlagValue) {
        update(store, account, |overrides| {
            overrides.insert(key.to_owned(), value.clone());
            Ok::<_, ()>(())
        })
        .await
        .expect("the store answers")
        .expect("nothing refuses");
    }

    #[test]
    fn every_feature_is_listed_once() {
        let mut keys: Vec<&str> = FEATURES.iter().map(|feature| feature.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), FEATURES.len());
        assert!(feature("touchcode_enabled").is_some());
        assert!(
            feature("synapse_bidirectional_streaming").is_none(),
            "the transport is this deployment's to decide"
        );
        assert!(feature("server_side_speech_synthesis_timeout_millis").is_none());
    }

    /// Settings → Features offers only what a wearer can see working: a key
    /// with a known Pin consumer that arrives with the next flag sync. Center
    /// renders this list as it is (`center/verify/settings-ia.test.mjs`).
    #[test]
    fn every_feature_has_a_known_consumer_and_arrives_by_flag_sync() {
        for feature in FEATURES {
            assert!(
                matches!(feature.evidence, "observed" | "derived" | "implemented"),
                "{} has no evidence record",
                feature.key
            );
            assert!(
                matches!(feature.delivery, "next_sync" | "next_sync_restart"),
                "{} is not delivered by a flag sync",
                feature.key
            );
            assert!(
                crate::services::feature_flags::default_value(feature.key).is_some(),
                "{} is not in the served set",
                feature.key
            );
        }
    }

    #[tokio::test]
    async fn a_choice_belongs_to_one_account() {
        let store = fresh();
        choose(&store, "U:alice", "tickle", FlagValue::Bool(false)).await;

        let alice = for_account(&store, "U:alice").await.unwrap();
        assert_eq!(alice.get("tickle"), Some(&FlagValue::Bool(false)));
        assert!(
            for_account(&store, "U:bob").await.unwrap().is_empty(),
            "another account keeps the defaults"
        );
    }
}
