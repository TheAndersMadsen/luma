//! `humane.aibus.*` supporting services, the non-assistant RPCs that surround
//! the `AIBusService` ReAct loop.
//!
//! This module implements seven `humane.aibus` services. They split cleanly into
//! two faithfulness classes:
//!
//! * **Storage / ack RPCs** (`DeviceMessagesService` backup+query,
//!   `FoodService.Feedback`, `TestAutomationService` calendar harness) hold no
//!   state in this deployment, so reads return a well-formed *empty* response and
//!   writes are acked by echoing the client's own payload or a default receipt.
//!   None of these need an LLM, vision, crypto, or external state, so none is
//!   `UNIMPLEMENTED`.
//!
//! * **Model / vision / crypto / external-fetch RPCs** use the clone's configured
//!   OpenAI-compatible model for composition, summarization, and text translation.
//!   Capabilities without a real backing service use deterministic, well-formed
//!   defaults where those are meaningful, and explicit failure statuses where a
//!   fabricated result, signed URL, transcript, or credential would mislead the
//!   device.
//!
//! Authentication is enforced at the mTLS edge (the DeviceUser client-cert
//! Subject-CN principal, RUNTIME-CONTRACTS §2). These handlers hold no per-user
//! state and trust the already-authenticated channel, matching the `account` and
//! `provisioning` handler idiom. Encrypted handlers share the ephemeral key store
//! established by `PublicPrivacyService`.

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

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

use crate::assistant::llm::{ChatMessage, ChatModel, ConfiguredChatModel};
use crate::backends::azure_speech::{
    AzureSpeechError, SpeechAudioFormat, SpeechRecognitionBackend, SpeechSynthesisBackend,
    configured_backend, configured_recognition_backend,
};

const MODEL_TIMEOUT: Duration = Duration::from_secs(10);
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
    let messages = [ChatMessage::system(system), ChatMessage::user(prompt)];
    let reply = tokio::time::timeout(MODEL_TIMEOUT, model.complete(&messages, &[]))
        .await
        .map_err(|_| Status::deadline_exceeded(format!("{capability} model timed out")))?
        .map_err(|error| {
            // The provider's text stays in the operator's log: reqwest's names
            // the endpoint URL.
            tracing::warn!(capability, %error, "a device model call failed");
            Status::unavailable(format!("the {capability} model is unavailable"))
        })?;
    let content = reply.content.unwrap_or_default();
    let content = content.trim();
    if content.is_empty() {
        return Err(Status::unavailable(format!(
            "{capability} model returned no usable text"
        )));
    }
    Ok(content.to_owned())
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
            // The device is sealing under a kid this server has no key for,
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
            // never reach the re-establish queue, deleting a working key would
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
/// AAD outright, "Cannot reconstruct protobuf with null/empty AAD"
/// (CoreSecureChannel.java:167), then does `Class.forName(aad)` to pick the
/// parser (CoreSecureChannel.java:172). `EphemeralProtectionManager.decrypt`
/// (EphemeralProtectionManager.java:130) returns an unconstrained generic, so
/// that AAD string is the ONLY thing that determines how the device parses the
/// body. An empty AAD is unopenable. A wrong one throws ClassNotFoundException.
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
// in the decompiled stock client, `Class.forName` must resolve it and the class
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
/// composition caller, no `EphemeralChannelId` for it exists in
/// `sources/hu/ma/ne/krypton/ephemeral/EphemeralChannelId.java`, so there is no
/// decrypt-site cast to cite. The name is still exact rather than guessed: AAD is
/// `data.getClass().getName()` of the payload, and the payload we seal *is* a
/// `MessageCompositionResponse`. Deliberately NOT the same-named
/// `sources/humane/system/composition/MessageCompositionResponse.java:7`, which is
/// a Parcelable with no `parseFrom`, that is the IPC shape handed to the
/// composition experience, never the wire shape.
const MESSAGE_COMPOSITION_RESPONSE: &str = "humane.aibus.MessageCompositionResponse";

