//! Incoming visual frames. A transport receipt is not render evidence; the
//! platform renders the exact content, then the client acknowledges it.
use crate::{Error, MAX_TEXT_BYTES, state::Stamp};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const MAX_PLACE_ITEMS: usize = 4;
const MAX_ATTRIBUTIONS: usize = 16;
const MAX_ATTRIBUTION_BYTES: usize = 2048;
const MAX_PLACES_BYTES: usize = 8192;
const MIN_CHOICES: usize = 2;
const MAX_CHOICES: usize = 8;
const MAX_CHOICE_TITLE_BYTES: usize = 120;
const MAX_CHOICE_ITEM_TITLE_BYTES: usize = 80;
const MAX_CHOICE_DETAIL_BYTES: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaceItem {
    pub place_id: String,
    pub name: String,
    pub address: String,
    pub source_url: Option<String>,
}

/// One numbered option of a choice list; `id` is `1`..`8` in list order and
/// is what a later "number two" refers to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChoiceItem {
    pub id: String,
    pub title: String,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DisplayContent {
    Text {
        text: String,
    },
    Places {
        query: String,
        items: Vec<PlaceItem>,
        attributions: Vec<String>,
    },
    Choices {
        title: String,
        items: Vec<ChoiceItem>,
    },
}

/// The outcome-gated state of this installation's own current turn. It
/// names the kind of surface involved, never which one, and never a reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Working,
    Waiting,
    /// A command is waiting for the owner's confirmation at the installation
    /// that would carry it out.
    Confirming,
    /// An approved device is carrying a command out. Nothing is claimed yet.
    Acting,
    Shown,
    Spoken,
    /// A device reported that it carried the command out.
    Done,
    /// A device reported that it did not. The origin never learns why.
    Refused,
    Nowhere,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfacePlatform {
    Pin,
    Browser,
    Macos,
    Linux,
    Android,
    AndroidTv,
}

impl SurfacePlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pin => "pin",
            Self::Browser => "browser",
            Self::Macos => "macos",
            Self::Linux => "linux",
            Self::Android => "android",
            Self::AndroidTv => "android_tv",
        }
    }
}

/// What the runtime committed about the turn this installation originated:
/// "heard, handled elsewhere" and nothing more. `privacy` is the class the
/// status is expressed at, never above this installation's own ceiling.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnStatus {
    pub turn_id: Uuid,
    pub generation: u64,
    pub state: TurnState,
    pub surface: Option<SurfacePlatform>,
    pub privacy: Privacy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusSurface {
    platform: SurfacePlatform,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusFrame {
    version: u8,
    turn_id: Uuid,
    generation: u64,
    state: TurnState,
    #[serde(deserialize_with = "explicit_surface")]
    surface: Option<StatusSurface>,
    privacy: Privacy,
}

/// `surface` is null when no surface is involved, and a frame that omits the
/// field is a different shape the runtime never sends: read it explicitly so a
/// missing key is rejected rather than read as "no surface".
fn explicit_surface<'de, D>(deserializer: D) -> Result<Option<StatusSurface>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

/// The class the runtime routed content at. A platform treats anything above
/// `shared_room` as private: shown only while it is the foreground of an
/// unlocked personal device, never previewed, never spoken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Privacy {
    Public,
    SharedRoom,
    NearUser,
    Private,
    Sensitive,
}

fn shared_room() -> Privacy {
    Privacy::SharedRoom
}

/// One bounded card the runtime dispatched to this installation. It carries
/// no authority: acknowledging it reports what was actually rendered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Display {
    pub action_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    pub content_digest: String,
    pub content: DisplayContent,
    pub expires_at_ms: i64,
    #[serde(default = "shared_room")]
    pub privacy: Privacy,
}

/// A private card is waiting for this installation. It names the kind of
/// surface that asked, the class and the expiry; it never carries content.
/// The card itself arrives as a render once the unlocked foreground reports
/// visible.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub id: Uuid,
    pub kind: InvitationKind,
    pub origin: String,
    pub privacy: Privacy,
    pub expires_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvitationFrame {
    version: u8,
    id: Uuid,
    kind: InvitationKind,
    surface_id: Uuid,
    incarnation: Uuid,
    origin: String,
    privacy: Privacy,
    expires_at: i64,
}

/// What is waiting: a private card, or a command this installation was asked
/// to carry out. A phone cannot begin either in the background.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvitationKind {
    Card,
    Task,
}

