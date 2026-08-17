//! Shared PirateWeather service client helpers.

use std::time::Duration;

use chrono::{DateTime, NaiveDate, Utc};
use futures::StreamExt as _;
use serde::Serialize;

const PIRATE_WEATHER_FORECAST_URL: &str = "https://api.pirateweather.net/forecast";
const PIRATE_WEATHER_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PIRATE_WEATHER_RESPONSE_BYTES: usize = 1024 * 1024;
const DEFAULT_HOURLY_LIMIT: usize = 12;
const DEFAULT_DAILY_LIMIT: usize = 7;
const MAX_HOURLY_LIMIT: usize = 48;
const MAX_DAILY_LIMIT: usize = 14;

/// PirateWeather API client.
#[derive(Clone)]
pub struct WeatherClient {
    http: reqwest::Client,
    api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CurrentWeather {
    pub temperature_fahrenheit: f64,
    pub temperature_celsius: f64,
    pub summary: String,
    pub icon: String,
    pub uv_index: i32,
    pub has_precipitation: bool,
    pub precipitation_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WeatherRequest {
    pub latitude: f64,
    pub longitude: f64,
    /// Optional ISO 8601 date/time for time-machine or date-specific requests.
    pub time: Option<String>,
    pub include_current: bool,
    pub include_hourly: bool,
    pub include_daily: bool,
    pub include_alerts: bool,
    pub hourly_limit: usize,
    pub daily_limit: usize,
}

impl WeatherRequest {
    pub fn current(latitude: f64, longitude: f64) -> Self {
        Self {
            latitude,
            longitude,
            time: None,
            include_current: true,
            include_hourly: false,
            include_daily: false,
            include_alerts: false,
            hourly_limit: 0,
            daily_limit: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WeatherReport {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<WeatherPoint>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hourly: Vec<WeatherPoint>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub daily: Vec<WeatherPoint>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<WeatherAlertSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeatherPoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_fahrenheit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_celsius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apparent_temperature_fahrenheit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apparent_temperature_celsius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_high_fahrenheit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_low_fahrenheit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precipitation_probability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precipitation_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precipitation_intensity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub humidity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uv_index: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeatherAlertSummary {
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

pub enum WeatherError {
    NotConfigured,
    InvalidTime(String),
    UnsupportedRequest(String),
    HttpRequest { timed_out: bool },
    ResponseTooLarge,
    ParseResponse,
    MissingCurrentConditions,
}

impl std::fmt::Display for WeatherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => f.write_str("weather not configured"),
            Self::InvalidTime(value) => write!(f, "invalid ISO 8601 weather time: {value}"),
            Self::UnsupportedRequest(message) => f.write_str(message),
            Self::HttpRequest { timed_out: true } => {
                f.write_str("weather provider request timed out")
            }
            Self::HttpRequest { timed_out: false } => {
                f.write_str("weather provider transport failed")
            }
            Self::ResponseTooLarge => f.write_str("weather provider response was too large"),
            Self::ParseResponse => f.write_str("weather provider returned an invalid response"),
            Self::MissingCurrentConditions => {
                f.write_str("PirateWeather response missing current conditions")
            }
        }
    }
}

impl std::error::Error for WeatherError {}

impl std::fmt::Debug for WeatherError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WeatherError")
            .field("kind", &self.kind())
            .finish()
    }
}

impl WeatherError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::InvalidTime(_) => "invalid_time",
            Self::UnsupportedRequest(_) => "unsupported_request",
            Self::HttpRequest { timed_out: true } => "timeout",
            Self::HttpRequest { timed_out: false } => "transport",
            Self::ResponseTooLarge => "response_too_large",
            Self::ParseResponse => "invalid_response",
            Self::MissingCurrentConditions => "missing_current_conditions",
        }
    }
}

impl WeatherClient {
    pub fn new(http: reqwest::Client, api_key: Option<String>) -> Self {
        Self { http, api_key }
    }

    pub fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    pub async fn current(
        &self,
        latitude: f64,
        longitude: f64,
    ) -> Result<CurrentWeather, WeatherError> {
        let report = self
            .weather(WeatherRequest::current(latitude, longitude))
            .await?;
        current_weather_from_report(report)
    }

    pub async fn weather(&self, request: WeatherRequest) -> Result<WeatherReport, WeatherError> {
        let api_key = self.api_key.clone().ok_or(WeatherError::NotConfigured)?;
        let url = build_weather_url(&api_key, &request)?;

        let response = execute_weather_request(
            self.http.get(&url),
            PIRATE_WEATHER_REQUEST_TIMEOUT,
            MAX_PIRATE_WEATHER_RESPONSE_BYTES,
        )
        .await?;

        Ok(parse_weather_report(&response, &request))
    }
}

