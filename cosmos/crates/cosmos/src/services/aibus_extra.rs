//! Stock supporting services. Storage and speech wire adapters remain here.
//! Cognitive provider calls and private semantic search are unsupported until
//! origin-scoped runtime services mediate them. Encrypted responses retain
//! the established PublicPrivacyService channel and stock payload identities.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;

use base64::Engine as _;
use prost::Message;
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status};

use cosmos_protocol::aibus as pb;
use cosmos_protocol::common::encryption::EncryptedData;

use pb::amazon_shopping_service_server::AmazonShoppingService;
use pb::composition_service_server::CompositionService;
use pb::device_messages_service_server::DeviceMessagesService;
use pb::food_service_server::FoodService;
use pb::speech_service_server::SpeechService;
use pb::test_automation_service_server::TestAutomationService;
use pb::web_search_service_server::WebSearchService;

use crate::assistant::llm::{ChatModel, ConfiguredChatModel};
use crate::backends::azure_speech::{
    AzureSpeechError, SpeechAudioFormat, SpeechRecognitionBackend, SpeechSynthesisBackend,
    configured_backend, configured_recognition_backend,
};

const STATE_CAS_RETRIES: usize = 32;
const MAX_STORED_MESSAGES: usize = 10_000;
const MAX_CALENDAR_EVENTS: usize = 2_000;

fn configured_model() -> Option<Arc<dyn ChatModel>> {
    Some(Arc::new(ConfiguredChatModel::external_only()))
}

async fn model_text(
    model: &Arc<dyn ChatModel>,
    capability: &str,
    system: impl Into<String>,
    prompt: impl Into<String>,
) -> Result<String, Status> {
    let _ = (model, capability, system, prompt);
    Err(Status::unimplemented(
        "this capability requires a runtime semantic service",
    ))
}

fn locale_name(locale: Option<&cosmos_protocol::common::Locale>) -> String {
    let Some(locale) = locale else {
        return "unspecified language".to_owned();
    };
    match (locale.language.trim(), locale.country.trim()) {
        ("", "") => "unspecified language".to_owned(),
        (language, "") => language.to_owned(),
        ("", country) => country.to_owned(),
        (language, country) => format!("{language}-{country}"),
    }
}

fn same_locale(
    from: Option<&cosmos_protocol::common::Locale>,
    to: Option<&cosmos_protocol::common::Locale>,
) -> bool {
    matches!((from, to), (Some(from), Some(to))
        if !from.language.is_empty()
            && from.language.eq_ignore_ascii_case(&to.language)
            && (from.country.is_empty()
                || to.country.is_empty()
                || from.country.eq_ignore_ascii_case(&to.country)))
}

async fn open_request<T: Message + Default>(
    keys: &crate::keymaterial::SharedKeyMaterial,
    directory: Option<&crate::keydirectory::SharedKeyDirectory>,
    data: Option<EncryptedData>,
    capability: &str,
) -> Result<(T, String), Status> {
    let data = data.ok_or_else(|| Status::invalid_argument("missing encrypted request"))?;
    let kid = data
        .encryption_information
        .as_ref()
        .map(|i| i.kid.clone())
        .unwrap_or_default();
    let envelope = cosmos_crypto::EncryptedData {
        data: data.data,
        kid: kid.clone(),
    };
    let plaintext = if let Some(directory) = directory {
        match directory
            .open(&envelope)
            .await
            .map_err(|error| crate::keydirectory::grpc_status(&error))?
        {
            Some(plaintext) => plaintext,
            None => {
                crate::services::public_privacy::note_unknown_kid(&kid);
                return Err(Status::failed_precondition(format!(
                    "no channel key for kid {kid} on {capability}; queued for re-establishment via PublicPrivacyService SyncKeys",
                )));
            }
        }
    } else {
        if keys.is_empty().map_err(|error| {
            crate::services::public_privacy::key_material_availability_status(&error)
                .unwrap_or_else(|| Status::internal("could not inspect channel-key state"))
        })? {
            return Err(Status::failed_precondition(format!(
                "no ephemeral channel key established for {capability}; call PublicPrivacyService EstablishWrappingKeys/ImportKeys first",
            )));
        }
        keys.open(&envelope).map_err(|e| {
            if let Some(status) =
                crate::services::public_privacy::key_material_availability_status(&e)
            {
                return status;
            }
            match e {
            // The device is sealing under a kid this server has no key for —
            // typically a channel established before key material was persisted.
            // That is a precondition failure, not an authorization one, and
            // saying so honestly (with the kid) is what tells an operator which
            // channel is stranded. Recording it also arms the only server-driven
            // repair there is: the next `SyncKeys` returns this kid in
            // `delete_kids`, which makes the device drop and re-upload the key.
            // See `services::public_privacy` for the full device-side chain.
            cosmos_crypto::CryptoError::UnknownKid(_) => {
                crate::services::public_privacy::note_unknown_kid(&kid);
                Status::failed_precondition(format!(
                    "no channel key for kid {kid} on {capability}; queued for re-establishment via PublicPrivacyService SyncKeys",
                ))
            }
            // A key we *do* hold that failed to open the envelope: bad tag, bad
            // AAD, truncated payload. Nothing to re-establish, and this kid must
            // never reach the re-establish queue — deleting a working key would
            // strand a healthy channel.
            _ => Status::permission_denied(format!(
                "could not open encrypted request for {capability}"
            )),
            }
        })?
    };
    let parsed = T::decode(plaintext.as_slice()).map_err(|_| {
        Status::invalid_argument(format!("malformed encrypted request for {capability}"))
    })?;
    Ok((parsed, kid))
}

/// Seal a plaintext protobuf response back under the request's channel key,
/// binding the envelope to the response TYPE via its AAD.
///
/// `type_name` MUST be the fully-qualified *Java* class name of the payload.
/// `CoreSecureChannel.encryptProto` sets the AAD from `data.getClass().getName()`
/// (CoreSecureChannel.java:111), and the matching `decryptProto` rejects an empty
/// AAD outright — "Cannot reconstruct protobuf with null/empty AAD"
/// (CoreSecureChannel.java:167) — then does `Class.forName(aad)` to pick the
/// parser (CoreSecureChannel.java:172). `EphemeralProtectionManager.decrypt`
/// (EphemeralProtectionManager.java:130) returns an unconstrained generic, so
/// that AAD string is the ONLY thing that determines how the device parses the
/// body. An empty AAD is unopenable; a wrong one throws ClassNotFoundException.
///
/// The device's `humane.aibus` protos are generated with `java_multiple_files`,
/// so each message is a top-level class in package `humane.aibus` and the Java
/// FQ name coincides with the protobuf FQ name (e.g.
/// `sources/humane/aibus/CanTranslateResponse.java:1` declares
/// `package humane.aibus;`). `AiBusMain::seal_response` does the same thing.
async fn seal_response<T: Message>(
    keys: &crate::keymaterial::SharedKeyMaterial,
    directory: Option<&crate::keydirectory::SharedKeyDirectory>,
    kid: &str,
    response: &T,
    capability: &str,
    type_name: &str,
) -> Result<EncryptedData, Status> {
    let encoded = response.encode_to_vec();
    let sealed = if let Some(directory) = directory {
        directory
            .seal(kid, &encoded, type_name.as_bytes())
            .await
            .map_err(|error| crate::keydirectory::grpc_status(&error))?
            .ok_or_else(|| Status::failed_precondition("the response channel key is absent"))?
    } else {
        keys.seal(kid, &encoded, type_name.as_bytes())
            .map_err(|error| {
                crate::services::public_privacy::key_material_availability_status(&error)
                    .unwrap_or_else(|| {
                        Status::internal(format!("failed to seal response for {capability}"))
                    })
            })?
    };
    Ok(EncryptedData {
        encryption_information: Some(cosmos_protocol::common::encryption::EncryptionInformation {
            kid: sealed.kid,
        }),
        data: sealed.data,
    })
}

// The AAD strings for this module's five encrypted responses. Each is the
// fully-qualified Java class of the message we actually seal, confirmed present
// in the decompiled stock client — `Class.forName` must resolve it and the class
// must expose `parseFrom`, which every `GeneratedMessageLite` in `humane.aibus`
// does. Named rather than inlined so the regression test asserts the exact
// strings the handlers pass.

/// `sources/humaneinternal/system/aibus/AIBusService.java:329` casts the
/// decrypted `EncryptedCanTranslateResponse.data` to this type (channel
/// `ai_bus.speech`). Class: `sources/humane/aibus/CanTranslateResponse.java:14`.
const CAN_TRANSLATE_RESPONSE: &str = "humane.aibus.CanTranslateResponse";

