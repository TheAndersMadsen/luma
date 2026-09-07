//! An owner-approved input and shared-display surface. Platform code owns the
//! installation key, secure journal, foreground state and actual rendering;
//! this crate owns admission, exact retries, frame checks and RTC fencing.
pub mod action;
pub mod display;
mod http;
pub mod speech;
mod state;
#[cfg(test)]
mod tests;
mod transport;
mod wire;

pub use action::{
    ActionPolicy, Attestation, CommandPolicy, Confirmation, DeclineReason, Description,
    DevicePolicy, Evidence, Locator, Operation, PlaybackState, PolicyApp, PolicyDocument,
    PolicyEntry, PolicyRoot, Position, Report, ReportOutcome, RevokeReason, Revoked, Risk, Task,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
pub use display::{
    AttributionPart, ChoiceItem, Display, DisplayContent, Invitation, InvitationKind, PlaceItem,
    Privacy, SurfacePlatform, TurnState, TurnStatus,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
pub use speech::Speech;
use state::{ContextKind, ContextWire, Journal, PendingOpen, RpcMessage};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const MAX_JOURNAL_BYTES: usize = 32 * 1024;
pub const MAX_TEXT_BYTES: usize = 4000;
/// Screen context bounds, byte-for-byte the runtime's.
pub const MAX_CONTEXT_APP_BYTES: usize = 64;
pub const MAX_CONTEXT_BYTES: usize = 8000;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const RECEIPT_MS: i64 = 300_000;
const LEASE_MS: i64 = 45_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Macos,
    Linux,
    Android,
    AndroidTv,
}

impl Platform {
    /// The wire spelling, also accepted as an explicit request target.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Linux => "linux",
            Self::Android => "android",
            Self::AndroidTv => "android_tv",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "macos" => Self::Macos,
            "linux" => Self::Linux,
            "android" => Self::Android,
            "android_tv" => Self::AndroidTv,
            _ => return None,
        })
    }
}

/// Bounded text from this installation's own screen, sent with one request.
/// It makes the turn private: the reply can appear only on a personal
/// surface, and the text reaches cognition only under the owner's
/// screen-context permission for this installation. No Debug: screen text.
#[derive(Clone, PartialEq, Eq)]
pub struct ScreenContext {
    pub app: String,
    pub text: String,
}

#[derive(Clone)]
pub struct Config {
    pub server_origin: String,
    pub enrollment_id: Uuid,
    pub platform: Platform,
    /// The platform boot/session identity, stable across process restarts.
    pub boot_epoch: Uuid,
}

#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("platform secure storage or signing unavailable")]
pub struct PlatformError;

pub trait Signer: Send + Sync {
    fn public_key_sec1(&self) -> Result<[u8; 65], PlatformError>;
    /// Sign the complete message with ECDSA P-256/SHA-256 exactly once and
    /// return canonical DER. The private key must remain platform-owned.
    fn sign_sha256(&self, message: &[u8]) -> Result<Vec<u8>, PlatformError>;
}