/// Class: `sources/humane/aibus/FoodIdentifyResponse.java:19`
/// (`package humane.aibus;` at :1). Same situation as composition, no food
/// `EphemeralChannelId` in this build, so no decrypt-site cast, but this is
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

/// `humane.aibus.AmazonShoppingService`, "look at this product and shop for it".
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

/// `humane.aibus.CompositionService`, notification triage, message drafting, and
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

    #[cfg(test)]
    fn with_dependencies(
        keys: crate::keymaterial::SharedKeyMaterial,
        model: Arc<dyn ChatModel>,
    ) -> Self {
        Self {
            keys,
            directory: None,
            model: Some(model),
        }
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

/// `humane.aibus.DeviceMessagesService`, durable, wearer-scoped SMS/MMS backup,
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

/// `humane.aibus.FoodService`, food-image identification and post-hoc feedback.
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
        // nutrition (the device narrates "couldn't get that info"). An unreachable
        // provider is an honest error. Nothing is fabricated.
        let (item_name, barcode, serving_size, nutrient, ingredients, brand) =
            match crate::backends::food::lookup(req.text.trim()).await {
                Ok(item) => (
                    item.item_name,
                    item.barcode,
                    item.serving_size,
                    // `FoodIdentifyResponse.nutrient` is aibus::NutritionInfo;
                    // `food::lookup` returns common::food::NutritionInfo. Same
                    // fields + same NutrientType enum, copy across.
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

/// `humane.aibus.SpeechService`, local-TTS handoff and encrypted translation.
/// Text translation uses the configured OpenAI-compatible model. Conversation
/// translation remains unavailable until the clone has an audio transcription
/// backend. It never returns a fabricated empty transcript.
#[derive(Clone)]
pub struct Speech {
    keys: crate::keymaterial::SharedKeyMaterial,
    history: Option<crate::store::SharedStore>,
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
            history: None,
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
            history: None,
            model: configured_model(),
            speech: configured_backend(),
            recognition: configured_recognition_backend(),
        }
    }

    pub fn with_translation_history(mut self, store: crate::store::SharedStore) -> Self {
        self.history = Some(store);
        self
    }

    pub fn with_key_directory(
        mut self,
        directory: crate::keydirectory::SharedKeyDirectory,
    ) -> Self {
        self.directory = Some(directory);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_dependencies(
        keys: crate::keymaterial::SharedKeyMaterial,
        model: Arc<dyn ChatModel>,
    ) -> Self {
        Self {
            keys,
            directory: None,
            history: None,
            model: Some(model),
            speech: None,
            recognition: None,
        }
    }

    #[cfg(test)]
    fn with_speech_backend(backend: Arc<dyn SpeechSynthesisBackend>) -> Self {
        Self {
            keys: Default::default(),
            directory: None,
            history: None,
            model: None,
            speech: Some(backend),
            recognition: None,
        }
    }
}

impl Speech {
    pub(crate) async fn translate_one_off(
        &self,
        account: &str,
        req: pb::TranslateTextRequest,
    ) -> Result<pb::TranslateTextResponse, Status> {
        if self.history.is_some() && account.trim().is_empty() {
            return Err(Status::unauthenticated(
                "translation requires an authenticated wearer",
            ));
        }
        tokio::time::timeout(
            crate::assistant::runtime::FOREGROUND_BUDGET,
            self.translate_one_off_within_budget(account, req),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("translation exceeded its foreground budget"))?
    }

    async fn translate_one_off_within_budget(
        &self,
        account: &str,
        req: pb::TranslateTextRequest,
    ) -> Result<pb::TranslateTextResponse, Status> {
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
        if let Some(store) = &self.history {
            // Stock humane.experience.actionhandlers.TranslateActionHandler.handleActionInternal does not record
            // a one-off. Humane.experience.actionhandlers.StopTranslationActionHandler.handleActionInternal records
            // TranslationNotableEvent(originLanguage, targetLanguage) for live
            // sessions. INFERRED requested Luma behavior: archive successful
            // one-offs centrally in that same language-pair shape, once per RPC
            // or Center operation, without inventing a stock action identifier.
            let display = |locale: Option<&cosmos_protocol::common::Locale>| {
                locale
                    .map(|locale| {
                        crate::assistant::intents::translation_language_name(&locale.language)
                            .map(str::to_owned)
                            .unwrap_or_else(|| locale_name(Some(locale)))
                    })
                    .unwrap_or_else(|| "Auto-detected".to_owned())
            };
            let string = |value: String| prost_types::Value {
                kind: Some(prost_types::value::Kind::StringValue(value)),
            };
            let now = crate::store::SyncTime::now();
            let identifier = uuid::Uuid::new_v4().to_string();
            let event = crate::store::NotableEventRecord {
                event_identifier: identifier.clone(),
                originator_identifier: "luma.translation".into(),
                creation_time: Some(now),
                event_type: "humane.translation".into(),
                event_data: Some(prost_types::Struct {
                    fields: [
                        ("originLanguage".into(), string(display(req.from.as_ref()))),
                        ("targetLanguage".into(), string(display(req.to.as_ref()))),
                    ]
                    .into_iter()
                    .collect(),
                }),
                encrypted_event_data: None,
                encrypted_location: None,
                device_is_locked: req.is_locked,
                ingested: now,
                indexed_text: None,
            };
            let committed = store
                .ingest_events(account, &[event])
                .await
                .map_err(|_| Status::unavailable("translation history could not be saved"))?;
            if !committed.contains(&identifier) {
                return Err(Status::unavailable(
                    "translation history could not be saved",
                ));
            }
        }
        let response = pb::TranslateTextResponse {
            translation,
            locale: req.to,
            speech,
        };
        Ok(response)
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
        AzureSpeechError::NotConfigured => {
            Status::failed_precondition("speech requires a configured speech backend")
        }
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
                let transcript = recognition
                    .transcribe(&wav)
                    .await
                    .map_err(speech_status)?;
                let source = config.device_locale.clone();
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
        let account = crate::auth::principal(&_request)
            .map(|principal| principal.expose_for_authorization().to_owned());
        if self.history.is_some() && account.is_none() {
            return Err(Status::unauthenticated(
                "translation requires an authenticated wearer",
            ));
        }
        let request = _request.into_inner();
        let (req, kid): (pb::TranslateTextRequest, _) = open_request(
            &self.keys,
            self.directory.as_ref(),
            request.data,
            "TranslateText",
        )
        .await?;
        if self.history.is_some() && self.directory.is_some() {
            let owner = account
                .as_deref()
                .and_then(crate::services::public_privacy::kid_user_id);
            if owner.is_none() || crate::services::public_privacy::kid_user_id(&kid) != owner {
                return Err(Status::permission_denied(
                    "translation key belongs to another wearer",
                ));
            }
        }
        let response = self
            .translate_one_off(account.as_deref().unwrap_or_default(), req)
            .await?;
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

/// `humane.aibus.WebSearchService`, query the web/memory index. The response is a
/// list of matched memory references (`SearchMemoryItem{uuid}`).
#[derive(Clone)]
pub struct WebSearch {
    authenticator: crate::auth::RequestAuthenticator,
    store: crate::store::SharedStore,
    model: Option<Arc<dyn ChatModel>>,
}

impl WebSearch {
    pub fn new(
        authenticator: crate::auth::RequestAuthenticator,
        store: crate::store::SharedStore,
    ) -> Self {
        Self {
            authenticator,
            store,
            model: configured_model(),
        }
    }

    #[cfg(test)]
    fn with_model(store: crate::store::SharedStore, model: Arc<dyn ChatModel>) -> Self {
        Self {
            authenticator: crate::auth::RequestAuthenticator::new(
                crate::config::Authentication::DevelopmentInsecure,
            ),
            store,
            model: Some(model),
        }
    }

    async fn semantic_matches(&self, principal: &str, query: &str) -> Option<Vec<String>> {
        let model = self.model.as_ref()?;
        let candidates = self.store.searchable_notes(principal, 128).await.ok()?;
        if candidates.is_empty() {
            return Some(Vec::new());
        }
        let allowed = candidates
            .iter()
            .map(|note| note.uuid.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let corpus = serde_json::to_string(
            &candidates
                .iter()
                .map(|note| serde_json::json!({ "uuid": note.uuid, "text": note.text }))
                .collect::<Vec<_>>(),
        )
        .ok()?;
        let reply = model_text(
            model,
            "memory search",
            "Rank saved notes by meaning. Return only a JSON array of matching UUID strings, most relevant first. Exclude notes that do not answer the query.",
            format!("Query: {query}\nNotes: {corpus}"),
        )
        .await
        .ok()?;
        let ranked = serde_json::from_str::<Vec<String>>(reply.trim()).ok()?;
        let mut seen = std::collections::BTreeSet::new();
        Some(
            ranked
                .into_iter()
                .filter(|uuid| allowed.contains(uuid) && seen.insert(uuid.clone()))
                .take(64)
                .collect(),
        )
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
    /// Search the wearer's own memories.
    ///
    /// Despite the service name this is **not** web search: it answers with
    /// `SearchMemoryItem{uuid}`, memory identifiers, never content, which is
    /// cosmos's `MODE_SEMANTIC_SEARCH` surface. The device resolves the uuids
    /// against its local store, so the wearer's note bodies never ride back over
    /// the wire.
    ///
    /// A configured model ranks the bounded set of opened note indexes by
    /// meaning and returns UUIDs only. If that provider is unavailable, the
    /// deterministic lexical index remains the retry-safe fallback.
    async fn search(
        &self,
        request: Request<pb::SearchRequest>,
    ) -> Result<Response<pb::SearchResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let query = request.into_inner().text_query;
        if query.trim().is_empty() {
            return Err(Status::invalid_argument("search requires text_query"));
        }
        let owner = principal.expose_for_authorization();
        let uuids = match self.semantic_matches(owner, &query).await {
            Some(matches) => matches,
            None => self.store.search_notes(owner, &query, 0).await?,
        };
        Ok(Response::new(pb::SearchResponse {
            memories: uuids
                .into_iter()
                .map(|uuid| pb::SearchMemoryItem { uuid })
                .collect(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::llm::{ChatResponse, MockChatModel};
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

    fn text_response(content: &str) -> ChatResponse {
        ChatResponse {
            content: Some(content.to_owned()),
            thought: String::new(),
            tool_call: None,
            extra_tool_calls: Vec::new(),
        }
    }

    /// The AAD an envelope was sealed with, read without opening it.
    fn aad(value: &EncryptedData) -> String {
        let aad = cosmos_crypto::envelope_aad(&value.data).expect("readable envelope");
        assert!(
            !aad.is_empty(),
            "an empty AAD is unopenable on device: decryptProto throws \
             \"Cannot reconstruct protobuf with null/empty AAD\" \
             (CoreSecureChannel.java:167)"
        );
        String::from_utf8(aad).expect("AAD is the UTF-8 class name")
    }

    /// Every encrypted response this module emits must name its payload's
    /// fully-qualified Java class in the envelope AAD. The device resolves the
    /// parser by `Class.forName(aad)` (CoreSecureChannel.java:172) after
    /// rejecting an empty AAD outright (:167), and
    /// `EphemeralProtectionManager.decrypt` (:130) returns an unconstrained
    /// generic, so this string is the only thing telling the Pin how to read the
    /// body. Empty means the response cannot be opened at all.
    #[tokio::test]
    async fn sealed_responses_name_their_payload_class_in_the_aad() {
        let keys = shared_keys();

        // CompositionService.EncryptedComposeMessage
        let model: Arc<dyn ChatModel> = Arc::new(MockChatModel::new(vec![
            text_response("Are you free tomorrow?"),
            text_response("Free tomorrow?"),
        ]));
        let composed = Composition::with_dependencies(keys.clone(), model)
            .encrypted_compose_message(Request::new(pb::EncryptedMessageCompositionRequest {
                request: Some(seal(
                    &keys,
                    &pb::MessageCompositionRequest {
                        r#type: pb::MessageSourceType::Message as i32,
                        text: "free tomorrow?".to_owned(),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect("compose response")
            .into_inner()
            .response
            .expect("encrypted compose payload");
        assert_eq!(aad(&composed), MESSAGE_COMPOSITION_RESPONSE);
        assert_eq!(aad(&composed), "humane.aibus.MessageCompositionResponse");

        // CompositionService.EncryptedSummarizeMessages
        let summarized = Composition::with_key_material(keys.clone())
            .encrypted_summarize_messages(Request::new(pb::EncryptedSummarizationNetworkRequest {
                request: Some(seal(&keys, &pb::SummarizationNetworkRequest::default())),
            }))
            .await
            .expect("summarize response")
            .into_inner()
            .response
            .expect("encrypted summarization payload");
        assert_eq!(aad(&summarized), SUMMARIZATION_NETWORK_RESPONSE);
        assert_eq!(
            aad(&summarized),
            "humane.aibus.SummarizationNetworkResponse"
        );

        // SpeechService.CanTranslate
        let capability = Speech::with_key_material(keys.clone())
            .can_translate(Request::new(pb::EncryptedCanTranslateRequest {
                data: Some(seal(&keys, &pb::CanTranslateRequest::default())),
            }))
            .await
            .expect("can-translate response")
            .into_inner()
            .data
            .expect("encrypted capability payload");
        assert_eq!(aad(&capability), CAN_TRANSLATE_RESPONSE);
        assert_eq!(aad(&capability), "humane.aibus.CanTranslateResponse");

        // SpeechService.TranslateText
        let model: Arc<dyn ChatModel> =
            Arc::new(MockChatModel::new(vec![text_response("Vi ses i morgen.")]));
        let translated = Speech::with_dependencies(keys.clone(), model)
            .translate_text(Request::new(pb::EncryptedTranslateTextRequest {
                data: Some(seal(
                    &keys,
                    &pb::TranslateTextRequest {
                        text: "See you tomorrow.".to_owned(),
                        from: Some(cosmos_protocol::common::Locale {
                            language: "en".to_owned(),
                            country: "US".to_owned(),
                        }),
                        to: Some(cosmos_protocol::common::Locale {
                            language: "da".to_owned(),
                            country: "DK".to_owned(),
                        }),
                        ..Default::default()
                    },
                )),
            }))
            .await
            .expect("translate-text response")
            .into_inner()
            .data
            .expect("encrypted translation payload");
        assert_eq!(aad(&translated), TRANSLATE_TEXT_RESPONSE);
        assert_eq!(aad(&translated), "humane.aibus.TranslateTextResponse");

        // FoodService.EncryptedIdentifyFood seals through the same helper, but
        // reaching its seal requires a live Open Food Facts lookup, so the RPC
        // itself is not driven here. Exercise the exact constant its call site
        // passes over the exact message type it seals.
        let identified = seal_response(
            &keys,
            None,
            TEST_KID,
            &pb::FoodIdentifyResponse {
                item_name: "oat milk".to_owned(),
                ..Default::default()
            },
            "FoodIdentify",
            FOOD_IDENTIFY_RESPONSE,
        )
        .await
        .expect("seal food response");
        assert_eq!(aad(&identified), "humane.aibus.FoodIdentifyResponse");

        // The binding is authenticated, not cosmetic: the body still opens under
        // its channel key with the AAD in place.
        for sealed in [composed, summarized, capability, translated, identified] {
            let kid = sealed
                .encryption_information
                .map(|information| information.kid)
                .unwrap_or_default();
            assert!(
                keys.open(&cosmos_crypto::EncryptedData {
                    kid,
                    data: sealed.data,
                })
                .is_ok(),
                "a type-bound envelope still opens under its channel key"
            );
        }
    }

    // Failure modes: success is unarchived/duplicated, one caller writes another
    // account, a failed model creates history, or failed persistence looks successful.
    #[tokio::test]
    async fn one_off_translation_rpc_is_archived_once_and_readable_only_by_its_wearer() {
        use crate::web_api::test_support::*;
        let store = crate::store::MemoryStore::shared();
        let keys = shared_keys();
        let service = Speech::with_dependencies(
            keys.clone(),
            Arc::new(MockChatModel::new(vec![text_response("cześć")])),
        )
        .with_translation_history(store.clone());
        let mut request = Request::new(pb::EncryptedTranslateTextRequest {
            data: Some(self::seal(
                &keys,
                &pb::TranslateTextRequest {
                    text: "hello".into(),
                    is_locked: true,
                    from: Some(cosmos_protocol::common::Locale {
                        language: "en".into(),
                        ..Default::default()
                    }),
                    to: Some(cosmos_protocol::common::Locale {
                        language: "pl".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        });
        request
            .extensions_mut()
            .insert(cosmos_core::AuthenticatedPrincipal::from_edge("U:alice").unwrap());
        let sealed = service
            .translate_text(request)
            .await
            .unwrap()
            .into_inner()
            .data
            .unwrap();
        let plaintext = keys
            .open(&cosmos_crypto::EncryptedData {
                kid: self::TEST_KID.into(),
                data: sealed.data,
            })
            .unwrap();
        assert_eq!(
            pb::TranslateTextResponse::decode(plaintext.as_slice())
                .unwrap()
                .translation,
            "cześć"
        );
        let events = store
            .query_events("U:alice", "humane.translation", "", None, None, 10)
            .await
            .unwrap();
        assert_eq!(
            events.len(),
            1,
            "successful RPC must create a history record"
        );
        assert!(
            events[0].device_is_locked,
            "stock TranslateText keyguard state is preserved"
        );
        let app = crate::web_api::router(crate::web_api::ApiState::for_tests(
            store,
            Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
            crate::web_api::DEMO_PRINCIPAL,
            internet_facing(),
            Some(test_verifier()),
            None,
        ));
        let (status, page) = send(
            &app,
            axum::http::Method::GET,
            "/notable-events/mydata?domain=TRANSLATION",
            &[bearer_header("alice")],
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(page["totalElements"], 1);
        assert_eq!(
            page["content"][0]["data"]["eventData"]["sourceLanguage"],
            "English"
        );
        assert_eq!(
            page["content"][0]["data"]["eventData"]["targetLanguage"],
            "Polish"
        );
        let (_, other) = send(
            &app,
            axum::http::Method::GET,
            "/notable-events/mydata?domain=TRANSLATION",
            &[bearer_header("bob")],
            None,
        )
        .await;
        assert_eq!(other["totalElements"], 0);
    }

    #[tokio::test]
    async fn one_off_translation_never_claims_success_when_the_archive_write_fails() {
        let service = Speech::with_dependencies(
            shared_keys(),
            Arc::new(MockChatModel::new(vec![text_response("cześć")])),
        )
        .with_translation_history(Arc::new(crate::store_postgres::PostgresStore::unreachable()));
        let status = service
            .translate_one_off(
                "U:alice",
                pb::TranslateTextRequest {
                    text: "hello".into(),
                    to: Some(cosmos_protocol::common::Locale {
                        language: "pl".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert_eq!(status.code(), tonic::Code::Unavailable);
    }

    #[tokio::test]
    async fn one_off_translation_provider_failure_records_nothing_and_missing_identity_is_denied() {
        let store = crate::store::MemoryStore::shared();
        let keys = shared_keys();
        let service = Speech::with_dependencies(
            keys.clone(),
            Arc::new(MockChatModel::new(vec![text_response("")])),
        )
        .with_translation_history(store.clone());
        let input = pb::TranslateTextRequest {
            text: "hello".into(),
            to: Some(cosmos_protocol::common::Locale {
                language: "pl".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(
            service
                .translate_one_off("U:alice", input.clone())
                .await
                .is_err()
        );
        assert_eq!(
            store
                .query_events("U:alice", "humane.translation", "", None, None, 10)
                .await
                .unwrap()
                .len(),
            0
        );
        let status = service
            .translate_text(Request::new(pb::EncryptedTranslateTextRequest {
                data: Some(seal(&keys, &input)),
            }))
            .await
            .unwrap_err();
        assert_eq!(status.code(), tonic::Code::Unauthenticated);
        let mut same_language = input;
        same_language.from = same_language.to.clone();
        assert_eq!(
            service
                .translate_one_off("", same_language)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unauthenticated
        );
    }

    #[tokio::test]
    async fn one_off_translation_encrypted_channel_cannot_record_for_another_wearer() {
        let store = crate::store::MemoryStore::shared();
        let directory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let kid = "d=pin;u=bob;s=translation";
        directory
            .put(kid, [17; cosmos_crypto::AES_KEY_LEN])
            .await
            .unwrap();
        let service = Speech::with_dependencies(
            shared_keys(),
            Arc::new(MockChatModel::new(vec![text_response("cześć")])),
        )
        .with_key_directory(directory.clone())
        .with_translation_history(store.clone());
        let input = pb::TranslateTextRequest {
            text: "hello".into(),
            to: Some(cosmos_protocol::common::Locale {
                language: "pl".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let encrypted = directory
            .seal(kid, &input.encode_to_vec(), b"")
            .await
            .unwrap()
            .unwrap();
        let mut request = Request::new(pb::EncryptedTranslateTextRequest {
            data: Some(EncryptedData {
                encryption_information: Some(
                    cosmos_protocol::common::encryption::EncryptionInformation {
                        kid: encrypted.kid,
                    },
                ),
                data: encrypted.data,
            }),
        });
        request
            .extensions_mut()
            .insert(cosmos_core::AuthenticatedPrincipal::from_edge("U:alice").unwrap());
        assert_eq!(
            service.translate_text(request).await.unwrap_err().code(),
            tonic::Code::PermissionDenied
        );
        assert!(
            store
                .query_events("U:alice", "humane.translation", "", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .query_events("U:bob", "humane.translation", "", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
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

    /// A failed model call tells the Pin which capability's model is
    /// unavailable and nothing of the provider's own error text.
    #[tokio::test]
    async fn a_failed_model_call_keeps_the_provider_error_out_of_the_status() {
        let model: Arc<dyn ChatModel> = Arc::new(MockChatModel::new(Vec::new()));
        let status = model_text(&model, "conversation translation", "system", "prompt")
            .await
            .unwrap_err();
        assert_eq!(status.code(), tonic::Code::Unavailable);
        assert_eq!(
            status.message(),
            "the conversation translation model is unavailable"
        );
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

    #[tokio::test]
    async fn semantic_memory_search_returns_only_model_ranked_owned_notes() {
        let store: crate::store::SharedStore = Arc::new(crate::store::MemoryStore::default());
        let principal = "development-insecure-principal";
        let wanted = store
            .create_note(principal, crate::store::NewNote::sealed(None, None))
            .await
            .expect("note created");
        store
            .index_note(
                principal,
                &wanted.uuid,
                "Our accommodation in France was Le Bristol",
            )
            .await;
        let unrelated = store
            .create_note(principal, crate::store::NewNote::sealed(None, None))
            .await
            .expect("note created");
        store
            .index_note(
                principal,
                &unrelated.uuid,
                "The car service is due on Friday",
            )
            .await;

        let response = format!("[\"unknown-note\",\"{}\",\"{}\"]", wanted.uuid, wanted.uuid);
        let search = WebSearch::with_model(
            store,
            Arc::new(MockChatModel::new(vec![text_response(&response)])),
        );
        let found = search
            .search(Request::new(pb::SearchRequest {
                text_query: "Where did we sleep in Paris?".to_owned(),
            }))
            .await
            .expect("semantic search succeeds")
            .into_inner();
        assert_eq!(found.memories.len(), 1);
        assert_eq!(found.memories[0].uuid, wanted.uuid);
    }

    /// Every stock method path reaches a handler through the servers
    /// `serve_until` registers. tonic routes the proto rpc name verbatim, so an
    /// rpc spelled differently from stock (`Search` for stock `search`) still
    /// compiles and passes every handler test that calls the trait directly,
    /// yet a stock client gets UNIMPLEMENTED.
    ///
    /// The registry is the stock inventory, all 98 paths. Every workload runs as
    /// it does in production. A path counts as routed when some workload answers
    /// with anything except tonic's routing fallback, which is grpc-status 12
    /// with no grpc-message. Handler errors, including a handler's own
    /// UNIMPLEMENTED, carry a message. The empty body stops a unary call at
    /// decoding, so those handlers never run.
    #[tokio::test]
    async fn every_stock_method_path_routes_to_a_handler() {
        use axum::http;
        use tower::ServiceExt;

        async fn routed(channel: &tonic::transport::Channel, path: &str) -> bool {
            let request = http::Request::post(path)
                .header(http::header::CONTENT_TYPE, "application/grpc")
                .header(http::header::TE, "trailers")
                .body(tonic::body::empty_body())
                .expect("gRPC request");
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                channel.clone().oneshot(request),
            )
            .await
            .unwrap_or_else(|_| panic!("{path} answered within 10s"))
            .unwrap_or_else(|error| panic!("{path} transport: {error}"));
            let headers = response.headers();
            let fallback = headers.get("grpc-status").is_some_and(|code| code == "12")
                && !headers.contains_key("grpc-message");
            !fallback
        }

        // Provisioning refuses process-local enrollment state unless told it is
        // the only replica, which platform/compose/production.yaml declares.
        // SAFETY: the value is constant, and nothing reads it as unset.
        unsafe { std::env::set_var("COSMOS_ALLOW_SINGLE_REPLICA_ENROLLMENT", "1") };
        let mut workloads = Vec::new();
        for workload in cosmos_core::Workload::ALL {
            let grpc_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind temporary gRPC listener");
            let admin_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind temporary HTTP listener");
            let grpc = grpc_listener.local_addr().expect("gRPC address");
            let admin = admin_listener.local_addr().expect("HTTP address");
            drop((grpc_listener, admin_listener));
            let values = std::collections::HashMap::from([
                ("COSMOS_WORKLOAD".to_owned(), workload.as_str().to_owned()),
                (
                    "COSMOS_AUTH_MODE".to_owned(),
                    "development-insecure".to_owned(),
                ),
                ("COSMOS_GRPC_BIND".to_owned(), grpc.to_string()),
                ("COSMOS_HTTP_BIND".to_owned(), admin.to_string()),
                ("COSMOS_KID_SCOPE".to_owned(), "audit".to_owned()),
            ]);
            let config = crate::config::Config::from_map(&values).expect("local workload config");
            let server = tokio::spawn(crate::serve_until(config, std::future::pending()));
            let endpoint = tonic::transport::Endpoint::from_shared(format!("http://{grpc}"))
                .expect("valid endpoint URI");
            let mut channel = None;
            for _ in 0..400 {
                if let Ok(connected) = endpoint.connect().await {
                    channel = Some(connected);
                    break;
                }
                if server.is_finished() {
                    panic!("{workload} stopped during startup: {:?}", server.await);
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            workloads.push((
                workload,
                channel.unwrap_or_else(|| panic!("{workload} gRPC server became reachable")),
            ));
        }

        for (workload, channel) in &workloads {
            assert!(
                !routed(channel, "/humane.aibus.WebSearchService/Search").await,
                "{workload} must answer the non-stock spelling with the routing fallback"
            );
        }

        let mut unrouted = Vec::new();
        for method in cosmos_core::registry::SERVICES
            .iter()
            .flat_map(|service| service.methods)
        {
            let mut served = false;
            for (_, channel) in &workloads {
                if routed(channel, method.path).await {
                    served = true;
                    break;
                }
            }
            if !served {
                unrouted.push(method.path);
            }
        }
        assert!(
            unrouted.is_empty(),
            "stock paths no workload routes: {unrouted:#?}"
        );
    }
}