/// `sources/humaneinternal/system/aibus/AIBusService.java:339` casts the
/// decrypted `EncryptedTranslateTextResponse.data` to this type (channel
/// `ai_bus.speech`). Class: `sources/humane/aibus/TranslateTextResponse.java:16`.
const TRANSLATE_TEXT_RESPONSE: &str = "humane.aibus.TranslateTextResponse";
const TRANSLATE_CONVERSATION_RESPONSE: &str = "humane.aibus.TranslateConversationResponse";

/// `sources/humaneinternal/system/notifications/NotificationSummarizer.java:204`
/// casts the decrypted `EncryptedSummarizationNetworkResponse.response` to this
/// type (channel `ai_bus.summarization`). Class:
/// `sources/humane/aibus/SummarizationNetworkResponse.java:19`.
const SUMMARIZATION_NETWORK_RESPONSE: &str = "humane.aibus.SummarizationNetworkResponse";

/// Class: `sources/humane/aibus/MessageCompositionResponse.java:15`
/// (`package humane.aibus;` at :1). This build of the stock client has no
/// composition caller — no `EphemeralChannelId` for it exists in
/// `sources/hu/ma/ne/krypton/ephemeral/EphemeralChannelId.java` — so there is no
/// decrypt-site cast to cite. The name is still exact rather than guessed: AAD is
/// `data.getClass().getName()` of the payload, and the payload we seal *is* a
/// `MessageCompositionResponse`. Deliberately NOT the same-named
/// `sources/humane/system/composition/MessageCompositionResponse.java:7`, which is
/// a Parcelable with no `parseFrom` — that is the IPC shape handed to the
/// composition experience, never the wire shape.
const MESSAGE_COMPOSITION_RESPONSE: &str = "humane.aibus.MessageCompositionResponse";

/// Class: `sources/humane/aibus/FoodIdentifyResponse.java:19`
/// (`package humane.aibus;` at :1). Same situation as composition — no food
/// `EphemeralChannelId` in this build, so no decrypt-site cast — but this is
/// demonstrably the food result type the device consumes:
/// `sources/humaneinternal/system/food/FoodItemModel.java:53` takes one in its
/// constructor and
/// `sources/humaneinternal/system/intent/interpreters/regex/RegexInterpreter.java:108`
/// serializes captured ones into `device_payload`.
const FOOD_IDENTIFY_RESPONSE: &str = "humane.aibus.FoodIdentifyResponse";

fn categorize_notification(notification: &pb::NotificationForSummarization) -> i32 {
    let haystack = format!(
        " {} {} {} {} ",
        notification.app_name, notification.title, notification.message, notification.subtitle
    )
    .to_ascii_lowercase();

    if haystack.contains("urgent")
        || haystack.contains("asap")
        || haystack.contains("overdue")
        || haystack.contains("expired")
        || haystack.contains("security")
        || haystack.contains("action required")
    {
        return pb::notification_categories::Category::TimeSensitive as i32;
    }

    if haystack.contains("promo")
        || haystack.contains("newsletter")
        || haystack.contains("sale")
        || haystack.contains("spam")
        || haystack.contains("advertisement")
    {
        return pb::notification_categories::Category::Junk as i32;
    }

    pb::notification_categories::Category::Informational as i32
}

/// `humane.aibus.AmazonShoppingService` — "look at this product and shop for it".
#[derive(Clone, Default)]
pub struct AmazonShopping;

#[tonic::async_trait]
impl AmazonShoppingService for AmazonShopping {
    async fn visual_search(
        &self,
        request: Request<pb::VisualSearchRequest>,
    ) -> Result<Response<pb::VisualSearchResponse>, Status> {
        let images = request.into_inner().image_data;
        if images.is_empty() || images.iter().any(Vec::is_empty) {
            return Err(Status::invalid_argument(
                "visual_search requires image bytes",
            ));
        }
        let product = crate::backends::shopping::visual_search(&images)
            .await
            .map_err(|error| match error {
                crate::backends::BackendError::NotConfigured => {
                    Status::failed_precondition("shopping visual-search backend is not configured")
                }
                crate::backends::BackendError::NoResult => {
                    Status::not_found("no catalog product matched the image")
                }
                crate::backends::BackendError::Unavailable => {
                    Status::unavailable("shopping visual-search backend is unavailable")
                }
            })?;
        Ok(Response::new(pb::VisualSearchResponse {
            title: product.title,
            price_usd: product.price_usd,
            deep_link: product.deep_link,
            star_rating: product.star_rating,
        }))
    }
}

/// `humane.aibus.CompositionService` — notification triage, message drafting, and
/// conversation/notification summarization. Every RPC is an LLM task (two of them
/// additionally over service-scoped encrypted envelopes).
#[derive(Clone)]
pub struct Composition {
    keys: crate::keymaterial::SharedKeyMaterial,
    directory: Option<crate::keydirectory::SharedKeyDirectory>,
    model: Option<Arc<dyn ChatModel>>,
}

impl Default for Composition {
    fn default() -> Self {
        Self {
            keys: Default::default(),
            directory: None,
            model: configured_model(),
        }
    }
}

impl Composition {
    pub fn with_key_material(keys: crate::keymaterial::SharedKeyMaterial) -> Self {
        Self {
            keys,
            directory: None,
            model: configured_model(),
        }
    }

    pub fn with_key_directory(
        mut self,
        directory: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        self.directory = Some(directory);
        self
    }

    async fn summarize_or_fallback(
        &self,
        source: &str,
        content: String,
        fallback: String,
    ) -> (String, bool) {
        if content.trim().is_empty() {
            return (fallback, false);
        }
        let Some(model) = self.model.as_ref() else {
            return (fallback, false);
        };
        match model_text(
            model,
            "summarization",
            "Summarize the supplied wearable notification or conversation content concisely. Preserve important people, actions, dates, and urgency. Do not invent details. Return only the summary.",
            format!("Content type: {source}\n\n{content}"),
        )
        .await
        {
            Ok(summary) => (summary, false),
            Err(_) => (fallback, true),
        }
    }
}

#[tonic::async_trait]
impl CompositionService for Composition {
    async fn categorize_notifications(
        &self,
        request: Request<pb::NotificationsForSummarization>,
    ) -> Result<Response<pb::NotificationCategories>, Status> {
        let mut result = Vec::new();
        for notification in &request.into_inner().notifications {
            result.push(categorize_notification(notification));
        }
        // Empty input yields an empty, valid envelope rather than fabricated
        // categories.
        Ok(Response::new(pb::NotificationCategories {
            categories: result,
        }))
    }

