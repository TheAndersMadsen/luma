//! Shared OpenStreetMap service client helpers.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use reqwest::{RequestBuilder, StatusCode, Url};
use serde::Serialize;

const OSM_USER_AGENT: &str = "PenumbraOS/0.1 (+https://github.com/PenumbraOS/humane-system-hook)";
const NOMINATIM_SEARCH_URL: &str = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL: &str = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS_PRIMARY_URL: &str = "https://lz4.overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK_URL: &str = "https://z.overpass-api.de/api/interpreter";
#[cfg(not(test))]
const NOMINATIM_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(test)]
const NOMINATIM_TIMEOUT: Duration = Duration::from_secs(30);
// Nearby's stock client gives the whole RPC 12 seconds. The Overpass query itself
// is allowed 10 seconds, so the HTTP deadline must be slightly longer than that
// server-side budget or reqwest can tear down a response just as Overpass finishes.
// Starting the second public backend earlier keeps the worst-case provider wait at
// 10.75 seconds, the same ceiling as the previous 10s + 750ms arrangement.
pub(crate) const OVERPASS_QUERY_TIMEOUT_SECONDS: u64 = 10;
const OVERPASS_TIMEOUT: Duration = Duration::from_millis(10_500);
const OVERPASS_HEDGE_DELAY: Duration = Duration::from_millis(250);
#[cfg(test)]
const STOCK_NEARBY_RPC_DEADLINE: Duration = Duration::from_secs(12);
const NOMINATIM_MIN_INTERVAL: Duration = Duration::from_secs(1);
const MAX_NOMINATIM_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_OVERPASS_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_OVERPASS_QUERY_BYTES: usize = 16 * 1024;
const MAX_PLACE_QUERY_BYTES: usize = 512;

/// OpenStreetMap API client.
#[derive(Clone)]
pub struct OsmClient {
    http: reqwest::Client,
    options: OsmOptions,
    endpoints: OsmEndpoints,
    overpass_hedge_delay: Duration,
}

#[derive(Clone, Debug)]
struct OsmEndpoints {
    nominatim_search: String,
    nominatim_reverse: String,
    overpass_primary: String,
    overpass_fallback: String,
}

impl Default for OsmEndpoints {
    fn default() -> Self {
        Self {
            nominatim_search: NOMINATIM_SEARCH_URL.to_string(),
            nominatim_reverse: NOMINATIM_REVERSE_URL.to_string(),
            overpass_primary: OVERPASS_PRIMARY_URL.to_string(),
            overpass_fallback: OVERPASS_FALLBACK_URL.to_string(),
        }
    }
}

/// Explicit privacy gates for Nominatim and Overpass requests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OsmOptions {
    enabled: bool,
    location_consent_acknowledged: bool,
}

impl OsmOptions {
    pub fn new(enabled: bool, location_consent_acknowledged: bool) -> Self {
        Self {
            enabled,
            location_consent_acknowledged,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn location_consent_acknowledged(&self) -> bool {
        self.location_consent_acknowledged
    }
}

#[derive(Debug)]
pub enum OsmError {
    Disabled,
    LocationConsentRequired,
    InvalidRequest(&'static str),
    Timeout,
    Transport,
    ProviderRejected,
    ProviderUnavailable,
    ResponseTooLarge,
    NotFound,
    InvalidResponse,
}

impl OsmError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::LocationConsentRequired => "location_consent_required",
            Self::InvalidRequest(_) => "invalid_request",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::ProviderRejected => "provider_rejected",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::ResponseTooLarge => "response_too_large",
            Self::NotFound => "not_found",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

impl std::fmt::Display for OsmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => f.write_str("OSM provider is disabled"),
            Self::LocationConsentRequired => f.write_str("OSM location consent is required"),
            Self::InvalidRequest(message) => write!(f, "invalid OSM request: {message}"),
            Self::Timeout => f.write_str("OSM provider request timed out"),
            Self::Transport => f.write_str("OSM provider transport failed"),
            Self::ProviderRejected => f.write_str("OSM provider rejected the request"),
            Self::ProviderUnavailable => f.write_str("OSM provider is unavailable"),
            Self::ResponseTooLarge => f.write_str("OSM provider response was too large"),
            Self::NotFound => f.write_str("OSM provider found no matching place"),
            Self::InvalidResponse => f.write_str("OSM provider returned an invalid response"),
        }
    }
}

