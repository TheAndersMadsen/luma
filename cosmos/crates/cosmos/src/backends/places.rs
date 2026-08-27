//! Places, reverse geocoding, and directions — Google Maps Platform.
//!
//! `NearbyPlace`, `NavigationStep`, and the `{text, value}` distance/duration
//! pair are field-for-field Google Places / Directions objects, so these adapters are close to a
//! rename.
//!
//! Reverse geocode is the exception: cosmos's `ReverseGeocodeResponse` uses
//! `municipality` / `country_subdivision`, which is Azure Maps / TomTom
//! vocabulary — Google emits `locality` / `administrative_area_level_1` and
//! never those names. Cosmos therefore used a *different* vendor for that one
//! surface. We adapt Google into the Azure-shaped fields; see
//! [`reverse_geocode`].

use cosmos_protocol::aibus as pb;
use cosmos_protocol::aibus::GeoLocateRequest;
use serde::Deserialize;
use serde_json::{self, json};

use super::{BackendError, http, key};

const KEY_VAR: &str = "COSMOS_GOOGLE_MAPS_KEY";
const DEFAULT_NEARBY_RADIUS_M: f64 = 1_000.0;

// --- places ---------------------------------------------------------------

#[derive(Deserialize)]
struct PlaceSearch {
    #[serde(default)]
    status: String,
    #[serde(default)]
    results: Vec<PlaceResult>,
}

#[derive(Deserialize)]
struct PlaceResult {
    #[serde(default)]
    name: String,
    #[serde(default)]
    formatted_address: String,
    #[serde(default)]
    vicinity: String,
    #[serde(default)]
    place_id: String,
    #[serde(default)]
    types: Vec<String>,
    #[serde(default)]
    rating: f32,
    #[serde(default)]
    user_ratings_total: i32,
    #[serde(default)]
    website: String,
    #[serde(default)]
    formatted_phone_number: String,
    opening_hours: Option<OpeningHours>,
    geometry: Option<Geometry>,
}

#[derive(Deserialize)]
struct OpeningHours {
    #[serde(default)]
    open_now: bool,
}

#[derive(Deserialize)]
struct Geometry {
    location: Option<LatLng>,
}

#[derive(Deserialize)]
struct LatLng {
    #[serde(default)]
    lat: f64,
    #[serde(default)]
    lng: f64,
}

/// Nearby/text place search, in cosmos's wire shape.
pub async fn nearby(
    text_query: &str,
    near: Option<(f64, f64)>,
    radius_m: f64,
) -> Result<Vec<pb::NearbyPlace>, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    let url = place_search_url(&api_key, text_query, near, radius_m)?;

    let body = http()
        .get(url)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .bytes()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    decode_nearby_response(&body)
}

pub(crate) fn decode_nearby_response(body: &[u8]) -> Result<Vec<pb::NearbyPlace>, BackendError> {
    let found: PlaceSearch = serde_json::from_slice(body).map_err(|_| BackendError::Unavailable)?;

    if found.status == "ZERO_RESULTS" {
        return Ok(Vec::new());
    }
    if found.status != "OK" {
        return Err(BackendError::Unavailable);
    }
    let places: Vec<_> = found.results.iter().map(to_place).collect();
    Ok(places)
}

fn place_search_url(
    api_key: &str,
    text_query: &str,
    near: Option<(f64, f64)>,
    radius_m: f64,
) -> Result<String, BackendError> {
    let query = text_query.trim();
    if query.is_empty() {
        let (lat, lng) = near.ok_or(BackendError::NoResult)?;
        let radius = if radius_m > 0.0 {
            radius_m
        } else {
            DEFAULT_NEARBY_RADIUS_M
        };
        return Ok(format!(
            "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location={lat},{lng}&radius={}&key={api_key}",
            radius.round() as i64,
        ));
    }

    let mut url = format!(
        "https://maps.googleapis.com/maps/api/place/textsearch/json?query={}&key={api_key}",
        encode(query),
    );
    if let Some((lat, lng)) = near {
        url.push_str(&format!("&location={lat},{lng}"));
        if radius_m > 0.0 {
            url.push_str(&format!("&radius={}", radius_m.round() as i64));
        }
    }
    Ok(url)
}

fn to_place(r: &PlaceResult) -> pb::NearbyPlace {
    pb::NearbyPlace {
        name: r.name.clone(),
        formatted_address: if r.formatted_address.is_empty() {
            r.vicinity.clone()
        } else {
            r.formatted_address.clone()
        },
        place_types: r.types.clone(),
        place_id: r.place_id.clone(),
        phone_number: r.formatted_phone_number.clone(),
        // Google's text search carries no editorial summary; leaving these empty
        // is correct — the device reads an absent description, not a fake one.
        place_description: String::new(),
        description_language: String::new(),
        website_url: r.website.clone(),
        rating: r.rating,
        user_ratings_total: r.user_ratings_total,
        location: r
            .geometry
            .as_ref()
            .and_then(|g| g.location.as_ref())
            .map(|l| pb::Location {
                latitude: l.lat,
                longitude: l.lng,
            }),
        open_now: r.opening_hours.as_ref().is_some_and(|h| h.open_now),
    }
}

