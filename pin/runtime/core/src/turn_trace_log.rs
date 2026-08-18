//! Durable storage for per-turn diagnostic traces.
//!
//! `turn_trace` builds the decision chain for one turn in memory; this module is
//! what makes it survive the turn. The motivating failure — "it refused to play
//! a song" — was undiagnosable minutes later because the only evidence lived in
//! logcat and logcat had already rolled.
//!
//! The shape deliberately matches `llm::request_log`: one JSON line per record,
//! a day-rolled file in `logging.log_dir`, seven days of retention, and a writer
//! that reports its own failures instead of propagating them. That logger keeps
//! `{role, characters}` — enough for latency, useless for "why did it refuse".
//! This one keeps the decision chain and shares the same disk discipline.
//!
//! ## Privacy posture
//!
//! Free text is gated by `TracePolicy::include_content` at three points, not
//! one:
//!
//! 1. at capture, by `TurnTracer` (nothing is ever collected);
//! 2. on the way to disk, here, so a record that somehow carries text under a
//!    shape-only policy is stripped before it is written;
//! 3. on the way back out, here, so disarming the flag also stops serving text
//!    captured while it was armed.
//!
//! The third point is the one that matters for the read API: a durable log plus
//! an authenticated endpoint is a content channel unless the endpoint honours
//! the *current* policy rather than the policy in force at capture time.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use chrono::Utc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tracing::warn;

use crate::turn_trace::{TraceEvent, TracePolicy, TurnTraceRecord};

const TURN_TRACE_LOG_PREFIX: &str = "turn-traces";
const TURN_TRACE_LOG_EXTENSION: &str = "jsonl";
const TURN_TRACE_LOG_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Newest bytes consulted in any one day file when serving a read. A trace log
/// on a busy device is unbounded in size but a read must not be: the reader
/// walks the tail, which is where the recent turns are.
const MAX_SCAN_BYTES_PER_FILE: u64 = 4 * 1024 * 1024;

/// Day files consulted for one read. Retention keeps seven; one extra covers a
/// clock that moved.
const MAX_SCANNED_FILES: usize = 8;

/// Traces returned when a caller does not ask for a specific count.
pub const DEFAULT_TRACE_READ_LIMIT: usize = 20;

/// Ceiling on a caller-supplied `limit`.
pub const MAX_TRACE_READ_LIMIT: usize = 100;

/// Appends finished turn traces to a rolling JSONL log and reads them back.
#[derive(Clone, Debug)]
pub struct TurnTraceLogger {
    log_dir: Arc<PathBuf>,
}

impl TurnTraceLogger {
    pub fn new(log_dir: PathBuf) -> Self {
        Self {
            log_dir: Arc::new(log_dir),
        }
    }

    /// Persist a finished turn without making the turn wait for the disk.
    ///
    /// Diagnostics must never cost the wearer an answer, so this hands the
    /// write to the runtime and returns. A trace that cannot be written is
    /// warned about and dropped; nothing here is allowed to fail a turn.
    pub fn record(&self, policy: TracePolicy, record: TurnTraceRecord) {
        if !policy.enabled {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            warn!("dropped a turn trace: no async runtime available to write it");
            return;
        };
        let logger = self.clone();
        handle.spawn(async move {
            logger.append(policy, record).await;
        });
    }