impl std::error::Error for OsmError {}

impl OsmClient {
    pub fn new(http: reqwest::Client, options: OsmOptions) -> Self {
        Self {
            http,
            options,
            endpoints: OsmEndpoints::default(),
            overpass_hedge_delay: OVERPASS_HEDGE_DELAY,
        }
    }

    pub fn options(&self) -> &OsmOptions {
        &self.options
    }

    #[cfg(test)]
    pub(crate) fn with_test_nominatim_search_endpoint(mut self, endpoint: String) -> Self {
        self.endpoints.nominatim_search = endpoint;
        self
    }

    #[cfg(test)]
    fn with_test_overpass_endpoints(
        mut self,
        primary: String,
        fallback: String,
        hedge_delay: Duration,
    ) -> Self {
        self.endpoints.overpass_primary = primary;
        self.endpoints.overpass_fallback = fallback;
        self.overpass_hedge_delay = hedge_delay;
        self
    }

    fn require_enabled(&self) -> Result<(), OsmError> {
        if !self.options.enabled {
            return Err(OsmError::Disabled);
        }
        if !self.options.location_consent_acknowledged {
            return Err(OsmError::LocationConsentRequired);
        }
        Ok(())
    }

    fn require_public_lookup_enabled(&self) -> Result<(), OsmError> {
        self.options.enabled.then_some(()).ok_or(OsmError::Disabled)
    }

    /// Resolve one public, user- or provider-grounded place name. Unlike
    /// reverse geocoding and nearby search this sends no device coordinates,
    /// so it does not consume the current-location consent gate.
    pub async fn search_place(&self, query: &str) -> Result<PlaceSearchResult, OsmError> {
        let query = query.trim();
        if query.is_empty()
            || query.len() > MAX_PLACE_QUERY_BYTES
            || query.chars().any(|character| {
                character == '\0' || (character.is_control() && !character.is_whitespace())
            })
        {
            return Err(OsmError::InvalidRequest("invalid place query"));
        }
        self.require_public_lookup_enabled()?;
        tokio::time::timeout(NOMINATIM_TIMEOUT, async {
            // The limiter wait is deliberately inside the same deadline as
            // the request so a busy process cannot strand a stock turn in a
            // provider queue before the HTTP timeout even starts.
            rate_limit_nominatim().await;
            let mut url = Url::parse(&self.endpoints.nominatim_search)
                .map_err(|_| OsmError::ProviderUnavailable)?;
            url.query_pairs_mut()
                .append_pair("format", "jsonv2")
                .append_pair("q", query)
                .append_pair("limit", "1")
                .append_pair("addressdetails", "1");

            let json = execute_osm_request(
                self.http.get(url),
                NOMINATIM_TIMEOUT,
                MAX_NOMINATIM_RESPONSE_BYTES,
            )
            .await?;
            parse_place_search_response(&json)
        })
        .await
        .map_err(|_| OsmError::Timeout)?
    }

    pub async fn reverse_geocode(
        &self,
        lat: f64,
        lon: f64,
    ) -> Result<ReverseGeocodeResult, OsmError> {
        validate_coordinates(lat, lon)?;
        self.require_enabled()?;
        rate_limit_nominatim().await;
        let mut url = Url::parse(&self.endpoints.nominatim_reverse)
            .map_err(|_| OsmError::ProviderUnavailable)?;
        url.query_pairs_mut()
            .append_pair("format", "jsonv2")
            .append_pair("lat", &lat.to_string())
            .append_pair("lon", &lon.to_string());

        let json = execute_osm_request(
            self.http.get(url),
            NOMINATIM_TIMEOUT,
            MAX_NOMINATIM_RESPONSE_BYTES,
        )
        .await?;

        parse_reverse_geocode_response(&json)
    }

