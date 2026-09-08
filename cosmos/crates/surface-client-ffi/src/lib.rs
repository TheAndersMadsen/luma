//! A single worker owns the native client. C and JNI see public configuration,
//! bounded commands, and redacted snapshots; protected bytes stay in callbacks.
#[cfg(target_os = "android")]
mod android;
use cosmos_surface_client::{
    Client, Config, Display, Error, OperationKind, Pending, Platform, PlatformError, ScreenContext,
    SecureStore, Signer, Speech, TransportShutdown, TurnStatus,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    ffi::c_void,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc as sync_mpsc,
    },
    thread,
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

#[cfg(test)]
mod tests;

const OK: i32 = 0;
const EMPTY: i32 = 1;
const BUFFER_TOO_SMALL: i32 = 2;
const INVALID_ARGUMENT: i32 = -1;
const QUEUE_FULL: i32 = -2;
const CLOSED: i32 = -3;
const PANIC: i32 = -4;
const UNAVAILABLE: i32 = -5;
const MAX_CONFIG: usize = 2048;
const MAX_TEXT: usize = 4000;
const MAX_CONTEXT_APP: usize = cosmos_surface_client::MAX_CONTEXT_APP_BYTES;
const MAX_CONTEXT: usize = cosmos_surface_client::MAX_CONTEXT_BYTES;
const MAX_DOCUMENT: usize = cosmos_surface_client::MAX_DOCUMENT_BYTES;
const MAX_JOURNAL: usize = 32768;
const MAX_EVENT: usize = 16384;
const COMMAND_CAPACITY: usize = 16;
const EVENT_CAPACITY: usize = 64;
static CLIENT_OCCUPIED: AtomicBool = AtomicBool::new(false);

struct ClientPermit;

