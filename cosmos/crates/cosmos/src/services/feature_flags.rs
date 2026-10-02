//! `humane.featureflags.FeatureFlagsService`, the device pulls its assigned
//! flags at startup, once a day, and when a `humane.feature-flags` push asks.
//!
//! The wire contract matches the observed protocol. Every Pin gets this
//! deployment's set (`default_flags`), with its own account's Settings →
//! Features choices applied on top (`flag_overrides`): humane.center kept
//! those per account, and the stock evidence for that is in `flag_overrides`.

use cosmos_protocol::featureflags::{
    DeviceFeatureFlagRequest, DeviceFeatureFlagResponse, FeatureFlagAssignment,
    feature_flag_assignment::Val, feature_flags_service_server::FeatureFlagsService,
};
use tonic::{Request, Response, Status};

use crate::auth::RequestAuthenticator;
use crate::flag_overrides::{self, FlagValue, Overrides};
use crate::store::SharedStore;

pub struct FeatureFlags {
    authenticator: RequestAuthenticator,
    /// Where each account's choices live. The web routes in
    /// `feature_flags_api` write the same rows.
    store: SharedStore,
}

impl FeatureFlags {
    pub fn new(authenticator: RequestAuthenticator, store: SharedStore) -> Self {
        Self {
            authenticator,
            store,
        }
    }
}

#[tonic::async_trait]
impl FeatureFlagsService for FeatureFlags {
    async fn get_flags(
        &self,
        request: Request<DeviceFeatureFlagRequest>,
    ) -> Result<Response<DeviceFeatureFlagResponse>, Status> {
        // The request carries no fields (`FeatureFlagSyncWorker.fetchFlagsFromServer`
        // builds it empty). The authenticated caller is the whole question.
        let principal = self.authenticator.authenticate(&request)?;
        // An outage is an error, not the defaults. The Pin replaces its whole
        // set with a successful answer (`FeatureFlagManager.setServerFlags` →
        // `defineAllServerFlags`), so answering the defaults would silently
        // undo the wearer's choices. A failed sync leaves the Pin on what it
        // has.
        let overrides =
            flag_overrides::for_account(&self.store, principal.expose_for_authorization()).await?;
        Ok(Response::new(DeviceFeatureFlagResponse {
            assignment: served_flags(&overrides),
        }))
    }
}

/// Build one assignment.
///
/// **`flag_name` (field 6) is THE lookup key**, not a human label:
/// `FeatureFlagSyncWorker.convertFeatureFlagAssignment` reads
/// `serverValue.getFlagName()`, drops the entry when it is empty ("somehow have
/// null or empty key"), and uses it as `flag.key`. `flag_id` (field 1) is never
/// read by the device, it is the server's own assignment id.
///
/// Getting these backwards makes the device silently drop every flag and fall
/// back to its compiled-in defaults.
fn assignment(key: &str, val: Val) -> FeatureFlagAssignment {
    FeatureFlagAssignment {
        // Stable, opaque, server-side. Derived from the key so it is
        // deterministic across restarts without inventing external state.
        flag_id: format!("cosmos/{key}"),
        flag_name: key.to_owned(),
        val: Some(val),
    }
}

fn boolean(key: &str, value: bool) -> FeatureFlagAssignment {
    assignment(key, Val::ValBool(value))
}

fn integer(key: &str, value: i64) -> FeatureFlagAssignment {
    assignment(key, Val::ValInt(value))
}

fn text(key: &str, value: &str) -> FeatureFlagAssignment {
    assignment(key, Val::ValStr(value.to_owned()))
}

/// The set one account's Pins are served: this deployment's defaults with the
/// account's own choices applied.
pub fn served_flags(overrides: &Overrides) -> Vec<FeatureFlagAssignment> {
    let mut flags = default_flags();
    for flag in &mut flags {
        if let Some(choice) = overrides.get(&flag.flag_name) {
            apply(flag, choice);
        }
    }
    flags
}