    pub async fn overpass(&self, query: &str) -> Result<serde_json::Value, OsmError> {
        if query.is_empty() || query.len() > MAX_OVERPASS_QUERY_BYTES {
            return Err(OsmError::InvalidRequest("invalid Overpass query size"));
        }
        self.require_enabled()?;

        let primary = self.overpass_at(&self.endpoints.overpass_primary, query);
        tokio::pin!(primary);
        let hedge_delay = tokio::time::sleep(self.overpass_hedge_delay);
        tokio::pin!(hedge_delay);

        tokio::select! {
            result = &mut primary => match result {
                Ok(json) => Ok(json),
                Err(primary_error) => match self
                    .overpass_at(&self.endpoints.overpass_fallback, query)
                    .await
                {
                    Ok(json) => Ok(json),
                    Err(_) => Err(primary_error),
                },
            },
            _ = &mut hedge_delay => {
                let fallback = self.overpass_at(&self.endpoints.overpass_fallback, query);
                tokio::pin!(fallback);
                tokio::select! {
                    result = &mut primary => match result {
                        Ok(json) => Ok(json),
                        Err(primary_error) => match fallback.await {
                            Ok(json) => Ok(json),
                            Err(_) => Err(primary_error),
                        },
                    },
                    result = &mut fallback => match result {
                        Ok(json) => Ok(json),
                        Err(_) => primary.await,
                    },
                }
            },
        }
    }

    async fn overpass_at(
        &self,
        endpoint: &str,
        query: &str,
    ) -> Result<serde_json::Value, OsmError> {
        let url = Url::parse(endpoint).map_err(|_| OsmError::ProviderUnavailable)?;
        let json = execute_osm_request(
            self.http.post(url).form(&[("data", query)]),
            OVERPASS_TIMEOUT,
            MAX_OVERPASS_RESPONSE_BYTES,
        )
        .await?;
        if !json
            .get("elements")
            .is_some_and(serde_json::Value::is_array)
        {
            return Err(OsmError::InvalidResponse);
        }
        Ok(json)
    }
}

fn parse_reverse_geocode_response(
    json: &serde_json::Value,
) -> Result<ReverseGeocodeResult, OsmError> {
    let address = json.get("address").unwrap_or(&serde_json::Value::Null);
    let result = ReverseGeocodeResult {
        display_name: optional_string(json, &["display_name", "name"]),
        street_number: optional_string(address, &["house_number"]),
        street_name: optional_string(address, &["road", "pedestrian", "footway", "path"]),
        municipality: optional_string(
            address,
            &["city", "town", "village", "hamlet", "municipality"],
        ),
        country_subdivision: optional_string(address, &["state", "region", "county"]),
        country: optional_string(address, &["country"]),
        postal_code: optional_string(address, &["postcode"]),
    };
    let has_usable_value = result.display_name.is_some()
        || result.street_number.is_some()
        || result.street_name.is_some()
        || result.municipality.is_some()
        || result.country_subdivision.is_some()
        || result.country.is_some()
        || result.postal_code.is_some();
    has_usable_value
        .then_some(result)
        .ok_or(OsmError::InvalidResponse)
}

fn parse_place_search_response(json: &serde_json::Value) -> Result<PlaceSearchResult, OsmError> {
    let results = json.as_array().ok_or(OsmError::InvalidResponse)?;
    let result = results.first().ok_or(OsmError::NotFound)?;
    let latitude = result
        .get("lat")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .ok_or(OsmError::InvalidResponse)?;
    let longitude = result
        .get("lon")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .ok_or(OsmError::InvalidResponse)?;
    validate_coordinates(latitude, longitude)?;
    let address = result.get("address").unwrap_or(&serde_json::Value::Null);
    let display_name =
        optional_string(result, &["display_name", "name"]).ok_or(OsmError::InvalidResponse)?;
    let name = optional_string(result, &["name"]).or_else(|| {
        optional_string(
            address,
            &[
                "city",
                "town",
                "village",
                "municipality",
                "county",
                "country",
            ],
        )
    });
    Ok(PlaceSearchResult {
        name,
        display_name,
        municipality: optional_string(
            address,
            &["city", "town", "village", "hamlet", "municipality"],
        ),
        country: optional_string(address, &["country"]),
        latitude,
        longitude,
    })
}

