use std::future::Future;
use std::pin::Pin;

use crate::llm::ChatResult;

use super::request::LlmChatRequest;
use super::tool_step::{ToolStepRequest, ToolStepResult};

pub type LlmFuture<'a> = Pin<Box<dyn Future<Output = Result<ChatResult, String>> + Send + 'a>>;
pub type ToolStepFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ToolStepResult, String>> + Send + 'a>>;

/// Object-safe application boundary around provider-specific LLM clients.
///
/// Rig's `Prompt` and `Chat` traits are not object-safe, so provider wrappers
/// implement this trait and keep Rig's concrete types hidden behind dynamic
/// dispatch at the app boundary.
pub trait LlmBackend: Send + Sync {
    fn chat<'a>(&'a self, request: LlmChatRequest) -> LlmFuture<'a>;

    /// One chat-turn-style native tool-calling step: full transcript plus a tool
    /// catalog in, assistant text or one tool-call batch out. Backends without
    /// an implementation fail closed so the caller can surface a clear
    /// configuration error instead of silently degrading the loop.
    fn tool_step<'a>(&'a self, _request: ToolStepRequest) -> ToolStepFuture<'a> {
        Box::pin(async {
            Err("the configured model backend does not support the tool-step loop".to_string())
        })
    }

    /// Finish any provider-side state retained for one tool-loop correlation.
    ///
    /// Most providers are stateless and need no cleanup. A backend that keeps
    /// a remote model thread implements this as a non-blocking, idempotent
    /// retirement request so terminal delivery is never held behind cleanup.
    /// The chat-turn loop calls it on success, error, timeout, and cancellation.
    fn finish_tool_session(&self, _correlation: &str) {}
}
