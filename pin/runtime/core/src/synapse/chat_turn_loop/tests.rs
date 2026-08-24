use super::*;
use crate::llm::backend::{LlmFuture, ToolStepFuture};
use crate::llm::tool_step::ToolStepDefinition;
use crate::tier_a::native_actions;
use crate::turn_trace::TracePolicy;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[test]
fn a_screen_formatted_answer_is_spoken_as_prose() {
    let answer = "## Options\n\
                  - **Oat** milk is creamy\n\
                  - *Almond* is lighter\n\
                  1. Try `oat` first\n\
                  See https://example.com/coffee for more";
    let spoken = speakable_answer(answer);

    // None of the screen furniture survives to the narrator.
    for markup in ["#", "**", "*", "`", "- ", "https://"] {
        assert!(
            !spoken.contains(markup),
            "{markup:?} leaked into speech: {spoken}",
        );
    }
    // The prose itself is intact and joined into sentences.
    assert!(spoken.contains("Oat milk is creamy"));
    assert!(spoken.contains("Almond is lighter"));
    assert!(spoken.contains("Try oat first"));
}

#[test]
fn sanitising_never_produces_silence_and_leaves_prose_alone() {
    // A plain sentence must pass through untouched.
    let plain = "It's about four degrees and clear in Copenhagen.";
    assert_eq!(speakable_answer(plain), plain);

    // Ordinals mid-sentence are not list markers.
    let ordinal = "They came 3. in the final standings";
    assert!(speakable_answer(ordinal).contains("3."));

    // An answer that is *only* markup must still say something.
    assert!(!speakable_answer("***").trim().is_empty());

    // And the result is bounded.
    let huge = "word ".repeat(4000);
    assert!(speakable_answer(&huge).len() <= MAX_SPOKEN_ANSWER_BYTES);
}

#[test]
fn a_decline_says_why_instead_of_one_sentence_for_every_cause() {
    // The provider layer has already turned this into a speakable sentence;
    // the whole point is that it survives to the user.
    let key = "There's a problem with the API key configuration. Please check the server settings.";
    assert_eq!(
        decline_speech(ChatTurnDeclineReason::BackendUnavailable, Some(key)),
        key,
    );

    // Each non-backend reason is distinct and suggests what actually helps,
    // rather than all collapsing to the generic line.
    let budget = decline_speech(ChatTurnDeclineReason::Budget, None);
    let empty = decline_speech(ChatTurnDeclineReason::EmptyModel, None);
    let stuck = decline_speech(ChatTurnDeclineReason::NoProgress, None);
    for spoken in [&budget, &empty, &stuck] {
        assert_ne!(spoken.as_str(), CHAT_TURN_GENERIC_DECLINE);
    }
    assert_ne!(budget, empty);
    assert_ne!(empty, stuck);
}

#[test]
fn a_wearable_never_reads_a_developer_string_aloud() {
    // Developer-facing producers are translated, not narrated verbatim.
    let spoken = decline_speech(
        ChatTurnDeclineReason::BackendUnavailable,
        Some("the configured model backend does not support the tool-step loop"),
    );
    assert!(!spoken.contains("tool-step loop"));
    assert!(spoken.contains("server settings"));

    // Anything unexpectedly long is a raw diagnostic that escaped.
    let raw = "x".repeat(MAX_SPOKEN_BACKEND_ERROR_BYTES + 1);
    assert_eq!(
        decline_speech(ChatTurnDeclineReason::BackendUnavailable, Some(&raw)),
        CHAT_TURN_GENERIC_DECLINE,
    );

    // An empty or whitespace error must not narrate an empty sentence.
    assert_eq!(
        decline_speech(ChatTurnDeclineReason::BackendUnavailable, Some("   ")),
        CHAT_TURN_GENERIC_DECLINE,
    );
}

/// The error sentences the Codex provider writes, exactly as they appear in
/// its source.
///
/// These are written for whoever administers the host: they name the
/// bridge, the transport and the HTTP status, and several instruct the
/// reader to go restart or reconfigure something. None of that is speech.
/// They reach this module as the `backend_error` of a declined turn, so
/// this is the fixture that proves the speech boundary rewrites them.
///
/// A copied fixture normally rots in silence; this one is pinned against
/// `codex.rs` itself by `the_codex_error_fixture_still_matches_its_source`,
/// so rewording a provider sentence turns that test red rather than quietly
/// dropping the sentence out of the corpus.
const CODEX_SOURCE_ERROR_LITERALS: &[&str] = &[
    "The Codex bridge token is not configured. Add it in server settings.",
    "The Codex bridge returned an empty response.",
    "The Codex bridge returned an invalid response.",
    "The Codex bridge returned an invalid response. Please restart the host bridge.",
    "The camera image is too large for vision analysis.",
    "The camera returned an unsupported image format.",
    "The Codex host bridge timed out. Please try again.",
    "I couldn't reach the Codex host bridge. Check Wi-Fi and the bridge process.",
    "The Codex host bridge could not be verified. Check Wi-Fi, TLS, and the bridge process.",
    "The Codex bridge token was rejected. Check the server settings.",
    "Codex on the host is unavailable right now. Please try again.",
    // Interpolated at the call site; rendered below with a real status.
    "The Codex host bridge failed with HTTP status {status}.",
];

/// The fixture as it actually arrives, with the one format hole filled.
fn codex_backend_errors() -> Vec<String> {
    CODEX_SOURCE_ERROR_LITERALS
        .iter()
        .map(|literal| literal.replace("{status}", "503 Service Unavailable"))
        .collect()
}

#[test]
fn the_codex_error_fixture_still_matches_its_source() {
    const CODEX_SOURCE: &str = include_str!("../../llm/providers/codex.rs");
    // Aliveness: a path that stopped resolving to the provider, or a scan
    // that matched nothing, would make every assertion below vacuous.
    assert!(
        CODEX_SOURCE.contains("fn bridge_status_error"),
        "the fixture is no longer reading the Codex provider",
    );
    for literal in CODEX_SOURCE_ERROR_LITERALS {
        assert!(
            CODEX_SOURCE.contains(literal),
            "the Codex provider no longer says this, so the corpus stopped covering it: {literal}",
        );
    }
}

/// Everything a wearer can hear from this module, built by CALLING the
/// producers rather than by copying their text, so a new decline reason or
/// a reworded sentence is covered automatically.
///
/// It also covers both halves of the backend-error boundary: the sentences
/// `llm::error` authors for a wearer (which pass through untouched) and the
/// Codex provider's host-operator sentences (which must not).
fn spoken_corpus() -> Vec<String> {
    let mut corpus = vec![CHAT_TURN_GENERIC_DECLINE.to_string()];
    for reason in [
        ChatTurnDeclineReason::Budget,
        ChatTurnDeclineReason::EmptyModel,
        ChatTurnDeclineReason::NoProgress,
        ChatTurnDeclineReason::BackendUnavailable,
    ] {
        corpus.push(decline_speech(reason, None));
    }
    // The two developer-facing producers this module translates itself.
    corpus.push(speakable_backend_error(
        "the configured model backend does not support the tool-step loop",
    ));
    corpus.push(speakable_backend_error("oversized arguments for one call"));
    // An over-long raw diagnostic must fall back, not be narrated.
    corpus.push(decline_speech(
        ChatTurnDeclineReason::BackendUnavailable,
        Some(&"x".repeat(MAX_SPOKEN_BACKEND_ERROR_BYTES + 1)),
    ));
    // The whitelisted provider sentences, called rather than copied.
    for authored in WEARER_FACING_ERRORS {
        corpus.push(decline_speech(
            ChatTurnDeclineReason::BackendUnavailable,
            Some(authored),
        ));
    }
    // Every Codex host-operator sentence, as the wearer would hear it.
    for raw in codex_backend_errors() {
        corpus.push(decline_speech(
            ChatTurnDeclineReason::BackendUnavailable,
            Some(&raw),
        ));
    }
    corpus
}

#[test]
fn a_provider_sentence_written_for_the_host_is_not_read_to_the_wearer() {
    // The measured leak: a person on a pavement told to check TLS on a
    // computer they are not near.
    let spoken = decline_speech(
        ChatTurnDeclineReason::BackendUnavailable,
        Some("The Codex host bridge could not be verified. Check Wi-Fi, TLS, and the bridge process."),
    );
    assert!(!spoken.contains("TLS"));
    assert!(!spoken.contains("bridge"));

    // Softened for the ear, never for the log: the classifiers that drive
    // retry and triage still read the untouched original.
    let raw = "The Codex host bridge failed with HTTP status 503 Service Unavailable.";
    assert!(!speakable_backend_error(raw).contains("503"));
    assert_eq!(chat_turn_backend_error_category(raw), "backend_other");
    assert!(chat_turn_backend_error_is_retryable(raw));

    // A sentence the provider layer already wrote for a wearer survives
    // intact — the arm is a whitelist, not a blanket rewrite.
    let authored = "The AI service is temporarily unavailable. Please try again shortly.";
    assert!(WEARER_FACING_ERRORS.contains(&authored));
    assert_eq!(speakable_backend_error(authored), authored);
}

#[test]
fn the_internal_vocabulary_matcher_is_falsifiable() {
    // Positive controls: a broken matcher must not pass vacuously.
    assert_eq!(
        internal_vocabulary_hit("I can't access music search or playback in this run."),
        Some("in this run"),
    );
    assert_eq!(
        internal_vocabulary_hit("Copy the from_call_id from the earlier call."),
        Some("call id"),
    );
    assert_eq!(
        internal_vocabulary_hit("The PROVIDER is unavailable."),
        Some("provider"),
    );

    // Negative controls: ordinary speech, including words that merely
    // contain a banned term, must stay clean.
    for clean in [
        "Unlock your Pin and ask again.",
        "I couldn't find that song. Try naming the artist.",
        "You're running late for the 9am.",
        "It's sixteen degrees and cloudy.",
    ] {
        assert_eq!(internal_vocabulary_hit(clean), None, "{clean}");
    }

    // Every entry carries a reason, so the list cannot rot into folklore.
    for (term, why) in INTERNAL_VOCABULARY {
        assert!(!term.is_empty() && !why.is_empty(), "{term}: {why}");
        assert_eq!(
            internal_vocabulary_hit(&format!("a sentence with {term} inside")),
            Some(*term),
            "{term} is listed but unmatchable",
        );
    }
}

#[test]
fn a_spoken_decline_never_carries_internal_vocabulary() {
    let corpus = spoken_corpus();
    // Aliveness: an empty or collapsed corpus would pass vacuously. The
    // floor counts the eight lines this module authors plus both halves of
    // the backend-error boundary, so losing either half is red.
    assert!(
        corpus.len() >= 8 + WEARER_FACING_ERRORS.len() + CODEX_SOURCE_ERROR_LITERALS.len(),
        "corpus collapsed: {}",
        corpus.len(),
    );
    assert!(
        corpus.iter().any(|line| line == CHAT_TURN_GENERIC_DECLINE),
        "the generic decline vanished from the corpus",
    );
    assert!(
        CODEX_SOURCE_ERROR_LITERALS.len() >= 10,
        "the Codex fixture collapsed: {}",
        CODEX_SOURCE_ERROR_LITERALS.len(),
    );

    for line in &corpus {
        assert!(!line.trim().is_empty(), "a spoken line was empty");
        assert_eq!(
            internal_vocabulary_hit(line),
            None,
            "internal vocabulary reached speech: {line}",
        );
        // A wearable answer over ~200 characters is interrupted mid-
        // delivery. A decline is one short sentence by construction, so
        // hold it to the tighter narratable-error ceiling this module
        // already owns rather than the outer spoken-answer limit.
        assert!(
            line.len() <= MAX_SPOKEN_BACKEND_ERROR_BYTES,
            "spoken line is too long to survive the narrator: {line}",
        );
    }

    // The assertion mechanism itself goes red on a planted leak.
    assert!(internal_vocabulary_hit(&format!("{CHAT_TURN_GENERIC_DECLINE} in this run")).is_some());
}

