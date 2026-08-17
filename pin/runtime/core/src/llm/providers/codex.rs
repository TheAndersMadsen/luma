use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures::StreamExt as _;
use reqwest::{Client as HttpClient, StatusCode, Url};
use rig::completion::message::{AssistantContent, Message, ToolResultContent, UserContent};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::{
    validate_codex_bridge_token, validate_codex_bridge_url, ResolvedConfig,
    MAX_CODEX_BRIDGE_URL_BYTES,
};
use crate::llm::backend::{LlmBackend, LlmFuture};
use crate::llm::codex_bridge::{
    build_bridge_http_client, verify_bridge_identity, BridgeIdentityError,
};
use crate::llm::prompt::PromptBuilder;
use crate::llm::request::{LlmChatRequest, LlmResponseMode};
use crate::llm::tool_step::{ToolStepDefinition, ToolStepResult};
use crate::llm::ChatResult;
use crate::tier_a::operational_markers;

const CHAT_TIMEOUT: Duration = Duration::from_secs(240);
const SESSION_FINISH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CHAT_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_CAMERA_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FLATTENED_HISTORY_PART_CHARS: usize = 16 * 1024;

/// The bridge response mode every tool step is sent with. Named once so the
/// payload below and the outbound instrumentation cannot disagree about which
/// bridge instruction the model actually received.
const TOOL_STEP_WIRE_MODE: LlmResponseMode = LlmResponseMode::ToolStep;
/// The serde spelling of `TOOL_STEP_WIRE_MODE`, logged so one device run proves
/// which mode produced a step. `tool_step_wire_mode_label_matches_the_payload`
/// pins the two together, so this literal cannot drift from the wire.
const TOOL_STEP_WIRE_MODE_LABEL: &str = "hermes_tool_loop";

pub struct CodexProvider;

impl CodexProvider {
    pub fn build(
        config: &ResolvedConfig,
    ) -> Result<Arc<dyn LlmBackend>, Box<dyn std::error::Error + Send + Sync>> {
        let llm_config = &config.config.llm;
        let bridge_url = llm_config.resolve_codex_bridge_url();
        let endpoint = chat_endpoint(&bridge_url)?;
        let http_client = build_bridge_http_client(llm_config)?;
        let bridge_token = llm_config.resolve_codex_bridge_token();
        if let Some(token) = bridge_token.as_deref() {
            validate_codex_bridge_token(token)?;
        }

        tracing::info!(
            model = %llm_config.model,
            bridge_origin = %endpoint.origin().ascii_serialization(),
            bridge_token_configured = bridge_token.is_some(),
            "Codex bridge backend ready"
        );

        Ok(Arc::new(CodexBackend {
            http_client,
            bridge_url,
            endpoint,
            bridge_token,
            model: llm_config.effective_model(),
            tool_sessions: Mutex::new(HashMap::new()),
        }))
    }
}

struct CodexBackend {
    http_client: HttpClient,
    bridge_url: String,
    endpoint: Url,
    bridge_token: Option<String>,
    model: String,
    tool_sessions: Mutex<HashMap<String, RetainedToolSession>>,
}

#[derive(Debug)]
enum RetainedToolSession {
    Active {
        system: String,
        seen_messages: usize,
        in_flight: bool,
    },
    /// This correlation already retired or failed its retained path. Continue
    /// statelessly; the bridge tombstones retired IDs and must not be asked to
    /// recreate them.
    Disabled,
}

struct ToolStepDelivery {
    endpoint: Url,
    messages: Vec<BridgeMessage>,
    retained: bool,
    verify_identity: bool,
    transcript_messages: usize,
}

#[derive(Debug, Serialize)]
struct BridgeChatRequest {
    model: String,
    messages: Vec<BridgeMessage>,
    #[serde(rename = "responseMode")]
    response_mode: LlmResponseMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<BridgeImage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeImage {
    media_type: &'static str,
    data: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct BridgeMessage {
    role: &'static str,
    content: String,
}

#[derive(Deserialize)]
struct BridgeChatResponse {
    text: String,
}

impl LlmBackend for CodexBackend {
    fn chat<'a>(&'a self, request: LlmChatRequest) -> LlmFuture<'a> {
        Box::pin(async move { self.send_chat(request, self.endpoint.clone()).await })
    }

    fn tool_step<'a>(
        &'a self,
        request: crate::llm::tool_step::ToolStepRequest,
    ) -> crate::llm::backend::ToolStepFuture<'a> {
        Box::pin(async move {
            // The Codex bridge has no native function-calling wire, so this
            // adapter follows the reference agent's fallback for such transports:
            // tool schemas are embedded in the instructions and the model
            // answers with `<tool_call>{...}</tool_call>` blocks that are
            // parsed back into the shared step result. The loop, tools, and
            // validation are identical to the native-wire providers.
            let bridge_token = self.bridge_token.as_deref().ok_or_else(|| {
                "The Codex bridge token is not configured. Add it in server settings.".to_string()
            })?;

            let system = build_tool_step_system_text(&request.system_prompt, &request.tools);
            let outbound =
                ToolSurfaceSummary::measure(&request.tools, request.system_prompt.len(), &system);

            let delivery = self.prepare_tool_step_delivery(&request, system);
            if delivery.verify_identity {
                if let Err(error) =
                    verify_bridge_identity(&self.http_client, &self.bridge_url, bridge_token).await
                {
                    if delivery.retained {
                        self.disable_retained_tool_session(&request.correlation);
                    }
                    return Err(bridge_identity_error(error));
                }
            }
            let session_transport = if delivery.retained {
                "retained"
            } else {
                "stateless"
            };
            let session_reused = delivery.retained && !delivery.verify_identity;

            // Instrumentation, emitted BEFORE the network call so a step that
            // later times out still proves what surface the model was offered.
            // Counts, byte lengths, booleans and tool NAMES only — the tool
            // descriptions, the parameter schemas and the transcript are
            // measured, never captured.
            tracing::info!(
                correlation = %request.correlation,
                tool_count = outbound.tool_count,
                tools_empty = outbound.tools_empty,
                tool_branch = outbound.tool_branch,
                base_prompt_bytes = outbound.base_prompt_bytes,
                system_bytes = outbound.system_bytes,
                tool_block_bytes = outbound.tool_block_bytes,
                transcript_messages = request.messages.len(),
                messages_sent = delivery.messages.len(),
                wire_mode = TOOL_STEP_WIRE_MODE_LABEL,
                session_transport,
                session_reused,
                tool_digest = %outbound.tool_digest,
                tool_names = %outbound.tool_names,
                "{}",
                operational_markers::CODEX_STEP_OUTBOUND
            );

            let payload = BridgeChatRequest {
                model: self.model.clone(),
                messages: delivery.messages,
                response_mode: TOOL_STEP_WIRE_MODE,
                image: None,
            };
            let response = async {
                let response = self
                    .http_client
                    .post(delivery.endpoint)
                    .bearer_auth(bridge_token)
                    .timeout(request.timeout.min(CHAT_TIMEOUT))
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|error| bridge_transport_error(&error))?;
                if !response.status().is_success() {
                    return Err(bridge_status_error(response.status()));
                }
                decode_limited_chat_response(response).await
            }
            .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    if delivery.retained {
                        self.disable_retained_tool_session(&request.correlation);
                    }
                    return Err(error);
                }
            };
            if delivery.retained {
                self.commit_retained_tool_session(
                    &request.correlation,
                    delivery.transcript_messages,
                );
            }
            let (step, scan) = parse_tool_step_text_scanned(&response.text);
            let (outcome, spoken_bytes) = step_outcome(&step);
            // Instrumentation. `reason` is a closed set; every other field is a
            // count, a boolean or a byte length. The reply is user-facing prose
            // and the block bodies carry tool arguments, so neither is ever
            // logged — not even a slice.
            tracing::info!(
                correlation = %request.correlation,
                response_bytes = response.text.len(),
                markup_present = scan.markup_present,
                open_tags = scan.open_tags,
                blocks_found = scan.blocks_found,
                parsed_ok = scan.parsed_ok,
                json_parse = scan.json_parse,
                missing_name = scan.missing_name,
                unterminated = scan.unterminated,
                foreign_tag = scan.foreign_tag,
                reason = scan.reason(),
                outcome,
                spoken_bytes,
                "{}",
                operational_markers::CODEX_STEP_PARSED
            );
            Ok(step)
        })
    }

    fn finish_tool_session(&self, correlation: &str) {
        let was_active = self
            .tool_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(correlation)
            .is_some_and(|session| matches!(session, RetainedToolSession::Active { .. }));
        if was_active {
            self.schedule_retained_session_finish(correlation);
        }
    }
}