    async fn encrypted_compose_message(
        &self,
        _request: Request<pb::EncryptedMessageCompositionRequest>,
    ) -> Result<Response<pb::EncryptedMessageCompositionResponse>, Status> {
        let request = _request.into_inner();
        let (req, kid): (pb::MessageCompositionRequest, _) = open_request(
            &self.keys,
            self.directory.as_ref(),
            request.request,
            "ComposeMessage",
        )
        .await?;
        if req.text.trim().is_empty() {
            return Err(Status::invalid_argument(
                "message composition requires source text",
            ));
        }
        let model = self.model.as_ref().ok_or_else(|| {
            Status::failed_precondition(
                "message composition requires an assistant provider in Center",
            )
        })?;
        let source = match req.r#type {
            value if value == pb::MessageSourceType::Email as i32 => "email",
            value if value == pb::MessageSourceType::Twitter as i32 => "social post",
            value if value == pb::MessageSourceType::Slack as i32 => "work chat message",
            _ => "message",
        };
        let formal_prompt = format!("Source type: {source}\nText:\n{}", req.text);
        let casual_prompt = formal_prompt.clone();
        let (formal, casual) = tokio::join!(
            model_text(
                model,
                "message composition",
                "Rewrite the supplied text in a polished formal style. Preserve its meaning and facts. Return only the rewritten text, with no label or quotation marks.",
                formal_prompt,
            ),
            model_text(
                model,
                "message composition",
                "Rewrite the supplied text in a natural casual style. Preserve its meaning and facts. Return only the rewritten text, with no label or quotation marks.",
                casual_prompt,
            )
        );
        let response = pb::MessageCompositionResponse {
            r#type: req.r#type,
            formal: formal?,
            casual: casual?,
        };
        let response = pb::EncryptedMessageCompositionResponse {
            response: Some(
                seal_response(
                    &self.keys,
                    self.directory.as_ref(),
                    &kid,
                    &response,
                    "ComposeMessage",
                    MESSAGE_COMPOSITION_RESPONSE,
                )
                .await?,
            ),
        };
        Ok(Response::new(response))
    }

    async fn encrypted_summarize_messages(
        &self,
        _request: Request<pb::EncryptedSummarizationNetworkRequest>,
    ) -> Result<Response<pb::EncryptedSummarizationNetworkResponse>, Status> {
        let request = _request.into_inner();
        let (req, kid): (pb::SummarizationNetworkRequest, _) = open_request(
            &self.keys,
            self.directory.as_ref(),
            request.request,
            "Summarization",
        )
        .await?;

        let mut summaries = Vec::new();

        for group in req.conversation_group {
            let fallback = if group.messages_from_users.is_empty() {
                "No conversation messages to summarize.".to_owned()
            } else {
                let first = group
                    .messages_from_users
                    .first()
                    .map_or("", |m| m.message.as_str());
                let participants = if group.participants.is_empty() {
                    "one".to_owned()
                } else {
                    group.participants.join(", ")
                };
                format!("Conversation summary for {participants}: {first}")
            };
            let content = group
                .conversation_history
                .iter()
                .chain(group.messages_from_users.iter())
                .map(|message| {
                    format!(
                        "{}: {}",
                        if message.sent_by_self {
                            "wearer"
                        } else {
                            "participant"
                        },
                        message.message
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let (summary, failed) = self
                .summarize_or_fallback("conversation", content, fallback)
                .await;
            summaries.push(pb::SummarizationResponse {
                summary,
                failed,
                id: group.id,
            });
        }

        for group in req.notifications_group {
            let application = group
                .notification
                .first()
                .map_or("Notification", |n| n.app_name.as_str());
            let fallback = if group.notification.is_empty() {
                "No notifications to summarize.".to_owned()
            } else {
                let titles: Vec<_> = group
                    .notification
                    .iter()
                    .map(|n| n.title.as_str())
                    .collect();
                format!(
                    "{} notifications from {application}: {}",
                    titles.len(),
                    titles.join(", ")
                )
            };
            let content = group
                .notification
                .iter()
                .map(|notification| {
                    format!(
                        "{} — {}: {}",
                        notification.app_name, notification.title, notification.message
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let (summary, failed) = self
                .summarize_or_fallback("notifications", content, fallback)
                .await;
            summaries.push(pb::SummarizationResponse {
                summary,
                failed,
                id: group.id,
            });
        }

        for group in req.missed_call_group {
            let calls = group.missed_calls.len();
            let callers: Vec<_> = group
                .missed_calls
                .iter()
                .map(|call| call.caller.as_str())
                .collect();
            summaries.push(pb::SummarizationResponse {
                summary: format!(
                    "{calls} missed call(s) from {}",
                    if callers.is_empty() {
                        "unknown".to_owned()
                    } else {
                        callers.join(", ")
                    }
                ),
                failed: false,
                id: group.id,
            });
        }

        let response = pb::SummarizationNetworkResponse {
            summary_group: summaries,
        };
        let response = pb::EncryptedSummarizationNetworkResponse {
            response: Some(
                seal_response(
                    &self.keys,
                    self.directory.as_ref(),
                    &kid,
                    &response,
                    "Summarization",
                    SUMMARIZATION_NETWORK_RESPONSE,
                )
                .await?,
            ),
        };
        Ok(Response::new(response))
    }

    async fn summarize_notifications(
        &self,
        request: Request<pb::SummarizeNotificationsRequest>,
    ) -> Result<Response<pb::SummarizeNotificationsResponse>, Status> {
        let wrapped = request.into_inner().notifications.unwrap_or_default();
        let mut by_app: BTreeMap<String, Vec<String>> = BTreeMap::new();

        for n in wrapped.notifications {
            by_app
                .entry(if n.app_name.is_empty() {
                    "Unknown app".to_owned()
                } else {
                    n.app_name
                })
                .or_default()
                .push(if n.message.trim().is_empty() {
                    n.title
                } else {
                    format!("{}: {}", n.title, n.message)
                });
        }

        let mut summaries = Vec::with_capacity(by_app.len());
        for (app, entries) in by_app {
            let content = entries.join("\n");
            let fallback = if content.is_empty() {
                "No notification bodies available.".to_owned()
            } else {
                format!("Notification update(s): {}", entries.join(", "))
            };
            let (summary, _) = self
                .summarize_or_fallback("notifications", content, fallback)
                .await;
            summaries.push(pb::ApplicationSummary {
                application: app,
                summary,
            });
        }

        Ok(Response::new(pb::SummarizeNotificationsResponse {
            summaries,
        }))
    }
}

/// `humane.aibus.DeviceMessagesService` — durable, wearer-scoped SMS/MMS backup,
/// query, and attachment upload capabilities.
#[derive(Clone)]
pub struct DeviceMessages {
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
    objects: Option<Arc<crate::services::capture::CaptureObjectStore>>,
    upload_endpoint: crate::services::capture::Endpoint,
}

impl DeviceMessages {
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
    ) -> Self {
        Self {
            authenticator,
            store,
            objects: crate::services::capture::configured_object_store(),
            upload_endpoint: crate::services::capture::Endpoint::from_environment(
                crate::services::capture::UPLOAD_BASE_URL_ENV,
            ),
        }
    }

    #[cfg(test)]
    fn with_objects(
        store: crate::store::SharedStore,
        objects: Arc<crate::services::capture::CaptureObjectStore>,
        upload_base: &str,
    ) -> Self {
        Self {
            authenticator: crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store,
            objects: Some(objects),
            upload_endpoint: crate::services::capture::Endpoint::parse(upload_base),
        }
    }
}

impl Default for DeviceMessages {
    fn default() -> Self {
        Self::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            crate::store::MemoryStore::shared(),
        )
    }
}

fn message_in_window(
    message: &pb::Message,
    start: Option<&prost_types::Timestamp>,
    end: Option<&prost_types::Timestamp>,
) -> bool {
    let Some(timestamp) = message.timestamp.as_ref() else {
        return start.is_none() && end.is_none();
    };
    let instant = (timestamp.seconds, timestamp.nanos);
    start.is_none_or(|value| instant >= (value.seconds, value.nanos))
        && end.is_none_or(|value| instant <= (value.seconds, value.nanos))
}

#[tonic::async_trait]
impl DeviceMessagesService for DeviceMessages {
    async fn backup_messages(
        &self,
        request: Request<pb::BackupMessagesRequest>,
    ) -> Result<Response<pb::BackupMessagesResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let messages = request.into_inner().messages;
        if messages.len() > MAX_STORED_MESSAGES {
            return Err(Status::resource_exhausted("message backup is too large"));
        }
        let owner = principal.expose_for_authorization();
        for _ in 0..STATE_CAS_RETRIES {
            let previous = self
                .store
                .get_account_blob(owner, crate::store::AccountBlobKind::DeviceMessages)
                .await?;
            let mut stored = previous
                .as_deref()
                .and_then(|bytes| pb::QueryMessagesResponse::decode(bytes).ok())
                .unwrap_or_default();
            for incoming in &messages {
                let existing = if incoming.device_message_id.is_empty() {
                    let encoded = incoming.encode_to_vec();
                    stored
                        .messages
                        .iter()
                        .position(|message| message.encode_to_vec() == encoded)
                } else {
                    stored
                        .messages
                        .iter()
                        .position(|message| message.device_message_id == incoming.device_message_id)
                };
                match existing {
                    Some(index) => stored.messages[index] = incoming.clone(),
                    None => stored.messages.push(incoming.clone()),
                }
            }
            stored.messages.sort_by_key(|message| {
                message
                    .timestamp
                    .as_ref()
                    .map(|value| (value.seconds, value.nanos))
                    .unwrap_or_default()
            });
            if stored.messages.len() > MAX_STORED_MESSAGES {
                let remove = stored.messages.len() - MAX_STORED_MESSAGES;
                stored.messages.drain(..remove);
            }
            if self
                .store
                .compare_and_swap_account_blob(
                    owner,
                    crate::store::AccountBlobKind::DeviceMessages,
                    previous.as_deref(),
                    &stored.encode_to_vec(),
                )
                .await?
            {
                return Ok(Response::new(pb::BackupMessagesResponse { messages }));
            }
        }
        Err(Status::aborted(
            "message backup changed concurrently; retry",
        ))
    }

    async fn query_messages(
        &self,
        request: Request<pb::QueryMessagesRequest>,
    ) -> Result<Response<pb::QueryMessagesResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let query = request.into_inner();
        let mut stored = self
            .store
            .get_account_blob(
                principal.expose_for_authorization(),
                crate::store::AccountBlobKind::DeviceMessages,
            )
            .await?
            .as_deref()
            .and_then(|bytes| pb::QueryMessagesResponse::decode(bytes).ok())
            .unwrap_or_default();
        stored.messages.retain(|message| {
            (query.user_phone_number.is_empty()
                || message.user_phone_number == query.user_phone_number)
                && message_in_window(message, query.start_time.as_ref(), query.end_time.as_ref())
        });
        Ok(Response::new(stored))
    }

    async fn upload_attachment(
        &self,
        request: Request<pb::UploadAttachmentRequest>,
    ) -> Result<Response<pb::UploadAttachmentResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let filename = request.into_inner().filename;
        if filename.trim().is_empty() {
            return Err(Status::invalid_argument(
                "upload attachment requires filename",
            ));
        }
        let objects = self.objects.as_ref().ok_or_else(|| {
            Status::failed_precondition("message attachment storage is not configured")
        })?;
        let token =
            objects.grant_message_attachment(principal.expose_for_authorization(), filename.trim());
        let url = self
            .upload_endpoint
            .resource_url(crate::services::capture::UPLOAD_BASE_URL_ENV, &token)?;
        Ok(Response::new(pb::UploadAttachmentResponse { url }))
    }
}