fn current_weather_from_report(report: WeatherReport) -> Result<CurrentWeather, WeatherError> {
    let currently = report
        .current
        .ok_or(WeatherError::MissingCurrentConditions)?;
    let temperature_fahrenheit = currently
        .temperature_fahrenheit
        .filter(|value| value.is_finite() && (-250.0..=350.0).contains(value))
        .ok_or(WeatherError::MissingCurrentConditions)?;
    let temperature_celsius = currently
        .temperature_celsius
        .filter(|value| value.is_finite() && (-160.0..=180.0).contains(value))
        .unwrap_or_else(|| fahrenheit_to_celsius(temperature_fahrenheit));
    let summary = currently
        .summary
        .filter(|value| !value.trim().is_empty())
        .ok_or(WeatherError::MissingCurrentConditions)?;
    let icon = currently
        .icon
        .filter(|value| !value.trim().is_empty())
        .ok_or(WeatherError::MissingCurrentConditions)?;
    let uv_index = currently
        .uv_index
        .filter(|value| (0..=50).contains(value))
        .ok_or(WeatherError::MissingCurrentConditions)?;
    let precipitation_intensity = currently
        .precipitation_intensity
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or(WeatherError::MissingCurrentConditions)?;

    Ok(CurrentWeather {
        temperature_fahrenheit,
        temperature_celsius,
        summary,
        icon,
        uv_index,
        has_precipitation: precipitation_intensity > 0.0,
        precipitation_type: currently.precipitation_type,
    })
}

async fn execute_weather_request(
    builder: reqwest::RequestBuilder,
    timeout: Duration,
    maximum_bytes: usize,
) -> Result<serde_json::Value, WeatherError> {
    let response = builder
        .timeout(timeout)
        .send()
        .await
        .map_err(classify_http_error)?
        .error_for_status()
        .map_err(classify_http_error)?;

    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(WeatherError::ResponseTooLarge);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(classify_http_error)?;
        let next_length = body
            .len()
            .checked_add(chunk.len())
            .ok_or(WeatherError::ResponseTooLarge)?;
        if next_length > maximum_bytes {
            return Err(WeatherError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body).map_err(|_| WeatherError::ParseResponse)
}

fn classify_http_error(error: reqwest::Error) -> WeatherError {
    WeatherError::HttpRequest {
        timed_out: error.is_timeout(),
    }
}

fn build_weather_url(api_key: &str, request: &WeatherRequest) -> Result<String, WeatherError> {
    let location = match request.time.as_deref() {
        Some(time) => format!(
            "{},{},{}",
            request.latitude,
            request.longitude,
            parse_iso8601_to_unix(time)?
        ),
        None => format!("{},{}", request.latitude, request.longitude),
    };

    let mut excluded = vec!["minutely"];
    if !request.include_current {
        excluded.push("currently");
    }
    if !request.include_hourly {
        excluded.push("hourly");
    }
    if !request.include_daily {
        excluded.push("daily");
    }
    if !request.include_alerts {
        excluded.push("alerts");
    }

    Ok(format!(
        "{PIRATE_WEATHER_FORECAST_URL}/{api_key}/{location}?units=us&exclude={}",
        excluded.join(",")
    ))
}

pub(crate) fn parse_iso8601_to_unix(value: &str) -> Result<i64, WeatherError> {
    if let Ok(datetime) = DateTime::parse_from_rfc3339(value) {
        return Ok(datetime.timestamp());
    }

    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        let datetime = date
            .and_hms_opt(12, 0, 0)
            .ok_or_else(|| WeatherError::InvalidTime(value.to_string()))?;
        return Ok(DateTime::<Utc>::from_naive_utc_and_offset(datetime, Utc).timestamp());
    }

    Err(WeatherError::InvalidTime(value.to_string()))
}

