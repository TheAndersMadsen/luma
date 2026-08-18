use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use axum::body::to_bytes;
use axum::extract::{DefaultBodyLimit, OriginalUri, Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hmac::{Hmac, Mac as _};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq as _;
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, Notify, OnceCell, RwLock as AsyncRwLock, Semaphore};
use tokio::time::Instant;
use tracing::warn;

use super::codex_app_server::{
    AppServerError, AppServerLaunch, ChatImage, ChatMessage, ChatRole, CodexAppServer,
    CodexChatSession, LoginCompletion,
};
use super::codex_connect_proxy::{CodexConnectProxy, ProxyCredentials, ProxyError};
use super::request::LlmResponseMode;
use crate::config::validate_codex_bridge_token;
use crate::esim::EsimBridge;

const BRIDGE_ADDRESS: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8765);
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_CAMERA_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_IN_FLIGHT_REQUESTS: usize = 16;
const MAX_ACTIVE_AGENTIC_SESSIONS: usize = 16;
const MAX_AGENTIC_SESSION_TOMBSTONES: usize = 64;
const AGENTIC_SESSION_IDLE_TTL: Duration = Duration::from_secs(75);
const MAX_CHALLENGE_TARGET_BYTES: usize = 128;
const CHALLENGE_NONCE_BYTES: usize = 32;
const CHALLENGE_NONCE_CHARS: usize = 43;
const CHALLENGE_DOMAIN: &[u8] = b"humane-system-hook/codex-bridge/identity/v1\0";
const PERSISTENCE_TIMEOUT: Duration = Duration::from_secs(8);
const PROGRESS_PERSIST_RETRY_INTERVAL: Duration = Duration::from_millis(500);
const PROGRESS_PERSIST_LIFETIME: Duration = Duration::from_secs(30);
const LOGIN_COMPLETION_LIFETIME: Duration = Duration::from_secs(15 * 60);
const LOGIN_PERSIST_RETRY_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalCodexError {
    InvalidConfiguration,
    AppServer,
    BridgeBind,
    Proxy,
    Server,
}

impl fmt::Display for LocalCodexError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("on-device Codex runtime failed")
    }
}

impl std::error::Error for LocalCodexError {}

#[derive(Debug, Clone)]
struct RuntimeEnvironment {
    executable: PathBuf,
    codex_home: PathBuf,
    temporary_directory: PathBuf,
    ca_certificate: PathBuf,
    /// Optional Codex provider config for OpenAI-compatible APIs.
    provider_config: Option<super::CodexProviderConfig>,
    /// The resolved API key value to inject into the child environment.
    api_key_value: Option<String>,
}

impl RuntimeEnvironment {
    fn from_process() -> Result<Option<Self>, LocalCodexError> {
        let Some(executable) = nonempty_environment_path("PENUMBRA_CODEX_APP_SERVER")? else {
            return Ok(None);
        };
        let codex_home = required_environment_path("PENUMBRA_CODEX_HOME")?;
        let temporary_directory = required_environment_path("PENUMBRA_CODEX_TMPDIR")?;
        let ca_certificate = required_environment_path("PENUMBRA_CODEX_CA_CERTIFICATE")?;
        Ok(Some(Self {
            executable,
            codex_home,
            temporary_directory,
            ca_certificate,
            provider_config: None,
            api_key_value: None,
        }))
    }

    fn launch(&self, proxy_url: &str) -> Result<AppServerLaunch, LocalCodexError> {
        AppServerLaunch::with_provider_config(
            self.executable.clone(),
            self.codex_home.clone(),
            self.temporary_directory.clone(),
            self.ca_certificate.clone(),
            proxy_url.to_string(),
            self.provider_config.clone(),
            self.api_key_value.clone(),
        )
        .map_err(|_| LocalCodexError::InvalidConfiguration)
    }
}

fn nonempty_environment_path(name: &str) -> Result<Option<PathBuf>, LocalCodexError> {
    match std::env::var_os(name) {
        None => Ok(None),
        Some(value) if value.is_empty() => Err(LocalCodexError::InvalidConfiguration),
        Some(value) => Ok(Some(PathBuf::from(value))),
    }
}

fn required_environment_path(name: &str) -> Result<PathBuf, LocalCodexError> {
    nonempty_environment_path(name)?.ok_or(LocalCodexError::InvalidConfiguration)
}

pub(crate) struct LocalCodexRuntime {
    app_server: CodexAppServer,
    bridge_listener: TcpListener,
    bridge_state: BridgeState,
    connect_proxy: CodexConnectProxy,
}

impl LocalCodexRuntime {
    pub(crate) async fn from_environment(
        bridge_token: Option<String>,
        esim_bridge: EsimBridge,
        provider_config: Option<super::CodexProviderConfig>,
        api_key_value: Option<String>,
    ) -> Result<Option<Self>, LocalCodexError> {
        let Some(mut environment) = RuntimeEnvironment::from_process()? else {
            return Ok(None);
        };

        // Set the provider config if provided
        environment.provider_config = provider_config;
        environment.api_key_value = api_key_value;

        let bridge_token = bridge_token.ok_or(LocalCodexError::InvalidConfiguration)?;
        validate_codex_bridge_token(&bridge_token)
            .map_err(|_| LocalCodexError::InvalidConfiguration)?;

        // Bind both loopback listeners before launching the child, so its
        // initialized process never observes a proxy or bridge port owned by
        // another process.
        let proxy_credentials =
            ProxyCredentials::derive(&bridge_token).map_err(|_| LocalCodexError::Proxy)?;
        let connect_proxy = CodexConnectProxy::bind(&proxy_credentials)
            .await
            .map_err(|_| LocalCodexError::Proxy)?;
        let bridge_listener = TcpListener::bind(BRIDGE_ADDRESS)
            .await
            .map_err(|_| LocalCodexError::BridgeBind)?;
        let actual_address = bridge_listener
            .local_addr()
            .map_err(|_| LocalCodexError::BridgeBind)?;
        if actual_address != BRIDGE_ADDRESS {
            return Err(LocalCodexError::BridgeBind);
        }

        let app_server = CodexAppServer::start(environment.launch(proxy_credentials.url())?)
            .await
            .map_err(|_| LocalCodexError::AppServer)?;
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let agentic_sessions = Arc::new(AgenticSessionRegistry::default());
        let bridge_state = BridgeState {
            app_server: app_server.clone(),
            token: Arc::new(bridge_token),
            in_flight: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
            account_operations: Arc::new(AsyncRwLock::new(())),
            persistence: ArtifactPersistence::Device(esim_bridge),
            persistence_coordinator,
            agentic_sessions,
            pending_login: PendingLogin::default(),
        };
        Ok(Some(Self {
            app_server,
            bridge_listener,
            bridge_state,
            connect_proxy,
        }))
    }

    pub(crate) async fn serve(self) -> Result<(), LocalCodexError> {
        let app_server = self.app_server;
        let bridge = axum::serve(self.bridge_listener, bridge_router(self.bridge_state));
        let proxy = self.connect_proxy.serve();
        let terminated_server = app_server.clone();
        let result = tokio::select! {
            result = bridge => result.map_err(|_| LocalCodexError::Server),
            result = proxy => result.map_err(|_| LocalCodexError::Proxy),
            () = terminated_server.wait_for_termination() => Err(LocalCodexError::AppServer),
        };
        app_server.close().await;
        result
    }
}

#[derive(Clone)]
struct BridgeState {
    app_server: CodexAppServer,
    token: Arc<String>,
    in_flight: Arc<Semaphore>,
    // Codex app-server multiplexes requests by id and every chat owns a
    // distinct ephemeral thread/directory, so authenticated reads may run in
    // parallel. Account transitions remain exclusive: starting a device-code
    // login cannot race a turn or the credential snapshot that follows it.
    account_operations: Arc<AsyncRwLock<()>>,
    persistence: ArtifactPersistence,
    persistence_coordinator: Arc<PersistenceCoordinator>,
    agentic_sessions: Arc<AgenticSessionRegistry>,
    pending_login: PendingLogin,
}

#[derive(Default)]
struct AgenticSessionRegistry {
    state: AsyncMutex<AgenticSessionRegistryState>,
}

#[derive(Default)]
struct AgenticSessionRegistryState {
    sessions: HashMap<String, Arc<AgenticBridgeSession>>,
    tombstones: HashMap<String, Instant>,
}