#[test]
fn permanent_faults_do_not_spend_the_rest_of_the_deadline_retrying() {
    // These fail identically on every retry, so the grace path only delays
    // a failure we can already describe.
    for permanent in [
        "There's a problem with the API key configuration. Please check the server settings.",
        "The configured AI model wasn't found. Please check the server settings.",
        "The AI service declined to answer that. Try rephrasing your question.",
        "the configured model backend does not support the tool-step loop",
    ] {
        assert!(
            !chat_turn_backend_error_is_retryable(permanent),
            "should be permanent: {permanent}",
        );
    }

    // Transient faults keep the grace path, which is what stops one hiccup
    // from discarding work already gathered.
    for transient in [
        "The request to the AI service timed out. Please try again.",
        "I couldn't reach the AI service. Please check the server's internet connection.",
        "I'm getting too many requests right now. Please try again in a moment.",
        "connection reset",
    ] {
        assert!(
            chat_turn_backend_error_is_retryable(transient),
            "should be retryable: {transient}",
        );
    }
}

// ---- scripted backend: returns pre-scripted step results in order ----
struct ScriptedBackend {
    steps: Mutex<std::collections::VecDeque<Result<ToolStepResult, String>>>,
    seen_tool_counts: Mutex<Vec<usize>>,
    seen_message_counts: Mutex<Vec<usize>>,
    seen_messages: Mutex<Vec<Vec<Message>>>,
    seen_timeouts: Mutex<Vec<Duration>>,
    finished_sessions: Mutex<Vec<String>>,
}
impl ScriptedBackend {
    fn new(steps: Vec<Result<ToolStepResult, String>>) -> Self {
        Self {
            steps: Mutex::new(steps.into_iter().collect()),
            seen_tool_counts: Mutex::new(Vec::new()),
            seen_message_counts: Mutex::new(Vec::new()),
            seen_messages: Mutex::new(Vec::new()),
            seen_timeouts: Mutex::new(Vec::new()),
            finished_sessions: Mutex::new(Vec::new()),
        }
    }
}
impl LlmBackend for ScriptedBackend {
    fn chat<'a>(&'a self, _request: crate::llm::LlmChatRequest) -> LlmFuture<'a> {
        Box::pin(async { Err("unused".to_string()) })
    }
    fn tool_step<'a>(&'a self, request: ToolStepRequest) -> ToolStepFuture<'a> {
        self.seen_tool_counts
            .lock()
            .unwrap()
            .push(request.tools.len());
        self.seen_message_counts
            .lock()
            .unwrap()
            .push(request.messages.len());
        self.seen_messages
            .lock()
            .unwrap()
            .push(request.messages.clone());
        self.seen_timeouts.lock().unwrap().push(request.timeout);
        let next = self.steps.lock().unwrap().pop_front();
        Box::pin(async move { next.unwrap_or_else(|| Err("script exhausted".to_string())) })
    }

    fn finish_tool_session(&self, correlation: &str) {
        self.finished_sessions
            .lock()
            .unwrap()
            .push(correlation.to_string());
    }
}

// ---- scripted tools ----
struct ScriptedTools {
    outcomes: Mutex<std::collections::HashMap<String, ToolExecutionOutcome>>,
    catalog_names: Vec<&'static str>,
    cue: Option<String>,
    cue_requests: Mutex<Vec<Vec<String>>>,
    executed: Mutex<Vec<String>>,
}
impl ScriptedTools {
    fn new(cue: Option<&str>) -> Self {
        Self {
            outcomes: Mutex::new(std::collections::HashMap::new()),
            catalog_names: vec!["knowledge_lookup"],
            cue: cue.map(|c| c.to_string()),
            cue_requests: Mutex::new(Vec::new()),
            executed: Mutex::new(Vec::new()),
        }
    }
    fn with_catalog(mut self, names: Vec<&'static str>) -> Self {
        self.catalog_names = names;
        self
    }
    fn with(self, name: &str, outcome: ToolExecutionOutcome) -> Self {
        self.outcomes
            .lock()
            .unwrap()
            .insert(name.to_string(), outcome);
        self
    }
}
#[tonic::async_trait]
impl ToolCatalog for ScriptedTools {
    fn catalog(&self) -> Vec<ToolStepDefinition> {
        self.catalog_names
            .iter()
            .map(|name| ToolStepDefinition {
                name,
                description: "test tool",
                parameters: serde_json::json!({"type":"object"}),
            })
            .collect()
    }
    fn cue_for(&self, tool_names: &[&str]) -> Option<String> {
        self.cue_requests
            .lock()
            .unwrap()
            .push(tool_names.iter().map(|name| (*name).to_string()).collect());
        self.cue.clone()
    }
    async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
        self.executed.lock().unwrap().push(call.name.clone());
        self.outcomes
            .lock()
            .unwrap()
            .get(&call.name)
            .cloned()
            .unwrap_or(ToolExecutionOutcome::Observation {
                ok: false,
                content: "unknown tool".to_string(),
            })
    }
}

struct BarrierReads {
    barrier: tokio::sync::Barrier,
    executed: Mutex<Vec<String>>,
}

impl BarrierReads {
    fn new() -> Self {
        Self {
            barrier: tokio::sync::Barrier::new(2),
            executed: Mutex::new(Vec::new()),
        }
    }
}

#[tonic::async_trait]
impl ToolCatalog for BarrierReads {
    fn catalog(&self) -> Vec<ToolStepDefinition> {
        ["alpha_read", "beta_read"]
            .into_iter()
            .map(|name| ToolStepDefinition {
                name,
                description: "independent test read",
                parameters: serde_json::json!({"type":"object"}),
            })
            .collect()
    }

    fn cue_for(&self, _tool_names: &[&str]) -> Option<String> {
        None
    }

    async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
        self.executed.lock().unwrap().push(call.name.clone());
        // A serial implementation blocks forever on the first call. The
        // surrounding test timeout therefore proves both futures were
        // actually polled together, not merely appended as one transcript.
        self.barrier.wait().await;
        ToolExecutionOutcome::Observation {
            ok: true,
            content: format!("{} result", call.name),
        }
    }

    fn parallel_read_safe(&self, tool_name: &str) -> bool {
        matches!(tool_name, "alpha_read" | "beta_read")
    }
}

struct RecordingCues(Mutex<Vec<String>>);
impl ChatTurnCueSink for RecordingCues {
    fn emit(&self, cue: ChatTurnProgressCue<'_>) {
        assert!(!cue.run_id().is_empty());
        assert!(!cue.operation().is_empty());
        self.0.lock().unwrap().push(cue.phrase().to_string());
    }
}

struct RecordingCueEvents(Mutex<Vec<(String, String, String)>>);
impl ChatTurnCueSink for RecordingCueEvents {
    fn emit(&self, cue: ChatTurnProgressCue<'_>) {
        self.0.lock().unwrap().push((
            cue.run_id().to_string(),
            cue.operation().to_string(),
            cue.phrase().to_string(),
        ));
    }
}

/// Records the selected tool-call lifecycle so multi-step runs can assert
/// the exact stock mid-run wire shape and its ordering.
#[derive(Default)]
struct RecordingTurns(Mutex<Vec<String>>);
impl ChatTurnObserver for RecordingTurns {
    fn on_batch_start(&self, first_tool: &str) {
        self.0.lock().unwrap().push(format!("start:{first_tool}"));
    }
    fn on_batch_end(&self, first_tool: &str, ok: bool) {
        self.0
            .lock()
            .unwrap()
            .push(format!("end:{first_tool}:{ok}"));
    }
}

fn call(name: &str) -> ToolStepCall {
    ToolStepCall {
        call_id: format!("{name}-1"),
        name: name.to_string(),
        arguments: serde_json::json!({}),
    }
}

fn transcript_tool_call_names(messages: &[Message]) -> Vec<String> {
    let mut names = Vec::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for item in content.iter() {
            if let AssistantContent::ToolCall(call) = item {
                names.push(call.function.name.clone());
            }
        }
    }
    names
}

fn transcript_tool_result_ids(messages: &[Message]) -> Vec<String> {
    let mut ids = Vec::new();
    for message in messages {
        let Message::User { content } = message else {
            continue;
        };
        for item in content.iter() {
            if let UserContent::ToolResult(result) = item {
                ids.push(result.id.clone());
            }
        }
    }
    ids
}

fn transcript_tool_result_texts(messages: &[Message]) -> Vec<String> {
    let mut texts = Vec::new();
    for message in messages {
        let Message::User { content } = message else {
            continue;
        };
        for item in content.iter() {
            let UserContent::ToolResult(result) = item else {
                continue;
            };
            for result_content in result.content.iter() {
                if let ToolResultContent::Text(text) = result_content {
                    texts.push(text.text.clone());
                }
            }
        }
    }
    texts
}

/// Test driver with a real timer. The loop keeps progress audible across a
/// slow model step via `tokio::time::sleep`, which needs a tokio reactor —
/// `futures::executor::block_on` has none and panics.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("test runtime")
        .block_on(future)
}

const TRACE_CORRELATION: &str = "223e4567-e89b-42d3-a456-426614174000";

#[derive(Clone, Default)]
struct TraceWriter(Arc<Mutex<Vec<u8>>>);

struct TraceWriterGuard(Arc<Mutex<Vec<u8>>>);

impl Write for TraceWriterGuard {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("trace writer lock").extend(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for TraceWriter {
    type Writer = TraceWriterGuard;

    fn make_writer(&'writer self) -> Self::Writer {
        TraceWriterGuard(Arc::clone(&self.0))
    }
}

fn capture_physical_trace<T>(run: impl FnOnce() -> T) -> (T, Vec<String>) {
    let writer = TraceWriter::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(writer.clone())
        .with_ansi(false)
        .without_time()
        .compact()
        .with_target(true)
        .finish();
    let result = tracing::subscriber::with_default(subscriber, run);
    let bytes = writer.0.lock().expect("trace bytes lock").clone();
    let output = String::from_utf8(bytes).expect("trace output is UTF-8");
    let events = output
        .lines()
        .filter_map(|line| {
            line.find(operational_markers::AGENTIC_PHYSICAL_TRACE)
                .map(|index| line[index..].to_string())
        })
        .collect();
    (result, events)
}

fn physical_trace_event(ordinal: usize, tool: &str, result_status: Option<&str>) -> String {
    format!(
        "{} correlation={TRACE_CORRELATION} ordinal={ordinal} tool={tool} status=completed{}",
        operational_markers::AGENTIC_PHYSICAL_TRACE,
        result_status
            .map(|status| format!(" result_status={status}"))
            .unwrap_or_default()
    )
}

fn traced_loop<'a>(
    backend: &'a dyn LlmBackend,
    tools: &'a dyn ToolCatalog,
    cues: &'a dyn ChatTurnCueSink,
    observer: &'a dyn ChatTurnObserver,
    max_iterations: usize,
) -> ChatTurnLoop<'a> {
    ChatTurnLoop {
        backend,
        tools,
        cues,
        observer,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: TRACE_CORRELATION.to_string(),
        config: ChatTurnLoopConfig::new(max_iterations),
    }
}

