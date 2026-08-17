//! Handler group: the restored stock mutations — planning and the allowlist
//! that bounds them. Action names and grammars are exact compatibility
//! identifiers and do not change here.

use super::*;

/// Restore stock-local mutations that the clone previously withheld. This
/// function does not mutate Android state. It emits the installed action and
/// lets the stock experience enforce its own handler, UI, and confirmation
/// behavior.
pub(super) fn plan_restored_stock_mutation(
    request: &SynapseUnderstandingRequest,
) -> Option<Option<PlannedNativeDeviceAction>> {
    if let Some(input_json) = parse_create_contact_action(&request.utterance) {
        return Some(allowed_restored_stock_mutation(
            request,
            native_actions::CREATE_CONTACT,
            "The user supplied an exact contact name and phone number for the installed Contacts handler",
            input_json,
        ));
    }

    let command = strict_restored_stock_command(&request.utterance)?;
    let (action_name, thought) = match command.as_str() {
        "connect to wifi" | "connect to wi fi" | "open wifi setup" | "open wi fi setup" => (
            native_actions::CONNECT_TO_WIFI,
            "The user explicitly asked to open the installed Wi-Fi connection flow",
        ),
        "disconnect wifi" | "disconnect from wifi" | "disconnect wi fi" | "disconnect from wi fi" => (
            native_actions::DISCONNECT_WIFI,
            "The user explicitly asked the installed settings handler to disconnect Wi-Fi",
        ),
        "factory reset" | "factory reset my pin" | "erase my pin" => (
            native_actions::FACTORY_RESET,
            "The user explicitly requested the installed factory-reset confirmation flow",
        ),
        "reboot" | "reboot device" | "reboot my pin" | "restart device" | "restart my pin" => (
            native_actions::REBOOT,
            "The user explicitly asked the installed settings handler to reboot the device",
        ),
        "set up touchcode" | "setup touchcode" | "create touchcode" => (
            native_actions::SET_UP_TOUCHCODE,
            "The user explicitly asked to open the installed Touchcode enrollment flow",
        ),
        "trust lock" | "enable trust lock" | "turn on trust lock" => (
            native_actions::TRUST_LOCK,
            "The user explicitly asked the installed settings handler to enable Trust Lock",
        ),
        "turn off airplane mode" | "disable airplane mode" => (
            native_actions::TURN_OFF_AIRPLANE_MODE,
            "The user explicitly asked the installed settings handler to disable airplane mode",
        ),
        "turn off amber alert" | "turn off amber alerts" | "disable amber alert" | "disable amber alerts" => (
            native_actions::TURN_OFF_AMBER_ALERT,
            "The user explicitly asked the installed settings handler to disable Amber alerts",
        ),
        "turn off bluetooth" | "disable bluetooth" => (
            native_actions::TURN_OFF_BLUETOOTH,
            "The user explicitly asked the installed settings handler to disable Bluetooth",
        ),
        "turn off cellular data" | "disable cellular data" => (
            native_actions::TURN_OFF_CELLULAR_DATA,
            "The user explicitly asked the installed settings handler to disable cellular data",
        ),
        "turn off cellular roaming" | "disable cellular roaming" => (
            native_actions::TURN_OFF_CELLULAR_ROAMING,
            "The user explicitly asked the installed settings handler to disable cellular roaming",
        ),
        "turn off device"
        | "turn off the device"
        | "turn off my pin"
        | "power off device"
        | "power off the device"
        | "power off my pin"
        | "shut down device"
        | "shut down the device"
        | "shut down my pin" => (
            native_actions::TURN_OFF_DEVICE,
            "The user explicitly asked the installed settings handler to power off the device",
        ),
        "turn off emergency alert"
        | "turn off emergency alerts"
        | "disable emergency alert"
        | "disable emergency alerts" => (
            native_actions::TURN_OFF_EMERGENCY_ALERT,
            "The user explicitly asked the installed settings handler to disable emergency alerts",
        ),
        "turn off public safety alert"
        | "turn off public safety alerts"
        | "disable public safety alert"
        | "disable public safety alerts" => (
            native_actions::TURN_OFF_PUBLIC_SAFETY_ALERT,
            "The user explicitly asked the installed settings handler to disable public-safety alerts",
        ),
        "turn off wifi" | "turn off wi fi" | "disable wifi" | "disable wi fi" => (
            native_actions::TURN_OFF_WIFI,
            "The user explicitly asked the installed settings handler to disable Wi-Fi",
        ),
        "turn on airplane mode" | "enable airplane mode" => (
            native_actions::TURN_ON_AIRPLANE_MODE,
            "The user explicitly asked the installed settings handler to enable airplane mode",
        ),
        "turn on amber alert" | "turn on amber alerts" | "enable amber alert" | "enable amber alerts" => (
            native_actions::TURN_ON_AMBER_ALERT,
            "The user explicitly asked the installed settings handler to enable Amber alerts",
        ),
        "turn on bluetooth" | "enable bluetooth" => (
            native_actions::TURN_ON_BLUETOOTH,
            "The user explicitly asked the installed settings handler to enable Bluetooth",
        ),
        "turn on cellular data" | "enable cellular data" => (
            native_actions::TURN_ON_CELLULAR_DATA,
            "The user explicitly asked the installed settings handler to enable cellular data",
        ),
        "turn on cellular roaming" | "enable cellular roaming" => (
            native_actions::TURN_ON_CELLULAR_ROAMING,
            "The user explicitly asked the installed settings handler to enable cellular roaming",
        ),
        "turn on emergency alert"
        | "turn on emergency alerts"
        | "enable emergency alert"
        | "enable emergency alerts" => (
            native_actions::TURN_ON_EMERGENCY_ALERT,
            "The user explicitly asked the installed settings handler to enable emergency alerts",
        ),
        "turn on public safety alert"
        | "turn on public safety alerts"
        | "enable public safety alert"
        | "enable public safety alerts" => (
            native_actions::TURN_ON_PUBLIC_SAFETY_ALERT,
            "The user explicitly asked the installed settings handler to enable public-safety alerts",
        ),
        "turn on wifi" | "turn on wi fi" | "enable wifi" | "enable wi fi" => (
            native_actions::TURN_ON_WIFI,
            "The user explicitly asked the installed settings handler to enable Wi-Fi",
        ),
        "scan wifi qr code"
        | "scan wi fi qr code"
        | "wifi qr scan"
        | "wi fi qr scan" => (
            native_actions::WIFI_QR_SCAN,
            "The user explicitly asked to open the installed Wi-Fi QR scanner",
        ),
        _ => return None,
    };

    Some(allowed_restored_stock_mutation(
        request,
        action_name,
        thought,
        "{}".to_string(),
    ))
}

pub(super) fn allowed_restored_stock_mutation(
    request: &SynapseUnderstandingRequest,
    action_name: &'static str,
    thought: &'static str,
    input_json: String,
) -> Option<PlannedNativeDeviceAction> {
    let spec = native_action_spec(action_name)?;
    if action_is_excluded(request, action_name)
        || (spec.requires_confirmed_unlock() && !request_is_explicitly_unlocked(request))
    {
        return None;
    }
    Some(PlannedNativeDeviceAction {
        action_name,
        thought,
        input_json,
    })
}