/// `humane.aibus.FoodService` — food-image identification and post-hoc feedback.
#[derive(Clone, Default)]
pub struct Food {
    keys: crate::keymaterial::SharedKeyMaterial,
    directory: Option<crate::keydirectory::SharedKeyDirectory>,
}

impl Food {
    pub fn with_key_material(keys: crate::keymaterial::SharedKeyMaterial) -> Self {
        Self {
            keys,
            directory: None,
        }
    }

    pub fn with_key_directory(
        mut self,
        directory: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        self.directory = Some(directory);
        self
    }
}

#[tonic::async_trait]
impl FoodService for Food {
    async fn encrypted_identify_food(
        &self,
        _request: Request<pb::EncryptedFoodIdentifyRequest>,
    ) -> Result<Response<pb::EncryptedFoodIdentifyResponse>, Status> {
        let request = _request.into_inner();
        let (req, kid): (pb::FoodIdentifyRequest, _) = open_request(
            &self.keys,
            self.directory.as_ref(),
            request.request,
            "FoodIdentify",
        )
        .await?;

        if req.text.trim().is_empty() {
            if req.image_data.is_empty() {
                return Err(Status::invalid_argument(
                    "food identification requires image bytes or descriptive text",
                ));
            }
            return Err(Status::failed_precondition(
                "food image identification requires a configured vision backend",
            ));
        }
        // Text -> real nutrition via Open Food Facts (the keyless substitute for
        // cosmos's Nutritionix backend). A no-match echoes the text with empty
        // nutrition (the device narrates "couldn't get that info"); an unreachable
        // provider is an honest error. Nothing is fabricated.
        let (item_name, barcode, serving_size, nutrient, ingredients, brand) =
            match crate::backends::food::lookup(req.text.trim()).await {
                Ok(item) => (
                    item.item_name,
                    item.barcode,
                    item.serving_size,
                    // `FoodIdentifyResponse.nutrient` is aibus::NutritionInfo;
                    // `food::lookup` returns common::food::NutritionInfo. Same
                    // fields + same NutrientType enum — copy across.
                    item.nutrition
                        .into_iter()
                        .map(|n| pb::NutritionInfo {
                            nutrient_type: n.nutrient_type,
                            value: n.value,
                        })
                        .collect(),
                    item.ingredients,
                    item.brand,
                ),
                Err(crate::backends::BackendError::NoResult) => (
                    req.text.clone(),
                    String::new(),
                    String::new(),
                    Vec::new(),
                    Vec::new(),
                    String::new(),
                ),
                Err(_) => {
                    return Err(Status::unavailable("the nutrition backend is unavailable"));
                }
            };

        let response = pb::FoodIdentifyResponse {
            item_name,
            barcode,
            serving_size,
            nutrient,
            ingredients,
            request_uuid: req.request_uuid.clone(),
            brand,
            debug_image_s3_location: String::new(),
            is_previous: false,
            item_id: String::new(),
            third_party_request_id: req.request_uuid,
            debug_image_blob_store_location: String::new(),
        };
        let response = pb::EncryptedFoodIdentifyResponse {
            best_response: Some(
                seal_response(
                    &self.keys,
                    self.directory.as_ref(),
                    &kid,
                    &response,
                    "FoodIdentify",
                    FOOD_IDENTIFY_RESPONSE,
                )
                .await?,
            ),
            alternate_responses: Vec::new(),
        };
        Ok(Response::new(response))
    }

    async fn feedback(
        &self,
        _request: Request<pb::FoodFeedbackRequest>,
    ) -> Result<Response<pb::FoodFeedbackResponse>, Status> {
        // Fire-and-forget feedback report: acked with the empty success message.
        Ok(Response::new(pb::FoodFeedbackResponse {}))
    }
}

/// `humane.aibus.SpeechService` — local-TTS handoff and encrypted translation.
/// Text translation uses the configured OpenAI-compatible model. Conversation
/// translation remains unavailable until the clone has an audio transcription
/// backend; it never returns a fabricated empty transcript.
#[derive(Clone)]
pub struct Speech {
    keys: crate::keymaterial::SharedKeyMaterial,
    directory: Option<crate::keydirectory::SharedKeyDirectory>,
    model: Option<Arc<dyn ChatModel>>,
    speech: Option<Arc<dyn SpeechSynthesisBackend>>,
    recognition: Option<Arc<dyn SpeechRecognitionBackend>>,
}

impl Default for Speech {
    fn default() -> Self {
        Self {
            keys: Default::default(),
            directory: None,
            model: configured_model(),
            speech: configured_backend(),
            recognition: configured_recognition_backend(),
        }
    }
}

impl Speech {
    pub fn with_key_material(keys: crate::keymaterial::SharedKeyMaterial) -> Self {
        Self {
            keys,
            directory: None,
            model: configured_model(),
            speech: configured_backend(),
            recognition: configured_recognition_backend(),
        }
    }

    pub fn with_key_directory(
        mut self,
        directory: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        self.directory = Some(directory);
        self
    }

    #[cfg(test)]
    fn with_speech_backend(backend: Arc<dyn SpeechSynthesisBackend>) -> Self {
        Self {
            keys: Default::default(),
            directory: None,
            model: None,
            speech: Some(backend),
            recognition: None,
        }
    }
}

fn requested_speech_format(config: Option<&pb::SpeechConfig>) -> Result<SpeechAudioFormat, Status> {
    match config.map(|config| config.audio_format).unwrap_or_default() {
        0 => Ok(SpeechAudioFormat::Riff16Khz16BitMonoPcm),
        1 => Ok(SpeechAudioFormat::Raw16Khz16BitMonoPcm),
        2 => Ok(SpeechAudioFormat::Raw24Khz16BitMonoPcm),
        3 => Ok(SpeechAudioFormat::Audio24Khz160KBitrateMonoMp3),
        _ => Err(Status::invalid_argument(
            "unsupported text-to-speech audio format",
        )),
    }
}

fn recognition_wav(audio: &pb::Audio) -> Result<Vec<u8>, Status> {
    match audio.format {
        // Already RIFF/WAV, which is the stock format the short-audio backend
        // accepts directly.
        0 if audio.audio.starts_with(b"RIFF") => Ok(audio.audio.clone()),
        // Stock raw 16 kHz mono PCM: independently wrap it in the standard
        // 44-byte WAV container Azure's endpoint requires.
        1 => {
            let data_len = u32::try_from(audio.audio.len())
                .map_err(|_| Status::resource_exhausted("conversation audio is too large"))?;
            let mut wav = Vec::with_capacity(44 + audio.audio.len());
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36u32.saturating_add(data_len)).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16u32.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&16_000u32.to_le_bytes());
            wav.extend_from_slice(&32_000u32.to_le_bytes());
            wav.extend_from_slice(&2u16.to_le_bytes());
            wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data_len.to_le_bytes());
            wav.extend_from_slice(&audio.audio);
            Ok(wav)
        }
        0 => Err(Status::invalid_argument(
            "RIFF conversation audio is missing its WAV header",
        )),
        _ => Err(Status::invalid_argument(
            "conversation transcription supports RIFF or raw 16 kHz mono PCM",
        )),
    }
}