/// Apply one choice, keeping the flag's declared arm.
///
/// Only a feature an account may choose is applied. The flags this deployment
/// decides for itself are never taken from a stored choice. The type arm is
/// NOT allowed to change either: `FeatureFlagManager.requireType` throws on the
/// device when a flag arrives as the wrong arm, so a mismatch is logged and the
/// default served, because serving the default is always safe.
fn apply(flag: &mut FeatureFlagAssignment, choice: &FlagValue) {
    if !flag_overrides::feature(&flag.flag_name).is_some_and(|feature| feature.editable()) {
        tracing::warn!(
            flag = %flag.flag_name,
            "ignoring a stored choice for a flag this deployment decides"
        );
        return;
    }
    let Some(val) = flag.val.as_mut() else { return };
    match (val, choice) {
        (Val::ValBool(value), FlagValue::Bool(chosen)) => *value = *chosen,
        (Val::ValInt(value), FlagValue::Int(chosen)) => *value = *chosen,
        (Val::ValStr(value), FlagValue::Text(chosen)) => value.clone_from(chosen),
        (_, mismatched) => tracing::warn!(
            flag = %flag.flag_name,
            choice_type = mismatched.type_name(),
            "ignoring a choice with the wrong value type; the device would throw on a \
             mismatched arm, so the default is served"
        ),
    }
}

/// This deployment's value for `key`, before any account's choice.
pub fn default_value(key: &str) -> Option<Val> {
    default_flags()
        .into_iter()
        .find(|assignment| assignment.flag_name == key)
        .and_then(|assignment| assignment.val)
}

/// Whether Cosmos currently has server-side speech synthesis. Center writes
/// the provider settings into the state volume shared by ai-bus and this
/// workload, so a dashboard save changes the next flag response without
/// touching the Pin. The environment switch is only the first-deploy fallback
/// before Center has written an integration file.
fn remote_tts_enabled() -> bool {
    match crate::integrations::persisted_speech_ready(
        std::env::var("COSMOS_STATE_DIR").ok().as_deref(),
    ) {
        Ok(Some(ready)) => ready,
        Ok(None) => matches!(
            std::env::var("COSMOS_REMOTE_TTS_ENABLED").ok().as_deref(),
            Some("1") | Some("true")
        ),
        Err(_) => false,
    }
}

/// Whether a device should take the bidirectional `Understand` transport
/// (`SYNPASE_BIDIRECTIONAL_STREAMING`, wire key `synapse_bidirectional_streaming`,
/// resolved in `LanguageUnderstanding`, true ⇒ bidi, false/absent ⇒ legacy
/// server-stream).
///
/// The value Humane actually served is **observed, not guessed**: a stock Pin
/// talking to live cosmos logged this assignment on 2026-08-01,
///
/// ```text
/// flag_name: "synapse_bidirectional_streaming"
/// val_bool: false
/// ```
///
/// (`PenumbraOS-Luma-Fork/tools/cosmos-probe/logs/cosmos-raw.log:1464`, a
/// `FeatureFlagSyncWorker` dump of `DeviceFeatureFlagResponse`.) So cosmos ran its
/// fleet on the legacy server-stream and the bidi path was dark in production.
///
/// Default **OFF** to match. This is a fidelity claim now, not a preference: an
/// earlier revision of this comment asserted the served value was unknown and
/// defaulted ON, which silently moved every device onto a transport stock never
/// exercised. Set `COSMOS_BIDIRECTIONAL_STREAMING=1` to opt a device in.
fn bidirectional_streaming_enabled() -> bool {
    matches!(
        std::env::var("COSMOS_BIDIRECTIONAL_STREAMING")
            .ok()
            .as_deref(),
        Some("1") | Some("true")
    )
}

/// This deployment's set, before any account's choices.
pub fn default_flags() -> Vec<FeatureFlagAssignment> {
    build_flags(remote_tts_enabled(), bidirectional_streaming_enabled())
}

#[cfg(test)]
fn default_flags_for_remote_tts(remote_tts: bool) -> Vec<FeatureFlagAssignment> {
    build_flags(remote_tts, true)
}

