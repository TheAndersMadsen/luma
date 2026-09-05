//! Local, bounded input processing only. The caller owns capture permission,
//! source provenance, current-turn checks and transcript admission. Recognition
//! establishes neither actor identity nor permission to disclose the result.
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    fs::File,
    io::Read,
    path::Path,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, Semaphore};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const MODEL_ID: &str = "whisper.cpp-1.8.3/base-multilingual/60ed5bc3";
pub const MODEL_BYTES: u64 = 147_951_465;
pub const MODEL_SHA256: &str = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
pub const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin";
pub const SAMPLE_RATE: usize = 16_000;
pub const MAX_SAMPLES: usize = 15 * SAMPLE_RATE;
pub const MAX_TEXT_BYTES: usize = 2_048;
const MAX_SEGMENTS: usize = 32;
const MAX_WORK_TIME: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("local recognition input is not bounded normalized 16kHz mono PCM")]
    Input,
    #[error("local recognition worker is busy")]
    Busy,
    #[error("local recognition was cancelled")]
    Cancelled,
    #[error("local recognition deadline expired or exceeds its bound")]
    Deadline,
    #[error("local recognition model is unavailable or has the wrong size")]
    ModelFile,
    #[error("local recognition model checksum does not match")]
    ModelChecksum,
    #[error("local recognition model could not be initialized")]
    ModelLoad,
    #[error("local recognition failed")]
    Inference,
    #[error("local recognition result exceeds its bounds or is invalid")]
    ResultBounds,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Danish,
    English,
}

/// No Debug or serialization: raw input stays in memory until worker exit.
/// The upstream capture/resampler establishes the rate and channel count.
pub struct Pcm16Mono(Box<[f32]>);
impl Pcm16Mono {
    pub fn new(samples: Vec<f32>) -> Result<Self, Error> {
        if samples.is_empty()
            || samples.len() > MAX_SAMPLES
            || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0)
        {
            return Err(Error::Input);
        }
        Ok(Self(samples.into_boxed_slice()))
    }
}

/// Untrusted recognition text. Empty decoding is NoMatch, never a claim that
/// the microphone captured silence. No Debug/Display or serialization.
pub enum Recognition {
    NoMatch,
    Transcript(String),
}

#[derive(Clone, Default)]
pub struct Cancellation(Arc<CancellationState>);
#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    notify: Notify,
    #[cfg(test)]
    native_abort_observed: AtomicBool,
}
impl Cancellation {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        loop {
            let notification = self.0.notify.notified();
            tokio::pin!(notification);
            notification.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notification.await;
        }
    }
}

struct CancelOnDrop(Option<Cancellation>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancellation) = &self.0 {
            cancellation.cancel();
        }
    }
}

// Shared by every recognizer and clone, including initialization. Never queue
// microphone buffers in the blocking pool. The actual worker owns the permit
// until native code returns, even when the waiting future is dropped.
fn worker_limit() -> &'static Arc<Semaphore> {
    static WORKER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    WORKER.get_or_init(|| Arc::new(Semaphore::new(1)))
}

/// Load once during service initialization, outside the async executor. Model
/// files are provisioned externally; this adapter never downloads or falls back.
#[derive(Clone)]
pub struct LocalRecognizer(Arc<WhisperContext>);
impl LocalRecognizer {
    pub fn load(model_path: &Path) -> Result<Self, Error> {
        let _permit = worker_limit().try_acquire().map_err(|_| Error::Busy)?;
        whisper_rs::install_logging_hooks();
        let bytes = verified_model(model_path)?;
        // Decode exactly the bytes verified above, not a reopened pathname.
        let context = WhisperContext::new_from_buffer_with_params(
            &bytes,
            WhisperContextParameters {
                use_gpu: false,
                ..Default::default()
            },
        )
        .map_err(|_| Error::ModelLoad)?;
        if !context.is_multilingual() {
            return Err(Error::ModelLoad);
        }
        Ok(Self(Arc::new(context)))
    }

    /// Caller passes the remaining turn deadline and cancels when origin or
    /// authority changes. Completion must still be admitted under that same
    /// durable fence. Dropping this future requests native cooperative abort;
    /// it does not claim a hard bound on how soon native computation stops.
    pub async fn transcribe(
        &self,
        pcm: Pcm16Mono,
        language: Language,
        deadline: Instant,
        cancellation: Cancellation,
    ) -> Result<Recognition, Error> {
        let context = Arc::clone(&self.0);
        bounded_work(deadline, cancellation, move |abort| {
            // An exactly zero digital buffer carries no recorded signal. The
            // pinned decoder can hallucinate on it. This exact check is not VAD
            // and makes no claim about quiet speech, noise or background media.
            if pcm.0.iter().all(|sample| *sample == 0.0) {
                return Ok(Recognition::NoMatch);
            }
            let mut state = context.create_state().map_err(|_| Error::Inference)?;
            let mut params = language_parameters(language);
            // SAFETY: `abort` is caller-owned Arc storage kept alive throughout
            // synchronous full(). Native callbacks receive a shared reference
            // only, never mutate the context, never retain this pointer, and
            // cannot outlive full(). No raw Arc conversion transfers ownership.
            unsafe {
                params.set_abort_callback(Some(abort_callback));
                params.set_abort_callback_user_data(Arc::as_ptr(&abort).cast_mut().cast());
            }
            let result = state.full(params, &pcm.0);
            abort.check()?;
            result.map_err(|_| Error::Inference)?;
            if state.full_n_segments() < 0 || state.full_n_segments() as usize > MAX_SEGMENTS {
                return Err(Error::ResultBounds);
            }
            collect_text(
                state
                    .as_iter()
                    .map(|segment| segment.to_str().map_err(|_| Error::ResultBounds)),
            )
        })
        .await
    }
}

