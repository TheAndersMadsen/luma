//! Typed feature-flag definitions shared by configuration, gRPC, and the
//! dashboard API.
//!
//! Humane's client persists every successful `GetFlags` response as the full
//! server-owned flag set.  An empty successful response therefore clears all
//! server overrides. Ai Pin Revival always carries a non-empty baseline assignment
//! for the custom vision gesture and returns an RPC error instead of ever
//! emitting an accidental empty success.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::proto::featureflags::{feature_flag_assignment, FeatureFlagAssignment};
use crate::tier_a::feature_flags::{
    cloud as cloud_keys, penumbra_settings_global as penumbra_settings_keys,
    settings_global as settings_global_keys,
};

pub const VISION_CUSTOM_GESTURE_KEY: &str = cloud_keys::VISION_CUSTOM_GESTURE_ENABLED;
/// Private Settings.Global selector consumed only by the System Navigation
/// compatibility hook. It is deliberately not a public stock feature flag.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub const WEATHER_CELSIUS_SETTING_KEY: &str = penumbra_settings_keys::WEATHER_CELSIUS;

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn settings_global_bridge_key_allowed(key: &str) -> bool {
    key == WEATHER_CELSIUS_SETTING_KEY || settings_global_feature_gate_spec(key).is_some()
}