#[test]
fn physical_trace_emits_one_terminal_for_a_direct_answer() {
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("Six million.".into()))]);
    let tools = ScriptedTools::new(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);

    let (outcome, events) =
        capture_physical_trace(|| block_on(loop_.run("how many people live there")));

    assert_eq!(outcome, ChatTurnOutcome::Answer("Six million.".into()));
    assert_eq!(events, [physical_trace_event(1, "terminal", None)]);
    assert_eq!(
        backend.finished_sessions.lock().unwrap().as_slice(),
        &[TRACE_CORRELATION],
        "a terminal answer must retire the retained provider thread"
    );
}

#[test]
fn physical_trace_records_reads_replay_and_terminal_contiguously() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::ToolCalls(vec![call("current_weather")])),
        Ok(ToolStepResult::Final("Best effort.".into())),
    ]);
    let tools = ScriptedTools::new(None)
        .with_catalog(vec!["knowledge_lookup", "current_weather"])
        .with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "public fact".into(),
            },
        )
        .with(
            "current_weather",
            ToolExecutionOutcome::Observation {
                ok: false,
                content: "not available".into(),
            },
        );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 6);

    let (outcome, events) = capture_physical_trace(|| block_on(loop_.run("answer with two reads")));

    assert_eq!(outcome, ChatTurnOutcome::Answer("Best effort.".into()));
    assert_eq!(
        tools.executed.lock().unwrap().as_slice(),
        &["knowledge_lookup", "current_weather"],
        "the identical second read is replayed, but still consumes a trace ordinal"
    );
    assert_eq!(
        events,
        [
            physical_trace_event(1, "knowledge_lookup", Some("ok")),
            physical_trace_event(2, "knowledge_lookup", Some("ok")),
            physical_trace_event(3, "current_weather", Some("unavailable")),
            physical_trace_event(4, "terminal", None),
        ]
    );
}

#[test]
fn physical_trace_preserves_the_next_ordinal_across_preflight_resume() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::ToolCalls(vec![call("current_location")])),
    ]);
    let tools = ScriptedTools::new(None)
        .with_catalog(vec!["knowledge_lookup", "current_location"])
        .with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "public fact".into(),
            },
        )
        .with(
            "current_location",
            ToolExecutionOutcome::Preflight {
                action: native_actions::GET_CURRENT_LOCATION.into(),
                arguments: serde_json::json!({}),
            },
        );
    let resumed_backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("nearby_search")])),
        Ok(ToolStepResult::Final("Three places.".into())),
    ]);
    let resumed_tools = ScriptedTools::new(None)
        .with_catalog(vec!["current_location", "nearby_search"])
        .with(
            "current_location",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "fresh location".into(),
            },
        )
        .with(
            "nearby_search",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "three places".into(),
            },
        );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let resumed_observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 6);
    let resumed_loop = traced_loop(
        &resumed_backend,
        &resumed_tools,
        &resumed_cues,
        &resumed_observer,
        6,
    );

    let ((initial, resumed, next_suspension), events) = capture_physical_trace(|| {
        let (initial, suspension) = block_on(loop_.run_suspendable("find somewhere nearby"));
        let suspension = suspension.expect("preflight must contain its transcript");
        assert_eq!(
            suspension.next_trace_ordinal, 2,
            "the pending preflight has not completed and must not consume an ordinal"
        );
        let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
        (initial, resumed, next_suspension)
    });

    assert!(matches!(initial, ChatTurnOutcome::Preflight { .. }));
    assert_eq!(resumed, ChatTurnOutcome::Answer("Three places.".into()));
    assert!(next_suspension.is_none());
    assert_eq!(
        events,
        [
            physical_trace_event(1, "knowledge_lookup", Some("ok")),
            physical_trace_event(2, "current_location", Some("ok")),
            physical_trace_event(3, "nearby_search", Some("ok")),
            physical_trace_event(4, "terminal", None),
        ],
        "preflight emits nothing until resume completes the pending call"
    );
}

#[test]
fn physical_trace_records_a_selected_mutation_before_terminal() {
    let action = ValidatedNativeAction {
        action: native_actions::PLAY_MUSIC.into(),
        arguments: serde_json::json!({"Track":"T","Artist":"A"}),
    };
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "play_music",
    )]))]);
    let tools = ScriptedTools::new(None)
        .with_catalog(vec!["play_music"])
        .with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 3);

    let (outcome, events) =
        capture_physical_trace(|| block_on(loop_.run("play the selected track")));

    assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
    assert_eq!(
        events,
        [
            physical_trace_event(1, "other_registered_tool", Some("ok")),
            physical_trace_event(2, "terminal", None),
        ]
    );
}

#[test]
fn physical_trace_replaces_an_unadvertised_name_with_the_invalid_placeholder() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call(
            "private_text_from_model",
        )])),
        Ok(ToolStepResult::Final("I couldn't use that.".into())),
    ]);
    let tools = ScriptedTools::new(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 3);

    let (outcome, events) = capture_physical_trace(|| block_on(loop_.run("try an invented call")));

    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("I couldn't use that.".into())
    );
    assert_eq!(
        events,
        [
            physical_trace_event(1, "invalid_tool", Some("invalid")),
            physical_trace_event(2, "terminal", None),
        ]
    );
    assert!(
        events
            .iter()
            .all(|event| !event.contains("private_text_from_model")),
        "untrusted model text must not cross the physical-proof boundary"
    );
}

// ---- turn trace: the durable per-turn decision chain ----

fn tracer_for(policy: TracePolicy, utterance: &str) -> TurnTracer {
    TurnTracer::new(
        policy,
        TRACE_CORRELATION,
        utterance,
        "2026-07-31T09:00:00Z".to_string(),
    )
}

fn enabled_trace(utterance: &str, include_content: bool) -> (TurnTracer, ChatTurnTrace) {
    let tracer = tracer_for(
        TracePolicy {
            enabled: true,
            include_content,
        },
        utterance,
    );
    let trace = ChatTurnTrace::new(tracer.clone(), "codex", "gpt-5.6-sol");
    (tracer, trace)
}

/// The recorded chain as an order-preserving list of short shapes, so a test
/// pins the sequence rather than one event in isolation.
fn trace_shape(tracer: &TurnTracer) -> Vec<String> {
    tracer
        .finish()
        .expect("an enabled tracer yields a record")
        .events
        .iter()
        .map(|event| match event {
            TraceEvent::ModelStep {
                iteration,
                tool_calls,
                ..
            } => format!("model_step:{iteration}:[{}]", tool_calls.join(",")),
            TraceEvent::ToolCall {
                ordinal,
                tool,
                ok,
                status,
                ..
            } => format!("tool_call:{ordinal}:{tool}:{ok}:{status}"),
            TraceEvent::GateDecision {
                gate,
                allowed,
                reason,
                ..
            } => format!("gate:{gate}:{allowed}:{reason}"),
            TraceEvent::Terminal {
                outcome,
                spoken_chars,
                ..
            } => format!("terminal:{outcome}:{spoken_chars}"),
            TraceEvent::Note { marker, .. } => format!("note:{marker}"),
        })
        .collect()
}

/// Instrumentation that changes the run is worse than no instrumentation.
/// A disabled trace must leave the outcome, the tool executions and the
/// exact transcript the provider was shown byte-identical to the untraced
/// entry point — and must produce no record at all.
#[test]
fn a_disabled_trace_changes_neither_the_outcome_nor_the_transcript() {
    fn run_once(
        trace: Option<&ChatTurnTrace>,
    ) -> (ChatTurnOutcome, Vec<String>, Vec<Vec<Message>>) {
        let backend = ScriptedBackend::new(vec![
            Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
            Ok(ToolStepResult::Final("Six million.".into())),
        ]);
        let tools = ScriptedTools::new(None).with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "public fact".into(),
            },
        );
        let cues = RecordingCues(Mutex::new(Vec::new()));
        let observer = NoopTurnObserver;
        let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
        let utterance = "how many people live there";
        let outcome = match trace {
            Some(trace) => block_on(loop_.run_traced(utterance, trace)),
            None => block_on(loop_.run(utterance)),
        };
        let executed = tools.executed.lock().unwrap().clone();
        let seen = backend.seen_messages.lock().unwrap().clone();
        (outcome, executed, seen)
    }

    let (untraced_outcome, untraced_tools, untraced_messages) = run_once(None);

    // Content capture is deliberately ON here: even the most permissive
    // policy must be inert while `enabled` is false.
    let tracer = tracer_for(
        TracePolicy {
            enabled: false,
            include_content: true,
        },
        "how many people live there",
    );
    let (traced_outcome, traced_tools, traced_messages) =
        run_once(Some(&ChatTurnTrace::new(tracer.clone(), "codex", "sol")));

    assert_eq!(untraced_outcome, traced_outcome);
    assert_eq!(untraced_tools, traced_tools);
    assert_eq!(
        untraced_messages, traced_messages,
        "the provider must be shown exactly the same transcript"
    );
    assert!(
        tracer.finish().is_none(),
        "a disabled tracer must not produce a record"
    );
}

/// The chain a normal turn produces: one model step per call, the tool it
/// ran, the gate that accepted the answer, and one terminal.
#[test]
fn an_enabled_trace_records_the_ordered_chain_of_a_tool_then_answer_turn() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final("Six million.".into())),
    ]);
    let tools = ScriptedTools::new(None).with(
        "knowledge_lookup",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: "public fact".into(),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
    let (tracer, trace) = enabled_trace("how many people live there", true);

    let outcome = block_on(loop_.run_traced("how many people live there", &trace));

    assert_eq!(outcome, ChatTurnOutcome::Answer("Six million.".into()));
    assert_eq!(
        trace_shape(&tracer),
        [
            "model_step:0:[knowledge_lookup]",
            "tool_call:1:knowledge_lookup:true:ok",
            "model_step:1:[]",
            "gate:final_answer_verification:true:final_answer_accepted",
            "terminal:respond:12",
        ]
    );

    let record = tracer.finish().expect("record");
    match &record.events[0] {
        TraceEvent::ModelStep {
            provider,
            model,
            prompt_chars,
            completion_chars,
            text,
            ..
        } => {
            assert_eq!(provider, "codex");
            assert_eq!(model, "gpt-5.6-sol");
            // System prompt ("sys") plus the utterance, and nothing else yet.
            assert_eq!(*prompt_chars, 3 + "how many people live there".len());
            assert_eq!(*completion_chars, 0, "a tool step produced no prose");
            assert!(text.is_none());
        }
        other => panic!("expected the first event to be a model step, got {other:?}"),
    }
    match &record.events[1] {
        TraceEvent::ToolCall {
            arguments, result, ..
        } => {
            assert_eq!(arguments.as_deref(), Some("{}"));
            assert_eq!(
                result.as_deref(),
                Some("public fact"),
                "the observation the model was actually given is the evidence"
            );
        }
        other => panic!("expected a tool call, got {other:?}"),
    }
    match record.events.last().expect("terminal") {
        TraceEvent::Terminal {
            outcome,
            action,
            spoken_text,
            ..
        } => {
            assert_eq!(outcome, "respond");
            assert!(action.is_none());
            assert_eq!(spoken_text.as_deref(), Some("Six million."));
        }
        other => panic!("expected a terminal, got {other:?}"),
    }
}

