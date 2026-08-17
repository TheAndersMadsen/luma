use serde::{Deserialize, Serialize};

use crate::external::weather::{
    WeatherAlertSummary, WeatherPoint as APIWeatherPoint, WeatherReport,
};
use crate::util::serde::f64_option_serialize_1_decimal;

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum WeatherUnits {
    Fahrenheit,
    Celsius,
}

#[derive(Debug, Serialize)]
pub struct LLMWeatherResponse {
    pub units: WeatherUnits,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<LLMWeatherPoint>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hourly: Vec<LLMWeatherPoint>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub daily: Vec<LLMDailyWeatherPoint>,

    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<LLMWeatherAlert>,
}

impl LLMWeatherResponse {
    pub(super) fn from_report(report: WeatherReport, units: WeatherUnits) -> Self {
        Self {
            units,
            timezone: report.timezone,
            current: report
                .current
                .map(|point| LLMWeatherPoint::from_point(point, units)),
            hourly: report
                .hourly
                .into_iter()
                .map(|point| LLMWeatherPoint::from_point(point, units))
                .collect(),
            daily: report
                .daily
                .into_iter()
                .map(|point| LLMDailyWeatherPoint::from_point(point, units))
                .collect(),
            alerts: report
                .alerts
                .into_iter()
                .take(5)
                .map(LLMWeatherAlert::from_alert)
                .collect(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LLMWeatherPoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub temperature: Option<f64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub feels_like: Option<f64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub high_temp: Option<f64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub low_temp: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub precip_prob_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precip_type: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub precip_intensity: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub humid_pct: Option<u8>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub wind_mph: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uv: Option<i32>,
}

impl LLMWeatherPoint {
    pub(super) fn from_point(point: APIWeatherPoint, units: WeatherUnits) -> Self {
        let (precip_prob_pct, precip_type, precip_intensity) = precipitation_fields(&point);

        Self {
            time: point.time,
            summary: point.summary,
            temperature: convert_temperature(point.temperature_fahrenheit, units),
            feels_like: convert_temperature(point.apparent_temperature_fahrenheit, units),
            high_temp: convert_temperature(point.temperature_high_fahrenheit, units),
            low_temp: convert_temperature(point.temperature_low_fahrenheit, units),
            precip_prob_pct,
            precip_type,
            precip_intensity,
            humid_pct: percentage_option(point.humidity),
            wind_mph: point.wind_speed,
            uv: point.uv_index,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LLMDailyWeatherPoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub high_temp: Option<f64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "f64_option_serialize_1_decimal"
    )]
    pub low_temp: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub precip_prob_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precip_type: Option<String>,
}

impl LLMDailyWeatherPoint {
    pub(super) fn from_point(point: APIWeatherPoint, units: WeatherUnits) -> Self {
        let (precip_prob_pct, precip_type, _) = precipitation_fields(&point);

        Self {
            time: point.time,
            summary: point.summary,
            high_temp: convert_temperature(point.temperature_high_fahrenheit, units),
            low_temp: convert_temperature(point.temperature_low_fahrenheit, units),
            precip_prob_pct,
            precip_type,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LLMWeatherAlert {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

impl LLMWeatherAlert {
    pub(super) fn from_alert(alert: WeatherAlertSummary) -> Self {
        Self {
            title: alert.title,
            severity: alert.severity,
            time: alert.time,
            expires: alert.expires,
            description: alert.description,
            uri: alert.uri,
        }
    }
}

fn convert_temperature(value: Option<f64>, units: WeatherUnits) -> Option<f64> {
    value.map(|fahrenheit| match units {
        WeatherUnits::Fahrenheit => fahrenheit,
        WeatherUnits::Celsius => (fahrenheit - 32.0) * 5.0 / 9.0,
    })
}

fn precipitation_fields(point: &APIWeatherPoint) -> (Option<u8>, Option<String>, Option<f64>) {
    let probability = point.precipitation_probability.unwrap_or(0.);

    // Consider values close to zero as no precip, and drop fields
    if probability > 0.001 {
        (
            Some(percentage(probability)),
            point.precipitation_type.clone(),
            point.precipitation_intensity,
        )
    } else {
        (None, None, None)
    }
}

fn percentage_option(value: Option<f64>) -> Option<u8> {
    value.map(percentage)
}

fn percentage(value: f64) -> u8 {
    (value * 100.0).round().clamp(0.0, 100.0) as u8
}
