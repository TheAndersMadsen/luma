//! Device actions, as this client independently interprets them. A surface
//! may be asked to render, to speak, or to act; this is the third thing.
//!
//! Nothing here trusts the runtime's word for the command's shape. The client
//! recomputes every content digest byte-for-byte from the canonical tuple, so
//! a drift in either implementation refuses the command instead of carrying
//! out something the owner never approved. Acknowledging binds; only the
//! platform's own observation may report an outcome.
use crate::Error;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

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
/// The longest command output a terminal report may carry.
pub const MAX_OUTPUT_BYTES: usize = 6144;
/// At most sixty progress messages per command, one per ten seconds.
pub const MAX_PROGRESS: u64 = 60;

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub(crate) fn digest_text(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Coordinates are ASCII decimal strings with exactly six fraction digits,
/// because float formatting is the one conversion that drifts between
/// languages and this contract hashes it.
fn coordinate(value: &str, maximum: u32) -> bool {
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

    /// The registrable host of an `https` locator, for the platform's own
    /// copy of the owner's allowlist.
    pub fn host(&self) -> Option<String> {
        let Self::Https { url } = self else {
            return None;
        };
        reqwest::Url::parse(url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
    }
}

/// An `https` locator a platform can open without ambiguity: no userinfo, no
/// port, no whitespace and no backslash.
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
            Self::Fragment { value } => {
                text(value, MAX_FRAGMENT_BYTES) && !value.chars().any(char::is_whitespace)
            }
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Line { .. } => "line",
            Self::Page { .. } => "page",
            Self::Fragment { .. } => "fragment",
        }
    }

    fn value(&self) -> String {
        match self {
            Self::Line { line } => line.to_string(),
            Self::Page { page } => page.to_string(),
            Self::Fragment { value } => value.clone(),
        }
    }
}

/// One bound command. Every field was minted by the runtime from state it
/// committed itself; the platform builds nothing from strings.
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub fn channel(&self) -> &'static str {
        match self {
            Self::Open { .. } => "action.open",
            Self::Route { .. } => "action.route",
            Self::Play { .. } => "action.play",
            Self::Run { .. } => "action.run",
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
                    && coordinate(lat, 90)
                    && coordinate(lng, 180)
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

    /// Byte-for-byte the runtime's binding. A single drift refuses every
    /// command with no useful error, which is why both sides assert it
    /// against `contracts/fixtures/ambiance-device-action-digests-v1.json`.
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
        sha256_hex(canonical.to_string().as_bytes())
    }
}

/// One command this installation was asked to carry out. Acknowledging it
/// says "I bound this exact command and it is legal here" and nothing more.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub action_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    pub channel: String,
    pub content_digest: String,
    /// Deduplicate on this within a ten-minute retention window: a repeat
    /// re-sends the existing report and never re-executes.
    pub idempotency_key: String,
    pub operation: Operation,
    pub expires_at_ms: i64,
    /// When the platform must have said what happened.
    pub report_by_ms: i64,
    pub privacy: crate::display::Privacy,
}

/// Why the runtime told this installation to stop. A revoke supersedes
/// remaining work; it does not un-open an application.
/// One retired command and why it was retired, so a platform can say
/// "stopped when you asked for something else" instead of guessing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revoked {
    pub action_id: Uuid,
    pub reason: RevokeReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevokeReason {
    Cancelled,
    Preempted,
    Superseded,
    Expired,
    RevalidationFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Low,
    Moderate,
    High,
}

/// What the platform proved about the person who confirmed. A bare tap can
/// never stand in for device-owner authentication.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Attestation {
    ForegroundTap,
    DeviceOwnerAuth,
}

impl Attestation {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "foreground_tap" => Some(Self::ForegroundTap),
            "device_owner_auth" => Some(Self::DeviceOwnerAuth),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DescriptionKind {
    DeviceAction,
}

/// What a person is asked to confirm, composed by the runtime's own policy
/// from the bound command and the owner's own label. Never model prose, and
/// never rendered as JSON: each platform writes these words itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Description {
    pub kind: DescriptionKind,
    pub verb: String,
    pub subject: String,
    pub device_kind: String,
    pub effect: String,
    pub class: crate::display::Privacy,
}

impl Description {
    pub fn valid(&self) -> bool {
        text(&self.verb, 16)
            && text(&self.subject, MAX_LABEL_BYTES)
            && text(&self.device_kind, 32)
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
        sha256_hex(canonical.to_string().as_bytes())
    }
}

/// One ceremony this installation is the venue for. The person standing here
/// is the person who answers; declining is one control away and weighs
/// exactly as much as accepting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Confirmation {
    pub grant_id: Uuid,
    pub action_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    pub description: Description,
    pub description_digest: String,
    pub risk: Risk,
    /// The weakest actor evidence Cosmos will accept for this command.
    pub attestation: Attestation,
    pub privacy: crate::display::Privacy,
    pub expires_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome {
    Completed,
    Refused,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackState {
    Playing,
    Buffering,
    Launched,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

/// The platform's own bounded account of what it observed. A launch it could
/// not observe further is not playback and not navigation.
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

    pub fn fits(&self, channel: &str) -> bool {
        match self {
            Self::Declined { .. } => channel.starts_with("action."),
            Self::Open { .. } => channel == "action.open",
            Self::Route { .. } => channel == "action.route",
            Self::Playback { .. } => channel == "action.play",
            Self::Command { .. } => channel == "action.run",
        }
    }

    pub fn proves_completion(&self) -> bool {
        match self {
            Self::Open { opened, .. } => *opened,
            Self::Route { navigating, .. } => *navigating,
            Self::Playback { state, .. } => *state == PlaybackState::Playing,
            Self::Command { .. } => true,
            Self::Declined { .. } => false,
        }
    }
}

/// What the platform says happened. Reporting `completed` for an effect the
/// platform did not observe is a false outcome claim, which is why the shape
/// itself refuses it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub outcome: ReportOutcome,
    pub evidence: Evidence,
    /// The command's own bounded output, for a terminal command report only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

impl Report {
    pub fn valid(&self, channel: &str) -> bool {
        let declined = matches!(self.evidence, Evidence::Declined { .. });
        self.evidence.valid()
            && self.evidence.fits(channel)
            && (self.outcome != ReportOutcome::Completed || self.evidence.proves_completion())
            && (self.outcome == ReportOutcome::Refused) == declined
            && match &self.output {
                None => true,
                Some(output) => {
                    matches!(self.evidence, Evidence::Command { .. })
                        && !output.is_empty()
                        && output.len() <= MAX_OUTPUT_BYTES
                        && !output
                            .chars()
                            .any(|c| c.is_control() && c != '\n' && c != '\t')
                }
            }
    }

    /// Parse the bounded UTF-8 JSON a platform binding hands across the FFI.
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > 16 * 1024 {
            return Err(Error::InvalidInput);
        }
        serde_json::from_slice(bytes).map_err(|_| Error::InvalidInput)
    }
}