fn parse_weather_report(value: &serde_json::Value, request: &WeatherRequest) -> WeatherReport {
    let current = value.get("currently").map(parse_weather_point);
    let hourly_limit = request
        .hourly_limit
        .min(MAX_HOURLY_LIMIT)
        .max(if request.include_hourly { 1 } else { 0 });
    let daily_limit = request
        .daily_limit
        .min(MAX_DAILY_LIMIT)
        .max(if request.include_daily { 1 } else { 0 });

    let hourly = value
        .get("hourly")
        .and_then(|block| block.get("data"))
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
        .take(hourly_limit)
        .map(parse_weather_point)
        .collect();

    let daily = value
        .get("daily")
        .and_then(|block| block.get("data"))
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
        .take(daily_limit)
        .map(parse_weather_point)
        .collect();

    let alerts = value
        .get("alerts")
        .and_then(|alerts| alerts.as_array())
        .into_iter()
        .flatten()
        .map(parse_alert)
        .collect();

    WeatherReport {
        latitude: value
            .get("latitude")
            .and_then(|v| v.as_f64())
            .unwrap_or(request.latitude),
        longitude: value
            .get("longitude")
            .and_then(|v| v.as_f64())
            .unwrap_or(request.longitude),
        timezone: optional_string(value, "timezone"),
        current,
        hourly,
        daily,
        alerts,
    }
}

fn parse_weather_point(value: &serde_json::Value) -> WeatherPoint {
    let temperature_fahrenheit = optional_f64(value, "temperature");
    let apparent_temperature_fahrenheit = optional_f64(value, "apparentTemperature");

    WeatherPoint {
        time: value.get("time").and_then(|v| v.as_i64()),
        summary: optional_string(value, "summary"),
        icon: optional_string(value, "icon"),
        temperature_fahrenheit,
        temperature_celsius: temperature_fahrenheit.map(fahrenheit_to_celsius),
        apparent_temperature_fahrenheit,
        apparent_temperature_celsius: apparent_temperature_fahrenheit.map(fahrenheit_to_celsius),
        temperature_high_fahrenheit: optional_f64(value, "temperatureHigh")
            .or_else(|| optional_f64(value, "temperatureMax")),
        temperature_low_fahrenheit: optional_f64(value, "temperatureLow")
            .or_else(|| optional_f64(value, "temperatureMin")),
        precipitation_probability: optional_f64(value, "precipProbability"),
        precipitation_type: optional_string(value, "precipType"),
        precipitation_intensity: optional_f64(value, "precipIntensity"),
        humidity: optional_f64(value, "humidity"),
        wind_speed: optional_f64(value, "windSpeed"),
        uv_index: optional_i32(value, "uvIndex"),
    }
}

fn parse_alert(value: &serde_json::Value) -> WeatherAlertSummary {
    WeatherAlertSummary {
        title: optional_string(value, "title"),
        severity: optional_string(value, "severity"),
        time: value.get("time").and_then(|v| v.as_i64()),
        expires: value.get("expires").and_then(|v| v.as_i64()),
        description: optional_string(value, "description"),
        uri: optional_string(value, "uri"),
    }
}

fn optional_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn optional_f64(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|v| v.as_f64())
}

fn optional_i32(value: &serde_json::Value, key: &str) -> Option<i32> {
    value
        .get(key)
        .and_then(|v| v.as_i64())
        .and_then(|value| i32::try_from(value).ok())
        .or_else(|| {
            value
                .get(key)
                .and_then(|v| v.as_f64())
                .map(|value| value as i32)
        })
}

fn fahrenheit_to_celsius(value: f64) -> f64 {
    (value - 32.0) * 5.0 / 9.0
}

