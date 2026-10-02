//! Places, reverse geocoding, and directions, Google Maps Platform.
//!
//! `NearbyPlace` is field-for-field a Google Places object, and
//! `NavigationStep` with its `{text, value}` distance/duration pair and its
//! maneuver enum is a Google directions step, so these adapters are close to a
//! rename. Place search uses Places API (New) and directions use the Routes
//! API (`computeRoutes`). Google closed the legacy Places and Directions APIs
//! to new projects.
//!
//! Reverse geocode is the exception: cosmos's `ReverseGeocodeResponse` uses
//! `municipality` / `country_subdivision`, which is Azure Maps / TomTom
//! vocabulary, Google emits `locality` / `administrative_area_level_1` and
//! never those names. Cosmos therefore used a *different* vendor for that one
//! surface. We adapt Google into the Azure-shaped fields. See
//! [`reverse_geocode`].

use cosmos_protocol::aibus as pb;
use cosmos_protocol::aibus::GeoLocateRequest;
use serde::Deserialize;
use serde_json::{self, json};

use super::{BackendError, http, key};

const KEY_VAR: &str = "COSMOS_GOOGLE_MAPS_KEY";
const DEFAULT_NEARBY_RADIUS_M: f64 = 1_000.0;

// --- places ---------------------------------------------------------------

const PLACES_API: &str = "Places API (New)";
const PLACES_SEARCH_NEARBY_URL: &str = "https://places.googleapis.com/v1/places:searchNearby";
const PLACES_SEARCH_TEXT_URL: &str = "https://places.googleapis.com/v1/places:searchText";

/// Exactly the place fields the stock `NearbyPlace` carries. Places (New)
/// refuses a search without a field mask.
const PLACES_FIELD_MASK: &str = "places.id,places.displayName,places.formattedAddress,\
places.types,places.location,places.rating,places.userRatingCount,\
places.currentOpeningHours.openNow,places.nationalPhoneNumber,places.websiteUri,\
places.editorialSummary";

/// One page of places, the most Google returns and what the legacy API sent.
const PLACE_RESULTS: u32 = 20;

/// Google's largest search circle.
const MAX_SEARCH_RADIUS_M: f64 = 50_000.0;

#[derive(Deserialize, Default)]
struct PlacesResponse {
    #[serde(default)]
    places: Vec<Place>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Place {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_name: LocalizedText,
    #[serde(default)]
    formatted_address: String,
    #[serde(default)]
    types: Vec<String>,
    #[serde(default)]
    location: Option<LatLng>,
    #[serde(default)]
    rating: f32,
    #[serde(default)]
    user_rating_count: i32,
    #[serde(default)]
    current_opening_hours: Option<OpeningHours>,
    #[serde(default)]
    national_phone_number: String,
    #[serde(default)]
    website_uri: String,
    #[serde(default)]
    editorial_summary: LocalizedText,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpeningHours {
    #[serde(default)]
    open_now: bool,
}

/// Place search through Places API (New), in cosmos's wire shape.
///
/// With no query this is the stock Nearby ring's "what is around me": any
/// place inside the radius, most popular first, as the legacy nearby search
/// answered. A query near a point is ranked by distance from that point, so
/// the first place really is the nearest one. The legacy text search ranked by
/// prominence and named a café 1.5 km away as the nearest. A query with no
/// point is ranked by relevance.
pub async fn nearby(
    text_query: &str,
    near: Option<(f64, f64)>,
    radius_m: f64,
) -> Result<Vec<pb::NearbyPlace>, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    let (url, request) = place_search_request(text_query, near, radius_m)?;
    let (status, body) =
        google_post(PLACES_API, url, &api_key, PLACES_FIELD_MASK, &request).await?;
    decode_nearby_response(status, &body)
}

pub(crate) fn decode_nearby_response(
    status: u16,
    body: &[u8],
) -> Result<Vec<pb::NearbyPlace>, BackendError> {
    let found: PlacesResponse = decode_google(PLACES_API, status, body)?;
    Ok(found.places.into_iter().map(to_place).collect())
}

fn place_search_request(
    text_query: &str,
    near: Option<(f64, f64)>,
    radius_m: f64,
) -> Result<(&'static str, serde_json::Value), BackendError> {
    let query = text_query.trim();
    if query.is_empty() {
        let (latitude, longitude) = near.ok_or(BackendError::NoResult)?;
        return Ok((
            PLACES_SEARCH_NEARBY_URL,
            json!({
                "locationRestriction": search_circle(latitude, longitude, search_radius(radius_m)),
                "languageCode": "en",
                "maxResultCount": PLACE_RESULTS,
            }),
        ));
    }

    let mut request = json!({
        "textQuery": query,
        "languageCode": "en",
        "pageSize": PLACE_RESULTS,
    });
    if let Some((latitude, longitude)) = near {
        request["locationBias"] = search_circle(latitude, longitude, search_radius(radius_m));
        request["rankPreference"] = json!("DISTANCE");
    }
    Ok((PLACES_SEARCH_TEXT_URL, request))
}

fn search_circle(latitude: f64, longitude: f64, radius_m: f64) -> serde_json::Value {
    json!({
        "circle": {
            "center": { "latitude": latitude, "longitude": longitude },
            "radius": radius_m,
        }
    })
}

/// The requested radius within Google's limit, or a kilometre when none was
/// given.
fn search_radius(radius_m: f64) -> f64 {
    if radius_m.is_finite() && radius_m > 0.0 {
        radius_m.min(MAX_SEARCH_RADIUS_M)
    } else {
        DEFAULT_NEARBY_RADIUS_M
    }
}

fn to_place(place: Place) -> pb::NearbyPlace {
    pb::NearbyPlace {
        name: place.display_name.text,
        formatted_address: place.formatted_address,
        place_types: place.types,
        place_id: place.id,
        phone_number: place.national_phone_number,
        // Most places have no editorial summary. The device then reads an
        // absent description, never an invented one.
        place_description: place.editorial_summary.text,
        description_language: place.editorial_summary.language_code,
        website_url: place.website_uri,
        rating: place.rating,
        user_ratings_total: place.user_rating_count,
        location: place.location.map(to_location),
        open_now: place
            .current_opening_hours
            .is_some_and(|hours| hours.open_now),
    }
}

// --- reverse geocoding ----------------------------------------------------

#[derive(Deserialize)]
struct GeocodeResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    error_message: String,
    #[serde(default)]
    results: Vec<GeocodeResult>,
}