impl CodexBackend {
    fn prepare_tool_step_delivery(
        &self,
        request: &crate::llm::tool_step::ToolStepRequest,
        system: String,
    ) -> ToolStepDelivery {
        let full_messages = || {
            let mut messages = vec![BridgeMessage {
                role: "system",
                content: system.clone(),
            }];
            messages.extend(
                request
                    .messages
                    .iter()
                    .filter_map(message_to_bridge_message),
            );
            messages
        };
        let stateless = || ToolStepDelivery {
            endpoint: self.endpoint.clone(),
            messages: full_messages(),
            retained: false,
            verify_identity: true,
            transcript_messages: request.messages.len(),
        };

        // Tests and defensive callers may use a human-readable correlation.
        // Production run IDs are canonical server-generated UUIDv4 values. A
        // noncanonical value keeps the previous stateless behavior rather than
        // becoming an attacker-chosen bridge path segment.
        if !canonical_retained_session_id(&request.correlation) {
            return stateless();
        }
        let Ok(endpoint) = retained_session_endpoint(&self.bridge_url, &request.correlation, true)
        else {
            return stateless();
        };

        let mut retire_existing = false;
        let delivery = {
            let mut sessions = self
                .tool_sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match sessions.get_mut(&request.correlation) {
                None if !request.tools.is_empty() => {
                    sessions.insert(
                        request.correlation.clone(),
                        RetainedToolSession::Active {
                            system: system.clone(),
                            seen_messages: 0,
                            in_flight: true,
                        },
                    );
                    ToolStepDelivery {
                        endpoint,
                        messages: full_messages(),
                        retained: true,
                        verify_identity: true,
                        transcript_messages: request.messages.len(),
                    }
                }
                Some(RetainedToolSession::Active {
                    system: retained_system,
                    seen_messages,
                    in_flight,
                }) if retained_system == &system
                    && !*in_flight
                    && request.messages.len() >= *seen_messages =>
                {
                    let mut messages = vec![BridgeMessage {
                        role: "system",
                        content: system.clone(),
                    }];
                    // The retained Codex thread already owns every assistant
                    // answer it produced. Only host-authored user/tool-result
                    // deltas are new input; replaying assistant output or the
                    // full transcript would duplicate context each step.
                    messages.extend(
                        request.messages[*seen_messages..]
                            .iter()
                            .filter(|message| matches!(message, Message::User { .. }))
                            .filter_map(message_to_bridge_message),
                    );
                    if messages.len() == 1 {
                        retire_existing = true;
                        sessions.insert(request.correlation.clone(), RetainedToolSession::Disabled);
                        stateless()
                    } else {
                        *in_flight = true;
                        ToolStepDelivery {
                            endpoint,
                            messages,
                            retained: true,
                            verify_identity: false,
                            transcript_messages: request.messages.len(),
                        }
                    }
                }
                Some(RetainedToolSession::Active { .. }) => {
                    // A changed tool surface (the tool-free grace call), a
                    // transcript rewind, or overlapping use cannot safely
                    // continue the same provider thread. Retire it and use the
                    // complete stateless request for the remainder of this run.
                    retire_existing = true;
                    sessions.insert(request.correlation.clone(), RetainedToolSession::Disabled);
                    stateless()
                }
                Some(RetainedToolSession::Disabled) | None => stateless(),
            }
        };
        if retire_existing {
            self.schedule_retained_session_finish(&request.correlation);
        }
        delivery
    }

    fn commit_retained_tool_session(&self, correlation: &str, seen_messages: usize) {
        if let Some(RetainedToolSession::Active {
            seen_messages: retained_seen,
            in_flight,
            ..
        }) = self
            .tool_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(correlation)
        {
            *retained_seen = seen_messages;
            *in_flight = false;
        }
    }

    fn disable_retained_tool_session(&self, correlation: &str) {
        let was_active = {
            let mut sessions = self
                .tool_sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = sessions.insert(correlation.to_string(), RetainedToolSession::Disabled);
            previous.is_some_and(|session| matches!(session, RetainedToolSession::Active { .. }))
        };
        if was_active {
            self.schedule_retained_session_finish(correlation);
        }
    }

    fn schedule_retained_session_finish(&self, correlation: &str) {
        let Some(token) = self.bridge_token.clone() else {
            return;
        };
        let Ok(endpoint) = retained_session_endpoint(&self.bridge_url, correlation, false) else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let client = self.http_client.clone();
        runtime.spawn(async move {
            let result = client
                .delete(endpoint)
                .bearer_auth(token)
                .timeout(SESSION_FINISH_TIMEOUT)
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => {}
                Ok(response) => {
                    tracing::warn!(
                        status = %response.status(),
                        "Codex retained tool session retirement was refused"
                    );
                }
                Err(_) => {
                    tracing::warn!("Codex retained tool session retirement did not reach bridge");
                }
            }
        });
    }

    async fn send_chat(
        &self,
        request: LlmChatRequest,
        endpoint: Url,
    ) -> Result<ChatResult, String> {
        let bridge_token = self.bridge_token.as_deref().ok_or_else(|| {
            "The Codex bridge token is not configured. Add it in server settings.".to_string()
        })?;

        let image = request
            .image
            .as_deref()
            .map(encode_camera_image)
            .transpose()?;

        verify_bridge_identity(&self.http_client, &self.bridge_url, bridge_token)
            .await
            .map_err(bridge_identity_error)?;

        let payload = BridgeChatRequest {
            model: request
                .model_override
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .unwrap_or(&self.model)
                .to_string(),
            messages: bridge_messages(&request),
            response_mode: request.response_mode,
            image,
        };

        let response = self
            .http_client
            .post(endpoint)
            .bearer_auth(bridge_token)
            .timeout(CHAT_TIMEOUT)
            .json(&payload)
            .send()
            .await
            .map_err(|error| bridge_transport_error(&error))?;

        if !response.status().is_success() {
            return Err(bridge_status_error(response.status()));
        }

        let response = decode_limited_chat_response(response).await?;
        let text = response.text.trim();
        if text.is_empty() {
            return Err("The Codex bridge returned an empty response.".to_string());
        }

        Ok(ChatResult::Text(text.to_string()))
    }
}

/// Assemble the chat-turn system text: the base prompt, then either the tool
/// catalog block or the explicit "no tools" notice.
///
/// Extracted verbatim from `tool_step` so the outbound instrumentation and
/// its tests can measure the exact bytes the model receives without a bridge or
/// a device. The output is byte-identical to the inline assembly it replaced —
/// `assembled_system_text_is_byte_stable` pins both branches.
fn build_tool_step_system_text(system_prompt: &str, tools: &[ToolStepDefinition]) -> String {
    let mut system = system_prompt.to_string();
    if !tools.is_empty() {
        system.push_str("\n# Tools\nYou may call the following tools. To call one, reply with ONLY one or more blocks of the exact form <tool_call>{\"name\":\"tool_name\",\"arguments\":{...}}</tool_call> and no other text. To answer the user instead, reply with plain text and no tool_call block.\n");
        for tool in tools {
            let _ = std::fmt::Write::write_fmt(
                &mut system,
                format_args!(
                    "- {}: {} parameters={}\n",
                    tool.name,
                    tool.description,
                    serde_json::to_string(&tool.parameters).unwrap_or_default()
                ),
            );
        }
    } else {
        system.push_str("\nNo tools are available for this reply. Answer in plain text.\n");
    }
    system
}

/// What tool surface one tool step actually offered the model.
///
/// Instrumentation only: every field is a count, a byte length, a boolean, or a
/// tool NAME. `ToolStepDefinition::name` is a `&'static str` from the compile-time
/// spec tables, so it is a public identifier and safe to trace; the
/// description, the parameter schema, the base prompt and the transcript are
/// MEASURED here and never captured. `outbound_summary_never_carries_tool_text`
/// pins that: adding any text-bearing field to this struct turns it red.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolSurfaceSummary {
    tool_count: usize,
    tools_empty: bool,
    /// Closed set: which branch of the system-text assembly ran.
    /// `none_advertised` means the model was explicitly told it has no tools.
    tool_branch: &'static str,
    base_prompt_bytes: usize,
    system_bytes: usize,
    tool_block_bytes: usize,
    tool_names: String,
    tool_digest: String,
}

impl ToolSurfaceSummary {
    fn measure(tools: &[ToolStepDefinition], base_prompt_bytes: usize, system: &str) -> Self {
        // The full catalog joins to ~570 bytes, far inside logcat's per-line
        // budget, so the names are logged in full rather than sampled: the
        // operator gets one device run and needs to see WHICH tools were
        // advertised, not just how many. The digest rides alongside so two
        // steps (or two runs, or two releases) can be compared for an
        // identical surface with a single grep instead of eyeballing 37 names.
        let tool_names = tools
            .iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>()
            .join(",");
        Self {
            tool_count: tools.len(),
            tools_empty: tools.is_empty(),
            tool_branch: if tools.is_empty() {
                "none_advertised"
            } else {
                "catalog"
            },
            base_prompt_bytes,
            system_bytes: system.len(),
            tool_block_bytes: system.len().saturating_sub(base_prompt_bytes),
            tool_digest: tool_name_digest(&tool_names),
            tool_names,
        }
    }
}

/// Stable 64-bit FNV-1a over the joined tool names. A fingerprint for
/// comparing tool surfaces across steps and runs, not a security hash.
fn tool_name_digest(names: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in names.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// How the reply's tool-call markup was recognised — or lost.
///
/// Instrumentation only: counts and booleans, no text of any kind. The block
/// bodies carry tool arguments (which the repo treats as private user data) and
/// the surrounding prose is the spoken answer, so neither may be retained.
/// `inbound_scan_never_carries_reply_text` pins that.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ToolCallScan {
    /// The reply contains the tool-call tag FAMILY (`<tool_call…`) anywhere.
    markup_present: bool,
    /// Occurrences of the exact open tag `<tool_call>` in the whole reply.
    open_tags: usize,
    /// Blocks the parser actually entered. `open_tags > blocks_found` means an
    /// open tag was swallowed inside an earlier block's body — see the
    /// unterminated-block note on `parse_tool_step_text_scanned`.
    blocks_found: usize,
    parsed_ok: usize,
    json_parse: usize,
    missing_name: usize,
    unterminated: usize,
    /// Tag-family occurrences that are NOT the exact `<tool_call>` open tag:
    /// `<tool_call_result>`, `<tool_call id="1">`, and friends. These are
    /// invisible to the parser even when they carry a well-formed call.
    foreign_tag: usize,
}

impl ToolCallScan {
    fn failed(&self) -> usize {
        self.json_parse + self.missing_name + self.unterminated
    }