async fn execute_osm_request(
    builder: RequestBuilder,
    timeout: Duration,
    maximum_bytes: usize,
) -> Result<serde_json::Value, OsmError> {
    let response = builder
        .header(reqwest::header::USER_AGENT, OSM_USER_AGENT)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                OsmError::Timeout
            } else {
                OsmError::Transport
            }
        })?;

    match response.status() {
        StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(OsmError::ProviderRejected)
        }
        StatusCode::TOO_MANY_REQUESTS => return Err(OsmError::ProviderUnavailable),
        status if !status.is_success() => return Err(OsmError::ProviderUnavailable),
        _ => {}
    }

    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(OsmError::ResponseTooLarge);
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| OsmError::Transport)?;
        if bytes.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(OsmError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| OsmError::InvalidResponse)
}

fn validate_coordinates(latitude: f64, longitude: f64) -> Result<(), OsmError> {
    if !latitude.is_finite()
        || !longitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
    {
        return Err(OsmError::InvalidRequest("invalid coordinates"));
    }
    Ok(())
}

async fn rate_limit_nominatim() {
    static LAST_REQUEST: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    let limiter = LAST_REQUEST.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut last_request = limiter.lock().await;
    if let Some(previous) = *last_request {
        let elapsed = previous.elapsed();
        if elapsed < NOMINATIM_MIN_INTERVAL {
            tokio::time::sleep(NOMINATIM_MIN_INTERVAL - elapsed).await;
        }
    }
    *last_request = Some(Instant::now());
}

