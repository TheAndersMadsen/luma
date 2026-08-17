//! Argument parsing for the contact actions: name/number splitting and the
//! ASCII-case-insensitive prefix grammar.

use super::*;

/// Parse one complete contact mutation without guessing. The stock action
/// fields are all optional, but the installed handler can only complete the
/// write when both a name and phone number are present. It also always creates
/// the contact as trusted, regardless of the public `trusted` field.
pub(super) fn parse_create_contact_action(value: &str) -> Option<String> {
    let command = value.trim();
    if command.is_empty()
        || command.len() > 256
        || !command.is_ascii()
        || command.contains(['\r', '\n', ';', '|', '\0'])
    {
        return None;
    }
    let command = command.trim_end_matches(['.', '!', '?']).trim_end();
    let command = strip_ascii_case_prefixes(
        command,
        &[
            "can you please ",
            "could you please ",
            "would you please ",
            "can you ",
            "could you ",
            "would you ",
            "please ",
        ],
    );
    let normalized = normalize_words(command);
    if contains_instruction_injection_marker(&normalized)
        || [" and then ", " then ", " after that "]
            .iter()
            .any(|marker| normalized.contains(marker))
    {
        return None;
    }

    let (name, phone_number) = [
        "create a contact for ",
        "create contact for ",
        "create a contact ",
        "create contact ",
        "add a contact for ",
        "add contact for ",
        "add a contact ",
        "add contact ",
    ]
    .iter()
    .find_map(|prefix| {
        let remainder = strip_ascii_case_prefix(command, prefix)?;
        split_contact_name_and_number(remainder)
    })
    .or_else(|| {
        let remainder = strip_ascii_case_prefix(command, "add ")?;
        let (name, phone) = split_once_ascii_case(remainder, " as a contact with phone number ")
            .or_else(|| split_once_ascii_case(remainder, " as a contact with number "))?;
        Some((name, phone))
    })?;

    let name = name.trim();
    let phone_number = phone_number.trim();
    let name_parts = name.split_whitespace().collect::<Vec<_>>();
    let digits = phone_number
        .chars()
        .filter(|character| character.is_ascii_digit())
        .count();
    if !(1..=4).contains(&name_parts.len())
        || name_parts.iter().any(|part| {
            !part
                .chars()
                .any(|character| character.is_ascii_alphabetic())
                || part.chars().any(|character| {
                    !character.is_ascii_alphabetic() && !matches!(character, '-' | '\'')
                })
        })
        || !(7..=15).contains(&digits)
        || phone_number.len() > 32
        || phone_number.chars().any(|character| {
            !character.is_ascii_digit()
                && !character.is_ascii_whitespace()
                && !matches!(character, '+' | '-' | '(' | ')')
        })
    {
        return None;
    }

    let first_name = name_parts[0];
    let last_name = (name_parts.len() > 1).then(|| name_parts[1..].join(" "));
    let mut arguments = serde_json::Map::from_iter([
        (
            "firstName".to_string(),
            serde_json::Value::String(first_name.to_string()),
        ),
        ("trusted".to_string(), serde_json::Value::Bool(true)),
        (
            "phoneNumber".to_string(),
            serde_json::Value::String(phone_number.to_string()),
        ),
    ]);
    if let Some(last_name) = last_name {
        arguments.insert("lastName".to_string(), serde_json::Value::String(last_name));
    }
    Some(serde_json::Value::Object(arguments).to_string())
}

pub(super) fn split_contact_name_and_number(value: &str) -> Option<(&str, &str)> {
    split_once_ascii_case(value, " with phone number ")
        .or_else(|| split_once_ascii_case(value, " with number "))
}

pub(super) fn strip_ascii_case_prefixes<'a>(value: &'a str, prefixes: &[&str]) -> &'a str {
    prefixes
        .iter()
        .find_map(|prefix| strip_ascii_case_prefix(value, prefix))
        .unwrap_or(value)
}

pub(super) fn strip_ascii_case_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())?
        .eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

pub(super) fn split_once_ascii_case<'a>(
    value: &'a str,
    separator: &str,
) -> Option<(&'a str, &'a str)> {
    let index = value.to_ascii_lowercase().find(separator)?;
    Some((&value[..index], &value[index + separator.len()..]))
}