// --- reverse geocoding ----------------------------------------------------

#[derive(Deserialize)]
struct GeocodeResponse {
    #[serde(default)]
    status: String,
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
/// a neighbouring field — a wrong city is worse than an absent one.
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
        return Err(BackendError::Unavailable);
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

#[derive(Deserialize)]
struct DirectionsResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    routes: Vec<DirectionRoute>,
}

#[derive(Deserialize)]
struct DirectionRoute {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    legs: Vec<DirectionLeg>,
}

#[derive(Deserialize)]
struct DirectionLeg {
    #[serde(default)]
    distance: DirectionDistance,
    #[serde(default)]
    duration: DirectionDuration,
    #[serde(default)]
    steps: Vec<DirectionStep>,
}

#[derive(Deserialize, Default)]
struct DirectionDistance {
    #[serde(default)]
    text: String,
    #[serde(default)]
    value: i32,
}

#[derive(Deserialize, Default)]
struct DirectionDuration {
    #[serde(default)]
    text: String,
    #[serde(default)]
    value: i32,
}

#[derive(Deserialize)]
struct DirectionStep {
    #[serde(default)]
    html_instructions: String,
    #[serde(default)]
    distance: DirectionDistance,
    #[serde(default)]
    duration: DirectionDuration,
    #[serde(default)]
    start_location: Option<GeoLocation>,
    #[serde(default)]
    end_location: Option<GeoLocation>,
    #[serde(default)]
    maneuver: Option<String>,
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

    let response: GeoLocateResponse = http()
        .post(format!(
            "https://www.googleapis.com/geolocation/v1/geolocate?key={api_key}"
        ))
        .json(&body)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
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

/// Resolve an origin point + destination to route steps.
pub async fn directions(
    latitude: f64,
    longitude: f64,
    destination: String,
) -> Result<pb::NavigationDirectionsResponse, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    if destination.trim().is_empty() {
        return Err(BackendError::NoResult);
    }
    let origin = format!("{latitude},{longitude}");
    let response: DirectionsResponse = http()
        .get(format!(
            "https://maps.googleapis.com/maps/api/directions/json?origin={origin}&destination={}&key={api_key}",
            encode(&destination),
        ))
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    if response.status != "OK" {
        return Err(BackendError::Unavailable);
    }
    let route = response
        .routes
        .into_iter()
        .next()
        .ok_or(BackendError::NoResult)?;
    let leg = route
        .legs
        .into_iter()
        .next()
        .ok_or(BackendError::NoResult)?;

    let steps = leg
        .steps
        .into_iter()
        .map(|step| pb::NavigationStep {
            instruction: step.html_instructions,
            distance: Some(pb::NavigationDistance {
                text: step.distance.text,
                value: step.distance.value,
            }),
            duration: Some(pb::NavigationDuration {
                text: step.duration.text,
                value: step.duration.value,
            }),
            start_location: step.start_location.map(|l| pb::Location {
                latitude: l.lat,
                longitude: l.lng,
            }),
            end_location: step.end_location.map(|l| pb::Location {
                latitude: l.lat,
                longitude: l.lng,
            }),
            maneuver: match step.maneuver.unwrap_or_default().as_str() {
                "turn-sharp-left" => pb::NavigationManeuver::NavigationActionTurnSharpLeft as i32,
                "turn-left" => pb::NavigationManeuver::NavigationActionTurnLeft as i32,
                "turn-slight-left" => pb::NavigationManeuver::NavigationActionTurnSlightLeft as i32,
                "turn-slight-right" => {
                    pb::NavigationManeuver::NavigationActionTurnSlightRight as i32
                }
                "turn-right" => pb::NavigationManeuver::NavigationActionTurnRight as i32,
                "merge" => pb::NavigationManeuver::NavigationActionMerge as i32,
                "uturn-left" => pb::NavigationManeuver::NavigationActionUturnLeft as i32,
                "uturn-right" => pb::NavigationManeuver::NavigationActionUturnRight as i32,
                "keep-right" => pb::NavigationManeuver::NavigationActionKeepRight as i32,
                "keep-left" => pb::NavigationManeuver::NavigationActionKeepLeft as i32,
                "ramp-left" => pb::NavigationManeuver::NavigationActionRampLeft as i32,
                "ramp-right" => pb::NavigationManeuver::NavigationActionRampRight as i32,
                "roundabout-left" => pb::NavigationManeuver::NavigationActionRoundaboutLeft as i32,
                "roundabout-right" => {
                    pb::NavigationManeuver::NavigationActionRoundaboutRight as i32
                }
                _ => pb::NavigationManeuver::NavigationActionUnspecified as i32,
            },
        })
        .collect();

