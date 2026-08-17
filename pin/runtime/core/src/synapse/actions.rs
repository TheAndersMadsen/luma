use uuid::Uuid;

use crate::proto::aibus::*;

impl SynapseUnderstandingResponse {
    pub fn action_response(
        action_name: &str,
        thought: &str,
        input_json: &str,
        parent_id: &str,
    ) -> Self {
        let turn_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now();

        let action = SynapseActionContent {
            thought: thought.into(),
            action: action_name.into(),
            input: input_json.into(),
            device_payload: Vec::new(),
            source: SynapseSource::Server as i32,
        };

        let turn = SynapseChatTurn {
            user: SynapseUser::Assistant as i32,
            timestamp: Some(prost_types::Timestamp {
                seconds: now.timestamp(),
                nanos: now.timestamp_subsec_nanos() as i32,
            }),
            identifier: turn_id,
            parent_identifier: parent_id.into(),
            content: Some(synapse_chat_turn::Content::Action(action)),
        };

        Self {
            response: String::new(),
            is_final: false,
            body: Some(synapse_understanding_response::Body::Turn(turn)),
        }
    }
}

#[cfg(test)]
impl SynapseUnderstandingResponse {
    /// A parent-linked server OBSERVATION turn, paired with
    /// [`Self::action_response`] to reproduce the stock cloud's mid-run wire
    /// shape (server action -> server observation -> ... -> final Respond).
    /// The legacy client records every non-final turn
    /// (`processLegacySupervisorOnlyChatTurns` -> `onRecordObservation`) and
    /// speaks a progress cue for each non-catalog interim action. Observation
    /// text stays a closed status JSON because these turns re-enter device
    /// history.
    pub fn observation_response(
        action_name: &str,
        observation_json: &str,
        parent_id: &str,
    ) -> Self {
        let now = chrono::Utc::now();
        let observation = SynapseObservationContent {
            observation: observation_json.into(),
            is_final: false,
            action_name: action_name.into(),
            source: SynapseSource::Server as i32,
        };
        let turn = SynapseChatTurn {
            user: SynapseUser::Assistant as i32,
            timestamp: Some(prost_types::Timestamp {
                seconds: now.timestamp(),
                nanos: now.timestamp_subsec_nanos() as i32,
            }),
            identifier: Uuid::new_v4().to_string(),
            parent_identifier: parent_id.into(),
            content: Some(synapse_chat_turn::Content::Observation(observation)),
        };
        Self {
            response: String::new(),
            is_final: false,
            body: Some(synapse_understanding_response::Body::Turn(turn)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tier_a::native_actions;

    #[test]
    fn observation_response_is_a_parent_linked_server_observation() {
        let response = SynapseUnderstandingResponse::observation_response(
            "knowledge_lookup",
            r#"{"status":"ok"}"#,
            "action-turn-id",
        );
        assert!(!response.is_final);
        let synapse_understanding_response::Body::Turn(turn) = response.body.unwrap() else {
            panic!("expected observation turn");
        };
        assert_eq!(turn.parent_identifier, "action-turn-id");
        let Some(synapse_chat_turn::Content::Observation(observation)) = turn.content else {
            panic!("expected observation content");
        };
        assert_eq!(observation.action_name, "knowledge_lookup");
        assert_eq!(observation.source(), SynapseSource::Server);
        assert!(!observation.is_final);
    }

    #[test]
    fn action_response_is_a_parent_linked_stock_server_turn() {
        let before = chrono::Utc::now().timestamp();
        let response = SynapseUnderstandingResponse::action_response(
            native_actions::COMPOSE_MESSAGE,
            "compose",
            r#"{"To":["Alice"],"Message":"Hello"}"#,
            "user-turn",
        );
        let after = chrono::Utc::now().timestamp();

        assert!(!response.is_final);
        let synapse_understanding_response::Body::Turn(turn) = response.body.unwrap() else {
            panic!("expected action turn");
        };
        assert_eq!(turn.user(), SynapseUser::Assistant);
        assert_eq!(turn.parent_identifier, "user-turn");
        assert!(Uuid::parse_str(&turn.identifier).is_ok());
        let timestamp = turn.timestamp.expect("server timestamp");
        assert!((before..=after).contains(&timestamp.seconds));

        let synapse_chat_turn::Content::Action(action) = turn.content.unwrap() else {
            panic!("expected action content");
        };
        assert_eq!(action.action, native_actions::COMPOSE_MESSAGE);
        assert_eq!(action.input, r#"{"To":["Alice"],"Message":"Hello"}"#);
        assert_eq!(action.source(), SynapseSource::Server);
        assert!(action.device_payload.is_empty());
    }
}
