mod playback;
pub mod types;

use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures::{FutureExt as _, StreamExt as _};
use librespot_audio::{AudioDecrypt, AudioFile};
use librespot_core::authentication::Credentials;
use librespot_core::config::SessionConfig;
use librespot_core::session::Session;
use librespot_core::SpotifyUri;
use librespot_discovery::{DeviceType, Discovery};
use librespot_metadata::audio::{AudioFileFormat, AudioFiles};
use librespot_metadata::{Album, Metadata as _, Playlist, Track};
use librespot_playback::config::{Bitrate, NormalisationMethod, NormalisationType, PlayerConfig};
use librespot_playback::mixer::NoOpVolume;
use librespot_playback::player::{Player, PlayerEvent, PlayerEventChannel};
use rand::TryRng as _;
use reqwest::{Client, RequestBuilder, Response as ReqwestResponse};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use subtle::ConstantTimeEq as _;
use tokio::sync::{oneshot, watch, Mutex, Notify, RwLock};
use tracing::{info, warn};
use uuid::Uuid;

use self::playback::{
    PlaybackBuffer, SwitchableWavSinkController, PLAYBACK_PREROLL_DEADLINE,
    PLAYBACK_PREROLL_PCM_BYTES,
};
pub use self::types::{
    SpotifyPlaybackRequest, SpotifyPlaybackResponse, SpotifyQueryRequest, SpotifyQueryResponse,
    SpotifyRankingProvenance, SpotifySaveRequest, SpotifySaveResponse, SpotifyState, SpotifyStatus,
    SpotifyTrack, UpdateSpotifySettings,
};
use crate::config::SpotifyConfig;
use crate::db::Database;
use crate::esim::EsimBridge;
use crate::tier_a::operational_markers;

const AUTH_VERSION: u8 = 1;
const MAX_AUTH_BYTES: u64 = 64 * 1024;
const PAIRING_LIFETIME: Duration = Duration::from_secs(120);
const VAULT_COMMIT_TIMEOUT: Duration = Duration::from_secs(8);
const SESSION_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const PLAYER_LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PLAYER_DROP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);
const SPOTIFY_API: &str = "https://api.spotify.com/v1";
const SEARCH_SCOPE: &str = "user-read-private";
const LIBRARY_READ_SCOPE: &str = "user-library-read";
const LIBRARY_WRITE_SCOPE: &str = "user-library-modify";
const PLAYLIST_READ_SCOPE: &str = "playlist-read-private,playlist-read-collaborative";
const TOP_ITEMS_SCOPE: &str = "user-top-read";
const MAX_TRACK_CACHE: usize = 256;
const MAX_PLAYBACK_BUFFERS: usize = 3;
const API_PAGE_SIZE: usize = 50;
const MAX_PLAYLIST_DISCOVERY_PAGES: usize = 100;
const METADATA_CONCURRENCY: usize = 8;
const MAX_RATE_LIMIT_RETRY_AFTER: Duration = Duration::from_secs(5);
const BRIDGE_TOKEN_ENV: &str = "PENUMBRA_SPOTIFY_BRIDGE_TOKEN";
const BRIDGE_TOKEN_HEADER: &str = "x-penumbra-spotify-bridge-token";
const BRIDGE_TOKEN_CHARS: usize = 64;

#[derive(Clone)]
pub struct SpotifyService {
    inner: Arc<SpotifyInner>,
}

struct SpotifyInner {
    settings: RwLock<SpotifyConfig>,
    runtime: Mutex<Runtime>,
    playback_gate: Mutex<()>,
    /// Negative cache for the artist top-tracks primary lookup. While set and
    /// in the future, `query(kind=artist)` skips the known-unavailable primary
    /// and goes straight to the ranked-search fallback, saving a dead provider
    /// roundtrip per music prompt. Cleared on the next primary success.
    artist_top_tracks_backoff_until: std::sync::Mutex<Option<Instant>>,
    lifecycle: Arc<LifecycleGate>,
    auth_path: PathBuf,
    cache_dir: PathBuf,
    stream_origin: String,
    bridge_token: Option<String>,
    http: Client,
    persistence: EsimBridge,
    db: Database,
}

struct Runtime {
    state: RuntimeState,
    playback_epoch: u64,
    session: Option<Session>,
    player: Option<Arc<Player>>,
    sink_controller: Option<SwitchableWavSinkController>,
    playback_watcher: Option<tokio::task::JoinHandle<()>>,
    active_buffer: Option<Arc<PlaybackBuffer>>,
    buffers: HashMap<String, Arc<PlaybackBuffer>>,
    buffer_order: VecDeque<String>,
    tracks: HashMap<String, SpotifyTrack>,
    reconnect_failures: u32,
    reconnect_not_before: Option<tokio::time::Instant>,
    reconnect_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PlaybackLease {
    epoch: u64,
    session_id: String,
}

struct PendingPlaybackPublication {
    ticket: String,
    buffer: Arc<PlaybackBuffer>,
    watcher: tokio::task::JoinHandle<()>,
}

struct PlaybackAttemptGuard {
    controller: SwitchableWavSinkController,
    route_generation: u64,
    buffer: Arc<PlaybackBuffer>,
    armed: bool,
}

impl PlaybackAttemptGuard {
    fn new(
        controller: SwitchableWavSinkController,
        route_generation: u64,
        buffer: Arc<PlaybackBuffer>,
    ) -> Self {
        Self {
            controller,
            route_generation,
            buffer,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PlaybackAttemptGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // This runs only during an unexpected unwind. Clean the exact staged
        // generation and its activity, never global Runtime state. Each step is
        // isolated so a poisoned cache/sink lock cannot double-panic the worker.
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.controller.cancel(self.route_generation);
        }));
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            self.buffer.finish(true);
        }));
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let buffer = self.buffer.clone();
            handle.spawn(async move {
                buffer.fail_activity().await;
            });
        }
    }
}

enum RuntimeState {
    SignedOut,
    Pairing { expires_at: i64 },
    Ready { username: Option<String> },
    Error { message: String },
}

struct PairingTask {
    generation: u64,
    cancel: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct LifecycleGate {
    state: Mutex<LifecycleState>,
    changed: Notify,
}

#[derive(Default)]
struct LifecycleState {
    generation: u64,
    transition_generation: Option<u64>,
    pairing_task: Option<PairingTask>,
}

impl LifecycleGate {
    /// Serialize public lifecycle mutations without holding a mutex across
    /// network, vault, task-join, or player-shutdown awaits. Incrementing the
    /// generation first atomically invalidates every older async operation.
    async fn begin_transition(&self) -> u64 {
        loop {
            let changed = self.changed.notified();
            {
                let mut state = self.state.lock().await;
                if state.transition_generation.is_none() {
                    state.generation = next_generation(state.generation);
                    let generation = state.generation;
                    state.transition_generation = Some(generation);
                    return generation;
                }
            }
            changed.await;
        }
    }

    /// Pairing start is the one transition that must not invalidate an
    /// already-running pairing attempt. Check and reserve the transition in
    /// the same critical section so two concurrent starts cannot both win.
    async fn begin_pairing_transition(&self) -> Result<u64, ()> {
        self.begin_transition_without_active_pairing().await
    }

    /// Lazy session recovery must never invalidate a live Spotify Connect
    /// pairing attempt. Concurrent demand is coalesced by reporting an occupied
    /// transition rather than queueing another network attempt.
    async fn try_begin_reconnect_transition(&self) -> Result<Option<u64>, ()> {
        let mut state = self.state.lock().await;
        if state.pairing_task.is_some() {
            return Err(());
        }
        if state.transition_generation.is_some() {
            return Ok(None);
        }
        state.generation = next_generation(state.generation);
        let generation = state.generation;
        state.transition_generation = Some(generation);
        Ok(Some(generation))
    }

    async fn begin_transition_without_active_pairing(&self) -> Result<u64, ()> {
        loop {
            let changed = self.changed.notified();
            {
                let mut state = self.state.lock().await;
                if state.transition_generation.is_none() {
                    if state.pairing_task.is_some() {
                        return Err(());
                    }
                    state.generation = next_generation(state.generation);
                    let generation = state.generation;
                    state.transition_generation = Some(generation);
                    return Ok(generation);
                }
            }
            changed.await;
        }
    }

    async fn end_transition(&self, generation: u64) {
        let changed = {
            let mut state = self.state.lock().await;
            if state.transition_generation == Some(generation) {
                state.transition_generation = None;
                true
            } else {
                false
            }
        };
        if changed {
            self.changed.notify_waiters();
        }
    }
}

fn next_generation(current: u64) -> u64 {
    let next = current.wrapping_add(1);
    if next == 0 {
        1
    } else {
        next
    }
}

fn install_pairing_task(state: &mut LifecycleState, task: PairingTask) -> Result<(), PairingTask> {
    if state.pairing_task.is_some() || state.generation != task.generation {
        Err(task)
    } else {
        state.pairing_task = Some(task);
        Ok(())
    }
}

fn take_pairing_task_for_generation(
    state: &mut LifecycleState,
    generation: u64,
) -> Option<PairingTask> {
    if state
        .pairing_task
        .as_ref()
        .is_some_and(|task| task.generation == generation)
    {
        state.pairing_task.take()
    } else {
        None
    }
}

fn publication_allowed(
    current_generation: u64,
    operation_generation: u64,
    settings: &SpotifyConfig,
) -> bool {
    current_generation == operation_generation
        && settings.enabled
        && settings.experimental_acknowledged
}

fn spotify_playback_enabled(settings: &SpotifyConfig) -> bool {
    settings.enabled && settings.experimental_acknowledged
}

fn spotify_playback_gate_error(settings: &SpotifyConfig) -> Option<SpotifyError> {
    if !settings.enabled {
        Some(SpotifyError::Disabled)
    } else if !settings.experimental_acknowledged {
        Some(SpotifyError::AcknowledgementRequired)
    } else {
        None
    }
}

fn runtime_matches_playback_lease(runtime: &Runtime, lease: &PlaybackLease) -> bool {
    runtime.playback_epoch == lease.epoch
        && matches!(runtime.state, RuntimeState::Ready { .. })
        && runtime.session.as_ref().is_some_and(|session| {
            !session.is_invalid() && session.session_id() == lease.session_id
        })
}

fn runtime_matches_playback_owner(
    runtime: &Runtime,
    lease: &PlaybackLease,
    player: &Arc<Player>,
    controller: &SwitchableWavSinkController,
) -> bool {
    runtime_matches_playback_lease(runtime, lease)
        && !player.is_invalid()
        && runtime
            .player
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, player))
        && runtime
            .sink_controller
            .as_ref()
            .is_some_and(|current| current.is_same(controller))
}

/// No make-up gain. Deliberate, and the opposite of the obvious instinct.
///
/// The Pin's speaker is already protected and tuned *below* the app, and that
/// tune is keyed to the **volume index**, not to the signal level:
/// `audio_effects.xml` binds the AOSP `volume_listener` effect (`music_helper`)
/// to `<stream type="music">`, which pushes a different ACDB calibration into
/// the ADSP at each volume step. Digitally pre-boosting the stream therefore
/// pushes more energy through a calibration that assumes a nominal level — it
/// spends the excursion and thermal headroom the speaker-protection algorithm
/// budgets, so protection engages earlier and the audible result is ramp-down
/// and pumping rather than loudness. On this device the way to get louder is to
/// raise the system volume index, which the calibration is built for.
const PIN_SPEAKER_PREGAIN_DB: f64 = 0.0;

/// Player settings for the Pin's built-in speaker.
///
/// Observed from operator-owned firmware evidence kept outside canonical
/// source (optionally mounted under `decompile-workspace/` for local tests):
///
/// - The stock music app applied **zero** app-level DSP: there is no
///   `android.media.audiofx` usage anywhere in it — no equaliser, no loudness
///   enhancer, no dynamics processing. It handed compressed audio straight to
///   the DSP through ExoPlayer offload.
/// - All speaker shaping lives below the app in Qualcomm's stack. Speaker
///   protection is on system-wide (`persist.vendor.audio.speaker.prot.enable`,
///   `persist.vendor.audio.spv3.enable`), the audio policy declares
///   `speaker_drc_enabled="true"`, and an ADSP RX limiter with excursion and
///   thermal thresholds runs closed-loop against the smart amp's V/I sense.
/// - Stock requested Tidal quality `HIGH` (~AAC 320 kbps) by default, so 320
///   kbps here is at or above stock parity. There is nothing to gain above it;
///   the speaker output path tops out at 48 kHz.
///
/// The rule that follows is **do not duplicate the platform**: no EQ, no
/// high-pass, no make-up gain, no attempt to "protect" the driver. What the
/// platform genuinely cannot do is level one track against the next — the ADSP
/// knows nothing about per-track master levels — so that, and only that, is
/// what is added here.
///
/// `Dynamic` is kept not as a second acoustic limiter but as a guard on our own
/// digital headroom: normalisation applies positive gain to quiet masters, and a
/// sample clipped here is destroyed before the DSP ever sees it. With no pregain
/// it should rarely engage. `Track` (rather than `Auto`) suits a device that
/// plays individually requested songs rather than albums in order.
///
/// Attack/release/knee/threshold stay at librespot's defaults; moving them
/// without listening tests risks audible pumping. The `f64 -> s16` sink keeps
/// librespot's default triangular ditherer.
fn pin_speaker_player_config() -> PlayerConfig {
    PlayerConfig {
        // Stock asked Tidal for HIGH (~AAC 320); this is parity or better.
        bitrate: Bitrate::Bitrate320,
        // Unchanged: the sink serves one WAV per track, so gapless does not apply.
        gapless: false,
        passthrough: false,
        // The one thing the platform cannot do for us: track-to-track levelling.
        normalisation: true,
        normalisation_type: NormalisationType::Track,
        normalisation_method: NormalisationMethod::Dynamic,
        normalisation_pregain_db: PIN_SPEAKER_PREGAIN_DB,
        ..PlayerConfig::default()
    }
}

