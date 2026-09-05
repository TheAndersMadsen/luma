//! Stock Ai Bus transport adapters. Text turns converge on AmbianceRuntime;
//! crypto envelopes and humane wire identities remain stock-compatible.
//! Unsupported legacy cognition and raw execution fail closed until their
//! origin-scoped runtime semantic services are implemented.

use cosmos_protocol::aibus as pb;

use base64::Engine as _;
use pb::ai_bus_service_server::AiBusService;
use tonic::{Request, Response, Status};

use crate::assistant::catalog;
use crate::assistant::llm::ConfiguredChatModel;
#[cfg(test)]
use crate::assistant::llm::{ChatMessage, ChatModel};
#[cfg(test)]
use std::sync::Arc;

/// Concrete erased stream type used by the server-stream and bidi RPCs.
type BoxStream<T> = std::pin::Pin<
    Box<dyn tonic::codegen::tokio_stream::Stream<Item = Result<T, Status>> + Send + 'static>,
>;

/// The device never completed the ephemeral key exchange for this capability.
const NO_CHANNEL_KEY: &str = "no ephemeral channel key established; call PublicPrivacyService \
     EstablishWrappingKeys/ImportKeys first";

/// Stock starts a service-scoped encrypted RPC and its first key import in
/// parallel. Give the authoritative directory a short chance to observe that
/// concurrent import instead of failing the wearer's first request by a few
/// milliseconds. Twenty five-millisecond polls stay well below the stock RPC
/// deadline while covering the observed import transaction comfortably.
const CHANNEL_KEY_IMPORT_POLL_ATTEMPTS: usize = 20;
const CHANNEL_KEY_IMPORT_POLL_DELAY: std::time::Duration = std::time::Duration::from_millis(5);

const FOOD_CHAT_REQUEST_KID: &str = "humane.aibus.ChatCompletionRequest";
const FOOD_CHAT_RESPONSE_KID: &str = "humane.aibus.ChatCompletionResponse";
const FOOD_ITEM_REQUEST_KID: &str = "humane.aibus.GetFoodItemRequest";
const FOOD_ITEM_RESPONSE_KID: &str = "humane.aibus.GetFoodItemResponse";
const FOOD_IMAGE_REQUEST_KID: &str = "humane.aibus.AnalyzeFoodImageRequest";
const FOOD_IMAGE_RESPONSE_KID: &str = "humane.aibus.AnalyzeFoodImageResponse";
const MAX_FOOD_CHAT_REQUEST_BYTES: usize = 256 * 1024;
const MAX_FOOD_ITEM_REQUEST_BYTES: usize = 4 * 1024;
const MAX_FOOD_IMAGE_REQUEST_BYTES: usize = 8 * 1024 * 1024;
/// The sealed request could not be opened under the established channel key.
const ENVELOPE_OPEN_FAILED: &str = "could not open the request envelope";

/// The plaintext response could not be sealed back under the channel key.
const ENVELOPE_SEAL_FAILED: &str = "could not seal the response envelope";

/// Short wearer-facing fallbacks. These deliberately contain no assistant persona,
/// provider name, model jargon, or deployment detail.
#[cfg(test)]
const NO_COMPLETION: &str = "No answer came back. Try again.";
#[cfg(test)]
const VISION_UNAVAILABLE: &str = "Image analysis is unavailable. Try again.";
#[cfg(test)]
const AUDIO_TRANSCRIPTION_UNAVAILABLE: &str = "Audio could not be transcribed.";
const LOADING_MUSIC_CUE: &str = "Finding music";
const LOADING_WEATHER_CUE: &str = "Checking the weather";