impl ClientPermit {
    fn acquire() -> Option<Self> {
        CLIENT_OCCUPIED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for ClientPermit {
    fn drop(&mut self) {
        CLIENT_OCCUPIED.store(false, Ordering::Release);
    }
}

struct CallbackBarrier {
    completed: Option<sync_mpsc::Sender<i32>>,
    closed: Arc<AtomicBool>,
}

impl CallbackBarrier {
    fn finish(&mut self, result: i32) {
        self.closed.store(true, Ordering::Release);
        if let Some(completed) = self.completed.take() {
            let _ = completed.send(result);
        }
    }
}

impl Drop for CallbackBarrier {
    fn drop(&mut self) {
        self.finish(PANIC);
    }
}

type ReadCallback = unsafe extern "C" fn(*mut c_void, *mut u8, usize, *mut usize) -> i32;
type SignCallback =
    unsafe extern "C" fn(*mut c_void, *const u8, usize, *mut u8, usize, *mut usize) -> i32;
type WriteCallback = unsafe extern "C" fn(*mut c_void, *const u8, usize) -> i32;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CosmosSurfaceCallbacks {
    pub context: *mut c_void,
    pub public_key: Option<ReadCallback>,
    pub sign_sha256: Option<SignCallback>,
    pub read_journal: Option<ReadCallback>,
    pub write_journal_atomically: Option<WriteCallback>,
}

/// Platform-owned key, journal and nothing else. Every binding supplies one
/// implementation; the worker never sees key material or journal contents.
trait Bindings: Signer + SecureStore {}
impl<T: Signer + SecureStore> Bindings for T {}

struct Callbacks(CosmosSurfaceCallbacks);
// SAFETY: The C contract requires a thread-safe context retained until the
// callback barrier completes. No callback is spawned or invoked after it.
unsafe impl Send for Callbacks {}
unsafe impl Sync for Callbacks {}

impl Signer for Callbacks {
    fn public_key_sec1(&self) -> Result<[u8; 65], PlatformError> {
        let callback = self.0.public_key.ok_or(PlatformError)?;
        let mut output = [0u8; 65];
        let mut written = 0;
        // SAFETY: All buffers are initialized, writable, and live for this call.
        let result = unsafe {
            callback(
                self.0.context,
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            )
        };
        if result != OK || written != output.len() || output[0] != 4 {
            return Err(PlatformError);
        }
        Ok(output)
    }

    fn sign_sha256(&self, message: &[u8]) -> Result<Vec<u8>, PlatformError> {
        let callback = self.0.sign_sha256.ok_or(PlatformError)?;
        let mut output = [0u8; 72];
        let mut written = 0;
        // SAFETY: The message and output buffers remain borrowed for this call.
        let result = unsafe {
            callback(
                self.0.context,
                message.as_ptr(),
                message.len(),
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            )
        };
        if result != OK || written == 0 || written > output.len() {
            return Err(PlatformError);
        }
        Ok(output[..written].to_vec())
    }
}

impl SecureStore for Callbacks {
    fn load(&self) -> Result<Option<Vec<u8>>, PlatformError> {
        let callback = self.0.read_journal.ok_or(PlatformError)?;
        let mut output = vec![0u8; MAX_JOURNAL];
        let mut written = 0;
        // SAFETY: The initialized output is exclusively writable until return.
        let result = unsafe {
            callback(
                self.0.context,
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            )
        };
        if result == 1 && written == 0 {
            return Ok(None);
        }
        if result != OK || written == 0 || written > output.len() {
            return Err(PlatformError);
        }
        output.truncate(written);
        Ok(Some(output))
    }

    fn save_atomically(&self, journal: &[u8]) -> Result<(), PlatformError> {
        if journal.is_empty() || journal.len() > MAX_JOURNAL {
            return Err(PlatformError);
        }
        let callback = self.0.write_journal_atomically.ok_or(PlatformError)?;
        // SAFETY: This protected journal is borrowed only during the callback.
        let result = unsafe { callback(self.0.context, journal.as_ptr(), journal.len()) };
        if result == OK {
            Ok(())
        } else {
            Err(PlatformError)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicConfig {
    version: u8,
    server_origin: String,
    enrollment_id: String,
    platform: String,
    boot_epoch: String,
}

fn config(bytes: &[u8]) -> Result<Config, i32> {
    let value: PublicConfig = serde_json::from_slice(bytes).map_err(|_| INVALID_ARGUMENT)?;
    let uuid = |value: &str| {
        Uuid::parse_str(value)
            .ok()
            .filter(|id| !id.is_nil() && id.to_string().eq_ignore_ascii_case(value))
            .ok_or(INVALID_ARGUMENT)
    };
    if value.version != 1 {
        return Err(INVALID_ARGUMENT);
    }
    Ok(Config {
        server_origin: value.server_origin,
        enrollment_id: uuid(&value.enrollment_id)?,
        platform: match value.platform.as_str() {
            "macos" => Platform::Macos,
            "linux" => Platform::Linux,
            "android" => Platform::Android,
            "android_tv" => Platform::AndroidTv,
            _ => return Err(INVALID_ARGUMENT),
        },
        boot_epoch: uuid(&value.boot_epoch)?,
    })
}

enum Command {
    Connect,
    Text(String),
    TextTo(String, Option<Platform>),
    TextWithContext {
        text: String,
        context: ScreenContext,
        target: Option<Platform>,
    },
    Retry,
    Cancel,
    SetVisible(bool),
    Acknowledge,
    AcknowledgeSpeech,
    /// Bind the current command locally and say it is legal here. Never an
    /// outcome, and never sent for a command this platform will not attempt.
    AcknowledgeTask,
    /// Say what happened, once, after the platform observed it. It names
    /// the action it is about, so a command that was swapped between the
    /// platform's own read and this queue closes nothing.
    Report {
        action_id: Uuid,
        report: Box<cosmos_surface_client::Report>,
    },
    /// Say the current command is still running.
    Progress {
        sequence: u64,
        elapsed_ms: i64,
    },
    /// Answer the current ceremony with the actor evidence obtained.
    Grant {
        granted: bool,
        attestation: Option<cosmos_surface_client::Attestation>,
    },
    Disconnect,
}

/// The explicit destination a binding passed: absent, or exactly one of the
/// wire platform names. Anything else is an argument error, never ignored.
fn parse_target(bytes: Option<&[u8]>) -> Result<Option<Platform>, i32> {
    match bytes {
        None => Ok(None),
        Some([]) => Ok(None),
        Some(bytes) => std::str::from_utf8(bytes)
            .ok()
            .and_then(Platform::parse)
            .map(Some)
            .ok_or(INVALID_ARGUMENT),
    }
}

/// Bounded, non-blank UTF-8 request text from a binding.
fn parse_text(bytes: &[u8]) -> Result<String, i32> {
    if bytes.is_empty() || bytes.len() > MAX_TEXT {
        return Err(INVALID_ARGUMENT);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| INVALID_ARGUMENT)?;
    if text.trim().is_empty() {
        return Err(INVALID_ARGUMENT);
    }
    Ok(text.to_owned())
}

/// Bounded screen context from a binding; the client rechecks every bound.
/// The document handle is carried, never inspected: the platform composed it
/// from the owner's own declared folders and the runtime validates every
/// field of it.
fn parse_context(app: &[u8], context: &[u8]) -> Result<ScreenContext, i32> {
    parse_context_with_document(app, context, &[])
}

fn parse_context_with_document(
    app: &[u8],
    context: &[u8],
    document: &[u8],
) -> Result<ScreenContext, i32> {
    if app.is_empty()
        || app.len() > MAX_CONTEXT_APP
        || context.is_empty()
        || context.len() > MAX_CONTEXT
    {
        return Err(INVALID_ARGUMENT);
    }
    let app = std::str::from_utf8(app).map_err(|_| INVALID_ARGUMENT)?;
    let text = std::str::from_utf8(context).map_err(|_| INVALID_ARGUMENT)?;
    if app.trim().is_empty() || text.trim().is_empty() {
        return Err(INVALID_ARGUMENT);
    }
    let document = if document.is_empty() {
        None
    } else {
        if document.len() > MAX_DOCUMENT {
            return Err(INVALID_ARGUMENT);
        }
        let value: Value = serde_json::from_slice(document).map_err(|_| INVALID_ARGUMENT)?;
        if !value.is_object()
            || serde_json::to_vec(&value)
                .map_err(|_| INVALID_ARGUMENT)?
                .len()
                > MAX_DOCUMENT
        {
            return Err(INVALID_ARGUMENT);
        }
        Some(
            std::str::from_utf8(document)
                .map_err(|_| INVALID_ARGUMENT)?
                .to_owned(),
        )
    };
    Ok(ScreenContext {
        app: app.to_owned(),
        text: text.to_owned(),
        document,
    })
}

/// The current spoken reply's audio, shared with the platform's own buffer
/// copy. Snapshots carry its identity and length, never the bytes.
type SpeechAudio = Arc<Mutex<Option<(Uuid, Vec<u8>)>>>;

/// The owner's policy document for this installation, shared with the
/// platform's own buffer copy. Snapshots carry its digest and length; this is
/// the exact document the runtime serialized and both sides hashed.
type PolicyDocument = Arc<Mutex<Option<Vec<u8>>>>;

/// The two payloads a snapshot names but never repeats. The worker publishes
/// them; a platform copies the bytes out on its own thread.
#[derive(Clone)]
struct Buffers {
    speech: SpeechAudio,
    policy: PolicyDocument,
}

#[derive(Default)]
struct Events {
    snapshots: VecDeque<Vec<u8>>,
    skipped: u64,
}

impl Events {
    fn push(&mut self, mut snapshot: Value) {
        if self.snapshots.len() == EVENT_CAPACITY {
            self.snapshots.pop_front();
            self.skipped = self.skipped.saturating_add(1);
        }
        snapshot["eventsSkipped"] = json!(self.skipped);
        if let Ok(bytes) = serde_json::to_vec(&snapshot)
            && bytes.len() <= MAX_EVENT
        {
            self.snapshots.push_back(bytes);
        }
    }
}

pub struct CosmosSurface {
    commands: mpsc::Sender<Command>,
    shutdown: watch::Sender<bool>,
    events: Arc<Mutex<Events>>,
    speech_audio: SpeechAudio,
    policy_document: PolicyDocument,
    closed: Arc<AtomicBool>,
    callbacks_finished: Mutex<Option<sync_mpsc::Receiver<i32>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl CosmosSurface {
    fn enqueue(&self, command: Command) -> i32 {
        if self.closed.load(Ordering::Acquire) || *self.shutdown.borrow() {
            return CLOSED;
        }
        match self.commands.try_send(command) {
            Ok(()) => OK,
            Err(mpsc::error::TrySendError::Full(_)) => QUEUE_FULL,
            Err(mpsc::error::TrySendError::Closed(_)) => CLOSED,
        }
    }

    /// A copy of the owner's policy document, if this installation holds one.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    fn policy_document(&self) -> Option<Vec<u8>> {
        self.policy_document
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// A copy of the current spoken reply's audio bytes, if one is current.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    fn speech_audio(&self) -> Option<Vec<u8>> {
        self.speech_audio
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|(_, audio)| audio.clone())
    }

    /// The oldest retained snapshot, consumed. Bindings without a caller
    /// buffer take ownership of the exact bytes.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    fn take_event(&self) -> Option<Vec<u8>> {
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshots
            .pop_front()
    }

    fn stop(&mut self) -> i32 {
        self.shutdown.send_replace(true);
        self.closed.store(true, Ordering::Release);
        let Some(worker) = self.worker.take() else {
            return OK;
        };
        let result = self
            .callbacks_finished
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .and_then(|finished| finished.recv().ok())
            .unwrap_or(PANIC);
        if worker.is_finished() && worker.join().is_err() {
            return PANIC;
        }
        // A still-running thread owns only its runtime, transport cleanup scope,
        // and process permit. It cannot access platform callbacks again.
        result
    }
}

impl Drop for CosmosSurface {
    fn drop(&mut self) {
        self.stop();
    }
}

fn push(events: &Mutex<Events>, snapshot: Value) {
    // Recovery cannot expose poisoned contents outside the same safe schema.
    events
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(snapshot);
}

fn pending(value: Option<Pending>) -> Value {
    value.map_or(Value::Null, |value| {
        json!({
            "kind": match value.kind {
                OperationKind::Text => "text",
                OperationKind::Heartbeat => "heartbeat",
                OperationKind::Cancel => "cancel",
                OperationKind::State => "state",
                OperationKind::Acknowledge => "acknowledge",
                OperationKind::Report => "report",
                OperationKind::Grant => "grant",
            },
            "instanceId": value.instance_id.to_string(),
            "sequence": value.sequence,
            "canRetry": value.can_retry,
        })
    })
}

fn error_code(error: &Error) -> &'static str {
    match error {
        Error::Pending => "pending_operation",
        Error::NoPending => "no_pending_operation",
        Error::Disconnected => "disconnected",
        Error::Expired => "expired",
        Error::InvalidConfig => "invalid_config",
        Error::InvalidResponse => "invalid_response",
        Error::InvalidSignature => "invalid_signature",
        Error::Persistence => "persistence",
        Error::InvalidJournal => "invalid_journal",
        Error::Unavailable => "unavailable",
        Error::InvalidInput => "invalid_input",
        Error::Denied => "denied",
        Error::Stale => "stale",
        Error::Busy => "busy",
    }
}

/// The exact delivered card. Content is bounded by the client's frame checks;
/// the platform renders it verbatim and acknowledges only after commit.
fn display(value: Option<&Display>) -> Value {
    value.map_or(Value::Null, |card| {
        // Credits were validated with the frame; parts are inert text/link
        // tokens so platforms never interpret markup themselves.
        let credits = match &card.content {
            cosmos_surface_client::DisplayContent::Places { attributions, .. } => attributions
                .iter()
                .map(|credit| cosmos_surface_client::display::parse_attribution(credit))
                .collect::<Result<Vec<_>, _>>()
                .ok(),
            cosmos_surface_client::DisplayContent::Text { .. }
            | cosmos_surface_client::DisplayContent::Choices { .. } => Some(Vec::new()),
        };
        let Some(credits) = credits else {
            return Value::Null;
        };
        json!({
            "actionId": card.action_id.to_string(),
            "turnId": card.turn_id.to_string(),
            "generation": card.generation,
            "contentDigest": card.content_digest,
            "expiresAtMs": card.expires_at_ms,
            "content": card.content,
            "credits": credits,
            "privacy": card.privacy,
        })
    })
}

/// A private card waiting for this installation: the class, the kind of
/// surface that asked and the expiry; never content.
fn invitation(value: Option<&cosmos_surface_client::Invitation>) -> Value {
    value.map_or(Value::Null, |invitation| {
        json!({
            "id": invitation.id.to_string(),
            "kind": invitation.kind,
            "origin": invitation.origin,
            "privacy": invitation.privacy,
            "expiresAtMs": invitation.expires_at_ms,
        })
    })
}

/// The committed state of this installation's own turn. It names only the
/// kind of surface involved and the class the status is expressed at.
fn status(value: Option<&TurnStatus>) -> Value {
    value.map_or(Value::Null, |status| {
        json!({
            "turnId": status.turn_id.to_string(),
            "generation": status.generation,
            "state": status.state,
            "surfacePlatform": status.surface.map(|platform| platform.as_str()),
            "privacy": status.privacy,
        })
    })
}

/// The command this installation was asked to carry out. The platform
/// re-verifies it against its own copy of the owner's policy, acknowledges
/// the binding, then reports only what it actually observed.
fn task(value: Option<&cosmos_surface_client::Task>) -> Value {
    value.map_or(Value::Null, |task| {
        json!({
            "actionId": task.action_id.to_string(),
            "turnId": task.turn_id.to_string(),
            "generation": task.generation,
            "channel": task.channel,
            "contentDigest": task.content_digest,
            "idempotencyKey": task.idempotency_key,
            "operation": task.operation,
            "expiresAtMs": task.expires_at_ms,
            "reportByMs": task.report_by_ms,
            "privacy": task.privacy,
        })
    })
}

/// The ceremony this installation is the venue for. The description is the
/// runtime's own composed words; a platform renders them from its own strings
/// file and echoes the digest, so the answer binds to the sentence read.
fn confirmation(value: Option<&cosmos_surface_client::Confirmation>) -> Value {
    value.map_or(Value::Null, |confirmation| {
        json!({
            "grantId": confirmation.grant_id.to_string(),
            "actionId": confirmation.action_id.to_string(),
            "turnId": confirmation.turn_id.to_string(),
            "generation": confirmation.generation,
            "description": confirmation.description,
            "descriptionDigest": confirmation.description_digest,
            "risk": confirmation.risk,
            "attestation": confirmation.attestation,
            "privacy": confirmation.privacy,
            "expiresAtMs": confirmation.expires_at_ms,
        })
    })
}

/// The owner's own policy for this installation, named but not repeated: the
/// document itself is copied out with cosmos_surface_device_policy, and a
/// platform that already holds this digest has nothing to re-read.
fn policy(value: Option<&cosmos_surface_client::PolicyDocument>) -> Value {
    value.map_or(Value::Null, |held| {
        json!({
            "surfaceId": held.policy.surface_id.to_string(),
            "approvalRevision": held.policy.approval_revision,
            "actionsRevision": held.policy.actions.as_ref().map(|actions| actions.revision),
            "commandsRevision": held.policy.commands.as_ref().map(|commands| commands.revision),
            "digest": held.digest,
            "byteLength": held.document.len(),
        })
    })
}

fn speech(value: Option<&Speech>) -> Value {
    value.map_or(Value::Null, |speech| {
        json!({
            "actionId": speech.action_id.to_string(),
            "turnId": speech.turn_id.to_string(),
            "generation": speech.generation,
            "contentDigest": speech.content_digest,
            "expiresAtMs": speech.expires_at_ms,
            "text": speech.text,
            "format": speech.format,
            "byteLength": speech.audio.len(),
        })
    })
}

fn snapshot(
    client: Option<&Client>,
    descriptor: &Value,
    operation: &str,
    error: Option<&str>,
) -> Value {
    let status = client.map(Client::status);
    let admission = status.as_ref().and_then(|s| s.last_admission);
    json!({
        "version": 1,
        "kind": "state",
        "operation": operation,
        "outcome": if error.is_some() { "error" } else { "ok" },
        "error": error,
        "connected": status.as_ref().is_some_and(|s| s.connected),
        "pendingOpen": status.as_ref().is_some_and(|s| s.pending_open),
        "needsReconnect": status.as_ref().is_some_and(|s| s.needs_reconnect),
        "descriptor": descriptor,
        "pending": status.as_ref().map_or(Value::Null, |s| pending(s.pending)),
        "lastUnknown": status.as_ref().map_or(Value::Null, |s| pending(s.last_unknown)),
        "admission": admission.map(|a| json!({
            "turnId": a.turn_id.to_string(), "generation": a.generation,
            "duplicate": a.duplicate,
        })),
        "visible": status.as_ref().is_some_and(|s| s.visible),
        "display": status.as_ref().map_or(Value::Null, |s| display(s.display.as_ref())),
        "speech": status.as_ref().map_or(Value::Null, |s| speech(s.speech.as_ref())),
        "invitation": status.as_ref().map_or(Value::Null, |s| invitation(s.invitation.as_ref())),
        "status": status.as_ref().map_or(Value::Null, |s| self::status(s.turn_status.as_ref())),
        "task": status.as_ref().map_or(Value::Null, |s| task(s.task.as_ref())),
        "confirmation": status.as_ref().map_or(Value::Null, |s| confirmation(s.confirmation.as_ref())),
        "policy": status.as_ref().map_or(Value::Null, |s| policy(s.policy.as_ref())),
        "revoked": status.as_ref().and_then(|s| s.revoked).map(|revoked| json!({
            "actionId": revoked.action_id.to_string(), "reason": revoked.reason,
        })),
    })
}

async fn run(
    config: Config,
    callbacks: Arc<dyn Bindings>,
    mut commands: mpsc::Receiver<Command>,
    mut shutdown: watch::Receiver<bool>,
    events: Arc<Mutex<Events>>,
    buffers: Buffers,
    shutdown_scope: &mut Option<TransportShutdown>,
) {
    let signer: Arc<dyn Signer> = callbacks.clone();
    let store: Arc<dyn SecureStore> = callbacks;
    let mut client = match Client::new(config, signer, store) {
        Ok(client) => client,
        Err(error) => {
            push(
                &events,
                snapshot(None, &Value::Null, "prepare", Some(error_code(&error))),
            );
            return;
        }
    };
    *shutdown_scope = Some(client.transport_shutdown());
    let descriptor = match serde_json::to_value(client.descriptor()) {
        Ok(descriptor) => descriptor,
        Err(_) => {
            push(
                &events,
                snapshot(
                    Some(&client),
                    &Value::Null,
                    "prepare",
                    Some("invalid_response"),
                ),
            );
            return;
        }
    };
    push(
        &events,
        snapshot(Some(&client), &descriptor, "prepare", None),
    );
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut displays = client.display_changes();
    let mut speeches = client.speech_changes();
    let mut invitations = client.invitation_changes();
    let mut statuses = client.status_changes();
    // A command has three seconds to be acknowledged and its own report
    // budget after that, so an `act` or a `confirm` wakes the platform at
    // once instead of waiting for the next heartbeat. A revoke clears the
    // task or the confirmation it names, which is the same wake.
    let mut tasks = client.task_changes();
    let mut confirmations = client.confirmation_changes();
    // The owner's policy for this installation. It arrives and is withdrawn
    // on its own, so a platform learns it may act — or may no longer — as
    // soon as the runtime says so rather than at the next command.
    let mut policies = client.policy_changes();
    // The platform's last requested foreground state. It is re-reported after
    // every new connection because visibility lives on the connection.
    let mut wanted_visible = false;
    enum Wake {
        Command(Command),
        Heartbeat,
        Display,
        Speech,
        Invitation,
        Status,
        Task,
        Confirmation,
        Policy,
    }
    let publish_policy = |client: &Client| {
        *buffers.policy.lock().unwrap_or_else(|e| e.into_inner()) =
            client.policy().map(|held| held.document.into_bytes());
    };
    let publish_speech = |client: &Client| {
        *buffers.speech.lock().unwrap_or_else(|e| e.into_inner()) = client
            .speech()
            .map(|speech| (speech.action_id, speech.audio));
    };
    loop {
        if *shutdown.borrow() {
            break;
        }
        let wake = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            changed = displays.changed() => { if changed.is_err() { break; } Wake::Display }
            changed = speeches.changed() => { if changed.is_err() { break; } Wake::Speech }
            changed = invitations.changed() => { if changed.is_err() { break; } Wake::Invitation }
            changed = statuses.changed() => { if changed.is_err() { break; } Wake::Status }
            changed = tasks.changed() => { if changed.is_err() { break; } Wake::Task }
            changed = confirmations.changed() => { if changed.is_err() { break; } Wake::Confirmation }
            changed = policies.changed() => { if changed.is_err() { break; } Wake::Policy }
            _ = heartbeat.tick() => Wake::Heartbeat,
            command = commands.recv() => match command { Some(command) => Wake::Command(command), None => break },
        };
        let command = match wake {
            Wake::Display => {
                push(
                    &events,
                    snapshot(Some(&client), &descriptor, "display", None),
                );
                continue;
            }
            Wake::Speech => {
                // Audio is published before the snapshot names it, so a
                // platform that reads the snapshot can always fetch the bytes.
                publish_speech(&client);
                push(
                    &events,
                    snapshot(Some(&client), &descriptor, "speech", None),
                );
                continue;
            }
            Wake::Invitation => {
                push(
                    &events,
                    snapshot(Some(&client), &descriptor, "invitation", None),
                );
                continue;
            }
            Wake::Status => {
                push(
                    &events,
                    snapshot(Some(&client), &descriptor, "status", None),
                );
                continue;
            }
            Wake::Task => {
                push(&events, snapshot(Some(&client), &descriptor, "task", None));
                continue;
            }
            Wake::Confirmation => {
                push(
                    &events,
                    snapshot(Some(&client), &descriptor, "confirmation", None),
                );
                continue;
            }
            Wake::Policy => {
                // The document is published before the snapshot names it, so
                // a platform reading the snapshot can always copy the bytes.
                publish_policy(&client);
                push(
                    &events,
                    snapshot(Some(&client), &descriptor, "policy", None),
                );
                continue;
            }
            Wake::Heartbeat => None,
            Wake::Command(command) => Some(command),
        };
        // Automatic heartbeats never create, retry or replace an uncertain
        // request, with one exception: an uncertain heartbeat of this same
        // connection is retried exactly on the next tick. It renews only the
        // lease, an exact retry cannot duplicate anything, and leaving it to
        // the platform would silently let the lease lapse.
        let command = match command {
            None => {
                let state = client.status();
                if !state.connected || state.pending_open {
                    continue;
                }
                match state.pending {
                    Some(pending)
                        if pending.kind == cosmos_surface_client::OperationKind::Heartbeat
                            && pending.can_retry =>
                    {
                        Some(Command::Retry)
                    }
                    Some(_) => continue,
                    None => None,
                }
            }
            other => other,
        };
        let operation = match &command {
            Some(Command::Connect) => "connect",
            Some(Command::Text(_)) => "send_text",
            Some(Command::TextTo(..)) => "send_text_to",
            // The operation a platform waits on names what it actually sent,
            // so a client that named a document knows its handle travelled.
            Some(Command::TextWithContext { context, .. }) => {
                if context.document.is_some() {
                    "send_text_with_document"
                } else {
                    "send_text_with_context"
                }
            }
            Some(Command::Retry) => "retry_pending",
            Some(Command::Cancel) => "cancel",
            Some(Command::SetVisible(_)) => "set_visible",
            Some(Command::Acknowledge) => "acknowledge",
            Some(Command::AcknowledgeSpeech) => "acknowledge_speech",
            Some(Command::AcknowledgeTask) => "acknowledge_task",
            Some(Command::Report { .. }) => "report",
            Some(Command::Progress { .. }) => "progress",
            Some(Command::Grant { .. }) => "grant",
            Some(Command::Disconnect) => "disconnect",
            None => "heartbeat",
        };
        if let Some(Command::SetVisible(visible)) = &command {
            wanted_visible = *visible;
        }
        let result = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = async {
                match command {
                    Some(Command::Connect) => {
                        let connected = client.connect().await;
                        if connected.is_ok() && wanted_visible && !client.status().visible {
                            // Report the retained foreground state on the new
                            // connection; a failure surfaces as its own event.
                            if let Err(error) = client.set_visible(true).await {
                                push(&events, snapshot(Some(&client), &descriptor, "set_visible", Some(error_code(&error))));
                            }
                        }
                        connected
                    }
                    Some(Command::Text(text)) => client.send_text(&text).await.map(|_| ()),
                    Some(Command::TextTo(text, target)) => client.send_text_to(&text, target).await.map(|_| ()),
                    Some(Command::TextWithContext { text, context, target }) => {
                        client.send_text_with_context(&text, context, target).await.map(|_| ())
                    }
                    Some(Command::Retry) => client.retry_pending().await.map(|_| ()),
                    Some(Command::Cancel) => match client.status().last_admission {
                        Some(value) => client.cancel(value).await,
                        None => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("no_admission")));
                            return None;
                        }
                    },
                    Some(Command::SetVisible(visible)) => {
                        if !client.status().connected {
                            // Retained for the next connection; nothing to send.
                            push(&events, snapshot(Some(&client), &descriptor, operation, None));
                            return None;
                        }
                        client.set_visible(visible).await
                    }
                    Some(Command::Acknowledge) => match client.display() {
                        Some(card) => client.acknowledge(&card).await,
                        None => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("no_display")));
                            return None;
                        }
                    },
                    Some(Command::AcknowledgeSpeech) => match client.speech() {
                        Some(speech) => client.acknowledge_speech(&speech).await,
                        None => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("no_speech")));
                            return None;
                        }
                    },
                    Some(Command::AcknowledgeTask) => match client.task() {
                        Some(task) => client.acknowledge_task(&task).await,
                        None => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("no_task")));
                            return None;
                        }
                    },
                    // A report names the action it is about. A task that was
                    // swapped between the platform's own read and this drain
                    // is a different command, and closing it from here would
                    // claim an outcome nobody observed.
                    Some(Command::Report { action_id, report }) => match client.task() {
                        Some(task) if task.action_id == action_id => client.report(&task, *report).await,
                        Some(_) => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("stale_task")));
                            return None;
                        }
                        None => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("no_task")));
                            return None;
                        }
                    },
                    Some(Command::Progress { sequence, elapsed_ms }) => match client.task() {
                        Some(task) => client.progress(&task, sequence, elapsed_ms).await,
                        None => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("no_task")));
                            return None;
                        }
                    },
                    Some(Command::Grant { granted, attestation }) => match client.confirmation() {
                        Some(confirmation) => client.grant(&confirmation, granted, attestation).await,
                        None => {
                            push(&events, snapshot(Some(&client), &descriptor, operation, Some("no_confirmation")));
                            return None;
                        }
                    },
                    Some(Command::Disconnect) => {
                        client.disconnect().await
                    }
                    None => client.heartbeat().await,
                }.map_or_else(|error| Some(Err(error)), |_| Some(Ok(())))
            } => result,
        };
        if let Some(result) = result {
            publish_speech(&client);
            publish_policy(&client);
            push(
                &events,
                snapshot(
                    Some(&client),
                    &descriptor,
                    operation,
                    result.as_ref().err().map(error_code),
                ),
            );
        }
    }
    *buffers.speech.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *buffers.policy.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // The client journals before side effects; dropping an in-flight future
    // leaves recoverable uncertainty. Shutdown never retries the saved input.
    let _ = tokio::time::timeout(Duration::from_secs(5), client.disconnect()).await;
}