struct AgenticBridgeSession {
    app_session: OnceCell<CodexChatSession>,
    persistence: AsyncMutex<Option<ArtifactPersistenceGuard>>,
    last_activity: StdMutex<Instant>,
    active_turns: AtomicUsize,
    turn_idle: Notify,
    finalizing: AtomicBool,
}

struct AgenticTurnActivity {
    session: Arc<AgenticBridgeSession>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgenticSessionLookupError {
    Capacity,
    Retired,
}

impl AgenticBridgeSession {
    fn new(persistence: ArtifactPersistenceGuard) -> Self {
        Self {
            app_session: OnceCell::new(),
            persistence: AsyncMutex::new(Some(persistence)),
            last_activity: StdMutex::new(Instant::now()),
            active_turns: AtomicUsize::new(0),
            turn_idle: Notify::new(),
            finalizing: AtomicBool::new(false),
        }
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    fn idle_deadline(&self) -> Instant {
        *self.last_activity.lock().unwrap() + AGENTIC_SESSION_IDLE_TTL
    }

    fn begin_turn(self: &Arc<Self>) -> Option<AgenticTurnActivity> {
        if self.finalizing.load(Ordering::Acquire) {
            return None;
        }
        self.active_turns.fetch_add(1, Ordering::AcqRel);
        if self.finalizing.load(Ordering::Acquire) {
            if self.active_turns.fetch_sub(1, Ordering::AcqRel) == 1 {
                self.turn_idle.notify_waiters();
            }
            return None;
        }
        self.touch();
        Some(AgenticTurnActivity {
            session: Arc::clone(self),
        })
    }

    async fn finalize(&self) -> Result<(), ()> {
        if self.finalizing.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        while self.active_turns.load(Ordering::Acquire) != 0 {
            let idle = self.turn_idle.notified();
            if self.active_turns.load(Ordering::Acquire) == 0 {
                break;
            }
            idle.await;
        }
        if let Some(app_session) = self.app_session.get() {
            app_session.close().await;
        }
        let Some(mut persistence) = self.persistence.lock().await.take() else {
            return Ok(());
        };
        persistence.announce_high_priority();
        persistence.commit().await
    }
}

impl Drop for AgenticTurnActivity {
    fn drop(&mut self) {
        self.session.touch();
        if self.session.active_turns.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.session.turn_idle.notify_waiters();
        }
    }
}

impl AgenticSessionRegistry {
    async fn get_or_create(
        self: &Arc<Self>,
        id: &str,
        create: impl FnOnce() -> AgenticBridgeSession,
    ) -> Result<Arc<AgenticBridgeSession>, AgenticSessionLookupError> {
        let now = Instant::now();
        let mut state = self.state.lock().await;
        state
            .tombstones
            .retain(|_, retired_at| now.duration_since(*retired_at) < AGENTIC_SESSION_IDLE_TTL);
        if state.tombstones.contains_key(id) {
            return Err(AgenticSessionLookupError::Retired);
        }
        if let Some(session) = state.sessions.get(id) {
            return Ok(Arc::clone(session));
        }
        if state.sessions.len() >= MAX_ACTIVE_AGENTIC_SESSIONS {
            return Err(AgenticSessionLookupError::Capacity);
        }
        let session = Arc::new(create());
        state.sessions.insert(id.to_string(), Arc::clone(&session));
        drop(state);
        self.spawn_expiry(id.to_string(), Arc::clone(&session));
        Ok(session)
    }

    async fn retire_if_same(
        &self,
        id: &str,
        expected: Option<&Arc<AgenticBridgeSession>>,
    ) -> Option<Arc<AgenticBridgeSession>> {
        let mut state = self.state.lock().await;
        if let Some(expected) = expected {
            let session = state.sessions.get(id)?;
            if !Arc::ptr_eq(session, expected) {
                return None;
            }
        }
        let session = state.sessions.remove(id);
        // An explicit finish must retire even an id whose first turn has not
        // reached the bridge yet. Otherwise a canceled POST racing behind its
        // DELETE could recreate and execute a supposedly finished session.
        // Expiry passes `expected`, so it cannot tombstone a replacement.
        if session.is_none() && expected.is_some() {
            return None;
        }
        state.tombstones.insert(id.to_string(), Instant::now());
        trim_agentic_tombstones(&mut state.tombstones);
        session
    }

    fn spawn_expiry(self: &Arc<Self>, id: String, session: Arc<AgenticBridgeSession>) {
        let registry = Arc::downgrade(self);
        let session = Arc::downgrade(&session);
        tokio::spawn(async move {
            loop {
                let Some(session) = session.upgrade() else {
                    return;
                };
                let deadline = session.idle_deadline();
                tokio::time::sleep_until(deadline).await;
                if session.active_turns.load(Ordering::Acquire) != 0 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
                if Instant::now() < session.idle_deadline() {
                    continue;
                }
                let Some(registry) = registry.upgrade() else {
                    return;
                };
                if let Some(retired) = registry.retire_if_same(&id, Some(&session)).await {
                    spawn_agentic_finalization(retired);
                }
                return;
            }
        });
    }
}

fn trim_agentic_tombstones(tombstones: &mut HashMap<String, Instant>) {
    while tombstones.len() > MAX_AGENTIC_SESSION_TOMBSTONES {
        let Some(oldest) = tombstones
            .iter()
            .min_by_key(|(_, retired_at)| **retired_at)
            .map(|(id, _)| id.clone())
        else {
            return;
        };
        tombstones.remove(&oldest);
    }
}

fn spawn_agentic_finalization(
    session: Arc<AgenticBridgeSession>,
) -> tokio::task::JoinHandle<Result<(), ()>> {
    tokio::spawn(async move { session.finalize().await })
}

#[derive(Default)]
struct PersistenceCoordinator {
    high_priority_waiters: std::sync::atomic::AtomicUsize,
    progress: StdMutex<ProgressPersistenceState>,
}

#[derive(Default)]
struct ProgressPersistenceState {
    requested: u64,
    persisted: u64,
    worker_running: bool,
}

struct HighPriorityPersistence {
    coordinator: Arc<PersistenceCoordinator>,
}

struct ProgressPersistenceWorker {
    coordinator: Arc<PersistenceCoordinator>,
    covered_generation: u64,
    finished: bool,
}

impl PersistenceCoordinator {
    fn announce_high_priority(self: &Arc<Self>) -> HighPriorityPersistence {
        self.high_priority_waiters
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        HighPriorityPersistence {
            coordinator: Arc::clone(self),
        }
    }

    fn high_priority_waiting(&self) -> bool {
        self.high_priority_waiters
            .load(std::sync::atomic::Ordering::SeqCst)
            != 0
    }

    fn request_progress_worker(self: &Arc<Self>) -> Option<ProgressPersistenceWorker> {
        let mut progress = self.progress.lock().unwrap();
        progress.requested = progress
            .requested
            .checked_add(1)
            .expect("progress persistence generation overflow");
        if progress.worker_running {
            None
        } else {
            progress.worker_running = true;
            Some(ProgressPersistenceWorker {
                coordinator: Arc::clone(self),
                covered_generation: progress.requested,
                finished: false,
            })
        }
    }

    #[cfg(test)]
    fn progress_worker_running(&self) -> bool {
        self.progress.lock().unwrap().worker_running
    }