fn install_player_if_current(
    runtime: &mut Runtime,
    settings: &SpotifyConfig,
    lease: &PlaybackLease,
    player: &Arc<Player>,
    controller: &SwitchableWavSinkController,
) -> bool {
    if !spotify_playback_enabled(settings)
        || !runtime_matches_playback_lease(runtime, lease)
        || player.is_invalid()
        || runtime.player.is_some()
        || runtime.sink_controller.is_some()
    {
        return false;
    }
    runtime.player = Some(player.clone());
    runtime.sink_controller = Some(controller.clone());
    true
}

fn publish_playback_if_current(
    runtime: &mut Runtime,
    settings: &SpotifyConfig,
    lease: &PlaybackLease,
    player: &Arc<Player>,
    controller: &SwitchableWavSinkController,
    pending: PendingPlaybackPublication,
) -> Result<(), PendingPlaybackPublication> {
    if !spotify_playback_enabled(settings)
        || !runtime_matches_playback_owner(runtime, lease, player, controller)
    {
        return Err(pending);
    }

    runtime.active_buffer = Some(pending.buffer.clone());
    runtime.playback_watcher = Some(pending.watcher);
    runtime
        .buffers
        .insert(pending.ticket.clone(), pending.buffer);
    runtime
        .buffer_order
        .retain(|existing| existing != &pending.ticket);
    runtime.buffer_order.push_back(pending.ticket);
    while runtime.buffer_order.len() > MAX_PLAYBACK_BUFFERS {
        if let Some(expired) = runtime.buffer_order.pop_front() {
            runtime.buffers.remove(&expired);
        }
    }
    Ok(())
}

fn should_restore_saved_session(state: &RuntimeState, session_ready: bool) -> bool {
    !session_ready && !matches!(state, RuntimeState::Pairing { .. })
}

fn reconnect_backoff(failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(4);
    Duration::from_secs((2_u64 << exponent).min(MAX_RECONNECT_BACKOFF.as_secs()))
}

fn reconnect_is_due(not_before: Option<tokio::time::Instant>, now: tokio::time::Instant) -> bool {
    not_before.is_none_or(|deadline| now >= deadline)
}

fn reconnect_failure_needs_backoff(error: &SpotifyError) -> bool {
    matches!(error, SpotifyError::Unavailable | SpotifyError::Persistence)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlayerLoadFailure {
    Unavailable,
    Stopped,
    EndedBeforePlaying,
    ChannelClosed,
    Timeout,
}

impl PlayerLoadFailure {
    fn invalidates_player(self) -> bool {
        matches!(self, Self::ChannelClosed | Self::Timeout)
    }
}

/// Bind a reused Player event channel to the first request id announced after
/// the receiver was registered, then ignore every event for older/newer loads.
/// This is required for same-track replay, where URI matching is ambiguous.
async fn await_player_load(
    events: &mut PlayerEventChannel,
    timeout: Duration,
) -> Result<u64, PlayerLoadFailure> {
    tokio::time::timeout(timeout, async {
        let mut request_id = None;
        while let Some(event) = events.recv().await {
            match event {
                PlayerEvent::PlayRequestIdChanged { play_request_id } if request_id.is_none() => {
                    request_id = Some(play_request_id);
                }
                PlayerEvent::Playing {
                    play_request_id, ..
                } if request_id == Some(play_request_id) => return Ok(play_request_id),
                PlayerEvent::Unavailable {
                    play_request_id, ..
                } if request_id == Some(play_request_id) => {
                    return Err(PlayerLoadFailure::Unavailable);
                }
                PlayerEvent::Stopped {
                    play_request_id, ..
                } if request_id == Some(play_request_id) => {
                    return Err(PlayerLoadFailure::Stopped);
                }
                PlayerEvent::EndOfTrack {
                    play_request_id, ..
                } if request_id == Some(play_request_id) => {
                    return Err(PlayerLoadFailure::EndedBeforePlaying);
                }
                _ => {}
            }
        }
        Err(PlayerLoadFailure::ChannelClosed)
    })
    .await
    .unwrap_or(Err(PlayerLoadFailure::Timeout))
}

async fn watch_player_terminal(
    mut events: PlayerEventChannel,
    request_id: u64,
    buffer: Arc<PlaybackBuffer>,
) {
    while let Some(event) = events.recv().await {
        match event {
            PlayerEvent::EndOfTrack {
                play_request_id, ..
            } if play_request_id == request_id => {
                // Decoder completion finalizes the private WAV; only the HTTP
                // stream is authoritative for durable listening completion.
                buffer.finish(false);
                return;
            }
            PlayerEvent::Stopped {
                play_request_id, ..
            } if play_request_id == request_id => {
                buffer.finish(true);
                buffer.interrupt_activity().await;
                return;
            }
            PlayerEvent::Unavailable {
                play_request_id, ..
            } if play_request_id == request_id => {
                buffer.finish(true);
                buffer.fail_activity().await;
                return;
            }
            _ => {}
        }
    }
    buffer.finish(true);
    buffer.fail_activity().await;
}

type RuntimeResources = (
    Option<Arc<Player>>,
    Option<Arc<PlaybackBuffer>>,
    Option<Session>,
);

fn take_runtime_resources(
    runtime: &mut Runtime,
    state: RuntimeState,
    clear_tracks: bool,
) -> RuntimeResources {
    // Every teardown invalidates all detached playback work, even when there
    // are no resources left to take. A stale task can hold cloned Session and
    // Player handles after this point, but it can never publish them again.
    runtime.playback_epoch = runtime.playback_epoch.wrapping_add(1);
    let player = runtime.player.take();
    let active_buffer = runtime.active_buffer.take();
    let session = runtime.session.take();
    runtime.sink_controller = None;
    if let Some(watcher) = runtime.playback_watcher.take() {
        watcher.abort();
    }
    runtime.buffers.clear();
    runtime.buffer_order.clear();
    if clear_tracks {
        runtime.tracks.clear();
        runtime.reconnect_failures = 0;
        runtime.reconnect_not_before = None;
        runtime.reconnect_error = None;
    }
    runtime.state = state;
    (player, active_buffer, session)
}

fn stop_stale_player(player: Arc<Player>) {
    player.stop();
    drop_player_off_thread(player);
}

fn drop_player_off_thread(player: Arc<Player>) {
    drop(tokio::task::spawn_blocking(move || drop(player)));
}

#[derive(Default)]
struct PairingFinalization {
    local_auth_written: bool,
    vault_confirmed: bool,
}

impl PairingFinalization {
    fn can_publish(&self, cancelled: bool) -> bool {
        self.local_auth_written && self.vault_confirmed && !cancelled
    }
}

enum PairingRunError {
    Cancelled,
    Failed(SpotifyError),
}

impl From<SpotifyError> for PairingRunError {
    fn from(error: SpotifyError) -> Self {
        Self::Failed(error)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredAuth {
    version: u8,
    device_id: String,
    credentials: Credentials,
}

#[derive(Debug)]
pub enum SpotifyError {
    Disabled,
    AcknowledgementRequired,
    NotPaired,
    Pairing,
    AlreadyPaired,
    InvalidRequest(&'static str),
    RateLimited,
    Unavailable,
    Persistence,
}

impl SpotifyError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::Disabled | Self::AcknowledgementRequired => StatusCode::PRECONDITION_FAILED,
            Self::NotPaired => StatusCode::UNAUTHORIZED,
            Self::Pairing | Self::AlreadyPaired => StatusCode::CONFLICT,
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::Unavailable | Self::Persistence => StatusCode::SERVICE_UNAVAILABLE,
        }
    }

    pub fn safe_message(&self) -> &'static str {
        match self {
            Self::Disabled => "Spotify is disabled",
            Self::AcknowledgementRequired => "Spotify acknowledgement is required",
            Self::NotPaired => "Spotify is not paired",
            Self::Pairing => "Spotify pairing is already active",
            Self::AlreadyPaired => "Spotify is already paired; disconnect it before pairing again",
            Self::InvalidRequest(message) => message,
            Self::RateLimited => "Spotify rate limit reached",
            Self::Unavailable => "Spotify is temporarily unavailable",
            Self::Persistence => "Spotify credentials could not be protected",
        }
    }
}

/// Run a lifecycle mutation in a detached owner. The request may disappear at
/// any await point (browser navigation, USB loss, or a client timeout), but the
/// owner always publishes a bounded result and releases the reserved generation.
async fn await_owned_transition<T, F>(
    lifecycle: Arc<LifecycleGate>,
    generation: u64,
    operation: F,
) -> Result<T, SpotifyError>
where
    T: Send + 'static,
    F: std::future::Future<Output = Result<T, SpotifyError>> + Send + 'static,
{
    let (completed, completion) = oneshot::channel();
    tokio::spawn(async move {
        let attempted = AssertUnwindSafe(operation).catch_unwind().await;
        let result = match attempted {
            Ok(result) => result,
            Err(_) => {
                warn!("Spotify lifecycle worker panicked");
                Err(SpotifyError::Unavailable)
            }
        };
        lifecycle.end_transition(generation).await;
        let _ = completed.send(result);
    });
    completion.await.unwrap_or(Err(SpotifyError::Unavailable))
}

