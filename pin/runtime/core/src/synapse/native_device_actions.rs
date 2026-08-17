use crate::proto::aibus::SynapseUnderstandingRequest;
use crate::synapse::capabilities::settings::{
    parse_bluetooth_settings_request, BluetoothSettingsOperation,
};
use crate::synapse::capabilities::vision_automation::BoundedAutomationUtterance;
use crate::synapse::catalog::native_action_spec;
use crate::tier_a::native_actions;

const MAX_VISION_CONDITION_CHARS: usize = 160;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeActionFeatureSnapshot {
    pub fitness_tracker_enabled: bool,
    pub tickle_enabled: bool,
    pub vision_actions_enabled: bool,
    pub quick_actions_remapping_enabled: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PlannedNativeDeviceAction {
    pub action_name: &'static str,
    pub thought: &'static str,
    pub input_json: String,
}

/// Preserve the conservative entry point for callers that do not have an
/// authoritative feature-flag snapshot. Every gated action remains
/// unavailable through this wrapper.
#[cfg(test)]
pub fn plan_native_device_action(
    request: &SynapseUnderstandingRequest,
) -> Option<PlannedNativeDeviceAction> {
    plan_native_device_action_with_features(request, NativeActionFeatureSnapshot::default())
}

/// Deterministic fallbacks for stock actions whose handlers still live on the
/// device. Humane's regex and semantic interpreters run before Synapse, so this
/// planner only sees phrases that those local stages did not recognize.
///
/// Every mutating action here requires an explicit, bounded imperative phrase;
/// read-only status actions use anchored aliases. The restored power, reset,
/// contact, trust, and radio actions preserve the stock action annotation and
/// therefore still execute inside the installed device handler. In particular,
/// FactoryReset reaches CENTRAL's confirmation flow instead of resetting here.
pub fn plan_native_device_action_with_features(
    request: &SynapseUnderstandingRequest,
    features: NativeActionFeatureSnapshot,
) -> Option<PlannedNativeDeviceAction> {
    // Context reset is intentionally stricter than the shared native-command
    // normalizer below. In particular, polite-prefix removal and punctuation
    // folding must never turn a mention or near miss into destructive session
    // state loss. Mirror the stock Hook's exact horizontal-whitespace policy so
    // both Server and local-interpreter paths authorize the same utterance.
    if is_exact_reset_session_command(&request.utterance) {
        if action_is_excluded(request, native_actions::CLEAR_UNDERSTANDING_CONTEXT) {
            return None;
        }
        return Some(PlannedNativeDeviceAction {
            action_name: native_actions::CLEAR_UNDERSTANDING_CONTEXT,
            thought: "The user explicitly asked to reset the stock short-term interaction session",
            input_json: "{}".to_string(),
        });
    }

    let utterance = normalize(&request.utterance);
    if utterance.is_empty() {
        return None;
    }
    let bluetooth_request = parse_bluetooth_settings_request(&request.utterance);

    // SetVolume is the only supported direct action with a dynamic field. Keep
    // it out of the alias table so the numeric value is parsed and range-checked
    // before any JSON is constructed. Stock declares this action keyguard-safe.
    if let Some(level) = parse_set_volume_level(&request.utterance) {
        if action_is_excluded(request, native_actions::SET_VOLUME) {
            return None;
        }
        return Some(PlannedNativeDeviceAction {
            action_name: native_actions::SET_VOLUME,
            thought: "The user explicitly asked to set the stock media volume to a bounded level",
            input_json: serde_json::json!({"level": level}).to_string(),
        });
    }

    // The outer option reports whether the utterance matched this action
    // family. The inner option is empty when policy (lock state or exclusion)
    // blocks that exact match; in that case do not let a later planner
    // reinterpret the same words as another action.
    if let Some(planned) = plan_restored_stock_mutation(request) {
        return planned;
    }

    if let Some(planned) = plan_feature_gated_action(request, features) {
        return Some(planned);
    }

    let (action_name, thought, input_json, nested_action_name) = match utterance.as_str() {
        // Camera/gallery actions. These are strict command phrases so an
        // informational question such as "how do I take a picture" cannot
        // activate the camera.
        "take a photo"
        | "take photo"
        | "take a photograph"
        | "take photograph"
        | "take a picture"
        | "take picture"
        | "capture a photo"
        | "capture a photograph"
        | "capture a picture"
        | "snap a photo"
        | "snap a picture" => (
            native_actions::CAPTURE_PHOTOGRAPH,
            "The user explicitly asked the stock camera to take a photograph",
            "{}",
            None,
        ),
        "record a video"
        | "record video"
        | "take a video"
        | "take video"
        | "capture a video"
        | "capture video"
        | "start recording a video"
        | "start recording video" => (
            native_actions::CAPTURE_VIDEO,
            "The user explicitly asked the stock camera to record a video",
            "{}",
            None,
        ),
        "stop recording" | "stop recording video" | "stop the video" | "stop video" => (
            native_actions::STOP_VIDEO,
            "The user explicitly asked the stock camera to stop recording",
            "{}",
            None,
        ),
        "open my photos"
        | "open my recent photos"
        | "open recent photos"
        | "show my photos"
        | "show me my photos"
        | "show my recent photos"
        | "show me my recent photos"
        | "show recent photos"
        | "show me recent photos"
        | "open my pictures"
        | "show me my pictures" => (
            native_actions::OPEN_RECENT_PHOTOS,
            "The user explicitly asked to open the stock recent-photos experience",
            "{}",
            None,
        ),

        // LockDevice is a fieldless direct action in the central catalog even
        // though Settings owns its handler. It mutates device state and is not
        // enabled in keyguard, so accept only complete explicit commands and
        // require an explicitly unlocked request below.
        "lock my device" | "lock the device" | "lock my pin" => (
            native_actions::LOCK_DEVICE,
            "The user explicitly asked the stock keyguard to lock the device",
            "{}",
            None,
        ),

        // Small, stock-local compatibility set. These actions already have
        // device handlers and stock schemas; the server fallback exists so the
        // same request still works when it arrives through visual Then replay
        // or after a local-recognizer miss.
        "what time is it"
        | "what s the time"
        | "tell me the time"
        | "tell me the current time"
        | "current time" => (
            native_actions::GET_CURRENT_TIME,
            "The user asked for the current time through the stock device action",
            "{}",
            None,
        ),
        "enter privacy mode" | "turn on privacy mode" | "enable privacy mode" => (
            native_actions::ENTER_PRIVACY_MODE,
            "The user explicitly asked the stock device to enter privacy mode",
            "{}",
            None,
        ),
        "increase volume" | "turn up the volume" | "volume up" => (
            native_actions::INCREMENT_VOLUME,
            "The user explicitly asked the stock device to increase media volume",
            "{}",
            None,
        ),
        "decrease volume" | "lower the volume" | "turn down the volume" | "volume down" => (
            native_actions::DECREMENT_VOLUME,
            "The user explicitly asked the stock device to decrease media volume",
            "{}",
            None,
        ),
        "start tracking my run"
        | "start tracking my walk"
        | "start tracking my hike"
        | "start tracking my workout"
        | "start tracking my exercise"
        | "start activity tracking"
        | "start fitness tracking" => (
            native_actions::START_ACTIVITY_TRACKER,
            "The user explicitly asked the enabled stock fitness tracker to start",
            "{}",
            None,
        ),
        "stop tracking my run"
        | "stop tracking my walk"
        | "stop tracking my hike"
        | "stop tracking my workout"
        | "stop tracking my exercise"
        | "stop activity tracking"
        | "stop fitness tracking"
        | "stop tracking" => (
            native_actions::STOP_ACTIVITY_TRACKER,
            "The user explicitly asked the enabled stock fitness tracker to stop",
            "{}",
            None,
        ),
        "open tutorial"
        | "open the tutorial"
        | "show tutorial"
        | "show me the tutorial"
        | "laser ink tutorial"
        | "open laser ink tutorial" => (
            native_actions::OPEN_TUTORIAL,
            "The user explicitly asked to open the stock tutorial experience",
            "{}",
            None,
        ),

        // Read-only device actions. Most have stock local recognizers already;
        // these aliases restore the cloud-era natural wording after a miss.
        // DeviceStatus is owned by the nested Settings agent, not the central
        // action catalog. Enter that agent with its exact inherited Request
        // field; settings/3 can then emit DeviceStatus through the stock path.
        "device status"
        | "get device status"
        | "show device status"
        | "show me device status"
        | "give me a device status"
        | "give me a device status report"
        | "device status report" => (
            native_actions::SETTINGS,
            "The user asked the stock Settings agent for a device status summary",
            "{}",
            Some(native_actions::DEVICE_STATUS),
        ),
        "where am i"
        | "where am i right now"
        | "what is my current location"
        | "tell me my current location"
        | "tell me where i am" => (
            native_actions::GET_CURRENT_LOCATION,
            "The user asked the device for its current location",
            "{}",
            None,
        ),
        "battery status"
        | "battery level"
        | "what is my battery level"
        // `normalize()` folds the apostrophe in "what's" to a space, so the
        // contracted form arrives as "what s ...". Anchor the same sibling stock
        // spoke naturally, one-for-one with the "what is ..." alias, so an
        // immediate device fact stays on the deterministic path instead of a
        // model round-trip.
        | "what s my battery level"
        | "how much battery do i have"
        | "how much battery is left"
        | "how much charge do i have left" => (
            native_actions::GET_BATTERY_LEVEL,
            "The user asked for the stock battery status",
            "{}",
            None,
        ),
        "am i online"
        | "am i connected"
        | "am i connected to the internet"
        | "do i have internet"
        | "do i have an internet connection" => (
            native_actions::AM_I_ONLINE,
            "The user asked for the stock connectivity status",
            "{}",
            None,
        ),
        "what is the current volume"
        | "what is my current volume"
        | "what is the volume"
        // Apostrophe-folded "what's ..." siblings (see the battery arm note).
        | "what s the current volume"
        | "what s my current volume"
        | "what s the volume"
        | "tell me the current volume"
        | "volume status" => (
            native_actions::GET_CURRENT_VOLUME,
            "The user asked for the current volume",
            "{}",
            None,
        ),
        "bluetooth status" | "is bluetooth on" | "is bluetooth enabled" => (
            native_actions::GET_BLUETOOTH_STATUS,
            "The user asked for the stock Bluetooth status",
            "{}",
            None,
        ),
        "airplane mode status" | "is airplane mode on" | "is airplane mode enabled" => (
            native_actions::GET_AIRPLANE_MODE_STATUS,
            "The user asked for the stock airplane-mode status",
            "{}",
            None,
        ),
        "what is my phone number"
        | "tell me my phone number"
        | "what is my number"
        // Apostrophe-folded "what's ..." siblings (see the battery arm note).
        | "what s my phone number"
        | "what s my number" => (
            native_actions::GET_PHONE_NUMBER,
            "The user asked for the device phone number",
            "{}",
            None,
        ),
        "what is my serial number"
        | "what is my pin s serial number"
        | "what is my pin serial number"
        // Apostrophe-folded "what's ..." siblings (see the battery arm note).
        | "what s my serial number"
        | "what s my pin s serial number"
        | "what s my pin serial number"
        | "tell me my serial number" => (
            native_actions::GET_SERIAL_NUMBER,
            "The user asked for the device serial number",
            "{}",
            None,
        ),
        _ => {
            let bluetooth = bluetooth_request.as_ref()?;
            let thought = match bluetooth.operation {
                BluetoothSettingsOperation::Connect => {
                    "The user explicitly asked the stock Settings agent to resolve and connect a named Bluetooth device"
                }
                BluetoothSettingsOperation::Disconnect => {
                    "The user explicitly asked the stock Settings agent to resolve and disconnect a named Bluetooth device"
                }
            };
            (
                native_actions::SETTINGS,
                thought,
                "{}",
                Some(bluetooth.operation.lookup_action_name()),
            )
        }
    };

    if action_is_excluded(request, action_name)
        || nested_action_name.is_some_and(|name| action_is_excluded(request, name))
        || (nested_action_name.is_some() && !request_is_explicitly_unlocked(request))
        // Capture/stop actions are stock-enabled in keyguard, but the private
        // recent-photo gallery is not. Preserve that exact distinction.
        || (action_name == native_actions::OPEN_RECENT_PHOTOS
            && !request_is_explicitly_unlocked(request))
        // Serial-number disclosure is also explicitly keyguard-disabled in
        // the stock action annotation.
        || (action_name == native_actions::GET_SERIAL_NUMBER
            && !request_is_explicitly_unlocked(request))
        // The stock tutorial exposes private projector guidance and is not
        // enabled in keyguard. Unknown lock state therefore fails closed too.
        || (action_name == native_actions::OPEN_TUTORIAL
            && !request_is_explicitly_unlocked(request))
        // Disabling fitness prevents new sessions, but an already-running stock
        // tracker must remain stoppable so its listeners and writers can close.
        || (action_name == native_actions::START_ACTIVITY_TRACKER
            && !features.fitness_tracker_enabled)
        || (matches!(
            action_name,
            native_actions::ENTER_PRIVACY_MODE
                | native_actions::INCREMENT_VOLUME
                | native_actions::DECREMENT_VOLUME
                | native_actions::START_ACTIVITY_TRACKER
                | native_actions::STOP_ACTIVITY_TRACKER
                | native_actions::OPEN_TUTORIAL
        ) && !is_strict_safe_local_command(&request.utterance))
        || bluetooth_request.as_ref().is_some_and(|bluetooth| {
            !request_is_explicitly_unlocked(request)
                || action_is_excluded(request, bluetooth.operation.mutation_action_name())
        })
        || (action_name == native_actions::LOCK_DEVICE
            && (!request_is_explicitly_unlocked(request)
                || !is_strict_lock_command(&request.utterance)))
    {
        return None;
    }

    Some(PlannedNativeDeviceAction {
        action_name,
        thought,
        input_json: if nested_action_name.is_some() {
            serde_json::json!({"Request": request.utterance.trim()}).to_string()
        } else {
            input_json.to_string()
        },
    })
}

mod command_grammar;
mod contact_args;
mod feature_policy;
mod stock_mutations;

pub(crate) use command_grammar::action_is_excluded;
use command_grammar::*;
use contact_args::*;
use feature_policy::*;
use stock_mutations::*;

#[cfg(test)]
#[path = "native_device_actions/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "native_device_actions/replay_tests.rs"]
mod synthetic_non_mutating_replay;