/// The flag set this deployment serves.
///
/// Two sources feed it, and they are ranked:
///
/// 1. **What live cosmos was captured serving.** A stock Pin logged a real
///    `DeviceFeatureFlagResponse` from production continue 2026-08-01:
///    `PenumbraOS-Luma-Fork/tools/cosmos-probe/logs/cosmos-raw.log:1457-1556`
///    (a `FeatureFlagSyncWorker` dump), repeated identically in three later
///    syncs in the same capture (3219-3318, 4882-4981, 6644-6743) and in
///    `logs/quick-run-1785609878/cosmos-raw.log:23686-23785`. All twenty
///    assignments are `val_bool`. This is observed-on-the-wire evidence and it
///    outranks any inference from the decompile about what a flag "should" be.
/// 2. **What this deployment hosts**, for `FeatureFlagManager.Feature` keys
///    cosmos did not assign at all.
///
/// The distinction matters because `defineAllServerFlags` is a **full replace**
/// (`FeatureFlagManager.java:90-98`) and an unserved key resolves to a *null*
/// assignment, which `getBoolValue`/`getIntValue`/`getStringValue` turn into
/// `false`/`0`/`""` (`FeatureFlagManager.java:249-277`). The served set is
/// therefore the device's entire flag universe: omitting a key is not "leave the
/// device's own default alone", it is "serve the zero value".
///
/// `requireType` THROWS when an arm does not match the key's declared type
/// (`FeatureFlagManager.java:279-283`), so a wrong value arm is a device-side
/// exception, not a silently ignored flag.
fn build_flags(remote_tts: bool, bidi: bool) -> Vec<FeatureFlagAssignment> {
    vec![
        // ------------------------------------------------------------------
        // Assignments live cosmos was captured serving. The trailing
        // `cosmos-raw.log:NNNN` is the `val_bool` line for that flag in the
        // 2026-08-01 `FeatureFlagSyncWorker` dump. Do not change one of these
        // without a NEW capture, a comment's reasoning does not outrank a
        // recording of the real backend.
        // ------------------------------------------------------------------
        //
        // Device-inert here: no decompiled on-device app reads these keys (they
        // are not in `FeatureFlagManager.Feature` and no source in the stock
        // reference (`./luma stock decompile`) looks them up by string), so they are
        // cosmos's server-/web-side flags. Served anyway because the response set
        // is the contract and this is what a stock Pin saw.
        boolean("demo_v1_enabled", false),    // cosmos-raw.log:1505
        boolean("demo_v2_enabled", false),    // cosmos-raw.log:1460
        boolean("demo_v2_experience", false), // cosmos-raw.log:1525
        boolean("personal_voice_enabled", false), // cosmos-raw.log:1470
        boolean("calendar_enabled", false),   // cosmos-raw.log:1485
        boolean("synapse_prod_logging_enabled", false), // cosmos-raw.log:1510
        boolean("health_experience", false),  // cosmos-raw.log:1535
        boolean("hackathon_health_experience", false), // cosmos-raw.log:1520
        boolean("hackathon_ai_profile_user_personalization", false), // cosmos-raw.log:1550
        boolean("flight_search_enabled", true), // cosmos-raw.log:1530
        boolean("history_search_enabled", true), // cosmos-raw.log:1540
        boolean("web_show_save_event_location_privacy_setting", true), // cosmos-raw.log:1490
        // Captured ON, but no recovered stock consumer reads this key.
        // TouchcodeManager.setActive owns unlock sessions independently. Its
        // scheduleOrExtendAutoFinish reads only touchcode_timeout_millis.
        boolean("touchcode_enabled", true), // cosmos-raw.log:1475
        //
        // Captured AND read by the device:
        //
        // `IntentRecognitionAction.java:100-105`: when the mic is opened by a
        // *vision* gesture and this is false, the run returns early ("Custom
        // gesture is not enabled for Vision") and the wearer's gesture does
        // nothing at all. Cosmos served TRUE. The clone previously served false,
        // which silently killed that entry point.
        boolean("vision_custom_gesture_enabled", true), // cosmos-raw.log:1495
        // `ActionUtils.java:268-271`, `AppController.java:468`,
        // `RegexIntentEngine.java:103-106`: exposes `ChangeQuickActionAction` /
        // `SetQuickMessagingContactAction` and the "change my quick action to X"
        // regexes. Already matched the capture.
        boolean("quick_actions_remapping_enabled", true), // cosmos-raw.log:1500
        // `ActionUtils.java:276-278` adds `TickleAction` to the schema catalog and
        // `RegexIntentEngine.java:107-110` adds the "tickle" regexes. Cosmos served
        // TRUE. False removed both, so "tickle" fell through to the model with no
        // action to dispatch.
        boolean("tickle", true), // cosmos-raw.log:1545
        // `PlayMusicActionHandler.java:125` (and the Featured / Favorites /
        // CurrentTrackRadio handlers) gate the spoken now-playing line on this.
        // The narration is produced LOCALLY, `getNarrationForSong` plus
        // `narratorAccess().speak`, so it needs no server-side interstitial
        // model. The clone's old "no interstitial model hosted" note was a
        // misreading of the call site, and false cost the wearer the track
        // announcement cosmos shipped with.
        boolean("music_interstitials_enabled", true), // cosmos-raw.log:1555
        // Selects `BidirectionalStreamingUnderstand` over the legacy server-stream
        // `Understand`. Cosmos served FALSE (cosmos-raw.log:1465). See
        // `bidirectional_streaming_enabled` for why the default matches.
        boolean("synapse_bidirectional_streaming", bidi),
        //
        // ------------------------------------------------------------------
        // `FeatureFlagManager.Feature` keys cosmos did NOT assign. The device
        // would read false/0/"" for each. Served explicitly only where this
        // deployment has something to say. Each one records why it does not just
        // take the device's zero value.
        // ------------------------------------------------------------------
        text("accessory_feature_flags", ""),
        boolean("feature_flag_suppress_sync_on_startup", false),
        // Cosmos did not serve this, so a stock Pin read 0, and 0 makes
        // `TouchcodeManager.scheduleOrExtendAutoFinish` post the auto-finish with
        // a zero delay (`TouchcodeManager.java:138-141` into
        // `Delay.start()`/`postDelayed`), firing `handleAutoFinishDelay` on the
        // very next main-loop turn after `setActive(true)`. The session ends
        // before the wearer can enter a single gesture, so touchcode unlock is
        // unusable. Absence is weaker evidence than an observed value: cosmos had
        // no assignment for this key, not a considered 0. Deliberately NOT
        // matched, replicating it would break the unlock path, and this project
        // does not degrade a security gate to chase parity.
        integer("touchcode_timeout_millis", 10_000),
        // Also unassigned by cosmos (device default false). Purely device-side
        // guidance UI with no server dependency, so serving it costs nothing and
        // the wearer keeps the guide.
        boolean("laser_finding_guide", true),
        // Unbacked here, no transcription store.
        boolean("server_side_transcription_save_enabled", false),
        // 0 is precisely the value that makes `HybridSpeechSynthesizer.speakText`
        // take the LOCAL TTS branch instead of burning a round trip per utterance
        // against a SpeechService this deployment does not host.
        integer(
            "server_side_speech_synthesis_timeout_millis",
            if remote_tts { 15_000 } else { 0 },
        ),
        boolean("server_side_speech_synthesis_streaming_enabled", remote_tts),
        text("server_side_speech_synthesis_voice_name", ""),
        boolean("cmu_ultra_enabled", false),
        boolean("cmu_ultra_chime_enabled", false),
        boolean("vision_actions_enabled", false),
        boolean("fitness_tracker_enabled", false),
        boolean("fitness_tracker_extra_data_enabled", false),
        boolean("esim_qr_scanner_enabled", false),
        // Unassigned by cosmos (device default false). Gates the Network Reset
        // entry in Settings › About (`AboutViewController.java:87`), a local
        // recovery affordance that matters more on a re-pointed deployment than
        // it did on cosmos.
        boolean("network_reset_enabled", true),
    ]
}