impl SpotifyService {
    pub async fn new(
        settings: SpotifyConfig,
        config_path: &Path,
        http_bind_addr: SocketAddr,
        http: Client,
        persistence: EsimBridge,
        db: Database,
    ) -> Self {
        match db.interrupt_stale_music_activity().await {
            Ok(count) if count > 0 => {
                info!(count, "reconciled stale Spotify activity rows");
            }
            Ok(_) => {}
            Err(_) => warn!("Spotify activity reconciliation failed"),
        }
        let files_dir = config_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let auth_path = std::env::var_os("PENUMBRA_SPOTIFY_AUTH_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| files_dir.join("spotify-auth.json"));
        let cache_dir = files_dir.join("spotify-cache");
        let bridge_token = std::env::var(BRIDGE_TOKEN_ENV)
            .ok()
            .filter(|token| valid_bridge_token(token));
        if cfg!(target_os = "android") && bridge_token.is_none() {
            warn!("Spotify hook bridge authentication is unavailable");
        }
        clear_playback_cache(&cache_dir);
        let stream_origin = format!("http://127.0.0.1:{}", http_bind_addr.port());
        let service = Self {
            inner: Arc::new(SpotifyInner {
                settings: RwLock::new(settings.clone()),
                runtime: Mutex::new(Runtime {
                    state: RuntimeState::SignedOut,
                    playback_epoch: 0,
                    session: None,
                    player: None,
                    sink_controller: None,
                    playback_watcher: None,
                    active_buffer: None,
                    buffers: HashMap::new(),
                    buffer_order: VecDeque::new(),
                    tracks: HashMap::new(),
                    reconnect_failures: 0,
                    reconnect_not_before: None,
                    reconnect_error: None,
                }),
                playback_gate: Mutex::new(()),
                artist_top_tracks_backoff_until: std::sync::Mutex::new(None),
                lifecycle: Arc::new(LifecycleGate::default()),
                auth_path,
                cache_dir,
                stream_origin,
                bridge_token,
                http,
                persistence,
                db,
            }),
        };

        if settings.enabled && settings.experimental_acknowledged {
            match load_auth(&service.inner.auth_path) {
                Ok(stored) => {
                    // Expose the durable pairing immediately. Session recovery
                    // runs detached so an offline Spotify AP never delays the
                    // dashboard or gRPC listeners during server startup.
                    service.inner.runtime.lock().await.state = RuntimeState::Ready {
                        username: stored.credentials.username,
                    };
                    let restoring = service.clone();
                    tokio::spawn(async move {
                        if let Err(error) = restoring.restore_saved_session().await {
                            warn!(
                                error = error.safe_message(),
                                "Spotify saved session could not be restored at startup"
                            );
                        }
                    });
                }
                Err(SpotifyError::NotPaired) => {}
                Err(error) => {
                    service.inner.runtime.lock().await.state = RuntimeState::Error {
                        message: error.safe_message().into(),
                    };
                }
            }
        }
        service
    }

    pub async fn status(&self) -> SpotifyStatus {
        let settings = self.inner.settings.read().await.clone();
        let runtime = self.inner.runtime.lock().await;
        let (state, username, engine_ready, pairing_expires_at, last_error) = if !settings.enabled
            || !settings.experimental_acknowledged
        {
            (SpotifyState::Disabled, None, false, None, None)
        } else {
            match &runtime.state {
                RuntimeState::SignedOut => (SpotifyState::NotConfigured, None, false, None, None),
                RuntimeState::Pairing { expires_at } => {
                    (SpotifyState::Pairing, None, false, Some(*expires_at), None)
                }
                RuntimeState::Ready { username } => (
                    SpotifyState::Ready,
                    username.clone(),
                    runtime
                        .session
                        .as_ref()
                        .is_some_and(|session| !session.is_invalid()),
                    None,
                    runtime.reconnect_error.clone(),
                ),
                RuntimeState::Error { message } => (
                    SpotifyState::Error,
                    None,
                    false,
                    None,
                    Some(message.clone()),
                ),
            }
        };
        SpotifyStatus {
            enabled: settings.enabled,
            experimental_acknowledged: settings.experimental_acknowledged,
            state,
            device_name: settings.device_name,
            username,
            engine_ready,
            pairing_expires_at,
            last_error,
        }
    }

    pub async fn apply_settings(&self, settings: SpotifyConfig) -> Result<(), SpotifyError> {
        settings
            .validate()
            .map_err(|_| SpotifyError::InvalidRequest("invalid Spotify settings"))?;
        if *self.inner.settings.read().await == settings {
            return Ok(());
        }
        let generation = self.inner.lifecycle.begin_transition().await;
        let service = self.clone();
        await_owned_transition(self.inner.lifecycle.clone(), generation, async move {
            service
                .apply_settings_in_transition(settings, generation)
                .await
        })
        .await
    }

    pub async fn start_pairing(&self) -> Result<(), SpotifyError> {
        let generation = self
            .inner
            .lifecycle
            .begin_pairing_transition()
            .await
            .map_err(|_| SpotifyError::Pairing)?;
        let service = self.clone();
        await_owned_transition(self.inner.lifecycle.clone(), generation, async move {
            service.start_pairing_in_transition(generation).await
        })
        .await
    }

    pub async fn cancel_pairing(&self) {
        let generation = self.inner.lifecycle.begin_transition().await;
        let service = self.clone();
        let _ = await_owned_transition(self.inner.lifecycle.clone(), generation, async move {
            service.cancel_pairing_in_transition(generation, true).await;
            Ok(())
        })
        .await;
    }

    pub async fn disconnect(&self) -> Result<(), SpotifyError> {
        let generation = self.inner.lifecycle.begin_transition().await;
        let service = self.clone();
        await_owned_transition(self.inner.lifecycle.clone(), generation, async move {
            service.disconnect_in_transition(generation).await
        })
        .await
    }

    pub async fn query(
        &self,
        request: SpotifyQueryRequest,
    ) -> Result<SpotifyQueryResponse, SpotifyError> {
        request.validate().map_err(SpotifyError::InvalidRequest)?;
        self.require_enabled().await?;

        // Ranking provenance is recorded AT the branch that chooses, never
        // inferred afterwards from the tracks themselves. Everything outside
        // the artist branch is a sequence the caller asked for, so it makes no
        // ranking claim at all.
        let mut ranking = SpotifyRankingProvenance::NotRanked;
        let items = if request.kind == "favorites" {
            self.saved_tracks(request.limit).await?
        } else if uses_personal_top_tracks(&request.kind) {
            // Current public Web API access does not expose Spotify's editorial
            // Featured queue to this private hardware client. The authenticated
            // user's top tracks are the strongest supported stock-style
            // equivalent until extended access or a hardware partnership
            // supplies that editorial surface. Stock `top_hits`, by contrast,
            // is a Tidal search-result query and must continue through search.
            self.top_tracks(request.limit).await?
        } else if request.kind == "artist" {
            let artist_name = request.primary.as_deref().unwrap_or_default().trim();
            // Deterministic guard shared by both branches: the backoff fallback
            // must reject a degenerate name exactly like the primary lookup.
            if artist_name.is_empty() || artist_name.len() > types::MAX_QUERY_BYTES {
                return Err(SpotifyError::InvalidRequest("invalid artist name"));
            }
            if self.artist_top_tracks_backoff_active(Instant::now()) {
                // The whole backoff window is degraded, not just the request
                // that opened it. Only the opening failure used to log, so
                // every later artist query in the window looked identical to a
                // genuine top-tracks result after the fact.
                ranking = SpotifyRankingProvenance::SearchRelevanceFallback;
                let tracks = self
                    .search_tracks(
                        &artist_top_tracks_fallback_query(artist_name),
                        request.limit,
                    )
                    .await?;
                log_degraded_artist_ranking("backoff_window_open", &tracks);
                tracks
            } else {
                match self
                    .artist_top_tracks_by_search(artist_name, request.limit)
                    .await
                {
                    Ok(tracks) => {
                        self.set_artist_top_tracks_backoff(None);
                        ranking = SpotifyRankingProvenance::ProviderTopTracks;
                        tracks
                    }
                    Err(error) if artist_top_tracks_needs_search_fallback(&error) => {
                        self.set_artist_top_tracks_backoff(Some(
                            Instant::now() + ARTIST_TOP_TRACKS_BACKOFF,
                        ));
                        ranking = SpotifyRankingProvenance::SearchRelevanceFallback;
                        warn!(
                            "Spotify artist top-tracks lookup unavailable; using ranked track search"
                        );
                        let tracks = self
                            .search_tracks(
                                &artist_top_tracks_fallback_query(artist_name),
                                request.limit,
                            )
                            .await?;
                        log_degraded_artist_ranking("top_tracks_unavailable", &tracks);
                        tracks
                    }
                    Err(error) => return Err(error),
                }
            }
        } else if request.kind == "playlist" {
            self.playlist_tracks(
                request.primary.as_deref().unwrap_or_default(),
                request.limit,
            )
            .await?
        } else if request.kind == "album" || request.kind == "album_artist" {
            self.album_tracks_by_search(
                request.primary.as_deref().unwrap_or_default(),
                request.secondary.as_deref(),
                request.limit,
            )
            .await?
        } else if request.kind == "album_id" {
            self.album_tracks_by_id(
                request.primary.as_deref().unwrap_or_default(),
                request.limit,
            )
            .await?
        } else if request.kind == "ids" || !request.ids.is_empty() {
            self.tracks_by_ids(&request.ids, request.limit).await?
        } else if request.kind == "radio" || request.kind == "recommendations" {
            // Spotify's private station responses are not a stable public
            // schema. Keep the deterministic search fallback until a response
            // can be parsed without guessing at arbitrary JSON fields.
            let cached = request
                .primary
                .as_deref()
                .and_then(|id| self.cached_track(id));
            let query = radio_fallback_query(
                cached.as_ref(),
                request.secondary.as_deref(),
                request.primary.as_deref(),
            );
            self.search_tracks(&query, request.limit).await?
        } else {
            let query = build_search_query(&request);
            self.search_tracks(&query, request.limit).await?
        };
        self.cache_tracks(&items).await;
        Ok(SpotifyQueryResponse {
            items,
            collection_name: request.primary.clone(),
            is_user_playlist: request.kind == "favorites",
            ranking_provenance: ranking,
        })
    }

    pub async fn playback(
        &self,
        request: SpotifyPlaybackRequest,
    ) -> Result<SpotifyPlaybackResponse, SpotifyError> {
        request.validate().map_err(SpotifyError::InvalidRequest)?;
        self.require_enabled().await?;

        // The stock HTTP/Binder caller can disappear while a track is loading.
        // Keep ownership detached so cancellation cannot strand a staged sink or
        // release the serialization gate before the Player reaches a terminal
        // load event.
        let service = self.clone();
        let (completed, completion) = oneshot::channel();
        tokio::spawn(async move {
            let attempted = AssertUnwindSafe(service.playback_owned(request))
                .catch_unwind()
                .await;
            let result = match attempted {
                Ok(result) => result,
                Err(_) => {
                    warn!("Spotify playback worker panicked");
                    // A detached task must never guess which runtime it owns.
                    // Normal failures carry an exact PlaybackLease and clean up
                    // conditionally; a panic returns unavailable without
                    // overwriting a concurrent disable/disconnect generation.
                    Err(SpotifyError::Unavailable)
                }
            };
            let _ = completed.send(result);
        });
        completion.await.unwrap_or(Err(SpotifyError::Unavailable))
    }

    async fn playback_owned(
        &self,
        request: SpotifyPlaybackRequest,
    ) -> Result<SpotifyPlaybackResponse, SpotifyError> {
        let _playback = self.inner.playback_gate.lock().await;
        self.require_enabled().await?;
        let session = self.session().await?;
        let lease = self.capture_playback_lease(&session).await?;
        let uri = SpotifyUri::from_uri(&format!("spotify:track:{}", request.id))
            .map_err(|_| SpotifyError::InvalidRequest("invalid track identifier"))?;
        let ticket = random_ticket()?;
        // Prefer the catalog's own duration over the caller-supplied one. The
        // WAV's declared length — and therefore the response Content-Length the
        // stock player commits to — is derived from this number, so a caller
        // that rounded or guessed would make the player either cut the tail off
        // or sit waiting on bytes that never arrive. `runtime.tracks` holds the
        // same metadata the catalog served, so it is the better source; the
        // request value stays as the fallback for an uncached id.
        let cached_track = {
            let runtime = self.inner.runtime.lock().await;
            runtime.tracks.get(&request.id).cloned()
        };
        let duration_ms = cached_track
            .as_ref()
            .map(|track| track.duration_ms)
            .unwrap_or(request.duration_ms);
        let buffer = PlaybackBuffer::create(&self.inner.cache_dir, ticket.clone(), duration_ms)
            .map_err(|_| SpotifyError::Unavailable)?;
        // Record which formats Spotify offers for the track we are about to
        // play. This lives here, not in catalog hydration, because the planner
        // resolves "play X" through the Web API and never touches librespot
        // metadata — so the hydration-side probe only ever fires for album and
        // playlist loads. Detached, so the extra metadata round-trip adds no
        // latency to a play the user is waiting on.
        {
            let session_for_formats = session.clone();
            let uri_for_formats = uri.clone();
            tokio::spawn(async move {
                if let Ok(track) = Track::get(&session_for_formats, &uri_for_formats).await {
                    log_available_audio_formats(&track.files);
                }
            });
        }

        let (player, sink_controller, lease) = self.reusable_player(session, lease).await?;
        let route_generation = match sink_controller.stage(buffer.clone()) {
            Ok(generation) => generation,
            Err(_) => {
                self.invalidate_playback_runtime_if_current(&lease, &player, &sink_controller)
                    .await;
                stop_stale_player(player);
                return Err(SpotifyError::Unavailable);
            }
        };
        let mut attempt_guard =
            PlaybackAttemptGuard::new(sink_controller.clone(), route_generation, buffer.clone());
        let activity_id = match cached_track {
            Some(track) => self
                .inner
                .db
                .start_music_activity(&track.id, &track.title, &track.artists, Some(&track.album))
                .await
                .ok(),
            None => self
                .inner
                .db
                .start_music_activity(&request.id, "Unknown track", &[], None)
                .await
                .ok(),
        };
        if let Some(activity_id) = activity_id {
            buffer
                .attach_activity(self.inner.db.clone(), activity_id)
                .await;
        }

        let mut events = player.get_player_event_channel();
        let (old_buffer, old_watcher) = match self
            .take_previous_playback_if_current(&lease, &player, &sink_controller)
            .await
        {
            Ok(previous) => previous,
            Err(error) => {
                sink_controller.cancel(route_generation);
                buffer.finish(true);
                buffer.fail_activity().await;
                stop_stale_player(player);
                attempt_guard.disarm();
                return Err(error);
            }
        };
        if let Some(old_watcher) = old_watcher {
            old_watcher.abort();
        }
        if let Some(old_buffer) = old_buffer {
            old_buffer.finish(true);
            old_buffer.interrupt_activity().await;
        }
        player.load(uri, true, 0);

        let play_request_id = match await_player_load(&mut events, PLAYER_LOAD_TIMEOUT).await {
            Ok(play_request_id) if sink_controller.is_active(route_generation) => play_request_id,
            Ok(_) => {
                sink_controller.cancel(route_generation);
                buffer.finish(true);
                buffer.fail_activity().await;
                self.invalidate_playback_runtime_if_current(&lease, &player, &sink_controller)
                    .await;
                stop_stale_player(player);
                attempt_guard.disarm();
                return Err(SpotifyError::Unavailable);
            }
            Err(failure) => {
                sink_controller.cancel(route_generation);
                buffer.finish(true);
                buffer.fail_activity().await;
                if failure.invalidates_player() {
                    self.invalidate_playback_runtime_if_current(&lease, &player, &sink_controller)
                        .await;
                    stop_stale_player(player);
                } else if !self
                    .playback_owner_is_current(&lease, &player, &sink_controller)
                    .await
                {
                    // Teardown may win after take_previous_playback_if_current
                    // but before player.load. The stale load can run only on
                    // this detached Arc; it cannot publish across the epoch,
                    // and its final drop must not join the Player thread on a
                    // Tokio worker.
                    stop_stale_player(player);
                } else {
                    // Keep the reusable runtime owner alive, but never risk
                    // becoming the final Arc drop on this async worker if a
                    // teardown races immediately after the identity check.
                    drop_player_off_thread(player);
                }
                attempt_guard.disarm();
                return Err(SpotifyError::Unavailable);
            }
        };

        let event_buffer = buffer.clone();
        let watcher = tokio::spawn(async move {
            watch_player_terminal(events, play_request_id, event_buffer).await;
        });
        let pending = PendingPlaybackPublication {
            ticket: ticket.clone(),
            buffer: buffer.clone(),
            watcher,
        };
        let publication = {
            let settings = self.inner.settings.read().await;
            let mut runtime = self.inner.runtime.lock().await;
            publish_playback_if_current(
                &mut runtime,
                &settings,
                &lease,
                &player,
                &sink_controller,
                pending,
            )
        };
        if let Err(pending) = publication {
            pending.watcher.abort();
            sink_controller.cancel(route_generation);
            pending.buffer.finish(true);
            pending.buffer.fail_activity().await;
            stop_stale_player(player);
            attempt_guard.disarm();
            return Err(self.stale_operation_error().await);
        }

        // Runtime owns the published Player. Release this request's clone on a
        // blocking thread so a teardown racing the HTTP response can never make
        // Player::drop join its private thread on a Tokio worker.
        drop_player_off_thread(player);
        attempt_guard.disarm();

        // Accumulate a short head start before handing over the URL. The stock
        // player parks its loader at our write head for the whole track and
        // treats an 8 s silent read as fatal, so opening with slack is what
        // keeps a slow CDN from killing the track outright. Bounded, so a slow
        // start is delayed rather than refused.
        buffer
            .await_preroll(PLAYBACK_PREROLL_PCM_BYTES, PLAYBACK_PREROLL_DEADLINE)
            .await;

        Ok(SpotifyPlaybackResponse {
            url: format!(
                "{}/internal/spotify/stream/{}",
                self.inner.stream_origin, ticket
            ),
        })
    }

    async fn reusable_player(
        &self,
        mut session: Session,
        mut lease: PlaybackLease,
    ) -> Result<(Arc<Player>, SwitchableWavSinkController, PlaybackLease), SpotifyError> {
        loop {
            let inspected = {
                let settings = self.inner.settings.read().await;
                let runtime = self.inner.runtime.lock().await;
                if let Some(error) = spotify_playback_gate_error(&settings) {
                    Err(error)
                } else if !runtime_matches_playback_lease(&runtime, &lease) {
                    Err(SpotifyError::Unavailable)
                } else {
                    Ok(
                        match (runtime.player.as_ref(), runtime.sink_controller.as_ref()) {
                            (Some(player), Some(controller)) if !player.is_invalid() => {
                                (Some((player.clone(), controller.clone())), false)
                            }
                            (None, None) => (None, false),
                            // The Player and its sink controller are one lifetime
                            // unit. An invalid Player or partial pair means the
                            // Session may retain dispatchers owned by a dead
                            // Player runtime.
                            _ => (None, true),
                        },
                    )
                }
            };
            let (existing, runtime_is_broken) = inspected?;
            if let Some((player, controller)) = existing {
                return Ok((player, controller, lease));
            }
            if runtime_is_broken {
                // Repair only the exact generation inspected above. If a
                // concurrent teardown already won, do not touch its state.
                if !self.invalidate_playback_lease_if_current(&lease).await {
                    return Err(self.stale_operation_error().await);
                }
                session = self.session().await?;
                lease = self.capture_playback_lease(&session).await?;
                continue;
            }

            let controller = SwitchableWavSinkController::new();
            let player_controller = controller.clone();
            let player_config = pin_speaker_player_config();
            let player = Player::new(
                player_config,
                session.clone(),
                Box::new(NoOpVolume),
                move || Box::new(player_controller.sink()),
            );
            let installed = {
                let settings = self.inner.settings.read().await;
                let mut runtime = self.inner.runtime.lock().await;
                install_player_if_current(&mut runtime, &settings, &lease, &player, &controller)
            };
            if installed {
                return Ok((player, controller, lease));
            }
            stop_stale_player(player);
            return Err(self.stale_operation_error().await);
        }
    }

    async fn capture_playback_lease(
        &self,
        session: &Session,
    ) -> Result<PlaybackLease, SpotifyError> {
        let settings = self.inner.settings.read().await;
        if let Some(error) = spotify_playback_gate_error(&settings) {
            return Err(error);
        }
        let runtime = self.inner.runtime.lock().await;
        let lease = PlaybackLease {
            epoch: runtime.playback_epoch,
            session_id: session.session_id(),
        };
        if runtime_matches_playback_lease(&runtime, &lease) {
            Ok(lease)
        } else {
            Err(SpotifyError::Unavailable)
        }
    }

    async fn take_previous_playback_if_current(
        &self,
        lease: &PlaybackLease,
        player: &Arc<Player>,
        controller: &SwitchableWavSinkController,
    ) -> Result<
        (
            Option<Arc<PlaybackBuffer>>,
            Option<tokio::task::JoinHandle<()>>,
        ),
        SpotifyError,
    > {
        let settings = self.inner.settings.read().await;
        if let Some(error) = spotify_playback_gate_error(&settings) {
            return Err(error);
        }
        let mut runtime = self.inner.runtime.lock().await;
        if !runtime_matches_playback_owner(&runtime, lease, player, controller) {
            return Err(SpotifyError::Unavailable);
        }
        Ok((
            runtime.active_buffer.take(),
            runtime.playback_watcher.take(),
        ))
    }

    async fn playback_owner_is_current(
        &self,
        lease: &PlaybackLease,
        player: &Arc<Player>,
        controller: &SwitchableWavSinkController,
    ) -> bool {
        let settings = self.inner.settings.read().await;
        if !spotify_playback_enabled(&settings) {
            return false;
        }
        let runtime = self.inner.runtime.lock().await;
        runtime_matches_playback_owner(&runtime, lease, player, controller)
    }

    async fn invalidate_playback_lease_if_current(&self, lease: &PlaybackLease) -> bool {
        let resources = {
            let settings = self.inner.settings.read().await;
            if !spotify_playback_enabled(&settings) {
                return false;
            }
            let mut runtime = self.inner.runtime.lock().await;
            if !runtime_matches_playback_lease(&runtime, lease) {
                return false;
            }
            let username = match &runtime.state {
                RuntimeState::Ready { username } => username.clone(),
                _ => return false,
            };
            take_runtime_resources(&mut runtime, RuntimeState::Ready { username }, false)
        };
        Self::shutdown_runtime_resources(resources).await;
        true
    }

    async fn invalidate_playback_runtime_if_current(
        &self,
        lease: &PlaybackLease,
        player: &Arc<Player>,
        controller: &SwitchableWavSinkController,
    ) -> bool {
        let resources = {
            let settings = self.inner.settings.read().await;
            if !spotify_playback_enabled(&settings) {
                return false;
            }
            let mut runtime = self.inner.runtime.lock().await;
            if !runtime_matches_playback_owner(&runtime, lease, player, controller) {
                return false;
            }
            let username = match &runtime.state {
                RuntimeState::Ready { username } => username.clone(),
                _ => return false,
            };
            take_runtime_resources(&mut runtime, RuntimeState::Ready { username }, false)
        };
        Self::shutdown_runtime_resources(resources).await;
        true
    }

    pub async fn save(
        &self,
        request: SpotifySaveRequest,
    ) -> Result<SpotifySaveResponse, SpotifyError> {
        request.validate().map_err(SpotifyError::InvalidRequest)?;
        self.require_enabled().await?;
        let session = self.session().await?;
        let token = session
            .token_provider()
            .get_token(LIBRARY_WRITE_SCOPE)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let response = self
            .send_api(
                self.inner
                    .http
                    .put(format!("{SPOTIFY_API}/me/library"))
                    .bearer_auth(token.access_token)
                    .query(&[("uris", format!("spotify:track:{}", request.id))]),
            )
            .await?;
        classify_response(response.status())?;
        Ok(SpotifySaveResponse { ok: true })
    }

    pub async fn playback_buffer(&self, ticket: &str) -> Option<Arc<PlaybackBuffer>> {
        if ticket.len() != 43
            || !ticket
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return None;
        }
        let mut runtime = self.inner.runtime.lock().await;
        let buffer = runtime.buffers.get(ticket).cloned()?;
        if buffer.has_failed() {
            // A failed buffer will never produce another byte. Handing it to the
            // route makes the stock player commit to a Content-Length that can
            // never be satisfied, so the track dies mid-body instead of failing
            // cleanly. Report it as absent — a 404 is the honest answer — and
            // drop it here, since nothing can revive it.
            runtime.buffers.remove(ticket);
            return None;
        }
        Some(buffer)
    }

