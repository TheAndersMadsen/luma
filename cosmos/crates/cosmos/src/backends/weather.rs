//! Weather, Pirate Weather, mapped onto cosmos's AccuWeather-shaped response.
//!
//! cosmos's `WeatherResponse` is field-for-field an AccuWeather *Current
//! Conditions* payload. We hold a
//! Pirate Weather key instead. Pirate is a **Dark Sky**-compatible API. Every
//! field maps exactly except the icon, which is translated by [`accuweather_icon`].
//!
//! The stock RPC carries current conditions only. The assistant's `weather`
//! tool also reads Pirate's daily forecast from the same request, through
//! [`outlook`], so "will it rain tomorrow?" gets a grounded answer.

use cosmos_protocol::aibus as pb;
use serde::Deserialize;

use super::{BackendError, http, key};

const KEY_VAR: &str = "COSMOS_PIRATE_WEATHER_KEY";

#[derive(Deserialize)]
struct Forecast {
    currently: Option<Currently>,
    /// Hours east of UTC at the forecast point.
    #[serde(default)]
    offset: f64,
    #[serde(default)]
    daily: Option<Daily>,
}

#[derive(Deserialize)]
struct Daily {
    #[serde(default)]
    data: Vec<Day>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Day {
    /// Local midnight of this day, in Unix seconds.
    time: i64,
    #[serde(default)]
    summary: String,
    temperature_high: Option<f64>,
    temperature_low: Option<f64>,
    #[serde(default)]
    precip_probability: f64,
    #[serde(default)]
    precip_type: String,
}

/// One day of Pirate's daily forecast at the forecast point.
#[derive(Clone, Debug, PartialEq)]
pub struct DailyForecast {
    /// The local calendar day this forecast covers.
    pub date: time::Date,
    pub summary: String,
    pub high_fahrenheit: Option<f64>,
    pub low_fahrenheit: Option<f64>,
    /// 0.0 to 1.0.
    pub precipitation_probability: f64,
    /// Empty when Pirate reports no precipitation type.
    pub precipitation_type: String,
}

/// Current conditions plus the daily forecast, first day = today locally.
#[derive(Clone, Debug, PartialEq)]
pub struct Outlook {
    pub current: pb::WeatherResponse,
    pub days: Vec<DailyForecast>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Currently {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    icon: String,
    /// Fahrenheit, the API is queried with `units=us`.
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
/// Pirate emits 11 default icon values, documents `hail` as a future value, and
/// can rarely return `none`. AccuWeather defines 44 icon numbers, of which the
/// stock SystemNavigation renderer supports 40. Each recognized Pirate value is
/// mapped to the closest supported AccuWeather concept, preserving the day/night
/// split that AccuWeather encodes in separate numbers:
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
/// | `hail` | 24 | Ice |
///
/// Missing, `none`, and unrecognized values use the Pin-local adapter's generic
/// partly-cloudy fallback (`3`). Stock treats icon `0` as an invalid response and
/// replaces the complete weather card with "weather not available".
fn accuweather_icon(pirate: &str) -> i32 {
    match pirate.trim().to_ascii_lowercase().as_str() {
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
        "hail" => 24,
        _ => 3,
    }
}

/// Icon numbers for which stock SystemNavigation has a drawable.
pub(crate) fn stock_weather_icon_is_renderable(icon: i32) -> bool {
    matches!(icon, 1..=8 | 11..=26 | 29..=44)
}

/// Whether stock SystemNavigation can render the complete weather payload.
pub(crate) fn stock_weather_response_is_renderable(weather: &pb::WeatherResponse) -> bool {
    weather.temperature_fahrenheit.is_finite()
        && weather.temperature_celsius.is_finite()
        && stock_weather_icon_is_renderable(weather.weather_icon)
}

/// Whether a weather backend, and so a daily forecast, is hosted here.
pub(crate) fn configured() -> bool {
    key(KEY_VAR).is_some()
}

/// Current conditions at a point, in cosmos's wire shape.
pub async fn current(latitude: f64, longitude: f64) -> Result<pb::WeatherResponse, BackendError> {
    let forecast = fetch(latitude, longitude, "minutely,hourly,daily,alerts").await?;
    let now = forecast.currently.ok_or(BackendError::NoResult)?;
    to_wire(&now)
}

/// Current conditions and the daily forecast at a point, in one request.
pub async fn outlook(latitude: f64, longitude: f64) -> Result<Outlook, BackendError> {
    to_outlook(fetch(latitude, longitude, "minutely,hourly,alerts").await?)
}

async fn fetch(latitude: f64, longitude: f64, exclude: &str) -> Result<Forecast, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    // The key is part of Pirate's path, so neither the URL nor a reqwest
    // error (whose text includes the URL) is ever logged.
    let url = format!(
        "https://api.pirateweather.net/forecast/{api_key}/{latitude},{longitude}\
         ?units=us&exclude={exclude}"
    );
    let response = http().get(url).send().await.map_err(|error| {
        tracing::warn!(
            timeout = error.is_timeout(),
            "Pirate Weather could not be reached"
        );
        BackendError::Unavailable
    })?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    decode_forecast(status, &body)
}

/// Pirate Weather's answer: a refused key (401, 403) is not connected, any
/// other refusal or an unreadable body an outage.
fn decode_forecast(status: u16, body: &[u8]) -> Result<Forecast, BackendError> {
    if !(200..300).contains(&status) {
        return Err(super::refused("pirate_weather", status));
    }
    serde_json::from_slice(body).map_err(|_| {
        tracing::warn!("Pirate Weather answered with an unreadable body");
        BackendError::Unavailable
    })
}

fn to_outlook(forecast: Forecast) -> Result<Outlook, BackendError> {
    let current = to_wire(forecast.currently.as_ref().ok_or(BackendError::NoResult)?)?;
    let offset = local_offset(forecast.offset);
    let days = forecast
        .daily
        .map(|daily| daily.data)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|day| {
            let date = time::OffsetDateTime::from_unix_timestamp(day.time)
                .ok()?
                .to_offset(offset)
                .date();
            let precipitating = day.precip_probability > 0.0 && day.precip_type != "none";
            Some(DailyForecast {
                date,
                summary: day.summary.trim().to_owned(),
                high_fahrenheit: day.temperature_high.filter(|value| value.is_finite()),
                low_fahrenheit: day.temperature_low.filter(|value| value.is_finite()),
                precipitation_probability: day.precip_probability.clamp(0.0, 1.0),
                precipitation_type: if precipitating {
                    day.precip_type
                } else {
                    String::new()
                },
            })
        })
        .collect();
    Ok(Outlook { current, days })
}

/// Pirate's `offset` in hours, as a UTC offset. UTC when it is unusable.
fn local_offset(hours: f64) -> time::UtcOffset {
    if !hours.is_finite() {
        return time::UtcOffset::UTC;
    }
    time::UtcOffset::from_whole_seconds((hours * 3_600.0).round() as i32)
        .unwrap_or(time::UtcOffset::UTC)
}

fn to_wire(now: &Currently) -> Result<pb::WeatherResponse, BackendError> {
    // Pirate reports "none" when dry. Cosmos's field carries a type only when
    // there is precipitation, so an absent type stays empty rather than "none".
    let precipitating = now.precip_intensity > 0.0 && now.precip_type != "none";
    let response = pb::WeatherResponse {
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
    };
    if stock_weather_response_is_renderable(&response) {
        Ok(response)
    } else {
        Err(BackendError::NoResult)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let wire = to_wire(forecast.currently.as_ref().expect("current conditions"))
            .expect("valid weather");

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
    fn every_documented_pirate_icon_maps_to_a_stock_renderable_icon() {
        for (pirate, expected) in [
            ("clear-day", 1),
            ("clear-night", 33),
            ("partly-cloudy-day", 3),
            ("partly-cloudy-night", 35),
            ("cloudy", 7),
            ("fog", 11),
            ("rain", 18),
            ("thunderstorm", 15),
            ("sleet", 25),
            ("snow", 22),
            ("wind", 32),
            ("hail", 24),
        ] {
            let projected = accuweather_icon(pirate);
            assert_eq!(projected, expected, "wrong projection for {pirate}");
            assert!(
                stock_weather_icon_is_renderable(projected),
                "{pirate} projected to stock-unsupported icon {projected}",
            );
        }
    }

    #[test]
    fn stock_renderable_icon_set_matches_the_extracted_renderer_oracle() {
        const STOCK_RENDERABLE_ICONS: &[i32] = &[
            1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
            29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
        ];

        for icon in 0..=45 {
            assert_eq!(
                stock_weather_icon_is_renderable(icon),
                STOCK_RENDERABLE_ICONS.contains(&icon),
                "renderer oracle mismatch for icon {icon}",
            );
        }
    }

    #[test]
    fn missing_none_and_unknown_icons_use_the_stock_renderable_fallback() {
        for icon in ["", "none", "hail-of-frogs"] {
            assert_eq!(accuweather_icon(icon), 3, "wrong fallback for {icon:?}");
        }

        let forecast: Forecast = serde_json::from_str(
            r#"{
                "currently": {
                    "summary": "Current conditions",
                    "temperature": 60.96
                }
            }"#,
        )
        .expect("a provider response may omit its icon");
        let wire = to_wire(forecast.currently.as_ref().expect("current conditions"))
            .expect("valid weather");
        assert_eq!(wire.weather_icon, 3);
        assert!(stock_weather_icon_is_renderable(wire.weather_icon));
    }
}