#[derive(Deserialize)]
struct GeocodeResult {
    #[serde(default)]
    address_components: Vec<AddressComponent>,
}

#[derive(Deserialize)]
struct AddressComponent {
    #[serde(default)]
    long_name: String,
    #[serde(default)]
    types: Vec<String>,
}

/// Reverse geocode a point into cosmos's address shape.
///
/// cosmos's field names are Azure Maps / TomTom vocabulary, so this translates
/// Google's `address_components` into them:
///
/// | Cosmos field | Google component |
/// |---|---|
/// | `street_number` | `street_number` |
/// | `street_name` | `route` |
/// | `municipality` | `locality` |
/// | `country_subdivision` | `administrative_area_level_1` |
/// | `country` | `country` |
/// | `postal_code` | `postal_code` |
///
/// A component Google does not return stays empty rather than being filled from
/// a neighbouring field, a wrong city is worse than an absent one.
pub async fn reverse_geocode(
    latitude: f64,
    longitude: f64,
) -> Result<pb::ReverseGeocodeResponse, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    let url = format!(
        "https://maps.googleapis.com/maps/api/geocode/json?latlng={latitude},{longitude}&key={api_key}"
    );
    let geocoded: GeocodeResponse = http()
        .get(url)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    if geocoded.status == "ZERO_RESULTS" {
        return Err(BackendError::NoResult);
    }
    if geocoded.status != "OK" {
        return Err(legacy_refusal(
            "Geocoding",
            &geocoded.status,
            &geocoded.error_message,
        ));
    }
    let first = geocoded.results.first().ok_or(BackendError::NoResult)?;
    Ok(to_address(&first.address_components))
}

fn to_address(components: &[AddressComponent]) -> pb::ReverseGeocodeResponse {
    let pick = |wanted: &str| {
        components
            .iter()
            .find(|c| c.types.iter().any(|t| t == wanted))
            .map(|c| c.long_name.clone())
            .unwrap_or_default()
    };
    pb::ReverseGeocodeResponse {
        street_number: pick("street_number"),
        street_name: pick("route"),
        municipality: pick("locality"),
        country_subdivision: pick("administrative_area_level_1"),
        country: pick("country"),
        postal_code: pick("postal_code"),
    }
}

/// A non-OK status from a keyed Google web service. `REQUEST_DENIED` means
/// Google refused the key for that API, which the owner fixes in Google Cloud,
/// so it reads as "not configured". Anything else is an outage. Either way the
/// operator's log says which, with Google's own reason.
fn legacy_refusal(api: &'static str, status: &str, message: &str) -> BackendError {
    let message = bounded_log_text(message);
    if status == "REQUEST_DENIED" {
        tracing::warn!(
            api,
            status,
            message,
            "Google refused the Maps key for this API"
        );
        BackendError::NotConfigured
    } else {
        tracing::warn!(api, status, message, "Google Maps did not answer");
        BackendError::Unavailable
    }
}

/// Percent-encode a query component. Shared with the search backend.
pub(crate) fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// --- geolocation and directions -----------------------------------------

#[derive(Deserialize)]
struct GeoLocateResponse {
    #[serde(default)]
    location: Option<GeoLocation>,
    #[serde(default)]
    accuracy: Option<f64>,
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
struct GeoLocation {
    #[serde(default)]
    lat: f64,
    #[serde(default)]
    lng: f64,
}

fn wifi_access_points_for(request: &GeoLocateRequest) -> Vec<serde_json::Value> {
    request
        .wifi_access_points
        .iter()
        .filter_map(|w| {
            if w.mac_address.is_empty() {
                None
            } else {
                Some(json!({
                    "macAddress": w.mac_address,
                    "signalStrength": w.signal_strength,
                    "signalToNoiseRatio": w.signal_to_noise_ratio,
                    "channel": w.channel,
                    "age": w.age
                }))
            }
        })
        .collect()
}

fn cell_towers_for(request: &GeoLocateRequest) -> Vec<serde_json::Value> {
    request
        .cell_towers
        .iter()
        .filter_map(|c| {
            if c.cell_id == 0 && c.location_area_code == 0 && c.mobile_country_code == 0 {
                None
            } else {
                Some(json!({
                    "cellId": c.cell_id,
                    "locationAreaCode": c.location_area_code,
                    "mobileCountryCode": c.mobile_country_code,
                    "mobileNetworkCode": c.mobile_network_code,
                    "radioType": request.radio_type,
                    "carrier": request.carrier,
                    "newRadioCellId": c.new_radio_cell_id,
                    "age": c.age,
                    "signalStrength": c.signal_strength,
                    "timingAdvance": c.timing_advance
                }))
            }
        })
        .collect()
}

/// Resolve observed radios to a point using Google Geolocation.
///
/// This is explicitly best-effort and non-sensitive: if the external provider is
/// not configured or returns no usable result, callers receive a safe capability
/// status instead of a fabricated coordinate.
pub async fn geolocate(req: &GeoLocateRequest) -> Result<pb::GeoLocateResponse, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    let wifi_access_points = wifi_access_points_for(req);
    let cell_towers = cell_towers_for(req);
    if wifi_access_points.is_empty() && cell_towers.is_empty() {
        return Err(BackendError::NoResult);
    }
    let body = json!({
        "considerIp": req.consider_ip,
        "wifiAccessPoints": wifi_access_points,
        "cellTowers": cell_towers
    });