    /// One closed-set token naming what happened, for single-grep triage.
    /// Values: `ok`, `partial`, `unterminated`, `json_parse`, `missing_name`,
    /// `foreign_tag`, `no_markup`.
    fn reason(&self) -> &'static str {
        if self.parsed_ok > 0 && self.failed() == 0 {
            "ok"
        } else if self.parsed_ok > 0 {
            "partial"
        } else if self.unterminated > 0 {
            "unterminated"
        } else if self.json_parse > 0 {
            "json_parse"
        } else if self.missing_name > 0 {
            "missing_name"
        } else if self.markup_present {
            "foreign_tag"
        } else {
            "no_markup"
        }
    }
}

/// Closed-set outcome label plus the length of what would be spoken. The three
/// shapes are the only ones this transport can hand the loop.
fn step_outcome(step: &ToolStepResult) -> (&'static str, usize) {
    match step {
        ToolStepResult::ToolCalls(_) => ("tool_calls", 0),
        ToolStepResult::Final(text) if text.is_empty() => ("final_empty", 0),
        ToolStepResult::Final(text) => ("final_prose", text.len()),
    }
}

fn encode_camera_image(bytes: &[u8]) -> Result<BridgeImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_CAMERA_IMAGE_BYTES {
        return Err("The camera image is too large for vision analysis.".to_string());
    }
    let media_type = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        "image/png"
    } else {
        return Err("The camera returned an unsupported image format.".to_string());
    };
    Ok(BridgeImage {
        media_type,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn chat_endpoint(base_url: &str) -> Result<Url, Box<dyn std::error::Error + Send + Sync>> {
    if base_url.trim().len() > MAX_CODEX_BRIDGE_URL_BYTES {
        return Err("Codex bridge URL is too long".into());
    }
    validate_codex_bridge_url(base_url)?;
    let mut url = Url::parse(base_url.trim())?;

    let base_path = url.path().trim_end_matches('/');
    let chat_path = if base_path.is_empty() {
        "/chat".to_string()
    } else {
        format!("{base_path}/chat")
    };
    url.set_path(&chat_path);
    Ok(url)
}

fn canonical_retained_session_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| {
        parsed.get_version_num() == 4 && parsed.hyphenated().to_string() == value
    })
}

fn retained_session_endpoint(
    base_url: &str,
    session_id: &str,
    turn: bool,
) -> Result<Url, Box<dyn std::error::Error + Send + Sync>> {
    if base_url.trim().len() > MAX_CODEX_BRIDGE_URL_BYTES {
        return Err("Codex bridge URL is too long".into());
    }
    validate_codex_bridge_url(base_url)?;
    if !canonical_retained_session_id(session_id) {
        return Err("Codex retained session ID is invalid".into());
    }
    let mut url = Url::parse(base_url.trim())?;
    let base_path = url.path().trim_end_matches('/');
    let suffix = if turn { "/turn" } else { "" };
    let path = if base_path.is_empty() {
        format!("/agentic-sessions/{session_id}{suffix}")
    } else {
        format!("{base_path}/agentic-sessions/{session_id}{suffix}")
    };
    url.set_path(&path);
    Ok(url)
}

