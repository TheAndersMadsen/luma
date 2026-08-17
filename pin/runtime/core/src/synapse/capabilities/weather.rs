use crate::config::TemperatureUnit;
use crate::external::weather::{CurrentWeather, WeatherReport};
use crate::proto::aibus::SynapseUnderstandingRequest;

const MAX_WEATHER_UTTERANCE_BYTES: usize = 256;
const MAX_WEATHER_SUMMARY_CHARS: usize = 160;
const MAX_WEATHER_ALERT_TITLE_CHARS: usize = 120;
const MAX_WEATHER_LOCALITY_CHARS: usize = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeatherPromptKind {
    Current,
    Tomorrow,
    Alerts,
}

/// Recognize a deliberately bounded set of complete weather questions.
///
/// Weather was not one of Humane's annotated device actions: the stock home
/// screen called `EncryptedWeather`, while conversational weather depended on
/// the retired remote assistant selecting a provider tool. Resolve these
/// common prompts before the configured LLM so the bundled Codex runtime (whose
/// arbitrary tools are intentionally disabled) can still use the configured
/// Pirate Weather service with the Pin's current request location.
pub fn plan_weather_prompt(request: &SynapseUnderstandingRequest) -> Option<WeatherPromptKind> {
    if request
        .device_context
        .as_ref()
        .is_none_or(|context| context.is_locked)
        || request.utterance.len() > MAX_WEATHER_UTTERANCE_BYTES
    {
        return None;
    }

    let utterance = normalize(&request.utterance);
    match utterance.as_str() {
        "what is the weather"
        | "what s the weather"
        | "what is the weather like"
        | "what s the weather like"
        | "what is the weather like today"
        | "what s the weather like today"
        | "what is the weather here"
        | "what s the weather here"
        | "what is the weather like here"
        | "what s the weather like here"
        | "what is the weather where i am"
        | "what s the weather where i am"
        | "what is the weather like where i am"
        | "what s the weather like where i am"
        | "what is the weather where i am right now"
        | "what s the weather where i am right now"
        | "what is the weather like where i am right now"
        | "what s the weather like where i am right now"
        | "what is the weather at my current location"
        | "what s the weather at my current location"
        | "what is the weather outside"
        | "what s the weather outside"
        | "what is the weather like outside"
        | "what s the weather like outside"
        | "tell me the weather outside"
        | "what is the current weather"
        | "what s the current weather"
        | "current weather"
        | "weather now"
        | "weather right now"
        | "weather today"
        | "what is the temperature"
        | "what is the temperature outside"
        | "how hot is it"
        | "how hot is it outside"
        | "how cold is it"
        | "how cold is it outside"
        | "is it raining"
        | "is it raining outside" => Some(WeatherPromptKind::Current),

        "what is the weather tomorrow"
        | "what s the weather tomorrow"
        | "what will the weather be tomorrow"
        | "what ll the weather be tomorrow"
        | "weather tomorrow"
        | "tomorrow s weather"
        | "will it rain tomorrow"
        | "do i need a jacket tomorrow" => Some(WeatherPromptKind::Tomorrow),

        "are there any weather alerts"
        | "are there weather alerts"
        | "weather alerts"
        | "weather warnings"
        | "are there any weather warnings" => Some(WeatherPromptKind::Alerts),
        _ => None,
    }
}

#[cfg(test)]
pub fn format_current_weather(current: &CurrentWeather, unit: TemperatureUnit) -> String {
    format_current_weather_with_locality(current, unit, None)
}

pub fn format_current_weather_with_locality(
    current: &CurrentWeather,
    unit: TemperatureUnit,
    locality: Option<&str>,
) -> String {
    let summary = sentence_fragment(&current.summary, "Current conditions");
    let temperature = match unit {
        TemperatureUnit::Celsius => {
            format!("{:.0} degrees Celsius", current.temperature_celsius)
        }
        TemperatureUnit::Fahrenheit => {
            format!("{:.0} degrees Fahrenheit", current.temperature_fahrenheit)
        }
    };
    let locality = bounded_weather_locality(locality)
        .map(|locality| format!(" in {locality}"))
        .unwrap_or_default();
    let mut response = format!("{summary}, {temperature}{locality}.");
    if current.has_precipitation {
        let precipitation = current
            .precipitation_type
            .as_deref()
            .map(|value| bounded_provider_text(value, MAX_WEATHER_ALERT_TITLE_CHARS))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "precipitation".to_string());
        response.push_str(&format!(" There is {precipitation} right now."));
    }
    response
}

