use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tracing::warn;

use crate::db::Database;

const WAV_HEADER_BYTES: u64 = 44;
const SAMPLE_RATE: u64 = 44_100;
const CHANNELS: u64 = 2;
const BYTES_PER_SAMPLE: u64 = 2;
const PCM_FRAME_BYTES: u64 = CHANNELS * BYTES_PER_SAMPLE;
const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// One second of audio, accumulated before the stock player is given the URL.
/// See [`PlaybackBuffer::await_preroll`] for why.
pub const PLAYBACK_PREROLL_PCM_BYTES: u64 = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

/// Upper bound on the pre-roll wait, so a slow CDN delays the start instead of
/// blocking it. Kept short because it is spent inside the play request, which
/// the user is waiting on after a spoken command.
pub const PLAYBACK_PREROLL_DEADLINE: Duration = Duration::from_millis(1_500);

#[derive(Debug, Default)]
struct Progress {
    pcm_bytes: u64,
    complete: bool,
    failed: bool,
}

/// Immutable identity plus synchronized progress for one opaque playback
/// ticket. The file remains alive while an HTTP request owns this Arc.
pub struct PlaybackBuffer {
    path: PathBuf,
    expected_pcm_bytes: u64,
    progress: Mutex<Progress>,
    changed: Notify,
    activity: AsyncMutex<Option<PlaybackActivity>>,
}

struct PlaybackActivity {
    db: Database,
    id: i64,
    terminal: bool,
}

impl PlaybackBuffer {
    pub fn create(cache_dir: &Path, ticket: String, duration_ms: u64) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(cache_dir).map_err(|_| "spotify playback cache unavailable")?;
        let path = cache_dir.join(format!("{ticket}.wav"));
        if path.exists() || path.is_symlink() {
            return Err("spotify playback ticket collision".into());
        }

        let expected_pcm_bytes = expected_pcm_bytes(duration_ms)?;
        let mut file = create_private_file(&path)?;
        file.write_all(&wav_header(expected_pcm_bytes))
            .map_err(|_| "spotify playback cache unavailable")?;
        file.sync_data()
            .map_err(|_| "spotify playback cache unavailable")?;