async fn decode_limited_chat_response(
    response: reqwest::Response,
) -> Result<BridgeChatResponse, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CHAT_RESPONSE_BYTES as u64)
    {
        return Err("The Codex bridge returned an invalid response.".into());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The Codex bridge returned an invalid response.")?;
        if body.len().saturating_add(chunk.len()) > MAX_CHAT_RESPONSE_BYTES {
            return Err("The Codex bridge returned an invalid response.".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| {
        "The Codex bridge returned an invalid response. Please restart the host bridge.".into()
    })
}

/// Parse a prompted-fallback tool step reply: `<tool_call>{...}</tool_call>`
/// blocks become tool calls; anything else is the final text. Mirrors the
/// Reference-agent ACP fallback parser: tolerant of surrounding prose, strict
/// about the JSON inside a block.
/// Monotonic across the process so synthesized tool-call ids are never reused
/// within a run (see the call-id comment below).
static SYNTHETIC_CALL_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Remove `<tool_call>` markup from a fallback answer.
///
/// A malformed or unterminated block leaves no parsed calls, and returning the
/// raw text made the Pin SPEAK the markup aloud — "less-than tool underscore
/// call, backtick backtick backtick json…" — and persisted it into conversation
/// history, contaminating the next turn. Strip every complete block plus any
/// unterminated remainder. If nothing meaningful survives, the loop declines on
/// the empty answer instead of narrating JSON.
fn strip_tool_call_markup(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    // Match the whole tool-call TAG FAMILY (`<tool_call…>`), not the single tag
    // `<tool_call>`. The model also emits `<tool_call_result>…</tool_call_result>`,
    // which contains neither `<tool_call>` nor `</tool_call>` as a substring, so it
    // slipped past this strip AND past the loop's `answer.contains("<tool_call>")`
    // guard and was SPOKEN ALOUD. Measured on device 2026-07-28: "who wrote Romeo
    // and Juliet?" was answered with
    //   <tool_call_result>Tool call failed: function not found</tool_call_result>
    // and the turn was additionally persisted into conversation history, so it
    // contaminated the following turn as well.
    while let Some(start) = rest.find("<tool_call") {
        out.push_str(&rest[..start]);
        let from_open = &rest[start..];
        let Some(open_end) = from_open.find('>') else {
            // Truncated opening tag: the remainder is markup, never speech.
            rest = "";
            break;
        };
        // Take the tag NAME only, so an attribute (`<tool_call id="1">`) still
        // yields the right closing tag rather than a string that never matches.
        let tag_full = &from_open[1..open_end];
        let tag = tag_full.split_whitespace().next().unwrap_or(tag_full);
        let closing = format!("</{tag}>");
        let body = &from_open[open_end + 1..];
        match body.find(closing.as_str()) {
            Some(end) => rest = &body[end + closing.len()..],
            None => {
                // Unterminated: the rest is truncated markup, never speech.
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Parse a step reply AND record how its markup was recognised.
///
/// The counters sit at the parser's own branch points rather than in a second
/// scanning pass, so the instrument cannot drift from the thing it measures.
/// Every accept/reject decision is unchanged: the `if let Ok`/`if let Some`
/// pair became a `match` whose new arms only increment a counter.
///
/// KNOWN BUG, deliberately preserved and instrumented rather than fixed:
/// `after.find("</tool_call>")` searches the WHOLE remainder, so an
/// unterminated block swallows every following block into its own body, the
/// combined body fails to parse, and well-formed later calls are lost. The
/// signature is `open_tags > blocks_found`. Fixing it would change behaviour
/// and invalidate the operator's before/after comparison.
fn parse_tool_step_text_scanned(text: &str) -> (ToolStepResult, ToolCallScan) {
    use crate::llm::tool_step::ToolStepCall;
    let mut scan = ToolCallScan {
        markup_present: text.contains("<tool_call"),
        open_tags: text.matches("<tool_call>").count(),
        foreign_tag: text
            .matches("<tool_call")
            .count()
            .saturating_sub(text.matches("<tool_call>").count()),
        ..ToolCallScan::default()
    };
    let mut calls = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<tool_call>") {
        scan.blocks_found += 1;
        let after = &rest[start + "<tool_call>".len()..];
        let Some(end) = after.find("</tool_call>") else {
            scan.unterminated += 1;
            break;
        };
        let body = after[..end].trim();
        match serde_json::from_str::<serde_json::Value>(body) {
            Ok(parsed) => match parsed.get("name").and_then(serde_json::Value::as_str) {
                Some(name) => {
                    scan.parsed_ok += 1;
                    let arguments = parsed
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    calls.push(ToolStepCall {
                        // Unique for the life of the process, not per step. A
                        // per-step counter restarted at "call-1" every iteration, so
                        // a run that searched music twice produced two results under
                        // the same id — the second collided with the first and
                        // `play_music` could never resolve the intended track, so
                        // playback silently never started.
                        call_id: format!(
                            "call-{}",
                            SYNTHETIC_CALL_SEQUENCE
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                + 1
                        ),
                        name: name.to_string(),
                        arguments,
                    });
                }
                None => scan.missing_name += 1,
            },
            Err(_) => scan.json_parse += 1,
        }
        rest = &after[end + "</tool_call>".len()..];
    }
    let result = if calls.is_empty() {
        ToolStepResult::Final(strip_tool_call_markup(text))
    } else {
        ToolStepResult::ToolCalls(calls)
    };
    (result, scan)
}

/// Test shim: the parse result without the recognition counters, so the
/// existing parser tests read exactly as they did before instrumentation.
#[cfg(test)]
fn parse_tool_step_text(text: &str) -> ToolStepResult {
    parse_tool_step_text_scanned(text).0
}

fn bridge_messages(request: &LlmChatRequest) -> Vec<BridgeMessage> {
    let mut messages = PromptBuilder::build_chat_history(request)
        .iter()
        .filter_map(message_to_bridge_message)
        .collect::<Vec<_>>();
    messages.push(BridgeMessage {
        role: "user",
        content: request.utterance.clone(),
    });
    messages
}

fn message_to_bridge_message(message: &Message) -> Option<BridgeMessage> {
    match message {
        Message::System { content } => nonempty_message("system", content.clone()),
        Message::User { content } => {
            let content = content
                .iter()
                .filter_map(user_content_to_bridge_text)
                .collect::<Vec<_>>()
                .join("\n");
            nonempty_message("user", content)
        }
        Message::Assistant { content, .. } => {
            let content = content
                .iter()
                .filter_map(assistant_content_to_bridge_text)
                .collect::<Vec<_>>()
                .join("\n");
            nonempty_message("assistant", content)
        }
    }
}

fn user_content_to_bridge_text(content: &UserContent) -> Option<String> {
    match content {
        UserContent::Text(text) => bounded_history_part(&text.text),
        UserContent::ToolResult(result) => {
            let output = result
                .content
                .iter()
                .filter_map(|content| match content {
                    ToolResultContent::Text(text) => bounded_history_part(&text.text),
                    ToolResultContent::Image(_) => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let output = output.trim();
            (!output.is_empty()).then(|| {
                format!(
                    "Prior device action result (action id {}):\n{}",
                    result.id, output
                )
            })
        }
        // Historical binary media is deliberately not duplicated into the
        // text bridge. The current request image uses the bounded image field.
        UserContent::Image(_)
        | UserContent::Audio(_)
        | UserContent::Video(_)
        | UserContent::Document(_) => None,
    }
}

fn assistant_content_to_bridge_text(content: &AssistantContent) -> Option<String> {
    match content {
        AssistantContent::Text(text) => bounded_history_part(&text.text),
        AssistantContent::ToolCall(call) => {
            let arguments = serde_json::to_string(&call.function.arguments).ok()?;
            let arguments = bounded_history_part(&arguments)?;
            Some(format!(
                "Prior assistant device action (action id {}, action {}):\n{}",
                call.id, call.function.name, arguments
            ))
        }
        // Never expose hidden reasoning or historical binary output.
        AssistantContent::Reasoning(_) | AssistantContent::Image(_) => None,
    }
}

fn bounded_history_part(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(
        value
            .chars()
            .take(MAX_FLATTENED_HISTORY_PART_CHARS)
            .collect(),
    )
}

fn nonempty_message(role: &'static str, content: String) -> Option<BridgeMessage> {
    (!content.trim().is_empty()).then_some(BridgeMessage { role, content })
}

fn bridge_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The Codex host bridge timed out. Please try again.".to_string()
    } else {
        "I couldn't reach the Codex host bridge. Check Wi-Fi and the bridge process.".to_string()
    }
}

fn bridge_identity_error(_error: BridgeIdentityError) -> String {
    "The Codex host bridge could not be verified. Check Wi-Fi, TLS, and the bridge process."
        .to_string()
}

fn bridge_status_error(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED => {
            "The Codex bridge token was rejected. Check the server settings.".to_string()
        }
        // The bridge answers 503 for a busy pool, a pending login and any
        // app-server fault alike, so this branch cannot know the cause. It used
        // to blame the login and sent users to fix a session that was already
        // healthy; the host log now names the real fault
        // (local_codex_bridge.rs `chat_outcome`). Only the 401 branch above is
        // credential-specific.
        StatusCode::SERVICE_UNAVAILABLE => {
            "Codex on the host is unavailable right now. Please try again.".to_string()
        }
        StatusCode::GATEWAY_TIMEOUT => {
            "The Codex host bridge timed out. Please try again.".to_string()
        }
        _ => format!("The Codex host bridge failed with HTTP status {status}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Json, Query};
    use axum::http::HeaderMap;
    use axum::routing::{delete, get, post};
    use axum::Router;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::Mutex;

    use crate::config::{Config, LlmProvider};
    use crate::llm::codex_bridge::challenge_proof_for_test;
    use crate::llm::request::{PromptTemplateContext, PromptTemplates};

    const TEST_TOKEN: &str = "unit-test-bridge-token-0123456789abcdef";

    fn test_chat_request(utterance: &str) -> LlmChatRequest {
        LlmChatRequest::new(
            utterance.into(),
            Vec::new(),
            PromptTemplates {
                system_prompt: "Keep it short.".into(),
                status_prompt: String::new(),
            },
            PromptTemplateContext {
                run_id: "run-1".into(),
                assistant_display_name: None,
                server_public_addr: "127.0.0.1:8080".into(),
                current_timestamp: "2026-07-13T12:00:00+02:00".into(),
                current_date: "2026-07-13".into(),
                current_time: "12:00:00 +0200".into(),
                location_name: None,
                latitude: None,
                longitude: None,
                coordinates: None,
            },
            None,
        )
    }

    async fn test_server(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), server)
    }

    #[test]
    fn provider_builds_without_a_persisted_bridge_token() {
        let mut config: Config = toml::from_str("").unwrap();
        config.llm.provider = LlmProvider::Codex;
        config.llm.codex_bridge_token = None;
        let config = ResolvedConfig::resolve(config);

        assert!(CodexProvider::build(&config).is_ok());
    }

    #[test]
    fn appends_chat_path_without_discarding_base_path() {
        assert_eq!(
            chat_endpoint("http://127.0.0.1:8765/bridge/")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8765/bridge/chat"
        );
    }

    #[test]
    fn retained_session_paths_require_canonical_uuid_v4_and_keep_base_path() {
        let session_id = "223e4567-e89b-42d3-a456-426614174000";
        assert_eq!(
            retained_session_endpoint(
                "http://127.0.0.1:8765/bridge/",
                session_id,
                true
            )
            .unwrap()
            .as_str(),
            "http://127.0.0.1:8765/bridge/agentic-sessions/223e4567-e89b-42d3-a456-426614174000/turn"
        );
        assert_eq!(
            retained_session_endpoint("http://127.0.0.1:8765/bridge/", session_id, false)
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8765/bridge/agentic-sessions/223e4567-e89b-42d3-a456-426614174000"
        );
        assert!(!canonical_retained_session_id(
            "223E4567-E89B-42D3-A456-426614174000"
        ));
        assert!(!canonical_retained_session_id("user-selected-session"));
    }

    #[test]
    fn rejects_bridge_url_credentials() {
        let error = chat_endpoint("http://user:secret@127.0.0.1:8765")
            .unwrap_err()
            .to_string();
        assert!(error.contains("must not contain credentials"));
    }

    #[test]
    fn accepts_loopback_http_and_https_bridge_hosts() {
        for base_url in [
            "http://localhost:8765",
            "http://127.42.0.1:8765",
            "http://[::1]:8765",
            "https://127.0.0.1:8765",
            "https://192.0.2.10:8765",
            "https://bridge.example.test:8765",
        ] {
            assert!(chat_endpoint(base_url).is_ok(), "{base_url}");
        }
    }

    #[test]
    fn rejects_plaintext_remote_and_ambiguous_bridge_urls() {
        for base_url in ["http://192.0.2.10:8765", "http://bridge.example.test:8765"] {
            let error = chat_endpoint(base_url).unwrap_err().to_string();
            assert!(error.contains("must use HTTPS"));
        }
        for base_url in [
            "https://bridge.example.test:8765?target=other",
            "https://bridge.example.test:8765/#fragment",
            "https://0.0.0.0:8765",
            "https://[::]:8765",
        ] {
            assert!(chat_endpoint(base_url).is_err(), "{base_url}");
        }
    }

    #[tokio::test]
    async fn sends_structured_messages_with_bridge_bearer_token() {
        let observed = Arc::new(Mutex::new(None));
        let handler_observed = Arc::clone(&observed);
        let events = Arc::new(Mutex::new(Vec::new()));
        let challenge_events = Arc::clone(&events);
        let chat_events = Arc::clone(&events);
        let challenge_observed = Arc::new(Mutex::new(None));
        let handler_challenge_observed = Arc::clone(&challenge_observed);
        let app = Router::new()
            .route(
                "/challenge",
                get(
                    move |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| {
                        let events = Arc::clone(&challenge_events);
                        let observed = Arc::clone(&handler_challenge_observed);
                        async move {
                            events.lock().unwrap().push("challenge");
                            let nonce = query.get("nonce").unwrap().clone();
                            *observed.lock().unwrap() = Some((headers, nonce.clone()));
                            Json(json!({
                                "proof": challenge_proof_for_test(TEST_TOKEN, &nonce)
                            }))
                        }
                    },
                ),
            )
            .route(
                "/chat",
                post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let observed = Arc::clone(&handler_observed);
                    let events = Arc::clone(&chat_events);
                    async move {
                        events.lock().unwrap().push("chat");
                        *observed.lock().unwrap() = Some((headers, body));
                        Json(json!({ "text": "Bridge answer" }))
                    }
                }),
            );
        let (bridge_url, server) = test_server(app).await;

        let backend = CodexBackend {
            http_client: HttpClient::new(),
            bridge_url: bridge_url.clone(),
            endpoint: chat_endpoint(&bridge_url).unwrap(),
            bridge_token: Some(TEST_TOKEN.into()),
            model: "gpt-5.4".into(),
            tool_sessions: Mutex::new(HashMap::new()),
        };
        assert_eq!(
            test_chat_request("default").response_mode,
            LlmResponseMode::VoiceAnswer
        );
        let mut request = test_chat_request("Hello")
            .with_model_override("gpt-5.3-codex-spark")
            .with_image(vec![0xff, 0xd8, 0xff, 0xdb]);
        request.response_mode = LlmResponseMode::AgenticJson;

        let result = backend.chat(request).await.unwrap();
        assert!(matches!(result, ChatResult::Text(ref text) if text == "Bridge answer"));

        let (challenge_headers, nonce) = challenge_observed.lock().unwrap().take().unwrap();
        assert!(challenge_headers.get("authorization").is_none());
        assert_eq!(nonce.len(), 43);
        assert!(!nonce.contains(TEST_TOKEN));
        assert!(!nonce.contains("Hello"));
        assert_eq!(*events.lock().unwrap(), ["challenge", "chat"]);

        let (headers, body) = observed.lock().unwrap().take().unwrap();
        assert_eq!(
            headers.get("authorization").unwrap().to_str().unwrap(),
            format!("Bearer {TEST_TOKEN}")
        );
        assert_eq!(body["model"], "gpt-5.3-codex-spark");
        assert_eq!(body["responseMode"], "agentic_json");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "Keep it short.");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "Hello");
        assert_eq!(body["image"]["mediaType"], "image/jpeg");
        assert_eq!(body["image"]["data"], "/9j/2w==");

        server.abort();
    }

    #[tokio::test]
    async fn invalid_challenge_outputs_fail_before_sending_bearer_or_prompt() {
        for challenge_body in [
            json!({
                "proof": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            })
            .to_string(),
            json!({ "proof": "malformed" }).to_string(),
            json!({ "proof": "x".repeat(300) }).to_string(),
            "{not-json".to_string(),
        ] {
            let chat_calls = Arc::new(Mutex::new(0_u32));
            let handler_chat_calls = Arc::clone(&chat_calls);
            let challenge_observed = Arc::new(Mutex::new(None));
            let handler_challenge_observed = Arc::clone(&challenge_observed);
            let app = Router::new()
                .route(
                    "/challenge",
                    get(
                        move |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| {
                            let challenge_body = challenge_body.clone();
                            let observed = Arc::clone(&handler_challenge_observed);
                            async move {
                                *observed.lock().unwrap() =
                                    Some((headers, query.get("nonce").unwrap().clone()));
                                (StatusCode::OK, challenge_body)
                            }
                        },
                    ),
                )
                .route(
                    "/chat",
                    post(move || {
                        let calls = Arc::clone(&handler_chat_calls);
                        async move {
                            *calls.lock().unwrap() += 1;
                            Json(json!({ "text": "must not be reached" }))
                        }
                    }),
                );
            let (bridge_url, server) = test_server(app).await;
            let backend = CodexBackend {
                http_client: HttpClient::new(),
                bridge_url: bridge_url.clone(),
                endpoint: chat_endpoint(&bridge_url).unwrap(),
                bridge_token: Some(TEST_TOKEN.into()),
                model: "gpt-5.4".into(),
                tool_sessions: Mutex::new(HashMap::new()),
            };

            let error = backend
                .chat(test_chat_request("prompt-must-not-leak"))
                .await
                .unwrap_err();

            assert_eq!(
                error,
                "The Codex host bridge could not be verified. Check Wi-Fi, TLS, and the bridge process."
            );
            assert!(!error.contains(TEST_TOKEN));
            assert!(!error.contains("prompt-must-not-leak"));
            assert_eq!(*chat_calls.lock().unwrap(), 0);
            let (headers, nonce) = challenge_observed.lock().unwrap().take().unwrap();
            assert!(headers.get("authorization").is_none());
            assert!(!nonce.contains(TEST_TOKEN));
            assert!(!nonce.contains("prompt-must-not-leak"));
            server.abort();
        }
    }

    #[tokio::test]
    async fn missing_bridge_token_fails_at_chat_time_without_network_access() {
        let backend = CodexBackend {
            http_client: HttpClient::new(),
            bridge_url: "http://127.0.0.1:9".into(),
            endpoint: chat_endpoint("http://127.0.0.1:9").unwrap(),
            bridge_token: None,
            model: "gpt-5.4".into(),
            tool_sessions: Mutex::new(HashMap::new()),
        };
        let request = test_chat_request("Hello");

        let error = backend.chat(request).await.unwrap_err();
        assert_eq!(
            error,
            "The Codex bridge token is not configured. Add it in server settings."
        );
    }

    #[test]
    fn camera_image_encoding_is_bounded_and_format_checked() {
        let png = encode_camera_image(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        assert_eq!(png.media_type, "image/png");
        assert_eq!(png.data, "iVBORw0KGgo=");
        assert!(encode_camera_image(&[]).is_err());
        assert!(encode_camera_image(b"not an image").is_err());
        assert!(encode_camera_image(&vec![0xff; MAX_CAMERA_IMAGE_BYTES + 1]).is_err());
    }

    #[tokio::test]
    async fn progress_cue_mode_and_model_override_reach_the_bridge_payload() {
        let observed = Arc::new(Mutex::new(None));
        let handler_observed = Arc::clone(&observed);
        let app = Router::new()
            .route(
                "/challenge",
                get(|Query(query): Query<HashMap<String, String>>| async move {
                    let nonce = query.get("nonce").unwrap();
                    Json(json!({
                        "proof": challenge_proof_for_test(TEST_TOKEN, nonce)
                    }))
                }),
            )
            .route(
                "/chat",
                post(move |Json(body): Json<Value>| {
                    let observed = Arc::clone(&handler_observed);
                    async move {
                        *observed.lock().unwrap() = Some(body);
                        Json(json!({ "text": r#"{"cue":"Finding songs"}"# }))
                    }
                }),
            );
        let (bridge_url, server) = test_server(app).await;

        let backend = CodexBackend {
            http_client: HttpClient::new(),
            bridge_url: bridge_url.clone(),
            endpoint: chat_endpoint(&bridge_url).unwrap(),
            bridge_token: Some(TEST_TOKEN.into()),
            model: "gpt-5.6-sol".into(),
            tool_sessions: Mutex::new(HashMap::new()),
        };
        let request = test_chat_request(r#"{"current_request":"play music"}"#)
            .with_progress_cue_output()
            .with_model_override("gpt-5.3-codex-spark");

        let result = backend.chat(request).await.unwrap();
        assert!(matches!(result, ChatResult::Text(_)));

        let body = observed.lock().unwrap().take().unwrap();
        assert_eq!(body["model"], "gpt-5.3-codex-spark");
        assert_eq!(body["responseMode"], "progress_cue");
        assert!(body.get("image").is_none());

        server.abort();
    }

    #[test]
    fn stock_action_and_observation_history_survives_codex_bridge_conversion() {
        let mut request = test_chat_request("How far is the second one?");
        request.history = vec![
            Message::Assistant {
                id: None,
                content: rig::OneOrMany::one(AssistantContent::tool_call(
                    "nearby-1",
                    "NearbySearch",
                    json!({"query":"coffee"}),
                )),
            },
            Message::tool_result("nearby-1", r#"1. First Cafe, 120 m\n2. Second Cafe, 240 m"#),
        ];

        let messages = bridge_messages(&request);
        assert!(messages.iter().any(|message| {
            message.role == "assistant"
                && message.content.contains("action NearbySearch")
                && message.content.contains("coffee")
        }));
        assert!(messages.iter().any(|message| {
            message.role == "user"
                && message.content.contains("action id nearby-1")
                && message.content.contains("2. Second Cafe, 240 m")
        }));
        assert_eq!(
            messages.last().unwrap().content,
            "How far is the second one?"
        );
    }

    #[test]
    fn synthesized_call_ids_never_repeat_across_steps() {
        use crate::llm::tool_step::ToolStepResult;
        // A run that searches music twice used to produce two results under
        // "call-1", because the counter restarted every step. The second
        // collided with the first, so `play_music` could not resolve the
        // intended track and playback silently never started.
        let block = "<tool_call>{\"name\":\"music_catalog_search\",\"arguments\":{}}</tool_call>";
        let mut seen = std::collections::HashSet::new();
        for _ in 0..4 {
            match parse_tool_step_text(block) {
                ToolStepResult::ToolCalls(calls) => {
                    assert_eq!(calls.len(), 1);
                    assert!(
                        seen.insert(calls[0].call_id.clone()),
                        "call id {} was reused across steps",
                        calls[0].call_id
                    );
                }
                other => panic!("expected tool calls, got {other:?}"),
            }
        }
        // Ids within a single multi-call batch must also be distinct.
        match parse_tool_step_text(&format!("{block}{block}")) {
            ToolStepResult::ToolCalls(calls) => {
                assert_eq!(calls.len(), 2);
                assert_ne!(calls[0].call_id, calls[1].call_id);
            }
            other => panic!("expected tool calls, got {other:?}"),
        }
    }

    #[test]
    fn tool_call_result_markup_is_never_spoken_aloud() {
        use crate::llm::tool_step::ToolStepResult;
        // MEASURED ON DEVICE 2026-07-28: this exact string was SPOKEN ALOUD in
        // answer to "who wrote Romeo and Juliet?" (test-runs artifact
        // session-20260728-110030-e245774a). `<tool_call_result>` contains neither
        // `<tool_call>` nor `</tool_call>` as a substring, so it passed both the
        // old strip and the loop's `answer.contains("<tool_call>")` guard, and was
        // additionally persisted into conversation history.
        assert_eq!(
            parse_tool_step_text(
                "<tool_call_result>Tool call failed: function not found</tool_call_result>"
            ),
            ToolStepResult::Final(String::new())
        );
        // Prose around a result block survives; the block does not.
        assert_eq!(
            parse_tool_step_text("Romeo and Juliet. <tool_call_result>noise</tool_call_result>"),
            ToolStepResult::Final("Romeo and Juliet.".to_string())
        );
        // An attribute on the tag must not defeat the closing-tag match.
        assert_eq!(
            parse_tool_step_text("<tool_call id=\"1\">{\"x\":1}</tool_call> Fine."),
            ToolStepResult::Final("Fine.".to_string())
        );
        // Truncated opening tag of the family: markup, never speech.
        assert_eq!(
            parse_tool_step_text("Checking. <tool_call_res"),
            ToolStepResult::Final("Checking.".to_string())
        );
    }

    #[test]
    fn malformed_tool_call_markup_is_stripped_from_the_spoken_answer() {
        use crate::llm::tool_step::ToolStepResult;
        // Truncated block: everything from the marker on is markup, not speech.
        assert_eq!(
            parse_tool_step_text("Let me check.\n<tool_call>{\"name\":\"knowledge_loo"),
            ToolStepResult::Final("Let me check.".to_string())
        );
        // Complete but non-JSON block: prose around it survives, markup does not.
        assert_eq!(
            parse_tool_step_text("Here you go. <tool_call>not json</tool_call> Done."),
            ToolStepResult::Final("Here you go.  Done.".to_string())
        );
        // Markup-only reply leaves nothing to say; the loop declines on empty
        // rather than narrating JSON.
        assert_eq!(
            parse_tool_step_text("<tool_call>{\"oops\":true}</tool_call>"),
            ToolStepResult::Final(String::new())
        );
    }

    // ---- instrumentation: outbound tool surface -------------------------

    /// A secret-shaped string no log line may ever carry. Used by both privacy
    /// tests below.
    const PRIVATE_MARKER: &str = "sk-live-PRIVATE-USER-SECRET-9f3a";

    fn tool_def(name: &'static str, description: &'static str) -> ToolStepDefinition {
        ToolStepDefinition {
            name,
            description,
            parameters: json!({"type": "object", "properties": {}}),
        }
    }

    #[test]
    fn tool_step_wire_mode_label_matches_the_payload() {
        // The outbound log line is the only device-side marker of which bridge
        // instruction a step actually received, so the literal must track the
        // wire value rather than be maintained by hand.
        assert_eq!(TOOL_STEP_WIRE_MODE, LlmResponseMode::ToolStep);
        assert_eq!(
            serde_json::to_value(TOOL_STEP_WIRE_MODE).unwrap(),
            json!(TOOL_STEP_WIRE_MODE_LABEL)
        );
        // The mode this step used to be sent under still exists for its six
        // genuinely tool-free callers; the tool step must not be it.
        assert_ne!(TOOL_STEP_WIRE_MODE, LlmResponseMode::ToolFreeText);
    }

    #[tokio::test]
    async fn tool_step_reaches_the_bridge_under_the_tool_permitting_mode() {
        let observed = Arc::new(Mutex::new(None));
        let handler_observed = Arc::clone(&observed);
        let app = Router::new()
            .route(
                "/challenge",
                get(|Query(query): Query<HashMap<String, String>>| async move {
                    let nonce = query.get("nonce").unwrap();
                    Json(json!({
                        "proof": challenge_proof_for_test(TEST_TOKEN, nonce)
                    }))
                }),
            )
            .route(
                "/chat",
                post(move |Json(body): Json<Value>| {
                    let observed = Arc::clone(&handler_observed);
                    async move {
                        *observed.lock().unwrap() = Some(body);
                        Json(json!({
                            "text": "<tool_call>{\"name\":\"alpha\",\"arguments\":{}}</tool_call>"
                        }))
                    }
                }),
            );
        let (bridge_url, server) = test_server(app).await;

        let backend = CodexBackend {
            http_client: HttpClient::new(),
            bridge_url: bridge_url.clone(),
            endpoint: chat_endpoint(&bridge_url).unwrap(),
            bridge_token: Some(TEST_TOKEN.into()),
            model: "gpt-5.6-sol".into(),
            tool_sessions: Mutex::new(HashMap::new()),
        };
        let step = backend
            .tool_step(crate::llm::tool_step::ToolStepRequest {
                system_prompt: "Base.".into(),
                messages: vec![Message::user("what is the weather")],
                tools: vec![tool_def("alpha", "Do alpha.")],
                timeout: Duration::from_secs(5),
                correlation: "corr-1".into(),
            })
            .await
            .unwrap();
        assert!(matches!(step, ToolStepResult::ToolCalls(ref calls) if calls.len() == 1));

        let body = observed.lock().unwrap().take().unwrap();
        // The step is sent under the one mode whose bridge instruction permits
        // the caller's tools — NOT under `tool_free_text`, whose instruction
        // orders the model not to call any tool.
        assert_eq!(body["responseMode"], TOOL_STEP_WIRE_MODE_LABEL);
        assert_ne!(body["responseMode"], "tool_free_text");
        // The catalog still rides in the system message, unchanged.
        assert_eq!(body["messages"][0]["role"], "system");
        let system = body["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("<tool_call>"));
        assert!(system.contains("- alpha: Do alpha."));
        assert!(body.get("image").is_none());

        server.abort();
    }

    #[tokio::test]
    async fn canonical_turn_reuses_one_bridge_session_and_sends_only_new_results() {
        const SESSION_ID: &str = "223e4567-e89b-42d3-a456-426614174000";
        let challenge_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handler_challenge_count = Arc::clone(&challenge_count);
        let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
        let handler_observed = Arc::clone(&observed);
        let finished = Arc::new(tokio::sync::Notify::new());
        let handler_finished = Arc::clone(&finished);
        let turn_path = format!("/agentic-sessions/{SESSION_ID}/turn");
        let finish_path = format!("/agentic-sessions/{SESSION_ID}");
        let app = Router::new()
            .route(
                "/challenge",
                get(move |Query(query): Query<HashMap<String, String>>| {
                    let count = Arc::clone(&handler_challenge_count);
                    async move {
                        count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let nonce = query.get("nonce").unwrap();
                        Json(json!({
                            "proof": challenge_proof_for_test(TEST_TOKEN, nonce)
                        }))
                    }
                }),
            )
            .route(
                &turn_path,
                post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let observed = Arc::clone(&handler_observed);
                    async move {
                        assert_eq!(
                            headers.get("authorization").unwrap().to_str().unwrap(),
                            format!("Bearer {TEST_TOKEN}")
                        );
                        let mut observed = observed.lock().unwrap();
                        observed.push(body);
                        let text = if observed.len() == 1 {
                            "<tool_call>{\"name\":\"alpha\",\"arguments\":{}}</tool_call>"
                        } else {
                            "Done."
                        };
                        Json(json!({ "text": text }))
                    }
                }),
            )
            .route(
                &finish_path,
                delete(move |headers: HeaderMap| {
                    let finished = Arc::clone(&handler_finished);
                    async move {
                        assert_eq!(
                            headers.get("authorization").unwrap().to_str().unwrap(),
                            format!("Bearer {TEST_TOKEN}")
                        );
                        finished.notify_one();
                        Json(json!({ "finished": true }))
                    }
                }),
            );
        let (bridge_url, server) = test_server(app).await;
        let backend = CodexBackend {
            http_client: HttpClient::new(),
            bridge_url: bridge_url.clone(),
            endpoint: chat_endpoint(&bridge_url).unwrap(),
            bridge_token: Some(TEST_TOKEN.into()),
            model: "gpt-5.6-sol".into(),
            tool_sessions: Mutex::new(HashMap::new()),
        };

        let first = backend
            .tool_step(crate::llm::tool_step::ToolStepRequest {
                system_prompt: "Base.".into(),
                messages: vec![Message::user("check alpha")],
                tools: vec![tool_def("alpha", "Do alpha.")],
                timeout: Duration::from_secs(5),
                correlation: SESSION_ID.into(),
            })
            .await
            .unwrap();
        let call = match first {
            ToolStepResult::ToolCalls(mut calls) => calls.remove(0),
            other => panic!("expected one tool call, got {other:?}"),
        };
        let assistant_call = Message::Assistant {
            id: None,
            content: rig::OneOrMany::one(AssistantContent::tool_call(
                call.call_id.clone(),
                call.name.clone(),
                call.arguments.clone(),
            )),
        };
        let second = backend
            .tool_step(crate::llm::tool_step::ToolStepRequest {
                system_prompt: "Base.".into(),
                messages: vec![
                    Message::user("check alpha"),
                    assistant_call,
                    Message::tool_result(call.call_id, "alpha result"),
                ],
                tools: vec![tool_def("alpha", "Do alpha.")],
                timeout: Duration::from_secs(5),
                correlation: SESSION_ID.into(),
            })
            .await
            .unwrap();
        assert_eq!(second, ToolStepResult::Final("Done.".into()));

        backend.finish_tool_session(SESSION_ID);
        tokio::time::timeout(Duration::from_secs(1), finished.notified())
            .await
            .expect("retained bridge session must be retired");
        assert_eq!(
            challenge_count.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "bridge identity is proved once per retained turn, not once per model step"
        );

        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 2);
        assert_eq!(observed[0]["responseMode"], TOOL_STEP_WIRE_MODE_LABEL);
        assert_eq!(observed[0]["messages"][1]["content"], "check alpha");
        assert_eq!(
            observed[1]["messages"].as_array().unwrap().len(),
            2,
            "continued turn sends stable system text plus one new host result"
        );
        assert_eq!(observed[1]["messages"][0], observed[0]["messages"][0]);
        let delta = observed[1]["messages"][1]["content"].as_str().unwrap();
        assert!(delta.contains("Prior device action result"));
        assert!(delta.contains("alpha result"));
        assert!(!delta.contains("check alpha"));

        server.abort();
    }

    #[test]
    fn assembled_system_text_is_byte_stable() {
        // Pins the exact bytes sent to the model, so any future edit to the
        // tool header or the no-tools notice fails here instead of silently
        // invalidating an outbound byte measurement.
        assert_eq!(
            build_tool_step_system_text("Base.", &[]),
            "Base.\nNo tools are available for this reply. Answer in plain text.\n"
        );
        assert_eq!(
            build_tool_step_system_text("Base.", &[tool_def("alpha", "Do alpha.")]),
            concat!(
                "Base.\n# Tools\nYou may call the following tools. To call one, reply with ONLY ",
                "one or more blocks of the exact form ",
                "<tool_call>{\"name\":\"tool_name\",\"arguments\":{...}}</tool_call> and no other ",
                "text. To answer the user instead, reply with plain text and no tool_call ",
                "block.\n",
                "- alpha: Do alpha. parameters={\"type\":\"object\",\"properties\":{}}\n"
            )
        );
    }

    #[test]
    fn outbound_summary_reports_count_and_empty_branch_for_both_branches() {
        let base = "Base prompt.";

        let empty_system = build_tool_step_system_text(base, &[]);
        let empty = ToolSurfaceSummary::measure(&[], base.len(), &empty_system);
        assert_eq!(empty.tool_count, 0);
        assert!(empty.tools_empty);
        // This is the branch that TELLS the model it has no tools.
        assert_eq!(empty.tool_branch, "none_advertised");
        assert_eq!(empty.tool_names, "");
        assert_eq!(empty.system_bytes, empty_system.len());
        assert_eq!(
            empty.tool_block_bytes,
            "\nNo tools are available for this reply. Answer in plain text.\n".len()
        );

        let tools = vec![
            tool_def("alpha", "Do alpha."),
            tool_def("beta", "Do beta."),
            tool_def("gamma", "Do gamma."),
        ];
        let system = build_tool_step_system_text(base, &tools);
        let full = ToolSurfaceSummary::measure(&tools, base.len(), &system);
        assert_eq!(full.tool_count, 3);
        assert!(!full.tools_empty);
        assert_eq!(full.tool_branch, "catalog");
        assert_eq!(full.tool_names, "alpha,beta,gamma");
        assert_eq!(full.base_prompt_bytes, base.len());
        assert_eq!(full.system_bytes, system.len());
        assert_eq!(full.tool_block_bytes, system.len() - base.len());
        assert!(full.system_bytes > empty.system_bytes);

        // A catalog-sized list, because the live surface is 36-37 tools and the
        // regression this instrumentation exists to detect is a SILENT TRIM.
        // A summary that quietly capped its own count (at 8, say — the inert
        // `dynamic_tool_count` default) would report a healthy-looking number
        // while hiding the very trim the operator is hunting.
        const CATALOG: [&str; 37] = [
            "t00", "t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10", "t11",
            "t12", "t13", "t14", "t15", "t16", "t17", "t18", "t19", "t20", "t21", "t22", "t23",
            "t24", "t25", "t26", "t27", "t28", "t29", "t30", "t31", "t32", "t33", "t34", "t35",
            "t36",
        ];
        let catalog = CATALOG
            .iter()
            .copied()
            .map(|name| tool_def(name, "Do the thing."))
            .collect::<Vec<_>>();
        let catalog_system = build_tool_step_system_text(base, &catalog);
        let measured = ToolSurfaceSummary::measure(&catalog, base.len(), &catalog_system);
        assert_eq!(measured.tool_count, 37);
        assert_eq!(measured.tool_names.split(',').count(), 37);
        assert_eq!(measured.tool_names, CATALOG.join(","));
        assert!(!measured.tools_empty);
        assert_eq!(measured.tool_branch, "catalog");
        // Every advertised tool contributes to the measured block.
        for name in CATALOG {
            assert!(catalog_system.contains(name), "{name} missing from prompt");
        }
    }

    #[test]
    fn tool_digest_tracks_the_advertised_surface() {
        let names = |list: &[&'static str]| {
            list.iter()
                .map(|name| tool_def(name, "d"))
                .collect::<Vec<_>>()
        };
        let digest =
            |list: &[&'static str]| ToolSurfaceSummary::measure(&names(list), 0, "").tool_digest;
        // Same surface, same fingerprint — usable as a grep-level equality check.
        assert_eq!(digest(&["alpha", "beta"]), digest(&["alpha", "beta"]));
        // A dropped tool, or a reordered catalog, changes it.
        assert_ne!(digest(&["alpha", "beta"]), digest(&["alpha"]));
        assert_ne!(digest(&["alpha", "beta"]), digest(&["beta", "alpha"]));
        assert_eq!(digest(&[]).len(), 16);
    }

    #[test]
    fn outbound_summary_never_carries_tool_text() {
        // The description and the parameter schema both embed a secret-shaped
        // string. It genuinely reaches the model (asserted below), so this is a
        // real leak test, not a vacuous one.
        const DESCRIPTION: &str = "Recall a fact. Internal note: sk-live-PRIVATE-USER-SECRET-9f3a";
        assert!(DESCRIPTION.contains(PRIVATE_MARKER));
        let tools = vec![ToolStepDefinition {
            name: "remember_fact",
            description: DESCRIPTION,
            parameters: json!({
                "type": "object",
                "properties": { "fact": { "description": PRIVATE_MARKER } }
            }),
        }];
        let base = "Base prompt with sk-live-PRIVATE-USER-SECRET-9f3a inside.";
        assert!(base.contains(PRIVATE_MARKER));

        let system = build_tool_step_system_text(base, &tools);
        assert!(
            system.contains(PRIVATE_MARKER),
            "fixture must actually carry the secret into the assembled prompt"
        );

        let summary = ToolSurfaceSummary::measure(&tools, base.len(), &system);
        let rendered = format!("{summary:?}");
        assert!(
            !rendered.contains(PRIVATE_MARKER),
            "outbound summary leaked prompt/description/schema text: {rendered}"
        );
        assert!(!rendered.contains("Internal note"));
        assert!(!rendered.contains("properties"));
        assert!(!rendered.contains("Base prompt"));
        // Tool NAMES are deliberately logged: they are public identifiers from
        // the compile-time spec tables and are the whole point of the line.
        assert!(rendered.contains("remember_fact"));
    }

    // ---- instrumentation: inbound recognition ---------------------------

    #[test]
    fn inbound_scan_distinguishes_every_recognition_outcome() {
        // No markup at all: the model simply answered.
        let (step, scan) = parse_tool_step_text_scanned("The sky is blue.");
        assert!(!scan.markup_present);
        assert_eq!((scan.blocks_found, scan.parsed_ok), (0, 0));
        assert_eq!(scan.reason(), "no_markup");
        assert_eq!(
            step_outcome(&step),
            ("final_prose", "The sky is blue.".len())
        );

        // One well-formed block.
        let (step, scan) = parse_tool_step_text_scanned(
            "<tool_call>{\"name\":\"knowledge_lookup\",\"arguments\":{}}</tool_call>",
        );
        assert!(scan.markup_present);
        assert_eq!(
            (scan.open_tags, scan.blocks_found, scan.parsed_ok),
            (1, 1, 1)
        );
        assert_eq!(scan.failed(), 0);
        assert_eq!(scan.reason(), "ok");
        assert_eq!(step_outcome(&step), ("tool_calls", 0));

        // Invalid JSON inside a complete block.
        let (step, scan) = parse_tool_step_text_scanned("<tool_call>{\"name\":\"a\",}</tool_call>");
        assert_eq!(
            (scan.blocks_found, scan.parsed_ok, scan.json_parse),
            (1, 0, 1)
        );
        assert_eq!(scan.reason(), "json_parse");
        assert_eq!(step_outcome(&step), ("final_empty", 0));

        // Valid JSON whose key is not exactly "name".
        for body in [
            "{\"tool_name\":\"knowledge_lookup\"}",
            "{\"function\":{\"name\":\"knowledge_lookup\"}}",
            "{\"name\":123}",
            "[{\"name\":\"knowledge_lookup\"}]",
        ] {
            let (_, scan) = parse_tool_step_text_scanned(&format!("<tool_call>{body}</tool_call>"));
            assert_eq!(
                (scan.blocks_found, scan.parsed_ok, scan.missing_name),
                (1, 0, 1),
                "{body}"
            );
            assert_eq!(scan.reason(), "missing_name", "{body}");
        }

        // Unterminated block: no closing tag anywhere after the open tag.
        let (_, scan) =
            parse_tool_step_text_scanned("Let me check.\n<tool_call>{\"name\":\"knowledge_loo");
        assert_eq!(
            (scan.blocks_found, scan.parsed_ok, scan.unterminated),
            (1, 0, 1)
        );
        assert_eq!(scan.reason(), "unterminated");

        // Mixed batch: one good, one bad.
        let (_, scan) = parse_tool_step_text_scanned(
            "<tool_call>{\"name\":\"a\",\"arguments\":{}}</tool_call><tool_call>nope</tool_call>",
        );
        assert_eq!((scan.parsed_ok, scan.json_parse), (1, 1));
        assert_eq!(scan.reason(), "partial");

        // Several DIFFERENT failures and no success: `reason` is a triage
        // token, so its precedence is pinned here (the per-failure counters in
        // the log line always carry the full picture). Without these two rows
        // the precedence chain could be reordered silently.
        let (_, scan) = parse_tool_step_text_scanned(
            "<tool_call>{\"x\":1}</tool_call><tool_call>nope</tool_call>",
        );
        assert_eq!(
            (scan.parsed_ok, scan.json_parse, scan.missing_name),
            (0, 1, 1)
        );
        assert_eq!(
            scan.reason(),
            "json_parse",
            "json_parse outranks missing_name"
        );
        let (_, scan) =
            parse_tool_step_text_scanned("<tool_call>{\"x\":1}</tool_call><tool_call>{\"y\":2}");
        assert_eq!(
            (scan.parsed_ok, scan.missing_name, scan.unterminated),
            (0, 1, 1)
        );
        assert_eq!(
            scan.reason(),
            "unterminated",
            "unterminated outranks the rest"
        );
    }

    #[test]
    fn inbound_scan_flags_tag_spellings_the_parser_cannot_see() {
        // `<tool_call_result>` — measured on device 2026-07-28.
        let (_, scan) = parse_tool_step_text_scanned(
            "<tool_call_result>Tool call failed: function not found</tool_call_result>",
        );
        assert!(scan.markup_present);
        assert_eq!(
            (scan.open_tags, scan.blocks_found, scan.foreign_tag),
            (0, 0, 1)
        );
        assert_eq!(scan.reason(), "foreign_tag");

        // An attribute on the open tag: a WELL-FORMED call the parser never
        // sees, because it scans for the literal `<tool_call>` while the
        // stripper matches the tag family. Behaviour preserved; now visible.
        let (step, scan) = parse_tool_step_text_scanned(
            "<tool_call id=\"1\">{\"name\":\"knowledge_lookup\",\"arguments\":{}}</tool_call>",
        );
        assert_eq!(
            (scan.open_tags, scan.blocks_found, scan.parsed_ok),
            (0, 0, 0)
        );
        assert_eq!(scan.foreign_tag, 1);
        assert_eq!(scan.reason(), "foreign_tag");
        assert_eq!(step_outcome(&step), ("final_empty", 0));
    }

    #[test]
    fn inbound_scan_exposes_the_unterminated_block_swallowing_later_calls() {
        // KNOWN BUG, deliberately NOT fixed: the first block has no closing tag
        // of its own, so it consumes the second block's open tag into its body.
        // The combined body fails to parse and the well-formed second call is
        // destroyed. `open_tags` (2) exceeding `blocks_found` (1) is the
        // signature that proves it fired on device.
        let (step, scan) = parse_tool_step_text_scanned(
            "<tool_call>{\"name\":\"a\",\"arguments\":{}}\n<tool_call>{\"name\":\"b\",\"arguments\":{}}</tool_call>",
        );
        assert_eq!(scan.open_tags, 2);
        assert_eq!(scan.blocks_found, 1);
        assert_eq!(scan.parsed_ok, 0);
        assert_eq!(scan.json_parse, 1);
        assert!(scan.open_tags > scan.blocks_found);
        assert_eq!(step_outcome(&step), ("final_empty", 0));
    }

    #[test]
    fn inbound_scan_block_counters_account_for_every_entered_block() {
        // Invariant: the parser cannot leave a block uncounted or double-count
        // one. If a future edit adds a branch without a counter, this goes red.
        for text in [
            "plain answer",
            "<tool_call>{\"name\":\"a\"}</tool_call>",
            "<tool_call>bad</tool_call><tool_call>{\"x\":1}</tool_call><tool_call>{\"name\":\"c\"}</tool_call>",
            "prose <tool_call>{\"name\":\"a\"}</tool_call> more <tool_call>oops",
            "<tool_call_result>noise</tool_call_result>",
        ] {
            let (_, scan) = parse_tool_step_text_scanned(text);
            assert_eq!(scan.blocks_found, scan.parsed_ok + scan.failed(), "{text}");
        }
    }

    #[test]
    fn inbound_scan_never_carries_reply_text() {
        // The reply embeds a secret in a tool argument AND in the prose.
        let reply = concat!(
            "Saving that. sk-live-PRIVATE-USER-SECRET-9f3a ",
            "<tool_call>{\"name\":\"remember_fact\",",
            "\"arguments\":{\"fact\":\"sk-live-PRIVATE-USER-SECRET-9f3a\"}}</tool_call>"
        );
        assert!(reply.contains(PRIVATE_MARKER));

        let (step, scan) = parse_tool_step_text_scanned(reply);
        assert_eq!(scan.parsed_ok, 1);

        let rendered = format!("{scan:?}");
        assert!(
            !rendered.contains(PRIVATE_MARKER),
            "inbound scan leaked reply text or tool arguments: {rendered}"
        );
        assert!(!rendered.contains("remember_fact"));
        assert!(!rendered.contains("Saving that"));

        // The outcome label is a closed set and carries no text either.
        let (outcome, spoken_bytes) = step_outcome(&step);
        assert_eq!((outcome, spoken_bytes), ("tool_calls", 0));
        assert!(!outcome.contains(PRIVATE_MARKER));

        // Same for a final answer that happens to contain the secret: only its
        // LENGTH is reportable.
        let (step, _) = parse_tool_step_text_scanned(PRIVATE_MARKER);
        let (outcome, spoken_bytes) = step_outcome(&step);
        assert_eq!(outcome, "final_prose");
        assert_eq!(spoken_bytes, PRIVATE_MARKER.len());
    }

    #[test]
    fn parser_decisions_are_pinned_beside_their_scan_reason() {
        // BEHAVIOUR PIN. The instrumentation must not move a single
        // accept/reject line, or the operator's before/after comparison
        // silently changes meaning. Each row asserts the parse OUTCOME the
        // loop receives next to the reason code the log will carry, so a
        // counter can never drift away from the decision it describes.
        struct Case {
            text: &'static str,
            /// Names accepted, in order. Empty = the turn became a final answer.
            calls: &'static [&'static str],
            /// Exact spoken text when the turn became a final answer.
            spoken: &'static str,
            outcome: &'static str,
            reason: &'static str,
        }
        let cases = [
            Case {
                text: "The sky is blue.",
                calls: &[],
                spoken: "The sky is blue.",
                outcome: "final_prose",
                reason: "no_markup",
            },
            Case {
                text: "<tool_call>{\"name\":\"a\",\"arguments\":{}}</tool_call>",
                calls: &["a"],
                spoken: "",
                outcome: "tool_calls",
                reason: "ok",
            },
            Case {
                text: "Here you go. <tool_call>not json</tool_call> Done.",
                calls: &[],
                spoken: "Here you go.  Done.",
                outcome: "final_prose",
                reason: "json_parse",
            },
            Case {
                text: "<tool_call>{\"oops\":true}</tool_call>",
                calls: &[],
                spoken: "",
                outcome: "final_empty",
                reason: "missing_name",
            },
            // The near-miss key shapes. These are REJECTED today; each row is
            // the boundary a "helpful" parser relaxation would cross, which is
            // exactly the behaviour change that would invalidate the
            // operator's before/after comparison.
            Case {
                text: "<tool_call>{\"tool_name\":\"a\",\"arguments\":{}}</tool_call>",
                calls: &[],
                spoken: "",
                outcome: "final_empty",
                reason: "missing_name",
            },
            Case {
                text:
                    "<tool_call>{\"type\":\"function\",\"function\":{\"name\":\"a\"}}</tool_call>",
                calls: &[],
                spoken: "",
                outcome: "final_empty",
                reason: "missing_name",
            },
            Case {
                text: "<tool_call>[{\"name\":\"a\"}]</tool_call>",
                calls: &[],
                spoken: "",
                outcome: "final_empty",
                reason: "missing_name",
            },
            Case {
                text: "Let me check.\n<tool_call>{\"name\":\"knowledge_loo",
                calls: &[],
                spoken: "Let me check.",
                outcome: "final_prose",
                reason: "unterminated",
            },
            Case {
                text: "<tool_call_result>noise</tool_call_result>",
                calls: &[],
                spoken: "",
                outcome: "final_empty",
                reason: "foreign_tag",
            },
            Case {
                text: "<tool_call id=\"1\">{\"name\":\"a\"}</tool_call> Fine.",
                calls: &[],
                spoken: "Fine.",
                outcome: "final_prose",
                reason: "foreign_tag",
            },
            Case {
                text: "<tool_call>{\"name\":\"a\",\"arguments\":{}}</tool_call>\
                       <tool_call>nope</tool_call>\
                       <tool_call>{\"name\":\"b\"}</tool_call>",
                calls: &["a", "b"],
                spoken: "",
                outcome: "tool_calls",
                reason: "partial",
            },
            Case {
                text: "",
                calls: &[],
                spoken: "",
                outcome: "final_empty",
                reason: "no_markup",
            },
        ];
        for case in cases {
            let (step, scan) = parse_tool_step_text_scanned(case.text);
            assert_eq!(scan.reason(), case.reason, "reason for {:?}", case.text);
            assert_eq!(
                step_outcome(&step).0,
                case.outcome,
                "outcome for {:?}",
                case.text
            );
            match &step {
                ToolStepResult::Final(text) => {
                    assert!(case.calls.is_empty(), "expected calls for {:?}", case.text);
                    assert_eq!(text, case.spoken, "spoken text for {:?}", case.text);
                }
                ToolStepResult::ToolCalls(calls) => {
                    assert_eq!(
                        calls
                            .iter()
                            .map(|call| call.name.as_str())
                            .collect::<Vec<_>>(),
                        case.calls,
                        "accepted calls for {:?}",
                        case.text
                    );
                }
            }
        }
    }

    #[test]
    fn tool_step_text_parses_tool_call_blocks_and_plain_answers() {
        use crate::llm::tool_step::ToolStepResult;
        // Plain text = final answer.
        assert_eq!(
            parse_tool_step_text("The sky is blue because of Rayleigh scattering."),
            ToolStepResult::Final("The sky is blue because of Rayleigh scattering.".to_string())
        );
        // One block with surrounding prose still parses as a tool call.
        let step = parse_tool_step_text(
            "Let me check.\n<tool_call>{\"name\":\"knowledge_lookup\",\"arguments\":{\"query\":\"Denmark\"}}</tool_call>",
        );
        match step {
            ToolStepResult::ToolCalls(calls) => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "knowledge_lookup");
                assert_eq!(calls[0].arguments["query"], "Denmark");
                // The exact value is not part of the contract — uniqueness is.
                assert!(calls[0].call_id.starts_with("call-"));
            }
            other => panic!("expected tool calls, got {other:?}"),
        }
        // Two blocks become a batch in order; malformed JSON blocks are skipped.
        let step = parse_tool_step_text(
            "<tool_call>{\"name\":\"a\",\"arguments\":{}}</tool_call>\
             <tool_call>not json</tool_call>\
             <tool_call>{\"name\":\"b\"}</tool_call>",
        );
        match step {
            ToolStepResult::ToolCalls(calls) => {
                assert_eq!(
                    calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                    vec!["a", "b"]
                );
            }
            other => panic!("expected tool calls, got {other:?}"),
        }
    }
}
