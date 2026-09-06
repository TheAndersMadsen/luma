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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaceItem {
    pub place_id: String,
    pub name: String,
    pub address: String,
    pub source_url: Option<String>,
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
}

pub(crate) enum Incoming {
    Render(Display),
    Clear(Uuid),
    Speak(crate::speech::SpeechFrame),
}

/// The exact bound connection this frame must name.
#[derive(Clone, Copy)]
pub(crate) struct Expected {
    pub(crate) surface_id: Uuid,
    pub(crate) incarnation: Uuid,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Byte-for-byte the runtime's binding: text hashes its bytes, a place card
/// hashes its canonical tuple including every raw credit string.
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
    }
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
                }),
                stamp,
            )
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