/// The failure that motivated all of this: a refusal has to name the gate
/// and give a stable machine reason, not just leave a marker in a log that
/// has since rolled.
#[test]
fn a_refused_final_answer_records_the_verification_gate_with_its_reason() {
    struct NudgingTools(ScriptedTools);
    #[tonic::async_trait]
    impl ToolCatalog for NudgingTools {
        fn catalog(&self) -> Vec<ToolStepDefinition> {
            self.0.catalog()
        }
        fn cue_for(&self, names: &[&str]) -> Option<String> {
            self.0.cue_for(names)
        }
        async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
            self.0.execute(call).await
        }
        fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
            Some("Call play_music now.".to_string())
        }
    }
    let action = ValidatedNativeAction {
        action: native_actions::PLAY_MUSIC.into(),
        arguments: serde_json::json!({"Track":"T","Artist":"A"}),
    };
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::Final("Here are the songs.".into())),
        Ok(ToolStepResult::ToolCalls(vec![call("play_music")])),
    ]);
    let tools = NudgingTools(
        ScriptedTools::new(None).with("play_music", ToolExecutionOutcome::Terminal(action.clone())),
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
    let (tracer, trace) = enabled_trace("play the thing", false);

    let outcome = block_on(loop_.run_traced("play the thing", &trace));

    assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
    assert_eq!(
        trace_shape(&tracer),
        [
            "model_step:0:[]".to_string(),
            "gate:final_answer_verification:false:final_answer_nudged".to_string(),
            "model_step:1:[play_music]".to_string(),
            "tool_call:1:play_music:true:terminal".to_string(),
            format!("terminal:{}:0", native_actions::PLAY_MUSIC),
        ]
    );

    let record = tracer.finish().expect("record");
    let TraceEvent::GateDecision { shape, .. } = &record.events[1] else {
        panic!("expected the refusal to be a gate decision");
    };
    assert_eq!(
        shape,
        &[
            ("iteration".to_string(), 0),
            ("answer_chars".to_string(), 19),
        ],
        "a refusal must contain the shape it judged, not just the verdict"
    );
    assert!(
        record
            .events
            .iter()
            .all(|event| !format!("{event:?}").contains("Here are the songs")),
        "content capture is off, so no free text may be recorded"
    );
}

/// A backend failure must record which way it was classified: a permanent
/// fault declining immediately and a transient one buying a grace answer
/// are the same spoken outcome and completely different bugs.
#[test]
fn a_backend_failure_records_its_retryable_classification_and_decline() {
    // A permanent fault, worded exactly as the provider layer emits it.
    const KEY_ERROR: &str =
        "There's a problem with the API key configuration. Please check the server settings.";
    let backend = ScriptedBackend::new(vec![Err(KEY_ERROR.into())]);
    let tools = ScriptedTools::new(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);
    let (tracer, trace) = enabled_trace("what's the weather", true);

    let outcome = block_on(loop_.run_traced("what's the weather", &trace));

    assert!(matches!(outcome, ChatTurnOutcome::Decline(_)));
    assert_eq!(
        trace_shape(&tracer),
        [
            "note:backend_error_backend_other".to_string(),
            "gate:backend_step:false:permanent_backend_error".to_string(),
            "gate:decline:false:backend_unavailable".to_string(),
            format!("terminal:decline:{}", KEY_ERROR.chars().count()),
        ],
        "no model step is recorded for a call that never returned one"
    );

    let record = tracer.finish().expect("record");
    let TraceEvent::Terminal { spoken_text, .. } = record.events.last().expect("terminal") else {
        panic!("expected a terminal");
    };
    assert_eq!(
        spoken_text.as_deref(),
        Some(KEY_ERROR),
        "the trace must hold what the wearer actually heard"
    );
    let TraceEvent::GateDecision { shape, .. } = &record.events[1] else {
        panic!("expected the classification to be a gate decision");
    };
    assert_eq!(
        shape
            .iter()
            .map(|(key, value)| (key.as_str(), *value))
            .filter(|(key, _)| *key != "latency_ms")
            .collect::<Vec<_>>(),
        [("iteration", 0), ("retryable", 0)],
        "a permanent fault must be recorded as not retryable",
    );
}

#[test]
fn cancelling_a_pending_run_does_not_fabricate_a_terminal_trace() {
    struct PendingBackend(std::sync::atomic::AtomicUsize);
    impl LlmBackend for PendingBackend {
        fn chat<'a>(&'a self, _request: crate::llm::LlmChatRequest) -> LlmFuture<'a> {
            Box::pin(async { Err("unused".to_string()) })
        }

        fn tool_step<'a>(&'a self, _request: ToolStepRequest) -> ToolStepFuture<'a> {
            Box::pin(std::future::pending::<Result<ToolStepResult, String>>())
        }

        fn finish_tool_session(&self, _correlation: &str) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    let backend = PendingBackend(std::sync::atomic::AtomicUsize::new(0));
    let tools = ScriptedTools::new(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = NoopTurnObserver;
    let loop_ = traced_loop(&backend, &tools, &cues, &observer, 4);

    let (timed_out, events) = capture_physical_trace(|| {
        block_on(async {
            tokio::time::timeout(
                Duration::from_millis(5),
                loop_.run("wait on the pending provider"),
            )
            .await
        })
    });

    assert!(timed_out.is_err(), "the test must actually cancel the run");
    assert!(
        events.is_empty(),
        "a dropped future did not complete, so it cannot claim tool or terminal proof"
    );
    assert_eq!(
        backend.0.load(std::sync::atomic::Ordering::Relaxed),
        1,
        "cancelling a run must retire its retained provider thread"
    );
}

fn run_loop(
    backend: &ScriptedBackend,
    tools: &ScriptedTools,
    cues: &dyn ChatTurnCueSink,
    max_iterations: usize,
) -> ChatTurnOutcome {
    run_loop_observed(backend, tools, cues, &NoopTurnObserver, max_iterations)
}

fn run_loop_observed(
    backend: &ScriptedBackend,
    tools: &ScriptedTools,
    cues: &dyn ChatTurnCueSink,
    observer: &dyn ChatTurnObserver,
    max_iterations: usize,
) -> ChatTurnOutcome {
    let loop_ = ChatTurnLoop {
        backend,
        tools,
        cues,
        observer,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(max_iterations),
    };
    block_on(loop_.run("do the thing"))
}

fn reading_tools(cue: Option<&str>) -> ScriptedTools {
    ScriptedTools::new(cue)
        .with(
            "knowledge_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "population 6M".into(),
            },
        )
        .with(
            "weather_lookup",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "12C and clear".into(),
            },
        )
        .with(
            "nearby_search",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: "three cafes".into(),
            },
        )
}

// ---- every abnormal path must still SPEAK, never go silent ----
//
// Each of these maps to AgenticRuntimeOutcome::Decline (understand.rs), which
// becomes a spoken response. A run that produced no outcome at all would
// leave the user staring at a Pin that did nothing.

#[test]
fn an_empty_model_answer_declines_instead_of_speaking_nothing() {
    // The model returns whitespace/no text. Without this guard the user would
    // get an empty utterance, which reads on-device as "it ignored me".
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("   ".into()))]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 4);

    assert!(
        matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
        "an empty model answer must still produce non-empty spoken text, got {outcome:?}"
    );
}

#[test]
fn a_spent_time_budget_forces_the_grace_answer_instead_of_the_outer_timeout() {
    // The loop must convert its last slice into a tool-free answer built
    // from what was gathered. Previously the grace call was scheduled by
    // iteration index only, so a slow run never reached it: the outer
    // breaker fired mid-iteration and the user got a fixed apology while
    // every retrieved observation was thrown away.
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
        "Denmark has about 6 million people.".into(),
    ))]);
    let tools = reading_tools(Some("Working on it"));
    let cues = RecordingCues(Mutex::new(Vec::new()));
    // Budget already spent: the very next iteration must become the grace
    // call even though the iteration ceiling is nowhere near.
    let loop_ = ChatTurnLoop {
        backend: &backend,
        tools: &tools,
        cues: &cues,
        observer: &NoopTurnObserver,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(12).with_time_budget(Duration::from_millis(1)),
    };
    let outcome = block_on(loop_.run("how many people live in denmark"));

    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Denmark has about 6 million people.".into())
    );
    // Exactly one model step: the run went straight to the grace answer
    // rather than burning iterations it had no time for.
    assert_eq!(backend.seen_message_counts.lock().unwrap().len(), 1);
    // Tools withheld on that step — the signature of the grace call.
    assert_eq!(backend.seen_tool_counts.lock().unwrap().as_slice(), &[0]);
    assert!(
        tools.executed.lock().unwrap().is_empty(),
        "the grace call withholds tools"
    );
}

#[test]
fn a_model_step_is_clamped_to_the_budget_the_run_can_still_afford() {
    // The per-step timeout is a fixed circuit breaker sized for the slowest
    // provider path, so on its own it can exceed what is actually left and
    // overrun the whole-run breaker — which discards every observation
    // gathered. The clamp is what makes the grace reserve a real guarantee
    // rather than a nominal one, and it is what stops a future raise of a
    // nested provider deadline from silently busting this budget.
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final("Six million.".into())),
    ]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    // Per-step bound (30s) deliberately larger than the whole budget (10s).
    let loop_ = ChatTurnLoop {
        backend: &backend,
        tools: &tools,
        cues: &cues,
        observer: &NoopTurnObserver,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(30),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(6).with_time_budget(Duration::from_secs(10)),
    };
    let _ = block_on(loop_.run("how many people live in denmark"));

    let timeouts = backend.seen_timeouts.lock().unwrap().clone();
    assert!(!timeouts.is_empty(), "the run must have taken a step");
    for (index, seen) in timeouts.iter().enumerate() {
        assert!(
            *seen <= Duration::from_secs(10),
            "step {index} was handed {seen:?}, which exceeds the whole run \
             budget of 10s; an unclamped step can overrun the outer breaker \
             and throw away every observation gathered"
        );
    }
}

#[test]
fn an_unbudgeted_run_still_gets_the_full_per_step_timeout() {
    // The clamp must only ever subtract time that a budget actually
    // withholds. With no budget configured there is nothing to clamp to,
    // and shortening the step there would be a silent regression.
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("Six million.".into()))]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let _ = run_loop(&backend, &tools, &cues, 4);

    assert_eq!(
        backend.seen_timeouts.lock().unwrap().as_slice(),
        &[Duration::from_secs(5)]
    );
}