pub trait SecureStore: Send + Sync {
    /// Callers must hold exclusive ownership of this installation's journal.
    /// An unavailable/locked store is an error, never an absent journal.
    fn load(&self) -> Result<Option<Vec<u8>>, PlatformError>;
    /// Atomically preserve these exact nonempty bytes in platform secure
    /// storage. An uncertain failure must only permit this identical retry.
    fn save_atomically(&self, bytes: &[u8]) -> Result<(), PlatformError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid surface configuration")]
    InvalidConfig,
    #[error("invalid server response")]
    InvalidResponse,
    #[error("installation signature unavailable or invalid")]
    InvalidSignature,
    #[error("secure journal unavailable")]
    Persistence,
    #[error("invalid secure journal")]
    InvalidJournal,
    #[error("surface service unavailable")]
    Unavailable,
    #[error("surface approval unavailable")]
    Denied,
    #[error("surface connection is stale")]
    Stale,
    #[error("surface service busy")]
    Busy,
    #[error("a request needs explicit reconciliation")]
    Pending,
    #[error("no pending request")]
    NoPending,
    #[error("request receipt has expired")]
    Expired,
    #[error("surface is disconnected")]
    Disconnected,
    #[error("invalid surface input")]
    InvalidInput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub enrollment_id: Uuid,
    pub public_key: String,
    pub platform: Platform,
    pub approval: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Admission {
    pub turn_id: Uuid,
    pub generation: u64,
    pub duplicate: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Text,
    Heartbeat,
    Cancel,
    State,
    Acknowledge,
    Report,
    Grant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub kind: OperationKind,
    pub instance_id: Uuid,
    pub sequence: u64,
    pub can_retry: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OperationResult {
    Text(Admission),
    Heartbeat,
    Cancel,
    State(bool),
    Acknowledge,
    Report,
    Grant,
}

#[derive(Clone, Debug)]
pub struct Status {
    pub connected: bool,
    pub pending: Option<Pending>,
    pub last_unknown: Option<Pending>,
    pub pending_open: bool,
    pub needs_reconnect: bool,
    /// A committed admission retained even when saving its reply needed retry.
    pub last_admission: Option<Admission>,
    /// The card the runtime delivered to this connection, if still current.
    pub display: Option<Display>,
    /// The spoken reply the runtime delivered to this connection, if current.
    pub speech: Option<Speech>,
    /// A current private continuation invitation, if any.
    pub invitation: Option<Invitation>,
    /// The command this installation was asked to carry out, if current.
    pub task: Option<Task>,
    /// The ceremony this installation is the venue for, if current.
    pub confirmation: Option<Confirmation>,
    /// The last command the runtime told this installation to stop, and why.
    pub revoked: Option<action::Revoked>,
    /// The owner's own policy for this installation, as the runtime last
    /// delivered it on this connection. `None` is an ordinary state and
    /// means this installation may do nothing at all.
    pub policy: Option<action::PolicyDocument>,
    /// The foreground visibility Cosmos last accepted for this connection.
    pub visible: bool,
    /// The committed status of this installation's own current turn.
    pub turn_status: Option<TurnStatus>,
}

/// Callback-free transport completion. Retain this scope outside an owned
/// Tokio runtime's task and drop Client before finishing it. If a UI stops
/// waiting, the runtime must stay alive until this completion is observed.
#[derive(Clone)]
pub struct TransportShutdown {
    scope: transport::CleanupScope,
}

impl TransportShutdown {
    pub fn pending(&self) -> bool {
        self.scope.pending()
    }
    pub async fn finish(&self) -> Result<(), Error> {
        self.scope.finish().await
    }
}

/// No Debug: the journal contains session secrets and user-authored text.
pub struct Client {
    config: Config,
    public_key: [u8; 65],
    signer: Arc<dyn Signer>,
    store: Arc<dyn SecureStore>,
    http: http::Http,
    journal: Journal,
    failed_save: Option<Journal>,
    session: Option<transport::Connection>,
    cleanup: transport::CleanupScope,
    display: tokio::sync::watch::Sender<Option<Display>>,
    speech: tokio::sync::watch::Sender<Option<Speech>>,
    invitation: tokio::sync::watch::Sender<Option<Invitation>>,
    turn_status: tokio::sync::watch::Sender<Option<TurnStatus>>,
    task: tokio::sync::watch::Sender<Option<Task>>,
    confirmation: tokio::sync::watch::Sender<Option<Confirmation>>,
    revoked: tokio::sync::watch::Sender<Option<action::Revoked>>,
    policy: tokio::sync::watch::Sender<Option<action::PolicyDocument>>,
    visible: bool,
}

impl Client {
    pub fn new(
        config: Config,
        signer: Arc<dyn Signer>,
        store: Arc<dyn SecureStore>,
    ) -> Result<Self, Error> {
        Self::with_http(config, signer, store, http::Http::new()?)
    }

    /// Explicitly trust one additional HTTPS bootstrap PEM root, retaining
    /// normal certificate and hostname verification. SDK WSS trust is
    /// unchanged. Platform shells normally use `new`.
    pub fn new_with_root_certificate(
        config: Config,
        signer: Arc<dyn Signer>,
        store: Arc<dyn SecureStore>,
        pem: &[u8],
    ) -> Result<Self, Error> {
        Self::with_http(
            config,
            signer,
            store,
            http::Http::with_root_certificate(pem)?,
        )
    }

    fn with_http(
        mut config: Config,
        signer: Arc<dyn Signer>,
        store: Arc<dyn SecureStore>,
        http: http::Http,
    ) -> Result<Self, Error> {
        config.server_origin = wire::canonical_origin(&config.server_origin)?;
        if config.enrollment_id.is_nil() || config.boot_epoch.is_nil() {
            return Err(Error::InvalidConfig);
        }
        let public_key = signer
            .public_key_sec1()
            .map_err(|_| Error::InvalidSignature)?;
        wire::public_key(public_key)?;
        let journal = match store.load().map_err(|_| Error::Persistence)? {
            Some(bytes) => Journal::load(&bytes, &config, &public_key)?,
            None => {
                let journal = Journal::fresh(&config, &public_key);
                store
                    .save_atomically(&journal.bytes()?)
                    .map_err(|_| Error::Persistence)?;
                journal
            }
        };
        Ok(Self {
            config,
            public_key,
            signer,
            store,
            http,
            journal,
            failed_save: None,
            session: None,
            cleanup: transport::CleanupScope::default(),
            display: tokio::sync::watch::channel(None).0,
            speech: tokio::sync::watch::channel(None).0,
            invitation: tokio::sync::watch::channel(None).0,
            turn_status: tokio::sync::watch::channel(None).0,
            task: tokio::sync::watch::channel(None).0,
            confirmation: tokio::sync::watch::channel(None).0,
            revoked: tokio::sync::watch::channel(None).0,
            policy: tokio::sync::watch::channel(None).0,
            visible: false,
        })
    }

    /// Wakes when a private card starts or stops waiting for this
    /// installation. The platform shows a generic prompt (no content) and
    /// reports its unlocked foreground visible to receive the card.
    pub fn invitation_changes(&self) -> tokio::sync::watch::Receiver<Option<Invitation>> {
        self.invitation.subscribe()
    }

    /// Wakes when the runtime reports a new committed state for the turn
    /// this installation originated: working, waiting, shown or spoken on
    /// some kind of surface, nowhere, or unknown. It is outcome evidence the
    /// ledger already holds, never a reason and never content.
    pub fn status_changes(&self) -> tokio::sync::watch::Receiver<Option<TurnStatus>> {
        self.turn_status.subscribe()
    }

    pub fn turn_status(&self) -> Option<TurnStatus> {
        self.status().turn_status
    }

    pub fn invitation(&self) -> Option<Invitation> {
        self.status().invitation
    }

    /// Wakes when the runtime dispatches or revokes a command for this
    /// installation. Nothing here proves an effect: the platform carries the
    /// command out, then reports what it actually observed.
    pub fn task_changes(&self) -> tokio::sync::watch::Receiver<Option<Task>> {
        self.task.subscribe()
    }

    pub fn task(&self) -> Option<Task> {
        self.status().task
    }

    /// Wakes when the runtime delivers or withdraws the owner's policy for
    /// this installation. It is a cache of what the owner approved in Center
    /// and never an authority of its own: the platform verifies every
    /// command against this copy, and with no copy it carries nothing out.
    pub fn policy_changes(&self) -> tokio::sync::watch::Receiver<Option<action::PolicyDocument>> {
        self.policy.subscribe()
    }

    pub fn policy(&self) -> Option<action::PolicyDocument> {
        self.status().policy
    }

    /// Wakes when a ceremony starts or ends here. The platform renders the
    /// runtime's description from its own strings file, with a decline
    /// exactly one control away, and answers with `grant`.
    pub fn confirmation_changes(&self) -> tokio::sync::watch::Receiver<Option<Confirmation>> {
        self.confirmation.subscribe()
    }

    pub fn confirmation(&self) -> Option<Confirmation> {
        self.status().confirmation
    }

    /// Wakes when the runtime delivers or retires a card. Platforms render the
    /// exact content, then call `acknowledge`; nothing here proves rendering.
    pub fn display_changes(&self) -> tokio::sync::watch::Receiver<Option<Display>> {
        self.display.subscribe()
    }

    pub fn display(&self) -> Option<Display> {
        self.status().display
    }

    /// Wakes when the runtime completes or retires a spoken reply. Platforms
    /// play the exact bytes, then call `acknowledge_speech`.
    pub fn speech_changes(&self) -> tokio::sync::watch::Receiver<Option<Speech>> {
        self.speech.subscribe()
    }

    pub fn speech(&self) -> Option<Speech> {
        self.status().speech
    }

    pub fn descriptor(&self) -> Descriptor {
        Descriptor {
            enrollment_id: self.config.enrollment_id,
            public_key: URL_SAFE_NO_PAD.encode(self.public_key),
            platform: self.config.platform,
            // What a fresh enrollment asks the owner to approve. An
            // installation already approved at an earlier profile keeps it.
            approval: wire::PROFILE,
        }
    }

    pub fn transport_shutdown(&self) -> TransportShutdown {
        TransportShutdown {
            scope: self.cleanup.clone(),
        }
    }

    async fn retire_transport(&mut self) -> Result<(), Error> {
        // Dropping the connection only signals its dedicated cleanup task.
        // Timing out this wait must never cancel the SDK's one-shot close.
        drop(self.session.take());
        self.display.send_replace(None);
        self.speech.send_replace(None);
        self.invitation.send_replace(None);
        self.turn_status.send_replace(None);
        self.task.send_replace(None);
        self.confirmation.send_replace(None);
        self.revoked.send_replace(None);
        self.policy.send_replace(None);
        self.visible = false;
        tokio::time::timeout(Duration::from_secs(2), self.cleanup.finish())
            .await
            .map_err(|_| Error::Unavailable)?
    }

    pub fn status(&self) -> Status {
        let visible = self.failed_save.as_ref().unwrap_or(&self.journal);
        let pending = visible.pending.as_ref().or(self.journal.pending.as_ref());
        let now = now_ms().unwrap_or(i64::MAX);
        let connected = self.session.as_ref().is_some_and(|session| session.alive())
            && visible.epoch == self.config.boot_epoch
            && visible.open.as_ref().is_some_and(|open| {
                now < open.lease_until_ms
                    && open
                        .connection
                        .as_ref()
                        .is_some_and(|connection| now < connection.expires_at_ms)
            });
        Status {
            connected,
            pending: pending.map(|p| {
                let mut value = p.summary(now);
                value.can_retry &= visible.epoch == self.config.boot_epoch;
                value
            }),
            last_unknown: visible.last_unknown,
            pending_open: visible
                .open
                .as_ref()
                .is_some_and(|open| open.connection.is_none()),
            needs_reconnect: !connected,
            last_admission: visible.last_admission,
            display: self
                .display
                .borrow()
                .clone()
                .filter(|card| connected && now < card.expires_at_ms),
            speech: self
                .speech
                .borrow()
                .clone()
                .filter(|speech| connected && now < speech.expires_at_ms),
            invitation: self
                .invitation
                .borrow()
                .clone()
                .filter(|invitation| connected && now < invitation.expires_at_ms),
            visible: connected && self.visible,
            turn_status: self.turn_status.borrow().clone().filter(|_| connected),
            task: self
                .task
                .borrow()
                .clone()
                .filter(|task| connected && now < task.expires_at_ms),
            confirmation: self
                .confirmation
                .borrow()
                .clone()
                .filter(|request| connected && now < request.expires_at_ms),
            revoked: self.revoked.borrow().filter(|_| connected),
            // A policy belongs to the approval revision its connection was
            // opened at, so losing the connection drops the copy with it.
            policy: self.policy.borrow().clone().filter(|_| connected),
        }
    }

    // A failed platform mutation may already have reached secure storage.
    // Freeze its exact bytes until the same save succeeds; never replace it
    // with a different transition or send new network work in the meantime.
    fn persist(&mut self, next: Journal) -> Result<(), Error> {
        if self.failed_save.is_some() {
            return Err(Error::Persistence);
        }
        let bytes = next.bytes()?;
        match self.store.save_atomically(&bytes) {
            Ok(()) => {
                self.journal = next;
                Ok(())
            }
            Err(_) => {
                self.failed_save = Some(next);
                Err(Error::Persistence)
            }
        }
    }

    fn flush(&mut self) -> Result<Option<OperationResult>, Error> {
        let Some(next) = self.failed_save.as_ref() else {
            return Ok(None);
        };
        self.store
            .save_atomically(&next.bytes()?)
            .map_err(|_| Error::Persistence)?;
        let completed = if self.journal.pending.is_some() && next.pending.is_none() {
            next.last_result
        } else {
            None
        };
        self.journal = self.failed_save.take().ok_or(Error::Persistence)?;
        Ok(completed)
    }

    /// Explicitly connect/reconcile. Same-boot pending text is retained and is
    /// sent only by `retry_pending`. A different boot or expired receipt keeps
    /// an unknown-outcome summary and discards its old text without replaying.
    pub async fn connect(&mut self) -> Result<(), Error> {
        self.flush()?;
        let now = now_ms()?;
        let mut next = self.journal.clone();
        next.reconcile(self.config.boot_epoch, now);
        self.persist(next)?;
        if self.status().connected {
            return Ok(());
        }
        self.retire_transport().await?;
        if self.journal.open.as_ref().is_some_and(|open| open.joined) {
            let mut next = self.journal.clone();
            next.open = None;
            next.last_admission = None;
            self.persist(next)?;
        }
        if self.journal.open.is_none() {
            self.prepare_open().await?;
        }
        if self
            .journal
            .open
            .as_ref()
            .is_some_and(|open| open.connection.is_none())
        {
            self.finish_open().await?;
        }
        let open = self.journal.open.as_ref().ok_or(Error::Disconnected)?;
        let connection = open.connection.as_ref().ok_or(Error::Disconnected)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct RoomRequest {
            enrollment_id: Uuid,
            approval_revision: u64,
            incarnation: Uuid,
            epoch: Uuid,
        }
        let request = RoomRequest {
            enrollment_id: self.config.enrollment_id,
            approval_revision: connection.approval_revision,
            incarnation: connection.incarnation,
            epoch: connection.epoch,
        };
        let response: Result<wire::RoomResponse, Error> = self
            .http
            .post(
                &self.config.server_origin,
                "/runtime-api/v1/native/room",
                &request,
                Some(&open.secret),
            )
            .await;
        let expected = display::Expected {
            surface_id: connection.surface_id,
            incarnation: connection.incarnation,
            approval_revision: connection.approval_revision,
        };
        let room = match response {
            Ok(value) => value,
            Err(error) => {
                self.clear_definitive_open(error)?;
                return Err(error);
            }
        };
        room.validate(&self.config.server_origin, self.config.boot_epoch)?;
        validate_coordination_token(&room)?;
        let mut next = self.journal.clone();
        if next
            .pending
            .as_ref()
            .is_some_and(|pending| pending.runtime_epoch != room.runtime_epoch)
        {
            next.abandon_pending();
        }
        let open = next.open.as_mut().ok_or(Error::Disconnected)?;
        open.joined = true;
        open.runtime_epoch = Some(room.runtime_epoch);
        // Persist this conservative marker BEFORE touching the SFU. A crash
        // or canceled join must require an explicit new connection next time.
        self.persist(next)?;
        self.display.send_replace(None);
        self.speech.send_replace(None);
        self.invitation.send_replace(None);
        self.turn_status.send_replace(None);
        self.task.send_replace(None);
        self.confirmation.send_replace(None);
        self.revoked.send_replace(None);
        self.policy.send_replace(None);
        self.visible = false;
        self.session = Some(
            transport::Connection::connect(
                &room,
                &self.cleanup,
                expected,
                transport::Outputs {
                    display: self.display.clone(),
                    speech: self.speech.clone(),
                    invitation: self.invitation.clone(),
                    status: self.turn_status.clone(),
                    task: self.task.clone(),
                    confirmation: self.confirmation.clone(),
                    revoked: self.revoked.clone(),
                    policy: self.policy.clone(),
                },
            )
            .await?,
        );
        if self.journal.pending.is_none() {
            // Nonmedia participant presence may be batched briefly by the SFU.
            // Only the newly allocated heartbeat is retried here, never text.
            tokio::time::timeout(Duration::from_secs(8), self.establish_heartbeat())
                .await
                .map_err(|_| Error::Unavailable)??;
        }
        Ok(())
    }

    async fn prepare_open(&mut self) -> Result<(), Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Request {
            enrollment_id: Uuid,
        }
        let reply: wire::ChallengeEnvelope = self
            .http
            .post(
                &self.config.server_origin,
                "/runtime-api/v1/native/challenge",
                &Request {
                    enrollment_id: self.config.enrollment_id,
                },
                None,
            )
            .await?;
        let now = now_ms()?;
        let challenge = reply.challenge;
        challenge.validate(
            &self.config.server_origin,
            self.config.enrollment_id,
            &self.public_key,
            now,
        )?;
        if self
            .journal
            .surface_id
            .is_some_and(|id| id != challenge.surface_id)
            || self
                .journal
                .approval_revision
                .is_some_and(|revision| revision > challenge.approval_revision)
        {
            return Err(Error::InvalidResponse);
        }
        let mut secret = [0u8; 32];
        rand::rngs::OsRng
            .try_fill_bytes(&mut secret)
            .map_err(|_| Error::Unavailable)?;
        let mut request = wire::OpenRequest {
            enrollment_id: self.config.enrollment_id,
            challenge_id: challenge.challenge_id,
            epoch: self.config.boot_epoch,
            expected_incarnation: challenge.current_incarnation,
            session_token_hash: wire::fingerprint(&secret),
            signature: String::new(),
        };
        let message = wire::signing_message(&challenge, &request)?;
        let signature = self
            .signer
            .sign_sha256(&message)
            .map_err(|_| Error::InvalidSignature)?;
        wire::verify_signature(&self.public_key, &message, &signature)?;
        request.signature = URL_SAFE_NO_PAD.encode(signature);
        let mut next = self.journal.clone();
        if next
            .pending
            .as_ref()
            .is_some_and(|pending| pending.approval_revision != challenge.approval_revision)
        {
            next.abandon_pending();
        }
        next.surface_id = Some(challenge.surface_id);
        next.approval_revision = Some(challenge.approval_revision);
        next.last_admission = None;
        next.open = Some(PendingOpen {
            challenge,
            request,
            secret: URL_SAFE_NO_PAD.encode(secret),
            created_at_ms: now,
            opened_at_ms: None,
            connection: None,
            joined: false,
            runtime_epoch: None,
            lease_until_ms: 0,
        });
        self.persist(next)
    }

    async fn finish_open(&mut self) -> Result<(), Error> {
        let open = self.journal.open.as_ref().ok_or(Error::Disconnected)?;
        let response: Result<wire::OpenResponse, Error> = self
            .http
            .post(
                &self.config.server_origin,
                "/runtime-api/v1/native/open",
                &open.request,
                None,
            )
            .await;
        let response = match response {
            Ok(value) => value,
            Err(error) => {
                self.clear_definitive_open(error)?;
                return Err(error);
            }
        };
        let now = now_ms()?;
        let open = self.journal.open.as_ref().ok_or(Error::Disconnected)?;
        response
            .connection
            .validate(&open.challenge, self.config.boot_epoch, now)?;
        if Some(response.connection.incarnation) == open.request.expected_incarnation {
            return Err(Error::InvalidResponse);
        }
        let mut next = self.journal.clone();
        let open = next.open.as_mut().ok_or(Error::Disconnected)?;
        open.opened_at_ms = Some(now);
        open.lease_until_ms = response.connection.lease_expires_at_ms;
        open.connection = Some(response.connection);
        self.persist(next)
    }

    fn clear_definitive_open(&mut self, error: Error) -> Result<(), Error> {
        if matches!(error, Error::Denied | Error::Stale) {
            let mut next = self.journal.clone();
            next.open = None;
            next.last_admission = None;
            self.persist(next)?;
        }
        Ok(())
    }

    async fn establish_heartbeat(&mut self) -> Result<(), Error> {
        loop {
            let result = if self.journal.pending.is_none() {
                self.heartbeat().await
            } else {
                self.retry_pending().await.map(|_| ())
            };
            match result {
                Ok(()) => return Ok(()),
                Err(Error::Unavailable | Error::Busy) if self.status().connected => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn stamp(&self, instance_id: Uuid) -> Result<state::Stamp, Error> {
        if self.journal.pending.is_some() {
            return Err(Error::Pending);
        }
        if !self.status().connected {
            return Err(Error::Disconnected);
        }
        let sequence = self
            .journal
            .sequence
            .checked_add(1)
            .filter(|v| *v <= MAX_SEQUENCE)
            .ok_or(Error::InvalidInput)?;
        Ok(state::Stamp {
            epoch: self.config.boot_epoch,
            sequence,
            instance_id,
        })
    }

    async fn submit(&mut self, message: RpcMessage) -> Result<OperationResult, Error> {
        let now = now_ms()?;
        let runtime_epoch = self
            .session
            .as_ref()
            .filter(|session| session.alive())
            .ok_or(Error::Disconnected)?
            .runtime_epoch();
        let mut next = self.journal.clone();
        let incarnation = self
            .journal
            .open
            .as_ref()
            .and_then(|open| open.connection.as_ref())
            .ok_or(Error::Disconnected)?
            .incarnation;
        next.stage(message, now, runtime_epoch, incarnation)?;
        self.persist(next)?;
        self.invoke_pending().await
    }

    pub async fn send_text(&mut self, text: &str) -> Result<Admission, Error> {
        self.send_input(text, None, None).await
    }

    /// Send the current text with the request's own explicit destination:
    /// the kind of approved screen the user named. Cosmos weighs it exactly
    /// like a hint from cognition, and the client's wins when both exist.
    pub async fn send_text_to(
        &mut self,
        text: &str,
        target: Option<Platform>,
    ) -> Result<Admission, Error> {
        self.send_input(text, target, None).await
    }

    /// Send the current text with bounded text from this installation's own
    /// screen. The turn becomes private; the reply can appear only on a
    /// personal surface, and the screen text reaches cognition only under the
    /// owner's screen-context permission for this installation.
    pub async fn send_text_with_context(
        &mut self,
        text: &str,
        context: ScreenContext,
        target: Option<Platform>,
    ) -> Result<Admission, Error> {
        self.send_input(text, target, Some(context)).await
    }

    async fn send_input(
        &mut self,
        text: &str,
        target: Option<Platform>,
        context: Option<ScreenContext>,
    ) -> Result<Admission, Error> {
        self.flush()?;
        if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(Error::InvalidInput);
        }
        let context = context.map(|context| ContextWire {
            kind: ContextKind::Screen,
            app: context.app,
            text: context.text,
        });
        if context.as_ref().is_some_and(|context| !context.valid()) {
            return Err(Error::InvalidInput);
        }
        let stamp = self.stamp(Uuid::new_v4())?;
        match self
            .submit(RpcMessage::Input {
                stamp,
                text: text.to_owned(),
                target,
                context,
            })
            .await?
        {
            OperationResult::Text(admission) => Ok(admission),
            _ => Err(Error::InvalidResponse),
        }
    }

    pub async fn heartbeat(&mut self) -> Result<(), Error> {
        self.flush()?;
        let stamp = self.stamp(Uuid::new_v4())?;
        match self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::Heartbeat,
            })
            .await?
        {
            OperationResult::Heartbeat => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    /// Report the platform's own foreground visibility. Cosmos treats it as
    /// availability for shared cards, never as occupancy or actor identity.
    pub async fn set_visible(&mut self, visible: bool) -> Result<(), Error> {
        self.flush()?;
        let stamp = self.stamp(Uuid::new_v4())?;
        match self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::State { visible },
            })
            .await?
        {
            OperationResult::State(reported) if reported == visible => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    /// Acknowledge the exact current card after the platform committed its
    /// complete render, including every credit. Never call it speculatively.
    pub async fn acknowledge(&mut self, card: &Display) -> Result<(), Error> {
        self.flush()?;
        if self.display().as_ref() != Some(card) {
            return Err(Error::NoPending);
        }
        let stamp = self.stamp(card.action_id)?;
        match self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::Acknowledge {
                    action_id: card.action_id,
                    turn_id: card.turn_id,
                    generation: card.generation,
                    channel: "visual.card".into(),
                    content_digest: card.content_digest.clone(),
                },
            })
            .await?
        {
            OperationResult::Acknowledge => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    /// Acknowledge the exact current spoken reply after the platform played
    /// its complete audio. Never call it speculatively or on partial playback.
    pub async fn acknowledge_speech(&mut self, speech: &Speech) -> Result<(), Error> {
        self.flush()?;
        if self.speech().as_ref() != Some(speech) {
            return Err(Error::NoPending);
        }
        let stamp = self.stamp(speech.action_id)?;
        match self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::Acknowledge {
                    action_id: speech.action_id,
                    turn_id: speech.turn_id,
                    generation: speech.generation,
                    channel: "audio.tts".into(),
                    content_digest: speech.content_digest.clone(),
                },
            })
            .await?
        {
            OperationResult::Acknowledge => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    /// Acknowledge the exact current command after binding it locally and
    /// finding it legal here. On an action channel this is not an outcome:
    /// never acknowledge a command you will not attempt.
    pub async fn acknowledge_task(&mut self, task: &Task) -> Result<(), Error> {
        self.flush()?;
        if self.task().as_ref() != Some(task) {
            return Err(Error::NoPending);
        }
        let stamp = self.stamp(task.action_id)?;
        match self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::Acknowledge {
                    action_id: task.action_id,
                    turn_id: task.turn_id,
                    generation: task.generation,
                    channel: task.channel.clone(),
                    content_digest: task.content_digest.clone(),
                },
            })
            .await?
        {
            OperationResult::Acknowledge => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    /// Say what happened, once, after the platform observed it. Reporting
    /// `completed` for an effect the platform did not observe is a false
    /// outcome claim; `cancelled` is a promise that nothing started or that
    /// this installation stopped it, and anything else is `unknown`.
    pub async fn report(&mut self, task: &Task, report: Report) -> Result<(), Error> {
        self.flush()?;
        if self.task().as_ref() != Some(task) {
            return Err(Error::NoPending);
        }
        if !report.valid(&task.channel) {
            return Err(Error::InvalidInput);
        }
        let stamp = self.stamp(task.action_id)?;
        let result = self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::Report {
                    action_id: task.action_id,
                    turn_id: task.turn_id,
                    generation: task.generation,
                    channel: task.channel.clone(),
                    content_digest: task.content_digest.clone(),
                    outcome: report.outcome,
                    evidence: report.evidence,
                    output: report.output,
                },
            })
            .await?;
        match result {
            OperationResult::Report => {
                self.task.send_if_modified(|current| {
                    let matched = current
                        .as_ref()
                        .is_some_and(|current| current.action_id == task.action_id);
                    if matched {
                        *current = None;
                    }
                    matched
                });
                Ok(())
            }
            _ => Err(Error::InvalidResponse),
        }
    }

    /// Answer the current ceremony with the actor evidence the platform
    /// actually obtained. Evidence weaker than the ceremony asked for is
    /// refused by Cosmos; dismissing the panel answers nothing at all.
    pub async fn grant(
        &mut self,
        confirmation: &Confirmation,
        granted: bool,
        attestation: Option<Attestation>,
    ) -> Result<(), Error> {
        self.flush()?;
        if self.confirmation().as_ref() != Some(confirmation) {
            return Err(Error::NoPending);
        }
        if granted && attestation.is_none_or(|value| value < confirmation.attestation) {
            return Err(Error::InvalidInput);
        }
        let stamp = self.stamp(confirmation.grant_id)?;
        match self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::Grant {
                    grant_id: confirmation.grant_id,
                    action_id: confirmation.action_id,
                    granted,
                    attestation,
                    description_digest: confirmation.description_digest.clone(),
                },
            })
            .await?
        {
            OperationResult::Grant => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    /// Say that a running command is still running. It is unsequenced and
    /// idempotent: it consumes no ordered slot, claims no outcome, and only
    /// renews the command's deadline and the turn's worker lease. A repeat of
    /// an already-accepted sequence changes nothing.
    pub async fn progress(
        &mut self,
        task: &Task,
        sequence: u64,
        elapsed_ms: i64,
    ) -> Result<(), Error> {
        if self.task().as_ref() != Some(task) {
            return Err(Error::NoPending);
        }
        if sequence == 0
            || sequence > action::MAX_PROGRESS
            || !(0..=action::MAX_BUDGET_MS).contains(&elapsed_ms)
        {
            return Err(Error::InvalidInput);
        }
        let session = self
            .session
            .as_ref()
            .filter(|session| session.alive())
            .ok_or(Error::Disconnected)?;
        let payload = serde_json::json!({
            "kind": "progress",
            "progress": {
                "version": 1,
                "actionId": task.action_id,
                "generation": task.generation,
                "sequence": sequence,
                "elapsedMs": elapsed_ms,
            },
        })
        .to_string();
        let response = session.invoke(payload).await?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Accepted {
            version: u8,
            kind: String,
            #[allow(dead_code)]
            duplicate: bool,
        }
        let accepted: Accepted =
            serde_json::from_str(&response).map_err(|_| Error::InvalidResponse)?;
        if accepted.version != 1 || accepted.kind != "accepted" {
            return Err(Error::InvalidResponse);
        }
        Ok(())
    }

    pub async fn cancel(&mut self, admission: Admission) -> Result<(), Error> {
        self.flush()?;
        if !state::valid_admission(admission)
            || self.journal.last_admission.is_none_or(|known| {
                known.turn_id != admission.turn_id || known.generation != admission.generation
            })
        {
            return Err(Error::InvalidInput);
        }
        let stamp = self.stamp(admission.turn_id)?;
        match self
            .submit(RpcMessage::Control {
                stamp,
                control: state::Control::Cancel {
                    turn_id: admission.turn_id,
                    generation: admission.generation,
                },
            })
            .await?
        {
            OperationResult::Cancel => Ok(()),
            _ => Err(Error::InvalidResponse),
        }
    }

    pub async fn retry_pending(&mut self) -> Result<OperationResult, Error> {
        if let Some(result) = self.flush()? {
            return Ok(result);
        }
        self.invoke_pending().await
    }

    async fn invoke_pending(&mut self) -> Result<OperationResult, Error> {
        let pending = self.journal.pending.as_ref().ok_or(Error::NoPending)?;
        if self.journal.epoch != self.config.boot_epoch {
            return Err(Error::Stale);
        }
        if !pending.retryable(now_ms()?) {
            return Err(Error::Expired);
        }
        if !self.status().connected {
            return Err(Error::Disconnected);
        }
        let session = self.session.as_ref().ok_or(Error::Disconnected)?;
        if pending.runtime_epoch != session.runtime_epoch() {
            return Err(Error::Stale);
        }
        let payload = serde_json::to_string(&pending.message).map_err(|_| Error::InvalidJournal)?;
        let response = session.invoke(payload).await?;
        let (result, duplicate) = pending.response(&response)?;
        let mut next = self.journal.clone();
        if result == OperationResult::Heartbeat && !duplicate {
            let deadline = pending
                .created_at_ms
                .checked_add(LEASE_MS)
                .ok_or(Error::InvalidResponse)?;
            let open = next.open.as_mut().ok_or(Error::Disconnected)?;
            open.lease_until_ms = deadline.min(
                open.connection
                    .as_ref()
                    .ok_or(Error::Disconnected)?
                    .expires_at_ms,
            );
        }
        next.complete(result);
        self.persist(next)?;
        if let OperationResult::State(visible) = result {
            self.visible = visible;
        }
        Ok(result)
    }

    pub async fn disconnect(&mut self) -> Result<(), Error> {
        drop(self.session.take());
        let saved = (|| {
            self.flush()?;
            let mut next = self.journal.clone();
            next.open = None;
            next.last_admission = None;
            self.persist(next)
        })();
        let closed = self.retire_transport().await;
        saved.and(closed)
    }
}

fn validate_coordination_token(room: &wire::RoomResponse) -> Result<(), Error> {
    // These are untrusted claims until the SFU verifies the JWT signature.
    // Reject an accidentally overpowered profile before giving it to the SDK.
    let payload = room.token.split('.').nth(1).ok_or(Error::InvalidResponse)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| Error::InvalidResponse)?;
    let claims: serde_json::Value =
        serde_json::from_slice(&payload).map_err(|_| Error::InvalidResponse)?;
    if claims.get("sub").and_then(|v| v.as_str()) != Some(room.participant.to_string().as_str()) {
        return Err(Error::InvalidResponse);
    }
    let video = claims
        .get("video")
        .and_then(|v| v.as_object())
        .ok_or(Error::InvalidResponse)?;
    for name in ["roomJoin", "canPublishData"] {
        if video.get(name).and_then(|v| v.as_bool()) != Some(true) {
            return Err(Error::InvalidResponse);
        }
    }
    for name in ["canPublish", "canSubscribe", "canUpdateOwnMetadata"] {
        if video.get(name).and_then(|v| v.as_bool()) != Some(false) {
            return Err(Error::InvalidResponse);
        }
    }
    for name in [
        "roomAdmin",
        "roomRecord",
        "roomCreate",
        "roomList",
        "ingressAdmin",
        "recorder",
        "hidden",
    ] {
        if video.get(name).is_some_and(|v| v.as_bool() != Some(false)) {
            return Err(Error::InvalidResponse);
        }
    }
    if video
        .get("room")
        .and_then(|v| v.as_str())
        .is_none_or(|v| v.is_empty())
        || video
            .get("canPublishSources")
            .is_some_and(|v| v.as_array().is_none_or(|v| !v.is_empty()))
        || claims.get("sip").is_some_and(|sip| {
            sip.as_object()
                .is_none_or(|v| v.values().any(|v| v.as_bool() != Some(false)))
        })
    {
        return Err(Error::InvalidResponse);
    }
    Ok(())
}

fn now_ms() -> Result<i64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_millis()).ok())
        .filter(|value| *value > 0)
        .ok_or(Error::Unavailable)
}
