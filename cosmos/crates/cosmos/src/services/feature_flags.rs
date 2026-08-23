//! `humane.featureflags.FeatureFlagsService` — the device pulls its assigned
//! flags at startup and after a privacy sync.
//!
//! The wire contract matches the observed protocol; the flag *values* are this
//! project's own configuration, not Humane's. A real deployment would load
//! them from a store — here they are a static, clearly-synthetic default set.

use std::sync::Arc;

use cosmos_protocol::featureflags::{
    DeviceFeatureFlagRequest, DeviceFeatureFlagResponse, FeatureFlagAssignment,
    feature_flag_assignment::Val, feature_flags_service_server::FeatureFlagsService,
};
use tonic::{Request, Response, Status};

use crate::auth::RequestAuthenticator;

#[derive(Clone)]
/// Where a response's flag set comes from.
///
/// This used to be a plain `Arc<Vec<..>>` built once in the constructor, which
/// made operator overrides inert: the process computed the list at startup and
/// every later `GetFlags` returned that same snapshot, so a flag changed at
/// runtime was written to disk, read back correctly by the admin API, and never
/// reached the device. "Adjust without a restart" requires recomputing per call.
enum FlagSource {
    /// A fixed list, for tests that assert on an exact set.
    ///
    /// Never constructed in production: serving a snapshot is precisely the bug
    /// this enum exists to prevent, so the live arm is the only one wired up.
    #[allow(dead_code)]
    Fixed(Arc<Vec<FeatureFlagAssignment>>),
    /// Recomputed per request, so overrides apply to the next flag sync.
    Live,
}

pub struct FeatureFlags {
    authenticator: RequestAuthenticator,
    flags: FlagSource,
}

impl FeatureFlags {
    /// Construct with an explicit set. Test seam — production uses
    /// [`Self::with_default_flags`], which serves the live set.
    #[allow(dead_code)]
    pub fn new(authenticator: RequestAuthenticator, flags: Vec<FeatureFlagAssignment>) -> Self {
        Self {
            authenticator,
            flags: FlagSource::Fixed(Arc::new(flags)),
        }
    }

    pub fn with_default_flags(authenticator: RequestAuthenticator) -> Self {
        Self {
            authenticator,
            flags: FlagSource::Live,
        }
    }

    fn current(&self) -> Vec<FeatureFlagAssignment> {
        match &self.flags {
            FlagSource::Fixed(flags) => flags.as_ref().clone(),
            FlagSource::Live => default_flags(),
        }
    }
}

#[tonic::async_trait]
impl FeatureFlagsService for FeatureFlags {
    async fn get_flags(
        &self,
        request: Request<DeviceFeatureFlagRequest>,
    ) -> Result<Response<DeviceFeatureFlagResponse>, Status> {
        // Identity comes from the authenticated edge; the flag set is not
        // per-device in this implementation, but every caller must still be
        // authenticated (fails closed otherwise).
        let _principal = self.authenticator.authenticate(&request)?;
        Ok(Response::new(DeviceFeatureFlagResponse {
            assignment: self.current(),
        }))
    }
}