        Ok(Arc::new(Self {
            path,
            expected_pcm_bytes,
            progress: Mutex::new(Progress::default()),
            changed: Notify::new(),
            activity: AsyncMutex::new(None),
        }))
    }

    /// Attach the durable history row after the caller has created it. The
    /// buffer is constructed first because librespot needs its sink up front,
    /// but no stock stream can be returned before this attachment completes.
    pub async fn attach_activity(&self, db: Database, id: i64) {
        let mut activity = self.activity.lock().await;
        if activity.is_none() {
            *activity = Some(PlaybackActivity {
                db,
                id,
                terminal: false,
            });
        }
    }

    async fn mark_activity_playing(&self) {
        let mut activity = self.activity.lock().await;
        let Some(activity) = activity.as_mut().filter(|activity| !activity.terminal) else {
            return;
        };
        let _ = activity.db.mark_music_activity_playing(activity.id).await;
    }

    async fn finish_activity(&self, status: &'static str) {
        let mut activity = self.activity.lock().await;
        let Some(activity) = activity.as_mut().filter(|activity| !activity.terminal) else {
            return;
        };
        if activity
            .db
            .finish_music_activity(activity.id, status)
            .await
            .is_ok()
        {
            // A false result means another terminal transition won in SQLite;
            // either way this buffer must never attempt to overwrite it.
            activity.terminal = true;
        }
    }

    pub async fn interrupt_activity(&self) {
        self.finish_activity("interrupted").await;
    }

    pub async fn fail_activity(&self) {
        self.finish_activity("failed").await;
    }

    async fn complete_activity(&self) {
        self.finish_activity("completed").await;
    }

    pub fn total_bytes(&self) -> u64 {
        WAV_HEADER_BYTES + self.expected_pcm_bytes
    }

    /// True once this buffer has been marked failed. A failed buffer can never
    /// produce another byte, so the stream route treats it as absent rather
    /// than committing to a `Content-Length` it cannot satisfy.
    pub fn has_failed(&self) -> bool {
        self.progress.lock().unwrap().failed
    }

    fn available_bytes(&self) -> (u64, bool, bool) {
        let progress = self.progress.lock().unwrap();
        (
            WAV_HEADER_BYTES + progress.pcm_bytes,
            progress.complete,
            progress.failed,
        )
    }

    pub fn finish(&self, failed: bool) {
        // Decide under the lock, then release it before touching the
        // filesystem. `set_len` + `sync_data` are blocking calls and the HTTP
        // body stream takes this same mutex for every chunk it serves, so
        // holding it across an fsync stalls playback for as long as the write
        // takes. The ordering that matters for readers is unchanged: the file
        // is extended *before* `complete` is published.
        let decoded_pcm_bytes = {
            let mut progress = self.progress.lock().unwrap();
            if progress.complete {
                return;
            }

            if failed || progress.failed {
                progress.complete = true;
                progress.failed = true;
                drop(progress);
                self.changed.notify_waiters();
                return;
            }

            progress.pcm_bytes
        };

        // The Spotify duration is authoritative for the response Content-Length,
        // but a decoder can end a few PCM frames early. Extend the private WAV
        // with zero-valued samples while completion is still hidden from readers.
        // set_len also trims any impossible overrun and preserves frame alignment
        // because expected_pcm_bytes is always a whole stereo PCM frame.
        //
        // Both the pad and the trim used to be silent. They are audible when the
        // gap is large — a short decode ends in inserted silence, an overrun has
        // its tail cut — so record the disagreement. Byte counts only, no track
        // identity.
        let expected_pcm_bytes = self.expected_pcm_bytes;
        if decoded_pcm_bytes != expected_pcm_bytes {
            let (outcome, delta) = if decoded_pcm_bytes < expected_pcm_bytes {
                ("zero-padded", expected_pcm_bytes - decoded_pcm_bytes)
            } else {
                ("truncated", decoded_pcm_bytes - expected_pcm_bytes)
            };
            warn!(
                decoded_pcm_bytes,
                expected_pcm_bytes,
                delta_bytes = delta,
                outcome,
                "decoded length disagrees with the declared duration"
            );
        }

        let finalized = OpenOptions::new()
            .write(true)
            .open(&self.path)
            .and_then(|file| {
                file.set_len(self.total_bytes())?;
                file.sync_data()
            });

        let mut progress = self.progress.lock().unwrap();
        if progress.complete {
            // A concurrent failure path won while the lock was released; its
            // verdict stands.
            return;
        }
        if finalized.is_ok() {
            progress.pcm_bytes = expected_pcm_bytes;
            progress.complete = true;
        } else {
            progress.complete = true;
            progress.failed = true;
        }
        drop(progress);
        self.changed.notify_waiters();
    }

    /// Wait until roughly `pcm_bytes` of audio exist, or `deadline` elapses.
    ///
    /// The stock player's `DefaultHttpDataSource` uses an 8 s read timeout with
    /// 3 retries, and because its loader wants ~50 s of buffer it sits parked at
    /// our write head for essentially the whole track. If the CDN stalls while
    /// we are still producing the opening bytes, the player emits no progress,
    /// times out and raises a fatal error — the track dies rather than
    /// rebuffering. Accumulating a little audio before the URL is handed over
    /// puts slack between its read head and our write head.
    ///
    /// Bounded on purpose. If the pre-roll is not ready in time we return
    /// anyway, so the worst case is exactly the previous behaviour plus this
    /// deadline, never a refusal to play. It also returns early once the buffer
    /// is complete or failed, so short tracks do not wait out the full deadline.
    pub async fn await_preroll(&self, pcm_bytes: u64, deadline: Duration) {
        let target = WAV_HEADER_BYTES + pcm_bytes;
        let _ = tokio::time::timeout(deadline, async {
            loop {
                // Register for the notification *before* sampling, so a write
                // landing between the two cannot be missed.
                let notified = self.changed.notified();
                let (available, complete, failed) = self.available_bytes();
                if failed || complete || available >= target {
                    return;
                }
                notified.await;
            }
        })
        .await;
    }

    async fn wait_until_readable(&self, position: u64) -> Result<u64, ()> {
        loop {
            let notified = self.changed.notified();
            let (available, complete, failed) = self.available_bytes();
            if failed {
                return Err(());
            }
            if position < available {
                return Ok(available);
            }
            if complete {
                return Err(());
            }
            notified.await;
        }
    }

    pub async fn response(self: Arc<Self>, method_is_head: bool, headers: &HeaderMap) -> Response {
        let total = self.total_bytes();
        let range = match parse_range(headers, total) {
            Ok(range) => range,
            Err(status) => return status.into_response(),
        };
        let (start, end, partial) = match range {
            Some(range) => (range.start, range.end, true),
            None => (0, total - 1, false),
        };
        let content_length = end - start + 1;

        // HEAD is metadata-only and must not turn a requested track into a
        // listened track. A valid GET/Range open is the first stock-player
        // signal and advances the row to `playing` before bytes are served.
        if !method_is_head {
            self.mark_activity_playing().await;
        }

        let body = if method_is_head {
            Body::empty()
        } else {
            let buffer = self.clone();
            let stream = async_stream::stream! {
                let mut file = match tokio::fs::File::open(&buffer.path).await {
                    Ok(file) => file,
                    Err(error) => {
                        yield Err::<Bytes, std::io::Error>(error);
                        return;
                    }
                };
                if let Err(error) = file.seek(SeekFrom::Start(start)).await {
                    yield Err::<Bytes, std::io::Error>(error);
                    return;
                }
                let mut position = start;
                let mut scratch = vec![0u8; STREAM_CHUNK_BYTES];
                while position <= end {
                    let available = match buffer.wait_until_readable(position).await {
                        Ok(value) => value,
                        Err(()) => {
                            yield Err::<Bytes, std::io::Error>(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "spotify playback ended before the declared WAV length",
                            ));
                            return;
                        }
                    };
                    let readable_end = available.saturating_sub(1).min(end);
                    let wanted = (readable_end - position + 1).min(scratch.len() as u64) as usize;
                    let read = match file.read(&mut scratch[..wanted]).await {
                        Ok(read) => read,
                        Err(error) => {
                            yield Err::<Bytes, std::io::Error>(error);
                            return;
                        }
                    };
                    if read == 0 {
                        tokio::task::yield_now().await;
                        continue;
                    }
                    position += read as u64;
                    let served_final_byte = position > end && end == total - 1;
                    yield Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&scratch[..read]));
                    // Decoder completion only finalized the private WAV. The
                    // durable activity becomes completed only after a stock
                    // HTTP stream has actually yielded the declared final byte.
                    // A range ending earlier, or a body cancelled before this
                    // point, remains playing until an explicit interruption.
                    if served_final_byte {
                        buffer.complete_activity().await;
                    }
                }
            };
            Body::from_stream(stream)
        };

        let mut response = Response::new(body);
        *response.status_mut() = if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        };
        let response_headers = response.headers_mut();
        response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/wav"));
        response_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        response_headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&content_length.to_string()).unwrap(),
        );
        response_headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, private"),
        );
        if partial {
            response_headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")).unwrap(),
            );
        }
        response
    }
}