    /// Audio-path diagnostics for one track, **without playing it**.
    ///
    /// Both numbers the speaker teardown left open are derivable from metadata:
    /// the format map from the track's file list, and the loudness gain from
    /// Spotify's normalisation header, which sits at a fixed offset in the
    /// decrypted audio file ahead of the Ogg stream. Nothing is decoded, no
    /// sink is opened and no audio is produced — which matters because the only
    /// other way to obtain these is to actually play a track out loud.
    pub async fn track_audio_diagnostics(
        &self,
        id: &str,
    ) -> Result<SpotifyTrackAudioDiagnostics, SpotifyError> {
        self.require_enabled().await?;
        let session = self.session().await?;
        let uri = SpotifyUri::from_uri(&format!("spotify:track:{id}"))
            .map_err(|_| SpotifyError::InvalidRequest("invalid track identifier"))?;
        let SpotifyUri::Track { id: track_id } = uri else {
            return Err(SpotifyError::InvalidRequest("not a track identifier"));
        };
        let track = Track::get(&session, &uri)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;

        let mut formats: Vec<String> = track
            .files
            .keys()
            .map(|format| format!("{format:?}"))
            .collect();
        formats.sort_unstable();
        // Narrower than `AudioFiles::is_mp3`, which also counts MP3_160_ENC —
        // librespot never selects that and it is not a plain MP3 stream.
        let dsp_offloadable = track.files.keys().any(|format| {
            matches!(
                format,
                AudioFileFormat::MP3_320
                    | AudioFileFormat::MP3_256
                    | AudioFileFormat::MP3_160
                    | AudioFileFormat::MP3_96
            )
        });

        let mut diagnostics = SpotifyTrackAudioDiagnostics {
            formats,
            dsp_offloadable,
            normalisation_source_format: None,
            track_gain_db: None,
            track_peak: None,
            album_gain_db: None,
            album_peak: None,
            applied_gain_db: None,
            applied_factor_percent: None,
        };

        // The normalisation block lives in the custom header of the Ogg
        // variants; MP3 files carry no such header (which is exactly why MP3
        // passthrough would forfeit levelling).
        let source = [
            AudioFileFormat::OGG_VORBIS_320,
            AudioFileFormat::OGG_VORBIS_160,
            AudioFileFormat::OGG_VORBIS_96,
        ]
        .into_iter()
        .find_map(|format| track.files.get(&format).map(|file| (format, *file)));
        let Some((format, file_id)) = source else {
            return Ok(diagnostics);
        };
        diagnostics.normalisation_source_format = Some(format!("{format:?}"));

        let key = session.audio_key().request(track_id, file_id).await.ok();
        let file = AudioFile::open(&session, file_id, 40 * 1024)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;

        // `Read`/`Seek` here are blocking, so keep them off the async workers.
        let header = tokio::task::spawn_blocking(move || {
            use std::io::{Read as _, Seek as _};
            let mut decrypted = AudioDecrypt::new(key, file);
            decrypted.seek(std::io::SeekFrom::Start(SPOTIFY_NORMALISATION_OFFSET))?;
            let mut buf = [0u8; SPOTIFY_NORMALISATION_BYTES];
            decrypted.read_exact(&mut buf)?;
            Ok::<_, std::io::Error>(buf)
        })
        .await
        .map_err(|_| SpotifyError::Unavailable)?
        .map_err(|_| SpotifyError::Unavailable)?;

        let field = |offset: usize| {
            f32::from_le_bytes([
                header[offset],
                header[offset + 1],
                header[offset + 2],
                header[offset + 3],
            ]) as f64
        };
        let track_gain_db = field(0);
        let album_gain_db = field(8);
        diagnostics.track_gain_db = Some(track_gain_db);
        diagnostics.track_peak = Some(field(4));
        diagnostics.album_gain_db = Some(album_gain_db);
        diagnostics.album_peak = Some(field(12));

        // Mirror the configured player exactly. With the Dynamic method the
        // factor is just gain + pregain; the limiter handles peaks, so there is
        // no clamp to fold in here.
        let config = pin_speaker_player_config();
        if config.normalisation {
            let gain_db = if config.normalisation_type == NormalisationType::Album {
                album_gain_db
            } else {
                track_gain_db
            };
            let applied = gain_db + config.normalisation_pregain_db;
            diagnostics.applied_gain_db = Some(applied);
            diagnostics.applied_factor_percent = Some(10f64.powf(applied / 20.0) * 100.0);
        } else {
            diagnostics.applied_gain_db = Some(0.0);
            diagnostics.applied_factor_percent = Some(100.0);
        }

        Ok(diagnostics)
    }

    async fn apply_settings_in_transition(
        &self,
        settings: SpotifyConfig,
        generation: u64,
    ) -> Result<(), SpotifyError> {
        *self.inner.settings.write().await = settings.clone();
        let pairing_was_active = self.cancel_pairing_task().await;
        self.finish_pairing_cancelled_if_current(generation).await;

        if !settings.enabled || !settings.experimental_acknowledged {
            // Disabling stops playback and the live connection. A credential
            // whose pairing completed before this transition remains vaulted
            // so re-enabling can restore it.
            self.stop_runtime(RuntimeState::SignedOut).await;
            return Ok(());
        }

        let session_ready = self
            .inner
            .runtime
            .lock()
            .await
            .session
            .as_ref()
            .is_some_and(|session| !session.is_invalid());
        if session_ready {
            return Ok(());
        }

        // A settings change invalidates an in-flight pairing. Do not silently
        // launch a second discovery task; the user can restart pairing with the
        // newly selected device name. A fully persisted credential, however,
        // is safe to restore under this transition's generation.
        if pairing_was_active {
            return Ok(());
        }
        if let Ok(stored) = load_auth(&self.inner.auth_path) {
            self.connect_saved(stored, generation).await?;
        }
        Ok(())
    }

