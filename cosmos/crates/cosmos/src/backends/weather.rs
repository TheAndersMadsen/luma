//! Weather — Pirate Weather, mapped onto cosmos's AccuWeather-shaped response.
//!
//! cosmos's `WeatherResponse` is field-for-field an AccuWeather *Current
//! Conditions* payload. We hold a
//! Pirate Weather key instead; Pirate is a **Dark Sky**-compatible API. Every
//! field maps exactly except the icon, which is translated by [`accuweather_icon`].

use cosmos_protocol::aibus as pb;
use serde::Deserialize;

use super::{BackendError, http, key};

const KEY_VAR: &str = "COSMOS_PIRATE_WEATHER_KEY";

#[derive(Deserialize)]
struct Forecast {
    currently: Option<Currently>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Currently {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    icon: String,
    /// Fahrenheit — the API is queried with `units=us`.
    #[serde(default)]
    temperature: f64,
    #[serde(default)]
    precip_intensity: f64,
    #[serde(default)]
    precip_type: String,
    #[serde(default)]
    uv_index: f64,
}

/// Translate a Dark Sky / Pirate icon string to the AccuWeather icon number the
/// device expects.
///
/// **This is an approximation between two different vendors**, not a lossless
/// mapping, and it is the one field of `WeatherResponse` that is not exact.
/// Pirate emits 11 icon values; AccuWeather defines 44. Each Pirate value is
/// mapped to the closest AccuWeather concept, preserving the day/night split
/// that AccuWeather encodes in separate numbers:
///
/// | Pirate | AccuWeather | |
/// |---|---|---|
/// | `clear-day` | 1 | Sunny |
/// | `clear-night` | 33 | Clear (night) |
/// | `partly-cloudy-day` | 3 | Partly Sunny |
/// | `partly-cloudy-night` | 35 | Partly Cloudy (night) |
/// | `cloudy` | 7 | Cloudy |
/// | `fog` | 11 | Fog |
/// | `rain` | 18 | Rain |
/// | `thunderstorm` | 15 | Thunderstorms |
/// | `sleet` | 25 | Sleet |
/// | `snow` | 22 | Snow |
/// | `wind` | 32 | Windy |
///
/// An unrecognized value yields `0` — AccuWeather has no icon 0, so the device
/// receives an explicit "unknown" rather than a confidently wrong picture.
fn accuweather_icon(pirate: &str) -> i32 {
    match pirate {
        "clear-day" => 1,
        "clear-night" => 33,
        "partly-cloudy-day" => 3,
        "partly-cloudy-night" => 35,
        "cloudy" => 7,
        "fog" => 11,
        "rain" => 18,
        "thunderstorm" => 15,
        "sleet" => 25,
        "snow" => 22,
        "wind" => 32,
        _ => 0,
    }
}

/// Current conditions at a point, in cosmos's wire shape.
pub async fn current(latitude: f64, longitude: f64) -> Result<pb::WeatherResponse, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    let url = format!(
        "https://api.pirateweather.net/forecast/{api_key}/{latitude},{longitude}\
         ?units=us&exclude=minutely,hourly,daily,alerts"
    );
    let forecast: Forecast = http()
        .get(url)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    let now = forecast.currently.ok_or(BackendError::NoResult)?;
    Ok(to_wire(&now))
}

fn to_wire(now: &Currently) -> pb::WeatherResponse {
    // Pirate reports "none" when dry; cosmos's field carries a type only when
    // there is precipitation, so an absent type stays empty rather than "none".
    let precipitating = now.precip_intensity > 0.0 && now.precip_type != "none";
    pb::WeatherResponse {
        has_precipitation: precipitating,
        precipitation_type: if precipitating {
            now.precip_type.clone()
        } else {
            String::new()
        },
        temperature_fahrenheit: now.temperature,
        temperature_celsius: (now.temperature - 32.0) * 5.0 / 9.0,
        weather_text: now.summary.clone(),
        weather_icon: accuweather_icon(&now.icon),
        u_v_index: now.uv_index.round() as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(icon: &str, precip_intensity: f64, precip_type: &str) -> Currently {
        Currently {
            summary: "Clear".into(),
            icon: icon.into(),
            temperature: 60.96,
            precip_intensity,
            precip_type: precip_type.into(),
            uv_index: 2.79,
        }
    }

    #[test]
    fn maps_a_dry_reading_onto_the_accuweather_shape() {
        let w = to_wire(&sample("clear-day", 0.0, "none"));
        assert_eq!(w.weather_text, "Clear");
        assert_eq!(w.weather_icon, 1); // Sunny
        assert!(!w.has_precipitation);
        // "none" must not leak through as a precipitation type.
        assert_eq!(w.precipitation_type, "");
        assert!((w.temperature_fahrenheit - 60.96).abs() < 1e-6);
        // 60.96F == 16.09C
        assert!((w.temperature_celsius - 16.0889).abs() < 1e-3);
        assert_eq!(w.u_v_index, 3); // 2.79 rounds
    }

    #[test]
    fn wet_readings_preserve_the_precipitation_type() {
        let w = to_wire(&sample("rain", 0.12, "rain"));
        assert!(w.has_precipitation);
        assert_eq!(w.precipitation_type, "rain");
        assert_eq!(w.weather_icon, 18); // Rain
    }

    #[test]
    fn pirate_camel_case_thunderstorm_maps_to_a_stock_valid_wire_shape() {
        let forecast: Forecast = serde_json::from_str(
            r#"{
                "currently": {
                    "summary": "Thunderstorms",
                    "icon": "thunderstorm",
                    "temperature": 60.96,
                    "precipIntensity": 0.12,
                    "precipType": "rain",
                    "uvIndex": 2.79
                }
            }"#,
        )
        .expect("real Pirate Weather current-conditions shape should deserialize");
        let wire = to_wire(forecast.currently.as_ref().expect("current conditions"));

        assert_eq!(
            (
                wire.weather_icon,
                wire.has_precipitation,
                wire.precipitation_type.as_str(),
                wire.u_v_index,
            ),
            (15, true, "rain", 3),
        );
    }

    #[test]
    fn day_and_night_icons_stay_distinct_as_accuweather_encodes_them() {
        assert_eq!(accuweather_icon("clear-day"), 1);
        assert_eq!(accuweather_icon("clear-night"), 33);
        assert_eq!(accuweather_icon("partly-cloudy-day"), 3);
        assert_eq!(accuweather_icon("partly-cloudy-night"), 35);
    }

    #[test]
    fn an_unknown_icon_is_explicitly_unknown_not_a_confident_guess() {
        // AccuWeather defines no icon 0, so the device reads this as "unknown"
        // rather than being shown the wrong weather.
        assert_eq!(accuweather_icon("hail-of-frogs"), 0);
        assert_eq!(accuweather_icon(""), 0);
    }

    #[tokio::test]
    async fn without_a_key_the_capability_reports_absent() {
        // SAFETY: single-threaded test scope.
        unsafe {
            std::env::remove_var(KEY_VAR);
        }
        assert_eq!(
            current(37.77, -122.41).await,
            Err(BackendError::NotConfigured)
        );
    }
}
