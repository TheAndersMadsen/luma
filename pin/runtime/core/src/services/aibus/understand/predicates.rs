//! Pure text, location, and proximity predicates used by AIBus understanding.
//!
//! Keeping these helpers free of handler state makes their authority boundaries
//! visible and lets the compiler prevent accidental runtime coupling.

use crate::proto::aibus::Location;

use super::{LocationIntent, NEARBY_CATEGORY_ALIASES};

pub(super) fn classify_location_intent(utterance: &str) -> Option<LocationIntent> {
    let normalized = normalize_utterance(utterance);
    if normalized.is_empty() {
        return None;
    }

    let reverse_geocode = is_bounded_reverse_geocode_intent(&normalized);

    let nearby_signal = [
        "nearby",
        "near me",
        "near us",
        "around me",
        "around us",
        "around here",
        "close by",
        "in this area",
    ]
    .iter()
    .any(|phrase| contains_phrase(&normalized, phrase));

    let nearby_query = bounded_proximity_query(&normalized)
        .or_else(|| nearby_signal.then(|| extract_nearby_query(&normalized)));

    (reverse_geocode || nearby_query.is_some()).then_some(LocationIntent {
        reverse_geocode,
        nearby_query,
    })
}

/// Parse only an adjacent conversational category substitution such as
/// "What about restaurants?". Free-form tails are deliberately rejected:
/// without a direct Nearby phrase they must stay with the conversational model.
pub(super) fn contextual_nearby_refinement_query(utterance: &str) -> Option<String> {
    let normalized = normalize_utterance(utterance);
    if normalized.is_empty() || normalized.len() > 128 {
        return None;
    }
    let mut category = ["what about ", "how about ", "and ", "try "]
        .iter()
        .find_map(|prefix| normalized.strip_prefix(prefix))?;
    if let Some(without_instead) = category.strip_suffix(" instead") {
        category = without_instead;
    }
    for determiner in ["some ", "any ", "the "] {
        if let Some(remainder) = category.strip_prefix(determiner) {
            category = remainder;
            break;
        }
    }
    NEARBY_CATEGORY_ALIASES
        .iter()
        .find_map(|(alias, canonical)| (*alias == category).then(|| (*canonical).to_string()))
}

pub(super) fn is_natural_weather_question(utterance: &str) -> bool {
    let normalized = normalize_utterance(utterance);
    let unambiguous_weather_term = ["weather", "forecast", "temperature", "uv index"]
        .iter()
        .any(|term| contains_phrase(&normalized, term));
    let precipitation_term = ["rain", "raining", "snow", "snowing"]
        .iter()
        .any(|term| contains_phrase(&normalized, term));
    let question_or_time_cue = [
        "will it",
        "is it",
        "does it",
        "going to",
        "today",
        "tomorrow",
        "tonight",
        "this morning",
        "this afternoon",
        "this evening",
        "outside",
    ]
    .iter()
    .any(|term| contains_phrase(&normalized, term));
    unambiguous_weather_term || (precipitation_term && question_or_time_cue)
}

pub(super) fn is_explicit_remote_weather_question(utterance: &str) -> bool {
    if !is_natural_weather_question(utterance) {
        return false;
    }
    let normalized = normalize_utterance(utterance);
    if normalized.contains(" trip to ") {
        return true;
    }
    normalized.match_indices(" in ").any(|(index, marker)| {
        let tail = normalized[index + marker.len()..].trim_start();
        !tail.is_empty()
            && ![
                "here",
                "my location",
                "my current location",
                "where i am",
                "today",
                "tomorrow",
                "tonight",
                "now",
                "right now",
                "this morning",
                "this afternoon",
                "this evening",
                "the morning",
                "the afternoon",
                "the evening",
            ]
            .iter()
            .any(|deictic| tail == *deictic || tail.starts_with(&format!("{deictic} ")))
    }) || ["weather for ", "forecast for ", "temperature for "]
        .iter()
        .filter_map(|marker| normalized.find(marker).map(|index| (marker, index)))
        .any(|(marker, index)| {
            let tail = normalized[index + marker.len()..].trim_start();
            !tail.is_empty()
                && ![
                    "me",
                    "my location",
                    "my current location",
                    "today",
                    "tomorrow",
                    "tonight",
                    "now",
                    "right now",
                    "this morning",
                    "this afternoon",
                    "this evening",
                ]
                .iter()
                .any(|deictic| tail == *deictic || tail.starts_with(&format!("{deictic} ")))
        })
}