    async fn start_pairing_in_transition(&self, generation: u64) -> Result<(), SpotifyError> {
        self.require_enabled().await?;
        {
            let runtime = self.inner.runtime.lock().await;
            if matches!(runtime.state, RuntimeState::Pairing { .. }) {
                return Err(SpotifyError::Pairing);
            }
            if runtime
                .session
                .as_ref()
                .is_some_and(|session| !session.is_invalid())
            {
                return Err(SpotifyError::AlreadyPaired);
            }
        }
        match load_auth(&self.inner.auth_path) {
            Ok(_) => return Err(SpotifyError::AlreadyPaired),
            Err(SpotifyError::NotPaired) => {}
            Err(error) => return Err(error),
        }

        let expires_at = chrono::Utc::now().timestamp() + PAIRING_LIFETIME.as_secs() as i64;
        self.inner.runtime.lock().await.state = RuntimeState::Pairing { expires_at };
        let service = self.clone();
        let (cancel, cancel_rx) = watch::channel(false);
        let (launch, launched) = oneshot::channel();
        let handle = tokio::spawn(async move {
            if launched.await.is_err() {
                return;
            }
            let result = service.run_pairing(cancel_rx, generation).await;
            service.finish_pairing_run(generation, result).await;
        });
        let task = PairingTask {
            generation,
            cancel,
            handle,
        };
        let installed = {
            let mut lifecycle = self.inner.lifecycle.state.lock().await;
            install_pairing_task(&mut lifecycle, task)
        };
        if let Err(task) = installed {
            task.handle.abort();
            self.finish_pairing_cancelled_if_current(generation).await;
            return Err(SpotifyError::Pairing);
        }
        if launch.send(()).is_err() {
            let task = {
                let mut lifecycle = self.inner.lifecycle.state.lock().await;
                lifecycle.pairing_task.take()
            };
            if let Some(task) = task {
                task.handle.abort();
            }
            self.finish_pairing_cancelled_if_current(generation).await;
            return Err(SpotifyError::Unavailable);
        }
        Ok(())
    }

    async fn cancel_pairing_task(&self) -> bool {
        let task = self.inner.lifecycle.state.lock().await.pairing_task.take();
        let Some(task) = task else {
            return false;
        };
        task.cancel.send_replace(true);
        let _ = task.handle.await;
        true
    }

    async fn cancel_pairing_in_transition(&self, generation: u64, remove_published: bool) {
        let pairing_was_active = self.cancel_pairing_task().await;
        let published_during_cancel = pairing_was_active && {
            let runtime = self.inner.runtime.lock().await;
            matches!(runtime.state, RuntimeState::Ready { .. }) && runtime.session.is_some()
        };
        if remove_published && published_during_cancel {
            let cleanup = self.remove_auth_durably().await;
            let state = match cleanup {
                Ok(()) => RuntimeState::SignedOut,
                Err(error) => RuntimeState::Error {
                    message: error.safe_message().into(),
                },
            };
            self.stop_runtime(state).await;
        } else {
            self.finish_pairing_cancelled_if_current(generation).await;
        }
    }

    async fn disconnect_in_transition(&self, generation: u64) -> Result<(), SpotifyError> {
        self.cancel_pairing_task().await;
        self.finish_pairing_cancelled_if_current(generation).await;
        // Keep an established live session until the vault confirms deletion.
        // Reporting signed-out before that point can resurrect an older
        // credential on the next boot.
        self.remove_auth_durably().await?;
        self.stop_runtime(RuntimeState::SignedOut).await;
        Ok(())
    }

    async fn run_pairing(
        &self,
        mut cancel: watch::Receiver<bool>,
        generation: u64,
    ) -> Result<(), PairingRunError> {
        if !self.operation_current_and_enabled(generation).await {
            return Err(PairingRunError::Cancelled);
        }
        let settings = self.inner.settings.read().await.clone();
        let session_config = SessionConfig {
            device_id: Uuid::new_v4().to_string(),
            tmp_dir: self.inner.cache_dir.clone(),
            ..SessionConfig::default()
        };
        let mut discovery = Discovery::builder(
            session_config.device_id.clone(),
            session_config.client_id.clone(),
        )
        .name(settings.device_name)
        .device_type(DeviceType::Speaker)
        .launch()
        .map_err(|_| SpotifyError::Unavailable)?;

        let discovered = tokio::select! {
            _ = wait_for_pairing_cancellation(&mut cancel) => {
                discovery.shutdown().await;
                return Err(PairingRunError::Cancelled);
            }
            result = tokio::time::timeout(PAIRING_LIFETIME, discovery.next()) => result,
        };
        discovery.shutdown().await;
        let credentials = discovered
            .map_err(|_| SpotifyError::Unavailable)?
            .ok_or(SpotifyError::Unavailable)?;
        let stored = StoredAuth {
            version: AUTH_VERSION,
            device_id: session_config.device_id,
            credentials,
        };

        validate_stored_auth(&stored)?;
        let config = SessionConfig {
            device_id: stored.device_id.clone(),
            tmp_dir: self.inner.cache_dir.clone(),
            ..SessionConfig::default()
        };
        let session = Session::new(config, None);
        let username = stored.credentials.username.clone();
        let connect_result = tokio::select! {
            _ = wait_for_pairing_cancellation(&mut cancel) => {
                session.shutdown();
                return Err(PairingRunError::Cancelled);
            }
            result = tokio::time::timeout(
                SESSION_CONNECT_TIMEOUT,
                session.connect(stored.credentials.clone(), false),
            ) => result,
        };
        if !connect_result.is_ok_and(|result| result.is_ok()) {
            session.shutdown();
            return Err(SpotifyError::Unavailable.into());
        }

        // The session stays private until both durable steps are confirmed.
        // Cancellation never aborts this block midway through a vault request;
        // it waits for a known result and then commits a compensating snapshot.
        let mut finalization = PairingFinalization::default();
        if pairing_cancelled(&cancel) || !self.operation_current_and_enabled(generation).await {
            session.shutdown();
            return Err(PairingRunError::Cancelled);
        }
        persist_auth(&self.inner.auth_path, &stored)?;
        finalization.local_auth_written = true;

        if pairing_cancelled(&cancel) || !self.operation_current_and_enabled(generation).await {
            session.shutdown();
            return match self.rollback_unpublished_auth(&stored).await {
                Ok(()) => Err(PairingRunError::Cancelled),
                Err(error) => Err(error.into()),
            };
        }

        let vault_commit = self
            .inner
            .persistence
            .commit_persistent_artifacts(VAULT_COMMIT_TIMEOUT)
            .await;
        if vault_commit.is_err() {
            session.shutdown();
            let _ = self.rollback_unpublished_auth(&stored).await;
            return Err(SpotifyError::Persistence.into());
        }
        finalization.vault_confirmed = true;

        let cancelled =
            pairing_cancelled(&cancel) || !self.operation_current_and_enabled(generation).await;
        if !finalization.can_publish(cancelled) {
            session.shutdown();
            return match self.rollback_unpublished_auth(&stored).await {
                Ok(()) if cancelled => Err(PairingRunError::Cancelled),
                Ok(()) => Err(SpotifyError::Persistence.into()),
                Err(error) => Err(error.into()),
            };
        }

        if !self
            .publish_session_if_current(generation, session, username)
            .await
        {
            return match self.rollback_unpublished_auth(&stored).await {
                Ok(()) => Err(PairingRunError::Cancelled),
                Err(error) => Err(error.into()),
            };
        }
        info!("Spotify pairing completed and credentials were vaulted");
        Ok(())
    }

    async fn connect_saved(&self, stored: StoredAuth, generation: u64) -> Result<(), SpotifyError> {
        validate_stored_auth(&stored)?;
        let config = SessionConfig {
            device_id: stored.device_id.clone(),
            tmp_dir: self.inner.cache_dir.clone(),
            ..SessionConfig::default()
        };
        let session = Session::new(config, None);
        let connected = tokio::time::timeout(
            SESSION_CONNECT_TIMEOUT,
            session.connect(stored.credentials.clone(), false),
        )
        .await
        .is_ok_and(|result| result.is_ok());
        if !connected {
            session.shutdown();
            return Err(SpotifyError::Unavailable);
        }
        let username = stored.credentials.username;
        if self
            .publish_session_if_current(generation, session, username)
            .await
        {
            Ok(())
        } else {
            Err(self.stale_operation_error().await)
        }
    }

    async fn operation_current_and_enabled(&self, generation: u64) -> bool {
        let lifecycle = self.inner.lifecycle.state.lock().await;
        let settings = self.inner.settings.read().await;
        publication_allowed(lifecycle.generation, generation, &settings)
    }

    async fn publish_session_if_current(
        &self,
        generation: u64,
        session: Session,
        username: Option<String>,
    ) -> bool {
        let mut pending = Some(session);
        let published = {
            let lifecycle = self.inner.lifecycle.state.lock().await;
            let settings = self.inner.settings.read().await;
            if !publication_allowed(lifecycle.generation, generation, &settings) {
                false
            } else {
                let mut runtime = self.inner.runtime.lock().await;
                if runtime
                    .session
                    .as_ref()
                    .is_some_and(|session| !session.is_invalid())
                {
                    false
                } else {
                    runtime.session = pending.take();
                    runtime.state = RuntimeState::Ready { username };
                    runtime.reconnect_failures = 0;
                    runtime.reconnect_not_before = None;
                    runtime.reconnect_error = None;
                    true
                }
            }
        };
        if let Some(session) = pending {
            session.shutdown();
        }
        published
    }

    async fn stale_operation_error(&self) -> SpotifyError {
        let settings = self.inner.settings.read().await;
        if !settings.enabled {
            SpotifyError::Disabled
        } else if !settings.experimental_acknowledged {
            SpotifyError::AcknowledgementRequired
        } else {
            SpotifyError::Unavailable
        }
    }

    async fn require_enabled(&self) -> Result<(), SpotifyError> {
        let settings = self.inner.settings.read().await;
        if !settings.enabled {
            return Err(SpotifyError::Disabled);
        }
        if !settings.experimental_acknowledged {
            return Err(SpotifyError::AcknowledgementRequired);
        }
        Ok(())
    }

    async fn session(&self) -> Result<Session, SpotifyError> {
        self.restore_saved_session().await
    }

    async fn restore_saved_session(&self) -> Result<Session, SpotifyError> {
        self.require_enabled().await?;
        loop {
            {
                let runtime = self.inner.runtime.lock().await;
                if let Some(session) = runtime
                    .session
                    .as_ref()
                    .filter(|session| !session.is_invalid())
                    .cloned()
                {
                    return Ok(session);
                }
                if !should_restore_saved_session(&runtime.state, false) {
                    return Err(SpotifyError::Pairing);
                }
                if !reconnect_is_due(runtime.reconnect_not_before, tokio::time::Instant::now()) {
                    return Err(SpotifyError::Unavailable);
                }
            }

            let changed = self.inner.lifecycle.changed.notified();
            let generation = match self
                .inner
                .lifecycle
                .try_begin_reconnect_transition()
                .await
                .map_err(|_| SpotifyError::Pairing)?
            {
                Some(generation) => generation,
                None => {
                    changed.await;
                    continue;
                }
            };
            // The reconnect worker owns the lifecycle generation, not this
            // request future. If the HTTP/gRPC client disconnects, the detached
            // worker still records the result and releases the transition.
            let service = self.clone();
            return await_owned_transition(self.inner.lifecycle.clone(), generation, async move {
                let result = service
                    .restore_saved_session_in_transition(generation)
                    .await;
                if let Err(error) = &result {
                    if reconnect_failure_needs_backoff(error) {
                        service
                            .record_reconnect_failure_if_current(generation, error.safe_message())
                            .await;
                    }
                }
                result
            })
            .await;
        }
    }

    async fn restore_saved_session_in_transition(
        &self,
        generation: u64,
    ) -> Result<Session, SpotifyError> {
        // Settings may have changed after the optimistic preflight but before
        // this reconnect generation was reserved. Never resurrect a disabled
        // runtime or undo its completed cleanup.
        if !self.operation_current_and_enabled(generation).await {
            return Err(self.stale_operation_error().await);
        }
        if let Some(session) = self
            .inner
            .runtime
            .lock()
            .await
            .session
            .as_ref()
            .filter(|session| !session.is_invalid())
            .cloned()
        {
            return Ok(session);
        }

        {
            let runtime = self.inner.runtime.lock().await;
            if !reconnect_is_due(runtime.reconnect_not_before, tokio::time::Instant::now()) {
                return Err(SpotifyError::Unavailable);
            }
        }

        let stored = load_auth(&self.inner.auth_path)?;
        let username = stored.credentials.username.clone();
        // The current player and buffers are bound to the invalid session.
        // Tear them down before publishing a replacement so no stale decoder
        // can write into a new stock playback request.
        self.stop_runtime_for_reconnect(RuntimeState::Ready { username })
            .await;
        self.connect_saved(stored, generation).await?;

        self.inner
            .runtime
            .lock()
            .await
            .session
            .as_ref()
            .filter(|session| !session.is_invalid())
            .cloned()
            .ok_or(SpotifyError::Unavailable)
    }