/// Inert credit token. Platforms render text and one HTTPS link per part.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttributionPart {
    Text { text: String },
    Link { text: String, href: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    version: u8,
    action_id: Uuid,
    turn_id: Uuid,
    generation: u64,
    surface_id: Uuid,
    incarnation: Uuid,
    channel: String,
    content_digest: String,
    content: DisplayContent,
    expires_at: i64,
    #[serde(default)]
    privacy: Option<Privacy>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Frame {
    Render {
        version: u8,
        stamp: Stamp,
        command: Command,
    },
    Clear {
        version: u8,
        stamp: Stamp,
        #[serde(rename = "actionId")]
        action_id: Uuid,
    },
    Speak {
        version: u8,
        stamp: Stamp,
        speech: crate::speech::SpeechFrame,
    },
    Invite {
        version: u8,
        stamp: Stamp,
        invitation: Option<InvitationFrame>,
    },
    Status {
        version: u8,
        stamp: Stamp,
        status: StatusFrame,
    },
    Act {
        version: u8,
        stamp: Stamp,
        command: ActCommand,
    },
    Revoke {
        version: u8,
        stamp: Stamp,
        #[serde(rename = "actionId")]
        action_id: Uuid,
        reason: crate::action::RevokeReason,
    },
    Confirm {
        version: u8,
        stamp: Stamp,
        #[serde(deserialize_with = "explicit_request")]
        request: Option<ConfirmRequest>,
    },
    Policy {
        version: u8,
        stamp: Stamp,
        #[serde(deserialize_with = "explicit_digest")]
        digest: Option<String>,
        #[serde(deserialize_with = "explicit_policy")]
        policy: Option<crate::action::DevicePolicy>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActCommand {
    version: u8,
    action_id: Uuid,
    turn_id: Uuid,
    generation: u64,
    surface_id: Uuid,
    incarnation: Uuid,
    channel: String,
    content_digest: String,
    idempotency_key: String,
    operation: crate::action::Operation,
    expires_at: i64,
    report_by: i64,
    privacy: Privacy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmRequest {
    version: u8,
    grant_id: Uuid,
    action_id: Uuid,
    turn_id: Uuid,
    generation: u64,
    surface_id: Uuid,
    incarnation: Uuid,
    channel: String,
    description_digest: String,
    description: crate::action::Description,
    risk: crate::action::Risk,
    attestation: crate::action::Attestation,
    privacy: Privacy,
    expires_at: i64,
}

/// `request` is null when no ceremony is live, and a frame that omits the
/// field is a shape the runtime never sends: read it explicitly so a missing
/// key is rejected rather than read as "no ceremony".
fn explicit_request<'de, D>(deserializer: D) -> Result<Option<ConfirmRequest>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

/// An explicit null withdraws the owner's copy, which is a real state: the
/// installation then holds no policy and does nothing. A frame that omits
/// either field is a shape the runtime never sends.
fn explicit_policy<'de, D>(deserializer: D) -> Result<Option<crate::action::DevicePolicy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

fn explicit_digest<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

pub(crate) enum Incoming {
    Render(Display),
    Clear(Uuid),
    Speak(crate::speech::SpeechFrame),
    Invite(Option<Invitation>),
    Status(TurnStatus),
    Act(crate::action::Task),
    Revoke(Uuid, crate::action::RevokeReason),
    Confirm(Option<crate::action::Confirmation>),
    Policy(Option<crate::action::PolicyDocument>),
}

/// The exact bound connection this frame must name.
#[derive(Clone, Copy)]
pub(crate) struct Expected {
    pub(crate) surface_id: Uuid,
    pub(crate) incarnation: Uuid,
    /// The approval revision this connection was opened at. The owner's
    /// policy is a statement about that exact approval, so a copy naming any
    /// other revision is refused rather than held.
    pub(crate) approval_revision: u64,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Byte-for-byte the runtime's binding: text hashes its bytes, a place card
/// hashes its canonical tuple including every raw credit string, a choice
/// list hashes its title and numbered items.
pub fn content_digest(content: &DisplayContent) -> String {
    match content {
        DisplayContent::Text { text } => sha256_hex(text.as_bytes()),
        DisplayContent::Places {
            query,
            items,
            attributions,
        } => {
            let items: Vec<_> = items
                .iter()
                .map(|item| {
                    serde_json::json!([item.place_id, item.name, item.address, item.source_url])
                })
                .collect();
            let canonical =
                serde_json::json!(["cosmos.place-address-card", 1, query, items, attributions]);
            sha256_hex(canonical.to_string().as_bytes())
        }
        DisplayContent::Choices { title, items } => {
            let items: Vec<_> = items
                .iter()
                .map(|item| serde_json::json!([item.id, item.title, item.detail]))
                .collect();
            let canonical = serde_json::json!(["cosmos.choice-list", 1, title, items]);
            sha256_hex(canonical.to_string().as_bytes())
        }
    }
}

fn choice_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn forbidden(character: char) -> bool {
    matches!(character as u32,
        0x0000..=0x0008 | 0x000b | 0x000c | 0x000e..=0x001f | 0x007f..=0x009f
        | 0x061c | 0x200e | 0x200f | 0x202a..=0x202e | 0x2066..=0x2069)
}

fn place_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.chars().any(|c| !c.is_whitespace())
        && !value.chars().any(|c| c.is_control())
}

fn place_source(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return true;
    };
    if !place_text(value, 2048) || value.chars().any(|c| c.is_whitespace() || c == '\\') {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && match url.host_str() {
            Some("maps.google.com") => true,
            Some("www.google.com") => url.path() == "/maps" || url.path().starts_with("/maps/"),
            _ => false,
        }
}

fn visible(text: &str) -> bool {
    text.chars().any(|c| !c.is_whitespace() && !is_format(c))
}

fn is_format(c: char) -> bool {
    matches!(c as u32, 0x00ad | 0x0600..=0x0605 | 0x061c | 0x06dd | 0x070f | 0x180e
        | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb)
}

fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "middot" => "·",
        "bull" => "•",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "thinsp" => "\u{2009}",
        _ => return None,
    })
}

fn decode_entities(source: &str) -> Result<String, Error> {
    let mut text = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(index) = rest.find('&') {
        text.push_str(&rest[..index]);
        rest = &rest[index..];
        let body = &rest[1..];
        let follows = body
            .chars()
            .next()
            .is_some_and(|c| c == '#' || c.is_ascii_alphanumeric());
        if !follows {
            text.push('&');
            rest = body;
            continue;
        }
        let end = body.find(';').ok_or(Error::InvalidResponse)?;
        let name = &body[..end];
        if let Some(digits) = name.strip_prefix('#') {
            let (radix, digits) = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => (16, hex),
                None => (10, digits),
            };
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return Err(Error::InvalidResponse);
            }
            let code = u32::from_str_radix(digits, radix).map_err(|_| Error::InvalidResponse)?;
            let character = char::from_u32(code)
                .filter(|_| code > 0)
                .ok_or(Error::InvalidResponse)?;
            text.push(character);
        } else {
            if name.is_empty()
                || !name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                || !name.chars().all(|c| c.is_ascii_alphanumeric())
            {
                return Err(Error::InvalidResponse);
            }
            text.push_str(entity(name).ok_or(Error::InvalidResponse)?);
        }
        rest = &body[end + 1..];
    }
    text.push_str(rest);
    if text.chars().any(forbidden) {
        return Err(Error::InvalidResponse);
    }
    Ok(text)
}

fn checked_href(source: &str) -> Result<String, Error> {
    let href = decode_entities(source)?;
    let authority = href
        .strip_prefix("https://")
        .ok_or(Error::InvalidResponse)?;
    let host = authority.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty()
        || host.contains('@')
        || href.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || is_format(c)
                || matches!(c, '\\' | '<' | '>' | '"' | '\'' | '`')
        })
    {
        return Err(Error::InvalidResponse);
    }
    let bytes = href.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && !(bytes.len() > index + 2
                && bytes[index + 1].is_ascii_hexdigit()
                && bytes[index + 2].is_ascii_hexdigit())
        {
            return Err(Error::InvalidResponse);
        }
    }
    let url = reqwest::Url::parse(&href).map_err(|_| Error::InvalidResponse)?;
    if url.scheme() != "https"
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::InvalidResponse);
    }
    Ok(href)
}

/// Plain text plus lowercase `<a href="HTTPS URL">text</a>`; anything else
/// rejects the whole credit. Partial credit is never recovered.
pub fn parse_attribution(source: &str) -> Result<Vec<AttributionPart>, Error> {
    if source.len() > MAX_ATTRIBUTION_BYTES || source.chars().any(forbidden) {
        return Err(Error::InvalidResponse);
    }
    let mut parts = Vec::new();
    let mut rest = source;
    while !rest.is_empty() {
        if !rest.starts_with('<') {
            let end = rest.find('<').unwrap_or(rest.len());
            let text = &rest[..end];
            if text.contains('>') {
                return Err(Error::InvalidResponse);
            }
            parts.push(AttributionPart::Text {
                text: decode_entities(text)?,
            });
            rest = &rest[end..];
            continue;
        }
        let after = rest
            .strip_prefix("<a href=")
            .ok_or(Error::InvalidResponse)?;
        let quote = after
            .chars()
            .next()
            .filter(|c| matches!(c, '"' | '\''))
            .ok_or(Error::InvalidResponse)?;
        let href_source = &after[1..];
        let href_end = href_source.find(quote).ok_or(Error::InvalidResponse)?;
        let href = &href_source[..href_end];
        let body_source = href_source[href_end + 1..]
            .strip_prefix('>')
            .ok_or(Error::InvalidResponse)?;
        if href.contains('<') || href.contains('>') {
            return Err(Error::InvalidResponse);
        }
        let body_end = body_source.find("</a>").ok_or(Error::InvalidResponse)?;
        let body = &body_source[..body_end];
        if body.contains('<') || body.contains('>') {
            return Err(Error::InvalidResponse);
        }
        let text = decode_entities(body)?;
        if !visible(&text) {
            return Err(Error::InvalidResponse);
        }
        parts.push(AttributionPart::Link {
            text,
            href: checked_href(href)?,
        });
        rest = &body_source[body_end + "</a>".len()..];
    }
    let any_visible = parts.iter().any(|part| match part {
        AttributionPart::Text { text } | AttributionPart::Link { text, .. } => visible(text),
    });
    if !any_visible {
        return Err(Error::InvalidResponse);
    }
    Ok(parts)
}