/// Every assignment live cosmos was captured serving: `(flag_name, val_bool,
/// cosmos-raw.log line of the `val_bool`)`.
///
/// All twenty are booleans. This table is the pin; `build_flags` must agree with
/// it for every key except the deliberately withheld ones below.
#[cfg(test)]
const CAPTURED_COSMOS_ASSIGNMENTS: &[(&str, bool, u32)] = &[
    ("demo_v2_enabled", false, 1460),
    ("synapse_bidirectional_streaming", false, 1465),
    ("personal_voice_enabled", false, 1470),
    ("touchcode_enabled", true, 1475),
    ("web_wifinetworks_list", true, 1480),
    ("calendar_enabled", false, 1485),
    ("web_show_save_event_location_privacy_setting", true, 1490),
    ("vision_custom_gesture_enabled", true, 1495),
    ("quick_actions_remapping_enabled", true, 1500),
    ("demo_v1_enabled", false, 1505),
    ("synapse_prod_logging_enabled", false, 1510),
    ("sync_wifinetworks_enabled", true, 1515),
    ("hackathon_health_experience", false, 1520),
    ("demo_v2_experience", false, 1525),
    ("flight_search_enabled", true, 1530),
    ("health_experience", false, 1535),
    ("history_search_enabled", true, 1540),
    ("tickle", true, 1545),
    ("hackathon_ai_profile_user_personalization", false, 1550),
    ("music_interstitials_enabled", true, 1555),
];