    /// Append one record, awaiting the write. `record` is the fire-and-forget
    /// form; this is for callers that already own the wait (and for tests).
    pub async fn append(&self, policy: TracePolicy, mut record: TurnTraceRecord) {
        if !policy.enabled {
            return;
        }
        if !policy.include_content {
            redact_content(&mut record);
        }

        if let Err(error) = self.cleanup_old_logs().await {
            warn!(error = %error, "failed to clean up old turn trace logs");
        }

        if let Err(error) = tokio::fs::create_dir_all(self.log_dir.as_ref()).await {
            warn!(dir = %self.log_dir.display(), error = %error, "failed to create turn trace log dir");
            return;
        }

        let path = self.current_log_path();
        let line = match serde_json::to_string(&record) {
            Ok(line) => line,
            Err(error) => {
                warn!(error = %error, "failed to serialize turn trace record");
                return;
            }
        };

        match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(line.as_bytes()).await {
                    warn!(path = %path.display(), error = %error, "failed to write turn trace record");
                    return;
                }
                if let Err(error) = file.write_all(b"\n").await {
                    warn!(path = %path.display(), error = %error, "failed to finish turn trace record");
                }
            }
            Err(error) => {
                warn!(path = %path.display(), error = %error, "failed to open turn trace log file");
            }
        }
    }

    /// The most recent traces, newest first.
    ///
    /// `include_content` is the *current* policy, not the one in force when the
    /// records were written: a shape-only policy serves shape-only traces even
    /// if the file on disk holds text.
    pub async fn recent(&self, limit: usize, include_content: bool) -> Vec<TurnTraceRecord> {
        self.scan(limit.min(MAX_TRACE_READ_LIMIT), include_content, |_| true)
            .await
    }

    /// The newest trace recorded under `correlation`, subject to the same
    /// current-policy content rule as `recent`.
    pub async fn find(&self, correlation: &str, include_content: bool) -> Option<TurnTraceRecord> {
        self.scan(1, include_content, |record| {
            record.correlation == correlation
        })
        .await
        .pop()
    }

    async fn scan(
        &self,
        limit: usize,
        include_content: bool,
        mut wanted: impl FnMut(&TurnTraceRecord) -> bool,
    ) -> Vec<TurnTraceRecord> {
        let mut found = Vec::new();
        if limit == 0 {
            return found;
        }

        for path in self.log_files_newest_first().await {
            let text = match read_tail(&path).await {
                Ok(text) => text,
                Err(error) => {
                    warn!(path = %path.display(), error = %error, "failed to read turn trace log file");
                    continue;
                }
            };
            // Records are appended in order, so the tail of the file is the
            // newest end of it.
            for line in text.lines().rev() {
                if line.trim().is_empty() {
                    continue;
                }
                // A half-written or hand-edited line is skipped rather than
                // failing the read: a diagnostic surface that returns nothing
                // because one record is malformed is worse than one that
                // returns the rest.
                let Ok(mut record) = serde_json::from_str::<TurnTraceRecord>(line) else {
                    continue;
                };
                if !wanted(&record) {
                    continue;
                }
                if !include_content {
                    redact_content(&mut record);
                }
                found.push(record);
                if found.len() >= limit {
                    return found;
                }
            }
        }

        found
    }

    /// Day files, newest first. The `%Y-%m-%d` stamp sorts chronologically as
    /// text, so a reverse name sort is a reverse date sort.
    async fn log_files_newest_first(&self) -> Vec<PathBuf> {
        let mut entries = match tokio::fs::read_dir(self.log_dir.as_ref()).await {
            Ok(entries) => entries,
            Err(_) => return Vec::new(),
        };

        let mut paths = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if is_turn_trace_log_file(&path) {
                paths.push(path);
            }
        }
        paths.sort_unstable();
        paths.reverse();
        paths.truncate(MAX_SCANNED_FILES);
        paths
    }

    async fn cleanup_old_logs(&self) -> std::io::Result<()> {
        let now = SystemTime::now();
        let mut entries = match tokio::fs::read_dir(self.log_dir.as_ref()).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !is_turn_trace_log_file(&path) {
                continue;
            }

            let metadata = entry.metadata().await?;
            let Ok(modified) = metadata.modified() else {
                continue;
            };
            let Ok(age) = now.duration_since(modified) else {
                continue;
            };

            if age > TURN_TRACE_LOG_RETENTION {
                tokio::fs::remove_file(&path).await?;
            }
        }

        Ok(())
    }

    fn current_log_path(&self) -> PathBuf {
        let date = Utc::now().format("%Y-%m-%d");
        self.log_dir.join(format!(
            "{TURN_TRACE_LOG_PREFIX}.{date}.{TURN_TRACE_LOG_EXTENSION}"
        ))
    }
}