    fn mark_current_progress_persisted(&self) {
        let mut progress = self.progress.lock().unwrap();
        progress.persisted = progress.persisted.max(progress.requested);
    }
}

impl Drop for HighPriorityPersistence {
    fn drop(&mut self) {
        self.coordinator
            .high_priority_waiters
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl ProgressPersistenceWorker {
    fn clear_running(&mut self, progress: &mut ProgressPersistenceState) {
        if self.finished {
            return;
        }
        self.finished = true;
        progress.worker_running = false;
    }

    /// Finish only when a high-priority snapshot atomically covers every cue
    /// generation. If a cue arrives during this handoff it either keeps this
    /// worker alive or observes `worker_running = false` and starts its own.
    fn finish_if_persisted(&mut self) -> bool {
        let coordinator = Arc::clone(&self.coordinator);
        let mut progress = coordinator.progress.lock().unwrap();
        if progress.persisted < progress.requested {
            return false;
        }
        self.clear_running(&mut progress);
        true
    }

    /// Complete one vault attempt while owning the generation handoff. A
    /// failed attempt may stop only when no newer cue was coalesced behind it.
    fn finish_after_attempt(&mut self, succeeded: bool) -> bool {
        let coordinator = Arc::clone(&self.coordinator);
        let mut progress = coordinator.progress.lock().unwrap();
        if succeeded {
            progress.persisted = progress.persisted.max(progress.requested);
            self.clear_running(&mut progress);
            return true;
        }
        if progress.requested > self.covered_generation {
            self.covered_generation = progress.requested;
            return false;
        }
        self.clear_running(&mut progress);
        true
    }

    /// Bound each generation cohort to thirty seconds without dropping a cue
    /// that arrives at the old cohort's deadline. A newer generation receives
    /// a fresh bounded window on this same single-flight worker.
    fn finish_or_roll_deadline(&mut self) -> bool {
        let coordinator = Arc::clone(&self.coordinator);
        let mut progress = coordinator.progress.lock().unwrap();
        if progress.persisted >= progress.requested {
            self.clear_running(&mut progress);
            return true;
        }
        if progress.requested > self.covered_generation {
            self.covered_generation = progress.requested;
            return false;
        }
        self.clear_running(&mut progress);
        true
    }

    fn finish(&mut self) {
        let coordinator = Arc::clone(&self.coordinator);
        let mut progress = coordinator.progress.lock().unwrap();
        self.clear_running(&mut progress);
    }
}

impl Drop for ProgressPersistenceWorker {
    fn drop(&mut self) {
        self.finish();
    }
}

#[derive(Clone, Default)]
struct PendingLogin {
    login_id: Arc<StdMutex<Option<String>>>,
    completion_task: Arc<StdMutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl PendingLogin {
    fn is_pending(&self) -> bool {
        self.login_id.lock().unwrap().is_some()
    }

    fn begin(
        &self,
        completion: LoginCompletion,
        persistence: ArtifactPersistence,
        account_operations: Arc<AsyncRwLock<()>>,
        persistence_coordinator: Arc<PersistenceCoordinator>,
    ) {
        let expected_login_id = completion.login_id().to_string();
        *self.login_id.lock().unwrap() = Some(expected_login_id.clone());
        let pending_login_id = Arc::clone(&self.login_id);
        let task = tokio::spawn(async move {
            let complete_and_persist = async move {
                completion.wait().await.map_err(|_| ())?;
                let _priority = persistence_coordinator.announce_high_priority();
                loop {
                    if commit_artifacts_when_stable(
                        &account_operations,
                        &persistence,
                        &persistence_coordinator,
                    )
                    .await
                    .is_ok()
                    {
                        return Ok::<(), ()>(());
                    }
                    tokio::time::sleep(LOGIN_PERSIST_RETRY_INTERVAL).await;
                }
            };
            let _ = tokio::time::timeout(LOGIN_COMPLETION_LIFETIME, complete_and_persist).await;
            let mut current_login_id = pending_login_id.lock().unwrap();
            if current_login_id.as_deref() == Some(expected_login_id.as_str()) {
                current_login_id.take();
            }
        });
        if let Some(previous) = self.completion_task.lock().unwrap().replace(task) {
            previous.abort();
        }
    }
}

#[derive(Clone)]
enum ArtifactPersistence {
    Device(EsimBridge),
    #[cfg(test)]
    Observer(Arc<std::sync::atomic::AtomicUsize>),
    #[cfg(test)]
    BlockingObserver {
        calls: Arc<std::sync::atomic::AtomicUsize>,
        entered: Arc<Semaphore>,
        release: Arc<Semaphore>,
    },
}

/// A successful ChatGPT turn can rotate the refresh token before the HTTP
/// caller receives a response. If that caller's stock deadline cancels this
/// handler, Drop schedules a fresh bounded retry of the idempotent fixed-set
/// snapshot. Voice/agentic responses wait for that commit. A completed
/// ProgressCue detaches its low-priority snapshot so Sol work cannot delay the
/// short cue response.
struct ArtifactPersistenceGuard {
    persistence: Option<(ArtifactPersistence, Arc<AsyncRwLock<()>>)>,
    persistence_coordinator: Arc<PersistenceCoordinator>,
    high_priority: Option<HighPriorityPersistence>,
    response_mode: LlmResponseMode,
}

impl ArtifactPersistence {
    async fn commit(
        &self,
        _stable_artifacts: &tokio::sync::RwLockWriteGuard<'_, ()>,
    ) -> Result<(), ()> {
        // Production callers hold the account-operation write gate while this
        // reads the fixed artifact set. Android still correlates the request by
        // id and treats a cancellation retry as an idempotent fresh snapshot.
        match self {
            Self::Device(bridge) => bridge
                .commit_persistent_artifacts(PERSISTENCE_TIMEOUT)
                .await
                .map(|_| ())
                .map_err(|_| ()),
            #[cfg(test)]
            Self::Observer(calls) => {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
            #[cfg(test)]
            Self::BlockingObserver {
                calls,
                entered,
                release,
            } => {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                entered.add_permits(1);
                let permit = release.acquire().await.map_err(|_| ())?;
                permit.forget();
                Ok(())
            }
        }
    }
}

async fn commit_artifacts_when_stable(
    account_operations: &AsyncRwLock<()>,
    persistence: &ArtifactPersistence,
    persistence_coordinator: &PersistenceCoordinator,
) -> Result<(), ()> {
    // Codex FileAuthStorage truncates and rewrites auth.json. Wait for every
    // model turn to finish, then exclude new turns while Android reads the
    // fixed artifact set, so the vault can never capture a partial rewrite.
    let stable_artifacts = account_operations.write().await;
    let result = persistence.commit(&stable_artifacts).await;
    if result.is_ok() {
        persistence_coordinator.mark_current_progress_persisted();
    }
    result
}

async fn commit_progress_artifacts_when_idle(
    account_operations: &AsyncRwLock<()>,
    persistence: &ArtifactPersistence,
    persistence_coordinator: &PersistenceCoordinator,
    worker: &mut ProgressPersistenceWorker,
) -> Result<(), ()> {
    let mut wait_deadline = tokio::time::Instant::now() + PROGRESS_PERSIST_LIFETIME;
    loop {
        // Never queue a low-priority cue writer. Tokio's write-preferring
        // queue would otherwise put it ahead of a newly arriving Sol/voice
        // model turn. try_write still guarantees the source files are idle.
        let now = tokio::time::Instant::now();
        if worker.finish_if_persisted() {
            return Ok(());
        }
        if now >= wait_deadline {
            if worker.finish_or_roll_deadline() {
                return Err(());
            }
            wait_deadline = now + PROGRESS_PERSIST_LIFETIME;
            continue;
        }
        tokio::time::sleep_until(std::cmp::min(
            wait_deadline,
            now + PROGRESS_PERSIST_RETRY_INTERVAL,
        ))
        .await;
        if tokio::time::Instant::now() >= wait_deadline {
            if worker.finish_or_roll_deadline() {
                return Err(());
            }
            wait_deadline = tokio::time::Instant::now() + PROGRESS_PERSIST_LIFETIME;
            continue;
        }
        if worker.finish_if_persisted() {
            return Ok(());
        }
        if persistence_coordinator.high_priority_waiting() {
            continue;
        }
        let Ok(stable_artifacts) = account_operations.try_write() else {
            continue;
        };
        if persistence_coordinator.high_priority_waiting() {
            drop(stable_artifacts);
            continue;
        }
        if worker.finish_if_persisted() {
            return Ok(());
        }
        let result = persistence.commit(&stable_artifacts).await;
        // Persisted/requested/worker_running transition under one mutex while
        // the source write guard is still held. This is the generation
        // handoff: a coalesced cue cannot be stranded behind a disappearing
        // worker after either a successful or failed vault attempt.
        if worker.finish_after_attempt(result.is_ok()) {
            return result;
        }
        drop(stable_artifacts);
        wait_deadline = tokio::time::Instant::now() + PROGRESS_PERSIST_LIFETIME;
    }
}

fn spawn_artifact_persistence(
    runtime: &tokio::runtime::Handle,
    persistence: ArtifactPersistence,
    account_operations: Arc<AsyncRwLock<()>>,
    persistence_coordinator: Arc<PersistenceCoordinator>,
    high_priority: Option<HighPriorityPersistence>,
    response_mode: LlmResponseMode,
) {
    match response_mode {
        LlmResponseMode::ProgressCue => {
            let Some(mut worker) = persistence_coordinator.request_progress_worker() else {
                return;
            };
            runtime.spawn(async move {
                let _ = commit_progress_artifacts_when_idle(
                    &account_operations,
                    &persistence,
                    &persistence_coordinator,
                    &mut worker,
                )
                .await;
            });
        }
        // The chat-turn loop shares the tool-free text path's persistence
        // behaviour exactly: it is the same `/chat` request under a different
        // bridge instruction, so its credential snapshot stays high priority.
        LlmResponseMode::VoiceAnswer
        | LlmResponseMode::AgenticJson
        | LlmResponseMode::ToolFreeText
        | LlmResponseMode::ToolStep => {
            let high_priority =
                high_priority.unwrap_or_else(|| persistence_coordinator.announce_high_priority());
            runtime.spawn(async move {
                let _high_priority = high_priority;
                let _ = commit_artifacts_when_stable(
                    &account_operations,
                    &persistence,
                    &persistence_coordinator,
                )
                .await;
            });
        }
    }
}

impl ArtifactPersistenceGuard {
    fn new(
        persistence: ArtifactPersistence,
        account_operations: Arc<AsyncRwLock<()>>,
        persistence_coordinator: Arc<PersistenceCoordinator>,
        response_mode: LlmResponseMode,
    ) -> Self {
        Self {
            persistence: Some((persistence, account_operations)),
            persistence_coordinator,
            high_priority: None,
            response_mode,
        }
    }

    fn announce_high_priority(&mut self) {
        if self.response_mode != LlmResponseMode::ProgressCue && self.high_priority.is_none() {
            self.high_priority = Some(self.persistence_coordinator.announce_high_priority());
        }
    }

    async fn commit(&mut self) -> Result<(), ()> {
        if self.response_mode == LlmResponseMode::ProgressCue {
            let runtime = tokio::runtime::Handle::try_current().map_err(|_| ())?;
            let Some((persistence, account_operations)) = self.persistence.take() else {
                return Err(());
            };
            spawn_artifact_persistence(
                &runtime,
                persistence,
                account_operations,
                Arc::clone(&self.persistence_coordinator),
                None,
                self.response_mode,
            );
            return Ok(());
        }

        self.announce_high_priority();
        let Some((persistence, account_operations)) = self.persistence.as_ref() else {
            return Err(());
        };
        let result = commit_artifacts_when_stable(
            account_operations,
            persistence,
            &self.persistence_coordinator,
        )
        .await;
        // A completed attempt, including a reported failure, preserves the
        // existing one-attempt request behavior. Cancellation while the future
        // is pending may have partially delivered that attempt, so Drop leaves
        // correctness to a fresh idempotent fixed-set snapshot request.
        self.persistence.take();
        self.high_priority.take();
        result
    }
}

impl Drop for ArtifactPersistenceGuard {
    fn drop(&mut self) {
        let Some((persistence, account_operations)) = self.persistence.take() else {
            return;
        };
        let response_mode = self.response_mode;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            if response_mode != LlmResponseMode::ProgressCue && self.high_priority.is_none() {
                self.high_priority = Some(self.persistence_coordinator.announce_high_priority());
            }
            spawn_artifact_persistence(
                &runtime,
                persistence,
                account_operations,
                Arc::clone(&self.persistence_coordinator),
                self.high_priority.take(),
                response_mode,
            );
        }
    }
}

fn bridge_router(state: BridgeState) -> Router {
    Router::new()
        .route("/challenge", get(challenge))
        .route("/status", get(status))
        .route("/login/device-code", post(device_code_login))
        .route("/chat", post(chat))
        .route(
            "/agentic-sessions/{session_id}/turn",
            post(agentic_session_turn),
        )
        .route(
            "/agentic-sessions/{session_id}",
            delete(finish_agentic_session),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

async fn challenge(State(state): State<BridgeState>, OriginalUri(uri): OriginalUri) -> Response {
    let Some(_permit) = acquire_request_permit(&state) else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Codex bridge is busy");
    };
    let target = uri.to_string();
    if target.len() > MAX_CHALLENGE_TARGET_BYTES {
        return error_response(StatusCode::BAD_REQUEST, "invalid challenge");
    }
    let Some(nonce) = target.strip_prefix("/challenge?nonce=") else {
        return error_response(StatusCode::BAD_REQUEST, "invalid challenge");
    };
    if !valid_challenge_nonce(nonce) {
        return error_response(StatusCode::BAD_REQUEST, "invalid challenge");
    }
    match challenge_proof(&state.token, nonce) {
        Some(proof) => json_response(StatusCode::OK, json!({ "proof": proof })),
        None => error_response(StatusCode::BAD_REQUEST, "invalid challenge"),
    }
}

async fn status(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    let Some(_permit) = acquire_request_permit(&state) else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Codex bridge is busy");
    };
    if !authorized(&headers, &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let account_operation = state.account_operations.read().await;
    if state.pending_login.is_pending() {
        return json_response(
            StatusCode::OK,
            json!({ "ready": false, "loginMode": null, "loginPending": true }),
        );
    }
    let account_status = state.app_server.account_status().await;
    let _high_priority = account_status
        .as_ref()
        .ok()
        .filter(|status| status.ready)
        .map(|_| state.persistence_coordinator.announce_high_priority());
    drop(account_operation);
    match account_status {
        Ok(status) => {
            if status.ready {
                let stable_artifacts = state.account_operations.write().await;
                if state.pending_login.is_pending() {
                    return json_response(
                        StatusCode::OK,
                        json!({ "ready": false, "loginMode": null, "loginPending": true }),
                    );
                }
                if state.persistence.commit(&stable_artifacts).await.is_err() {
                    return error_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Codex bridge request failed",
                    );
                }
                state
                    .persistence_coordinator
                    .mark_current_progress_persisted();
            }
            json_response(
                StatusCode::OK,
                json!({
                    "ready": status.ready,
                    "loginMode": status.login_mode,
                    "loginPending": false
                }),
            )
        }
        Err(_) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Codex bridge request failed",
        ),
    }
}

async fn device_code_login(
    State(state): State<BridgeState>,
    request: axum::extract::Request,
) -> Response {
    let Some(_permit) = acquire_request_permit(&state) else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Codex bridge is busy");
    };
    if !authorized(request.headers(), &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let body: Value = match read_json(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if !body.is_object() {
        return error_response(StatusCode::BAD_REQUEST, "JSON object required");
    }
    let _high_priority = state.persistence_coordinator.announce_high_priority();
    let _account_operation = state.account_operations.write().await;
    match state.app_server.start_device_code_login().await {
        Ok((login, completion)) => {
            // Correlate the official completion notification to this exact
            // loginId before persisting auth.json. This remains autonomous if
            // the dashboard closes and cannot mistake an old ready account for
            // completion of a reauthentication/account-switch flow.
            state.pending_login.begin(
                completion,
                state.persistence.clone(),
                Arc::clone(&state.account_operations),
                Arc::clone(&state.persistence_coordinator),
            );
            json_response(
                StatusCode::OK,
                json!({
                    "loginId": login.login_id,
                    "verificationUrl": login.verification_url,
                    "userCode": login.user_code
                }),
            )
        }
        Err(_) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Codex bridge request failed",
        ),
    }
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    model: Option<String>,
    messages: Vec<ChatMessageRequest>,
    #[serde(default, rename = "responseMode")]
    response_mode: LlmResponseMode,
    image: Option<ChatImageRequest>,
}

#[derive(Debug, Deserialize)]
struct ChatMessageRequest {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatImageRequest {
    media_type: String,
    data: String,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    text: String,
}

/// The distinct faults behind an undelivered chat answer. All of them return
/// the same 503 to the device, so the host log is the only place they stay
/// separable. Variants contain byte counts and error discriminants only, never
/// prompt or response text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatFailure {
    /// The app-server produced no answer at all.
    AppServer(AppServerError),
    /// An answer arrived but exceeded the bridge response cap.
    ResponseTooLarge { response_bytes: usize },
    /// The answer was deliverable but the artifact snapshot did not commit.
    Persistence { response_bytes: usize },
}

impl ChatFailure {
    /// A stable log key. `Debug` carries the detail; this is what a host-side
    /// grep counts.
    fn reason(self) -> &'static str {
        match self {
            Self::AppServer(_) => "app_server_error",
            Self::ResponseTooLarge { .. } => "response_too_large",
            Self::Persistence { .. } => "persistence_failed",
        }
    }
}

/// Reduces a chat attempt and its artifact snapshot to either the deliverable
/// answer or the one fault that stopped it. When several faults coincide the
/// earliest in this chain is reported; the HTTP outcome is identical either
/// way, only the log key differs.
fn chat_outcome(
    chat_result: Result<String, AppServerError>,
    persistence_result: Result<(), ()>,
) -> Result<String, ChatFailure> {
    let text = chat_result.map_err(ChatFailure::AppServer)?;
    if text.len() > MAX_RESPONSE_BYTES {
        return Err(ChatFailure::ResponseTooLarge {
            response_bytes: text.len(),
        });
    }
    if persistence_result.is_err() {
        return Err(ChatFailure::Persistence {
            response_bytes: text.len(),
        });
    }
    Ok(text)
}

fn retained_session_response_mode(response_mode: LlmResponseMode) -> bool {
    matches!(
        response_mode,
        LlmResponseMode::AgenticJson | LlmResponseMode::ToolStep
    )
}

async fn agentic_session_turn(
    State(state): State<BridgeState>,
    AxumPath(session_id): AxumPath<String>,
    request: axum::extract::Request,
) -> Response {
    let Some(_permit) = acquire_request_permit(&state) else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Codex bridge is busy");
    };
    if !authorized(request.headers(), &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if !canonical_agentic_session_id(&session_id) {
        return error_response(StatusCode::BAD_REQUEST, "invalid session");
    }
    let body: ChatRequest = match read_json(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if !retained_session_response_mode(body.response_mode) || body.image.is_some() {
        return error_response(StatusCode::BAD_REQUEST, "invalid agentic session request");
    }
    let messages = match bridge_messages(body.messages) {
        Some(messages) => messages,
        None => return error_response(StatusCode::BAD_REQUEST, "invalid message"),
    };
    let session = match state
        .agentic_sessions
        .get_or_create(&session_id, || {
            AgenticBridgeSession::new(ArtifactPersistenceGuard::new(
                state.persistence.clone(),
                Arc::clone(&state.account_operations),
                Arc::clone(&state.persistence_coordinator),
                body.response_mode,
            ))
        })
        .await
    {
        Ok(session) => session,
        Err(AgenticSessionLookupError::Capacity) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, "Codex bridge is busy");
        }
        Err(AgenticSessionLookupError::Retired) => {
            return error_response(StatusCode::GONE, "model session has finished");
        }
    };
    let Some(_activity) = session.begin_turn() else {
        return error_response(StatusCode::GONE, "model session has finished");
    };