impl Drop for PlaybackBuffer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A deliberately non-audible sink. Librespot decodes as quickly as the
/// network permits into a WAV that stock Humane ExoPlayer owns and plays.
pub struct WavSink {
    buffer: Arc<PlaybackBuffer>,
    file: File,
}

/// Stable sink owned by one long-lived librespot `Player`. New stock playback
/// requests stage a private WAV destination; librespot's normal
/// `stop(temporarily=true) -> start()` load transition flushes the old file and
/// atomically promotes the staged file before the first packet of the new track.
/// This lets the Player (and its private Tokio runtime) live for the full
/// Spotify Session instead of dropping Hyper/CDN dispatch tasks between songs.
#[derive(Clone)]
pub struct SwitchableWavSinkController {
    state: Arc<Mutex<SwitchableWavSinkState>>,
}

struct SwitchableWavSinkState {
    active: Option<SinkRoute>,
    staged: Option<SinkRoute>,
    next_generation: u64,
}

struct SinkRoute {
    generation: u64,
    sink: WavSink,
}

pub struct SwitchableWavSink {
    controller: SwitchableWavSinkController,
}

impl SwitchableWavSinkController {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(SwitchableWavSinkState {
                active: None,
                staged: None,
                next_generation: 0,
            })),
        }
    }

    pub fn sink(&self) -> SwitchableWavSink {
        SwitchableWavSink {
            controller: self.clone(),
        }
    }

    /// Stage exactly one destination. Playback calls are serialized above this
    /// layer, so a second staged route means an earlier transition did not reach
    /// a terminal event and must fail closed rather than overwrite its buffer.
    pub fn stage(&self, buffer: Arc<PlaybackBuffer>) -> Result<u64, String> {
        let sink = WavSink::open(buffer)?;
        let mut state = self.state.lock().unwrap();
        if state.staged.is_some() {
            return Err("spotify playback transition is already staged".into());
        }
        state.next_generation = state.next_generation.wrapping_add(1).max(1);
        let generation = state.next_generation;
        state.staged = Some(SinkRoute { generation, sink });
        Ok(generation)
    }

    /// Remove only the requested generation. Used after a bounded load failure
    /// or timeout, including the narrow race where `start()` already promoted
    /// the route just before the terminal event was observed.
    pub fn cancel(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state
            .staged
            .as_ref()
            .is_some_and(|route| route.generation == generation)
        {
            state.staged = None;
            return true;
        }
        if state
            .active
            .as_ref()
            .is_some_and(|route| route.generation == generation)
        {
            state.active = None;
            return true;
        }
        false
    }

    pub fn is_active(&self, generation: u64) -> bool {
        self.state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .is_some_and(|route| route.generation == generation)
    }

    pub fn is_same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    #[cfg(test)]
    fn generations(&self) -> (Option<u64>, Option<u64>) {
        let state = self.state.lock().unwrap();
        (
            state.active.as_ref().map(|route| route.generation),
            state.staged.as_ref().map(|route| route.generation),
        )
    }
}

