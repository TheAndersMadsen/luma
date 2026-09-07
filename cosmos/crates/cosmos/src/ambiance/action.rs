//! Device actions. A surface may be asked to render, to speak, or to act.
//! An action is the third thing, and it travels the same pipeline: cognition
//! proposes a runtime-minted reference, the runtime binds every argument from
//! state it committed itself, policy decides where it may go, and only a
//! device report — never an acknowledgment — may claim it happened.
//!
//! Nothing here names a device, a grant or a dispatch. An `Operation` is a
//! bound command: every string is bounded, every coordinate is a canonical
//! decimal string, and its content digest is the one value the runtime, the
//! shared client and Center each recompute independently from
//! `contracts/fixtures/ambiance-device-action-digests-v1.json`.
use super::{Channel, PrivacyClass};
use crate::surface_registry::hash;
use serde::{Deserialize, Serialize};

pub const MAX_LABEL_BYTES: usize = 120;
pub const MAX_TITLE_BYTES: usize = 120;
pub const MAX_NAME_BYTES: usize = 120;
pub const MAX_ADDRESS_BYTES: usize = 200;
pub const MAX_QUERY_BYTES: usize = 200;
pub const MAX_URL_BYTES: usize = 2048;
pub const MAX_RELATIVE_BYTES: usize = 512;
pub const MAX_PLACE_ID_BYTES: usize = 1024;
pub const MAX_FRAGMENT_BYTES: usize = 200;
pub const MAX_PROVIDERS: usize = 4;
pub const MAX_ENTRY_ID_BYTES: usize = 48;
pub const MAX_ROOT_ID_BYTES: usize = 32;
pub const MAX_BUDGET_MS: i64 = 900_000;
/// The longest command output a terminal report may carry, well inside the
/// 12 KiB realtime payload envelope.
pub const MAX_OUTPUT_BYTES: usize = 6144;

/// Bounded text with no control characters.
pub(super) fn text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub(super) fn digest_text(value: &str) -> bool {
    super::state::digest_valid(value)
}

/// How much a channel may change about the world. Authority is the minimum of
/// device, channel and actor trust (§4.2), so this is a ceiling, never a grant.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Low,
    Moderate,
    High,
}

/// What the executing installation proved about the person who confirmed.
/// Every Cosmos manifest declares `actor_unknown`, so a bare tap can never
/// stand in for device-owner authentication.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Attestation {
    ForegroundTap,
    DeviceOwnerAuth,
}

/// Where an operation points. The runtime mints every locator from state it
/// already committed; a model never supplies one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "scheme",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Locator {
    Https { url: String },
    App { id: String },
    File { root_id: String, relative: String },
}

impl Locator {
    pub fn valid(&self) -> bool {
        match self {
            Self::Https { url } => https_url(url),
            Self::App { id } => {
                !id.is_empty()
                    && id.len() <= 128
                    && !id.starts_with('.')
                    && !id.ends_with('.')
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
            }
            Self::File { root_id, relative } => {
                token(root_id, MAX_ROOT_ID_BYTES)
                    && !relative.is_empty()
                    && relative.len() <= MAX_RELATIVE_BYTES
                    && !relative.starts_with('/')
                    && !relative.contains('\\')
                    && !relative.chars().any(char::is_control)
                    && relative
                        .split('/')
                        .all(|part| !part.is_empty() && part != "." && part != "..")
            }
        }
    }

    pub fn scheme(&self) -> &'static str {
        match self {
            Self::Https { .. } => "https",
            Self::App { .. } => "app",
            Self::File { .. } => "file",
        }
    }

    /// The digest's locator value: the URL, the application id, or the path
    /// relative to its owner-declared root.
    fn value(&self) -> &str {
        match self {
            Self::Https { url } => url,
            Self::App { id } => id,
            Self::File { relative, .. } => relative,
        }
    }

    fn root(&self) -> Option<&str> {
        match self {
            Self::File { root_id, .. } => Some(root_id),
            Self::Https { .. } | Self::App { .. } => None,
        }
    }

    /// The registrable host of an `https` locator, for the owner's host list.
    pub fn host(&self) -> Option<String> {
        let Self::Https { url } = self else {
            return None;
        };
        reqwest::Url::parse(url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
    }
}

/// An `https` locator that a client can open without ambiguity: no userinfo,
/// no port, no whitespace and no backslash.
pub fn https_url(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value.contains('\\')
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}

/// A bare lowercase host the owner declared: no scheme, port, userinfo or path.
pub fn declared_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value == value.to_ascii_lowercase()
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && value.contains('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// Where in a document to land. A line, a page or a named fragment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Position {
    Line { line: u32 },
    Page { page: u32 },
    Fragment { value: String },
}

impl Position {
    pub fn valid(&self) -> bool {
        match self {
            Self::Line { line } => (1..=1_000_000).contains(line),
            Self::Page { page } => (1..=100_000).contains(page),
            Self::Fragment { value } => text(value, MAX_FRAGMENT_BYTES),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Line { .. } => "line",
            Self::Page { .. } => "page",
            Self::Fragment { .. } => "fragment",
        }
    }

    /// The digest's position value. Numbers are rendered as decimal strings so
    /// four languages hash the same bytes without float or integer-width drift.
    fn value(&self) -> String {
        match self {
            Self::Line { line } => line.to_string(),
            Self::Page { page } => page.to_string(),
            Self::Fragment { value } => value.clone(),
        }
    }
}

/// The kind of operation, for the content-free ledger.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Open,
    Route,
    Play,
    Run,
}

/// One bound device command. Every field is minted by the runtime from a
/// candidate it offered and state it committed; nothing here is model text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Open {
        locator: Locator,
        version: Option<String>,
        position: Option<Position>,
        label: String,
    },
    Route {
        place_id: String,
        name: String,
        address: String,
        lat: String,
        lng: String,
    },
    Play {
        title: String,
        query: String,
        providers: Vec<String>,
        item_digest: String,
    },
    Run {
        entry_id: String,
        label: String,
        entry_digest: String,
        argv_digest: String,
        budget_ms: i64,
        mutates: bool,
    },
}

impl Operation {
    pub fn kind(&self) -> OperationKind {
        match self {
            Self::Open { .. } => OperationKind::Open,
            Self::Route { .. } => OperationKind::Route,
            Self::Play { .. } => OperationKind::Play,
            Self::Run { .. } => OperationKind::Run,
        }
    }

    pub fn channel(&self) -> Channel {
        match self {
            Self::Open { .. } => Channel::ActionOpen,
            Self::Route { .. } => Channel::ActionRoute,
            Self::Play { .. } => Channel::ActionPlay,
            Self::Run { .. } => Channel::ActionRun,
        }
    }

    /// The bound risk. A command that changes files is `high` whatever the
    /// channel ceiling says; everything else this release ships is `low`.
    pub fn risk(&self) -> Risk {
        match self {
            Self::Open { .. } | Self::Route { .. } | Self::Play { .. } => Risk::Low,
            Self::Run { mutates: true, .. } => Risk::High,
            Self::Run { mutates: false, .. } => Risk::Moderate,
        }
    }

    /// How long the executing installation has, after acknowledging, to say
    /// what happened. It is the channel's published budget, and for a command
    /// the owner's own entry budget.
    pub fn report_budget_ms(&self) -> i64 {
        match self {
            Self::Open { .. } => 10_000,
            Self::Route { .. } => 20_000,
            Self::Play { .. } => 30_000,
            Self::Run { budget_ms, .. } => *budget_ms,
        }
    }

    /// What a person is asked to confirm, in the policy engine's own words.
    /// The model never sees or writes this.
    pub fn description(&self, device_kind: &str, class: PrivacyClass) -> Description {
        let (verb, subject, effect) = match self {
            Self::Open { label, .. } => ("open", label.clone(), "opens it on that device"),
            Self::Route { name, .. } => ("route", name.clone(), "starts navigation on that device"),
            Self::Play { title, .. } => ("play", title.clone(), "starts playback on that device"),
            Self::Run {
                label,
                mutates: true,
                ..
            } => ("run", label.clone(), "changes files on that device"),
            Self::Run { label, .. } => ("run", label.clone(), "does not change files"),
        };
        Description {
            kind: DescriptionKind::DeviceAction,
            verb: verb.to_owned(),
            subject,
            device_kind: device_kind.to_owned(),
            effect: effect.to_owned(),
            class,
        }
    }

    pub fn valid(&self) -> bool {
        match self {
            Self::Open {
                locator,
                version,
                position,
                label,
            } => {
                locator.valid()
                    && version.as_deref().is_none_or(digest_text)
                    && position.as_ref().is_none_or(Position::valid)
                    && text(label, MAX_LABEL_BYTES)
            }
            Self::Route {
                place_id,
                name,
                address,
                lat,
                lng,
            } => {
                text(place_id, MAX_PLACE_ID_BYTES)
                    && !place_id.chars().any(char::is_whitespace)
                    && text(name, MAX_NAME_BYTES)
                    && text(address, MAX_ADDRESS_BYTES)
                    && coordinate_valid(lat, 90)
                    && coordinate_valid(lng, 180)
            }
            Self::Play {
                title,
                query,
                providers,
                item_digest,
            } => {
                text(title, MAX_TITLE_BYTES)
                    && text(query, MAX_QUERY_BYTES)
                    && (1..=MAX_PROVIDERS).contains(&providers.len())
                    && providers.iter().all(|p| provider_id(p))
                    && providers.windows(2).all(|pair| pair[0] < pair[1])
                    && digest_text(item_digest)
            }
            Self::Run {
                entry_id,
                label,
                entry_digest,
                argv_digest,
                budget_ms,
                mutates: _,
            } => {
                token(entry_id, MAX_ENTRY_ID_BYTES)
                    && text(label, MAX_LABEL_BYTES)
                    && digest_text(entry_digest)
                    && digest_text(argv_digest)
                    && (1..=MAX_BUDGET_MS).contains(budget_ms)
            }
        }
    }

    /// Every human-visible string of the bound command, so the runtime's own
    /// input classification can raise the class. It can never lower it. A
    /// command contributes the owner's label only: its argv is never routed.
    pub fn classified_text(&self) -> String {
        match self {
            Self::Open { label, .. } => label.clone(),
            Self::Route { name, address, .. } => format!("{name}\n{address}"),
            Self::Play { title, query, .. } => format!("{title}\n{query}"),
            Self::Run { label, .. } => label.clone(),
        }
    }

    pub fn content_digest(&self) -> String {
        let canonical = match self {
            Self::Open {
                locator,
                version,
                position,
                label,
            } => serde_json::json!([
                "cosmos.device-action.open",
                1,
                locator.scheme(),
                locator.value(),
                locator.root(),
                version,
                position.as_ref().map(Position::kind),
                position.as_ref().map(Position::value),
                label,
            ]),
            Self::Route {
                place_id,
                name,
                address,
                lat,
                lng,
            } => serde_json::json!([
                "cosmos.device-action.route",
                1,
                place_id,
                name,
                address,
                lat,
                lng,
            ]),
            Self::Play {
                title,
                query,
                providers,
                item_digest,
            } => serde_json::json!([
                "cosmos.device-action.play",
                1,
                title,
                query,
                providers,
                item_digest,
            ]),
            Self::Run {
                entry_id,
                label,
                entry_digest,
                argv_digest,
                budget_ms,
                mutates,
            } => serde_json::json!([
                "cosmos.device-action.run",
                1,
                entry_id,
                label,
                entry_digest,
                argv_digest,
                budget_ms,
                mutates,
            ]),
        };
        hash(canonical.to_string().as_bytes())
    }
}

fn provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Coordinates cross Rust, Swift, Kotlin, Python and TypeScript as ASCII
/// decimal strings with exactly six fraction digits, because float formatting
/// is the one conversion that drifts and this design hashes it.
pub fn coordinate(value: f64) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    let text = format!("{value:.6}");
    let text = if text == "-0.000000" {
        "0.000000".to_owned()
    } else {
        text
    };
    coordinate_valid(&text, 180).then_some(text)
}

fn coordinate_valid(value: &str, maximum: u32) -> bool {
    let body = value.strip_prefix('-').unwrap_or(value);
    let Some((whole, fraction)) = body.split_once('.') else {
        return false;
    };
    if fraction.len() != 6
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || whole.is_empty()
        || whole.len() > 3
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || (whole.len() > 1 && whole.starts_with('0'))
    {
        return false;
    }
    let degrees: u32 = whole.parse().unwrap_or(u32::MAX);
    degrees < maximum || (degrees == maximum && fraction.bytes().all(|b| b == b'0'))
}

/// What a confirmation ceremony says, composed by policy from the bound
/// operation and the owner's own label. A model never sees or writes it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DescriptionKind {
    DeviceAction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Description {
    pub kind: DescriptionKind,
    pub verb: String,
    pub subject: String,
    pub device_kind: String,
    pub effect: String,
    pub class: PrivacyClass,
}

impl Description {
    pub fn valid(&self) -> bool {
        text(&self.verb, 16)
            && text(&self.subject, MAX_LABEL_BYTES)
            && crate::surface_registry::native_platform(&self.device_kind)
            && text(&self.effect, MAX_ADDRESS_BYTES)
    }

    pub fn content_digest(&self) -> String {
        let canonical = serde_json::json!([
            "cosmos.confirmation",
            1,
            self.verb,
            self.subject,
            self.device_kind,
            self.effect,
            self.class,
        ]);
        hash(canonical.to_string().as_bytes())
    }
}

/// What the device said happened. Only a final report may set a turn outcome;
/// an acknowledgment on an action channel means "bound and legal here".
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome {
    Completed,
    Refused,
    Failed,
    Cancelled,
    Unknown,
}

impl ReportOutcome {
    /// The status a reported outcome commits the action to. Every reported
    /// outcome is terminal: a device says what happened exactly once.
    pub fn status(self) -> super::ActionStatus {
        match self {
            Self::Completed => super::ActionStatus::Completed,
            Self::Refused => super::ActionStatus::Refused,
            Self::Failed => super::ActionStatus::Failed,
            Self::Cancelled => super::ActionStatus::Cancelled,
            Self::Unknown => super::ActionStatus::OutcomeUnknown,
        }
    }
}

/// The closed evidence vocabulary. No free text crosses this leg except the
/// owner's own command output, which is content and is handled as content.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Open,
    Route,
    Playback,
    Command,
    Declined,
}

/// What a player reported. A launch that cannot be observed further is not
/// playback, which is why `Launched` can never carry a completed outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState {
    Playing,
    Buffering,
    Launched,
}

/// Why a device declined a bound command. The origin never learns this; the
/// owner reads it in their own ledger.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeclineReason {
    NoHandler,
    Locked,
    NotPermitted,
    Unresolvable,
    VersionChanged,
    EntryChanged,
    NoAttestation,
}

/// The device's own bounded account of what it observed. Nothing here is
/// prose: every field is an identifier, a flag, a digest or a number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Evidence {
    Open {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_app: Option<String>,
        opened: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        document_digest: Option<String>,
    },
    Route {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_app: Option<String>,
        launched: bool,
        navigating: bool,
    },
    Playback {
        provider: String,
        state: PlaybackState,
        position_ms: i64,
        item_digest: String,
    },
    Command {
        entry_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        duration_ms: i64,
        output_bytes: u32,
        truncated: bool,
    },
    Declined {
        reason: DeclineReason,
    },
}

impl Evidence {
    pub fn kind(&self) -> EvidenceKind {
        match self {
            Self::Open { .. } => EvidenceKind::Open,
            Self::Route { .. } => EvidenceKind::Route,
            Self::Playback { .. } => EvidenceKind::Playback,
            Self::Command { .. } => EvidenceKind::Command,
            Self::Declined { .. } => EvidenceKind::Declined,
        }
    }

    pub fn valid(&self) -> bool {
        let app = |value: &Option<String>| {
            value
                .as_ref()
                .is_none_or(|id| Locator::App { id: id.clone() }.valid())
        };
        match self {
            Self::Open {
                resolved_app,
                document_digest,
                ..
            } => app(resolved_app) && document_digest.as_deref().is_none_or(digest_text),
            Self::Route { resolved_app, .. } => app(resolved_app),
            Self::Playback {
                provider,
                position_ms,
                item_digest,
                ..
            } => {
                provider_id(provider)
                    && (0..=86_400_000).contains(position_ms)
                    && digest_text(item_digest)
            }
            Self::Command {
                entry_id,
                duration_ms,
                output_bytes,
                ..
            } => {
                token(entry_id, MAX_ENTRY_ID_BYTES)
                    && (0..=MAX_BUDGET_MS).contains(duration_ms)
                    && *output_bytes <= 16 * 1024 * 1024
            }
            Self::Declined { .. } => true,
        }
    }