    let http_response = http()
        .post(format!(
            "https://www.googleapis.com/geolocation/v1/geolocate?key={api_key}"
        ))
        .json(&body)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    let status = http_response.status();
    // Google's Geolocation API answers 404 `notFound` when it cannot place the
    // request. The stock Pin treats that as "no fix", not an outage.
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(pb::GeoLocateResponse {
            location: None,
            radius_accuracy: 0.0,
            status: pb::GeoLocateResponseStatus::GeolocateResponseStatusNotFound as i32,
        });
    }
    // The Geolocation API is separate from Places, Geocoding and Routes. A Maps
    // key not enabled for it is refused. Report that the way the other Google
    // paths report a refused key, instead of the silent `Unavailable` that left
    // every network fix failing with no explanation in the log.
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        tracing::warn!(
            status = status.as_u16(),
            "Google Geolocation API refused the request; enable the Geolocation API for the Maps key in Google Cloud"
        );
        return Err(BackendError::NotConfigured);
    }
    if !status.is_success() {
        tracing::warn!(
            status = status.as_u16(),
            "Google Geolocation API request failed"
        );
        return Err(BackendError::Unavailable);
    }
    let response: GeoLocateResponse = http_response
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    if response.location.is_none() {
        return Err(BackendError::NoResult);
    }
    if response.status == "OK" || response.status.is_empty() {
        let loc = response.location.expect("location");
        return Ok(pb::GeoLocateResponse {
            location: Some(pb::Location {
                latitude: loc.lat,
                longitude: loc.lng,
            }),
            radius_accuracy: response.accuracy.unwrap_or(0.0),
            status: pb::GeoLocateResponseStatus::GeolocateResponseStatusSuccess as i32,
        });
    }

    if response.status == "ZERO_RESULTS" {
        Ok(pb::GeoLocateResponse {
            location: None,
            radius_accuracy: 0.0,
            status: pb::GeoLocateResponseStatus::GeolocateResponseStatusNotFound as i32,
        })
    } else {
        Err(BackendError::Unavailable)
    }
}

/// The travel mode the assistant's `route` tool asks for. The stock
/// `NavigationDirectionsRequest` names only a destination, so the stock RPC
/// never sets one.
///
/// INFERRED: `Transit`. No recovered stock app or humane.center page asks for
/// a transit route. The stock `NavigationDirectionsResponse` carries one
/// unchanged, as Google's legacy Directions API did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectionsMode {
    Driving,
    Walking,
    Bicycling,
    Transit,
}

impl DirectionsMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "driving" => Some(Self::Driving),
            "walking" => Some(Self::Walking),
            "bicycling" | "cycling" => Some(Self::Bicycling),
            "transit" => Some(Self::Transit),
            _ => None,
        }
    }

    /// The Routes API `travelMode` for this mode.
    fn as_routes_travel_mode(self) -> &'static str {
        match self {
            Self::Driving => "DRIVE",
            Self::Walking => "WALK",
            Self::Bicycling => "BICYCLE",
            Self::Transit => "TRANSIT",
        }
    }
}

const ROUTES_API: &str = "Routes API";
const ROUTES_URL: &str = "https://routes.googleapis.com/directions/v2:computeRoutes";

/// Exactly the route fields the stock `NavigationDirectionsResponse` carries,
/// plus the transit details a transit step's instruction is spoken from. The
/// Routes API refuses a request without a field mask.
const ROUTES_FIELD_MASK: &str = "routes.description,routes.distanceMeters,routes.duration,\
routes.localizedValues,\
routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,\
routes.legs.steps.localizedValues,routes.legs.steps.navigationInstruction,\
routes.legs.steps.startLocation,routes.legs.steps.endLocation,\
routes.legs.steps.transitDetails";

/// A destination lookup needs only the place ID, Places (New)'s cheapest
/// Text Search.
const DESTINATION_FIELD_MASK: &str = "places.id";

/// How far around the Pin a named destination is looked for first. It is a
/// bias, not a limit: a farther place the wearer names still resolves.
const DESTINATION_BIAS_RADIUS_M: f64 = 50_000.0;

/// The Text Search that turns the destination the wearer named into one place
/// near the Pin.
fn destination_search_request(
    latitude: f64,
    longitude: f64,
    destination: &str,
) -> serde_json::Value {
    json!({
        "textQuery": destination,
        "languageCode": "en",
        "pageSize": 1,
        "locationBias": search_circle(latitude, longitude, DESTINATION_BIAS_RADIUS_M),
    })
}

