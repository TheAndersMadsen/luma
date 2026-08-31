use super::*;
use crate::synapse::authority::runtime::AgenticToolError;

/// The read tools are declared twice: here, as the surface the model is
/// offered, and in `READ_TOOL_CATALOG`, as the table every call is
/// validated against. Nothing in the code links the two, so a tool added to
/// one and not the other either goes out unvalidated or becomes a name the
/// model can never successfully call — which reads on-device as silence.
#[test]
fn exposed_read_tools_match_the_validation_catalog() {
    use crate::synapse::catalog::READ_TOOL_CATALOG;
    use std::collections::BTreeSet;

    let exposed: BTreeSet<&str> = read_specs().iter().map(|spec| spec.name).collect();
    let validated: BTreeSet<&str> = READ_TOOL_CATALOG.iter().map(|spec| spec.name).collect();

    assert_eq!(
        exposed, validated,
        "read tool surface and validation catalog have drifted apart",
    );
}

#[test]
fn only_observation_only_reads_are_parallel_batch_safe() {
    assert!(is_parallel_read_tool("knowledge_lookup"));
    assert!(is_parallel_read_tool("web_search"));
    assert!(is_parallel_read_tool("current_weather"));
    assert!(is_parallel_read_tool("music_artist_top_tracks"));

    // May suspend into a stock GetCurrentLocation preflight.
    assert!(!is_parallel_read_tool("current_location"));
    // These consume another read's result and therefore stay serial even
    // though their final effect is read-only.
    assert!(!is_parallel_read_tool("weather_at_place"));
    assert!(!is_parallel_read_tool("reverse_geocode"));
    assert!(!is_parallel_read_tool("route"));
    // Server writes and native actions are never concurrent read work.
    assert!(!is_parallel_read_tool("remember_fact"));
    assert!(!is_parallel_read_tool("play_music"));
    assert!(!is_parallel_read_tool("volume_up"));
    assert!(!is_parallel_read_tool("unknown_tool"));
}

struct StaticBroker(Value);
#[tonic::async_trait]
impl AgenticToolExecutor for StaticBroker {
    async fn execute(
        &self,
        _request: AgenticToolRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        Ok(AgenticToolOutput::Result(self.0.clone()))
    }
}

/// A broker whose only distinguishing feature is whether search is
/// configured, so the catalog gate can be tested independently of locks.
struct SearchCapableBroker(bool);
#[tonic::async_trait]
impl AgenticToolExecutor for SearchCapableBroker {
    async fn execute(
        &self,
        _request: AgenticToolRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        Ok(AgenticToolOutput::Result(json!({"status": "ok"})))
    }

    fn web_search_available(&self) -> bool {
        self.0
    }
}

#[test]
fn web_search_is_advertised_only_when_a_subscription_is_configured() {
    // An advertised-but-always-failing tool costs the model a round trip
    // and teaches it nothing, so an unconfigured Pin hides it entirely and
    // the model reaches for knowledge_lookup on its first choice instead.
    let configured = SearchCapableBroker(true);
    let names: Vec<&str> = AibusToolCatalog::new(
        &configured,
        unlocked_authorization(),
        "what happened in the election today",
    )
    .catalog()
    .into_iter()
    .map(|def| def.name)
    .collect();
    assert!(names.contains(&"web_search"), "{names:?}");
    assert!(names.contains(&"knowledge_lookup"), "{names:?}");

    let unconfigured = SearchCapableBroker(false);
    let names: Vec<&str> = AibusToolCatalog::new(
        &unconfigured,
        unlocked_authorization(),
        "what happened in the election today",
    )
    .catalog()
    .into_iter()
    .map(|def| def.name)
    .collect();
    assert!(!names.contains(&"web_search"), "{names:?}");
    assert!(
        names.contains(&"knowledge_lookup"),
        "the encyclopedia fallback must survive: {names:?}"
    );
}

/// REGRESSION (observed on device): "Look up the best songs by Drake and play
/// the best one" spent two whole model steps inside `web_search`, and when the
/// provider was unreachable the turn died on "Something went wrong. Try again."
///
/// `web_search` could never have finished that request: it discharges only a
/// `CurrentEvents` freshness obligation, never the device-scoped one a play
/// request raises, and the server had already parsed the artist out of the
/// utterance. A tool that cannot complete the turn must not be offered for it.
#[test]
fn a_ranked_lookup_and_play_request_never_advertises_web_search() {
    let configured = SearchCapableBroker(true);
    let advertised = |utterance: &str| -> Vec<&'static str> {
        AibusToolCatalog::new(&configured, unlocked_authorization(), utterance)
            .catalog()
            .into_iter()
            .map(|def| def.name)
            .collect()
    };

    for utterance in [
        // The exact device utterance, and the phrasings the same grammar owns.
        "Look up the best songs by Drake and play the best one.",
        "look up the best song by Michael Jackson and play it",
        "find the top tracks by Drake and play the top one",
    ] {
        let names = advertised(utterance);
        assert!(
            !names.contains(&"web_search"),
            "a ranked lookup-and-play request must not be offered a tool that \
             cannot complete it ({utterance:?}): {names:?}"
        );
        assert!(
            names.contains(&"music_artist_top_tracks") || names.contains(&"music_catalog_search"),
            "the tools that CAN answer it must still be advertised \
             ({utterance:?}): {names:?}"
        );
    }

    // Control: an ordinary current-events question is exactly what `web_search`
    // is for and must keep it. Without this the gate above could pass by
    // hiding search from everyone.
    let names = advertised("what happened in the election today");
    assert!(
        names.contains(&"web_search"),
        "current-events questions must keep web search: {names:?}"
    );

    // Control: a lookup with NO playback clause is not this grammar, so it
    // keeps search. This is what keeps the gate narrow.
    let names = advertised("look up the best songs by Drake");
    assert!(
        names.contains(&"web_search"),
        "a bare lookup is not a ranked lookup-and-play request: {names:?}"
    );
}

#[test]
fn a_default_broker_reports_no_search_rather_than_assuming_one() {
    // The trait default is the safe direction: a broker that never opted
    // in must not have search advertised on its behalf.
    assert!(!StaticBroker(json!({})).web_search_available());
}

struct RejectingBroker(&'static str);
#[tonic::async_trait]
impl AgenticToolExecutor for RejectingBroker {
    async fn execute(
        &self,
        _request: AgenticToolRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        Err(AgenticToolError::new(self.0))
    }
}

#[tokio::test]
async fn live_fact_requests_reject_the_first_tool_free_answer() {
    let broker = StaticBroker(json!({"status":"ok","weather":{"temperature_c":18}}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "find the nearest coffee shop and navigate there",
    );
    // Tool-free answer to a live-fact request: rejected with the
    // freshness nudge (context must not substitute for fresh evidence).
    let nudge = tools.final_answer_nudge("There is one on Main Street.");
    assert!(nudge.is_some());
    assert!(
        nudge.unwrap().contains("live information"),
        "freshness nudge expected"
    );

    // After a successful read this run, the obligation is satisfied.
    let read = tools.execute(&call("current_weather", json!({}))).await;
    assert!(matches!(
        read,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));
    assert_eq!(tools.final_answer_nudge("It is 18 degrees."), None);
}

#[test]
fn non_live_requests_are_never_freshness_nudged() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "tell me about tycho brahe",
    );
    assert_eq!(tools.final_answer_nudge("He was an astronomer."), None);
}

#[test]
fn freshness_lexicon_covers_natural_weather_and_respects_word_boundaries() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let live = |utterance: &str| {
        AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .live_evidence_obligation()
            .is_some()
    };
    // Product weather phrasings the old bare list missed.
    assert!(live("will it rain today"));
    assert!(live("do I need an umbrella"));
    assert!(live("how hot is it outside"));
    assert!(live("what's the forecast"));
    assert!(live("find the nearest coffee shop"));
    assert!(live("what song is playing"));
    // Word boundaries: "rain" must not fire inside "train"/"brain".
    assert!(!live("how do trains brake"));
    assert!(!live("explain the water cycle"));
    // General-knowledge questions are not live-fact.
    assert!(!live("who painted the mona lisa"));
}

#[test]
fn freshness_nudge_is_suppressed_on_a_locked_device() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let mut locked = unlocked_authorization();
    locked.device_lock_state = DeviceLockState::Locked;
    let tools = AibusToolCatalog::new(&broker, locked, "what's the weather today");
    // The tools the nudge would demand are all hidden when locked, so it
    // must not fire an impossible obligation.
    assert_eq!(tools.final_answer_nudge("It's sunny."), None);
}

#[test]
fn numeric_string_arguments_survive_coercion() {
    // A knowledge query of "1984" must reach the tool as the string "1984",
    // not be rewritten into the JSON number 1984 (which fails String
    // deserialization). Exercised through the shared `args` helper.
    use crate::synapse::catalog::KnowledgeLookupArguments;
    let parsed: KnowledgeLookupArguments =
        args(json!({"query": "1984"})).expect("numeric-looking string query");
    assert_eq!(parsed.query, "1984");
    // Drift repair still works: a JSON-encoded arguments string is parsed.
    let repaired: KnowledgeLookupArguments =
        args(json!("{\"query\": \"tycho brahe\"}")).expect("json-string args repaired");
    assert_eq!(repaired.query, "tycho brahe");
}

#[tokio::test]
async fn broker_rejections_surface_their_reason_for_model_self_repair() {
    let broker = RejectingBroker(
        "this query text is not grounded in the user's request or the recent conversation",
    );
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "look that up");
    let outcome = tools
        .execute(&call("knowledge_lookup", json!({"query": "unrelated"})))
        .await;
    let ToolExecutionOutcome::Observation { ok, content } = outcome else {
        panic!("expected an observation outcome");
    };
    assert!(!ok);
    // The old wording told the model the tool was broken; the body must
    // now contain the actionable rejection reason instead.
    assert!(!content.contains("unavailable right now"), "{content}");
    assert!(content.contains("knowledge_lookup"), "{content}");
    assert!(content.contains("not grounded"), "{content}");
}

#[test]
fn a_current_events_question_owes_evidence_only_when_search_can_answer_it() {
    // Before this, "what happened with X" had no freshness obligation at
    // all, so a tool-free answer from training data was accepted on exactly
    // the question class web_search exists to ground.
    let searchable = SearchCapableBroker(true);
    let tools = AibusToolCatalog::new(
        &searchable,
        unlocked_authorization(),
        "what happened with the harbour tunnel project",
    );
    assert_eq!(
        tools.live_evidence_obligation(),
        Some(LiveEvidenceFamily::CurrentEvents)
    );
    assert!(tools.final_answer_nudge("It opened years ago.").is_some());
    // The nudge must name the tool that can actually answer; the
    // device-scoped list would steer the model away from it.
    let nudge = tools.final_answer_nudge("It opened years ago.").unwrap();
    assert!(nudge.contains("web_search"), "{nudge}");
    assert!(!nudge.contains("current_location"), "{nudge}");

    // No subscription: the obligation would be undischargeable, so it never
    // exists. An unconfigured Pin must not burn a grace iteration.
    let unsearchable = SearchCapableBroker(false);
    let tools = AibusToolCatalog::new(
        &unsearchable,
        unlocked_authorization(),
        "what happened with the harbour tunnel project",
    );
    assert_eq!(tools.live_evidence_obligation(), None);
    assert!(tools.final_answer_nudge("It opened years ago.").is_none());
}

#[tokio::test]
async fn a_web_search_never_discharges_a_device_scoped_obligation() {
    // The staleness this gate exists to prevent: a web snippet must not be
    // allowed to answer "what is playing" or "where am I".
    let broker = SearchCapableBroker(true);
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "what's playing right now",
    );
    assert_eq!(
        tools.live_evidence_obligation(),
        Some(LiveEvidenceFamily::DeviceScoped)
    );

    tools
        .execute(&call("web_search", json!({"query": "what's playing"})))
        .await;

    let nudge = tools.final_answer_nudge("Some song.");
    assert!(
        nudge.is_some(),
        "a web search must not satisfy a device-scoped freshness obligation"
    );
    assert!(nudge.unwrap().contains("current_location"));
}

fn unlocked_authorization() -> AgenticAuthorizationContext {
    AgenticAuthorizationContext {
        excluded_actions: Vec::new(),
        device_lock_state: DeviceLockState::Unlocked,
        enabled_feature_gates: Vec::new(),
        trusted_current_user: true,
    }
}

fn call(name: &str, arguments: Value) -> ToolStepCall {
    ToolStepCall {
        call_id: format!("{name}-1"),
        name: name.to_string(),
        arguments,
    }
}

fn locked_authorization() -> AgenticAuthorizationContext {
    let mut authorization = unlocked_authorization();
    authorization.device_lock_state = DeviceLockState::Locked;
    authorization
}

fn untrusted_authorization() -> AgenticAuthorizationContext {
    let mut authorization = unlocked_authorization();
    authorization.trusted_current_user = false;
    authorization
}

/// A broker that confirms a write and echoes a canned success payload. Its read
/// side is inert — only the write path is exercised through it.
struct WritingBroker;
#[tonic::async_trait]
impl AgenticToolExecutor for WritingBroker {
    async fn execute(
        &self,
        _request: AgenticToolRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        Ok(AgenticToolOutput::Result(json!({"status": "ok"})))
    }

    async fn execute_write(
        &self,
        _request: AgenticWriteRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        Ok(AgenticToolOutput::Result(json!({
            "status": "ok",
            "tool": "remember_fact",
            "remembered": "coffee black",
            "kind": "preference",
        })))
    }
}