fn boundary(action: impl FnOnce() -> i32) -> i32 {
    catch_unwind(AssertUnwindSafe(action)).unwrap_or(PANIC)
}

/// # Safety
/// Pointers must satisfy the lifetimes, capacities, and callback rules in
/// cosmos_surface.h; output and callbacks must be properly aligned and valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_create(
    bytes: *const u8,
    length: usize,
    callbacks: *const CosmosSurfaceCallbacks,
    output: *mut *mut CosmosSurface,
) -> i32 {
    boundary(|| {
        if output.is_null() {
            return INVALID_ARGUMENT;
        }
        // SAFETY: Caller supplies a writable handle slot.
        unsafe {
            *output = ptr::null_mut();
        }
        if bytes.is_null() || callbacks.is_null() || length == 0 || length > MAX_CONFIG {
            return INVALID_ARGUMENT;
        }
        // SAFETY: The caller guarantees readable configuration/callback storage.
        let (bytes, callbacks) = unsafe { (std::slice::from_raw_parts(bytes, length), *callbacks) };
        if callbacks.public_key.is_none()
            || callbacks.sign_sha256.is_none()
            || callbacks.read_journal.is_none()
            || callbacks.write_journal_atomically.is_none()
        {
            return INVALID_ARGUMENT;
        }
        let config = match config(bytes) {
            Ok(config) => config,
            Err(code) => return code,
        };
        match spawn(config, Arc::new(Callbacks(callbacks))) {
            Ok(handle) => {
                // SAFETY: Transfer ownership only after the join guard is installed.
                unsafe {
                    *output = Box::into_raw(handle);
                }
                OK
            }
            Err(code) => code,
        }
    })
}