/// The ID of the place a destination search found. A destination Google
/// cannot place answers `200 {}`.
fn decode_destination(status: u16, body: &[u8]) -> Result<String, BackendError> {
    let found: PlacesResponse = decode_google(PLACES_API, status, body)?;
    found
        .places
        .into_iter()
        .map(|place| place.id)
        .find(|id| !id.is_empty())
        .ok_or_else(|| {
            tracing::info!("Google Places found no place for the route destination");
            BackendError::NoResult
        })
}

/// The `computeRoutes` body: from the Pin's position to one resolved place.
///
/// The display language is pinned to English, the assistant's language. Left
/// unset, Google picks the language of the route's country. Display units stay
/// inferred from the origin, as the legacy API did. Omitting the mode leaves
/// Google's default, driving, which is also what the stock RPC asks for.
fn directions_request(
    latitude: f64,
    longitude: f64,
    place_id: &str,
    mode: Option<DirectionsMode>,
) -> serde_json::Value {
    let mut body = json!({
        "origin": { "location": { "latLng": { "latitude": latitude, "longitude": longitude } } },
        "destination": { "placeId": place_id },
        "languageCode": "en",
    });
    if let Some(mode) = mode {
        body["travelMode"] = json!(mode.as_routes_travel_mode());
    }
    body
}

#[derive(Deserialize, Default)]
struct RoutesResponse {
    #[serde(default)]
    routes: Vec<Route>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    #[serde(default)]
    description: String,
    #[serde(default)]
    distance_meters: i64,
    #[serde(default)]
    duration: String,
    #[serde(default)]
    localized_values: LocalizedValues,
    #[serde(default)]
    legs: Vec<RouteLeg>,
}