fn write_tool_names(tools: &AibusToolCatalog<'_>) -> Vec<&'static str> {
    tools.catalog().into_iter().map(|def| def.name).collect()
}

#[test]
fn remember_fact_is_advertised_only_for_a_trusted_unlocked_user() {
    let broker = WritingBroker;
    let utterance = "remember that I take my coffee black";

    let trusted_unlocked = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
    assert!(
        write_tool_names(&trusted_unlocked).contains(&"remember_fact"),
        "a trusted user on an unlocked device must be offered the write tool"
    );

    let locked = AibusToolCatalog::new(&broker, locked_authorization(), utterance);
    assert!(
        !write_tool_names(&locked).contains(&"remember_fact"),
        "a locked device must not advertise a write it would refuse"
    );

    let untrusted = AibusToolCatalog::new(&broker, untrusted_authorization(), utterance);
    assert!(
        !write_tool_names(&untrusted).contains(&"remember_fact"),
        "an untrusted turn must not advertise a write"
    );
}

#[tokio::test]
async fn remember_fact_refuses_an_untrusted_user() {
    // StaticBroker's execute_write is the trait default (Err). The refusal must
    // come from the trust gate BEFORE the broker is ever consulted, so the exact
    // message — not a generic broker error — is what proves the gate fired.
    let broker = StaticBroker(json!({"status": "ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        untrusted_authorization(),
        "remember that I take my coffee black",
    );
    let outcome = tools
        .execute(&call("remember_fact", json!({"content": "coffee black"})))
        .await;
    match outcome {
        ToolExecutionOutcome::Observation { ok, content } => {
            assert!(!ok, "an untrusted write must not report success");
            assert!(
                content.contains("trusted current user"),
                "expected the trust-gate reason, got {content}"
            );
        }
        other => panic!("expected a refusal observation, got {other:?}"),
    }
}

#[tokio::test]
async fn remember_fact_refuses_a_locked_device() {
    let broker = StaticBroker(json!({"status": "ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        locked_authorization(),
        "remember that I take my coffee black",
    );
    let outcome = tools
        .execute(&call("remember_fact", json!({"content": "coffee black"})))
        .await;
    match outcome {
        ToolExecutionOutcome::Observation { ok, content } => {
            assert!(!ok);
            assert!(
                content.contains("unlocked"),
                "expected the unlock-gate reason, got {content}"
            );
        }
        other => panic!("expected a refusal observation, got {other:?}"),
    }
}

#[tokio::test]
async fn remember_fact_persists_for_a_trusted_unlocked_user() {
    let broker = WritingBroker;
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "Remember that my favorite color is teal.",
    );
    let outcome = tools
        .execute(&call(
            "remember_fact",
            json!({"content": "my favorite color is teal"}),
        ))
        .await;
    assert!(
        matches!(outcome, ToolExecutionOutcome::Observation { ok: true, .. }),
        "a grounded write from a trusted unlocked user must succeed, got {outcome:?}"
    );
}

#[tokio::test]
async fn remember_fact_reports_invalid_arguments() {
    let broker = WritingBroker;
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "remember that I take my coffee black",
    );
    // No `content` field — the build must fail loudly rather than store nothing.
    let outcome = tools
        .execute(&call("remember_fact", json!({"kind": "preference"})))
        .await;
    match outcome {
        ToolExecutionOutcome::Observation { ok, content } => {
            assert!(!ok);
            assert!(
                content.contains("invalid arguments"),
                "expected an argument error, got {content}"
            );
        }
        other => panic!("expected a refusal observation, got {other:?}"),
    }
}

#[test]
fn the_write_surface_is_disjoint_from_reads_and_mutations() {
    use std::collections::BTreeSet;
    let reads: BTreeSet<&str> = read_specs().iter().map(|spec| spec.name).collect();
    let mutations: BTreeSet<&str> = mutation_specs().iter().map(|spec| spec.name).collect();
    for spec in write_specs() {
        assert!(
            !reads.contains(spec.name),
            "write tool '{}' collides with a read tool name",
            spec.name
        );
        assert!(
            !mutations.contains(spec.name),
            "write tool '{}' collides with a mutation name",
            spec.name
        );
        assert!(
            spec.name != PLAY_MUSIC_TOOL,
            "write tool '{}' collides with play_music",
            spec.name
        );
        assert!(
            write_tool_spec(spec.name).is_some(),
            "every write tool must resolve to its own spec"
        );
    }
}

#[test]
fn write_tool_unlock_gate_stays_in_lockstep_with_the_invocation() {
    // The dispatch gate reads the unlock requirement from the tool NAME, before
    // arguments are bound; the broker reads it from the typed INVOCATION. If the
    // two ever disagree, a write is gated one way and executed the other. Build
    // each write and assert the name-mirror equals the method.
    for spec in write_specs() {
        let invocation = (spec.build)(json!({"content": "coffee black"}))
            .expect("every write spec must build from a minimal valid argument set");
        assert_eq!(
            write_tool_name_requires_confirmed_unlock(spec.name),
            invocation.requires_confirmed_unlock(),
            "unlock gate for '{}' disagrees between name and invocation",
            spec.name
        );
    }
}

#[tokio::test]
async fn a_grounded_message_dispatches_as_a_native_action() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "send a message to Sarah saying I'm running late",
    );
    let outcome = tools
        .execute(&call(
            "send_message",
            json!({"to": "Sarah", "message": "I'm running late"}),
        ))
        .await;
    match outcome {
        ToolExecutionOutcome::Terminal(action) => {
            assert_eq!(action.action, native_actions::COMPOSE_MESSAGE);
            assert_eq!(action.arguments["To"], json!(["Sarah"]));
            assert_eq!(action.arguments["Message"], json!("I'm running late"));
        }
        other => panic!("expected a native ComposeMessage, got {other:?}"),
    }
}

#[tokio::test]
async fn a_model_cannot_invent_a_recipient_or_rewrite_the_message() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let utterance = "send a message to Sarah saying I'm running late";
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);

    // A recipient the user never named — the single most damaging thing a
    // messaging tool can get wrong.
    let wrong_person = tools
        .execute(&call(
            "send_message",
            json!({"to": "Mum", "message": "I'm running late"}),
        ))
        .await;
    assert!(
        !matches!(wrong_person, ToolExecutionOutcome::Terminal(_)),
        "an invented recipient must never dispatch",
    );

    // A "helpfully" reworded body is still not what the user said.
    let paraphrased = tools
        .execute(&call(
            "send_message",
            json!({"to": "Sarah", "message": "Apologies, I will be delayed"}),
        ))
        .await;
    assert!(
        !matches!(paraphrased, ToolExecutionOutcome::Terminal(_)),
        "a paraphrased body must never dispatch",
    );
}

#[tokio::test]
async fn a_mutation_the_user_never_asked_for_is_refused() {
    let broker = StaticBroker(json!({"status":"ok"}));
    // Nothing in this turn asks for a call; the model inferred it.
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "who did I speak to yesterday",
    );
    let outcome = tools
        .execute(&call("call_person", json!({"to": "Sarah"})))
        .await;
    assert!(
        !matches!(outcome, ToolExecutionOutcome::Terminal(_)),
        "an unanchored mutation must never dispatch",
    );

    // This mention contains both the action anchor and an exact recipient,
    // but asks about the past rather than authorizing another call.
    let retrospective =
        AibusToolCatalog::new(&broker, unlocked_authorization(), "why did you call Sarah?")
            .execute(&call("call_person", json!({"to": "Sarah"})))
            .await;
    assert!(
        !matches!(retrospective, ToolExecutionOutcome::Terminal(_)),
        "a retrospective mention must never dispatch",
    );
}

#[tokio::test]
async fn natural_alarm_phrasing_now_reaches_the_action() {
    let broker = StaticBroker(json!({"status":"ok"}));
    // "set an alarm" — the article used to defeat the "set alarm" anchor.
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "set an alarm for 7:30");
    match tools
        .execute(&call("set_alarm", json!({"time": "7:30"})))
        .await
    {
        ToolExecutionOutcome::Terminal(action) => {
            assert_eq!(action.action, native_actions::SET_ALARM);
            assert_eq!(action.arguments["time"], json!("7:30"));
        }
        other => panic!("expected a native SetAlarm, got {other:?}"),
    }
}

#[tokio::test]
async fn alarm_qualifiers_must_be_complete_and_exact() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let qualified = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "set an alarm for 7 pm tomorrow",
    );

    match qualified
        .execute(&call(
            "set_alarm",
            json!({"time": "7", "ampm": "pm", "once_day": "tomorrow"}),
        ))
        .await
    {
        ToolExecutionOutcome::Terminal(action) => {
            assert_eq!(action.arguments["time"], "7");
            assert_eq!(action.arguments["ampm"], "pm");
            assert_eq!(action.arguments["onceDay"], "tomorrow");
        }
        other => panic!("complete alarm qualifiers should dispatch: {other:?}"),
    }

    for arguments in [
        json!({"time": "7"}),
        json!({"time": "7", "ampm": "pm"}),
        json!({"time": "7", "once_day": "tomorrow"}),
        json!({"time": "7", "ampm": "am", "once_day": "tomorrow"}),
        json!({"time": "7", "ampm": "pm", "once_day": "today"}),
    ] {
        let outcome = qualified
            .execute(&call("set_alarm", arguments.clone()))
            .await;
        assert!(
            matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
            "omitted or mismatched qualifier dispatched: {arguments} -> {outcome:?}"
        );
    }

    let unqualified =
        AibusToolCatalog::new(&broker, unlocked_authorization(), "set an alarm for 7");
    assert!(matches!(
        unqualified
            .execute(&call("set_alarm", json!({"time": "7"})))
            .await,
        ToolExecutionOutcome::Terminal(_)
    ));
    assert!(matches!(
        unqualified
            .execute(&call("set_alarm", json!({"time": "7", "ampm": "pm"})))
            .await,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));

    let next_monday = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "wake me up at 7 am next monday",
    );
    assert!(matches!(
        next_monday
            .execute(&call(
                "set_alarm",
                json!({"time": "7", "ampm": "am", "once_day": "next monday"}),
            ))
            .await,
        ToolExecutionOutcome::Terminal(_)
    ));
}

#[test]
fn catalog_advertises_authorized_mutations_and_hides_unavailable_ones() {
    let broker = StaticBroker(json!({"status":"ok"}));

    let unlocked = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "send a message to Sarah saying hi",
    );
    let names: Vec<&str> = unlocked.catalog().iter().map(|def| def.name).collect();
    for expected in [
        "play_favorite_tracks",
        "play_featured_music",
        "generate_music_playlist",
        "set_timer",
        "set_alarm",
        "send_message",
        "call_person",
    ] {
        assert!(names.contains(&expected), "missing {expected}: {names:?}");
    }
    assert!(
        !names.contains(&"play_current_track_radio"),
        "stock current-track state is absent from the chat-turn loop, so radio must stay pre-chat-turn: {names:?}"
    );

    let mut locked_auth = unlocked_authorization();
    locked_auth.device_lock_state = DeviceLockState::Locked;
    let locked = AibusToolCatalog::new(&broker, locked_auth, "send a message to Sarah");
    let locked_names: Vec<&str> = locked.catalog().iter().map(|def| def.name).collect();
    assert!(
        !locked_names.contains(&"send_message") && !locked_names.contains(&"call_person"),
        "unlock-required mutations must not be advertised when locked: {locked_names:?}",
    );

    let mut excluded_auth = unlocked_authorization();
    excluded_auth.excluded_actions = vec![native_actions::PLAY_FAVORITE_TRACKS.to_string()];
    let excluded = AibusToolCatalog::new(&broker, excluded_auth, "play my favorites");
    let excluded_names: Vec<&str> = excluded.catalog().iter().map(|def| def.name).collect();
    assert!(!excluded_names.contains(&"play_favorite_tracks"));
    assert!(excluded_names.contains(&"play_featured_music"));

    let mut untrusted_auth = unlocked_authorization();
    untrusted_auth.trusted_current_user = false;
    let untrusted = AibusToolCatalog::new(&broker, untrusted_auth, "play my favorites");
    let untrusted_names: Vec<&str> = untrusted.catalog().iter().map(|def| def.name).collect();
    for mutation in mutation_specs() {
        assert!(
            !untrusted_names.contains(&mutation.name),
            "untrusted turn advertised {}: {untrusted_names:?}",
            mutation.name
        );
    }
    assert!(!untrusted_names.contains(&PLAY_MUSIC_TOOL));
    assert!(
        untrusted_names.contains(&"knowledge_lookup"),
        "read tools should remain available: {untrusted_names:?}"
    );
}

#[tokio::test]
async fn generic_mutation_execution_fails_closed_without_current_turn_trust() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let mut untrusted = unlocked_authorization();
    untrusted.trusted_current_user = false;
    let tools = AibusToolCatalog::new(&broker, untrusted, "set a timer for 5 minutes");

    let outcome = tools
        .execute(&call("set_timer", json!({"minutes": 5})))
        .await;
    assert!(
        matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
        "untrusted generic mutation must not dispatch: {outcome:?}"
    );
}

