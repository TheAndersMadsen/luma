//! Strict, privacy-preserving adapters for Google Maps Platform web services.
//!
//! The adapters deliberately do not read process environment or application
//! configuration. Callers must construct [`GoogleMapsOptions`] explicitly.
//! Routes are disabled by default and require a second, independent compliance
//! acknowledgement before any request can leave the server.

use std::collections::HashSet;
use std::fmt;
use std::time::Duration;

use futures::StreamExt as _;
use reqwest::redirect::Policy;
use reqwest::{Client, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};

use crate::proto::aibus::{
    CellTower, GeoLocateRequest, Location, NavigationDirectionsResponse, NavigationDistance,
    NavigationDuration, NavigationManeuver, NavigationStep, WifiAccessPoint,
};

const ROUTES_URL: &str = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOLOCATION_URL: &str = "https://www.googleapis.com/geolocation/v1/geolocate";

pub const ROUTES_FIELD_MASK: &str = concat!(
    "routes.description,",
    "routes.distanceMeters,",
    "routes.duration,",
    "routes.localizedValues.distance,",
    "routes.localizedValues.duration,",
    "routes.legs.steps.distanceMeters,",
    "routes.legs.steps.staticDuration,",
    "routes.legs.steps.startLocation.latLng,",
    "routes.legs.steps.endLocation.latLng,",
    "routes.legs.steps.navigationInstruction.instructions,",
    "routes.legs.steps.navigationInstruction.maneuver,",
    "routes.legs.steps.localizedValues.distance,",
    "routes.legs.steps.localizedValues.staticDuration"
);

const DEFAULT_ROUTES_TIMEOUT: Duration = Duration::from_secs(4);
const DEFAULT_GEOLOCATION_TIMEOUT: Duration = Duration::from_secs(7);
const MAX_ROUTES_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_GEOLOCATION_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_DESTINATION_BYTES: usize = 512;
const MAX_CARRIER_BYTES: usize = 128;
const MAX_RADIO_OBSERVATIONS: usize = 64;
pub const MAX_GOOGLE_MAPS_API_KEY_BYTES: usize = 512;

pub fn validate_google_maps_api_key(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > MAX_GOOGLE_MAPS_API_KEY_BYTES
        || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Google Maps API key must be 1-512 visible ASCII characters");
    }
    Ok(())
}

/// Google travel modes that can be selected by server configuration.
///
/// The stock request has no travel-mode field, so [`Walk`](Self::Walk) is the
/// conservative default. No `routingPreference` is sent because Google rejects
/// it for walking and bicycle requests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RoutesTravelMode {
    #[default]
    Walk,
    Drive,
    Bicycle,
    TwoWheeler,
}

/// Localized distance units requested from Google Routes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RoutesUnitSystem {
    #[default]
    Metric,
    Imperial,
}

impl RoutesUnitSystem {
    fn as_google_value(self) -> &'static str {
        match self {
            Self::Metric => "METRIC",
            Self::Imperial => "IMPERIAL",
        }
    }
}

impl RoutesTravelMode {
    fn as_google_value(self) -> &'static str {
        match self {
            Self::Walk => "WALK",
            Self::Drive => "DRIVE",
            Self::Bicycle => "BICYCLE",
            Self::TwoWheeler => "TWO_WHEELER",
        }
    }
}

/// Explicit, secret-safe options for Google Maps web-service adapters.
#[derive(Clone)]
pub struct GoogleMapsOptions {
    api_key: Option<String>,
    geolocation_enabled: bool,
    routes_enabled: bool,
    routes_compliance_acknowledged: bool,
    routes_travel_mode: RoutesTravelMode,
    routes_unit_system: RoutesUnitSystem,
    language_code: Option<String>,
    routes_timeout: Duration,
    geolocation_timeout: Duration,
}

impl Default for GoogleMapsOptions {
    fn default() -> Self {
        Self {
            api_key: None,
            geolocation_enabled: false,
            routes_enabled: false,
            routes_compliance_acknowledged: false,
            routes_travel_mode: RoutesTravelMode::Walk,
            routes_unit_system: RoutesUnitSystem::Metric,
            language_code: Some("en-US".to_string()),
            routes_timeout: DEFAULT_ROUTES_TIMEOUT,
            geolocation_timeout: DEFAULT_GEOLOCATION_TIMEOUT,
        }
    }
}

impl fmt::Debug for GoogleMapsOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleMapsOptions")
            .field("has_api_key", &self.api_key.is_some())
            .field("geolocation_enabled", &self.geolocation_enabled)
            .field("routes_enabled", &self.routes_enabled)
            .field(
                "routes_compliance_acknowledged",
                &self.routes_compliance_acknowledged,
            )
            .field("routes_travel_mode", &self.routes_travel_mode)
            .field("routes_unit_system", &self.routes_unit_system)
            .field("language_code", &self.language_code)
            .field("routes_timeout", &self.routes_timeout)
            .field("geolocation_timeout", &self.geolocation_timeout)
            .finish()
    }
}

impl GoogleMapsOptions {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
            api_key: api_key.and_then(trimmed_nonempty),
            ..Self::default()
        }
    }

    pub fn with_geolocation_enabled(mut self, enabled: bool) -> Self {
        self.geolocation_enabled = enabled;
        self
    }

    pub fn with_routes_enabled(mut self, enabled: bool) -> Self {
        self.routes_enabled = enabled;
        self
    }

    /// Acknowledge that the caller has implemented the applicable Google Maps
    /// attribution, terms, privacy, EEA, and road-safety requirements.
    pub fn with_routes_compliance_acknowledged(mut self, acknowledged: bool) -> Self {
        self.routes_compliance_acknowledged = acknowledged;
        self
    }

    pub fn with_routes_travel_mode(mut self, mode: RoutesTravelMode) -> Self {
        self.routes_travel_mode = mode;
        self
    }

    pub fn with_routes_unit_system(mut self, unit_system: RoutesUnitSystem) -> Self {
        self.routes_unit_system = unit_system;
        self
    }

    pub fn with_language_code(mut self, language_code: Option<String>) -> Self {
        self.language_code = language_code.and_then(trimmed_nonempty);
        self
    }

    #[cfg(test)]
    pub fn with_routes_timeout(mut self, timeout: Duration) -> Self {
        if !timeout.is_zero() {
            self.routes_timeout = timeout;
        }
        self
    }

    #[cfg(test)]
    pub fn with_geolocation_timeout(mut self, timeout: Duration) -> Self {
        if !timeout.is_zero() {
            self.geolocation_timeout = timeout;
        }
        self
    }

    #[cfg(test)]
    pub fn geolocation_enabled(&self) -> bool {
        self.geolocation_enabled
    }

    #[cfg(test)]
    pub fn routes_enabled(&self) -> bool {
        self.routes_enabled
    }

    #[cfg(test)]
    pub fn routes_compliance_acknowledged(&self) -> bool {
        self.routes_compliance_acknowledged
    }

    fn api_key(&self) -> Result<&str, GoogleMapsError> {
        let key = self
            .api_key
            .as_deref()
            .ok_or(GoogleMapsError::NotConfigured)?;
        validate_google_maps_api_key(key).map_err(|_| GoogleMapsError::NotConfigured)?;
        Ok(key)
    }

    fn validate_language_code(&self) -> Result<(), GoogleMapsError> {
        let Some(language_code) = self.language_code.as_deref() else {
            return Ok(());
        };
        if language_code.len() > 35
            || !language_code
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            // This value comes from server configuration, not the device
            // request, so it must never be surfaced as a client BAD_REQUEST.
            return Err(GoogleMapsError::NotConfigured);
        }
        Ok(())
    }
}

