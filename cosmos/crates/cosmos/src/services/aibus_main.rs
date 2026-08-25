//! `humane.aibus.AIBusService` — the assistant itself (streaming ReAct) plus the
//! per-turn cloud tools it drives (vision, completion, translation, navigation,
//! weather, nearby/food lookups, geolocation, smart playlists, TTS-adjacent
//! audio processing).
//!
//! This is the one service in the clone whose real behavior *cannot* be faked:
//! almost every RPC needs a server-side LLM, an image/vision model, real Krypton
//! envelope crypto, or unguessable external state (a Google geolocation result,
//! a Places/Directions answer, a presigned upload URL). Per RUNTIME-CONTRACTS §3
//! the server owns the model and the tool catalog keyed by `tool_set_version`;
//! the device sends `action_definitions`/`example_sessions` empty and expects the
//! cloud to supply them. This clean-room service supplies its own model, prompts,
//! tool catalog, provider adapters, and real encrypted envelopes. Capabilities
//! with no configured provider fail explicitly instead of fabricating an answer,
//! token, upload URL, or audio payload.
//!
//! `Understand` drives the clone's own ReAct engine (`assistant::engine`)
//! over our own model, prompts, and tool catalog, and streams the transcript
//! nodes plus a terminal `Respond` DEVICE action (the wire shape cosmos's legacy
//! consumer actually dispatches and speaks) in cosmos's server-stream shape. With
//! no model configured it still completes a well-formed turn with a brief retry
//! response, rather than inventing facts or exposing deployment internals.
//! Completion/chat streams, vision, places/weather, translation, playlists, and
//! upload signing also run when their clone-owned providers are configured.
//! Audio processing remains an explicit per-message precondition failure until a
//! speech provider exists. `ActionExecutionTest` reports through its
//! `success`/`error_message` channel when a queried action backend is not hosted.
//! `TranscriptionRepairTest` performs the identity (no-op) repair, echoing
//! the client's own transcription back — the faithful result when no repair model
//! is present. It never invents corrected text.
//!
//! Authentication is enforced at the mTLS edge (the DeviceUser client cert /
//! `X-Forwarded-Client-Cert` principal, per RUNTIME-CONTRACTS §2); this handler
//! trusts the already-authenticated channel and holds no per-device state beyond
//! the shared assistant engine, matching the `Provisioning` / `account` gate idiom.

use cosmos_protocol::aibus as pb;

use base64::Engine as _;
use pb::ai_bus_service_server::AiBusService;
use tonic::{Request, Response, Status};

use crate::assistant::catalog;
use crate::assistant::llm::{ChatMessage, ChatModel, ConfiguredChatModel};
#[cfg(test)]
use std::sync::Arc;

/// Concrete erased stream type used by the server-stream and bidi RPCs.
type BoxStream<T> = std::pin::Pin<
    Box<dyn tonic::codegen::tokio_stream::Stream<Item = Result<T, Status>> + Send + 'static>,
>;

/// The device never completed the ephemeral key exchange for this capability.
const NO_CHANNEL_KEY: &str = "no ephemeral channel key established; call PublicPrivacyService \
     EstablishWrappingKeys/ImportKeys first";

/// The sealed request could not be opened under the established channel key.
const ENVELOPE_OPEN_FAILED: &str = "could not open the request envelope";

/// The plaintext response could not be sealed back under the channel key.
const ENVELOPE_SEAL_FAILED: &str = "could not seal the response envelope";

/// Short wearer-facing fallbacks. These deliberately contain no assistant persona,
/// provider name, model jargon, or deployment detail.
const NO_COMPLETION: &str = "No answer came back. Try again.";
const VISION_UNAVAILABLE: &str = "Image analysis is unavailable. Try again.";
const AUDIO_TRANSCRIPTION_UNAVAILABLE: &str = "Audio could not be transcribed.";
const LOADING_MESSAGE: &str = "One moment.";

/// `humane.aibus.AIBusService` — the assistant + its per-turn cloud tools.
#[derive(Clone)]
pub struct AiBusMain {
    engine: std::sync::Arc<crate::assistant::engine::Engine>,
    /// Shared ephemeral channel keys, populated by `PublicPrivacyService`. The
    /// `Encrypted*` assistant path opens requests and seals responses with these.
    keys: crate::keymaterial::SharedKeyMaterial,
    /// Production channel-key authority. `None` is retained only for focused
    /// unit tests that exercise the legacy in-memory KeyMaterial seam.
    directory: Option<crate::keydirectory::SharedKeyDirectory>,
    /// The wearer's saved data, for tools like `recall_memory`.
    store: crate::store::SharedStore,
    /// Resolves each caller's account verdict. Fail-open by default (no store).
    entitlements: std::sync::Arc<crate::services::gates::FailOpenDirectory>,
}

impl Default for AiBusMain {
    fn default() -> Self {
        Self {
            engine: crate::assistant::build_engine(),
            keys: Default::default(),
            directory: None,
            store: crate::store::MemoryStore::shared(),
            entitlements: Default::default(),
        }
    }
}

/// Run one `FunctionCall` the way the DEVICE sends it.
///
/// Shared by `FunctionExecution` and its encrypted twin so the two cannot drift.
///
/// The subtlety is the Notes quick action. `QuickActionRouter.handleNotesAction`
/// builds `FunctionCall.newBuilder().setName("CreateMemory").setUtterance(transcript)`
/// — it sets `utterance` and **never sets `arguments`** — and sends it over
/// `AIBusService.FunctionExecution`. That is the only on-device caller of this
/// RPC anywhere in the decompile, so the RPC exists on stock cosmos essentially to
/// serve this feature, and the note is created SERVER-side.
///
/// Passing `arguments` (empty) to the tool dispatcher meant the call fell through
/// to the unknown-tool arm and returned `Unknown server tool "CreateMemory".`,
/// which the device wraps in a `ResponseObservation` and narrates. The wearer
/// held two fingers, spoke a note, heard an acknowledgement, and nothing was
/// saved. This is the same defect already fixed on `CaptureService.CreateMemory`;
/// it survived here because the AIBus *function* named "CreateMemory" is a
/// different thing from the capture RPC of the same name — one carries a
/// plaintext `utterance`, the other an `encrypted_note`.
async fn run_device_function(
    call: &pb::FunctionCall,
    tools: &crate::assistant::catalog::ToolContext,
) -> String {
    if call.name == "CreateMemory" {
        // The wearer's own words are in `utterance`; `arguments` is empty here.
        let text = if call.utterance.trim().is_empty() {
            // Fall back to an `arguments` payload if some other caller ever sends
            // one, rather than silently saving nothing.
            crate::assistant::catalog::text_argument(&call.arguments)
        } else {
            call.utterance.clone()
        };
        return crate::assistant::catalog::execute_tool_with(
            "remember",
            &serde_json::json!({ "text": text }).to_string(),
            tools,
        )
        .await;
    }
    crate::assistant::catalog::execute_tool_with(&call.name, &call.arguments, tools).await
}

impl AiBusMain {
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
            return match directory
                .open(&envelope)
                .await
                .map_err(|error| crate::keydirectory::grpc_status(&error))?
            {
                Some(plaintext) => Ok(plaintext),
                None => {
                    crate::services::public_privacy::note_unknown_kid(&kid);
                    Err(Status::failed_precondition(format!(
                        "no channel key for kid {kid}; queued for re-establishment via PublicPrivacyService SyncKeys",
                    )))
                }
            };
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