fn speech_response(audio: Vec<u8>, format: i32, transcription: String) -> pb::TextToSpeechResponse {
    pb::TextToSpeechResponse {
        speech: Some(pb::Audio { audio, format }),
        speech_transcription: transcription,
        source: pb::SpeechSource::SourceMicrosoftSpeechSynthesis as i32,
    }
}

fn speech_status(error: AzureSpeechError) -> Status {
    match error {
        AzureSpeechError::InvalidRequest => Status::invalid_argument("invalid speech request"),
        AzureSpeechError::InvalidConfiguration => {
            Status::failed_precondition("speech backend configuration is invalid")
        }
        AzureSpeechError::Unavailable | AzureSpeechError::ResponseTooLarge => {
            Status::unavailable("speech backend is unavailable")
        }
    }
}

#[tonic::async_trait]
impl SpeechService for Speech {
    async fn can_translate(
        &self,
        _request: Request<pb::EncryptedCanTranslateRequest>,
    ) -> Result<Response<pb::EncryptedCanTranslateResponse>, Status> {
        let request = _request.into_inner();
        let (req, kid): (pb::CanTranslateRequest, _) = open_request(
            &self.keys,
            self.directory.as_ref(),
            request.data,
            "CanTranslate",
        )
        .await?;
        let supported = match (&req.from, &req.to) {
            (_, Some(to)) if !to.language.trim().is_empty() => {
                same_locale(req.from.as_ref(), req.to.as_ref()) || self.model.is_some()
            }
            _ => false,
        };
        let response = pb::CanTranslateResponse {
            is_supported: supported,
        };
        let response = pb::EncryptedCanTranslateResponse {
            data: Some(
                seal_response(
                    &self.keys,
                    self.directory.as_ref(),
                    &kid,
                    &response,
                    "CanTranslate",
                    CAN_TRANSLATE_RESPONSE,
                )
                .await?,
            ),
        };
        Ok(Response::new(response))
    }

    type StreamingTextToSpeechStream =
        Pin<Box<dyn Stream<Item = Result<pb::TextToSpeechResponse, Status>> + Send + 'static>>;

    async fn streaming_text_to_speech(
        &self,
        request: Request<pb::TextToSpeechRequest>,
    ) -> Result<Response<Self::StreamingTextToSpeechStream>, Status> {
        let req = request.into_inner();
        if req.text.trim().is_empty() {
            return Err(Status::invalid_argument("text to speech requires text"));
        }
        let backend = self.speech.as_ref().ok_or_else(|| {
            Status::failed_precondition(
                "text to speech requires a configured speech-synthesis backend",
            )
        })?;
        let wire_format = req
            .speech_config
            .as_ref()
            .map(|config| config.audio_format)
            .unwrap_or_default();
        let format = requested_speech_format(req.speech_config.as_ref())?;
        let stream = backend
            .synthesize_stream(&req.text, format)
            .await
            .map_err(speech_status)?
            .map(move |chunk| {
                chunk
                    .map(|audio| speech_response(audio, wire_format, String::new()))
                    .map_err(speech_status)
            });
        Ok(Response::new(Box::pin(stream)))
    }

    async fn text_to_speech(
        &self,
        request: Request<pb::TextToSpeechRequest>,
    ) -> Result<Response<pb::TextToSpeechResponse>, Status> {
        let req = request.into_inner();
        if req.text.trim().is_empty() {
            return Err(Status::invalid_argument("text to speech requires text"));
        }
        let backend = self.speech.as_ref().ok_or_else(|| {
            Status::failed_precondition(
                "text to speech requires a configured speech-synthesis backend",
            )
        })?;
        let wire_format = req
            .speech_config
            .as_ref()
            .map(|config| config.audio_format)
            .unwrap_or_default();
        let format = requested_speech_format(req.speech_config.as_ref())?;
        let audio = backend
            .synthesize(&req.text, format)
            .await
            .map_err(speech_status)?;
        Ok(Response::new(speech_response(audio, wire_format, req.text)))
    }

    type TranslateConversationStream = Pin<
        Box<
            dyn Stream<Item = Result<pb::EncryptedTranslateConversationResponse, Status>>
                + Send
                + 'static,
        >,
    >;

    async fn translate_conversation(
        &self,
        request: Request<tonic::Streaming<pb::EncryptedTranslateConversationRequest>>,
    ) -> Result<Response<Self::TranslateConversationStream>, Status> {
        let recognition = self.recognition.clone().ok_or_else(|| {
            Status::failed_precondition(
                "conversation translation requires a configured speech-transcription backend",
            )
        })?;
        let model = self.model.clone();
        let speech = self.speech.clone();
        let keys = self.keys.clone();
        let directory = self.directory.clone();
        let mut inbound = request.into_inner();
        let responses = async_stream::try_stream! {
            while let Some(message) = inbound.next().await {
                let message = message.map_err(|_| Status::invalid_argument("invalid translate-conversation stream"))?;
                let (req, kid): (pb::TranslateConversationRequest, _) =
                    open_request(
                        &keys,
                        directory.as_ref(),
                        message.data,
                        "TranslateConversation",
                    )
                    .await?;
                let audio = req.audio.as_ref().ok_or_else(|| {
                    Status::invalid_argument("translate conversation requires audio bytes")
                })?;
                if audio.audio.is_empty() {
                    Err(Status::invalid_argument("translate conversation requires audio bytes"))?;
                }
                let config = req.config.as_ref().ok_or_else(|| {
                    Status::invalid_argument("translate conversation requires locale configuration")
                })?;
                let target = config.conversation_locale.clone().ok_or_else(|| {
                    Status::invalid_argument("translate conversation requires a target locale")
                })?;
                if target.language.trim().is_empty() {
                    Err(Status::invalid_argument("translate conversation requires a target locale"))?;
                }
                let wav = recognition_wav(audio)?;
                let source = config.device_locale.clone();
                let transcript = recognition
                    .transcribe(&wav, &locale_name(source.as_ref()))
                    .await
                    .map_err(speech_status)?;
                let translation = if transcript.is_empty()
                    || same_locale(source.as_ref(), Some(&target))
                {
                    transcript.clone()
                } else {
                    let model = model.as_ref().ok_or_else(|| {
                        Status::failed_precondition(
                            "conversation translation requires a configured translation model",
                        )
                    })?;
                    model_text(
                        model,
                        "conversation translation",
                        "Translate the supplied transcript accurately. Preserve names, numbers, and meaning. Return only the translation.",
                        format!(
                            "Translate from {} to {}:\n{}",
                            locale_name(source.as_ref()),
                            locale_name(Some(&target)),
                            transcript
                        ),
                    )
                    .await?
                };
                let translated_speech = match (speech.as_ref(), config.speech_config.as_ref()) {
                    (Some(backend), Some(speech_config)) if !translation.is_empty() => {
                        let format = requested_speech_format(Some(speech_config))?;
                        let bytes = backend.synthesize(&translation, format).await.map_err(speech_status)?;
                        Some(pb::Audio { audio: bytes, format: speech_config.audio_format })
                    }
                    _ => None,
                };
                let response = pb::TranslateConversationResponse {
                    transcript,
                    transcript_locale: source,
                    translation,
                    translation_locale: Some(target),
                    speech: translated_speech,
                };
                yield pb::EncryptedTranslateConversationResponse {
                    data: Some(seal_response(
                        &keys,
                        directory.as_ref(),
                        &kid,
                        &response,
                        "TranslateConversation",
                        TRANSLATE_CONVERSATION_RESPONSE,
                    ).await?),
                };
            }
        };
        Ok(Response::new(Box::pin(responses)))
    }