#[test]
fn a_step_error_answers_from_gathered_observations_instead_of_declining() {
    // A transient provider hiccup after useful reads must not discard them —
    // declining there reads as flaky because retrying the same utterance
    // then succeeds.
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Err("connection reset".to_string()),
        Ok(ToolStepResult::Final(
            "Denmark has about 6 million people.".into(),
        )),
    ]);
    let tools = reading_tools(Some("Working on it"));
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 8);

    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Denmark has about 6 million people.".into()),
        "the run must answer from the observation it already had"
    );
}

#[test]
fn a_step_error_with_nothing_gathered_still_declines() {
    // No observations yet: there is nothing to answer from, so the honest
    // outcome is the spoken decline.
    let backend = ScriptedBackend::new(vec![Err("connection reset".to_string())]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 8);

    assert!(
        matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
        "got {outcome:?}"
    );
}

/// Drive the real loop with the bounded first-step retry stated explicitly.
/// Never reads the process-wide runtime mirror, so these tests measure the
/// flag and nothing else.
fn run_loop_with_first_step_retry(
    backend: &ScriptedBackend,
    tools: &ScriptedTools,
    cues: &dyn ChatTurnCueSink,
    max_iterations: usize,
    first_step_retry: bool,
) -> ChatTurnOutcome {
    let loop_ = ChatTurnLoop {
        backend,
        tools,
        cues,
        observer: &NoopTurnObserver,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(max_iterations).with_first_step_retry(first_step_retry),
    };
    block_on(loop_.run("do the thing"))
}

#[test]
fn the_first_step_retry_ships_off_and_a_failed_first_step_declines_at_once() {
    // Default-off means byte-for-byte today's behaviour: one step, one
    // decline. The second scripted step exists precisely so that consuming
    // it would be visible — if the flag ever leaked on, this goes red.
    let backend = ScriptedBackend::new(vec![
        Err("connection reset".to_string()),
        Ok(ToolStepResult::Final("Six million.".into())),
    ]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 4, false);

    assert!(
        matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
        "got {outcome:?}"
    );
    assert_eq!(
        backend.seen_message_counts.lock().unwrap().len(),
        1,
        "with the flag off the loop must not spend a second model step"
    );
    // The config default agrees with the explicit `false` above.
    assert!(
        !ChatTurnLoopConfig::new(4).first_step_retry,
        "an unconfigured process must not retry"
    );
}

#[test]
fn an_armed_first_step_retry_re_issues_the_failed_step_exactly_once() {
    // The measured failure: the run's FIRST model step fails with a
    // transient fault, before any tool result exists, so the grace path
    // cannot fire and the turn declines faster than a correct answer would
    // have arrived. Asking again is what a wearer already does by hand.
    let backend = ScriptedBackend::new(vec![
        Err("connection reset".to_string()),
        Ok(ToolStepResult::Final(
            "Denmark has about 6 million people.".into(),
        )),
    ]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 4, true);

    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Denmark has about 6 million people.".into()),
    );
    let messages = backend.seen_messages.lock().unwrap().clone();
    assert_eq!(messages.len(), 2, "exactly one retry, never more");
    assert_eq!(
        messages[0], messages[1],
        "a failed step appends nothing, so the retry must re-issue the identical request"
    );
    // Tools still offered on the retry: it is another attempt at the first
    // step, not the tool-free grace call (which offers zero).
    assert_eq!(backend.seen_tool_counts.lock().unwrap().as_slice(), &[1, 1]);
}

#[test]
fn a_permanent_first_step_fault_is_never_retried_even_when_armed() {
    // A bad key fails identically forever. Retrying it only spends the
    // wearer's wall clock to reach the same answer later, so the
    // permanent-vs-retryable split must gate the retry exactly as it gates
    // the grace path.
    for permanent in [
        "There's a problem with the API key configuration. Please check the server settings.",
        "The configured AI model wasn't found. Please check the server settings.",
        "The AI service declined to answer that. Try rephrasing your question.",
        "the configured model backend does not support the tool-step loop",
    ] {
        let backend = ScriptedBackend::new(vec![
            Err(permanent.to_string()),
            Ok(ToolStepResult::Final("Six million.".into())),
        ]);
        let tools = reading_tools(None);
        let cues = RecordingCues(Mutex::new(Vec::new()));

        let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 4, true);

        assert!(
            matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
            "{permanent} produced {outcome:?}"
        );
        assert_eq!(
            backend.seen_message_counts.lock().unwrap().len(),
            1,
            "a permanent fault must cost exactly one model step: {permanent}"
        );
    }
}

#[test]
fn an_armed_first_step_retry_that_also_fails_declines_once_and_never_loops() {
    // The retry is a one-shot latch, not a counter. Two failures must end
    // the run: a third step would mean the flag can spend the whole
    // deadline re-asking, which is the failure mode a retry must not have.
    let backend = ScriptedBackend::new(vec![
        Err("connection reset".to_string()),
        Err("connection reset".to_string()),
        Ok(ToolStepResult::Final("Six million.".into())),
    ]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 8, true);

    assert!(
        matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
        "got {outcome:?}"
    );
    assert_eq!(
        backend.seen_message_counts.lock().unwrap().len(),
        2,
        "exactly one retry: the scripted answer after it must stay unreached"
    );
}

#[test]
fn an_armed_first_step_retry_does_not_spend_an_iteration_of_the_budget() {
    // The retry re-enters at the same iteration index, so the tool-free
    // grace call stays reachable. With a 2-iteration budget: step 0 fails,
    // step 0 is retried and calls a tool, and iteration 1 is still the
    // grace call that produces the spoken answer.
    let backend = ScriptedBackend::new(vec![
        Err("connection reset".to_string()),
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final("Six million.".into())),
    ]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 2, true);

    assert_eq!(outcome, ChatTurnOutcome::Answer("Six million.".into()));
    assert_eq!(
        tools.executed.lock().unwrap().as_slice(),
        &["knowledge_lookup"],
        "the retried first step still gets a tool-capable iteration"
    );
    assert_eq!(
        backend.seen_tool_counts.lock().unwrap().as_slice(),
        &[1, 1, 0],
        "the last step withholds tools, so the grace call survived the retry"
    );
}

#[test]
fn an_armed_first_step_retry_leaves_the_later_step_grace_path_alone() {
    // A later step that fails after real observations must keep answering
    // from them, exactly as before: the grace path is checked first and the
    // retry latch is never touched.
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Err("connection reset".to_string()),
        Ok(ToolStepResult::Final(
            "Denmark has about 6 million people.".into(),
        )),
    ]);
    let tools = reading_tools(Some("Working on it"));
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop_with_first_step_retry(&backend, &tools, &cues, 8, true);

    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Denmark has about 6 million people.".into()),
    );
    assert_eq!(
        backend.seen_tool_counts.lock().unwrap().as_slice(),
        &[1, 1, 0],
        "the recovery was the tool-free grace answer, not a re-issued step"
    );
}

#[test]
fn a_fast_model_step_never_fires_the_slow_step_cue() {
    // Fast turns must keep their original single-cue cadence — an extra cue
    // there would double-speak moments before the answer.
    struct CountingObserver(std::sync::atomic::AtomicUsize);
    impl ChatTurnObserver for CountingObserver {
        fn on_slow_step(&self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final(
            "Denmark has about 6 million people.".into(),
        )),
    ]);
    let tools = reading_tools(Some("Working on it"));
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let observer = CountingObserver(std::sync::atomic::AtomicUsize::new(0));

    let outcome = run_loop_observed(&backend, &tools, &cues, &observer, 8);

    assert!(matches!(outcome, ChatTurnOutcome::Answer(_)));
    assert_eq!(
        observer.0.load(std::sync::atomic::Ordering::Relaxed),
        0,
        "a scripted (instant) step must not be treated as slow"
    );
}

#[test]
fn the_slow_step_threshold_sits_above_normal_model_latency() {
    // Measured on-device steps were 2.8s-14.8s. The threshold must clear the
    // common case (so normal turns are untouched) while still firing well
    // before the observed 14.8s outlier that left the user in silence.
    assert!(SLOW_STEP_CUE_AFTER >= Duration::from_secs(6));
    assert!(SLOW_STEP_CUE_AFTER < Duration::from_secs(14));
}

#[test]
fn tool_call_markup_is_never_spoken_aloud() {
    // A malformed or truncated tool-call block must not reach the speaker.
    // Without this guard the Pin narrates raw JSON ("less-than tool
    // underscore call...") and saves it into conversation history.
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
        "<tool_call>{\"name\":\"knowledge_lookup\",\"argum".into(),
    ))]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 4);

    match outcome {
        ChatTurnOutcome::Decline(text) => {
            assert!(!text.contains("<tool_call>"), "markup leaked into speech");
            assert!(!text.trim().is_empty(), "the decline must still speak");
        }
        other => panic!("tool-call markup must never be spoken, got {other:?}"),
    }
}

#[test]
fn an_empty_tool_call_batch_declines_rather_than_spinning() {
    // The model asks for tools but names none: no progress is possible, so
    // the run must end immediately rather than burn the whole 80s budget.
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(Vec::new()))]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 8);

    assert!(
        matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
        "an empty tool batch must decline with spoken text, got {outcome:?}"
    );
    assert!(
        tools.executed.lock().unwrap().is_empty(),
        "no tool should run for an empty batch"
    );
}

#[test]
fn a_model_that_only_ever_calls_tools_still_terminates_with_speech() {
    // Worst case for a wearable: the model never answers, just keeps
    // requesting tools. The iteration budget (plus the tool-free grace call)
    // must end the run with something spoken rather than running to the
    // whole-turn deadline and timing out.
    let mut steps = Vec::new();
    for _ in 0..12 {
        steps.push(Ok(ToolStepResult::ToolCalls(vec![call(
            "knowledge_lookup",
        )])));
    }
    let backend = ScriptedBackend::new(steps);
    let tools = reading_tools(Some("Working on it"));
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 4);

    assert!(
        matches!(outcome, ChatTurnOutcome::Decline(ref text) if !text.trim().is_empty()),
        "a never-answering model must still terminate with spoken text, got {outcome:?}"
    );
    // Bounded work: the budget, not the transcript, decides when to stop.
    let steps_taken = backend.seen_message_counts.lock().unwrap().len();
    assert!(
        steps_taken <= 6,
        "a 4-iteration budget must not run away ({steps_taken} model steps)"
    );
}

#[test]
fn multi_step_tool_run_executes_each_replanned_call_in_order_and_answers() {
    // The core multi-tool shape: tool -> observation -> tool -> observation
    // -> tool -> observation -> answer, across three model steps.
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::ToolCalls(vec![call("weather_lookup")])),
        Ok(ToolStepResult::ToolCalls(vec![call("nearby_search")])),
        Ok(ToolStepResult::Final("All three answered.".into())),
    ]);
    let tools = reading_tools(Some("Working on it"));
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let turns = RecordingTurns::default();

    let outcome = run_loop_observed(&backend, &tools, &cues, &turns, 8);

    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("All three answered.".into())
    );
    assert_eq!(
        tools.executed.lock().unwrap().as_slice(),
        &["knowledge_lookup", "weather_lookup", "nearby_search"],
        "every replanned call must execute, in order"
    );
    // One paired action/observation turn per selected call, in order.
    assert_eq!(
        turns.0.lock().unwrap().as_slice(),
        &[
            "start:knowledge_lookup",
            "end:knowledge_lookup:true",
            "start:weather_lookup",
            "end:weather_lookup:true",
            "start:nearby_search",
            "end:nearby_search:true",
        ]
    );
    // One cue per selected call reaches only the ephemeral side channel.
    assert_eq!(cues.0.lock().unwrap().len(), 3);
    // Each step saw a strictly larger transcript: no earlier tool result was
    // dropped, which is what keeps later batches grounded in earlier ones.
    let seen = backend.seen_message_counts.lock().unwrap().clone();
    assert_eq!(seen.len(), 4, "four model steps: {seen:?}");
    assert!(
        seen.windows(2).all(|w| w[1] > w[0]),
        "transcript must grow monotonically across steps: {seen:?}"
    );
}