    /// Whether this evidence can belong to a command on this channel at all.
    /// A refusal is legal everywhere; anything else must match the operation.
    pub fn fits(&self, channel: Channel) -> bool {
        match self {
            Self::Declined { .. } => channel.is_action(),
            Self::Open { .. } => channel == Channel::ActionOpen,
            Self::Route { .. } => channel == Channel::ActionRoute,
            Self::Playback { .. } => channel == Channel::ActionPlay,
            Self::Command { .. } => channel == Channel::ActionRun,
        }
    }

    /// Whether this evidence can carry a `completed` outcome. A launch the
    /// device could not observe further is `unknown`, never `completed`, and
    /// a non-zero exit code is evidence of a command that ran, not a failure.
    pub fn proves_completion(&self) -> bool {
        match self {
            Self::Open { opened, .. } => *opened,
            Self::Route { navigating, .. } => *navigating,
            Self::Playback { state, .. } => *state == PlaybackState::Playing,
            Self::Command { .. } => true,
            Self::Declined { .. } => false,
        }
    }

    /// The one value the ledger keeps of what the device said.
    pub fn digest(&self) -> String {
        hash(serde_json::to_string(self).unwrap_or_default().as_bytes())
    }
}

/// Why the runtime told a device to stop. A revoke supersedes remaining work;
/// it does not un-open an application (§5.4's accepted residue).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevokeReason {
    Cancelled,
    Preempted,
    Superseded,
    Expired,
    RevalidationFailed,
}

/// One dispatched device action per principal at a time, and at most six in a
/// rolling ten minutes: §4.5(d)'s residual risk is accumulation of low-risk
/// actions, and §10's answer is a per-session budget.
pub const BUDGET_WINDOW_MS: i64 = 600_000;
pub const BUDGET_LIMIT: usize = 6;
/// A running command must say it is still running at least this often.
pub const PROGRESS_GRACE_MS: i64 = 10_000;
pub const MAX_PROGRESS: u64 = 60;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionBudget {
    #[serde(default)]
    pub dispatched_at_ms: Vec<i64>,
}

impl ActionBudget {
    pub fn prune(&mut self, now: i64) {
        self.dispatched_at_ms
            .retain(|at| now.saturating_sub(*at) < BUDGET_WINDOW_MS);
        while self.dispatched_at_ms.len() > BUDGET_LIMIT + 2 {
            self.dispatched_at_ms.remove(0);
        }
    }

    pub fn exhausted(&self, now: i64) -> bool {
        self.dispatched_at_ms
            .iter()
            .filter(|at| now.saturating_sub(**at) < BUDGET_WINDOW_MS)
            .count()
            >= BUDGET_LIMIT
    }

    pub fn spend(&mut self, now: i64) {
        self.dispatched_at_ms.push(now);
        self.prune(now);
    }
}

/// Which runtime-minted candidate a bound action came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    Choice,
    Place,
    Document,
    Continuation,
    Command,
}

impl CandidateKind {
    /// The identifier prefix cognition sees. A reference is `<prefix>:<id>`.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Choice => "choice",
            Self::Place => "place",
            Self::Document => "doc",
            Self::Continuation => "cont",
            Self::Command => "cmd",
        }
    }
}

// ---------------------------------------------------------------------------
// Owner permissions
// ---------------------------------------------------------------------------

pub const OWNER_APPROVAL: &str = "approve-device-actions-v1";
pub const COMMAND_OWNER_APPROVAL: &str = "approve-device-command-v1";

pub const MAX_HOSTS: usize = 16;
pub const MAX_APPS: usize = 8;
pub const MAX_ROOTS: usize = 4;
pub const MAX_ROOT_PATH_BYTES: usize = 256;
pub const MAX_COMMAND_ENTRIES: usize = 8;
pub const MIN_ARGV: usize = 1;
pub const MAX_ARGV: usize = 12;
pub const MAX_ARGV_BYTES: usize = 256;

/// One application the owner declared this installation may open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppEntry {
    pub id: String,
    pub label: String,
}

/// One directory the owner declared, named by an id both installations of a
/// continuation must share. Cosmos never resolves the path itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootEntry {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenPolicy {
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub apps: Vec<AppEntry>,
    #[serde(default)]
    pub roots: Vec<RootEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteApp {
    GoogleMaps,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutePolicy {
    pub app: RouteApp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlayPolicy {
    pub providers: Vec<String>,
}

/// The owner's statement of what one installation may be asked to do. An
/// operation absent from that installation's manifest is not writable here,
/// and `maximumClass` is capped by the installation's own private-display
/// ceiling: an action policy can never raise a posture, only spend one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub maximum_class: PrivacyClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<OpenPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<RoutePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub play: Option<PlayPolicy>,
}

impl Policy {
    /// Shape only. Which operations this installation may hold, and how high
    /// its class may go, are checked against the record where it is written.
    fn valid(&self) -> bool {
        self.maximum_class <= PrivacyClass::Private
            && self.open.as_ref().is_none_or(|open| {
                open.hosts.len() <= MAX_HOSTS
                    && open.hosts.iter().all(|host| declared_host(host))
                    && open.hosts.windows(2).all(|pair| pair[0] < pair[1])
                    && open.apps.len() <= MAX_APPS
                    && open.apps.iter().all(|app| {
                        Locator::App { id: app.id.clone() }.valid()
                            && text(&app.label, MAX_LABEL_BYTES)
                    })
                    && open.roots.len() <= MAX_ROOTS
                    && open.roots.iter().all(|root| {
                        token(&root.id, MAX_ROOT_ID_BYTES)
                            && text(&root.label, MAX_LABEL_BYTES)
                            && root.path.starts_with('/')
                            && text(&root.path, MAX_ROOT_PATH_BYTES)
                            && !root.path.split('/').any(|part| part == "..")
                    })
                    && unique(open.apps.iter().map(|app| app.id.as_str()))
                    && unique(open.roots.iter().map(|root| root.id.as_str()))
                    && (!open.hosts.is_empty() || !open.apps.is_empty() || !open.roots.is_empty())
            })
            && self.play.as_ref().is_none_or(|play| {
                (1..=MAX_PROVIDERS).contains(&play.providers.len())
                    && play.providers.iter().all(|p| provider_id(p))
                    && play.providers.windows(2).all(|pair| pair[0] < pair[1])
            })
            && (self.open.is_some() || self.route.is_some() || self.play.is_some())
    }

    /// The channels this policy actually opens.
    pub fn channels(&self) -> Vec<Channel> {
        let mut channels = Vec::new();
        if self.open.is_some() {
            channels.push(Channel::ActionOpen);
        }
        if self.route.is_some() {
            channels.push(Channel::ActionRoute);
        }
        if self.play.is_some() {
            channels.push(Channel::ActionPlay);
        }
        channels
    }
}

fn unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut seen: Vec<&str> = values.collect();
    let count = seen.len();
    seen.sort_unstable();
    seen.dedup();
    seen.len() == count
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<Policy>,
}

/// One command the owner authored in Center. There are no parameters and no
/// shell string: `argv` is fixed here, and the runtime later sends only the
/// entry id and two digests, so nothing the model or a page says can become
/// an argument.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandEntry {
    pub id: String,
    pub label: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub mutates: bool,
    pub budget_ms: i64,
}

impl CommandEntry {
    fn valid(&self) -> bool {
        token(&self.id, MAX_ENTRY_ID_BYTES)
            && text(&self.label, MAX_LABEL_BYTES)
            && (MIN_ARGV..=MAX_ARGV).contains(&self.argv.len())
            && self.argv.iter().all(|value| {
                !value.is_empty()
                    && value.len() <= MAX_ARGV_BYTES
                    && !value.chars().any(char::is_control)
            })
            && self.cwd.starts_with('/')
            && text(&self.cwd, MAX_ROOT_PATH_BYTES)
            && !self.cwd.split('/').any(|part| part == "..")
            && !self.argv[0].split('/').any(|part| part == "..")
            && (1..=MAX_BUDGET_MS).contains(&self.budget_ms)
    }

    /// What the executing installation must find in its own copy of this
    /// policy before it spawns anything.
    pub fn argv_digest(&self) -> String {
        let canonical = serde_json::json!(["cosmos.device-command.argv", 1, self.argv, self.cwd]);
        hash(canonical.to_string().as_bytes())
    }

