//! An owner-approved input and shared-display surface. Platform code owns the
//! installation key, secure journal, foreground state and actual rendering;
//! this crate owns admission, exact retries, frame checks and RTC fencing.
pub mod display;
mod http;
mod state;
#[cfg(test)]
mod tests;
mod transport;
mod wire;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
pub use display::{AttributionPart, Display, DisplayContent, PlaceItem};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use state::{Journal, PendingOpen, RpcMessage};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const MAX_JOURNAL_BYTES: usize = 32 * 1024;
pub const MAX_TEXT_BYTES: usize = 4000;
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
    /// The foreground visibility Cosmos last accepted for this connection.
    pub visible: bool,
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
            visible: false,
        })
    }

    /// Wakes when the runtime delivers or retires a card. Platforms render the
    /// exact content, then call `acknowledge`; nothing here proves rendering.
    pub fn display_changes(&self) -> tokio::sync::watch::Receiver<Option<Display>> {
        self.display.subscribe()
    }

    pub fn display(&self) -> Option<Display> {
        self.status().display
    }

    pub fn descriptor(&self) -> Descriptor {
        Descriptor {
            enrollment_id: self.config.enrollment_id,
            public_key: URL_SAFE_NO_PAD.encode(self.public_key),
            platform: self.config.platform,
            approval: "native-shared-display-v2",
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
            visible: connected && self.visible,
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
        self.visible = false;
        self.session = Some(
            transport::Connection::connect(&room, &self.cleanup, expected, self.display.clone())
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
        self.flush()?;
        if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(Error::InvalidInput);
        }
        let stamp = self.stamp(Uuid::new_v4())?;
        match self
            .submit(RpcMessage::Input {
                stamp,
                text: text.to_owned(),
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
