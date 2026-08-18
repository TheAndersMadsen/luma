//! The clone's assistant orchestration engine — a from-scratch recreation of
//! cosmos's serverside `Understand` ReAct loop (protocol/logic parity), driving
//! **our own** model + prompts + tool catalog. See `engine.rs`.
//!
// Future-facing engine API (tool-set versioning, mock helpers) is partially used.
#![allow(dead_code)]

pub mod bidi;
pub mod catalog;
pub mod catalog_generated;
pub mod engine;
pub mod llm;
pub mod prompts;
pub mod toolsets;
pub mod turn;

use std::sync::Arc;

use engine::Engine;
use llm::{ChatModel, DEFAULT_LLM_MODEL, DemoChatModel, OpenAiChatModel, configured_api_key};

/// Build the assistant engine, selecting the model from the environment:
/// an OpenAI-compatible endpoint when `COSMOS_LLM_BASE_URL` + `COSMOS_LLM_API_KEY`
/// are set (`COSMOS_LLM_MODEL` optional), otherwise a deterministic keyless model
/// so `Understand` still streams a well-formed turn with no external LLM.
pub fn build_engine() -> Arc<Engine> {
    let base = std::env::var("COSMOS_LLM_BASE_URL").unwrap_or_default();
    let key = configured_api_key();
    let model: Arc<dyn ChatModel> =
        if let (false, Some(api_key)) = (base.trim().is_empty(), key.clone()) {
            let name =
                std::env::var("COSMOS_LLM_MODEL").unwrap_or_else(|_| DEFAULT_LLM_MODEL.to_owned());
            Arc::new(OpenAiChatModel::new(base, api_key, name))
        } else {
            // No model configured: a stateless demo model runs one honest loop (tool
            // call -> observation -> answer) so the full ReAct machinery is exercised
            // end-to-end on the wire, identically on every request and without
            // inventing facts.
            Arc::new(DemoChatModel)
        };
    Arc::new(Engine::new(model))
}