    /// The whole entry, so an owner editing it between decision and dispatch
    /// invalidates the bound command instead of changing what runs.
    pub fn entry_digest(&self) -> String {
        let canonical = serde_json::json!([
            "cosmos.device-command.entry",
            1,
            self.id,
            self.label,
            self.argv_digest(),
            self.mutates,
            self.budget_ms,
        ]);
        hash(canonical.to_string().as_bytes())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandPolicy {
    pub maximum_class: PrivacyClass,
    /// Whether a completed command's own output may be offered to a later
    /// turn's cognition, as a delimited untrusted block.
    pub offer_output_to_cognition: bool,
    pub entries: Vec<CommandEntry>,
}

impl CommandPolicy {
    fn valid(&self) -> bool {
        self.maximum_class <= PrivacyClass::Private
            && (1..=MAX_COMMAND_ENTRIES).contains(&self.entries.len())
            && self.entries.iter().all(CommandEntry::valid)
            && unique(self.entries.iter().map(|entry| entry.id.as_str()))
    }

    pub fn entry(&self, id: &str) -> Option<&CommandEntry> {
        self.entries.iter().find(|entry| entry.id == id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandApproval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<CommandPolicy>,
}

// ---------------------------------------------------------------------------
// The copy one installation holds
// ---------------------------------------------------------------------------

/// The longest policy document the runtime will commit for one installation.
/// The whole `policy` frame — this document, its digest and the frame's own
/// stamp — has to fit the 12 KiB realtime envelope, so a policy larger than
/// this is refused where the owner writes it instead of being delivered
/// truncated. Half an allowlist is worse than none.
pub const MAX_POLICY_BYTES: usize = 8 * 1024;

/// What this installation may be asked to open, route to or play, at the
/// owner's own revision of that permission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSection {
    pub revision: u64,
    pub maximum_class: PrivacyClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<OpenPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<RoutePolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play: Option<PlayPolicy>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSection {
    pub revision: u64,
    pub maximum_class: PrivacyClass,
    pub offer_output_to_cognition: bool,
    pub entries: Vec<CommandEntry>,
}

/// The owner's committed statement about one installation, as that
/// installation receives it. It is bound to the approval revision its
/// connection was opened at and carries only the operations that
/// installation's own approved manifest declares. Delivering it grants
/// nothing: the device still verifies every command against this copy, and a
/// device holding no copy carries nothing out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePolicy {
    pub version: u8,
    pub surface_id: Uuid,
    pub approval_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<ActionSection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<CommandSection>,
}

impl DevicePolicy {
    /// The one serialization the whole fleet hashes: compact JSON in
    /// declaration order, absent sections omitted. The shared client
    /// recomputes it from its own struct, so a drift refuses the policy
    /// instead of quietly widening or narrowing what a device may do.
    pub fn document(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn content_digest(&self) -> String {
        hash(self.document().as_bytes())
    }

    pub fn fits(&self) -> bool {
        self.document().len() <= MAX_POLICY_BYTES
    }
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

impl super::RuntimeState {
    fn action_record(
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
    ) -> Result<&crate::surface_registry::Record, super::RuntimeError> {
        records
            .get(&surface)
            .filter(|r| {
                !r.revoked && matches!(r.binding, crate::surface_registry::Binding::Native { .. })
            })
            .ok_or(super::RuntimeError::InvalidOrigin)
    }

    pub(super) fn device_action_policy(
        &self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
    ) -> Result<Option<Approval>, super::RuntimeError> {
        let record = Self::action_record(records, surface)?;
        Ok(self
            .device_action_policies
            .get(&surface)
            .filter(|a| a.approval_revision == record.revision)
            .cloned())
    }

    pub(super) fn device_command_policy(
        &self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
    ) -> Result<Option<CommandApproval>, super::RuntimeError> {
        let record = Self::action_record(records, surface)?;
        Ok(self
            .device_command_policies
            .get(&surface)
            .filter(|a| a.approval_revision == record.revision)
            .cloned())
    }

    /// Every action channel this installation currently holds: declared by
    /// its approved manifest and opened by the owner's policy at that same
    /// approval revision. Both, or nothing.
    pub(super) fn action_channels(
        &self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
    ) -> Vec<Channel> {
        let Ok(record) = Self::action_record(records, surface) else {
            return Vec::new();
        };
        let mut channels: Vec<Channel> = self
            .device_action_policy(records, surface)
            .ok()
            .flatten()
            .and_then(|approval| approval.policy)
            .map(|policy| policy.channels())
            .unwrap_or_default();
        if self
            .device_command_policy(records, surface)
            .ok()
            .flatten()
            .and_then(|approval| approval.policy)
            .is_some_and(|policy| !policy.entries.is_empty())
        {
            channels.push(Channel::ActionRun);
        }
        channels
            .retain(|channel| crate::surface_registry::native_declares(record, channel.as_str()));
        channels
    }

    /// The owner's committed policy for one installation, as that
    /// installation receives it. Both halves are already bound to the
    /// approval revision, so reapproving or revoking the installation leaves
    /// nothing to deliver; a section whose channel the installation's own
    /// approved manifest does not declare is dropped here as well, so
    /// delivery can never reach an operation the owner never approved.
    pub(super) fn device_policy(
        &self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
    ) -> Result<Option<DevicePolicy>, super::RuntimeError> {
        let record = Self::action_record(records, surface)?;
        if !crate::surface_registry::known_native_manifest(record) {
            return Err(super::RuntimeError::InvalidOrigin);
        }
        let declares =
            |channel: Channel| crate::surface_registry::native_declares(record, channel.as_str());
        let actions = self
            .device_action_policy(records, surface)?
            .and_then(|approval| {
                let policy = approval.policy?;
                let section = ActionSection {
                    revision: approval.revision,
                    maximum_class: policy.maximum_class,
                    open: policy.open.filter(|_| declares(Channel::ActionOpen)),
                    route: policy.route.filter(|_| declares(Channel::ActionRoute)),
                    play: policy.play.filter(|_| declares(Channel::ActionPlay)),
                };
                (section.open.is_some() || section.route.is_some() || section.play.is_some())
                    .then_some(section)
            });
        let commands = self
            .device_command_policy(records, surface)?
            .and_then(|approval| {
                let policy = approval.policy.filter(|_| declares(Channel::ActionRun))?;
                (!policy.entries.is_empty()).then_some(CommandSection {
                    revision: approval.revision,
                    maximum_class: policy.maximum_class,
                    offer_output_to_cognition: policy.offer_output_to_cognition,
                    entries: policy.entries,
                })
            });
        if actions.is_none() && commands.is_none() {
            return Ok(None);
        }
        let policy = DevicePolicy {
            version: 1,
            surface_id: surface,
            approval_revision: record.revision,
            actions,
            commands,
        };
        // Unreachable while both writers apply the same bound, and never
        // truncated: an installation is told it holds no policy instead.
        Ok(policy.fits().then_some(policy))
    }

    /// The document one more committed permission would produce. A policy the
    /// owner writes has to be deliverable whole, so this is checked where the
    /// owner can still do something about it rather than at dispatch.
    fn policy_fits(
        &self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
        actions: Option<&Policy>,
        commands: Option<&CommandPolicy>,
    ) -> bool {
        let record = &records[&surface];
        DevicePolicy {
            version: 1,
            surface_id: surface,
            approval_revision: record.revision,
            actions: actions.map(|policy| ActionSection {
                revision: u64::MAX,
                maximum_class: policy.maximum_class,
                open: policy.open.clone(),
                route: policy.route,
                play: policy.play.clone(),
            }),
            commands: commands.map(|policy| CommandSection {
                revision: u64::MAX,
                maximum_class: policy.maximum_class,
                offer_output_to_cognition: policy.offer_output_to_cognition,
                entries: policy.entries.clone(),
            }),
        }
        .fits()
    }

    pub(super) fn set_device_action_policy(
        &mut self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<(Approval, Vec<super::RuntimeData>), super::RuntimeError> {
        let current = self.device_action_policy(records, surface)?;
        let record = &records[&surface];
        if record.revision != approval_revision
            || current.as_ref().map_or(0, |a| a.revision) != expected_revision
        {
            return Err(super::RuntimeError::Stale);
        }
        if let Some(policy) = &policy {
            if !policy.valid() {
                return Err(super::RuntimeError::InvalidRequest);
            }
            // An operation this installation's manifest does not declare is
            // not a permission the owner can write here.
            if !policy
                .channels()
                .iter()
                .all(|channel| crate::surface_registry::native_declares(record, channel.as_str()))
            {
                return Err(super::RuntimeError::InvalidRequest);
            }
            if policy.maximum_class > self.action_ceiling(records, surface) {
                return Err(super::RuntimeError::PolicyBlocked);
            }
            // A permission the installation could never be told about is not
            // a permission. Say so here, where the owner is still editing it.
            let commands = self
                .device_command_policy(records, surface)?
                .and_then(|approval| approval.policy);
            if !self.policy_fits(records, surface, Some(policy), commands.as_ref()) {
                return Err(super::RuntimeError::InvalidRequest);
            }
        }
        let approval = Approval {
            approval_revision,
            revision: expected_revision
                .checked_add(1)
                .ok_or(super::RuntimeError::Unavailable)?,
            policy,
        };
        self.device_action_policies
            .insert(surface, approval.clone());
        Ok((
            approval.clone(),
            vec![super::RuntimeData::DeviceActionPolicyChanged {
                surface_id: surface,
                approval: Box::new(approval),
            }],
        ))
    }

    pub(super) fn set_device_command_policy(
        &mut self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<CommandPolicy>,
    ) -> Result<(CommandApproval, Vec<super::RuntimeData>), super::RuntimeError> {
        let current = self.device_command_policy(records, surface)?;
        let record = &records[&surface];
        if record.revision != approval_revision
            || current.as_ref().map_or(0, |a| a.revision) != expected_revision
        {
            return Err(super::RuntimeError::Stale);
        }
        if let Some(policy) = &policy {
            if !policy.valid() {
                return Err(super::RuntimeError::InvalidRequest);
            }
            if !crate::surface_registry::native_declares(record, Channel::ActionRun.as_str())
                || policy.maximum_class > self.action_ceiling(records, surface)
            {
                return Err(super::RuntimeError::PolicyBlocked);
            }
            // A label the runtime would classify above `private` could never
            // be routed anywhere, so the entry would be permanently
            // unrunnable and indistinguishable from a capability miss. Say so
            // at policy-write time instead.
            if policy.entries.iter().any(|entry| {
                super::runtime::input_privacy(&entry.label) > super::PrivacyClass::Private
            }) {
                return Err(super::RuntimeError::PolicyBlocked);
            }
            // The command list is the half that grows. A list the runtime
            // could not deliver whole is refused where the owner writes it.
            let actions = self
                .device_action_policy(records, surface)?
                .and_then(|approval| approval.policy);
            if !self.policy_fits(records, surface, actions.as_ref(), Some(policy)) {
                return Err(super::RuntimeError::InvalidRequest);
            }
        }
        let approval = CommandApproval {
            approval_revision,
            revision: expected_revision
                .checked_add(1)
                .ok_or(super::RuntimeError::Unavailable)?,
            policy,
        };
        self.device_command_policies
            .insert(surface, approval.clone());
        Ok((
            approval.clone(),
            vec![super::RuntimeData::DeviceCommandPolicyChanged {
                surface_id: surface,
                approval: Box::new(approval),
            }],
        ))
    }

    /// The highest class an action policy may name for this installation: the
    /// personal declaration the owner already made for it, or the shared-room
    /// ceiling every surface starts from.
    fn action_ceiling(
        &self,
        records: &std::collections::BTreeMap<uuid::Uuid, crate::surface_registry::Record>,
        surface: uuid::Uuid,
    ) -> super::PrivacyClass {
        self.personal_ceiling(records, surface)
            .unwrap_or(super::PrivacyClass::SharedRoom)
    }
}

// ---------------------------------------------------------------------------
// Candidates and binding
// ---------------------------------------------------------------------------

use std::collections::BTreeMap;
use uuid::Uuid;

use crate::surface_registry::Record;

/// One runtime-minted reference this turn may name. The label is everything
/// cognition may learn about it: a choice title or an owner's command label,
/// and nothing at all for a document the owner is reading.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionCandidate {
    pub reference: String,
    pub kind: CandidateKind,
    pub label: String,
    pub mutates: bool,
}

/// What this turn's cognition is told: which kinds of operation some approved
/// installation could carry out, and the candidate identifiers. No surface
/// identity, no count of devices and no platform name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionOffer {
    pub operations: Vec<OperationKind>,
    pub candidates: Vec<ActionCandidate>,
}

impl ActionOffer {
    pub fn is_empty(&self) -> bool {
        self.operations.is_empty() || self.candidates.is_empty()
    }

    pub fn kinds(&self) -> Vec<CandidateKind> {
        let mut kinds: Vec<_> = self.candidates.iter().map(|c| c.kind).collect();
        kinds.sort_unstable();
        kinds.dedup();
        kinds
    }
}

impl CandidateKind {
    /// The one operation a candidate of this kind can be bound into. A
    /// proposal whose operation disagrees with its reference is a parse
    /// failure: the runtime does not guess what was meant.
    pub fn operation(self) -> OperationKind {
        match self {
            Self::Choice => OperationKind::Play,
            Self::Place => OperationKind::Route,
            Self::Document | Self::Continuation => OperationKind::Open,
            Self::Command => OperationKind::Run,
        }
    }

    fn channel(self) -> Channel {
        match self.operation() {
            OperationKind::Open => Channel::ActionOpen,
            OperationKind::Route => Channel::ActionRoute,
            OperationKind::Play => Channel::ActionPlay,
            OperationKind::Run => Channel::ActionRun,
        }
    }
}

pub fn reference_digest(reference: &str) -> String {
    hash(reference.as_bytes())
}

/// `(deviceId, epoch, sequence, actionInstanceId)` deduplicated at the
/// receiving end. A retry carries the same action id, which is the point of
/// the key, so the sequence adds nothing.
pub fn idempotency_key(surface_id: Uuid, incarnation: Uuid, action_id: Uuid) -> String {
    let canonical = serde_json::json!(["cosmos.action-key", 1, surface_id, incarnation, action_id]);
    hash(canonical.to_string().as_bytes())
}

/// The digest of one item of an acknowledged list, bound to that exact list.
pub fn item_digest(list_digest: &str, item_id: &str) -> String {
    let canonical = serde_json::json!(["cosmos.action-item", 1, list_digest, item_id]);
    hash(canonical.to_string().as_bytes())
}

impl super::RuntimeState {
    /// Whether the owner's own policy for this installation admits this exact
    /// bound command, at the installation's current approval revision.
    pub(super) fn action_permits(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        operation: &Operation,
    ) -> bool {
        let Ok(record) = Self::action_record(records, surface) else {
            return false;
        };
        if !crate::surface_registry::native_declares(record, operation.channel().as_str()) {
            return false;
        }
        let policy = self
            .device_action_policy(records, surface)
            .ok()
            .flatten()
            .and_then(|approval| approval.policy);
        match operation {
            Operation::Open { locator, .. } => policy
                .as_ref()
                .and_then(|policy| policy.open.as_ref())
                .is_some_and(|open| match locator {
                    Locator::Https { .. } => locator
                        .host()
                        .is_some_and(|host| open.hosts.contains(&host)),
                    Locator::App { id } => open.apps.iter().any(|app| app.id == *id),
                    Locator::File { root_id, .. } => {
                        open.roots.iter().any(|root| root.id == *root_id)
                    }
                }),
            Operation::Route { .. } => policy.as_ref().is_some_and(|p| p.route.is_some()),
            Operation::Play { providers, .. } => policy
                .as_ref()
                .and_then(|policy| policy.play.as_ref())
                .is_some_and(|play| {
                    providers
                        .iter()
                        .all(|provider| play.providers.contains(provider))
                }),
            // An owner editing an entry between decision and dispatch
            // invalidates the bound command instead of changing what runs.
            Operation::Run {
                entry_id,
                entry_digest,
                ..
            } => self
                .device_command_policy(records, surface)
                .ok()
                .flatten()
                .and_then(|approval| approval.policy)
                .and_then(|policy| policy.entry(entry_id).cloned())
                .is_some_and(|entry| entry.entry_digest() == *entry_digest),
        }
    }

    /// The candidate identifiers this turn may name and the operations some
    /// approved installation could carry out with them.
    pub(super) fn action_offer(
        &self,
        records: &BTreeMap<Uuid, Record>,
        turn: &super::Turn,
        now: i64,
    ) -> ActionOffer {
        // Untrusted content and command execution never meet. A turn whose
        // prompt carries a delimited block from the owner's screen is offered
        // no command candidate at all, so a page the owner is reading cannot
        // name a process.
        let untrusted = turn.screen_context.is_some();
        // A private document is named to cognition only on a turn already at
        // that class whose origin holds the permission that already carries
        // the owner's own private text there.
        let personal = turn.privacy >= PrivacyClass::Private
            && untrusted
            && self.screen_context_permitted(records, turn.fence.origin_surface);
        let mut candidates = Vec::new();
        for context in self.recent_context.iter().filter(|c| now < c.expires_at_ms) {
            match context.kind {
                super::RecentContextKind::Choices
                    if context.privacy <= PrivacyClass::SharedRoom
                        && context.list_digest.is_some() =>
                {
                    for (index, title) in context.items.iter().enumerate() {
                        candidates.push(ActionCandidate {
                            reference: format!("choice:{}", index + 1),
                            kind: CandidateKind::Choice,
                            label: title.clone(),
                            mutates: false,
                        });
                    }
                }
                super::RecentContextKind::Continuation
                    if personal && context.privacy <= turn.privacy =>
                {
                    candidates.push(ActionCandidate {
                        reference: "cont:1".into(),
                        kind: CandidateKind::Continuation,
                        label: String::new(),
                        mutates: false,
                    });
                }
                _ => {}
            }
        }
        if personal
            && turn
                .screen_context
                .as_ref()
                .is_some_and(|offered| offered.document.is_some())
        {
            candidates.push(ActionCandidate {
                reference: "doc:1".into(),
                kind: CandidateKind::Document,
                label: String::new(),
                mutates: false,
            });
        }
        if !untrusted {
            for record in records.values().filter(|r| !r.revoked) {
                let entries = self
                    .device_command_policy(records, record.surface_id)
                    .ok()
                    .flatten()
                    .and_then(|approval| approval.policy)
                    .filter(|_| {
                        crate::surface_registry::native_declares(
                            record,
                            Channel::ActionRun.as_str(),
                        )
                    });
                for entry in entries.iter().flat_map(|policy| policy.entries.iter()) {
                    let reference = format!("cmd:{}", entry.id);
                    if candidates.iter().any(|c| c.reference == reference) {
                        continue;
                    }
                    candidates.push(ActionCandidate {
                        reference,
                        kind: CandidateKind::Command,
                        label: entry.label.clone(),
                        mutates: entry.mutates,
                    });
                }
            }
        }
        // A candidate is only offered when some approved installation could
        // actually carry out its operation at this turn's class. Whether a
        // specific locator or entry resolves there is checked when the
        // reference is bound, and again at dispatch.
        let mut operations: Vec<OperationKind> = Vec::new();
        candidates.retain(|candidate| {
            let channel = candidate.kind.channel();
            let reachable = records.values().filter(|r| !r.revoked).any(|record| {
                self.action_channels(records, record.surface_id)
                    .contains(&channel)
                    && self
                        .candidate(
                            records,
                            record,
                            turn.fence.origin_surface,
                            channel,
                            turn.privacy,
                            None,
                            None,
                            now,
                        )
                        .blocker
                        .is_none()
            });
            if reachable && !operations.contains(&candidate.kind.operation()) {
                operations.push(candidate.kind.operation());
            }
            reachable
        });
        ActionOffer {
            operations,
            candidates,
        }
    }

    /// Resolve one proposed reference into a bound command. Everything the
    /// command names comes from state the runtime committed itself.
    pub(super) fn bind_device_action(
        &self,
        records: &BTreeMap<Uuid, Record>,
        turn: &super::Turn,
        kind: OperationKind,
        reference: &str,
        now: i64,
    ) -> Result<(Operation, CandidateKind), super::RuntimeError> {
        let offer = self.action_offer(records, turn, now);
        let candidate = offer
            .candidates
            .iter()
            .find(|candidate| candidate.reference == reference)
            .ok_or(super::RuntimeError::InvalidRequest)?;
        if candidate.kind.operation() != kind {
            return Err(super::RuntimeError::InvalidRequest);
        }
        let operation = match candidate.kind {
            CandidateKind::Choice => {
                let context = self
                    .recent_context
                    .iter()
                    .find(|c| c.kind == super::RecentContextKind::Choices && now < c.expires_at_ms)
                    .ok_or(super::RuntimeError::Stale)?;
                let list_digest = context
                    .list_digest
                    .as_deref()
                    .ok_or(super::RuntimeError::Stale)?;
                let item_id = reference
                    .split_once(':')
                    .map(|(_, id)| id)
                    .ok_or(super::RuntimeError::InvalidRequest)?;
                let providers = self.play_providers(records, turn, now);
                Operation::Play {
                    title: candidate.label.clone(),
                    query: candidate.label.clone(),
                    providers,
                    item_digest: item_digest(list_digest, item_id),
                }
            }
            CandidateKind::Document => {
                let document = turn
                    .screen_context
                    .as_ref()
                    .and_then(|offered| offered.document.clone())
                    .ok_or(super::RuntimeError::Stale)?;
                Operation::Open {
                    locator: document.locator,
                    version: document.version,
                    position: document.position,
                    label: document.label,
                }
            }
            CandidateKind::Continuation => {
                let continuation = self
                    .recent_context
                    .iter()
                    .filter(|c| now < c.expires_at_ms)
                    .find_map(|c| c.continuation.clone())
                    .ok_or(super::RuntimeError::Stale)?;
                Operation::Open {
                    locator: continuation.document.locator,
                    version: continuation.document.version,
                    position: continuation.document.position,
                    label: continuation.document.label,
                }
            }
            CandidateKind::Command => {
                let entry_id = reference
                    .split_once(':')
                    .map(|(_, id)| id)
                    .ok_or(super::RuntimeError::InvalidRequest)?;
                let entry = records
                    .values()
                    .filter(|r| !r.revoked)
                    .filter_map(|record| {
                        self.device_command_policy(records, record.surface_id)
                            .ok()
                            .flatten()
                            .and_then(|approval| approval.policy)
                            .and_then(|policy| policy.entry(entry_id).cloned())
                    })
                    .next()
                    .ok_or(super::RuntimeError::Stale)?;
                Operation::Run {
                    entry_id: entry.id.clone(),
                    label: entry.label.clone(),
                    entry_digest: entry.entry_digest(),
                    argv_digest: entry.argv_digest(),
                    budget_ms: entry.budget_ms,
                    mutates: entry.mutates,
                }
            }
            // A place is bound by the runtime from its own completed receipt,
            // never from a reference cognition proposed.
            CandidateKind::Place => return Err(super::RuntimeError::InvalidRequest),
        };
        if !operation.valid() {
            return Err(super::RuntimeError::InvalidRequest);
        }
        Ok((operation, candidate.kind))
    }

    /// The providers the leading eligible player declares. Playback is bound
    /// for the device the ranking already selects, so the digest the client
    /// recomputes matches the policy copy it holds.
    fn play_providers(
        &self,
        records: &BTreeMap<Uuid, Record>,
        turn: &super::Turn,
        now: i64,
    ) -> Vec<String> {
        let mut candidates: Vec<_> = records
            .values()
            .filter(|r| !r.revoked)
            .map(|record| {
                self.candidate(
                    records,
                    record,
                    turn.fence.origin_surface,
                    Channel::ActionPlay,
                    turn.privacy,
                    None,
                    None,
                    now,
                )
            })
            .collect();
        super::policy::rank(&mut candidates);
        candidates
            .iter()
            .find(|c| c.blocker.is_none())
            .and_then(|c| {
                self.device_action_policy(records, c.surface_id)
                    .ok()
                    .flatten()
                    .and_then(|approval| approval.policy)
                    .and_then(|policy| policy.play)
            })
            .map(|play| play.providers)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str =
        include_str!("../../../../../contracts/fixtures/ambiance-device-action-digests-v1.json");

    fn vector(name: &str) -> (String, String) {
        let file: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let case = file["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap_or_else(|| panic!("missing digest vector: {name}"));
        (
            case["encoded"].as_str().unwrap().to_owned(),
            case["digest"].as_str().unwrap().to_owned(),
        )
    }

    fn entry() -> CommandEntry {
        CommandEntry {
            id: "project-tests".into(),
            label: "Project tests".into(),
            argv: vec!["./revival".into(), "check".into(), "cosmos".into()],
            cwd: "/Users/owner/Projects/ai-pin-revival".into(),
            mutates: true,
            budget_ms: 900_000,
        }
    }

    /// Every implementation that binds, renders or verifies a device action
    /// recomputes these; one drift refuses every action with no useful error.
    #[test]
    fn ambiance_device_action_digest_matches_the_canonical_tuple() {
        let file: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let cases = file["cases"].as_array().unwrap();
        let mut names: Vec<_> = cases.iter().map(|case| case["name"].clone()).collect();
        names.dedup();
        assert_eq!(names.len(), cases.len(), "duplicate digest vector");
        for case in cases {
            let encoded = case["encoded"].as_str().unwrap();
            assert_eq!(
                encoded,
                serde_json::to_string(&case["canonical"]).unwrap(),
                "vector {} is not its own compact encoding",
                case["name"]
            );
            assert_eq!(
                case["digest"].as_str().unwrap(),
                crate::surface_registry::hash(encoded.as_bytes()),
                "vector {} digest",
                case["name"]
            );
        }

        let list_digest = format!("3f9c{}", "1".repeat(60));
        let item = item_digest(&list_digest, "2");
        assert_eq!(item, vector("action-item").1);
        let argv = entry().argv_digest();
        assert_eq!(argv, vector("command-argv").1);
        let entry_digest = entry().entry_digest();
        assert_eq!(entry_digest, vector("command-entry").1);
        assert_eq!(
            idempotency_key(
                "b1d4a0f2-0000-4000-8000-000000000001".parse().unwrap(),
                "77e0a0f2-0000-4000-8000-000000000002".parse().unwrap(),
                "6a1fa0f2-0000-4000-8000-000000000003".parse().unwrap(),
            ),
            vector("action-key").1
        );

        let operations = [
            (
                "open-https",
                Operation::Open {
                    locator: Locator::Https {
                        url: "https://github.com/owner/repo/pull/412".into(),
                    },
                    version: None,
                    position: Some(Position::Fragment {
                        value: "discussion_r1".into(),
                    }),
                    label: "PR 412".into(),
                },
            ),
            (
                "open-file-line",
                Operation::Open {
                    locator: Locator::File {
                        root_id: "repo".into(),
                        relative: "cosmos/crates/cosmos/src/ambiance/state.rs".into(),
                    },
                    version: Some(format!("7c40{}", "0".repeat(60))),
                    position: Some(Position::Line { line: 1710 }),
                    label: "state.rs".into(),
                },
            ),
            (
                "open-app",
                Operation::Open {
                    locator: Locator::App {
                        id: "dev.zed.Zed".into(),
                    },
                    version: None,
                    position: None,
                    label: "Zed".into(),
                },
            ),
            (
                "route",
                Operation::Route {
                    place_id: "ChIJa1b2c3d4e5f6".into(),
                    name: "Restaurant Barr".into(),
                    address: "Strandgade 93, 1401 København".into(),
                    lat: "55.673611".into(),
                    lng: "12.596944".into(),
                },
            ),
            (
                "play",
                Operation::Play {
                    title: "The Zone of Interest trailer".into(),
                    query: "The Zone of Interest trailer".into(),
                    providers: vec!["youtube".into()],
                    item_digest: item,
                },
            ),
            (
                "run",
                Operation::Run {
                    entry_id: "project-tests".into(),
                    label: "Project tests".into(),
                    entry_digest,
                    argv_digest: argv,
                    budget_ms: 900_000,
                    mutates: true,
                },
            ),
        ];
        for (name, operation) in operations {
            assert!(operation.valid(), "{name}");
            assert_eq!(operation.content_digest(), vector(name).1, "{name}");
        }
        let description = Description {
            kind: DescriptionKind::DeviceAction,
            verb: "run".into(),
            subject: "Project tests".into(),
            device_kind: "macos".into(),
            effect: "changes files in that project".into(),
            class: PrivacyClass::Private,
        };
        assert!(description.valid());
        assert_eq!(description.content_digest(), vector("confirm").1);
    }

    #[test]
    fn ambiance_device_action_rejects_out_of_bounds_fields() {
        let base = Operation::Play {
            title: "Trailer".into(),
            query: "Trailer".into(),
            providers: vec!["youtube".into()],
            item_digest: "a".repeat(64),
        };
        assert!(base.valid());
        for invalid in [
            Operation::Play {
                title: "x".repeat(MAX_TITLE_BYTES + 1),
                query: "Trailer".into(),
                providers: vec!["youtube".into()],
                item_digest: "a".repeat(64),
            },
            Operation::Play {
                title: "Trailer".into(),
                query: "x".repeat(MAX_QUERY_BYTES + 1),
                providers: vec!["youtube".into()],
                item_digest: "a".repeat(64),
            },
            // Providers are a sorted, bounded, non-empty set.
            Operation::Play {
                title: "Trailer".into(),
                query: "Trailer".into(),
                providers: Vec::new(),
                item_digest: "a".repeat(64),
            },
            Operation::Play {
                title: "Trailer".into(),
                query: "Trailer".into(),
                providers: vec!["youtube".into(), "netflix".into()],
                item_digest: "a".repeat(64),
            },
            Operation::Play {
                title: "Trailer".into(),
                query: "Trailer".into(),
                providers: vec!["youtube".into()],
                item_digest: "A".repeat(64),
            },
            // A command entry names an owner label and a bounded budget.
            Operation::Run {
                entry_id: "Project-Tests".into(),
                label: "Project tests".into(),
                entry_digest: "a".repeat(64),
                argv_digest: "b".repeat(64),
                budget_ms: 1000,
                mutates: false,
            },
            Operation::Run {
                entry_id: "project-tests".into(),
                label: "Project tests".into(),
                entry_digest: "a".repeat(64),
                argv_digest: "b".repeat(64),
                budget_ms: MAX_BUDGET_MS + 1,
                mutates: false,
            },
            Operation::Open {
                locator: Locator::App {
                    id: "dev.zed.Zed".into(),
                },
                version: None,
                position: Some(Position::Line { line: 0 }),
                label: "Zed".into(),
            },
            Operation::Open {
                locator: Locator::App {
                    id: "dev.zed.Zed".into(),
                },
                version: Some("short".into()),
                position: None,
                label: "Zed".into(),
            },
            Operation::Open {
                locator: Locator::App {
                    id: "dev.zed.Zed".into(),
                },
                version: None,
                position: None,
                label: "  ".into(),
            },
        ] {
            assert!(!invalid.valid(), "{invalid:?}");
        }
    }

    #[test]
    fn ambiance_device_action_coordinates_are_canonical_decimal_strings() {
        assert_eq!(coordinate(55.6736111).as_deref(), Some("55.673611"));
        assert_eq!(coordinate(-0.0000001).as_deref(), Some("0.000000"));
        assert_eq!(coordinate(-12.5).as_deref(), Some("-12.500000"));
        assert_eq!(coordinate(0.0).as_deref(), Some("0.000000"));
        assert_eq!(coordinate(f64::NAN), None);
        assert_eq!(coordinate(f64::INFINITY), None);
        assert_eq!(coordinate(181.0), None);
        let route = |lat: &str, lng: &str| Operation::Route {
            place_id: "ChIJ1".into(),
            name: "Barr".into(),
            address: "Strandgade 93".into(),
            lat: lat.into(),
            lng: lng.into(),
        };
        assert!(route("55.673611", "12.596944").valid());
        assert!(route("-90.000000", "180.000000").valid());
        // Anything a float formatter might emit instead is refused.
        for (lat, lng) in [
            ("55.6736", "12.596944"),
            ("55.6736110", "12.596944"),
            ("55", "12.596944"),
            ("+55.673611", "12.596944"),
            ("55.673611", "180.000001"),
            ("90.000001", "12.596944"),
            ("055.673611", "12.596944"),
            ("5.5673611e1", "12.596944"),
        ] {
            assert!(!route(lat, lng).valid(), "{lat} {lng}");
        }
    }

    #[test]
    fn ambiance_device_action_locator_rejects_traversal_userinfo_and_ports() {
        assert!(
            Locator::Https {
                url: "https://github.com/owner/repo".into()
            }
            .valid()
        );
        for url in [
            "http://github.com/",
            "https://user:pass@github.com/",
            "https://github.com:8443/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://github.com/a b",
            "https://github.com/a\\b",
            "https://",
        ] {
            assert!(
                !Locator::Https {
                    url: url.to_owned()
                }
                .valid(),
                "{url}"
            );
        }
        assert!(
            Locator::File {
                root_id: "repo".into(),
                relative: "src/main.rs".into()
            }
            .valid()
        );
        for relative in [
            "../etc/passwd",
            "/etc/passwd",
            "a/../b",
            "./a",
            "a//b",
            "",
            "a/b\\c",
            &"x".repeat(MAX_RELATIVE_BYTES + 1),
        ] {
            assert!(
                !Locator::File {
                    root_id: "repo".into(),
                    relative: relative.to_owned()
                }
                .valid(),
                "{relative}"
            );
        }
        for root in [
            "",
            "Repo",
            "repo/../other",
            &"r".repeat(MAX_ROOT_ID_BYTES + 1),
        ] {
            assert!(
                !Locator::File {
                    root_id: root.to_owned(),
                    relative: "src/main.rs".into()
                }
                .valid(),
                "{root}"
            );
        }
        // A declared host is a bare lowercase name, never a URL.
        assert!(declared_host("github.com"));
        for host in [
            "GitHub.com",
            "https://github.com",
            "github.com:443",
            "github.com/a",
            "localhost",
            ".github.com",
            "github..com",
        ] {
            assert!(!declared_host(host), "{host}");
        }
    }

    /// The wire shape the clients decode: tagged, camel-cased and strict.
    #[test]
    fn ambiance_device_action_operation_is_strict_camel_cased_wire() {
        let operation = Operation::Run {
            entry_id: "project-tests".into(),
            label: "Project tests".into(),
            entry_digest: "a".repeat(64),
            argv_digest: "b".repeat(64),
            budget_ms: 900_000,
            mutates: true,
        };
        assert_eq!(
            serde_json::to_value(&operation).unwrap(),
            serde_json::json!({
                "kind": "run", "entryId": "project-tests", "label": "Project tests",
                "entryDigest": "a".repeat(64), "argvDigest": "b".repeat(64),
                "budgetMs": 900_000, "mutates": true
            })
        );
        assert_eq!(
            serde_json::from_value::<Operation>(serde_json::to_value(&operation).unwrap()).unwrap(),
            operation
        );
        // An unknown field or an unknown operation kind never parses.
        for invalid in [
            serde_json::json!({"kind":"run","entryId":"a","label":"a","entryDigest":"a","argvDigest":"b","budgetMs":1,"mutates":true,"argv":["rm"]}),
            serde_json::json!({"kind":"exec","entryId":"a"}),
        ] {
            assert!(serde_json::from_value::<Operation>(invalid).is_err());
        }
        assert_eq!(
            serde_json::to_value(Locator::File {
                root_id: "repo".into(),
                relative: "src/main.rs".into()
            })
            .unwrap(),
            serde_json::json!({"scheme":"file","rootId":"repo","relative":"src/main.rs"})
        );
    }

    // ---- owner permissions and runtime-minted candidates ----

    use crate::ambiance::{
        Action, ActionStatus, BrowserProof, OriginProof, RoomProof, RuntimeData, RuntimeError,
        RuntimeOperation, RuntimeResult, RuntimeState, SemanticIntent, TurnFence, grant,
    };
    use crate::surface_registry::{Mutation, Record, hash, transition};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    const NOW: i64 = 1_000;

    fn native(platform: &str) -> Record {
        transition(
            None,
            0,
            Uuid::new_v4(),
            &Mutation::ApproveNative {
                enrollment_id: Uuid::new_v4(),
                public_key: "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU".into(),
                platform: platform.into(),
                expected_revision: 0,
            },
            100,
        )
        .unwrap()
        .0
    }

    fn browser() -> Record {
        let (record, _) = transition(
            None,
            0,
            Uuid::new_v4(),
            &Mutation::Approve {
                token_hash: hash(b"browser"),
                incarnation: Uuid::new_v4(),
            },
            100,
        )
        .unwrap();
        transition(
            Some(&record),
            1,
            record.surface_id,
            &Mutation::State {
                token_hash: record.token_hash.clone(),
                incarnation: record.incarnation,
                sequence: 1,
                visible: true,
            },
            100,
        )
        .unwrap()
        .0
    }

    struct Fixture {
        state: RuntimeState,
        records: BTreeMap<Uuid, Record>,
        origin: Uuid,
        proofs: BTreeMap<Uuid, crate::ambiance::NativeProof>,
    }

    impl Fixture {
        fn new(platforms: &[&str]) -> (Self, Vec<Uuid>) {
            let origin_record = browser();
            let origin = origin_record.surface_id;
            let mut records = BTreeMap::from([(origin, origin_record)]);
            let mut state = RuntimeState::default();
            let mut ids = Vec::new();
            let mut proofs = BTreeMap::new();
            for platform in platforms {
                let record = native(platform);
                proofs.insert(
                    record.surface_id,
                    state.connect_native_for_test(&record, NOW),
                );
                ids.push(record.surface_id);
                records.insert(record.surface_id, record);
            }
            (
                Fixture {
                    state,
                    records,
                    origin,
                    proofs,
                },
                ids,
            )
        }

        fn apply(
            &mut self,
            operation: RuntimeOperation,
            now: i64,
        ) -> Result<RuntimeResult, RuntimeError> {
            self.state
                .apply("U:owner", &self.records, operation, now)
                .map(|(result, _)| result)
        }

        fn events(
            &mut self,
            operation: RuntimeOperation,
            now: i64,
        ) -> Vec<crate::ambiance::RuntimeData> {
            self.state
                .apply("U:owner", &self.records, operation, now)
                .unwrap()
                .1
        }

        /// Begin a turn from an approved native installation, so its own
        /// permissions govern what this turn may be offered.
        fn begin_from(&mut self, surface: Uuid) -> TurnFence {
            self.origin = surface;
            self.begin()
        }

        fn begin(&mut self) -> TurnFence {
            let turn_id = Uuid::new_v4();
            let proof = match self.proofs.get(&self.origin) {
                Some(proof) => OriginProof::SequencedRoom {
                    connection: RoomProof::Native(proof.clone()),
                    stamp: crate::ambiance::InputStamp {
                        epoch: self.state.ingress[&self.origin].epoch,
                        sequence: self.state.ingress[&self.origin].high_water + 1,
                        instance_id: turn_id,
                    },
                },
                None => {
                    let record = &self.records[&self.origin];
                    OriginProof::Browser(BrowserProof {
                        surface_id: record.surface_id,
                        incarnation: record.incarnation,
                        token_hash: record.token_hash.clone(),
                    })
                }
            };
            let RuntimeResult::Begun(fence) = self
                .apply(
                    RuntimeOperation::Begin {
                        turn_id,
                        worker: Uuid::new_v4(),
                        origin: proof,
                        request_digest: hash(b"request"),
                        privacy_floor: PrivacyClass::Public,
                    },
                    NOW + 1,
                )
                .unwrap()
            else {
                panic!("turn")
            };
            fence
        }

        fn allow_private(&mut self, surface: Uuid) {
            self.apply(
                RuntimeOperation::SetPrivatePolicy {
                    surface_id: surface,
                    approval_revision: self.records[&surface].revision,
                    expected_revision: 0,
                    policy: Some(crate::ambiance::personal::Policy {
                        maximum_class: PrivacyClass::Private,
                    }),
                },
                NOW,
            )
            .unwrap();
        }

        fn set_actions(
            &mut self,
            surface: Uuid,
            policy: Option<Policy>,
        ) -> Result<RuntimeResult, RuntimeError> {
            let revision = self.records[&surface].revision;
            let expected = self
                .state
                .device_action_policy(&self.records, surface)
                .unwrap()
                .map_or(0, |approval| approval.revision);
            self.apply(
                RuntimeOperation::SetDeviceActionPolicy {
                    surface_id: surface,
                    approval_revision: revision,
                    expected_revision: expected,
                    policy,
                },
                NOW,
            )
        }

        fn set_commands(
            &mut self,
            surface: Uuid,
            policy: Option<CommandPolicy>,
        ) -> Result<RuntimeResult, RuntimeError> {
            let revision = self.records[&surface].revision;
            let expected = self
                .state
                .device_command_policy(&self.records, surface)
                .unwrap()
                .map_or(0, |approval| approval.revision);
            self.apply(
                RuntimeOperation::SetDeviceCommandPolicy {
                    surface_id: surface,
                    approval_revision: revision,
                    expected_revision: expected,
                    policy,
                },
                NOW,
            )
        }
    }

    fn open_policy() -> Policy {
        Policy {
            maximum_class: PrivacyClass::SharedRoom,
            open: Some(OpenPolicy {
                hosts: vec!["github.com".into()],
                apps: Vec::new(),
                roots: vec![RootEntry {
                    id: "repo".into(),
                    label: "Projects".into(),
                    path: "/Users/owner/Projects".into(),
                }],
            }),
            route: None,
            play: None,
        }
    }

    fn command_policy() -> CommandPolicy {
        CommandPolicy {
            maximum_class: PrivacyClass::SharedRoom,
            offer_output_to_cognition: false,
            entries: vec![entry()],
        }
    }

    #[test]
    fn ambiance_device_action_policy_requires_the_current_approval_revision() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        // A stale approval revision or a stale policy revision is a conflict.
        assert!(matches!(
            fixture.apply(
                RuntimeOperation::SetDeviceActionPolicy {
                    surface_id: mac,
                    approval_revision: 99,
                    expected_revision: 0,
                    policy: Some(open_policy()),
                },
                NOW
            ),
            Err(RuntimeError::Stale)
        ));
        assert!(fixture.set_actions(mac, Some(open_policy())).is_ok());
        assert!(matches!(
            fixture.apply(
                RuntimeOperation::SetDeviceActionPolicy {
                    surface_id: mac,
                    approval_revision: fixture.records[&mac].revision,
                    expected_revision: 0,
                    policy: None,
                },
                NOW
            ),
            Err(RuntimeError::Stale)
        ));
        // Reapproving the installation drops the permission with the revision.
        let record = fixture.records.get_mut(&mac).unwrap();
        record.revision += 1;
        fixture.state.reconcile(&fixture.records, NOW);
        assert!(
            fixture
                .state
                .device_action_policy(&fixture.records, mac)
                .unwrap()
                .is_none()
        );
        assert!(
            fixture
                .state
                .action_channels(&fixture.records, mac)
                .is_empty()
        );
    }

    /// The owner's committed policy is a statement about one installation at
    /// one approval revision. It reaches that installation over the
    /// connection it already holds, carries only what its own manifest
    /// declares, and is gone the moment the approval revision moves.
    #[test]
    fn ambiance_device_policy_is_delivered_for_the_approval_revision_and_dropped_by_reapproval() {
        let (mut fixture, ids) = Fixture::new(&["macos", "android_tv"]);
        let (mac, tv) = (ids[0], ids[1]);
        // No permission, nothing to deliver: the device then does nothing.
        assert!(
            fixture
                .state
                .device_policy(&fixture.records, mac)
                .unwrap()
                .is_none()
        );
        fixture.set_actions(mac, Some(open_policy())).unwrap();
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let policy = fixture
            .state
            .device_policy(&fixture.records, mac)
            .unwrap()
            .expect("policy");
        assert_eq!(policy.version, 1);
        assert_eq!(policy.surface_id, mac);
        assert_eq!(policy.approval_revision, fixture.records[&mac].revision);
        assert_eq!(policy.actions.as_ref().unwrap().revision, 1);
        assert_eq!(policy.commands.as_ref().unwrap().revision, 1);
        assert_eq!(policy.commands.as_ref().unwrap().entries, vec![entry()]);
        assert!(policy.fits());

        // The shared client parses the runtime's own document, recomputes the
        // same digest from its own struct, and keeps the argv digests the
        // dispatched command is bound by.
        let held = cosmos_surface_client::DevicePolicy::parse(policy.document().as_bytes())
            .expect("the client accepts the runtime's document");
        assert_eq!(held.document(), policy.document());
        assert_eq!(held.content_digest(), policy.content_digest());
        let held_entry = held.entry("project-tests").expect("entry");
        assert_eq!(held_entry.argv_digest(), entry().argv_digest());
        assert_eq!(held_entry.entry_digest(), entry().entry_digest());
        assert_eq!(held.root("repo").unwrap().path, "/Users/owner/Projects");

        // A television declares play and no command channel at all, so its
        // own copy can never name one.
        fixture
            .set_actions(
                tv,
                Some(Policy {
                    maximum_class: PrivacyClass::SharedRoom,
                    open: None,
                    route: None,
                    play: Some(PlayPolicy {
                        providers: vec!["youtube".into()],
                    }),
                }),
            )
            .unwrap();
        let television = fixture
            .state
            .device_policy(&fixture.records, tv)
            .unwrap()
            .expect("policy");
        assert!(television.commands.is_none());
        let actions = television.actions.as_ref().unwrap();
        assert!(actions.open.is_none() && actions.route.is_none());
        assert_eq!(actions.play.as_ref().unwrap().providers, ["youtube"]);
        assert!(matches!(
            fixture.set_commands(tv, Some(command_policy())),
            Err(RuntimeError::PolicyBlocked)
        ));

        // Delivery follows the connection, not the foreground: a device has
        // to hold the copy before it can refuse against it, and a command
        // still waits for a reported foreground on its own invitation.
        fixture
            .state
            .native_connections
            .get_mut(&mac)
            .unwrap()
            .connection
            .as_mut()
            .unwrap()
            .visible = false;
        assert!(
            fixture
                .state
                .device_policy(&fixture.records, mac)
                .unwrap()
                .is_some()
        );

        // Reapproving the installation drops both permissions with the
        // revision, so there is nothing left to deliver.
        let record = fixture.records.get_mut(&mac).unwrap();
        record.revision += 1;
        fixture.state.reconcile(&fixture.records, NOW);
        assert!(
            fixture
                .state
                .device_policy(&fixture.records, mac)
                .unwrap()
                .is_none()
        );
        // A revoked installation has no policy either, and is not an origin.
        fixture.records.get_mut(&tv).unwrap().revoked = true;
        assert!(matches!(
            fixture.state.device_policy(&fixture.records, tv),
            Err(RuntimeError::InvalidOrigin)
        ));
    }

    /// Delivery reaches the installation the connection proves and no other,
    /// and a browser member has no policy of its own to receive.
    #[test]
    fn ambiance_device_policy_reaches_only_the_connected_installation_it_belongs_to() {
        let (mut fixture, ids) = Fixture::new(&["macos", "android"]);
        let (mac, phone) = (ids[0], ids[1]);
        fixture.set_actions(mac, Some(open_policy())).unwrap();
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let ask = |fixture: &mut Fixture, connection: RoomProof| {
            fixture.apply(RuntimeOperation::DevicePolicyFor { connection }, NOW + 1)
        };
        let proof = fixture.proofs[&mac].clone();
        let RuntimeResult::DevicePolicyFor(Some(policy)) =
            ask(&mut fixture, RoomProof::Native(proof)).unwrap()
        else {
            panic!("policy")
        };
        assert_eq!(policy.surface_id, mac);
        // The phone holds no permission of its own, so it receives none.
        let phone_proof = fixture.proofs[&phone].clone();
        assert!(matches!(
            ask(&mut fixture, RoomProof::Native(phone_proof)).unwrap(),
            RuntimeResult::DevicePolicyFor(None)
        ));
        // A browser member is never a device that acts.
        let record = &fixture.records[&fixture.origin];
        let browser = RoomProof::Browser(BrowserProof {
            surface_id: record.surface_id,
            incarnation: record.incarnation,
            token_hash: record.token_hash.clone(),
        });
        assert!(matches!(
            ask(&mut fixture, browser),
            Err(RuntimeError::InvalidOrigin)
        ));
        // A connection that is no longer current receives nothing at all.
        let stale = fixture.proofs[&mac].clone();
        fixture.records.get_mut(&mac).unwrap().revision += 1;
        fixture.state.reconcile(&fixture.records, NOW);
        assert!(ask(&mut fixture, RoomProof::Native(stale)).is_err());
    }

    /// The command list is the half that grows. A policy the runtime could
    /// not deliver whole is refused where the owner writes it, rather than
    /// arriving truncated: half an allowlist is worse than none.
    #[test]
    fn ambiance_device_policy_over_the_envelope_is_refused_where_the_owner_writes_it() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        let long = |id: &str, argv: usize| CommandEntry {
            id: id.into(),
            label: "x".repeat(MAX_LABEL_BYTES),
            argv: std::iter::once("/usr/bin/true".to_owned())
                .chain((1..argv).map(|_| "y".repeat(MAX_ARGV_BYTES)))
                .collect(),
            cwd: format!("/{}", "z".repeat(200)),
            mutates: false,
            budget_ms: MAX_BUDGET_MS,
        };
        let oversized = CommandPolicy {
            maximum_class: PrivacyClass::SharedRoom,
            offer_output_to_cognition: false,
            entries: (0..MAX_COMMAND_ENTRIES)
                .map(|index| long(&format!("entry-{index}"), MAX_ARGV))
                .collect(),
        };
        assert!(oversized.valid());
        assert!(matches!(
            fixture.set_commands(mac, Some(oversized)),
            Err(RuntimeError::InvalidRequest)
        ));
        // Nothing was committed, so the installation still holds nothing.
        assert!(
            fixture
                .state
                .device_policy(&fixture.records, mac)
                .unwrap()
                .is_none()
        );
        // A list that fits is committed and delivered whole.
        let fits = CommandPolicy {
            maximum_class: PrivacyClass::SharedRoom,
            offer_output_to_cognition: false,
            entries: vec![long("entry-0", 4), long("entry-1", 4)],
        };
        assert!(fixture.set_commands(mac, Some(fits)).is_ok());
        let policy = fixture
            .state
            .device_policy(&fixture.records, mac)
            .unwrap()
            .expect("policy");
        assert!(policy.document().len() <= MAX_POLICY_BYTES);
        assert_eq!(policy.commands.as_ref().unwrap().entries.len(), 2);
        // The bound is on the whole document, not on either half, so a list
        // of hosts, applications and roots that fits on its own is refused
        // beside those commands and accepted once they are gone.
        let wide = Policy {
            maximum_class: PrivacyClass::SharedRoom,
            open: Some(OpenPolicy {
                hosts: (0..MAX_HOSTS)
                    .map(|index| format!("{}{index:02}.example.com", "h".repeat(238)))
                    .collect(),
                apps: (0..MAX_APPS)
                    .map(|index| AppEntry {
                        id: format!("com.example.{}{index}", "a".repeat(100)),
                        label: "x".repeat(MAX_LABEL_BYTES),
                    })
                    .collect(),
                roots: (0..MAX_ROOTS)
                    .map(|index| RootEntry {
                        id: format!("root-{index}"),
                        label: "x".repeat(MAX_LABEL_BYTES),
                        path: format!("/{}{index}", "p".repeat(250)),
                    })
                    .collect(),
            }),
            route: None,
            play: None,
        };
        assert!(matches!(
            fixture.set_actions(mac, Some(wide.clone())),
            Err(RuntimeError::InvalidRequest)
        ));
        fixture.set_commands(mac, None).unwrap();
        assert!(fixture.set_actions(mac, Some(wide)).is_ok());
        assert!(
            fixture
                .state
                .device_policy(&fixture.records, mac)
                .unwrap()
                .expect("policy")
                .fits()
        );
        // Both bounds are the same number on both sides of the wire.
        assert_eq!(
            MAX_POLICY_BYTES,
            cosmos_surface_client::action::MAX_POLICY_BYTES
        );
    }

    #[test]
    fn ambiance_device_action_policy_is_capped_by_the_private_display_ceiling() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        let mut private = open_policy();
        private.maximum_class = PrivacyClass::Private;
        // Without the personal declaration the class is capped at shared_room.
        assert!(matches!(
            fixture.set_actions(mac, Some(private.clone())),
            Err(RuntimeError::PolicyBlocked)
        ));
        fixture.allow_private(mac);
        assert!(fixture.set_actions(mac, Some(private)).is_ok());
        // Sensitive has no display ceiling anywhere and is never writable.
        let mut sensitive = open_policy();
        sensitive.maximum_class = PrivacyClass::Sensitive;
        assert!(matches!(
            fixture.set_actions(mac, Some(sensitive)),
            Err(RuntimeError::InvalidRequest)
        ));
    }

    #[test]
    fn ambiance_device_action_policy_refuses_run_for_every_platform_but_macos() {
        let (mut fixture, ids) = Fixture::new(&["macos", "linux", "android", "android_tv"]);
        for (index, platform) in ["macos", "linux", "android", "android_tv"]
            .iter()
            .enumerate()
        {
            let surface = ids[index];
            let result = fixture.set_commands(surface, Some(command_policy()));
            if *platform == "macos" {
                assert!(result.is_ok(), "{platform}");
            } else {
                assert!(
                    matches!(result, Err(RuntimeError::PolicyBlocked)),
                    "{platform}"
                );
            }
        }
        // Per-platform floors follow from the manifest, not from a second list.
        let route = Policy {
            maximum_class: PrivacyClass::SharedRoom,
            open: None,
            route: Some(RoutePolicy {
                app: RouteApp::GoogleMaps,
            }),
            play: None,
        };
        let play = Policy {
            maximum_class: PrivacyClass::SharedRoom,
            open: None,
            route: None,
            play: Some(PlayPolicy {
                providers: vec!["youtube".into()],
            }),
        };
        for (index, platform) in ["macos", "linux", "android", "android_tv"]
            .iter()
            .enumerate()
        {
            let surface = ids[index];
            let open = fixture.set_actions(surface, Some(open_policy())).is_ok();
            assert_eq!(open, *platform != "android_tv", "open on {platform}");
            let routed = fixture.set_actions(surface, Some(route.clone())).is_ok();
            assert_eq!(routed, *platform == "android", "route on {platform}");
            let played = fixture.set_actions(surface, Some(play.clone())).is_ok();
            assert_eq!(played, *platform == "android_tv", "play on {platform}");
        }
    }

    #[test]
    fn ambiance_device_action_policy_refuses_argv_that_is_not_a_fixed_array() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        // There is no shell string and no parameter: argv is a bounded array
        // of literal elements, written once by a person.
        assert!(
            serde_json::from_value::<CommandEntry>(serde_json::json!({
                "id": "project-tests", "label": "Project tests",
                "argv": "./revival check cosmos", "cwd": "/Users/owner",
                "mutates": true, "budgetMs": 1000
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<CommandEntry>(serde_json::json!({
                "id": "project-tests", "label": "Project tests",
                "argv": ["./revival"], "cwd": "/Users/owner", "shell": true,
                "mutates": true, "budgetMs": 1000
            }))
            .is_err()
        );
        let mut policy = command_policy();
        policy.entries[0].argv = Vec::new();
        assert!(matches!(
            fixture.set_commands(mac, Some(policy)),
            Err(RuntimeError::InvalidRequest)
        ));
        let mut duplicated = command_policy();
        duplicated.entries.push(entry());
        assert!(matches!(
            fixture.set_commands(mac, Some(duplicated)),
            Err(RuntimeError::InvalidRequest)
        ));
        let mut over_cap = command_policy();
        over_cap.entries = (0..=MAX_COMMAND_ENTRIES)
            .map(|index| {
                let mut entry = entry();
                entry.id = format!("task-{index}");
                entry
            })
            .collect();
        assert!(matches!(
            fixture.set_commands(mac, Some(over_cap)),
            Err(RuntimeError::InvalidRequest)
        ));
    }

    /// A silent `Sensitive` classification would make an owner-approved entry
    /// permanently unrunnable and indistinguishable from a capability miss.
    #[test]
    fn ambiance_device_action_policy_refuses_a_sensitive_label() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        let mut policy = command_policy();
        policy.entries[0].label = "Rotate the api key".into();
        assert!(matches!(
            fixture.set_commands(mac, Some(policy)),
            Err(RuntimeError::PolicyBlocked)
        ));
        assert!(fixture.set_commands(mac, Some(command_policy())).is_ok());
    }

    #[test]
    fn ambiance_device_action_policy_entry_cap_and_host_shape() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        for hosts in [
            vec!["https://github.com".to_owned()],
            vec!["GitHub.com".to_owned()],
            vec!["github.com:443".to_owned()],
            vec!["github.com".to_owned(), "github.com".to_owned()],
            vec!["b.com".to_owned(), "a.com".to_owned()],
            (0..=MAX_HOSTS)
                .map(|i| format!("h{i}.example.com"))
                .collect(),
        ] {
            let mut policy = open_policy();
            policy.open.as_mut().unwrap().hosts = hosts.clone();
            assert!(
                matches!(
                    fixture.set_actions(mac, Some(policy)),
                    Err(RuntimeError::InvalidRequest)
                ),
                "{hosts:?}"
            );
        }
        let mut empty = open_policy();
        empty.open = Some(OpenPolicy::default());
        assert!(matches!(
            fixture.set_actions(mac, Some(empty)),
            Err(RuntimeError::InvalidRequest)
        ));
        let mut traversing = open_policy();
        traversing.open.as_mut().unwrap().roots[0].path = "/Users/owner/../etc".into();
        assert!(matches!(
            fixture.set_actions(mac, Some(traversing)),
            Err(RuntimeError::InvalidRequest)
        ));
    }

    /// A page the owner is reading must not be able to name a process.
    #[test]
    fn ambiance_action_candidate_cmd_is_never_offered_on_a_screen_context_turn() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.allow_private(mac);
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        fixture
            .apply(
                RuntimeOperation::SetScreenContextPolicy {
                    surface_id: mac,
                    approval_revision: fixture.records[&mac].revision,
                    expected_revision: 0,
                    policy: Some(crate::ambiance::screen::Policy {
                        maximum_class: PrivacyClass::Private,
                    }),
                },
                NOW,
            )
            .unwrap();
        let fence = fixture.begin_from(mac);
        let offer = fixture.state.action_offer(
            &fixture.records,
            fixture.state.turn.as_ref().unwrap(),
            NOW + 2,
        );
        assert_eq!(
            offer
                .candidates
                .iter()
                .map(|c| c.reference.as_str())
                .collect::<Vec<_>>(),
            ["cmd:project-tests"]
        );
        assert_eq!(offer.operations, vec![OperationKind::Run]);
        // Raise the turn and attach the origin's own screen text: the command
        // candidate disappears, and a run proposal no longer resolves.
        fixture.state.turn.as_mut().unwrap().privacy = PrivacyClass::Private;
        fixture.state.turn.as_mut().unwrap().screen_context =
            Some(crate::ambiance::screen::Offered {
                app_digest: hash(b"Safari"),
                bytes: 12,
                document: None,
            });
        let offer = fixture.state.action_offer(
            &fixture.records,
            fixture.state.turn.as_ref().unwrap(),
            NOW + 2,
        );
        assert!(offer.candidates.is_empty());
        assert!(matches!(
            fixture.apply(
                RuntimeOperation::BindDeviceAction {
                    fence,
                    operation: OperationKind::Run,
                    reference: "cmd:project-tests".into(),
                },
                NOW + 2
            ),
            Err(RuntimeError::InvalidRequest)
        ));
    }

    /// A private label in a shared-class prompt would be a class downgrade in
    /// fact if not in name, so the note carries the identifier and the kind.
    #[test]
    fn ambiance_action_candidate_cont_and_doc_notes_carry_no_title_app_or_line() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.allow_private(mac);
        fixture.set_actions(mac, Some(open_policy())).unwrap();
        fixture
            .apply(
                RuntimeOperation::SetScreenContextPolicy {
                    surface_id: mac,
                    approval_revision: fixture.records[&mac].revision,
                    expected_revision: 0,
                    policy: Some(crate::ambiance::screen::Policy {
                        maximum_class: PrivacyClass::Private,
                    }),
                },
                NOW,
            )
            .unwrap();
        fixture.begin_from(mac);
        let document = crate::ambiance::continuation::DocumentHandle {
            app: "Zed".into(),
            locator: Locator::File {
                root_id: "repo".into(),
                relative: "src/state.rs".into(),
            },
            version: None,
            position: Some(Position::Line { line: 1710 }),
            label: "state.rs".into(),
        };
        // A shared-class turn is never offered a private document.
        fixture.state.turn.as_mut().unwrap().screen_context =
            Some(crate::ambiance::screen::Offered {
                app_digest: hash(b"Zed"),
                bytes: 12,
                document: Some(document.clone()),
            });
        let turn = fixture.state.turn.clone().unwrap();
        assert!(
            fixture
                .state
                .action_offer(&fixture.records, &turn, NOW + 2)
                .candidates
                .is_empty()
        );
        fixture.state.turn.as_mut().unwrap().privacy = PrivacyClass::Private;
        let turn = fixture.state.turn.clone().unwrap();
        let offer = fixture.state.action_offer(&fixture.records, &turn, NOW + 2);
        assert_eq!(offer.candidates.len(), 1);
        let candidate = &offer.candidates[0];
        assert_eq!(candidate.reference, "doc:1");
        assert_eq!(candidate.kind, CandidateKind::Document);
        // Nothing a person wrote travels with the identifier.
        assert!(candidate.label.is_empty());
        // But the runtime itself still binds the whole handle.
        let (bound, kind) = fixture
            .state
            .bind_device_action(
                &fixture.records,
                &turn,
                OperationKind::Open,
                "doc:1",
                NOW + 2,
            )
            .unwrap();
        assert_eq!(kind, CandidateKind::Document);
        assert_eq!(
            bound,
            Operation::Open {
                locator: document.locator.clone(),
                version: None,
                position: Some(Position::Line { line: 1710 }),
                label: "state.rs".into(),
            }
        );
        // An operation that disagrees with the reference is not resolved.
        assert!(matches!(
            fixture.state.bind_device_action(
                &fixture.records,
                &turn,
                OperationKind::Run,
                "doc:1",
                NOW + 2
            ),
            Err(RuntimeError::InvalidRequest)
        ));
    }

    #[test]
    fn ambiance_action_candidate_unknown_expired_or_ineligible_reference_is_a_parse_failure() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let fence = fixture.begin();
        for (kind, reference) in [
            (OperationKind::Run, "cmd:unknown-task"),
            (OperationKind::Play, "choice:2"),
            (OperationKind::Open, "doc:1"),
            (OperationKind::Open, "cont:1"),
            (OperationKind::Route, "place:1"),
        ] {
            assert!(
                matches!(
                    fixture.apply(
                        RuntimeOperation::BindDeviceAction {
                            fence: fence.clone(),
                            operation: kind,
                            reference: reference.into(),
                        },
                        NOW + 2
                    ),
                    Err(RuntimeError::InvalidRequest)
                ),
                "{reference}"
            );
        }
        // The one candidate this turn does have resolves, and binding it is
        // logged content-free.
        let events = fixture.events(
            RuntimeOperation::BindDeviceAction {
                fence,
                operation: OperationKind::Run,
                reference: "cmd:project-tests".into(),
            },
            NOW + 2,
        );
        let bound = events
            .iter()
            .find_map(|event| match event {
                RuntimeData::ActionBound {
                    candidate,
                    entry_digest,
                    reference_digest,
                    ..
                } => Some((*candidate, entry_digest.clone(), reference_digest.clone())),
                _ => None,
            })
            .expect("bound event");
        assert_eq!(bound.0, CandidateKind::Command);
        assert_eq!(bound.1.as_deref(), Some(entry().entry_digest().as_str()));
        assert_eq!(bound.2, reference_digest("cmd:project-tests"));
    }