    async fn translate_text(
        &self,
        _request: Request<pb::EncryptedTranslateTextRequest>,
    ) -> Result<Response<pb::EncryptedTranslateTextResponse>, Status> {
        let request = _request.into_inner();
        let (req, kid): (pb::TranslateTextRequest, _) = open_request(
            &self.keys,
            self.directory.as_ref(),
            request.data,
            "TranslateText",
        )
        .await?;
        if req.text.trim().is_empty() {
            return Err(Status::invalid_argument("translate text requires text"));
        }
        if req
            .to
            .as_ref()
            .is_none_or(|locale| locale.language.trim().is_empty())
        {
            return Err(Status::invalid_argument(
                "translate text requires a target locale",
            ));
        }
        let translation = if same_locale(req.from.as_ref(), req.to.as_ref()) {
            req.text.clone()
        } else {
            let model = self.model.as_ref().ok_or_else(|| {
                Status::failed_precondition(
                    "text translation requires an assistant provider in Center",
                )
            })?;
            model_text(
                model,
                "text translation",
                "Translate the supplied text accurately. Preserve names, numbers, and meaning. Return only the translated text with no notes, labels, or quotation marks.",
                format!(
                    "Source language: {}\nTarget language: {}\nText:\n{}",
                    locale_name(req.from.as_ref()),
                    locale_name(req.to.as_ref()),
                    req.text
                ),
            )
            .await?
        };
        let speech = match (req.speech_config.as_ref(), self.speech.as_ref()) {
            (Some(config), Some(backend)) => {
                let wire_format = config.audio_format;
                let format = requested_speech_format(Some(config))?;
                let audio = backend
                    .synthesize(&translation, format)
                    .await
                    .map_err(speech_status)?;
                Some(pb::Audio {
                    audio,
                    format: wire_format,
                })
            }
            _ => None,
        };
        let response = pb::TranslateTextResponse {
            translation,
            locale: req.to,
            speech,
        };
        let response = pb::EncryptedTranslateTextResponse {
            data: Some(
                seal_response(
                    &self.keys,
                    self.directory.as_ref(),
                    &kid,
                    &response,
                    "TranslateText",
                    TRANSLATE_TEXT_RESPONSE,
                )
                .await?,
            ),
        };
        Ok(Response::new(response))
    }
}

#[derive(Clone, PartialEq, Message)]
struct StoredCalendar {
    #[prost(string, tag = "1")]
    calendar_id: String,
    #[prost(message, repeated, tag = "2")]
    events: Vec<pb::CalendarEvent>,
}

#[derive(Clone, PartialEq, Message)]
struct LegacyStoredCalendar {
    #[prost(bytes = "vec", tag = "1")]
    calendar_id: Vec<u8>,
    #[prost(message, repeated, tag = "2")]
    events: Vec<LegacyCalendarEvent>,
}

#[derive(Clone, PartialEq, Message)]
struct LegacyCalendarEvent {
    #[prost(string, tag = "1")]
    title: String,
    #[prost(string, tag = "2")]
    location: String,
    #[prost(string, tag = "3")]
    description: String,
    #[prost(bytes = "vec", tag = "4")]
    starttime: Vec<u8>,
    #[prost(bytes = "vec", tag = "5")]
    endtime: Vec<u8>,
    #[prost(bytes = "vec", tag = "6")]
    recurrencerule: Vec<u8>,
    #[prost(message, repeated, tag = "7")]
    attendees: Vec<pb::EventAttendee>,
    #[prost(bytes = "vec", tag = "8")]
    meetinginfo: Vec<u8>,
    #[prost(string, tag = "9")]
    status: String,
    #[prost(bytes = "vec", tag = "10")]
    calendarid: Vec<u8>,
    #[prost(bytes = "vec", tag = "11")]
    eventid: Vec<u8>,
}

#[derive(Clone)]
pub struct TestAutomation {
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
}

impl TestAutomation {
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
    ) -> Self {
        Self {
            authenticator,
            store,
        }
    }
}

impl Default for TestAutomation {
    fn default() -> Self {
        Self::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            crate::store::MemoryStore::shared(),
        )
    }
}

fn calendar_id_from_bytes(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes.clone()).unwrap_or_else(|_| {
        uuid::Uuid::from_slice(&bytes)
            .map(|id| id.to_string())
            .unwrap_or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
    })
}

fn decode_stored_calendar(bytes: &[u8]) -> StoredCalendar {
    if let Ok(calendar) = StoredCalendar::decode(bytes) {
        return calendar;
    }
    let Ok(legacy) = LegacyStoredCalendar::decode(bytes) else {
        return StoredCalendar::default();
    };
    StoredCalendar {
        calendar_id: calendar_id_from_bytes(legacy.calendar_id),
        events: legacy
            .events
            .into_iter()
            .map(|event| pb::CalendarEvent {
                title: event.title,
                location: event.location,
                description: event.description,
                starttime: pb::CalendarEventDate::decode(event.starttime.as_slice()).ok(),
                endtime: pb::CalendarEventDate::decode(event.endtime.as_slice()).ok(),
                recurrencerule: String::from_utf8(event.recurrencerule)
                    .ok()
                    .filter(|rule| !rule.is_empty())
                    .into_iter()
                    .collect(),
                attendees: event.attendees,
                meetinginfo: pb::ConferenceData::decode(event.meetinginfo.as_slice()).ok(),
                status: event.status,
                calendarid: calendar_id_from_bytes(event.calendarid),
                eventid: calendar_id_from_bytes(event.eventid),
            })
            .collect(),
    }
}

#[tonic::async_trait]
impl TestAutomationService for TestAutomation {
    async fn create_new_calendar_events(
        &self,
        request: Request<pb::CreateNewCalendarEventsRequest>,
    ) -> Result<Response<pb::CreateNewCalendarEventsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let mut incoming = request.into_inner().calendareventstocreate;
        if incoming.len() > MAX_CALENDAR_EVENTS {
            return Err(Status::resource_exhausted(
                "calendar event batch is too large",
            ));
        }
        let owner = principal.expose_for_authorization();
        for _ in 0..STATE_CAS_RETRIES {
            let previous = self
                .store
                .get_account_blob(owner, crate::store::AccountBlobKind::CalendarState)
                .await?;
            let mut calendar = previous
                .as_deref()
                .map(decode_stored_calendar)
                .unwrap_or_default();
            if calendar.calendar_id.is_empty() {
                calendar.calendar_id = uuid::Uuid::new_v4().to_string();
            }
            let mut created = Vec::with_capacity(incoming.len());
            for event in &mut incoming {
                if event.eventid.is_empty() {
                    event.eventid = uuid::Uuid::new_v4().to_string();
                }
                event.calendarid.clone_from(&calendar.calendar_id);
                created.push(event.eventid.clone());
                if let Some(index) = calendar
                    .events
                    .iter()
                    .position(|stored| stored.eventid == event.eventid)
                {
                    calendar.events[index] = event.clone();
                } else {
                    calendar.events.push(event.clone());
                }
            }
            if calendar.events.len() > MAX_CALENDAR_EVENTS {
                return Err(Status::resource_exhausted(
                    "calendar contains too many events",
                ));
            }
            if self
                .store
                .compare_and_swap_account_blob(
                    owner,
                    crate::store::AccountBlobKind::CalendarState,
                    previous.as_deref(),
                    &calendar.encode_to_vec(),
                )
                .await?
            {
                return Ok(Response::new(pb::CreateNewCalendarEventsResponse {
                    createdeventids: created,
                    calendarid: calendar.calendar_id,
                }));
            }
        }
        Err(Status::aborted("calendar changed concurrently; retry"))
    }

    async fn delete_all_calendar_events(
        &self,
        request: Request<()>,
    ) -> Result<Response<()>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let owner = principal.expose_for_authorization();
        for _ in 0..STATE_CAS_RETRIES {
            let previous = self
                .store
                .get_account_blob(owner, crate::store::AccountBlobKind::CalendarState)
                .await?;
            let mut calendar = previous
                .as_deref()
                .map(decode_stored_calendar)
                .unwrap_or_default();
            calendar.events.clear();
            if self
                .store
                .compare_and_swap_account_blob(
                    owner,
                    crate::store::AccountBlobKind::CalendarState,
                    previous.as_deref(),
                    &calendar.encode_to_vec(),
                )
                .await?
            {
                return Ok(Response::new(()));
            }
        }
        Err(Status::aborted("calendar changed concurrently; retry"))
    }

    async fn get_calendar_events(
        &self,
        request: Request<pb::GetCalendarEventsRequest>,
    ) -> Result<Response<pb::GetCalendarEventsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let query = request.into_inner();
        let calendar = self
            .store
            .get_account_blob(
                principal.expose_for_authorization(),
                crate::store::AccountBlobKind::CalendarState,
            )
            .await?
            .as_deref()
            .map(decode_stored_calendar)
            .unwrap_or_default();
        if !query.calendarid.is_empty() && query.calendarid != calendar.calendar_id {
            return Ok(Response::new(pb::GetCalendarEventsResponse::default()));
        }
        let mut events = calendar.events;
        if !query.eventids.is_empty() {
            events.retain(|event| query.eventids.contains(&event.eventid));
        }
        if query.maxcount > 0 {
            events.truncate(query.maxcount as usize);
        }
        Ok(Response::new(pb::GetCalendarEventsResponse { events }))
    }

    async fn initialize_calendar(
        &self,
        request: Request<()>,
    ) -> Result<Response<pb::InitializedCalendarResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let owner = principal.expose_for_authorization();
        for _ in 0..STATE_CAS_RETRIES {
            let previous = self
                .store
                .get_account_blob(owner, crate::store::AccountBlobKind::CalendarState)
                .await?;
            let mut calendar = previous
                .as_deref()
                .map(decode_stored_calendar)
                .unwrap_or_default();
            if calendar.calendar_id.is_empty() {
                calendar.calendar_id = uuid::Uuid::new_v4().to_string();
            }
            if previous.is_some()
                || self
                    .store
                    .compare_and_swap_account_blob(
                        owner,
                        crate::store::AccountBlobKind::CalendarState,
                        None,
                        &calendar.encode_to_vec(),
                    )
                    .await?
            {
                return Ok(Response::new(pb::InitializedCalendarResponse {
                    calendarid: calendar.calendar_id,
                }));
            }
        }
        Err(Status::aborted("calendar changed concurrently; retry"))
    }
}