impl Default for SwitchableWavSinkController {
    fn default() -> Self {
        Self::new()
    }
}

impl Sink for SwitchableWavSink {
    fn start(&mut self) -> SinkResult<()> {
        let mut state = self.controller.state.lock().unwrap();
        if let Some(staged) = state.staged.take() {
            state.active = Some(staged);
        }
        state
            .active
            .as_mut()
            .ok_or_else(|| SinkError::NotConnected("spotify playback route is unavailable".into()))?
            .sink
            .start()
    }

    fn stop(&mut self) -> SinkResult<()> {
        let mut state = self.controller.state.lock().unwrap();
        match state.active.as_mut() {
            Some(route) => route.sink.stop(),
            None => Ok(()),
        }
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        let mut state = self.controller.state.lock().unwrap();
        state
            .active
            .as_mut()
            .ok_or_else(|| SinkError::NotConnected("spotify playback route is unavailable".into()))?
            .sink
            .write(packet, converter)
    }
}

impl WavSink {
    pub fn open(buffer: Arc<PlaybackBuffer>) -> Result<Self, String> {
        let mut file = OpenOptions::new()
            .write(true)
            .open(&buffer.path)
            .map_err(|_| "spotify playback cache unavailable")?;
        file.seek(SeekFrom::Start(WAV_HEADER_BYTES))
            .map_err(|_| "spotify playback cache unavailable")?;
        Ok(Self { buffer, file })
    }
}