    let account_operation = state.account_operations.read().await;
    if state.pending_login.is_pending() {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Codex login is still pending",
        );
    }
    let app_session = match session
        .app_session
        .get_or_try_init(|| async {
            state
                .app_server
                .start_chat_session(body.model.as_deref(), &messages, body.response_mode)
                .await
        })
        .await
    {
        Ok(session) => session,
        Err(error) => {
            warn!(
                reason = "session_start_failed",
                failure = ?error,
                "codex bridge agentic session could not start"
            );
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Codex bridge request failed",
            );
        }
    };
    let result = app_session
        .turn(body.model.as_deref(), &messages, None, body.response_mode)
        .await;
    drop(account_operation);
    // This path performs no artifact snapshot of its own, so persistence is
    // reported as succeeded and only the two answer-side faults can occur.
    match chat_outcome(result, Ok(())) {
        Ok(text) => json_response(StatusCode::OK, ChatResponse { text }),
        Err(failure) => {
            warn!(
                reason = failure.reason(),
                failure = ?failure,
                "codex bridge agentic turn failed"
            );
            error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Codex bridge request failed",
            )
        }
    }
}

async fn finish_agentic_session(
    State(state): State<BridgeState>,
    AxumPath(session_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let Some(_permit) = acquire_request_permit(&state) else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Codex bridge is busy");
    };
    if !authorized(&headers, &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if !canonical_agentic_session_id(&session_id) {
        return error_response(StatusCode::BAD_REQUEST, "invalid session");
    }
    let Some(session) = state
        .agentic_sessions
        .retire_if_same(&session_id, None)
        .await
    else {
        // A duplicate finish is an idempotent success. Tombstones still keep
        // delayed turns from recreating the retired provider thread.
        return json_response(StatusCode::OK, json!({ "finished": true }));
    };
    // Retirement and tombstoning are synchronous; cleanup itself is an owned
    // bridge task so the verified terminal answer keeps the stock five-second
    // delivery margin even when vault persistence needs its full timeout.
    // Dropping this JoinHandle detaches rather than aborts the finalizer.
    drop(spawn_agentic_finalization(session));
    json_response(StatusCode::OK, json!({ "finished": true }))
}

async fn chat(State(state): State<BridgeState>, request: axum::extract::Request) -> Response {
    let Some(_permit) = acquire_request_permit(&state) else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Codex bridge is busy");
    };
    if !authorized(request.headers(), &state.token) {
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let body: ChatRequest = match read_json(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let messages = match bridge_messages(body.messages) {
        Some(messages) => messages,
        None => return error_response(StatusCode::BAD_REQUEST, "invalid message"),
    };
    let image = match body.image.map(decode_chat_image).transpose() {
        Ok(image) => image,
        Err(()) => return error_response(StatusCode::BAD_REQUEST, "invalid image"),
    };
    let account_operation = state.account_operations.read().await;
    if state.pending_login.is_pending() {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Codex login is still pending",
        );
    }
    let mut persistence = ArtifactPersistenceGuard::new(
        state.persistence.clone(),
        Arc::clone(&state.account_operations),
        Arc::clone(&state.persistence_coordinator),
        body.response_mode,
    );
    let chat_result = state
        .app_server
        .chat(
            body.model.as_deref(),
            &messages,
            image.as_ref(),
            body.response_mode,
        )
        .await;
    persistence.announce_high_priority();
    drop(account_operation);
    // A refresh token can rotate before a later turn/model failure. Always
    // snapshot the fixed artifact set after an authenticated chat attempt so
    // the vault never restores an invalidated predecessor credential.
    let persistence_result = persistence.commit().await;
    // Every tool step that fails on device arrives here. The client-facing
    // status and body are unchanged; the named fault is logged so an oversized
    // answer, a failed snapshot and an app-server error stop being one
    // indistinguishable 503.
    match chat_outcome(chat_result, persistence_result) {
        Ok(text) => json_response(StatusCode::OK, ChatResponse { text }),
        Err(failure) => {
            warn!(
                reason = failure.reason(),
                failure = ?failure,
                "codex bridge chat request failed"
            );
            error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Codex bridge request failed",
            )
        }
    }
}