/// Start the owned worker for one platform binding. The returned handle owns
/// the worker; its process permit is released only after SDK cleanup ends.
fn spawn(config: Config, callbacks: Arc<dyn Bindings>) -> Result<Box<CosmosSurface>, i32> {
    {
        let Some(permit) = ClientPermit::acquire() else {
            return Err(QUEUE_FULL);
        };
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (shutdown, stop) = watch::channel(false);
        let (finished, callbacks_finished) = sync_mpsc::channel();
        let events = Arc::new(Mutex::new(Events::default()));
        let buffers = Buffers {
            speech: Arc::new(Mutex::new(None)),
            policy: Arc::new(Mutex::new(None)),
        };
        let closed = Arc::new(AtomicBool::new(false));
        let mut handle = Box::new(CosmosSurface {
            commands,
            shutdown,
            events: events.clone(),
            speech_audio: buffers.speech.clone(),
            policy_document: buffers.policy.clone(),
            closed: closed.clone(),
            callbacks_finished: Mutex::new(Some(callbacks_finished)),
            worker: None,
        });
        let worker = thread::Builder::new()
            .name("cosmos-surface".into())
            .spawn(move || {
                let mut barrier = CallbackBarrier {
                    completed: Some(finished),
                    closed,
                };
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(_) => {
                        drop(callbacks);
                        drop(receiver);
                        push(
                            &events,
                            snapshot(None, &Value::Null, "prepare", Some("unavailable")),
                        );
                        drop(permit);
                        barrier.finish(UNAVAILABLE);
                        return;
                    }
                };
                let mut shutdown_scope = None;
                let result = catch_unwind(AssertUnwindSafe(|| {
                    runtime.block_on(run(
                        config,
                        callbacks,
                        receiver,
                        stop,
                        events.clone(),
                        buffers,
                        &mut shutdown_scope,
                    ))
                }));
                if result.is_err() {
                    push(
                        &events,
                        snapshot(None, &Value::Null, "prepare", Some("panic")),
                    );
                }
                let outcome = if result.is_err() { PANIC } else { OK };
                if !shutdown_scope
                    .as_ref()
                    .is_some_and(TransportShutdown::pending)
                {
                    drop(shutdown_scope);
                    drop(runtime);
                    drop(permit);
                    barrier.finish(outcome);
                    return;
                }
                // run has dropped Client and every platform callback and queued
                // text. Network cleanup below cannot access callback context.
                barrier.finish(outcome);
                if let Some(scope) = shutdown_scope {
                    // Retain the runtime until SDK close finishes. The process
                    // permit bounds this callback-free tail to one worker.
                    runtime.block_on(async {
                        if scope.finish().await.is_err() && scope.pending() {
                            // An unobserved completion cannot release the permit
                            // or destroy a runtime still owning SDK work.
                            std::future::pending::<()>().await;
                        }
                    });
                }
                drop(runtime);
                drop(permit);
            });
        handle.worker = match worker {
            Ok(worker) => Some(worker),
            Err(_) => return Err(UNAVAILABLE),
        };
        Ok(handle)
    }
}