#[tokio::test]
async fn generic_mutations_require_an_action_specific_outer_command() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for (tool, utterance, arguments) in [
        (
            "set_timer",
            "how do I set a timer for 5 minutes",
            json!({"minutes": 5}),
        ),
        (
            "set_alarm",
            "should I set an alarm for 7:30",
            json!({"time": "7:30"}),
        ),
        (
            "call_person",
            "should I call Sarah?",
            json!({"to": "Sarah"}),
        ),
        (
            "call_person",
            "call Sarah if I say so",
            json!({"to": "Sarah"}),
        ),
        ("call_person", "call Sarah or Bob", json!({"to": "Sarah"})),
        (
            "set_timer",
            "set a timer for 5 minutes hypothetically",
            json!({"minutes": 5}),
        ),
        (
            "send_message",
            "what happens if I say send a message to Sarah saying hello",
            json!({"to": "Sarah", "message": "hello"}),
        ),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        let outcome = tools.execute(&call(tool, arguments)).await;
        assert!(
            matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
            "informational mention dispatched: {utterance:?} -> {outcome:?}"
        );
    }

    // Authority belongs to the outer message command, not words inside its
    // exact payload. The body may itself contain question/hypothetical
    // language without being reinterpreted as an instruction envelope.
    let utterance = "send a message to Sarah saying what happens if I say hello";
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
    let outcome = tools
        .execute(&call(
            "send_message",
            json!({"to": "Sarah", "message": "what happens if I say hello"}),
        ))
        .await;
    assert!(
        matches!(outcome, ToolExecutionOutcome::Terminal(_)),
        "a direct message command with an exact question-shaped body must dispatch: {outcome:?}"
    );

    let cancelled = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "send a message to Sarah saying hello, actually don't",
    )
    .execute(&call(
        "send_message",
        json!({"to": "Sarah", "message": "hello, actually don't"}),
    ))
    .await;
    assert!(matches!(
        cancelled,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));

    let quoted_body = "hello, actually don't";
    let quoted = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "send a message to Sarah saying \"hello, actually don't\"",
    )
    .execute(&call(
        "send_message",
        json!({"to": "Sarah", "message": quoted_body}),
    ))
    .await;
    assert!(matches!(quoted, ToolExecutionOutcome::Terminal(_)));

    for utterance in ["set a timer for 5 minutes", "set a timer for five minutes"] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        assert!(matches!(
            tools
                .execute(&call("set_timer", json!({"minutes": 5})))
                .await,
            ToolExecutionOutcome::Terminal(_)
        ));
    }

    for arguments in [
        json!({}),
        json!({"minutes": 5, "seconds": 5}),
        json!({"minutes": 10}),
    ] {
        let tools = AibusToolCatalog::new(
            &broker,
            unlocked_authorization(),
            "set a timer for 5 minutes",
        );
        assert!(matches!(
            tools.execute(&call("set_timer", arguments)).await,
            ToolExecutionOutcome::Observation { ok: false, .. }
        ));
    }

    let contrasted_timer = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "set a timer for 10 minutes instead of 5 minutes",
    );
    assert!(matches!(
        contrasted_timer
            .execute(&call("set_timer", json!({"minutes": 5})))
            .await,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));
    assert!(matches!(
        contrasted_timer
            .execute(&call("set_timer", json!({"minutes": 10})))
            .await,
        ToolExecutionOutcome::Terminal(_)
    ));

    let grammatical_am = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "set an alarm for 7 because I am tired",
    );
    assert!(matches!(
        grammatical_am
            .execute(&call("set_alarm", json!({"time": "7", "ampm": "am"})))
            .await,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));
    assert!(matches!(
        grammatical_am
            .execute(&call("set_alarm", json!({"time": "7"})))
            .await,
        ToolExecutionOutcome::Terminal(_)
    ));
}

#[tokio::test]
async fn informational_phrasing_reaches_argument_free_device_reads() {
    // "How much battery do I have left?" is not a mention of the battery; it
    // is the request. These four reads are the complete, literal exemption.
    let broker = StaticBroker(json!({"status":"ok"}));
    for (tool, action, utterance) in [
        (
            "get_battery_level",
            native_actions::GET_BATTERY_LEVEL,
            "how much battery do I have left",
        ),
        (
            "get_current_volume",
            native_actions::GET_CURRENT_VOLUME,
            "what's the volume right now",
        ),
        (
            "get_music_queue",
            native_actions::GET_MUSIC_QUEUE,
            "what's next in the queue",
        ),
        (
            "am_i_online",
            native_actions::AM_I_ONLINE,
            "do I have internet right now",
        ),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        let outcome = tools.execute(&call(tool, json!({}))).await;
        match outcome {
            ToolExecutionOutcome::Terminal(action_taken) => {
                assert_eq!(action_taken.action, action, "{utterance:?}");
                assert_eq!(action_taken.arguments, json!({}), "{utterance:?}");
            }
            other => panic!("{utterance:?} was refused: {other:?}"),
        }
    }
}

#[test]
fn argument_free_reads_ground_against_the_catalog_for_natural_phrasing() {
    use crate::synapse::catalog::{enforce_mutation_grounding, native_action_spec};

    for (action, utterance) in [
        (
            native_actions::GET_BATTERY_LEVEL,
            "how much battery do I have left",
        ),
        (
            native_actions::GET_CURRENT_VOLUME,
            "what's the volume right now",
        ),
        (native_actions::GET_MUSIC_QUEUE, "what's next in the queue"),
        (native_actions::AM_I_ONLINE, "do I have internet right now"),
    ] {
        let spec = native_action_spec(action).expect(action);
        assert!(
            enforce_mutation_grounding(spec, &json!({}), utterance).is_ok(),
            "{action} must accept {utterance:?} — second gate, independent of the tool gate"
        );
    }
}

#[test]
fn informational_device_reads_complete_when_the_model_only_talks() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "how much battery do I have left",
    );
    let forced = tools
        .forced_terminal_action("I can't check the battery.")
        .expect("an argument-free read must complete deterministically");
    assert_eq!(forced.action, native_actions::GET_BATTERY_LEVEL);
    assert_eq!(forced.arguments, json!({}));
}

#[tokio::test]
async fn informational_phrasing_still_refuses_state_changing_actions() {
    // This is the gate that stops a question about an action from performing
    // it. Every row covers both model-chosen and deterministic completion.
    let broker = StaticBroker(json!({"status":"ok"}));
    for (tool, utterance, arguments) in [
        (
            "set_timer",
            "how do I set a timer for 5 minutes",
            json!({"minutes": 5}),
        ),
        (
            "set_alarm",
            "how do I set an alarm for 7:30",
            json!({"time": "7:30"}),
        ),
        ("call_person", "how do I call Sarah", json!({"to": "Sarah"})),
        (
            "send_message",
            "how do I send a message to Sarah",
            json!({"to":"Sarah","message":"hello"}),
        ),
        ("increment_volume", "how do I turn the volume up", json!({})),
        ("pause_music", "how do I pause the music", json!({})),
        ("next_track", "how do I skip a song", json!({})),
        (
            "play_favorite_tracks",
            "how do I play my favorites",
            json!({}),
        ),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        let outcome = tools.execute(&call(tool, arguments)).await;
        assert!(
            matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
            "informational phrasing dispatched a state change: {utterance:?} -> {outcome:?}"
        );
        let forced = tools.forced_terminal_action("Here's how.");
        assert!(
            forced.is_none(),
            "informational phrasing force-completed a state change: {utterance:?} -> {forced:?}"
        );
    }
}

#[test]
fn the_read_exemption_does_not_reach_the_music_command_gates() {
    assert!(!authoritative_play_music_command("how do I play Beat It"));
    assert!(!authoritative_play_music_command(
        "what happens if I play Beat It"
    ));
    assert!(generated_playlist_requested_topic("how do I make a playlist for running").is_none());
}

#[test]
fn informational_read_exemption_is_literal_and_catalog_audited() {
    use crate::synapse::catalog::KeyguardBehavior;

    assert_eq!(
        INFORMATIONAL_PREFIX_EXEMPT_READS,
        &[
            native_actions::GET_BATTERY_LEVEL,
            native_actions::GET_CURRENT_VOLUME,
            native_actions::GET_MUSIC_QUEUE,
            native_actions::AM_I_ONLINE,
        ],
        "the exemption must remain a reviewed literal allowlist",
    );
    for action in INFORMATIONAL_PREFIX_EXEMPT_READS {
        let spec = native_action_spec(action).expect(action);
        assert!(spec.arguments.is_empty(), "{action} must take no arguments");
        assert_eq!(
            spec.keyguard,
            KeyguardBehavior::Allowed,
            "{action} must stay keyguard-safe",
        );
    }

    for forbidden in [
        native_actions::GET_CURRENT_TIME,
        native_actions::CAPTURE_PHOTOGRAPH,
        native_actions::INCREMENT_VOLUME,
    ] {
        assert!(
            !INFORMATIONAL_PREFIX_EXEMPT_READS.contains(&forbidden),
            "{forbidden} must stay outside the exemption",
        );
    }

    let current_time = mutation_specs()
        .iter()
        .find(|mutation| mutation.action == native_actions::GET_CURRENT_TIME)
        .expect("GetCurrentTime mutation exists");
    assert!(
        !generic_mutation_command_intent(current_time, "what time is it in Tokyo", &json!({}),),
        "GetCurrentTime must not turn a world-time question into a local-time read",
    );

    let camera = AdvertisedMutationTool {
        name: "capture_photograph",
        action: native_actions::CAPTURE_PHOTOGRAPH,
        description: "test-only camera mutation",
        parameters: || json!({"type": "object", "properties": {}}),
        build: |_| json!({}),
    };
    assert!(
        !generic_mutation_command_intent(&camera, "how do I take a photo", &json!({})),
        "a camera question must never become a camera command",
    );
}

#[tokio::test]
async fn fieldless_music_mutations_dispatch_for_direct_polite_commands() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for (tool, utterance, expected_action) in [
        (
            "play_favorite_tracks",
            "could you please play my favorites",
            native_actions::PLAY_FAVORITE_TRACKS,
        ),
        (
            "play_featured_music",
            "please play something featured",
            native_actions::PLAY_FEATURED_MUSIC,
        ),
        (
            "play_featured_music",
            "could you play something",
            native_actions::PLAY_FEATURED_MUSIC,
        ),
        (
            "play_favorite_tracks",
            "I'd like to play my favorites",
            native_actions::PLAY_FAVORITE_TRACKS,
        ),
        (
            "play_favorite_tracks",
            "could you put on my favourites",
            native_actions::PLAY_FAVORITE_TRACKS,
        ),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        match tools.execute(&call(tool, json!({}))).await {
            ToolExecutionOutcome::Terminal(action) => {
                assert_eq!(action.action, expected_action, "utterance: {utterance}");
                assert_eq!(action.arguments, json!({}), "utterance: {utterance}");
            }
            other => panic!("expected {expected_action} for {utterance:?}, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn generated_playlist_maps_only_an_exact_nonempty_user_span() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let utterance = "could you make a playlist for running";
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);

    match tools
        .execute(&call(
            "generate_music_playlist",
            json!({"playlist": "running"}),
        ))
        .await
    {
        ToolExecutionOutcome::Terminal(action) => {
            assert_eq!(action.action, native_actions::GENERATE_MUSIC_PLAYLIST);
            assert_eq!(action.arguments, json!({"Playlist": "running"}));
        }
        other => panic!("expected GenerateMusicPlaylist, got {other:?}"),
    }

    for arguments in [
        json!({"playlist": "focus"}),
        json!({"playlist": "run"}),
        json!({}),
        json!({"playlist": ""}),
    ] {
        let outcome = tools
            .execute(&call("generate_music_playlist", arguments.clone()))
            .await;
        assert!(
            matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
            "invalid playlist arguments dispatched: {arguments} -> {outcome:?}"
        );
    }

    let quoted = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "make a playlist for \"rainy days\"",
    );
    assert!(matches!(
        quoted
            .execute(&call(
                "generate_music_playlist",
                json!({"playlist": "rainy days"}),
            ))
            .await,
        ToolExecutionOutcome::Terminal(_)
    ));

    let contrasted = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "make a playlist for running instead of jazz",
    );
    let excluded = contrasted
        .execute(&call(
            "generate_music_playlist",
            json!({"playlist": "jazz"}),
        ))
        .await;
    assert!(
        matches!(
            excluded,
            ToolExecutionOutcome::Observation { ok: false, .. }
        ),
        "an excluded alternative must not become the playlist topic: {excluded:?}"
    );
    let requested = contrasted
        .execute(&call(
            "generate_music_playlist",
            json!({"playlist": "running"}),
        ))
        .await;
    assert!(
        matches!(requested, ToolExecutionOutcome::Terminal(_)),
        "the deterministically requested topic should remain valid: {requested:?}"
    );

    let hypothetical = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "make a playlist for running hypothetically",
    );
    assert!(matches!(
        hypothetical
            .execute(&call(
                "generate_music_playlist",
                json!({"playlist": "running hypothetically"}),
            ))
            .await,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));

    let punctuated = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "make a playlist for rainy-days",
    );
    assert!(matches!(
        punctuated
            .execute(&call(
                "generate_music_playlist",
                json!({"playlist": "rainy days"}),
            ))
            .await,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));
    match punctuated
        .execute(&call(
            "generate_music_playlist",
            json!({"playlist": "rainy-days"}),
        ))
        .await
    {
        ToolExecutionOutcome::Terminal(action) => {
            assert_eq!(action.arguments["Playlist"], "rainy-days");
        }
        other => panic!("exact deterministic playlist topic should dispatch: {other:?}"),
    }

    let benign_and = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "make a playlist for work and play",
    );
    assert!(matches!(
        benign_and
            .execute(&call(
                "generate_music_playlist",
                json!({"playlist": "work and play"}),
            ))
            .await,
        ToolExecutionOutcome::Terminal(_)
    ));
}

