use crate::proto::aibus::*;

/// Check if the current Understand request is a vision request.
pub fn is_vision_request(ctx: &SynapseDeviceContext) -> bool {
    for turn in ctx.turns.iter().rev() {
        if let Some(synapse_chat_turn::Content::UserRequest(req)) = &turn.content {
            return req.vision_requested
                == synapse_user_request_content::VisionRequested::Vision as i32;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_request(
        vision_requested: synapse_user_request_content::VisionRequested,
    ) -> SynapseChatTurn {
        SynapseChatTurn {
            content: Some(synapse_chat_turn::Content::UserRequest(
                SynapseUserRequestContent {
                    vision_requested: vision_requested as i32,
                    ..Default::default()
                },
            )),
            ..Default::default()
        }
    }

    #[test]
    fn only_the_latest_user_request_controls_the_no_image_vision_preflight() {
        let historical_vision = SynapseDeviceContext {
            turns: vec![
                user_request(synapse_user_request_content::VisionRequested::Vision),
                user_request(synapse_user_request_content::VisionRequested::NoVision),
            ],
            ..Default::default()
        };
        assert!(!is_vision_request(&historical_vision));

        let current_vision = SynapseDeviceContext {
            turns: vec![
                user_request(synapse_user_request_content::VisionRequested::NoVision),
                user_request(synapse_user_request_content::VisionRequested::Vision),
            ],
            ..Default::default()
        };
        assert!(is_vision_request(&current_vision));
    }
}