/// Strip every free-text field from a record, leaving the shapes and counts.
///
/// The match is deliberately exhaustive rather than `_ => {}`: a new event
/// variant containing text must fail to compile here instead of silently becoming
/// content that no policy gates.
fn redact_content(record: &mut TurnTraceRecord) {
    record.utterance = None;
    for event in &mut record.events {
        match event {
            TraceEvent::ModelStep { text, .. } => *text = None,
            TraceEvent::ToolCall {
                arguments, result, ..
            } => {
                *arguments = None;
                *result = None;
            }
            TraceEvent::Terminal { spoken_text, .. } => *spoken_text = None,
            // Gate reasons, gate names, shape keys, and note markers are
            // bounded machine labels chosen in code, never user or model text.
            TraceEvent::GateDecision { .. } | TraceEvent::Note { .. } => {}
        }
    }
}

/// Read at most `MAX_SCAN_BYTES_PER_FILE` from the end of a log file.
///
/// When the file is longer, the first line of the window is a fragment of a
/// record that started before the window did, so it is dropped.
async fn read_tail(path: &Path) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let len = file.metadata().await?.len();
    let windowed = len > MAX_SCAN_BYTES_PER_FILE;
    if windowed {
        file.seek(std::io::SeekFrom::Start(len - MAX_SCAN_BYTES_PER_FILE))
            .await?;
    }

    let mut bytes = Vec::with_capacity(len.min(MAX_SCAN_BYTES_PER_FILE) as usize);
    file.take(MAX_SCAN_BYTES_PER_FILE)
        .read_to_end(&mut bytes)
        .await?;

    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(match windowed {
        true => text
            .find('\n')
            .map(|newline| text[newline + 1..].to_string())
            .unwrap_or_default(),
        false => text,
    })
}