    /// "Number two" resolves against exactly the list the owner was shown, or
    /// against nothing at all.
    #[test]
    fn ambiance_action_candidate_choice_two_resolves_only_against_the_acknowledged_list_digest() {
        let (mut fixture, ids) = Fixture::new(&["android_tv"]);
        let tv = ids[0];
        fixture
            .set_actions(
                tv,
                Some(Policy {
                    maximum_class: PrivacyClass::SharedRoom,
                    open: None,
                    route: None,
                    play: Some(PlayPolicy {
                        providers: vec!["youtube".into()],
                    }),
                }),
            )
            .unwrap();
        fixture.begin();
        let list_digest = format!("3f9c{}", "1".repeat(60));
        fixture.state.remember(crate::ambiance::RecentContext {
            kind: crate::ambiance::RecentContextKind::Choices,
            text: "Films for tonight".into(),
            items: vec!["Arrival".into(), "Heat".into()],
            source_surface: tv,
            privacy: PrivacyClass::SharedRoom,
            created_at_ms: NOW,
            expires_at_ms: NOW + crate::ambiance::RECENT_CONTEXT_MS,
            list_digest: Some(list_digest.clone()),
            continuation: None,
        });
        let turn = fixture.state.turn.clone().unwrap();
        let offer = fixture.state.action_offer(&fixture.records, &turn, NOW + 2);
        assert_eq!(
            offer
                .candidates
                .iter()
                .map(|c| (c.reference.as_str(), c.label.as_str()))
                .collect::<Vec<_>>(),
            [("choice:1", "Arrival"), ("choice:2", "Heat")]
        );
        let (bound, kind) = fixture
            .state
            .bind_device_action(
                &fixture.records,
                &turn,
                OperationKind::Play,
                "choice:2",
                NOW + 2,
            )
            .unwrap();
        assert_eq!(kind, CandidateKind::Choice);
        assert_eq!(
            bound,
            Operation::Play {
                title: "Heat".into(),
                query: "Heat".into(),
                providers: vec!["youtube".into()],
                item_digest: item_digest(&list_digest, "2"),
            }
        );
        // A different list is a different digest, so the same reference binds
        // a different item and never silently the old one.
        fixture.state.remember(crate::ambiance::RecentContext {
            kind: crate::ambiance::RecentContextKind::Choices,
            text: "Films for tonight".into(),
            items: vec!["Dune".into(), "Poor Things".into()],
            source_surface: tv,
            privacy: PrivacyClass::SharedRoom,
            created_at_ms: NOW,
            expires_at_ms: NOW + crate::ambiance::RECENT_CONTEXT_MS,
            list_digest: Some(format!("aaaa{}", "2".repeat(60))),
            continuation: None,
        });
        let (rebound, _) = fixture
            .state
            .bind_device_action(
                &fixture.records,
                &turn,
                OperationKind::Play,
                "choice:2",
                NOW + 2,
            )
            .unwrap();
        assert_ne!(rebound, bound);
        // Once the memory expires the reference resolves to nothing.
        assert!(matches!(
            fixture.state.bind_device_action(
                &fixture.records,
                &turn,
                OperationKind::Play,
                "choice:2",
                NOW + crate::ambiance::RECENT_CONTEXT_MS + 1
            ),
            Err(RuntimeError::InvalidRequest)
        ));
    }