/// Parse only bounded, device-relative nearest/closest requests. Explicit
/// non-device destinations stay with the conversational model, so a factual
/// superlative such as `nearest star to Earth` never becomes a Nearby lookup.
pub(super) fn bounded_proximity_query(normalized: &str) -> Option<String> {
    if normalized.len() > 256 {
        return None;
    }
    let mut request = normalized;
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
        if let Some(rest) = request.strip_prefix(prefix) {
            request = rest;
            break;
        }
    }

    let mut implies_device_location = false;
    for prefix in ["take me to ", "where is ", "where s "] {
        if let Some(rest) = request.strip_prefix(prefix) {
            request = rest;
            implies_device_location = true;
            break;
        }
    }
    if !implies_device_location {
        for prefix in ["what is ", "what s ", "show me ", "find "] {
            if let Some(rest) = request.strip_prefix(prefix) {
                request = rest;
                break;
            }
        }
    }
    if let Some(rest) = request.strip_prefix("the ") {
        request = rest;
    }
    let mut query = request
        .strip_prefix("nearest ")
        .or_else(|| request.strip_prefix("closest "))?;

    let mut device_relative_suffix = false;
    for suffix in [
        " to me",
        " to us",
        " to here",
        " near me",
        " near us",
        " near here",
        " around here",
        " here",
    ] {
        if let Some(rest) = query.strip_suffix(suffix) {
            query = rest;
            device_relative_suffix = true;
            break;
        }
    }
    if !device_relative_suffix && !implies_device_location {
        return None;
    }
    if [" to ", " in ", " at ", " from "]
        .iter()
        .any(|separator| query.contains(separator))
    {
        return None;
    }
    if [
        "star", "planet", "galaxy", "number", "integer", "date", "word", "value",
    ]
    .iter()
    .any(|factual| query == *factual || query.ends_with(&format!(" {factual}")))
    {
        return None;
    }

    let query = query.trim();
    if query.is_empty() || matches!(query, "one" | "place" | "thing") {
        return None;
    }
    Some(query.chars().take(64).collect())
}

/// Recognize only questions about the device's own current position. Bare
/// prefixes such as `what city` or `what country` are deliberately rejected:
/// they also begin ordinary factual questions and must remain with the model.
pub(super) fn is_bounded_reverse_geocode_intent(normalized: &str) -> bool {
    let mut query = normalized;
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
        if let Some(rest) = query.strip_prefix(prefix) {
            query = rest;
            break;
        }
    }
    for wrapper in [
        "tell me ",
        "figure out ",
        "work out ",
        "check ",
        "show me ",
        "let me know ",
        "do you know ",
    ] {
        if let Some(rest) = query.strip_prefix(wrapper) {
            query = rest;
            break;
        }
    }
    if let Some(rest) = query.strip_suffix(" please") {
        query = rest;
    }
    for suffix in [" right now", " at the moment", " currently", " now"] {
        if let Some(rest) = query.strip_suffix(suffix) {
            query = rest;
            break;
        }
    }

    if [
        "where am i",
        "where i am",
        "where exactly am i",
        "where are we",
        "where we are",
        "where exactly are we",
        "my location",
        "my current location",
        "our location",
        "our current location",
        "current location",
        "what is my location",
        "what s my location",
        "what is my current location",
        "what s my current location",
        "what is our location",
        "what s our location",
        "what is our current location",
        "what s our current location",
    ]
    .contains(&query)
    {
        return true;
    }

    for noun in [
        "city",
        "town",
        "neighborhood",
        "neighbourhood",
        "country",
        "address",
        "street",
        "area",
    ] {
        let preposition = match noun {
            "street" => "on",
            "address" => "at",
            _ => "in",
        };
        for determiner in ["what", "which"] {
            for subject in ["am i", "i am", "are we", "we are"] {
                if query == format!("{determiner} {noun} {subject} {preposition}")
                    || query == format!("{determiner} {noun} {subject} currently {preposition}")
                {
                    return true;
                }
            }
            if query == format!("{determiner} {noun} is this")
                || query == format!("{determiner} {noun} is here")
                || query == format!("{determiner} is this {noun}")
                || query == format!("{determiner} is the {noun} here")
            {
                return true;
            }
        }
        if query == format!("what is my current {noun}")
            || query == format!("what s my current {noun}")
            || query == format!("what is our current {noun}")
            || query == format!("what s our current {noun}")
        {
            return true;
        }
    }

    false
}