#[cfg(test)]
pub fn format_tomorrow_weather(report: &WeatherReport, unit: TemperatureUnit) -> Option<String> {
    format_tomorrow_weather_with_locality(report, unit, None)
}

pub fn format_tomorrow_weather_with_locality(
    report: &WeatherReport,
    unit: TemperatureUnit,
    locality: Option<&str>,
) -> Option<String> {
    // Pirate Weather index zero is today's daily point. Never relabel it as
    // tomorrow when the provider returns an incomplete one-day response.
    let point = report.daily.get(1)?;
    let summary = point
        .summary
        .as_deref()
        .map(|value| sentence_fragment(value, "Forecast"))
        .unwrap_or_else(|| "Forecast".to_string());
    let locality = bounded_weather_locality(locality)
        .map(|locality| format!(" in {locality}"))
        .unwrap_or_default();
    let mut parts = vec![format!("Tomorrow{locality}: {summary}.")];

    if let Some(high_f) = point.temperature_high_fahrenheit {
        parts.push(match unit {
            TemperatureUnit::Celsius => {
                format!("High {:.0} degrees Celsius.", fahrenheit_to_celsius(high_f))
            }
            TemperatureUnit::Fahrenheit => {
                format!("High {high_f:.0} degrees Fahrenheit.")
            }
        });
    }
    if let Some(low_f) = point.temperature_low_fahrenheit {
        parts.push(match unit {
            TemperatureUnit::Celsius => {
                format!("Low {:.0} degrees Celsius.", fahrenheit_to_celsius(low_f))
            }
            TemperatureUnit::Fahrenheit => {
                format!("Low {low_f:.0} degrees Fahrenheit.")
            }
        });
    }
    if let Some(probability) = point.precipitation_probability {
        if probability.is_finite() && (0.0..=1.0).contains(&probability) {
            parts.push(format!(
                "Chance of precipitation {:.0} percent.",
                probability * 100.0
            ));
        }
    }
    Some(parts.join(" "))
}

#[cfg(test)]
pub fn format_weather_alerts(report: &WeatherReport) -> String {
    format_weather_alerts_with_locality(report, None)
}

pub fn format_weather_alerts_with_locality(
    report: &WeatherReport,
    locality: Option<&str>,
) -> String {
    let titles = report
        .alerts
        .iter()
        .filter_map(|alert| alert.title.as_deref())
        .map(|title| bounded_provider_text(title, MAX_WEATHER_ALERT_TITLE_CHARS))
        .filter(|title| !title.is_empty())
        .take(3)
        .collect::<Vec<_>>();
    let locality = bounded_weather_locality(locality);
    if titles.is_empty() {
        locality.map_or_else(
            || "There are no current weather alerts for your location.".to_string(),
            |locality| format!("There are no current weather alerts for {locality}."),
        )
    } else if titles.len() == 1 {
        locality.map_or_else(
            || format!("There is one current weather alert: {}.", titles[0]),
            |locality| {
                format!(
                    "There is one current weather alert for {locality}: {}.",
                    titles[0]
                )
            },
        )
    } else {
        locality.map_or_else(
            || {
                format!(
                    "There are {} current weather alerts: {}.",
                    titles.len(),
                    titles.join("; ")
                )
            },
            |locality| {
                format!(
                    "There are {} current weather alerts for {locality}: {}.",
                    titles.len(),
                    titles.join("; ")
                )
            },
        )
    }
}

fn bounded_weather_locality(locality: Option<&str>) -> Option<String> {
    locality
        .map(|value| bounded_provider_text(value, MAX_WEATHER_LOCALITY_CHARS))
        .filter(|value| !value.is_empty())
}

fn normalize(value: &str) -> String {
    let mut normalized = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character.is_whitespace() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
    ] {
        if let Some(remainder) = normalized.strip_prefix(prefix) {
            normalized = remainder.to_string();
            break;
        }
    }
    normalized
}