fn valid_content(content: &DisplayContent) -> bool {
    match content {
        DisplayContent::Text { text } => !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES,
        DisplayContent::Places {
            query,
            items,
            attributions,
        } => {
            place_text(query, 512)
                && items.len() <= MAX_PLACE_ITEMS
                && attributions.len() <= MAX_ATTRIBUTIONS
                && serde_json::to_vec(content).is_ok_and(|bytes| bytes.len() <= MAX_PLACES_BYTES)
                && items.iter().all(|item| {
                    place_text(&item.place_id, 1024)
                        && !item.place_id.chars().any(char::is_whitespace)
                        && place_text(&item.name, 256)
                        && place_text(&item.address, 512)
                        && place_source(item.source_url.as_deref())
                })
                && attributions
                    .iter()
                    .all(|credit| parse_attribution(credit).is_ok())
        }
        DisplayContent::Choices { title, items } => {
            choice_text(title, MAX_CHOICE_TITLE_BYTES)
                && (MIN_CHOICES..=MAX_CHOICES).contains(&items.len())
                && items.iter().enumerate().all(|(index, item)| {
                    item.id == (index + 1).to_string()
                        && choice_text(&item.title, MAX_CHOICE_ITEM_TITLE_BYTES)
                        && item.detail.len() <= MAX_CHOICE_DETAIL_BYTES
                        && !item.detail.chars().any(char::is_control)
                })
        }
    }
}

fn valid_stamp(stamp: &Stamp) -> bool {
    !stamp.epoch.is_nil()
        && !stamp.instance_id.is_nil()
        && stamp.sequence > 0
        && stamp.sequence <= MAX_SEQUENCE
}