    Ok(pb::NavigationDirectionsResponse {
        summary: route.summary,
        steps,
        total_distance: Some(pb::NavigationDistance {
            text: leg.distance.text,
            value: leg.distance.value,
        }),
        total_duration: Some(pb::NavigationDuration {
            text: leg.duration.text,
            value: leg.duration.value,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_components_map_onto_cosmos_azure_shaped_address() {
        let components = vec![
            AddressComponent {
                long_name: "422".into(),
                types: vec!["street_number".into()],
            },
            AddressComponent {
                long_name: "Larkin St".into(),
                types: vec!["route".into()],
            },
            AddressComponent {
                long_name: "San Francisco".into(),
                types: vec!["locality".into()],
            },
            AddressComponent {
                long_name: "California".into(),
                types: vec!["administrative_area_level_1".into()],
            },
            AddressComponent {
                long_name: "United States".into(),
                types: vec!["country".into()],
            },
            AddressComponent {
                long_name: "94102".into(),
                types: vec!["postal_code".into()],
            },
        ];
        let a = to_address(&components);
        assert_eq!(a.street_number, "422");
        assert_eq!(a.street_name, "Larkin St");
        assert_eq!(a.municipality, "San Francisco");
        assert_eq!(a.country_subdivision, "California");
        assert_eq!(a.country, "United States");
        assert_eq!(a.postal_code, "94102");
    }

    #[test]
    fn a_missing_component_stays_empty_rather_than_borrowing_a_neighbour() {
        // Google often returns no street_number for a transit stop. A wrong
        // address is worse for a wearer than an incomplete one.
        let components = vec![AddressComponent {
            long_name: "San Francisco".into(),
            types: vec!["locality".into()],
        }];
        let a = to_address(&components);
        assert_eq!(a.municipality, "San Francisco");
        assert_eq!(a.street_number, "");
        assert_eq!(a.country, "");
    }

    #[test]
    fn place_results_map_onto_the_wire_shape() {
        let r = PlaceResult {
            name: "Outta Sight Pizza".into(),
            formatted_address: "422 Larkin St, San Francisco, CA 94102, USA".into(),
            vicinity: "422 Larkin St".into(),
            place_id: "ChIJi2CdSa6BhYARP6xkfxOB8OA".into(),
            types: vec!["restaurant".into(), "food".into()],
            rating: 4.6,
            user_ratings_total: 724,
            website: String::new(),
            formatted_phone_number: String::new(),
            opening_hours: Some(OpeningHours { open_now: false }),
            geometry: Some(Geometry {
                location: Some(LatLng {
                    lat: 37.7818216,
                    lng: -122.4171258,
                }),
            }),
        };
        let p = to_place(&r);
        assert_eq!(p.name, "Outta Sight Pizza");
        assert_eq!(p.place_id, "ChIJi2CdSa6BhYARP6xkfxOB8OA");
        assert_eq!(p.user_ratings_total, 724);
        assert!(!p.open_now);
        assert_eq!(p.location.as_ref().map(|l| l.latitude), Some(37.7818216));
        // No editorial summary in this API — stays empty, never invented.
        assert_eq!(p.place_description, "");
    }

    #[test]
    fn generic_location_search_uses_google_nearby_search() {
        let url = place_search_url("test-key", "  ", Some((55.6761, 12.5683)), 1_000.0)
            .expect("generic nearby URL");
        assert_eq!(
            url,
            "https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=55.6761,12.5683&radius=1000&key=test-key",
        );
        assert!(!url.contains("query="));
    }

    #[test]
    fn named_location_search_still_uses_google_text_search() {
        let url = place_search_url(
            "test-key",
            "coffee & tea",
            Some((55.6761, 12.5683)),
            1_500.0,
        )
        .expect("text search URL");
        assert_eq!(
            url,
            "https://maps.googleapis.com/maps/api/place/textsearch/json?query=coffee+%26+tea&key=test-key&location=55.6761,12.5683&radius=1500",
        );
    }

    #[test]
    fn generic_search_requires_a_location() {
        assert_eq!(
            place_search_url("test-key", "", None, 1_000.0),
            Err(BackendError::NoResult),
        );
    }

    #[test]
    fn nearby_vicinity_fills_the_address_when_formatted_address_is_absent() {
        let r = PlaceResult {
            name: "The Lakes".into(),
            formatted_address: String::new(),
            vicinity: "Nørregade 6, København".into(),
            place_id: "place-id".into(),
            types: vec!["restaurant".into()],
            rating: 4.4,
            user_ratings_total: 100,
            website: String::new(),
            formatted_phone_number: String::new(),
            opening_hours: None,
            geometry: None,
        };
        assert_eq!(to_place(&r).formatted_address, "Nørregade 6, København");
    }

    #[test]
    fn query_encoding_is_safe_for_spaces_and_symbols() {
        assert_eq!(encode("sushi near me"), "sushi+near+me");
        assert_eq!(encode("caf&e"), "caf%26e");
    }

    #[tokio::test]
    async fn without_a_key_the_capability_reports_absent() {
        // SAFETY: single-threaded test scope.
        unsafe {
            std::env::remove_var(KEY_VAR);
        }
        assert_eq!(
            reverse_geocode(37.77, -122.41).await,
            Err(BackendError::NotConfigured)
        );
    }
}