fn food_item_response(
    result: Result<crate::backends::food::FoodLookup, crate::backends::BackendError>,
    fallback_text: &str,
) -> Result<pb::GetFoodItemResponse, Status> {
    let best = match result {
        Ok(item) => cosmos_protocol::common::food::FoodItem {
            request_uuid: uuid::Uuid::new_v4().to_string(),
            item_name: item.item_name,
            typical_serving_size: item.serving_size,
            nutrition_info: item.nutrition,
            brand: item.brand,
        },
        Err(crate::backends::BackendError::NoResult) => cosmos_protocol::common::food::FoodItem {
            request_uuid: uuid::Uuid::new_v4().to_string(),
            item_name: fallback_text.to_owned(),
            typical_serving_size: String::new(),
            nutrition_info: Vec::new(),
            brand: String::new(),
        },
        Err(_) => {
            return Err(Status::unavailable("the nutrition backend is unavailable"));
        }
    };
    Ok(pb::GetFoodItemResponse {
        best_food_item: Some(best),
        alternate_food_items: Vec::new(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LoadingDecision {
    cue: Option<&'static str>,
    source: &'static str,
    reason: &'static str,
}

fn loading_message_for(utterance: &str, is_unlocked: bool) -> pb::LoadingMessageResponse {
    let decision = loading_decision(utterance, is_unlocked);
    match decision.cue {
        Some(cue) => pb::LoadingMessageResponse {
            loading_message: format!("{cue}..."),
            verbal_message: format!("{cue}."),
        },
        None => pb::LoadingMessageResponse::default(),
    }
}

fn loading_decision(utterance: &str, is_unlocked: bool) -> LoadingDecision {
    if !is_unlocked {
        return LoadingDecision {
            cue: None,
            source: "policy",
            reason: "locked",
        };
    }

    let normalized = utterance.to_lowercase();
    let words = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let has = |candidates: &[&str]| candidates.iter().any(|candidate| words.contains(candidate));
    let media_subject = has(&[
        "music",
        "song",
        "songs",
        "track",
        "tracks",
        "album",
        "albums",
        "playlist",
        "playlists",
        "playback",
    ]);
    if media_subject
        && has(&[
            "pause", "paused", "hold", "resume", "stop", "skip", "next", "previous",
        ])
    {
        return LoadingDecision {
            cue: None,
            source: "deterministic",
            reason: "playback_control",
        };
    }
    if has(&[
        "weather",
        "forecast",
        "umbrella",
        "rain",
        "raining",
        "snow",
        "snowing",
        "temperature",
        "wind",
        "windy",
    ]) {
        return LoadingDecision {
            cue: Some(LOADING_WEATHER_CUE),
            source: "deterministic",
            reason: "weather",
        };
    }
    if media_subject
        || (has(&["queue"]) && has(&["hit", "hits", "pop", "dance", "artist", "band", "singer"]))
    {
        return LoadingDecision {
            cue: Some(LOADING_MUSIC_CUE),
            source: "deterministic",
            reason: "music",
        };
    }
    LoadingDecision {
        cue: None,
        source: "deterministic",
        reason: "unclassified",
    }
}

/// `humane.aibus.AIBusService` — the assistant + its per-turn cloud tools.
#[derive(Clone)]
pub struct AiBusMain {
    runtime: std::sync::Arc<crate::ambiance::runtime::AmbianceRuntime>,
    /// Shared ephemeral channel keys, populated by `PublicPrivacyService`. The
    /// `Encrypted*` assistant path opens requests and seals responses with these.
    keys: crate::keymaterial::SharedKeyMaterial,
    /// Production channel-key authority. `None` is retained only for focused
    /// unit tests that exercise the legacy in-memory KeyMaterial seam.
    directory: Option<crate::keydirectory::SharedKeyDirectory>,
    /// The shared registry and durable runtime authority.
    store: crate::store::SharedStore,
    pairing: Option<crate::enrollment::SharedEnrollmentStore>,
}

#[derive(Debug)]
enum ResponseEnvelope {
    Encrypted {
        kid: String,
        response_kid: &'static str,
    },
    FoodPlaintext(&'static str),
}

impl Default for AiBusMain {
    fn default() -> Self {
        Self {
            runtime: std::sync::Arc::new(crate::ambiance::runtime::AmbianceRuntime::new(
                crate::store::MemoryStore::shared(),
                std::sync::Arc::new(ConfiguredChatModel::external_only()),
                crate::enrollment::pairing_store(),
            )),
            keys: Default::default(),
            directory: None,
            store: crate::store::MemoryStore::shared(),
            pairing: crate::enrollment::pairing_store(),
        }
    }
}

impl AiBusMain {
    pub fn with_runtime(
        mut self,
        runtime: std::sync::Arc<crate::ambiance::runtime::AmbianceRuntime>,
    ) -> Self {
        self.runtime = runtime;
        self
    }
    fn admit<T>(
        &self,
        request: &Request<T>,
    ) -> impl std::future::Future<Output = Result<(), Status>> + Send + use<T> {
        let store = self.store.clone();
        let pairing = self.pairing.clone();
        let authenticated = crate::auth::authenticated_request(request).cloned();
        async move {
            crate::pin_admission::admit(&store, pairing.as_ref(), authenticated.as_ref())
                .await
                .map(|_| ())
        }
    }
    fn locale_to_bcp47(locale: Option<&cosmos_protocol::common::Locale>) -> String {
        match locale {
            Some(l) if !l.language.is_empty() && !l.country.is_empty() => {
                format!("{}-{}", l.language, l.country)
            }
            Some(l) if !l.language.is_empty() => l.language.clone(),
            _ => "und".to_owned(),
        }
    }

    /// Open one channel envelope through the configured authority.
    ///
    /// Production always has a `KeyDirectory`; the local `KeyMaterial` branch
    /// exists only for focused unit tests. Keeping the lookup here prevents a
    /// bespoke encrypted RPC from accidentally consulting the retired local
    /// channel map and reporting an authoritative database row as absent.
    async fn open_envelope(
        &self,
        envelope: cosmos_crypto::EncryptedData,
    ) -> Result<Vec<u8>, Status> {
        let kid = envelope.kid.clone();
        if let Some(directory) = &self.directory {
            for attempt in 0..=CHANNEL_KEY_IMPORT_POLL_ATTEMPTS {
                match directory
                    .open(&envelope)
                    .await
                    .map_err(|error| crate::keydirectory::grpc_status(&error))?
                {
                    Some(plaintext) => return Ok(plaintext),
                    None if attempt < CHANNEL_KEY_IMPORT_POLL_ATTEMPTS => {
                        tokio::time::sleep(CHANNEL_KEY_IMPORT_POLL_DELAY).await;
                    }
                    None => {
                        crate::services::public_privacy::note_unknown_kid(&kid);
                        return Err(Status::failed_precondition(format!(
                            "no channel key for kid {kid}; queued for re-establishment via PublicPrivacyService SyncKeys",
                        )));
                    }
                }
            }
            unreachable!("bounded channel-key import poll returns on its final attempt");
        }

        if self.keys.is_empty().map_err(|error| {
            crate::services::public_privacy::key_material_availability_status(&error)
                .unwrap_or_else(|| Status::internal("could not inspect channel-key state"))
        })? {
            return Err(Self::channel_failure(NO_CHANNEL_KEY));
        }
        self.keys.open(&envelope).map_err(|error| {
            if let Some(status) =
                crate::services::public_privacy::key_material_availability_status(&error)
            {
                return status;
            }
            match error {
                cosmos_crypto::CryptoError::UnknownKid(_) => {
                    crate::services::public_privacy::note_unknown_kid(&kid);
                    Status::failed_precondition(format!(
                        "no channel key for kid {kid}; queued for re-establishment via PublicPrivacyService SyncKeys",
                    ))
                }
                _ => Self::channel_failure(ENVELOPE_OPEN_FAILED),
            }
        })
    }

    /// Open an `EncryptedData` request payload into its plaintext protobuf.
    ///
    /// Shared by every `Encrypted*` tool RPC. Both failure modes here are
    /// **channel** failures, so both report as [`Self::channel_failure`] — see
    /// that helper for why neither may borrow an account status code.
    async fn open_request<T: prost::Message + Default>(
        &self,
        enc: Option<cosmos_protocol::common::encryption::EncryptedData>,
    ) -> Result<(T, String), Status> {
        let enc = enc.ok_or_else(|| Status::invalid_argument("missing encrypted request"))?;
        let kid = enc
            .encryption_information
            .as_ref()
            .map(|i| i.kid.clone())
            .unwrap_or_default();
        let plaintext = self
            .open_envelope(cosmos_crypto::EncryptedData {
                data: enc.data,
                kid: kid.clone(),
            })
            .await?;
        let decoded = T::decode(plaintext.as_slice()).map_err(|_| {
            Status::invalid_argument("envelope did not contain the expected request")
        })?;
        Ok((decoded, kid))
    }

    /// The recovered Food process intentionally replaces only its three retired
    /// Krypton channels with exact plaintext proto envelopes inside the already
    /// authenticated device transport. Keep that compatibility closed over the
    /// request KID and a route-specific byte bound; every other KID continues
    /// through the normal channel-key directory.
    async fn open_food_request<T: prost::Message + Default>(
        &self,
        enc: Option<cosmos_protocol::common::encryption::EncryptedData>,
        request_kid: &'static str,
        response_kid: &'static str,
        maximum_bytes: usize,
    ) -> Result<(T, ResponseEnvelope), Status> {
        let plaintext = enc
            .as_ref()
            .and_then(|envelope| envelope.encryption_information.as_ref())
            .is_some_and(|information| information.kid == request_kid);
        if !plaintext {
            let (request, kid) = self.open_request(enc).await?;
            return Ok((request, ResponseEnvelope::Encrypted { kid, response_kid }));
        }

        let envelope = enc.ok_or_else(|| Status::invalid_argument("missing encrypted request"))?;
        if envelope.data.len() > maximum_bytes {
            return Err(Status::invalid_argument(
                "food request payload is too large",
            ));
        }
        let request = T::decode(envelope.data.as_slice()).map_err(|_| {
            Status::invalid_argument("food envelope did not contain the expected request")
        })?;
        Ok((request, ResponseEnvelope::FoodPlaintext(response_kid)))
    }

    async fn seal_food_response<T: prost::Message>(
        &self,
        protection: ResponseEnvelope,
        message: &T,
    ) -> Result<cosmos_protocol::common::encryption::EncryptedData, Status> {
        match protection {
            ResponseEnvelope::Encrypted { kid, response_kid } => {
                self.seal_response(&kid, message, response_kid).await
            }
            ResponseEnvelope::FoodPlaintext(kid) => {
                Ok(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: kid.to_owned(),
                        },
                    ),
                    data: message.encode_to_vec(),
                })
            }
        }
    }

    /// Open the location shape sent by stock location-bearing AIBus clients.
    ///
    /// `EncryptedWeather`, `EncryptedReverseGeocode`, and
    /// `EncryptedNavigationDirections` do not seal `humane.aibus.Location`:
    /// they seal the same float/freshness-bearing `LocationEnvelope` used by
    /// the encrypted understanding transport. Decoding it as the former fails
    /// on the first coordinate because their protobuf wire types differ.
    async fn open_stock_location(
        &self,
        enc: Option<cosmos_protocol::common::encryption::EncryptedData>,
    ) -> Result<
        (
            cosmos_protocol::common::encryption::LocationEnvelope,
            String,
        ),
        Status,
    > {
        self.open_request(enc).await
    }

    /// Convert stock float coordinates without applying a caller-specific
    /// freshness policy. Reverse geocoding and navigation historically accept
    /// the location supplied by their stock caller even when Weather would ask
    /// for a fresher fix.
    fn stock_location_coordinates(
        location: &cosmos_protocol::common::encryption::LocationEnvelope,
    ) -> Result<pb::Location, Status> {
        let latitude = f64::from(location.latitude);
        let longitude = f64::from(location.longitude);
        if !latitude.is_finite()
            || !longitude.is_finite()
            || !(-90.0..=90.0).contains(&latitude)
            || !(-180.0..=180.0).contains(&longitude)
        {
            return Err(Status::invalid_argument("invalid location envelope"));
        }
        Ok(pb::Location {
            latitude,
            longitude,
        })
    }

    fn weather_location_coordinates(
        location: &cosmos_protocol::common::encryption::LocationEnvelope,
    ) -> Result<pb::Location, Status> {
        use cosmos_protocol::common::encryption::LocationStaleStatus;

        if location == &cosmos_protocol::common::encryption::LocationEnvelope::default() {
            return Err(Status::invalid_argument("missing weather location"));
        }
        let usable_freshness = location.stalestatus == LocationStaleStatus::Undefined as i32
            || location.stalestatus == LocationStaleStatus::NotStale as i32;
        if !usable_freshness
            || !location.accuracy.is_finite()
            || !(0.0..=50_000.0).contains(&location.accuracy)
        {
            return Err(Status::invalid_argument("invalid weather location"));
        }
        Self::stock_location_coordinates(location)
    }

    /// Seal a plaintext protobuf response back under the same channel key,
    /// binding the envelope to the response TYPE via its AAD.
    ///
    /// Two reasons the AAD must not be empty. A real Pin's `decryptProto`
    /// requires a non-empty AAD — it resolves the payload class from it, and
    /// `Class.forName("")` fails, so an empty-AAD envelope cannot be opened at
    /// all. And because AAD is authenticated, binding it to the message type
    /// stops a sealed envelope from being replayed into a different RPC.
    async fn seal_response<T: prost::Message>(
        &self,
        kid: &str,
        message: &T,
        type_name: &str,
    ) -> Result<cosmos_protocol::common::encryption::EncryptedData, Status> {
        let encoded = message.encode_to_vec();
        let sealed = if let Some(directory) = &self.directory {
            directory
                .seal(kid, &encoded, type_name.as_bytes())
                .await
                .map_err(|error| crate::keydirectory::grpc_status(&error))?
                .ok_or_else(|| Status::failed_precondition("the response channel key is absent"))?
        } else {
            self.keys
                .seal(kid, &encoded, type_name.as_bytes())
                .map_err(|error| {
                    crate::services::public_privacy::key_material_availability_status(&error)
                        .unwrap_or_else(|| Self::channel_failure(ENVELOPE_SEAL_FAILED))
                })?
        };
        Ok(cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation { kid: sealed.kid },
            ),
            data: sealed.data,
        })
    }

    /// A crypto/transport failure on the assistant channel — never an account
    /// verdict.
    ///
    /// The stock client maps status codes ALONE onto wearer experiences, with no
    /// look at the message or the trailers
    /// (`intent/interpreters/RemoteInterpreter.java:81-96`):
    ///
    /// * DEADLINE_EXCEEDED → `Errors.timeout()`
    /// * UNAVAILABLE       → `Errors.unavailable()` (or the SSL variant)
    /// * UNAUTHENTICATED   → `Errors.unsubscribed()`  ⇒ `InvalidSubscription`
    /// * PERMISSION_DENIED → `Errors.deviceBlocked()` ⇒ `UnauthorizedDevice`
    /// * anything else     → `throw e`
    ///
    /// So the two account codes are not merely "auth-ish" here: emitting either
    /// one for a bad envelope makes the Pin narrate a crypto bug to the wearer as
    /// a billing or lost-device verdict. They are reserved for
    /// `gates::unsubscribed_status` / `gates::unauthorized_device_status`, which
    /// also attach the trailer the device's `AccountAuthorizationInterceptor`
    /// requires before it persists that verdict.
    ///
    /// The "anything else" arm is why this is UNAVAILABLE rather than the
    /// arguably tidier FAILED_PRECONDITION/INTERNAL: the rethrow is swallowed by
    /// `InterpreterOrchestrator.m5056xebc663ef` (`catch (Exception e) → return
    /// null`), and `LanguageUnderstanding.onRequestOrObservation` then logs
    /// "No action content, halting." — the wearer hears **nothing at all**.
    /// UNAVAILABLE is also the client's own code for exactly this condition: when
    /// its side of the ephemeral channel cannot be prepared or a payload cannot be
    /// encrypted, `aibus/AIBusService.java:241,249,266,437,513,528,543` synthesize
    /// `Status.UNAVAILABLE`. Same failure, same code, and the wearer is told.
    fn channel_failure(detail: &str) -> Status {
        Status::unavailable(detail)
    }

    /// Map a backend outcome onto a gRPC status. A capability with no credential
    /// configured is UNIMPLEMENTED (this deployment does not host it); a vendor
    /// that failed or found nothing is reported as such — never as a fake result.
    fn backend_status(e: crate::backends::BackendError, capability: &str) -> Status {
        use crate::backends::BackendError;
        match e {
            BackendError::NotConfigured => {
                Status::unimplemented(format!("no {capability} backend is configured"))
            }
            BackendError::NoResult => {
                Status::not_found(format!("{capability} returned no results"))
            }
            BackendError::Unavailable => {
                Status::unavailable(format!("the {capability} backend could not be reached"))
            }
        }
    }

    async fn seal_nearby_response(
        &self,
        kid: &str,
        places: Vec<pb::NearbyPlace>,
    ) -> Result<pb::EncryptedNearbySearchResponse, Status> {
        let reply = pb::NearbySearchResponse {
            nearby_places: places,
            status: pb::NearbySearchResultStatus::Success as i32,
        };
        Ok(pb::EncryptedNearbySearchResponse {
            response: Some(
                self.seal_response(kid, &reply, "humane.aibus.NearbySearchResponse")
                    .await?,
            ),
        })
    }

    async fn run_model_completion(&self, prompt: String) -> Result<String, Status> {
        let _ = prompt;
        Err(Status::unimplemented(
            "completion requires a runtime semantic service",
        ))
    }
    /// Raw child-agent plans are unsupported until represented by runtime intents.
    async fn run_model_chat(
        &self,
        chat: &pb::ChatCompletionRequest,
    ) -> Result<pb::ChatCompletionMessage, Status> {
        let _ = chat;
        Err(Status::unimplemented(
            "child agent execution is not a runtime intent",
        ))
    }
    /// Attach the workload's authoritative registry and runtime Store.
    pub fn with_store(mut self, store: crate::store::SharedStore) -> Self {
        self.runtime = std::sync::Arc::new(crate::ambiance::runtime::AmbianceRuntime::new(
            store.clone(),
            std::sync::Arc::new(ConfiguredChatModel::external_only()),
            self.pairing.clone(),
        ));
        self.store = store;
        self
    }

    /// Wearer-scoped context for the server-side tools this turn may call.
    ///
    /// Tools like `recall_memory` read the wearer's own saved notes, so they need
    /// the authenticated principal. A request without one yields an empty
    /// context and those tools report having nothing rather than reaching into
    /// another account.
    #[cfg(test)]
    fn tool_context<T>(&self, request: &Request<T>) -> crate::assistant::catalog::ToolContext {
        crate::assistant::catalog::ToolContext {
            principal: crate::auth::principal(request)
                .map(|p| p.expose_for_authorization().to_owned()),
            authenticated_request: crate::auth::authenticated_request(request).cloned(),
            answer_engine_available: crate::integrations::value("COSMOS_PPLX_API_KEY").is_some(),
            store: Some(self.store.clone()),
            keys: Some(self.keys.clone()),
            key_directory: self.directory.clone(),
            // Generic over the request body, so it cannot see
            // `SynapseUnderstandingRequest.location`. The Understand handlers
            // attach it once they have the typed request.
            location: None,
            music_discovery: None,
            deadline: None,
        }
    }

    /// Share the privacy service's key material so `EncryptedUnderstand` can use
    /// the very channel keys the device established.
    pub fn with_key_material(keys: crate::keymaterial::SharedKeyMaterial) -> Self {
        Self {
            keys,
            ..Default::default()
        }
    }

    pub fn with_key_directory(
        mut self,
        directory: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        self.directory = Some(directory);
        self
    }

    /// Convert the device's opaque image bytes into an OpenAI-compatible data
    /// URL without persisting them. The schema carries no MIME type, so magic
    /// bytes select the common formats and JPEG is the conservative fallback.
    fn image_data_url(bytes: &[u8]) -> Result<String, Status> {
        if bytes.is_empty() {
            return Err(Status::invalid_argument("image bytes are empty"));
        }
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            "image/gif"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            "image/jpeg"
        };
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    #[cfg(test)]
    fn analyze_image_data_url(request: &pb::AnalyzeImageRequest) -> Result<String, Status> {
        if !request.image_data.is_empty() {
            return Self::image_data_url(&request.image_data);
        }
        let encoded = request.base_64_encoded_image.trim();
        if encoded.is_empty() {
            return Err(Status::invalid_argument(
                "AnalyzeImage requires image_data or base_64_encoded_image",
            ));
        }
        if encoded.starts_with("data:image/") {
            if !encoded.contains(";base64,") {
                return Err(Status::invalid_argument(
                    "image data URL must contain a base64 payload",
                ));
            }
            Ok(encoded.to_owned())
        } else {
            Ok(format!("data:image/jpeg;base64,{encoded}"))
        }
    }
    /// Vision requires an origin-scoped runtime service before provider access.
    async fn vision_text(image_urls: Vec<String>, prompt: String) -> Result<String, Status> {
        let _ = (image_urls, prompt);
        Err(Status::unimplemented(
            "vision requires a runtime semantic service",
        ))
    }

    async fn analyze_image_inner(
        request: pb::AnalyzeImageRequest,
    ) -> Result<pb::AnalyzeImageResponse, Status> {
        let _ = request;
        Err(Status::unimplemented(
            "vision requires a runtime semantic service",
        ))
    }

    fn json_object(text: &str) -> Option<serde_json::Value> {
        serde_json::from_str(text).ok().or_else(|| {
            let start = text.find('{')?;
            let end = text.rfind('}')?;
            serde_json::from_str(&text[start..=end]).ok()
        })
    }

    async fn analyze_food_image_inner(
        request: pb::AnalyzeFoodImageRequest,
    ) -> Result<pb::AnalyzeFoodImageResponse, Status> {
        let image_urls = request
            .images
            .iter()
            .map(|image| Self::image_data_url(&image.image_data))
            .collect::<Result<Vec<_>, _>>()?;
        let text = Self::vision_text(
            image_urls,
            "Identify the visible food. Return only JSON in this exact shape: {\"items\":[{\"name\":\"\",\"serving_size\":\"\",\"brand\":\"\"}]}. Omit uncertain fields and do not estimate nutrition.".to_owned(),
        )
        .await?;
        let json = Self::json_object(&text)
            .ok_or_else(|| Status::unavailable("food vision response was not valid JSON"))?;
        let items = json
            .get("items")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| Status::unavailable("food vision response omitted items"))?;
        let mut foods = items
            .iter()
            .filter_map(|item| {
                let name = item.get("name")?.as_str()?.trim();
                if name.is_empty() {
                    return None;
                }
                Some(cosmos_protocol::common::food::FoodItem {
                    request_uuid: uuid::Uuid::new_v4().to_string(),
                    item_name: name.to_owned(),
                    typical_serving_size: item
                        .get("serving_size")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    nutrition_info: Vec::new(),
                    brand: item
                        .get("brand")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
            })
            .collect::<Vec<_>>();
        if foods.is_empty() {
            return Err(Status::not_found("no food was identified in the image"));
        }
        let best_food_item = foods.remove(0);
        Ok(pb::AnalyzeFoodImageResponse {
            food_bounding_boxes: vec![cosmos_protocol::common::food::FoodBoundingBox {
                best_food_item: Some(best_food_item),
                alternate_food_items: foods,
            }],
        })
    }

    /// Ask an operator-controlled object-store signer to mint the one-time URL.
    /// The signer contract is intentionally small and S3-shaped because those
    /// three response fields are part of the observed device wire contract.
    async fn presign_upload(
        request: pb::UploadFileRequest,
    ) -> Result<pb::UploadFileResponse, Status> {
        let use_case = pb::upload_file_request::UploadUseCase::try_from(request.use_case)
            .map_err(|_| Status::invalid_argument("unknown upload use case"))?;
        if use_case == pb::upload_file_request::UploadUseCase::Unset {
            return Err(Status::invalid_argument("upload use case is required"));
        }
        let endpoint = std::env::var("COSMOS_UPLOAD_PRESIGN_ENDPOINT").map_err(|_| {
            Status::failed_precondition("object-storage presign endpoint is not configured")
        })?;
        if endpoint.trim().is_empty() {
            return Err(Status::failed_precondition(
                "object-storage presign endpoint is not configured",
            ));
        }
        let response: serde_json::Value = reqwest::Client::new()
            .post(endpoint)
            .json(&serde_json::json!({ "use_case": use_case.as_str_name() }))
            .send()
            .await
            .map_err(|e| Status::unavailable(format!("upload signer transport failed: {e}")))?
            .error_for_status()
            .map_err(|e| Status::unavailable(format!("upload signer rejected request: {e}")))?
            .json()
            .await
            .map_err(|e| {
                Status::unavailable(format!("upload signer response was malformed: {e}"))
            })?;
        let field = |name: &str| {
            response
                .get(name)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    Status::unavailable(format!("upload signer response omitted {name}"))
                })
        };
        let url = field("url")?;
        if !(url.starts_with("https://") || url.starts_with("http://127.0.0.1:")) {
            return Err(Status::unavailable(
                "upload signer returned a non-HTTPS URL",
            ));
        }
        Ok(pb::UploadFileResponse {
            url,
            s3_key: field("s3_key")?,
            bucket_name: field("bucket_name")?,
        })
    }

    async fn process_completion_request(
        &self,
        request: pb::OpenAiCompletionRequest,
    ) -> Result<pb::OpenAiCompletionResponse, Status> {
        use pb::open_ai_completion_request::Completiontype;
        use pb::open_ai_completion_response::Completiontype as ResponseType;

        let completiontype = match request.completiontype {
            Some(Completiontype::GenericCompletion(req)) => {
                let history = req
                    .history
                    .iter()
                    .map(|item| format!("Q: {}\nA: {}", item.question, item.answer))
                    .collect::<Vec<_>>()
                    .join("\n");
                let text = self
                    .run_model_completion(format!(
                        "Answer concisely.\nContext: {}\nQuestion: {}\nTarget: {}\nHistory:\n{}",
                        req.text, req.raw_question, req.target, history
                    ))
                    .await?;
                ResponseType::GenericCompletion(pb::GenericCompletionResponse { text })
            }
            Some(Completiontype::MessageComposition(req)) => {
                if req.text.trim().is_empty() {
                    return Err(Status::invalid_argument(
                        "message composition requires source text",
                    ));
                }
                let formal = self
                    .run_model_completion(format!(
                        "Rewrite this message formally. Return only the message:\n{}",
                        req.text
                    ))
                    .await?;
                let casual = self
                    .run_model_completion(format!(
                        "Rewrite this message casually. Return only the message:\n{}",
                        req.text
                    ))
                    .await?;
                ResponseType::MessageComposition(pb::MessageCompositionResponse {
                    r#type: req.r#type,
                    formal,
                    casual,
                })
            }
            Some(Completiontype::SmartEditRequest(req)) => {
                if req.message.trim().is_empty() {
                    return Err(Status::invalid_argument("smart edit requires a message"));
                }
                let text = self.run_model_completion(format!(
                    "Apply this edit request: {}\nSelection: {}\nMessage:\n{}\nReturn only the edited message.",
                    req.edit_request, req.selection, req.message
                )).await?;
                ResponseType::SmartEditResponse(pb::SmartEditResponse {
                    text,
                    command: req.edit_request,
                })
            }
            Some(Completiontype::SummarizationRequest(req)) => {
                let mut summary_group = Vec::new();
                for group in req.conversation_group {
                    let text = group
                        .conversation_history
                        .iter()
                        .chain(group.messages_from_users.iter())
                        .map(|message| message.message.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    let summary = self
                        .run_model_completion(format!(
                            "Summarize this conversation concisely:\n{text}"
                        ))
                        .await?;
                    summary_group.push(pb::SummarizationResponse {
                        summary,
                        failed: false,
                        id: group.id,
                    });
                }
                for group in req.notifications_group {
                    let text = group
                        .notification
                        .iter()
                        .map(|n| format!("{}: {}", n.title, n.message))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let summary = self
                        .run_model_completion(format!(
                            "Summarize these notifications concisely:\n{text}"
                        ))
                        .await?;
                    summary_group.push(pb::SummarizationResponse {
                        summary,
                        failed: false,
                        id: group.id,
                    });
                }
                for group in req.missed_call_group {
                    let callers = group
                        .missed_calls
                        .iter()
                        .map(|call| call.caller.as_str())
                        .collect::<Vec<_>>();
                    summary_group.push(pb::SummarizationResponse {
                        summary: format!(
                            "{} missed call(s) from {}",
                            callers.len(),
                            callers.join(", ")
                        ),
                        failed: false,
                        id: group.id,
                    });
                }
                ResponseType::SummarizationResponse(pb::SummarizationNetworkResponse {
                    summary_group,
                })
            }
            None => {
                return Err(Status::failed_precondition(
                    "audio processing requires a configured speech backend",
                ));
            }
        };
        Ok(pb::OpenAiCompletionResponse {
            completiontype: Some(completiontype),
        })
    }

    async fn process_chat_request(
        &self,
        request: pb::OpenAiChatRequest,
    ) -> Result<pb::OpenAiChatResponse, Status> {
        use pb::open_ai_chat_request::Completiontype;
        use pb::open_ai_chat_response::Completiontype as ResponseType;

        let completiontype = match request.completiontype {
            Some(Completiontype::GenericChat(req)) => {
                if req.raw_question.trim().is_empty() {
                    return Err(Status::invalid_argument("chat request is empty"));
                }
                ResponseType::GenericResponse(pb::GenericChatResponse {
                    text: self.run_model_completion(req.raw_question).await?,
                    chatid: uuid::Uuid::new_v4().as_bytes().to_vec(),
                })
            }
            Some(Completiontype::SmartPlaylistRequest(req)) => {
                if req.topic.trim().is_empty() {
                    return Err(Status::invalid_argument("playlist topic is empty"));
                }
                let count = req.max_track_count.clamp(1, 24);
                let playlist = self
                    .catalog_playlist(&req.topic, count as usize, &req.playback_history)
                    .await?;
                ResponseType::SmartPlaylistResponse(pb::SmartPlaylistResponse {
                    playlist,
                    error: String::new(),
                    artist: String::new(),
                    album: String::new(),
                })
            }
            None => return Err(Status::invalid_argument("chat request has no payload")),
        };
        Ok(pb::OpenAiChatResponse {
            completiontype: Some(completiontype),
        })
    }

    async fn process_ai_request(&self, request: pb::AiRequest) -> Result<pb::AiResponse, Status> {
        use pb::ai_request::Capabilityrequest;
        let mut response = pb::AiResponse::default();
        match request.capabilityrequest {
            Some(Capabilityrequest::CompletionRequest(request)) => {
                response.completion_response =
                    Some(self.process_completion_request(request).await?);
            }
            Some(Capabilityrequest::ChatRequest(request)) => {
                response.chat_response = Some(self.process_chat_request(request).await?);
            }
            Some(Capabilityrequest::AudioProcessingRequest(audio)) => {
                response.audio_processing_response = Some(self.process_audio_request(audio).await?);
            }
            None => {
                return Err(Status::invalid_argument("empty AI request"));
            }
        }
        Ok(response)
    }

    /// Dispatch one `AudioProcessingRequest` sub-operation.
    ///
    /// The stream multiplexes four audio vendors (`SpeechSource`): Google STT,
    /// Google speech-translate, Google TTS, and Resemble TTS. We serve the two
    /// **synthesis** paths (text -> audio) with the configured Azure Speech
    /// backend — Microsoft is itself one of the stock `SpeechSource` options, so
    /// this is a legitimate vendor, not a fabrication (the audio speaks the exact
    /// requested text; only the voice differs from Humane's Resemble clone). The
    /// **recognition** paths (audio -> text / translated text) need a
    /// speech-to-text backend this deployment does not host, so they return an
    /// honest capability error rather than an invented transcript.
    async fn process_audio_request(
        &self,
        req: pb::AudioProcessingRequest,
    ) -> Result<pb::AudioProcessingResponse, Status> {
        // Text to synthesize, from whichever TTS sub-op is set.
        let tts_text = req
            .google_speech_request
            .and_then(|r| r.audio_data)
            .map(|a| a.text)
            .or_else(|| {
                req.resemble_speech_request
                    .and_then(|r| r.audio_data)
                    .map(|a| a.text)
            });

        if let Some(text) = tts_text {
            if text.trim().is_empty() {
                return Err(Status::invalid_argument("speech synthesis requires text"));
            }
            let backend = crate::backends::azure_speech::configured_backend().ok_or_else(|| {
                Status::unimplemented(
                    "speech synthesis requires a configured backend (set COSMOS_AZURE_SPEECH_KEY)",
                )
            })?;
            let audio = backend
                .synthesize(
                    &text,
                    crate::backends::azure_speech::SpeechAudioFormat::Riff16Khz16BitMonoPcm,
                )
                .await
                .map_err(|_| Status::unavailable("the speech-synthesis backend is unavailable"))?;
            return Ok(pb::AudioProcessingResponse {
                audio_data: Some(pb::AudioData {
                    audio_bytes: audio,
                    text: String::new(),
                    audio_context: Vec::new(),
                }),
                translated_text: String::new(),
            });
        }

        // Transcription (audio -> text) via the configured speech-to-text backend.
        if let Some(transcribe) = req.google_transcribe_request {
            let audio = transcribe
                .audio_data
                .map(|a| a.audio_bytes)
                .unwrap_or_default();
            if audio.is_empty() {
                return Err(Status::invalid_argument("transcription requires audio"));
            }
            let backend = crate::backends::azure_speech::configured_recognition_backend()
                .ok_or_else(|| {
                    Status::unimplemented(
                        "audio transcription requires a configured speech-to-text backend \
                         (set COSMOS_AZURE_SPEECH_KEY)",
                    )
                })?;
            let text = backend
                .transcribe(&audio)
                .await
                .map_err(|_| Status::unavailable("the speech-to-text backend is unavailable"))?;
            return Ok(pb::AudioProcessingResponse {
                audio_data: Some(pb::AudioData {
                    audio_bytes: Vec::new(),
                    text,
                    audio_context: Vec::new(),
                }),
                translated_text: String::new(),
            });
        }
        // Speech TRANSLATION needs a translator this deployment does not host (the
        // Azure Speech key covers TTS + STT, not text translation). Honest decline.
        if req.google_translate_request.is_some() {
            return Err(Status::unimplemented(
                "speech translation requires a translation backend not hosted here",
            ));
        }
        Err(Status::invalid_argument("empty audio processing request"))
    }

    async fn catalog_playlist(
        &self,
        topic: &str,
        limit: usize,
        playback_history: &[pb::SongInfo],
    ) -> Result<Vec<pb::SongInfo>, Status> {
        let history = playback_history
            .iter()
            .map(|track| format!("{}\u{0}{}", track.song.to_ascii_lowercase(), track.isrc))
            .collect::<std::collections::BTreeSet<_>>();
        let tracks = crate::backends::music::search(topic, limit.saturating_add(history.len()))
            .await
            .map_err(|error| match error {
                crate::backends::BackendError::NoResult => {
                    Status::not_found("no catalog tracks matched the playlist topic")
                }
                _ => Status::unavailable("music catalog is unavailable"),
            })?;
        let playlist = tracks
            .into_iter()
            .map(|track| pb::SongInfo {
                song: track.title,
                artist: track.artists,
                isrc: track.isrc,
            })
            .filter(|track| {
                !history.contains(&format!(
                    "{}\u{0}{}",
                    track.song.to_ascii_lowercase(),
                    track.isrc
                ))
            })
            .take(limit.clamp(1, 24))
            .collect::<Vec<_>>();
        if playlist.is_empty() {
            Err(Status::not_found(
                "no new catalog tracks matched the playlist topic",
            ))
        } else {
            Ok(playlist)
        }
    }
}