#[derive(Deserialize)]
struct RouteLeg {
    #[serde(default)]
    steps: Vec<RouteStep>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteStep {
    #[serde(default)]
    distance_meters: i64,
    #[serde(default)]
    static_duration: String,
    #[serde(default)]
    localized_values: LocalizedValues,
    #[serde(default)]
    navigation_instruction: Option<NavigationInstruction>,
    #[serde(default)]
    start_location: Option<RouteLocation>,
    #[serde(default)]
    end_location: Option<RouteLocation>,
    #[serde(default)]
    transit_details: Option<TransitDetails>,
}

/// The Routes API `RouteLegStepTransitDetails` fields a spoken ride needs.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TransitDetails {
    #[serde(default)]
    stop_details: TransitStopDetails,
    #[serde(default)]
    localized_values: TransitLocalizedValues,
    #[serde(default)]
    headsign: String,
    #[serde(default)]
    transit_line: TransitLine,
    #[serde(default)]
    stop_count: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TransitStopDetails {
    #[serde(default)]
    departure_stop: TransitStop,
    #[serde(default)]
    arrival_stop: TransitStop,
}

#[derive(Deserialize, Default)]
struct TransitStop {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TransitLocalizedValues {
    #[serde(default)]
    departure_time: LocalizedTime,
}

#[derive(Deserialize, Default)]
struct LocalizedTime {
    #[serde(default)]
    time: LocalizedText,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TransitLine {
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_short: String,
    #[serde(default)]
    vehicle: TransitVehicle,
}

#[derive(Deserialize, Default)]
struct TransitVehicle {
    #[serde(default)]
    name: LocalizedText,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalizedValues {
    #[serde(default)]
    distance: LocalizedText,
    #[serde(default)]
    duration: LocalizedText,
    #[serde(default)]
    static_duration: LocalizedText,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalizedText {
    #[serde(default)]
    text: String,
    #[serde(default)]
    language_code: String,
}

#[derive(Deserialize)]
struct NavigationInstruction {
    #[serde(default)]
    maneuver: String,
    #[serde(default)]
    instructions: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteLocation {
    lat_lng: Option<LatLng>,
}

/// Google's `LatLng`, shared by Places (New) and Routes.
#[derive(Deserialize)]
struct LatLng {
    #[serde(default)]
    latitude: f64,
    #[serde(default)]
    longitude: f64,
}

fn to_location(point: LatLng) -> pb::Location {
    pb::Location {
        latitude: point.latitude,
        longitude: point.longitude,
    }
}

#[derive(Deserialize)]
struct GoogleErrorBody {
    error: GoogleError,
}

#[derive(Deserialize)]
struct GoogleError {
    #[serde(default)]
    status: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    details: Vec<GoogleErrorDetail>,
}

#[derive(Deserialize)]
struct GoogleErrorDetail {
    #[serde(default)]
    reason: String,
}

/// Resolve an origin point + destination to route steps, through Places API
/// (New) and the Google Routes API.
///
/// Routes geocodes a bare destination with no notion of where the wearer is:
/// with English pinned, "Nyhavn" became Nyhavn in Greenland, where no route
/// exists. So the destination is first resolved to one place near the Pin,
/// and the route goes to that place ID. Google closed the legacy Directions
/// API to new Cloud projects. Every maneuver the Routes API names for a turn
/// has a stock `NavigationManeuver` value, so the steps map field for field.
pub async fn directions(
    latitude: f64,
    longitude: f64,
    destination: String,
    mode: Option<DirectionsMode>,
) -> Result<pb::NavigationDirectionsResponse, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    let destination = destination.trim();
    if destination.is_empty() {
        return Err(BackendError::NoResult);
    }
    let (status, body) = google_post(
        PLACES_API,
        PLACES_SEARCH_TEXT_URL,
        &api_key,
        DESTINATION_FIELD_MASK,
        &destination_search_request(latitude, longitude, destination),
    )
    .await?;
    let place_id = decode_destination(status, &body)?;
    let (status, body) = google_post(
        ROUTES_API,
        ROUTES_URL,
        &api_key,
        ROUTES_FIELD_MASK,
        &directions_request(latitude, longitude, &place_id, mode),
    )
    .await?;
    decode_directions(status, &body)
}

/// POST one request to a Google Maps Platform API. The key rides in a header,
/// so no URL here ever carries it.
async fn google_post(
    api: &'static str,
    url: &str,
    api_key: &str,
    field_mask: &str,
    request: &serde_json::Value,
) -> Result<(u16, Vec<u8>), BackendError> {
    let response = http()
        .post(url)
        .header("X-Goog-Api-Key", api_key)
        .header("X-Goog-FieldMask", field_mask)
        .json(request)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                api,
                timeout = error.is_timeout(),
                connect = error.is_connect(),
                "Google Maps could not be reached"
            );
            BackendError::Unavailable
        })?;
    let status = response.status().as_u16();
    let body = response.bytes().await.map_err(|_| {
        tracing::warn!(api, status, "Google Maps response could not be read");
        BackendError::Unavailable
    })?;
    Ok((status, body.to_vec()))
}

/// Read one answer from a keyed Google Maps Platform API, or say why not.
///
/// A key Google refuses for this API (not enabled, restricted, or invalid) is
/// a configuration fault the owner fixes in Google Cloud, so it reads as
/// "not configured" rather than as an outage, and the reason Google gave is
/// logged for the operator.
fn decode_google<T: serde::de::DeserializeOwned>(
    api: &'static str,
    status: u16,
    body: &[u8],
) -> Result<T, BackendError> {
    if !(200..300).contains(&status) {
        let error = serde_json::from_slice::<GoogleErrorBody>(body)
            .map(|body| body.error)
            .ok();
        let google_status = error.as_ref().map_or("", |error| error.status.as_str());
        let message = error
            .as_ref()
            .map_or(String::new(), |error| bounded_log_text(&error.message));
        let key_refused = matches!(status, 401 | 403)
            || error.as_ref().is_some_and(|error| {
                error
                    .details
                    .iter()
                    .any(|detail| detail.reason.starts_with("API_KEY"))
            });
        if key_refused {
            tracing::warn!(
                api,
                status,
                google_status,
                message,
                "Google refused the Maps key for this API; enable it for the key in Google Cloud"
            );
            return Err(BackendError::NotConfigured);
        }
        tracing::warn!(
            api,
            status,
            google_status,
            message,
            "Google Maps did not answer"
        );
        return Err(BackendError::Unavailable);
    }
    serde_json::from_slice(body).map_err(|_| {
        tracing::warn!(api, status, "Google Maps answered with an unreadable body");
        BackendError::Unavailable
    })
}

/// Map one Routes API answer onto the stock wire shape, or say why not. A
/// place Google cannot route to answers `200` with no routes.
pub(crate) fn decode_directions(
    status: u16,
    body: &[u8],
) -> Result<pb::NavigationDirectionsResponse, BackendError> {
    let found: RoutesResponse = decode_google(ROUTES_API, status, body)?;
    let Some(route) = found.routes.into_iter().next() else {
        tracing::info!("Google Routes found no route to the destination");
        return Err(BackendError::NoResult);
    };
    let steps: Vec<RouteStep> = route.legs.into_iter().flat_map(|leg| leg.steps).collect();
    let steps: Vec<pb::NavigationStep> = if steps.iter().any(|step| step.transit_details.is_some())
    {
        transit_segments(steps)
    } else {
        steps.into_iter().map(to_navigation_step).collect()
    };
    if steps.is_empty() {
        tracing::info!("Google Routes found a route with no steps");
        return Err(BackendError::NoResult);
    }
    Ok(pb::NavigationDirectionsResponse {
        summary: route.description,
        steps,
        total_distance: Some(pb::NavigationDistance {
            text: route.localized_values.distance.text,
            value: saturating_i32(route.distance_meters),
        }),
        total_duration: Some(pb::NavigationDuration {
            text: route.localized_values.duration.text,
            value: duration_seconds(&route.duration),
        }),
    })
}

fn to_navigation_step(step: RouteStep) -> pb::NavigationStep {
    let (maneuver, instruction) = step
        .navigation_instruction
        .map(|instruction| (instruction.maneuver, instruction.instructions))
        .unwrap_or_default();
    pb::NavigationStep {
        instruction: spoken_instruction(&instruction),
        distance: Some(pb::NavigationDistance {
            text: step.localized_values.distance.text,
            value: saturating_i32(step.distance_meters),
        }),
        duration: Some(pb::NavigationDuration {
            text: step.localized_values.static_duration.text,
            value: duration_seconds(&step.static_duration),
        }),
        start_location: step.start_location.and_then(route_location),
        end_location: step.end_location.and_then(route_location),
        maneuver: navigation_maneuver(&maneuver) as i32,
    }
}

/// A transit route as one step per walk and one per ride, the shape the legacy
/// Directions API gave the stock response. The Routes API lists every turn of
/// each walk instead, and a spoken answer bounded to a few steps would run out
/// before the first ride.
fn transit_segments(steps: Vec<RouteStep>) -> Vec<pb::NavigationStep> {
    let mut segments = Vec::new();
    let mut walk = Vec::new();
    for mut step in steps {
        let Some(ride) = step.transit_details.take() else {
            walk.push(step);
            continue;
        };
        if !walk.is_empty() {
            segments.push(walk_segment(
                std::mem::take(&mut walk),
                &ride.stop_details.departure_stop.name,
            ));
        }
        let spoken = ride_instruction(&ride);
        let mut ride_step = to_navigation_step(step);
        if !spoken.is_empty() {
            ride_step.instruction = spoken;
        }
        segments.push(ride_step);
    }
    if !walk.is_empty() {
        segments.push(walk_segment(walk, ""));
    }
    segments
}

/// One walk between rides. Google localizes each step's text. A sum has none,
/// so the text stays empty rather than guessing the origin's units.
///
/// INFERRED: the wording "Walk to {stop}", after the legacy Directions API.
fn walk_segment(mut walk: Vec<RouteStep>, to: &str) -> pb::NavigationStep {
    let meters = walk.iter().map(|step| step.distance_meters.max(0)).sum();
    let seconds = walk
        .iter()
        .map(|step| i64::from(duration_seconds(&step.static_duration)))
        .sum();
    let start_location = walk
        .first_mut()
        .and_then(|step| step.start_location.take())
        .and_then(route_location);
    let end_location = walk
        .last_mut()
        .and_then(|step| step.end_location.take())
        .and_then(route_location);
    let to = to.trim();
    pb::NavigationStep {
        instruction: if to.is_empty() {
            "Walk to the destination".to_owned()
        } else {
            format!("Walk to {to}")
        },
        distance: Some(pb::NavigationDistance {
            text: String::new(),
            value: saturating_i32(meters),
        }),
        duration: Some(pb::NavigationDuration {
            text: String::new(),
            value: saturating_i32(seconds),
        }),
        start_location,
        end_location,
        maneuver: pb::NavigationManeuver::NavigationActionUnspecified as i32,
    }
}

/// One ride, spoken from its transit details: line, direction, where and when
/// to board, and where to get off. Empty when Google named none of them.
///
/// INFERRED: the wording.
fn ride_instruction(ride: &TransitDetails) -> String {
    let line = &ride.transit_line;
    let name = [line.name_short.trim(), line.name.trim()]
        .into_iter()
        .find(|name| !name.is_empty())
        .unwrap_or_default();
    let vehicle = line.vehicle.name.text.trim().to_lowercase();
    let boarding = ride.stop_details.departure_stop.name.trim();
    let alighting = ride.stop_details.arrival_stop.name.trim();
    let headsign = ride.headsign.trim();
    if name.is_empty() && vehicle.is_empty() && headsign.is_empty() && alighting.is_empty() {
        return String::new();
    }
    let mut spoken = match (name.is_empty(), vehicle.is_empty()) {
        (false, false) => format!("Take the {name} {vehicle}"),
        (false, true) => format!("Take the {name}"),
        (true, false) => format!("Take the {vehicle}"),
        (true, true) => "Take transit".to_owned(),
    };
    if !headsign.is_empty() {
        spoken.push_str(&format!(" towards {headsign}"));
    }
    if !boarding.is_empty() {
        spoken.push_str(&format!(" from {boarding}"));
    }
    let departs = ride.localized_values.departure_time.time.text.trim();
    if !departs.is_empty() {
        spoken.push_str(&format!(" at {departs}"));
    }
    if !alighting.is_empty() {
        spoken.push_str(&format!(", and get off at {alighting}"));
        match ride.stop_count {
            1 => spoken.push_str(" after 1 stop"),
            count if count > 1 => spoken.push_str(&format!(" after {count} stops")),
            _ => {}
        }
    }
    spoken
}

/// Routes API instructions put a secondary note ("Destination will be on the
/// right") on its own line. Spoken guidance reads them as sentences.
fn spoken_instruction(instruction: &str) -> String {
    instruction
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(". ")
}

fn route_location(location: RouteLocation) -> Option<pb::Location> {
    location.lat_lng.map(to_location)
}

/// The stock enum is Google's legacy Directions maneuver list. The Routes API
/// kept all of it except keep-left and keep-right, which it never sends, and
/// added `DEPART` and `NAME_CHANGE`, which have no stock value.
fn navigation_maneuver(maneuver: &str) -> pb::NavigationManeuver {
    use pb::NavigationManeuver as M;
    match maneuver {
        "TURN_SLIGHT_LEFT" => M::NavigationActionTurnSlightLeft,
        "TURN_SHARP_LEFT" => M::NavigationActionTurnSharpLeft,
        "TURN_LEFT" => M::NavigationActionTurnLeft,
        "TURN_SLIGHT_RIGHT" => M::NavigationActionTurnSlightRight,
        "TURN_SHARP_RIGHT" => M::NavigationActionTurnSharpRight,
        "UTURN_LEFT" => M::NavigationActionUturnLeft,
        "UTURN_RIGHT" => M::NavigationActionUturnRight,
        "TURN_RIGHT" => M::NavigationActionTurnRight,
        "STRAIGHT" => M::NavigationActionGoStraight,
        "RAMP_LEFT" => M::NavigationActionRampLeft,
        "RAMP_RIGHT" => M::NavigationActionRampRight,
        "MERGE" => M::NavigationActionMerge,
        "FORK_LEFT" => M::NavigationActionForkLeft,
        "FORK_RIGHT" => M::NavigationActionForkRight,
        "FERRY" => M::NavigationActionFerry,
        "FERRY_TRAIN" => M::NavigationActionFerryTrain,
        "ROUNDABOUT_LEFT" => M::NavigationActionRoundaboutLeft,
        "ROUNDABOUT_RIGHT" => M::NavigationActionRoundaboutRight,
        _ => M::NavigationActionUnspecified,
    }
}

/// A protobuf `Duration` in JSON: whole or fractional seconds with an `s`.
fn duration_seconds(value: &str) -> i32 {
    value
        .trim()
        .strip_suffix('s')
        .and_then(|seconds| seconds.parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map_or(0, |seconds| seconds.round().min(f64::from(i32::MAX)) as i32)
}

fn saturating_i32(value: i64) -> i32 {
    i32::try_from(value.max(0)).unwrap_or(i32::MAX)
}

/// Google's own error text, bounded for a log line. It names the API and the
/// project, never the key.
fn bounded_log_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_places_mask_names_every_stock_nearby_field() {
        for field in [
            "places.id",
            "places.displayName",
            "places.formattedAddress",
            "places.types",
            "places.location",
            "places.rating",
            "places.userRatingCount",
            "places.currentOpeningHours.openNow",
            "places.nationalPhoneNumber",
            "places.websiteUri",
            "places.editorialSummary",
        ] {
            assert!(
                PLACES_FIELD_MASK.split(',').any(|path| path == field),
                "{field}"
            );
        }
        assert_eq!(PLACES_FIELD_MASK.split(',').count(), 11);
    }

    #[test]
    fn every_routes_maneuver_reaches_its_stock_value() {
        use pb::NavigationManeuver as M;
        for (routes, stock) in [
            ("TURN_SLIGHT_LEFT", M::NavigationActionTurnSlightLeft),
            ("TURN_SHARP_LEFT", M::NavigationActionTurnSharpLeft),
            ("UTURN_LEFT", M::NavigationActionUturnLeft),
            ("TURN_LEFT", M::NavigationActionTurnLeft),
            ("TURN_SLIGHT_RIGHT", M::NavigationActionTurnSlightRight),
            ("TURN_SHARP_RIGHT", M::NavigationActionTurnSharpRight),
            ("UTURN_RIGHT", M::NavigationActionUturnRight),
            ("TURN_RIGHT", M::NavigationActionTurnRight),
            ("STRAIGHT", M::NavigationActionGoStraight),
            ("RAMP_LEFT", M::NavigationActionRampLeft),
            ("RAMP_RIGHT", M::NavigationActionRampRight),
            ("MERGE", M::NavigationActionMerge),
            ("FORK_LEFT", M::NavigationActionForkLeft),
            ("FORK_RIGHT", M::NavigationActionForkRight),
            ("FERRY", M::NavigationActionFerry),
            ("FERRY_TRAIN", M::NavigationActionFerryTrain),
            ("ROUNDABOUT_LEFT", M::NavigationActionRoundaboutLeft),
            ("ROUNDABOUT_RIGHT", M::NavigationActionRoundaboutRight),
            ("DEPART", M::NavigationActionUnspecified),
            ("NAME_CHANGE", M::NavigationActionUnspecified),
            ("", M::NavigationActionUnspecified),
        ] {
            assert_eq!(navigation_maneuver(routes), stock, "{routes}");
        }
    }

    /// The live failure: driving and cycling to "Nyhavn" reached the wearer
    /// as "no results". Routed to the resolved place, both carry steps.
    #[test]
    fn recorded_driving_and_cycling_routes_to_nyhavn_carry_their_steps() {
        let drive = decode_directions(200, recorded::NYHAVN_DRIVE.as_bytes()).expect("drive");
        assert_eq!(drive.summary, "Holbergsgade");
        assert_eq!(
            drive
                .total_distance
                .as_ref()
                .map(|d| (d.text.as_str(), d.value)),
            Some(("2.0 km", 1982))
        );
        assert_eq!(drive.total_duration.as_ref().map(|d| d.value), Some(425));
        assert_eq!(drive.steps.len(), 3);
        assert_eq!(
            drive.steps[0].instruction,
            "Head southwest on H. C. Andersens Blvd. toward H. C. Andersens Blvd."
        );
        assert_eq!(
            drive.steps[2].instruction,
            "Turn left onto Nyhavn. Destination will be on the right"
        );

        let cycle = decode_directions(200, recorded::NYHAVN_BICYCLE.as_bytes()).expect("cycle");
        assert_eq!(cycle.summary, "Vester Voldgade and O2");
        assert_eq!(cycle.steps.len(), 6);
        assert_eq!(
            cycle.steps[1].maneuver,
            pb::NavigationManeuver::NavigationActionTurnRight as i32
        );
        assert_eq!(
            cycle.steps[5].instruction,
            "Turn left onto Nyhavn. Walk your bicycle. Destination will be on the left"
        );
        assert!(cycle.steps.iter().all(|step| step.start_location.is_some()));
    }
}

/// Real Google answers, trimmed, recorded from Rådhuspladsen in Copenhagen
/// (55.6761, 12.5683) with the request shapes above.
#[cfg(test)]
pub(crate) mod recorded {

