use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use super::envelope::unwrap_plaintext_data_for_kid;
use crate::config::TemperatureUnit;
use crate::external::weather::{WeatherClient, WeatherError};
use crate::proto::aibus::*;
use crate::proto::common::encryption::{self, EncryptedData};
use crate::tier_a::proto_kids;

const MAX_LOCATION_ENVELOPE_BYTES: usize = 16 * 1024;
const MAX_LOCATION_ACCURACY_METERS: f32 = 50_000.0;

pub struct WeatherHandler {
    weather: WeatherClient,
}

impl WeatherHandler {
    pub fn new(
        http_client: reqwest::Client,
        api_key: Option<String>,
        _display_unit: TemperatureUnit,
    ) -> Self {
        Self {
            weather: WeatherClient::new(http_client, api_key),
        }
    }

    pub async fn encrypted_weather(
        &self,
        request: Request<EncryptedWeatherRequest>,
    ) -> Result<Response<EncryptedWeatherResponse>, Status> {
        let req = request.into_inner();
        let location_bytes = unwrap_plaintext_data_for_kid(
            &req.location,
            proto_kids::LOCATION_ENVELOPE,
            MAX_LOCATION_ENVELOPE_BYTES,
        )?;
        let location = encryption::LocationEnvelope::decode(location_bytes)
            .map_err(|_| Status::invalid_argument("bad LocationEnvelope"))?;
        let (latitude, longitude) = validate_weather_location(&location)?;

        info!(">>> EncryptedWeather");

        let current = self
            .weather
            .current(latitude, longitude)
            .await
            .map_err(|e| match e {
                WeatherError::NotConfigured => {
                    info!(">>> EncryptedWeather (no API key configured)");
                    Status::unavailable(
                        "weather not configured — set PIRATE_WEATHER_API_KEY in the environment or .env, or set pirate_weather_api_key in config.toml",
                    )
                }
                other => {
                    warn!(error_kind = other.kind(), "weather provider request failed");
                    Status::unavailable("weather provider is temporarily unavailable")
                }
            })?;

        // Keep both protobuf fields semantically truthful. The stock System
        // Navigation APK reads only the Fahrenheit getter; the injected
        // compatibility hook selects the configured field at that UI boundary.
        let weather = WeatherResponse {
            has_precipitation: current.has_precipitation,
            precipitation_type: current.precipitation_type.clone().unwrap_or_default(),
            temperature_fahrenheit: current.temperature_fahrenheit,
            temperature_celsius: current.temperature_celsius,
            weather_text: current.summary.clone(),
            weather_icon: pirate_weather_icon_to_device(&current.icon),
            u_v_index: current.uv_index,
        };

        // Weather conditions are user/provider data. Keep operational logging
        // to a closed, content-free provider outcome; the response itself is
        // returned only through the encrypted stock RPC envelope below.
        info!(
            provider = "pirate_weather",
            outcome = "success",
            "<<< EncryptedWeather"
        );

        Ok(Response::new(EncryptedWeatherResponse {
            response: Some(EncryptedData::new(
                proto_kids::WEATHER_RESPONSE,
                weather.encode_to_vec(),
            )),
        }))
    }
}

fn validate_weather_location(
    location: &encryption::LocationEnvelope,
) -> Result<(f64, f64), Status> {
    let latitude = f64::from(location.latitude);
    let longitude = f64::from(location.longitude);
    let status_is_usable = location.stale_status
        == encryption::LocationStaleStatus::Undefined as i32
        || location.stale_status == encryption::LocationStaleStatus::NotStale as i32;
    if !status_is_usable
        || !latitude.is_finite()
        || !longitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
        || !location.accuracy.is_finite()
        || !(0.0..=MAX_LOCATION_ACCURACY_METERS).contains(&location.accuracy)
    {
        return Err(Status::invalid_argument("invalid weather location"));
    }
    Ok((latitude, longitude))
}

/// Map PirateWeather icon string to the device's integer weather icon code.
fn pirate_weather_icon_to_device(icon: &str) -> i32 {
    match icon {
        "clear-day" => 1,
        "clear-night" => 33,
        "partly-cloudy-day" => 3,
        "partly-cloudy-night" => 35,
        "cloudy" => 7,
        "rain" => 12,
        "snow" => 19,
        "sleet" => 24,
        "wind" => 32,
        "fog" => 11,
        "thunderstorm" => 15,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_location() -> encryption::LocationEnvelope {
        encryption::LocationEnvelope {
            latitude: 55.6761,
            longitude: 12.5683,
            stale_status: encryption::LocationStaleStatus::NotStale as i32,
            accuracy: 10.0,
            ..Default::default()
        }
    }

    #[test]
    fn weather_location_rejects_stale_invalid_and_imprecise_envelopes() {
        let valid = valid_location();
        assert!(validate_weather_location(&valid).is_ok());

        for invalid in [
            encryption::LocationEnvelope {
                stale_status: encryption::LocationStaleStatus::Stale as i32,
                ..valid.clone()
            },
            encryption::LocationEnvelope {
                stale_status: 99,
                ..valid.clone()
            },
            encryption::LocationEnvelope {
                latitude: f32::NAN,
                ..valid.clone()
            },
            encryption::LocationEnvelope {
                latitude: 91.0,
                ..valid.clone()
            },
            encryption::LocationEnvelope {
                longitude: 181.0,
                ..valid.clone()
            },
            encryption::LocationEnvelope {
                accuracy: -1.0,
                ..valid.clone()
            },
            encryption::LocationEnvelope {
                accuracy: f32::INFINITY,
                ..valid.clone()
            },
            encryption::LocationEnvelope {
                accuracy: MAX_LOCATION_ACCURACY_METERS + 1.0,
                ..valid
            },
        ] {
            assert!(validate_weather_location(&invalid).is_err());
        }
    }

    #[test]
    fn weather_location_preserves_stock_undefined_status_compatibility() {
        let location = encryption::LocationEnvelope {
            stale_status: encryption::LocationStaleStatus::Undefined as i32,
            accuracy: 0.0,
            ..valid_location()
        };
        assert!(validate_weather_location(&location).is_ok());
    }

    #[test]
    fn weather_success_log_is_static_and_content_free() {
        let source = include_str!("weather.rs");
        let success_log = source
            .split("info!(")
            .find(|block| block.contains("\"<<< EncryptedWeather\""))
            .and_then(|block| block.split_once(");").map(|(event, _)| event))
            .expect("weather success log event must remain present");
        let compact: String = success_log
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();

        assert_eq!(
            compact,
            "provider=\"pirate_weather\",outcome=\"success\",\"<<<EncryptedWeather\""
        );
    }
}