    async fn finish_pairing_run(&self, generation: u64, result: Result<(), PairingRunError>) {
        match result {
            Ok(()) => {}
            Err(PairingRunError::Cancelled) => {
                self.finish_pairing_cancelled_if_current(generation).await
            }
            Err(PairingRunError::Failed(error)) => {
                self.set_error_if_current(generation, error.safe_message())
                    .await
            }
        }
        let task = {
            let mut lifecycle = self.inner.lifecycle.state.lock().await;
            take_pairing_task_for_generation(&mut lifecycle, generation)
        };
        // Dropping this task's own JoinHandle simply detaches the already
        // finishing task; a newer generation's handle is never touched.
        drop(task);
    }

    async fn set_error_if_current(&self, generation: u64, message: &str) {
        let lifecycle = self.inner.lifecycle.state.lock().await;
        if lifecycle.generation != generation {
            return;
        }
        let mut runtime = self.inner.runtime.lock().await;
        if runtime.session.is_none() {
            runtime.state = RuntimeState::Error {
                message: message.into(),
            };
        }
    }

    async fn record_reconnect_failure_if_current(&self, generation: u64, message: &str) {
        let lifecycle = self.inner.lifecycle.state.lock().await;
        if lifecycle.generation != generation {
            return;
        }
        let mut runtime = self.inner.runtime.lock().await;
        runtime.reconnect_failures = runtime.reconnect_failures.saturating_add(1);
        runtime.reconnect_not_before =
            Some(tokio::time::Instant::now() + reconnect_backoff(runtime.reconnect_failures));
        runtime.reconnect_error = Some(message.into());
    }

    async fn finish_pairing_cancelled_if_current(&self, generation: u64) {
        let lifecycle = self.inner.lifecycle.state.lock().await;
        if lifecycle.generation != generation {
            return;
        }
        let mut runtime = self.inner.runtime.lock().await;
        if matches!(runtime.state, RuntimeState::Pairing { .. }) {
            runtime.state = RuntimeState::SignedOut;
        }
    }

    async fn stop_runtime(&self, state: RuntimeState) {
        self.stop_runtime_impl(state, true).await;
    }

    async fn stop_runtime_for_reconnect(&self, state: RuntimeState) {
        self.stop_runtime_impl(state, false).await;
    }

    async fn stop_runtime_impl(&self, state: RuntimeState, clear_tracks: bool) {
        let resources = {
            let mut runtime = self.inner.runtime.lock().await;
            take_runtime_resources(&mut runtime, state, clear_tracks)
        };
        Self::shutdown_runtime_resources(resources).await;
    }

    async fn shutdown_runtime_resources((player, active_buffer, session): RuntimeResources) {
        // Player destruction can block in librespot. Stop it explicitly, then
        // release every runtime lock before waiting for the blocking drop.
        let player_drop = player.map(|player| {
            player.stop();
            tokio::task::spawn_blocking(move || drop(player))
        });
        if let Some(active_buffer) = active_buffer {
            active_buffer.finish(true);
            active_buffer.interrupt_activity().await;
        }
        if let Some(session) = session {
            session.shutdown();
        }
        if let Some(player_drop) = player_drop {
            if tokio::time::timeout(PLAYER_DROP_TIMEOUT, player_drop)
                .await
                .is_err()
            {
                warn!("Spotify player shutdown exceeded the bounded wait");
            }
        }
    }

    async fn remove_auth_durably(&self) -> Result<(), SpotifyError> {
        let rollback = match load_auth(&self.inner.auth_path) {
            Ok(stored) => Some(stored),
            Err(SpotifyError::NotPaired) => None,
            Err(error) => return Err(error),
        };
        remove_auth(&self.inner.auth_path)?;
        if self
            .inner
            .persistence
            .commit_persistent_artifacts(VAULT_COMMIT_TIMEOUT)
            .await
            .is_err()
        {
            if let Some(stored) = rollback.as_ref() {
                persist_auth(&self.inner.auth_path, stored)?;
            }
            return Err(SpotifyError::Persistence);
        }
        Ok(())
    }

    async fn rollback_unpublished_auth(&self, stored: &StoredAuth) -> Result<(), SpotifyError> {
        remove_auth(&self.inner.auth_path)?;
        if self
            .inner
            .persistence
            .commit_persistent_artifacts(VAULT_COMMIT_TIMEOUT)
            .await
            .is_ok()
        {
            return Ok(());
        }

        // A lost acknowledgement can mean the credential snapshot did land.
        // Restore the same local source of truth instead of leaving an orphaned
        // credential that can unexpectedly reappear after a reboot.
        persist_auth(&self.inner.auth_path, stored)?;
        Err(SpotifyError::Persistence)
    }

    fn cached_track(&self, id: &str) -> Option<SpotifyTrack> {
        self.inner
            .runtime
            .try_lock()
            .ok()
            .and_then(|runtime| runtime.tracks.get(id).cloned())
    }

    async fn cache_tracks(&self, tracks: &[SpotifyTrack]) {
        let mut runtime = self.inner.runtime.lock().await;
        for track in tracks {
            runtime.tracks.insert(track.id.clone(), track.clone());
        }
        while runtime.tracks.len() > MAX_TRACK_CACHE {
            let Some(key) = runtime.tracks.keys().next().cloned() else {
                break;
            };
            runtime.tracks.remove(&key);
        }
    }

    async fn search_tracks(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        if query.is_empty() || query.len() > types::MAX_QUERY_BYTES {
            return Err(SpotifyError::InvalidRequest("invalid search query"));
        }
        let session = self.session().await?;
        let token = session
            .token_provider()
            .get_token(SEARCH_SCOPE)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let mut tracks = Vec::with_capacity(limit);
        let mut offset = 0usize;
        while tracks.len() < limit {
            let page_size = search_page_size(limit - tracks.len());
            let body = self
                .api_json(
                    self.inner
                        .http
                        .get(format!("{SPOTIFY_API}/search"))
                        .bearer_auth(&token.access_token)
                        .query(&[
                            ("q", query.to_string()),
                            ("type", "track".into()),
                            ("limit", page_size.to_string()),
                            ("offset", offset.to_string()),
                        ]),
                )
                .await?;
            let page = body.pointer("/tracks/items").and_then(Value::as_array);
            let raw_count = page.map_or(0, Vec::len);
            tracks.extend(
                page.into_iter()
                    .flatten()
                    .filter_map(parse_track)
                    .take(limit - tracks.len()),
            );
            let has_next = has_next_page(body.pointer("/tracks/next"));
            if raw_count == 0 && has_next {
                return Err(SpotifyError::Unavailable);
            }
            if !has_next {
                if tracks.len() < limit
                    && page_has_unseen_items(body.get("tracks"), offset + raw_count)
                {
                    return Err(SpotifyError::Unavailable);
                }
                break;
            }
            offset = offset.saturating_add(raw_count);
        }
        Ok(tracks)
    }

