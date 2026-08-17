//! Location handling: request-scoped location grounding for tool-less
//! providers, restricted-location classification, location preflight markers,
//! and the location envelope/extraction helpers.

use super::*;

/// Provider-independent, request-scoped location lookup for tool-less LLM
/// backends. Codex intentionally runs without network or tool access, so the
/// trusted Rust service performs only the narrow OSM operations that already
/// passed the explicit provider and exact-location consent gates.
pub(super) struct LocationGrounding {
    pub(super) enabled: bool,
    pub(super) osm: OsmClient,
    pub(super) nearby: NearbyClient,
    pub(super) cache: Arc<Mutex<HashMap<String, GroundingCacheEntry>>>,
}

#[derive(Clone)]
pub(super) struct GroundingCacheEntry {
    pub(super) stored_at: Instant,
    pub(super) latitude: f64,
    pub(super) longitude: f64,
    pub(super) payload: GroundingPayload,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct LocationIntent {
    pub(super) reverse_geocode: bool,
    /// `Some("")` means a generic Nearby lookup; `None` means no lookup.
    pub(super) nearby_query: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct GroundingPayload {
    pub(super) location_status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reverse_geocode_status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) nearby_search_status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) resolved_location: Option<GroundedLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) nearby_query: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) nearby_places: Vec<GroundedPlace>,
}

#[derive(Clone, Serialize)]
pub(super) struct GroundedLocation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) municipality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) country_subdivision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) postal_code: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct GroundedPlace {
    pub(super) ordinal: usize,
    pub(super) name: String,
    pub(super) address: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(super) place_types: Vec<String>,
    pub(super) distance_meters: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) phone_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) website_url: Option<String>,
}