    async fn run_model_completion(&self, prompt: String) -> Result<String, Status> {
        let model = ConfiguredChatModel::assistant();
        let messages = vec![ChatMessage {
            role: crate::assistant::llm::Role::User,
            content: prompt,
        }];

        let output = model
            .complete(&messages, &[])
            .await
            .map_err(|e| Status::unavailable(format!("completion model failed: {e}")))?
            .content
            .unwrap_or_else(|| NO_COMPLETION.to_owned());

        Ok(output)
    }

    /// Drive one `ChatCompletion` turn — the DEVICE-hosted sub-agent's model call.
    ///
    /// This is the second tier of cosmos's topology. `TaoAgentV2` runs its own
    /// ReAct loop on the pin for the capability experiences (Settings, Timer,
    /// Alarm, Contacts, ManageNutrition) and asks the server for each model step
    /// over this RPC, naming the tool set it wants via `tool_set_version` — the
    /// only transport on which the per-capability set names ever arrive
    /// (`SynapseInterpreter` always sends `supervisor` on `Understand`).
    ///
    /// So the pointer MUST be resolved here. Answering with no tools and no
    /// per-set guidance leaves the sub-agent unable to act at all: the wearer's
    /// setting is never changed, their timer never set, and the supervisor's
    /// wrapper action dead-ends after the pin has already dispatched it.
    async fn run_model_chat(
        &self,
        chat: &pb::ChatCompletionRequest,
    ) -> Result<pb::ChatCompletionMessage, Status> {
        use crate::assistant::llm::{ChatMessage, Role};

        let pointer = chat
            .tool_set_version
            .as_ref()
            .map(|v| (v.set_name.as_str(), v.version));
        let resolved = crate::assistant::toolsets::resolve(pointer);

        // The sub-agent runs on the pin, which is the authority on its own state,
        // so the catalog is not narrowed by keyguard or subscription here — those
        // gate what the SUPERVISOR may dispatch, and the pin has already decided
        // to run this experience. The set itself is the narrowing.
        let context = crate::assistant::catalog::CatalogContext {
            is_locked: false,
            excluded: &[],
            subscribed: true,
        };
        let tools = crate::assistant::catalog::tool_catalog_for_set(&context, resolved.set);

        // Lead with the resolved set's guidance unless the device already sent a
        // system message of its own; the device's own framing wins when present.
        let mut model_messages: Vec<ChatMessage> = Vec::with_capacity(chat.messages.len() + 1);
        if !chat.messages.iter().any(|m| m.role == "system") {
            model_messages.push(ChatMessage::system(
                crate::assistant::catalog::system_prompt_for(resolved.set),
            ));
        }
        model_messages.extend(chat.messages.iter().map(|msg| ChatMessage {
            role: match msg.role.as_str() {
                "system" => Role::System,
                "assistant" => Role::Assistant,
                _ => Role::User,
            },
            content: msg.content.clone(),
        }));

        let output = self
            .engine
            .model()
            .complete(&model_messages, &tools)
            .await
            .map_err(|e| Status::unavailable(format!("chat completion model failed: {e}")))?;

        // The sub-agent's whole purpose is calling tools, and it reads them from
        // `tool_calls` (`MessageFactory.functionCall(toolId, name, input)`).
        // Dropping them here left the loop able only to talk, never to act.
        let tool_calls: Vec<pb::ToolCall> = output
            .tool_call
            .into_iter()
            .map(|call| pb::ToolCall {
                // The device pairs the result back by this id, so it must be
                // present and unique within the turn.
                id: uuid::Uuid::new_v4().to_string(),
                r#type: "function".to_owned(),
                function: Some(pb::FunctionCall {
                    name: call.name,
                    // Never let a non-object reach the device: it parses `arguments`
                    // unconditionally and a JsonNull throws.
                    arguments: crate::assistant::llm::normalize_arguments(&call.arguments),
                    ..Default::default()
                }),
            })
            .collect();

        // Only claim "no output" when the model genuinely produced neither text
        // nor a tool call — a pure tool-call step legitimately has empty content.
        let content = match output.content {
            Some(content) => content,
            None if !tool_calls.is_empty() => String::new(),
            None => NO_COMPLETION.to_owned(),
        };

        Ok(pb::ChatCompletionMessage {
            role: "assistant".to_owned(),
            content,
            tool_calls,
            name: String::new(),
            tool_call_id: String::new(),
        })
    }

    /// Share the workload's store so wearer-scoped tools (`recall_memory`) read
    /// the same notes the capture service writes.
    pub fn with_store(mut self, store: crate::store::SharedStore) -> Self {
        self.store = store;
        self
    }

    /// The store this assistant reads and writes. The demo HTTP surface reads the
    /// SAME instance through the capture API, so a "remember …" turn is visible in
    /// the companion viewer.
    pub fn store(&self) -> crate::store::SharedStore {
        self.store.clone()
    }

    /// Wearer-scoped context for the server-side tools this turn may call.
    ///
    /// Tools like `recall_memory` read the wearer's own saved notes, so they need
    /// the authenticated principal. A request without one yields an empty
    /// context and those tools report having nothing rather than reaching into
    /// another account.
    fn tool_context<T>(&self, request: &Request<T>) -> crate::assistant::catalog::ToolContext {
        crate::assistant::catalog::ToolContext {
            principal: crate::auth::principal(request)
                .map(|p| p.expose_for_authorization().to_owned()),
            store: Some(self.store.clone()),
            keys: Some(self.keys.clone()),
            key_directory: self.directory.clone(),
            // Generic over the request body, so it cannot see
            // `SynapseUnderstandingRequest.location`. The Understand handlers
            // attach it once they have the typed request.
            location: None,
        }
    }