fn is_turn_trace_log_file(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                name.starts_with(&format!("{TURN_TRACE_LOG_PREFIX}."))
                    && name.ends_with(&format!(".{TURN_TRACE_LOG_EXTENSION}"))
            })
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_trace::TurnTracer;

    fn policy(enabled: bool, include_content: bool) -> TracePolicy {
        TracePolicy {
            enabled,
            include_content,
        }
    }

    fn logger(dir: &tempfile::TempDir) -> TurnTraceLogger {
        TurnTraceLogger::new(dir.path().to_path_buf())
    }

    /// A finished turn with one gate refusal, one tool call, and a spoken
    /// terminal — the shape the motivating failure would have produced.
    fn refused_music_turn(policy: TracePolicy, correlation: &str) -> TurnTraceRecord {
        let tracer = TurnTracer::new(
            policy,
            correlation,
            "play the best one",
            "2026-07-31".into(),
        );
        tracer.record(TraceEvent::ToolCall {
            ordinal: 0,
            tool: "play_music".into(),
            latency_ms: 12,
            ok: false,
            status: "invalid".into(),
            arguments: tracer.content(r#"{"query":"the best one"}"#),
            result: tracer.content("no catalog match for \"the best one\""),
        });
        tracer.gate(
            "music_grounding",
            false,
            "music_target_not_grounded",
            &[("targets", 1), ("requested_words", 3)],
        );
        tracer.record(TraceEvent::Terminal {
            outcome: "decline".into(),
            action: None,
            spoken_chars: 27,
            spoken_text: tracer.content("I could not find that song."),
        });
        tracer.finish().expect("an enabled tracer yields a record")
    }

    fn written_lines(dir: &tempfile::TempDir) -> Vec<String> {
        let mut lines = Vec::new();
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let path = entry.unwrap().path();
            if !is_turn_trace_log_file(&path) {
                continue;
            }
            lines.extend(
                std::fs::read_to_string(&path)
                    .unwrap()
                    .lines()
                    .map(str::to_string),
            );
        }
        lines
    }

    #[tokio::test]
    async fn a_record_round_trips_through_the_sink() {
        let dir = tempfile::tempdir().unwrap();
        let logger = logger(&dir);
        let policy = policy(true, false);

        logger
            .append(policy, refused_music_turn(policy, "turn-1"))
            .await;

        let recent = logger.recent(10, false).await;
        assert_eq!(recent.len(), 1, "the appended trace must be readable back");
        let record = &recent[0];
        assert_eq!(record.correlation, "turn-1");
        assert_eq!(record.started_at, "2026-07-31");
        assert_eq!(record.utterance_chars, 17);
        assert_eq!(record.events.len(), 3);
        // The refusal — the fact the original failure could not recover — is
        // what has to survive the round trip.
        match &record.events[1] {
            TraceEvent::GateDecision {
                gate,
                allowed,
                reason,
                shape,
            } => {
                assert_eq!(gate, "music_grounding");
                assert!(!allowed);
                assert_eq!(reason, "music_target_not_grounded");
                assert_eq!(shape[0], ("targets".to_string(), 1));
                assert_eq!(shape[1], ("requested_words".to_string(), 3));
            }
            other => panic!("expected the gate decision to survive, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_disabled_policy_writes_nothing_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let logger = logger(&dir);
        // The record is built under an enabled policy, then offered to a sink
        // whose policy is off: the sink, not just the tracer, must refuse.
        let record = refused_music_turn(policy(true, true), "turn-off");

        logger.append(policy(false, true), record).await;

        assert!(
            written_lines(&dir).is_empty(),
            "tracing off must leave no file and no line behind"
        );
        assert!(logger.recent(10, true).await.is_empty());
    }

    #[tokio::test]
    async fn content_is_absent_on_disk_when_include_content_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let logger = logger(&dir);
        // Built WITH content, written under a shape-only policy: the sink must
        // strip it, so the secret never reaches the disk at all.
        let mut record = refused_music_turn(policy(true, true), "turn-2");
        record.utterance = Some("play the best one".into());

        logger.append(policy(true, false), record).await;

        let lines = written_lines(&dir);
        assert_eq!(lines.len(), 1);
        for text in [
            "play the best one",
            "the best one",
            "no catalog match",
            "I could not find that song.",
        ] {
            assert!(
                !lines[0].contains(text),
                "shape-only tracing must not write {text:?} to disk; wrote {}",
                lines[0]
            );
        }
        // The diagnostic payload is still there.
        assert!(lines[0].contains("music_target_not_grounded"));
        assert!(lines[0].contains("\"utterance_chars\":17"));

        let record = logger.recent(10, false).await.pop().unwrap();
        assert!(record.utterance.is_none());
        match &record.events[0] {
            TraceEvent::ToolCall {
                arguments, result, ..
            } => {
                assert!(arguments.is_none());
                assert!(result.is_none());
            }
            other => panic!("expected a tool call, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn disarming_content_also_stops_serving_text_captured_while_it_was_armed() {
        let dir = tempfile::tempdir().unwrap();
        let logger = logger(&dir);
        let armed = policy(true, true);
        logger
            .append(armed, refused_music_turn(armed, "turn-3"))
            .await;

        // Armed: the text is on disk and served.
        let served = logger.recent(10, true).await.pop().unwrap();
        assert_eq!(served.utterance.as_deref(), Some("play the best one"));

        // Disarmed: the same file, read under the current policy, is shape-only.
        // Otherwise the read endpoint would be a way to retrieve content the
        // live policy says must not be exposed.
        let redacted = logger.recent(10, false).await.pop().unwrap();
        assert!(redacted.utterance.is_none());
        match &redacted.events[2] {
            TraceEvent::Terminal {
                spoken_chars,
                spoken_text,
                ..
            } => {
                assert_eq!(*spoken_chars, 27, "the shape survives redaction");
                assert!(spoken_text.is_none(), "the text does not");
            }
            other => panic!("expected the terminal event, got {other:?}"),
        }
        assert!(logger
            .find("turn-3", false)
            .await
            .expect("found by correlation")
            .utterance
            .is_none());
    }

    #[tokio::test]
    async fn traces_come_back_newest_first_and_bounded_by_limit() {
        let dir = tempfile::tempdir().unwrap();
        let logger = logger(&dir);
        let policy = policy(true, false);
        for index in 0..5 {
            logger
                .append(policy, refused_music_turn(policy, &format!("turn-{index}")))
                .await;
        }

        let correlations: Vec<_> = logger
            .recent(3, false)
            .await
            .into_iter()
            .map(|record| record.correlation)
            .collect();
        assert_eq!(correlations, ["turn-4", "turn-3", "turn-2"]);
        assert_eq!(logger.recent(usize::MAX, false).await.len(), 5);
    }

    #[tokio::test]
    async fn one_malformed_line_does_not_hide_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let logger = logger(&dir);
        let policy = policy(true, false);
        logger
            .append(policy, refused_music_turn(policy, "turn-good"))
            .await;
        let path = logger.current_log_path();
        let existing = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{{not json\n{existing}")).unwrap();

        assert_eq!(logger.recent(10, false).await.len(), 1);
    }

    #[tokio::test]
    async fn a_lookup_misses_cleanly_for_an_unknown_correlation() {
        let dir = tempfile::tempdir().unwrap();
        let logger = logger(&dir);
        let policy = policy(true, false);
        logger
            .append(policy, refused_music_turn(policy, "turn-known"))
            .await;

        assert!(logger.find("turn-known", false).await.is_some());
        assert!(logger.find("turn-unknown", false).await.is_none());
    }

    #[tokio::test]
    async fn an_unwritable_log_dir_is_reported_and_dropped_not_propagated() {
        // A file where the directory should be: every write fails. The turn
        // path must not learn about it.
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let logger = TurnTraceLogger::new(blocked);
        let policy = policy(true, false);

        logger
            .append(policy, refused_music_turn(policy, "turn-lost"))
            .await;
        assert!(logger.recent(10, false).await.is_empty());
    }

    #[test]
    fn only_this_logger_s_own_files_are_read_or_retained() {
        let dir = tempfile::tempdir().unwrap();
        let ours = dir.path().join("turn-traces.2026-07-31.jsonl");
        let neighbour = dir.path().join("llm-requests.2026-07-31.jsonl");
        std::fs::write(&ours, b"").unwrap();
        std::fs::write(&neighbour, b"").unwrap();

        assert!(is_turn_trace_log_file(&ours));
        assert!(
            !is_turn_trace_log_file(&neighbour),
            "the neighbouring llm-request log shares the directory and must be left alone"
        );
        assert!(!is_turn_trace_log_file(dir.path()));
    }

    #[tokio::test]
    async fn a_windowed_read_drops_the_partial_first_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("turn-traces.2026-07-31.jsonl");
        let policy = policy(true, false);
        let complete = serde_json::to_string(&refused_music_turn(policy, "turn-whole")).unwrap();
        let filler = "x".repeat(MAX_SCAN_BYTES_PER_FILE as usize);
        std::fs::write(&path, format!("{filler}\n{complete}\n")).unwrap();

        let text = read_tail(&path).await.unwrap();
        assert!(
            !text.contains('x'),
            "the fragment of the record that started before the window must be dropped"
        );
        assert_eq!(
            TurnTraceLogger::new(dir.path().to_path_buf())
                .recent(10, false)
                .await
                .len(),
            1
        );
    }
}