    #[test]
    fn ambiance_action_candidate_a_private_list_mints_none() {
        let (mut fixture, ids) = Fixture::new(&["android_tv", "macos"]);
        let (tv, mac) = (ids[0], ids[1]);
        fixture
            .set_actions(
                tv,
                Some(Policy {
                    maximum_class: PrivacyClass::SharedRoom,
                    open: None,
                    route: None,
                    play: Some(PlayPolicy {
                        providers: vec!["youtube".into()],
                    }),
                }),
            )
            .unwrap();
        fixture.begin();
        fixture.state.remember(crate::ambiance::RecentContext {
            kind: crate::ambiance::RecentContextKind::Choices,
            text: "My prescriptions".into(),
            items: vec!["One".into(), "Two".into()],
            source_surface: mac,
            privacy: PrivacyClass::Private,
            created_at_ms: NOW,
            expires_at_ms: NOW + crate::ambiance::RECENT_CONTEXT_MS,
            list_digest: Some("b".repeat(64)),
            continuation: None,
        });
        let turn = fixture.state.turn.clone().unwrap();
        assert!(
            fixture
                .state
                .action_offer(&fixture.records, &turn, NOW + 2)
                .candidates
                .is_empty()
        );
    }

    /// A remembered list and a remembered command must coexist: today one
    /// eviction per kind, newest wins, bounded.
    #[test]
    fn ambiance_action_candidate_kinds_coexist_within_the_window() {
        let (mut fixture, ids) = Fixture::new(&["android_tv", "macos"]);
        let (tv, mac) = (ids[0], ids[1]);
        fixture
            .set_actions(
                tv,
                Some(Policy {
                    maximum_class: PrivacyClass::SharedRoom,
                    open: None,
                    route: None,
                    play: Some(PlayPolicy {
                        providers: vec!["youtube".into()],
                    }),
                }),
            )
            .unwrap();
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        fixture.begin();
        fixture.state.remember(crate::ambiance::RecentContext {
            kind: crate::ambiance::RecentContextKind::PlaceQuery,
            text: "Restaurant Barr".into(),
            items: Vec::new(),
            source_surface: mac,
            privacy: PrivacyClass::SharedRoom,
            created_at_ms: NOW,
            expires_at_ms: NOW + crate::ambiance::RECENT_CONTEXT_MS,
            list_digest: None,
            continuation: None,
        });
        fixture.state.remember(crate::ambiance::RecentContext {
            kind: crate::ambiance::RecentContextKind::Choices,
            text: "Films for tonight".into(),
            items: vec!["Arrival".into(), "Heat".into()],
            source_surface: tv,
            privacy: PrivacyClass::SharedRoom,
            created_at_ms: NOW,
            expires_at_ms: NOW + crate::ambiance::RECENT_CONTEXT_MS,
            list_digest: Some("c".repeat(64)),
            continuation: None,
        });
        assert_eq!(fixture.state.recent_context.len(), 2);
        let turn = fixture.state.turn.clone().unwrap();
        let offer = fixture.state.action_offer(&fixture.records, &turn, NOW + 2);
        assert_eq!(offer.candidates.len(), 3);
        assert_eq!(
            offer.operations,
            vec![OperationKind::Play, OperationKind::Run]
        );
    }