fn verified_model(path: &Path) -> Result<Vec<u8>, Error> {
    let file = File::open(path).map_err(|_| Error::ModelFile)?;
    let metadata = file.metadata().map_err(|_| Error::ModelFile)?;
    if !metadata.is_file() || metadata.len() != MODEL_BYTES {
        return Err(Error::ModelFile);
    }
    let mut bytes = Vec::with_capacity(MODEL_BYTES as usize);
    file.take(MODEL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::ModelFile)?;
    if bytes.len() as u64 != MODEL_BYTES {
        return Err(Error::ModelFile);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != MODEL_SHA256 {
        return Err(Error::ModelChecksum);
    }
    Ok(bytes)
}

fn language_parameters(language: Language) -> FullParams<'static, 'static> {
    // whisper-rs 0.16.0 set_language leaks its CString. Exactly two immutable
    // process-lifetime templates bound this upstream allocation; per-turn clones
    // never call CString setters and retained templates never carry callbacks.
    static LANGUAGES: OnceLock<[FullParams<'static, 'static>; 2]> = OnceLock::new();
    let templates = LANGUAGES.get_or_init(|| {
        ["da", "en"].map(|language| {
            let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            p.set_language(Some(language));
            p.set_n_threads(4);
            p.set_translate(false);
            p.set_detect_language(false);
            p.set_no_context(true);
            p.set_n_max_text_ctx(0);
            p.set_no_timestamps(true);
            p.set_max_tokens(128);
            p.set_print_special(false);
            p.set_print_progress(false);
            p.set_print_realtime(false);
            p.set_print_timestamps(false);
            p
        })
    });
    templates[match language {
        Language::Danish => 0,
        Language::English => 1,
    }]
    .clone()
}

fn collect_text<'a>(
    segments: impl Iterator<Item = Result<&'a str, Error>>,
) -> Result<Recognition, Error> {
    let mut text = String::new();
    for (index, segment) in segments.enumerate() {
        let segment = segment?.trim();
        let separator = usize::from(!text.is_empty() && !segment.is_empty());
        if index >= MAX_SEGMENTS || text.len() + separator + segment.len() > MAX_TEXT_BYTES {
            return Err(Error::ResultBounds);
        }
        if separator != 0 {
            text.push(' ');
        }
        text.push_str(segment);
    }
    Ok(if text.is_empty() {
        Recognition::NoMatch
    } else {
        Recognition::Transcript(text)
    })
}

struct AbortState {
    cancellation: Cancellation,
    deadline: Instant,
}
impl AbortState {
    fn check(&self) -> Result<(), Error> {
        if self.cancellation.is_cancelled() {
            Err(Error::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(Error::Deadline)
        } else {
            Ok(())
        }
    }
}

unsafe extern "C" fn abort_callback(data: *mut c_void) -> bool {
    // SAFETY: only transcribe installs this callback, with a live Arc<AbortState>
    // held until full returns. Fields are immutable or atomic and read-only.
    let Some(state) = (unsafe { data.cast::<AbortState>().as_ref() }) else {
        return true;
    };
    let abort = state.check().is_err();
    #[cfg(test)]
    if abort {
        state
            .cancellation
            .0
            .native_abort_observed
            .store(true, Ordering::Release);
    }
    abort
}

async fn bounded_work(
    deadline: Instant,
    cancellation: Cancellation,
    work: impl FnOnce(Arc<AbortState>) -> Result<Recognition, Error> + Send + 'static,
) -> Result<Recognition, Error> {
    let abort = Arc::new(AbortState {
        cancellation: cancellation.clone(),
        deadline,
    });
    abort.check()?;
    if deadline.duration_since(Instant::now()) > MAX_WORK_TIME {
        return Err(Error::Deadline);
    }
    let permit = worker_limit()
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Busy)?;
    let mut cancel_on_drop = CancelOnDrop(Some(cancellation.clone()));
    let worker_abort = Arc::clone(&abort);
    let worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        worker_abort.check()?;
        let result = work(Arc::clone(&worker_abort));
        worker_abort.check()?;
        result
    });
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Error::Cancelled),
        _ = tokio::time::sleep_until(deadline.into()) => Err(Error::Deadline),
        result = worker => result.map_err(|_| Error::Inference)?,
    };
    abort.check()?;
    if result.is_ok() {
        // Disarm without marking successful work cancelled.
        cancel_on_drop.0 = None;
    }
    result
}

#[cfg(test)]
mod tests;