pub(super) fn is_location_followup(utterance: &str) -> bool {
    let normalized = normalize_utterance(utterance);
    if normalized.is_empty() {
        return false;
    }
    let ordinal_phrases = [
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
        "sixth",
        "seventh",
        "eighth",
        "number one",
        "number two",
        "number three",
        "number four",
        "number five",
        "number six",
        "number seven",
        "number eight",
        "number 1",
        "number 2",
        "number 3",
        "number 4",
        "number 5",
        "number 6",
        "number 7",
        "number 8",
        "1st",
        "2nd",
        "3rd",
        "4th",
        "5th",
        "6th",
        "7th",
        "8th",
    ];
    let contains_ordinal = ordinal_phrases
        .iter()
        .any(|phrase| contains_phrase(&normalized, phrase));
    let ordinal_target = [
        "one", "ones", "place", "places", "option", "options", "result", "results", "listing",
        "listings",
    ]
    .iter()
    .any(|phrase| contains_phrase(&normalized, phrase));
    let ordinal_place_detail = [
        "address",
        "close",
        "closest",
        "distance",
        "far",
        "hours",
        "navigate",
        "near",
        "nearest",
        "open",
        "phone",
        "walk",
        "walking",
        "website",
        "directions",
    ]
    .iter()
    .any(|phrase| contains_phrase(&normalized, phrase));
    let standalone_ordinal = ordinal_phrases.iter().any(|phrase| {
        normalized == *phrase
            || normalized == format!("the {phrase}")
            || normalized == format!("and the {phrase}")
            || normalized == format!("{phrase} one")
            || normalized == format!("the {phrase} one")
            || normalized == format!("and the {phrase} one")
    });
    let ordinal_reference =
        contains_ordinal && (ordinal_target || ordinal_place_detail || standalone_ordinal);

    let explicit_place_reference = [
        "this place",
        "that place",
        "these places",
        "those places",
        "over there",
        "go there",
        "walk there",
        "drive there",
        "navigate there",
        "directions there",
        "which one",
        "which is closest",
        "which is nearest",
    ]
    .iter()
    .any(|phrase| contains_phrase(&normalized, phrase));

    let pronoun_reference = ["it", "its", "they", "them", "one", "ones"]
        .iter()
        .any(|phrase| contains_phrase(&normalized, phrase));
    let place_detail = [
        "address",
        "about",
        "close",
        "closest",
        "distance",
        "far",
        "hours",
        "navigate",
        "near",
        "nearest",
        "open",
        "phone",
        "walk",
        "walking",
        "website",
        "directions",
    ]
    .iter()
    .any(|phrase| contains_phrase(&normalized, phrase));
    let standalone_followup = matches!(
        normalized.as_str(),
        "tell me more" | "what about" | "how far" | "give me directions" | "start navigation"
    );

    ordinal_reference
        || explicit_place_reference
        || (pronoun_reference && place_detail)
        || standalone_followup
}

pub(super) fn extract_nearby_query(normalized: &str) -> String {
    for (phrase, canonical) in NEARBY_CATEGORY_ALIASES {
        if contains_phrase(normalized, phrase) {
            return (*canonical).to_string();
        }
    }

    let mut remainder = normalized.to_string();
    for phrase in [
        "in this area",
        "around here",
        "around me",
        "around us",
        "near me",
        "near us",
        "close by",
        "nearby",
    ] {
        remainder = remainder.replace(phrase, " ");
    }
    let stop_words = [
        "find", "show", "me", "us", "please", "what", "whats", "s", "where", "which", "are", "is",
        "there", "any", "some", "the", "a", "an", "places", "place",
    ];
    remainder
        .split_whitespace()
        .filter(|word| !stop_words.contains(word))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(64)
        .collect()
}

pub(super) fn normalize_utterance(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn contains_phrase(value: &str, phrase: &str) -> bool {
    value == phrase
        || value.starts_with(&format!("{phrase} "))
        || value.ends_with(&format!(" {phrase}"))
        || value.contains(&format!(" {phrase} "))
}

pub(super) fn distance_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_METERS: f64 = 6_371_000.0;
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let delta_lat = lat2 - lat1;
    let delta_lon = (lon2 - lon1).to_radians();
    let a =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_METERS * a.sqrt().atan2((1.0 - a).sqrt())
}

pub(super) fn format_coordinate(value: f64) -> String {
    format!("{value:.3}")
}

pub(super) fn valid_location(location: &Location) -> bool {
    location.latitude.is_finite()
        && location.longitude.is_finite()
        && (-90.0..=90.0).contains(&location.latitude)
        && (-180.0..=180.0).contains(&location.longitude)
}