fn trimmed_nonempty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[derive(Clone, Debug)]
struct GoogleMapsEndpoints {
    routes: String,
    geolocation: String,
}

impl Default for GoogleMapsEndpoints {
    fn default() -> Self {
        Self {
            routes: ROUTES_URL.to_string(),
            geolocation: GEOLOCATION_URL.to_string(),
        }
    }
}

/// Cloneable Google Maps Platform client. Debug output never contains a key.
#[derive(Clone)]
pub struct GoogleMapsClient {
    http: Client,
    options: GoogleMapsOptions,
    endpoints: GoogleMapsEndpoints,
}

impl fmt::Debug for GoogleMapsClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleMapsClient")
            .field("options", &self.options)
            .field("endpoints", &self.endpoints)
            .finish_non_exhaustive()
    }
}

impl GoogleMapsClient {
    /// Build the production client with redirects disabled. Location and radio
    /// observations must never be replayed to a redirect target, and the
    /// Routes API-key header must not be forwarded to another origin.
    pub fn from_options(options: GoogleMapsOptions) -> Result<Self, GoogleMapsError> {
        if let Some(key) = options.api_key.as_deref() {
            validate_google_maps_api_key(key).map_err(|_| GoogleMapsError::NotConfigured)?;
        }
        options.validate_language_code()?;
        let http = Client::builder()
            .redirect(Policy::none())
            .build()
            .map_err(|_| GoogleMapsError::Transport)?;
        Ok(Self::new(http, options))
    }

    /// Construct with an injected HTTP client. Production wiring should prefer
    /// [`Self::from_options`]; injection exists for callers that already apply
    /// an equally strict redirect policy and for deterministic tests.
    pub fn new(http: Client, options: GoogleMapsOptions) -> Self {
        Self {
            http,
            options,
            endpoints: GoogleMapsEndpoints::default(),
        }
    }

    pub fn disabled(http: Client) -> Self {
        Self::new(http, GoogleMapsOptions::default())
    }

    pub fn routes_travel_mode(&self) -> RoutesTravelMode {
        self.options.routes_travel_mode
    }

    #[cfg(test)]
    pub fn options(&self) -> &GoogleMapsOptions {
        &self.options
    }

    #[cfg(test)]
    fn with_test_endpoints(mut self, routes: String, geolocation: String) -> Self {
        self.endpoints = GoogleMapsEndpoints {
            routes,
            geolocation,
        };
        self
    }

    pub async fn compute_route(
        &self,
        origin_latitude: f64,
        origin_longitude: f64,
        destination: &str,
    ) -> Result<NavigationDirectionsResponse, GoogleMapsError> {
        if !self.options.routes_enabled {
            return Err(GoogleMapsError::Disabled);
        }
        if !self.options.routes_compliance_acknowledged {
            return Err(GoogleMapsError::RoutesComplianceRequired);
        }
        self.options.validate_language_code()?;
        validate_coordinates(origin_latitude, origin_longitude)?;
        let destination = validate_destination(destination)?;
        let api_key = self.options.api_key()?;

        let request = ComputeRoutesRequest {
            origin: RouteWaypoint::from_coordinates(origin_latitude, origin_longitude),
            destination: RouteWaypoint::from_address(destination),
            travel_mode: self.options.routes_travel_mode.as_google_value(),
            compute_alternative_routes: false,
            language_code: self.options.language_code.as_deref(),
            units: self.options.routes_unit_system.as_google_value(),
        };

        let response = self
            .http
            .post(&self.endpoints.routes)
            .header("X-Goog-Api-Key", api_key)
            .header("X-Goog-FieldMask", ROUTES_FIELD_MASK)
            .json(&request)
            .timeout(self.options.routes_timeout)
            .send()
            .await
            .map_err(|_| GoogleMapsError::Transport)?;

        if !response.status().is_success() {
            return Err(error_for_http_status(response.status()));
        }

        let response: ComputeRoutesResponse =
            decode_limited_json(response, MAX_ROUTES_RESPONSE_BYTES).await?;
        let route = response
            .routes
            .into_iter()
            .next()
            .ok_or(GoogleMapsError::NotFound)?;

        Ok(route_to_proto(
            route,
            destination,
            self.options.routes_unit_system,
        ))
    }

