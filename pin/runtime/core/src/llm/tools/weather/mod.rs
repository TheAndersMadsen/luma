mod types;
use std::convert::Infallible;

use chrono::Utc;
use rig::completion::ToolDefinition;
use rig::tool::{Tool, ToolEmbedding};
use serde::Deserialize;
use serde_json::json;

use crate::config::TemperatureUnit;
use crate::external::weather::{
    parse_iso8601_to_unix, WeatherClient, WeatherError, WeatherRequest,
};
use crate::llm::tools::weather::types::{LLMWeatherResponse, WeatherUnits};

#[derive(Debug, Deserialize)]
pub struct WeatherArgs {
    pub latitude: f64,
    pub longitude: f64,
    pub request_type: WeatherRequestType,
    pub time: Option<String>,
    pub units: Option<WeatherUnits>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WeatherRequestType {
    Current,
    Forecast,
    Historical,
    Alerts,
}

#[derive(Clone)]
pub struct WeatherTool {
    weather: WeatherClient,
    default_unit: TemperatureUnit,
}

impl WeatherTool {
    pub fn new(weather: WeatherClient, default_unit: TemperatureUnit) -> Self {
        Self {
            weather,
            default_unit,
        }
    }
}

impl Tool for WeatherTool {
    const NAME: &'static str = "weather";

    type Error = WeatherError;
    type Args = WeatherArgs;
    type Output = LLMWeatherResponse;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Get weather for a latitude and longitude, including current conditions, hourly forecasts, daily forecasts, alerts, and historical weather. Use forecast for normal future forecast ranges such as later today, tomorrow, or this weekend, but do not pass time for forecasts because PirateWeather does not support future time-machine requests. Use historical with a past ISO 8601 time/date for past weather only.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "latitude": {
                        "type": "number",
                        "description": "Latitude for the weather location. Required."
                    },
                    "longitude": {
                        "type": "number",
                        "description": "Longitude for the weather location. Required."
                    },
                    "request_type": {
                        "type": "string",
                        "enum": ["current", "forecast", "historical", "alerts"],
                        "description": "The kind of weather information needed. Use current for immediate weather, forecast for normal forecast ranges without time, historical for past weather with time, and alerts for warnings/advisories."
                    },
                    "time": {
                        "type": "string",
                        "description": "Optional ISO 8601 date or datetime for historical past-weather requests only, e.g. 2026-06-02T15:00:00Z or 2026-06-02. Omit for current, forecast, and alerts. Future times are unsupported."
                    },
                    "units": {
                        "type": "string",
                        "enum": ["fahrenheit", "celsius"],
                        "description": "Optional temperature units for temperature, feels_like, high, and low fields. Omit to use the user's configured dashboard preference; an explicit unit request wins."
                    }
                },
                "required": ["latitude", "longitude", "request_type"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let units = args.units.unwrap_or(match self.default_unit {
            TemperatureUnit::Celsius => WeatherUnits::Celsius,
            TemperatureUnit::Fahrenheit => WeatherUnits::Fahrenheit,
        });
        let time = args
            .time
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let (
            time,
            include_current,
            include_hourly,
            include_daily,
            include_alerts,
            hourly_limit,
            daily_limit,
        ) = match args.request_type {
            WeatherRequestType::Current => {
                reject_if_time(&time, "current weather")?;
                (None, true, false, false, false, 0, 0)
            }
            WeatherRequestType::Forecast => {
                reject_if_time(&time, "weather forecasts")?;
                (None, true, true, true, false, 12, 5)
            }
            WeatherRequestType::Historical => {
                let time = require_historical_time(time)?;
                (Some(time), true, true, true, false, 12, 1)
            }
            WeatherRequestType::Alerts => {
                reject_if_time(&time, "weather alerts")?;
                (None, false, false, false, true, 0, 0)
            }
        };

        let request = WeatherRequest {
            latitude: args.latitude,
            longitude: args.longitude,
            time,
            include_current,
            include_hourly,
            include_daily,
            include_alerts,
            hourly_limit,
            daily_limit,
        };

        let report = self.weather.weather(request).await?;
        Ok(LLMWeatherResponse::from_report(report, units))
    }
}

fn reject_if_time(time: &Option<String>, request_name: &str) -> Result<(), WeatherError> {
    if time.is_some() {
        return Err(WeatherError::UnsupportedRequest(format!(
            "specific times are not supported for {request_name}; omit time or use historical for past weather"
        )));
    }

    Ok(())
}

fn require_historical_time(time: Option<String>) -> Result<String, WeatherError> {
    let time = time.ok_or_else(|| {
        WeatherError::UnsupportedRequest(
            "historical weather requires a past ISO 8601 time or date".to_string(),
        )
    })?;

    let timestamp = parse_iso8601_to_unix(&time)?;
    if timestamp > Utc::now().timestamp() {
        return Err(WeatherError::UnsupportedRequest(
            "specific future weather times are not supported by PirateWeather forecasts; omit time for forecast requests"
                .to_string(),
        ));
    }

    Ok(time)
}

impl ToolEmbedding for WeatherTool {
    type InitError = Infallible;
    type Context = ();
    type State = WeatherClient;

    fn embedding_docs(&self) -> Vec<String> {
        vec!["Get weather conditions and forecasts for a latitude and longitude, including current weather, hourly forecast, daily forecast, rain, precipitation, temperature, UV index, wind, humidity, alerts, historical weather, tomorrow's weather, weekend forecast, and whether someone needs a jacket. Use for questions like: what's the weather here, is it raining, how hot is it outside, do I need a jacket tomorrow, will it rain this weekend, what was the weather yesterday, are there weather alerts. Forecasts must omit time; only historical past-weather requests may include time.".to_string()]
    }

    fn context(&self) -> Self::Context {}

    fn init(state: Self::State, _context: Self::Context) -> Result<Self, Self::InitError> {
        Ok(Self::new(state, TemperatureUnit::Celsius))
    }
}
