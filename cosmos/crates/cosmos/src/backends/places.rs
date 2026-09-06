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
use serde::{Deserialize, Serialize};
use serde_json::{self, json};

use super::lookup::{
    LookupError, LookupProvider, LookupProviderIdentity, LookupQuery, bounded_body,
    get_payload_digest, lookup_endpoint, lookup_http, lookup_response_privacy,
};
use super::{BackendError, http, key};

const KEY_VAR: &str = "COSMOS_GOOGLE_MAPS_KEY";
const DEFAULT_NEARBY_RADIUS_M: f64 = 1_000.0;
const LOOKUP_ENDPOINT: &str = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const MAX_LOOKUP_PLACES: usize = 4;
const MAX_ATTRIBUTIONS: usize = 16;
const MAX_ATTRIBUTION_BYTES: usize = 2048;

/// Actual provider identities and content. No missing ratings, hours or contact
/// data are synthesized. A source URL is present only if the provider supplied it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LookupPlace {
    pub place_id: String,
    pub name: String,
    pub address: String,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

/// Transient service evidence, not a durable text action or model context.
/// Attribution HTML is preserved as untrusted data; no caller may execute it or
/// silently omit required attribution. A compliant transient renderer is separate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupEvidence {
    pub places: Vec<LookupPlace>,
    pub html_attributions: Vec<String>,
    pub privacy_floor: crate::ambiance::PrivacyClass,
}

/// Private immutable request snapshot. Preparing is network-free; execute may
/// run only after the runtime commits a matching Places disclosure. No Debug,
/// Clone or Serialize implementation can expose its credential-bearing URL.
pub struct PreparedLookup {
    identity: LookupProviderIdentity,
    query: LookupQuery,
    query_digest: String,
    payload_digest: String,
    url: reqwest::Url,
}

impl PreparedLookup {
    pub fn identity(&self) -> &LookupProviderIdentity {
        &self.identity
    }
    pub fn query(&self) -> &str {
        self.query.as_str()
    }
    pub fn query_digest(&self) -> &str {
        &self.query_digest
    }
    pub fn payload_digest(&self) -> &str {
        &self.payload_digest
    }

    pub async fn execute(self) -> Result<LookupEvidence, LookupError> {
        let response = lookup_http()?
            .get(self.url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| LookupError::Unavailable)?;
        if !response.status().is_success() {
            return Err(LookupError::Unavailable);
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next());
        if !content_type.is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
        {
            return Err(LookupError::Malformed);
        }
        let body = bounded_body(response).await?;
        let privacy_floor = lookup_response_privacy(&body)?;
        let response: LookupResponse =
            serde_json::from_slice(&body).map_err(|_| LookupError::Malformed)?;
        let mut html_attributions = Vec::new();
        append_attributions(response.html_attributions.as_ref(), &mut html_attributions)?;
        let rows = match response.status.as_str() {
            "OK" | "ZERO_RESULTS" => response.results.ok_or(LookupError::Malformed)?,
            "REQUEST_DENIED" | "OVER_QUERY_LIMIT" | "UNKNOWN_ERROR" | "INVALID_REQUEST" => {
                return Err(LookupError::Unavailable);
            }
            _ => return Err(LookupError::Malformed),
        };
        if response.status == "ZERO_RESULTS" {
            if !rows.is_empty() {
                return Err(LookupError::Malformed);
            }
            return Ok(LookupEvidence {
                places: Vec::new(),
                html_attributions,
                privacy_floor,
            });
        }
        let mut places = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for row in rows {
            append_attributions(row.html_attributions.as_ref(), &mut html_attributions)?;
            if places.len() == MAX_LOOKUP_PLACES {
                continue;
            }
            let Ok(raw) =
                serde_json::from_value::<LookupPlaceResponse>(serde_json::Value::Object(row.place))
            else {
                continue;
            };
            let Some(place) = checked_lookup_place(raw) else {
                continue;
            };
            if seen.insert(place.place_id.clone()) {
                places.push(place);
            }
        }
        if places.is_empty() {
            return Err(LookupError::Malformed);
        }
        Ok(LookupEvidence {
            places,
            html_attributions,
            privacy_floor,
        })
    }
}