/// `humane.aibus.WebSearchService` — query the web/memory index; the response is a
/// list of matched memory references (`SearchMemoryItem{uuid}`).
#[derive(Clone)]
pub struct WebSearch {
    authenticator: crate::auth::RequestAuthenticator,
}

impl WebSearch {
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        _store: crate::store::SharedStore,
    ) -> Self {
        Self { authenticator }
    }

    #[cfg(test)]
    fn with_model(_store: crate::store::SharedStore, _model: Arc<dyn ChatModel>) -> Self {
        Self {
            authenticator: crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
        }
    }
}

impl Default for WebSearch {
    fn default() -> Self {
        Self::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            crate::store::MemoryStore::shared(),
        )
    }
}

#[tonic::async_trait]
impl WebSearchService for WebSearch {
    /// Private semantic memory search remains unsupported until runtime
    /// admission establishes origin-scoped retrieval clearance.
    async fn search(
        &self,
        request: Request<pb::SearchRequest>,
    ) -> Result<Response<pb::SearchResponse>, Status> {
        self.authenticator.authenticate(&request)?;
        Err(Status::unimplemented(
            "private memory search requires origin-scoped runtime admission",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ambiance_extra_semantic_capabilities_fail_before_cognition_or_private_reads() {
        struct Never;
        #[tonic::async_trait]
        impl ChatModel for Never {
            async fn complete(
                &self,
                _: &[crate::assistant::llm::ChatMessage],
                _: &[crate::assistant::llm::ToolDef],
            ) -> Result<crate::assistant::llm::ChatResponse, crate::assistant::llm::LlmError>
            {
                panic!("unsupported service reached cognition")
            }
        }
        let model: Arc<dyn ChatModel> = Arc::new(Never);
        assert_eq!(
            model_text(&model, "composition", "client system", "PRIVATE_CANARY")
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unimplemented
        );
        let observed = Arc::new(crate::store::MemoryStore::default());
        let search = WebSearch::with_model(observed.clone(), model);
        assert_eq!(
            search
                .search(Request::new(pb::SearchRequest {
                    text_query: "PRIVATE_CANARY".into(),
                }))
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
    use crate::backends::azure_speech::SpeechAudioStream;

    const TEST_KID: &str = "aibus-extra-test";

    fn shared_keys() -> crate::keymaterial::SharedKeyMaterial {
        let keys: crate::keymaterial::SharedKeyMaterial = Default::default();
        keys.insert(TEST_KID.to_owned(), [17u8; cosmos_crypto::AES_KEY_LEN])
            .expect("insert test channel key");
        keys
    }

    fn seal<T: Message>(keys: &crate::keymaterial::SharedKeyMaterial, value: &T) -> EncryptedData {
        let sealed = keys
            .seal(TEST_KID, &value.encode_to_vec(), b"")
            .expect("seal test request");
        EncryptedData {
            encryption_information: Some(
                cosmos_protocol::common::encryption::EncryptionInformation { kid: sealed.kid },
            ),
            data: sealed.data,
        }
    }

    #[derive(Clone)]
    struct MockSpeechBackend;

    #[tonic::async_trait]
    impl SpeechSynthesisBackend for MockSpeechBackend {
        async fn synthesize(
            &self,
            text: &str,
            format: SpeechAudioFormat,
        ) -> Result<Vec<u8>, AzureSpeechError> {
            assert!(!text.is_empty());
            assert_eq!(format, SpeechAudioFormat::Raw24Khz16BitMonoPcm);
            Ok(vec![0x10, 0x20, 0x30, 0x40])
        }

        async fn synthesize_stream(
            &self,
            text: &str,
            format: SpeechAudioFormat,
        ) -> Result<SpeechAudioStream, AzureSpeechError> {
            assert!(!text.is_empty());
            assert_eq!(format, SpeechAudioFormat::Audio24Khz160KBitrateMonoMp3);
            Ok(Box::pin(tokio_stream::iter([
                Ok(vec![0x49, 0x44, 0x33]),
                Ok(vec![0x01, 0x02]),
            ])))
        }
    }

    #[tokio::test]
    async fn azure_backed_tts_matches_stock_unary_and_streaming_shapes() {
        let service = Speech::with_speech_backend(Arc::new(MockSpeechBackend));
        let unary = service
            .text_to_speech(Request::new(pb::TextToSpeechRequest {
                text: "Hello from Cosmos".to_owned(),
                speech_config: Some(pb::SpeechConfig {
                    audio_format: pb::AudioFormat::Raw24khz16bitMonoPcm as i32,
                    ..Default::default()
                }),
            }))
            .await
            .expect("unary TTS response")
            .into_inner();
        assert_eq!(
            unary.source,
            pb::SpeechSource::SourceMicrosoftSpeechSynthesis as i32
        );
        assert_eq!(unary.speech_transcription, "Hello from Cosmos");
        let unary_audio = unary.speech.expect("unary audio");
        assert_eq!(
            unary_audio.format,
            pb::AudioFormat::Raw24khz16bitMonoPcm as i32
        );
        assert_eq!(unary_audio.audio, [0x10, 0x20, 0x30, 0x40]);

        let mut stream = service
            .streaming_text_to_speech(Request::new(pb::TextToSpeechRequest {
                text: "Stream this".to_owned(),
                speech_config: Some(pb::SpeechConfig {
                    audio_format: pb::AudioFormat::Audio24khz160kbitrateMonoMp3 as i32,
                    ..Default::default()
                }),
            }))
            .await
            .expect("streaming TTS response")
            .into_inner();
        let first = stream
            .next()
            .await
            .expect("first stream item")
            .expect("audio");
        let second = stream
            .next()
            .await
            .expect("second stream item")
            .expect("audio");
        assert!(stream.next().await.is_none());
        assert_eq!(first.speech.expect("first audio").audio, [0x49, 0x44, 0x33]);
        assert_eq!(second.speech.expect("second audio").audio, [0x01, 0x02]);
    }

    #[test]
    fn raw_conversation_pcm_is_wrapped_as_a_valid_16khz_mono_wav() {
        let wav = recognition_wav(&pb::Audio {
            audio: vec![1, 2, 3, 4],
            format: pb::AudioFormat::Raw16khz16bitMonoPcm as i32,
        })
        .expect("raw PCM is supported");
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[44..], [1, 2, 3, 4]);
        assert!(
            recognition_wav(&pb::Audio {
                audio: vec![1, 2],
                format: pb::AudioFormat::Audio24khz160kbitrateMonoMp3 as i32,
            })
            .is_err(),
            "a deliberately wrong encoding must not be mislabeled as WAV",
        );
    }

    #[tokio::test]
    async fn storage_acks_ok_and_fallback_rpcs_succeed() {
        let store: crate::store::SharedStore = Arc::new(crate::store::MemoryStore::default());
        let messages = DeviceMessages::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store.clone(),
        );
        let calendar = TestAutomation::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store,
        );
        // Representative storage RPCs return Ok with well-formed responses.
        let query = messages
            .query_messages(Request::new(pb::QueryMessagesRequest {
                start_time: None,
                end_time: None,
                user_phone_number: String::new(),
            }))
            .await
            .expect("query_messages ok")
            .into_inner();
        assert!(query.messages.is_empty(), "empty store returns no messages");

        let backup = messages
            .backup_messages(Request::new(pb::BackupMessagesRequest {
                messages: vec![pb::Message::default()],
            }))
            .await
            .expect("backup_messages ok")
            .into_inner();
        assert_eq!(
            backup.messages.len(),
            1,
            "write is acked by echoing payload"
        );

        let events = calendar
            .get_calendar_events(Request::new(pb::GetCalendarEventsRequest {
                calendarid: String::new(),
                maxcount: 0,
                eventids: Vec::new(),
            }))
            .await
            .expect("get_calendar_events ok")
            .into_inner();
        assert!(events.events.is_empty(), "no seeded calendar returns empty");

        Food::default()
            .feedback(Request::new(pb::FoodFeedbackRequest::default()))
            .await
            .expect("feedback ack ok");

        let keys = shared_keys();
        let food_error = Food::with_key_material(keys.clone())
            .encrypted_identify_food(Request::new(pb::EncryptedFoodIdentifyRequest {
                request: Some(seal(
                    &keys,
                    &pb::FoodIdentifyRequest {
                        image_data: vec![b"fake-jpeg".to_vec()],
                        ..Default::default()
                    },
                )),
            }))
            .await
            .unwrap_err();
        assert_eq!(food_error.code(), tonic::Code::FailedPrecondition);

        // Missing external backends return explicit errors rather than
        // success-shaped fabricated values.
        assert_eq!(
            AmazonShopping
                .visual_search(Request::new(pb::VisualSearchRequest {
                    image_data: vec![b"fake-jpeg".to_vec()],
                }))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::FailedPrecondition,
        );
        assert_eq!(
            messages
                .upload_attachment(Request::new(pb::UploadAttachmentRequest {
                    filename: "notes.txt".to_owned(),
                }))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::FailedPrecondition,
        );
        assert_eq!(
            WebSearch::default()
                .search(Request::new(pb::SearchRequest {
                    text_query: "anything".into()
                }))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unimplemented
        );
        assert_eq!(
            Speech::default()
                .text_to_speech(Request::new(pb::TextToSpeechRequest {
                    text: "Speak this".to_owned(),
                    ..Default::default()
                }))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::FailedPrecondition,
        );
        let streaming_tts_code = match Speech::default()
            .streaming_text_to_speech(Request::new(pb::TextToSpeechRequest {
                text: "Speak this".to_owned(),
                ..Default::default()
            }))
            .await
        {
            Ok(_) => panic!("streaming TTS must not return fabricated audio"),
            Err(status) => status.code(),
        };
        assert_eq!(streaming_tts_code, tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn calendar_uses_the_stock_typed_shape_and_round_trips_mutations() {
        let store: crate::store::SharedStore = Arc::new(crate::store::MemoryStore::default());
        let calendar = TestAutomation::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store,
        );

        let initialized = calendar
            .initialize_calendar(Request::new(()))
            .await
            .expect("calendar initializes")
            .into_inner();
        assert!(uuid::Uuid::parse_str(&initialized.calendarid).is_ok());

        let created = calendar
            .create_new_calendar_events(Request::new(pb::CreateNewCalendarEventsRequest {
                calendareventstocreate: vec![
                    pb::CalendarEvent {
                        title: "Dentist".to_owned(),
                        starttime: Some(pb::CalendarEventDate {
                            timestamp: Some(prost_types::Timestamp {
                                seconds: 1_800_000_000,
                                nanos: 0,
                            }),
                            timezone: "Europe/Copenhagen".to_owned(),
                        }),
                        recurrencerule: vec!["RRULE:FREQ=YEARLY".to_owned()],
                        meetinginfo: Some(pb::ConferenceData {
                            uri: "https://meet.example/dentist".to_owned(),
                            pincode: "1234".to_owned(),
                            accesscode: "front-desk".to_owned(),
                        }),
                        ..Default::default()
                    },
                    pb::CalendarEvent {
                        title: "Dinner".to_owned(),
                        eventid: "stock-event-2".to_owned(),
                        ..Default::default()
                    },
                ],
            }))
            .await
            .expect("events are created")
            .into_inner();
        assert_eq!(created.calendarid, initialized.calendarid);
        assert_eq!(created.createdeventids.len(), 2);
        assert!(uuid::Uuid::parse_str(&created.createdeventids[0]).is_ok());
        assert_eq!(created.createdeventids[1], "stock-event-2");

        let filtered = calendar
            .get_calendar_events(Request::new(pb::GetCalendarEventsRequest {
                calendarid: initialized.calendarid.clone(),
                maxcount: 10,
                eventids: vec!["stock-event-2".to_owned()],
            }))
            .await
            .expect("calendar reads")
            .into_inner();
        assert_eq!(filtered.events.len(), 1);
        assert_eq!(filtered.events[0].title, "Dinner");
        assert_eq!(filtered.events[0].calendarid, initialized.calendarid);

        calendar
            .delete_all_calendar_events(Request::new(()))
            .await
            .expect("events delete");
        let empty = calendar
            .get_calendar_events(Request::new(pb::GetCalendarEventsRequest {
                calendarid: initialized.calendarid.clone(),
                maxcount: 0,
                eventids: Vec::new(),
            }))
            .await
            .expect("calendar reads after delete")
            .into_inner();
        assert!(empty.events.is_empty());

        let reinitialized = calendar
            .initialize_calendar(Request::new(()))
            .await
            .expect("calendar reinitializes")
            .into_inner();
        assert_eq!(reinitialized.calendarid, initialized.calendarid);
    }

    #[tokio::test]
    async fn message_backup_is_durable_upserted_and_queryable_by_phone_and_time() {
        let store: crate::store::SharedStore = Arc::new(crate::store::MemoryStore::default());
        let messages = DeviceMessages::with_objects(
            store.clone(),
            crate::services::capture::CaptureObjectStore::for_tests(),
            "https://upload.clone.example/put/",
        );
        let message = |id: &str, phone: &str, seconds: i64| pb::Message {
            device_message_id: id.to_owned(),
            user_phone_number: phone.to_owned(),
            timestamp: Some(prost_types::Timestamp { seconds, nanos: 0 }),
            ..Default::default()
        };
        messages
            .backup_messages(Request::new(pb::BackupMessagesRequest {
                messages: vec![
                    message("m-1", "+4511111111", 100),
                    message("m-2", "+4522222222", 200),
                    message("m-3", "+4511111111", 300),
                ],
            }))
            .await
            .expect("messages are backed up");

        let mut updated = message("m-3", "+4511111111", 250);
        updated.user_id = "updated".to_owned();
        messages
            .backup_messages(Request::new(pb::BackupMessagesRequest {
                messages: vec![updated],
            }))
            .await
            .expect("existing message is upserted");

        let restarted = DeviceMessages::new(
            crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store,
        );
        let found = restarted
            .query_messages(Request::new(pb::QueryMessagesRequest {
                start_time: Some(prost_types::Timestamp {
                    seconds: 150,
                    nanos: 0,
                }),
                end_time: Some(prost_types::Timestamp {
                    seconds: 275,
                    nanos: 0,
                }),
                user_phone_number: "+4511111111".to_owned(),
            }))
            .await
            .expect("messages are queried")
            .into_inner();
        assert_eq!(found.messages.len(), 1);
        assert_eq!(found.messages[0].device_message_id, "m-3");
        assert_eq!(found.messages[0].user_id, "updated");
    }

    #[tokio::test]
    async fn message_attachment_urls_are_real_one_use_upload_capabilities() {
        let store: crate::store::SharedStore = Arc::new(crate::store::MemoryStore::default());
        let objects = crate::services::capture::CaptureObjectStore::for_tests();
        let messages = DeviceMessages::with_objects(
            store,
            objects.clone(),
            "https://upload.clone.example/put/",
        );
        let upload = messages
            .upload_attachment(Request::new(pb::UploadAttachmentRequest {
                filename: "photo.jpg".to_owned(),
            }))
            .await
            .expect("attachment URL is minted")
            .into_inner();
        let url = reqwest::Url::parse(&upload.url).expect("valid upload URL");
        let token = url
            .path_segments()
            .and_then(Iterator::last)
            .expect("capability token");
        assert_eq!(token.len(), 43);

        objects
            .accept(token, None, b"mms attachment")
            .await
            .expect("first upload stores bytes");
        assert!(
            objects.accept(token, None, b"replacement").await.is_err(),
            "the same attachment capability must not be reusable"
        );
    }
}