unsafe fn enqueue(surface: *mut CosmosSurface, command: Command) -> i32 {
    // SAFETY: Caller retains this live handle until all non-destroy calls finish.
    unsafe { surface.as_ref() }.map_or(INVALID_ARGUMENT, |surface| surface.enqueue(command))
}

macro_rules! command {
    ($name:ident, $command:expr) => {
        /// # Safety
        /// The handle must be live and cannot be concurrently destroyed.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(surface: *mut CosmosSurface) -> i32 {
            boundary(|| unsafe { enqueue(surface, $command) })
        }
    };
}
command!(cosmos_surface_connect, Command::Connect);
command!(cosmos_surface_retry_pending, Command::Retry);
command!(cosmos_surface_cancel, Command::Cancel);
command!(cosmos_surface_acknowledge, Command::Acknowledge);
command!(
    cosmos_surface_acknowledge_speech,
    Command::AcknowledgeSpeech
);
command!(cosmos_surface_acknowledge_task, Command::AcknowledgeTask);
command!(cosmos_surface_disconnect, Command::Disconnect);

/// # Safety
/// The handle must be live; action_id and report must be readable for their
/// lengths until return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_report(
    surface: *mut CosmosSurface,
    action_id: *const u8,
    action_id_length: usize,
    report: *const u8,
    length: usize,
) -> i32 {
    boundary(|| {
        let action = match unsafe { optional_bytes(action_id, action_id_length, 64) } {
            Ok(Some(bytes)) => bytes,
            Ok(None) | Err(_) => return INVALID_ARGUMENT,
        };
        let Ok(action_id) = parse_action_id(action) else {
            return INVALID_ARGUMENT;
        };
        let bytes = match unsafe { optional_bytes(report, length, 16 * 1024) } {
            Ok(Some(bytes)) => bytes,
            Ok(None) | Err(_) => return INVALID_ARGUMENT,
        };
        let Ok(report) = cosmos_surface_client::Report::parse(bytes) else {
            return INVALID_ARGUMENT;
        };
        unsafe {
            enqueue(
                surface,
                Command::Report {
                    action_id,
                    report: Box::new(report),
                },
            )
        }
    })
}