impl Sink for WavSink {
    fn stop(&mut self) -> SinkResult<()> {
        if self.file.flush().is_err() {
            self.buffer.finish(true);
            return Err(SinkError::OnWrite(
                "spotify playback cache unavailable".into(),
            ));
        }
        Ok(())
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        let samples = match packet {
            AudioPacket::Samples(samples) => converter.f64_to_s16(&samples),
            AudioPacket::Raw(_) => {
                self.buffer.finish(true);
                return Err(SinkError::InvalidParams(
                    "spotify decoder returned raw packets".into(),
                ));
            }
        };

        // Serialize writes with finish(): completion may extend the file only
        // after the final real sample has landed, and no late packet may write
        // beyond or overwrite the finalized zero tail.
        let mut progress = self.buffer.progress.lock().unwrap();
        if progress.complete || progress.failed {
            return Ok(());
        }
        let remaining = self
            .buffer
            .expected_pcm_bytes
            .saturating_sub(progress.pcm_bytes);
        if remaining == 0 {
            return Ok(());
        }
        let sample_limit = (remaining / BYTES_PER_SAMPLE).min(samples.len() as u64) as usize;
        let mut bytes = Vec::with_capacity(sample_limit * BYTES_PER_SAMPLE as usize);
        for sample in &samples[..sample_limit] {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        if self.file.write_all(&bytes).is_err() {
            progress.complete = true;
            progress.failed = true;
            drop(progress);
            self.buffer.changed.notify_waiters();
            return Err(SinkError::OnWrite(
                "spotify playback cache unavailable".into(),
            ));
        }
        progress.pcm_bytes =
            (progress.pcm_bytes + bytes.len() as u64).min(self.buffer.expected_pcm_bytes);
        drop(progress);
        self.buffer.changed.notify_waiters();
        Ok(())
    }
}

impl Drop for WavSink {
    fn drop(&mut self) {
        if self.file.flush().is_err() {
            self.buffer.finish(true);
        }
    }
}

fn create_private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "spotify playback cache unavailable".into())
}

fn expected_pcm_bytes(duration_ms: u64) -> Result<u64, String> {
    let bytes = duration_ms
        .checked_mul(SAMPLE_RATE)
        .and_then(|value| value.checked_mul(PCM_FRAME_BYTES))
        .map(|value| value / 1_000)
        .ok_or_else(|| "spotify track duration is too large".to_string())?;
    Ok(bytes - (bytes % PCM_FRAME_BYTES))
}