/// Parse one runtime frame for the bound connection. The returned reply is
/// the exact transport receipt the runtime requires; an invalid frame gets
/// no receipt, so the runtime records the failed delivery itself.
pub(crate) fn parse_frame(
    payload: &str,
    expected: Expected,
    now_ms: i64,
) -> Result<(Incoming, String), Error> {
    if payload.len() > cosmos_rtc::MAX_PAYLOAD {
        return Err(Error::InvalidResponse);
    }
    let frame: Frame = serde_json::from_str(payload).map_err(|_| Error::InvalidResponse)?;
    let (incoming, stamp) = match frame {
        Frame::Render {
            version,
            stamp,
            command,
        } => {
            if version != 1
                || !valid_stamp(&stamp)
                || command.version != 1
                || command.channel != "visual.card"
                || command.action_id.is_nil()
                || command.turn_id.is_nil()
                || command.action_id != stamp.instance_id
                || command.generation == 0
                || command.generation > MAX_SEQUENCE
                || command.surface_id != expected.surface_id
                || command.incarnation != expected.incarnation
                || command.expires_at <= now_ms
                || !valid_content(&command.content)
                || command.content_digest != content_digest(&command.content)
                || command.privacy == Some(Privacy::Sensitive)
            {
                return Err(Error::InvalidResponse);
            }
            (
                Incoming::Render(Display {
                    action_id: command.action_id,
                    turn_id: command.turn_id,
                    generation: command.generation,
                    content_digest: command.content_digest,
                    content: command.content,
                    expires_at_ms: command.expires_at,
                    privacy: command.privacy.unwrap_or(Privacy::SharedRoom),
                }),
                stamp,
            )
        }
        Frame::Invite {
            version,
            stamp,
            invitation,
        } => {
            if version != 1 || !valid_stamp(&stamp) {
                return Err(Error::InvalidResponse);
            }
            let invitation = match invitation {
                None => None,
                Some(frame) => {
                    if frame.version != 1
                        || frame.id.is_nil()
                        || frame.surface_id != expected.surface_id
                        || frame.incarnation != expected.incarnation
                        || frame.origin.is_empty()
                        || frame.origin.len() > 32
                        || !frame
                            .origin
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b == b'_')
                        || match frame.kind {
                            // A private card waits for an unlocked personal
                            // foreground; a command waits for any foreground,
                            // because no platform starts one in the background.
                            InvitationKind::Card => {
                                !matches!(frame.privacy, Privacy::NearUser | Privacy::Private)
                            }
                            InvitationKind::Task => frame.privacy == Privacy::Sensitive,
                        }
                        || frame.expires_at <= now_ms
                    {
                        return Err(Error::InvalidResponse);
                    }
                    Some(Invitation {
                        id: frame.id,
                        kind: frame.kind,
                        origin: frame.origin,
                        privacy: frame.privacy,
                        expires_at_ms: frame.expires_at,
                    })
                }
            };
            (Incoming::Invite(invitation), stamp)
        }
        Frame::Status {
            version,
            stamp,
            status,
        } => {
            if version != 1
                || !valid_stamp(&stamp)
                || status.version != 1
                || status.turn_id.is_nil()
                || status.generation == 0
                || status.generation > MAX_SEQUENCE
                || status.privacy == Privacy::Sensitive
            {
                return Err(Error::InvalidResponse);
            }
            (
                Incoming::Status(TurnStatus {
                    turn_id: status.turn_id,
                    generation: status.generation,
                    state: status.state,
                    surface: status.surface.map(|surface| surface.platform),
                    privacy: status.privacy,
                }),
                stamp,
            )
        }
        // A bound command for this exact connection. The client recomputes
        // the content digest from the canonical tuple: it never carries out
        // something whose shape it could not reproduce itself.
        Frame::Act {
            version,
            stamp,
            command,
        } => {
            if version != 1
                || !valid_stamp(&stamp)
                || command.version != 1
                || command.action_id.is_nil()
                || command.turn_id.is_nil()
                || command.action_id != stamp.instance_id
                || command.generation == 0
                || command.generation > MAX_SEQUENCE
                || command.surface_id != expected.surface_id
                || command.incarnation != expected.incarnation
                || command.channel != command.operation.channel()
                || command.expires_at <= now_ms
                || command.report_by <= now_ms
                || command.report_by > command.expires_at
                || !command.operation.valid()
                || command.content_digest != command.operation.content_digest()
                || !crate::action::digest_text(&command.idempotency_key)
                || command.privacy == Privacy::Sensitive
            {
                return Err(Error::InvalidResponse);
            }
            (
                Incoming::Act(crate::action::Task {
                    action_id: command.action_id,
                    turn_id: command.turn_id,
                    generation: command.generation,
                    channel: command.channel,
                    content_digest: command.content_digest,
                    idempotency_key: command.idempotency_key,
                    operation: command.operation,
                    expires_at_ms: command.expires_at,
                    report_by_ms: command.report_by,
                    privacy: command.privacy,
                }),
                stamp,
            )
        }
        Frame::Revoke {
            version,
            stamp,
            action_id,
            reason,
        } => {
            if version != 1 || !valid_stamp(&stamp) || action_id.is_nil() {
                return Err(Error::InvalidResponse);
            }
            (Incoming::Revoke(action_id, reason), stamp)
        }
        // The ceremony this installation is the venue for. Its description is
        // the runtime's own words; the platform renders them from its own
        // strings file and echoes the digest, so the answer binds to the exact
        // sentence a person read.
        Frame::Confirm {
            version,
            stamp,
            request,
        } => {
            if version != 1 || !valid_stamp(&stamp) {
                return Err(Error::InvalidResponse);
            }
            let confirmation = match request {
                None => None,
                Some(request) => {
                    if request.version != 1
                        || request.grant_id.is_nil()
                        || request.action_id.is_nil()
                        || request.turn_id.is_nil()
                        || request.generation == 0
                        || request.generation > MAX_SEQUENCE
                        || request.surface_id != expected.surface_id
                        || request.incarnation != expected.incarnation
                        || request.channel != "confirm.tap"
                        || !request.description.valid()
                        || request.description_digest != request.description.content_digest()
                        || request.description.class != request.privacy
                        || request.privacy == Privacy::Sensitive
                        || request.expires_at <= now_ms
                    {
                        return Err(Error::InvalidResponse);
                    }
                    Some(crate::action::Confirmation {
                        grant_id: request.grant_id,
                        action_id: request.action_id,
                        turn_id: request.turn_id,
                        generation: request.generation,
                        description: request.description,
                        description_digest: request.description_digest,
                        risk: request.risk,
                        attestation: request.attestation,
                        privacy: request.privacy,
                        expires_at_ms: request.expires_at,
                    })
                }
            };
            (Incoming::Confirm(confirmation), stamp)
        }
        Frame::Clear {
            version,
            stamp,
            action_id,
        } => {
            if version != 1 || !valid_stamp(&stamp) || action_id.is_nil() {
                return Err(Error::InvalidResponse);
            }
            (Incoming::Clear(action_id), stamp)
        }
        // The owner's own statement about this installation, delivered over
        // the connection it already holds. It grants nothing by arriving:
        // the platform still verifies every command against this copy, and
        // an explicit null withdraws it, which leaves the device doing
        // nothing at all.
        Frame::Policy {
            version,
            stamp,
            digest,
            policy,
        } => {
            if version != 1 || !valid_stamp(&stamp) {
                return Err(Error::InvalidResponse);
            }
            let document = match (policy, digest) {
                (None, None) => None,
                (Some(policy), Some(digest)) => {
                    let document = policy.document();
                    if !policy.valid()
                        || document.len() > crate::action::MAX_POLICY_BYTES
                        || policy.surface_id != expected.surface_id
                        || policy.approval_revision != expected.approval_revision
                        || !crate::action::digest_text(&digest)
                        || digest != policy.content_digest()
                    {
                        return Err(Error::InvalidResponse);
                    }
                    Some(crate::action::PolicyDocument {
                        digest,
                        document,
                        policy,
                    })
                }
                _ => return Err(Error::InvalidResponse),
            };
            (Incoming::Policy(document), stamp)
        }
        Frame::Speak {
            version,
            stamp,
            speech,
        } => {
            if version != 1 || !valid_stamp(&stamp) || speech.sequence_action() != stamp.instance_id
            {
                return Err(Error::InvalidResponse);
            }
            speech.validate(
                crate::speech::Expected {
                    surface_id: expected.surface_id,
                    incarnation: expected.incarnation,
                },
                now_ms,
            )?;
            (Incoming::Speak(speech), stamp)
        }
    };
    let reply = serde_json::json!({"version": 1, "kind": "received", "stamp": stamp}).to_string();
    Ok((incoming, reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected() -> Expected {
        Expected {
            surface_id: Uuid::from_u128(2),
            incarnation: Uuid::from_u128(5),
            approval_revision: 4,
        }
    }

    fn render(content: serde_json::Value, digest: &str) -> String {
        serde_json::json!({
            "version": 1, "kind": "render",
            "stamp": {"epoch": Uuid::from_u128(9), "sequence": 3, "instanceId": Uuid::from_u128(7)},
            "command": {
                "version": 1, "actionId": Uuid::from_u128(7), "turnId": Uuid::from_u128(8),
                "generation": 2, "surfaceId": Uuid::from_u128(2), "incarnation": Uuid::from_u128(5),
                "channel": "visual.card", "contentDigest": digest, "content": content,
                "expiresAt": 1_000_060_000,
            }
        })
        .to_string()
    }

    #[test]
    fn text_frames_bind_the_connection_and_exact_digest() {
        let content = serde_json::json!({"kind": "text", "text": "Public informational text"});
        let digest = sha256_hex(b"Public informational text");
        let (incoming, reply) =
            parse_frame(&render(content.clone(), &digest), expected(), 1_000_000_000).unwrap();
        let Incoming::Render(display) = incoming else {
            panic!("render expected")
        };
        assert_eq!(display.action_id, Uuid::from_u128(7));
        assert_eq!(display.content_digest, digest);
        assert_eq!(
            reply,
            serde_json::json!({"version":1,"kind":"received","stamp":{"epoch":Uuid::from_u128(9),"sequence":3,"instanceId":Uuid::from_u128(7)}}).to_string()
        );
        let wrong_digest = render(content.clone(), &sha256_hex(b"other"));
        assert!(parse_frame(&wrong_digest, expected(), 1_000_000_000).is_err());
        let other_incarnation = Expected {
            incarnation: Uuid::from_u128(6),
            ..expected()
        };
        assert!(
            parse_frame(
                &render(content.clone(), &digest),
                other_incarnation,
                1_000_000_000
            )
            .is_err()
        );
        assert!(parse_frame(&render(content, &digest), expected(), 1_000_060_000).is_err());
    }

    #[test]
    fn place_frames_match_the_center_fixture_digest_and_reject_unsupported_credit() {
        let attributions = [
            "Data &copy; contributors &lt;script&gt;placeExecuted()&lt;/script&gt;",
            "Credit: <a href=\"https://credits.example/source?one=1&amp;two=2\">Map &amp; Data</a> &mdash; all contributors",
        ];
        let content = DisplayContent::Places {
            query: "Café & Bakery".into(),
            items: vec![
                PlaceItem {
                    place_id: "place-one".into(),
                    name: "Café <img src=\"https://assets.example/track\" onerror=\"placeExecuted()\">".into(),
                    address: "1 Main Street".into(),
                    source_url: Some("https://www.google.com/maps/place/?q=cafe".into()),
                },
                PlaceItem {
                    place_id: "place-two".into(),
                    name: "Second café".into(),
                    address: "2 Other Street".into(),
                    source_url: None,
                },
            ],
            attributions: attributions.iter().map(|a| a.to_string()).collect(),
        };
        // The same canonical tuple Center hashes in BrowserDisplay.test.tsx.
        let canonical = serde_json::json!([
            "cosmos.place-address-card",
            1,
            "Café & Bakery",
            [
                [
                    "place-one",
                    "Café <img src=\"https://assets.example/track\" onerror=\"placeExecuted()\">",
                    "1 Main Street",
                    "https://www.google.com/maps/place/?q=cafe"
                ],
                ["place-two", "Second café", "2 Other Street", null]
            ],
            attributions,
        ]);
        assert_eq!(
            content_digest(&content),
            sha256_hex(canonical.to_string().as_bytes())
        );
        let frame = render(
            serde_json::to_value(&content).unwrap(),
            &content_digest(&content),
        );
        assert!(matches!(
            parse_frame(&frame, expected(), 1_000_000_000),
            Ok((Incoming::Render(_), _))
        ));
        assert_eq!(
            parse_attribution(attributions[1]).unwrap(),
            vec![
                AttributionPart::Text {
                    text: "Credit: ".into()
                },
                AttributionPart::Link {
                    text: "Map & Data".into(),
                    href: "https://credits.example/source?one=1&two=2".into()
                },
                AttributionPart::Text {
                    text: " — all contributors".into()
                },
            ]
        );
        for unsupported in [
            "<img src=\"https://assets.example/track\" onerror=\"placeExecuted()\">",
            "<script>placeExecuted()</script>",
            "<b>Required contributor</b>",
            "<a href=\"https://credits.example\" onclick=\"placeExecuted()\">Contributor</a>",
            "<a href=\"javascript:placeExecuted()\">Contributor</a>",
            "<a href=\"https://credits.example\">Unclosed contributor",
            "Contributor &unsupported;",
            "   ",
        ] {
            assert!(parse_attribution(unsupported).is_err(), "{unsupported}");
        }
        let mut rejected = content.clone();
        if let DisplayContent::Places { attributions, .. } = &mut rejected {
            attributions.push("<b>bold</b>".into());
        }
        let frame = render(
            serde_json::to_value(&rejected).unwrap(),
            &content_digest(&rejected),
        );
        assert!(parse_frame(&frame, expected(), 1_000_000_000).is_err());
    }

    #[test]
    fn choice_frames_bind_the_numbered_list_digest_and_reject_unbounded_lists() {
        let content = DisplayContent::Choices {
            title: "Films for tonight".into(),
            items: vec![
                ChoiceItem {
                    id: "1".into(),
                    title: "The Lighthouse".into(),
                    detail: "2019, psychological drama".into(),
                },
                ChoiceItem {
                    id: "2".into(),
                    title: "Arrival".into(),
                    detail: String::new(),
                },
            ],
        };
        // The same canonical tuple Cosmos hashes: title, then [id, title, detail].
        let canonical = serde_json::json!([
            "cosmos.choice-list",
            1,
            "Films for tonight",
            [
                ["1", "The Lighthouse", "2019, psychological drama"],
                ["2", "Arrival", ""]
            ]
        ]);
        assert_eq!(
            content_digest(&content),
            sha256_hex(canonical.to_string().as_bytes())
        );
        let frame = render(
            serde_json::to_value(&content).unwrap(),
            &content_digest(&content),
        );
        let (incoming, _) = parse_frame(&frame, expected(), 1_000_000_000).unwrap();
        let Incoming::Render(display) = incoming else {
            panic!("render expected")
        };
        assert_eq!(display.content, content);
        let DisplayContent::Choices { items, .. } = &content else {
            unreachable!()
        };
        let mutate = |f: &dyn Fn(&mut String, &mut Vec<ChoiceItem>)| {
            let mut title = "Films for tonight".to_owned();
            let mut items = items.clone();
            f(&mut title, &mut items);
            let rejected = DisplayContent::Choices { title, items };
            let frame = render(
                serde_json::to_value(&rejected).unwrap(),
                &content_digest(&rejected),
            );
            parse_frame(&frame, expected(), 1_000_000_000).is_err()
        };
        assert!(mutate(&|_, items| items.truncate(1)), "one item");
        assert!(
            mutate(&|_, items| {
                for index in 3..=9 {
                    items.push(ChoiceItem {
                        id: index.to_string(),
                        title: "More".into(),
                        detail: String::new(),
                    });
                }
            }),
            "nine items"
        );
        assert!(mutate(&|_, items| items[1].id = "3".into()), "gap in ids");
        assert!(mutate(&|title, _| *title = "x".repeat(121)), "long title");
        assert!(mutate(&|title, _| *title = "  ".into()), "blank title");
        assert!(
            mutate(&|_, items| items[0].title = "x".repeat(81)),
            "long item"
        );
        assert!(
            mutate(&|_, items| items[0].detail = "x".repeat(201)),
            "long detail"
        );
        assert!(
            mutate(&|_, items| items[0].detail = "a\u{0007}b".into()),
            "control"
        );
        assert!(
            !mutate(&|_, items| items[0].detail = "x".repeat(200)),
            "bounded detail"
        );
        let unknown = render(
            serde_json::json!({"kind":"menu","title":"x","items":[]}),
            &sha256_hex(b"x"),
        );
        assert!(parse_frame(&unknown, expected(), 1_000_000_000).is_err());
    }

    fn act(operation: serde_json::Value, digest: &str) -> String {
        serde_json::json!({
            "version": 1, "kind": "act",
            "stamp": {"epoch": Uuid::from_u128(9), "sequence": 4, "instanceId": Uuid::from_u128(7)},
            "command": {
                "version": 1, "actionId": Uuid::from_u128(7), "turnId": Uuid::from_u128(8),
                "generation": 2, "surfaceId": Uuid::from_u128(2), "incarnation": Uuid::from_u128(5),
                "channel": "action.open", "contentDigest": digest,
                "idempotencyKey": "a0".to_owned() + &"4".repeat(62),
                "operation": operation,
                "expiresAt": 1_000_060_000, "reportBy": 1_000_030_000,
                "privacy": "shared_room",
            }
        })
        .to_string()
    }

    /// A command is carried out only when this client can reproduce the
    /// runtime's binding itself, for its own connection, from a shape it
    /// bounds. Every digest here is the canonical tuple in
    /// `contracts/fixtures/ambiance-device-action-digests-v1.json`.
    #[test]
    fn client_recomputes_every_device_action_digest_and_binds_the_connection() {
        let file: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/fixtures/ambiance-device-action-digests-v1.json"
        ))
        .unwrap();
        let vector = |name: &str| -> String {
            file["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["name"] == name)
                .unwrap()["digest"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let operations = [
            (
                "open-https",
                crate::action::Operation::Open {
                    locator: crate::action::Locator::Https {
                        url: "https://github.com/owner/repo/pull/412".into(),
                    },
                    version: None,
                    position: Some(crate::action::Position::Fragment {
                        value: "discussion_r1".into(),
                    }),
                    label: "PR 412".into(),
                },
            ),
            (
                "open-file-line",
                crate::action::Operation::Open {
                    locator: crate::action::Locator::File {
                        root_id: "repo".into(),
                        relative: "cosmos/crates/cosmos/src/ambiance/state.rs".into(),
                    },
                    version: Some(format!("7c40{}", "0".repeat(60))),
                    position: Some(crate::action::Position::Line { line: 1710 }),
                    label: "state.rs".into(),
                },
            ),
            (
                "open-app",
                crate::action::Operation::Open {
                    locator: crate::action::Locator::App {
                        id: "dev.zed.Zed".into(),
                    },
                    version: None,
                    position: None,
                    label: "Zed".into(),
                },
            ),
            (
                "route",
                crate::action::Operation::Route {
                    place_id: "ChIJa1b2c3d4e5f6".into(),
                    name: "Restaurant Barr".into(),
                    address: "Strandgade 93, 1401 København".into(),
                    lat: "55.673611".into(),
                    lng: "12.596944".into(),
                },
            ),
            (
                "play",
                crate::action::Operation::Play {
                    title: "The Zone of Interest trailer".into(),
                    query: "The Zone of Interest trailer".into(),
                    providers: vec!["youtube".into()],
                    item_digest: file["cases"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|case| case["name"] == "play")
                        .unwrap()["canonical"][5]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                },
            ),
            (
                "run",
                crate::action::Operation::Run {
                    entry_id: "project-tests".into(),
                    label: "Project tests".into(),
                    entry_digest: vector("command-entry"),
                    argv_digest: vector("command-argv"),
                    budget_ms: 900_000,
                    mutates: true,
                },
            ),
        ];
        for (name, operation) in &operations {
            assert!(operation.valid(), "{name}");
            assert_eq!(operation.content_digest(), vector(name), "{name}");
        }
        let (open, _) = &operations[0];
        let _ = open;
        let operation = serde_json::to_value(&operations[0].1).unwrap();
        let digest = operations[0].1.content_digest();
        let (incoming, reply) =
            parse_frame(&act(operation.clone(), &digest), expected(), 1_000_000_000).unwrap();
        let Incoming::Act(task) = incoming else {
            panic!("act expected")
        };
        assert_eq!(task.action_id, Uuid::from_u128(7));
        assert_eq!(task.channel, "action.open");
        assert_eq!(task.operation, operations[0].1);
        assert_eq!(
            reply,
            serde_json::json!({"version":1,"kind":"received","stamp":{"epoch":Uuid::from_u128(9),"sequence":4,"instanceId":Uuid::from_u128(7)}}).to_string()
        );
        // A drift in either implementation refuses the command rather than
        // carrying out something the owner never approved.
        assert!(
            parse_frame(
                &act(operation.clone(), &sha256_hex(b"other")),
                expected(),
                1_000_000_000
            )
            .is_err()
        );
        // Another installation's command is never this installation's.
        assert!(
            parse_frame(
                &act(operation.clone(), &digest),
                Expected {
                    incarnation: Uuid::from_u128(6),
                    ..expected()
                },
                1_000_000_000
            )
            .is_err()
        );
        assert!(parse_frame(&act(operation, &digest), expected(), 1_000_060_000).is_err());
    }

    /// A locator this client cannot open without ambiguity is not a command.
    #[test]
    fn client_rejects_an_unsupported_operation_or_an_ambiguous_locator() {
        let open = |locator: serde_json::Value| serde_json::json!({"kind": "open", "locator": locator, "label": "x"});
        for locator in [
            serde_json::json!({"scheme": "https", "url": "http://github.com/a"}),
            serde_json::json!({"scheme": "https", "url": "https://user:pw@github.com/a"}),
            serde_json::json!({"scheme": "https", "url": "https://github.com:8443/a"}),
            serde_json::json!({"scheme": "https", "url": "https://github.com/a b"}),
            serde_json::json!({"scheme": "file", "rootId": "repo", "relative": "../secrets"}),
            serde_json::json!({"scheme": "file", "rootId": "repo", "relative": "/etc/passwd"}),
            serde_json::json!({"scheme": "file", "rootId": "REPO", "relative": "a"}),
            serde_json::json!({"scheme": "ftp", "url": "ftp://github.com/a"}),
        ] {
            let operation = open(locator.clone());
            let digest = sha256_hex(b"unused");
            assert!(
                parse_frame(&act(operation, &digest), expected(), 1_000_000_000).is_err(),
                "{locator}"
            );
        }
        // An unknown operation kind is not decoded into something adjacent.
        assert!(
            parse_frame(
                &act(
                    serde_json::json!({"kind": "paste", "text": "x"}),
                    &sha256_hex(b"x")
                ),
                expected(),
                1_000_000_000
            )
            .is_err()
        );
        // The channel must be the one the bound operation names.
        let mismatched = act(
            serde_json::json!({"kind": "play", "title": "a", "query": "a",
                "providers": ["youtube"], "itemDigest": "c1".to_owned() + &"1".repeat(62)}),
            &sha256_hex(b"x"),
        );
        assert!(parse_frame(&mismatched, expected(), 1_000_000_000).is_err());
    }

    /// The ceremony binds to the exact sentence a person reads, and the
    /// revoke frame says why an effect was stopped.
    #[test]
    fn client_confirm_binds_the_description_digest_and_revoke_carries_its_reason() {
        let description = crate::action::Description {
            kind: crate::action::DescriptionKind::DeviceAction,
            verb: "run".into(),
            subject: "Project tests".into(),
            device_kind: "macos".into(),
            effect: "changes files on that device".into(),
            class: Privacy::Private,
        };
        let confirm = |digest: &str, class: &str| {
            serde_json::json!({
                "version": 1, "kind": "confirm",
                "stamp": {"epoch": Uuid::from_u128(9), "sequence": 6, "instanceId": Uuid::from_u128(11)},
                "request": {
                    "version": 1, "grantId": Uuid::from_u128(11), "actionId": Uuid::from_u128(7),
                    "turnId": Uuid::from_u128(8), "generation": 2,
                    "surfaceId": Uuid::from_u128(2), "incarnation": Uuid::from_u128(5),
                    "channel": "confirm.tap", "descriptionDigest": digest,
                    "description": description, "risk": "high",
                    "attestation": "device_owner_auth", "privacy": class,
                    "expiresAt": 1_000_030_000,
                }
            })
            .to_string()
        };
        let digest = description.content_digest();
        let (incoming, _) =
            parse_frame(&confirm(&digest, "private"), expected(), 1_000_000_000).unwrap();
        let Incoming::Confirm(Some(request)) = incoming else {
            panic!("confirm expected")
        };
        assert_eq!(request.grant_id, Uuid::from_u128(11));
        assert_eq!(
            request.attestation,
            crate::action::Attestation::DeviceOwnerAuth
        );
        assert_eq!(request.description, description);
        // A sentence whose digest does not match is not the sentence Cosmos
        // will accept an answer for.
        assert!(
            parse_frame(
                &confirm(&sha256_hex(b"other"), "private"),
                expected(),
                1_000_000_000
            )
            .is_err()
        );
        // The rendered class is the class the description carries.
        assert!(parse_frame(&confirm(&digest, "shared_room"), expected(), 1_000_000_000).is_err());
        // A withdrawn ceremony is an explicit null, never an omitted key.
        let withdrawn = serde_json::json!({
            "version": 1, "kind": "confirm",
            "stamp": {"epoch": Uuid::from_u128(9), "sequence": 7, "instanceId": Uuid::from_u128(11)},
            "request": serde_json::Value::Null,
        })
        .to_string();
        let (incoming, _) = parse_frame(&withdrawn, expected(), 1_000_000_000).unwrap();
        assert!(matches!(incoming, Incoming::Confirm(None)));
        let omitted = serde_json::json!({
            "version": 1, "kind": "confirm",
            "stamp": {"epoch": Uuid::from_u128(9), "sequence": 7, "instanceId": Uuid::from_u128(11)},
        })
        .to_string();
        assert!(parse_frame(&omitted, expected(), 1_000_000_000).is_err());
        // A revoke names the effect and why it was stopped.
        let revoke = serde_json::json!({
            "version": 1, "kind": "revoke",
            "stamp": {"epoch": Uuid::from_u128(9), "sequence": 8, "instanceId": Uuid::from_u128(7)},
            "actionId": Uuid::from_u128(7), "reason": "preempted",
        })
        .to_string();
        let (incoming, _) = parse_frame(&revoke, expected(), 1_000_000_000).unwrap();
        assert!(matches!(
            incoming,
            Incoming::Revoke(id, crate::action::RevokeReason::Preempted) if id == Uuid::from_u128(7)
        ));
    }

    /// A report claims only what the platform observed, and only what its own
    /// channel can produce.
    #[test]
    fn client_report_refuses_an_outcome_its_evidence_does_not_show() {
        use crate::action::{DeclineReason, Evidence, PlaybackState, Report, ReportOutcome};
        let launched = Evidence::Playback {
            provider: "youtube".into(),
            state: PlaybackState::Launched,
            position_ms: 0,
            item_digest: format!("c1{}", "1".repeat(62)),
        };
        let playing = Evidence::Playback {
            provider: "youtube".into(),
            state: PlaybackState::Playing,
            position_ms: 4_200,
            item_digest: format!("c1{}", "1".repeat(62)),
        };
        let completed = |evidence: Evidence| Report {
            outcome: ReportOutcome::Completed,
            evidence,
            output: None,
        };
        assert!(!completed(launched.clone()).valid("action.play"));
        assert!(!completed(playing.clone()).valid("action.play"));
        assert!(!completed(playing).valid("action.open"));
        assert!(
            Report {
                outcome: ReportOutcome::Unknown,
                evidence: launched,
                output: None,
            }
            .valid("action.play")
        );
        // A refusal is exactly the declined evidence, and nothing else is.
        let declined = Evidence::Declined {
            reason: DeclineReason::NoHandler,
        };
        assert!(
            Report {
                outcome: ReportOutcome::Refused,
                evidence: declined.clone(),
                output: None,
            }
            .valid("action.run")
        );
        assert!(
            !Report {
                outcome: ReportOutcome::Failed,
                evidence: declined,
                output: None,
            }
            .valid("action.run")
        );
        // Output belongs to a command and is bounded.
        let command = Evidence::Command {
            entry_id: "project-tests".into(),
            exit_code: Some(1),
            duration_ms: 48_211,
            output_bytes: 18_422,
            truncated: true,
        };
        assert!(
            completed(command.clone()).valid("action.run"),
            "a non-zero exit code is a command that ran"
        );
        assert!(
            !Report {
                outcome: ReportOutcome::Completed,
                evidence: command,
                output: Some("x".repeat(crate::action::MAX_OUTPUT_BYTES + 1)),
            }
            .valid("action.run")
        );
        assert!(Report::parse(b"{\"outcome\":\"completed\"}").is_err());
    }

    #[test]
    fn client_report_evidence_matches_the_exact_bound_operation() {
        use crate::action::{Evidence, Locator, Operation, PlaybackState, ReportOutcome};
        let version = "d".repeat(64);
        let document = Operation::Open {
            locator: Locator::Https {
                url: "https://github.com/owner/project".into(),
            },
            version: Some(version.clone()),
            position: None,
            label: "Document".into(),
        };
        for (digest, completed) in [
            (None, false),
            (Some("e".repeat(64)), false),
            (Some(version), true),
        ] {
            let evidence = Evidence::Open {
                resolved_app: None,
                opened: true,
                document_digest: digest,
            };
            assert_eq!(
                evidence.matches_operation(&document, ReportOutcome::Completed),
                completed
            );
        }
        assert!(
            Evidence::Open {
                resolved_app: None,
                opened: false,
                document_digest: None
            }
            .matches_operation(&document, ReportOutcome::Unknown)
        );
        let app = Operation::Open {
            locator: Locator::App {
                id: "com.example.viewer".into(),
            },
            version: None,
            position: None,
            label: "Viewer".into(),
        };
        for resolved_app in [None, Some("com.example.other".into())] {
            assert!(
                !Evidence::Open {
                    resolved_app,
                    opened: true,
                    document_digest: None
                }
                .matches_operation(&app, ReportOutcome::Completed)
            );
        }
        let item_digest = "c".repeat(64);
        let play = Operation::Play {
            title: "A trailer".into(),
            query: "A trailer".into(),
            providers: vec!["youtube".into()],
            item_digest: item_digest.clone(),
        };
        for (provider, digest, matches) in [
            ("youtube", item_digest.clone(), true),
            ("netflix", item_digest.clone(), false),
            ("youtube", "e".repeat(64), false),
        ] {
            let evidence = Evidence::Playback {
                provider: provider.into(),
                state: PlaybackState::Playing,
                position_ms: 4200,
                item_digest: digest,
            };
            assert_eq!(
                evidence.matches_operation(&play, ReportOutcome::Unknown),
                matches
            );
            assert!(!evidence.proves_completion());
        }
        let run = Operation::Run {
            entry_id: "project-tests".into(),
            label: "Project tests".into(),
            entry_digest: "a".repeat(64),
            argv_digest: "b".repeat(64),
            budget_ms: 1000,
            mutates: false,
        };
        for (entry_id, matches) in [("project-tests", true), ("other-task", false)] {
            let evidence = Evidence::Command {
                entry_id: entry_id.into(),
                exit_code: Some(0),
                duration_ms: 100,
                output_bytes: 0,
                truncated: false,
            };
            assert_eq!(
                evidence.matches_operation(&run, ReportOutcome::Completed),
                matches
            );
        }
    }

    #[test]
    fn status_frames_name_only_the_kind_of_surface_and_reject_unknown_states() {
        let stamp = serde_json::json!({"epoch": Uuid::from_u128(9), "sequence": 5, "instanceId": Uuid::from_u128(12)});
        let status = |body: serde_json::Value| {
            serde_json::json!({"version": 1, "kind": "status", "stamp": stamp, "status": body})
                .to_string()
        };
        let shown = status(serde_json::json!({
            "version": 1, "turnId": Uuid::from_u128(8), "generation": 2,
            "state": "shown", "surface": {"platform": "android"}, "privacy": "shared_room",
        }));
        let (incoming, reply) = parse_frame(&shown, expected(), 1_000_000_000).unwrap();
        let Incoming::Status(parsed) = incoming else {
            panic!("status expected")
        };
        assert_eq!(
            parsed,
            TurnStatus {
                turn_id: Uuid::from_u128(8),
                generation: 2,
                state: TurnState::Shown,
                surface: Some(SurfacePlatform::Android),
                privacy: Privacy::SharedRoom,
            }
        );
        assert_eq!(
            reply,
            serde_json::json!({"version":1,"kind":"received","stamp":stamp}).to_string()
        );
        let working = status(serde_json::json!({
            "version": 1, "turnId": Uuid::from_u128(8), "generation": 2,
            "state": "working", "surface": null, "privacy": "public",
        }));
        assert!(matches!(
            parse_frame(&working, expected(), 1_000_000_000),
            Ok((
                Incoming::Status(TurnStatus {
                    state: TurnState::Working,
                    surface: None,
                    ..
                }),
                _
            ))
        ));
        for invalid in [
            serde_json::json!({"version": 2, "turnId": Uuid::from_u128(8), "generation": 2, "state": "shown", "surface": null, "privacy": "public"}),
            serde_json::json!({"version": 1, "turnId": Uuid::nil(), "generation": 2, "state": "shown", "surface": null, "privacy": "public"}),
            serde_json::json!({"version": 1, "turnId": Uuid::from_u128(8), "generation": 0, "state": "shown", "surface": null, "privacy": "public"}),
            serde_json::json!({"version": 1, "turnId": Uuid::from_u128(8), "generation": 2, "state": "privacy_blocked", "surface": null, "privacy": "public"}),
            serde_json::json!({"version": 1, "turnId": Uuid::from_u128(8), "generation": 2, "state": "shown", "surface": {"platform": "ios"}, "privacy": "public"}),
            serde_json::json!({"version": 1, "turnId": Uuid::from_u128(8), "generation": 2, "state": "shown", "surface": {"platform": "android", "surfaceId": Uuid::from_u128(3)}, "privacy": "public"}),
            serde_json::json!({"version": 1, "turnId": Uuid::from_u128(8), "generation": 2, "state": "shown", "surface": null, "privacy": "sensitive"}),
            serde_json::json!({"version": 1, "turnId": Uuid::from_u128(8), "generation": 2, "state": "shown", "surface": null, "privacy": "public", "reason": "blocked"}),
            serde_json::json!({"version": 1, "turnId": Uuid::from_u128(8), "generation": 2, "state": "shown", "privacy": "public"}),
        ] {
            assert!(
                parse_frame(&status(invalid.clone()), expected(), 1_000_000_000).is_err(),
                "{invalid}"
            );
        }
    }

    /// The owner's own policy for this installation, delivered over the
    /// connection it already holds. It is refused unless it names this exact
    /// surface and the approval revision this connection was opened at, and
    /// unless the digest the runtime sent is the digest of the document this
    /// client itself would serialize.
    #[test]
    fn policy_frames_bind_the_surface_the_approval_revision_and_the_exact_digest() {
        use crate::action::{
            ActionPolicy, CommandPolicy, DevicePolicy, OpenPolicy, PolicyApp, PolicyEntry,
            PolicyRoot, RouteApp, RoutePolicy,
        };
        let owner = DevicePolicy {
            version: 1,
            surface_id: Uuid::from_u128(2),
            approval_revision: 4,
            actions: Some(ActionPolicy {
                revision: 3,
                maximum_class: Privacy::SharedRoom,
                open: Some(OpenPolicy {
                    hosts: vec!["github.com".into(), "news.ycombinator.com".into()],
                    apps: vec![PolicyApp {
                        id: "dev.zed.Zed".into(),
                        label: "Zed".into(),
                    }],
                    roots: vec![PolicyRoot {
                        id: "repo".into(),
                        label: "Projects".into(),
                        path: "/Users/owner/Projects".into(),
                    }],
                }),
                route: Some(RoutePolicy {
                    app: RouteApp::GoogleMaps,
                }),
                play: None,
            }),
            commands: Some(CommandPolicy {
                revision: 2,
                maximum_class: Privacy::Private,
                offer_output_to_cognition: false,
                entries: vec![PolicyEntry {
                    id: "project-tests".into(),
                    label: "Project tests".into(),
                    argv: vec!["./revival".into(), "check".into(), "cosmos".into()],
                    cwd: "/Users/owner/Projects/ai-pin-revival".into(),
                    mutates: true,
                    budget_ms: 900_000,
                }],
            }),
        };
        let frame = |policy: serde_json::Value, digest: serde_json::Value| {
            serde_json::json!({
                "version": 1, "kind": "policy",
                "stamp": {"epoch": Uuid::from_u128(9), "sequence": 5, "instanceId": Uuid::from_u128(13)},
                "digest": digest, "policy": policy,
            })
            .to_string()
        };
        let document = serde_json::to_value(&owner).unwrap();
        let held = frame(document.clone(), owner.content_digest().into());
        let (incoming, reply) = parse_frame(&held, expected(), 1).unwrap();
        let Incoming::Policy(Some(held)) = incoming else {
            panic!("policy expected")
        };
        assert_eq!(held.policy, owner);
        assert_eq!(held.document, owner.document());
        assert_eq!(held.digest, owner.content_digest());
        assert_eq!(
            crate::action::DevicePolicy::parse(held.document.as_bytes()).unwrap(),
            owner
        );
        assert_eq!(
            reply,
            serde_json::json!({"version":1,"kind":"received","stamp":{"epoch":Uuid::from_u128(9),"sequence":5,"instanceId":Uuid::from_u128(13)}}).to_string()
        );

        // An explicit null withdraws the copy, which leaves this installation
        // doing nothing at all. It is a state, not a failure.
        let withdrawn = frame(serde_json::Value::Null, serde_json::Value::Null);
        assert!(matches!(
            parse_frame(&withdrawn, expected(), 1),
            Ok((Incoming::Policy(None), _))
        ));

        // Someone else's policy, another approval, a digest that is not the
        // digest of this document, half a frame, or a document out of shape.
        let other_surface = serde_json::json!({"surfaceId": Uuid::from_u128(3).to_string()});
        let mut foreign = document.clone();
        foreign["surfaceId"] = other_surface["surfaceId"].clone();
        let mut reapproved = document.clone();
        reapproved["approvalRevision"] = serde_json::json!(5);
        let mut widened = document.clone();
        widened["actions"]["open"]["hosts"] = serde_json::json!(["GitHub.com", "example.com"]);
        let mut shell = document.clone();
        shell["commands"]["entries"][0]["argv"] = serde_json::json!([]);
        let mut unsorted = document.clone();
        unsorted["actions"]["open"]["hosts"] =
            serde_json::json!(["news.ycombinator.com", "github.com"]);
        for (label, invalid) in [
            ("foreign", frame(foreign.clone(), digest_of(&foreign))),
            (
                "reapproved",
                frame(reapproved.clone(), digest_of(&reapproved)),
            ),
            ("widened", frame(widened.clone(), digest_of(&widened))),
            ("shell", frame(shell.clone(), digest_of(&shell))),
            ("unsorted", frame(unsorted.clone(), digest_of(&unsorted))),
            (
                "wrong digest",
                frame(document.clone(), sha256_hex(b"other").into()),
            ),
            (
                "no digest",
                frame(document.clone(), serde_json::Value::Null),
            ),
            (
                "digest alone",
                frame(serde_json::Value::Null, owner.content_digest().into()),
            ),
            ("unknown field", {
                let mut extra = document.clone();
                extra["openers"] = serde_json::json!([]);
                frame(extra.clone(), digest_of(&extra))
            }),
        ] {
            assert!(
                parse_frame(&invalid, expected(), 1).is_err(),
                "accepted {label}"
            );
        }
        // A frame that omits either field is a shape the runtime never sends.
        for omitted in ["digest", "policy"] {
            let mut value: serde_json::Value =
                serde_json::from_str(&frame(document.clone(), owner.content_digest().into()))
                    .unwrap();
            value.as_object_mut().unwrap().remove(omitted);
            assert!(
                parse_frame(&value.to_string(), expected(), 1).is_err(),
                "accepted a frame without {omitted}"
            );
        }
    }

    /// The digest of a document exactly as this client would serialize it,
    /// for the frames a test deliberately malforms.
    fn digest_of(document: &serde_json::Value) -> serde_json::Value {
        match serde_json::from_value::<crate::action::DevicePolicy>(document.clone()) {
            Ok(policy) => policy.content_digest().into(),
            Err(_) => sha256_hex(document.to_string().as_bytes()).into(),
        }
    }

    #[test]
    fn clear_frames_and_malformed_frames() {
        let clear = serde_json::json!({
            "version": 1, "kind": "clear",
            "stamp": {"epoch": Uuid::from_u128(9), "sequence": 4, "instanceId": Uuid::from_u128(11)},
            "actionId": Uuid::from_u128(7),
        })
        .to_string();
        assert!(
            matches!(parse_frame(&clear, expected(), 1), Ok((Incoming::Clear(id), _)) if id == Uuid::from_u128(7))
        );
        assert!(parse_frame("{}", expected(), 1).is_err());
        assert!(parse_frame(&"x".repeat(cosmos_rtc::MAX_PAYLOAD + 1), expected(), 1).is_err());
    }
}