    async fn saved_tracks(&self, limit: usize) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let session = self.session().await?;
        let token = session
            .token_provider()
            .get_token(LIBRARY_READ_SCOPE)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let mut tracks = Vec::with_capacity(limit);
        let mut offset = 0usize;
        while tracks.len() < limit {
            let page_size = API_PAGE_SIZE.min(limit - tracks.len());
            let body = self
                .api_json(
                    self.inner
                        .http
                        .get(format!("{SPOTIFY_API}/me/tracks"))
                        .bearer_auth(&token.access_token)
                        .query(&[("limit", page_size), ("offset", offset)]),
                )
                .await?;
            let page = body.get("items").and_then(Value::as_array);
            let raw_count = page.map_or(0, Vec::len);
            tracks.extend(
                page.into_iter()
                    .flatten()
                    .filter_map(|item| parse_track(item.get("track")?))
                    .take(limit - tracks.len()),
            );
            let has_next = has_next_page(body.get("next"));
            if raw_count == 0 && has_next {
                return Err(SpotifyError::Unavailable);
            }
            if !has_next {
                if tracks.len() < limit && page_has_unseen_items(Some(&body), offset + raw_count) {
                    return Err(SpotifyError::Unavailable);
                }
                break;
            }
            offset = offset.saturating_add(raw_count);
        }
        Ok(tracks)
    }

    fn artist_top_tracks_backoff_active(&self, now: Instant) -> bool {
        let until = self
            .inner
            .artist_top_tracks_backoff_until
            .lock()
            .map(|guard| *guard)
            .unwrap_or(None);
        artist_top_tracks_backoff_is_active(until, now)
    }

    fn set_artist_top_tracks_backoff(&self, until: Option<Instant>) {
        if let Ok(mut guard) = self.inner.artist_top_tracks_backoff_until.lock() {
            *guard = until;
        }
    }

    /// Resolve an exact artist result, then use Spotify's artist top-tracks
    /// endpoint. This restores stock `PlayMusic(Artist)` semantics more
    /// faithfully than a generic track search for `artist:<name>`.
    async fn artist_top_tracks_by_search(
        &self,
        artist_name: &str,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let artist_name = artist_name.trim();
        if artist_name.is_empty() || artist_name.len() > types::MAX_QUERY_BYTES {
            return Err(SpotifyError::InvalidRequest("invalid artist name"));
        }
        let session = self.session().await?;
        let token = session
            .token_provider()
            .get_token(SEARCH_SCOPE)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let search = self
            .api_json(
                self.inner
                    .http
                    .get(format!("{SPOTIFY_API}/search"))
                    .bearer_auth(&token.access_token)
                    .query(&[
                        ("q", format!("artist:{artist_name}")),
                        ("type", "artist".into()),
                        ("limit", "10".into()),
                    ]),
            )
            .await?;
        let artist_id = select_artist_id(search.pointer("/artists/items"), artist_name)
            .ok_or(SpotifyError::Unavailable)?;
        let body = self
            .api_json(
                self.inner
                    .http
                    .get(format!("{SPOTIFY_API}/artists/{artist_id}/top-tracks"))
                    .bearer_auth(&token.access_token)
                    .query(&[("market", "from_token")]),
            )
            .await?;
        let tracks = parse_track_array_unbounded(body.get("tracks"), limit);
        if tracks.is_empty() {
            return Err(SpotifyError::Unavailable);
        }
        Ok(tracks)
    }

    async fn top_tracks(&self, limit: usize) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let session = self.session().await?;
        let token = session
            .token_provider()
            .get_token(TOP_ITEMS_SCOPE)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let mut tracks = Vec::with_capacity(limit);
        let mut offset = 0usize;
        while tracks.len() < limit {
            let page_size = API_PAGE_SIZE.min(limit - tracks.len());
            let body = self
                .api_json(
                    self.inner
                        .http
                        .get(format!("{SPOTIFY_API}/me/top/tracks"))
                        .bearer_auth(&token.access_token)
                        .query(&[
                            ("limit", page_size.to_string()),
                            ("offset", offset.to_string()),
                            ("time_range", "medium_term".into()),
                        ]),
                )
                .await?;
            let page = body.get("items").and_then(Value::as_array);
            let raw_count = page.map_or(0, Vec::len);
            tracks.extend(
                page.into_iter()
                    .flatten()
                    .filter_map(parse_track)
                    .take(limit - tracks.len()),
            );
            let has_next = has_next_page(body.get("next"));
            if raw_count == 0 && has_next {
                return Err(SpotifyError::Unavailable);
            }
            if !has_next {
                if tracks.len() < limit && page_has_unseen_items(Some(&body), offset + raw_count) {
                    return Err(SpotifyError::Unavailable);
                }
                break;
            }
            offset = offset.saturating_add(raw_count);
        }
        Ok(tracks)
    }

    async fn playlist_tracks(
        &self,
        name: &str,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        if name.is_empty() || name.len() > types::MAX_QUERY_BYTES {
            return Err(SpotifyError::InvalidRequest("invalid playlist name"));
        }
        let session = self.session().await?;
        let token = session
            .token_provider()
            .get_token(PLAYLIST_READ_SCOPE)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let playlist_id = match parse_playlist_reference(name) {
            Some(id) => id,
            None => {
                self.find_user_playlist_id(name, &token.access_token)
                    .await?
            }
        };

        match self
            .official_playlist_tracks(&playlist_id, limit, &token.access_token)
            .await?
        {
            Some(tracks) => Ok(tracks),
            None => {
                self.metadata_playlist_tracks(&session, &playlist_id, limit)
                    .await
            }
        }
    }

    async fn find_user_playlist_id(
        &self,
        name: &str,
        access_token: &str,
    ) -> Result<String, SpotifyError> {
        let wanted = name.trim();
        let mut offset = 0usize;
        for _ in 0..MAX_PLAYLIST_DISCOVERY_PAGES {
            let body = self
                .api_json(
                    self.inner
                        .http
                        .get(format!("{SPOTIFY_API}/me/playlists"))
                        .bearer_auth(access_token)
                        .query(&[("limit", API_PAGE_SIZE), ("offset", offset)]),
                )
                .await?;
            let page = body.get("items").and_then(Value::as_array);
            let raw_count = page.map_or(0, Vec::len);
            if let Some(id) = page.into_iter().flatten().find_map(|item| {
                let id = item.get("id")?.as_str()?;
                let candidate = item.get("name")?.as_str()?;
                (types::valid_spotify_id(id) && candidate.eq_ignore_ascii_case(wanted))
                    .then(|| id.to_string())
            }) {
                return Ok(id);
            }
            let has_next = has_next_page(body.get("next"));
            if raw_count == 0 && has_next {
                return Err(SpotifyError::Unavailable);
            }
            if !has_next {
                if page_has_unseen_items(Some(&body), offset + raw_count) {
                    return Err(SpotifyError::Unavailable);
                }
                return Err(SpotifyError::InvalidRequest("playlist not found"));
            }
            offset = offset.saturating_add(raw_count);
        }
        // Refuse to pretend a bounded discovery scan was complete.
        Err(SpotifyError::Unavailable)
    }

    /// `Ok(None)` means the Web API explicitly denied the followed/private
    /// playlist endpoint and the authenticated metadata protocol should be used.
    async fn official_playlist_tracks(
        &self,
        playlist_id: &str,
        limit: usize,
        access_token: &str,
    ) -> Result<Option<Vec<SpotifyTrack>>, SpotifyError> {
        let mut tracks = Vec::with_capacity(limit);
        let mut offset = 0usize;
        while tracks.len() < limit {
            let page_size = API_PAGE_SIZE.min(limit - tracks.len());
            let response = self
                .send_api(
                    self.inner
                        .http
                        .get(format!("{SPOTIFY_API}/playlists/{playlist_id}/items"))
                        .bearer_auth(access_token)
                        .query(&[("limit", page_size), ("offset", offset)]),
                )
                .await?;
            if response.status() == reqwest::StatusCode::FORBIDDEN {
                return Ok(None);
            }
            classify_response(response.status())?;
            let body: Value = response
                .json()
                .await
                .map_err(|_| SpotifyError::Unavailable)?;
            let page = body.get("items").and_then(Value::as_array);
            let raw_count = page.map_or(0, Vec::len);
            for entry in page.into_iter().flatten() {
                if tracks.len() == limit {
                    break;
                }
                if let Some(track) = parse_playlist_entry(entry)? {
                    tracks.push(track);
                }
            }
            let has_next = has_next_page(body.get("next"));
            if raw_count == 0 && has_next {
                return Err(SpotifyError::Unavailable);
            }
            if !has_next {
                if tracks.len() < limit && page_has_unseen_items(Some(&body), offset + raw_count) {
                    return Err(SpotifyError::Unavailable);
                }
                break;
            }
            offset = offset.saturating_add(raw_count);
        }
        Ok(Some(tracks))
    }

    async fn metadata_playlist_tracks(
        &self,
        session: &Session,
        playlist_id: &str,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let uri = SpotifyUri::from_uri(&format!("spotify:playlist:{playlist_id}"))
            .map_err(|_| SpotifyError::InvalidRequest("invalid playlist identifier"))?;
        let playlist = Playlist::get(session, &uri)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let track_uris = playlist
            .contents
            .items
            .iter()
            .filter(|&item| matches!(item.id, SpotifyUri::Track { .. }))
            .map(|item| item.id.clone())
            .take(limit)
            .collect::<Vec<_>>();
        if !metadata_playlist_is_complete(
            playlist.contents.is_truncated,
            playlist.contents.items.len(),
            playlist.length,
            track_uris.len(),
            limit,
        ) {
            return Err(SpotifyError::Unavailable);
        }
        self.hydrate_track_uris(session, track_uris, limit).await
    }

    async fn album_tracks_by_search(
        &self,
        album_name: &str,
        artist_name: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let album_name = album_name.trim();
        if album_name.is_empty() || album_name.len() > types::MAX_QUERY_BYTES {
            return Err(SpotifyError::InvalidRequest("invalid album name"));
        }
        let session = self.session().await?;
        let token = session
            .token_provider()
            .get_token(SEARCH_SCOPE)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let query = match artist_name.map(str::trim).filter(|name| !name.is_empty()) {
            Some(artist) => format!("album:{album_name} artist:{artist}"),
            None => format!("album:{album_name}"),
        };
        let body = self
            .api_json(
                self.inner
                    .http
                    .get(format!("{SPOTIFY_API}/search"))
                    .bearer_auth(&token.access_token)
                    .query(&[
                        ("q", query),
                        ("type", "album".into()),
                        ("limit", types::MAX_SEARCH_RESULTS.to_string()),
                    ]),
            )
            .await?;
        let album_id = select_album_id(body.pointer("/albums/items"), album_name, artist_name)
            .ok_or(SpotifyError::Unavailable)?;
        self.album_tracks_by_id_with_session(&session, &album_id, limit)
            .await
    }

    async fn album_tracks_by_id(
        &self,
        album_id: &str,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        if !types::valid_spotify_id(album_id) {
            return Err(SpotifyError::InvalidRequest("invalid album identifier"));
        }
        let session = self.session().await?;
        self.album_tracks_by_id_with_session(&session, album_id, limit)
            .await
    }

    async fn album_tracks_by_id_with_session(
        &self,
        session: &Session,
        album_id: &str,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let uri = SpotifyUri::from_uri(&format!("spotify:album:{album_id}"))
            .map_err(|_| SpotifyError::InvalidRequest("invalid album identifier"))?;
        let album = Album::get(session, &uri)
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        let track_uris = album.tracks().take(limit).cloned().collect::<Vec<_>>();
        self.hydrate_track_uris(session, track_uris, limit).await
    }

    async fn tracks_by_ids(
        &self,
        ids: &[String],
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let session = self.session().await?;
        let uris = ids
            .iter()
            .filter(|id| types::valid_spotify_id(id))
            .take(limit)
            .filter_map(|id| SpotifyUri::from_uri(&format!("spotify:track:{id}")).ok())
            .collect::<Vec<_>>();
        self.hydrate_track_uris(&session, uris, limit).await
    }

    async fn hydrate_track_uris(
        &self,
        session: &Session,
        uris: Vec<SpotifyUri>,
        limit: usize,
    ) -> Result<Vec<SpotifyTrack>, SpotifyError> {
        let session = session.clone();
        futures::stream::iter(uris.into_iter().take(limit).map(move |uri| {
            let session = session.clone();
            async move {
                let track = Track::get(&session, &uri)
                    .await
                    .map_err(|_| SpotifyError::Unavailable)?;
                log_available_audio_formats(&track.files);
                metadata_track(track)
            }
        }))
        // `buffered`, unlike `buffer_unordered`, preserves the source queue
        // while bounding network/decoder pressure on the Pin.
        .buffered(METADATA_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect()
    }

    async fn send_api(&self, request: RequestBuilder) -> Result<ReqwestResponse, SpotifyError> {
        let retry = request.try_clone();
        let response = request
            .send()
            .await
            .map_err(|_| SpotifyError::Unavailable)?;
        if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(response);
        }
        let delay = retry_after_delay(response.headers()).ok_or(SpotifyError::RateLimited)?;
        let retry = retry.ok_or(SpotifyError::RateLimited)?;
        drop(response);
        tokio::time::sleep(delay).await;
        retry.send().await.map_err(|_| SpotifyError::Unavailable)
    }

    async fn api_json(&self, request: RequestBuilder) -> Result<Value, SpotifyError> {
        let response = self.send_api(request).await?;
        classify_response(response.status())?;
        response.json().await.map_err(|_| SpotifyError::Unavailable)
    }
}

fn parse_playlist_reference(value: &str) -> Option<String> {
    let value = value.trim();
    if types::valid_spotify_id(value) {
        return Some(value.to_string());
    }
    let uri = SpotifyUri::from_uri(value).ok()?;
    if !matches!(uri, SpotifyUri::Playlist { .. }) {
        return None;
    }
    uri.to_id().ok().filter(|id| types::valid_spotify_id(id))
}

fn select_album_id(
    items: Option<&Value>,
    wanted_name: &str,
    wanted_artist: Option<&str>,
) -> Option<String> {
    let wanted_name = wanted_name.trim();
    let wanted_artist = wanted_artist.map(str::trim).filter(|name| !name.is_empty());
    items
        .and_then(Value::as_array)?
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let id = item.get("id")?.as_str()?;
            let name = item.get("name")?.as_str()?;
            if !types::valid_spotify_id(id) {
                return None;
            }
            let name_penalty = usize::from(!name.eq_ignore_ascii_case(wanted_name));
            let artist_penalty =
                wanted_artist.map_or(0, |wanted| {
                    usize::from(!item.get("artists").and_then(Value::as_array).is_some_and(
                        |artists| {
                            artists.iter().any(|artist| {
                                artist
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
                            })
                        },
                    ))
                });
            Some(((name_penalty, artist_penalty, index), id.to_string()))
        })
        .min_by_key(|(score, _)| *score)
        .map(|(_, id)| id)
}

fn parse_playlist_entry(entry: &Value) -> Result<Option<SpotifyTrack>, SpotifyError> {
    let Some(item) = entry.get("item").or_else(|| entry.get("track")) else {
        return Ok(None);
    };
    if item.is_null()
        || item.get("is_local").and_then(Value::as_bool) == Some(true)
        || matches!(item.get("type").and_then(Value::as_str), Some("episode"))
    {
        return Ok(None);
    }
    if let Some(track) = parse_track(item) {
        return Ok(Some(track));
    }
    // A declared Spotify track that no longer matches the documented object
    // shape is a schema/error condition, not an empty slot. Failing preserves
    // queue integrity instead of silently returning a truncated collection.
    if matches!(item.get("type").and_then(Value::as_str), Some("track"))
        || item
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(types::valid_spotify_id)
    {
        return Err(SpotifyError::Unavailable);
    }
    Ok(None)
}

fn metadata_playlist_is_complete(
    is_truncated: bool,
    materialized_items: usize,
    declared_length: i32,
    materialized_tracks: usize,
    requested_tracks: usize,
) -> bool {
    if !is_truncated || materialized_tracks >= requested_tracks {
        return true;
    }
    let declared_length = usize::try_from(declared_length).unwrap_or(usize::MAX);
    materialized_items >= declared_length
}

/// Record which audio formats Spotify actually offers for a track.
///
/// This is the gate on ever moving off the decode-to-WAV pipeline. The Pin's
/// DSP can hardware-decode MP3 (and AAC) but never raw PCM or Ogg Vorbis, so a
/// track that carries an MP3 file could in principle be handed to the stock
/// player untouched and decoded by the ADSP instead of by us — which is the
/// power/flash win, not a fidelity one (the speaker's fixed EQ has a ~20 dB
/// notch across 7-16 kHz, exactly where 320 kbps codecs differ).
///
/// Whether Spotify serves MP3 at all is per-track and server-supplied, so it
/// cannot be answered from source, and librespot logs nothing about the file
/// map on its success path. We record it here, inside catalog hydration, where
/// the metadata fetch has already happened and this costs no extra request and
/// adds no latency to the play path.
///
/// Content-free: format names only, never a track identity.
/// Offset of Spotify's loudness-normalisation block inside the custom header
/// that precedes the Ogg stream (the Ogg itself starts at 0xA7). librespot uses
/// the same constant; the block is four little-endian `f32`s: track gain dB,
/// track peak, album gain dB, album peak.
const SPOTIFY_NORMALISATION_OFFSET: u64 = 144;
const SPOTIFY_NORMALISATION_BYTES: usize = 16;

/// Audio-path facts for one track, derived **without playing it**.
///
/// Answers the two questions the firmware teardown left open:
/// - which formats Spotify offers, i.e. whether an MP3 the Pin's DSP could
///   hardware-decode exists at all; and
/// - the exact loudness gain this server applies, which — with normalisation on
///   and no pregain — is an *attenuation* on loud masters that was otherwise
///   invisible without playing a track.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SpotifyTrackAudioDiagnostics {
    pub formats: Vec<String>,
    pub dsp_offloadable: bool,
    pub normalisation_source_format: Option<String>,
    pub track_gain_db: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_gain_db: Option<f64>,
    pub album_peak: Option<f64>,
    /// Gain this server actually applies under the active player config.
    pub applied_gain_db: Option<f64>,
    /// The same figure as a linear factor percentage, matching the wording of
    /// librespot's own "Calculated Normalisation Factor" log line.
    pub applied_factor_percent: Option<f64>,
}

fn log_available_audio_formats(files: &AudioFiles) {
    let mut formats: Vec<String> = files.keys().map(|format| format!("{format:?}")).collect();
    formats.sort_unstable();
    // Deliberately narrower than `AudioFiles::is_mp3`, which also counts
    // MP3_160_ENC — librespot never selects that one and it is not a plain MP3
    // stream, so it would not survive being proxied to the stock player.
    let dsp_offloadable = files.keys().any(|format| {
        matches!(
            format,
            AudioFileFormat::MP3_320
                | AudioFileFormat::MP3_256
                | AudioFileFormat::MP3_160
                | AudioFileFormat::MP3_96
        )
    });
    info!(
        formats = %formats.join(","),
        dsp_offloadable,
        "spotify audio formats offered for track"
    );
}