#[tonic::async_trait]
impl AiBusService for AiBusMain {
    // --- Deterministic on-device test RPCs (no model needed) -----------------

    async fn action_execution_test(
        &self,
        _request: Request<pb::ActionExecutionTestRequest>,
    ) -> Result<Response<pb::ActionExecutionTestResponse>, Status> {
        // Diagnostic harness that pings a named action backend (weather, SERP,
        // Wolfram, Wikipedia, GPT-3.5, notes, list, semantic search, PPLX). None
        // of those backends are hosted here, so we report that honestly through
        // the response's own failure channel — a well-formed, stock-shaped Ok,
        // not a fabricated success and not a strand-inducing gRPC error.
        Ok(Response::new(pb::ActionExecutionTestResponse {
            success: false,
            error_message: "action backend not hosted in this deployment".to_owned(),
        }))
    }

    async fn transcription_repair_test(
        &self,
        request: Request<pb::TranscriptionRepairTestRequest>,
    ) -> Result<Response<pb::TranscriptionRepairTestResponse>, Status> {
        // Identity repair: with no repair model present, the faithful result is
        // the client's own transcription unchanged. We echo it back rather than
        // invent a "corrected" string.
        let transcription = request.into_inner().transcription;
        Ok(Response::new(pb::TranscriptionRepairTestResponse {
            success: true,
            error_message: String::new(),
            corrected_transcription: transcription,
        }))
    }

    // --- Assistant core: server-side LLM required ---------------------------

    type UnderstandStream = BoxStream<pb::SynapseUnderstandingResponse>;

    async fn understand(
        &self,
        request: Request<pb::SynapseUnderstandingRequest>,
    ) -> Result<Response<Self::UnderstandStream>, Status> {
        self.admit(&request).await?;
        let authenticated = crate::auth::authenticated_request(&request)
            .cloned()
            .ok_or_else(|| Status::permission_denied("authenticated Pin required"))?;
        Ok(Response::new(Box::pin(crate::ambiance::stock::stream(
            self.runtime.clone(),
            authenticated,
            request.into_inner(),
        ))))
    }