#[derive(Deserialize)]
struct LookupResponse {
    status: String,
    results: Option<Vec<LookupRow>>,
    html_attributions: Option<serde_json::Value>,
}

/// Attribution is a known field so duplicate entries are rejected during the
/// complete response decode, before a row limit can discard required credit.
#[derive(Deserialize)]
struct LookupRow {
    html_attributions: Option<serde_json::Value>,
    #[serde(flatten)]
    place: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct LookupPlaceResponse {
    place_id: String,
    name: String,
    formatted_address: String,
    geometry: LookupGeometry,
    url: Option<String>,
}

#[derive(Deserialize)]
struct LookupGeometry {
    location: LookupCoordinates,
}

#[derive(Deserialize)]
struct LookupCoordinates {
    lat: f64,
    lng: f64,
}

fn checked_lookup_place(raw: LookupPlaceResponse) -> Option<LookupPlace> {
    fn text(value: &str, maximum: usize) -> bool {
        !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
    }
    if !text(&raw.place_id, 1024)
        || raw.place_id.chars().any(char::is_whitespace)
        || !text(&raw.name, 256)
        || !text(&raw.formatted_address, 512)
        || !raw.geometry.location.lat.is_finite()
        || !(-90.0..=90.0).contains(&raw.geometry.location.lat)
        || !raw.geometry.location.lng.is_finite()
        || !(-180.0..=180.0).contains(&raw.geometry.location.lng)
    {
        return None;
    }
    let source_url = match raw.url {
        None => None,
        Some(value) => {
            if value.len() > 2048
                || value.chars().any(|c| c.is_whitespace() || c.is_control())
                || value.contains('\\')
            {
                return None;
            }
            let parsed = reqwest::Url::parse(&value).ok()?;
            if parsed.scheme() != "https"
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.port().is_some()
                || !matches!(
                    parsed.host_str(),
                    Some("maps.google.com" | "www.google.com")
                )
                || (parsed.host_str() == Some("www.google.com")
                    && parsed.path() != "/maps"
                    && !parsed.path().starts_with("/maps/"))
            {
                return None;
            }
            Some(value)
        }
    };
    Some(LookupPlace {
        place_id: raw.place_id,
        name: raw.name,
        address: raw.formatted_address,
        latitude: raw.geometry.location.lat,
        longitude: raw.geometry.location.lng,
        source_url,
    })
}

fn append_attributions(
    value: Option<&serde_json::Value>,
    output: &mut Vec<String>,
) -> Result<(), LookupError> {
    let Some(value) = value else {
        return Ok(());
    };
    let entries = value.as_array().ok_or(LookupError::Malformed)?;
    if entries.len() > MAX_ATTRIBUTIONS {
        return Err(LookupError::Oversized);
    }
    for entry in entries {
        let text = entry.as_str().ok_or(LookupError::Malformed)?;
        if text.len() > MAX_ATTRIBUTION_BYTES {
            return Err(LookupError::Oversized);
        }
        if !output.iter().any(|existing| existing == text) {
            if output.len() == MAX_ATTRIBUTIONS {
                return Err(LookupError::Oversized);
            }
            output.push(text.to_owned());
        }
    }
    Ok(())
}

pub fn lookup_providers() -> Vec<LookupProviderIdentity> {
    lookup_providers_from(
        &crate::integrations::active().snapshot().maps,
        LOOKUP_ENDPOINT,
    )
}

pub fn prepare_lookup(
    identity: &LookupProviderIdentity,
    query: LookupQuery,
) -> Result<PreparedLookup, LookupError> {
    prepare_lookup_from(
        identity,
        query,
        &crate::integrations::active().snapshot().maps,
        LOOKUP_ENDPOINT,
    )
}

#[cfg(test)]
pub(crate) fn lookup_providers_for_test(
    config: &crate::integrations::MapsConfig,
    endpoint: &str,
) -> Vec<LookupProviderIdentity> {
    lookup_providers_from(config, endpoint)
}

#[cfg(test)]
pub(crate) fn prepare_lookup_for_test(
    identity: &LookupProviderIdentity,
    query: LookupQuery,
    config: &crate::integrations::MapsConfig,
    endpoint: &str,
) -> Result<PreparedLookup, LookupError> {
    prepare_lookup_from(identity, query, config, endpoint)
}

fn lookup_providers_from(
    config: &crate::integrations::MapsConfig,
    endpoint: &str,
) -> Vec<LookupProviderIdentity> {
    if config
        .google_maps_key
        .as_deref()
        .is_none_or(|key| key.trim().is_empty())
        || lookup_endpoint(endpoint).is_err()
    {
        return Vec::new();
    }
    vec![LookupProviderIdentity {
        provider: LookupProvider::GooglePlaces,
        endpoint: endpoint.to_owned(),
        configuration_digest: lookup_configuration_digest(endpoint),
    }]
}

pub(super) fn lookup_configuration_digest(endpoint: &str) -> String {
    let profile = json!([
        "cosmos.places-lookup",
        1,
        LookupProvider::GooglePlaces,
        endpoint,
        "GET",
        "query"
    ]);
    crate::surface_registry::hash(profile.to_string().as_bytes())
}

fn prepare_lookup_from(
    identity: &LookupProviderIdentity,
    query: LookupQuery,
    config: &crate::integrations::MapsConfig,
    endpoint: &str,
) -> Result<PreparedLookup, LookupError> {
    if identity.provider != LookupProvider::GooglePlaces || !identity.valid() {
        return Err(LookupError::InvalidProvider);
    }
    let current = lookup_providers_from(config, endpoint)
        .pop()
        .ok_or(LookupError::NotConfigured)?;
    if &current != identity {
        return Err(LookupError::StaleProvider);
    }
    let mut url = lookup_endpoint(endpoint)?;
    url.query_pairs_mut().append_pair("query", query.as_str());
    let query_digest = crate::surface_registry::hash(query.as_str().as_bytes());
    let payload_digest = get_payload_digest(&url);
    url.query_pairs_mut().append_pair(
        "key",
        config
            .google_maps_key
            .as_deref()
            .ok_or(LookupError::NotConfigured)?,
    );
    Ok(PreparedLookup {
        identity: current,
        query,
        query_digest,
        payload_digest,
        url,
    })
}

#[cfg(test)]
mod lookup_tests {
    use super::*;
    use crate::backends::lookup::{LookupService, MAX_RESPONSE_BYTES};
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    fn config() -> crate::integrations::MapsConfig {
        crate::integrations::MapsConfig {
            google_maps_key: Some("synthetic-places-key".into()),
        }
    }