#[test]
fn cue_prose_never_enters_provider_messages_or_tool_history() {
    const EPHEMERAL_CUE: &str = "EPHEMERAL_CUE_MUST_NOT_ENTER_CONTEXT";
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final("Finished.".into())),
    ]);
    let tools = reading_tools(Some(EPHEMERAL_CUE));
    let cues = RecordingCueEvents(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 4);

    assert_eq!(outcome, ChatTurnOutcome::Answer("Finished.".into()));
    assert_eq!(
        cues.0.lock().unwrap().as_slice(),
        &[(
            "corr".to_string(),
            "knowledge_lookup".to_string(),
            EPHEMERAL_CUE.to_string(),
        )],
        "the cue side channel must contain its run and selected operation"
    );
    for provider_step in backend.seen_messages.lock().unwrap().iter() {
        assert!(
            !format!("{provider_step:?}").contains(EPHEMERAL_CUE),
            "cue prose entered provider/model context"
        );
    }
}

#[test]
fn independent_read_siblings_execute_concurrently_before_one_replan() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![
            call("alpha_read"),
            call("beta_read"),
        ])),
        Ok(ToolStepResult::Final("Both checked.".into())),
    ]);
    let tools = BarrierReads::new();
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let turns = RecordingTurns::default();
    let loop_ = ChatTurnLoop {
        backend: &backend,
        tools: &tools,
        cues: &cues,
        observer: &turns,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(4),
    };

    let outcome = block_on(async {
        tokio::time::timeout(Duration::from_secs(1), loop_.run("check both"))
            .await
            .expect("parallel reads must not deadlock")
    });

    assert_eq!(outcome, ChatTurnOutcome::Answer("Both checked.".into()));
    let mut executed = tools.executed.lock().unwrap().clone();
    executed.sort();
    assert_eq!(executed, ["alpha_read", "beta_read"]);
    assert_eq!(
        turns.0.lock().unwrap().as_slice(),
        &["start:alpha_read", "end:alpha_read:true"],
        "one observer batch surrounds both independent reads"
    );

    let seen = backend.seen_messages.lock().unwrap();
    assert_eq!(
        transcript_tool_call_names(&seen[1]),
        vec!["alpha_read".to_string(), "beta_read".to_string()]
    );
    assert_eq!(
        transcript_tool_result_ids(&seen[1]),
        vec!["alpha_read-1".to_string(), "beta_read-1".to_string()]
    );
}

#[test]
fn read_and_mutation_siblings_execute_one_at_a_time_after_replanning() {
    // A provider proposes a read and a terminal mutation together. Only the
    // read may run; the mutation must be proposed again after the real read
    // observation before it can reach typed validation and dispatch.
    let action = ValidatedNativeAction {
        action: native_actions::PLAY_MUSIC.into(),
        arguments: serde_json::json!({"Track":"T","Artist":"A"}),
    };
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![
            call("knowledge_lookup"),
            call("play_music"),
        ])),
        Ok(ToolStepResult::ToolCalls(vec![
            call("play_music"),
            call("nearby_search"),
        ])),
    ]);
    let tools = reading_tools(Some("Working on it"))
        .with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let turns = RecordingTurns::default();

    let outcome = run_loop_observed(&backend, &tools, &cues, &turns, 8);

    assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
    assert_eq!(
        tools.executed.lock().unwrap().as_slice(),
        &["knowledge_lookup", "play_music"],
        "only the first call from each model step may execute"
    );
    assert_eq!(
        turns.0.lock().unwrap().as_slice(),
        &[
            "start:knowledge_lookup",
            "end:knowledge_lookup:true",
            "start:play_music",
        ],
        "observer events must follow only the selected call"
    );
    assert_eq!(cues.0.lock().unwrap().len(), 2);
    assert_eq!(
        tools.cue_requests.lock().unwrap().as_slice(),
        &[
            vec!["knowledge_lookup".to_string()],
            vec!["play_music".to_string()],
        ],
        "cue selection must not include unexecuted siblings"
    );

    // The replanning request contains exactly the selected assistant call
    // and its real result. The unexecuted mutation sibling never acquired
    // an unresolved assistant call ID in the transcript.
    let seen = backend.seen_messages.lock().unwrap();
    assert_eq!(
        transcript_tool_call_names(&seen[1]),
        vec!["knowledge_lookup".to_string()]
    );
    assert_eq!(
        transcript_tool_result_ids(&seen[1]),
        vec!["knowledge_lookup-1".to_string()]
    );
}

#[test]
fn a_failed_selected_call_is_observed_before_a_sibling_can_be_replanned() {
    // A failed first call becomes the only observation from its model step.
    // A sibling can run only if the model proposes it again on the next
    // step, after seeing the real `[TOOL_ERROR]` result.
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![
            call("weather_lookup"),
            call("nearby_search"),
        ])),
        Ok(ToolStepResult::ToolCalls(vec![
            call("nearby_search"),
            call("knowledge_lookup"),
        ])),
        Ok(ToolStepResult::Final("Partial but useful.".into())),
    ]);
    let tools = reading_tools(Some("Working on it")).with(
        "weather_lookup",
        ToolExecutionOutcome::Observation {
            ok: false,
            content: "weather provider unavailable".into(),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let turns = RecordingTurns::default();

    let outcome = run_loop_observed(&backend, &tools, &cues, &turns, 8);

    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Partial but useful.".into())
    );
    assert_eq!(
        tools.executed.lock().unwrap().as_slice(),
        &["weather_lookup", "nearby_search"],
        "the failed step's sibling must wait for a fresh proposal"
    );
    assert_eq!(
        turns.0.lock().unwrap().as_slice(),
        &[
            "start:weather_lookup",
            "end:weather_lookup:false",
            "start:nearby_search",
            "end:nearby_search:true",
        ],
        "each selected call reports its own real outcome"
    );
    assert_eq!(
        tools.cue_requests.lock().unwrap().as_slice(),
        &[
            vec!["weather_lookup".to_string()],
            vec!["nearby_search".to_string()],
        ]
    );

    let seen = backend.seen_messages.lock().unwrap();
    assert_eq!(
        transcript_tool_call_names(&seen[1]),
        vec!["weather_lookup".to_string()]
    );
    assert_eq!(
        transcript_tool_result_ids(&seen[1]),
        vec!["weather_lookup-1".to_string()]
    );
    assert_eq!(
        transcript_tool_result_texts(&seen[1]),
        vec![format!(
            "{TOOL_STEP_ERROR_PREFIX} weather provider unavailable"
        )]
    );
    assert_eq!(
        transcript_tool_call_names(&seen[2]),
        vec!["weather_lookup".to_string(), "nearby_search".to_string()],
        "only calls selected across successive steps enter the transcript"
    );
}

#[test]
fn read_then_answer_produces_the_final_answer() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final(
            "Denmark has about 6 million people.".into(),
        )),
    ]);
    let tools = ScriptedTools::new(Some("Looking up the answer")).with(
        "knowledge_lookup",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: "population 6M".into(),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let outcome = run_loop(&backend, &tools, &cues, 4);
    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Denmark has about 6 million people.".into())
    );
    // A cue fired for the read batch.
    assert_eq!(
        cues.0.lock().unwrap().as_slice(),
        &["Looking up the answer"]
    );
}

#[test]
fn failed_read_becomes_an_observation_and_the_model_recovers() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        // Model tries again, this time answers from a second read result.
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final("Here is the answer.".into())),
    ]);
    let tools = ScriptedTools::new(None).with(
        "knowledge_lookup",
        ToolExecutionOutcome::Observation {
            ok: false,
            content: "unavailable".into(),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    // A failed read never terminates the run; the model gets [TOOL_ERROR]
    // observations and can keep going.
    let outcome = run_loop(&backend, &tools, &cues, 5);
    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Here is the answer.".into())
    );
}

#[test]
fn mutation_tool_terminates_into_a_native_action() {
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "play_music",
    )]))]);
    let action = ValidatedNativeAction {
        action: native_actions::PLAY_MUSIC.into(),
        arguments: serde_json::json!({"Track":"Smooth Criminal","Artist":"Michael Jackson"}),
    };
    let tools =
        ScriptedTools::new(None).with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let outcome = run_loop(&backend, &tools, &cues, 4);
    assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
}

#[test]
fn budget_exhaustion_forces_a_tool_free_grace_call() {
    // The model keeps calling tools; on the final (grace) iteration tools
    // are withheld so it must answer.
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::Final("Best effort answer.".into())),
    ]);
    let tools = ScriptedTools::new(None).with(
        "knowledge_lookup",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: "partial".into(),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let outcome = run_loop(&backend, &tools, &cues, 2);
    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("Best effort answer.".into())
    );
    // The grace (2nd) step must have been offered zero tools.
    let counts = backend.seen_tool_counts.lock().unwrap().clone();
    assert_eq!(counts.len(), 2);
    assert!(counts[0] > 0, "first step advertises tools");
    assert_eq!(counts[1], 0, "grace step withholds tools");
}

#[test]
fn a_ready_deterministic_action_dispatches_without_spending_a_nudge_round_trip() {
    // The nudge exists to give the model a retry. When the deterministic
    // completion ALREADY holds a validated candidate, that retry cannot
    // improve the outcome — it can only reach the same action one model
    // round-trip later, and a round-trip measured 2.8-14.8s on device.
    //
    // Both hooks return `Some` here, which is the ambiguous case: the loop
    // must prefer the action it can already dispatch.
    struct ReadyTools(ScriptedTools);
    #[tonic::async_trait]
    impl ToolCatalog for ReadyTools {
        fn catalog(&self) -> Vec<ToolStepDefinition> {
            self.0.catalog()
        }
        fn cue_for(&self, names: &[&str]) -> Option<String> {
            self.0.cue_for(names)
        }
        async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
            self.0.execute(call).await
        }
        fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
            Some("Call play_music now.".to_string())
        }
        fn forced_terminal_action(&self, _final_answer: &str) -> Option<ValidatedNativeAction> {
            Some(ValidatedNativeAction {
                action: native_actions::PLAY_MUSIC.into(),
                arguments: serde_json::json!({"Track":"T","Artist":"A"}),
            })
        }
    }
    // Exactly ONE step is scripted. If the loop still spent a nudge
    // round-trip it would ask for a second step and not find one.
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
        "Here are the songs.".into(),
    ))]);
    let tools = ReadyTools(ScriptedTools::new(None));
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let loop_ = ChatTurnLoop {
        backend: &backend,
        tools: &tools,
        cues: &cues,
        observer: &NoopTurnObserver,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(4),
    };
    let outcome = block_on(loop_.run("play the thing"));
    assert_eq!(
        outcome,
        ChatTurnOutcome::NativeAction(ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"T","Artist":"A"}),
        })
    );
    assert_eq!(
        backend.seen_tool_counts.lock().unwrap().len(),
        1,
        "the ready action must dispatch on the first final, not after a nudge"
    );
}