    type EncryptedUnderstandStream = BoxStream<pb::EncryptedSynapseUnderstandingResponse>;
    /// Preserve the stock encrypted wire shape around the same runtime text path.
    /// Output closure tears down both adapter tasks and their pending turn.
    async fn encrypted_understand(
        &self,
        request: Request<pb::EncryptedSynapseUnderstandingRequest>,
    ) -> Result<Response<Self::EncryptedUnderstandStream>, Status> {
        self.admit(&request).await?;
        use prost::Message as _;

        let authenticated = crate::auth::authenticated_request(&request)
            .cloned()
            .ok_or_else(|| Status::permission_denied("authenticated Pin required"))?;
        let body = request.into_inner();
        let enc = body
            .request
            .ok_or_else(|| Status::invalid_argument("missing encrypted request"))?;
        let kid = enc
            .encryption_information
            .as_ref()
            .map(|i| i.kid.clone())
            .unwrap_or_default();
        let plaintext = self
            .open_envelope(cosmos_crypto::EncryptedData {
                data: enc.data,
                kid: kid.clone(),
            })
            .await?;
        let inner = pb::SynapseUnderstandingRequest::decode(plaintext.as_slice())
            .map_err(|_| Status::invalid_argument("invalid understanding request"))?;
        // Separate location and client-supplied history are not cognitive input.
        let runtime = self.runtime.clone();
        let keys = self.keys.clone();
        let directory = self.directory.clone();
        let (plain_tx, mut plain_rx) = tokio::sync::mpsc::channel(16);
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            tokio::select! {
                _ = plain_tx.closed() => {}
                response = crate::ambiance::stock::response(&runtime, &authenticated, inner) => { let _ = plain_tx.send(response).await; }
            }
        });
        tokio::spawn(async move {
            loop {
                let msg = tokio::select! {
                    biased;
                    _ = tx.closed() => return,
                    msg = plain_rx.recv() => match msg { Some(msg) => msg, None => return },
                };
                let sealing = async {
                    match msg {
                        Ok(m) => {
                            let encoded = m.encode_to_vec();
                            let result = if let Some(directory) = &directory {
                                directory
                                    .seal(
                                        &kid,
                                        &encoded,
                                        b"humane.aibus.SynapseUnderstandingResponse",
                                    )
                                    .await
                                    .map_err(|error| crate::keydirectory::grpc_status(&error))
                                    .and_then(|sealed| {
                                        sealed.ok_or_else(|| {
                                            Status::failed_precondition(
                                                "the response channel key is absent",
                                            )
                                        })
                                    })
                            } else {
                                keys.seal(
                                &kid,
                                &encoded,
                                b"humane.aibus.SynapseUnderstandingResponse",
                            )
                            .map_err(|error| {
                                crate::services::public_privacy::key_material_availability_status(
                                    &error,
                                )
                                .unwrap_or_else(|| Self::channel_failure(ENVELOPE_SEAL_FAILED))
                            })
                            };
                            result.map(|e| {
                                pb::EncryptedSynapseUnderstandingResponse {
                            response: Some(cosmos_protocol::common::encryption::EncryptedData {
                                encryption_information: Some(
                                    cosmos_protocol::common::encryption::EncryptionInformation {
                                        kid: e.kid,
                                    },
                                ),
                                data: e.data,
                            }),
                        }
                            })
                        }
                        Err(status) => Err(status),
                    }
                };
                let sealed = tokio::select! {
                    biased;
                    _ = tx.closed() => return,
                    sealed = sealing => sealed,
                };
                match sealed {
                    Ok(m) => {
                        if tx.send(Ok(m)).await.is_err() {
                            return; // client hung up
                        }
                    }
                    Err(status) => {
                        let _ = tx.send(Err(status)).await;
                        return;
                    }
                }
            }
        });
        Ok(Response::new(Box::pin(
            tokio_stream::wrappers::ReceiverStream::new(rx),
        )))
    }

    type BidirectionalStreamingUnderstandStream = BoxStream<pb::StreamingUnderstandResponse>;
    /// Stock execution frames around runtime intents. Unverified observations
    /// supply neither playback evidence nor control authority.
    async fn bidirectional_streaming_understand(
        &self,
        request: Request<tonic::Streaming<pb::StreamingUnderstandRequest>>,
    ) -> Result<Response<Self::BidirectionalStreamingUnderstandStream>, Status> {
        self.admit(&request).await?;
        let authenticated = crate::auth::authenticated_request(&request)
            .cloned()
            .ok_or_else(|| Status::permission_denied("authenticated Pin required"))?;
        Ok(Response::new(Box::pin(crate::ambiance::stock::bidi(
            self.runtime.clone(),
            authenticated,
            request.into_inner(),
        ))))
    }

    async fn server_stateful_understand(
        &self,
        request: Request<pb::ServerStatefulUnderstandRequest>,
    ) -> Result<Response<pb::ServerStatefulUnderstandResponse>, Status> {
        self.admit(&request).await?;
        let authenticated = crate::auth::authenticated_request(&request)
            .cloned()
            .ok_or_else(|| Status::permission_denied("authenticated Pin required"))?;
        let Some(pb::server_stateful_understand_request::Userrequest::Transcription(text)) =
            request.into_inner().userrequest
        else {
            return Err(Status::unimplemented(
                "realtime audio admission is not implemented",
            ));
        };
        let reply = crate::ambiance::stock::response(
            &self.runtime,
            &authenticated,
            pb::SynapseUnderstandingRequest {
                utterance: text,
                ..Default::default()
            },
        )
        .await?;
        let Some(pb::synapse_understanding_response::Body::Turn(turn)) = reply.body else {
            return Err(Status::internal("invalid stock response"));
        };
        let Some(pb::synapse_chat_turn::Content::Action(action)) = turn.content else {
            return Err(Status::internal("invalid stock response"));
        };
        let value: serde_json::Value = serde_json::from_str(&action.input)
            .map_err(|_| Status::internal("invalid stock response"))?;
        let text = value
            .get("Response")
            .and_then(|value| value.as_str())
            .ok_or_else(|| Status::internal("invalid stock response"))?
            .to_owned();
        Ok(Response::new(pb::ServerStatefulUnderstandResponse {
            response: Some(pb::server_stateful_understand_response::Response::Text(
                text,
            )),
        }))
    }

    // --- Completion / chat: LLM + Krypton crypto ----------------------------

    async fn encrypted_completion(
        &self,
        request: Request<pb::EncryptedCompletionRequest>,
    ) -> Result<Response<pb::EncryptedCompletionResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (completion, kid): (pb::CompletionRequest, _) =
            self.open_request(request.request).await?;
        if completion.prompt.trim().is_empty() {
            return Err(Status::invalid_argument(
                "completion request missing prompt",
            ));
        }
        let text = self.run_model_completion(completion.prompt).await?;
        let response = pb::CompletionResponse {
            choices: vec![pb::CompletionChoice {
                text,
                index: 0,
                finish_reason: "stop".to_owned(),
            }],
            usage: Some(pb::CompletionUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            }),
            error: None,
        };
        Ok(Response::new(pb::EncryptedCompletionResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.CompletionResponse")
                    .await?,
            ),
        }))
    }

    async fn encrypted_chat_completion(
        &self,
        request: Request<pb::EncryptedChatCompletionRequest>,
    ) -> Result<Response<pb::EncryptedChatCompletionResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (chat, protection): (pb::ChatCompletionRequest, _) = self
            .open_food_request(
                request.request,
                FOOD_CHAT_REQUEST_KID,
                FOOD_CHAT_RESPONSE_KID,
                MAX_FOOD_CHAT_REQUEST_BYTES,
            )
            .await?;
        let response_message = self.run_model_chat(&chat).await?;
        let response = pb::ChatCompletionResponse {
            choices: vec![pb::Choice {
                message: Some(response_message),
                stop_reason: "stop".to_owned(),
            }],
            usage: Some(pb::ChatCompletionUsage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            }),
            error: None,
        };
        Ok(Response::new(pb::EncryptedChatCompletionResponse {
            response: Some(self.seal_food_response(protection, &response).await?),
        }))
    }

    // --- Vision / image understanding: image model required -----------------

    async fn analyze_image(
        &self,
        request: Request<pb::AnalyzeImageRequest>,
    ) -> Result<Response<pb::AnalyzeImageResponse>, Status> {
        self.admit(&request).await?;
        Ok(Response::new(
            Self::analyze_image_inner(request.into_inner()).await?,
        ))
    }

    async fn encrypted_analyze_image(
        &self,
        request: Request<pb::EncryptedAnalyzeImageRequest>,
    ) -> Result<Response<pb::EncryptedAnalyzeImageResponse>, Status> {
        self.admit(&request).await?;
        let (request, kid): (pb::AnalyzeImageRequest, _) =
            self.open_request(request.into_inner().request).await?;
        let response = Self::analyze_image_inner(request).await?;
        Ok(Response::new(pb::EncryptedAnalyzeImageResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.AnalyzeImageResponse")
                    .await?,
            ),
        }))
    }

    async fn encrypted_analyze_food_image(
        &self,
        request: Request<pb::EncryptedAnalyzeFoodImageRequest>,
    ) -> Result<Response<pb::EncryptedAnalyzeFoodImageResponse>, Status> {
        self.admit(&request).await?;
        let (request, protection): (pb::AnalyzeFoodImageRequest, _) = self
            .open_food_request(
                request.into_inner().request,
                FOOD_IMAGE_REQUEST_KID,
                FOOD_IMAGE_RESPONSE_KID,
                MAX_FOOD_IMAGE_REQUEST_BYTES,
            )
            .await?;
        let response = Self::analyze_food_image_inner(request).await?;
        Ok(Response::new(pb::EncryptedAnalyzeFoodImageResponse {
            response: Some(self.seal_food_response(protection, &response).await?),
        }))
    }

    // --- Interstitial / loading copy -----------------------------------------

    async fn encrypted_action_based_interstitial(
        &self,
        request: Request<pb::EncryptedActionBasedInterstitialRequest>,
    ) -> Result<Response<pb::EncryptedActionBasedInterstitialResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (req, kid): (pb::ActionBasedInterstitialRequest, _) =
            self.open_request(request.request).await?;
        let response = pb::ActionBasedInterstitialResponse {
            interstitial: catalog::progress_cue_from_action_strings(&req.action_strings)
                .unwrap_or_default(),
        };
        let response = pb::EncryptedActionBasedInterstitialResponse {
            response: Some(
                self.seal_response(
                    &kid,
                    &response,
                    "humane.aibus.ActionBasedInterstitialResponse",
                )
                .await?,
            ),
        };
        Ok(Response::new(response))
    }

    async fn encrypted_loading_message(
        &self,
        request: Request<pb::EncryptedLoadingMessageRequest>,
    ) -> Result<Response<pb::EncryptedLoadingMessageResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (req, kid): (pb::LoadingMessageRequest, _) = self.open_request(request.request).await?;
        let decision = loading_decision(&req.utterance, req.is_unlocked);
        let response = loading_message_for(&req.utterance, req.is_unlocked);
        tracing::info!(
            emitted = decision.cue.is_some(),
            source = decision.source,
            reason = decision.reason,
            "returning bounded loading message"
        );
        let response = pb::EncryptedLoadingMessageResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.LoadingMessageResponse")
                    .await?,
            ),
        };
        Ok(Response::new(response))
    }

    // --- Server-side tool execution: needs the action backends --------------

    async fn function_execution(
        &self,
        request: Request<pb::FunctionCall>,
    ) -> Result<Response<pb::FunctionResponse>, Status> {
        self.admit(&request).await?;
        Err(Status::unimplemented(
            "raw function execution is not a runtime intent",
        ))
    }

    async fn encrypted_function_execution(
        &self,
        request: Request<pb::EncryptedFunctionCall>,
    ) -> Result<Response<pb::EncryptedFunctionResponse>, Status> {
        self.admit(&request).await?;
        Err(Status::unimplemented(
            "raw function execution is not a runtime intent",
        ))
    }

    // --- Location / maps / places: external services ------------------------

    async fn encrypted_geo_locate(
        &self,
        request: Request<pb::EncryptedGeoLocateRequest>,
    ) -> Result<Response<pb::EncryptedGeoLocateResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (req, kid): (pb::GeoLocateRequest, _) = self.open_request(request.request).await?;
        let location = crate::backends::places::geolocate(&req)
            .await
            .map_err(|e| Self::backend_status(e, "geolocation"))?;
        Ok(Response::new(pb::EncryptedGeoLocateResponse {
            response: Some(
                self.seal_response(&kid, &location, "humane.aibus.GeoLocateResponse")
                    .await?,
            ),
        }))
    }

    /// Reverse geocode the device's position. cosmos's response fields are Azure
    /// Maps vocabulary (`municipality`, `country_subdivision`); `backends::places`
    /// translates Google's `address_components` into them.
    async fn encrypted_reverse_geocode(
        &self,
        request: Request<pb::EncryptedReverseGeocodeRequest>,
    ) -> Result<Response<pb::EncryptedReverseGeocodeResponse>, Status> {
        self.admit(&request).await?;
        let (location_envelope, kid) = self
            .open_stock_location(request.into_inner().location)
            .await?;
        let location = Self::stock_location_coordinates(&location_envelope)?;
        let address =
            crate::backends::places::reverse_geocode(location.latitude, location.longitude)
                .await
                .map_err(|e| Self::backend_status(e, "reverse-geocoding"))?;
        Ok(Response::new(pb::EncryptedReverseGeocodeResponse {
            response: Some(
                self.seal_response(&kid, &address, "humane.aibus.ReverseGeocodeResponse")
                    .await?,
            ),
        }))
    }

    async fn encrypted_navigation_directions(
        &self,
        request: Request<pb::EncryptedNavigationDirectionsRequest>,
    ) -> Result<Response<pb::EncryptedNavigationDirectionsResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (origin_envelope, _) = self.open_stock_location(request.location).await?;
        let origin = Self::stock_location_coordinates(&origin_envelope)?;
        let (nav, kid): (pb::NavigationDirectionsRequest, _) =
            self.open_request(request.request).await?;
        let directions = crate::backends::places::directions(
            origin.latitude,
            origin.longitude,
            nav.destination,
            None,
        )
        .await
        .map_err(|e| Self::backend_status(e, "directions"))?;
        Ok(Response::new(pb::EncryptedNavigationDirectionsResponse {
            response: Some(
                self.seal_response(
                    &kid,
                    &directions,
                    "humane.aibus.NavigationDirectionsResponse",
                )
                .await?,
            ),
        }))
    }

    /// Places search around the wearer, in cosmos's `NearbyPlace` shape — which is
    /// field-for-field Google Places, so this adapter is close to a rename.
    async fn encrypted_nearby_search(
        &self,
        request: Request<pb::EncryptedNearbySearchRequest>,
    ) -> Result<Response<pb::EncryptedNearbySearchResponse>, Status> {
        self.admit(&request).await?;
        let (search, kid): (pb::NearbySearchRequest, _) =
            self.open_request(request.into_inner().request).await?;
        let near = search.location.as_ref().map(|l| (l.latitude, l.longitude));
        let places =
            crate::backends::places::nearby(&search.text_query, near, search.radius_accuracy)
                .await
                .map_err(|e| Self::backend_status(e, "places-search"))?;
        Ok(Response::new(
            self.seal_nearby_response(&kid, places).await?,
        ))
    }

    /// Current conditions for the device's location, in cosmos's AccuWeather-shaped
    /// `WeatherResponse`. Served by Pirate Weather when configured; see
    /// `backends::weather` for the one field (the numeric icon) that is a
    /// documented approximation between the two vendors.
    async fn encrypted_weather(
        &self,
        request: Request<pb::EncryptedWeatherRequest>,
    ) -> Result<Response<pb::EncryptedWeatherResponse>, Status> {
        self.admit(&request).await?;
        let (location_envelope, kid) = self
            .open_stock_location(request.into_inner().location)
            .await?;
        let location = Self::weather_location_coordinates(&location_envelope)?;
        let weather = crate::backends::weather::current(location.latitude, location.longitude)
            .await
            .map_err(|e| Self::backend_status(e, "weather"))?;
        Ok(Response::new(pb::EncryptedWeatherResponse {
            response: Some(
                self.seal_response(&kid, &weather, "humane.aibus.WeatherResponse")
                    .await?,
            ),
        }))
    }

    // --- Food nutrition lookup: external database ---------------------------

    async fn encrypted_get_food_item(
        &self,
        request: Request<pb::EncryptedGetFoodItemRequest>,
    ) -> Result<Response<pb::EncryptedGetFoodItemResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (req, protection): (pb::GetFoodItemRequest, _) = self
            .open_food_request(
                request.request,
                FOOD_ITEM_REQUEST_KID,
                FOOD_ITEM_RESPONSE_KID,
                MAX_FOOD_ITEM_REQUEST_BYTES,
            )
            .await?;
        let text = req.text.trim().to_owned();
        if text.is_empty() {
            return Err(Status::invalid_argument("GetFoodItem requires text"));
        }
        // Real nutrition from Open Food Facts (a free, keyless substitute for
        // cosmos's Nutritionix backend). A no-match returns the query with empty
        // nutrition — the device narrates "couldn't get that info" — rather than a
        // fabricated figure; an unreachable provider is an honest gRPC error.
        let response = food_item_response(crate::backends::food::lookup(&text).await, &text)?;
        Ok(Response::new(pb::EncryptedGetFoodItemResponse {
            response: Some(self.seal_food_response(protection, &response).await?),
        }))
    }

    // --- Smart playlist: catalog-backed -------------------------------------

    async fn encrypted_smart_playlist(
        &self,
        request: Request<pb::EncryptedSmartPlaylistRequest>,
    ) -> Result<Response<pb::EncryptedSmartPlaylistResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (req, kid): (pb::SmartPlaylistRequest, _) = self.open_request(request.request).await?;

        if req.topic.trim().is_empty() {
            return Err(Status::invalid_argument("playlist topic is empty"));
        }
        let playlist = self
            .catalog_playlist(
                &req.topic,
                req.max_track_count.clamp(1, 24) as usize,
                &req.playback_history,
            )
            .await?;
        let response = pb::SmartPlaylistResponse {
            playlist,
            error: String::new(),
            artist: String::new(),
            album: String::new(),
        };
        let response = pb::EncryptedSmartPlaylistResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.SmartPlaylistResponse")
                    .await?,
            ),
        };
        Ok(Response::new(response))
    }

    // --- Translation: translation model -------------------------------------

    async fn translate(
        &self,
        request: Request<pb::EncryptedTranslateRequest>,
    ) -> Result<Response<pb::EncryptedTranslateResponse>, Status> {
        self.admit(&request).await?;
        let request = request.into_inner();
        let (req, kid): (pb::TranslateRequest, _) = self.open_request(request.request).await?;
        let from = Self::locale_to_bcp47(req.from.as_ref());
        let to = Self::locale_to_bcp47(req.to.as_ref());
        let include_audio = req.include_audio;
        let prompt = format!(
            "Translate the following text from {from} to {to}. Output only the translation.\n\n{}",
            req.text
        );
        let translation = self.run_model_completion(prompt).await?;
        let mut response = pb::TranslateResponse {
            text: translation,
            audio: Vec::new(),
        };
        if !include_audio {
            response.audio = Vec::new();
        }
        let response = pb::EncryptedTranslateResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.TranslateResponse")
                    .await?,
            ),
        };
        Ok(Response::new(response))
    }

    // --- Streaming AI bus (audio processing over a bidi stream) -------------

    type EncryptedStreamAIBusStream = BoxStream<pb::EncryptedAiResponse>;

    async fn encrypted_stream_ai_bus(
        &self,
        request: Request<tonic::Streaming<pb::EncryptedAiRequest>>,
    ) -> Result<Response<Self::EncryptedStreamAIBusStream>, Status> {
        self.admit(&request).await?;
        let authenticated = crate::auth::authenticated_request(&request).cloned();
        let mut inbound = request.into_inner();
        let service = self.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            loop {
                let encrypted = match inbound.message().await {
                    Ok(Some(message)) => message,
                    Ok(None) => return,
                    Err(status) => {
                        let _ = tx.send(Err(status)).await;
                        return;
                    }
                };
                let result = async {
                    crate::pin_admission::admit(
                        &service.store,
                        service.pairing.as_ref(),
                        authenticated.as_ref(),
                    )
                    .await?;
                    let (request, kid): (pb::AiRequest, _) =
                        service.open_request(encrypted.request).await?;
                    let response = service.process_ai_request(request).await?;
                    Ok(pb::EncryptedAiResponse {
                        // AAD MUST be the exact FQ Java class name: the device runs
                        // `Class.forName(aad)` to pick the parser, so a lowercase "i"
                        // (AiResponse) throws ClassNotFoundException and the whole
                        // response is silently dropped. The real class is `AIResponse`.
                        response: Some(
                            service
                                .seal_response(&kid, &response, "humane.aibus.AIResponse")
                                .await?,
                        ),
                    })
                }
                .await;
                if tx.send(result).await.is_err() {
                    return;
                }
            }
        });
        Ok(Response::new(Box::pin(
            tokio_stream::wrappers::ReceiverStream::new(rx),
        )))
    }

    // --- Upload URL: unguessable external (presigned) state -----------------

    async fn upload_file(
        &self,
        request: Request<pb::UploadFileRequest>,
    ) -> Result<Response<pb::UploadFileResponse>, Status> {
        Ok(Response::new(
            Self::presign_upload(request.into_inner()).await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ambiance_encrypted_disconnect_cancels_blocked_cognition_and_display_wait() {
        use crate::ambiance::{
            BrowserProof, OriginProof, PrivacyClass, RuntimeOperation, RuntimeResult,
        };
        use crate::assistant::llm::{ChatResponse, LlmError, ToolCall, ToolDef};
        use prost::Message;
        struct Model {
            visual: bool,
            started: Arc<tokio::sync::Notify>,
            dropped: Arc<std::sync::atomic::AtomicBool>,
        }
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        #[tonic::async_trait]
        impl ChatModel for Model {
            async fn complete(
                &self,
                _: &[ChatMessage],
                _: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                let _drop = Dropped(self.dropped.clone());
                self.started.notify_one();
                if !self.visual {
                    std::future::pending::<()>().await;
                }
                Ok(ChatResponse { tool_call: Some(ToolCall { name: "propose_information".into(), arguments: serde_json::json!({"intent":{"kind":"visual_text_card","text":"Display fixture"},"privacy":"public"}).to_string() }), ..Default::default() })
            }
        }
        for visual in [false, true] {
            let mut service = AiBusMain::default();
            let auth = approve_test_pin(&mut service, "disconnect-owner", "abcd1234").await;
            let principal = auth.principal.expose_for_authorization();
            let started = Arc::new(tokio::sync::Notify::new());
            let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            service.runtime = Arc::new(crate::ambiance::runtime::AmbianceRuntime::new(
                service.store.clone(),
                Arc::new(Model {
                    visual,
                    started: started.clone(),
                    dropped: dropped.clone(),
                }),
                service.pairing.clone(),
            ));
            let surface_id = uuid::Uuid::new_v4();
            let incarnation = uuid::Uuid::new_v4();
            let token_hash = crate::surface_registry::hash(b"disconnect-browser-capability");
            if visual {
                service
                    .store
                    .mutate_surface(
                        principal,
                        surface_id,
                        crate::surface_registry::Mutation::Approve {
                            token_hash: token_hash.clone(),
                            incarnation,
                        },
                    )
                    .await
                    .unwrap();
                service
                    .store
                    .mutate_surface(
                        principal,
                        surface_id,
                        crate::surface_registry::Mutation::State {
                            token_hash: token_hash.clone(),
                            incarnation,
                            sequence: 1,
                            visible: true,
                        },
                    )
                    .await
                    .unwrap();
            }
            service
                .keys
                .insert("disconnect-key".into(), [12; cosmos_crypto::AES_KEY_LEN])
                .unwrap();
            let inner = pb::SynapseUnderstandingRequest {
                utterance: "Current explanation".into(),
                ..Default::default()
            };
            let sealed = service
                .keys
                .seal("disconnect-key", &inner.encode_to_vec(), b"")
                .unwrap();
            let stream = service
                .encrypted_understand(admitted_request(
                    pb::EncryptedSynapseUnderstandingRequest {
                        request: Some(cosmos_protocol::common::encryption::EncryptedData {
                            data: sealed.data,
                            encryption_information: Some(
                                cosmos_protocol::common::encryption::EncryptionInformation {
                                    kid: sealed.kid,
                                },
                            ),
                        }),
                        location: None,
                    },
                    &auth,
                ))
                .await
                .unwrap()
                .into_inner();
            tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
                .await
                .unwrap();
            let proof = || BrowserProof {
                surface_id,
                incarnation,
                token_hash: token_hash.clone(),
            };
            if visual {
                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    loop {
                        let RuntimeResult::Pending(actions) = service
                            .store
                            .runtime(
                                principal,
                                RuntimeOperation::Poll {
                                    connection: proof(),
                                },
                            )
                            .await
                            .unwrap()
                        else {
                            panic!("poll");
                        };
                        if !actions.is_empty() {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
            }
            drop(stream);
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let result = service
                        .store
                        .runtime(
                            principal,
                            RuntimeOperation::Begin {
                                turn_id: uuid::Uuid::new_v4(),
                                worker: uuid::Uuid::new_v4(),
                                origin: OriginProof::Pin {
                                    device: auth.device.clone().unwrap(),
                                    surface_id: crate::surface_registry::pin_surface_id(
                                        principal, "abcd1234",
                                    ),
                                },
                                request_digest: crate::surface_registry::hash(b"next request"),
                                privacy_floor: PrivacyClass::SharedRoom,
                            },
                        )
                        .await;
                    match result {
                        Ok(RuntimeResult::Begun(fence)) => {
                            service
                                .store
                                .runtime(
                                    principal,
                                    RuntimeOperation::Cancel {
                                        turn_id: fence.turn_id,
                                        generation: fence.generation,
                                        worker: fence.worker,
                                    },
                                )
                                .await
                                .unwrap();
                            break;
                        }
                        Err(crate::ambiance::RuntimeError::Busy) => tokio::task::yield_now().await,
                        other => panic!("unexpected admission after disconnect: {other:?}"),
                    }
                }
            })
            .await
            .expect("disconnect releases only its pending turn without waiting for the lease");
            assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn ambiance_legacy_cognition_and_raw_execution_are_unsupported_before_private_access() {
        let observed = Arc::new(crate::store::MemoryStore::default());
        let mut service = AiBusMain::default().with_store(observed.clone());
        let auth = approve_test_pin(&mut service, "wearer", "abcd1234").await;
        assert_eq!(
            service
                .function_execution(admitted_request(
                    pb::FunctionCall {
                        name: "CreateMemory".into(),
                        utterance: "PRIVATE_CANARY".into(),
                        ..Default::default()
                    },
                    &auth
                ))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unimplemented
        );
        assert_eq!(
            service
                .encrypted_function_execution(admitted_request(
                    pb::EncryptedFunctionCall::default(),
                    &auth
                ))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unimplemented
        );
        assert_eq!(
            service
                .analyze_image(admitted_request(
                    pb::AnalyzeImageRequest {
                        utterance: "PRIVATE_CANARY".into(),
                        ..Default::default()
                    },
                    &auth
                ))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unimplemented
        );
        assert_eq!(
            service
                .run_model_chat(&pb::ChatCompletionRequest::default())
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unimplemented
        );
        assert_eq!(
            service
                .run_model_completion("PRIVATE_CANARY".into())
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unimplemented
        );
        assert_eq!(
            observed
                .assistant_private_accesses
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    /// Test fixtures use the same required pairing and durable registry approval,
    /// not an admission bypass. The returned extension is transport evidence;
    /// end-to-end tests obtain it through the actual AuthLayer instead.
    async fn approve_test_pin(
        service: &mut AiBusMain,
        subject: &str,
        device_id: &str,
    ) -> crate::auth::AuthenticatedRequest {
        use crate::enrollment::EnrollmentStore;
        // Default services share the process store. Parallel wire tests must
        // not rotate another test's active approval and correctly fence it.
        let subject = format!("{subject}-{}", uuid::Uuid::new_v4());
        let pairing = Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        pairing
            .put_device_account(device_id, &subject)
            .await
            .unwrap();
        service.pairing = Some(pairing);
        let principal = cosmos_core::AuthenticatedPrincipal::for_user(&subject).unwrap();
        service
            .store
            .mutate_surface(
                principal.expose_for_authorization(),
                crate::surface_registry::pin_surface_id(
                    principal.expose_for_authorization(),
                    device_id,
                ),
                crate::surface_registry::Mutation::ApprovePin {
                    device_id: device_id.to_owned(),
                },
            )
            .await
            .unwrap();
        let response = crate::assistant::llm::ChatResponse {
            tool_call: Some(crate::assistant::llm::ToolCall {
                name: "propose_information".into(),
                arguments: serde_json::json!({"intent":{"kind":"informational_speech","text":"Fixture answer."},"privacy":"public"}).to_string(),
            }),
            ..Default::default()
        };
        service.runtime = Arc::new(crate::ambiance::runtime::AmbianceRuntime::new(
            service.store.clone(),
            Arc::new(crate::assistant::llm::MockChatModel::new(vec![
                response;
                16
            ])),
            service.pairing.clone(),
        ));
        crate::auth::AuthenticatedRequest {
            principal,
            plane: crate::auth::AuthenticationPlane::Device,
            device: Some(cosmos_core::AuthenticatedDeviceIdentity::from_edge(device_id).unwrap()),
        }
    }

    fn admitted_request<T>(
        body: T,
        authenticated: &crate::auth::AuthenticatedRequest,
    ) -> Request<T> {
        let mut request = Request::new(body);
        request
            .extensions_mut()
            .insert(authenticated.principal.clone());
        request.extensions_mut().insert(authenticated.clone());
        request
    }

    #[tokio::test]
    async fn runtime_wire_fixtures_do_not_rotate_another_parallel_tests_origin() {
        let mut first = AiBusMain::default();
        let mut second = AiBusMain::default();
        let a = approve_test_pin(&mut first, "wearer", "abcd1234").await;
        let before = crate::pin_admission::admit(&first.store, first.pairing.as_ref(), Some(&a))
            .await
            .unwrap();
        let b = approve_test_pin(&mut second, "wearer", "abcd1234").await;
        assert_ne!(a.principal, b.principal);
        let after = crate::pin_admission::admit(&first.store, first.pairing.as_ref(), Some(&a))
            .await
            .unwrap();
        assert_eq!(before.revision, after.revision);
        assert_eq!(before.surface_id, after.surface_id);
    }

    struct TestKeyPath(std::path::PathBuf);

    impl TestKeyPath {
        fn new(tag: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "cosmos-aibus-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            std::fs::create_dir_all(&directory).expect("create key scratch directory");
            Self(directory.join("keymaterial.json"))
        }
    }

    impl Drop for TestKeyPath {
        fn drop(&mut self) {
            if let Some(directory) = self.0.parent() {
                let _ = std::fs::remove_dir_all(directory);
            }
        }
    }

    #[tokio::test]
    async fn encrypted_weather_accepts_the_stock_location_envelope() {
        use prost::Message as _;

        let kid = "weather-stock-location";
        let key = [0x2au8; cosmos_crypto::AES_KEY_LEN];
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert(kid.to_owned(), key)
            .expect("insert location channel key");
        let stock_location = cosmos_protocol::common::encryption::LocationEnvelope {
            longitude: 12.5683,
            latitude: 55.6761,
            stalestatus: cosmos_protocol::common::encryption::LocationStaleStatus::NotStale as i32,
            accuracy: 10.0,
            ..Default::default()
        };
        let sealed = cosmos_crypto::seal(
            kid,
            &key,
            &stock_location.encode_to_vec(),
            b"humane.common.encryption.LocationEnvelope",
        )
        .expect("seal stock location envelope");
        let service = AiBusMain::with_key_material(keys);

        let (location, opened_kid) = service
            .open_stock_location(Some(cosmos_protocol::common::encryption::EncryptedData {
                encryption_information: Some(
                    cosmos_protocol::common::encryption::EncryptionInformation {
                        kid: kid.to_owned(),
                    },
                ),
                data: sealed.data,
            }))
            .await
            .expect("stock location envelope should decode");

        assert_eq!(opened_kid, kid);
        let coordinates = AiBusMain::weather_location_coordinates(&location)
            .expect("stock weather location should be usable");
        assert!((coordinates.latitude - 55.6761).abs() < 0.0001);
        assert!((coordinates.longitude - 12.5683).abs() < 0.0001);
    }

    #[tokio::test]
    async fn encrypted_weather_rejects_the_default_location_before_provider_lookup() {
        use prost::Message as _;

        let kid = "weather-missing-location";
        let key = [0x2bu8; cosmos_crypto::AES_KEY_LEN];
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert(kid.to_owned(), key)
            .expect("insert location channel key");
        let sealed = cosmos_crypto::seal(
            kid,
            &key,
            &cosmos_protocol::common::encryption::LocationEnvelope::default().encode_to_vec(),
            b"humane.common.encryption.LocationEnvelope",
        )
        .expect("seal default stock location envelope");
        let mut service = AiBusMain::with_key_material(keys);
        let authenticated = approve_test_pin(&mut service, "wearer", "abcd1234").await;

        let error = service
            .encrypted_weather(admitted_request(
                pb::EncryptedWeatherRequest {
                    location: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: kid.to_owned(),
                            },
                        ),
                        data: sealed.data,
                    }),
                },
                &authenticated,
            ))
            .await
            .expect_err("default location must fail before a provider lookup");

        assert_eq!(error.code(), tonic::Code::InvalidArgument);
        assert_eq!(error.message(), "missing weather location");
    }

    #[tokio::test]
    async fn empty_provider_results_seal_as_a_stock_nearby_success() {
        use prost::Message as _;

        let kid = "nearby-empty-results";
        let key = [0x39u8; cosmos_crypto::AES_KEY_LEN];
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert(kid.to_owned(), key)
            .expect("insert nearby channel key");
        let service = AiBusMain::with_key_material(keys.clone());

        for body in [
            br#"{"status":"ZERO_RESULTS","results":[]}"#.as_slice(),
            br#"{"status":"OK","results":[]}"#.as_slice(),
        ] {
            let places = crate::backends::places::decode_nearby_response(body)
                .expect("an empty provider result is a successful empty search");
            let encrypted = service
                .seal_nearby_response(kid, places)
                .await
                .expect("empty nearby results remain a successful AIBus response")
                .response
                .expect("sealed nearby response");
            let payload = keys
                .open(&cosmos_crypto::EncryptedData {
                    data: encrypted.data,
                    kid: encrypted
                        .encryption_information
                        .map(|information| information.kid)
                        .unwrap_or_default(),
                })
                .expect("nearby response opens");
            let reply = pb::NearbySearchResponse::decode(payload.as_slice())
                .expect("nearby response is valid protobuf");

            assert!(reply.nearby_places.is_empty());
            assert_eq!(reply.status, pb::NearbySearchResultStatus::Success as i32);
        }
    }

    #[test]
    fn reverse_geocode_and_navigation_keep_stock_location_policy_separate_from_weather() {
        let location = cosmos_protocol::common::encryption::LocationEnvelope {
            longitude: 12.5683,
            latitude: 55.6761,
            stalestatus: cosmos_protocol::common::encryption::LocationStaleStatus::Stale as i32,
            accuracy: 50_001.0,
            ..Default::default()
        };

        assert!(AiBusMain::stock_location_coordinates(&location).is_ok());
        assert!(AiBusMain::weather_location_coordinates(&location).is_err());
    }

    #[test]
    fn weather_rejects_the_default_location_without_rejecting_real_axis_coordinates() {
        let missing = cosmos_protocol::common::encryption::LocationEnvelope::default();
        assert!(AiBusMain::weather_location_coordinates(&missing).is_err());

        for (latitude, longitude, human_readable) in [
            (0.0, 12.5683, "equator"),
            (55.6761, 0.0, "prime meridian"),
            (0.0, 0.0, "null island"),
        ] {
            let real = cosmos_protocol::common::encryption::LocationEnvelope {
                latitude,
                longitude,
                human_readable: human_readable.into(),
                ..Default::default()
            };
            assert!(
                AiBusMain::weather_location_coordinates(&real).is_ok(),
                "valid coordinate on an axis was rejected: {latitude},{longitude}",
            );
        }
    }

    #[tokio::test]
    async fn encrypted_rpc_maps_unreadable_and_pending_key_state_before_envelope_errors() {
        use crate::keymaterial::{KeyMaterial, PersistenceFault};
        use prost::Message as _;

        let corrupt = TestKeyPath::new("corrupt-key-state");
        {
            let material = KeyMaterial::at_path(corrupt.0.clone());
            material
                .insert("held".to_owned(), [1u8; cosmos_crypto::AES_KEY_LEN])
                .expect("create protected snapshot");
        }
        // Truncating the existing file preserves the writer's exact 0600 mode,
        // so this reaches schema refusal rather than only the mode guard.
        std::fs::write(&corrupt.0, b"{ not json").expect("corrupt snapshot");
        let service =
            AiBusMain::with_key_material(Arc::new(KeyMaterial::at_path(corrupt.0.clone())));
        let error = service
            .open_request::<pb::CompletionRequest>(Some(
                cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: "held".to_owned(),
                        },
                    ),
                    data: Vec::new(),
                },
            ))
            .await
            .expect_err("unreadable state must fail before envelope classification");
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);

        let pending = TestKeyPath::new("pending-key-state");
        let kid = "pending";
        let sealed = {
            let material = KeyMaterial::at_path(pending.0.clone());
            material
                .insert(kid.to_owned(), [2u8; cosmos_crypto::AES_KEY_LEN])
                .expect("seed key");
            material
                .seal(kid, &pb::CompletionRequest::default().encode_to_vec(), b"")
                .expect("seal request")
        };
        let material = Arc::new(KeyMaterial::at_path_with_initial_fault(
            pending.0.clone(),
            PersistenceFault::DirectorySync,
        ));
        material.fail_next_persistence_at(PersistenceFault::DirectorySync);
        let service = AiBusMain::with_key_material(material);
        let request = || cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: kid.to_owned(),
                },
            ),
            data: sealed.data.clone(),
        };
        let error = service
            .open_request::<pb::CompletionRequest>(Some(request()))
            .await
            .expect_err("pending parent sync must be unavailable");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        service
            .open_request::<pb::CompletionRequest>(Some(request()))
            .await
            .expect("retry confirms durability before opening");
    }

    #[tokio::test]
    async fn encrypted_rpc_maps_pending_seal_durability_to_unavailable() {
        use crate::keymaterial::{KeyMaterial, PersistenceFault};

        let pending = TestKeyPath::new("pending-seal-state");
        let kid = "pending-seal";
        {
            let material = KeyMaterial::at_path(pending.0.clone());
            material
                .insert(kid.to_owned(), [3u8; cosmos_crypto::AES_KEY_LEN])
                .expect("seed key");
        }
        let material = Arc::new(KeyMaterial::at_path_with_initial_fault(
            pending.0.clone(),
            PersistenceFault::DirectorySync,
        ));
        material.fail_next_persistence_at(PersistenceFault::DirectorySync);
        let service = AiBusMain::with_key_material(material);
        let error = service
            .seal_response(
                kid,
                &pb::CompletionResponse::default(),
                "humane.aibus.CompletionResponse",
            )
            .await
            .expect_err("pending seal must not be called envelope corruption");
        assert_eq!(error.code(), tonic::Code::Unavailable);
        service
            .seal_response(
                kid,
                &pb::CompletionResponse::default(),
                "humane.aibus.CompletionResponse",
            )
            .await
            .expect("retry confirms durability before sealing");
    }

    #[test]
    fn wearer_facing_fallbacks_have_no_model_or_assistant_persona() {
        let forbidden = [
            "language model",
            "deployment",
            "provider",
            "backend",
            "as an ai",
            "i ",
            "i'm",
            "i've",
            "sorry",
        ];
        for text in [
            NO_COMPLETION,
            VISION_UNAVAILABLE,
            AUDIO_TRANSCRIPTION_UNAVAILABLE,
            LOADING_MUSIC_CUE,
            LOADING_WEATHER_CUE,
        ] {
            let lower = text.to_ascii_lowercase();
            assert!(
                forbidden.iter().all(|term| !lower.contains(term)),
                "wearer-facing fallback exposes persona or deployment jargon: {text:?}",
            );
        }
    }

    #[test]
    fn loading_cues_use_bounded_deterministic_categories() {
        let music = loading_message_for(
            "Queue the definitive dance-floor hit from the King of Pop.",
            true,
        );
        assert_eq!(music.loading_message, "Finding music...");
        assert_eq!(music.verbal_message, "Finding music.");

        let weather = loading_message_for("Will I need an umbrella before dinner?", true);
        assert_eq!(weather.loading_message, "Checking the weather...");
        assert_eq!(weather.verbal_message, "Checking the weather.");

        for (utterance, is_unlocked) in [
            ("Put the current track on hold for a moment.", true),
            ("Use what you remember about my commute.", false),
            ("Tell me something interesting.", true),
        ] {
            assert_eq!(
                loading_message_for(utterance, is_unlocked),
                pb::LoadingMessageResponse::default(),
            );
        }
    }

    /// The real router, AuthLayer, stock envelopes, and both model loops must
    /// preserve the same provenance. Everything here is loopback/in-memory;
    /// no configured model, deployment key, database, or physical Pin is used.
    #[tokio::test]
    async fn device_provenance_reaches_plaintext_encrypted_and_bidi_model_contexts() {
        use crate::assistant::llm::{ChatResponse, LlmError, Role, ToolDef};
        use crate::auth::{AuthLayer, RequestAuthenticator};
        use crate::config::{
            Authentication, EDGE_PRINCIPAL_HEADER, EDGE_TOKEN_HEADER, EdgeAuthentication,
        };
        use prost::Message as _;
        use std::time::Duration;
        use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};

        #[derive(Default)]
        struct ProvenanceModel(std::sync::Mutex<Vec<Vec<ChatMessage>>>);

        #[tonic::async_trait]
        impl ChatModel for ProvenanceModel {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                tools: &[ToolDef],
            ) -> Result<ChatResponse, LlmError> {
                assert_eq!(tools.len(), 1);
                assert_eq!(tools[0].name, "propose_information");
                self.0.lock().unwrap().push(messages.to_vec());
                Ok(ChatResponse {
                    tool_call: Some(crate::assistant::llm::ToolCall { name: "propose_information".into(), arguments: serde_json::json!({"intent":{"kind":"informational_speech","text":"Hello."},"privacy":"public"}).to_string() }),
                    ..Default::default()
                })
            }
        }

        fn authenticated<T>(body: T) -> Request<T> {
            let mut request = Request::new(body);
            request.metadata_mut().insert(
                EDGE_PRINCIPAL_HEADER,
                "Subject=\"CN=V:01:D:2c2a00010000abcd:U:provenance-wearer-fixture,O=Humane\""
                    .parse()
                    .unwrap(),
            );
            request.metadata_mut().insert(
                EDGE_TOKEN_HEADER,
                "provenance-model-test-edge".parse().unwrap(),
            );
            // Unrelated claims cannot upgrade transport evidence to a private
            // channel or an authenticated actor.
            request
                .metadata_mut()
                .insert("x-origin-privacy", "private".parse().unwrap());
            request
        }

        fn understanding() -> pb::SynapseUnderstandingRequest {
            pb::SynapseUnderstandingRequest {
                utterance: "hello".to_owned(),
                ..Default::default()
            }
        }

        let model = Arc::new(ProvenanceModel::default());
        let observed_store = Arc::new(crate::store::MemoryStore::default());
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert(
            "provenance-test-kid".to_owned(),
            [7; cosmos_crypto::AES_KEY_LEN],
        )
        .unwrap();
        let pairing: crate::enrollment::SharedEnrollmentStore =
            Arc::new(crate::enrollment::MemoryEnrollmentStore::default());
        let runtime = Arc::new(crate::ambiance::runtime::AmbianceRuntime::new(
            observed_store.clone(),
            model.clone(),
            Some(pairing.clone()),
        ));
        let service = AiBusMain {
            runtime,
            keys: keys.clone(),
            directory: None,
            store: observed_store.clone(),
            pairing: Some(pairing),
        };
        let store = service.store.clone();
        let pairing = service.pairing.clone().unwrap();
        let subject = "provenance-wearer-fixture";
        let device = "2c2a00010000abcd";
        let principal = cosmos_core::AuthenticatedPrincipal::for_user(subject).unwrap();
        let principal = principal.expose_for_authorization();
        let surface_id = crate::surface_registry::pin_surface_id(principal, device);
        pairing.put_device_account(device, subject).await.unwrap();
        let (_, public) = crate::web_auth::test_jwt_keypair();
        let web = crate::web_auth::JwtVerifier::with_keys(
            crate::web_auth::OidcConfig {
                issuer: "https://pin-admission.test".into(),
                audience: None,
                jwks_uri: "unused".into(),
            },
            [(
                "pin-test".into(),
                jsonwebtoken::DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(),
            )]
            .into(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .layer(AuthLayer::new(
                    RequestAuthenticator::new(Authentication::EdgeAuthenticated(
                        EdgeAuthentication::with_test_token("provenance-model-test-edge"),
                    ))
                    .with_web(web),
                ))
                .add_service(pb::ai_bus_service_server::AiBusServiceServer::new(service))
                .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                    let _ = shutdown_rx.await;
                })
                .await
                .unwrap();
        });
        let mut client = tokio::time::timeout(
            Duration::from_secs(5),
            pb::ai_bus_service_client::AiBusServiceClient::connect(format!("http://{address}")),
        )
        .await
        .expect("the loopback assistant client connects promptly")
        .unwrap();

        tokio::time::timeout(Duration::from_secs(10), async {
            for state in ["unapproved", "revoked", "transferred", "unpaired"] {
                if state != "unapproved" {
                    store
                        .mutate_surface(
                            principal,
                            surface_id,
                            crate::surface_registry::Mutation::ApprovePin {
                                device_id: device.into(),
                            },
                        )
                        .await
                        .unwrap();
                }
                match state {
                    "revoked" => {
                        store
                            .mutate_surface(
                                principal,
                                surface_id,
                                crate::surface_registry::Mutation::RevokePin,
                            )
                            .await
                            .unwrap();
                    }
                    "transferred" => {
                        pairing
                            .put_device_account(device, "other-owner")
                            .await
                            .unwrap();
                    }
                    "unpaired" => {
                        pairing
                            .delete_device_account(device, "other-owner")
                            .await
                            .unwrap();
                    }
                    _ => (),
                }
                assert_eq!(
                    client
                        .understand(authenticated(understanding()))
                        .await
                        .unwrap_err()
                        .code(),
                    tonic::Code::PermissionDenied,
                    "{state}"
                );
                assert_eq!(
                    client
                        .encrypted_understand(authenticated(
                            pb::EncryptedSynapseUnderstandingRequest::default()
                        ))
                        .await
                        .unwrap_err()
                        .code(),
                    tonic::Code::PermissionDenied,
                    "{state}"
                );
                assert_eq!(
                    client
                        .bidirectional_streaming_understand(authenticated(tokio_stream::empty::<
                            pb::StreamingUnderstandRequest,
                        >(
                        )))
                        .await
                        .unwrap_err()
                        .code(),
                    tonic::Code::PermissionDenied,
                    "{state}"
                );
                assert_eq!(
                    client
                        .encrypted_stream_ai_bus(authenticated(tokio_stream::empty::<
                            pb::EncryptedAiRequest,
                        >()))
                        .await
                        .unwrap_err()
                        .code(),
                    tonic::Code::PermissionDenied,
                    "{state}"
                );
                assert_eq!(
                    client
                        .function_execution(authenticated(pb::FunctionCall {
                            name: "CreateMemory".into(),
                            utterance: "denied-canary".into(),
                            ..Default::default()
                        }))
                        .await
                        .unwrap_err()
                        .code(),
                    tonic::Code::PermissionDenied,
                    "{state}"
                );
                assert!(model.0.lock().unwrap().is_empty());
                macro_rules! denied {
                    ($method:ident, $body:ty) => {
                        assert_eq!(
                            client
                                .$method(authenticated(<$body>::default()))
                                .await
                                .unwrap_err()
                                .code(),
                            tonic::Code::PermissionDenied,
                            "{}: {state}",
                            stringify!($method)
                        );
                    };
                }
                denied!(
                    server_stateful_understand,
                    pb::ServerStatefulUnderstandRequest
                );
                denied!(encrypted_completion, pb::EncryptedCompletionRequest);
                denied!(
                    encrypted_chat_completion,
                    pb::EncryptedChatCompletionRequest
                );
                denied!(analyze_image, pb::AnalyzeImageRequest);
                denied!(encrypted_analyze_image, pb::EncryptedAnalyzeImageRequest);
                denied!(
                    encrypted_analyze_food_image,
                    pb::EncryptedAnalyzeFoodImageRequest
                );
                denied!(
                    encrypted_action_based_interstitial,
                    pb::EncryptedActionBasedInterstitialRequest
                );
                denied!(
                    encrypted_loading_message,
                    pb::EncryptedLoadingMessageRequest
                );
                denied!(encrypted_function_execution, pb::EncryptedFunctionCall);
                denied!(encrypted_geo_locate, pb::EncryptedGeoLocateRequest);
                denied!(
                    encrypted_reverse_geocode,
                    pb::EncryptedReverseGeocodeRequest
                );
                denied!(
                    encrypted_navigation_directions,
                    pb::EncryptedNavigationDirectionsRequest
                );
                denied!(encrypted_nearby_search, pb::EncryptedNearbySearchRequest);
                denied!(encrypted_weather, pb::EncryptedWeatherRequest);
                denied!(encrypted_get_food_item, pb::EncryptedGetFoodItemRequest);
                denied!(encrypted_smart_playlist, pb::EncryptedSmartPlaylistRequest);
                denied!(translate, pb::EncryptedTranslateRequest);
            }
            pairing.put_device_account(device, subject).await.unwrap();
            store
                .mutate_surface(
                    principal,
                    surface_id,
                    crate::surface_registry::Mutation::ApprovePin {
                        device_id: device.into(),
                    },
                )
                .await
                .unwrap();
            // An authenticated account without full DeviceUser provenance is
            // not the approved Pin, even with the same claimed account.
            let mut no_device = authenticated(understanding());
            no_device.metadata_mut().insert(
                EDGE_PRINCIPAL_HEADER,
                "U:provenance-wearer-fixture".parse().unwrap(),
            );
            assert_eq!(
                client.understand(no_device).await.unwrap_err().code(),
                tonic::Code::PermissionDenied
            );
            let mut mixed = authenticated(understanding());
            mixed
                .metadata_mut()
                .insert("authorization", "Bearer invalid".parse().unwrap());
            assert_eq!(
                client.understand(mixed).await.unwrap_err().code(),
                tonic::Code::Unauthenticated
            );
            assert!(model.0.lock().unwrap().is_empty());
        })
        .await
        .expect("denied transport requests terminate before models or tools");
        assert_eq!(
            observed_store
                .assistant_private_accesses
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "denied requests cannot preload private notes, write notes, or read account context"
        );

        tokio::time::timeout(Duration::from_secs(5), async {
            let mut plaintext = client
                .understand(authenticated(understanding()))
                .await
                .unwrap()
                .into_inner();
            let mut plaintext_count = 0;
            while plaintext.message().await.unwrap().is_some() {
                plaintext_count += 1;
            }
            assert!(plaintext_count > 0);

            let sealed = keys
                .seal("provenance-test-kid", &understanding().encode_to_vec(), b"")
                .unwrap();
            let mut encrypted = client
                .encrypted_understand(authenticated(pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: sealed.kid,
                            },
                        ),
                        data: sealed.data,
                    }),
                    location: None,
                }))
                .await
                .unwrap()
                .into_inner();
            let mut encrypted_count = 0;
            while let Some(response) = encrypted.message().await.unwrap() {
                let envelope = response.response.unwrap();
                let opened = keys
                    .open(&cosmos_crypto::EncryptedData {
                        data: envelope.data,
                        kid: envelope.encryption_information.unwrap().kid,
                    })
                    .unwrap();
                pb::SynapseUnderstandingResponse::decode(opened.as_slice()).unwrap();
                encrypted_count += 1;
            }
            assert!(encrypted_count > 0);

            let (input_tx, input_rx) = tokio::sync::mpsc::channel(2);
            input_tx
                .send(pb::StreamingUnderstandRequest {
                    content: Some(
                        pb::streaming_understand_request::Content::UnderstandingRequest(
                            understanding(),
                        ),
                    ),
                })
                .await
                .unwrap();
            let mut bidi = client
                .bidirectional_streaming_understand(authenticated(ReceiverStream::new(input_rx)))
                .await
                .unwrap()
                .into_inner();
            assert!(bidi.message().await.unwrap().is_some());
            drop(input_tx);
            while bidi.message().await.unwrap().is_some() {}
        })
        .await
        .expect("all three in-memory assistant exchanges finish promptly");
        drop(client);
        shutdown_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();

        let seen = model.0.lock().unwrap();
        assert_eq!(
            observed_store
                .assistant_private_accesses
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "admitted turns never preload private data"
        );
        assert_eq!(seen.len(), 3);
        for messages in seen.iter() {
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0].role, Role::System);
            assert_eq!(messages[1].role, Role::User);
            assert_eq!(messages[1].content, "hello");
            for message in messages {
                assert!(!message.content.contains("provenance-wearer-fixture"));
                assert!(!message.content.contains("2c2a00010000abcd"));
            }
        }
    }

    #[test]
    fn device_provenance_tool_context_does_not_infer_evidence_from_headers_or_principal() {
        let mut request = Request::new(pb::SynapseUnderstandingRequest::default());
        request
            .extensions_mut()
            .insert(cosmos_core::AuthenticatedPrincipal::from_edge("V:01:D:abcd:U:owner").unwrap());
        request.metadata_mut().insert(
            crate::config::EDGE_PRINCIPAL_HEADER,
            "Subject=\"CN=V:01:D:abcd:U:owner\"".parse().unwrap(),
        );
        let tools = AiBusMain::default().tool_context(&request);
        assert_eq!(tools.principal.as_deref(), Some("V:01:D:abcd:U:owner"));
        assert!(tools.authenticated_request.is_none());
    }

    #[test]
    fn food_item_responses_assign_fresh_stock_request_uuids() {
        let matched = food_item_response(
            Ok(crate::backends::food::FoodLookup {
                item_name: "apple".to_owned(),
                brand: String::new(),
                barcode: String::new(),
                serving_size: "one apple".to_owned(),
                ingredients: Vec::new(),
                nutrition: Vec::new(),
            }),
            "apple",
        )
        .expect("a matched food response succeeds")
        .best_food_item
        .expect("a matched response has a best item");
        let fallback = food_item_response(
            Err(crate::backends::BackendError::NoResult),
            "unknown fruit",
        )
        .expect("a no-match food response keeps the stock fallback")
        .best_food_item
        .expect("a no-match response has a fallback item");

        for request_uuid in [&matched.request_uuid, &fallback.request_uuid] {
            let parsed = uuid::Uuid::parse_str(request_uuid)
                .expect("Food request_uuid must be a stock-compatible UUID");
            assert_eq!(parsed.get_version_num(), 4);
        }
        assert_ne!(matched.request_uuid, fallback.request_uuid);
    }

    #[tokio::test]
    async fn food_plaintext_compatibility_rejects_oversize_and_near_match_kids() {
        use prost::Message as _;

        let svc = AiBusMain::default();

        for (kid, maximum_bytes) in [
            (FOOD_CHAT_REQUEST_KID, MAX_FOOD_CHAT_REQUEST_BYTES),
            (FOOD_ITEM_REQUEST_KID, MAX_FOOD_ITEM_REQUEST_BYTES),
            (FOOD_IMAGE_REQUEST_KID, MAX_FOOD_IMAGE_REQUEST_BYTES),
        ] {
            let error = svc
                .open_food_request::<pb::ChatCompletionRequest>(
                    Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: kid.to_owned(),
                            },
                        ),
                        data: vec![0; maximum_bytes + 1],
                    }),
                    kid,
                    FOOD_CHAT_RESPONSE_KID,
                    maximum_bytes,
                )
                .await
                .expect_err("an oversized plaintext Food envelope must be rejected");
            assert_eq!(error.code(), tonic::Code::InvalidArgument);
        }

        let error = svc
            .open_food_request::<pb::ChatCompletionRequest>(
                Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: format!("{FOOD_CHAT_REQUEST_KID}.near-match"),
                        },
                    ),
                    data: pb::ChatCompletionRequest::default().encode_to_vec(),
                }),
                FOOD_CHAT_REQUEST_KID,
                FOOD_CHAT_RESPONSE_KID,
                MAX_FOOD_CHAT_REQUEST_BYTES,
            )
            .await
            .expect_err("a near-match KID must stay on the encrypted path");
        assert_eq!(error.code(), tonic::Code::Unavailable);
    }

    /// The encrypted assistant path is the RPC a stock Pin actually uses: seal a
    /// real `SynapseUnderstandingRequest` under an established channel key, and
    /// every streamed response must come back sealed under the same kid and open
    /// to a well-formed runtime action, matching plaintext Understand.
    #[tokio::test]
    async fn encrypted_understand_round_trips_a_real_envelope() {
        use prost::Message as _;
        use tokio_stream::StreamExt;

        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("kid-test".to_owned(), [3u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let mut svc = AiBusMain::with_key_material(keys.clone());
        let authenticated = approve_test_pin(&mut svc, "wearer", "abcd1234").await;

        // Device side: seal a real request under the channel key.
        let inner = pb::SynapseUnderstandingRequest {
            utterance: "hello".to_owned(),
            ..Default::default()
        };
        let sealed = keys
            .seal("kid-test", &inner.encode_to_vec(), b"")
            .expect("seal request");

        let stream = svc
            .encrypted_understand(admitted_request(
                pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: sealed.kid.clone(),
                            },
                        ),
                        data: sealed.data,
                    }),
                    location: None,
                },
                &authenticated,
            ))
            .await
            .map_err(|e| format!("encrypted stream: {e}"))
            .unwrap()
            .into_inner();

        let msgs: Vec<_> = stream.collect::<Vec<_>>().await;
        assert!(!msgs.is_empty(), "encrypted turn must stream");

        // Open every response and confirm it is the real transcript.
        let mut saw_respond = false;
        for m in msgs {
            let env = m.expect("ok message").response.expect("sealed body");
            let opened = keys
                .open(&cosmos_crypto::EncryptedData {
                    data: env.data,
                    kid: env
                        .encryption_information
                        .map(|i| i.kid)
                        .unwrap_or_default(),
                })
                .expect("responses are sealed under the established key");
            let decoded =
                pb::SynapseUnderstandingResponse::decode(opened.as_slice()).expect("valid turn");
            if let Some(pb::synapse_understanding_response::Body::Turn(t)) = &decoded.body {
                if let Some(pb::synapse_chat_turn::Content::Action(a)) = &t.content {
                    if a.action == "Respond" {
                        saw_respond = true;
                    }
                }
            }
        }
        assert!(saw_respond, "encrypted turn ends in a terminal Respond");
    }

    #[tokio::test]
    async fn encrypted_understand_uses_the_authoritative_directory_with_no_local_key() {
        use prost::Message as _;
        use tokio_stream::StreamExt as _;

        let kid = "directory-only-understand";
        let key = [0x36; cosmos_crypto::AES_KEY_LEN];
        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        directory.put(kid, key).await.expect("seed authority");
        let local: crate::keymaterial::SharedKeyMaterial = Default::default();
        let mut svc = AiBusMain::with_key_material(local.clone()).with_key_directory(directory);
        let authenticated = approve_test_pin(&mut svc, "wearer", "abcd1234").await;
        let inner = pb::SynapseUnderstandingRequest {
            utterance: "hello".to_owned(),
            ..Default::default()
        };
        let sealed = cosmos_crypto::seal(kid, &key, &inner.encode_to_vec(), b"")
            .expect("seal directory-only request");

        let messages = svc
            .encrypted_understand(admitted_request(
                pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: kid.to_owned(),
                            },
                        ),
                        data: sealed.data,
                    }),
                    location: None,
                },
                &authenticated,
            ))
            .await
            .expect("directory row opens request")
            .into_inner()
            .collect::<Vec<_>>()
            .await;
        assert!(!messages.is_empty());
        for message in messages {
            let envelope = message
                .expect("stream item")
                .response
                .expect("sealed response");
            let opened = cosmos_crypto::open(
                &key,
                &cosmos_crypto::EncryptedData {
                    data: envelope.data,
                    kid: envelope
                        .encryption_information
                        .map(|information| information.kid)
                        .unwrap_or_default(),
                },
            )
            .expect("directory key seals every response");
            pb::SynapseUnderstandingResponse::decode(opened.as_slice())
                .expect("well-formed response");
        }
        assert!(local.is_empty().expect("inspect local state"));
    }

    #[tokio::test]
    async fn encrypted_request_waits_for_a_concurrent_channel_key_import() {
        use prost::Message as _;
        use std::time::Duration;

        let kid = "d=;u=;s=ai_bus.nearby;a=;first-use;race";
        let key = [0x5a; cosmos_crypto::AES_KEY_LEN];
        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let service = AiBusMain::default().with_key_directory(directory.clone());
        let payload = pb::NearbySearchRequest {
            text_query: "coffee".to_owned(),
            location: Some(pb::Location {
                latitude: 55.0,
                longitude: 12.0,
            }),
            radius_accuracy: 1_000.0,
        };
        let sealed = cosmos_crypto::seal(kid, &key, &payload.encode_to_vec(), b"")
            .expect("seal first-use request");

        let import = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            directory.put(kid, key).await.expect("import channel key");
        });
        let (opened, opened_kid) = service
            .open_request::<pb::NearbySearchRequest>(Some(
                cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: kid.to_owned(),
                        },
                    ),
                    data: sealed.data,
                },
            ))
            .await
            .expect("the request should observe the concurrent import");
        import.await.expect("import task completes");

        assert_eq!(opened_kid, kid);
        assert_eq!(opened, payload);
    }

    #[tokio::test]
    async fn encrypted_understand_maps_authority_lookup_failure_to_unavailable() {
        use crate::keydirectory::DirectoryFault;

        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        directory.fail_next(DirectoryFault::Get);
        let mut svc = AiBusMain::default().with_key_directory(directory);
        let authenticated = approve_test_pin(&mut svc, "wearer", "abcd1234").await;
        let result = svc
            .encrypted_understand(admitted_request(
                pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: "unavailable-directory".to_owned(),
                            },
                        ),
                        data: Vec::new(),
                    }),
                    location: None,
                },
                &authenticated,
            ))
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("an unavailable authority must not start a response stream"),
        };
        assert_eq!(error.code(), tonic::Code::Unavailable);
    }

    /// A real Pin's `decryptProto` resolves the payload class from the envelope's
    /// AAD, so an empty AAD cannot be opened at all — and because AAD is
    /// authenticated, binding it to the response type also stops an envelope from
    /// being replayed into a different RPC.
    #[tokio::test]
    async fn sealed_responses_are_bound_to_their_response_type() {
        use prost::Message as _;
        use tokio_stream::StreamExt;

        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("kid-test".to_owned(), [5u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let mut svc = AiBusMain::with_key_material(keys.clone());
        let authenticated = approve_test_pin(&mut svc, "wearer", "abcd1234").await;

        let inner = pb::SynapseUnderstandingRequest {
            utterance: "hello".to_owned(),
            ..Default::default()
        };
        let sealed = keys
            .seal("kid-test", &inner.encode_to_vec(), b"")
            .expect("seal request");
        let stream = svc
            .encrypted_understand(admitted_request(
                pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: sealed.kid.clone(),
                            },
                        ),
                        data: sealed.data,
                    }),
                    location: None,
                },
                &authenticated,
            ))
            .await
            .map_err(|e| format!("encrypted stream: {e}"))
            .unwrap()
            .into_inner();

        let msgs: Vec<_> = stream.collect::<Vec<_>>().await;
        assert!(!msgs.is_empty());
        for m in msgs {
            let env = m.expect("ok message").response.expect("sealed body");
            let kid = env
                .encryption_information
                .map(|i| i.kid)
                .unwrap_or_default();
            let enc = cosmos_crypto::EncryptedData {
                data: env.data,
                kid,
            };
            // The envelope names its payload type. An empty AAD cannot be
            // opened by a real Pin at all (`Class.forName("")` fails), and
            // because AAD is authenticated, binding it to the response type also
            // stops the envelope being replayed into a different RPC.
            let aad = cosmos_crypto::envelope_aad(&enc.data).expect("readable envelope");
            assert_eq!(
                String::from_utf8_lossy(&aad),
                "humane.aibus.SynapseUnderstandingResponse"
            );
            assert!(!aad.is_empty(), "an empty AAD is unopenable on device");
            // And it still opens under its channel key.
            assert!(keys.open(&enc).is_ok());
        }
    }

    /// With no key exchange done, the encrypted path reports that precisely
    /// instead of pretending the envelope was malformed — and as a channel
    /// failure, which is what the client itself emits for the mirror-image
    /// condition (`aibus/AIBusService.java:241`).
    #[tokio::test]
    async fn encrypted_understand_without_a_channel_key_is_a_channel_failure() {
        let mut svc = AiBusMain::default();
        let authenticated = approve_test_pin(&mut svc, "wearer", "abcd1234").await;
        let err = svc
            .encrypted_understand(admitted_request(
                pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData::default()),
                    location: None,
                },
                &authenticated,
            ))
            .await;
        let err = match err {
            Err(e) => e,
            Ok(_) => panic!("must not stream without an established channel key"),
        };
        assert_eq!(err.code(), tonic::Code::Unavailable);
        assert!(err.message().contains("channel key"));
    }

    /// UNAUTHENTICATED and PERMISSION_DENIED are account verdicts on this wire,
    /// not generic auth codes.
    ///
    /// `intent/interpreters/RemoteInterpreter.java:81-96` branches on the status
    /// code ALONE — no message, no trailers — and turns UNAUTHENTICATED into
    /// `Errors.unsubscribed()` (the `InvalidSubscription` experience) and
    /// PERMISSION_DENIED into `Errors.deviceBlocked()` (`UnauthorizedDevice`). So
    /// a crypto or transport fault that borrows either code is narrated to the
    /// wearer as a billing or lost-device verdict. Both stay reserved for
    /// `gates::unsubscribed_status` / `gates::unauthorized_device_status`, which
    /// additionally contain the trailer the device's
    /// `AccountAuthorizationInterceptor` requires before it persists the verdict.
    #[tokio::test]
    async fn account_status_codes_are_reserved_for_entitlement_verdicts() {
        use prost::Message as _;

        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("kid-test".to_owned(), [7u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let mut svc = AiBusMain::with_key_material(keys.clone());
        let authenticated = approve_test_pin(&mut svc, "wearer", "abcd1234").await;

        // Every envelope/channel fault on this service, plus its no-key case.
        let mut faults: Vec<(&str, Status)> = Vec::new();

        // Unopenable envelope on the RPC a stock Pin actually uses.
        let corrupt = cosmos_protocol::common::encryption::EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation {
                    kid: "kid-test".to_owned(),
                },
            ),
            data: b"not a real envelope".to_vec(),
        };
        faults.push((
            "encrypted_understand / corrupt envelope",
            svc.encrypted_understand(admitted_request(
                pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(corrupt.clone()),
                    location: None,
                },
                &authenticated,
            ))
            .await
            .err()
            .expect("a corrupt envelope must not stream"),
        ));

        // The shared `open_request` path every other `Encrypted*` tool RPC uses.
        faults.push((
            "encrypted_completion / corrupt envelope",
            svc.encrypted_completion(admitted_request(
                pb::EncryptedCompletionRequest {
                    request: Some(corrupt),
                },
                &authenticated,
            ))
            .await
            .expect_err("a corrupt envelope must not answer"),
        ));

        // An envelope sealed under a key this deployment does not hold.
        let stranger: crate::keymaterial::SharedKeyMaterial = Default::default();
        stranger
            .insert("kid-test".to_owned(), [9u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert stranger test channel key");
        let foreign = stranger
            .seal(
                "kid-test",
                &pb::SynapseUnderstandingRequest::default().encode_to_vec(),
                b"",
            )
            .expect("seal under the stranger's key");
        faults.push((
            "encrypted_understand / foreign key",
            svc.encrypted_understand(admitted_request(
                pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData {
                        encryption_information: Some(
                            cosmos_protocol::common::encryption::EncryptionInformation {
                                kid: foreign.kid,
                            },
                        ),
                        data: foreign.data,
                    }),
                    location: None,
                },
                &authenticated,
            ))
            .await
            .err()
            .expect("a foreign envelope must not stream"),
        ));

        // No key exchange at all.
        let mut no_keys = AiBusMain::default();
        let no_keys_authenticated = approve_test_pin(&mut no_keys, "wearer", "abcd1234").await;
        faults.push(
            (
                "encrypted_understand / no channel key",
                no_keys
                    .encrypted_understand(admitted_request(
                        pb::EncryptedSynapseUnderstandingRequest {
                            request: Some(
                                cosmos_protocol::common::encryption::EncryptedData::default(),
                            ),
                            location: None,
                        },
                        &no_keys_authenticated,
                    ))
                    .await
                    .err()
                    .expect("no channel key must not stream"),
            ),
        );

        for (what, status) in &faults {
            assert_ne!(
                status.code(),
                tonic::Code::Unauthenticated,
                "{what}: UNAUTHENTICATED narrates InvalidSubscription to the wearer"
            );
            assert_ne!(
                status.code(),
                tonic::Code::PermissionDenied,
                "{what}: PERMISSION_DENIED narrates UnauthorizedDevice to the wearer"
            );
            // And it must be a code the client actually maps: an unmapped code is
            // rethrown, swallowed by `InterpreterOrchestrator`, and the turn ends
            // in silence.
            assert_eq!(
                status.code(),
                tonic::Code::Unavailable,
                "{what}: channel faults report as UNAVAILABLE, like the client's own"
            );
            // Nothing here may contain an account trailer either.
            assert!(
                status
                    .metadata()
                    .get(crate::services::gates::SUBSCRIPTION_STATUS_METADATA)
                    .is_none()
                    && status
                        .metadata()
                        .get(crate::services::gates::UNAUTHORIZED_DEVICE_METADATA)
                        .is_none(),
                "{what}: no account trailer on a channel fault"
            );
        }

        // The other half of the rule: the real entitlement paths DO still emit the
        // account codes, with their trailers. Losing that would make this test
        // pass for the wrong reason.
        let unsubscribed = crate::services::gates::unsubscribed_status(
            cosmos_protocol::account::SubscriptionStatusCode::Suspended,
        );
        assert_eq!(unsubscribed.code(), tonic::Code::Unauthenticated);
        assert!(
            unsubscribed
                .metadata()
                .get(crate::services::gates::SUBSCRIPTION_STATUS_METADATA)
                .is_some()
        );
        let unauthorized = crate::services::gates::unauthorized_device_status(&[
            cosmos_protocol::account::UnauthorizedStatusCode::DeviceLostOrStolen,
        ]);
        assert_eq!(unauthorized.code(), tonic::Code::PermissionDenied);
        assert!(
            unauthorized
                .metadata()
                .get(crate::services::gates::UNAUTHORIZED_DEVICE_METADATA)
                .is_some()
        );
    }

    /// The bidi transport must get the same per-request state the other two
    /// transports resolve. It previously got neither, so it served every caller as
    /// fully subscribed and its server tools had no wearer to read for.
    ///
    /// Driven through `BidiSession::spawn_with` because a `tonic::Streaming` can
    /// only be built by a live connection; the handler's own call site passes the
    /// same two values, and they are required parameters, so it cannot skip them.

    #[test]
    fn image_payloads_become_in_memory_data_urls() {
        let png = AiBusMain::image_data_url(b"\x89PNG\r\n\x1a\nbody").expect("data URL");
        assert!(png.starts_with("data:image/png;base64,"));
        assert!(
            !png.contains("body"),
            "raw image bytes must not leak into JSON"
        );

        let err = AiBusMain::analyze_image_data_url(&pb::AnalyzeImageRequest::default())
            .expect_err("missing image must be rejected before calling a provider");
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn upload_requires_a_real_use_case_before_contacting_a_signer() {
        let mut service = AiBusMain::default();
        let authenticated = approve_test_pin(&mut service, "wearer", "abcd1234").await;
        let err = service
            .upload_file(admitted_request(
                pb::UploadFileRequest::default(),
                &authenticated,
            ))
            .await
            .expect_err("unset upload must not mint a placeholder URL");
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }
}