    fn row(id: &str) -> serde_json::Value {
        json!({"place_id":id,"name":"Named restaurant","formatted_address":"Example street 1, Copenhagen",
            "geometry":{"location":{"lat":55.6761,"lng":12.5683}}})
    }

    async fn serve(
        status: &str,
        body: String,
        location: Option<String>,
    ) -> (String, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/maps/api/place/textsearch/json",
            listener.local_addr().unwrap()
        );
        let status = status.to_owned();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut chunk = [0; 1024];
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                assert!(request.len() + count <= 8192);
                request.extend_from_slice(&chunk[..count]);
            }
            let _ = sender.send(String::from_utf8(request).unwrap());
            let location = location
                .map(|url| format!("Location: {url}\r\n"))
                .unwrap_or_default();
            let reply = format!(
                "HTTP/1.1 {status}\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
        });
        (endpoint, receiver)
    }

    async fn execute(body: String) -> Result<LookupEvidence, LookupError> {
        let (endpoint, request) = serve("200 OK", body, None).await;
        let provider = lookup_providers_for_test(&config(), &endpoint).remove(0);
        let prepared = prepare_lookup_for_test(
            &provider,
            LookupQuery::new("Named restaurant Copenhagen").unwrap(),
            &config(),
            &endpoint,
        )
        .unwrap();
        let result = prepared.execute().await;
        assert!(
            request
                .await
                .unwrap()
                .starts_with("GET /maps/api/place/textsearch/json?")
        );
        result
    }

    #[tokio::test]
    async fn ambiance_places_exact_named_query_excludes_location_and_credentials_from_digests() {
        let attribution = r#"<a href="https://example.org/attribution">Provider attribution</a>"#;
        let mut place = row("actual-place-id");
        place["url"] = json!("https://maps.google.com/?cid=123");
        let (endpoint, request) = serve(
            "200 OK",
            json!({"status":"OK","results":[place],"html_attributions":[attribution]}).to_string(),
            None,
        )
        .await;
        let provider = lookup_providers_for_test(&config(), &endpoint).remove(0);
        assert_eq!(provider.provider.service(), LookupService::Places);
        assert!(provider.valid());
        let prepared = prepare_lookup_for_test(
            &provider,
            LookupQuery::new(" Named\nrestaurant Copenhagen ").unwrap(),
            &config(),
            &endpoint,
        )
        .unwrap();
        assert_eq!(prepared.query(), "Named restaurant Copenhagen");
        assert_eq!(
            prepared.query_digest(),
            crate::surface_registry::hash(b"Named restaurant Copenhagen")
        );
        let digest = prepared.payload_digest().to_owned();
        let mut rotated = config();
        rotated.google_maps_key = Some("rotated-places-key".into());
        let other = prepare_lookup_for_test(
            &provider,
            LookupQuery::new("Named restaurant Copenhagen").unwrap(),
            &rotated,
            &endpoint,
        )
        .unwrap();
        assert_eq!(other.payload_digest(), digest);
        let evidence = prepared.execute().await.unwrap();
        assert_eq!(evidence.places.len(), 1);
        assert_eq!(evidence.places[0].place_id, "actual-place-id");
        assert_eq!(evidence.places[0].latitude, 55.6761);
        assert_eq!(evidence.places[0].longitude, 12.5683);
        assert_eq!(
            evidence.places[0].source_url.as_deref(),
            Some("https://maps.google.com/?cid=123")
        );
        assert_eq!(evidence.html_attributions, [attribution]);
        let serialized = serde_json::to_value(&evidence.places[0]).unwrap();
        assert!(serialized.get("rating").is_none() && serialized.get("open_now").is_none());
        let request = request.await.unwrap();
        let target = request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let mut actual = reqwest::Url::parse(&endpoint)
            .unwrap()
            .join(target)
            .unwrap();
        let parameters: std::collections::BTreeMap<_, _> =
            actual.query_pairs().into_owned().collect();
        assert_eq!(parameters.len(), 2);
        assert_eq!(parameters["query"], "Named restaurant Copenhagen");
        assert_eq!(parameters["key"], "synthetic-places-key");
        actual.set_query(None);
        actual
            .query_pairs_mut()
            .append_pair("query", &parameters["query"]);
        assert_eq!(digest, get_payload_digest(&actual));
        assert!(
            !serde_json::to_string(&provider)
                .unwrap()
                .contains("synthetic-places-key")
        );
    }

    #[tokio::test]
    async fn ambiance_places_preserves_privacy_before_invalid_rows_and_attribution_projection() {
        let mut rows: Vec<_> = (0..4).map(|i| row(&format!("place-{i}"))).collect();
        rows.push(json!({"place_id":"ignored","name":"password","geometry":{"location":{"lat":99,"lng":12}},"html_attributions":["Fifth row credit"]}));
        let body = json!({"status":"OK","results":rows,"html_attributions":["Attribution"]})
            .to_string()
            .replace("password", "\\u0070assword");
        let evidence = execute(body).await.unwrap();
        assert_eq!(evidence.places.len(), 4);
        assert_eq!(
            evidence.html_attributions,
            ["Attribution", "Fifth row credit"]
        );
        assert_eq!(
            evidence.privacy_floor,
            crate::ambiance::PrivacyClass::Sensitive
        );
        assert!(
            evidence
                .places
                .iter()
                .all(|place| place.source_url.is_none())
        );
        let empty = execute(r#"{"status":"ZERO_RESULTS","results":[],"ignored":"\u0070assword","ignored":"ordinary","html_attributions":["Attribution"]}"#.into()).await.unwrap();
        assert!(empty.places.is_empty());
        assert_eq!(
            empty.privacy_floor,
            crate::ambiance::PrivacyClass::Sensitive
        );
        assert_eq!(empty.html_attributions, ["Attribution"]);
    }

    #[tokio::test]
    async fn ambiance_places_duplicate_row_attribution_is_rejected_even_beyond_result_cap() {
        for preceding in [0, MAX_LOOKUP_PLACES] {
            let mut rows: Vec<_> = (0..preceding)
                .map(|index| row(&format!("place-{index}")).to_string())
                .collect();
            let duplicate = row("duplicate-attribution").to_string();
            rows.push(format!(
                "{},\"html_attributions\":[\"Required credit\"],\"html_attributions\":[],\"ignored\":\"\\u0070assword\"}}",
                duplicate.strip_suffix('}').unwrap(),
            ));
            let body = format!("{{\"status\":\"OK\",\"results\":[{}]}}", rows.join(","));
            assert_eq!(execute(body).await, Err(LookupError::Malformed));
        }
    }

    #[tokio::test]
    async fn ambiance_places_invalid_nonempty_content_is_not_empty_success() {
        let mut missing = row("missing-coordinate");
        missing["geometry"]["location"]
            .as_object_mut()
            .unwrap()
            .remove("lat");
        let mut outside = row("outside-range");
        outside["geometry"]["location"]["lng"] = json!(181);
        let mut oversized_id = row(&"x".repeat(1025));
        oversized_id["name"] = json!("Existing name");
        let mut false_source = row("wrong-source");
        false_source["url"] = json!("https://other.example/source");
        for invalid in [missing, outside, oversized_id, false_source, json!({})] {
            assert_eq!(
                execute(json!({"status":"OK","results":[invalid]}).to_string()).await,
                Err(LookupError::Malformed)
            );
        }
        for body in [
            r#"{"status":"OK","results":[]}"#,
            r#"{"status":"ZERO_RESULTS","results":[{}]}"#,
            r#"{"status":"OK"}"#,
            r#"{"status":"OK","results":[],"html_attributions":null}"#,
            "{}",
        ] {
            assert_eq!(execute(body.into()).await, Err(LookupError::Malformed));
        }
        assert_eq!(
            execute(r#"{"status":"REQUEST_DENIED","error_message":"Not enabled"}"#.into()).await,
            Err(LookupError::Unavailable)
        );
    }

    #[tokio::test]
    async fn ambiance_places_redirects_never_disclose_to_a_second_endpoint() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        for status in [
            "301 Moved",
            "302 Found",
            "303 Other",
            "307 Temporary",
            "308 Permanent",
        ] {
            let (endpoint, request) = serve(
                status,
                String::new(),
                Some(format!(
                    "http://{}/must-not-receive-query",
                    target.local_addr().unwrap()
                )),
            )
            .await;
            let provider = lookup_providers_for_test(&config(), &endpoint).remove(0);
            let prepared = prepare_lookup_for_test(
                &provider,
                LookupQuery::new("Named place").unwrap(),
                &config(),
                &endpoint,
            )
            .unwrap();
            assert_eq!(prepared.execute().await, Err(LookupError::Unavailable));
            assert!(request.await.unwrap().contains("query=Named+place"));
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn ambiance_places_stale_identity_and_missing_configuration_make_no_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/textsearch", listener.local_addr().unwrap());
        let provider = lookup_providers_for_test(&config(), &endpoint).remove(0);
        assert_eq!(
            prepare_lookup_for_test(
                &provider,
                LookupQuery::new("Named place").unwrap(),
                &config(),
                &format!("{endpoint}/changed")
            )
            .err(),
            Some(LookupError::StaleProvider)
        );
        assert_eq!(
            prepare_lookup_for_test(
                &provider,
                LookupQuery::new("Named place").unwrap(),
                &crate::integrations::MapsConfig::default(),
                &endpoint
            )
            .err(),
            Some(LookupError::NotConfigured)
        );
        let web =
            super::super::search::lookup_providers_for_test(&crate::integrations::SearchConfig {
                searxng_base_url: Some("https://search.example".into()),
                ..Default::default()
            })
            .remove(0);
        assert_eq!(
            prepare_lookup_for_test(
                &web,
                LookupQuery::new("Named place").unwrap(),
                &config(),
                &endpoint
            )
            .err(),
            Some(LookupError::InvalidProvider)
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn ambiance_places_response_and_attributions_are_bounded_without_dropping_credit() {
        assert_eq!(execute(json!({"status":"ZERO_RESULTS","results":[],"padding":"x".repeat(MAX_RESPONSE_BYTES)}).to_string()).await, Err(LookupError::Oversized));
        assert_eq!(execute(json!({"status":"OK","results":[row("place")],"html_attributions":["x".repeat(MAX_ATTRIBUTION_BYTES+1)]}).to_string()).await, Err(LookupError::Oversized));
        assert_eq!(
            execute(
                json!({"status":"OK","results":[row("place")],"html_attributions":[17]})
                    .to_string()
            )
            .await,
            Err(LookupError::Malformed)
        );
    }
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectionsMode {
    Driving,
    Walking,
    Bicycling,
}

impl DirectionsMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "driving" => Some(Self::Driving),
            "walking" => Some(Self::Walking),
            "bicycling" | "cycling" => Some(Self::Bicycling),
            _ => None,
        }
    }

    fn as_google_value(self) -> &'static str {
        match self {
            Self::Driving => "driving",
            Self::Walking => "walking",
            Self::Bicycling => "bicycling",
        }
    }
}