    /// The account verdict for this request's authenticated caller.
    ///
    /// The principal is the one `AuthLayer` resolved from the mesh edge; a request
    /// that somehow reached a handler without one is treated as unauthorized
    /// rather than anonymous. With no entitlement datastore the directory resolves
    /// every real principal to `Active` — cosmos's own fail-open behavior.
    fn entitlement_for<T>(&self, request: &Request<T>) -> crate::services::gates::Entitlement {
        use crate::services::gates::EntitlementDirectory;
        use cosmos_protocol::account::UnauthorizedStatusCode;
        match crate::auth::principal(request) {
            Some(principal) => self.entitlements.entitlement(principal),
            None => crate::services::gates::Entitlement::unauthorized(vec![
                UnauthorizedStatusCode::Unspecified,
            ]),
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

    /// Invoke the explicitly configured OpenAI-compatible multimodal model.
    /// This is clone-owned behavior; the stock provider/model and hidden prompt
    /// remain unknown. Images stay in-memory and are sent only to the operator's
    /// configured endpoint.
    async fn vision_text(image_urls: Vec<String>, prompt: String) -> Result<String, Status> {
        if image_urls.is_empty() {
            return Err(Status::invalid_argument("vision request has no images"));
        }
        crate::assistant::vision::complete(&prompt, &image_urls)
            .await
            .map_err(|error| match error {
                crate::assistant::vision::VisionError::Unsupported => {
                    Status::failed_precondition(error.to_string())
                }
                _ => Status::unavailable(error.to_string()),
            })
    }

    async fn analyze_image_inner(
        request: pb::AnalyzeImageRequest,
    ) -> Result<pb::AnalyzeImageResponse, Status> {
        let image_url = Self::analyze_image_data_url(&request)?;
        let prompt = if !request.request.trim().is_empty() {
            request.request.trim().to_owned()
        } else if !request.utterance.trim().is_empty() {
            request.utterance.trim().to_owned()
        } else {
            "Describe the image for a person wearing a screenless assistant.".to_owned()
        };
        let observation = match Self::vision_text(vec![image_url], prompt).await {
            Ok(observation) => observation,
            Err(error) => {
                tracing::warn!(
                    grpc_code = ?error.code(),
                    "vision provider request failed; returning a stock-compatible response"
                );
                VISION_UNAVAILABLE.to_owned()
            }
        };
        Ok(pb::AnalyzeImageResponse {
            observation: observation.clone(),
            nested_analyze_image_response: Some(pb::NestedAnalyzeImageResponse {
                responseoneof: Some(
                    pb::nested_analyze_image_response::Responseoneof::GenericImageResponse(
                        pb::GenericImageResponse { observation },
                    ),
                ),
            }),
        })
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

    /// Run a minimal `Understand` stateful turn and extract the final spoken
    /// answer text from the terminal `Respond` action.
    async fn stateful_respond_text(
        &self,
        request: pb::SynapseUnderstandingRequest,
        entitlement: crate::services::gates::Entitlement,
        tools: crate::assistant::catalog::ToolContext,
    ) -> Result<String, Status> {
        let engine = self.engine.for_request(entitlement, tools);
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move { engine.run_text_only(request, tx).await });

        while let Some(msg) = rx.recv().await {
            let message =
                msg.map_err(|e| Status::internal(format!("stateful understand failed: {e}")))?;
            if let Some(pb::synapse_understanding_response::Body::Turn(turn)) = message.body {
                if let Some(pb::synapse_chat_turn::Content::Action(action)) = turn.content {
                    if action.action == catalog::RESPOND_ACTION {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&action.input)
                        {
                            if let Some(text) =
                                parsed.get(catalog::RESPOND_FIELD).and_then(|v| v.as_str())
                            {
                                return Ok(text.to_owned());
                            }
                        }
                        if !action.input.is_empty() {
                            return Ok(action.input);
                        }
                        return Ok("Done.".to_owned());
                    }
                }
            }
        }

        Err(Status::internal(
            "stateful understand produced no terminal response",
        ))
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
        // Resolve the caller's account verdict before the turn: Cosmos gates every
        // dispatched action on it, and a degraded account rewrites the ReAct chain
        // into a canned local experience rather than going silent.
        let entitlement = self.entitlement_for(&request);
        let mut tools = self.tool_context(&request);
        // Drive the ReAct engine (recreated from cosmos's serverside logic) and
        // stream the transcript + final answer as it is produced.
        let req = request.into_inner();
        // The wearer's own position, when the device sent one, so the
        // location-taking tools do not have to invent a coordinate.
        tools.location = req.location.as_ref().map(|l| (l.latitude, l.longitude));
        let engine = self.engine.for_request(entitlement, tools);
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move { engine.run(req, tx).await });
        Ok(Response::new(Box::pin(
            tokio_stream::wrappers::ReceiverStream::new(rx),
        )))
    }

    type EncryptedUnderstandStream = BoxStream<pb::EncryptedSynapseUnderstandingResponse>;

