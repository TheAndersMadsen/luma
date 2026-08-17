//! Stock: ironman/sources/humaneinternal/system/intent/interpreters/SynapseInterpreter.java

use tonic::metadata::MetadataMap;

pub mod actions;
pub mod authority;
pub mod capabilities;
pub mod capability_answer;
pub mod catalog;
pub mod chat_turn_loop;
pub mod conversation;
pub mod image_store;
pub mod intent_authority;
pub mod native_device_actions;
pub mod vision;

/// Read the `x-ai-mic-run-id` gRPC header, which identifies each conversation execution
pub fn extract_run_id(metadata: &MetadataMap) -> String {
    metadata
        .get("x-ai-mic-run-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string()
}