fn wav_header(pcm_bytes: u64) -> [u8; WAV_HEADER_BYTES as usize] {
    let pcm_bytes = pcm_bytes.min(u32::MAX as u64) as u32;
    let riff_bytes = pcm_bytes.saturating_add(36);
    let byte_rate = (SAMPLE_RATE * PCM_FRAME_BYTES) as u32;
    let mut header = [0u8; WAV_HEADER_BYTES as usize];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&riff_bytes.to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes());
    header[22..24].copy_from_slice(&(CHANNELS as u16).to_le_bytes());
    header[24..28].copy_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    header[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    header[32..34].copy_from_slice(&(PCM_FRAME_BYTES as u16).to_le_bytes());
    header[34..36].copy_from_slice(&16u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    header[40..44].copy_from_slice(&pcm_bytes.to_le_bytes());
    header
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

fn parse_range(headers: &HeaderMap, total: u64) -> Result<Option<ByteRange>, StatusCode> {
    let Some(value) = headers.get(header::RANGE) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
    let Some(value) = value.strip_prefix("bytes=") else {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    };
    if value.contains(',') || value.starts_with('-') {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let (start, end) = value
        .split_once('-')
        .ok_or(StatusCode::RANGE_NOT_SATISFIABLE)?;
    let start = start
        .parse::<u64>()
        .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
    if start >= total {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let end = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>()
            .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?
            .min(total - 1)
    };
    if end < start {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    Ok(Some(ByteRange { start, end }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn activity_status(db: &Database, id: i64) -> String {
        db.list_music_activity(100, None)
            .await
            .unwrap()
            .into_iter()
            .find(|record| record.id == id)
            .unwrap()
            .status
    }

    async fn attach_test_activity(db: &Database, buffer: &PlaybackBuffer) -> i64 {
        let id = db
            .start_music_activity(
                "0123456789012345678901",
                "Test track",
                &["Test artist".into()],
                Some("Test album"),
            )
            .await
            .unwrap();
        buffer.attach_activity(db.clone(), id).await;
        id
    }

    #[test]
    fn a_failed_buffer_reports_itself_so_the_route_can_answer_404() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "gone".into(), 1_000).unwrap();

        // A live buffer is servable even though nothing has been decoded yet —
        // the stream route waits on the write head rather than 404ing.
        assert!(!buffer.has_failed());

        buffer.finish(true);

        // Once failed it can never produce another byte, so the route must be
        // able to treat it as absent instead of committing to a Content-Length
        // it cannot satisfy and dying mid-body.
        assert!(buffer.has_failed());
    }

    #[test]
    fn a_cleanly_finished_buffer_is_not_reported_as_failed() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "kept".into(), 1_000).unwrap();

        // Finishing without a failure zero-pads to the declared duration; that
        // is a successful, fully servable buffer and must stay in the registry.
        buffer.finish(false);

        assert!(!buffer.has_failed());
        assert_eq!(buffer.total_bytes(), WAV_HEADER_BYTES + 176_400);
    }

    #[tokio::test]
    async fn preroll_gives_up_at_the_deadline_instead_of_withholding_playback() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "slow".into(), 60_000).unwrap();

        // Nothing is ever decoded, so the pre-roll can never be satisfied. It
        // must still return: a slow CDN should delay the start, never turn into
        // a refusal to play.
        let start = std::time::Instant::now();
        buffer
            .await_preroll(PLAYBACK_PREROLL_PCM_BYTES, Duration::from_millis(150))
            .await;
        let waited = start.elapsed();

        assert!(waited >= Duration::from_millis(120), "should have waited");
        assert!(waited < Duration::from_secs(2), "must be bounded");
    }

    #[tokio::test]
    async fn preroll_returns_early_when_the_buffer_is_already_terminal() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "dead".into(), 60_000).unwrap();
        buffer.finish(true);

        // A failed buffer will never produce the pre-roll, so waiting out the
        // deadline would add pure latency to a request that is already doomed.
        let start = std::time::Instant::now();
        buffer
            .await_preroll(PLAYBACK_PREROLL_PCM_BYTES, Duration::from_secs(30))
            .await;

        assert!(
            start.elapsed() < Duration::from_secs(1),
            "a terminal buffer must short-circuit the pre-roll",
        );
    }

    #[test]
    fn wav_header_matches_declared_pcm() {
        let pcm = expected_pcm_bytes(1_000).unwrap();
        assert_eq!(pcm, 176_400);
        let header = wav_header(pcm);
        assert_eq!(&header[..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(header[40..44].try_into().unwrap()),
            176_400
        );
    }

    #[test]
    fn switchable_sink_routes_packets_only_after_stop_start_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let first = PlaybackBuffer::create(directory.path(), "route-one".into(), 1_000).unwrap();
        let second = PlaybackBuffer::create(directory.path(), "route-two".into(), 1_000).unwrap();
        let controller = SwitchableWavSinkController::new();
        let first_generation = controller.stage(first.clone()).unwrap();
        let mut sink = controller.sink();
        let mut converter = Converter::new(None);

        sink.start().unwrap();
        sink.write(AudioPacket::Samples(vec![0.1; 4]), &mut converter)
            .unwrap();
        let second_generation = controller.stage(second.clone()).unwrap();
        // Staging alone must not retarget packets from the current track.
        sink.write(AudioPacket::Samples(vec![0.1; 2]), &mut converter)
            .unwrap();
        assert_eq!(
            controller.generations(),
            (Some(first_generation), Some(second_generation))
        );
        assert_eq!(first.progress.lock().unwrap().pcm_bytes, 12);
        assert_eq!(second.progress.lock().unwrap().pcm_bytes, 0);

        sink.stop().unwrap();
        sink.start().unwrap();
        sink.write(AudioPacket::Samples(vec![0.1; 4]), &mut converter)
            .unwrap();
        assert_eq!(controller.generations(), (Some(second_generation), None));
        assert_eq!(first.progress.lock().unwrap().pcm_bytes, 12);
        assert_eq!(second.progress.lock().unwrap().pcm_bytes, 8);
    }

    #[test]
    fn cancelling_staged_route_preserves_active_route_and_generation() {
        let directory = tempfile::tempdir().unwrap();
        let first = PlaybackBuffer::create(directory.path(), "active".into(), 1_000).unwrap();
        let second = PlaybackBuffer::create(directory.path(), "staged".into(), 1_000).unwrap();
        let controller = SwitchableWavSinkController::new();
        let active = controller.stage(first).unwrap();
        let mut sink = controller.sink();
        sink.start().unwrap();
        let staged = controller.stage(second).unwrap();

        assert!(controller.cancel(staged));
        assert_eq!(controller.generations(), (Some(active), None));
        assert!(!controller.cancel(staged));
    }

    #[test]
    fn start_without_staged_route_resumes_the_active_buffer() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "resume".into(), 1_000).unwrap();
        let controller = SwitchableWavSinkController::new();
        let generation = controller.stage(buffer.clone()).unwrap();
        let mut sink = controller.sink();
        let mut converter = Converter::new(None);

        sink.start().unwrap();
        sink.stop().unwrap();
        sink.start().unwrap();
        sink.write(AudioPacket::Samples(vec![0.1; 4]), &mut converter)
            .unwrap();

        assert_eq!(controller.generations(), (Some(generation), None));
        assert_eq!(buffer.progress.lock().unwrap().pcm_bytes, 8);
    }

    #[test]
    fn parses_exoplayer_open_ended_range() {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=44-"));
        assert_eq!(
            parse_range(&headers, 100).unwrap(),
            Some(ByteRange { start: 44, end: 99 })
        );
    }

    #[test]
    fn rejects_multiple_or_suffix_ranges() {
        for raw in ["bytes=0-1,4-5", "bytes=-20", "items=0-1"] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, HeaderValue::from_str(raw).unwrap());
            assert_eq!(
                parse_range(&headers, 100),
                Err(StatusCode::RANGE_NOT_SATISFIABLE)
            );
        }
    }

    #[tokio::test]
    async fn successful_short_decode_is_zero_padded_to_declared_length() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "short".into(), 1_000).unwrap();
        let real_pcm = [1u8, 2, 3, 4, 5, 6];

        {
            let mut file = OpenOptions::new().write(true).open(&buffer.path).unwrap();
            file.seek(SeekFrom::Start(WAV_HEADER_BYTES)).unwrap();
            file.write_all(&real_pcm).unwrap();
            let mut progress = buffer.progress.lock().unwrap();
            progress.pcm_bytes = real_pcm.len() as u64;
        }

        buffer.finish(false);

        let response = buffer.clone().response(false, &HeaderMap::new()).await;
        let declared_length = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .unwrap()
            .to_str()
            .unwrap()
            .parse::<usize>()
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(declared_length, buffer.total_bytes() as usize);
        assert_eq!(body.len(), declared_length);
        assert_eq!(
            &body[WAV_HEADER_BYTES as usize..WAV_HEADER_BYTES as usize + real_pcm.len()],
            &real_pcm
        );
        assert!(body[WAV_HEADER_BYTES as usize + real_pcm.len()..]
            .iter()
            .all(|byte| *byte == 0));
        assert_eq!(
            std::fs::metadata(&buffer.path).unwrap().len(),
            buffer.total_bytes()
        );
    }

    #[tokio::test]
    async fn failed_short_decode_is_not_padded_or_reported_as_a_full_body() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "failed".into(), 1_000).unwrap();
        let real_pcm = [1u8, 2, 3, 4];

        {
            let mut file = OpenOptions::new().write(true).open(&buffer.path).unwrap();
            file.seek(SeekFrom::Start(WAV_HEADER_BYTES)).unwrap();
            file.write_all(&real_pcm).unwrap();
            let mut progress = buffer.progress.lock().unwrap();
            progress.pcm_bytes = real_pcm.len() as u64;
        }

        buffer.finish(true);

        assert_eq!(
            std::fs::metadata(&buffer.path).unwrap().len(),
            WAV_HEADER_BYTES + real_pcm.len() as u64
        );
        let response = buffer.clone().response(false, &HeaderMap::new()).await;
        assert!(response.into_body().collect().await.is_err());
    }

    #[tokio::test]
    async fn clean_sink_drop_defers_to_the_authoritative_player_event() {
        let directory = tempfile::tempdir().unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "dropped".into(), 1_000).unwrap();

        drop(WavSink::open(buffer.clone()).unwrap());
        // Librespot may release its sink before delivering EndOfTrack. A clean
        // close therefore stays pending until that authoritative event arrives.
        buffer.finish(false);

        assert_eq!(
            std::fs::metadata(&buffer.path).unwrap().len(),
            buffer.total_bytes()
        );
        let response = buffer.clone().response(false, &HeaderMap::new()).await;
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .len(),
            buffer.total_bytes() as usize
        );
    }

    #[tokio::test]
    async fn head_never_advances_music_activity() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("activity.sqlite")).unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "head".into(), 1).unwrap();
        let id = attach_test_activity(&db, &buffer).await;

        let response = buffer.clone().response(true, &HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(activity_status(&db, id).await, "requested");
    }

    #[tokio::test]
    async fn full_stock_stream_marks_playing_then_completed() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("activity.sqlite")).unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "full".into(), 1).unwrap();
        let id = attach_test_activity(&db, &buffer).await;
        buffer.finish(false);

        let response = buffer.clone().response(false, &HeaderMap::new()).await;
        assert_eq!(activity_status(&db, id).await, "playing");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.len(), buffer.total_bytes() as usize);
        assert_eq!(activity_status(&db, id).await, "completed");

        // A later stop/replacement cannot overwrite a completed listen.
        buffer.interrupt_activity().await;
        assert_eq!(activity_status(&db, id).await, "completed");
    }

    #[tokio::test]
    async fn range_without_final_byte_never_marks_completed() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("activity.sqlite")).unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "partial".into(), 1).unwrap();
        let id = attach_test_activity(&db, &buffer).await;
        buffer.finish(false);
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=0-43"));

        let response = buffer.clone().response(false, &headers).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .len(),
            44
        );
        assert_eq!(activity_status(&db, id).await, "playing");

        buffer.interrupt_activity().await;
        assert_eq!(activity_status(&db, id).await, "interrupted");
    }

    #[tokio::test]
    async fn open_ended_stock_range_through_final_byte_marks_completed() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("activity.sqlite")).unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "open-range".into(), 1).unwrap();
        let id = attach_test_activity(&db, &buffer).await;
        buffer.finish(false);
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=44-"));

        let response = buffer.clone().response(false, &headers).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.len(), (buffer.total_bytes() - 44) as usize);
        assert_eq!(activity_status(&db, id).await, "completed");
    }

    #[tokio::test]
    async fn cancelled_full_stream_never_marks_completed() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("activity.sqlite")).unwrap();
        let buffer = PlaybackBuffer::create(directory.path(), "cancelled".into(), 1_000).unwrap();
        let id = attach_test_activity(&db, &buffer).await;
        buffer.finish(false);

        let response = buffer.clone().response(false, &HeaderMap::new()).await;
        let mut body = response.into_body();
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert!(first.len() < buffer.total_bytes() as usize);
        drop(body);
        assert_eq!(activity_status(&db, id).await, "playing");

        buffer.interrupt_activity().await;
        assert_eq!(activity_status(&db, id).await, "interrupted");
    }
}