/// The action a report is about, exactly as the snapshot spelled it.
fn parse_action_id(bytes: &[u8]) -> Result<Uuid, i32> {
    let text = std::str::from_utf8(bytes).map_err(|_| INVALID_ARGUMENT)?;
    Uuid::parse_str(text)
        .ok()
        .filter(|id| !id.is_nil() && id.to_string().eq_ignore_ascii_case(text))
        .ok_or(INVALID_ARGUMENT)
}

/// # Safety
/// The handle must be live and cannot be concurrently destroyed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_progress(
    surface: *mut CosmosSurface,
    sequence: u32,
    elapsed_ms: i64,
) -> i32 {
    boundary(|| unsafe {
        enqueue(
            surface,
            Command::Progress {
                sequence: u64::from(sequence),
                elapsed_ms,
            },
        )
    })
}

/// # Safety
/// The handle must be live; attestation must be readable for its length until
/// return, and may be null only when its length is zero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_grant(
    surface: *mut CosmosSurface,
    granted: i32,
    attestation: *const u8,
    attestation_length: usize,
) -> i32 {
    boundary(|| {
        if !matches!(granted, 0 | 1) {
            return INVALID_ARGUMENT;
        }
        let attestation = match unsafe { optional_bytes(attestation, attestation_length, 64) } {
            Ok(None) => None,
            Err(_) => return INVALID_ARGUMENT,
            Ok(Some(bytes)) => match std::str::from_utf8(bytes)
                .ok()
                .and_then(cosmos_surface_client::Attestation::parse)
            {
                Some(value) => Some(value),
                None => return INVALID_ARGUMENT,
            },
        };
        // Granting without the evidence the ceremony asked for is not an
        // answer; the client refuses it before anything is sent.
        if granted == 1 && attestation.is_none() {
            return INVALID_ARGUMENT;
        }
        unsafe {
            enqueue(
                surface,
                Command::Grant {
                    granted: granted == 1,
                    attestation,
                },
            )
        }
    })
}