fn optional_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaceSearchResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub municipality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReverseGeocodeResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub street_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub street_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub municipality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country_subdivision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub postal_code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, post},
        Router,
    };
    use tokio::net::TcpListener;

    async fn spawn_overpass(status: StatusCode, body: &'static str, delay: Duration) -> String {
        let app = Router::new().route(
            "/",
            post(move || async move {
                tokio::time::sleep(delay).await;
                (status, body)
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/")
    }

    #[test]
    fn errors_do_not_retain_urls_or_provider_bodies() {
        assert_eq!(
            OsmError::Transport.to_string(),
            "OSM provider transport failed"
        );
        assert_eq!(OsmError::Transport.kind(), "transport");
    }

    #[test]
    fn overpass_transport_budget_outlives_query_and_fits_stock_rpc_deadline() {
        assert!(
            OVERPASS_TIMEOUT > Duration::from_secs(OVERPASS_QUERY_TIMEOUT_SECONDS),
            "HTTP must have time to receive Overpass's response after its query budget expires"
        );
        assert!(
            OVERPASS_TIMEOUT + OVERPASS_HEDGE_DELAY < STOCK_NEARBY_RPC_DEADLINE,
            "both hedged attempts must settle before the stock 12-second RPC deadline"
        );
    }

    #[test]
    fn coordinate_validation_is_strict() {
        assert!(validate_coordinates(55.0, 12.0).is_ok());
        assert!(validate_coordinates(f64::NAN, 12.0).is_err());
        assert!(validate_coordinates(91.0, 12.0).is_err());
        assert!(validate_coordinates(55.0, -181.0).is_err());
    }

    #[test]
    fn reverse_geocode_requires_a_usable_display_or_address_value() {
        assert!(matches!(
            parse_reverse_geocode_response(&serde_json::json!({"error": "unable to geocode"})),
            Err(OsmError::InvalidResponse)
        ));
        assert!(matches!(
            parse_reverse_geocode_response(&serde_json::json!({})),
            Err(OsmError::InvalidResponse)
        ));

        let parsed = parse_reverse_geocode_response(&serde_json::json!({
            "display_name": "Copenhagen, Denmark",
            "address": {"city": "Copenhagen", "country": "Denmark"}
        }))
        .unwrap();
        assert_eq!(parsed.municipality.as_deref(), Some("Copenhagen"));
    }

    #[test]
    fn place_search_requires_one_valid_rank_one_result() {
        let parsed = parse_place_search_response(&serde_json::json!([{
            "lat": "48.8566",
            "lon": "2.3522",
            "name": "Paris",
            "display_name": "Paris, Île-de-France, France",
            "address": {"city": "Paris", "country": "France"}
        }]))
        .unwrap();
        assert_eq!(parsed.name.as_deref(), Some("Paris"));
        assert_eq!(parsed.country.as_deref(), Some("France"));
        assert_eq!(parsed.latitude, 48.8566);

        let address_named = parse_place_search_response(&serde_json::json!([{
            "lat": "48.8588897",
            "lon": "2.320041",
            "display_name": "Paris, Île-de-France, Metropolitan France, France",
            "address": {"city": "Paris", "country": "France"}
        }]))
        .unwrap();
        assert_eq!(address_named.name.as_deref(), Some("Paris"));
        assert_eq!(address_named.municipality.as_deref(), Some("Paris"));
        assert_eq!(address_named.country.as_deref(), Some("France"));

        for invalid in [
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::json!([{"lat":"NaN","lon":"2","display_name":"Paris"}]),
            serde_json::json!([{"lat":"91","lon":"2","display_name":"Paris"}]),
        ] {
            assert!(parse_place_search_response(&invalid).is_err());
        }
    }

    #[tokio::test]
    async fn network_access_requires_both_explicit_privacy_gates() {
        let disabled = OsmClient::new(reqwest::Client::new(), OsmOptions::default());
        assert!(matches!(
            disabled.reverse_geocode(55.0, 12.0).await,
            Err(OsmError::Disabled)
        ));

        let no_consent = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false));
        assert!(matches!(
            no_consent.overpass("[out:json];node(0,0,1,1);out;").await,
            Err(OsmError::LocationConsentRequired)
        ));

        assert!(matches!(
            disabled.search_place("Paris").await,
            Err(OsmError::Disabled)
        ));
    }

    #[tokio::test]
    async fn public_place_search_does_not_require_device_location_consent() {
        let app = Router::new().route(
            "/search",
            get(|| async {
                (
                    StatusCode::OK,
                    r#"[{"lat":"48.8566","lon":"2.3522","name":"Paris","display_name":"Paris, France","address":{"city":"Paris","country":"France"}}]"#,
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, false))
            .with_test_nominatim_search_endpoint(format!("http://{address}/search"));

        let result = client.search_place("Paris").await.unwrap();
        assert_eq!(result.name.as_deref(), Some("Paris"));
        assert_eq!(result.display_name, "Paris, France");
    }

    #[tokio::test]
    async fn overpass_falls_back_after_primary_gateway_timeout() {
        let primary = spawn_overpass(
            StatusCode::GATEWAY_TIMEOUT,
            "provider busy",
            Duration::from_millis(5),
        )
        .await;
        let fallback = spawn_overpass(
            StatusCode::OK,
            r#"{"elements":[{"id":42}]}"#,
            Duration::ZERO,
        )
        .await;
        let client = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, true))
            .with_test_overpass_endpoints(primary, fallback, Duration::from_secs(1));

        let response = client
            .overpass("[out:json];node(0,0,1,1);out;")
            .await
            .unwrap();

        assert_eq!(response["elements"][0]["id"], 42);
    }

    #[tokio::test]
    async fn overpass_falls_back_after_semantically_invalid_success_body() {
        let primary = spawn_overpass(
            StatusCode::OK,
            r#"{"remark":"dispatcher overloaded"}"#,
            Duration::ZERO,
        )
        .await;
        let fallback = spawn_overpass(
            StatusCode::OK,
            r#"{"elements":[{"id":84}]}"#,
            Duration::ZERO,
        )
        .await;
        let client = OsmClient::new(reqwest::Client::new(), OsmOptions::new(true, true))
            .with_test_overpass_endpoints(primary, fallback, Duration::from_secs(1));

        let response = client
            .overpass("[out:json];node(0,0,1,1);out;")
            .await
            .unwrap();

        assert_eq!(response["elements"][0]["id"], 84);
    }
}