#[tokio::test]
async fn direct_music_mutations_reject_mentions_negation_and_compounds() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for (tool, utterance, arguments) in [
        (
            "play_favorite_tracks",
            "what happens if I say play my favorites",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "please explain \"play my favorites\"",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "do not play my favorites",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "play my favorites and text Sarah",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "favorite tracks are a nice feature",
            json!({}),
        ),
        (
            "play_current_track_radio",
            "track radio is a nice feature",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "play anything but my favorite tracks",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "do not put on my favourites",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "call Sarah and put on my favourites",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "should I put on my favourites",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "hypothetically, play my favorites",
            json!({}),
        ),
        (
            "play_featured_music",
            "play something other than featured music",
            json!({}),
        ),
        (
            "play_featured_music",
            "play something, not featured music",
            json!({}),
        ),
        (
            "play_favorite_tracks",
            "play Favorite Tracks by Prince",
            json!({}),
        ),
        (
            "generate_music_playlist",
            "how do I create a playlist for running",
            json!({"playlist": "running"}),
        ),
        (
            "generate_music_playlist",
            "make a playlist for running and then call Sarah",
            json!({"playlist": "running"}),
        ),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        let outcome = tools.execute(&call(tool, arguments)).await;
        assert!(
            matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
            "non-command dispatched: {utterance} -> {outcome:?}"
        );
    }
}

#[tokio::test]
async fn catalog_music_mutations_reject_bounded_cancellation_suffixes() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for (tool, utterance, arguments) in [
        (
            "play_favorite_tracks",
            "play my favorites scratch that",
            json!({}),
        ),
        (
            "play_featured_music",
            "play something forget that please",
            json!({}),
        ),
        (
            "generate_music_playlist",
            "make a playlist for running not now",
            json!({"playlist": "running not now"}),
        ),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        let outcome = tools.execute(&call(tool, arguments)).await;
        assert!(
            matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
            "cancelled command dispatched: {utterance} -> {outcome:?}"
        );
    }
}

#[tokio::test]
async fn current_track_radio_stays_on_the_deterministic_pre_chat_turn_path() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "play similar songs",
        "track radio",
        "play current track radio",
        "start a radio from this track",
        "play more like this",
        "please play songs like this",
        "put on tracks like this",
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        let names: Vec<&str> = tools
            .catalog()
            .iter()
            .map(|definition| definition.name)
            .collect();
        assert!(
            !names.contains(&"play_current_track_radio"),
            "the chat-turn loop advertised a mutation whose stock current-track state it does not contain: {utterance}"
        );
        let outcome = tools
            .execute(&call("play_current_track_radio", json!({})))
            .await;
        assert!(
            matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
            "the chat-turn loop dispatched current-track radio without stock state: {utterance} -> {outcome:?}"
        );
        assert_eq!(
            tools.final_answer_nudge("Okay."),
            None,
            "current-track radio was reinterpreted as catalog playback: {utterance}"
        );
    }
}

#[test]
fn catalog_hides_unlock_required_reads_when_locked() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let mut locked = unlocked_authorization();
    locked.device_lock_state = DeviceLockState::Locked;
    let tools = AibusToolCatalog::new(&broker, locked, "what is the time");
    let names: Vec<&str> = tools.catalog().iter().map(|def| def.name).collect();
    assert!(names.contains(&"knowledge_lookup"));
    assert!(
        !names.contains(&"memory_search"),
        "private reads must not be advertised on a locked device: {names:?}"
    );
}

#[test]
fn play_music_is_not_advertised_without_current_turn_trust() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let mut untrusted = unlocked_authorization();
    untrusted.trusted_current_user = false;
    let tools = AibusToolCatalog::new(&broker, untrusted, "play something");
    let names: Vec<&str> = tools.catalog().iter().map(|def| def.name).collect();
    assert!(!names.contains(&PLAY_MUSIC_TOOL));
}

#[test]
fn knowledge_lookup_executes_with_plain_args() {
    let broker = StaticBroker(json!({
        "status": "ok", "query": "Denmark", "title": "Denmark",
        "extract": "A Nordic country.", "source_url": "https://example.test"
    }));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "tell me about denmark");
    let outcome = futures::executor::block_on(
        tools.execute(&call("knowledge_lookup", json!({"query": "Denmark"}))),
    );
    match outcome {
        ToolExecutionOutcome::Observation { ok, content } => {
            assert!(ok);
            assert!(content.contains("Nordic"));
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[test]
fn json_string_arguments_are_coerced() {
    let broker = StaticBroker(
        json!({"status":"ok","query":"Denmark","title":"Denmark","extract":"x","source_url":"u"}),
    );
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "tell me about denmark");
    let outcome = futures::executor::block_on(tools.execute(&call(
        "knowledge_lookup",
        Value::String(r#"{"query":"Denmark"}"#.to_string()),
    )));
    assert!(matches!(
        outcome,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));
}

#[test]
fn unknown_tool_and_bad_args_fail_as_observations() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "whatever");
    let unknown = futures::executor::block_on(tools.execute(&call("evil_tool", json!({}))));
    assert!(matches!(
        unknown,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));
    let bad =
        futures::executor::block_on(tools.execute(&call("knowledge_lookup", json!({"nope": 1}))));
    assert!(matches!(
        bad,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));
}

#[test]
fn play_music_resolves_rank_one_from_a_stored_provider_result() {
    let broker = StaticBroker(json!({
        "status": "ok",
        "artist": "Michael Jackson",
        "tracks": [
            {"rank": 1, "title": "Smooth Criminal", "artists": ["Michael Jackson"], "album": "Bad"},
            {"rank": 2, "title": "Beat It", "artists": ["Michael Jackson"]}
        ]
    }));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "look up the best songs by michael jackson and play the top one",
    );
    // First the read (stores the provider result under its call id).
    let read = futures::executor::block_on(tools.execute(&call(
        "music_artist_top_tracks",
        json!({"artist": "Michael Jackson"}),
    )));
    assert!(matches!(
        read,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));
    // Then the mutation referencing that call id.
    let play = futures::executor::block_on(tools.execute(&call(
        "play_music",
        json!({"from_call_id": "music_artist_top_tracks-1"}),
    )));
    match play {
        ToolExecutionOutcome::Terminal(action) => {
            assert_eq!(action.action, native_actions::PLAY_MUSIC);
            assert_eq!(action.arguments["Track"], "Smooth Criminal");
            assert_eq!(action.arguments["Artist"], "Michael Jackson");
        }
        other => panic!("expected terminal PlayMusic, got {other:?}"),
    }
}

#[tokio::test]
async fn play_music_rejects_unsafe_turns_even_with_a_same_run_result() {
    let broker = StaticBroker(json!({
        "status": "ok",
        "artist": "Example Artist",
        "tracks": [{"rank": 1, "title": "Example Track", "artists": ["Example Artist"]}]
    }));

    for (utterance, trusted) in [
        ("what happens if I say play music", true),
        ("do not play music", true),
        ("should I play music?", true),
        ("I heard you play music yesterday", true),
        ("\"play music\"", true),
        ("play Example Track hypothetically", true),
        ("play Example Track if I say so", true),
        ("play Example Track and call Sarah", true),
        ("play Example Track but do not play it", true),
        ("\"play Example Track\" is just a phrase", true),
        ("play Example Track\" actually don't", true),
        ("play \"Example Track actually don't", true),
        ("play Example Track scratch that", true),
        ("play Example Track forget that", true),
        ("play Example Track not now", true),
        ("play my favorites", true),
        ("listen to my favorites", true),
        ("play something", true),
        ("play current track radio", true),
        ("put on songs like this", true),
        ("play music", false),
    ] {
        let mut authorization = unlocked_authorization();
        authorization.trusted_current_user = trusted;
        let tools = AibusToolCatalog::new(&broker, authorization, utterance);
        let read = tools
            .execute(&call(
                "music_artist_top_tracks",
                json!({"artist": "Example Artist"}),
            ))
            .await;
        assert!(
            matches!(read, ToolExecutionOutcome::Observation { ok: true, .. }),
            "test setup must retain a valid same-run provider result: {read:?}"
        );
        let play = tools
            .execute(&call(
                "play_music",
                json!({"from_call_id": "music_artist_top_tracks-1"}),
            ))
            .await;
        assert!(
            matches!(play, ToolExecutionOutcome::Observation { ok: false, .. }),
            "unsafe turn dispatched despite same-run evidence: {utterance:?} -> {play:?}"
        );
    }
}

#[tokio::test]
async fn play_music_rejects_same_run_results_for_invented_search_targets() {
    for (tool_name, search_arguments, provider_result) in [
        (
            "music_artist_top_tracks",
            json!({"artist": "Invented Artist"}),
            json!({
                "status": "ok",
                "artist": "Invented Artist",
                "tracks": [{
                    "rank": 1,
                    "title": "Invented Track",
                    "artists": ["Invented Artist"]
                }]
            }),
        ),
        (
            "music_catalog_search",
            json!({"query": "Invented Track", "kind": "track"}),
            json!({
                "status": "ok",
                "query": "Invented Track",
                "tracks": [{
                    "rank": 1,
                    "title": "Invented Track",
                    "artists": ["Invented Artist"]
                }]
            }),
        ),
    ] {
        let broker = StaticBroker(provider_result);
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "play Example Track")
            .with_entry_intent(Some(play_intent(true)));
        let read = tools.execute(&call(tool_name, search_arguments)).await;
        assert!(
            matches!(read, ToolExecutionOutcome::Observation { ok: true, .. }),
            "test setup needs a successful same-run result: {read:?}"
        );
        let play = tools
            .execute(&call(
                "play_music",
                json!({"from_call_id": format!("{tool_name}-1")}),
            ))
            .await;
        assert!(
            matches!(play, ToolExecutionOutcome::Observation { ok: false, .. }),
            "invented search target gained mutation authority: {tool_name} -> {play:?}"
        );
        let nudge = tools
            .final_answer_nudge("Playing.")
            .expect("an invented search result must not satisfy the catalog obligation");
        assert!(nudge.contains("music_catalog_search"), "{nudge}");
        assert!(
            !nudge.contains(&format!("{tool_name}-1")),
            "nudge cited an ungrounded provider result: {nudge}"
        );
    }
}

#[tokio::test]
async fn play_music_rejects_partial_or_non_playback_search_spans() {
    for (utterance, query) in [
        ("play Example Track", "Example"),
        ("look up weather and play jazz", "weather"),
        ("play songs by Example Artist", "songs"),
        ("play tracks by Example Artist", "tracks"),
        ("play albums by Example Artist", "albums"),
        ("play hits by Example Artist", "hits"),
        ("play popular songs by Example Artist", "popular songs"),
        ("play all songs by Example Artist", "all songs"),
        ("play old tracks by Example Artist", "old tracks"),
        ("play new albums by Example Artist", "new albums"),
        ("play popular tunes by Example Artist", "popular tunes"),
        ("play new releases by Example Artist", "new releases"),
        ("play classic records by Example Artist", "classic records"),
        ("play recent singles by Example Artist", "recent singles"),
        ("play their catalogue by Example Artist", "their catalogue"),
        ("play Example Track by Example Artist", "Example Track"),
        ("play Example Track by Example Artist", "Example Artist"),
    ] {
        let broker = StaticBroker(json!({
            "status": "ok",
            "query": query,
            "tracks": [{
                "rank": 1,
                "title": "Different Track",
                "artists": ["Different Artist"]
            }]
        }));
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        assert!(matches!(
            tools
                .execute(&call(
                    "music_catalog_search",
                    json!({"query": query, "kind": "track"}),
                ))
                .await,
            ToolExecutionOutcome::Observation { ok: true, .. }
        ));
        let play = tools
            .execute(&call(
                "play_music",
                json!({"from_call_id": "music_catalog_search-1"}),
            ))
            .await;
        assert!(
            matches!(play, ToolExecutionOutcome::Observation { ok: false, .. }),
            "non-target span gained playback authority: {utterance:?}, {query:?} -> {play:?}"
        );
    }
}

#[tokio::test]
async fn play_music_accepts_exact_track_artist_and_genre_targets() {
    for (tool_name, utterance, search_arguments, provider_result) in [
        (
            "music_catalog_search",
            "play Example Track",
            json!({"query": "Example Track", "kind": "track"}),
            json!({
                "status": "ok",
                "query": "Example Track",
                "tracks": [{"rank": 1, "title": "Example Track", "artists": ["Artist"]}]
            }),
        ),
        (
            "music_artist_top_tracks",
            "play Prince",
            json!({"artist": "Prince"}),
            json!({
                "status": "ok",
                "artist": "Prince",
                "tracks": [{"rank": 1, "title": "Kiss", "artists": ["Prince"]}]
            }),
        ),
        (
            "music_catalog_search",
            "play jazz",
            json!({"query": "jazz"}),
            json!({
                "status": "ok",
                "query": "jazz",
                "tracks": [{"rank": 1, "title": "Jazz Track", "artists": ["Artist"]}]
            }),
        ),
        (
            "music_catalog_search",
            "look up weather and play jazz",
            json!({"query": "jazz"}),
            json!({
                "status": "ok",
                "query": "jazz",
                "tracks": [{"rank": 1, "title": "Jazz Track", "artists": ["Artist"]}]
            }),
        ),
        (
            "music_catalog_search",
            "play songs by Example Artist",
            json!({"query": "Example Artist", "kind": "artist"}),
            json!({
                "status": "ok",
                "query": "Example Artist",
                "tracks": [{"rank": 1, "title": "Example Song", "artists": ["Example Artist"]}]
            }),
        ),
        (
            "music_catalog_search",
            "play songs by Example Artist",
            json!({"query": "songs by Example Artist"}),
            json!({
                "status": "ok",
                "query": "songs by Example Artist",
                "tracks": [{"rank": 1, "title": "Example Song", "artists": ["Example Artist"]}]
            }),
        ),
        (
            "music_catalog_search",
            "play Example Track by Example Artist",
            json!({"query": "Example Track by Example Artist", "kind": "track"}),
            json!({
                "status": "ok",
                "query": "Example Track by Example Artist",
                "tracks": [{"rank": 1, "title": "Example Track", "artists": ["Example Artist"]}]
            }),
        ),
    ] {
        let broker = StaticBroker(provider_result);
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        assert!(matches!(
            tools.execute(&call(tool_name, search_arguments)).await,
            ToolExecutionOutcome::Observation { ok: true, .. }
        ));
        let play = tools
            .execute(&call(
                "play_music",
                json!({"from_call_id": format!("{tool_name}-1")}),
            ))
            .await;
        assert!(
            matches!(play, ToolExecutionOutcome::Terminal(_)),
            "exact playback target was rejected: {utterance:?} -> {play:?}"
        );
    }
}