/// Captured keys this deployment refuses to serve, and why.
///
/// Cosmos served both of these TRUE. Neither is a key the Pin reads: they are
/// not in `FeatureFlagManager.Feature`, and ironman's `WifiNetworksSyncScheduler`
/// pulls `ListSecureWifiConfigs` at boot and every 4 hours whatever they say.
/// They named humane.center's web Wi-Fi list and the cloud's own network sync,
/// and Luma has neither (there is no web write path for saved networks), so
/// serving them TRUE would advertise a feature this deployment does not have.
/// Withholding them changes nothing on the device.
#[cfg(test)]
const WITHHELD_CAPTURED_KEYS: &[&str] = &["web_wifinetworks_list", "sync_wifinetworks_enabled"];

/// The keys `FeatureFlagManager.Feature` declares, with the value arm each one
/// requires. `requireType` throws on a mismatch, so this is a wire contract.
#[cfg(test)]
const FEATURE_KEYS: &[(&str, &str)] = &[
    ("accessory_feature_flags", "str"),
    ("feature_flag_suppress_sync_on_startup", "bool"),
    ("touchcode_timeout_millis", "int"),
    ("laser_finding_guide", "bool"),
    ("server_side_transcription_save_enabled", "bool"),
    ("server_side_speech_synthesis_timeout_millis", "int"),
    ("server_side_speech_synthesis_streaming_enabled", "bool"),
    ("server_side_speech_synthesis_voice_name", "str"),
    ("cmu_ultra_enabled", "bool"),
    ("cmu_ultra_chime_enabled", "bool"),
    ("music_interstitials_enabled", "bool"),
    ("vision_custom_gesture_enabled", "bool"),
    ("quick_actions_remapping_enabled", "bool"),
    ("vision_actions_enabled", "bool"),
    ("fitness_tracker_enabled", "bool"),
    ("fitness_tracker_extra_data_enabled", "bool"),
    ("esim_qr_scanner_enabled", "bool"),
    ("tickle", "bool"),
    ("network_reset_enabled", "bool"),
    ("synapse_bidirectional_streaming", "bool"),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin the transport default to the value live cosmos was observed serving.
    ///
    /// This is a parity assertion backed by a wire capture, not a preference:
    /// `cosmos-raw.log:1464` records the real backend sending `val_bool: false`
    /// for `synapse_bidirectional_streaming`. Defaulting ON moved every device
    /// onto the bidi path, which stock never exercised in production, and which
    /// carries neither the account gate nor the 25s run deadline the legacy path
    /// enforces. If this test fails, the default drifted. Do not "fix" it by
    /// editing the expectation without new capture evidence.
    #[test]
    fn bidirectional_streaming_defaults_off_as_live_cosmos_served_it() {
        let flags = build_flags(false, bidirectional_streaming_enabled());
        let bidi = flags
            .iter()
            .find(|f| f.flag_name == "synapse_bidirectional_streaming")
            .expect("the device looks this flag up by flag_name; it must be served");
        assert_eq!(
            bidi.val,
            Some(Val::ValBool(false)),
            "live cosmos served synapse_bidirectional_streaming=false \
             (cosmos-raw.log:1464); the clone must not default devices onto bidi"
        );
    }

    /// Pin every flag value live cosmos was captured serving.
    ///
    /// The capture (`tools/cosmos-probe/logs/cosmos-raw.log:1457-1556`, four
    /// identical `FeatureFlagSyncWorker` dumps plus a fifth in
    /// `logs/quick-run-1785609878/cosmos-raw.log:23686-23785`) is the strongest
    /// evidence this project has about the backend: it is the real cosmos
    /// response, recorded off the wire. A comment reasoning about what a flag
    /// "should" be does not outrank it.
    ///
    /// If this test fails, the served value drifted from the recording. Do not
    /// fix it by editing the expectation, that requires a NEW capture.
    #[test]
    fn served_values_match_what_live_cosmos_was_captured_serving() {
        // `synapse_bidirectional_streaming` is env-driven. Take the branch that
        // corresponds to an unconfigured deployment, which is what cosmos served.
        let flags = build_flags(false, false);

        for (key, captured, line) in CAPTURED_COSMOS_ASSIGNMENTS {
            let served = flags.iter().find(|flag| flag.flag_name == *key);
            if WITHHELD_CAPTURED_KEYS.contains(key) {
                assert!(
                    served.is_none(),
                    "{key} is withheld: it names a web Wi-Fi feature this deployment \
                     does not have (cosmos-raw.log:{line})"
                );
                continue;
            }
            let served = served
                .unwrap_or_else(|| panic!("{key} was captured on the wire; it must be served"));
            assert_eq!(
                served.val,
                Some(Val::ValBool(*captured)),
                "live cosmos served {key}={captured} (cosmos-raw.log:{line}); \
                 the clone must serve the same value"
            );
        }
    }

    #[test]
    fn the_served_set_matches_the_devices_feature_keys_and_arms() {
        use std::collections::BTreeMap;
        let flags = default_flags();

        // `flag_name` is the lookup key; `flag_id` is the server's own id and is
        // never read. Backwards means the device drops the whole set.
        let served: BTreeMap<&str, &FeatureFlagAssignment> =
            flags.iter().map(|f| (f.flag_name.as_str(), f)).collect();
        assert_eq!(
            served.len(),
            flags.len(),
            "a duplicated flag_name would let one assignment shadow another"
        );

        // The served set is exactly (device Feature keys) ∪ (keys cosmos was
        // captured serving), minus the keys withheld on privacy grounds. Anything
        // else is a typo or an undocumented addition.
        let mut expected: Vec<&str> = FEATURE_KEYS
            .iter()
            .map(|(key, _)| *key)
            .chain(
                CAPTURED_COSMOS_ASSIGNMENTS
                    .iter()
                    .map(|(key, _, _)| *key)
                    .filter(|key| !WITHHELD_CAPTURED_KEYS.contains(key)),
            )
            .collect();
        expected.sort_unstable();
        expected.dedup();
        assert_eq!(
            served.keys().copied().collect::<Vec<_>>(),
            expected,
            "served keys must be the device's Feature keys plus the captured cosmos set"
        );

        for (key, want_arm) in FEATURE_KEYS {
            let flag = served[key];
            // An empty key is dropped device-side with "somehow have null or
            // empty key".
            assert!(!flag.flag_name.is_empty(), "{key} must contain a key");
            assert_eq!(
                flag.flag_id,
                format!("cosmos/{key}"),
                "{key} has a stale server id"
            );
            // `requireType` THROWS on a mismatched arm, so this is a wire contract.
            let got_arm = match flag.val {
                Some(Val::ValBool(_)) => "bool",
                Some(Val::ValInt(_)) => "int",
                Some(Val::ValFloat(_)) => "float",
                Some(Val::ValStr(_)) => "str",
                None => "none",
            };
            assert_eq!(got_arm, *want_arm, "{key} has the wrong value arm");
        }
    }

    #[test]
    fn values_describe_what_this_deployment_actually_hosts() {
        let by_key = |k: &str| {
            default_flags()
                .into_iter()
                .find(|f| f.flag_name == k)
                .unwrap_or_else(|| panic!("{k} must be served"))
                .val
        };
        // 0 makes the device take its LOCAL TTS branch instead of waiting on a
        // SpeechService this deployment does not host.
        assert_eq!(
            by_key("server_side_speech_synthesis_timeout_millis"),
            Some(Val::ValInt(0))
        );
        assert_eq!(
            by_key("server_side_speech_synthesis_streaming_enabled"),
            Some(Val::ValBool(false))
        );
        // Zero would auto-finish the unlock gesture immediately.
        match by_key("touchcode_timeout_millis") {
            Some(Val::ValInt(ms)) => assert!(ms > 0, "touchcode timeout must be positive"),
            other => panic!("expected an int, got {other:?}"),
        }
    }

    #[test]
    fn stock_speech_flags_select_remote_only_when_azure_is_ready() {
        for (configured, expected_timeout, expected_streaming) in
            [(false, 0, false), (true, 15_000, true)]
        {
            let flags = default_flags_for_remote_tts(configured);
            let timeout = flags
                .iter()
                .find(|flag| flag.flag_name == "server_side_speech_synthesis_timeout_millis")
                .and_then(|flag| flag.val.as_ref());
            assert!(matches!(timeout, Some(Val::ValInt(value)) if *value == expected_timeout));
            let streaming = flags
                .iter()
                .find(|flag| flag.flag_name == "server_side_speech_synthesis_streaming_enabled")
                .and_then(|flag| flag.val.as_ref());
            assert!(matches!(streaming, Some(Val::ValBool(value)) if *value == expected_streaming));
        }
    }

    #[test]
    fn bidi_flag_follows_the_explicit_transport_setting() {
        let on = build_flags(false, true);
        let off = build_flags(false, false);
        let val = |flags: &[FeatureFlagAssignment]| {
            flags
                .iter()
                .find(|f| f.flag_name == "synapse_bidirectional_streaming")
                .and_then(|f| f.val.clone())
        };
        assert_eq!(val(&on), Some(Val::ValBool(true)));
        assert_eq!(val(&off), Some(Val::ValBool(false)));
        // The environment-controlled value is passed through without changing
        // the stock-compatible default asserted above.
        assert_eq!(
            val(&default_flags()),
            Some(Val::ValBool(bidirectional_streaming_enabled()))
        );
    }
}