#[test]
fn an_artist_scoped_observation_completes_without_waiting_for_a_final_answer() {
    // `.144` measured ~3 searches before the model emitted any final, with
    // the deterministic completion waiting on that final. Once the
    // artist-scoped search has answered and a validated candidate exists,
    // there is nothing left to decide.
    struct ReadyTools(ScriptedTools);
    #[tonic::async_trait]
    impl ToolCatalog for ReadyTools {
        fn catalog(&self) -> Vec<ToolStepDefinition> {
            self.0.catalog()
        }
        fn cue_for(&self, names: &[&str]) -> Option<String> {
            self.0.cue_for(names)
        }
        async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
            self.0.execute(call).await
        }
        fn forced_terminal_action(&self, _final_answer: &str) -> Option<ValidatedNativeAction> {
            Some(ValidatedNativeAction {
                action: native_actions::PLAY_MUSIC.into(),
                arguments: serde_json::json!({"Track":"T","Artist":"A"}),
            })
        }
    }
    // A generic catalog search runs first and must NOT short-circuit: `.141`
    // established artist-scoped results are the preferred source, and
    // completing on a generic hit trades latency for the wrong song.
    // Only the artist-scoped observation may complete the turn.
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call(
            "music_catalog_search",
        )])),
        Ok(ToolStepResult::ToolCalls(vec![call(
            "music_artist_top_tracks",
        )])),
    ]);
    let tools = ReadyTools(
        ScriptedTools::new(None)
            .with(
                "music_catalog_search",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "generic hits".into(),
                },
            )
            .with(
                "music_artist_top_tracks",
                ToolExecutionOutcome::Observation {
                    ok: true,
                    content: "top tracks".into(),
                },
            ),
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let loop_ = ChatTurnLoop {
        backend: &backend,
        tools: &tools,
        cues: &cues,
        observer: &NoopTurnObserver,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(6),
    };
    let outcome = block_on(loop_.run("play Some Artist's most popular song"));
    assert_eq!(
        outcome,
        ChatTurnOutcome::NativeAction(ValidatedNativeAction {
            action: native_actions::PLAY_MUSIC.into(),
            arguments: serde_json::json!({"Track":"T","Artist":"A"}),
        })
    );
    assert_eq!(
        tools.0.executed.lock().unwrap().as_slice(),
        &["music_catalog_search", "music_artist_top_tracks"],
        "the generic search must not short-circuit; the artist-scoped one must"
    );
    assert_eq!(
        backend.seen_tool_counts.lock().unwrap().len(),
        2,
        "no further model step may be spent once the candidate is ready"
    );
}

#[test]
fn an_identical_repeated_read_executes_once_but_changed_arguments_re_execute() {
    // Measured on device: playing one song issued ~4.3 catalog lookups,
    // many byte-identical. Each was a fresh network round-trip.
    let repeated = |args: serde_json::Value| ToolStepCall {
        call_id: "knowledge_lookup-1".to_string(),
        name: "knowledge_lookup".to_string(),
        arguments: args,
    };
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![repeated(
            serde_json::json!({"query": "denmark", "limit": 5}),
        )])),
        // Same pair, different key order: the same request, so it must be
        // served from the memo rather than re-fetched.
        Ok(ToolStepResult::ToolCalls(vec![repeated(
            serde_json::json!({"limit": 5, "query": "denmark"}),
        )])),
        // A genuinely different argument must NOT be served from the memo.
        Ok(ToolStepResult::ToolCalls(vec![repeated(
            serde_json::json!({"query": "sweden", "limit": 5}),
        )])),
        Ok(ToolStepResult::Final("Population is 6M.".into())),
    ]);
    let tools = reading_tools(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));

    let outcome = run_loop(&backend, &tools, &cues, 8);

    assert_eq!(outcome, ChatTurnOutcome::Answer("Population is 6M.".into()));
    assert_eq!(
        tools.executed.lock().unwrap().as_slice(),
        &["knowledge_lookup", "knowledge_lookup"],
        "the identical repeat is replayed; the changed query re-executes"
    );
}

#[test]
fn verification_gate_rejects_one_final_and_the_model_completes_the_mutation() {
    struct NudgingTools(ScriptedTools);
    #[tonic::async_trait]
    impl ToolCatalog for NudgingTools {
        fn catalog(&self) -> Vec<ToolStepDefinition> {
            self.0.catalog()
        }
        fn cue_for(&self, names: &[&str]) -> Option<String> {
            self.0.cue_for(names)
        }
        async fn execute(&self, call: &ToolStepCall) -> ToolExecutionOutcome {
            self.0.execute(call).await
        }
        fn final_answer_nudge(&self, _final_answer: &str) -> Option<String> {
            Some("Call play_music now.".to_string())
        }
    }
    let action = ValidatedNativeAction {
        action: native_actions::PLAY_MUSIC.into(),
        arguments: serde_json::json!({"Track":"T","Artist":"A"}),
    };
    let backend = ScriptedBackend::new(vec![
        // Model tries to end with text; the gate rejects once.
        Ok(ToolStepResult::Final("Here are the songs.".into())),
        // After the nudge it completes the mutation.
        Ok(ToolStepResult::ToolCalls(vec![call("play_music")])),
    ]);
    let tools = NudgingTools(
        ScriptedTools::new(None).with("play_music", ToolExecutionOutcome::Terminal(action.clone())),
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let loop_ = ChatTurnLoop {
        backend: &backend,
        tools: &tools,
        cues: &cues,
        observer: &NoopTurnObserver,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(4),
    };
    let outcome = block_on(loop_.run("play the thing"));
    assert_eq!(outcome, ChatTurnOutcome::NativeAction(action));
    // A second text final after the nudge is accepted (gate is one-shot):
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::Final("Here are the songs.".into())),
        Ok(ToolStepResult::Final("I cannot play that.".into())),
    ]);
    let tools = NudgingTools(ScriptedTools::new(None));
    let loop_ = ChatTurnLoop {
        backend: &backend,
        tools: &tools,
        cues: &cues,
        observer: &NoopTurnObserver,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(4),
    };
    let outcome = block_on(loop_.run("play the thing"));
    assert_eq!(
        outcome,
        ChatTurnOutcome::Answer("I cannot play that.".into())
    );
}

#[test]
fn backend_error_declines_gracefully() {
    let backend = ScriptedBackend::new(vec![Err("timed out".into())]);
    let tools = ScriptedTools::new(None);
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let outcome = run_loop(&backend, &tools, &cues, 4);
    assert!(matches!(outcome, ChatTurnOutcome::Decline(_)));
}

#[test]
fn preflight_stops_the_loop_for_a_device_observation() {
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "current_location",
    )]))]);
    let tools = ScriptedTools::new(None).with(
        "current_location",
        ToolExecutionOutcome::Preflight {
            action: native_actions::GET_CURRENT_LOCATION.into(),
            arguments: serde_json::json!({}),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let outcome = run_loop(&backend, &tools, &cues, 4);
    assert!(matches!(outcome, ChatTurnOutcome::Preflight { .. }));
}

// ---- suspension/resume (streaming in-session continuation) ----

fn suspendable_loop<'a>(
    backend: &'a ScriptedBackend,
    tools: &'a ScriptedTools,
    cues: &'a RecordingCues,
    max_iterations: usize,
) -> ChatTurnLoop<'a> {
    suspendable_loop_observed(backend, tools, cues, &NoopTurnObserver, max_iterations)
}

fn suspendable_loop_observed<'a>(
    backend: &'a ScriptedBackend,
    tools: &'a ScriptedTools,
    cues: &'a RecordingCues,
    observer: &'a dyn ChatTurnObserver,
    max_iterations: usize,
) -> ChatTurnLoop<'a> {
    ChatTurnLoop {
        backend,
        tools,
        cues,
        observer,
        system_prompt: "sys".to_string(),
        timeout: Duration::from_secs(5),
        correlation: "corr".to_string(),
        config: ChatTurnLoopConfig::new(max_iterations),
    }
}

/// Multi-tool across a device round-trip: read -> device preflight ->
/// (device answers) -> further reads -> answer. This is the shape a real
/// "what's near me" turn takes, and nothing from before the suspension may
/// be lost when planning continues.
#[test]
fn a_device_round_trip_mid_run_resumes_into_further_tool_batches() {
    let backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("knowledge_lookup")])),
        Ok(ToolStepResult::ToolCalls(vec![call("current_location")])),
    ]);
    let tools = reading_tools(Some("Working on it")).with(
        "current_location",
        ToolExecutionOutcome::Preflight {
            action: native_actions::GET_CURRENT_LOCATION.into(),
            arguments: serde_json::json!({}),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let turns = RecordingTurns::default();
    let loop_ = suspendable_loop_observed(&backend, &tools, &cues, &turns, 8);

    let (outcome, suspension) = block_on(loop_.run_suspendable("what's near me"));
    assert!(
        matches!(outcome, ChatTurnOutcome::Preflight { ref action, .. } if action == native_actions::GET_CURRENT_LOCATION),
        "the device action must interrupt the run"
    );
    let suspension = suspension.expect("a preflight must contain its suspension");
    // The completed first batch streamed its pair; the interrupted batch
    // announced itself but has no observation yet (it is still pending).
    assert_eq!(
        turns.0.lock().unwrap().as_slice(),
        &[
            "start:knowledge_lookup",
            "end:knowledge_lookup:true",
            "start:current_location",
        ]
    );

    // Continuation: the device fix is now available and the model runs a
    // FURTHER tool batch before answering.
    let resumed_backend = ScriptedBackend::new(vec![
        Ok(ToolStepResult::ToolCalls(vec![call("nearby_search")])),
        Ok(ToolStepResult::Final("Three cafes near you.".into())),
    ]);
    let resumed_tools = reading_tools(Some("Working on it")).with(
        "current_location",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: r#"{"status":"ok","latitude":55.7,"longitude":12.6}"#.into(),
        },
    );
    let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
    let resumed_turns = RecordingTurns::default();
    let resumed_loop = suspendable_loop_observed(
        &resumed_backend,
        &resumed_tools,
        &resumed_cues,
        &resumed_turns,
        8,
    );

    let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));

    assert_eq!(
        resumed,
        ChatTurnOutcome::Answer("Three cafes near you.".into()),
        "the resumed run must finish the multi-tool plan"
    );
    assert!(next_suspension.is_none(), "the resumed run completed");
    assert_eq!(
        resumed_tools.executed.lock().unwrap().as_slice(),
        &["current_location", "nearby_search"],
        "the interrupted call is retried, then planning continues with more tools"
    );
    // Post-resume batches keep streaming cue pairs, so progress keeps
    // rendering after the device round-trip instead of going silent. The
    // retried pending call deliberately does NOT re-announce a batch: its
    // cue already fired before the suspension, so re-announcing it would
    // speak the same progress twice.
    assert_eq!(
        resumed_turns.0.lock().unwrap().as_slice(),
        &["start:nearby_search", "end:nearby_search:true"],
        "only genuinely new batches announce after a resume"
    );
    // The resumed planning step inherited the pre-suspension transcript
    // rather than starting a fresh plan.
    let seen = resumed_backend.seen_message_counts.lock().unwrap().clone();
    assert!(
        seen[0] >= 4,
        "resumed planning must retain the pre-suspension transcript: {seen:?}"
    );
}