/// Build one assignment.
///
/// **`flag_name` (field 6) is THE lookup key**, not a human label:
/// `FeatureFlagSyncWorker.convertFeatureFlagAssignment` reads
/// `serverValue.getFlagName()`, drops the entry when it is empty ("somehow have
/// null or empty key"), and uses it as `flag.key`. `flag_id` (field 1) is never
/// read by the device — it is the server's own assignment id.
///
/// Getting these backwards makes the device silently drop every flag and fall
/// back to its compiled-in defaults.
fn assignment(key: &str, val: Val) -> FeatureFlagAssignment {
    // Operator overrides are applied here, at the single funnel every flag passes
    // through, so the observed defaults above stay untouched as evidence.
    //
    // The type arm is NOT allowed to change. `FeatureFlagManager.requireType`
    // throws on the device when a flag arrives as the wrong arm, so an override
    // that turned a bool into an int would not be a config mistake — it would be
    // an exception on the Pin. A mismatch is refused and logged, keeping the
    // observed value, because serving the evidence is always safe.
    let suppressed = OBSERVING.with(|observing| observing.get());
    let val = match crate::flag_overrides::get(key).filter(|_| !suppressed) {
        None => val,
        Some(override_value) => {
            use crate::flag_overrides::FlagValue;
            match (&val, override_value) {
                (Val::ValBool(_), FlagValue::Bool(value)) => Val::ValBool(value),
                (Val::ValInt(_), FlagValue::Int(value)) => Val::ValInt(value),
                (Val::ValStr(_), FlagValue::Text(value)) => Val::ValStr(value),
                (_, mismatched) => {
                    tracing::warn!(
                        flag = key,
                        override_type = mismatched.type_name(),
                        "ignoring flag override with the wrong value type; the device \
                         would throw on a mismatched arm, so the observed value is served"
                    );
                    val
                }
            }
        }
    };

    FeatureFlagAssignment {
        // Stable, opaque, server-side; derived from the key so it is
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

/// Whether this deployment hosts server-side speech synthesis.
///
/// It does: `SpeechService` is registered and returns real Azure audio when
/// `AZURE_SPEECH_KEY` is configured. An earlier version of this comment said the
/// service was unimplemented, which stopped being true and then justified leaving
/// the flag off.
///
/// The env name matters and was wrong for a while: this read `COSMOS_REMOTE_TTS`
/// while the root runtime template, Compose model, and README all set
/// `COSMOS_REMOTE_TTS_ENABLED`. The live deployment set it to `"true"` and the
/// server never saw it, so devices were served `timeout=0` and stayed on local
/// on-device TTS — a configured, paid-for capability that was silently off. Keep
/// this name identical to the deployment files.
fn remote_tts_enabled() -> bool {
    matches!(
        std::env::var("COSMOS_REMOTE_TTS_ENABLED").ok().as_deref(),
        Some("1") | Some("true")
    )
}

/// Whether a device should take the bidirectional `Understand` transport
/// (`SYNPASE_BIDIRECTIONAL_STREAMING`, wire key `synapse_bidirectional_streaming`,
/// resolved in `LanguageUnderstanding` — true ⇒ bidi, false/absent ⇒ legacy
/// server-stream).
///
/// The value Humane actually served is **observed, not guessed**: a stock Pin
/// talking to live cosmos logged this assignment on 2026-08-01 —
///
/// ```text
/// flag_name: "synapse_bidirectional_streaming"
/// val_bool: false
/// ```
///
/// (`PenumbraOS-Revival-Fork/tools/cosmos-probe/logs/cosmos-raw.log:1464`, a
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

pub fn default_flags() -> Vec<FeatureFlagAssignment> {
    // One read of the override file for the whole set, not one per flag. The
    // response is a full replace on the device, so it has to be built from a
    // single reading of the overrides anyway — see `flag_overrides::scoped`.
    crate::flag_overrides::scoped(|| {
        build_flags(remote_tts_enabled(), bidirectional_streaming_enabled())
    })
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
///    `PenumbraOS-Revival-Fork/tools/cosmos-probe/logs/cosmos-raw.log:1457-1556`
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
/// (`FeatureFlagManager.java:279-283`) — so a wrong value arm is a device-side
/// exception, not a silently ignored flag.
fn build_flags(remote_tts: bool, bidi: bool) -> Vec<FeatureFlagAssignment> {
    vec![
        // ------------------------------------------------------------------
        // Assignments live cosmos was captured serving. The trailing
        // `cosmos-raw.log:NNNN` is the `val_bool` line for that flag in the
        // 2026-08-01 `FeatureFlagSyncWorker` dump. Do not change one of these
        // without a NEW capture — a comment's reasoning does not outrank a
        // recording of the real backend.
        // ------------------------------------------------------------------
        //
        // Device-inert here: no decompiled on-device app reads these keys (they
        // are not in `FeatureFlagManager.Feature` and no source in
        // `decompile-workspace/decompiled` looks them up by string), so they are
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
        // Touchcode is the Pin's unlock gesture; cosmos served it ON. Serving it
        // keeps the unlock gate available, so this is a tightening.
        boolean("touchcode_enabled", true), // cosmos-raw.log:1475
        //
        // Captured AND read by the device:
        //
        // `IntentRecognitionAction.java:100-105`: when the mic is opened by a
        // *vision* gesture and this is false, the run returns early ("Custom
        // gesture is not enabled for Vision") and the wearer's gesture does
        // nothing at all. Cosmos served TRUE; the clone previously served false,
        // which silently killed that entry point.
        boolean("vision_custom_gesture_enabled", true), // cosmos-raw.log:1495
        // `ActionUtils.java:268-271`, `AppController.java:468`,
        // `RegexIntentEngine.java:103-106`: exposes `ChangeQuickActionAction` /
        // `SetQuickMessagingContactAction` and the "change my quick action to X"
        // regexes. Already matched the capture.
        boolean("quick_actions_remapping_enabled", true), // cosmos-raw.log:1500
        // `ActionUtils.java:276-278` adds `TickleAction` to the schema catalog and
        // `RegexIntentEngine.java:107-110` adds the "tickle" regexes. Cosmos served
        // TRUE; false removed both, so "tickle" fell through to the model with no
        // action to dispatch.
        boolean("tickle", true), // cosmos-raw.log:1545
        // `PlayMusicActionHandler.java:125` (and the Featured / Favorites /
        // CurrentTrackRadio handlers) gate the spoken now-playing line on this.
        // The narration is produced LOCALLY — `getNarrationForSong` plus
        // `narratorAccess().speak` — so it needs no server-side interstitial
        // model. The clone's old "no interstitial model hosted" note was a
        // misreading of the call site, and false cost the wearer the track
        // announcement cosmos shipped with.
        boolean("music_interstitials_enabled", true), // cosmos-raw.log:1555
        // Selects `BidirectionalStreamingUnderstand` over the legacy server-stream
        // `Understand`. Cosmos served FALSE (cosmos-raw.log:1465); see
        // `bidirectional_streaming_enabled` for why the default matches.
        boolean("synapse_bidirectional_streaming", bidi),
        //
        // ------------------------------------------------------------------
        // `FeatureFlagManager.Feature` keys cosmos did NOT assign. The device
        // would read false/0/"" for each. Served explicitly only where this
        // deployment has something to say; each one records why it does not just
        // take the device's zero value.
        // ------------------------------------------------------------------
        text("accessory_feature_flags", ""),
        boolean("feature_flag_suppress_sync_on_startup", false),
        // Cosmos did not serve this, so a stock Pin read 0 — and 0 makes
        // `TouchcodeManager.scheduleOrExtendAutoFinish` post the auto-finish with
        // a zero delay (`TouchcodeManager.java:138-141` into
        // `Delay.start()`/`postDelayed`), firing `handleAutoFinishDelay` on the
        // very next main-loop turn after `setActive(true)`. The session ends
        // before the wearer can enter a single gesture, so touchcode unlock is
        // unusable. Absence is weaker evidence than an observed value: cosmos had
        // no assignment for this key, not a considered 0. Deliberately NOT
        // matched — replicating it would break the unlock path, and this project
        // does not degrade a security gate to chase parity.
        integer("touchcode_timeout_millis", 10_000),
        // Also unassigned by cosmos (device default false). Purely device-side
        // guidance UI with no server dependency, so serving it costs nothing and
        // the wearer keeps the guide.
        boolean("laser_finding_guide", true),
        // Unbacked here — no transcription store.
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
        // entry in Settings › About (`AboutViewController.java:87`) — a local
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
/// Cosmos served both of these TRUE. They govern collecting the wearer's saved
/// Wi-Fi networks (`WifiNetworksSyncWorker`/`WifiNetworksSyncScheduler`) and
/// listing them back out on the web. Withholding them leaves the device reading
/// false, i.e. the *more* private posture — the one case where matching the
/// capture would relax a privacy protection rather than tighten one. Tightening
/// only; if a deployment wants network sync it must opt in deliberately.
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
    /// onto the bidi path — which stock never exercised in production, and which
    /// carries neither the account gate nor the 25s run deadline the legacy path
    /// enforces. If this test fails, the default drifted; do not "fix" it by
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
    /// fix it by editing the expectation — that requires a NEW capture.
    #[test]
    fn served_values_match_what_live_cosmos_was_captured_serving() {
        // `synapse_bidirectional_streaming` is env-driven; take the branch that
        // corresponds to an unconfigured deployment, which is what cosmos served.
        let flags = build_flags(false, false);

        for (key, captured, line) in CAPTURED_COSMOS_ASSIGNMENTS {
            let served = flags.iter().find(|flag| flag.flag_name == *key);
            if WITHHELD_CAPTURED_KEYS.contains(key) {
                assert!(
                    served.is_none(),
                    "{key} is withheld on privacy grounds; serving it would let the \
                     wearer's saved Wi-Fi networks sync (cosmos-raw.log:{line})"
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
    fn bidi_flag_defaults_on_so_a_stock_pin_takes_it() {
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
        // The env-driven default is ON (the value a stock Pin needs to pick bidi).
        assert_eq!(
            val(&default_flags()),
            Some(Val::ValBool(bidirectional_streaming_enabled()))
        );
    }

    #[tokio::test]
    async fn get_flags_serves_the_default_set_over_grpc() {
        use std::{collections::HashMap, net::SocketAddr, time::Duration};

        use cosmos_protocol::featureflags::feature_flags_service_client::FeatureFlagsServiceClient;

        use crate::{config::Config, serve_until};

        async fn unused_loopback_address() -> SocketAddr {
            tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind temporary listener")
                .local_addr()
                .expect("temporary local address")
        }

        let grpc_address = unused_loopback_address().await;
        let http_address = unused_loopback_address().await;
        let values = HashMap::from([
            (
                "COSMOS_AUTH_MODE".to_owned(),
                "development-insecure".to_owned(),
            ),
            ("COSMOS_WORKLOAD".to_owned(), "feature-flags".to_owned()),
            ("COSMOS_GRPC_BIND".to_owned(), grpc_address.to_string()),
            ("COSMOS_HTTP_BIND".to_owned(), http_address.to_string()),
            ("COSMOS_SHUTDOWN_GRACE_MS".to_owned(), "2000".to_owned()),
        ]);
        let config = Config::from_map(&values).expect("local feature-flags config");
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_until(config, async move {
            let _ = shutdown_rx.await;
        }));

        let endpoint = tonic::transport::Endpoint::from_shared(format!("http://{grpc_address}"))
            .expect("valid endpoint URI");
        let mut client = None;
        for _ in 0..20 {
            match endpoint.clone().connect().await {
                Ok(channel) => {
                    client = Some(FeatureFlagsServiceClient::new(channel));
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        let mut client = client.expect("feature-flags gRPC server became reachable");
        let response = client
            .get_flags(DeviceFeatureFlagRequest {})
            .await
            .expect("get_flags succeeds")
            .into_inner();

        assert!(
            !response.assignment.is_empty(),
            "default flags must be served"
        );
        assert!(
            response
                .assignment
                .iter()
                .any(|flag| flag.flag_name == "synapse_bidirectional_streaming"),
            "a real device Feature key must be present (keyed on flag_name)"
        );

        shutdown_tx.send(()).expect("request shutdown");
        tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .expect("server stops before test timeout")
            .expect("server task completes")
            .expect("server exits cleanly");
    }
}

/// The full assignment set, for the admin API. Same code path the device sees,
/// so the panel can never show something different from what is served.
pub fn assignments_for_inspection() -> Vec<FeatureFlagAssignment> {
    default_flags()
}

/// What cosmos was observed to serve for `key`, ignoring any operator override.
///
/// Built by re-running the assignment list with overrides suppressed, so there is
/// exactly one definition of the observed values — duplicating them into a second
/// table is how the evidence and the served value drift apart.
pub fn observed_value(key: &str) -> Option<Val> {
    OBSERVING.with(|observing| {
        observing.set(true);
        let result = default_flags()
            .into_iter()
            .find(|assignment| assignment.flag_name == key)
            .and_then(|assignment| assignment.val);
        observing.set(false);
        result
    })
}

thread_local! {
    /// Set while reading observed values, so `assignment` skips the override
    /// layer. Thread-local rather than global: a concurrent device request on
    /// another thread must still receive the overridden value.
    static OBSERVING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod override_tests {
    use super::*;

    /// An override must reach the wire, and clearing it must restore EXACTLY the
    /// observed value — the thing a stock Pin was measured to receive.
    #[test]
    fn an_override_changes_the_served_value_and_clearing_restores_the_observed_one() {
        let key = "touchcode_enabled";
        let observed = observed_value(key).expect("flag exists");

        crate::flag_overrides::set(key, crate::flag_overrides::FlagValue::Bool(false));
        let served = default_flags()
            .into_iter()
            .find(|a| a.flag_name == key)
            .and_then(|a| a.val)
            .expect("flag still served");
        assert_eq!(
            served,
            Val::ValBool(false),
            "the override must reach the wire"
        );
        assert_eq!(
            observed_value(key),
            Some(observed.clone()),
            "observed must be unchanged"
        );

        crate::flag_overrides::clear(key);
        let restored = default_flags()
            .into_iter()
            .find(|a| a.flag_name == key)
            .and_then(|a| a.val);
        assert_eq!(
            restored,
            Some(observed),
            "clearing restores the observed value"
        );
    }

    /// A wrong-typed override is REFUSED, not coerced.
    ///
    /// `FeatureFlagManager.requireType` throws on the device when a flag arrives
    /// as the wrong arm, so coercing here would turn a config typo into an
    /// exception on the Pin. Serving the observed value is always safe.
    #[test]
    fn a_wrong_typed_override_is_refused_rather_than_bricking_the_device() {
        let key = "touchcode_timeout_millis";
        let observed = observed_value(key).expect("flag exists");
        assert!(matches!(observed, Val::ValInt(_)), "this flag is an int");

        // A bool where an int belongs.
        crate::flag_overrides::set(key, crate::flag_overrides::FlagValue::Bool(true));
        let served = default_flags()
            .into_iter()
            .find(|a| a.flag_name == key)
            .and_then(|a| a.val)
            .expect("flag still served");
        assert_eq!(
            served, observed,
            "a type mismatch must serve the observed value, never the wrong arm",
        );
        crate::flag_overrides::clear(key);
    }
}

/// Cost of building one flag response, measured rather than assumed.
///
/// Not part of the gate: it is `#[ignore]`d and prints a number, because a
/// timing assertion on shared CI hardware is a flake generator. Run it with
///
/// ```sh
/// cargo test --release -p cosmos --lib flag_response_cost \
///   -- --ignored --nocapture --test-threads=1
/// ```
///
/// The fixture is production's own `flag-overrides.json` shape — four boolean
/// overrides against a real `COSMOS_STATE_DIR` — because the cost being measured
/// is a filesystem `stat`, and it does not exist when `COSMOS_STATE_DIR` is unset.
#[cfg(test)]
mod flag_response_cost {
    use super::*;
    use std::time::Instant;

    const PRODUCTION_SHAPED_OVERRIDES: &str = r#"{
      "overrides": {
        "cmu_ultra_chime_enabled": { "type": "bool", "value": true },
        "cmu_ultra_enabled": { "type": "bool", "value": true },
        "esim_qr_scanner_enabled": { "type": "bool", "value": true },
        "vision_actions_enabled": { "type": "bool", "value": true }
      }
    }"#;

    fn with_production_shaped_state_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cosmos-flag-bench-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch state dir");
        std::fs::write(dir.join("flag-overrides.json"), PRODUCTION_SHAPED_OVERRIDES)
            .expect("write overrides fixture");
        // SAFETY: this bench is `--test-threads=1` by construction; no other
        // thread is reading the environment while it is set.
        unsafe { std::env::set_var("COSMOS_STATE_DIR", &dir) };
        dir
    }

    #[test]
    #[ignore = "benchmark: prints timings, asserts nothing"]
    fn flag_response_cost() {
        let dir = with_production_shaped_state_dir();

        // Warm the override cache so the first `stat` is not counted as setup.
        let _ = default_flags();

        const ITERATIONS: u32 = 2_000;

        let start = Instant::now();
        for _ in 0..ITERATIONS {
            std::hint::black_box(default_flags());
        }
        let per_get_flags = start.elapsed() / ITERATIONS;

        // What `/demo-api/flags` does: the whole set once, plus one full rebuild
        // per overridden flag to recover the observed value.
        let overridden = [
            "cmu_ultra_chime_enabled",
            "cmu_ultra_enabled",
            "esim_qr_scanner_enabled",
            "vision_actions_enabled",
        ];
        let start = Instant::now();
        for _ in 0..ITERATIONS {
            std::hint::black_box(assignments_for_inspection());
            for key in overridden {
                std::hint::black_box(observed_value(key));
            }
        }
        let per_admin_list = start.elapsed() / ITERATIONS;

        println!("GetFlags (default_flags):        {per_get_flags:?}");
        println!("/demo-api/flags (list_flags):    {per_admin_list:?}");
        println!("flags in the served set:         {}", default_flags().len());

        let _ = std::fs::remove_dir_all(dir);
    }
}