impl LocationGrounding {
    pub(super) fn new(
        http_client: reqwest::Client,
        nearby: NearbyClient,
        config: &ResolvedConfig,
    ) -> Self {
        let options = config.openstreetmap_options.clone();
        let enabled = config.config.llm.provider == LlmProvider::Codex
            && options.enabled()
            && options.location_consent_acknowledged();
        Self {
            enabled,
            osm: OsmClient::new(http_client.clone(), options.clone()),
            nearby,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(super) async fn resolve(
        &self,
        request: &SynapseUnderstandingRequest,
        run_id: &str,
        utterance: &str,
    ) -> Option<String> {
        // Lock state is a request-time authorization input, not merely prompt
        // context. Fail before checking intent, request coordinates, or the
        // adjacent-turn cache so a locked/unknown turn cannot read or refresh
        // grounding produced while the device was unlocked.
        if request_device_lock_state(request) != DeviceLockState::Unlocked {
            self.revoke_for_restricted_request();
            return None;
        }
        if !self.enabled {
            return None;
        }
        let intent = self.intent_for_request(request, utterance);
        let location = request_location(request);
        if intent.is_none() && is_location_followup(utterance) {
            return self.cached_followup(request, run_id, location.as_ref());
        }
        let intent = intent?;
        let Some(location) = location else {
            let needs_reverse = intent.reverse_geocode || intent.nearby_query.is_some();
            return serde_json::to_string(&GroundingPayload {
                location_status: "not_supplied_by_device",
                reverse_geocode_status: needs_reverse.then_some("not_attempted_no_device_location"),
                nearby_search_status: intent
                    .nearby_query
                    .is_some()
                    .then_some("not_attempted_no_device_location"),
                resolved_location: None,
                nearby_query: intent.nearby_query,
                nearby_places: Vec::new(),
            })
            .ok();
        };

        let reverse_lookup = async {
            if intent.reverse_geocode || intent.nearby_query.is_some() {
                Some(
                    tokio::time::timeout(
                        LOCATION_GROUNDING_LOOKUP_TIMEOUT,
                        self.osm
                            .reverse_geocode(location.latitude, location.longitude),
                    )
                    .await
                    .unwrap_or(Err(OsmError::Timeout)),
                )
            } else {
                None
            }
        };
        let nearby_lookup = async {
            if let Some(query) = intent.nearby_query.as_deref() {
                Some(
                    tokio::time::timeout(
                        LOCATION_GROUNDING_LOOKUP_TIMEOUT,
                        self.nearby.search(
                            location.latitude,
                            location.longitude,
                            LOCATION_GROUNDING_RADIUS_METERS,
                            query,
                        ),
                    )
                    .await
                    .unwrap_or(Err(OsmError::Timeout)),
                )
            } else {
                None
            }
        };
        let (reverse_result, nearby_result) = tokio::join!(reverse_lookup, nearby_lookup);
        let reverse_geocode_status = lookup_status(&reverse_result);
        let nearby_search_status = lookup_status(&nearby_result);

        let resolved_location = reverse_result.and_then(|result| match result {
            Ok(location) => Some(grounded_location(location)),
            Err(error) => {
                warn!(
                    error_kind = error.kind(),
                    "location grounding reverse lookup failed"
                );
                None
            }
        });
        let nearby_places = nearby_result
            .and_then(|result| match result {
                Ok(places) => Some(places),
                Err(error) => {
                    warn!(
                        error_kind = error.kind(),
                        "location grounding nearby lookup failed"
                    );
                    None
                }
            })
            .unwrap_or_default()
            .into_iter()
            .take(LOCATION_GROUNDING_RESULT_LIMIT)
            .enumerate()
            .filter_map(|(index, place)| {
                let place_location = place.location.as_ref()?;
                Some(GroundedPlace {
                    ordinal: index + 1,
                    name: safe_grounding_value(&place.name)?,
                    address: safe_grounding_value(&place.formatted_address)
                        .unwrap_or_else(|| place.name.clone()),
                    place_types: place
                        .place_types
                        .iter()
                        .filter_map(|value| safe_grounding_value(value))
                        .collect(),
                    distance_meters: distance_meters(
                        location.latitude,
                        location.longitude,
                        place_location.latitude,
                        place_location.longitude,
                    )
                    .round()
                    .max(0.0) as u64,
                    phone_number: safe_grounding_value(&place.phone_number),
                    description: safe_grounding_value(&place.place_description),
                    website_url: safe_grounding_value(&place.website_url),
                })
            })
            .collect();

        let payload = GroundingPayload {
            location_status: "current_device_location",
            reverse_geocode_status,
            nearby_search_status,
            resolved_location,
            nearby_query: intent.nearby_query,
            nearby_places,
        };
        if !payload.nearby_places.is_empty() && payload.nearby_query.is_some() {
            self.store_grounding(request, run_id, &location, payload.clone());
        }
        serde_json::to_string(&payload).ok()
    }

    pub(super) fn revoke_for_restricted_request(&self) {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Classify direct location prompts plus a narrowly bounded adjacent
    /// Nearby-category refinement. A refinement is eligible only when the
    /// immediately preceding trusted USER turn owns a still-live Nearby
    /// snapshot. It is returned as a normal intent so the provider performs a
    /// fresh search for the new category instead of replaying the old results.
    pub(super) fn intent_for_request(
        &self,
        request: &SynapseUnderstandingRequest,
        utterance: &str,
    ) -> Option<LocationIntent> {
        classify_location_intent(utterance).or_else(|| {
            let nearby_query = contextual_nearby_refinement_query(utterance)?;
            self.has_adjacent_grounding(request)
                .then_some(LocationIntent {
                    reverse_geocode: false,
                    nearby_query: Some(nearby_query),
                })
        })
    }

    pub(super) fn has_adjacent_grounding(&self, request: &SynapseUnderstandingRequest) -> bool {
        let Some(previous_key) = previous_grounding_key(request) else {
            return false;
        };
        let now = Instant::now();
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .retain(|_, entry| now.duration_since(entry.stored_at) <= LOCATION_GROUNDING_CACHE_TTL);
        cache.contains_key(&previous_key)
    }

    pub(super) fn cached_followup(
        &self,
        request: &SynapseUnderstandingRequest,
        run_id: &str,
        location: Option<&Location>,
    ) -> Option<String> {
        let previous_key = previous_grounding_key(request)?;
        let current_key = current_grounding_key(request, run_id);
        let now = Instant::now();
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .retain(|_, entry| now.duration_since(entry.stored_at) <= LOCATION_GROUNDING_CACHE_TTL);
        let entry = cache.get(&previous_key)?.clone();
        if let Some(location) = location {
            if distance_meters(
                entry.latitude,
                entry.longitude,
                location.latitude,
                location.longitude,
            ) > LOCATION_GROUNDING_CACHE_MAX_DISTANCE_METERS
            {
                return None;
            }
        }
        // Alias the exact same result snapshot to this follow-up turn. A later
        // deictic turn follows only its immediate parent instead of scanning
        // older completed runs and reviving stale Nearby context.
        insert_bounded_grounding_entry(&mut cache, current_key, entry.clone(), Some(&previous_key));
        let mut payload = entry.payload;
        if location.is_none() {
            payload.location_status = "cached_previous_turn_location";
        }
        serde_json::to_string(&payload).ok()
    }

    pub(super) fn store_grounding(
        &self,
        request: &SynapseUnderstandingRequest,
        run_id: &str,
        location: &Location,
        payload: GroundingPayload,
    ) {
        let key = current_grounding_key(request, run_id);
        let now = Instant::now();
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .retain(|_, entry| now.duration_since(entry.stored_at) <= LOCATION_GROUNDING_CACHE_TTL);
        insert_bounded_grounding_entry(
            &mut cache,
            key,
            GroundingCacheEntry {
                stored_at: now,
                latitude: location.latitude,
                longitude: location.longitude,
                payload,
            },
            None,
        );
    }
}

pub(super) fn lookup_status<T>(result: &Option<Result<T, OsmError>>) -> Option<&'static str> {
    match result {
        Some(Ok(_)) => Some("success"),
        Some(Err(error)) => Some(error.kind()),
        None => None,
    }
}

pub(super) fn insert_bounded_grounding_entry(
    cache: &mut HashMap<String, GroundingCacheEntry>,
    key: String,
    entry: GroundingCacheEntry,
    protected_key: Option<&str>,
) {
    if cache.len() >= LOCATION_GROUNDING_CACHE_MAX_ENTRIES && !cache.contains_key(&key) {
        if let Some(oldest_key) = cache
            .iter()
            .filter(|(candidate, _)| Some(candidate.as_str()) != protected_key)
            .min_by_key(|(_, entry)| entry.stored_at)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(key, entry);
}

pub(super) fn grounded_location(result: ReverseGeocodeResult) -> GroundedLocation {
    GroundedLocation {
        display_name: result
            .display_name
            .as_deref()
            .and_then(safe_grounding_value),
        municipality: result
            .municipality
            .as_deref()
            .and_then(safe_grounding_value),
        country_subdivision: result
            .country_subdivision
            .as_deref()
            .and_then(safe_grounding_value),
        country: result.country.as_deref().and_then(safe_grounding_value),
        postal_code: result.postal_code.as_deref().and_then(safe_grounding_value),
    }
}

pub(super) fn safe_grounding_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_GROUNDING_VALUE_CHARS)
        .collect::<String>();
    let sanitized = sanitized.trim();
    (!sanitized.is_empty()).then(|| sanitized.to_string())
}

pub(super) fn request_owns_weather_fix(
    request: &SynapseUnderstandingRequest,
    location: &Location,
) -> bool {
    if request_device_lock_state(request) != DeviceLockState::Unlocked {
        return false;
    }
    request_location(request).is_some_and(|request_location| {
        request_location.latitude.to_bits() == location.latitude.to_bits()
            && request_location.longitude.to_bits() == location.longitude.to_bits()
    })
}

pub(super) fn reverse_geocoded_weather_locality(result: &ReverseGeocodeResult) -> Option<String> {
    // A full display address can be stale or describe a road/POI rather than a
    // city. Only the provider's structured municipality field is safe to
    // narrate as the locality for this weather fix.
    result
        .municipality
        .as_deref()
        .and_then(safe_grounding_value)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct WeatherLocalityEvidence {
    pub(super) locality: Option<String>,
    pub(super) provider_succeeded: bool,
}

pub(super) async fn current_fix_weather_locality(
    osm: &OsmClient,
    request: &SynapseUnderstandingRequest,
    location: &Location,
) -> WeatherLocalityEvidence {
    // Never reuse a label already attached to request context: it has no fix
    // identity. Reverse-geocode only the exact unlocked coordinates used by
    // the weather request, under OsmClient's explicit enable + consent gates.
    if !request_owns_weather_fix(request, location) {
        return WeatherLocalityEvidence::default();
    }
    match tokio::time::timeout(
        LOCATION_GROUNDING_LOOKUP_TIMEOUT,
        osm.reverse_geocode(location.latitude, location.longitude),
    )
    .await
    {
        Ok(Ok(result)) => WeatherLocalityEvidence {
            locality: reverse_geocoded_weather_locality(&result),
            provider_succeeded: true,
        },
        Ok(Err(error)) => {
            debug!(
                error_kind = error.kind(),
                "weather locality reverse lookup unavailable"
            );
            WeatherLocalityEvidence::default()
        }
        Err(_) => {
            debug!("weather locality reverse lookup timed out");
            WeatherLocalityEvidence::default()
        }
    }
}

/// Extend the bounded standalone weather recognizer with a few exact adjacent
/// follow-ups. The latest request must be a trusted USER turn matching the
/// outer request, and the immediately preceding USER turn must itself be a
/// complete weather prompt recognized by the standalone planner.
pub(super) fn plan_weather_prompt_with_context(
    request: &SynapseUnderstandingRequest,
) -> Option<WeatherPromptKind> {
    if let Some(kind) = plan_weather_prompt(request) {
        return Some(kind);
    }
    let (_, _, current_content) = trusted_current_user_request(request)?;
    let normalized = normalize_utterance(selected_user_request_text(current_content));
    let kind = match normalized.as_str() {
        "what about tomorrow" | "how about tomorrow" | "and tomorrow" | "tomorrow" => {
            WeatherPromptKind::Tomorrow
        }
        "what about now" | "how about now" | "and now" | "what about today" | "and today" => {
            WeatherPromptKind::Current
        }
        "any alerts"
        | "any weather alerts"
        | "what about alerts"
        | "how about alerts"
        | "and alerts"
        | "what about weather alerts"
        | "and weather alerts"
        | "any warnings"
        | "what about warnings" => WeatherPromptKind::Alerts,
        _ => return None,
    };

    let (_, previous_content) = trusted_previous_user_request(request)?;
    let mut previous_request = request.clone();
    previous_request.utterance = selected_user_request_text(previous_content).to_string();
    plan_weather_prompt(&previous_request)?;
    Some(kind)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RestrictedLocationRequestKind {
    Weather,
    Location,
}

/// Recognize location-bearing questions before model dispatch without reading
/// the grounding cache. Direct requests and narrowly adjacent follow-ups must
/// terminate while lock state is restricted; ordinary factual questions stay
/// eligible for context-free chat.
pub(super) fn restricted_location_request_kind(
    request: &SynapseUnderstandingRequest,
) -> Option<RestrictedLocationRequestKind> {
    let authoritative_utterance = trusted_current_user_request(request)
        .map(|(_, _, content)| selected_user_request_text(content))
        .unwrap_or(request.utterance.as_str())
        .to_string();
    if non_authoritative_intent_reason(&authoritative_utterance).is_some() {
        return None;
    }
    if request_device_lock_state(request) == DeviceLockState::Unlocked {
        return None;
    }
    let mut recognition_only = request.clone();
    let context = recognition_only
        .device_context
        .get_or_insert_with(Default::default);
    context.is_locked = false;
    recognition_only.utterance = authoritative_utterance.clone();
    if (plan_weather_prompt_with_context(&recognition_only).is_some()
        || is_natural_weather_question(&authoritative_utterance))
        && !is_explicit_remote_weather_question(&authoritative_utterance)
    {
        return Some(RestrictedLocationRequestKind::Weather);
    }
    if classify_location_intent(&authoritative_utterance).is_some() {
        return Some(RestrictedLocationRequestKind::Location);
    }

    let adjacent_nearby_followup = trusted_previous_user_request(&recognition_only)
        .and_then(|(_, previous)| classify_location_intent(selected_user_request_text(previous)))
        .is_some_and(|intent| intent.nearby_query.is_some())
        && (contextual_nearby_refinement_query(&authoritative_utterance).is_some()
            || is_location_followup(&authoritative_utterance));
    adjacent_nearby_followup.then_some(RestrictedLocationRequestKind::Location)
}

#[cfg(test)]
pub(super) fn is_restricted_weather_prompt(request: &SynapseUnderstandingRequest) -> bool {
    restricted_location_request_kind(request) == Some(RestrictedLocationRequestKind::Weather)
}

pub(super) fn agentic_location_marker_identifiers(
    request: &SynapseUnderstandingRequest,
) -> Vec<&str> {
    let Some((user_index, _, _)) = trusted_current_user_request(request) else {
        return Vec::new();
    };
    let Some(context) = request.device_context.as_ref() else {
        return Vec::new();
    };
    context.turns[user_index + 1..]
        .iter()
        .filter_map(|turn| {
            let Some(synapse_chat_turn::Content::Action(action)) = turn.content.as_ref() else {
                return None;
            };
            (turn.user == SynapseUser::Assistant as i32
                && !turn.identifier.trim().is_empty()
                && action.action == native_actions::GET_CURRENT_LOCATION
                && action.source == SynapseSource::Server as i32
                && action.device_payload.is_empty()
                && action.thought == AGENTIC_LOCATION_PREFLIGHT_THOUGHT)
                .then_some(turn.identifier.as_str())
        })
        .collect()
}

pub(super) fn local_weather_location_marker_identifiers(
    request: &SynapseUnderstandingRequest,
) -> Vec<&str> {
    let Some((user_index, _, _)) = trusted_current_user_request(request) else {
        return Vec::new();
    };
    let Some(context) = request.device_context.as_ref() else {
        return Vec::new();
    };
    context.turns[user_index + 1..]
        .iter()
        .filter_map(|turn| {
            let Some(synapse_chat_turn::Content::Action(action)) = turn.content.as_ref() else {
                return None;
            };
            (turn.user == SynapseUser::Assistant as i32
                && !turn.identifier.trim().is_empty()
                && action.action == native_actions::GET_CURRENT_LOCATION
                && action.source == SynapseSource::Server as i32
                && action.device_payload.is_empty()
                && action.thought == LOCAL_WEATHER_LOCATION_PREFLIGHT_THOUGHT)
                .then_some(turn.identifier.as_str())
        })
        .collect()
}

pub(super) fn current_user_location_actions(
    request: &SynapseUnderstandingRequest,
) -> Vec<(&str, bool)> {
    let Some((user_index, user_turn, _)) = trusted_current_user_request(request) else {
        return Vec::new();
    };
    let Some(context) = request.device_context.as_ref() else {
        return Vec::new();
    };
    let following_turns = &context.turns[user_index + 1..];
    following_turns
        .iter()
        .filter_map(|turn| {
            let Some(synapse_chat_turn::Content::Action(action)) = turn.content.as_ref() else {
                return None;
            };
            (turn.user == SynapseUser::Assistant as i32
                && !turn.identifier.trim().is_empty()
                && turn.parent_identifier == user_turn.identifier
                && action.action == native_actions::GET_CURRENT_LOCATION
                && action.source == SynapseSource::Server as i32
                && action.device_payload.is_empty())
            .then_some((
                turn.identifier.as_str(),
                action.thought == AGENTIC_LOCATION_PREFLIGHT_THOUGHT,
            ))
        })
        .collect()
}

#[allow(deprecated)]
pub(super) fn apply_location_envelope(
    request: &mut SynapseUnderstandingRequest,
    envelope: &encryption::LocationEnvelope,
) {
    let stale_status = envelope.stale_status;
    let status_is_usable = stale_status == encryption::LocationStaleStatus::Undefined as i32
        || stale_status == encryption::LocationStaleStatus::NotStale as i32;
    let accuracy_is_usable = envelope.accuracy.is_finite()
        && (0.0..=MAX_LOCATION_ENVELOPE_ACCURACY_METERS).contains(&envelope.accuracy);
    let timestamp_is_well_formed = envelope
        .timestamp
        .as_ref()
        .is_none_or(|timestamp| (0..1_000_000_000).contains(&timestamp.nanos));
    let location = Location {
        latitude: envelope.latitude as f64,
        longitude: envelope.longitude as f64,
    };

    if !status_is_usable
        || !accuracy_is_usable
        || !timestamp_is_well_formed
        || !valid_location(&location)
    {
        clear_request_location(request);
        return;
    }

    request.location = Some(location);
    let label = safe_grounding_value(&envelope.full_address)
        .or_else(|| safe_grounding_value(&envelope.human_readable))
        .unwrap_or_default();
    // A location envelope is not evidence of device unlock. In particular, a
    // labeled encrypted envelope must never manufacture a default (therefore
    // apparently unlocked) device context for an otherwise Unknown request.
    if let Some(context) = request.device_context.as_mut() {
        context.reverse_geocoded_location = label;
        if let Some(situation) = context.situation.as_mut() {
            // Situation labels have no fix identity. Do not pair one from an
            // older fix with the authoritative outer-envelope coordinates.
            situation.location_string.clear();
        }
    }
}

#[allow(deprecated)]
pub(super) fn clear_request_location(request: &mut SynapseUnderstandingRequest) {
    request.location = None;
    if let Some(context) = request.device_context.as_mut() {
        context.reverse_geocoded_location.clear();
        if let Some(situation) = context.situation.as_mut() {
            situation.location = None;
            situation.latitude = 0.0;
            situation.longitude = 0.0;
            situation.location_string.clear();
        }
    }
}

#[allow(deprecated)]
pub(super) fn request_location_name(req: &SynapseUnderstandingRequest) -> Option<String> {
    let context = req.device_context.as_ref()?;
    safe_grounding_value(&context.reverse_geocoded_location).or_else(|| {
        context
            .situation
            .as_ref()
            .and_then(|situation| safe_grounding_value(&situation.location_string))
    })
}

/// Resolve the stock request's current location without assuming which of the
/// wire-compatible fields the calling firmware populated. Newer request paths
/// use `request.location`; older paths put the same data in
/// `device_context.situation`.
#[allow(deprecated)]
pub(super) fn request_location(req: &SynapseUnderstandingRequest) -> Option<Location> {
    req.location
        .as_ref()
        .filter(|location| valid_location(location))
        .cloned()
        .or_else(|| {
            req.device_context
                .as_ref()?
                .situation
                .as_ref()?
                .location
                .as_ref()
                .filter(|location| valid_location(location))
                .cloned()
        })
        .or_else(|| {
            let situation = req.device_context.as_ref()?.situation.as_ref()?;
            // Proto3 scalar fields have no presence bit. Stock leaves both
            // deprecated coordinates at zero when they were not populated.
            if situation.latitude == 0.0 && situation.longitude == 0.0 {
                return None;
            }
            let location = Location {
                latitude: situation.latitude as f64,
                longitude: situation.longitude as f64,
            };
            valid_location(&location).then_some(location)
        })
}
