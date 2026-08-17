use crate::tier_a::native_actions;

const MAX_BLUETOOTH_DEVICE_NAME_BYTES: usize = 128;
const MAX_BLUETOOTH_DEVICE_NAME_WORDS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BluetoothSettingsOperation {
    Connect,
    Disconnect,
}

impl BluetoothSettingsOperation {
    pub const fn lookup_action_name(self) -> &'static str {
        match self {
            Self::Connect => native_actions::GET_NEW_BLUETOOTH_ADDRESS,
            Self::Disconnect => native_actions::GET_PAIRED_BLUETOOTH_ADDRESS,
        }
    }

    pub const fn mutation_action_name(self) -> &'static str {
        match self {
            Self::Connect => native_actions::CONNECT_TO_BLUETOOTH,
            Self::Disconnect => native_actions::DISCONNECT_BLUETOOTH,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BluetoothSettingsRequest {
    pub operation: BluetoothSettingsOperation,
    pub device_name: String,
}

/// Parse only complete named-device Bluetooth commands.
///
/// The name is intentionally retained as text, never interpreted as an address.
/// `settings/3` must resolve it through the stock device lookup action before a
/// later turn may emit a connect/disconnect mutation.
pub fn parse_bluetooth_settings_request(raw: &str) -> Option<BluetoothSettingsRequest> {
    if raw.is_empty() || raw.len() > 512 || raw.chars().any(char::is_control) {
        return None;
    }
    let command = strip_polite_prefix(raw.trim())
        .trim_end_matches(['.', '!'])
        .trim();
    if command.is_empty() || command.ends_with('?') {
        return None;
    }

    let (operation, raw_name) = [
        (BluetoothSettingsOperation::Disconnect, "disconnect from "),
        (BluetoothSettingsOperation::Disconnect, "disconnect "),
        (BluetoothSettingsOperation::Connect, "connect to "),
        (BluetoothSettingsOperation::Connect, "connect "),
        (BluetoothSettingsOperation::Connect, "pair with "),
        (BluetoothSettingsOperation::Connect, "pair "),
    ]
    .into_iter()
    .find_map(|(operation, prefix)| {
        strip_prefix_ascii_case(command, prefix).map(|name| (operation, name))
    })?;

    let raw_name = raw_name.trim();
    let raw_name = ["my ", "the ", "a ", "an "]
        .into_iter()
        .find_map(|prefix| strip_prefix_ascii_case(raw_name, prefix))
        .unwrap_or(raw_name)
        .trim();
    valid_requested_bluetooth_device_name(raw_name).then(|| BluetoothSettingsRequest {
        operation,
        device_name: raw_name.to_string(),
    })
}

pub fn normalize_bluetooth_device_name(value: &str) -> Option<String> {
    if !valid_bluetooth_device_name_syntax(value) {
        return None;
    }
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_lowercase().next().unwrap_or(character)
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

fn valid_bluetooth_device_name_syntax(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_BLUETOOTH_DEVICE_NAME_BYTES
        || value.split_whitespace().count() > MAX_BLUETOOTH_DEVICE_NAME_WORDS
        || !value.chars().any(char::is_alphabetic)
        || value.chars().any(|character| {
            !(character.is_alphanumeric()
                || character.is_whitespace()
                || matches!(
                    character,
                    '-' | '_' | '\'' | '’' | '.' | '(' | ')' | '+' | '&' | '#' | ':' | '/'
                ))
        })
    {
        return false;
    }

    true
}

fn valid_requested_bluetooth_device_name(value: &str) -> bool {
    if !valid_bluetooth_device_name_syntax(value) || looks_like_bluetooth_address(value) {
        return false;
    }
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_lowercase().next().unwrap_or(character)
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    !matches!(
        normalized.as_str(),
        "bluetooth"
            | "bluetooth device"
            | "device"
            | "headphone"
            | "headphones"
            | "earbud"
            | "earbuds"
            | "speaker"
            | "it"
            | "this"
            | "that"
            | "them"
            | "something"
    ) && ![" and ", " then ", " after ", " when "]
        .iter()
        .any(|separator| format!(" {normalized} ").contains(separator))
}

fn looks_like_bluetooth_address(value: &str) -> bool {
    let mut octets = value.split(':');
    (0..6).all(|_| {
        octets.next().is_some_and(|octet| {
            octet.len() == 2 && octet.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    }) && octets.next().is_none()
}

fn strip_polite_prefix(mut value: &str) -> &str {
    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "will you please ",
        "can you ",
        "could you ",
        "would you ",
        "will you ",
        "please ",
    ] {
        if let Some(remainder) = strip_prefix_ascii_case(value, prefix) {
            value = remainder.trim_start();
            break;
        }
    }
    value
}

fn strip_prefix_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())?
        .eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_complete_named_bluetooth_commands() {
        assert_eq!(
            parse_bluetooth_settings_request("Please connect to my Acme Nova X1."),
            Some(BluetoothSettingsRequest {
                operation: BluetoothSettingsOperation::Connect,
                device_name: "Acme Nova X1".to_string(),
            })
        );
        assert_eq!(
            parse_bluetooth_settings_request("Disconnect from Taylor’s Nova X1"),
            Some(BluetoothSettingsRequest {
                operation: BluetoothSettingsOperation::Disconnect,
                device_name: "Taylor’s Nova X1".to_string(),
            })
        );
    }

    #[test]
    fn rejects_generic_addresses_questions_and_compound_mutations() {
        for prompt in [
            "connect bluetooth",
            "connect to my headphones",
            "connect 00:00:5E:00:53:FF",
            "can you connect to Acme Nova X1?",
            "connect to Acme Nova X1 and turn up the volume",
            "disconnect it",
        ] {
            assert!(
                parse_bluetooth_settings_request(prompt).is_none(),
                "prompt: {prompt}"
            );
        }
    }

    #[test]
    fn device_name_normalization_is_bounded_and_case_insensitive() {
        assert_eq!(
            normalize_bluetooth_device_name("ACME NOVA X1"),
            Some("acme nova x1".to_string())
        );
        assert_eq!(
            normalize_bluetooth_device_name("Acme_Nova X1"),
            Some("acme nova x1".to_string())
        );
        assert!(normalize_bluetooth_device_name(&"a".repeat(129)).is_none());
    }
}