fn location_preflight_tools() -> ScriptedTools {
    ScriptedTools::new(Some("Checking location")).with(
        "current_location",
        ToolExecutionOutcome::Preflight {
            action: native_actions::GET_CURRENT_LOCATION.into(),
            arguments: serde_json::json!({}),
        },
    )
}

/// The full streaming continuation: action -> device observation ->
/// resumed planning -> final answer, without a fresh re-plan.
#[test]
fn preflight_suspension_resumes_in_session_and_answers() {
    // First turn: the model asks for the current location; the tools have
    // no device fix yet, so the run suspends into a preflight.
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "current_location",
    )]))]);
    let tools = location_preflight_tools();
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let loop_ = suspendable_loop(&backend, &tools, &cues, 4);
    let (outcome, suspension) = block_on(loop_.run_suspendable("what's the weather here"));
    assert!(
        matches!(outcome, ChatTurnOutcome::Preflight { ref action, .. } if action == native_actions::GET_CURRENT_LOCATION)
    );
    let suspension = suspension.expect("a preflight must contain its suspension");

    // Continuation turn: a fresh loop instance (new tools now grounded
    // with the validated device observation) resumes the transcript.
    let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
        "It's sunny at your location.".into(),
    ))]);
    let resumed_tools = ScriptedTools::new(Some("Checking location")).with(
        "current_location",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: r#"{"status":"ok","latitude":55.7,"longitude":12.6}"#.into(),
        },
    );
    let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
    let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 4);
    let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
    assert_eq!(
        resumed,
        ChatTurnOutcome::Answer("It's sunny at your location.".into())
    );
    assert!(next_suspension.is_none());
    // The interrupted call was answered from the transcript, not re-cued.
    assert!(resumed_cues.0.lock().unwrap().is_empty());
    // The resumed model step saw the preserved transcript: initial user
    // turn + assistant tool-call turn + the pending call's tool result.
    assert_eq!(
        resumed_backend
            .seen_message_counts
            .lock()
            .unwrap()
            .as_slice(),
        &[3]
    );
    // The pending call was re-executed against the grounded tools.
    assert_eq!(
        resumed_tools.executed.lock().unwrap().as_slice(),
        &["current_location".to_string()]
    );
}

/// action -> observation re-entry -> next (terminal) native action.
#[test]
fn resumed_run_can_terminate_into_a_native_action() {
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "current_location",
    )]))]);
    let tools = location_preflight_tools();
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let loop_ = suspendable_loop(&backend, &tools, &cues, 5);
    let (_, suspension) = block_on(loop_.run_suspendable("play something nearby-themed"));
    let suspension = suspension.expect("preflight suspension");

    let action = ValidatedNativeAction {
        action: native_actions::PLAY_MUSIC.into(),
        arguments: serde_json::json!({"Track":"Here Comes the Sun","Artist":"The Beatles"}),
    };
    let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "play_music",
    )]))]);
    let resumed_tools = ScriptedTools::new(None)
        .with(
            "current_location",
            ToolExecutionOutcome::Observation {
                ok: true,
                content: r#"{"status":"ok"}"#.into(),
            },
        )
        .with("play_music", ToolExecutionOutcome::Terminal(action.clone()));
    let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
    let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 5);
    let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
    assert_eq!(resumed, ChatTurnOutcome::NativeAction(action));
    assert!(next_suspension.is_none());
}

/// A continuation whose observation still cannot ground the read must not
/// ping-pong the same call back to the device: it becomes a `[TOOL_ERROR]`
/// observation and the model concludes from the transcript.
#[test]
fn resume_with_still_missing_observation_feeds_tool_error_and_answers() {
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "current_location",
    )]))]);
    let tools = location_preflight_tools();
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let loop_ = suspendable_loop(&backend, &tools, &cues, 4);
    let (_, suspension) = block_on(loop_.run_suspendable("where am I"));
    let suspension = suspension.expect("preflight suspension");

    // The resumed tools STILL cannot ground the read (no location).
    let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
        "I couldn't get your location.".into(),
    ))]);
    let resumed_tools = location_preflight_tools();
    let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
    let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 4);
    let (resumed, next_suspension) = block_on(resumed_loop.resume(suspension));
    assert_eq!(
        resumed,
        ChatTurnOutcome::Answer("I couldn't get your location.".into())
    );
    assert!(
        next_suspension.is_none(),
        "a re-preflight of the interrupted call must not re-suspend"
    );
}

/// The suspension preserves the run's iteration budget: a resume never
/// grants more model steps than the original circuit breaker allowed.
#[test]
fn resume_preserves_the_remaining_iteration_budget() {
    // max_iterations=2: the preflight consumes iteration 0, so the resumed
    // run has exactly the grace iteration left (tools withheld).
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![call(
        "current_location",
    )]))]);
    let tools = location_preflight_tools();
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let loop_ = suspendable_loop(&backend, &tools, &cues, 2);
    let (_, suspension) = block_on(loop_.run_suspendable("what's near me"));
    let suspension = suspension.expect("preflight suspension");

    let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final(
        "Best effort from the observation.".into(),
    ))]);
    let resumed_tools = ScriptedTools::new(None).with(
        "current_location",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: r#"{"status":"ok"}"#.into(),
        },
    );
    let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
    let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 2);
    let (resumed, _) = block_on(resumed_loop.resume(suspension));
    assert_eq!(
        resumed,
        ChatTurnOutcome::Answer("Best effort from the observation.".into())
    );
    // The single resumed step was the grace call: zero tools offered.
    assert_eq!(
        resumed_backend.seen_tool_counts.lock().unwrap().as_slice(),
        &[0]
    );
}

/// A selected preflight suspends only its own assistant call. Unselected
/// siblings never enter the transcript and never receive fabricated
/// results, so resume can pair the selected call with one real observation.
#[test]
fn preflight_suspension_omits_unselected_siblings_and_resumes_cleanly() {
    let backend = ScriptedBackend::new(vec![Ok(ToolStepResult::ToolCalls(vec![
        call("current_location"),
        call("knowledge_lookup"),
    ]))]);
    let tools = location_preflight_tools().with(
        "knowledge_lookup",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: "never executed".into(),
        },
    );
    let cues = RecordingCues(Mutex::new(Vec::new()));
    let turns = RecordingTurns::default();
    let loop_ = suspendable_loop_observed(&backend, &tools, &cues, &turns, 4);
    let (_, suspension) = block_on(loop_.run_suspendable("compound request"));
    let suspension = suspension.expect("preflight suspension");
    assert_eq!(
        tools.executed.lock().unwrap().as_slice(),
        &["current_location".to_string()]
    );
    assert_eq!(
        tools.cue_requests.lock().unwrap().as_slice(),
        &[vec!["current_location".to_string()]]
    );
    assert_eq!(
        turns.0.lock().unwrap().as_slice(),
        &["start:current_location"],
        "a preflight has no real observation turn until resume"
    );
    assert_eq!(
        transcript_tool_call_names(&suspension.messages),
        vec!["current_location".to_string()],
        "the assistant transcript must omit the proposed sibling"
    );
    assert!(
        transcript_tool_result_ids(&suspension.messages).is_empty(),
        "the suspended transcript must not fabricate sibling results"
    );

    let resumed_backend = ScriptedBackend::new(vec![Ok(ToolStepResult::Final("Done.".into()))]);
    let resumed_tools = ScriptedTools::new(None).with(
        "current_location",
        ToolExecutionOutcome::Observation {
            ok: true,
            content: r#"{"status":"ok"}"#.into(),
        },
    );
    let resumed_cues = RecordingCues(Mutex::new(Vec::new()));
    let resumed_loop = suspendable_loop(&resumed_backend, &resumed_tools, &resumed_cues, 4);
    let (resumed, _) = block_on(resumed_loop.resume(suspension));
    assert_eq!(resumed, ChatTurnOutcome::Answer("Done.".into()));
    // Transcript at the resumed step: user + one selected assistant call +
    // that call's real result. There is no unresolved sibling ID.
    assert_eq!(
        resumed_backend
            .seen_message_counts
            .lock()
            .unwrap()
            .as_slice(),
        &[3]
    );
    let seen = resumed_backend.seen_messages.lock().unwrap();
    assert_eq!(
        transcript_tool_call_names(&seen[0]),
        vec!["current_location".to_string()]
    );
    assert_eq!(
        transcript_tool_result_ids(&seen[0]),
        vec!["current_location-1".to_string()]
    );
}

#[test]
fn the_language_guards_catch_the_canonical_leaks_and_filler() {
    // Aliveness for every fixture the language boundary is contracted to
    // reject: internal terms, canned chatbot filler, and the apology loop.
    for leak in [
        "As an AI, I cannot do that.",
        "I am a language model.",
        "The LLM backend failed.",
        "the backend did not answer",
        "the provider timed out",
        "that tool call failed",
        "per my system prompt",
        "the JSON was malformed",
    ] {
        assert!(
            internal_vocabulary_hit(leak).is_some(),
            "internal vocabulary guard missed: {leak}"
        );
    }
    for filler in ["I can help with that!", "Let me check the weather."] {
        assert!(
            speech::canned_filler_hit(filler).is_some(),
            "canned filler guard missed: {filler}"
        );
    }
    assert!(speech::is_apology_loop(
        "Sorry — I apologize for the trouble."
    ));
    assert!(!speech::is_apology_loop(
        "Sorry, that didn't work. Try again."
    ));
    // Ordinary answers pass: the guard protects speech, it does not ban words
    // a wearer might hear in an honest sentence about their own request.
    for fine in [
        "It's 12 degrees and clear.",
        "Saved.",
        "Your timer is set for ten minutes.",
    ] {
        assert!(internal_vocabulary_hit(fine).is_none());
        assert!(speech::canned_filler_hit(fine).is_none());
    }
}

#[test]
fn every_fixed_decline_passes_all_three_language_guards() {
    let empty = decline_speech(ChatTurnDeclineReason::EmptyModel, None);
    let budget = decline_speech(ChatTurnDeclineReason::Budget, None);
    let no_progress = decline_speech(ChatTurnDeclineReason::NoProgress, None);
    let unavailable = decline_speech(ChatTurnDeclineReason::BackendUnavailable, None);
    let timed_out = decline_speech(
        ChatTurnDeclineReason::BackendUnavailable,
        Some("request timed out after 30s (context deadline exceeded)"),
    );
    for spoken in [&empty, &budget, &no_progress, &unavailable, &timed_out] {
        assert!(
            internal_vocabulary_hit(spoken).is_none(),
            "fixed decline leaks internal vocabulary: {spoken}"
        );
        assert!(
            speech::canned_filler_hit(spoken).is_none(),
            "fixed decline is canned filler: {spoken}"
        );
        assert!(
            !speech::is_apology_loop(spoken),
            "fixed decline apologises in a loop: {spoken}"
        );
        assert!(
            !spoken.is_empty() && spoken.len() < 200,
            "decline is unbounded: {spoken}"
        );
    }
}
