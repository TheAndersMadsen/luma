mod agent;
pub(crate) mod backend;
mod codex_app_server;
pub(crate) mod codex_bridge;
mod codex_connect_proxy;
mod error;
pub(crate) mod local_codex_bridge;
pub mod memory;
mod prompt;
mod providers;
pub(crate) mod request;
mod request_log;
mod rig_backend;
pub(crate) mod tool_step;
pub mod tools;

pub use agent::LlmAgent;
pub(crate) use codex_app_server::{
    CodexProviderConfig, CLEANUP_REQUEST_TIMEOUT as CODEX_INTERRUPT_CLEANUP_TIMEOUT,
    INTERACTIVE_CHAT_TIMEOUT as CODEX_INTERACTIVE_CHAT_TIMEOUT,
    TURN_SETUP_TIMEOUT as CODEX_THREAD_START_TIMEOUT,
};
pub(crate) use codex_bridge::BRIDGE_IDENTITY_CHALLENGE_TIMEOUT as CODEX_BRIDGE_IDENTITY_TIMEOUT;
pub(crate) use error::{friendly_error_message, WEARER_FACING_ERRORS};
pub use prompt::validate_prompt_template;
pub use request::{LlmChatRequest, PromptTemplateContext, PromptTemplates};
pub use request_log::LlmRequestLogger;

/// Result of an LLM user Understand request
#[derive(Debug, Clone)]
pub enum ChatResult {
    Text(String),
    /// The `understand_scene` tool was invoked; the server awaits a follow up request containing a new camera image
    DeferredVision,
}