/// # Safety
/// The handle must be live, written must be writable, and output must be writable
/// for capacity bytes. Output may be null only when capacity is zero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_speech_audio(
    surface: *mut CosmosSurface,
    output: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> i32 {
    boundary(|| {
        if written.is_null() {
            return INVALID_ARGUMENT;
        }
        unsafe {
            *written = 0;
        }
        if output.is_null() && capacity != 0 {
            return INVALID_ARGUMENT;
        }
        let Some(surface) = (unsafe { surface.as_ref() }) else {
            return INVALID_ARGUMENT;
        };
        let audio = surface
            .speech_audio
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some((_, bytes)) = audio.as_ref() else {
            return EMPTY;
        };
        unsafe {
            *written = bytes.len();
        }
        if capacity < bytes.len() {
            return BUFFER_TOO_SMALL;
        }
        // SAFETY: Caller owns enough writable bytes, disjoint from Rust storage.
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
        }
        OK
    })
}

/// # Safety
/// The handle must be live, written must be writable, and output must be writable
/// for capacity bytes. Output may be null only when capacity is zero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_device_policy(
    surface: *mut CosmosSurface,
    output: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> i32 {
    boundary(|| {
        if written.is_null() {
            return INVALID_ARGUMENT;
        }
        unsafe {
            *written = 0;
        }
        if output.is_null() && capacity != 0 {
            return INVALID_ARGUMENT;
        }
        let Some(surface) = (unsafe { surface.as_ref() }) else {
            return INVALID_ARGUMENT;
        };
        let document = surface
            .policy_document
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(bytes) = document.as_ref() else {
            return EMPTY;
        };
        unsafe {
            *written = bytes.len();
        }
        if capacity < bytes.len() {
            return BUFFER_TOO_SMALL;
        }
        // SAFETY: Caller owns enough writable bytes, disjoint from Rust storage.
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
        }
        OK
    })
}

/// # Safety
/// The handle must be live and cannot be concurrently destroyed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_set_visible(
    surface: *mut CosmosSurface,
    visible: i32,
) -> i32 {
    boundary(|| {
        if !matches!(visible, 0 | 1) {
            return INVALID_ARGUMENT;
        }
        unsafe { enqueue(surface, Command::SetVisible(visible == 1)) }
    })
}

/// # Safety
/// The handle must be live; text must be readable for length bytes until return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_send_text(
    surface: *mut CosmosSurface,
    text: *const u8,
    length: usize,
) -> i32 {
    boundary(|| {
        if text.is_null() || length == 0 || length > MAX_TEXT {
            return INVALID_ARGUMENT;
        }
        // SAFETY: Length is bounded and caller guarantees a live readable slice.
        let text = match parse_text(unsafe { std::slice::from_raw_parts(text, length) }) {
            Ok(text) => text,
            Err(code) => return code,
        };
        unsafe { enqueue(surface, Command::Text(text)) }
    })
}