fn decode_chat_image(image: ChatImageRequest) -> Result<ChatImage, ()> {
    if image.data.is_empty() || image.data.len() > MAX_BODY_BYTES {
        return Err(());
    }
    let bytes = STANDARD.decode(image.data.as_bytes()).map_err(|_| ())?;
    if bytes.is_empty() || bytes.len() > MAX_CAMERA_IMAGE_BYTES {
        return Err(());
    }
    ChatImage::new(&image.media_type, bytes).map_err(|_| ())
}

fn bridge_messages(messages: Vec<ChatMessageRequest>) -> Option<Vec<ChatMessage>> {
    messages
        .into_iter()
        .map(|message| {
            let role = match message.role.as_str() {
                "system" => ChatRole::System,
                "user" => ChatRole::User,
                "assistant" => ChatRole::Assistant,
                _ => return None,
            };
            Some(ChatMessage {
                role,
                content: message.content,
            })
        })
        .collect()
}

async fn read_json<T: DeserializeOwned>(request: axum::extract::Request) -> Result<T, Response> {
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Err(error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body is too large",
        ));
    }
    let bytes = to_bytes(request.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|_| error_response(StatusCode::PAYLOAD_TOO_LARGE, "request body is too large"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| error_response(StatusCode::BAD_REQUEST, "invalid JSON"))
}

async fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "not found")
}

fn acquire_request_permit(state: &BridgeState) -> Option<tokio::sync::OwnedSemaphorePermit> {
    Arc::clone(&state.in_flight).try_acquire_owned().ok()
}

fn valid_challenge_nonce(nonce: &str) -> bool {
    if nonce.len() != CHALLENGE_NONCE_CHARS
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return false;
    }
    URL_SAFE_NO_PAD
        .decode(nonce)
        .ok()
        .filter(|decoded| decoded.len() == CHALLENGE_NONCE_BYTES)
        .is_some_and(|decoded| URL_SAFE_NO_PAD.encode(decoded) == nonce)
}

fn canonical_agentic_session_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|parsed| {
        parsed.get_version_num() == 4 && parsed.hyphenated().to_string() == value
    })
}