    /// The envelope-encrypted assistant turn — the RPC a **stock** Pin actually
    /// uses. Cosmos wraps the very same `Understand` exchange in the per-capability
    /// ephemeral channel: the device seals a `SynapseUnderstandingRequest` under a
    /// channel key it established via `PublicPrivacyService`, and every streamed
    /// `SynapseUnderstandingResponse` comes back sealed under the same kid.
    ///
    /// So this is not a second assistant: it opens the envelope, drives the *same*
    /// ReAct engine, and re-seals each streamed message. Key agreement itself is
    /// real (RSA-OAEP wrap -> AES-128-GCM channel key); see `cosmos-crypto`.
    async fn encrypted_understand(
        &self,
        request: Request<pb::EncryptedSynapseUnderstandingRequest>,
    ) -> Result<Response<Self::EncryptedUnderstandStream>, Status> {
        use prost::Message as _;

        let entitlement = self.entitlement_for(&request);
        let mut tools = self.tool_context(&request);
        let body = request.into_inner();
        let location_envelope = body.location;
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
        let inner =
            pb::SynapseUnderstandingRequest::decode(plaintext.as_slice()).map_err(|_| {
                Status::invalid_argument("envelope did not contain an understanding request")
            })?;

        // The device seals its location SEPARATELY, as a `LocationEnvelope`
        // alongside the request. Dropping it means the encrypted transport — the
        // one a stock Pin actually uses — answers every "what's near me" or
        // time-relative question with no idea where the wearer is, while the
        // plaintext transport has it. Merge it into the decrypted request.
        let mut inner = inner;
        if let Some(sealed_location) = location_envelope {
            let location_kid = sealed_location
                .encryption_information
                .as_ref()
                .map(|i| i.kid.clone())
                .unwrap_or_default();
            let plaintext = Some(
                self.open_envelope(cosmos_crypto::EncryptedData {
                    data: sealed_location.data,
                    kid: location_kid,
                })
                .await?,
            );
            if let Some(plaintext) = plaintext {
                // Log the failure rather than swallowing it. A decode error here
                // means our schema and the device's disagree, and the only
                // symptom is the wearer's location quietly vanishing from the
                // turn — "what's near me" answered blind, with nothing anywhere
                // saying why. That is exactly how the `stalestatus` field stayed
                // wrong (declared `bytes`, sent as an enum) without being noticed.
                let decoded = cosmos_protocol::common::encryption::LocationEnvelope::decode(
                    plaintext.as_slice(),
                );
                if let Err(error) = &decoded {
                    tracing::warn!(
                        %error,
                        "location envelope failed to decode; the wearer's location \
                         is being dropped from this turn — schema drift against the device",
                    );
                }
                if let Ok(envelope) = decoded {
                    inner.location = Some(pb::Location {
                        latitude: envelope.latitude as f64,
                        longitude: envelope.longitude as f64,
                    });
                }
            }
        }

        // Same gating and wearer scope as the plaintext transport: without this
        // the encrypted path skips the account gate and its tools cannot reach
        // the wearer's own notes.
        // The wearer's own position, decoded from the sealed `LocationEnvelope`
        // just above. This is the transport a stock Pin actually speaks, so it is
        // the one that carries a real location — without attaching it here the
        // `weather` and `nearby` tools would have to invent a coordinate or fall
        // back to a web search on exactly the questions the Pin is best placed to
        // answer.
        tools.location = inner.location.as_ref().map(|l| (l.latitude, l.longitude));
        let engine = self.engine.for_request(entitlement, tools);
        let keys = self.keys.clone();
        let directory = self.directory.clone();
        let (plain_tx, mut plain_rx) = tokio::sync::mpsc::channel(16);
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move { engine.run(inner, plain_tx).await });
        tokio::spawn(async move {
            while let Some(msg) = plain_rx.recv().await {
                let sealed = match msg {
                    Ok(m) => {
                        let encoded = m.encode_to_vec();
                        let result = if let Some(directory) = &directory {
                            directory
                                .seal(&kid, &encoded, b"humane.aibus.SynapseUnderstandingResponse")
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
                        result.map(|e| pb::EncryptedSynapseUnderstandingResponse {
                            response: Some(cosmos_protocol::common::encryption::EncryptedData {
                                encryption_information: Some(
                                    cosmos_protocol::common::encryption::EncryptionInformation {
                                        kid: e.kid,
                                    },
                                ),
                                data: e.data,
                            }),
                        })
                    }
                    Err(status) => {
                        let _ = tx.send(Err(status)).await;
                        return;
                    }
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

    /// The bidi ReAct loop. Where legacy `Understand` is positional (the device
    /// dispatches the FINAL action of a batch), bidi is EXPLICIT: the server
    /// streams informational events with `requires_response=false` that the device
    /// merely records, and terminates each device turn with exactly ONE event
    /// flagged `requires_response=true` — the wire-level definition of "device,
    /// run this and send me the observation". The device's observation arrives on
    /// the request stream and the loop continues. Server tools still resolve
    /// server-side and never wait. See `assistant::bidi`.
    async fn bidirectional_streaming_understand(
        &self,
        request: Request<tonic::Streaming<pb::StreamingUnderstandRequest>>,
    ) -> Result<Response<Self::BidirectionalStreamingUnderstandStream>, Status> {
        // Same per-request state the other two transports resolve. Without it
        // this stream ran fully ungated: every caller was served as subscribed,
        // authorized and unlocked — including a request that reached the handler
        // with no principal at all — and its server tools had no wearer to read
        // for, so `recall_memory` could never work here.
        let entitlement = self.entitlement_for(&request);
        let tools = self.tool_context(&request);
        let stream = crate::assistant::bidi::BidiSession::spawn(
            self.engine.model(),
            entitlement,
            tools,
            request.into_inner(),
        );
        Ok(Response::new(Box::pin(stream)))
    }

    async fn server_stateful_understand(
        &self,
        request: Request<pb::ServerStatefulUnderstandRequest>,
    ) -> Result<Response<pb::ServerStatefulUnderstandResponse>, Status> {
        let entitlement = self.entitlement_for(&request);
        let tools = self.tool_context(&request);
        use pb::server_stateful_understand_request::Userrequest;
        let request = request.into_inner();
        let utterance = match request.userrequest {
            Some(Userrequest::Transcription(text)) => text,
            Some(Userrequest::AudioBytes(audio)) => {
                if audio.audio.is_empty() {
                    String::new()
                } else {
                    AUDIO_TRANSCRIPTION_UNAVAILABLE.to_owned()
                }
            }
            None => String::new(),
        };
        let request = pb::SynapseUnderstandingRequest {
            utterance,
            // This RPC can return only text/audio, not a device action. Keep
            // `Respond` available, but do not offer actions the adapter cannot
            // return to its caller. Streaming Understand retains the full
            // Pin action catalog and observation loop.
            excluded_tools: catalog::stateful_excluded_device_tools(),
            ..Default::default()
        };
        let text = self
            .stateful_respond_text(request, entitlement, tools)
            .await?;
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
        let request = request.into_inner();
        let (chat, kid): (pb::ChatCompletionRequest, _) =
            self.open_request(request.request).await?;
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
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.ChatCompletionResponse")
                    .await?,
            ),
        }))
    }

    // --- Vision / image understanding: image model required -----------------

    async fn analyze_image(
        &self,
        request: Request<pb::AnalyzeImageRequest>,
    ) -> Result<Response<pb::AnalyzeImageResponse>, Status> {
        Ok(Response::new(
            Self::analyze_image_inner(request.into_inner()).await?,
        ))
    }

    async fn encrypted_analyze_image(
        &self,
        request: Request<pb::EncryptedAnalyzeImageRequest>,
    ) -> Result<Response<pb::EncryptedAnalyzeImageResponse>, Status> {
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
        let (request, kid): (pb::AnalyzeFoodImageRequest, _) =
            self.open_request(request.into_inner().request).await?;
        let response = Self::analyze_food_image_inner(request).await?;
        Ok(Response::new(pb::EncryptedAnalyzeFoodImageResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.AnalyzeFoodImageResponse")
                    .await?,
            ),
        }))
    }

    // --- Interstitial / loading copy -----------------------------------------

    async fn encrypted_action_based_interstitial(
        &self,
        request: Request<pb::EncryptedActionBasedInterstitialRequest>,
    ) -> Result<Response<pb::EncryptedActionBasedInterstitialResponse>, Status> {
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
        let request = request.into_inner();
        let (_req, kid): (pb::LoadingMessageRequest, _) =
            self.open_request(request.request).await?;
        let response = pb::LoadingMessageResponse {
            loading_message: LOADING_MESSAGE.to_owned(),
            verbal_message: LOADING_MESSAGE.to_owned(),
        };
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
        // Server tools run against the wearer's own data, so resolve them first.
        let tools = self.tool_context(&request);
        let request = request.into_inner();
        let response = run_device_function(&request, &tools).await;
        Ok(Response::new(pb::FunctionResponse { response }))
    }

    async fn encrypted_function_execution(
        &self,
        request: Request<pb::EncryptedFunctionCall>,
    ) -> Result<Response<pb::EncryptedFunctionResponse>, Status> {
        // Server tools run against the wearer's own data, so resolve them first.
        let tools = self.tool_context(&request);
        let (call, kid): (pb::FunctionCall, String) = self
            .open_request::<pb::FunctionCall>(request.into_inner().function_call)
            .await?;
        let response = run_device_function(&call, &tools).await;
        let response = pb::FunctionResponse { response };
        Ok(Response::new(pb::EncryptedFunctionResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.FunctionResponse")
                    .await?,
            ),
        }))
    }

    // --- Location / maps / places: external services ------------------------

    async fn encrypted_geo_locate(
        &self,
        request: Request<pb::EncryptedGeoLocateRequest>,
    ) -> Result<Response<pb::EncryptedGeoLocateResponse>, Status> {
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
        let (location, kid): (pb::Location, _) =
            self.open_request(request.into_inner().location).await?;
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
        let request = request.into_inner();
        let (origin, _): (pb::Location, _) = self.open_request(request.location).await?;
        let (nav, kid): (pb::NavigationDirectionsRequest, _) =
            self.open_request(request.request).await?;
        let directions =
            crate::backends::places::directions(origin.latitude, origin.longitude, nav.destination)
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
        let (search, kid): (pb::NearbySearchRequest, _) =
            self.open_request(request.into_inner().request).await?;
        let near = search.location.as_ref().map(|l| (l.latitude, l.longitude));
        let places =
            crate::backends::places::nearby(&search.text_query, near, search.radius_accuracy)
                .await
                .map_err(|e| Self::backend_status(e, "places-search"))?;
        let reply = pb::NearbySearchResponse {
            nearby_places: places,
            status: pb::NearbySearchResultStatus::Success as i32,
        };
        Ok(Response::new(pb::EncryptedNearbySearchResponse {
            response: Some(
                self.seal_response(&kid, &reply, "humane.aibus.NearbySearchResponse")
                    .await?,
            ),
        }))
    }

    /// Current conditions for the device's location, in cosmos's AccuWeather-shaped
    /// `WeatherResponse`. Served by Pirate Weather when configured; see
    /// `backends::weather` for the one field (the numeric icon) that is a
    /// documented approximation between the two vendors.
    async fn encrypted_weather(
        &self,
        request: Request<pb::EncryptedWeatherRequest>,
    ) -> Result<Response<pb::EncryptedWeatherResponse>, Status> {
        let (location, kid): (pb::Location, _) =
            self.open_request(request.into_inner().location).await?;
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
        let request = request.into_inner();
        let (req, kid): (pb::GetFoodItemRequest, _) = self.open_request(request.request).await?;
        let text = req.text.trim().to_owned();
        if text.is_empty() {
            return Err(Status::invalid_argument("GetFoodItem requires text"));
        }
        // Real nutrition from Open Food Facts (a free, keyless substitute for
        // cosmos's Nutritionix backend). A no-match returns the query with empty
        // nutrition — the device narrates "couldn't get that info" — rather than a
        // fabricated figure; an unreachable provider is an honest gRPC error.
        let best = match crate::backends::food::lookup(&text).await {
            Ok(item) => cosmos_protocol::common::food::FoodItem {
                request_uuid: String::new(),
                item_name: item.item_name,
                typical_serving_size: item.serving_size,
                nutrition_info: item.nutrition,
                brand: item.brand,
            },
            Err(crate::backends::BackendError::NoResult) => {
                cosmos_protocol::common::food::FoodItem {
                    request_uuid: String::new(),
                    item_name: text.clone(),
                    typical_serving_size: String::new(),
                    nutrition_info: Vec::new(),
                    brand: String::new(),
                }
            }
            Err(_) => {
                return Err(Status::unavailable("the nutrition backend is unavailable"));
            }
        };
        let response = pb::GetFoodItemResponse {
            best_food_item: Some(best),
            alternate_food_items: Vec::new(),
        };
        Ok(Response::new(pb::EncryptedGetFoodItemResponse {
            response: Some(
                self.seal_response(&kid, &response, "humane.aibus.GetFoodItemResponse")
                    .await?,
            ),
        }))
    }

    // --- Smart playlist: catalog-backed -------------------------------------

    async fn encrypted_smart_playlist(
        &self,
        request: Request<pb::EncryptedSmartPlaylistRequest>,
    ) -> Result<Response<pb::EncryptedSmartPlaylistResponse>, Status> {
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
            LOADING_MESSAGE,
        ] {
            let lower = text.to_ascii_lowercase();
            assert!(
                forbidden.iter().all(|term| !lower.contains(term)),
                "wearer-facing fallback exposes persona or deployment jargon: {text:?}",
            );
        }
    }

    /// Captures what the sub-agent path actually handed the model.
    struct CapturingModel {
        seen: std::sync::Mutex<Option<(Vec<String>, Vec<String>)>>,
    }

    #[tonic::async_trait]
    impl crate::assistant::llm::ChatModel for CapturingModel {
        async fn complete(
            &self,
            messages: &[crate::assistant::llm::ChatMessage],
            tools: &[crate::assistant::llm::ToolDef],
        ) -> Result<crate::assistant::llm::ChatResponse, crate::assistant::llm::LlmError> {
            *self.seen.lock().unwrap() = Some((
                messages.iter().map(|m| m.content.clone()).collect(),
                tools.iter().map(|t| t.name.clone()).collect(),
            ));
            Ok(crate::assistant::llm::ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(crate::assistant::llm::ToolCall {
                    name: "SetTimer".to_owned(),
                    arguments: "{}".to_owned(),
                }),
                extra_tool_calls: Vec::new(),
            })
        }
    }

    /// The Notes quick action must actually save a note.
    ///
    /// Two-finger hold, speak, release: `QuickActionRouter.handleNotesAction`
    /// sends `FunctionCall{name:"CreateMemory", utterance:<transcript>}` with
    /// `arguments` EMPTY. Dispatching on `arguments` sent it to the unknown-tool
    /// arm, so the wearer heard an acknowledgement and nothing was stored —
    /// the same defect already fixed on `CaptureService.CreateMemory`, surviving
    /// here under a colliding name.
    #[tokio::test]
    async fn the_notes_quick_action_stores_what_the_wearer_said() {
        let store = crate::store::MemoryStore::shared();
        let svc = AiBusMain {
            engine: Arc::new(crate::assistant::engine::Engine::new(Arc::new(
                crate::assistant::llm::DemoChatModel,
            ))),
            keys: Default::default(),
            directory: None,
            store: store.clone(),
            entitlements: Default::default(),
        };

        // AuthLayer inserts the principal in production; do the same here so the
        // wearer-scoped store path is exercised rather than the no-principal one.
        let mut call = Request::new(pb::FunctionCall {
            name: "CreateMemory".to_owned(),
            // Exactly what the device sends: utterance set, arguments empty.
            utterance: "the spare key is under the third pot".to_owned(),
            arguments: String::new(),
            ..Default::default()
        });
        call.extensions_mut().insert(
            cosmos_core::AuthenticatedPrincipal::from_edge("V:01:D:test-pin:U:wearer")
                .expect("principal"),
        );
        let spoken = svc
            .function_execution(call)
            .await
            .expect("function_execution answers")
            .into_inner()
            .response;
        assert!(
            !spoken.contains("Unknown server tool"),
            "the device's own Notes function must be recognised, got {spoken:?}",
        );

        // The claim that matters: it is actually there afterwards.
        let found = store
            .search_notes("V:01:D:test-pin:U:wearer", "spare key", 5)
            .await
            .expect("search runs");
        assert!(
            !found.is_empty(),
            "a note spoken through the Notes quick action must be saved and \
             findable — an acknowledgement with nothing stored is the failure \
             this test exists for",
        );
    }

    /// REGRESSION: `EncryptedChatCompletion` is the ONLY transport on which the
    /// per-capability tool-set names arrive.
    ///
    /// `SynapseInterpreter` always sends `supervisor` on `Understand`; the child
    /// set names (`timer@1`, `settings@3`, …) come from `TaoAgentV2`, the pin's
    /// own sub-agent, over this RPC. This handler used to ignore both the pointer
    /// and the tool list, answering with no tools and no per-set guidance — so
    /// every capability set was dead, the sub-agent could talk but never act, and
    /// a supervisor `Timer`/`Settings` wrapper action dead-ended after the pin
    /// had already dispatched it. It must also return the model's tool call:
    /// the device reads `tool_calls`, and dropping them is the same silence.
    #[tokio::test]
    async fn the_sub_agents_tool_set_pointer_selects_its_tools_and_guidance() {
        use prost::Message as _;

        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("kid-test".to_owned(), [7u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let model = Arc::new(CapturingModel {
            seen: std::sync::Mutex::new(None),
        });
        let svc = AiBusMain {
            engine: Arc::new(crate::assistant::engine::Engine::new(model.clone())),
            keys: keys.clone(),
            directory: None,
            store: crate::store::MemoryStore::shared(),
            entitlements: Default::default(),
        };

        let chat = pb::ChatCompletionRequest {
            messages: vec![pb::ChatCompletionMessage {
                role: "user".to_owned(),
                content: "set a five minute timer".to_owned(),
                ..Default::default()
            }],
            tool_set_version: Some(pb::ToolSetVersion {
                set_name: "timer".to_owned(),
                version: 1,
            }),
            ..Default::default()
        };
        let sealed = keys
            .seal("kid-test", &chat.encode_to_vec(), b"")
            .expect("seal chat request");
        let response = svc
            .encrypted_chat_completion(Request::new(pb::EncryptedChatCompletionRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: sealed.kid,
                        },
                    ),
                    data: sealed.data,
                }),
            }))
            .await
            .expect("chat completion answers")
            .into_inner()
            .response
            .expect("sealed response present");

        let (messages, tools) = model
            .seen
            .lock()
            .unwrap()
            .clone()
            .expect("the model must have been called");
        assert!(
            !tools.is_empty(),
            "the sub-agent must be handed its tool set; with none it can talk but never act",
        );
        assert!(
            tools.iter().any(|t| t == "SetTimer"),
            "timer@1 must offer SetTimer, got {tools:?}",
        );
        assert!(
            !tools.iter().any(|t| t == "PlayMusic"),
            "timer@1 must not be handed the whole flat catalog, got {tools:?}",
        );
        assert!(
            messages.first().is_some_and(|m| !m.is_empty()),
            "the resolved set's guidance must lead the transcript",
        );

        // The device reads `tool_calls`; dropping them is the same as silence.
        let payload = keys
            .open(&cosmos_crypto::EncryptedData {
                data: response.data,
                kid: response
                    .encryption_information
                    .as_ref()
                    .map(|i| i.kid.clone())
                    .unwrap_or_default(),
            })
            .expect("response opens");
        let decoded =
            pb::ChatCompletionResponse::decode(payload.as_slice()).expect("valid protobuf");
        let message = decoded.choices[0]
            .message
            .as_ref()
            .expect("a choice carries a message");
        assert_eq!(
            message
                .tool_calls
                .first()
                .and_then(|c| c.function.as_ref())
                .map(|f| f.name.as_str()),
            Some("SetTimer"),
            "the sub-agent's tool call must reach the device",
        );
    }

    #[tokio::test]
    async fn text_stateful_turn_recovers_when_model_requests_a_pin_only_action() {
        use crate::assistant::{
            engine::Engine,
            llm::{ChatResponse, MockChatModel, ToolCall},
        };

        let model = Arc::new(MockChatModel::new(vec![
            ChatResponse {
                content: None,
                thought: String::new(),
                tool_call: Some(ToolCall {
                    name: "SetTimer".to_owned(),
                    arguments: serde_json::json!({
                        "hourDuration": 0,
                        "minuteDuration": 1,
                        "secondDuration": 0,
                        "name": ""
                    })
                    .to_string(),
                }),
                extra_tool_calls: Vec::new(),
            },
            ChatResponse {
                content: Some("A connected Pin is required to start that timer.".to_owned()),
                thought: String::new(),
                tool_call: None,
                extra_tool_calls: Vec::new(),
            },
        ]));
        let svc = AiBusMain {
            engine: Arc::new(Engine::new(model)),
            keys: Default::default(),
            directory: None,
            store: crate::store::MemoryStore::shared(),
            entitlements: Default::default(),
        };

        let response = svc
            .server_stateful_understand(Request::new(pb::ServerStatefulUnderstandRequest {
                response_format: pb::server_stateful_understand_request::ResponseFormat::Text
                    as i32,
                userrequest: Some(
                    pb::server_stateful_understand_request::Userrequest::Transcription(
                        "Set a timer for one minute.".to_owned(),
                    ),
                ),
            }))
            .await
            .expect("text transport should recover to Respond")
            .into_inner();

        assert!(matches!(
            response.response,
            Some(pb::server_stateful_understand_response::Response::Text(text))
                if text == "A connected Pin is required to start that timer."
        ));
    }

    /// The encrypted assistant path is the RPC a stock Pin actually uses: seal a
    /// real `SynapseUnderstandingRequest` under an established channel key, and
    /// every streamed response must come back sealed under the same kid and open
    /// to a well-formed turn — the same ReAct transcript as plaintext Understand.
    #[tokio::test]
    async fn encrypted_understand_round_trips_a_real_envelope() {
        use prost::Message as _;
        use tokio_stream::StreamExt;

        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("kid-test".to_owned(), [3u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let svc = AiBusMain::with_key_material(keys.clone());

        // Device side: seal a real request under the channel key.
        let inner = pb::SynapseUnderstandingRequest {
            utterance: "hello".to_owned(),
            ..Default::default()
        };
        let sealed = keys
            .seal("kid-test", &inner.encode_to_vec(), b"")
            .expect("seal request");

        let stream = svc
            .encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: sealed.kid.clone(),
                        },
                    ),
                    data: sealed.data,
                }),
                location: None,
            }))
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
        let svc = AiBusMain::with_key_material(local.clone()).with_key_directory(directory);
        let inner = pb::SynapseUnderstandingRequest {
            utterance: "hello".to_owned(),
            ..Default::default()
        };
        let sealed = cosmos_crypto::seal(kid, &key, &inner.encode_to_vec(), b"")
            .expect("seal directory-only request");

        let messages = svc
            .encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: kid.to_owned(),
                        },
                    ),
                    data: sealed.data,
                }),
                location: None,
            }))
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
    async fn encrypted_understand_maps_authority_lookup_failure_to_unavailable() {
        use crate::keydirectory::DirectoryFault;

        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        directory.fail_next(DirectoryFault::Get);
        let svc = AiBusMain::default().with_key_directory(directory);
        let result = svc
            .encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: "unavailable-directory".to_owned(),
                        },
                    ),
                    data: Vec::new(),
                }),
                location: None,
            }))
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
        let svc = AiBusMain::with_key_material(keys.clone());

        let inner = pb::SynapseUnderstandingRequest {
            utterance: "hello".to_owned(),
            ..Default::default()
        };
        let sealed = keys
            .seal("kid-test", &inner.encode_to_vec(), b"")
            .expect("seal request");
        let stream = svc
            .encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: sealed.kid.clone(),
                        },
                    ),
                    data: sealed.data,
                }),
                location: None,
            }))
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
        let svc = AiBusMain::default();
        let err = svc
            .encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData::default()),
                location: None,
            }))
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
        let svc = AiBusMain::with_key_material(keys.clone());

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
            svc.encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                request: Some(corrupt.clone()),
                location: None,
            }))
            .await
            .err()
            .expect("a corrupt envelope must not stream"),
        ));

        // The shared `open_request` path every other `Encrypted*` tool RPC uses.
        faults.push((
            "encrypted_completion / corrupt envelope",
            svc.encrypted_completion(Request::new(pb::EncryptedCompletionRequest {
                request: Some(corrupt),
            }))
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
            svc.encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: foreign.kid,
                        },
                    ),
                    data: foreign.data,
                }),
                location: None,
            }))
            .await
            .err()
            .expect("a foreign envelope must not stream"),
        ));

        // No key exchange at all.
        faults.push((
            "encrypted_understand / no channel key",
            AiBusMain::default()
                .encrypted_understand(Request::new(pb::EncryptedSynapseUnderstandingRequest {
                    request: Some(cosmos_protocol::common::encryption::EncryptedData::default()),
                    location: None,
                }))
                .await
                .err()
                .expect("no channel key must not stream"),
        ));

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
    #[tokio::test]
    async fn bidi_applies_the_callers_entitlement_and_tool_context() {
        use crate::assistant::bidi::BidiSession;
        use crate::assistant::llm::{MockChatModel, ToolCall};
        use crate::services::gates::Entitlement;
        use tokio_stream::StreamExt as _;

        fn understanding() -> pb::StreamingUnderstandRequest {
            pb::StreamingUnderstandRequest {
                content: Some(
                    pb::streaming_understand_request::Content::UnderstandingRequest(
                        pb::SynapseUnderstandingRequest {
                            utterance: "play something".to_owned(),
                            ..Default::default()
                        },
                    ),
                ),
            }
        }

        /// Run one exchange and return every emitted turn with the flag that
        /// decides what the device does with it. `requires_response=true` is the
        /// wire-level "device, execute this"; `false` is history only, which is
        /// what the unknown-tool bounce emits.
        async fn exchange(
            model: Arc<dyn ChatModel>,
            entitlement: Entitlement,
            tools: catalog::ToolContext,
        ) -> Vec<(bool, pb::SynapseChatTurn)> {
            let (tx, rx) = tokio::sync::mpsc::channel(16);
            let out = BidiSession::spawn_with(
                model,
                entitlement,
                tools,
                tokio_stream::wrappers::ReceiverStream::new(rx),
            );
            tx.send(Ok(understanding())).await.expect("send request");
            drop(tx);
            out.filter_map(|m| m.ok())
                .filter_map(|m| match m.content {
                    Some(pb::streaming_understand_response::Content::IntermediateEvent(e)) => {
                        e.event.map(|turn| (e.requires_response, turn))
                    }
                    _ => None,
                })
                .collect()
                .await
        }

        /// Actions the device is actually told to run.
        fn dispatched(turns: &[(bool, pb::SynapseChatTurn)]) -> Vec<String> {
            turns
                .iter()
                .filter(|(requires_response, _)| *requires_response)
                .filter_map(|(_, t)| match &t.content {
                    Some(pb::synapse_chat_turn::Content::Action(a)) => Some(a.action.clone()),
                    _ => None,
                })
                .collect()
        }

        fn observations(turns: &[(bool, pb::SynapseChatTurn)]) -> Vec<String> {
            turns
                .iter()
                .filter_map(|(_, t)| match &t.content {
                    Some(pb::synapse_chat_turn::Content::Observation(o)) => {
                        Some(o.observation.clone())
                    }
                    _ => None,
                })
                .collect()
        }

        let play = || ToolCall {
            name: "PlayMusic".to_owned(),
            arguments: r#"{"Query":"anything"}"#.to_owned(),
        };

        // ENTITLEMENT. `PlayMusic` is deliberately absent from the unsubscribed
        // whitelist (gates::ENABLED_WHEN_UNSUBSCRIBED): transport on already
        // playing audio survives, starting playback does not.
        let subscribed = exchange(
            Arc::new(MockChatModel::tool_then_answer(play(), "done")),
            Entitlement::Active,
            catalog::ToolContext::default(),
        )
        .await;
        assert!(
            dispatched(&subscribed).iter().any(|n| n == "PlayMusic"),
            "a subscribed caller is offered PlayMusic, got {:?}",
            dispatched(&subscribed)
        );

        let degraded = exchange(
            Arc::new(MockChatModel::tool_then_answer(play(), "done")),
            Entitlement::from_subscription(
                cosmos_protocol::account::SubscriptionStatusCode::Suspended,
            ),
            catalog::ToolContext::default(),
        )
        .await;
        assert!(
            !dispatched(&degraded).iter().any(|n| n == "PlayMusic"),
            "an unsubscribed caller must never be dispatched PlayMusic, got {:?}",
            dispatched(&degraded)
        );
        // It is withheld by not being in the catalog at all, so the model's call
        // resolves to nothing and is bounced as informational — never run.
        assert!(
            observations(&degraded)
                .iter()
                .any(|o| o.contains("Unrecognized function")),
            "the withheld tool is bounced, got {:?}",
            observations(&degraded)
        );

        // TOOL CONTEXT. `recall_memory` distinguishes "no wearer on this request"
        // from "nothing saved", so the two contexts are directly observable.
        let recall = || ToolCall {
            name: "recall_memory".to_owned(),
            arguments: r#"{"query":"wifi password"}"#.to_owned(),
        };
        let anonymous = exchange(
            Arc::new(MockChatModel::tool_then_answer(recall(), "done")),
            Entitlement::Active,
            catalog::ToolContext::default(),
        )
        .await;
        assert!(
            observations(&anonymous)
                .iter()
                .any(|o| o.contains("No wearer is associated with this request")),
            "with no context the tool reports having no wearer, got {:?}",
            observations(&anonymous)
        );

        let store = crate::store::MemoryStore::shared();
        let wearer = exchange(
            Arc::new(MockChatModel::tool_then_answer(recall(), "done")),
            Entitlement::Active,
            catalog::ToolContext {
                principal: Some("device-test-pin-01".to_owned()),
                store: Some(store),
                key_directory: None,
                keys: Some(Default::default()),
                location: None,
            },
        )
        .await;
        assert!(
            !observations(&wearer)
                .iter()
                .any(|o| o.contains("No wearer is associated with this request")),
            "the wearer's context must reach the server tools, got {:?}",
            observations(&wearer)
        );
    }

    #[tokio::test]
    async fn assistant_rpcs_are_stock_shaped_and_model_backed() {
        let svc = AiBusMain::default();

        // Stateful understand now returns a stock-shaped terminal response for
        // text mode and never emits a fake payload.
        let stateful = svc
            .server_stateful_understand(Request::new(pb::ServerStatefulUnderstandRequest {
                response_format: pb::server_stateful_understand_request::ResponseFormat::Text
                    as i32,
                userrequest: Some(
                    pb::server_stateful_understand_request::Userrequest::Transcription(
                        "hello".to_owned(),
                    ),
                ),
            }))
            .await
            .expect("server_stateful_understand works for text format")
            .into_inner();
        assert!(matches!(
            stateful.response,
            Some(pb::server_stateful_understand_response::Response::Text(_))
                | Some(pb::server_stateful_understand_response::Response::AudioBytes(_))
        ));

        // Understand now drives the recreated ReAct engine and STREAMS turns.
        // With no LLM configured (test env) the keyless fallback still runs a
        // full action -> observation -> Respond loop, so assert the stream shape
        // rather than any one message: intermediate transcript nodes, then the
        // terminal `Respond` DEVICE action (the wire shape the legacy device
        // consumer dispatches + speaks — NOT a bare Answer/Failure body it drops).
        use tokio_stream::StreamExt;
        let stream = svc
            .understand(Request::new(pb::SynapseUnderstandingRequest {
                utterance: "hello".to_owned(),
                ..Default::default()
            }))
            .await
            .expect("understand returns a stream")
            .into_inner();
        let msgs: Vec<_> = stream
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|m| m.expect("ok message"))
            .collect();
        // Model the legacy device consumer: it keeps ONLY action/observation turns
        // and dispatches the FINAL action of the batch. That final action must be
        // the Respond (source DEVICE) that speaks the answer — never an Answer body.
        let actions: Vec<_> = msgs
            .iter()
            .filter_map(|m| match &m.body {
                Some(pb::synapse_understanding_response::Body::Turn(t)) => match &t.content {
                    Some(pb::synapse_chat_turn::Content::Action(a)) => Some(a),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        let dispatched = actions.last().expect("device dispatches a final action");
        assert_eq!(dispatched.action, "Respond");
        assert_eq!(dispatched.source, pb::SynapseSource::Server as i32);
        // The spoken text rides in the real decompiled field name.
        let input: serde_json::Value = serde_json::from_str(&dispatched.input).unwrap();
        assert!(input["Response"].as_str().is_some_and(|s| !s.is_empty()));

        // The stream closes with the explicit turn-complete marker. It does NOT
        // open with a heartbeat: the legacy consumer keeps only action and
        // observation turns and discards anything else.
        assert!(!msgs.iter().any(|m| matches!(
            m.body,
            Some(pb::synapse_understanding_response::Body::Heartbeat(_))
        )));
        let last = msgs.last().unwrap();
        assert!(last.is_final);
        assert!(matches!(&last.body,
            Some(pb::synapse_understanding_response::Body::Turn(t))
                if matches!(t.content, Some(pb::synapse_chat_turn::Content::End(_)))));

        // The deterministic test RPCs return well-formed, stock-shaped Ok.
        let action = svc
            .action_execution_test(Request::new(pb::ActionExecutionTestRequest::default()))
            .await
            .expect("action_execution_test ok")
            .into_inner();
        assert!(!action.success);
        assert!(!action.error_message.is_empty());

        let repaired = svc
            .transcription_repair_test(Request::new(pb::TranscriptionRepairTestRequest {
                transcription: "play the best song by miles davis".to_owned(),
                immutable_tokens: Vec::new(),
            }))
            .await
            .expect("transcription_repair_test ok")
            .into_inner();
        assert!(repaired.success);
        // Identity repair: input echoed back, nothing invented.
        assert_eq!(
            repaired.corrected_transcription,
            "play the best song by miles davis",
        );
    }

    #[tokio::test]
    async fn completion_like_rpcs_return_model_backed_results_without_external_setup() {
        use prost::Message as _;
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("kid-test".to_owned(), [3u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let svc = AiBusMain::with_key_material(keys.clone());

        let completion = pb::CompletionRequest {
            prompt: "Summarize this one-liner".to_owned(),
            ..Default::default()
        };
        let completion_sealed = keys
            .seal("kid-test", &completion.encode_to_vec(), b"")
            .expect("seal completion request");
        let completion = svc
            .encrypted_completion(Request::new(pb::EncryptedCompletionRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: completion_sealed.kid,
                        },
                    ),
                    data: completion_sealed.data,
                }),
            }))
            .await
            .expect("encrypted_completion should return a typed response")
            .into_inner()
            .response
            .expect("completion response present");
        let completion_payload = keys
            .open(&cosmos_crypto::EncryptedData {
                data: completion.data,
                kid: completion
                    .encryption_information
                    .map(|i| i.kid)
                    .unwrap_or_default(),
            })
            .expect("completion response opens");
        let completion_response = pb::CompletionResponse::decode(completion_payload.as_slice())
            .expect("completion response is valid protobuf");
        assert!(!completion_response.choices.is_empty());
        assert!(!completion_response.choices[0].text.trim().is_empty());

        let chat = pb::ChatCompletionRequest {
            messages: vec![pb::ChatCompletionMessage {
                role: "user".to_owned(),
                content: "Tell me a weather-safe fact.".to_owned(),
                tool_calls: Vec::new(),
                name: String::new(),
                tool_call_id: String::new(),
            }],
            stream: false,
            ..Default::default()
        };
        let chat_sealed = keys
            .seal("kid-test", &chat.encode_to_vec(), b"")
            .expect("seal chat request");
        let chat = svc
            .encrypted_chat_completion(Request::new(pb::EncryptedChatCompletionRequest {
                request: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: chat_sealed.kid,
                        },
                    ),
                    data: chat_sealed.data,
                }),
            }))
            .await
            .expect("encrypted_chat_completion should return a typed response")
            .into_inner()
            .response
            .expect("chat response present");
        let chat_payload = keys
            .open(&cosmos_crypto::EncryptedData {
                data: chat.data,
                kid: chat
                    .encryption_information
                    .as_ref()
                    .map(|i| i.kid.clone())
                    .unwrap_or_default(),
            })
            .expect("chat response opens");
        let chat_response = pb::ChatCompletionResponse::decode(chat_payload.as_slice())
            .expect("chat response is valid protobuf");
        assert_eq!(chat_response.choices.len(), 1);
        // The turn must contain something the sub-agent can act on: spoken text OR
        // a tool call. Requiring non-empty CONTENT was right only while this RPC
        // served no tools — now that it resolves a tool set, a pure tool-call step
        // legitimately has empty content, exactly as an OpenAI-shaped endpoint
        // returns it. What must never happen is a response containing neither.
        let message = chat_response.choices[0]
            .message
            .as_ref()
            .expect("a choice carries a message");
        assert!(
            !message.content.trim().is_empty() || !message.tool_calls.is_empty(),
            "a chat completion must return spoken text or a tool call, got neither",
        );
    }

    #[tokio::test]
    async fn function_execution_runs_server_tools_without_secret_keys() {
        // The AuthLayer normally injects this; a unit test must supply it or the
        // tool correctly refuses to touch anyone's data.
        fn authenticated<T>(body: T) -> Request<T> {
            let mut request = Request::new(body);
            request.extensions_mut().insert(
                cosmos_core::AuthenticatedPrincipal::from_edge("test-wearer")
                    .expect("valid principal"),
            );
            request
        }

        let svc = AiBusMain::default();
        let response = svc
            .function_execution(authenticated(pb::FunctionCall {
                name: "recall_memory".to_owned(),
                arguments: r#"{"query":"anything"}"#.to_owned(),
                ..Default::default()
            }))
            .await
            .expect("function_execution should run")
            .into_inner();
        assert_eq!(
            response.response,
            "Nothing the wearer saved matches \"anything\".",
        );
    }

    #[tokio::test]
    async fn encrypted_function_execution_runs_server_tools() {
        fn authenticated<T>(body: T) -> Request<T> {
            let mut request = Request::new(body);
            request.extensions_mut().insert(
                cosmos_core::AuthenticatedPrincipal::from_edge("test-wearer")
                    .expect("valid principal"),
            );
            request
        }

        use prost::Message as _;

        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert("kid-test".to_owned(), [3u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        let svc = AiBusMain::with_key_material(keys.clone());

        let call = pb::FunctionCall {
            name: "recall_memory".to_owned(),
            arguments: r#"{"query":"anything"}"#.to_owned(),
            ..Default::default()
        };
        let sealed = keys
            .seal("kid-test", &call.encode_to_vec(), b"")
            .expect("seal request");

        let response = svc
            .encrypted_function_execution(authenticated(pb::EncryptedFunctionCall {
                function_call: Some(cosmos_protocol::common::encryption::EncryptedData {
                    encryption_information: Some(
                        cosmos_protocol::common::encryption::EncryptionInformation {
                            kid: sealed.kid.clone(),
                        },
                    ),
                    data: sealed.data,
                }),
                location: None,
            }))
            .await
            .expect("encrypted_function_execution should run")
            .into_inner()
            .response
            .expect("response body");

        let opened = keys
            .open(&cosmos_crypto::EncryptedData {
                data: response.data,
                kid: response
                    .encryption_information
                    .map(|i| i.kid)
                    .unwrap_or_default(),
            })
            .expect("responses are sealed under the established key");
        let function_response =
            pb::FunctionResponse::decode(opened.as_slice()).expect("valid function response");
        assert_eq!(
            function_response.response,
            "Nothing the wearer saved matches \"anything\".",
        );
    }

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
    async fn typed_ai_bus_dispatches_completion_and_rejects_audio_without_speech() {
        use pb::ai_request::Capabilityrequest;
        use pb::open_ai_completion_request::Completiontype;

        let service = AiBusMain::default();
        let completion = service
            .process_ai_request(pb::AiRequest {
                capabilityrequest: Some(Capabilityrequest::CompletionRequest(
                    pb::OpenAiCompletionRequest {
                        completiontype: Some(Completiontype::GenericCompletion(
                            pb::GenericCompletionRequest {
                                raw_question: "What can this deployment do?".to_owned(),
                                ..Default::default()
                            },
                        )),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            })
            .await
            .expect("completion is a typed AIResponse even without external setup");
        assert!(completion.completion_response.is_some());
        assert!(completion.audio_processing_response.is_none());

        // An empty audio request (no sub-op set) is a malformed request.
        let audio = service
            .process_ai_request(pb::AiRequest {
                capabilityrequest: Some(Capabilityrequest::AudioProcessingRequest(
                    pb::AudioProcessingRequest::default(),
                )),
                ..Default::default()
            })
            .await
            .expect_err("an empty audio request is rejected");
        assert_eq!(audio.code(), tonic::Code::InvalidArgument);

        // Transcription with real audio but no dashboard-configured STT backend:
        // an honest availability error, never a fabricated transcript. (Empty
        // audio would be rejected earlier as InvalidArgument, so send non-empty
        // bytes to reach the backend-presence check.)
        let stt = service
            .process_ai_request(pb::AiRequest {
                capabilityrequest: Some(Capabilityrequest::AudioProcessingRequest(
                    pb::AudioProcessingRequest {
                        google_transcribe_request: Some(pb::GoogleTranscribeRequest {
                            audio_data: Some(pb::AudioData {
                                audio_bytes: vec![1, 2, 3, 4],
                                ..Default::default()
                            }),
                        }),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            })
            .await
            .expect_err("no STT backend configured in tests");
        assert_eq!(stt.code(), tonic::Code::Unavailable);
    }

    #[tokio::test]
    async fn upload_requires_a_real_use_case_before_contacting_a_signer() {
        let err = AiBusMain::default()
            .upload_file(Request::new(pb::UploadFileRequest::default()))
            .await
            .expect_err("unset upload must not mint a placeholder URL");
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }
}