/// Borrow an optional bounded byte argument: NULL or zero length is absent.
unsafe fn optional_bytes<'a>(
    bytes: *const u8,
    length: usize,
    maximum: usize,
) -> Result<Option<&'a [u8]>, i32> {
    if bytes.is_null() || length == 0 {
        return Ok(None);
    }
    if length > maximum {
        return Err(INVALID_ARGUMENT);
    }
    // SAFETY: The caller guarantees a live readable slice of `length` bytes.
    Ok(Some(unsafe { std::slice::from_raw_parts(bytes, length) }))
}

/// # Safety
/// The handle must be live; text and target must be readable for their lengths
/// until return. A NULL target with zero length means no explicit destination.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_send_text_to(
    surface: *mut CosmosSurface,
    text: *const u8,
    length: usize,
    target: *const u8,
    target_length: usize,
) -> i32 {
    boundary(|| {
        if text.is_null() || length == 0 || length > MAX_TEXT {
            return INVALID_ARGUMENT;
        }
        // SAFETY: Lengths are bounded and the caller guarantees live slices.
        let (text, target) = unsafe {
            (
                parse_text(std::slice::from_raw_parts(text, length)),
                optional_bytes(target, target_length, 16).and_then(parse_target),
            )
        };
        let (Ok(text), Ok(target)) = (text, target) else {
            return INVALID_ARGUMENT;
        };
        unsafe { enqueue(surface, Command::TextTo(text, target)) }
    })
}

/// Send text with the owner's screen context and the document they were
/// looking at, so a later request can carry on with it on another device.
/// `document` is the compact JSON handle the platform composed; it may be
/// null, and every field inside it is the runtime's to validate.
///
/// # Safety
/// Every pointer must be null or point at a live buffer of its stated length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_send_text_with_document(
    surface: *mut CosmosSurface,
    text: *const u8,
    length: usize,
    app: *const u8,
    app_length: usize,
    context: *const u8,
    context_length: usize,
    document: *const u8,
    document_length: usize,
    target: *const u8,
    target_length: usize,
) -> i32 {
    boundary(|| {
        if text.is_null()
            || length == 0
            || length > MAX_TEXT
            || app.is_null()
            || app_length == 0
            || app_length > MAX_CONTEXT_APP
            || context.is_null()
            || context_length == 0
            || context_length > MAX_CONTEXT
            || document_length > MAX_DOCUMENT
            || (document.is_null() && document_length != 0)
        {
            return INVALID_ARGUMENT;
        }
        // SAFETY: Lengths are bounded and the caller guarantees live slices.
        let (text, context, target) = unsafe {
            (
                parse_text(std::slice::from_raw_parts(text, length)),
                parse_context_with_document(
                    std::slice::from_raw_parts(app, app_length),
                    std::slice::from_raw_parts(context, context_length),
                    if document_length == 0 {
                        &[]
                    } else {
                        std::slice::from_raw_parts(document, document_length)
                    },
                ),
                optional_bytes(target, target_length, 16).and_then(parse_target),
            )
        };
        let (Ok(text), Ok(context), Ok(target)) = (text, context, target) else {
            return INVALID_ARGUMENT;
        };
        unsafe {
            enqueue(
                surface,
                Command::TextWithContext {
                    text,
                    context,
                    target,
                },
            )
        }
    })
}

/// # Safety
/// The handle must be live; text, app, context and target must be readable for
/// their lengths until return. App and context are required; a NULL target
/// with zero length means no explicit destination.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_send_text_with_context(
    surface: *mut CosmosSurface,
    text: *const u8,
    length: usize,
    app: *const u8,
    app_length: usize,
    context: *const u8,
    context_length: usize,
    target: *const u8,
    target_length: usize,
) -> i32 {
    boundary(|| {
        if text.is_null()
            || length == 0
            || length > MAX_TEXT
            || app.is_null()
            || app_length == 0
            || app_length > MAX_CONTEXT_APP
            || context.is_null()
            || context_length == 0
            || context_length > MAX_CONTEXT
        {
            return INVALID_ARGUMENT;
        }
        // SAFETY: Lengths are bounded and the caller guarantees live slices.
        let (text, context, target) = unsafe {
            (
                parse_text(std::slice::from_raw_parts(text, length)),
                parse_context(
                    std::slice::from_raw_parts(app, app_length),
                    std::slice::from_raw_parts(context, context_length),
                ),
                optional_bytes(target, target_length, 16).and_then(parse_target),
            )
        };
        let (Ok(text), Ok(context), Ok(target)) = (text, context, target) else {
            return INVALID_ARGUMENT;
        };
        unsafe {
            enqueue(
                surface,
                Command::TextWithContext {
                    text,
                    context,
                    target,
                },
            )
        }
    })
}

/// # Safety
/// The handle must be live, written must be writable, and output must be writable
/// for capacity bytes. Output may be null only when capacity is zero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_poll(
    surface: *mut CosmosSurface,
    output: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> i32 {
    boundary(|| {
        if written.is_null() {
            return INVALID_ARGUMENT;
        }
        unsafe {
            *written = 0;
        }
        if output.is_null() && capacity != 0 {
            return INVALID_ARGUMENT;
        }
        let Some(surface) = (unsafe { surface.as_ref() }) else {
            return INVALID_ARGUMENT;
        };
        let mut events = surface.events.lock().unwrap_or_else(|e| e.into_inner());
        let Some(event) = events.snapshots.front() else {
            return EMPTY;
        };
        unsafe {
            *written = event.len();
        }
        if capacity < event.len() {
            return BUFFER_TOO_SMALL;
        }
        // SAFETY: Caller owns enough writable bytes, disjoint from Rust storage.
        unsafe {
            ptr::copy_nonoverlapping(event.as_ptr(), output, event.len());
        }
        events.snapshots.pop_front();
        OK
    })
}

/// # Safety
/// Destroy a live handle exactly once, exclusively from other API calls. Keep
/// callback context alive until return. Never call from a worker callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cosmos_surface_destroy(surface: *mut CosmosSurface) -> i32 {
    boundary(|| {
        if surface.is_null() {
            return OK;
        }
        // SAFETY: The caller exclusively returns the handle created by this API.
        let mut surface = unsafe { Box::from_raw(surface) };
        surface.stop()
    })
}