#[cfg(test)]
mod choice_tests {
    use super::*;
    use crate::store::MemoryStore;

    fn value_of(flags: &[FeatureFlagAssignment], key: &str) -> Option<Val> {
        flags
            .iter()
            .find(|flag| flag.flag_name == key)
            .and_then(|flag| flag.val.clone())
    }

    fn edge_authenticated() -> (RequestAuthenticator, String) {
        use crate::config::{Authentication, Config};
        let values = std::collections::HashMap::from([(
            "COSMOS_AUTH_MODE".to_owned(),
            "edge-authenticated".to_owned(),
        )]);
        let config = Config::from_map(&values).expect("edge-authenticated test config");
        let key = match &config.auth {
            Authentication::EdgeAuthenticated(edge) => edge.principal_metadata_key().to_owned(),
            Authentication::DevelopmentInsecure => unreachable!("configured edge-authenticated"),
        };
        (RequestAuthenticator::new(config.auth), key)
    }

    fn as_pin_of(key: &str, account: &str) -> Request<DeviceFeatureFlagRequest> {
        let mut request = Request::new(DeviceFeatureFlagRequest {});
        request.metadata_mut().insert(
            tonic::metadata::MetadataKey::from_bytes(key.as_bytes()).expect("metadata key"),
            format!("U:{account}").parse().expect("ASCII principal"),
        );
        request
    }