fn metadata_track(track: Track) -> Result<SpotifyTrack, SpotifyError> {
    let id = track.id.to_id().map_err(|_| SpotifyError::Unavailable)?;
    let artists = track
        .artists
        .iter()
        .map(|artist| artist.name.clone())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    if !types::valid_spotify_id(&id)
        || track.name.is_empty()
        || artists.is_empty()
        || track.duration <= 0
    {
        return Err(SpotifyError::Unavailable);
    }
    Ok(SpotifyTrack {
        id,
        title: track.name,
        artists,
        album: track.album.name,
        duration_ms: track.duration as u64,
        track_number: track.number.max(0) as u32,
        disc_number: track.disc_number.max(0) as u32,
        explicit: track.is_explicit,
        // librespot's metadata surface hydrates album and playlist queues,
        // which are sequence-ordered, and its protobuf default is an
        // indistinguishable zero. Leave the score absent rather than record a
        // wire default as a real measurement.
        popularity: None,
    })
}

fn has_next_page(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|next| !next.is_empty())
}

fn page_has_unseen_items(page: Option<&Value>, consumed: usize) -> bool {
    page.and_then(|value| value.get("total"))
        .and_then(Value::as_u64)
        .is_some_and(|total| total > consumed as u64)
}

fn retry_after_delay(headers: &HeaderMap) -> Option<Duration> {
    let seconds = headers
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    let delay = Duration::from_secs(seconds);
    (delay <= MAX_RATE_LIMIT_RETRY_AFTER).then_some(delay)
}

fn pairing_cancelled(cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow()
}

async fn wait_for_pairing_cancellation(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

fn radio_fallback_query(
    cached: Option<&SpotifyTrack>,
    secondary: Option<&str>,
    primary: Option<&str>,
) -> String {
    cached
        .map(|track| {
            format!(
                "artist:{} {}",
                track.artists.first().cloned().unwrap_or_default(),
                track.title
            )
        })
        .or_else(|| secondary.map(str::to_string))
        .or_else(|| primary.map(str::to_string))
        .unwrap_or_else(|| "top hits".into())
}

fn uses_personal_top_tracks(kind: &str) -> bool {
    kind == "featured"
}

/// How long `query(kind=artist)` skips the primary top-tracks lookup after it
/// reported Unavailable/RateLimited, going straight to the ranked-search
/// fallback instead of paying a known-dead provider roundtrip every prompt.
const ARTIST_TOP_TRACKS_BACKOFF: Duration = Duration::from_secs(600);

fn artist_top_tracks_backoff_is_active(until: Option<Instant>, now: Instant) -> bool {
    until.is_some_and(|deadline| now < deadline)
}

fn artist_top_tracks_needs_search_fallback(error: &SpotifyError) -> bool {
    matches!(error, SpotifyError::Unavailable | SpotifyError::RateLimited)
}

fn artist_top_tracks_fallback_query(artist_name: &str) -> String {
    format!("artist:{}", artist_name.trim())
}

/// Whether a result list is ordered by descending popularity.
///
/// A genuine `/artists/{id}/top-tracks` page is; a relevance-ordered search is
/// generally not. This is the second, provider-independent opinion on the
/// question "is this really a ranking?" — deliberately a description of the
/// list, never an instruction to reorder it. Unscored tracks make the answer
/// `unknown` rather than silently passing, because `None` compared as zero
/// would report every unscored list as perfectly descending.
fn popularity_order(tracks: &[SpotifyTrack]) -> &'static str {
    if tracks.iter().any(|track| track.popularity.is_none()) {
        return "unknown";
    }
    if tracks
        .windows(2)
        .all(|pair| pair[0].popularity >= pair[1].popularity)
    {
        "descending"
    } else {
        "mixed"
    }
}

/// Record that an artist lookup fell back to relevance-ordered search.
///
/// Bounded shape only: a reason from a closed set, a count, and a description
/// of the ordering. The artist name is caller text and never appears here.
fn log_degraded_artist_ranking(reason: &'static str, tracks: &[SpotifyTrack]) {
    warn!(
        reason,
        track_count = tracks.len(),
        popularity_order = popularity_order(tracks),
        "{}",
        operational_markers::MUSIC_RANKING_DEGRADED
    );
}

fn search_page_size(remaining: usize) -> usize {
    remaining.min(types::MAX_SEARCH_RESULTS)
}

fn build_search_query(request: &SpotifyQueryRequest) -> String {
    let primary = request.primary.as_deref().unwrap_or("").trim();
    let secondary = request.secondary.as_deref().unwrap_or("").trim();
    match request.kind.as_str() {
        "artist" if !primary.is_empty() => format!("artist:{primary}"),
        "album" if !primary.is_empty() => format!("album:{primary}"),
        "album_artist" if !primary.is_empty() && !secondary.is_empty() => {
            format!("album:{primary} artist:{secondary}")
        }
        "genre" if !primary.is_empty() => format!("genre:{primary}"),
        "featured" => "top hits".into(),
        "top_hits" if !secondary.is_empty() => format!("{primary} artist:{secondary}"),
        _ => [primary, secondary]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn classify_response(status: reqwest::StatusCode) -> Result<(), SpotifyError> {
    if status.is_success() {
        Ok(())
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        Err(SpotifyError::RateLimited)
    } else {
        Err(SpotifyError::Unavailable)
    }
}

#[cfg(test)]
fn parse_track_array(value: Option<&Value>, limit: usize) -> Vec<SpotifyTrack> {
    parse_track_array_unbounded(value, limit)
}

fn parse_track_array_unbounded(value: Option<&Value>, limit: usize) -> Vec<SpotifyTrack> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_track).take(limit).collect())
        .unwrap_or_default()
}

fn select_artist_id(items: Option<&Value>, wanted_name: &str) -> Option<String> {
    let wanted = normalized_catalog_name(wanted_name);
    if wanted.is_empty() {
        return None;
    }
    let mut exact = items?
        .as_array()?
        .iter()
        .filter_map(|artist| {
            let name = artist.get("name")?.as_str()?;
            if normalized_catalog_name(name) != wanted {
                return None;
            }
            let id = artist.get("id")?.as_str()?;
            if !types::valid_spotify_id(id) {
                return None;
            }
            Some((
                artist
                    .get("popularity")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                id,
            ))
        })
        .collect::<Vec<_>>();
    exact.sort_by(|left, right| right.0.cmp(&left.0));
    match exact.as_slice() {
        [] => None,
        [(_, id)] => Some((*id).to_string()),
        [(first_popularity, first_id), (second_popularity, _), ..]
            if first_popularity > second_popularity =>
        {
            Some((*first_id).to_string())
        }
        // Two indistinguishable exact-name artists are ambiguous. Do not
        // silently route a contextual command to an arbitrary catalog entity.
        _ => None,
    }
}

fn normalized_catalog_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_track(value: &Value) -> Option<SpotifyTrack> {
    let id = value.get("id")?.as_str()?.to_string();
    if !types::valid_spotify_id(&id) {
        return None;
    }
    let artists = value
        .get("artists")?
        .as_array()?
        .iter()
        .filter_map(|artist| artist.get("name")?.as_str().map(str::to_string))
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    if artists.is_empty() {
        return None;
    }
    Some(SpotifyTrack {
        id,
        title: value.get("name")?.as_str()?.to_string(),
        artists,
        album: value
            .pointer("/album/name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        duration_ms: value.get("duration_ms")?.as_u64()?,
        track_number: value
            .get("track_number")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        disc_number: value
            .get("disc_number")
            .and_then(Value::as_u64)
            .unwrap_or(1) as u32,
        explicit: value
            .get("explicit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // Documented 0-100. Absent on some trimmed track objects, so this is
        // an `Option` rather than a defaulted zero — see `SpotifyTrack`.
        popularity: value
            .get("popularity")
            .and_then(Value::as_u64)
            .map(|score| score.min(100) as u32),
    })
}

fn validate_stored_auth(stored: &StoredAuth) -> Result<(), SpotifyError> {
    if stored.version != AUTH_VERSION
        || Uuid::parse_str(&stored.device_id).is_err()
        || stored.credentials.auth_data.is_empty()
        || stored.credentials.auth_data.len() > MAX_AUTH_BYTES as usize
        || stored
            .credentials
            .username
            .as_ref()
            .is_some_and(|username| username.is_empty() || username.len() > 256)
    {
        return Err(SpotifyError::Persistence);
    }
    Ok(())
}

fn load_auth(path: &Path) -> Result<StoredAuth, SpotifyError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| SpotifyError::NotPaired)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_AUTH_BYTES
    {
        return Err(SpotifyError::Persistence);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|_| SpotifyError::Persistence)?;
    let stored: StoredAuth =
        serde_json::from_slice(&bytes).map_err(|_| SpotifyError::Persistence)?;
    validate_stored_auth(&stored)?;
    Ok(stored)
}

fn persist_auth(path: &Path, stored: &StoredAuth) -> Result<(), SpotifyError> {
    validate_stored_auth(stored)?;
    let bytes = serde_json::to_vec(stored).map_err(|_| SpotifyError::Persistence)?;
    if bytes.len() > MAX_AUTH_BYTES as usize {
        return Err(SpotifyError::Persistence);
    }
    let parent = path.parent().ok_or(SpotifyError::Persistence)?;
    let parent_metadata =
        std::fs::symlink_metadata(parent).map_err(|_| SpotifyError::Persistence)?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(SpotifyError::Persistence);
    }
    if path.exists()
        && std::fs::symlink_metadata(path)
            .map_err(|_| SpotifyError::Persistence)?
            .file_type()
            .is_symlink()
    {
        return Err(SpotifyError::Persistence);
    }
    let temporary = parent.join(format!(".spotify-auth.{}.tmp", Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| SpotifyError::Persistence)?;
        file.write_all(&bytes)
            .map_err(|_| SpotifyError::Persistence)?;
        file.sync_all().map_err(|_| SpotifyError::Persistence)?;
        std::fs::rename(&temporary, path).map_err(|_| SpotifyError::Persistence)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| SpotifyError::Persistence)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn remove_auth(path: &Path) -> Result<(), SpotifyError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_file() => {
            Err(SpotifyError::Persistence)
        }
        Ok(_) => std::fs::remove_file(path).map_err(|_| SpotifyError::Persistence),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SpotifyError::Persistence),
    }
}

fn clear_playback_cache(cache_dir: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(cache_dir) else {
        let _ = std::fs::create_dir_all(cache_dir);
        return;
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        warn!("Spotify playback cache path is unsafe");
        return;
    }
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|extension| extension == "wav") {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn random_ticket() -> Result<String, SpotifyError> {
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| SpotifyError::Unavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn internal_peer(peer: &SocketAddr) -> bool {
    peer.ip().is_loopback()
}

fn valid_bridge_token(value: &str) -> bool {
    value.len() == BRIDGE_TOKEN_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn internal_control_authorized(
    peer: &SocketAddr,
    headers: &HeaderMap,
    expected: Option<&str>,
) -> bool {
    if !internal_peer(peer) {
        return false;
    }
    let Some(expected) = expected.filter(|value| valid_bridge_token(value)) else {
        return false;
    };
    let mut values = headers.get_all(BRIDGE_TOKEN_HEADER).iter();
    let Some(presented) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Ok(presented) = presented.to_str() else {
        return false;
    };
    valid_bridge_token(presented) && bool::from(presented.as_bytes().ct_eq(expected.as_bytes()))
}

pub fn internal_router(service: SpotifyService) -> Router {
    Router::new()
        .route("/internal/spotify/query", post(internal_query))
        .route("/internal/spotify/playback", post(internal_playback))
        .route("/internal/spotify/save", post(internal_save))
        .route(
            "/internal/spotify/stream/{ticket}",
            get(internal_stream).head(internal_stream),
        )
        .layer(DefaultBodyLimit::max(32 * 1024))
        .with_state(service)
}

async fn internal_query(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(service): State<SpotifyService>,
    headers: HeaderMap,
    Json(request): Json<SpotifyQueryRequest>,
) -> Response {
    if !internal_control_authorized(&peer, &headers, service.inner.bridge_token.as_deref()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match service.query(request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => (error.status_code(), error.safe_message()).into_response(),
    }
}

async fn internal_playback(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(service): State<SpotifyService>,
    headers: HeaderMap,
    Json(request): Json<SpotifyPlaybackRequest>,
) -> Response {
    if !internal_control_authorized(&peer, &headers, service.inner.bridge_token.as_deref()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match service.playback(request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => (error.status_code(), error.safe_message()).into_response(),
    }
}

async fn internal_save(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(service): State<SpotifyService>,
    headers: HeaderMap,
    Json(request): Json<SpotifySaveRequest>,
) -> Response {
    if !internal_control_authorized(&peer, &headers, service.inner.bridge_token.as_deref()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match service.save(request).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => (error.status_code(), error.safe_message()).into_response(),
    }
}

async fn internal_stream(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(service): State<SpotifyService>,
    AxumPath(ticket): AxumPath<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    if !internal_peer(&peer) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(buffer) = service.playback_buffer(&ticket).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    buffer.response(method == Method::HEAD, &headers).await
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    #[serde(default = "default_search_kind")]
    kind: String,
}

fn default_search_kind() -> String {
    "track".into()
}

pub async fn diagnostic_search(
    service: &SpotifyService,
    params: HashMap<String, String>,
) -> Result<SpotifyQueryResponse, SpotifyError> {
    let params = SearchParams {
        q: params.get("q").cloned().unwrap_or_default(),
        kind: params
            .get("kind")
            .cloned()
            .unwrap_or_else(default_search_kind),
    };
    service
        .query(SpotifyQueryRequest {
            kind: params.kind,
            primary: Some(params.q),
            secondary: None,
            ids: Vec::new(),
            limit: types::MAX_SEARCH_RESULTS,
        })
        .await
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