fn challenge_proof(token: &str, nonce: &str) -> Option<String> {
    let nonce = URL_SAFE_NO_PAD.decode(nonce).ok()?;
    if nonce.len() != CHALLENGE_NONCE_BYTES {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).ok()?;
    mac.update(CHALLENGE_DOMAIN);
    mac.update(&nonce);
    Some(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    let Some(actual) = headers.get(header::AUTHORIZATION) else {
        let _ = expected.as_bytes().ct_eq(expected.as_bytes());
        return false;
    };
    let actual = actual.as_bytes();
    if actual.len() != expected.len() {
        let _ = expected.as_bytes().ct_eq(expected.as_bytes());
        return false;
    }
    bool::from(actual.ct_eq(expected.as_bytes()))
}

fn json_response<T: Serialize>(status: StatusCode, body: T) -> Response {
    let mut response = (status, Json(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn error_response(status: StatusCode, message: &'static str) -> Response {
    json_response(status, json!({ "error": message }))
}

impl From<AppServerError> for LocalCodexError {
    fn from(_: AppServerError) -> Self {
        Self::AppServer
    }
}

impl From<ProxyError> for LocalCodexError {
    fn from(_: ProxyError) -> Self {
        Self::Proxy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "unit-test-bridge-token-0123456789abcdef";
    const NONCE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const PROOF: &str = "JERTounjAunEGgqk4ZJDi8WSWbYnPeLD_sbDxbNzTNU";

    struct HandlerDropObservation(Arc<AtomicBool>);

    impl Drop for HandlerDropObservation {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn challenge_matches_existing_bridge_protocol_vector() {
        assert!(valid_challenge_nonce(NONCE));
        assert_eq!(challenge_proof(TOKEN, NONCE).as_deref(), Some(PROOF));
        assert!(!valid_challenge_nonce("invalid"));
    }

    #[test]
    fn bearer_auth_is_exact_and_message_roles_are_bounded_to_known_values() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {TOKEN}")).unwrap(),
        );
        assert!(authorized(&headers, TOKEN));
        assert!(!authorized(&headers, "wrong-token-0123456789abcdefghijkl"));

        assert!(bridge_messages(vec![ChatMessageRequest {
            role: "user".into(),
            content: "hello".into(),
        }])
        .is_some());
        assert!(bridge_messages(vec![ChatMessageRequest {
            role: "tool".into(),
            content: "hello".into(),
        }])
        .is_none());
    }

    #[test]
    fn chat_response_mode_defaults_to_voice_and_accepts_known_modes_only() {
        let voice: ChatRequest = serde_json::from_value(json!({
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .unwrap();
        assert_eq!(voice.response_mode, LlmResponseMode::VoiceAnswer);

        let agentic: ChatRequest = serde_json::from_value(json!({
            "responseMode": "agentic_json",
            "messages": [{"role": "user", "content": "plan one step"}]
        }))
        .unwrap();
        assert_eq!(agentic.response_mode, LlmResponseMode::AgenticJson);

        let progress: ChatRequest = serde_json::from_value(json!({
            "responseMode": "progress_cue",
            "messages": [{"role": "user", "content": "weather"}]
        }))
        .unwrap();
        assert_eq!(progress.response_mode, LlmResponseMode::ProgressCue);

        let tool_free: ChatRequest = serde_json::from_value(json!({
            "responseMode": "tool_free_text",
            "messages": [{"role": "user", "content": "classify"}]
        }))
        .unwrap();
        assert_eq!(tool_free.response_mode, LlmResponseMode::ToolFreeText);

        let tool_step_request: ChatRequest = serde_json::from_value(json!({
            "responseMode": "hermes_tool_loop",
            "messages": [{"role": "user", "content": "what is the weather"}]
        }))
        .unwrap();
        assert_eq!(tool_step_request.response_mode, LlmResponseMode::ToolStep);
        assert_eq!(
            serde_json::to_value(LlmResponseMode::ToolStep).unwrap(),
            json!("hermes_tool_loop")
        );
        assert!(retained_session_response_mode(LlmResponseMode::AgenticJson));
        assert!(retained_session_response_mode(LlmResponseMode::ToolStep));
        for one_shot_mode in [
            LlmResponseMode::VoiceAnswer,
            LlmResponseMode::ProgressCue,
            LlmResponseMode::ToolFreeText,
        ] {
            assert!(
                !retained_session_response_mode(one_shot_mode),
                "{one_shot_mode:?} must remain on the one-shot bridge path"
            );
        }

        assert!(serde_json::from_value::<ChatRequest>(json!({
            "responseMode": "markdown",
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .is_err());

        // Fail closed on the one mode whose bridge instruction permits tool
        // calls: an absent mode is VoiceAnswer, and no near-miss spelling may
        // resolve to it. A `#[serde(other)]` or a defaulted boolean here would
        // let a stale caller silently reach the tool-permitting instruction.
        assert_ne!(voice.response_mode, LlmResponseMode::ToolStep);
        for near_miss in [
            "tool_step",
            "toolStepLoop",
            "ToolStep",
            "tool-step-loop",
            "tool_loop",
            "",
        ] {
            assert!(
                serde_json::from_value::<ChatRequest>(json!({
                    "responseMode": near_miss,
                    "messages": [{"role": "user", "content": "hello"}]
                }))
                .is_err(),
                "{near_miss} must not deserialize"
            );
        }
    }

    #[tokio::test]
    async fn timed_out_http_client_drops_the_inflight_bridge_handler() {
        let dropped = Arc::new(AtomicBool::new(false));
        let handler_dropped = Arc::clone(&dropped);
        let app = Router::new().route(
            "/pending",
            post(move || {
                let dropped = Arc::clone(&handler_dropped);
                async move {
                    let _observation = HandlerDropObservation(dropped);
                    std::future::pending::<StatusCode>().await
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let error = reqwest::Client::new()
            .post(format!("http://{address}/pending"))
            .timeout(Duration::from_millis(500))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_timeout());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !dropped.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("client cancellation must drop the bridge handler future");

        server.abort();
    }

    fn observed_agentic_persistence(
        calls: Arc<std::sync::atomic::AtomicUsize>,
        account_operations: Arc<AsyncRwLock<()>>,
        coordinator: Arc<PersistenceCoordinator>,
    ) -> ArtifactPersistenceGuard {
        ArtifactPersistenceGuard::new(
            ArtifactPersistence::Observer(calls),
            account_operations,
            coordinator,
            LlmResponseMode::AgenticJson,
        )
    }

    #[test]
    fn agentic_session_ids_are_canonical_server_uuid_v4_values() {
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        assert!(canonical_agentic_session_id(&id));
        assert!(!canonical_agentic_session_id(&id.to_uppercase()));
        assert!(!canonical_agentic_session_id("user-selected-session"));
        assert!(!canonical_agentic_session_id(
            "00000000-0000-0000-0000-000000000000"
        ));
    }

    #[tokio::test]
    async fn agentic_session_retirement_tombstones_and_persists_exactly_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let registry = Arc::new(AgenticSessionRegistry::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let account_operations = Arc::new(AsyncRwLock::new(()));
        let coordinator = Arc::new(PersistenceCoordinator::default());
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        let session = registry
            .get_or_create(&id, || {
                AgenticBridgeSession::new(observed_agentic_persistence(
                    Arc::clone(&calls),
                    Arc::clone(&account_operations),
                    Arc::clone(&coordinator),
                ))
            })
            .await
            .unwrap();
        let same = registry
            .get_or_create(&id, || unreachable!("must reuse active session"))
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&session, &same));

        let retired = registry.retire_if_same(&id, Some(&session)).await.unwrap();
        assert!(spawn_agentic_finalization(retired).await.unwrap().is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(registry.retire_if_same(&id, None).await.is_none());
        assert!(matches!(
            registry
                .get_or_create(&id, || unreachable!("tombstone must reject reuse"))
                .await,
            Err(AgenticSessionLookupError::Retired)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn finish_before_first_turn_tombstones_delayed_session_creation() {
        let registry = Arc::new(AgenticSessionRegistry::default());
        let id = uuid::Uuid::new_v4().hyphenated().to_string();

        assert!(registry.retire_if_same(&id, None).await.is_none());
        assert!(matches!(
            registry
                .get_or_create(&id, || unreachable!("a delayed turn must stay retired"))
                .await,
            Err(AgenticSessionLookupError::Retired)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn idle_agentic_session_ttl_retires_and_persists_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let registry = Arc::new(AgenticSessionRegistry::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let account_operations = Arc::new(AsyncRwLock::new(()));
        let coordinator = Arc::new(PersistenceCoordinator::default());
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        registry
            .get_or_create(&id, || {
                AgenticBridgeSession::new(observed_agentic_persistence(
                    Arc::clone(&calls),
                    Arc::clone(&account_operations),
                    Arc::clone(&coordinator),
                ))
            })
            .await
            .unwrap();

        tokio::time::advance(AGENTIC_SESSION_IDLE_TTL).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(matches!(
            registry
                .get_or_create(&id, || unreachable!("expired id must remain tombstoned"))
                .await,
            Err(AgenticSessionLookupError::Retired)
        ));
    }

    #[tokio::test]
    async fn agentic_session_registry_enforces_active_cap() {
        use std::sync::atomic::AtomicUsize;

        let registry = Arc::new(AgenticSessionRegistry::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let account_operations = Arc::new(AsyncRwLock::new(()));
        let coordinator = Arc::new(PersistenceCoordinator::default());
        let mut ids = Vec::new();
        for _ in 0..MAX_ACTIVE_AGENTIC_SESSIONS {
            let id = uuid::Uuid::new_v4().hyphenated().to_string();
            registry
                .get_or_create(&id, || {
                    AgenticBridgeSession::new(observed_agentic_persistence(
                        Arc::clone(&calls),
                        Arc::clone(&account_operations),
                        Arc::clone(&coordinator),
                    ))
                })
                .await
                .unwrap();
            ids.push(id);
        }
        let overflow = uuid::Uuid::new_v4().hyphenated().to_string();
        assert!(matches!(
            registry
                .get_or_create(&overflow, || unreachable!("capacity must reject creation"))
                .await,
            Err(AgenticSessionLookupError::Capacity)
        ));

        for id in ids {
            let session = registry.retire_if_same(&id, None).await.unwrap();
            assert!(spawn_agentic_finalization(session).await.unwrap().is_ok());
        }
    }

    #[tokio::test]
    async fn artifact_persistence_commits_once_normally_and_retries_after_handler_cancellation() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let account_operations = Arc::new(AsyncRwLock::new(()));
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let normal_calls = Arc::new(AtomicUsize::new(0));
        {
            let mut guard = ArtifactPersistenceGuard::new(
                ArtifactPersistence::Observer(Arc::clone(&normal_calls)),
                Arc::clone(&account_operations),
                Arc::clone(&persistence_coordinator),
                LlmResponseMode::VoiceAnswer,
            );
            assert!(guard.commit().await.is_ok());
        }
        assert_eq!(normal_calls.load(Ordering::SeqCst), 1);

        let canceled_calls = Arc::new(AtomicUsize::new(0));
        let guard = ArtifactPersistenceGuard::new(
            ArtifactPersistence::Observer(Arc::clone(&canceled_calls)),
            Arc::clone(&account_operations),
            Arc::clone(&persistence_coordinator),
            LlmResponseMode::VoiceAnswer,
        );
        drop(guard);
        tokio::time::timeout(Duration::from_secs(1), async {
            while canceled_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(canceled_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn parallel_chats_finish_before_high_priority_snapshot_blocks_new_chats() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let account_operations = Arc::new(AsyncRwLock::new(()));
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());

        // Model a ProgressCue turn that remains busy while an AgenticJson turn
        // reaches the authenticated-chat gate. Both are shared account reads,
        // so the second turn must be admitted immediately.
        let progress_cue = account_operations.read().await;
        let agentic_turn = account_operations
            .try_read()
            .expect("authenticated chats must be concurrent");

        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_entered = Arc::new(Semaphore::new(0));
        let snapshot_release = Arc::new(Semaphore::new(0));
        let persistence = ArtifactPersistence::BlockingObserver {
            calls: Arc::clone(&snapshot_calls),
            entered: Arc::clone(&snapshot_entered),
            release: Arc::clone(&snapshot_release),
        };
        let snapshot_gate = Arc::clone(&account_operations);
        let snapshot_coordinator = Arc::clone(&persistence_coordinator);
        let snapshot_task = tokio::spawn(async move {
            commit_artifacts_when_stable(&snapshot_gate, &persistence, &snapshot_coordinator).await
        });

        // Wait until the snapshot writer is queued. Existing readers keep it
        // out, and Tokio's fair write-preferring queue keeps later readers out.
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match account_operations.try_read() {
                    Ok(read) => drop(read),
                    Err(_) => break,
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("snapshot writer must enter the lock queue");
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 0);

        let new_reader_gate = Arc::clone(&account_operations);
        let (reader_attempted_tx, reader_attempted_rx) = tokio::sync::oneshot::channel();
        let (reader_admitted_tx, mut reader_admitted_rx) = tokio::sync::oneshot::channel();
        let new_reader = tokio::spawn(async move {
            let _ = reader_attempted_tx.send(());
            let _read = new_reader_gate.read().await;
            let _ = reader_admitted_tx.send(());
        });
        reader_attempted_rx.await.unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(
            reader_admitted_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        // The writer cannot snapshot while either model turn may still be
        // truncating and rewriting auth.json.
        drop(progress_cue);
        tokio::task::yield_now().await;
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 0);
        drop(agentic_turn);

        let entered = tokio::time::timeout(Duration::from_secs(1), snapshot_entered.acquire())
            .await
            .expect("stable snapshot must start after both chats finish")
            .unwrap();
        entered.forget();
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 1);
        assert!(matches!(
            reader_admitted_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));

        snapshot_release.add_permits(1);
        assert!(snapshot_task.await.unwrap().is_ok());
        tokio::time::timeout(Duration::from_secs(1), &mut reader_admitted_rx)
            .await
            .expect("new chat must proceed after stable snapshot")
            .unwrap();
        new_reader.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn low_priority_progress_snapshot_yields_to_new_agentic_chat() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let account_operations = Arc::new(AsyncRwLock::new(()));
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let finished_cue = account_operations.read().await;
        drop(finished_cue);

        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_entered = Arc::new(Semaphore::new(0));
        let snapshot_release = Arc::new(Semaphore::new(0));
        let persistence = ArtifactPersistence::BlockingObserver {
            calls: Arc::clone(&snapshot_calls),
            entered: Arc::clone(&snapshot_entered),
            release: Arc::clone(&snapshot_release),
        };
        let snapshot_gate = Arc::clone(&account_operations);
        let snapshot_coordinator = Arc::clone(&persistence_coordinator);
        let mut worker = snapshot_coordinator.request_progress_worker().unwrap();
        let snapshot_task = tokio::spawn(async move {
            commit_progress_artifacts_when_idle(
                &snapshot_gate,
                &persistence,
                &snapshot_coordinator,
                &mut worker,
            )
            .await
        });

        // Let the cue persistence task enter its low-priority retry interval.
        // Even a Sol request arriving 100ms later still enters first.
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(100)).await;
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 0);
        let agentic_turn = account_operations
            .try_read()
            .expect("agentic chat must bypass pending cue persistence");
        tokio::time::advance(Duration::from_millis(400)).await;
        tokio::task::yield_now().await;
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 0);

        // The cue snapshot remains forbidden while Sol may rewrite auth.json.
        drop(agentic_turn);
        tokio::time::advance(PROGRESS_PERSIST_RETRY_INTERVAL).await;
        let entered = snapshot_entered.acquire().await.unwrap();
        entered.forget();
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 1);
        assert!(account_operations.try_read().is_err());

        snapshot_release.add_permits(1);
        assert!(snapshot_task.await.unwrap().is_ok());
        assert!(account_operations.try_read().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn high_priority_snapshot_supersedes_coalesced_progress_work() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let account_operations = Arc::new(AsyncRwLock::new(()));
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let low_calls = Arc::new(AtomicUsize::new(0));
        let low_persistence = ArtifactPersistence::Observer(Arc::clone(&low_calls));
        let low_gate = Arc::clone(&account_operations);
        let low_coordinator = Arc::clone(&persistence_coordinator);
        let mut low_worker = low_coordinator.request_progress_worker().unwrap();
        let low_task = tokio::spawn(async move {
            commit_progress_artifacts_when_idle(
                &low_gate,
                &low_persistence,
                &low_coordinator,
                &mut low_worker,
            )
            .await
        });

        // A second cue only advances the requested generation. It does not
        // create another polling worker or a redundant vault commit.
        assert!(persistence_coordinator.request_progress_worker().is_none());
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(100)).await;

        let agentic_turn = account_operations.read().await;
        let high_priority = persistence_coordinator.announce_high_priority();
        drop(agentic_turn);
        let high_calls = Arc::new(AtomicUsize::new(0));
        assert!(commit_artifacts_when_stable(
            &account_operations,
            &ArtifactPersistence::Observer(Arc::clone(&high_calls)),
            &persistence_coordinator,
        )
        .await
        .is_ok());
        drop(high_priority);
        assert_eq!(high_calls.load(Ordering::SeqCst), 1);

        tokio::time::advance(Duration::from_millis(400)).await;
        assert!(low_task.await.unwrap().is_ok());
        assert_eq!(low_calls.load(Ordering::SeqCst), 0);

        // The single-flight slot is released after the covered generations
        // are observed, so a genuinely newer cue can schedule fresh work.
        let next_worker = persistence_coordinator
            .request_progress_worker()
            .expect("new cue generation must be schedulable");
        drop(next_worker);
    }

    #[test]
    fn progress_generation_handoff_cannot_strand_a_new_snapshot_request() {
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let mut worker = persistence_coordinator
            .request_progress_worker()
            .expect("first cue starts the single-flight worker");

        // Model the former race exactly: a high-priority snapshot covers the
        // first generation, then a new cue observes the still-running worker
        // immediately before that worker tries to finish.
        persistence_coordinator.mark_current_progress_persisted();
        assert!(persistence_coordinator.request_progress_worker().is_none());

        // The persisted check and worker handoff are one mutex transition.
        // Generation two remains owned by this worker instead of being left
        // with requested > persisted and worker_running = false.
        assert!(!worker.finish_if_persisted());
        assert!(persistence_coordinator.progress_worker_running());
        assert!(worker.finish_after_attempt(true));
        assert!(!persistence_coordinator.progress_worker_running());

        let next_worker = persistence_coordinator
            .request_progress_worker()
            .expect("a later generation can start a fresh worker");
        drop(next_worker);
    }

    #[test]
    fn progress_generation_at_old_deadline_receives_a_fresh_owned_window() {
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let mut worker = persistence_coordinator
            .request_progress_worker()
            .expect("first cue starts the single-flight worker");
        assert!(persistence_coordinator.request_progress_worker().is_none());

        assert!(!worker.finish_or_roll_deadline());
        assert!(persistence_coordinator.progress_worker_running());
        assert!(worker.finish_after_attempt(true));
        assert!(!persistence_coordinator.progress_worker_running());
    }

    #[tokio::test(start_paused = true)]
    async fn progress_response_detaches_snapshot_while_agentic_chat_is_active() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let account_operations = Arc::new(AsyncRwLock::new(()));
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let agentic_turn = account_operations.read().await;
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let snapshot_entered = Arc::new(Semaphore::new(0));
        let snapshot_release = Arc::new(Semaphore::new(0));
        let mut persistence = ArtifactPersistenceGuard::new(
            ArtifactPersistence::BlockingObserver {
                calls: Arc::clone(&snapshot_calls),
                entered: Arc::clone(&snapshot_entered),
                release: Arc::clone(&snapshot_release),
            },
            Arc::clone(&account_operations),
            Arc::clone(&persistence_coordinator),
            LlmResponseMode::ProgressCue,
        );

        // Scheduling durability is the completed ProgressCue path. It must
        // return before the concurrent Sol turn releases its model read guard.
        assert!(persistence.commit().await.is_ok());
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 0);

        drop(agentic_turn);
        tokio::task::yield_now().await;
        tokio::time::advance(PROGRESS_PERSIST_RETRY_INTERVAL).await;
        let entered = snapshot_entered.acquire().await.unwrap();
        entered.forget();
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 1);

        snapshot_release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match account_operations.try_read() {
                    Ok(read) => {
                        drop(read);
                        break;
                    }
                    Err(_) => tokio::task::yield_now().await,
                }
            }
        })
        .await
        .expect("detached stable snapshot must finish");
    }

    #[tokio::test(start_paused = true)]
    async fn detached_progress_snapshot_is_single_flight_and_lifetime_bounded() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let account_operations = Arc::new(AsyncRwLock::new(()));
        let persistence_coordinator = Arc::new(PersistenceCoordinator::default());
        let active_model = account_operations.read().await;
        let snapshot_calls = Arc::new(AtomicUsize::new(0));
        let mut persistence = ArtifactPersistenceGuard::new(
            ArtifactPersistence::Observer(Arc::clone(&snapshot_calls)),
            Arc::clone(&account_operations),
            Arc::clone(&persistence_coordinator),
            LlmResponseMode::ProgressCue,
        );
        assert!(persistence.commit().await.is_ok());
        tokio::task::yield_now().await;
        assert!(persistence_coordinator.progress_worker_running());

        tokio::time::advance(PROGRESS_PERSIST_LIFETIME).await;
        tokio::task::yield_now().await;
        assert!(!persistence_coordinator.progress_worker_running());
        assert_eq!(snapshot_calls.load(Ordering::SeqCst), 0);

        drop(active_model);
        let next_worker = persistence_coordinator
            .request_progress_worker()
            .expect("bounded worker must release the single-flight slot");
        drop(next_worker);
    }

    #[test]
    fn camera_image_bridge_decodes_only_matching_bounded_images() {
        assert!(decode_chat_image(ChatImageRequest {
            media_type: "image/jpeg".into(),
            data: STANDARD.encode([0xff, 0xd8, 0xff, 0xdb]),
        })
        .is_ok());

        assert!(decode_chat_image(ChatImageRequest {
            media_type: "image/png".into(),
            data: STANDARD.encode([0xff, 0xd8, 0xff]),
        })
        .is_err());
        assert!(decode_chat_image(ChatImageRequest {
            media_type: "image/jpeg".into(),
            data: "not-base64".into(),
        })
        .is_err());
    }

    #[test]
    fn chat_outcome_names_each_fault_that_shares_the_one_client_facing_503() {
        assert_eq!(
            chat_outcome(Ok("answer".into()), Ok(())),
            Ok("answer".into())
        );

        // An oversized success and a failed model step used to be the same
        // wildcard. They must not report the same reason.
        let oversized = chat_outcome(Ok("x".repeat(MAX_RESPONSE_BYTES + 1)), Ok(()));
        assert_eq!(
            oversized,
            Err(ChatFailure::ResponseTooLarge {
                response_bytes: MAX_RESPONSE_BYTES + 1,
            })
        );
        let chat_error = chat_outcome(Err(AppServerError::TimedOut), Ok(()));
        assert_eq!(
            chat_error,
            Err(ChatFailure::AppServer(AppServerError::TimedOut))
        );
        assert_ne!(
            oversized.unwrap_err().reason(),
            chat_error.unwrap_err().reason()
        );

        // A deliverable answer whose artifact snapshot failed is a third fault.
        assert_eq!(
            chat_outcome(Ok("answer".into()), Err(())),
            Err(ChatFailure::Persistence { response_bytes: 6 })
        );

        // The app-server variant survives into the log, so a transport fault is
        // distinguishable from a deadline.
        assert_ne!(
            chat_outcome(Err(AppServerError::Transport), Ok(())),
            chat_outcome(Err(AppServerError::TimedOut), Ok(()))
        );
    }

    #[test]
    fn chat_failure_reasons_are_distinct_and_contain_no_response_text() {
        let failures = [
            ChatFailure::AppServer(AppServerError::Protocol),
            ChatFailure::ResponseTooLarge {
                response_bytes: 512,
            },
            ChatFailure::Persistence {
                response_bytes: 512,
            },
        ];
        let mut reasons: Vec<&str> = failures.iter().map(|failure| failure.reason()).collect();
        reasons.sort_unstable();
        reasons.dedup();
        assert_eq!(reasons.len(), failures.len());

        // `Debug` is what reaches logcat. It must expose discriminants and byte
        // counts only, never the prompt or the answer.
        let secret = "SUPER-SECRET-ANSWER-PROSE";
        let oversized = secret.repeat(MAX_RESPONSE_BYTES / secret.len() + 1);
        assert!(oversized.len() > MAX_RESPONSE_BYTES);
        let rejected = chat_outcome(Ok(oversized), Ok(())).unwrap_err();
        let rendered = format!("{rejected:?}");
        assert!(!rendered.contains(secret), "{rendered}");
        assert!(rendered.contains("ResponseTooLarge"), "{rendered}");
        let failed = chat_outcome(Err(AppServerError::RequestFailed), Ok(())).unwrap_err();
        assert_eq!(format!("{failed:?}"), "AppServer(RequestFailed)");
    }
}