/// Scalar representation used in TOML. Native TOML scalar types preserve the
/// distinction between integer and float values without exposing protobuf
/// details in the configuration file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConfiguredFeatureFlagValue {
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct FeatureFlagsConfig {
    /// Explicit server-side overrides. Missing flags fall back to Revival's
    /// mandatory baseline (where one exists), then to firmware defaults.
    #[serde(default)]
    pub overrides: BTreeMap<String, ConfiguredFeatureFlagValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureFlagValueType {
    Bool,
    Int,
    Float,
    String,
}

impl FeatureFlagValueType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bool => "bool",
            Self::Int => "int",
            Self::Float => "float",
            Self::String => "string",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FeatureFlagDefault {
    Bool(bool),
    Int(i64),
    /// The wire protocol supports float defaults even though the current stock
    /// public registry has no known float-valued key.
    #[allow(dead_code)]
    Float(f64),
    String(&'static str),
}

impl FeatureFlagDefault {
    pub fn to_configured(self) -> ConfiguredFeatureFlagValue {
        match self {
            Self::Bool(value) => ConfiguredFeatureFlagValue::Bool(value),
            Self::Int(value) => ConfiguredFeatureFlagValue::Int(value),
            Self::Float(value) => ConfiguredFeatureFlagValue::Float(value),
            Self::String(value) => ConfiguredFeatureFlagValue::String(value.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FeatureFlagSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub value_type: FeatureFlagValueType,
    /// Effective stock fallback observed on firmware 101.000470.45.20.
    pub firmware_default: FeatureFlagDefault,
    /// Revival baseline emitted even when no user override is configured.
    pub penumbra_default: Option<FeatureFlagDefault>,
    pub writable: bool,
    pub warning: Option<&'static str>,
    /// Some stock consumers construct their action/UI maps once and need the
    /// Ironman process (or device) restarted after the sync completes.
    pub restart_recommended: bool,
}

macro_rules! bool_spec {
    ($key:expr, $label:literal, $description:literal, $default:expr, $restart:expr) => {
        FeatureFlagSpec {
            key: $key,
            label: $label,
            description: $description,
            value_type: FeatureFlagValueType::Bool,
            firmware_default: FeatureFlagDefault::Bool($default),
            penumbra_default: None,
            writable: true,
            warning: None,
            restart_recommended: $restart,
        }
    };
}

/// Exact public `FeatureFlagManager.Feature` keys in the stock launcher.
/// Unknown keys are rejected: an unused unknown today could become active after
/// a firmware update, and a wrong type makes stock getters throw.
pub const FEATURE_FLAG_SPECS: &[FeatureFlagSpec] = &[
    FeatureFlagSpec {
        key: cloud_keys::ACCESSORY_FEATURE_FLAGS,
        label: "Accessory feature flags",
        description: "Enum/default-only accessory string; no installed runtime consumer or non-empty format was found.",
        value_type: FeatureFlagValueType::String,
        firmware_default: FeatureFlagDefault::String(""),
        penumbra_default: None,
        writable: false,
        warning: Some("Locked: the installed APK corpus declares this key and empty default but never reads it, and no safe non-empty grammar is known."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::FEATURE_FLAG_SUPPRESS_SYNC_ON_STARTUP,
        label: "Suppress startup sync",
        description: "Suppresses only Ironman's explicit one-time startup feature-flag fetch; periodic, push, and debug/dashboard sync paths remain.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: false,
        warning: Some("Locked: a persisted true value removes the deterministic boot refresh and can prolong a bad cached assignment. It does not block push/debug sync, and daily periodic work remains enqueued."),
        restart_recommended: true,
    },
    FeatureFlagSpec {
        key: cloud_keys::TOUCHCODE_TIMEOUT_MILLIS,
        label: "Touchcode timeout",
        description: "Delay before an in-progress Touchcode gesture is finished, in milliseconds.",
        value_type: FeatureFlagValueType::Int,
        firmware_default: FeatureFlagDefault::Int(5_000),
        penumbra_default: None,
        writable: true,
        warning: Some("Use a non-negative value. Extreme delays can make Touchcode feel unresponsive."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::LASER_FINDING_GUIDE,
        label: "Laser finding guide",
        description: "Legacy stock laser-finding selector; no runtime consumer was found in the installed firmware.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: false,
        warning: Some("Locked: the installed stock APKs define this key but do not read it, so changing it cannot produce a supported behavior."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::SERVER_SIDE_TRANSCRIPTION_SAVE_ENABLED,
        label: "Include transcription audio",
        description: "Allows the stock transcriber to attach up to 320,000 bytes of recognition audio to its in-memory transcription response.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some("Privacy-sensitive: stock can attach microphone audio to the Synapse turn. No installed disk writer was found and Ai Pin Revival deliberately omits that response field; keep this off unless the stock attachment is explicitly required."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_TIMEOUT_MILLIS,
        label: "Remote speech timeout",
        description: "Remote speech timeout in milliseconds; 0 keeps stock local speech synthesis.",
        value_type: FeatureFlagValueType::Int,
        firmware_default: FeatureFlagDefault::Int(0),
        penumbra_default: None,
        writable: true,
        warning: Some("Zero keeps stock local TTS. A positive timeout permits the stock client to call Ai Pin Revival's SpeechService; cloud synthesis still requires Azure Speech enablement and explicit consent."),
        restart_recommended: false,
    },
    bool_spec!(
        cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_STREAMING_ENABLED,
        "Streaming remote speech",
        "Uses the server-streaming speech RPC when remote speech is active.",
        false,
        false
    ),
    FeatureFlagSpec {
        key: cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_VOICE_NAME,
        label: "Remote speech voice",
        description: "Stock-requested remote voice name. Ai Pin Revival ignores this untrusted value and uses only the operator-configured Azure voice.",
        value_type: FeatureFlagValueType::String,
        firmware_default: FeatureFlagDefault::String(""),
        penumbra_default: None,
        writable: false,
        warning: Some("Locked because Ai Pin Revival deliberately ignores request-provided voice names; configure the operator-selected Azure voice in Settings."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::CMU_ULTRA_ENABLED,
        label: "Catch Me Up Ultra accessory path",
        description: "Controls the stock iPhone ANCS notification parser and Settings' CMU Ultra onboarding eligibility.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(true),
        penumbra_default: None,
        writable: true,
        warning: Some("Settings reads this live at each bonded-device state check, but Ironman's BluetoothNotificationParser samples it only during construction and keeps a static ANCS client. Restart Ironman after either change to guarantee parser state; disabling cannot tear down an existing client in-process. Ai Pin Revival's local notification summaries do not depend on it."),
        restart_recommended: true,
    },
    FeatureFlagSpec {
        key: cloud_keys::CMU_ULTRA_CHIME_ENABLED,
        label: "Catch Me Up Ultra chime",
        description: "After successful categorization, chimes once for eligible time-sensitive experience IDs outside a five-minute cooldown; native Messages and Dialer are excluded.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some("Read live by stock NotificationManager after each successful categorization. Enabling it can produce sound, LED, and haptic alerts; deduplication is by experience ID for five minutes and no Ironman restart is required."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::MUSIC_INTERSTITIALS_ENABLED,
        label: "Music interstitials",
        description: "Toggles the stock music app's local narration for play, featured-music, favorites, and current-track-radio actions.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some("Read live by the installed music action handlers. Ai Pin Revival's bounded encrypted-action interstitial RPC is a separate always-available stock path."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: VISION_CUSTOM_GESTURE_KEY,
        label: "Custom vision gesture",
        description: "Enables the vision gesture used by Ai Pin Revival's stock interaction path.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: Some(FeatureFlagDefault::Bool(true)),
        writable: true,
        warning: Some("Ai Pin Revival defaults this on to preserve the existing gesture behavior."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::QUICK_ACTIONS_REMAPPING_ENABLED,
        label: "Quick action remapping",
        description: "Shows quick-action remapping in Settings and enables its voice intent.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(true),
        penumbra_default: None,
        writable: true,
        warning: Some(
            "Interpreter remapping is available again, but live interpretation requires Cosmos speech and translation to be ready. Physical touchpad, projector, and session presentation remain pending.",
        ),
        restart_recommended: true,
    },
    FeatureFlagSpec {
        key: cloud_keys::VISION_ACTIONS_ENABLED,
        label: "Vision actions",
        description: "Enables bounded if-you-see-then evaluation with a one-shot handoff into the restored stock-compatible planner cascade.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some(
            "Experimental: a matched rule re-enters the same bounded stock-compatible planners used by ordinary prompts. Exact run/image/observation binding, exclusions, lock policy, confirmations, and feature gates still apply; destructive, emergency, trust, and unsupported actions remain unavailable. This flag is ineffective until the independent camera-to-cloud consent (llm.vision_consent_acknowledged) is acknowledged in settings. Physical gesture and projector verification remain pending.",
        ),
        // AnalyzeImage reads this live, but RegexIntentEngine captures the
        // Add/Clear/Count voice grammar when it builds its immutable map.
        restart_recommended: true,
    },
    FeatureFlagSpec {
        key: cloud_keys::FITNESS_TRACKER_ENABLED,
        label: "Fitness tracker",
        description: "Gates new stock ActivityTracker starts; exact Stop remains available for cleanup, and completed sessions can enter bounded local history.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some("Sensitive health/activity data: full voice/catalog enabling needs an Ironman restart. Ai Pin Revival suppresses only the stock automatic fitness-session bug report; explicit diagnostic reports remain unchanged. Physical end-to-end verification remains pending."),
        restart_recommended: true,
    },
    FeatureFlagSpec {
        key: cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED,
        label: "Fitness extra data",
        description: "Adds raw accelerometer, gyroscope, magnetometer, step, CMC, and location rows to an optional per-session sensor CSV.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some("Sensitive/high-volume: enabling takes effect on the next tracking session. Disabling stops new raw CSV rows immediately, but the extra sensor listeners remain registered until that session stops. Requires Fitness tracker to be enabled."),
        restart_recommended: false,
    },
    bool_spec!(
        cloud_keys::ESIM_QR_SCANNER_ENABLED,
        "eSIM QR scanner",
        "Shows the eSIM QR scanner entry in stock cellular settings.",
        true,
        false
    ),
    FeatureFlagSpec {
        key: cloud_keys::TICKLE,
        label: "The Tickle",
        description: "Enables the hidden stock Tickle voice intent and its exact three stock phrases.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some("Prototype stock experience. Ai Pin Revival live-gates and repairs only Tickle's cached regex/action schema. On installed Hook .29, all three injected transcripts reached the stock parser, action, and activity; acoustic microphone ASR and subjective laughter/audio remain unverified."),
        // The compatibility hook re-reads the flag and lazily repairs all three
        // stock Tickle snapshots, so enable and disable are live.
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::NETWORK_RESET_ENABLED,
        label: "Network reset",
        description: "Shows the network-reset entry in stock About. The row is sampled when About is opened; re-enter About after changing this flag.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        penumbra_default: None,
        writable: true,
        warning: Some("This only exposes the stock confirmed destructive reset UI; it never executes a reset by itself. Changing the flag does not revoke a reset submenu or confirmation dialog that is already open."),
        restart_recommended: false,
    },
    FeatureFlagSpec {
        key: cloud_keys::SYNAPSE_BIDIRECTIONAL_STREAMING,
        label: "Streaming assistant sessions",
        description: "Switches stock SynapseInterpreter from the unary Understand RPC to persistent BidirectionalStreamingUnderstand action/observation sessions.",
        value_type: FeatureFlagValueType::Bool,
        firmware_default: FeatureFlagDefault::Bool(false),
        // The July 22 trial is no longer a safe default. Orphan observations
        // close promptly, but Stage-2 parent/run resume is still absent and the
        // independent InterpreterOrchestrator timeout remains unmeasured. Keep
        // stock's false default; an operator may explicitly override it for a
        // controlled protocol experiment because the selector is read live.
        penumbra_default: None,
        writable: true,
        warning: Some("Experimental: Stage-2 observation resume and the independent stock InterpreterOrchestrator deadline are not yet verified. Keep this off for normal use; enabling it requires an exact-stack spoken-turn test."),
        restart_recommended: false,
    },
];

/// Stock settings that are called feature flags but live in Settings.Global,
/// not in FeatureFlagsService. This separate allowlist prevents either storage
/// plane from accidentally writing keys owned by the other.
#[derive(Debug, Clone, Copy)]
pub struct SettingsGlobalFeatureGateSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub default: bool,
    pub writable: bool,
    pub warning: Option<&'static str>,
    pub restart_recommended: bool,
}

pub const SETTINGS_GLOBAL_FEATURE_GATES: &[SettingsGlobalFeatureGateSpec] = &[
    SettingsGlobalFeatureGateSpec {
        key: settings_global_keys::PHOTO_SHARING_ENABLED,
        label: "Photo sharing",
        default: false,
        writable: false,
        warning: Some("Locked off because Humane's remote share/import backend is not restored; local capture and Center media remain available. The sole stock consumer reconstructs with each Recents menu open."),
        restart_recommended: false,
    },
    SettingsGlobalFeatureGateSpec {
        key: settings_global_keys::PHOTOGRAPHY_JPG_ENABLED,
        label: "Save JPG photography",
        default: true,
        writable: false,
        warning: Some("Locked at the default true value: stock YUV mode reads only the raw-data filename, while Ai Pin Revival currently creates the JPG upload contract. Disabling this gate could prevent a photo from being uploaded."),
        restart_recommended: false,
    },
    SettingsGlobalFeatureGateSpec {
        key: settings_global_keys::FOOD_ENABLED,
        label: "Food and nutrition",
        default: false,
        writable: true,
        warning: Some("Requires Open Food Facts enablement plus the independent attribution acknowledgement. The installed regex engine builds the nutrition grammar once, so restart Ironman after changing this gate."),
        restart_recommended: true,
    },
    SettingsGlobalFeatureGateSpec {
        key: settings_global_keys::CLOCK_ENABLED,
        label: "Legacy clock gate",
        default: false,
        writable: false,
        warning: Some("Locked as unverified: the installed Clock and Ironman APKs define this setting but never read it. Ai Pin Revival's restored timer, alarm, and world-clock actions are available independently."),
        restart_recommended: false,
    },
    SettingsGlobalFeatureGateSpec {
        key: settings_global_keys::HEALTH_TRACKER_ENABLED,
        label: "Weather UV / ambient-light experiment",
        default: false,
        writable: true,
        warning: Some("Despite the stock key name, the only confirmed consumer is HomeWeather UV/ambient-light behavior, not fitness history. It samples ALS data and emits a stock notable event while rendering weather; Ai Pin Revival acknowledges but does not retain that event. Reconstruct or restart the separate System Navigation experience so the stock widget reads the new value."),
        restart_recommended: true,
    },
    SettingsGlobalFeatureGateSpec {
        key: settings_global_keys::CMU_ULTRA_ENABLED,
        label: "Unverified legacy CMU setting",
        default: false,
        writable: false,
        warning: Some("Locked: no runtime consumer was found in the installed firmware. This setting is not required by Ai Pin Revival's local Catch Me Up summaries; the separate cloud CMU accessory flag owns the stock Bluetooth parser."),
        restart_recommended: false,
    },
];

pub fn feature_flag_spec(key: &str) -> Option<&'static FeatureFlagSpec> {
    FEATURE_FLAG_SPECS.iter().find(|spec| spec.key == key)
}

pub fn settings_global_feature_gate_spec(
    key: &str,
) -> Option<&'static SettingsGlobalFeatureGateSpec> {
    SETTINGS_GLOBAL_FEATURE_GATES
        .iter()
        .find(|spec| spec.key == key)
}

pub fn value_type(value: &ConfiguredFeatureFlagValue) -> FeatureFlagValueType {
    match value {
        ConfiguredFeatureFlagValue::Bool(_) => FeatureFlagValueType::Bool,
        ConfiguredFeatureFlagValue::Int(_) => FeatureFlagValueType::Int,
        ConfiguredFeatureFlagValue::Float(_) => FeatureFlagValueType::Float,
        ConfiguredFeatureFlagValue::String(_) => FeatureFlagValueType::String,
    }
}

pub fn validate_feature_flags(config: &FeatureFlagsConfig) -> Result<(), String> {
    for (key, value) in &config.overrides {
        let spec = feature_flag_spec(key).ok_or_else(|| format!("unknown feature flag `{key}`"))?;
        if !spec.writable {
            return Err(format!("feature flag `{key}` is not writable"));
        }
        let actual_type = value_type(value);
        if actual_type != spec.value_type {
            return Err(format!(
                "feature flag `{key}` expects {}, got {}",
                spec.value_type.as_str(),
                actual_type.as_str()
            ));
        }
        validate_scalar(key, value)?;
    }

    if effective_bool(
        config,
        cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_STREAMING_ENABLED,
    ) == Some(true)
        && resolved_int(
            config,
            cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_TIMEOUT_MILLIS,
        )
        .is_none_or(|timeout| timeout <= 0)
    {
        return Err(format!(
            "feature flag `{}` requires a positive `{}`",
            cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_STREAMING_ENABLED,
            cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_TIMEOUT_MILLIS,
        ));
    }
    if effective_bool(config, cloud_keys::CMU_ULTRA_CHIME_ENABLED) == Some(true)
        && effective_bool(config, cloud_keys::CMU_ULTRA_ENABLED) != Some(true)
    {
        return Err(format!(
            "feature flag `{}` requires `{}=true`",
            cloud_keys::CMU_ULTRA_CHIME_ENABLED,
            cloud_keys::CMU_ULTRA_ENABLED,
        ));
    }
    if effective_bool(config, cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED) == Some(true)
        && effective_bool(config, cloud_keys::FITNESS_TRACKER_ENABLED) != Some(true)
    {
        return Err(format!(
            "feature flag `{}` requires `{}=true`",
            cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED,
            cloud_keys::FITNESS_TRACKER_ENABLED,
        ));
    }
    Ok(())
}

fn resolved_value(config: &FeatureFlagsConfig, key: &str) -> Option<ConfiguredFeatureFlagValue> {
    if let Some(value) = config.overrides.get(key) {
        return Some(value.clone());
    }
    let spec = feature_flag_spec(key)?;
    Some(
        spec.penumbra_default
            .unwrap_or(spec.firmware_default)
            .to_configured(),
    )
}

/// Resolve a boolean flag using the same precedence exposed by the dashboard:
/// explicit override, then Revival's baseline, then the stock firmware
/// default. Unknown and non-boolean keys are deliberately rejected.
pub(crate) fn effective_bool(config: &FeatureFlagsConfig, key: &str) -> Option<bool> {
    match resolved_value(config, key)? {
        ConfiguredFeatureFlagValue::Bool(value) => Some(value),
        _ => None,
    }
}

fn resolved_int(config: &FeatureFlagsConfig, key: &str) -> Option<i64> {
    match resolved_value(config, key)? {
        ConfiguredFeatureFlagValue::Int(value) => Some(value),
        _ => None,
    }
}

fn validate_scalar(key: &str, value: &ConfiguredFeatureFlagValue) -> Result<(), String> {
    match value {
        ConfiguredFeatureFlagValue::Int(value) => {
            if i32::try_from(*value).is_err() {
                return Err(format!(
                    "feature flag `{key}` integer must fit Java int range ({}..={})",
                    i32::MIN,
                    i32::MAX
                ));
            }
            if (key == cloud_keys::TOUCHCODE_TIMEOUT_MILLIS
                || key == cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_TIMEOUT_MILLIS)
                && *value < 0
            {
                return Err(format!("feature flag `{key}` cannot be negative"));
            }
        }
        ConfiguredFeatureFlagValue::Float(value) => {
            if !value.is_finite() || *value > f32::MAX as f64 || *value < f32::MIN as f64 {
                return Err(format!("feature flag `{key}` must be a finite f32 value"));
            }
        }
        ConfiguredFeatureFlagValue::String(value) => {
            if value.len() > 256 {
                return Err(format!("feature flag `{key}` string exceeds 256 bytes"));
            }
        }
        ConfiguredFeatureFlagValue::Bool(_) => {}
    }
    Ok(())
}

/// Resolve configured values over Revival's mandatory defaults. Firmware
/// defaults remain absent from the response so the stock binder owns them.
pub fn effective_server_values(
    config: &FeatureFlagsConfig,
) -> Result<BTreeMap<String, ConfiguredFeatureFlagValue>, String> {
    validate_feature_flags(config)?;

    let mut values = BTreeMap::new();
    for spec in FEATURE_FLAG_SPECS {
        if let Some(default) = spec.penumbra_default {
            values.insert(spec.key.to_string(), default.to_configured());
        }
    }
    for (key, value) in &config.overrides {
        values.insert(key.clone(), value.clone());
    }

    if values.is_empty() {
        return Err("refusing to emit an empty successful feature-flag response".to_string());
    }
    Ok(values)
}

pub fn to_proto_assignment(
    key: String,
    value: ConfiguredFeatureFlagValue,
) -> Result<FeatureFlagAssignment, String> {
    validate_scalar(&key, &value)?;
    let val = match value {
        ConfiguredFeatureFlagValue::Bool(value) => feature_flag_assignment::Val::ValBool(value),
        ConfiguredFeatureFlagValue::Int(value) => {
            // Validation above guarantees the stock client's int64 -> int32
            // cast is lossless.
            i32::try_from(value)
                .map_err(|_| format!("feature flag `{key}` integer is outside Java int range"))?;
            feature_flag_assignment::Val::ValInt(value)
        }
        ConfiguredFeatureFlagValue::Float(value) => {
            feature_flag_assignment::Val::ValFloat(value as f32)
        }
        ConfiguredFeatureFlagValue::String(value) => feature_flag_assignment::Val::ValStr(value),
    };
    Ok(FeatureFlagAssignment {
        flag_id: String::new(),
        flag_name: key,
        val: Some(val),
    })
}

pub fn proto_assignments(
    config: &FeatureFlagsConfig,
) -> Result<Vec<FeatureFlagAssignment>, String> {
    effective_server_values(config)?
        .into_iter()
        .map(|(key, value)| to_proto_assignment(key, value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_keys_are_unique() {
        let mut keys = std::collections::BTreeSet::new();
        for spec in FEATURE_FLAG_SPECS {
            assert!(keys.insert(spec.key), "duplicate feature flag {}", spec.key);
        }
    }

    #[test]
    fn registry_accounts_for_every_stock_cloud_selector() {
        let actual = FEATURE_FLAG_SPECS
            .iter()
            .map(|spec| spec.key)
            .collect::<std::collections::BTreeSet<_>>();
        let expected = cloud_keys::ALL
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(actual, expected);
        assert_eq!(FEATURE_FLAG_SPECS.len(), cloud_keys::ALL.len());
    }

    #[test]
    fn catalog_activation_metadata_matches_installed_consumers() {
        let cmu = feature_flag_spec(cloud_keys::CMU_ULTRA_ENABLED).unwrap();
        assert!(cmu.restart_recommended);
        assert!(cmu.description.contains("ANCS notification parser"));
        assert!(cmu.description.contains("onboarding eligibility"));
        assert!(cmu.warning.unwrap_or_default().contains("reads this live"));
        assert!(cmu
            .warning
            .unwrap_or_default()
            .contains("static ANCS client"));
        assert!(cmu
            .warning
            .unwrap_or_default()
            .contains("Restart Ironman after either change"));

        let cmu_chime = feature_flag_spec(cloud_keys::CMU_ULTRA_CHIME_ENABLED).unwrap();
        assert!(!cmu_chime.restart_recommended);
        assert!(cmu_chime.description.contains("time-sensitive"));
        assert!(!cmu_chime.warning.unwrap_or_default().contains("Unverified"));

        let music = feature_flag_spec(cloud_keys::MUSIC_INTERSTITIALS_ENABLED).unwrap();
        assert!(!music.restart_recommended);
        assert!(music.description.contains("current-track-radio"));
        assert!(!music.description.contains("pause"));

        let voice = feature_flag_spec(cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_VOICE_NAME).unwrap();
        assert!(!voice.writable);
        assert!(!voice.restart_recommended);
        assert!(voice
            .description
            .contains("operator-configured Azure voice"));
        assert!(voice
            .warning
            .unwrap_or_default()
            .contains("operator-selected Azure voice"));

        let accessory = feature_flag_spec(cloud_keys::ACCESSORY_FEATURE_FLAGS).unwrap();
        assert!(!accessory.writable);
        assert!(!accessory.restart_recommended);
        assert!(accessory
            .description
            .contains("no installed runtime consumer"));
        assert!(accessory
            .warning
            .unwrap_or_default()
            .contains("no safe non-empty grammar"));

        let laser = feature_flag_spec(cloud_keys::LASER_FINDING_GUIDE).unwrap();
        assert!(!laser.writable);
        assert!(!laser.restart_recommended);

        let suppress_startup =
            feature_flag_spec(cloud_keys::FEATURE_FLAG_SUPPRESS_SYNC_ON_STARTUP).unwrap();
        assert!(!suppress_startup.writable);
        assert!(suppress_startup.restart_recommended);
        assert!(suppress_startup.description.contains("one-time startup"));
        assert!(suppress_startup.description.contains("periodic, push"));
        assert!(suppress_startup
            .warning
            .unwrap_or_default()
            .contains("daily periodic work remains enqueued"));

        let streaming = feature_flag_spec(cloud_keys::SYNAPSE_BIDIRECTIONAL_STREAMING).unwrap();
        assert!(!streaming.restart_recommended);
        assert!(streaming
            .description
            .contains("BidirectionalStreamingUnderstand"));
        assert!(!streaming.warning.unwrap_or_default().contains("Unverified"));

        let tickle = feature_flag_spec(cloud_keys::TICKLE).unwrap();
        assert!(!tickle.restart_recommended);
        assert!(tickle.description.contains("exact three stock phrases"));
        assert!(tickle.warning.unwrap_or_default().contains("live-gates"));

        let fitness_extra =
            feature_flag_spec(cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED).unwrap();
        assert!(!fitness_extra.restart_recommended);
        assert!(fitness_extra.description.contains("accelerometer"));
        assert!(fitness_extra.description.contains("sensor CSV"));
        assert!(fitness_extra
            .warning
            .unwrap_or_default()
            .contains("listeners remain registered until that session stops"));

        let fitness = feature_flag_spec(cloud_keys::FITNESS_TRACKER_ENABLED).unwrap();
        assert!(fitness.restart_recommended);
        assert!(fitness.description.contains("Gates new"));
        assert!(fitness.description.contains("Stop remains available"));
        assert!(fitness
            .warning
            .unwrap_or_default()
            .contains("explicit diagnostic reports remain unchanged"));

        let network_reset = feature_flag_spec(cloud_keys::NETWORK_RESET_ENABLED).unwrap();
        assert!(!network_reset.restart_recommended);
        assert!(network_reset.description.contains("re-enter About"));
        assert!(network_reset
            .warning
            .unwrap_or_default()
            .contains("never executes a reset by itself"));

        assert!(laser.warning.unwrap_or_default().contains("Locked"));
    }

    #[test]
    fn settings_global_registry_matches_the_exact_six_stock_gates() {
        let actual = SETTINGS_GLOBAL_FEATURE_GATES
            .iter()
            .map(|spec| spec.key)
            .collect::<std::collections::BTreeSet<_>>();
        let expected = settings_global_keys::ALL
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(actual, expected);
        assert_eq!(
            SETTINGS_GLOBAL_FEATURE_GATES.len(),
            settings_global_keys::ALL.len()
        );

        let cmu =
            settings_global_feature_gate_spec(settings_global_keys::CMU_ULTRA_ENABLED).unwrap();
        assert_eq!(cmu.label, "Unverified legacy CMU setting");
        assert!(
            !cmu.default,
            "the separate Notifications gate must stay opt-in"
        );
        assert!(!cmu.writable);
        assert!(!cmu.restart_recommended);

        let food = settings_global_feature_gate_spec(settings_global_keys::FOOD_ENABLED).unwrap();
        assert!(food.restart_recommended);

        let clock = settings_global_feature_gate_spec(settings_global_keys::CLOCK_ENABLED).unwrap();
        assert!(!clock.default);
        assert!(!clock.writable);
        assert!(!clock.restart_recommended);
        assert!(clock.warning.unwrap_or_default().contains("never read it"));
        assert!(clock
            .warning
            .unwrap_or_default()
            .contains("available independently"));

        let health =
            settings_global_feature_gate_spec(settings_global_keys::HEALTH_TRACKER_ENABLED)
                .unwrap();
        assert!(!health.default);
        assert!(health.writable);
        assert!(health.restart_recommended);
        assert!(health.warning.unwrap_or_default().contains("HomeWeather"));
        assert!(health.warning.unwrap_or_default().contains("ALS"));

        let photography =
            settings_global_feature_gate_spec(settings_global_keys::PHOTOGRAPHY_JPG_ENABLED)
                .unwrap();
        assert!(!photography.writable);
        assert!(!photography.restart_recommended);
        assert!(photography.warning.unwrap_or_default().contains("YUV"));

        let sharing =
            settings_global_feature_gate_spec(settings_global_keys::PHOTO_SHARING_ENABLED).unwrap();
        assert!(!sharing.default);
        assert!(!sharing.writable);
        assert!(!sharing.restart_recommended);
        assert!(sharing
            .warning
            .unwrap_or_default()
            .contains("each Recents menu open"));

        let clock = settings_global_feature_gate_spec(settings_global_keys::CLOCK_ENABLED).unwrap();
        assert!(!clock.writable);

        let sharing =
            settings_global_feature_gate_spec(settings_global_keys::PHOTO_SHARING_ENABLED).unwrap();
        assert!(!sharing.writable);
        assert!(sharing.warning.is_some());

        assert!(settings_global_feature_gate_spec(WEATHER_CELSIUS_SETTING_KEY).is_none());
        assert!(settings_global_bridge_key_allowed(
            WEATHER_CELSIUS_SETTING_KEY
        ));
    }

    #[test]
    fn default_response_is_nonempty_and_preserves_vision() {
        // Revival asserts exactly the flags with a `penumbra_default`. Keep
        // this exact: every entry here changes stock behaviour on every device
        // with no override, so a new one must be a deliberate edit, not a
        // side effect.
        let assignments = proto_assignments(&FeatureFlagsConfig::default()).unwrap();
        let asserted: std::collections::HashMap<&str, _> = assignments
            .iter()
            .map(|assignment| (assignment.flag_name.as_str(), assignment.val.clone()))
            .collect();
        assert_eq!(asserted.len(), 1, "asserted flags: {:?}", asserted.keys());
        assert_eq!(
            asserted.get(VISION_CUSTOM_GESTURE_KEY),
            Some(&Some(feature_flag_assignment::Val::ValBool(true)))
        );
        assert!(!asserted.contains_key(cloud_keys::SYNAPSE_BIDIRECTIONAL_STREAMING));
    }

    #[test]
    fn effective_bool_uses_override_then_penumbra_then_firmware_precedence() {
        let defaults = FeatureFlagsConfig::default();
        assert_eq!(
            effective_bool(&defaults, VISION_CUSTOM_GESTURE_KEY),
            Some(true),
            "Revival's custom-gesture baseline must beat the stock fallback"
        );
        assert_eq!(
            effective_bool(&defaults, cloud_keys::VISION_ACTIONS_ENABLED),
            Some(false),
            "missing overrides must retain the stock firmware default"
        );

        let overrides = FeatureFlagsConfig {
            overrides: BTreeMap::from([
                (
                    VISION_CUSTOM_GESTURE_KEY.to_string(),
                    ConfiguredFeatureFlagValue::Bool(false),
                ),
                (
                    cloud_keys::VISION_ACTIONS_ENABLED.to_string(),
                    ConfiguredFeatureFlagValue::Bool(true),
                ),
            ]),
        };
        assert_eq!(
            effective_bool(&overrides, VISION_CUSTOM_GESTURE_KEY),
            Some(false)
        );
        assert_eq!(
            effective_bool(&overrides, cloud_keys::VISION_ACTIONS_ENABLED),
            Some(true)
        );
        assert_eq!(
            effective_bool(&defaults, cloud_keys::TOUCHCODE_TIMEOUT_MILLIS),
            None
        );
        assert_eq!(effective_bool(&defaults, "unknown"), None);
    }

    #[test]
    fn serializes_all_four_protobuf_value_types() {
        let cases = [
            (
                ConfiguredFeatureFlagValue::Bool(true),
                feature_flag_assignment::Val::ValBool(true),
            ),
            (
                ConfiguredFeatureFlagValue::Int(42),
                feature_flag_assignment::Val::ValInt(42),
            ),
            (
                ConfiguredFeatureFlagValue::Float(1.5),
                feature_flag_assignment::Val::ValFloat(1.5),
            ),
            (
                ConfiguredFeatureFlagValue::String("voice".into()),
                feature_flag_assignment::Val::ValStr("voice".into()),
            ),
        ];

        for (value, expected) in cases {
            let assignment = to_proto_assignment("test".into(), value).unwrap();
            assert_eq!(assignment.flag_id, "");
            assert_eq!(assignment.flag_name, "test");
            assert_eq!(assignment.val, Some(expected));
        }
    }

    #[test]
    fn rejects_unknown_locked_wrong_type_and_java_int_overflow() {
        for (key, value, expected) in [
            ("unknown", ConfiguredFeatureFlagValue::Bool(true), "unknown"),
            (
                cloud_keys::FEATURE_FLAG_SUPPRESS_SYNC_ON_STARTUP,
                ConfiguredFeatureFlagValue::Bool(true),
                "not writable",
            ),
            (
                cloud_keys::VISION_ACTIONS_ENABLED,
                ConfiguredFeatureFlagValue::String("true".into()),
                "expects bool",
            ),
            (
                cloud_keys::TOUCHCODE_TIMEOUT_MILLIS,
                ConfiguredFeatureFlagValue::Int(i64::from(i32::MAX) + 1),
                "Java int range",
            ),
        ] {
            let config = FeatureFlagsConfig {
                overrides: BTreeMap::from([(key.to_string(), value)]),
            };
            assert!(validate_feature_flags(&config)
                .unwrap_err()
                .contains(expected));
        }
    }

    #[test]
    fn override_replaces_penumbra_default_without_duplicates() {
        let config = FeatureFlagsConfig {
            overrides: BTreeMap::from([(
                VISION_CUSTOM_GESTURE_KEY.to_string(),
                ConfiguredFeatureFlagValue::Bool(false),
            )]),
        };
        let assignments = proto_assignments(&config).unwrap();
        // The point is that the override REPLACES the penumbra default for
        // this key rather than appending a second entry for it. Assert on the
        // key itself, not on the total, so an unrelated asserted flag does not
        // make this test fail for the wrong reason.
        let vision: Vec<_> = assignments
            .iter()
            .filter(|assignment| assignment.flag_name == VISION_CUSTOM_GESTURE_KEY)
            .collect();
        assert_eq!(vision.len(), 1, "exactly one entry for the overridden key");
        assert_eq!(
            vision[0].val,
            Some(feature_flag_assignment::Val::ValBool(false))
        );
    }

    #[test]
    fn dependent_flags_require_their_stock_prerequisites() {
        for (overrides, expected) in [
            (
                BTreeMap::from([(
                    cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_STREAMING_ENABLED.into(),
                    ConfiguredFeatureFlagValue::Bool(true),
                )]),
                "positive `server_side_speech_synthesis_timeout_millis`",
            ),
            (
                BTreeMap::from([
                    (
                        cloud_keys::CMU_ULTRA_ENABLED.into(),
                        ConfiguredFeatureFlagValue::Bool(false),
                    ),
                    (
                        cloud_keys::CMU_ULTRA_CHIME_ENABLED.into(),
                        ConfiguredFeatureFlagValue::Bool(true),
                    ),
                ]),
                "requires `cmu_ultra_enabled=true`",
            ),
            (
                BTreeMap::from([(
                    cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED.into(),
                    ConfiguredFeatureFlagValue::Bool(true),
                )]),
                "requires `fitness_tracker_enabled=true`",
            ),
        ] {
            let error = validate_feature_flags(&FeatureFlagsConfig { overrides }).unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
        }

        let valid = FeatureFlagsConfig {
            overrides: BTreeMap::from([
                (
                    cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_TIMEOUT_MILLIS.into(),
                    ConfiguredFeatureFlagValue::Int(5_000),
                ),
                (
                    cloud_keys::SERVER_SIDE_SPEECH_SYNTHESIS_STREAMING_ENABLED.into(),
                    ConfiguredFeatureFlagValue::Bool(true),
                ),
                (
                    cloud_keys::FITNESS_TRACKER_ENABLED.into(),
                    ConfiguredFeatureFlagValue::Bool(true),
                ),
                (
                    cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED.into(),
                    ConfiguredFeatureFlagValue::Bool(true),
                ),
            ]),
        };
        validate_feature_flags(&valid).unwrap();
    }
}