#[tokio::test]
async fn play_music_accepts_a_grounded_balanced_quoted_search_target() {
    let broker = StaticBroker(json!({
        "status": "ok",
        "query": "Example Track",
        "tracks": [{
            "rank": 1,
            "title": "Example Track",
            "artists": ["Example Artist"]
        }]
    }));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "play \"Example Track\"");
    assert!(matches!(
        tools
            .execute(&call(
                "music_catalog_search",
                json!({"query": "Example Track", "kind": "track"}),
            ))
            .await,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));
    let play = tools
        .execute(&call(
            "play_music",
            json!({"from_call_id": "music_catalog_search-1"}),
        ))
        .await;
    assert!(
        matches!(play, ToolExecutionOutcome::Terminal(_)),
        "balanced quoted target should remain playable: {play:?}"
    );
}

#[tokio::test]
async fn play_music_binds_provider_search_to_the_requested_side_of_an_exclusion() {
    for (utterance, query, should_dispatch) in [
        ("play jazz instead of my favorites", "jazz", true),
        ("play jazz instead of my favorites", "my favorites", false),
        ("play jazz instead my favorites", "jazz", true),
        ("play jazz not my favorites", "my favorites", false),
    ] {
        let broker = StaticBroker(json!({
            "status": "ok",
            "query": query,
            "tracks": [{
                "rank": 1,
                "title": query,
                "artists": ["Example Artist"]
            }]
        }));
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        assert!(matches!(
            tools
                .execute(&call(
                    "music_catalog_search",
                    json!({"query": query, "kind": "track"}),
                ))
                .await,
            ToolExecutionOutcome::Observation { ok: true, .. }
        ));
        let play = tools
            .execute(&call(
                "play_music",
                json!({"from_call_id": "music_catalog_search-1"}),
            ))
            .await;
        assert_eq!(
            matches!(play, ToolExecutionOutcome::Terminal(_)),
            should_dispatch,
            "wrong exclusion-side authority for {utterance:?}, query {query:?}: {play:?}"
        );
    }
}

#[test]
fn play_music_with_a_bogus_call_id_fails_as_an_observation() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "play music");
    let play = futures::executor::block_on(
        tools.execute(&call("play_music", json!({"from_call_id": "nope"}))),
    );
    assert!(matches!(
        play,
        ToolExecutionOutcome::Observation { ok: false, .. }
    ));
}

#[test]
fn every_registered_read_tool_has_a_progress_cue() {
    // Keep the selected-operation side channel complete even while the
    // production sink is fail-closed. A future spoken-only consumer must
    // never fall back to raw arguments or model prose for a missing entry.
    let specs = read_specs();
    assert!(!specs.is_empty(), "the read registry must not be empty");
    for spec in specs {
        assert!(
            !spec.cue.trim().is_empty(),
            "read tool '{}' has no progress cue",
            spec.name
        );
    }
}

#[test]
fn cue_uses_the_first_read_in_the_batch_and_names_only() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "weather");
    assert_eq!(
        tools.cue_for(&["current_weather", "knowledge_lookup"]),
        Some("Checking the forecast".to_string())
    );
    assert_eq!(tools.cue_for(&["play_music"]), None);
    assert_eq!(tools.cue_for(&[]), None);
}

fn play_intent(autocomplete: bool) -> crate::nlu::triggering::EntryIntent {
    crate::nlu::triggering::EntryIntent {
        intent: "Play".to_string(),
        distance: 1.0,
        slot: 0,
        autocomplete,
    }
}

fn slots(track: Option<&str>, artist: Option<&str>) -> crate::nlu::ner_post::NerSlots {
    crate::nlu::ner_post::NerSlots {
        track: track.map(str::to_string),
        artist: artist.map(str::to_string),
        album: None,
        genre: None,
        average_confidence: 0.97,
    }
}

/// Native actions deliberately NOT offered to the model, with the reason.
///
/// The repository contract keeps stock/local deterministic paths ahead of
/// general model planning and forbids routing immediate device facts or
/// exact local controls through a model-backed planner. Everything here is
/// excluded on that basis, not by oversight.
const DELIBERATELY_NOT_EXPOSED: &[(&str, &str)] = &[
    // Instant local controls and device facts — stock owns these.
    (native_actions::ACCEPT_CALL, "call control is stock/local"),
    (native_actions::END_CALL, "call control is stock/local"),
    (native_actions::RESUME_CALL, "call control is stock/local"),
    (
        native_actions::PLAY_CURRENT_TRACK_RADIO,
        "stock current-track state stays on the deterministic pre-chat-turn path",
    ),
    (native_actions::GET_CURRENT_LOCATION, "served by the current_location read tool"),
    (native_actions::DEVICE_STATUS, "immediate device fact"),
    (native_actions::GET_SERIAL_NUMBER, "device identifier, never model-facing"),
    (native_actions::GET_PHONE_NUMBER, "subscriber identifier, never model-facing"),
    (native_actions::GET_AIRPLANE_MODE_STATUS, "immediate device fact"),
    (native_actions::GET_BLUETOOTH_STATUS, "immediate device fact"),
    (native_actions::GET_NEW_BLUETOOTH_ADDRESS, "device identifier, never model-facing"),
    (native_actions::GET_PAIRED_BLUETOOTH_ADDRESS, "device identifier, never model-facing"),
    (native_actions::CONNECT_TO_BLUETOOTH, "immediate local control"),
    (native_actions::DISCONNECT_BLUETOOTH, "immediate local control"),
    (native_actions::LOCK_DEVICE, "security-relevant local control"),
    (native_actions::ENTER_PRIVACY_MODE, "security-relevant local control"),
    (native_actions::SETTINGS, "settings surface is stock-owned"),
    (native_actions::SET_DEFAULT_TRANSLATE_LANGUAGE, "NO VERIFIED HANDLER: server emits Translate{Target} and assumes stock converts it; unproven"),
    (native_actions::SET_QUICK_MESSAGING_CONTACT, "settings surface is stock-owned"),
    (native_actions::CHANGE_QUICK_ACTION, "settings surface is stock-owned"),
    (native_actions::GET_QUICK_MESSAGING_PARTICIPANTS, "immediate device fact"),
    // Exact stock settings/contact/lifecycle routes. They are reachable through
    // native_device_actions.rs but never advertised as free-form model tools.
    (native_actions::CONNECT_TO_WIFI, "deterministic stock Wi-Fi setup route"),
    (native_actions::CREATE_CONTACT, "bounded deterministic contact route"),
    (native_actions::DISCONNECT_WIFI, "deterministic stock Wi-Fi route"),
    (native_actions::FACTORY_RESET, "deterministic stock confirmation route"),
    (native_actions::REBOOT, "deterministic stock power route"),
    (native_actions::SET_UP_TOUCHCODE, "deterministic stock enrollment route"),
    (native_actions::TRUST_LOCK, "deterministic stock trust route"),
    (native_actions::TURN_OFF_AIRPLANE_MODE, "deterministic stock radio route"),
    (native_actions::TURN_OFF_AMBER_ALERT, "deterministic stock alert route"),
    (native_actions::TURN_OFF_BLUETOOTH, "deterministic stock radio route"),
    (native_actions::TURN_OFF_CELLULAR_DATA, "deterministic stock modem route"),
    (native_actions::TURN_OFF_CELLULAR_ROAMING, "deterministic stock modem route"),
    (native_actions::TURN_OFF_DEVICE, "deterministic stock power route"),
    (native_actions::TURN_OFF_EMERGENCY_ALERT, "deterministic stock alert route"),
    (native_actions::TURN_OFF_PUBLIC_SAFETY_ALERT, "deterministic stock alert route"),
    (native_actions::TURN_OFF_WIFI, "deterministic stock radio route"),
    (native_actions::TURN_ON_AIRPLANE_MODE, "deterministic stock radio route"),
    (native_actions::TURN_ON_AMBER_ALERT, "deterministic stock alert route"),
    (native_actions::TURN_ON_BLUETOOTH, "deterministic stock radio route"),
    (native_actions::TURN_ON_CELLULAR_DATA, "deterministic stock modem route"),
    (native_actions::TURN_ON_CELLULAR_ROAMING, "deterministic stock modem route"),
    (native_actions::TURN_ON_EMERGENCY_ALERT, "deterministic stock alert route"),
    (native_actions::TURN_ON_PUBLIC_SAFETY_ALERT, "deterministic stock alert route"),
    (native_actions::TURN_ON_WIFI, "deterministic stock radio route"),
    (native_actions::WIFI_QR_SCAN, "deterministic stock Wi-Fi scanner route"),
    // Timer/alarm inspection and editing — stock surfaces own these.
    (native_actions::ALARM, "stock alarm surface"),
    (native_actions::TIMER, "stock timer surface"),
    (native_actions::CANCEL_ALARM, "stock alarm surface"),
    (native_actions::DISPLAY_ALARM, "stock alarm surface"),
    (native_actions::DELETE_TIMER, "stock timer surface"),
    (native_actions::DISPLAY_TIMER, "stock timer surface"),
    (native_actions::EDIT_TIMER, "stock timer surface"),
    (native_actions::PAUSE_TIMER, "stock timer surface"),
    (native_actions::RESUME_TIMER, "stock timer surface"),
    (native_actions::WORLD_CLOCK, "stock clock surface"),
    // Navigation/display intents: stock presentation, not planning.
    (native_actions::DISPLAY_CONTACT, "stock presentation surface"),
    (native_actions::DISPLAY_MESSAGES, "stock presentation surface"),
    (native_actions::OPEN_CONTACTS, "stock navigation surface"),
    (native_actions::OPEN_DIALER_HOME, "stock navigation surface"),
    (native_actions::OPEN_DIALPAD, "stock navigation surface"),
    (native_actions::OPEN_MESSAGES_MAIN_MENU, "stock navigation surface"),
    (native_actions::OPEN_RECENT_CALLS, "stock navigation surface"),
    (native_actions::OPEN_RECENT_PHOTOS, "stock navigation surface"),
    (native_actions::OPEN_TUTORIAL, "stock navigation surface"),
    (native_actions::CONTACTS, "stock contacts surface"),
    (native_actions::SEARCH_CONTACT, "stock contacts surface"),
    (native_actions::MESSAGE_SEARCH, "message content stays out of the planner"),
    // Capture and vision: stock capture pipeline owns these.
    (native_actions::CAPTURE_PHOTOGRAPH, "stock capture pipeline"),
    (native_actions::CAPTURE_VIDEO, "stock capture pipeline"),
    (native_actions::STOP_VIDEO, "stock capture pipeline"),
    (native_actions::UNDERSTAND_SCENE, "vision runs through its own automation path"),
    (native_actions::ADD_IF_THEN_ENTRY, "deterministic planner; gated by vision_actions_enabled (default off) + vision consent"),
    (native_actions::CLEAR_IF_THEN_MAP, "deterministic planner; gated by vision_actions_enabled (default off) + vision consent"),
    (native_actions::GET_IF_THEN_MAP_SIZE, "deterministic planner; gated by vision_actions_enabled (default off) + vision consent"),
    // Runtime/plumbing, never a planner choice.
    (native_actions::RESPOND, "the loop's own answer path, not a tool"),
    (native_actions::CLEAR_UNDERSTANDING_CONTEXT, "session plumbing"),
    (native_actions::TICKLE, "deterministic planner; gated by the `tickle` flag, which the clone serves true from captured stock evidence"),
    (native_actions::CATCH_ME_UP, "stock summary surface"),
    (native_actions::TRANSLATE, "stock translation surface"),
    (native_actions::MANAGE_NUTRITION, "served by the food_lookup read tool"),
    (native_actions::START_ACTIVITY_TRACKER, "deterministic planner; gated by fitness_tracker_enabled, default off"),
    (native_actions::STOP_ACTIVITY_TRACKER, "stock fitness surface"),
];

#[test]
fn every_native_action_is_either_exposed_or_deliberately_withheld() {
    // A native action used to be able to enter the catalog and simply never
    // reach the model, with nothing failing — that is how
    // GenerateMusicPlaylist stayed unreachable. Exposure is now an explicit
    // decision: a new action fails this test until someone either gives it
    // a tool or records why it has none.
    let exposed: std::collections::HashSet<&str> = mutation_specs()
        .iter()
        .map(|spec| spec.action)
        .chain(std::iter::once(native_actions::PLAY_MUSIC))
        .collect();
    let withheld: std::collections::HashSet<&str> = DELIBERATELY_NOT_EXPOSED
        .iter()
        .map(|(name, _)| *name)
        .collect();

    let undecided: Vec<&str> = crate::synapse::catalog::NATIVE_ACTION_CATALOG
        .iter()
        .map(|spec| spec.name)
        .filter(|name| !exposed.contains(name) && !withheld.contains(name))
        .collect();
    assert!(
        undecided.is_empty(),
        "these native actions are neither exposed to the model nor recorded as \
         deliberately withheld: {undecided:?}"
    );

    // Keep the withheld list honest: it may not claim an action that is in
    // fact exposed, and it may not name actions that no longer exist.
    let catalog: std::collections::HashSet<&str> = crate::synapse::catalog::NATIVE_ACTION_CATALOG
        .iter()
        .map(|spec| spec.name)
        .collect();
    for (name, _) in DELIBERATELY_NOT_EXPOSED {
        assert!(
            catalog.contains(name),
            "withheld action '{name}' is not in the catalog"
        );
        assert!(
            !exposed.contains(name),
            "'{name}' is both exposed and withheld"
        );
    }
}