    /// One account's choice reaches that account's Pins and no one else's.
    #[tokio::test]
    async fn get_flags_serves_each_account_its_own_choices() {
        let (authenticator, key) = edge_authenticated();
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        let service = FeatureFlags::new(authenticator, store.clone());
        flag_overrides::update(&store, "U:alice", |overrides| {
            overrides.insert("tickle".to_owned(), FlagValue::Bool(false));
            Ok::<_, ()>(())
        })
        .await
        .unwrap()
        .unwrap();

        let served = |account: &'static str| {
            let request = as_pin_of(&key, account);
            let service = &service;
            async move {
                service
                    .get_flags(request)
                    .await
                    .expect("GetFlags answers")
                    .into_inner()
                    .assignment
            }
        };
        assert_eq!(
            value_of(&served("alice").await, "tickle"),
            Some(Val::ValBool(false))
        );
        assert_eq!(
            value_of(&served("bob").await, "tickle"),
            Some(Val::ValBool(true)),
            "another account's Pins keep what cosmos served"
        );
    }

    /// No principal, no flags: the auth seam fails closed, so a caller the
    /// edge did not identify never reads anyone's choices.
    #[tokio::test]
    async fn get_flags_answers_an_unidentified_caller_nothing() {
        let (authenticator, _) = edge_authenticated();
        let service = FeatureFlags::new(authenticator, std::sync::Arc::new(MemoryStore::default()));
        assert!(
            service
                .get_flags(Request::new(DeviceFeatureFlagRequest {}))
                .await
                .is_err()
        );
    }
}