    /// Stripping the note and the request's own target must leave the same
    /// decision: the note perturbs what the model proposes, never eligibility.
    #[test]
    fn ambiance_hint_stripped_floor_holds_for_actions() {
        let (mut fixture, ids) = Fixture::new(&["android_tv"]);
        let tv = ids[0];
        fixture
            .set_actions(
                tv,
                Some(Policy {
                    maximum_class: PrivacyClass::SharedRoom,
                    open: None,
                    route: None,
                    play: Some(PlayPolicy {
                        providers: vec!["youtube".into()],
                    }),
                }),
            )
            .unwrap();
        let fence = fixture.begin();
        fixture.state.remember(crate::ambiance::RecentContext {
            kind: crate::ambiance::RecentContextKind::Choices,
            text: "Films for tonight".into(),
            items: vec!["Arrival".into(), "Heat".into()],
            source_surface: tv,
            privacy: PrivacyClass::SharedRoom,
            created_at_ms: NOW,
            expires_at_ms: NOW + crate::ambiance::RECENT_CONTEXT_MS,
            list_digest: Some("c".repeat(64)),
            continuation: None,
        });
        let turn = fixture.state.turn.clone().unwrap();
        let (operation, _) = fixture
            .state
            .bind_device_action(
                &fixture.records,
                &turn,
                OperationKind::Play,
                "choice:2",
                NOW + 2,
            )
            .unwrap();
        let blockers = |fixture: &mut Fixture, hint| {
            let events = fixture.events(
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::DeviceAction {
                        operation: operation.clone(),
                    },
                    privacy: PrivacyClass::SharedRoom,
                    hint,
                },
                NOW + 3,
            );
            events
                .iter()
                .find_map(|event| match event {
                    RuntimeData::Decision { candidates, .. } => Some(
                        candidates
                            .iter()
                            .map(|c| (c.surface_id, c.blocker))
                            .collect::<Vec<_>>(),
                    ),
                    _ => None,
                })
                .expect("decision")
        };
        let hinted = blockers(
            &mut fixture,
            Some(crate::ambiance::policy::RoutingTarget::AndroidTv),
        );
        let bare = blockers(&mut fixture, None);
        assert_eq!(hinted, bare);
        // The browser origin cannot act, and the TV can only play.
        assert_eq!(
            bare.iter().filter(|(_, blocker)| blocker.is_none()).count(),
            1
        );
        assert!(bare.iter().any(|(id, blocker)| *id == fixture.origin
            && *blocker == Some(crate::ambiance::policy::Blocker::Capability)));
    }

    /// A bound command reaches only an installation whose owner permission
    /// admits that exact locator, entry or provider.
    #[test]
    fn ambiance_device_action_needs_the_owners_permission_for_this_exact_command() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        let allowed = Operation::Open {
            locator: Locator::Https {
                url: "https://github.com/owner/repo".into(),
            },
            version: None,
            position: None,
            label: "repo".into(),
        };
        let elsewhere = Operation::Open {
            locator: Locator::Https {
                url: "https://evil.example/owner/repo".into(),
            },
            version: None,
            position: None,
            label: "repo".into(),
        };
        assert!(
            !fixture
                .state
                .action_permits(&fixture.records, mac, &allowed)
        );
        fixture.set_actions(mac, Some(open_policy())).unwrap();
        assert!(
            fixture
                .state
                .action_permits(&fixture.records, mac, &allowed)
        );
        assert!(
            !fixture
                .state
                .action_permits(&fixture.records, mac, &elsewhere)
        );
        let outside_root = Operation::Open {
            locator: Locator::File {
                root_id: "elsewhere".into(),
                relative: "src/main.rs".into(),
            },
            version: None,
            position: None,
            label: "main.rs".into(),
        };
        assert!(
            !fixture
                .state
                .action_permits(&fixture.records, mac, &outside_root)
        );
        // An owner editing a command entry invalidates the bound command.
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let run = Operation::Run {
            entry_id: entry().id,
            label: entry().label,
            entry_digest: entry().entry_digest(),
            argv_digest: entry().argv_digest(),
            budget_ms: entry().budget_ms,
            mutates: entry().mutates,
        };
        assert!(fixture.state.action_permits(&fixture.records, mac, &run));
        let mut edited = command_policy();
        edited.entries[0].argv = vec!["./revival".into(), "test".into()];
        fixture.set_commands(mac, Some(edited)).unwrap();
        assert!(!fixture.state.action_permits(&fixture.records, mac, &run));
    }

    /// The owner's connected installations keep rendering and speaking after
    /// the profile bump and gain no action channel until they are reapproved,
    /// which is a real transition: it bumps the revision and drops every
    /// per-installation permission with it.
    #[test]
    fn a_v3_installation_gains_no_action_channel_until_reapproval() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.records.get_mut(&mac).unwrap().approved_manifest =
            crate::surface_registry::legacy_native_speech_manifest();
        // The owner cannot write an action permission an earlier profile does
        // not declare, so no permission can outlive the bump unnoticed.
        assert!(matches!(
            fixture.set_actions(mac, Some(open_policy())),
            Err(RuntimeError::InvalidRequest)
        ));
        assert!(matches!(
            fixture.set_commands(mac, Some(command_policy())),
            Err(RuntimeError::PolicyBlocked)
        ));
        assert!(
            fixture
                .state
                .action_channels(&fixture.records, mac)
                .is_empty()
        );
        // Reapproval is a real transition to the action profile.
        let record = fixture.records[&mac].clone();
        let crate::surface_registry::Binding::Native {
            enrollment_id,
            public_key,
            platform,
        } = record.binding.clone()
        else {
            unreachable!()
        };
        let (reapproved, kind) = transition(
            Some(&record),
            1,
            mac,
            &Mutation::ApproveNative {
                enrollment_id,
                public_key,
                platform: platform.clone(),
                expected_revision: record.revision,
            },
            NOW,
        )
        .unwrap();
        assert_eq!(kind, Some("surface.approved"));
        assert_eq!(reapproved.revision, record.revision + 1);
        assert_eq!(
            crate::surface_registry::native_approval(&reapproved),
            Some(crate::surface_registry::NATIVE_APPROVAL)
        );
        let incarnation = fixture.state.connect_native_for_test(&reapproved, NOW);
        fixture.proofs.insert(mac, incarnation);
        fixture.records.insert(mac, reapproved);
        assert!(fixture.set_actions(mac, Some(open_policy())).is_ok());
        assert_eq!(
            fixture.state.action_channels(&fixture.records, mac),
            vec![Channel::ActionOpen]
        );
    }

    // -----------------------------------------------------------------------
    // Dispatch, ceremony and outcome
    // -----------------------------------------------------------------------

    impl Fixture {
        fn proof(&self, surface: Uuid) -> RoomProof {
            RoomProof::Native(self.proofs[&surface].clone())
        }

        fn visible(&mut self, surface: Uuid, visible: bool, now: i64) {
            let proof = self.proofs[&surface].clone();
            self.state
                .set_native_visible(&self.records, &proof, visible, now)
                .unwrap();
        }

        /// Keep a connection current across a long-running command, exactly
        /// as an ordinary client heartbeat does.
        fn heartbeat(&mut self, surface: Uuid, now: i64) {
            let proof = self.proofs[&surface].clone();
            self.state
                .heartbeat_native(&self.records, &proof, now)
                .unwrap();
        }

        /// A shared-perceivable origin: it originates and is spoken to, it
        /// never acts, and it is never a ceremony venue.
        fn begin_from_pin(&mut self) -> TurnFence {
            let pin = crate::surface_registry::pin_surface_id("U:owner", "aabb");
            let record = transition(
                None,
                0,
                pin,
                &Mutation::ApprovePin {
                    device_id: "aabb".into(),
                },
                NOW,
            )
            .unwrap()
            .0;
            self.records.insert(pin, record);
            self.origin = pin;
            let RuntimeResult::Begun(fence) = self
                .apply(
                    RuntimeOperation::Begin {
                        turn_id: Uuid::new_v4(),
                        worker: Uuid::new_v4(),
                        origin: OriginProof::Pin {
                            device: cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb")
                                .unwrap(),
                            surface_id: pin,
                            echo_fingerprint: hash(b"pin request"),
                        },
                        request_digest: hash(b"pin request"),
                        privacy_floor: PrivacyClass::Public,
                    },
                    NOW + 1,
                )
                .unwrap()
            else {
                panic!("turn")
            };
            fence
        }

        fn play_policy(&mut self, surface: Uuid) {
            self.set_actions(
                surface,
                Some(Policy {
                    maximum_class: PrivacyClass::SharedRoom,
                    open: None,
                    route: None,
                    play: Some(PlayPolicy {
                        providers: vec!["youtube".into()],
                    }),
                }),
            )
            .unwrap();
        }

        fn propose(
            &mut self,
            fence: &TurnFence,
            operation: Operation,
            now: i64,
        ) -> Result<RuntimeResult, RuntimeError> {
            self.state
                .apply(
                    "U:owner",
                    &self.records,
                    RuntimeOperation::Propose {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: fence.worker,
                        intent: SemanticIntent::DeviceAction { operation },
                        privacy: PrivacyClass::Public,
                        hint: None,
                    },
                    now,
                )
                .map(|(result, _)| result)
        }

        fn poll(&mut self, surface: Uuid, now: i64) -> Vec<Action> {
            let connection = self.proof(surface);
            let RuntimeResult::Pending(actions) = self
                .state
                .apply(
                    "U:owner",
                    &self.records,
                    RuntimeOperation::Poll { connection },
                    now,
                )
                .unwrap()
                .0
            else {
                panic!("poll")
            };
            actions
        }

        fn action(&self, id: Uuid) -> crate::ambiance::Action {
            self.state.actions[&id].clone()
        }

        fn acknowledge(
            &mut self,
            action: &Action,
            now: i64,
        ) -> Result<RuntimeResult, RuntimeError> {
            let connection = self.proof(action.surface_id);
            self.apply(
                RuntimeOperation::Ack {
                    action_id: action.id,
                    turn_id: action.turn_id,
                    generation: action.generation,
                    connection,
                    channel: action.channel,
                    content_digest: action.content_digest.clone(),
                },
                now,
            )
        }

        fn report(
            &mut self,
            action: &Action,
            outcome: ReportOutcome,
            evidence: Evidence,
            output: Option<String>,
            now: i64,
        ) -> Result<RuntimeResult, RuntimeError> {
            let connection = self.proof(action.surface_id);
            self.apply(
                RuntimeOperation::Report {
                    connection,
                    action_id: action.id,
                    turn_id: action.turn_id,
                    generation: action.generation,
                    channel: action.channel,
                    content_digest: action.content_digest.clone(),
                    outcome,
                    evidence,
                    output,
                },
                now,
            )
        }

        fn confirmation(&mut self, surface: Uuid, now: i64) -> Option<grant::Request> {
            let connection = self.proof(surface);
            let RuntimeResult::Confirmation(request) = self
                .apply(RuntimeOperation::Confirmation { connection }, now)
                .unwrap()
            else {
                panic!("confirmation")
            };
            request
        }

        fn grant(
            &mut self,
            request: &grant::Request,
            surface: Uuid,
            granted: bool,
            attestation: Option<Attestation>,
            digest: &str,
            now: i64,
        ) -> Result<Vec<crate::ambiance::RuntimeData>, RuntimeError> {
            let incarnation = self.proofs[&surface].incarnation;
            self.state.resolve_grant(
                request.grant_id,
                request.action_id,
                surface,
                incarnation,
                granted,
                attestation,
                digest,
                now,
            )
        }
    }

    fn play(title: &str) -> Operation {
        Operation::Play {
            title: title.into(),
            query: title.into(),
            providers: vec!["youtube".into()],
            item_digest: format!("c1{}", "1".repeat(62)),
        }
    }

    fn playing() -> Evidence {
        Evidence::Playback {
            provider: "youtube".into(),
            state: PlaybackState::Playing,
            position_ms: 4_200,
            item_digest: format!("c1{}", "1".repeat(62)),
        }
    }

    fn run_operation() -> Operation {
        Operation::Run {
            entry_id: entry().id,
            label: entry().label,
            entry_digest: entry().entry_digest(),
            argv_digest: entry().argv_digest(),
            budget_ms: entry().budget_ms,
            mutates: entry().mutates,
        }
    }

    /// Visibility is required to begin an effect and never to continue one:
    /// launching a player backgrounds Cosmos, and an effect must not be
    /// retired the instant it succeeds.
    #[test]
    fn ambiance_device_action_is_claimed_only_by_a_visible_foreground_and_survives_leaving_it() {
        let (mut fixture, ids) = Fixture::new(&["android_tv"]);
        let tv = ids[0];
        fixture.play_policy(tv);
        let fence = fixture.begin();
        fixture.visible(tv, false, NOW + 2);
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, play("A trailer"), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        // A hidden foreground cannot begin it, and the action waits instead of
        // failing the poll.
        fixture.poll(tv, NOW + 3);
        assert_eq!(fixture.action(action.id).status, ActionStatus::Proposed);
        fixture.visible(tv, true, NOW + 4);
        fixture.poll(tv, NOW + 5);
        assert_eq!(fixture.action(action.id).status, ActionStatus::Dispatched);
        fixture
            .acknowledge(&fixture.action(action.id), NOW + 6)
            .unwrap();
        // The player is in front now, not Cosmos. The effect continues.
        fixture.visible(tv, false, NOW + 7);
        let events = fixture.state.reconcile(&fixture.records, NOW + 8);
        assert!(!events.iter().any(|event| matches!(
            event,
            RuntimeData::ActionChanged { status, .. }
                if status.terminal()
        )));
        assert_eq!(fixture.action(action.id).status, ActionStatus::Acknowledged);
        // And the report is accepted from a backgrounded installation.
        fixture
            .report(
                &fixture.action(action.id),
                ReportOutcome::Completed,
                playing(),
                None,
                NOW + 9,
            )
            .unwrap();
        assert_eq!(fixture.action(action.id).status, ActionStatus::Completed);
    }

    /// An acknowledgment on an action channel means "bound and legal here" and
    /// sets no outcome; only the device's own final report may, and only with
    /// evidence that shows what it claims.
    #[test]
    fn ambiance_acknowledge_on_an_action_channel_sets_no_turn_outcome_but_a_report_does() {
        let (mut fixture, ids) = Fixture::new(&["android_tv"]);
        let tv = ids[0];
        fixture.play_policy(tv);
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, play("A trailer"), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        fixture.poll(tv, NOW + 3);
        fixture
            .acknowledge(&fixture.action(action.id), NOW + 4)
            .unwrap();
        assert!(fixture.state.turn.as_ref().unwrap().outcome.is_none());
        assert!(!fixture.state.turn.as_ref().unwrap().finished);
        // A launch nobody observed is unknown, never completed.
        let launched = Evidence::Playback {
            provider: "youtube".into(),
            state: PlaybackState::Launched,
            position_ms: 0,
            item_digest: format!("c1{}", "1".repeat(62)),
        };
        assert_eq!(
            fixture
                .report(
                    &fixture.action(action.id),
                    ReportOutcome::Completed,
                    launched.clone(),
                    None,
                    NOW + 5
                )
                .unwrap_err(),
            RuntimeError::Stale
        );
        // Evidence from another channel is not this command's evidence.
        assert_eq!(
            fixture
                .report(
                    &fixture.action(action.id),
                    ReportOutcome::Completed,
                    Evidence::Open {
                        resolved_app: None,
                        opened: true,
                        document_digest: None
                    },
                    None,
                    NOW + 5,
                )
                .unwrap_err(),
            RuntimeError::Stale
        );
        assert!(fixture.state.turn.as_ref().unwrap().outcome.is_none());
        let events = fixture
            .state
            .apply(
                "U:owner",
                &fixture.records,
                RuntimeOperation::Report {
                    connection: fixture.proof(tv),
                    action_id: action.id,
                    turn_id: action.turn_id,
                    generation: action.generation,
                    channel: action.channel,
                    content_digest: action.content_digest.clone(),
                    outcome: ReportOutcome::Unknown,
                    evidence: launched,
                    output: None,
                },
                NOW + 6,
            )
            .unwrap()
            .1;
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeData::ActionReported {
                outcome: ReportOutcome::Unknown,
                evidence: EvidenceKind::Playback,
                ..
            }
        )));
        let outcome = fixture.state.turn.as_ref().unwrap().outcome.unwrap();
        assert_eq!(
            (outcome.surface_id, outcome.channel),
            (tv, Channel::ActionPlay)
        );
        assert!(fixture.state.turn.as_ref().unwrap().finished);
        // Exactly one report per command.
        assert!(
            fixture
                .report(
                    &fixture.action(action.id),
                    ReportOutcome::Completed,
                    playing(),
                    None,
                    NOW + 7
                )
                .is_err()
        );
    }

    /// A command that changes files always confirms, at the installation that
    /// will carry it out, with the actor evidence its manifest declares.
    #[test]
    fn ambiance_grant_is_single_use_venue_bound_and_refuses_a_weaker_attestation() {
        let (mut fixture, ids) = Fixture::new(&["macos", "android_tv"]);
        let (mac, tv) = (ids[0], ids[1]);
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, run_operation(), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        // Nothing dispatches without a ceremony.
        assert_eq!(action.status, ActionStatus::AwaitingGrant);
        fixture.poll(mac, NOW + 3);
        assert_eq!(
            fixture.action(action.id).status,
            ActionStatus::AwaitingGrant
        );
        // A television is bystander-perceivable, so it is never a venue.
        assert!(fixture.confirmation(tv, NOW + 3).is_none());
        let request = fixture.confirmation(mac, NOW + 4).unwrap();
        assert_eq!(request.action_id, action.id);
        assert_eq!(request.risk, Risk::High);
        assert_eq!(request.attestation, Attestation::DeviceOwnerAuth);
        // The description is composed by policy from the bound command and the
        // owner's own label, and it carries the class.
        assert_eq!(request.description.verb, "run");
        assert_eq!(request.description.subject, entry().label);
        assert_eq!(request.description.device_kind, "macos");
        assert_eq!(
            request.description_digest,
            request.description.content_digest()
        );
        // A bare tap cannot mint a high-risk authority, and the answer binds to
        // the exact sentence the owner read.
        assert!(
            fixture
                .grant(
                    &request,
                    mac,
                    true,
                    Some(Attestation::ForegroundTap),
                    &request.description_digest,
                    NOW + 5
                )
                .is_err()
        );
        assert!(
            fixture
                .grant(
                    &request,
                    mac,
                    true,
                    Some(Attestation::DeviceOwnerAuth),
                    &"a".repeat(64),
                    NOW + 5
                )
                .is_err()
        );
        // A grant naming this venue never authorises another installation.
        assert!(
            fixture
                .grant(
                    &request,
                    tv,
                    true,
                    Some(Attestation::DeviceOwnerAuth),
                    &request.description_digest,
                    NOW + 5
                )
                .is_err()
        );
        fixture
            .grant(
                &request,
                mac,
                true,
                Some(Attestation::DeviceOwnerAuth),
                &request.description_digest,
                NOW + 6,
            )
            .unwrap();
        fixture.poll(mac, NOW + 7);
        assert_eq!(fixture.action(action.id).status, ActionStatus::Dispatched);
        // Single use: the grant is consumed in the same transaction that
        // claimed the command it authorised.
        assert!(fixture.state.grants.values().all(|grant| grant.consumed));
        assert!(!fixture.state.granted(action.id, NOW + 8));
    }

    /// A ceremony expires thirty seconds after the sentence a person could
    /// read, and a restart voids it: unconfirmed is denied.
    #[test]
    fn ambiance_grant_expires_from_the_confirm_frame_and_is_void_after_a_restart() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, run_operation(), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        // The command waits for the venue's own foreground before the clock
        // starts, so a Pin-origin command does not expire on the way to a Mac.
        fixture.visible(mac, false, NOW + 3);
        assert!(fixture.confirmation(mac, NOW + 10_000).is_none());
        assert!(fixture.state.grants.is_empty());
        // It waits for the venue, not for a clock: the command's own window
        // is the five minutes a private card gets, plus its report budget.
        assert!(
            action.display_expires_at_ms >= NOW + 2 + super::super::personal::PRIVATE_DISPLAY_MS
        );
        fixture.visible(mac, true, NOW + 10_001);
        let request = fixture.confirmation(mac, NOW + 10_002).unwrap();
        assert_eq!(request.expires_at_ms, NOW + 10_002 + grant::GRANT_MS);
        // An unanswered ceremony expires and denies by fail-safe default.
        let events = fixture
            .state
            .reconcile(&fixture.records, request.expires_at_ms + 1);
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeData::GrantResolved {
                outcome: grant::Outcome::Expired,
                ..
            }
        )));
        assert!(!fixture.state.granted(action.id, request.expires_at_ms + 1));

        // A restart mints a fresh worker, the fence rejects every operation on
        // that turn, and the grant is dropped rather than honoured.
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let fence = fixture.begin();
        fixture.propose(&fence, run_operation(), NOW + 2).unwrap();
        let request = fixture.confirmation(mac, NOW + 3).unwrap();
        fixture.state.turn.as_mut().unwrap().fence.worker = Uuid::new_v4();
        assert!(
            fixture
                .grant(
                    &request,
                    mac,
                    true,
                    Some(Attestation::DeviceOwnerAuth),
                    &request.description_digest,
                    NOW + 4
                )
                .is_err()
        );
        fixture.state.reconcile(&fixture.records, NOW + 5);
        assert!(
            fixture
                .state
                .grants
                .values()
                .all(|grant| grant.decision.is_none())
        );
    }

    /// Six device actions in a rolling ten minutes and one in flight. The
    /// origin hears the ordinary understated acknowledgment; the owner reads
    /// the budget row.
    #[test]
    fn ambiance_seventh_action_in_ten_minutes_is_budget_blocked() {
        let (mut fixture, ids) = Fixture::new(&["android_tv"]);
        let tv = ids[0];
        fixture.play_policy(tv);
        let mut at = NOW + 2;
        for index in 0..BUDGET_LIMIT {
            let fence = fixture.begin();
            let RuntimeResult::Proposed(action) = fixture
                .propose(&fence, play(&format!("Trailer {index}")), at)
                .unwrap()
            else {
                panic!("proposed")
            };
            fixture.poll(tv, at);
            assert_eq!(fixture.action(action.id).status, ActionStatus::Dispatched);
            fixture.acknowledge(&fixture.action(action.id), at).unwrap();
            fixture
                .report(
                    &fixture.action(action.id),
                    ReportOutcome::Completed,
                    playing(),
                    None,
                    at,
                )
                .unwrap();
            at += 1_000;
        }
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, play("Trailer seven"), at).unwrap()
        else {
            panic!("proposed")
        };
        let events = fixture
            .state
            .apply(
                "U:owner",
                &fixture.records,
                RuntimeOperation::Poll {
                    connection: fixture.proof(tv),
                },
                at,
            )
            .unwrap()
            .1;
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeData::ActionBudgetExhausted { limit, .. } if *limit as usize == BUDGET_LIMIT
        )));
        assert_eq!(fixture.action(action.id).status, ActionStatus::Proposed);
        // The window rolls: the same six dispatches no longer bar the next.
        assert!(fixture.state.action_budget.exhausted(at));
        assert!(!fixture.state.action_budget.exhausted(at + BUDGET_WINDOW_MS));
    }

    /// A long command stays live on its own progress, not on a registry
    /// heartbeat, and progress never consumes an ordered ingress slot.
    #[test]
    fn ambiance_progress_renews_the_worker_lease_past_seventy_five_seconds() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        // The Mac is both the origin and the venue, so the turn outlives the
        // command on its own connection rather than a browser's lease.
        let fence = fixture.begin_from(mac);
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, run_operation(), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        let request = fixture.confirmation(mac, NOW + 3).unwrap();
        fixture
            .grant(
                &request,
                mac,
                true,
                Some(Attestation::DeviceOwnerAuth),
                &request.description_digest,
                NOW + 4,
            )
            .unwrap();
        fixture.poll(mac, NOW + 5);
        fixture
            .acknowledge(&fixture.action(action.id), NOW + 6)
            .unwrap();
        let lease = fixture.state.turn.as_ref().unwrap().lease_until_ms;
        let cursor = fixture.state.ingress[&mac].controls.len();
        let mut at = NOW + 6;
        for sequence in 1..=12u64 {
            at += 9_000;
            fixture.heartbeat(mac, at);
            fixture
                .apply(
                    RuntimeOperation::Progress {
                        connection: fixture.proof(mac),
                        action_id: action.id,
                        generation: action.generation,
                        sequence,
                        elapsed_ms: at - NOW,
                    },
                    at,
                )
                .unwrap();
            fixture.state.reconcile(&fixture.records, at);
        }
        // Well past the seventy-five second lease and still running.
        assert!(at - NOW > crate::ambiance::WORKER_LEASE_MS);
        assert!(fixture.state.turn.as_ref().unwrap().lease_until_ms > lease);
        assert_eq!(fixture.action(action.id).status, ActionStatus::Running);
        assert_eq!(fixture.state.ingress[&mac].controls.len(), cursor);
        // Progress is idempotent by its own sequence.
        let RuntimeResult::ProgressAccepted { duplicate } = fixture
            .apply(
                RuntimeOperation::Progress {
                    connection: fixture.proof(mac),
                    action_id: action.id,
                    generation: action.generation,
                    sequence: 3,
                    elapsed_ms: 3_000,
                },
                at,
            )
            .unwrap()
        else {
            panic!("progress")
        };
        assert!(duplicate);
        // A turn with a running effect is not finished, so its outcome can
        // still be delivered.
        assert!(!fixture.state.turn.as_ref().unwrap().finished);
        assert!(
            fixture
                .apply(
                    RuntimeOperation::Finish {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: fence.worker,
                    },
                    at,
                )
                .is_err()
        );
        // Ten seconds of silence and the outcome is unknown, with no retry.
        fixture
            .state
            .reconcile(&fixture.records, at + PROGRESS_GRACE_MS + 1);
        let action = fixture.action(action.id);
        assert_eq!(action.status, ActionStatus::OutcomeUnknown);
        assert_eq!(action.revoked, Some(RevokeReason::Expired));
        assert_eq!(action.attempts, 1);
    }

    /// A side-effecting action never repairs to another device, and only an
    /// idempotent channel retries at all: `action.run` never does.
    #[test]
    fn ambiance_device_action_never_repairs_and_retries_only_where_idempotent() {
        let (mut fixture, ids) = Fixture::new(&["android_tv", "android"]);
        let (tv, phone) = (ids[0], ids[1]);
        fixture.play_policy(tv);
        // A phone declares no player at all, so the owner cannot even write
        // that permission for it.
        assert!(
            fixture
                .set_actions(
                    phone,
                    Some(Policy {
                        maximum_class: PrivacyClass::SharedRoom,
                        open: None,
                        route: None,
                        play: Some(PlayPolicy {
                            providers: vec!["youtube".into()],
                        }),
                    }),
                )
                .is_err()
        );
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, play("A trailer"), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        // A phone declares no player, so the decision names exactly one
        // eligible surface and no fallback to repair to.
        assert_eq!(action.surface_id, tv);
        assert!(action.fallbacks.is_empty());
        fixture.poll(tv, NOW + 3);
        // A lost acknowledgment is retried once, on the same surface, with the
        // same idempotency key.
        let key = idempotency_key(tv, fixture.proofs[&tv].incarnation, action.id);
        fixture
            .state
            .reconcile(&fixture.records, NOW + 3 + crate::ambiance::ACK_MS);
        assert_eq!(fixture.action(action.id).status, ActionStatus::Proposed);
        assert_eq!(fixture.action(action.id).attempts, 1);
        fixture.poll(tv, NOW + 3 + crate::ambiance::ACK_MS);
        let retried = fixture.action(action.id);
        assert_eq!(retried.status, ActionStatus::Dispatched);
        assert_eq!(retried.surface_id, tv);
        assert_eq!(
            idempotency_key(retried.surface_id, retried.incarnation, retried.id),
            key
        );
        // The second loss is unknown, never a third attempt and never another
        // surface.
        fixture
            .state
            .reconcile(&fixture.records, NOW + 3 + 3 * crate::ambiance::ACK_MS);
        assert_eq!(
            fixture.action(action.id).status,
            ActionStatus::OutcomeUnknown
        );
        assert_eq!(fixture.state.actions.len(), 1);

        // A command never retries at all.
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, run_operation(), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        let request = fixture.confirmation(mac, NOW + 3).unwrap();
        fixture
            .grant(
                &request,
                mac,
                true,
                Some(Attestation::DeviceOwnerAuth),
                &request.description_digest,
                NOW + 4,
            )
            .unwrap();
        fixture.poll(mac, NOW + 5);
        fixture
            .state
            .reconcile(&fixture.records, NOW + 5 + crate::ambiance::ACK_MS);
        assert_eq!(
            fixture.action(action.id).status,
            ActionStatus::OutcomeUnknown
        );
    }

    /// A new request from the owner voids a turn whose effect is still
    /// running. The stopped task is reported cancelled, never completed.
    #[test]
    fn ambiance_new_input_preempts_a_running_effect_and_revokes_it() {
        let (mut fixture, ids) = Fixture::new(&["android_tv"]);
        let tv = ids[0];
        fixture.play_policy(tv);
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, play("A trailer"), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        fixture.poll(tv, NOW + 3);
        fixture
            .acknowledge(&fixture.action(action.id), NOW + 4)
            .unwrap();
        // A second turn would ordinarily be refused while this one is live.
        let next = fixture.begin();
        assert_ne!(next.turn_id, fence.turn_id);
        let revocation = fixture
            .state
            .revocations
            .iter()
            .find(|revocation| revocation.action_id == action.id)
            .unwrap();
        assert_eq!(revocation.reason, RevokeReason::Preempted);
        assert_eq!(revocation.surface_id, tv);
        // The preempted effect never becomes a completed one.
        assert!(!fixture.state.actions.contains_key(&action.id));
    }

    /// No action channel is eligible above the shared-room ceiling on an
    /// installation without a current personal declaration, and a television
    /// can never hold one.
    #[test]
    fn ambiance_no_action_channel_is_eligible_above_shared_room_without_a_declaration() {
        let (mut fixture, ids) = Fixture::new(&["android_tv", "macos"]);
        let (tv, mac) = (ids[0], ids[1]);
        fixture.play_policy(tv);
        fixture.set_actions(mac, Some(open_policy())).unwrap();
        let open = Operation::Open {
            locator: Locator::Https {
                url: "https://github.com/owner/repo".into(),
            },
            version: None,
            position: None,
            label: "repo".into(),
        };
        let blocker = |fixture: &Fixture, surface: Uuid, channel: Channel, privacy| {
            fixture
                .state
                .candidate(
                    &fixture.records,
                    &fixture.records[&surface],
                    fixture.origin,
                    channel,
                    privacy,
                    None,
                    None,
                    NOW + 2,
                )
                .blocker
        };
        assert_eq!(
            blocker(&fixture, tv, Channel::ActionPlay, PrivacyClass::SharedRoom),
            None
        );
        assert_eq!(
            blocker(&fixture, tv, Channel::ActionPlay, PrivacyClass::Private),
            Some(crate::ambiance::policy::Blocker::Privacy)
        );
        assert_eq!(
            blocker(&fixture, mac, Channel::ActionOpen, PrivacyClass::Private),
            Some(crate::ambiance::policy::Blocker::Privacy)
        );
        // A television never becomes personal, whatever the owner writes.
        assert!(
            fixture
                .apply(
                    RuntimeOperation::SetPrivatePolicy {
                        surface_id: tv,
                        approval_revision: fixture.records[&tv].revision,
                        expected_revision: 0,
                        policy: Some(crate::ambiance::personal::Policy {
                            maximum_class: PrivacyClass::Private,
                        }),
                    },
                    NOW,
                )
                .is_err()
        );
        // The Mac's own declaration lifts its ceiling, and the owner's action
        // permission is still checked at that class.
        fixture.allow_private(mac);
        assert_eq!(
            blocker(&fixture, mac, Channel::ActionOpen, PrivacyClass::Private),
            None
        );
        fixture.set_actions(mac, None).unwrap();
        assert_eq!(
            blocker(&fixture, mac, Channel::ActionOpen, PrivacyClass::Private),
            Some(crate::ambiance::policy::Blocker::Unavailable)
        );
        assert!(!fixture.state.action_permits(&fixture.records, mac, &open));
    }

    /// Every outcome that is not a committed `completed` produces the same
    /// sentence, byte for byte: a refusal, a failure, a cancellation, an
    /// unknown outcome, a privacy suppression, an exhausted budget and a
    /// capability miss are indistinguishable from a shared surface.
    #[test]
    fn ambiance_every_non_completed_outcome_produces_the_byte_identical_shared_sentence() {
        let sentence = |outcome: Option<(ReportOutcome, Evidence)>| {
            let (mut fixture, ids) = Fixture::new(&["android_tv", "macos"]);
            let (tv, mac) = (ids[0], ids[1]);
            fixture.play_policy(tv);
            let _ = mac;
            let fence = fixture.begin_from_pin();
            let proposed = fixture.propose(&fence, play("A trailer"), NOW + 2).unwrap();
            let action = match (proposed, outcome) {
                (RuntimeResult::Proposed(action), Some((outcome, evidence))) => {
                    fixture.poll(tv, NOW + 3);
                    fixture
                        .acknowledge(&fixture.action(action.id), NOW + 4)
                        .unwrap();
                    fixture
                        .report(&fixture.action(action.id), outcome, evidence, None, NOW + 5)
                        .unwrap();
                    Some(action.id)
                }
                // Nothing was dispatched at all: the origin still hears the
                // same sentence and never learns which of these it was.
                (_, None) => None,
                _ => panic!("proposed"),
            };
            let RuntimeResult::Proposed(expression) = fixture
                .apply(
                    RuntimeOperation::ExpressAction {
                        turn_id: fence.turn_id,
                        generation: fence.generation,
                        worker: fence.worker,
                        action_id: action,
                    },
                    NOW + 6,
                )
                .unwrap()
            else {
                panic!("expression")
            };
            assert!(expression.expression);
            assert_eq!(expression.privacy, PrivacyClass::SharedRoom);
            assert_eq!(expression.channel, Channel::AudioTts);
            expression.intent.text().to_owned()
        };
        let declined = Evidence::Declined {
            reason: DeclineReason::NoHandler,
        };
        let launched = Evidence::Playback {
            provider: "youtube".into(),
            state: PlaybackState::Launched,
            position_ms: 0,
            item_digest: format!("c1{}", "1".repeat(62)),
        };
        let handled = crate::ambiance::ACTION_HANDLED_EXPRESSION;
        for outcome in [
            Some((ReportOutcome::Refused, declined)),
            Some((ReportOutcome::Failed, launched.clone())),
            Some((ReportOutcome::Cancelled, launched.clone())),
            Some((ReportOutcome::Unknown, launched)),
            None,
        ] {
            assert_eq!(sentence(outcome), handled);
        }
        assert_eq!(
            sentence(Some((ReportOutcome::Completed, playing()))),
            crate::ambiance::ACTION_COMPLETED_EXPRESSION
        );
        assert_ne!(handled, crate::ambiance::ACTION_COMPLETED_EXPRESSION);
    }

    /// A non-zero exit code is a command that ran: the runtime would lie in
    /// exactly the direction the outcome gate exists to prevent if it called
    /// that a failure. Its output is content and lands as content.
    #[test]
    fn ambiance_exit_code_one_is_completed_and_its_output_is_routed_as_private_content() {
        let (mut fixture, ids) = Fixture::new(&["macos"]);
        let mac = ids[0];
        fixture.set_commands(mac, Some(command_policy())).unwrap();
        fixture.allow_private(mac);
        let fence = fixture.begin();
        let RuntimeResult::Proposed(action) =
            fixture.propose(&fence, run_operation(), NOW + 2).unwrap()
        else {
            panic!("proposed")
        };
        let request = fixture.confirmation(mac, NOW + 3).unwrap();
        fixture
            .grant(
                &request,
                mac,
                true,
                Some(Attestation::DeviceOwnerAuth),
                &request.description_digest,
                NOW + 4,
            )
            .unwrap();
        fixture.poll(mac, NOW + 5);
        fixture
            .acknowledge(&fixture.action(action.id), NOW + 6)
            .unwrap();
        let evidence = Evidence::Command {
            entry_id: entry().id,
            exit_code: Some(1),
            duration_ms: 48_211,
            output_bytes: 18_422,
            truncated: true,
        };
        fixture
            .report(
                &fixture.action(action.id),
                ReportOutcome::Completed,
                evidence,
                Some("2 tests failed".into()),
                NOW + 7,
            )
            .unwrap();
        assert_eq!(fixture.action(action.id).status, ActionStatus::Completed);
        // The command's own bytes join to at least private, so they can only
        // land on a personal surface.
        let card = fixture
            .state
            .actions
            .values()
            .find(|candidate| candidate.channel == Channel::VisualCard)
            .unwrap();
        assert_eq!(card.surface_id, mac);
        assert!(card.privacy >= PrivacyClass::Private);
    }

    #[test]
    fn ambiance_device_command_entry_bounds_argv_and_digests_the_whole_entry() {
        assert!(entry().valid());
        let mut edited = entry();
        edited.label = "Project checks".into();
        assert_ne!(edited.entry_digest(), entry().entry_digest());
        assert_eq!(edited.argv_digest(), entry().argv_digest());
        let mut moved = entry();
        moved.cwd = "/Users/owner/Projects/other".into();
        assert_ne!(moved.argv_digest(), entry().argv_digest());
        for mutate in [
            |e: &mut CommandEntry| e.argv = Vec::new(),
            |e: &mut CommandEntry| e.argv = vec!["x".into(); MAX_ARGV + 1],
            |e: &mut CommandEntry| e.argv = vec!["../../bin/sh".into()],
            |e: &mut CommandEntry| e.argv = vec!["a\u{0000}b".into()],
            |e: &mut CommandEntry| e.argv = vec!["x".repeat(MAX_ARGV_BYTES + 1)],
            |e: &mut CommandEntry| e.cwd = "relative/path".into(),
            |e: &mut CommandEntry| e.cwd = "/Users/../etc".into(),
            |e: &mut CommandEntry| e.budget_ms = MAX_BUDGET_MS + 1,
            |e: &mut CommandEntry| e.budget_ms = 0,
            |e: &mut CommandEntry| e.id = "Project Tests".into(),
        ] {
            let mut invalid = entry();
            mutate(&mut invalid);
            assert!(!invalid.valid());
        }
    }
}