    /// `computeRoutes` DRIVE to the Nyhavn place ID. Three of its nine steps.
    pub(crate) const NYHAVN_DRIVE: &str = r#"{
        "routes": [{
            "distanceMeters": 1982,
            "duration": "425s",
            "description": "Holbergsgade",
            "localizedValues": {
                "distance": { "text": "2.0 km" },
                "duration": { "text": "7 mins" },
                "staticDuration": { "text": "7 mins" }
            },
            "legs": [{ "steps": [
                {"distanceMeters": 322, "staticDuration": "50s", "startLocation": {"latLng": {"latitude": 55.6758792, "longitude": 12.568048899999999}}, "endLocation": {"latLng": {"latitude": 55.673969, "longitude": 12.5713264}}, "navigationInstruction": {"maneuver": "DEPART", "instructions": "Head southwest on H. C. Andersens Blvd. toward H. C. Andersens Blvd."}, "localizedValues": {"distance": {"text": "0.3 km"}, "staticDuration": {"text": "1 min"}}},
                {"distanceMeters": 308, "staticDuration": "68s", "startLocation": {"latLng": {"latitude": 55.6736161, "longitude": 12.572206399999999}}, "endLocation": {"latLng": {"latitude": 55.6755092, "longitude": 12.575673799999999}}, "navigationInstruction": {"maneuver": "TURN_LEFT", "instructions": "Turn left onto Stormgade"}, "localizedValues": {"distance": {"text": "0.3 km"}, "staticDuration": {"text": "1 min"}}},
                {"distanceMeters": 37, "staticDuration": "18s", "startLocation": {"latLng": {"latitude": 55.67943640000001, "longitude": 12.591166399999999}}, "endLocation": {"latLng": {"latitude": 55.679584399999996, "longitude": 12.5906386}}, "navigationInstruction": {"maneuver": "TURN_LEFT", "instructions": "Turn left onto Nyhavn\nDestination will be on the right"}, "localizedValues": {"distance": {"text": "37 m"}, "staticDuration": {"text": "1 min"}}}
            ] }]
        }]
    }"#;

