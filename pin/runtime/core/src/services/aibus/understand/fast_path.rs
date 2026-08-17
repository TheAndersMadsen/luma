//! Fast local answers: actions whose intent and arguments are already bounded
//! by stock-compatible parsers or verified current-player state. This path is
//! deliberately separate from `run_text_cascade` — ordering, eligibility,
//! storage, fallback, location, and terminal behavior are locked by tests.

use super::*;

impl UnderstandHandler {
    /// Run actions whose intent and arguments are already bounded by stock-
    /// compatible parsers or verified current-player state. Exact standalone
    /// weather prompts also stay on the audited stock location/provider path;
    /// arbitrary or compound weather requests still reach the dynamic loop.
    /// Device controls and the first stock weather preflight therefore do not
    /// wait behind a remote semantic turn.
    pub(super) async fn run_local_text_fast_path(
        &self,
        req: &SynapseUnderstandingRequest,
        run_id: &str,
        utterance: &str,
        response_parent: &str,
        is_vision: bool,
    ) -> Result<Option<UnderstandingStream>, Status> {
        // The outer utterance is correlation evidence, not mutation
        // authority. Only a unique current stock user root with a complete,
        // parent-linked action/observation chain may enter local planning.
        if trusted_authorizing_user_id(req).is_none() {
            return Ok(None);
        }

        if non_authoritative_intent_reason(utterance).is_some() {
            return Ok(None);
        }

        // "What can you do" — answered from the catalog, not improvised.
        //
        // Roadmap item 9a: this is the most common intent in the captured carry
        // corpus (3 of 17 distinct utterances) and carry routed every one to its
        // own capability lookup. Left to the model, the answer is wrong by
        // construction — it does not know which native actions this server
        // exposes, so it can promise the wearer something the Pin will refuse.
        //
        // The matcher is anchored to the END of the utterance, so a topic-scoped
        // question ("what can you do in terms of fitness") falls through to the
        // model rather than collecting a generic list. That is the same trap
        // `GetCurrentTime` avoids for "what time is it in Tokyo".
        //
        // The whole decision — is this a general capability question, may this
        // turn speak, what should it say — lives in `capability_response_for`.
        // Deliberately: this function needs a full service instance to drive, so
        // logic written here cannot be reached by a unit test. The `Respond`
        // exclusion check was originally written at this call site and no test
        // could see it, which is exactly how a request that had disabled spoken
        // turns would still have been answered aloud.
        {
            if let Some(answer) = crate::synapse::capability_answer::capability_response_for(req) {
                info!("<<< Returning grounded capability answer");
                self.spawn_save_local_activity(run_id, utterance, is_vision, &answer);
                let response = SynapseUnderstandingResponse::action_response(
                    native_actions::RESPOND,
                    "I should say what this device can actually do",
                    &serde_json::json!({ "Response": answer }).to_string(),
                    response_parent,
                );
                return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
            }
            // No dispatchable capability: say nothing here rather than claim
            // something. The model path still gets its turn.
        }

        if let (Some(planned), Some(function_execution)) =
            (plan_note(req), self.function_execution.as_ref())
        {
            let response_text = match function_execution
                .execute_call(note_function_call(req, planned.text))
                .await
            {
                Ok(response) => response.response,
                Err(status) => {
                    warn!(
                        code = ?status.code(),
                        "natural note creation failed without logging note content"
                    );
                    SPOKEN_NOTE_SAVE_FAILED.to_string()
                }
            };
            self.spawn_save_local_activity(run_id, utterance, is_vision, &response_text);
            let response = SynapseUnderstandingResponse::action_response(
                native_actions::RESPOND,
                "I should report the result of the requested local note creation",
                &serde_json::json!({"Response": response_text}).to_string(),
                response_parent,
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        if let Some(planned) = plan_message_action(req) {
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                planned.thought,
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        if let Some(planned) = plan_communications_action(req) {
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                planned.thought,
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        if let Some(planned) = plan_translation_action(req) {
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                planned.thought,
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        if let Some(planned) = plan_nutrition_action(req, true) {
            let Some(food_permit) = self.food_runtime_permit() else {
                return Ok(Some(food_runtime_unavailable_stream(req, response_parent)));
            };
            if !self.food_runtime_permit_is_current(food_permit) {
                return Ok(Some(food_runtime_unavailable_stream(req, response_parent)));
            }
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                planned.thought,
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        let recent_track = if requires_recent_track_context(req) {
            match self
                .db
                .recent_music_context(MUSIC_CONTEXT_TTL.as_secs())
                .await
            {
                Ok(track) => track,
                Err(error) => {
                    warn!(error = %error, "failed to read recent music context");
                    None
                }
            }
        } else {
            None
        };
        if let Some(planned) = plan_local_music_action(req, recent_track.as_ref()) {
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                planned.thought,
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        // Deterministic catalog/contextual music stays ahead of model
        // planning (product contract: local-first). This is the same planner
        // the cascade fallback uses; running it here means an exact "play the
        // top song by <artist>"-style request never pays a model round trip.
        if crate::synapse::capabilities::music::matches_direct_top_grammar(&req.utterance) {
            info!("deterministic direct-top music grammar matched in local fast path");
        }
        if let Some(planned) = plan_catalog_or_contextual_music_action(req, recent_track.as_ref()) {
            info!(
                action = planned.action_name,
                "<<< Returning stock catalog/contextual music action (local fast path)"
            );
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                planned.thought,
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        // The stock AI-DJ playlist, same local-first rule as the catalog planner
        // above. This planner previously existed ONLY in the post-agentic
        // cascade, which is reached only when the agentic runtime is
        // unavailable — so in normal operation GenerateMusicPlaylist was
        // unreachable and "play me a playlist of X" produced a spoken reply or a
        // single arbitrary track instead of the stock queue. It is safe ahead of
        // the model because it is narrow: it rejects questions and compound
        // commands and requires an explicitly extracted, validated topic.
        if let Some(planned) = plan_generated_playlist_action(req) {
            info!(
                action = planned.action_name,
                "<<< Returning stock generated-playlist action (local fast path)"
            );
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                planned.thought,
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        if let Some(planned) = plan_clock_family_action(req) {
            let response = SynapseUnderstandingResponse::action_response(
                planned.action_name,
                "I should enter the stock clock experience with the exact bounded request",
                &planned.input_json,
                response_parent,
            );
            self.spawn_save_local_activity(
                run_id,
                utterance,
                is_vision,
                &action_activity_outcome(planned.action_name, &planned.input_json),
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        // The deterministic weather cascade owns the exact stock
        // GetCurrentLocation marker, its parent-bound continuation, and the
        // privacy-minimal current_location -> reverse_geocode ->
        // current_weather -> terminal proof. Enter it before the general
        // model only for a complete bounded weather prompt. Compound requests
        // (for example, resolving a place and then checking weather there)
        // are intentionally not recognized here and remain agentic.
        if plan_weather_prompt_with_context(req).is_some() {
            return self
                .run_text_cascade(req, run_id, utterance, response_parent, is_vision)
                .await;
        }

        let native_action_features = self.live_native_action_features().await;
        if let Some(planned) = plan_native_device_action_with_features(req, native_action_features)
        {
            // Current location is a semantic read input, not a terminal local
            // answer. Let the generic loop decide whether to reverse-geocode,
            // check weather, search nearby, calculate a route, or simply stop.
            if planned.action_name != native_actions::GET_CURRENT_LOCATION {
                let response = SynapseUnderstandingResponse::action_response(
                    planned.action_name,
                    planned.thought,
                    &planned.input_json,
                    response_parent,
                );
                if !self.note_session_reset_if_clear(planned.action_name, run_id, utterance) {
                    self.spawn_save_local_activity(
                        run_id,
                        utterance,
                        is_vision,
                        &action_activity_outcome(planned.action_name, &planned.input_json),
                    );
                }
                return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
            }
        }

        Ok(None)
    }
}