/// The mutation mirror of `exposed_read_tools_match_the_validation_catalog`,
/// in the direction nothing checked. Catalog -> exposure is guarded above by
/// `every_native_action_is_either_exposed_or_deliberately_withheld`; exposure
/// -> catalog was not guarded at all.
///
/// It fails silently, which is the whole problem. `mutation_advertised`
/// resolves `native_action_spec(mutation.action)` and simply returns false
/// when the name is absent, so a mutation naming an action the catalog does
/// not contained is advertised to nobody and rejected by nothing — it reads
/// on-device as SILENCE, the same shape that kept GenerateMusicPlaylist
/// unreachable. Two live ways to land one: a typo, or a tool whose side
/// effect is not a stock native action at all (a server-side write), which
/// therefore has no catalog row it could ever match.
#[test]
fn every_exposed_mutation_resolves_to_a_catalog_row() {
    for action in mutation_specs()
        .iter()
        .map(|spec| spec.action)
        .chain(std::iter::once(native_actions::PLAY_MUSIC))
    {
        assert!(
            native_action_spec(action).is_some(),
            "exposed mutation action '{action}' has no validation-catalog row, so \
             mutation_advertised can only ever hide it and the tool is unreachable",
        );
    }
}

#[tokio::test]
async fn a_bare_nearby_request_needs_no_invented_category() {
    // Observed on device for "what's the weather here and what's nearby":
    // nearby_search failed the grounding gate twice before succeeding,
    // costing two extra model steps and re-running current_weather each
    // time. The user named no kind of place, so every query the model could
    // supply was ungrounded by construction — the requirement was
    // unsatisfiable, not merely strict.
    let broker = StaticBroker(json!({"status":"ok","places":[]}));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "what's nearby");

    let omitted = tools.execute(&call("nearby_search", json!({}))).await;
    assert!(
        matches!(omitted, ToolExecutionOutcome::Observation { ok: true, .. }),
        "omitting the query must be accepted, got {omitted:?}"
    );

    let blank = tools
        .execute(&call("nearby_search", json!({"query": "  "})))
        .await;
    assert!(matches!(
        blank,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));

    // Grounding of a SUPPLIED query belongs to the broker, not this layer
    // (see `a_bare_nearby_search_is_grounded_by_having_no_query` in
    // services::aibus::agentic); this test only pins that the schema and
    // deserialization accept an omitted query at all.
}

#[tokio::test]
async fn a_relative_volume_request_is_reachable_without_an_exact_phrase() {
    // The gap this closes: every device-control route is an exact-phrase
    // matcher, and "turn the volume up a bit" is not in the volume grammar.
    // With no tool, the model could only describe the action while nothing
    // happened — understood, discussed, never performed.
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "turn the volume up a bit",
    );

    let catalog: Vec<&str> = tools.catalog().iter().map(|def| def.name).collect();
    for expected in [
        "increment_volume",
        "decrement_volume",
        "set_volume",
        "pause_music",
        "next_track",
        "get_battery_level",
    ] {
        assert!(catalog.contains(&expected), "{expected} must be reachable");
    }

    // A relative request needs no argument, so nothing has to be invented
    // and nothing can be misquoted.
    let outcome = tools.execute(&call("increment_volume", json!({}))).await;
    assert!(
        matches!(outcome, ToolExecutionOutcome::Terminal(_)),
        "increment_volume must dispatch as a native action, got {outcome:?}"
    );
}

#[tokio::test]
async fn a_control_tool_refuses_without_action_specific_evidence() {
    // The model choosing a tool is not authority on its own. A turn that
    // never asked for volume must not be able to change it, even if the
    // model calls the tool.
    let broker = StaticBroker(json!({"status":"ok"}));
    let unrelated = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "what is the capital of France",
    );
    let outcome = unrelated
        .execute(&call("increment_volume", json!({})))
        .await;
    assert!(
        matches!(outcome, ToolExecutionOutcome::Observation { ok: false, .. }),
        "a control with no evidence in the turn must be refused, got {outcome:?}"
    );

    // A stated level must be the user's own number, not the model's.
    let spoken = AibusToolCatalog::new(&broker, unlocked_authorization(), "set the volume to 30");
    let invented = spoken
        .execute(&call("set_volume", json!({"level": 80})))
        .await;
    assert!(
        matches!(
            invented,
            ToolExecutionOutcome::Observation { ok: false, .. }
        ),
        "a level the user never said must be refused, got {invented:?}"
    );
    let quoted = spoken
        .execute(&call("set_volume", json!({"level": 30})))
        .await;
    assert!(matches!(quoted, ToolExecutionOutcome::Terminal(_)));
}

#[test]
fn security_relevant_actions_stay_deterministic_only() {
    // Exposure widens what can be reached, never what is permitted. These
    // must never become model-callable.
    let exposed: std::collections::HashSet<&str> =
        mutation_specs().iter().map(|spec| spec.action).collect();
    for forbidden in [
        native_actions::LOCK_DEVICE,
        native_actions::ENTER_PRIVACY_MODE,
        native_actions::CAPTURE_PHOTOGRAPH,
        native_actions::CAPTURE_VIDEO,
        native_actions::CONNECT_TO_BLUETOOTH,
        native_actions::GET_SERIAL_NUMBER,
        native_actions::GET_PHONE_NUMBER,
    ] {
        assert!(
            !exposed.contains(forbidden),
            "{forbidden} must not be exposed to the model"
        );
    }
}

#[test]
fn natural_device_control_phrasing_passes_the_catalog_grounding_gate() {
    // `.120` shipped inert because its test only exercised the TOOL intent
    // gate via `tools.execute(...)`. A second, independent gate —
    // `enforce_mutation_grounding` against the catalog's
    // `required_user_terms` — refused the same call on device:
    //   "'IncrementVolume' needs the user to actually ask for it in this turn"
    // A green test covering one of two gates was worse than no test: it
    // turned "unverified" into false confidence.
    use crate::synapse::catalog::{enforce_mutation_grounding, native_action_spec};

    for (action, utterance) in [
        (native_actions::INCREMENT_VOLUME, "turn the volume up a bit"),
        (native_actions::INCREMENT_VOLUME, "can you make it louder"),
        (
            native_actions::DECREMENT_VOLUME,
            "turn the volume down a bit",
        ),
        (native_actions::PAUSE_MUSIC, "pause"),
        (native_actions::NEXT_TRACK, "skip this song"),
        (native_actions::RESTART_TRACK, "play it again"),
        (
            native_actions::GET_BATTERY_LEVEL,
            "how much battery do I have",
        ),
        (native_actions::GET_CURRENT_TIME, "what is the time"),
    ] {
        let spec = native_action_spec(action).expect(action);
        assert!(
            enforce_mutation_grounding(spec, &json!({}), utterance).is_ok(),
            "{action} must accept {utterance:?} — this is the gate that refused on device"
        );
    }

    // Anchoring still does its job: the terms were widened, the matcher was
    // not relaxed. An unrelated request must never ground a device mutation.
    for (action, utterance) in [
        (
            native_actions::INCREMENT_VOLUME,
            "what is the capital of France",
        ),
        (native_actions::INCREMENT_VOLUME, "the music is too loud"),
        (native_actions::PAUSE_MUSIC, "what is the weather"),
        (native_actions::NEXT_TRACK, "what is next on my calendar"),
        // Guards a false-fire I introduced while widening: "what is next"
        // was too generic a term for the queue read.
        (
            native_actions::GET_MUSIC_QUEUE,
            "what is next on my calendar",
        ),
    ] {
        let spec = native_action_spec(action).expect(action);
        assert!(
            enforce_mutation_grounding(spec, &json!({}), utterance).is_err(),
            "{action} must refuse {utterance:?}"
        );
    }
}

#[tokio::test]
async fn playback_completes_deterministically_when_the_model_will_not() {
    // Measured on device across .123-.126: a play request returned 5-10
    // citable tracks, play_music was advertised, the completion nudge
    // fired, and the model still answered with prose on 0/3 runs. The user
    // asked for a song and got a sentence.
    let broker = StaticBroker(json!({
        "status":"ok","artist":"Prince",
        "tracks":[{"rank":1,"title":"Kiss","artists":["Prince"]}]
    }));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "play Prince");
    let read = tools
        .execute(&call(
            "music_artist_top_tracks",
            json!({"artist": "Prince"}),
        ))
        .await;
    assert!(matches!(
        read,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));

    let forced = tools
        .forced_terminal_action("Here are some Prince songs.")
        .expect("a citable rank-one result must complete the playback");
    assert_eq!(forced.action, native_actions::PLAY_MUSIC);

    // Without a search there is nothing audited to play, so nothing is
    // invented.
    let barren = AibusToolCatalog::new(&broker, unlocked_authorization(), "play Prince");
    assert!(barren.forced_terminal_action("Here you go.").is_none());

    // Not a play command: a question must never be completed as playback.
    let question = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "what is Prince's most popular song",
    );
    let _ = question
        .execute(&call(
            "music_artist_top_tracks",
            json!({"artist": "Prince"}),
        ))
        .await;
    assert!(
        question.forced_terminal_action("It is Kiss.").is_none(),
        "a question must not be force-completed into playback"
    );
}

#[tokio::test]
async fn the_agentic_path_completes_playback_for_a_trailing_artist() {
    // The user's literal request, measured failing on device 2026-07-31: the
    // model found the top track and the turn ended in prose — "I found Michael
    // Jackson's top track, 'Chicago,' but couldn't start playback" — because an
    // ungrounded `music_artist_top_tracks` call yields a non-citable result, and
    // playback may only complete from a citable one. This pins the whole
    // agentic chain (search grounds -> result is citable -> playback completes),
    // not just the span predicate, and it must not depend on the deterministic
    // local fast path, which never runs for this phrasing.
    let broker = StaticBroker(json!({
        "status":"ok","artist":"Michael Jackson",
        "tracks":[{"rank":1,"title":"Chicago","artists":["Michael Jackson"]}]
    }));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "look up the best song by Michael Jackson and play it",
    );
    let read = tools
        .execute(&call(
            "music_artist_top_tracks",
            json!({"artist": "Michael Jackson"}),
        ))
        .await;
    assert!(
        matches!(read, ToolExecutionOutcome::Observation { ok: true, .. }),
        "an artist named at the tail of the request must ground the search"
    );

    let forced = tools
        .forced_terminal_action("I found Michael Jackson's top track, \"Chicago.\"")
        .expect("a citable rank-one result must complete the playback");
    assert_eq!(forced.action, native_actions::PLAY_MUSIC);

    // The same invariant as the head form: a question is not a play command, so
    // nothing may be completed as playback however citable the result is.
    let question = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "what is the best song by Michael Jackson",
    );
    let _ = question
        .execute(&call(
            "music_artist_top_tracks",
            json!({"artist": "Michael Jackson"}),
        ))
        .await;
    assert!(
        question.forced_terminal_action("It's Chicago.").is_none(),
        "a question must never be completed as playback"
    );
}

#[test]
fn a_trailing_artist_grounds_the_same_as_a_leading_one() {
    // Measured on device 2026-07-31: "look up the best song by Michael Jackson
    // and play it" found the top track and then refused to play it —
    // `music target not grounded targets=1 requested_words=2
    // longest_target_words=6`, five iterations, 15.5s, no playback. The head
    // form ("michael jackson s best song") grounded; the tail form did not,
    // even though "by <artist>" is the more natural English ordering.
    let utterance = "look up the best song by Michael Jackson and play it";
    let targets = authoritative_music_playback_targets(utterance);
    assert!(!targets.is_empty(), "the utterance must yield a target");
    assert!(
        targets
            .iter()
            .any(|t| target_ends_with_entity_span(t, "michael jackson")),
        "a trailing artist is still the user's own words: {targets:?}"
    );

    // The invariant that must survive: every preceding word has to be a
    // qualifier or connective, so a bare fragment of the phrase stays refused.
    for foreign in ["song", "best", "taylor swift", "jackson", "the best song"] {
        assert!(
            !targets
                .iter()
                .any(|t| t == foreign || target_ends_with_entity_span(t, foreign)),
            "{foreign:?} must not ground against {targets:?}"
        );
    }

    // And an entity buried behind a non-qualifier is still refused: the words
    // before the span are not all qualifiers/connectives.
    assert!(
        !target_ends_with_entity_span("dr dre s most popular song", "song"),
        "a trailing qualifier word is not an entity"
    );
}