    /// `computeRoutes` BICYCLE to the Nyhavn place ID, every step.
    pub(crate) const NYHAVN_BICYCLE: &str = r#"{
        "routes": [{
            "distanceMeters": 2332,
            "duration": "465s",
            "description": "Vester Voldgade and O2",
            "localizedValues": {
                "distance": { "text": "2.3 km" },
                "duration": { "text": "8 mins" },
                "staticDuration": { "text": "8 mins" }
            },
            "legs": [{ "steps": [
                {"distanceMeters": 69, "staticDuration": "12s", "startLocation": {"latLng": {"latitude": 55.676145600000005, "longitude": 12.568188}}, "endLocation": {"latLng": {"latitude": 55.676640799999994, "longitude": 12.568634399999999}}, "navigationInstruction": {"maneuver": "DEPART", "instructions": "Head northeast toward Rådhuspladsen"}, "localizedValues": {"distance": {"text": "69 m"}, "staticDuration": {"text": "1 min"}}},
                {"distanceMeters": 205, "staticDuration": "32s", "startLocation": {"latLng": {"latitude": 55.676640799999994, "longitude": 12.568634399999999}}, "endLocation": {"latLng": {"latitude": 55.675435099999994, "longitude": 12.5711075}}, "navigationInstruction": {"maneuver": "TURN_RIGHT", "instructions": "Turn right onto Rådhuspladsen"}, "localizedValues": {"distance": {"text": "0.2 km"}, "staticDuration": {"text": "1 min"}}},
                {"distanceMeters": 638, "staticDuration": "101s", "startLocation": {"latLng": {"latitude": 55.675435099999994, "longitude": 12.5711075}}, "endLocation": {"latLng": {"latitude": 55.671595, "longitude": 12.5786492}}, "navigationInstruction": {"maneuver": "NAME_CHANGE", "instructions": "Continue onto Vester Voldgade"}, "localizedValues": {"distance": {"text": "0.6 km"}, "staticDuration": {"text": "2 mins"}}},
                {"distanceMeters": 956, "staticDuration": "199s", "startLocation": {"latLng": {"latitude": 55.671595, "longitude": 12.5786492}}, "endLocation": {"latLng": {"latitude": 55.677604699999996, "longitude": 12.5863982}}, "navigationInstruction": {"maneuver": "TURN_LEFT", "instructions": "Turn left onto Christians Brygge/O2\nContinue to follow O2"}, "localizedValues": {"distance": {"text": "1.0 km"}, "staticDuration": {"text": "3 mins"}}},
                {"distanceMeters": 428, "staticDuration": "74s", "startLocation": {"latLng": {"latitude": 55.677604699999996, "longitude": 12.5863982}}, "endLocation": {"latLng": {"latitude": 55.679801399999995, "longitude": 12.5914457}}, "navigationInstruction": {"maneuver": "TURN_RIGHT", "instructions": "Turn right onto Holbergsgade"}, "localizedValues": {"distance": {"text": "0.4 km"}, "staticDuration": {"text": "1 min"}}},
                {"distanceMeters": 36, "staticDuration": "47s", "startLocation": {"latLng": {"latitude": 55.679801399999995, "longitude": 12.5914457}}, "endLocation": {"latLng": {"latitude": 55.679927799999994, "longitude": 12.5909193}}, "navigationInstruction": {"maneuver": "TURN_LEFT", "instructions": "Turn left onto Nyhavn\nWalk your bicycle\nDestination will be on the left"}, "localizedValues": {"distance": {"text": "36 m"}, "staticDuration": {"text": "1 min"}}}
            ] }]
        }]
    }"#;
}