    pub async fn geolocate(
        &self,
        request: &GeoLocateRequest,
    ) -> Result<GeoLocationFix, GoogleMapsError> {
        if !self.options.geolocation_enabled {
            return Err(GoogleMapsError::Disabled);
        }
        let request = geolocation_request(request)?;
        let api_key = self.options.api_key()?;

        let mut url = Url::parse(&self.endpoints.geolocation)
            .map_err(|_| GoogleMapsError::ProviderUnavailable)?;
        url.query_pairs_mut().append_pair("key", api_key);

        let response = self
            .http
            .post(url)
            .json(&request)
            .timeout(self.options.geolocation_timeout)
            .send()
            .await
            .map_err(|_| GoogleMapsError::Transport)?;

        if !response.status().is_success() {
            return Err(error_for_http_status(response.status()));
        }

        let response: GoogleGeolocationResponse =
            decode_limited_json(response, MAX_GEOLOCATION_RESPONSE_BYTES).await?;
        validate_coordinates(response.location.lat, response.location.lng)
            .map_err(|_| GoogleMapsError::MalformedResponse)?;
        if !response.accuracy.is_finite() || response.accuracy < 0.0 {
            return Err(GoogleMapsError::MalformedResponse);
        }

        Ok(GeoLocationFix {
            latitude: response.location.lat,
            longitude: response.location.lng,
            accuracy_meters: response.accuracy,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeoLocationFix {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy_meters: f64,
}

/// Provider errors contain only classifications, never URLs, bodies, keys, or
/// user-provided location/navigation data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GoogleMapsError {
    Disabled,
    NotConfigured,
    RoutesComplianceRequired,
    InvalidRequest(&'static str),
    BadRequest,
    NotFound,
    RateLimited,
    Transport,
    ProviderUnavailable,
    MalformedResponse,
    ResponseTooLarge,
}

impl GoogleMapsError {
    pub fn kind(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::NotConfigured => "not_configured",
            Self::RoutesComplianceRequired => "routes_compliance_required",
            Self::InvalidRequest(_) => "invalid_request",
            Self::BadRequest => "bad_request",
            Self::NotFound => "not_found",
            Self::RateLimited => "rate_limited",
            Self::Transport => "transport",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::MalformedResponse => "malformed_response",
            Self::ResponseTooLarge => "response_too_large",
        }
    }
}

impl fmt::Display for GoogleMapsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(f, "invalid Google Maps request: {message}"),
            other => write!(f, "Google Maps provider error: {}", other.kind()),
        }
    }
}

impl std::error::Error for GoogleMapsError {}

fn error_for_http_status(status: StatusCode) -> GoogleMapsError {
    match status {
        StatusCode::BAD_REQUEST => GoogleMapsError::BadRequest,
        StatusCode::NOT_FOUND => GoogleMapsError::NotFound,
        StatusCode::TOO_MANY_REQUESTS => GoogleMapsError::RateLimited,
        _ => GoogleMapsError::ProviderUnavailable,
    }
}

async fn decode_limited_json<T: for<'de> Deserialize<'de>>(
    response: Response,
    maximum_bytes: usize,
) -> Result<T, GoogleMapsError> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(GoogleMapsError::ResponseTooLarge);
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| GoogleMapsError::Transport)?;
        let next_len = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or(GoogleMapsError::ResponseTooLarge)?;
        if next_len > maximum_bytes {
            return Err(GoogleMapsError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&bytes).map_err(|_| GoogleMapsError::MalformedResponse)
}

fn validate_coordinates(latitude: f64, longitude: f64) -> Result<(), GoogleMapsError> {
    if !latitude.is_finite() || !longitude.is_finite() {
        return Err(GoogleMapsError::InvalidRequest(
            "coordinates must be finite",
        ));
    }
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return Err(GoogleMapsError::InvalidRequest(
            "coordinates are out of range",
        ));
    }
    Ok(())
}

fn validate_destination(destination: &str) -> Result<&str, GoogleMapsError> {
    let destination = destination.trim();
    if destination.is_empty() {
        return Err(GoogleMapsError::InvalidRequest("destination is empty"));
    }
    if destination.len() > MAX_DESTINATION_BYTES {
        return Err(GoogleMapsError::InvalidRequest("destination is too long"));
    }
    if destination.chars().any(char::is_control) {
        return Err(GoogleMapsError::InvalidRequest(
            "destination contains control characters",
        ));
    }
    Ok(destination)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputeRoutesRequest<'a> {
    origin: RouteWaypoint,
    destination: RouteWaypoint,
    travel_mode: &'static str,
    compute_alternative_routes: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_code: Option<&'a str>,
    units: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteWaypoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<RouteWaypointLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
}

impl RouteWaypoint {
    fn from_coordinates(latitude: f64, longitude: f64) -> Self {
        Self {
            location: Some(RouteWaypointLocation {
                lat_lng: GoogleLatLng {
                    latitude,
                    longitude,
                },
            }),
            address: None,
        }
    }

