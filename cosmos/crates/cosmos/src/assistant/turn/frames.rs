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
/// `is_final` stays false: in carry the run's *final* observation is produced by
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_action_turn_carries_the_call_the_chain_and_the_source() {
        let tc = ToolCall {
            name: "Weather".to_owned(),
            arguments: "{\"q\":\"here\"}".to_owned(),
        };
        let turn = action_turn(
            &tc,
            "checking",
            "parent-1".to_owned(),
            "node-2".to_owned(),
            pb::SynapseSource::Server,
        );
        assert_eq!(turn.user, pb::SynapseUser::Assistant as i32);
        assert_eq!(turn.identifier, "node-2");
        assert_eq!(turn.parent_identifier, "parent-1");
        assert!(turn.timestamp.is_some());
        match turn.content {
            Some(pb::synapse_chat_turn::Content::Action(a)) => {
                assert_eq!(a.action, "Weather");
                assert_eq!(a.input, "{\"q\":\"here\"}");
                assert_eq!(a.thought, "checking");
                assert_eq!(a.source, pb::SynapseSource::Server as i32);
                assert!(a.device_payload.is_empty());
            }
            other => panic!("expected an action content, got {other:?}"),
        }
    }

    #[test]
    fn an_observation_turn_chains_to_its_action_and_is_never_final() {
        let turn = observation_turn(
            "Weather",
            "12 degrees",
            "action-1".to_owned(),
            "node-3".to_owned(),
            pb::SynapseSource::Server,
        );
        assert_eq!(turn.user, pb::SynapseUser::System as i32);
        assert_eq!(turn.parent_identifier, "action-1");
        match turn.content {
            Some(pb::synapse_chat_turn::Content::Observation(o)) => {
                assert_eq!(o.action_name, "Weather");
                assert_eq!(o.observation, "12 degrees");
                assert!(!o.is_final, "the device produces the final observation");
            }
            other => panic!("expected an observation content, got {other:?}"),
        }
    }
}