#[test]
fn a_narrowed_music_target_is_grounded_but_a_foreign_one_is_not() {
    // Root cause of music playback never completing (measured .123-.128:
    // results=4 ungrounded=4 play_args_refused=0). "play Dr. Dre's most popular
    // song" makes the whole phrase the authoritative target while the model
    // searches artist="Dr. Dre" — the user's own words, narrowed.
    let utterance = "play Dr. Dre's most popular song";
    let targets = authoritative_music_playback_targets(utterance);
    assert!(!targets.is_empty(), "the utterance must yield a target");

    assert!(
        targets.iter().any(|t| target_contains_span(t, "dr dre")),
        "a narrowing of the user's own words must ground: {targets:?}"
    );

    // The possessive is its own token after normalization, so the model's
    // natural query drops it. Measured on device as the single token that
    // blocked playback: requested_words=5 vs longest_target_words=6.
    let broker = StaticBroker(json!({
        "status":"ok","artist":"Dr. Dre",
        "tracks":[{"rank":1,"title":"Still D.R.E.","artists":["Dr. Dre"]}]
    }));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
    let read = futures::executor::block_on(tools.execute(&call(
        "music_catalog_search",
        json!({"query": "Dr Dre most popular song"}),
    )));
    assert!(
        matches!(read, ToolExecutionOutcome::Observation { ok: true, .. }),
        "the possessive-free form of the user's own words must ground"
    );
    // Completion from a grounded result is covered by
    // `playback_completes_deterministically_when_the_model_will_not`; this
    // test pins the grounding rule only.

    // The invariant that must survive: nothing may originate outside the
    // request. Substitution, foreign tokens and partial words stay refused.
    for foreign in ["taylor swift", "kanye", "dr dre greatest hits", "dr"] {
        assert!(
            !targets
                .iter()
                .any(|t| t == foreign || target_contains_span(t, foreign)),
            "{foreign:?} must not ground against {targets:?}"
        );
    }

    // A question is not a play command, so it yields no authoritative
    // target at all and nothing can ground against it.
    assert!(
        authoritative_music_playback_targets("what is Dr. Dre's most popular song").is_empty(),
        "a question must not mint playback targets"
    );
}

use crate::synapse::catalog::{
    MusicArtistTopTracksArguments, MusicCatalogSearchArguments, ReadToolResultProvenance,
};

/// The device utterance that was refused: the playback half is anaphoric, so
/// the artist only ever appears in the search half.
const COMPOUND_LOOKUP_AND_PLAY: &str =
    "Look up Michael Jackson's best songs and play the best one on Spotify";

fn stored_top_tracks(call_id: &str, artist: &str, tracks: Value) -> AgenticToolResult {
    AgenticToolResult {
        call_id: call_id.to_string(),
        tool_name: "music_artist_top_tracks",
        provenance: ReadToolResultProvenance::TrustedProviderResult,
        tool: ReadToolInvocation::MusicArtistTopTracks(MusicArtistTopTracksArguments {
            artist: artist.to_string(),
            limit: None,
        }),
        result: json!({"status": "ok", "artist": artist, "tracks": tracks}),
    }
}

fn stored_catalog_search(call_id: &str, query: &str) -> AgenticToolResult {
    AgenticToolResult {
        call_id: call_id.to_string(),
        tool_name: "music_catalog_search",
        provenance: ReadToolResultProvenance::TrustedProviderResult,
        tool: ReadToolInvocation::MusicCatalogSearch(MusicCatalogSearchArguments {
            query: query.to_string(),
            kind: None,
            limit: None,
        }),
        result: json!({
            "status": "ok",
            "query": query,
            "tracks": [{"rank": 1, "title": query, "artists": ["Michael Jackson"]}],
        }),
    }
}

/// Michael Jackson's top tracks as a trusted provider would return them: the
/// titles/albums here are the only values rule (b) may ever admit from it.
fn michael_jackson_top_tracks(call_id: &str) -> AgenticToolResult {
    stored_top_tracks(
        call_id,
        "Michael Jackson",
        json!([{
            "rank": 1,
            "title": "Billie Jean",
            "artists": ["Michael Jackson"],
            "album": "Thriller",
        }]),
    )
}

#[test]
fn a_compound_lookup_and_play_grounds_the_artist_from_the_search_half() {
    // Real device refusal: this utterance logged targets=1 requested_words=2
    // longest_target_words=5. The compound split kept only the ANAPHORIC
    // playback half ("the best one on spotify") and discarded the half naming
    // the artist, so the model's artist="Michael Jackson" could not be
    // contained in any target and playback was refused.
    let targets = authoritative_music_playback_targets(COMPOUND_LOOKUP_AND_PLAY);
    assert!(
        targets
            .iter()
            .any(|target| target == "the best one on spotify"),
        "the playback half must still contribute its target: {targets:?}"
    );
    assert!(
        targets
            .iter()
            .any(|target| target_contains_span(target, "michael jackson")),
        "the search half must contribute the artist: {targets:?}"
    );

    // Rule (a) alone, with NO prior results at all: this is Fix 1 in isolation,
    // not the chain of trust.
    assert!(
        music_result_search_target_is_grounded(
            &michael_jackson_top_tracks("m1"),
            COMPOUND_LOOKUP_AND_PLAY,
            &[],
        ),
        "the user's own words in the search half must ground the artist"
    );

    // The condition that keeps Fix 1 narrow. The search half contributes only
    // because the playback half is ANAPHORIC. When the playback half names a
    // concrete target the search clause is a different errand and must gain no
    // playback authority — the case
    // `play_music_rejects_partial_or_non_playback_search_spans` also pins.
    let separate_errand = authoritative_music_playback_targets("look up weather and play jazz");
    assert_eq!(
        separate_errand,
        vec!["jazz".to_string()],
        "a concrete playback half must not drag its search clause in"
    );
    // The same shape, anaphoric this time: now the search half is the only
    // place the entity can come from.
    assert!(
        authoritative_music_playback_targets("look up Example Artist and play the top one")
            .iter()
            .any(|target| target == "example artist"),
        "an anaphoric playback half must fall through to the search clause"
    );

    // The invariant that must survive Fix 1: both halves are the user's words,
    // and nothing else becomes sayable. No prior results exist here, so rule
    // (b) cannot rescue any of these either.
    for foreign in [
        "taylor swift",    // never said
        "jackson michael", // reordered
        "michael jordan",  // substituted
        "michael",         // partial name, not the entity head
        "billie jean",     // real, but only ever a provider value
    ] {
        assert!(
            !music_result_search_target_is_grounded(
                &stored_catalog_search("c1", foreign),
                COMPOUND_LOOKUP_AND_PLAY,
                &[],
            ),
            "{foreign:?} must not ground against the user's own words"
        );
    }
}

#[test]
fn a_discovered_value_grounds_only_through_a_grounded_and_citable_prior_result() {
    // Rule (b), the chain of trust. The user authorizes the TOPIC by grounding
    // the earlier search in their own words; the VALUE comes from real provider
    // data. Neither half is sufficient alone, and each negative below removes
    // exactly one half.
    let grounded_prior = [michael_jackson_top_tracks("m1")];

    // POSITIVE: a title the provider returned inside the grounded search.
    assert!(
        music_result_search_target_is_grounded(
            &stored_catalog_search("c1", "Billie Jean"),
            COMPOUND_LOOKUP_AND_PLAY,
            &grounded_prior,
        ),
        "a provider-supplied title from a grounded search must ground"
    );
    // The album field is provider data in a `PlayMusic` argument position too.
    assert!(
        music_result_search_target_is_grounded(
            &stored_catalog_search("c2", "Thriller"),
            COMPOUND_LOOKUP_AND_PLAY,
            &grounded_prior,
        ),
        "a provider-supplied album from a grounded search must ground"
    );

    // NEGATIVE 1: a foreign token the user never said, present in no citable
    // result.
    assert!(
        !music_result_search_target_is_grounded(
            &stored_catalog_search("c3", "Cruel Summer"),
            COMPOUND_LOOKUP_AND_PLAY,
            &grounded_prior,
        ),
        "a value absent from every citable result must stay refused"
    );

    // NEGATIVE 2: no bootstrapping. The value is real provider data, but the
    // result that returned it never passed grounding itself.
    let ungrounded_prior = [stored_top_tracks(
        "u1",
        "Taylor Swift",
        json!([{"rank": 1, "title": "Cruel Summer", "artists": ["Taylor Swift"]}]),
    )];
    assert!(
        !music_result_search_target_is_grounded(
            &stored_catalog_search("c4", "Cruel Summer"),
            COMPOUND_LOOKUP_AND_PLAY,
            &ungrounded_prior,
        ),
        "an ungrounded result must not become a grounding authority"
    );

    // NEGATIVE 3: not citable. Same grounded search, same provider values, but
    // the payload failed or did not come from a trusted provider.
    let mut failed = michael_jackson_top_tracks("m2");
    failed.result["status"] = json!("error");
    let mut untrusted = michael_jackson_top_tracks("m3");
    untrusted.provenance = ReadToolResultProvenance::AuthenticatedDeviceObservation;
    for non_citable in [failed, untrusted] {
        assert!(
            !music_result_search_target_is_grounded(
                &stored_catalog_search("c5", "Billie Jean"),
                COMPOUND_LOOKUP_AND_PLAY,
                std::slice::from_ref(&non_citable),
            ),
            "a non-citable result must contribute no grounding values"
        );
    }

    // NEGATIVE 4: no cycles. A result whose own payload echoes its own query
    // cannot ground itself — not with an empty prior list (what the call sites
    // actually pass, since they slice strictly earlier results) and not even
    // when handed a copy of itself, because that copy must pass grounding
    // first and cannot.
    let self_referential = stored_catalog_search("c6", "Billie Jean");
    assert!(
        !music_result_search_target_is_grounded(&self_referential, COMPOUND_LOOKUP_AND_PLAY, &[],),
        "a result must not ground itself from its own payload"
    );
    assert!(
        !music_result_search_target_is_grounded(
            &self_referential,
            COMPOUND_LOOKUP_AND_PLAY,
            std::slice::from_ref(&self_referential),
        ),
        "a cycle must not manufacture authority"
    );

    // NEGATIVE 5: rule (b) is exactly as strict as rule (a). Reordering,
    // substitution and part-of-a-word are refused against provider values too.
    for foreign in [
        "jean billie",  // reordered
        "billie jones", // substituted
        "billie",       // word-bounded prefix, not the whole value
        "billie je",    // substring of a word
        "jean",         // word-bounded suffix
    ] {
        assert!(
            !music_result_search_target_is_grounded(
                &stored_catalog_search("c7", foreign),
                COMPOUND_LOOKUP_AND_PLAY,
                &grounded_prior,
            ),
            "{foreign:?} must not ground against a provider value"
        );
    }
}

/// Echoes back the key the audited rank-one builder verifies, so a real
/// two-step chain can run through the catalog instead of hand-built fixtures.
struct EchoingMusicBroker;
#[tonic::async_trait]
impl AgenticToolExecutor for EchoingMusicBroker {
    async fn execute(
        &self,
        request: AgenticToolRequest<'_>,
    ) -> Result<AgenticToolOutput, AgenticToolError> {
        Ok(AgenticToolOutput::Result(match request.invocation {
            ReadToolInvocation::MusicArtistTopTracks(arguments) => json!({
                "status": "ok",
                "artist": arguments.artist,
                "tracks": [{
                    "rank": 1,
                    "title": "Billie Jean",
                    "artists": [arguments.artist],
                    "album": "Thriller",
                }],
            }),
            ReadToolInvocation::MusicCatalogSearch(arguments) => json!({
                "status": "ok",
                "query": arguments.query,
                "tracks": [{
                    "rank": 1,
                    "title": arguments.query,
                    "artists": ["Michael Jackson"],
                }],
            }),
            _ => json!({"status": "ok"}),
        }))
    }
}

fn music_call(call_id: &str, name: &str, arguments: Value) -> ToolStepCall {
    ToolStepCall {
        call_id: call_id.to_string(),
        name: name.to_string(),
        arguments,
    }
}

#[tokio::test]
async fn the_compound_request_reaches_playback_through_both_grounding_rules() {
    // End-to-end at the real call sites: the same utterance the device
    // refused, now completing both from the user's own words (rule a) and from
    // a title the provider supplied inside that grounded search (rule b).
    let tools = AibusToolCatalog::new(
        &EchoingMusicBroker,
        unlocked_authorization(),
        COMPOUND_LOOKUP_AND_PLAY,
    );
    let search = tools
        .execute(&music_call(
            "search-1",
            "music_artist_top_tracks",
            json!({"artist": "Michael Jackson"}),
        ))
        .await;
    assert!(matches!(
        search,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));

    // Rule (a): the artist came from the search half of the user's own words.
    let played = tools
        .execute(&music_call(
            "play-1",
            PLAY_MUSIC_TOOL,
            json!({"from_call_id": "search-1"}),
        ))
        .await;
    assert!(
        matches!(&played, ToolExecutionOutcome::Terminal(action) if action.action == native_actions::PLAY_MUSIC),
        "the compound request must reach playback: {played:?}"
    );

    // Rule (b): the model then searched a title only the provider knew.
    let chained = tools
        .execute(&music_call(
            "search-2",
            "music_catalog_search",
            json!({"query": "Billie Jean"}),
        ))
        .await;
    assert!(matches!(
        chained,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));
    let played = tools
        .execute(&music_call(
            "play-2",
            PLAY_MUSIC_TOOL,
            json!({"from_call_id": "search-2"}),
        ))
        .await;
    assert!(
        matches!(&played, ToolExecutionOutcome::Terminal(action) if action.action == native_actions::PLAY_MUSIC),
        "a title discovered inside the grounded search must be playable: {played:?}"
    );

    // The boundary, at the same call site: a value that appears in no citable
    // result is still refused, so the chain cannot wander off the topic the
    // user authorized.
    let foreign = tools
        .execute(&music_call(
            "search-3",
            "music_catalog_search",
            json!({"query": "Cruel Summer"}),
        ))
        .await;
    assert!(matches!(
        foreign,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));
    let refused = tools
        .execute(&music_call(
            "play-3",
            PLAY_MUSIC_TOOL,
            json!({"from_call_id": "search-3"}),
        ))
        .await;
    assert!(
        matches!(refused, ToolExecutionOutcome::Observation { ok: false, .. }),
        "an unchained value must not reach playback: {refused:?}"
    );
}

