//! Nearby place search backed by the OpenStreetMap Overpass API.

use crate::{
    external::osm::{OsmClient, OsmError, OsmOptions, OVERPASS_QUERY_TIMEOUT_SECONDS},
    proto::aibus::{Location, NearbyPlace},
};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_NEARBY_RADIUS_METERS: f64 = 50_000.0;
const MAX_LOCAL_NODE_SCAN_RADIUS_METERS: f64 = 5_000.0;
const MAX_NEARBY_QUERY_BYTES: usize = 128;
const MAX_NEARBY_RESULTS: usize = 20;
const MAX_PROVIDER_CANDIDATES: usize = 100;
const MAX_PLACE_NAME_CHARS: usize = 256;
const MAX_PLACE_FIELD_CHARS: usize = 1_024;
const NEARBY_CACHE_MAX_ENTRIES: usize = 32;
const NEARBY_STALE_ON_ERROR_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone)]
pub struct NearbyClient {
    osm: OsmClient,
    cache: Arc<Mutex<HashMap<NearbyCacheKey, NearbyCacheEntry>>>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct NearbyCacheKey {
    latitude_millidegrees: i32,
    longitude_millidegrees: i32,
    radius_meters: u32,
    query: String,
}

#[derive(Clone)]
struct NearbyCacheEntry {
    stored_at: Instant,
    places: Vec<NearbyPlace>,
}

impl NearbyClient {
    pub fn new(http_client: reqwest::Client, options: OsmOptions) -> Self {
        Self {
            osm: OsmClient::new(http_client, options),
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Search for nearby places using the Overpass API.
    ///
    /// `query` is either a known category or a bounded local name/brand/operator
    /// lookup. Pass `""` to return common named places in the area.
    pub async fn search(
        &self,
        lat: f64,
        lon: f64,
        radius: f64,
        query: &str,
    ) -> Result<Vec<NearbyPlace>, OsmError> {
        let overpass_ql = build_overpass_query(lat, lon, radius, query)?;
        let cache_key = NearbyCacheKey::new(lat, lon, radius, query);

        let json = match self.osm.overpass(&overpass_ql).await {
            Ok(json) => json,
            Err(error) => {
                if let Some(places) = self.cached_places(&cache_key) {
                    tracing::warn!(
                        error_kind = error.kind(),
                        results = places.len(),
                        "serving bounded cached Nearby results after provider failure"
                    );
                    return Ok(places);
                }
                return Err(error);
            }
        };

        let elements = json
            .get("elements")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let places = elements
            .iter()
            .filter_map(osm_element_to_place)
            .collect::<Vec<_>>();
        let places = rank_and_limit_places(places, lat, lon);
        if !places.is_empty() {
            self.store_cached_places(cache_key, places.clone());
        }
        Ok(places)
    }

    fn cached_places(&self, key: &NearbyCacheKey) -> Option<Vec<NearbyPlace>> {
        let now = Instant::now();
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.retain(|_, entry| now.duration_since(entry.stored_at) <= NEARBY_STALE_ON_ERROR_TTL);
        cache.get(key).map(|entry| entry.places.clone())
    }

    fn store_cached_places(&self, key: NearbyCacheKey, places: Vec<NearbyPlace>) {
        let now = Instant::now();
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.retain(|_, entry| now.duration_since(entry.stored_at) <= NEARBY_STALE_ON_ERROR_TTL);
        if cache.len() >= NEARBY_CACHE_MAX_ENTRIES && !cache.contains_key(&key) {
            if let Some(oldest_key) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.stored_at)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(
            key,
            NearbyCacheEntry {
                stored_at: now,
                places,
            },
        );
    }
}

impl NearbyCacheKey {
    fn new(latitude: f64, longitude: f64, radius: f64, query: &str) -> Self {
        Self {
            // Roughly 111 m latitude buckets. Stock itself reuses Nearby data
            // while the user remains within 1 km, so this is conservative.
            latitude_millidegrees: (latitude * 1_000.0).round() as i32,
            longitude_millidegrees: (longitude * 1_000.0).round() as i32,
            radius_meters: radius.round().max(0.0) as u32,
            query: query.trim().to_ascii_lowercase(),
        }
    }
}

fn rank_and_limit_places(
    mut places: Vec<NearbyPlace>,
    latitude: f64,
    longitude: f64,
) -> Vec<NearbyPlace> {
    places.sort_by(|left, right| {
        place_distance_meters(left, latitude, longitude)
            .total_cmp(&place_distance_meters(right, latitude, longitude))
    });

    let mut seen = HashSet::new();
    places.retain(|place| seen.insert(place.place_id.clone()));
    places.truncate(MAX_NEARBY_RESULTS);
    places
}

fn build_overpass_query(lat: f64, lon: f64, radius: f64, query: &str) -> Result<String, OsmError> {
    if !lat.is_finite()
        || !lon.is_finite()
        || !radius.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
        || !(1.0..=MAX_NEARBY_RADIUS_METERS).contains(&radius)
    {
        return Err(OsmError::InvalidRequest("invalid nearby search geometry"));
    }
    if query.len() > MAX_NEARBY_QUERY_BYTES || query.chars().any(char::is_control) {
        return Err(OsmError::InvalidRequest("invalid nearby search query"));
    }

    if query.trim().is_empty() {
        return build_spatial_first_node_query(
            lat,
            lon,
            radius,
            &[
                local_presence_filter("amenity"),
                local_presence_filter("shop"),
                local_presence_filter("tourism"),
                local_presence_filter("leisure"),
            ],
        );
    }

    if let Some(category_query) = build_category_query(lat, lon, radius, query) {
        return Ok(category_query);
    }

    // A direct regex or exact-value selector can make Overpass plan against a
    // global tag index before applying `around`, which is slow even for a 1 km
    // search. Materialize the bounded local node set first, then apply a fully
    // escaped literal regex to that input set. This preserves case-insensitive
    // substring matching without exposing a provider-wide regex scan.
    let escaped = escape_overpass_regex(query.trim());
    build_spatial_first_node_query(
        lat,
        lon,
        radius,
        &[
            local_regex_filter("name", &escaped),
            local_regex_filter("brand", &escaped),
            local_regex_filter("operator", &escaped),
            local_regex_filter("cuisine", &escaped),
        ],
    )
}

/// Translate the stock Nearby menu vocabulary (plus common synonyms) into
/// semantic OSM tags. Matching only `name` made "restaurants nearby" return
/// almost nothing unless the venue literally contained “restaurant”.
fn build_category_query(lat: f64, lon: f64, radius: f64, query: &str) -> Option<String> {
    let normalized = query
        .trim()
        .trim_matches(|character: char| !character.is_alphanumeric())
        .to_ascii_lowercase();
    let normalized = normalized.as_str();

    let (selectors, includes_areas) = match normalized {
        "coffee" | "cafe" | "cafes" => (
            vec![
                exact_selector("node", "amenity", Some("cafe")),
                exact_selector("node", "shop", Some("coffee")),
            ],
            false,
        ),
        "restaurant" | "restaurants" | "food" => (
            exact_value_selectors(
                "node",
                "amenity",
                &["restaurant", "fast_food", "food_court"],
            ),
            false,
        ),
        "shopping" | "shop" | "shops" | "store" | "stores" => {
            (vec![exact_selector("node", "shop", None)], false)
        }
        "nature" => (
            vec![
                exact_selector("nwr", "leisure", Some("nature_reserve")),
                exact_selector("nwr", "leisure", Some("park")),
                exact_selector("nwr", "leisure", Some("garden")),
                exact_selector("nwr", "tourism", Some("viewpoint")),
            ],
            true,
        ),
        "grocery" | "groceries" | "supermarket" | "supermarkets" => (
            exact_value_selectors(
                "node",
                "shop",
                &[
                    "supermarket",
                    "convenience",
                    "greengrocer",
                    "grocery",
                    "deli",
                ],
            ),
            false,
        ),
        "bar" | "bars" | "pub" | "pubs" => (
            exact_value_selectors("node", "amenity", &["bar", "pub", "biergarten"]),
            false,
        ),
        "park" | "parks" => (
            exact_value_selectors(
                "nwr",
                "leisure",
                &["park", "garden", "nature_reserve", "playground"],
            ),
            true,
        ),
        "art" | "gallery" | "galleries" => (
            exact_value_selectors("nwr", "tourism", &["gallery", "artwork", "museum"]),
            true,
        ),
        "live music" | "music" | "music venue" | "music venues" => (
            vec![
                exact_selector("node", "amenity", Some("music_venue")),
                exact_selector("node", "amenity", Some("nightclub")),
                exact_selector("node", "live_music", Some("yes")),
            ],
            false,
        ),
        "theater" | "theaters" | "theatre" | "theatres" | "cinema" | "cinemas" => (
            exact_value_selectors("node", "amenity", &["theatre", "cinema"]),
            false,
        ),
        "attraction" | "attractions" | "sightseeing" => (
            exact_value_selectors(
                "nwr",
                "tourism",
                &["attraction", "museum", "viewpoint", "theme_park", "zoo"],
            ),
            true,
        ),
        "bookstore" | "bookstores" | "book shop" | "book shops" | "books" => {
            (vec![exact_selector("node", "shop", Some("books"))], false)
        }
        "public transit" | "transit" | "transport" | "station" | "stations" => (
            vec![
                exact_selector("node", "public_transport", Some("platform")),
                exact_selector("node", "public_transport", Some("station")),
                exact_selector("node", "public_transport", Some("stop_position")),
                exact_selector("node", "railway", Some("station")),
                exact_selector("node", "railway", Some("tram_stop")),
                exact_selector("node", "railway", Some("subway_entrance")),
                exact_selector("node", "highway", Some("bus_stop")),
                exact_selector("node", "amenity", Some("bus_station")),
            ],
            false,
        ),
        "historical site" | "historical sites" | "historic site" | "historic sites" | "history" => {
            (vec![exact_selector("nwr", "historic", None)], true)
        }
        "pharmacy" | "pharmacies" => (
            vec![exact_selector("node", "amenity", Some("pharmacy"))],
            false,
        ),
        "gas" | "gas station" | "gas stations" | "fuel" => {
            (vec![exact_selector("node", "amenity", Some("fuel"))], false)
        }
        "hospital" | "hospitals" | "clinic" | "clinics" | "doctor" | "doctors" => (
            exact_value_selectors("node", "amenity", &["hospital", "clinic", "doctors"]),
            false,
        ),
        "hotel" | "hotels" | "hostel" | "hostels" => (
            exact_value_selectors("node", "tourism", &["hotel", "hostel", "guest_house"]),
            false,
        ),
        _ => return None,
    };
    Some(build_exact_overpass_query(
        lat,
        lon,
        radius,
        &selectors,
        includes_areas,
    ))
}

fn exact_selector(scope: &str, key: &str, value: Option<&str>) -> String {
    match value {
        Some(value) if key == "name" => format!(r#"{scope}["name"="{value}"]"#),
        Some(value) => format!(r#"{scope}["name"]["{key}"="{value}"]"#),
        None => format!(r#"{scope}["name"]["{key}"]"#),
    }
}

fn exact_value_selectors(scope: &str, key: &str, values: &[&str]) -> Vec<String> {
    values
        .iter()
        .map(|value| exact_selector(scope, key, Some(value)))
        .collect()
}

fn build_exact_overpass_query(
    lat: f64,
    lon: f64,
    radius: f64,
    selectors: &[String],
    includes_areas: bool,
) -> String {
    let branches = selectors
        .iter()
        .map(|selector| format!("{selector}(around:{radius},{lat},{lon});"))
        .collect::<Vec<_>>()
        .join("\n");
    let selection = if selectors.len() == 1 {
        branches
    } else {
        format!("(\n{branches}\n);")
    };
    let output = if includes_areas {
        "out tags center qt"
    } else {
        "out body qt"
    };
    format!(
        "[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_SECONDS}];\n{selection}\n{output} {MAX_PROVIDER_CANDIDATES};"
    )
}

fn build_spatial_first_node_query(
    lat: f64,
    lon: f64,
    radius: f64,
    filters: &[String],
) -> Result<String, OsmError> {
    if radius > MAX_LOCAL_NODE_SCAN_RADIUS_METERS {
        return Err(OsmError::InvalidRequest(
            "nearby local scan radius is too large",
        ));
    }
    let branches = filters
        .iter()
        .map(|filter| format!("node.nearby{filter};"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_SECONDS}];\n\
node(around:{radius},{lat},{lon})->.nearby;\n\
(\n{branches}\n);\n\
out body qt {MAX_PROVIDER_CANDIDATES};"
    ))
}

fn local_presence_filter(key: &str) -> String {
    format!(r#"["name"]["{key}"]"#)
}

fn local_regex_filter(key: &str, escaped_literal: &str) -> String {
    if key == "name" {
        format!(r#"["name"~"{escaped_literal}",i]"#)
    } else {
        format!(r#"["name"]["{key}"~"{escaped_literal}",i]"#)
    }
}

/// Escape both Overpass quoted-string delimiters and every regex metacharacter
/// in a single pass. The resulting expression is always a literal substring.
fn escape_overpass_regex(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for character in input.chars() {
        if matches!(
            character,
            '\\' | '"'
                | '['
                | ']'
                | '('
                | ')'
                | '{'
                | '}'
                | '.'
                | '*'
                | '+'
                | '?'
                | '|'
                | '^'
                | '$'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// Convert a single Overpass JSON element to a `NearbyPlace`.
///
/// Returns `None` for elements that lack a name or usable coordinates.
fn osm_element_to_place(el: &serde_json::Value) -> Option<NearbyPlace> {
    let tags = el.get("tags")?;
    let name = bounded_string(tags.get("name")?.as_str()?, MAX_PLACE_NAME_CHARS)?;

    // Nodes contain lat/lon directly; ways contain center.lat / center.lon
    // (from the `out center` directive).
    let (place_lat, place_lon) = resolve_coordinates(el)?;

    let formatted_address = {
        let address = build_address(tags);
        if address.is_empty() {
            name.clone()
        } else {
            address
        }
    };
    let place_types = collect_place_types(tags);
    let description = pick_description(tags, &place_types);

    let osm_type = el.get("type").and_then(|v| v.as_str()).unwrap_or("node");
    let osm_id = el.get("id").and_then(|v| v.as_u64()).filter(|id| *id > 0)?;

    Some(NearbyPlace {
        name,
        formatted_address,
        place_types,
        place_id: format!("osm:{osm_type}/{osm_id}"),
        phone_number: tag_or(tags, &["phone", "contact:phone"]),
        place_description: description,
        description_language: String::new(),
        website_url: tag_or(tags, &["website", "contact:website"]),
        rating: -1.0,
        user_ratings_total: -1,
        location: Some(Location {
            latitude: place_lat,
            longitude: place_lon,
        }),
        open_now: false,
    })
}

fn place_distance_meters(place: &NearbyPlace, latitude: f64, longitude: f64) -> f64 {
    let Some(location) = place.location.as_ref() else {
        return f64::INFINITY;
    };
    haversine_distance_meters(latitude, longitude, location.latitude, location.longitude)
}

fn haversine_distance_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_METERS: f64 = 6_371_000.0;
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let delta_lat = lat2 - lat1;
    let delta_lon = (lon2 - lon1).to_radians();
    let a =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_METERS * a.sqrt().atan2((1.0 - a).sqrt())
}

fn resolve_coordinates(el: &serde_json::Value) -> Option<(f64, f64)> {
    let coordinates = if let (Some(lat), Some(lon)) = (
        el.get("lat").and_then(|v| v.as_f64()),
        el.get("lon").and_then(|v| v.as_f64()),
    ) {
        (lat, lon)
    } else {
        let center = el.get("center")?;
        (
            center.get("lat").and_then(|v| v.as_f64())?,
            center.get("lon").and_then(|v| v.as_f64())?,
        )
    };

    (coordinates.0.is_finite()
        && coordinates.1.is_finite()
        && (-90.0..=90.0).contains(&coordinates.0)
        && (-180.0..=180.0).contains(&coordinates.1))
    .then_some(coordinates)
}

fn build_address(tags: &serde_json::Value) -> String {
    let parts: Vec<&str> = [
        "addr:housenumber",
        "addr:street",
        "addr:city",
        "addr:state",
        "addr:postcode",
    ]
    .iter()
    .filter_map(|key| tags.get(*key).and_then(|v| v.as_str()))
    .collect();

    if parts.is_empty() {
        String::new()
    } else {
        bounded_string(&parts.join(", "), MAX_PLACE_FIELD_CHARS).unwrap_or_default()
    }
}

fn collect_place_types(tags: &serde_json::Value) -> Vec<String> {
    [
        "amenity",
        "shop",
        "tourism",
        "leisure",
        "historic",
        "public_transport",
        "railway",
        "highway",
    ]
    .iter()
    .filter_map(|key| {
        tags.get(*key)
            .and_then(|value| value.as_str())
            .and_then(|value| bounded_string(value, MAX_PLACE_FIELD_CHARS))
    })
    .collect()
}

fn pick_description(tags: &serde_json::Value, place_types: &[String]) -> String {
    tags.get("cuisine")
        .and_then(|v| v.as_str())
        .or_else(|| tags.get("description").and_then(|v| v.as_str()))
        .or_else(|| place_types.first().map(|s| s.as_str()))
        .and_then(|value| bounded_string(value, MAX_PLACE_FIELD_CHARS))
        .unwrap_or_default()
}

/// Return the first non-empty string value found for the given tag keys.
fn tag_or(tags: &serde_json::Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| tags.get(*k).and_then(|v| v.as_str()))
        .and_then(|value| bounded_string(value, MAX_PLACE_FIELD_CHARS))
        .unwrap_or_default()
}

fn bounded_string(value: &str, maximum_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > maximum_chars
        || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearby_query_validation_rejects_private_input_abuse() {
        assert!(build_overpass_query(55.0, 12.0, 1_000.0, "coffee").is_ok());
        assert!(build_overpass_query(91.0, 12.0, 1_000.0, "coffee").is_err());
        assert!(build_overpass_query(55.0, 12.0, 0.0, "coffee").is_err());
        assert!(build_overpass_query(55.0, 12.0, 1_000.0, "bad\nquery").is_err());
        assert!(
            build_overpass_query(55.0, 12.0, 1_000.0, &"x".repeat(MAX_NEARBY_QUERY_BYTES + 1))
                .is_err()
        );
        assert!(build_overpass_query(55.0, 12.0, 5_001.0, "").is_err());
        assert!(build_overpass_query(55.0, 12.0, 5_001.0, "starbucks").is_err());
        assert!(build_overpass_query(55.0, 12.0, 50_000.0, "coffee").is_ok());
    }

    #[test]
    fn arbitrary_named_venue_queries_filter_one_bounded_local_node_set() {
        let query = build_overpass_query(55.0, 12.0, 1_000.0, "starbucks").unwrap();

        assert!(query.contains("node(around:1000,55,12)->.nearby;"));
        assert!(query.contains(r#"node.nearby["name"~"starbucks",i]"#));
        assert!(query.contains(r#"node.nearby["name"]["brand"~"starbucks",i]"#));
        assert!(query.contains(r#"node.nearby["name"]["operator"~"starbucks",i]"#));
        assert!(query.contains(r#"node.nearby["name"]["cuisine"~"starbucks",i]"#));
        assert_eq!(query.matches("(around:").count(), 1);
        assert!(!query.contains(r#"["name"~"starbucks",i](around:"#));
        assert!(query.contains("out body qt 100;"));
    }

    #[test]
    fn local_venue_regex_escapes_delimiters_and_metacharacters() {
        let query = build_overpass_query(55.0, 12.0, 1_000.0, r#"a"b\c.*[d]"#).unwrap();

        assert!(query.contains(r#"["name"~"a\"b\\c\.\*\[d\]",i]"#));
        assert_eq!(query.matches("(around:").count(), 1);
        assert!(query.contains("[timeout:10]"));
        assert!(query.contains("out body qt 100;"));
    }

    #[test]
    fn generic_nearby_query_filters_one_bounded_local_node_set() {
        let query = build_overpass_query(55.0, 12.0, 1_000.0, "").unwrap();

        assert!(query.contains("node(around:1000,55,12)->.nearby;"));
        for key in ["amenity", "shop", "tourism", "leisure"] {
            assert!(
                query.contains(&format!(r#"node.nearby["name"]["{key}"]"#)),
                "missing local {key} filter: {query}"
            );
        }
        assert_eq!(query.matches("(around:").count(), 1);
        assert!(!query.contains('~'));
        assert!(!query.contains("way["));
        assert!(!query.contains("nwr["));
        assert!(query.contains("out body qt 100;"));
    }

    #[test]
    fn all_known_categories_avoid_wildcard_and_value_regex_scans() {
        for category in [
            "coffee",
            "restaurants",
            "shopping",
            "nature",
            "groceries",
            "bars",
            "parks",
            "art",
            "live music",
            "theaters",
            "attractions",
            "bookstores",
            "public transit",
            "historical sites",
            "pharmacies",
            "gas stations",
            "hospitals",
            "hotels",
        ] {
            let query = build_overpass_query(55.0, 12.0, 1_000.0, category).unwrap();
            assert!(
                !query.contains("[~"),
                "wildcard key regex for {category}: {query}"
            );
            assert!(!query.contains('~'), "value regex for {category}: {query}");
            assert!(
                query.contains("qt 100;"),
                "unbounded output for {category}: {query}"
            );
        }
    }

    #[test]
    fn stock_launcher_categories_use_semantic_tag_filters() {
        let expected = [
            ("coffee", r#"["amenity"="cafe"]"#),
            ("restaurants", r#"["amenity"="fast_food"]"#),
            ("shopping", r#"["shop"]"#),
            ("nature", r#"["leisure"="nature_reserve"]"#),
            ("groceries", r#"["shop"="supermarket"]"#),
            ("bars", r#"["amenity"="pub"]"#),
            ("parks", r#"["leisure"="garden"]"#),
            ("art", r#"["tourism"="artwork"]"#),
            ("live music", r#"["live_music"="yes"]"#),
            ("theaters", r#"["amenity"="cinema"]"#),
            ("attractions", r#"["tourism"="attraction"]"#),
            ("bookstores", r#"["shop"="books"]"#),
            ("public transit", r#"["public_transport"="platform"]"#),
            ("historical sites", r#"["historic"]"#),
        ];

        for (category, selector_fragment) in expected {
            let query = build_overpass_query(55.0, 12.0, 1_000.0, category).unwrap();
            assert!(
                query.contains(selector_fragment),
                "{category} did not use {selector_fragment}: {query}"
            );
            assert!(!query.contains(&format!(r#"["name"~"{category}""#)));
        }
    }

    #[test]
    fn area_categories_use_scoped_nwr_queries_while_point_categories_stay_node_only() {
        for category in ["parks", "nature", "art", "historical sites"] {
            let query = build_overpass_query(55.0, 12.0, 1_000.0, category).unwrap();
            assert!(query.contains("nwr[\"name\"]"), "{category}: {query}");
            assert!(query.contains("out tags center qt 100;"));
        }

        let attractions = build_overpass_query(55.0, 12.0, 1_000.0, "attractions").unwrap();
        assert_eq!(attractions.matches("nwr[\"name\"]").count(), 5);
        assert!(attractions.contains(r#"["tourism"="museum"]"#));
        assert!(!attractions.contains("attraction|museum"));
        assert!(attractions.contains("out tags center qt 100;"));

        for category in ["coffee", "restaurants", "shopping", "public transit"] {
            let query = build_overpass_query(55.0, 12.0, 1_000.0, category).unwrap();
            assert!(query.contains("node[\"name\"]"), "{category}: {query}");
            assert!(!query.contains("nwr["));
            assert!(query.contains("out body qt 100;"));
        }
    }

    #[test]
    fn candidates_are_distance_ranked_and_deduplicated_before_limit() {
        fn place(id: &str, latitude: f64) -> NearbyPlace {
            NearbyPlace {
                name: id.to_string(),
                place_id: id.to_string(),
                location: Some(Location {
                    latitude,
                    longitude: 12.0,
                }),
                ..Default::default()
            }
        }

        let mut candidates = vec![
            place("far", 55.02),
            place("nearest", 55.001),
            place("middle", 55.01),
            place("nearest", 55.03),
        ];
        for index in 0..MAX_NEARBY_RESULTS {
            candidates.push(place(
                &format!("extra-{index}"),
                55.04 + index as f64 / 1000.0,
            ));
        }

        let ranked = rank_and_limit_places(candidates, 55.0, 12.0);
        assert_eq!(ranked.len(), MAX_NEARBY_RESULTS);
        assert_eq!(ranked[0].place_id, "nearest");
        assert_eq!(ranked[1].place_id, "middle");
        assert_eq!(ranked[2].place_id, "far");
        assert_eq!(
            ranked
                .iter()
                .filter(|place| place.place_id == "nearest")
                .count(),
            1
        );
    }

    #[test]
    fn provider_strings_are_bounded() {
        assert_eq!(bounded_string(" cafe ", 8).as_deref(), Some("cafe"));
        assert!(bounded_string(&"x".repeat(9), 8).is_none());
        assert!(bounded_string("bad\nvalue", 32).is_none());
    }

    #[test]
    fn malformed_provider_coordinates_are_dropped() {
        let invalid_node = serde_json::json!({
            "type": "node",
            "id": 1,
            "lat": 91.0,
            "lon": 12.0,
            "tags": { "name": "Invalid" }
        });
        let invalid_way = serde_json::json!({
            "type": "way",
            "id": 2,
            "center": { "lat": 55.0, "lon": -181.0 },
            "tags": { "name": "Invalid" }
        });

        assert!(osm_element_to_place(&invalid_node).is_none());
        assert!(osm_element_to_place(&invalid_way).is_none());
    }

    #[test]
    fn way_and_relation_centers_produce_typed_places() {
        for (osm_type, id) in [("way", 20), ("relation", 30)] {
            let element = serde_json::json!({
                "type": osm_type,
                "id": id,
                "center": { "lat": 55.0, "lon": 12.0 },
                "tags": { "name": "Historic Place", "historic": "monument" }
            });

            let place = osm_element_to_place(&element).expect("center should be usable");
            assert_eq!(place.place_id, format!("osm:{osm_type}/{id}"));
            assert_eq!(place.place_types, vec!["monument"]);
            assert_eq!(place.place_description, "monument");
        }
    }

    #[test]
    fn malformed_provider_place_types_are_omitted() {
        let element = serde_json::json!({
            "type": "node",
            "id": 3,
            "lat": 55.0,
            "lon": 12.0,
            "tags": {
                "name": "Cafe",
                "amenity": "x".repeat(MAX_PLACE_FIELD_CHARS + 1),
                "shop": "coffee"
            }
        });

        let place = osm_element_to_place(&element).expect("valid place");
        assert_eq!(place.place_types, vec!["coffee"]);
        assert_eq!(place.place_description, "coffee");
        assert_eq!(place.formatted_address, "Cafe");
        assert_eq!(place.rating, -1.0);
        assert_eq!(place.user_ratings_total, -1);
        assert!(place.description_language.is_empty());
    }

    #[test]
    fn missing_or_zero_provider_ids_are_rejected() {
        for element in [
            serde_json::json!({
                "type": "node",
                "lat": 55.0,
                "lon": 12.0,
                "tags": {"name": "Missing id"}
            }),
            serde_json::json!({
                "type": "node",
                "id": 0,
                "lat": 55.0,
                "lon": 12.0,
                "tags": {"name": "Zero id"}
            }),
        ] {
            assert!(osm_element_to_place(&element).is_none());
        }
    }

    #[test]
    fn nearby_cache_is_shared_across_clones_and_scoped_to_coarse_location_and_query() {
        let client = NearbyClient::new(reqwest::Client::new(), OsmOptions::new(true, true));
        let clone = client.clone();
        let key = NearbyCacheKey::new(55.0001, 12.0001, 1_000.0, "Coffee");
        client.store_cached_places(
            key,
            vec![NearbyPlace {
                name: "Cached Cafe".into(),
                place_id: "osm:node/42".into(),
                ..Default::default()
            }],
        );

        let equivalent = NearbyCacheKey::new(55.00009, 12.00009, 1_000.0, " coffee ");
        assert_eq!(
            clone.cached_places(&equivalent).unwrap()[0].name,
            "Cached Cafe"
        );
        assert!(clone
            .cached_places(&NearbyCacheKey::new(55.01, 12.01, 1_000.0, "coffee"))
            .is_none());
        assert!(clone
            .cached_places(&NearbyCacheKey::new(55.0001, 12.0001, 1_000.0, "parks"))
            .is_none());
    }
}
