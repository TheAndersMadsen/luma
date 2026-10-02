//! Turn-frame construction: the action and observation `SynapseChatTurn` nodes
//! and the server-minted timestamp both transports stamp them with.

use cosmos_protocol::aibus as pb;

use super::super::llm::ToolCall;

/// The server's wall clock as a protobuf timestamp, or `None` before the epoch.
pub(crate) fn now_ts() -> Option<prost_types::Timestamp> {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| prost_types::Timestamp {
            seconds: d.as_secs() as i64,
            nanos: d.subsec_nanos() as i32,
        })
}

/// An assistant action turn, parent-chained.
pub(crate) fn action_turn(
    tc: &ToolCall,
    thought: &str,
    parent: String,
    id: String,
    src: pb::SynapseSource,
) -> pb::SynapseChatTurn {
    pb::SynapseChatTurn {
        user: pb::SynapseUser::Assistant as i32,
        timestamp: now_ts(),
        identifier: id,
        parent_identifier: parent,
        content: Some(pb::synapse_chat_turn::Content::Action(
            pb::SynapseActionContent {
                thought: thought.to_owned(),
                action: tc.name.clone(),
                input: tc.arguments.clone(),
                device_payload: Vec::new(),
                source: src as i32,
            },
        )),
    }
}

/// A system observation turn, chained to its action node (`parent = action id`).
/// `is_final` stays false: in contain the run's *final* observation is produced by
/// the device after it executes the terminal action, not by the server.
pub(crate) fn observation_turn(
    action_name: &str,
    observation: &str,
    action_id: String,
    id: String,
    src: pb::SynapseSource,
) -> pb::SynapseChatTurn {
    pb::SynapseChatTurn {
        user: pb::SynapseUser::System as i32,
        timestamp: now_ts(),
        identifier: id,
        parent_identifier: action_id,
        content: Some(pb::synapse_chat_turn::Content::Observation(
            pb::SynapseObservationContent {
                observation: observation.to_owned(),
                is_final: false,
                action_name: action_name.to_owned(),
                source: src as i32,
            },
        )),
    }
}