    fn from_address(address: &str) -> Self {
        Self {
            location: None,
            address: Some(address.to_string()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteWaypointLocation {
    lat_lng: GoogleLatLng,
}

#[derive(Clone, Copy, Serialize)]
struct GoogleLatLng {
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize, Default)]
struct ComputeRoutesResponse {
    #[serde(default)]
    routes: Vec<GoogleRoute>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleRoute {
    #[serde(default)]
    description: String,
    distance_meters: Option<i64>,
    duration: Option<String>,
    localized_values: Option<GoogleRouteLocalizedValues>,
    #[serde(default)]
    legs: Vec<GoogleRouteLeg>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleRouteLocalizedValues {
    distance: Option<GoogleLocalizedText>,
    duration: Option<GoogleLocalizedText>,
}

#[derive(Deserialize, Default)]
struct GoogleRouteLeg {
    #[serde(default)]
    steps: Vec<GoogleRouteStep>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleRouteStep {
    distance_meters: Option<i64>,
    static_duration: Option<String>,
    start_location: Option<GoogleResponseLocation>,
    end_location: Option<GoogleResponseLocation>,
    navigation_instruction: Option<GoogleNavigationInstruction>,
    localized_values: Option<GoogleStepLocalizedValues>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleStepLocalizedValues {
    distance: Option<GoogleLocalizedText>,
    static_duration: Option<GoogleLocalizedText>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleNavigationInstruction {
    #[serde(default)]
    maneuver: String,
    #[serde(default)]
    instructions: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleResponseLocation {
    lat_lng: Option<GoogleResponseLatLng>,
}

#[derive(Deserialize, Default)]
struct GoogleResponseLatLng {
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleLocalizedText {
    #[serde(default)]
    text: String,
    #[allow(dead_code)]
    language_code: Option<String>,
}

fn route_to_proto(
    route: GoogleRoute,
    destination: &str,
    unit_system: RoutesUnitSystem,
) -> NavigationDirectionsResponse {
    let GoogleRoute {
        description,
        distance_meters,
        duration,
        localized_values,
        legs,
    } = route;
    let summary = if description.trim().is_empty() {
        format!("Route to {destination}")
    } else {
        description
    };

    let localized_distance = localized_values
        .as_ref()
        .and_then(|values| values.distance.as_ref());
    let localized_duration = localized_values
        .as_ref()
        .and_then(|values| values.duration.as_ref());

    let steps = legs
        .into_iter()
        .flat_map(|leg| leg.steps)
        .map(|step| step_to_proto(step, unit_system))
        .collect();

    NavigationDirectionsResponse {
        summary,
        steps,
        total_distance: navigation_distance(distance_meters, localized_distance, unit_system),
        total_duration: navigation_duration(duration.as_deref(), localized_duration),
    }
}

fn step_to_proto(step: GoogleRouteStep, unit_system: RoutesUnitSystem) -> NavigationStep {
    let instruction = step
        .navigation_instruction
        .as_ref()
        .map(|instruction| instruction.instructions.clone())
        .unwrap_or_default();
    let maneuver = navigation_maneuver(
        step.navigation_instruction
            .as_ref()
            .map(|instruction| instruction.maneuver.as_str()),
    );
    let localized_distance = step
        .localized_values
        .as_ref()
        .and_then(|values| values.distance.as_ref());
    let localized_duration = step
        .localized_values
        .as_ref()
        .and_then(|values| values.static_duration.as_ref());

    NavigationStep {
        instruction,
        distance: navigation_distance(step.distance_meters, localized_distance, unit_system),
        duration: navigation_duration(step.static_duration.as_deref(), localized_duration),
        start_location: response_location(step.start_location),
        end_location: response_location(step.end_location),
        maneuver: maneuver as i32,
    }
}

fn navigation_distance(
    meters: Option<i64>,
    localized: Option<&GoogleLocalizedText>,
    unit_system: RoutesUnitSystem,
) -> Option<NavigationDistance> {
    if meters.is_none() && localized.is_none() {
        return None;
    }
    let value = saturating_i32(meters.unwrap_or_default());
    let text = localized
        .map(|localized| localized.text.clone())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| fallback_distance_text(value, unit_system));
    Some(NavigationDistance { text, value })
}

fn fallback_distance_text(meters: i32, unit_system: RoutesUnitSystem) -> String {
    match unit_system {
        RoutesUnitSystem::Metric => format!("{meters} m"),
        RoutesUnitSystem::Imperial => {
            let feet = f64::from(meters) * 3.280_839_895;
            if feet >= 5_280.0 {
                format!("{:.1} mi", feet / 5_280.0)
            } else {
                format!("{} ft", feet.round() as i64)
            }
        }
    }
}

fn navigation_duration(
    duration: Option<&str>,
    localized: Option<&GoogleLocalizedText>,
) -> Option<NavigationDuration> {
    if duration.is_none() && localized.is_none() {
        return None;
    }
    let value = duration
        .and_then(parse_duration_seconds)
        .unwrap_or_default();
    let text = localized
        .map(|localized| localized.text.clone())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| format!("{value} sec"));
    Some(NavigationDuration { text, value })
}

fn parse_duration_seconds(duration: &str) -> Option<i32> {
    let seconds = duration.strip_suffix('s')?.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    if seconds >= i32::MAX as f64 {
        return Some(i32::MAX);
    }
    Some(seconds.ceil() as i32)
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(0, i32::MAX as i64) as i32
}

fn response_location(location: Option<GoogleResponseLocation>) -> Option<Location> {
    let lat_lng = location?.lat_lng?;
    validate_coordinates(lat_lng.latitude, lat_lng.longitude).ok()?;
    Some(Location {
        latitude: lat_lng.latitude,
        longitude: lat_lng.longitude,
    })
}

fn navigation_maneuver(maneuver: Option<&str>) -> NavigationManeuver {
    use NavigationManeuver::*;

    match maneuver.unwrap_or_default() {
        "TURN_SLIGHT_LEFT" => NavigationActionTurnSlightLeft,
        "TURN_SHARP_LEFT" => NavigationActionTurnSharpLeft,
        "TURN_LEFT" => NavigationActionTurnLeft,
        "TURN_SLIGHT_RIGHT" => NavigationActionTurnSlightRight,
        "TURN_SHARP_RIGHT" => NavigationActionTurnSharpRight,
        "UTURN_LEFT" => NavigationActionUturnLeft,
        "UTURN_RIGHT" => NavigationActionUturnRight,
        "TURN_RIGHT" => NavigationActionTurnRight,
        "STRAIGHT" => NavigationActionGoStraight,
        "RAMP_LEFT" => NavigationActionRampLeft,
        "RAMP_RIGHT" => NavigationActionRampRight,
        "MERGE" => NavigationActionMerge,
        "FORK_LEFT" => NavigationActionForkLeft,
        "FORK_RIGHT" => NavigationActionForkRight,
        "FERRY" => NavigationActionFerry,
        "FERRY_TRAIN" => NavigationActionFerryTrain,
        "ROUNDABOUT_LEFT" => NavigationActionRoundaboutLeft,
        "ROUNDABOUT_RIGHT" => NavigationActionRoundaboutRight,
        _ => NavigationActionUnspecified,
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct GoogleGeolocationRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    home_mobile_country_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    home_mobile_network_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    radio_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    carrier: Option<String>,
    consider_ip: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    cell_towers: Vec<GoogleCellTower>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    wifi_access_points: Vec<GoogleWifiAccessPoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCellTower {
    #[serde(skip_serializing_if = "Option::is_none")]
    cell_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_radio_cell_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location_area_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mobile_country_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mobile_network_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    age: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing_advance: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GoogleWifiAccessPoint {
    mac_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    age: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_to_noise_ratio: Option<f64>,
}

fn geolocation_request(
    request: &GeoLocateRequest,
) -> Result<GoogleGeolocationRequest, GoogleMapsError> {
    if request.cell_towers.len() > MAX_RADIO_OBSERVATIONS
        || request.wifi_access_points.len() > MAX_RADIO_OBSERVATIONS
    {
        return Err(GoogleMapsError::InvalidRequest(
            "too many radio observations",
        ));
    }

    let home_mobile_country_code = optional_u32(
        request.home_mobile_country_code,
        999,
        "invalid home mobile country code",
    )?;
    let home_mobile_network_code = optional_mobile_network_code(
        request.home_mobile_network_code,
        home_mobile_country_code,
        "invalid home mobile network code",
    )?;
    if home_mobile_country_code.is_none() && home_mobile_network_code.is_some() {
        return Err(GoogleMapsError::InvalidRequest(
            "home network code requires a country code",
        ));
    }

    let radio_type = validated_radio_type(&request.radio_type)?;
    let carrier = validated_optional_text(&request.carrier, MAX_CARRIER_BYTES, "invalid carrier")?;

    let mut cell_towers = Vec::new();
    for cell in &request.cell_towers {
        if let Some(cell) = cell_tower(cell, radio_type.as_deref())? {
            cell_towers.push(cell);
        }
    }

    let mut seen_macs = HashSet::new();
    let mut wifi_access_points = Vec::new();
    for access_point in &request.wifi_access_points {
        if let Some(access_point) = wifi_access_point(access_point)? {
            if seen_macs.insert(access_point.mac_address.clone()) {
                wifi_access_points.push(access_point);
            }
        }
    }

    if cell_towers.is_empty() && wifi_access_points.len() < 2 && !request.consider_ip {
        return Err(GoogleMapsError::NotFound);
    }

    Ok(GoogleGeolocationRequest {
        home_mobile_country_code,
        home_mobile_network_code,
        radio_type,
        carrier,
        consider_ip: request.consider_ip,
        cell_towers,
        wifi_access_points,
    })
}

fn validated_radio_type(value: &str) -> Result<Option<String>, GoogleMapsError> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    if matches!(value.as_str(), "gsm" | "cdma" | "wcdma" | "lte" | "nr") {
        Ok(Some(value))
    } else {
        Err(GoogleMapsError::InvalidRequest("invalid radio type"))
    }
}

fn validated_optional_text(
    value: &str,
    maximum_bytes: usize,
    error: &'static str,
) -> Result<Option<String>, GoogleMapsError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > maximum_bytes || value.chars().any(char::is_control) {
        return Err(GoogleMapsError::InvalidRequest(error));
    }
    Ok(Some(value.to_string()))
}

fn cell_tower(
    cell: &CellTower,
    radio_type: Option<&str>,
) -> Result<Option<GoogleCellTower>, GoogleMapsError> {
    let is_nr = radio_type == Some("nr");
    let cell_id = optional_u32(cell.cell_id, u32::MAX, "invalid cell ID")?;
    let new_radio_cell_id =
        optional_u64(cell.new_radio_cell_id, 68_719_476_735, "invalid NR cell ID")?;

    if is_nr && new_radio_cell_id.is_none() {
        return Ok(None);
    }
    if !is_nr && cell_id.is_none() {
        return Ok(None);
    }

    let mobile_country_code =
        optional_u32(cell.mobile_country_code, 999, "invalid mobile country code")?;
    let mobile_network_code = optional_mobile_network_code(
        cell.mobile_network_code,
        mobile_country_code,
        "invalid mobile network code",
    )?;

    Ok(Some(GoogleCellTower {
        cell_id: (!is_nr).then_some(cell_id).flatten(),
        new_radio_cell_id: is_nr.then_some(new_radio_cell_id).flatten(),
        location_area_code: optional_u32(
            cell.location_area_code,
            if is_nr { 16_777_215 } else { 65_535 },
            "invalid location area code",
        )?,
        mobile_country_code,
        mobile_network_code,
        age: optional_u32(cell.age, u32::MAX, "invalid cell age")?,
        signal_strength: optional_negative_measurement(
            cell.signal_strength,
            -200.0,
            "invalid cell signal strength",
        )?,
        timing_advance: optional_nonnegative_measurement(
            cell.timing_advance,
            1_000_000.0,
            "invalid timing advance",
        )?,
    }))
}

fn wifi_access_point(
    access_point: &WifiAccessPoint,
) -> Result<Option<GoogleWifiAccessPoint>, GoogleMapsError> {
    let Some(mac_address) = canonical_physical_mac(&access_point.mac_address) else {
        return Ok(None);
    };
    Ok(Some(GoogleWifiAccessPoint {
        mac_address,
        signal_strength: optional_negative_measurement(
            access_point.signal_strength,
            -200.0,
            "invalid Wi-Fi signal strength",
        )?,
        age: optional_u32(access_point.age, u32::MAX, "invalid Wi-Fi age")?,
        channel: optional_u32(access_point.channel, 233, "invalid Wi-Fi channel")?,
        signal_to_noise_ratio: optional_signed_measurement(
            access_point.signal_to_noise_ratio,
            -100.0,
            200.0,
            "invalid Wi-Fi signal-to-noise ratio",
        )?,
    }))
}

fn optional_u32(
    value: i32,
    maximum: u32,
    error: &'static str,
) -> Result<Option<u32>, GoogleMapsError> {
    if value == 0 {
        return Ok(None);
    }
    let value = u32::try_from(value).map_err(|_| GoogleMapsError::InvalidRequest(error))?;
    if value > maximum {
        return Err(GoogleMapsError::InvalidRequest(error));
    }
    Ok(Some(value))
}

/// MNC `00` is valid. Proto3 scalar fields do not contain presence, so a zero
/// network code is treated as present when the corresponding MCC is present.
fn optional_mobile_network_code(
    value: i32,
    country_code: Option<u32>,
    error: &'static str,
) -> Result<Option<u32>, GoogleMapsError> {
    if value == 0 {
        return Ok(country_code.map(|_| 0));
    }
    optional_u32(value, 999, error)
}

fn optional_u64(
    value: i32,
    maximum: u64,
    error: &'static str,
) -> Result<Option<u64>, GoogleMapsError> {
    if value == 0 {
        return Ok(None);
    }
    let value = u64::try_from(value).map_err(|_| GoogleMapsError::InvalidRequest(error))?;
    if value > maximum {
        return Err(GoogleMapsError::InvalidRequest(error));
    }
    Ok(Some(value))
}

fn optional_negative_measurement(
    value: f64,
    minimum: f64,
    error: &'static str,
) -> Result<Option<f64>, GoogleMapsError> {
    if value == 0.0 {
        return Ok(None);
    }
    if !value.is_finite() || value < minimum || value >= 0.0 {
        return Err(GoogleMapsError::InvalidRequest(error));
    }
    Ok(Some(value))
}

fn optional_nonnegative_measurement(
    value: f64,
    maximum: f64,
    error: &'static str,
) -> Result<Option<f64>, GoogleMapsError> {
    if value == 0.0 {
        return Ok(None);
    }
    if !value.is_finite() || value < 0.0 || value > maximum {
        return Err(GoogleMapsError::InvalidRequest(error));
    }
    Ok(Some(value))
}

fn optional_signed_measurement(
    value: f64,
    minimum: f64,
    maximum: f64,
    error: &'static str,
) -> Result<Option<f64>, GoogleMapsError> {
    if value == 0.0 {
        return Ok(None);
    }
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(GoogleMapsError::InvalidRequest(error));
    }
    Ok(Some(value))
}

fn canonical_physical_mac(value: &str) -> Option<String> {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    if parts.len() != 6 || parts.iter().any(|part| part.len() != 2) {
        return None;
    }
    let mut bytes = [0_u8; 6];
    for (index, part) in parts.into_iter().enumerate() {
        bytes[index] = u8::from_str_radix(part, 16).ok()?;
    }

    let is_multicast = bytes[0] & 0x01 != 0;
    let is_locally_administered = bytes[0] & 0x02 != 0;
    let is_iana_reserved = bytes[..3] == [0x00, 0x00, 0x5e];
    let is_all_zero = bytes.iter().all(|byte| *byte == 0);
    let is_broadcast = bytes.iter().all(|byte| *byte == 0xff);
    if is_multicast || is_locally_administered || is_iana_reserved || is_all_zero || is_broadcast {
        return None;
    }

    Some(format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]
    ))
}

#[derive(Deserialize)]
struct GoogleGeolocationResponse {
    location: GoogleGeolocationLocation,
    accuracy: f64,
}

#[derive(Deserialize)]
struct GoogleGeolocationLocation {
    lat: f64,
    lng: f64,
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::extract::{Request as AxumRequest, State};
    use axum::http::header::CONTENT_TYPE;
    use axum::response::{Redirect, Response as AxumResponse};
    use axum::routing::any;
    use axum::Router;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;

    use super::*;

    #[derive(Clone)]
    struct MockState {
        status: StatusCode,
        response_body: Arc<String>,
        delay: Duration,
        captured: Arc<Mutex<Option<CapturedRequest>>>,
    }

    struct CapturedRequest {
        uri: String,
        api_key: Option<String>,
        field_mask: Option<String>,
        body: Vec<u8>,
    }

    async fn mock_google_handler(
        State(state): State<MockState>,
        request: AxumRequest,
    ) -> AxumResponse {
        let (parts, body) = request.into_parts();
        let body = to_bytes(body, 2 * 1024 * 1024).await.unwrap().to_vec();
        let api_key = parts
            .headers
            .get("X-Goog-Api-Key")
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        let field_mask = parts
            .headers
            .get("X-Goog-FieldMask")
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        *state.captured.lock().await = Some(CapturedRequest {
            uri: parts.uri.to_string(),
            api_key,
            field_mask,
            body,
        });
        if !state.delay.is_zero() {
            tokio::time::sleep(state.delay).await;
        }
        AxumResponse::builder()
            .status(state.status)
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(state.response_body.as_str().to_string()))
            .unwrap()
    }

    async fn spawn_mock_google(
        status: StatusCode,
        response_body: &str,
        delay: Duration,
    ) -> (String, Arc<Mutex<Option<CapturedRequest>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(None));
        let app = Router::new()
            .fallback(any(mock_google_handler))
            .with_state(MockState {
                status,
                response_body: Arc::new(response_body.to_string()),
                delay,
                captured: captured.clone(),
            });
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), captured)
    }

    fn wifi_request() -> GeoLocateRequest {
        GeoLocateRequest {
            consider_ip: false,
            wifi_access_points: vec![
                WifiAccessPoint {
                    mac_address: "10:20:30:40:50:60".into(),
                    signal_strength: -50.0,
                    ..Default::default()
                },
                WifiAccessPoint {
                    mac_address: "20:21:31:41:51:61".into(),
                    signal_strength: -60.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn options_default_to_disabled_and_debug_redacts_key() {
        let options = GoogleMapsOptions::new(Some("maps-super-secret".to_string()));
        assert!(!options.geolocation_enabled());
        assert!(!options.routes_enabled());
        assert!(!options.routes_compliance_acknowledged());
        let debug = format!("{options:?}");
        assert!(debug.contains("has_api_key: true"));
        assert!(!debug.contains("maps-super-secret"));

        let client = GoogleMapsClient::new(Client::new(), options);
        assert!(!client.options().routes_enabled());
    }

    #[test]
    fn api_keys_are_bounded_visible_ascii_before_client_startup() {
        for key in [
            "contains\ncontrol".to_string(),
            "x".repeat(MAX_GOOGLE_MAPS_API_KEY_BYTES + 1),
        ] {
            let options = GoogleMapsOptions::new(Some(key));
            assert!(matches!(
                GoogleMapsClient::from_options(options),
                Err(GoogleMapsError::NotConfigured)
            ));
        }

        assert!(GoogleMapsClient::from_options(GoogleMapsOptions::new(Some(
            "valid-key_123".into()
        )))
        .is_ok());
    }

    #[test]
    fn route_requires_both_enablement_and_compliance_acknowledgement() {
        let client = GoogleMapsClient::new(
            Client::new(),
            GoogleMapsOptions::new(Some("secret".into())).with_routes_enabled(true),
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime
            .block_on(client.compute_route(55.0, 12.0, "Copenhagen"))
            .unwrap_err();
        assert_eq!(error, GoogleMapsError::RoutesComplianceRequired);
    }

    #[tokio::test]
    async fn request_validation_precedes_missing_key_and_config_errors_are_not_client_errors() {
        let route_options = GoogleMapsOptions::default()
            .with_routes_enabled(true)
            .with_routes_compliance_acknowledged(true);
        let route_client = GoogleMapsClient::new(Client::new(), route_options);
        assert!(matches!(
            route_client.compute_route(55.0, 12.0, " \n ").await,
            Err(GoogleMapsError::InvalidRequest(_))
        ));

        let invalid_language = GoogleMapsOptions::new(Some("test-key".into()))
            .with_routes_enabled(true)
            .with_routes_compliance_acknowledged(true)
            .with_language_code(Some("not a language".into()));
        let route_client = GoogleMapsClient::new(Client::new(), invalid_language);
        assert_eq!(
            route_client.compute_route(55.0, 12.0, "Copenhagen").await,
            Err(GoogleMapsError::NotConfigured)
        );

        let geolocation_client = GoogleMapsClient::new(
            Client::new(),
            GoogleMapsOptions::default().with_geolocation_enabled(true),
        );
        let malformed = GeoLocateRequest {
            radio_type: "satellite".into(),
            consider_ip: true,
            ..Default::default()
        };
        assert!(matches!(
            geolocation_client.geolocate(&malformed).await,
            Err(GoogleMapsError::InvalidRequest(_))
        ));
    }

    #[test]
    fn physical_mac_filter_rejects_private_multicast_iana_and_malformed_values() {
        assert_eq!(
            canonical_physical_mac("10:20:30:40:50:60").as_deref(),
            Some("10:20:30:40:50:60")
        );
        assert!(canonical_physical_mac("12:20:30:40:50:60").is_none());
        assert!(canonical_physical_mac("11:20:30:40:50:60").is_none());
        assert!(canonical_physical_mac("00:00:5e:00:53:01").is_none());
        assert!(canonical_physical_mac("not-a-mac").is_none());
    }

    #[test]
    fn geolocation_sanitization_filters_and_deduplicates_access_points() {
        let request = GeoLocateRequest {
            consider_ip: false,
            wifi_access_points: vec![
                WifiAccessPoint {
                    mac_address: "10:20:30:40:50:60".into(),
                    signal_strength: -50.0,
                    ..Default::default()
                },
                WifiAccessPoint {
                    mac_address: "10:20:30:40:50:60".into(),
                    signal_strength: -55.0,
                    ..Default::default()
                },
                WifiAccessPoint {
                    mac_address: "20:21:31:41:51:61".into(),
                    signal_strength: -60.0,
                    ..Default::default()
                },
                WifiAccessPoint {
                    mac_address: "02:00:00:00:00:00".into(),
                    signal_strength: -40.0,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let sanitized = geolocation_request(&request).unwrap();
        assert_eq!(sanitized.wifi_access_points.len(), 2);
        let json = serde_json::to_value(sanitized).unwrap();
        assert_eq!(json["considerIp"], false);
        assert_eq!(json["wifiAccessPoints"].as_array().unwrap().len(), 2);
        assert!(!json.to_string().contains("02:00:00:00:00:00"));
    }

    #[test]
    fn geolocation_without_enough_valid_evidence_is_not_found() {
        let request = GeoLocateRequest {
            consider_ip: false,
            wifi_access_points: vec![WifiAccessPoint {
                mac_address: "10:20:30:40:50:60".into(),
                signal_strength: -50.0,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(matches!(
            geolocation_request(&request),
            Err(GoogleMapsError::NotFound)
        ));
    }

    #[test]
    fn zero_mobile_network_code_is_preserved_when_country_code_is_present() {
        let request = GeoLocateRequest {
            home_mobile_country_code: 238,
            home_mobile_network_code: 0,
            consider_ip: true,
            ..Default::default()
        };
        let json = serde_json::to_value(geolocation_request(&request).unwrap()).unwrap();
        assert_eq!(json["homeMobileCountryCode"], 238);
        assert_eq!(json["homeMobileNetworkCode"], 0);
    }

    #[test]
    fn duration_and_maneuver_mappings_match_stock_wire_values() {
        assert_eq!(RoutesTravelMode::Drive.as_google_value(), "DRIVE");
        assert_eq!(RoutesTravelMode::Bicycle.as_google_value(), "BICYCLE");
        assert_eq!(
            RoutesTravelMode::TwoWheeler.as_google_value(),
            "TWO_WHEELER"
        );
        assert_eq!(parse_duration_seconds("3.5s"), Some(4));
        assert_eq!(parse_duration_seconds("-1s"), None);
        assert_eq!(parse_duration_seconds("NaNs"), None);
        assert_eq!(
            navigation_maneuver(Some("TURN_LEFT")) as i32,
            NavigationManeuver::NavigationActionTurnLeft as i32
        );
        assert_eq!(
            navigation_maneuver(Some("UTURN_RIGHT")) as i32,
            NavigationManeuver::NavigationActionUturnRight as i32
        );
        assert_eq!(
            navigation_maneuver(Some("DEPART")) as i32,
            NavigationManeuver::NavigationActionUnspecified as i32
        );
    }

    #[test]
    fn route_fixture_flattens_legs_and_maps_localized_values() {
        let fixture = br#"{
          "routes": [{
            "description": "via Main Street",
            "distanceMeters": 1250,
            "duration": "601.2s",
            "localizedValues": {
              "distance": {"text": "1.3 km"},
              "duration": {"text": "10 min"}
            },
            "legs": [{"steps": [{
              "distanceMeters": 100,
              "staticDuration": "45.1s",
              "startLocation": {"latLng": {"latitude": 55.0, "longitude": 12.0}},
              "endLocation": {"latLng": {"latitude": 55.1, "longitude": 12.1}},
              "navigationInstruction": {"maneuver": "TURN_RIGHT", "instructions": "Turn right"},
              "localizedValues": {
                "distance": {"text": "100 m"},
                "staticDuration": {"text": "1 min"}
              }
            }]}]
          }]
        }"#;
        let response: ComputeRoutesResponse = serde_json::from_slice(fixture).unwrap();
        let route = route_to_proto(
            response.routes.into_iter().next().unwrap(),
            "destination",
            RoutesUnitSystem::Metric,
        );

        assert_eq!(route.summary, "via Main Street");
        assert_eq!(route.steps.len(), 1);
        assert_eq!(route.total_distance.unwrap().value, 1250);
        assert_eq!(route.total_duration.unwrap().value, 602);
        assert_eq!(route.steps[0].instruction, "Turn right");
        assert_eq!(route.steps[0].maneuver, 10);
        assert_eq!(route.steps[0].duration.as_ref().unwrap().value, 46);
    }

    #[test]
    fn http_statuses_map_without_provider_bodies_or_auth_codes() {
        assert_eq!(
            error_for_http_status(StatusCode::BAD_REQUEST),
            GoogleMapsError::BadRequest
        );
        assert_eq!(
            error_for_http_status(StatusCode::NOT_FOUND),
            GoogleMapsError::NotFound
        );
        assert_eq!(
            error_for_http_status(StatusCode::TOO_MANY_REQUESTS),
            GoogleMapsError::RateLimited
        );
        assert_eq!(
            error_for_http_status(StatusCode::UNAUTHORIZED),
            GoogleMapsError::ProviderUnavailable
        );
        assert_eq!(
            error_for_http_status(StatusCode::FORBIDDEN),
            GoogleMapsError::ProviderUnavailable
        );
    }

    #[tokio::test]
    async fn routes_request_uses_exact_endpoint_headers_field_mask_and_payload() {
        let (base_url, captured) = spawn_mock_google(
            StatusCode::OK,
            r#"{"routes":[{"distanceMeters":1,"duration":"1s"}]}"#,
            Duration::ZERO,
        )
        .await;
        let secret = "routes-test-secret";
        let options = GoogleMapsOptions::new(Some(secret.into()))
            .with_routes_enabled(true)
            .with_routes_compliance_acknowledged(true)
            .with_routes_travel_mode(RoutesTravelMode::Walk)
            .with_routes_unit_system(RoutesUnitSystem::Imperial)
            .with_language_code(Some("en-US".into()))
            .with_routes_timeout(Duration::from_secs(1));
        let client = GoogleMapsClient::new(Client::new(), options).with_test_endpoints(
            format!("{base_url}/directions/v2:computeRoutes"),
            format!("{base_url}/geolocate"),
        );

        let route = client
            .compute_route(55.0, 12.0, " Copenhagen ")
            .await
            .unwrap();
        assert_eq!(route.summary, "Route to Copenhagen");
        assert_eq!(route.total_distance.as_ref().unwrap().value, 1);
        assert_eq!(route.total_distance.as_ref().unwrap().text, "3 ft");

        let captured = captured.lock().await.take().expect("captured request");
        assert_eq!(captured.uri, "/directions/v2:computeRoutes");
        assert_eq!(captured.api_key.as_deref(), Some(secret));
        assert_eq!(captured.field_mask.as_deref(), Some(ROUTES_FIELD_MASK));
        assert!(!captured.uri.contains(secret));
        let body: serde_json::Value = serde_json::from_slice(&captured.body).unwrap();
        assert_eq!(body["travelMode"], "WALK");
        assert_eq!(body["computeAlternativeRoutes"], false);
        assert_eq!(body["languageCode"], "en-US");
        assert_eq!(body["units"], "IMPERIAL");
        assert_eq!(body["origin"]["location"]["latLng"]["latitude"], 55.0);
        assert_eq!(body["destination"]["address"], "Copenhagen");
        assert!(body.get("routingPreference").is_none());
    }

    #[tokio::test]
    async fn geolocation_request_maps_payload_and_success_response() {
        let (base_url, captured) = spawn_mock_google(
            StatusCode::OK,
            r#"{"location":{"lat":55.6761,"lng":12.5683},"accuracy":24.5}"#,
            Duration::ZERO,
        )
        .await;
        let secret = "geo-test-secret";
        let options = GoogleMapsOptions::new(Some(secret.into()))
            .with_geolocation_enabled(true)
            .with_geolocation_timeout(Duration::from_secs(1));
        let client = GoogleMapsClient::new(Client::new(), options).with_test_endpoints(
            format!("{base_url}/routes"),
            format!("{base_url}/geolocation/v1/geolocate"),
        );

        let fix = client.geolocate(&wifi_request()).await.unwrap();
        assert_eq!(fix.latitude, 55.6761);
        assert_eq!(fix.longitude, 12.5683);
        assert_eq!(fix.accuracy_meters, 24.5);

        let captured = captured.lock().await.take().expect("captured request");
        assert_eq!(
            captured.uri,
            "/geolocation/v1/geolocate?key=geo-test-secret"
        );
        assert!(captured.api_key.is_none());
        let body: serde_json::Value = serde_json::from_slice(&captured.body).unwrap();
        assert_eq!(body["considerIp"], false);
        assert_eq!(body["wifiAccessPoints"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn request_timeout_and_provider_auth_failures_are_redacted() {
        let secret = "must-never-appear-in-errors";
        let (slow_base_url, _) = spawn_mock_google(
            StatusCode::OK,
            r#"{"location":{"lat":55.0,"lng":12.0},"accuracy":1.0}"#,
            Duration::from_millis(250),
        )
        .await;
        let options = GoogleMapsOptions::new(Some(secret.into()))
            .with_geolocation_enabled(true)
            .with_geolocation_timeout(Duration::from_millis(20));
        let client = GoogleMapsClient::new(Client::new(), options).with_test_endpoints(
            format!("{slow_base_url}/routes"),
            format!("{slow_base_url}/geo"),
        );
        let timeout = client.geolocate(&wifi_request()).await.unwrap_err();
        assert_eq!(timeout, GoogleMapsError::Transport);
        assert!(!timeout.to_string().contains(secret));
        assert!(!format!("{client:?}").contains(secret));

        let (auth_base_url, _) = spawn_mock_google(
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"body-must-not-leak"}}"#,
            Duration::ZERO,
        )
        .await;
        let options = GoogleMapsOptions::new(Some(secret.into())).with_geolocation_enabled(true);
        let client = GoogleMapsClient::new(Client::new(), options).with_test_endpoints(
            format!("{auth_base_url}/routes"),
            format!("{auth_base_url}/geo"),
        );
        let unauthorized = client.geolocate(&wifi_request()).await.unwrap_err();
        assert_eq!(unauthorized, GoogleMapsError::ProviderUnavailable);
        let rendered = unauthorized.to_string();
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains("body-must-not-leak"));
    }

    #[tokio::test]
    async fn production_client_does_not_replay_sensitive_requests_across_redirects() {
        let (target_base_url, target_capture) = spawn_mock_google(
            StatusCode::OK,
            r#"{"routes":[{"distanceMeters":1,"duration":"1s"}]}"#,
            Duration::ZERO,
        )
        .await;
        let target_url = format!("{target_base_url}/must-not-receive");

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let redirect_app = Router::new().fallback(move || {
            let target_url = target_url.clone();
            async move { Redirect::temporary(&target_url) }
        });
        tokio::spawn(async move {
            axum::serve(listener, redirect_app).await.unwrap();
        });

        let options = GoogleMapsOptions::new(Some("redirect-test-key".into()))
            .with_routes_enabled(true)
            .with_routes_compliance_acknowledged(true);
        let client = GoogleMapsClient::from_options(options)
            .unwrap()
            .with_test_endpoints(
                format!("http://{address}/directions/v2:computeRoutes"),
                format!("http://{address}/geolocate"),
            );
        assert_eq!(
            client.compute_route(55.0, 12.0, "Copenhagen").await,
            Err(GoogleMapsError::ProviderUnavailable)
        );
        assert!(target_capture.lock().await.is_none());
    }
}