#[tokio::test]
async fn a_device_command_completes_deterministically_when_the_model_will_not() {
    // Measured across suite runs on identical code: "turn the volume up a
    // bit" and "make it louder" FLIPPED pass/fail between runs. The tools
    // work; the model complies about half the time, and the nudge buys only
    // one retry before the user gets prose instead of a volume change.
    let broker = StaticBroker(json!({"status":"ok"}));

    for (utterance, expected) in [
        ("turn the volume up a bit", native_actions::INCREMENT_VOLUME),
        ("make it louder", native_actions::INCREMENT_VOLUME),
        (
            "turn the volume down a bit",
            native_actions::DECREMENT_VOLUME,
        ),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        let forced = tools
            .forced_terminal_action("I can help with that.")
            .unwrap_or_else(|| panic!("{utterance:?} must complete deterministically"));
        assert_eq!(forced.action, expected, "{utterance:?}");
    }

    // NEGATIVE CONTROLS. Nothing becomes reachable that the intent gate did
    // not already permit — this removes a coin flip, not a check.
    for utterance in [
        "what is the capital of France",
        "the music is too loud",
        "what time is the next train",
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance);
        let forced = tools.forced_terminal_action("Here you go.");
        assert!(
            forced.is_none(),
            "{utterance:?} must not force a device action, got {forced:?}"
        );
    }
}

#[test]
fn a_named_play_request_is_an_authoritative_play_command() {
    // Observed on device: "play Dr. Dre's most popular song" ran four
    // successful music searches over 58s and 8 iterations, then answered
    // with prose and never called play_music. If this predicate is false
    // the playback-completion nudge is suppressed, so nothing ever forces
    // the loop to finish the job.
    for utterance in [
        "play Dr. Dre's most popular song",
        "play Dr Dre's most popular song",
        "play something by Prince",
    ] {
        assert!(
            authoritative_play_music_command(utterance),
            "{utterance:?} must mint playback authority"
        );
    }
    // Discussion is not a command.
    for utterance in [
        "what is Dr. Dre's most popular song",
        "who plays bass on that",
    ] {
        assert!(
            !authoritative_play_music_command(utterance),
            "{utterance:?}"
        );
    }
}

#[test]
fn a_play_intent_that_ran_no_tools_is_told_to_search_this_run() {
    // Observed on-device: after discussing an artist, "play his most
    // popular song" returned a tool-free iteration-0 answer. Weather,
    // place and "what's playing" all demanded fresh evidence; play
    // intents did not, so the model could talk about the song instead of
    // finding and playing it.
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "play his most popular song",
    )
    .with_entry_intent(Some(play_intent(true)));

    let nudge = tools
        .final_answer_nudge("Dr. Dre's most popular song is widely considered to be that one.")
        .expect("a play intent with no tool results must be sent back to the catalog");
    assert!(nudge.contains("this run"));

    // The referent itself is never echoed back into the nudge.
    assert!(!nudge.contains("Dr. Dre"));
}

#[test]
fn direct_music_requests_nudge_the_terminal_tool_without_catalog_search() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for (utterance, expected_tool) in [
        ("play my favorites", "play_favorite_tracks"),
        ("play something featured", "play_featured_music"),
        ("make a playlist for running", "generate_music_playlist"),
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        let nudge = tools
            .final_answer_nudge("Done.")
            .expect("direct playback request must reject a text-only answer");
        assert!(nudge.contains(expected_tool), "{utterance}: {nudge}");
        assert!(
            !nudge.contains("music_catalog_search"),
            "{utterance}: {nudge}"
        );
        assert!(!nudge.contains("play_music"), "{utterance}: {nudge}");
    }
}

#[test]
fn catalog_does_not_turn_local_music_variants_or_deictics_into_catalog_searches() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "listen to my favorites",
        "queue up my liked tracks",
        "listen to track radio",
        "put on songs like this",
        "play more like this",
    ] {
        assert!(
            !authoritative_play_music_command(utterance),
            "local/direct music request became catalog playback authority: {utterance}"
        );
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        assert_eq!(
            tools.final_answer_nudge("Okay."),
            None,
            "local/direct music request became a catalog-search obligation: {utterance}"
        );
    }
}

#[test]
fn catalog_authority_rejects_quoted_and_cancelled_commands_but_keeps_real_catalog_requests() {
    for utterance in [
        "\"play Example Track\" is just a phrase",
        "please quote \"play Example Track\"",
        "play Example Track scratch that",
        "play Example Track forget that",
        "play Example Track not now",
        "play Example Track not right now please",
    ] {
        assert!(
            !authoritative_play_music_command(utterance),
            "unsafe catalog command gained playback authority: {utterance}"
        );
    }
    for utterance in [
        "play Example Track",
        "play \"Example Track\"",
        "listen to Miles Davis",
        "put on some jazz",
        "queue up ambient music",
        "look up Example Artist and play the top result",
        "look up \"Example Artist\" and play the top result",
    ] {
        assert!(
            authoritative_play_music_command(utterance),
            "legitimate catalog command lost playback authority: {utterance}"
        );
    }
}

#[test]
fn quoted_and_cancelled_catalog_mentions_do_not_trigger_search_nudges() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "\"play Example Track\" is just a phrase",
        "play Example Track scratch that",
        "play Example Track forget that",
        "play Example Track not now",
        "play Example Track not right now please",
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        assert_eq!(
            tools.final_answer_nudge("Okay."),
            None,
            "unsafe catalog mention triggered another model/tool step: {utterance}"
        );
    }
}

#[test]
fn malformed_quotes_and_bare_verbs_never_authorize_or_nudge_catalog_playback() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "play",
        "listen to",
        "put on",
        "queue up",
        "play \"\"",
        "play ` `",
        "play « »",
        "play Example Track\" actually don't",
        "play \"Example Track actually don't",
        "play `Example Track\"",
        "play “Example Track\"",
        "play „Example Track”",
        "play «Example Track”",
        "play ‘Example Track'",
        "play 'Example Track”",
    ] {
        assert!(
            !authoritative_play_music_command(utterance),
            "malformed quotes hid non-authoritative text: {utterance}"
        );
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        assert_eq!(
            tools.final_answer_nudge("Okay."),
            None,
            "malformed quotes triggered a catalog-search obligation: {utterance}"
        );
    }

    for utterance in [
        "play \"Example Track\"",
        "play `Example Track`",
        "play “Example Track”",
        "play „Example Track“",
        "play «Example Track»",
        "play ‘Example Track’",
        "play 'Example Track'",
        "play \"Don't Stop\"",
        "play “Don’t Stop”",
        "play Don't Stop",
    ] {
        assert!(
            authoritative_play_music_command(utterance),
            "balanced quoted payload lost valid outer playback authority: {utterance}"
        );
    }
}

#[test]
fn rejected_direct_music_mentions_do_not_become_search_obligations() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "what happens if I say play my favorites",
        "do not play my favorites",
        "should I play my favorites",
        "play my favorites and text Sarah",
        "play something other than featured music",
        "how do I make a playlist for running",
        "make a playlist for running and then call Sarah",
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        assert_eq!(
            tools.final_answer_nudge("Okay."),
            None,
            "rejected mention must not be upgraded: {utterance}"
        );
    }
}

#[test]
fn unsafe_music_mentions_do_not_suppress_unrelated_live_evidence() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "what's the weather today and don't play music",
        "find the nearest coffee shop and do not play my favorites",
        "what's the forecast and hypothetically make a playlist for running",
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        let nudge = tools
            .final_answer_nudge("Okay.")
            .expect("the unrelated live-evidence obligation must remain");
        assert!(nudge.contains("live information"), "{utterance}: {nudge}");
        assert!(!nudge.contains("play_favorite_tracks"), "{nudge}");
        assert!(!nudge.contains("generate_music_playlist"), "{nudge}");
    }
}

#[test]
fn named_catalog_collision_uses_search_not_the_fieldless_music_action() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "play Favorite Tracks by Prince",
    )
    .with_entry_intent(Some(play_intent(true)));
    let nudge = tools
        .final_answer_nudge("Playing.")
        .expect("a named catalog request still needs a search");
    assert!(
        nudge.contains("music search") || nudge.contains("music_catalog_search"),
        "{nudge}"
    );
    assert!(!nudge.contains("play_favorite_tracks"), "{nudge}");
}

#[test]
fn excluded_fieldless_alternative_does_not_suppress_catalog_playback() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "play jazz instead of my favorites",
        "play jazz instead my favorites",
        "play jazz not my favorites",
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        let nudge = tools
            .final_answer_nudge("Playing.")
            .unwrap_or_else(|| panic!("catalog request was suppressed: {utterance}"));
        assert!(
            nudge.contains("music search") || nudge.contains("music_catalog_search"),
            "catalog request was routed away from search: {utterance}: {nudge}"
        );
        assert!(
            !nudge.contains("play_favorite_tracks"),
            "excluded favorites became the requested action: {utterance}: {nudge}"
        );
        let excluded_action =
            futures::executor::block_on(tools.execute(&call("play_favorite_tracks", json!({}))));
        assert!(
            matches!(
                excluded_action,
                ToolExecutionOutcome::Observation { ok: false, .. }
            ),
            "excluded favorites gained mutation authority: {utterance}: {excluded_action:?}"
        );
    }
}

#[test]
fn unsafe_excluded_fieldless_mentions_still_suppress_playback_nudges() {
    let broker = StaticBroker(json!({"status":"ok"}));
    for utterance in [
        "play something other than featured music",
        "play it instead my favorites",
        "do not play jazz instead my favorites",
        "what happens if I say play jazz instead my favorites",
        "play jazz instead my favorites and text Sarah",
        "play jazz instead my favorites but do not play it",
    ] {
        let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), utterance)
            .with_entry_intent(Some(play_intent(true)));
        assert_eq!(
            tools.final_answer_nudge("Okay."),
            None,
            "unsafe mention became playback authority: {utterance}"
        );
    }
}

#[test]
fn classifier_gates_the_nudge_and_beats_the_lexical_check() {
    let broker = StaticBroker(json!({"status":"ok"}));
    // "queue up some jazz" has none of the lexical terms, but the stock
    // classifier reads it as Play — the nudge must now fire.
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "queue up some jazz")
        .with_entry_intent(Some(play_intent(true)));
    assert!(
        matches!(tools.entry_intent.as_ref(), Some(i) if i.autocomplete),
        "classifier attached"
    );
    // "play it cool" contains "play" but is NOT a Play intent — the
    // classifier must suppress the lexical false-fire.
    let cool = AibusToolCatalog::new(&broker, unlocked_authorization(), "play it cool")
        .with_entry_intent(Some(crate::nlu::triggering::EntryIntent {
            intent: native_actions::CLEAR_UNDERSTANDING_CONTEXT.to_string(),
            distance: 1.0,
            slot: 0,
            autocomplete: true,
        }));
    assert_eq!(cool.final_answer_nudge("Staying calm."), None);
    // Loose-radius Play still counts: it cleared the Play centroid, so
    // the completion obligation stands (a music result exists below).
    let broker2 = StaticBroker(json!({
        "status":"ok","artist":"Prince",
        "tracks":[{"rank":1,"title":"Kiss","artists":["Prince"]}]
    }));
    let loose = AibusToolCatalog::new(&broker2, unlocked_authorization(), "play something")
        .with_entry_intent(Some(play_intent(false)));
    let read = futures::executor::block_on(loose.execute(&call(
        "music_artist_top_tracks",
        json!({"artist": "Prince"}),
    )));
    assert!(matches!(
        read,
        ToolExecutionOutcome::Observation { ok: true, .. }
    ));
    assert!(
        loose.final_answer_nudge("Here are songs.").is_some(),
        "loose-radius Play with a music result must still nudge to play_music"
    );
}

#[test]
fn nudge_falls_back_to_lexical_when_the_classifier_is_absent() {
    let broker = StaticBroker(json!({"status":"ok"}));
    // No entry intent (feature off / model missing) => previous behavior.
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "play it cool");
    assert!(tools.entry_intent.is_none());
    // Lexical path still recognizes "play"; without a music result the
    // nudge stays None, proving the obligation needs real evidence.
    assert_eq!(tools.final_answer_nudge("Staying calm."), None);
}

#[test]
fn slots_seed_only_missing_music_arguments() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(
        &broker,
        unlocked_authorization(),
        "play smooth criminal by michael jackson",
    )
    .with_music_slots(Some(slots(
        Some("smooth criminal"),
        Some("michael jackson"),
    )));

    // Empty artist gets seeded from the calibrated slot.
    let seeded = tools.seed_music_arguments("music_artist_top_tracks", json!({}));
    assert_eq!(seeded["artist"], "michael jackson");

    // A model-supplied value is NEVER overridden.
    let kept = tools.seed_music_arguments("music_artist_top_tracks", json!({"artist": "prince"}));
    assert_eq!(kept["artist"], "prince");

    // Catalog search prefers the most specific span (track over artist).
    let query = tools.seed_music_arguments("music_catalog_search", json!({}));
    assert_eq!(query["query"], "smooth criminal");

    // Unrelated tools are untouched.
    let untouched = tools.seed_music_arguments("knowledge_lookup", json!({}));
    assert_eq!(untouched, json!({}));
}

#[test]
fn without_slots_arguments_pass_through_unchanged() {
    let broker = StaticBroker(json!({"status":"ok"}));
    let tools = AibusToolCatalog::new(&broker, unlocked_authorization(), "play something");
    let raw = json!({"artist": "prince"});
    assert_eq!(
        tools.seed_music_arguments("music_artist_top_tracks", raw.clone()),
        raw
    );
}
