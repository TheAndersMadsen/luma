//! The clone's assistant orchestration engine, a from-scratch recreation of
//! cosmos's serverside `Understand` ReAct loop (protocol/logic parity), driving
//! **our own** model + prompts + tool catalog. See `engine.rs`.
//!

pub mod bidi;
pub mod catalog;
// Generated: the recovered interface is emitted whole, including parts only
// the generator's own consumers read.
#[allow(dead_code)]
pub mod catalog_generated;
pub mod codex_app_server;
pub mod engine;
pub mod intents;
pub mod llm;
pub mod policy;
pub mod prompts;
pub mod runtime;
pub mod toolsets;
pub mod turn;
pub mod vision;

use std::sync::Arc;

use engine::Engine;
use llm::ConfiguredChatModel;

/// Build the assistant engine around Cosmos's live provider selector. Center
/// updates are read on the next model step, while an unconfigured server keeps
/// the deterministic keyless response used by local development.
pub fn build_engine() -> Arc<Engine> {
    Arc::new(Engine::new(Arc::new(ConfiguredChatModel::assistant())))
}