fn directions_url(
    api_key: &str,
    latitude: f64,
    longitude: f64,
    destination: &str,
    mode: Option<DirectionsMode>,
) -> String {
    let origin = format!("{latitude},{longitude}");
    let mode = mode.map_or_else(String::new, |mode| {
        format!("&mode={}", mode.as_google_value())
    });
    format!(
        "https://maps.googleapis.com/maps/api/directions/json?origin={origin}&destination={}{}&key={api_key}",
        encode(destination),
        mode,
    )
}

/// Resolve an origin point + destination to route steps.
pub async fn directions(
    latitude: f64,
    longitude: f64,
    destination: String,
    mode: Option<DirectionsMode>,
) -> Result<pb::NavigationDirectionsResponse, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    if destination.trim().is_empty() {
        return Err(BackendError::NoResult);
    }
    let response: DirectionsResponse = http()
        .get(directions_url(
            &api_key,
            latitude,
            longitude,
            &destination,
            mode,
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

    #[test]
    fn requested_route_mode_reaches_google_directions() {
        assert_eq!(
            directions_url(
                "test-key",
                55.6761,
                12.5683,
                "Nyhavn & Kongens Nytorv",
                Some(DirectionsMode::Bicycling),
            ),
            "https://maps.googleapis.com/maps/api/directions/json?origin=55.6761,12.5683&destination=Nyhavn+%26+Kongens+Nytorv&mode=bicycling&key=test-key",
        );
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
