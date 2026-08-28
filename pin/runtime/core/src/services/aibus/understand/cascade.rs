//! The deterministic/provider-backed text planner cascade, run in the same
//! order for ordinary speech and verified visual automation. Deliberately
//! separate from `run_local_text_fast_path`.

use super::*;

impl UnderstandHandler {
    /// Run every deterministic/provider-backed text planner in the same order
    /// for both ordinary speech and a verified visual automation `Then`
    /// utterance. The caller owns the response parent and provenance so a
    /// visual action remains linked to the exact device observation that
    /// authorized it.
    pub(super) async fn run_text_cascade(
        &self,
        req: &SynapseUnderstandingRequest,
        run_id: &str,
        utterance: &str,
        response_parent: &str,
        is_vision: bool,
    ) -> Result<Option<UnderstandingStream>, Status> {
        // Ordinary fallback routing has the same authority boundary as the
        // pre-agentic fast path. Visual automation reaches this method only
        // after its separately staged, parent-linked observation is consumed.
        if !is_vision && trusted_authorizing_user_id(req).is_none() {
            return Ok(None);
        }

        if let Some(reason) = non_authoritative_intent_reason(utterance) {
            info!(
                ?reason,
                "<<< Mention-only utterance skipped deterministic and provider cascade"
            );
            return Ok(None);
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
            info!("<<< Returning local note result through stock Respond action");
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
            info!(
                action = planned.action_name,
                "<<< Returning stock messaging action"
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

        if let Some(planned) = plan_communications_action(req) {
            info!(
                action = planned.action_name,
                "<<< Returning stock communications action"
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

        if let Some(planned) = plan_translation_action(req) {
            info!(
                action = planned.action_name,
                "<<< Returning stock one-off translation action"
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

        if let Some(planned) = plan_nutrition_action(req, true) {
            let Some(food_permit) = self.food_runtime_permit() else {
                return Ok(Some(food_runtime_unavailable_stream(req, response_parent)));
            };
            if !self.food_runtime_permit_is_current(food_permit) {
                return Ok(Some(food_runtime_unavailable_stream(req, response_parent)));
            }
            info!(
                action = planned.action_name,
                "<<< Returning stock nutrition-agent action"
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

        // Exact deterministic stock music actions above remain the fast path.
        // The constrained semantic classifier owns otherwise-unhandled music
        // paraphrases. Its narrow output can preserve stock PlayMusic while Rust
        // proves every selector against this utterance or verified recent-player
        // metadata.
        //
        // REACHABILITY: this whole cascade runs ONLY when
        // `run_agentic_orchestration` returned None (the generic runtime was
        // unavailable before its first model step). It is NOT reached "even when
        // the general agentic contract is available" — an earlier comment here
        // claimed that and was wrong. In normal operation chat-turn handles these
        // paraphrases via music_catalog_search + play_music, so this classifier
        // is a degraded-mode fallback only. Do not add latency-sensitive work
        // here expecting it to run on the common path; and if chat-turn is judged
        // to fully supersede it, delete the classifier rather than leaving a
        // second music brain that only executes when the model backend is down.
        let should_classify_ai_music = should_run_ai_music_classifier(req);
        let music_conversation_context = if should_classify_ai_music {
            bounded_music_conversation_context(req)
        } else {
            Default::default()
        };
        let recent_track =
            if crate::synapse::capabilities::music::requires_recent_track_context(req)
                || should_classify_ai_music
            {
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
        let planned_music = plan_catalog_or_contextual_music_action(req, recent_track.as_ref());
        // Content-free degraded-mode observability. A ranked request remains
        // unplanned here because provider-backed selection requires the
        // semantic runtime; the boolean makes an unavailable-runtime failure
        // distinguishable from an unrelated music phrase.
        if crate::synapse::capabilities::music::matches_direct_top_grammar(&req.utterance) {
            info!(
                planned = planned_music.is_some(),
                had_recent_track = recent_track.is_some(),
                "ranked music grammar reached the degraded fallback"
            );
        }
        if let Some(planned) = planned_music {
            info!(
                action = planned.action_name,
                "<<< Returning stock catalog/contextual music action"
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

        if let Some(planned) = plan_generated_playlist_action(req) {
            info!(
                action = planned.action_name,
                "<<< Returning stock generated-playlist action"
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
            info!(
                action = planned.action_name,
                "<<< Returning stock clock-family action"
            );
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

        let weather_kind = plan_weather_prompt_with_context(req);

        // Stock does not attach a location to ordinary Interpreter requests,
        // even while HumaneLocationService has a fresh fix. Use the same
        // read-only stock action as a one-shot preflight for explicit reverse-
        // geocode, Nearby, and weather prompts. Its exact trusted observation is
        // promoted by understand_inner, after which the existing provider path
        // performs its lookup and returns Respond.
        let needs_current_location = request_is_confirmed_unlocked(req)
            && (self
                .location_grounding
                .intent_for_request(req, utterance)
                .is_some()
                || weather_kind.is_some());
        if needs_current_location && request_location(req).is_none() {
            // A verified visual `Then` continuation is consumed before this
            // shared cascade runs. Emitting a device action here would have no
            // resumable continuation and could restart the same location fetch.
            // Fail closed until visual automation owns a dedicated continuation.
            if is_vision {
                if !response_action_allowed(req) {
                    info!("<<< Visual location continuation produced no allowed stock action");
                    return Ok(Some(Box::pin(tokio_stream::empty::<
                        Result<SynapseUnderstandingResponse, Status>,
                    >())));
                }
                let response_text =
                    "I couldn't use current location for that visual automation. Ask me directly after the visual request.";
                info!("<<< Returning terminal visual location-continuation response");
                self.spawn_save_local_activity(run_id, utterance, true, response_text);
                let response = SynapseUnderstandingResponse::action_response(
                    native_actions::RESPOND,
                    "Visual automation has no resumable stock location continuation",
                    &serde_json::json!({"Response": response_text}).to_string(),
                    response_parent,
                );
                return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
            }

            match current_location_fetch_state(req) {
                CurrentLocationFetchState::NotRequested
                    if !req.excluded_tools.iter().any(|excluded| {
                        excluded.eq_ignore_ascii_case(native_actions::GET_CURRENT_LOCATION)
                    }) =>
                {
                    info!("<<< Returning one-shot stock location fetch before grounded response");
                    let response = SynapseUnderstandingResponse::action_response(
                        native_actions::GET_CURRENT_LOCATION,
                        LOCAL_WEATHER_LOCATION_PREFLIGHT_THOUGHT,
                        "{}",
                        response_parent,
                    );
                    let local_weather_correlation = if weather_kind
                        == Some(WeatherPromptKind::Current)
                        && trusted_current_user_request(req)
                            .map(|(_, turn, _)| turn.identifier.as_str())
                            == Some(response_parent)
                    {
                        let action_identifier = match response.body.as_ref() {
                            Some(synapse_understanding_response::Body::Turn(turn)) => {
                                turn.identifier.as_str()
                            }
                            _ => "",
                        };
                        self.local_weather_traces.stage(
                            action_identifier,
                            response_parent,
                            utterance,
                        )
                    } else {
                        None
                    };
                    self.spawn_save_local_activity(
                        local_weather_correlation.as_deref().unwrap_or(run_id),
                        utterance,
                        is_vision,
                        &format!("Action: {}", native_actions::GET_CURRENT_LOCATION),
                    );
                    return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
                }
                CurrentLocationFetchState::Unavailable => {
                    if weather_kind == Some(WeatherPromptKind::Current) {
                        self.local_weather_traces.revoke_for_restricted_request(req);
                    }
                    if !response_action_allowed(req) {
                        info!("<<< Current-location failure produced no allowed stock action");
                        return Ok(Some(Box::pin(tokio_stream::empty::<
                            Result<SynapseUnderstandingResponse, Status>,
                        >())));
                    }
                    let response_text = SPOKEN_CURRENT_LOCATION_UNAVAILABLE;
                    info!(
                        "<<< Returning terminal current-location response after unusable stock fetch"
                    );
                    self.spawn_save_local_activity(run_id, utterance, is_vision, response_text);
                    let response = SynapseUnderstandingResponse::action_response(
                        native_actions::RESPOND,
                        "The one-shot stock location fetch did not return a fresh trusted fix",
                        &serde_json::json!({"Response": response_text}).to_string(),
                        response_parent,
                    );
                    return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
                }
                CurrentLocationFetchState::NotRequested | CurrentLocationFetchState::Fresh(_) => {}
            }
        }

        if let Some(kind) = weather_kind {
            if !request_is_confirmed_unlocked(req) {
                return Ok(Some(self.agentic_respond_or_empty(
                    TurnContext {
                        req,
                        run_id,
                        utterance,
                        is_vision,
                        response_parent,
                    },
                    match request_device_lock_state(req) {
                        DeviceLockState::Locked => "Unlock your Pin to check the weather.",
                        DeviceLockState::Unknown => SPOKEN_UNLOCK_UNKNOWN_WEATHER,
                        DeviceLockState::Unlocked => {
                            unreachable!("restricted weather defense excludes unlocked requests")
                        }
                    },
                    "Weather location access requires a confirmed unlocked device",
                )));
            }
            if !response_action_allowed(req) {
                if kind == WeatherPromptKind::Current {
                    self.local_weather_traces.revoke_for_restricted_request(req);
                }
                info!("<<< Weather request produced no allowed stock action");
                return Ok(Some(Box::pin(tokio_stream::empty::<
                    Result<SynapseUnderstandingResponse, Status>,
                >())));
            }
            let location_fetch_state = current_location_fetch_state(req);
            let mut local_weather_trace = if kind == WeatherPromptKind::Current {
                match self
                    .local_weather_traces
                    .consume_for_request(req, &location_fetch_state)
                {
                    LocalWeatherTraceResult::Ready(mut trace) => {
                        trace.record_completed("current_location");
                        Some(trace)
                    }
                    LocalWeatherTraceResult::Blocked | LocalWeatherTraceResult::NoMatch => None,
                }
            } else {
                None
            };
            let weather_response = self.weather_prompt_response(req, kind).await;
            if let Some(trace) = local_weather_trace.as_mut() {
                if weather_response.reverse_geocode_provider_succeeded {
                    trace.record_completed("reverse_geocode");
                }
                if weather_response.weather_provider_succeeded {
                    trace.record_completed("current_weather");
                }
            }
            let response_text = weather_response.text;
            info!(kind = ?kind, "<<< Returning provider-backed weather response");
            let response = SynapseUnderstandingResponse::action_response(
                native_actions::RESPOND,
                "I should answer the explicit weather request using the configured provider",
                &serde_json::json!({"Response": &response_text}).to_string(),
                response_parent,
            );
            if let Some(trace) = local_weather_trace.as_mut() {
                trace.record_completed("terminal");
            }
            self.spawn_save_local_activity(
                local_weather_trace
                    .as_ref()
                    .map(LocalWeatherTrace::correlation)
                    .unwrap_or(run_id),
                utterance,
                is_vision,
                &response_text,
            );
            return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
        }

        let native_action_features = self.live_native_action_features().await;
        if let Some(planned) = plan_native_device_action_with_features(req, native_action_features)
        {
            if planned.action_name == native_actions::GET_CURRENT_LOCATION
                && !should_emit_current_location_action(req)
            {
                if request_location(req).is_none()
                    && matches!(
                        current_location_fetch_state(req),
                        CurrentLocationFetchState::Unavailable
                    )
                {
                    if !response_action_allowed(req) {
                        info!("<<< Current-location failure produced no allowed stock action");
                        return Ok(Some(Box::pin(tokio_stream::empty::<
                            Result<SynapseUnderstandingResponse, Status>,
                        >())));
                    }
                    let response_text = SPOKEN_CURRENT_LOCATION_UNAVAILABLE;
                    info!(
                        "<<< Returning terminal current-location response after unusable stock fetch"
                    );
                    self.spawn_save_local_activity(run_id, utterance, is_vision, response_text);
                    let response = SynapseUnderstandingResponse::action_response(
                        native_actions::RESPOND,
                        "The one-shot stock location fetch did not return a fresh trusted fix",
                        &serde_json::json!({"Response": response_text}).to_string(),
                        response_parent,
                    );
                    return Ok(Some(Box::pin(tokio_stream::once(Ok(response)))));
                }
                // A usable request location can go straight through the
                // provider-backed LocationGrounding -> Respond path. If the
                // one-shot stock fetch already ran, its linked observation is
                // now in model history and must be consumed instead of asking
                // the device for the same location again.
                info!(
                    has_request_location = request_location(req).is_some(),
                    "<<< Continuing current-location request without repeating stock fetch"
                );
            } else {
                info!(
                    action = planned.action_name,
                    "<<< Returning stock native device action"
                );
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

        // Deterministic and stock-local planners remain authoritative. Only an
        // otherwise-unhandled, broadly music-shaped request reaches this
        // constrained classifier. A malformed/non-music result falls through
        // to ordinary chat; it never becomes a device action by itself.
        if should_classify_ai_music {
            if let Some(candidate) = self
                .classify_ai_music_request(
                    run_id,
                    utterance,
                    recent_track.as_ref(),
                    &music_conversation_context,
                )
                .await
            {
                if let Some(planned) = plan_ai_music_action(
                    req,
                    &candidate,
                    recent_track.as_ref(),
                    &music_conversation_context,
                ) {
                    info!(
                        action = planned.action_name,
                        "<<< Returning constrained AI music result through stock action"
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
            }
        }

        Ok(None)
    }

    pub(in crate::services::aibus) async fn understand_inner(
        self: &Arc<Self>,
        metadata: MetadataMap,
        mut req: SynapseUnderstandingRequest,
        log_name: &str,
    ) -> Result<
        Pin<Box<dyn Stream<Item = Result<SynapseUnderstandingResponse, Status>> + Send>>,
        Status,
    > {
        // Once the outer envelope is bound to the exact trusted current turn,
        // every downstream intent/tool classifier consumes stock's selected
        // repaired-or-raw text. The outer copy is correlation evidence only;
        // it must not become a second, divergent source of mutation authority.
        let trusted_turn_bound = trusted_current_user_request(&req).is_some();
        if let Some(authoritative_utterance) = trusted_current_user_request(&req)
            .map(|(_, _, content)| selected_user_request_text(content).to_string())
        {
            req.utterance = authoritative_utterance;
        }
        // Content-free turn fingerprint: byte length and an FNV-1a hash of the
        // effective utterance. Never the text itself. This makes host/device
        // routing divergences diagnosable without content exposure.
        info!(
            utterance_bytes = req.utterance.len(),
            utterance_fnv = %format!("{:08x}", fnv1a32(req.utterance.as_bytes())),
            trusted_turn_bound,
            "    effective utterance fingerprint"
        );

        // A turn is a streaming-session turn exactly when it entered through
        // the bidirectional endpoint. This is the deterministic gate for the
        // in-session chat-turn transcript resume: unary turns (the default while
        // the device streaming flag stays off) never capture or consume one.
        let streaming_session =
            log_name == super::super::turn::streaming::BIDIRECTIONAL_UNDERSTAND_LOG_NAME;

        // The stock current-location action returns its fresh fix as a
        // parent-linked observation instead of rewriting the outer request.
        // Claim a staged agentic continuation by the generated action UUID,
        // then promote only that exact trusted result before provider work.
        let device_lock_state = request_device_lock_state(&req);
        let agentic_resume = if device_lock_state == DeviceLockState::Unlocked {
            let location_fetch_state = current_location_fetch_state(&req);
            let resume = self.agentic_resumes.consume_for_request(
                &req,
                &location_fetch_state,
                streaming_session,
            );
            promote_fresh_current_location_observation(&mut req);
            resume
        } else {
            // Do not parse or promote the returned coordinates at all when the
            // continuation arrives locked or without a trusted lock context.
            self.local_weather_traces
                .revoke_for_restricted_request(&req);
            self.agentic_resumes.revoke_for_restricted_request(&req)
        };
        let restricted_location_kind = restricted_location_request_kind(&req);
        if device_lock_state != DeviceLockState::Unlocked {
            // Keep local stock planners available, but remove every outer or
            // situation-derived location field before any planner can attach it
            // to a prompt, provider request, or function-call metadata.
            clear_request_location(&mut req);
            self.location_grounding.revoke_for_restricted_request();
        }
        let utterance = &req.utterance;
        let transport_run_id = extract_run_id(&metadata);
        let run_id = effective_request_correlation(&req, &transport_run_id);
        // Record this run's session-context eligibility once, before any of its
        // turns are saved: only unlocked runs may later resurface as model
        // conversation context, matching the locked-history exclusion the
        // device-supplied window already enforces.
        {
            let db = self.db.clone();
            let run_id = run_id.to_string();
            let eligible = device_lock_state == DeviceLockState::Unlocked;
            tokio::spawn(async move {
                if let Err(error) = db.set_run_session_eligibility(&run_id, eligible).await {
                    warn!(error = %error, "failed to record session eligibility");
                }
            });
        }
        let visual_state_id = validated_visual_state_id(&req, &transport_run_id)
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string());
        let inline_image_id = validated_inline_image_id(&req, &transport_run_id)
            .map(str::to_string)
            .unwrap_or_else(|| visual_state_id.clone());

        let may_log_content = self.may_log_llm_content();
        if may_log_content {
            info!(run_id = %run_id, utterance = %utterance, ">>> {log_name}");
        } else if streaming_session {
            super::super::turn::streaming::log_redacted_request(&run_id);
        } else {
            info!(run_id = %run_id, ">>> {log_name} (content redacted)");
        }

        let ordinary_parent = response_parent_id(&req, &run_id).to_string();
        if let Some(kind) = restricted_location_kind {
            info!(?kind, "<<< Restricted location-bearing request terminated before history, image, provider, or model work");
            let (response, thought) = match (device_lock_state, kind) {
                (DeviceLockState::Locked, RestrictedLocationRequestKind::Weather) => (
                    "Unlock your Pin to check the weather.",
                    "Weather location access requires an unlocked device",
                ),
                (DeviceLockState::Unknown, RestrictedLocationRequestKind::Weather) => (
                    SPOKEN_UNLOCK_UNKNOWN_WEATHER,
                    "Weather location access requires a confirmed unlocked device",
                ),
                (DeviceLockState::Locked, RestrictedLocationRequestKind::Location) => (
                    "Unlock your Pin to use current location.",
                    "Current location access requires an unlocked device",
                ),
                (DeviceLockState::Unknown, RestrictedLocationRequestKind::Location) => (
                    SPOKEN_UNLOCK_UNKNOWN_LOCATION,
                    "Current location access requires a confirmed unlocked device",
                ),
                (DeviceLockState::Unlocked, _) => {
                    unreachable!("restricted guard excludes unlocked requests")
                }
            };
            return Ok(self.agentic_respond_or_empty(
                TurnContext {
                    req: &req,
                    run_id: &run_id,
                    utterance,
                    is_vision: false,
                    response_parent: &ordinary_parent,
                },
                response,
                thought,
            ));
        }

        let (history, ctx) = if let Some(ref ctx) = req.device_context {
            if device_lock_state != DeviceLockState::Unlocked {
                info!(
                    turns = ctx.turns.len(),
                    is_locked = ctx.is_locked,
                    "    restricted device_context (history and private observations suppressed)"
                );
                (Vec::new(), Some(ctx))
            } else {
                if may_log_content {
                    info!(
                        turns = ctx.turns.len(),
                        is_locked = ctx.is_locked,
                        location = %ctx.reverse_geocoded_location,
                        "    device_context"
                    );
                } else {
                    info!(
                        turns = ctx.turns.len(),
                        is_locked = ctx.is_locked,
                        "    device_context (content redacted)"
                    );
                }
                for (i, turn) in ctx.turns.iter().enumerate() {
                    let kind = match &turn.content {
                        Some(synapse_chat_turn::Content::UserRequest(_)) => "user_request",
                        Some(synapse_chat_turn::Content::Action(a)) => {
                            if may_log_content {
                                debug!(idx = i, action = %a.action, input = %a.input, "    turn");
                            } else {
                                debug!(idx = i, "    turn (content redacted)");
                            }
                            "action"
                        }
                        Some(synapse_chat_turn::Content::Observation(o)) => {
                            if may_log_content {
                                debug!(idx = i, is_final = o.is_final, action_name = %o.action_name, obs = %o.observation, "    turn");
                            } else {
                                debug!(
                                    idx = i,
                                    is_final = o.is_final,
                                    "    turn (content redacted)"
                                );
                            }
                            "observation"
                        }
                        Some(synapse_chat_turn::Content::Message(_)) => "message",
                        Some(synapse_chat_turn::Content::End(_)) => "end",
                        Some(synapse_chat_turn::Content::Tao(_)) => "tao",
                        Some(synapse_chat_turn::Content::Interpretation(_)) => "interpretation",
                        Some(synapse_chat_turn::Content::Speech(_)) => "speech",
                        None => "empty",
                    };
                    if may_log_content {
                        debug!(idx = i, kind = kind, user = ?turn.user(), "    turn");
                    } else {
                        debug!(idx = i, kind = kind, "    turn (content redacted)");
                    }
                }
                let h = extract_history(ctx, &self.image_store).await;
                if !h.is_empty() {
                    info!(messages = h.len(), "    extracted history");
                }
                (h, Some(ctx))
            }
        } else {
            (Vec::new(), None)
        };
        let agentic_conversation_context = extract_agentic_conversation_context(&req);
        // Content-free: counts only. An unexpected zero alongside a populated
        // device_context is the signature of the strict current-turn
        // validation rejecting the whole window.
        info!(
            turns = agentic_conversation_context.len(),
            "    agentic conversation context"
        );
        match agentic_resume {
            AgenticResumeResult::Ready(resume, chat_turn_suspension) => {
                info!(
                    in_session_transcript = chat_turn_suspension.is_some(),
                    "<<< Resuming parent-bound agentic location continuation"
                );
                let continuity = if streaming_session {
                    ChatTurnSessionContinuity::Streaming(chat_turn_suspension)
                } else {
                    ChatTurnSessionContinuity::Unary
                };
                if let Some(stream) = self
                    .run_agentic_orchestration(
                        TurnContext {
                            req: &req,
                            run_id: &run_id,
                            utterance,
                            response_parent: &ordinary_parent,
                            is_vision: false,
                        },
                        &agentic_conversation_context,
                        Some(*resume),
                        continuity,
                    )
                    .await?
                {
                    return Ok(stream);
                }
                warn!("agentic location continuation failed safely after being consumed");
                // Speak the same truthful failure the deterministic location
                // path uses. An empty stream here is indistinguishable from the
                // Pin ignoring the request.
                // `agentic_respond_or_empty` still degrades to an empty stream
                // when stock actually excluded `Respond`.
                return Ok(self.agentic_respond_or_empty(
                    TurnContext {
                        req: &req,
                        run_id: &run_id,
                        utterance,
                        response_parent: &ordinary_parent,
                        is_vision: false,
                    },
                    SPOKEN_CURRENT_LOCATION_UNAVAILABLE,
                    "The location continuation could not be completed",
                ));
            }
            AgenticResumeResult::Blocked => {
                warn!("agentic location continuation was missing, expired, or invalid");
                return Ok(self.agentic_respond_or_empty(
                    TurnContext {
                        req: &req,
                        run_id: &run_id,
                        utterance,
                        response_parent: &ordinary_parent,
                        is_vision: false,
                    },
                    SPOKEN_CURRENT_LOCATION_UNAVAILABLE,
                    "The location continuation was missing, expired, or invalid",
                ));
            }
            AgenticResumeResult::NoMatch => {}
        }

        if device_lock_state != DeviceLockState::Unlocked && request_contains_visual_context(&req) {
            self.vision_automation
                .revoke_pending(&visual_state_id)
                .await;
            let response = match device_lock_state {
                DeviceLockState::Locked => "Unlock your Pin to use vision.",
                DeviceLockState::Unknown => SPOKEN_UNLOCK_UNKNOWN_VISION,
                DeviceLockState::Unlocked => {
                    unreachable!("restricted visual guard excludes unlocked requests")
                }
            };
            return Ok(self.agentic_respond_or_empty(
                TurnContext {
                    req: &req,
                    run_id: &run_id,
                    utterance,
                    is_vision: true,
                    response_parent: &ordinary_parent,
                },
                response,
                "Vision requires a confirmed unlocked device",
            ));
        }

        // AnalyzeImage stages only a bounded, user-authored `Then` utterance.
        // Consume it solely on stock's immediate, parent-linked, non-final
        // UnderstandScene observation pass, then run the same planners used by
        // ordinary voice. The verified observation remains the response parent.
        // A malformed/expired/tampered continuation is consumed and halted so
        // no generic image or chat path can reinterpret it.
        match self.consume_visual_automation(&visual_state_id, &req).await {
            PendingActionResult::Ready {
                utterance: automation_utterance,
                parent_identifier,
            } => {
                info!("<<< Planning trusted utterance from parent-linked visual automation");
                let automation_text = automation_utterance.text().to_string();
                let automation_req = request_with_automation_utterance(&req, &automation_text);

                // Preserve stock's contextual "play this song" capability: it
                // needs the linked image before the text-only music planners.
                if let Some(stream) = self
                    .run_visual_music_request(
                        TurnContext {
                            req: &automation_req,
                            run_id: &run_id,
                            utterance: &automation_text,
                            response_parent: &parent_identifier,
                            is_vision: true,
                        },
                        &inline_image_id,
                        &visual_state_id,
                    )
                    .await?
                {
                    return Ok(stream);
                }

                if let Some(stream) = self
                    .run_text_cascade(
                        &automation_req,
                        &run_id,
                        &automation_text,
                        &parent_identifier,
                        true,
                    )
                    .await?
                {
                    return Ok(stream);
                }

                // The general model can only return Respond/DeferredVision; it
                // cannot name or execute arbitrary device actions. Respect the
                // ordinary Respond exclusion before using that fallback.
                if response_action_allowed(&automation_req) {
                    return self
                        .evaluate_agent_conversation(
                            TurnContext {
                                req: &automation_req,
                                run_id: &run_id,
                                utterance: &automation_text,
                                response_parent: &parent_identifier,
                                is_vision: true,
                            },
                            &history,
                            None,
                            log_name,
                        )
                        .await;
                }

                info!("<<< Visual automation produced no allowed stock action");
                return Ok(Box::pin(tokio_stream::empty::<
                    Result<SynapseUnderstandingResponse, Status>,
                >()));
            }
            PendingActionResult::Blocked => {
                info!("<<< Visual automation continuation was blocked; no fallback planner run");
                return Ok(Box::pin(tokio_stream::empty::<
                    Result<SynapseUnderstandingResponse, Status>,
                >()));
            }
            PendingActionResult::NoMatch => {}
        }

        // A visual music command is allowed only when the user explicitly
        // asked to play the entity in the linked image. Image/OCR/model text
        // can identify an entity but never select a device action.
        if let Some(stream) = self
            .run_visual_music_request(
                TurnContext {
                    req: &req,
                    run_id: &run_id,
                    utterance,
                    response_parent: &ordinary_parent,
                    is_vision: true,
                },
                &inline_image_id,
                &visual_state_id,
            )
            .await?
        {
            return Ok(stream);
        }

        // Numeric nutrition for an image is a separate, read-only trust path:
        // identify food/portion with the constrained visual model, then use
        // only Open Food Facts values. It may target the current inline image
        // or stock's exact immediately preceding UnderstandScene parent chain.
        // It never uses the broad historical-image extractor below.
        let visual_nutrition_query = parse_visual_nutrition_query(utterance);
        let blocked_visual_nutrition_candidate = is_blocked_visual_nutrition_query(utterance);
        let visual_nutrition_candidate = is_visual_nutrition_candidate(utterance);
        let deictic_visual_nutrition = is_deictic_visual_nutrition_query(utterance);
        let should_guard_visual_nutrition = visual_nutrition_query.is_some()
            || blocked_visual_nutrition_candidate
            || visual_nutrition_candidate;
        let food_permit = if should_guard_visual_nutrition {
            match self.food_runtime_permit() {
                Some(permit) => Some(permit),
                None => return Ok(food_runtime_unavailable_stream(&req, &ordinary_parent)),
            }
        } else {
            None
        };
        let exact_nutrition_image = if should_guard_visual_nutrition {
            exact_visual_nutrition_image(
                &req,
                &inline_image_id,
                &visual_state_id,
                &self.image_store,
            )
            .await
        } else {
            None
        };
        let same_run_nutrition_capture =
            if should_guard_visual_nutrition && device_lock_state == DeviceLockState::Unlocked {
                self.image_store.get_capture_refresh(&visual_state_id).await
            } else {
                None
            };
        if food_permit.is_some_and(|permit| !self.food_runtime_permit_is_current(permit)) {
            return Ok(food_runtime_unavailable_stream(&req, &ordinary_parent));
        }
        let repeats_same_run_nutrition_question =
            same_run_nutrition_capture.as_ref().is_some_and(|capture| {
                normalize_utterance(utterance) == normalize_utterance(&capture.question)
            });
        let has_trusted_visual_nutrition_target = exact_nutrition_image.is_some()
            || repeats_same_run_nutrition_question
            || deictic_visual_nutrition;
        let blocked_visual_nutrition_query =
            blocked_visual_nutrition_candidate && has_trusted_visual_nutrition_target;
        let unsupported_visual_nutrition_query = visual_nutrition_candidate
            && visual_nutrition_query.is_none()
            && !blocked_visual_nutrition_candidate
            && has_trusted_visual_nutrition_target;
        let mut prefer_text_nutrition = false;
        if blocked_visual_nutrition_query
            || unsupported_visual_nutrition_query
            || (visual_nutrition_query.is_some() && has_trusted_visual_nutrition_target)
        {
            if !response_action_allowed(&req) {
                info!("<<< Visual nutrition produced no allowed stock action");
                return Ok(Box::pin(tokio_stream::empty::<
                    Result<SynapseUnderstandingResponse, Status>,
                >()));
            }
            if ctx.is_some_and(|context| context.is_locked) {
                let response = SynapseUnderstandingResponse::action_response(
                    native_actions::RESPOND,
                    "Visual nutrition requires an unlocked device",
                    &serde_json::json!({"Response": "Unlock your Pin to use visual nutrition."})
                        .to_string(),
                    &run_id,
                );
                return Ok(Box::pin(tokio_stream::once(Ok(response))));
            }
        }
        if blocked_visual_nutrition_query {
            let observation = "I can provide read-only Open Food Facts reference nutrients for an identified food, but I can't combine visual nutrition with food logging, diet, medical, or health-advice requests. I won't estimate nutrients from the image.";
            self.spawn_save_local_activity(&run_id, utterance, true, observation);
            let response = SynapseUnderstandingResponse::action_response(
                native_actions::RESPOND,
                "I should refuse a mutating or advisory visual nutrition request",
                &serde_json::json!({"Response": observation}).to_string(),
                &ordinary_parent,
            );
            return Ok(Box::pin(tokio_stream::once(Ok(response))));
        }
        if unsupported_visual_nutrition_query {
            let observation = "I can only provide read-only Open Food Facts reference values for supported nutrients when the request is unambiguous. I won't let a generic vision model estimate or invent nutrition from the image.";
            self.spawn_save_local_activity(&run_id, utterance, true, observation);
            let response = SynapseUnderstandingResponse::action_response(
                native_actions::RESPOND,
                "I should keep unsupported visual nutrition out of generic image chat",
                &serde_json::json!({"Response": observation}).to_string(),
                &ordinary_parent,
            );
            return Ok(Box::pin(tokio_stream::once(Ok(response))));
        }
        if let Some(query) = visual_nutrition_query.as_ref() {
            // Stock commonly repeats the same AnalyzeImage question through
            // Understand. Reuse that exact same-run completed observation; it
            // is not permission to retarget the cached image with a new query.
            if let Some(capture) = same_run_nutrition_capture.as_ref() {
                if normalize_utterance(utterance) == normalize_utterance(&capture.question) {
                    if let Some(observation) = capture.observation.as_deref() {
                        if food_permit
                            .is_some_and(|permit| !self.food_runtime_permit_is_current(permit))
                        {
                            return Ok(food_runtime_unavailable_stream(&req, &ordinary_parent));
                        }
                        self.spawn_save_local_activity(&run_id, utterance, true, observation);
                        let response = SynapseUnderstandingResponse::action_response(
                            native_actions::RESPOND,
                            "I should return the completed visual nutrition analysis",
                            &serde_json::json!({"Response": observation}).to_string(),
                            &ordinary_parent,
                        );
                        return Ok(Box::pin(tokio_stream::once(Ok(response))));
                    }
                }
            }

            if let Some(image) = exact_nutrition_image {
                let observation = if let Some(food) = &self.food {
                    food.visual_nutrition_observation(
                        &run_id,
                        query,
                        image,
                        food_permit.expect("guarded visual nutrition has a runtime permit"),
                    )
                    .await
                } else {
                    "Visual nutrition is unavailable right now, so I won't guess nutrition from the image."
                        .to_string()
                };
                if food_permit.is_some_and(|permit| !self.food_runtime_permit_is_current(permit)) {
                    return Ok(food_runtime_unavailable_stream(&req, &ordinary_parent));
                }
                self.spawn_save_local_activity(&run_id, utterance, true, &observation);
                let response = SynapseUnderstandingResponse::action_response(
                    native_actions::RESPOND,
                    "I should return provider-backed visual nutrition",
                    &serde_json::json!({"Response": observation}).to_string(),
                    &ordinary_parent,
                );
                return Ok(Box::pin(tokio_stream::once(Ok(response))));
            }

            if deictic_visual_nutrition {
                let observation = "I need a new or directly linked vision capture to answer that nutrition question. I won't use an older image or guess.";
                self.spawn_save_local_activity(&run_id, utterance, true, observation);
                let response = SynapseUnderstandingResponse::action_response(
                    native_actions::RESPOND,
                    "I need a safely linked image for visual nutrition",
                    &serde_json::json!({"Response": observation}).to_string(),
                    &ordinary_parent,
                );
                return Ok(Box::pin(tokio_stream::once(Ok(response))));
            }

            // A non-deictic named-food question without a trusted image remains
            // eligible for the ordinary text nutrition planner, but an older
            // incidental image must not divert it into generic visual chat.
            prefer_text_nutrition = true;
        } else if visual_nutrition_candidate {
            // Nutrition-like named-food text without a current/deictic image is
            // not a visual request. Keep it in the ordinary text cascade and do
            // not let an incidental historical image divert it into image chat.
            prefer_text_nutrition = true;
        }

        // The dedicated visual music and nutrition guards above own the image-
        // dependent contracts. After they decline, deterministic current-turn
        // text handling must still win before generic image chat so attaching a
        // camera frame cannot divert an exact stock command through a model.
        // Run this fast path exactly once in the ordinary request flow.
        if let Some(stream) = self
            .run_local_text_fast_path(&req, &run_id, utterance, &ordinary_parent, false)
            .await?
        {
            return Ok(stream);
        }

        // Generic image chat accepts inline bytes only from the trusted current
        // user turn. An older image elsewhere in history is context, never the
        // target of this request. A same-run AnalyzeImage capture remains the
        // bounded fallback when no current inline image exists.
        let inline_image = (device_lock_state == DeviceLockState::Unlocked)
            .then(|| linked_current_turn_image(&req, &inline_image_id))
            .flatten();
        let stored_capture =
            if device_lock_state == DeviceLockState::Unlocked && inline_image.is_none() {
                self.image_store.get_capture_refresh(&visual_state_id).await
            } else {
                None
            };
        let image =
            inline_image.or_else(|| stored_capture.as_ref().map(|capture| capture.bytes.clone()));
        let prefer_text_music = prefers_text_music_over_image(&req);

        if let Some(image_bytes) = image {
            if prefer_text_music || prefer_text_nutrition {
                info!("Explicit text request takes precedence over incidental image context");
            } else {
                // Every image-bearing branch below can produce only `Respond`.
                // An excluded action must terminate this cascade stage without
                // silently reintroducing the same action through a fallback.
                if !response_action_allowed(&req) {
                    info!("<<< Image request produced no allowed stock action");
                    return Ok(Box::pin(tokio_stream::empty::<
                        Result<SynapseUnderstandingResponse, Status>,
                    >()));
                }
                if ctx.is_some_and(|context| context.is_locked) {
                    info!("<<< Refusing camera analysis while the device is locked");
                    self.spawn_save_local_activity(
                        &run_id,
                        utterance,
                        true,
                        "Unlock your Pin to use vision.",
                    );
                    let response = SynapseUnderstandingResponse::action_response(
                        native_actions::RESPOND,
                        "Vision requires an unlocked device",
                        &serde_json::json!({"Response": "Unlock your Pin to use vision."})
                            .to_string(),
                        &run_id,
                    );
                    return Ok(Box::pin(tokio_stream::once(Ok(response))));
                }

                // AnalyzeImage already performed the initial strict image pass.
                // If stock immediately repeats that same question through
                // Understand, reuse the live result instead of uploading the
                // image twice. New follow-ups still receive the image.
                if let Some(capture) = stored_capture.as_ref() {
                    let repeats_initial_question = utterance.trim().is_empty()
                        || normalize_utterance(utterance) == normalize_utterance(&capture.question);
                    if repeats_initial_question {
                        if let Some(observation) = capture.observation.as_deref() {
                            self.spawn_save_local_activity(&run_id, utterance, true, observation);
                            let response = SynapseUnderstandingResponse::action_response(
                                native_actions::RESPOND,
                                "I should return the completed visual analysis",
                                &serde_json::json!({"Response": observation}).to_string(),
                                &run_id,
                            );
                            return Ok(Box::pin(tokio_stream::once(Ok(response))));
                        }
                    }
                }

                // The camera->cloud boundary for follow-up image chat: without
                // the live consent acknowledgement the image must not reach a
                // provider. Cached same-question observations above remain
                // available because they never leave the device.
                if !self.vision_cloud_consent_acknowledged().await {
                    info!(
                        "<<< Refusing camera analysis without the vision consent acknowledgement"
                    );
                    self.spawn_save_local_activity(
                        &run_id,
                        utterance,
                        true,
                        VISION_CONSENT_REQUIRED_MESSAGE,
                    );
                    let response = SynapseUnderstandingResponse::action_response(
                        native_actions::RESPOND,
                        "Vision requires the camera cloud consent acknowledgement",
                        &serde_json::json!({"Response": VISION_CONSENT_REQUIRED_MESSAGE})
                            .to_string(),
                        &run_id,
                    );
                    return Ok(Box::pin(tokio_stream::once(Ok(response))));
                }

                info!("<<< Image-bearing Understand request, running image-aware chat");
                return self
                    .evaluate_agent_conversation(
                        TurnContext {
                            req: &req,
                            run_id: &run_id,
                            utterance,
                            response_parent: &ordinary_parent,
                            is_vision: true,
                        },
                        &history,
                        Some(image_bytes),
                        log_name,
                    )
                    .await;
            }
        }

        if !prefer_text_music && ctx.is_some_and(is_vision_request) {
            if device_lock_state != DeviceLockState::Unlocked {
                return Ok(self.agentic_respond_or_empty(
                    TurnContext {
                        req: &req,
                        run_id: &run_id,
                        utterance,
                        is_vision: true,
                        response_parent: &ordinary_parent,
                    },
                    match device_lock_state {
                        DeviceLockState::Locked => "Unlock your Pin to use vision.",
                        DeviceLockState::Unknown => SPOKEN_UNLOCK_UNKNOWN_VISION,
                        DeviceLockState::Unlocked => {
                            unreachable!("restricted visual guard excludes unlocked requests")
                        }
                    },
                    "Vision requires a confirmed unlocked device",
                ));
            }
            // Refuse before triggering a capture whose analysis would only be
            // refused at the camera->cloud boundary anyway.
            if !self.vision_cloud_consent_acknowledged().await {
                return Ok(self.agentic_respond_or_empty(
                    TurnContext {
                        req: &req,
                        run_id: &run_id,
                        utterance,
                        is_vision: true,
                        response_parent: &ordinary_parent,
                    },
                    VISION_CONSENT_REQUIRED_MESSAGE,
                    "Vision requires the camera cloud consent acknowledgement",
                ));
            }
            info!("<<< Vision request detected, returning UnderstandScene");
            self.spawn_save_local_activity(&run_id, utterance, true, "Vision capture requested.");
            let response = SynapseUnderstandingResponse::action_response(
                native_actions::UNDERSTAND_SCENE,
                "I should look at what the user is seeing",
                &serde_json::json!({"Question": utterance}).to_string(),
                &run_id,
            );
            return Ok(Box::pin(tokio_stream::once(Ok(response))));
        }

        // Every ordinary request not handled locally enters one semantic
        // contract, including factual chat, a single read, or an arbitrary
        // multi-read outcome. A returned stream means planning began or
        // terminated and is final: never reinterpret a failed/partial model turn
        // through a legacy mutation path.
        if let Some(stream) = self
            .run_agentic_orchestration(
                TurnContext {
                    req: &req,
                    run_id: &run_id,
                    utterance,
                    response_parent: &ordinary_parent,
                    is_vision: false,
                },
                &agentic_conversation_context,
                None,
                if streaming_session {
                    ChatTurnSessionContinuity::Streaming(None)
                } else {
                    ChatTurnSessionContinuity::Unary
                },
            )
            .await?
        {
            return Ok(stream);
        }

        // The generic runtime was unavailable before its first model step.
        // Keep the existing provider/stock compatibility cascade as a service
        // fallback only; it is never reached after semantic work has begun.
        if let Some(stream) = self
            .run_text_cascade(&req, &run_id, utterance, &ordinary_parent, false)
            .await?
        {
            return Ok(stream);
        }

        // No deterministic/provider planner handled the request, so continue
        // through the ordinary conversational model with the same parent.
        self.evaluate_agent_conversation(
            TurnContext {
                req: &req,
                run_id: &run_id,
                utterance,
                response_parent: &ordinary_parent,
                is_vision: false,
            },
            &history,
            None,
            log_name,
        )
        .await
    }
}