fn sentence_fragment(value: &str, fallback: &str) -> String {
    let value = bounded_provider_text(value, MAX_WEATHER_SUMMARY_CHARS);
    let value = value.trim_end_matches(['.', '!', '?']);
    let value = if value.is_empty() { fallback } else { value };
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => fallback.to_string(),
    }
}

/// Provider strings become stock action JSON and spoken output. Collapse all
/// controls/whitespace and cap by Unicode scalar count so an upstream response
/// cannot produce an oversized or multi-line narration.
fn bounded_provider_text(value: &str, maximum_chars: usize) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control() || character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    normalized.chars().take(maximum_chars).collect()
}

fn fahrenheit_to_celsius(value: f64) -> f64 {
    (value - 32.0) * 5.0 / 9.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external::weather::{WeatherAlertSummary, WeatherPoint};

    fn request(utterance: &str) -> SynapseUnderstandingRequest {
        SynapseUnderstandingRequest {
            utterance: utterance.to_string(),
            device_context: Some(crate::proto::aibus::SynapseDeviceContext {
                is_locked: false,
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn complete_common_weather_prompts_are_classified() {
        for (utterance, expected) in [
            ("What's the weather?", WeatherPromptKind::Current),
            ("What's the weather like today?", WeatherPromptKind::Current),
            (
                "What's the weather like where I am right now?",
                WeatherPromptKind::Current,
            ),
            (
                "WHAT'S THE WEATHER LIKE TODAY!!!",
                WeatherPromptKind::Current,
            ),
            (
                "Please tell me the weather outside",
                WeatherPromptKind::Current,
            ),
            ("Will it rain tomorrow?", WeatherPromptKind::Tomorrow),
            ("Are there any weather alerts?", WeatherPromptKind::Alerts),
        ] {
            assert_eq!(plan_weather_prompt(&request(utterance)), Some(expected));
        }
    }

    #[test]
    fn ambiguous_or_extended_weather_mentions_fall_through() {
        for utterance in [
            "Tell me about weather satellites",
            "Why does weather change?",
            "Weather in Tokyo",
            "Will it rain next month?",
            "I like this weather",
        ] {
            assert_eq!(
                plan_weather_prompt(&request(utterance)),
                None,
                "{utterance}"
            );
        }
    }

    #[test]
    fn weather_prompts_are_not_resolved_on_the_lock_screen() {
        let unknown = SynapseUnderstandingRequest {
            utterance: "what's the weather".to_string(),
            ..Default::default()
        };
        assert_eq!(plan_weather_prompt(&unknown), None);

        let mut locked = request("what's the weather");
        locked.device_context = Some(crate::proto::aibus::SynapseDeviceContext {
            is_locked: true,
            ..Default::default()
        });
        assert_eq!(plan_weather_prompt(&locked), None);
    }

    #[test]
    fn current_forecast_and_alert_text_are_bounded_and_complete() {
        let current = CurrentWeather {
            temperature_fahrenheit: 64.0,
            temperature_celsius: 17.8,
            summary: "partly cloudy".to_string(),
            icon: "partly-cloudy-day".to_string(),
            uv_index: 3,
            has_precipitation: true,
            precipitation_type: Some("rain".to_string()),
        };
        assert_eq!(
            format_current_weather(&current, TemperatureUnit::Celsius),
            "Partly cloudy, 18 degrees Celsius. There is rain right now."
        );
        assert_eq!(
            format_current_weather(&current, TemperatureUnit::Fahrenheit),
            "Partly cloudy, 64 degrees Fahrenheit. There is rain right now."
        );

        let mut report = WeatherReport {
            latitude: 55.0,
            longitude: 12.0,
            timezone: None,
            current: None,
            hourly: vec![],
            daily: vec![WeatherPoint {
                time: None,
                summary: Some("clear".to_string()),
                icon: None,
                temperature_fahrenheit: None,
                temperature_celsius: None,
                apparent_temperature_fahrenheit: None,
                apparent_temperature_celsius: None,
                temperature_high_fahrenheit: Some(68.0),
                temperature_low_fahrenheit: Some(50.0),
                precipitation_probability: Some(0.25),
                precipitation_type: None,
                precipitation_intensity: None,
                humidity: None,
                wind_speed: None,
                uv_index: None,
            }],
            alerts: vec![],
        };
        assert_eq!(
            format_tomorrow_weather(&report, TemperatureUnit::Celsius),
            None
        );
        report.daily.insert(0, report.daily[0].clone());
        assert_eq!(
            format_tomorrow_weather(&report, TemperatureUnit::Celsius).unwrap(),
            "Tomorrow: Clear. High 20 degrees Celsius. Low 10 degrees Celsius. Chance of precipitation 25 percent."
        );
        assert_eq!(
            format_weather_alerts(&report),
            "There are no current weather alerts for your location."
        );

        report.alerts = vec![WeatherAlertSummary {
            title: Some("Strong wind".to_string()),
            severity: None,
            time: None,
            expires: None,
            description: None,
            uri: None,
        }];
        assert_eq!(
            format_weather_alerts(&report),
            "There is one current weather alert: Strong wind."
        );

        let oversized = format!("storm\nwarning {}", "x".repeat(300));
        report.alerts[0].title = Some(oversized);
        let alerts = format_weather_alerts(&report);
        assert!(!alerts.contains('\n'));
        assert!(alerts.chars().count() < 200);

        let mut oversized_current = current.clone();
        oversized_current.summary = format!("cloudy\r\n{}", "y".repeat(300));
        let response = format_current_weather(&oversized_current, TemperatureUnit::Celsius);
        assert!(!response.contains('\n'));
        assert!(response.chars().count() < 260);
    }

    #[test]
    fn weather_narration_includes_only_a_bounded_current_fix_locality() {
        let current = CurrentWeather {
            temperature_fahrenheit: 71.6,
            temperature_celsius: 22.0,
            summary: "clear".to_string(),
            icon: "clear-day".to_string(),
            uv_index: 4,
            has_precipitation: false,
            precipitation_type: None,
        };
        assert_eq!(
            format_current_weather_with_locality(
                &current,
                TemperatureUnit::Celsius,
                Some("Hvidovre"),
            ),
            "Clear, 22 degrees Celsius in Hvidovre."
        );

        let mut report = WeatherReport {
            latitude: 55.0,
            longitude: 12.0,
            timezone: None,
            current: None,
            hourly: vec![],
            daily: vec![WeatherPoint {
                time: None,
                summary: Some("cloudy".to_string()),
                icon: None,
                temperature_fahrenheit: None,
                temperature_celsius: None,
                apparent_temperature_fahrenheit: None,
                apparent_temperature_celsius: None,
                temperature_high_fahrenheit: Some(68.0),
                temperature_low_fahrenheit: Some(50.0),
                precipitation_probability: None,
                precipitation_type: None,
                precipitation_intensity: None,
                humidity: None,
                wind_speed: None,
                uv_index: None,
            }],
            alerts: vec![],
        };
        assert_eq!(
            format_tomorrow_weather_with_locality(
                &report,
                TemperatureUnit::Celsius,
                Some("Hvidovre"),
            ),
            None
        );
        report.daily.insert(0, report.daily[0].clone());
        assert_eq!(
            format_tomorrow_weather_with_locality(
                &report,
                TemperatureUnit::Celsius,
                Some("Hvidovre"),
            )
            .unwrap(),
            "Tomorrow in Hvidovre: Cloudy. High 20 degrees Celsius. Low 10 degrees Celsius."
        );
        assert_eq!(
            format_weather_alerts_with_locality(&report, Some("Hvidovre")),
            "There are no current weather alerts for Hvidovre."
        );

        let oversized = format!("Hvidovre\n{}", "x".repeat(200));
        let response = format_current_weather_with_locality(
            &current,
            TemperatureUnit::Celsius,
            Some(&oversized),
        );
        assert!(!response.contains('\n'));
        assert!(response.chars().count() < 140);
        let blank_locality =
            format_current_weather_with_locality(&current, TemperatureUnit::Celsius, Some(" \n "));
        assert_eq!(
            blank_locality,
            format_current_weather(&current, TemperatureUnit::Celsius),
        );
    }
}