impl Default for WeatherRequest {
    fn default() -> Self {
        Self {
            latitude: 0.0,
            longitude: 0.0,
            time: None,
            include_current: true,
            include_hourly: true,
            include_daily: true,
            include_alerts: false,
            hourly_limit: DEFAULT_HOURLY_LIMIT,
            daily_limit: DEFAULT_DAILY_LIMIT,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    async fn mock_server(response: Vec<u8>, response_delay: Duration) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local mock server");
        let address = listener.local_addr().expect("mock server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept mock request");
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await;
            tokio::time::sleep(response_delay).await;
            let _ = socket.write_all(&response).await;
        });
        (format!("http://{address}/forecast"), server)
    }

    fn test_http_client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("build test HTTP client")
    }

    fn complete_current_report() -> WeatherReport {
        WeatherReport {
            latitude: 48.8566,
            longitude: 2.3522,
            timezone: Some("Europe/Paris".to_string()),
            current: Some(WeatherPoint {
                time: Some(1_700_000_000),
                summary: Some("Clear".to_string()),
                icon: Some("clear-day".to_string()),
                temperature_fahrenheit: Some(68.0),
                temperature_celsius: Some(20.0),
                apparent_temperature_fahrenheit: None,
                apparent_temperature_celsius: None,
                temperature_high_fahrenheit: None,
                temperature_low_fahrenheit: None,
                precipitation_probability: Some(0.0),
                precipitation_type: None,
                precipitation_intensity: Some(0.0),
                humidity: Some(0.5),
                wind_speed: Some(2.0),
                uv_index: Some(3),
            }),
            hourly: Vec::new(),
            daily: Vec::new(),
            alerts: Vec::new(),
        }
    }

    #[test]
    fn current_weather_fails_closed_when_required_provider_fields_are_missing() {
        let valid = current_weather_from_report(complete_current_report()).unwrap();
        assert_eq!(valid.temperature_celsius, 20.0);
        assert_eq!(valid.summary, "Clear");
        assert!(!valid.has_precipitation);

        let mutations: [fn(&mut WeatherPoint); 5] = [
            |point: &mut WeatherPoint| point.temperature_fahrenheit = None,
            |point: &mut WeatherPoint| point.summary = None,
            |point: &mut WeatherPoint| point.icon = None,
            |point: &mut WeatherPoint| point.uv_index = None,
            |point: &mut WeatherPoint| point.precipitation_intensity = None,
        ];
        for mutate in mutations {
            let mut report = complete_current_report();
            mutate(report.current.as_mut().unwrap());
            assert!(matches!(
                current_weather_from_report(report),
                Err(WeatherError::MissingCurrentConditions)
            ));
        }

        let mut non_finite = complete_current_report();
        non_finite.current.as_mut().unwrap().temperature_fahrenheit = Some(f64::NAN);
        assert!(matches!(
            current_weather_from_report(non_finite),
            Err(WeatherError::MissingCurrentConditions)
        ));
    }

    #[test]
    fn preserves_provider_uv_index_for_the_stock_home_weather_response() {
        let request = WeatherRequest::current(55.6761, 12.5683);

        for (provider_value, expected) in [
            (serde_json::json!(7), Some(7)),
            (serde_json::json!(7.9), Some(7)),
        ] {
            let report = parse_weather_report(
                &serde_json::json!({
                    "currently": {
                        "temperature": 68.0,
                        "uvIndex": provider_value,
                    },
                }),
                &request,
            );
            assert_eq!(
                report.current.expect("current weather point").uv_index,
                expected,
            );
        }

        let missing = parse_weather_report(
            &serde_json::json!({ "currently": { "temperature": 68.0 } }),
            &request,
        );
        assert_eq!(
            missing.current.expect("current weather point").uv_index,
            None,
        );
    }

    #[tokio::test]
    async fn rejects_oversized_content_length_before_reading_body() {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_PIRATE_WEATHER_RESPONSE_BYTES + 1
        )
        .into_bytes();
        let (url, server) = mock_server(response, Duration::ZERO).await;

        let result = execute_weather_request(
            test_http_client().get(url),
            Duration::from_secs(1),
            MAX_PIRATE_WEATHER_RESPONSE_BYTES,
        )
        .await;

        server.await.expect("mock server task");
        assert!(matches!(result, Err(WeatherError::ResponseTooLarge)));
    }

    #[tokio::test]
    async fn rejects_chunked_response_that_exceeds_limit() {
        let body = vec![b'x'; MAX_PIRATE_WEATHER_RESPONSE_BYTES + 1];
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(&body);
        response.extend_from_slice(b"\r\n0\r\n\r\n");
        let (url, server) = mock_server(response, Duration::ZERO).await;

        let result = execute_weather_request(
            test_http_client().get(url),
            Duration::from_secs(1),
            MAX_PIRATE_WEATHER_RESPONSE_BYTES,
        )
        .await;

        server.await.expect("mock server task");
        assert!(matches!(result, Err(WeatherError::ResponseTooLarge)));
    }

    #[tokio::test]
    async fn classifies_request_timeout_without_retaining_transport_details() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec();
        let (url, server) = mock_server(response, Duration::from_millis(100)).await;

        let error = execute_weather_request(
            test_http_client().get(url),
            Duration::from_millis(20),
            MAX_PIRATE_WEATHER_RESPONSE_BYTES,
        )
        .await
        .expect_err("request should time out");

        server.await.expect("mock server task");
        assert!(matches!(
            error,
            WeatherError::HttpRequest { timed_out: true }
        ));
        assert_eq!(error.kind(), "timeout");
        assert_eq!(error.to_string(), "weather provider request timed out");
        assert!(!format!("{error:?}").contains("127.0.0.1"));
    }
}
