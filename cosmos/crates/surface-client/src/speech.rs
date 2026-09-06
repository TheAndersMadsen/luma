//! Incoming speech frames. The runtime streams one disclosed synthesis as a
//! bound header followed by ordered audio chunks; the platform plays the
//! exact assembled bytes, then acknowledges playback. A transport receipt is
//! never playback evidence.
use crate::{Error, MAX_TEXT_BYTES};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
/// Matches the runtime's per-frame audio bound after base64 decoding.
const MAX_CHUNK_BYTES: usize = 8192;
/// Matches the runtime's whole-reply bound.
pub const MAX_AUDIO_BYTES: usize = 1_048_576;

/// One complete spoken reply the runtime delivered to this installation. It
/// carries no authority: acknowledging it reports what was actually played.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Speech {
    pub action_id: Uuid,
    pub turn_id: Uuid,
    pub generation: u64,
    pub content_digest: String,
    /// The spoken text, byte-for-byte the digest's preimage.
    pub text: String,
    /// The MIME type of `audio`; currently always `audio/mpeg`.
    pub format: String,
    pub audio: Vec<u8>,
    pub expires_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechFrame {
    version: u8,
    action_id: Uuid,
    turn_id: Uuid,
    generation: u64,
    surface_id: Uuid,
    incarnation: Uuid,
    channel: String,
    content_digest: String,
    format: String,
    expires_at: i64,
    sequence: u64,
    #[serde(rename = "final")]
    last: bool,
    text: Option<String>,
    chunk: Option<String>,
}

pub(crate) struct Expected {
    pub(crate) surface_id: Uuid,
    pub(crate) incarnation: Uuid,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl SpeechFrame {
    pub(crate) fn sequence_action(&self) -> Uuid {
        self.action_id
    }

    pub(crate) fn validate(&self, expected: Expected, now_ms: i64) -> Result<(), Error> {
        if self.version != 1
            || self.channel != "audio.tts"
            || self.format != "audio/mpeg"
            || self.action_id.is_nil()
            || self.turn_id.is_nil()
            || self.generation == 0
            || self.generation > MAX_SEQUENCE
            || self.surface_id != expected.surface_id
            || self.incarnation != expected.incarnation
            || self.expires_at <= now_ms
            || self.sequence == 0
            || self.sequence > MAX_SEQUENCE
            || self.content_digest.len() != 64
            || !self
                .content_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || (self.sequence == 1) != self.text.is_some()
            || (self.sequence == 1) == self.chunk.is_some()
            || (self.sequence == 1 && self.last)
        {
            return Err(Error::InvalidResponse);
        }
        if let Some(text) = &self.text
            && (text.trim().is_empty()
                || text.len() > MAX_TEXT_BYTES
                || text.contains('\0')
                || sha256_hex(text.as_bytes()) != self.content_digest)
        {
            return Err(Error::InvalidResponse);
        }
        Ok(())
    }

    fn chunk_bytes(&self) -> Result<Vec<u8>, Error> {
        let encoded = self.chunk.as_deref().ok_or(Error::InvalidResponse)?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| Error::InvalidResponse)?;
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
            return Err(Error::InvalidResponse);
        }
        Ok(bytes)
    }
}

/// Reassembles one reply at a time. A header starts a fresh reply and
/// discards any partial one; chunks must arrive in exact sequence.
#[derive(Default)]
pub(crate) struct Assembler {
    partial: Option<(Speech, u64)>,
}

impl Assembler {
    /// Returns the completed reply after its final frame.
    pub(crate) fn accept(&mut self, frame: SpeechFrame) -> Result<Option<Speech>, Error> {
        if let Some(text) = frame.text {
            self.partial = Some((
                Speech {
                    action_id: frame.action_id,
                    turn_id: frame.turn_id,
                    generation: frame.generation,
                    content_digest: frame.content_digest,
                    text,
                    format: frame.format,
                    audio: Vec::new(),
                    expires_at_ms: frame.expires_at,
                },
                1,
            ));
            return Ok(None);
        }
        let Some((speech, sequence)) = self.partial.as_mut() else {
            return Err(Error::InvalidResponse);
        };
        if frame.action_id != speech.action_id
            || frame.turn_id != speech.turn_id
            || frame.generation != speech.generation
            || frame.content_digest != speech.content_digest
            || frame.expires_at != speech.expires_at_ms
            || frame.sequence != *sequence + 1
        {
            self.partial = None;
            return Err(Error::InvalidResponse);
        }
        let bytes = match frame.chunk_bytes() {
            Ok(bytes) if speech.audio.len() + bytes.len() <= MAX_AUDIO_BYTES => bytes,
            _ => {
                self.partial = None;
                return Err(Error::InvalidResponse);
            }
        };
        speech.audio.extend_from_slice(&bytes);
        *sequence = frame.sequence;
        if frame.last {
            return Ok(self.partial.take().map(|(speech, _)| speech));
        }
        Ok(None)
    }

    pub(crate) fn clear(&mut self, action_id: Uuid) {
        if self
            .partial
            .as_ref()
            .is_some_and(|(speech, _)| speech.action_id == action_id)
        {
            self.partial = None;
        }
    }
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

    fn frame(sequence: u64, last: bool, body: serde_json::Value) -> SpeechFrame {
        let mut value = serde_json::json!({
            "version": 1, "actionId": Uuid::from_u128(7), "turnId": Uuid::from_u128(8),
            "generation": 2, "surfaceId": Uuid::from_u128(2), "incarnation": Uuid::from_u128(5),
            "channel": "audio.tts", "contentDigest": sha256_hex(b"A spoken answer."),
            "format": "audio/mpeg", "expiresAt": 1_000_060_000, "sequence": sequence, "final": last,
        });
        for (key, item) in body.as_object().unwrap() {
            value[key] = item.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn frames_bind_the_connection_and_assemble_in_order() {
        let header = frame(1, false, serde_json::json!({"text": "A spoken answer."}));
        header.validate(expected(), 1_000_000_000).unwrap();
        let mut assembler = Assembler::default();
        assert!(assembler.accept(header).unwrap().is_none());
        let first = frame(
            2,
            false,
            serde_json::json!({"chunk": STANDARD.encode(b"abc")}),
        );
        first.validate(expected(), 1_000_000_000).unwrap();
        assert!(assembler.accept(first).unwrap().is_none());
        let last = frame(
            3,
            true,
            serde_json::json!({"chunk": STANDARD.encode(b"def")}),
        );
        let speech = assembler.accept(last).unwrap().unwrap();
        assert_eq!(speech.audio, b"abcdef");
        assert_eq!(speech.text, "A spoken answer.");
        assert_eq!(speech.action_id, Uuid::from_u128(7));
        assert!(assembler.partial.is_none());
    }

    #[test]
    fn frames_reject_wrong_binding_digest_order_and_size() {
        let mut wrong = frame(1, false, serde_json::json!({"text": "Another answer."}));
        assert!(wrong.validate(expected(), 1_000_000_000).is_err());
        wrong = frame(1, false, serde_json::json!({"text": "A spoken answer."}));
        wrong.incarnation = Uuid::from_u128(6);
        assert!(wrong.validate(expected(), 1_000_000_000).is_err());
        let expired = frame(1, false, serde_json::json!({"text": "A spoken answer."}));
        assert!(expired.validate(expected(), 1_000_060_000).is_err());
        // A chunk with text, a header with a chunk, or a final header is malformed.
        assert!(
            frame(2, false, serde_json::json!({"text": "A spoken answer."}))
                .validate(expected(), 1_000_000_000)
                .is_err()
        );
        assert!(
            frame(1, true, serde_json::json!({"text": "A spoken answer."}))
                .validate(expected(), 1_000_000_000)
                .is_err()
        );
        let mut assembler = Assembler::default();
        // Chunks before a header, or out of sequence, discard the partial reply.
        assert!(
            assembler
                .accept(frame(
                    2,
                    false,
                    serde_json::json!({"chunk": STANDARD.encode(b"x")})
                ))
                .is_err()
        );
        assembler
            .accept(frame(
                1,
                false,
                serde_json::json!({"text": "A spoken answer."}),
            ))
            .unwrap();
        assert!(
            assembler
                .accept(frame(
                    3,
                    false,
                    serde_json::json!({"chunk": STANDARD.encode(b"x")})
                ))
                .is_err()
        );
        assert!(assembler.partial.is_none());
        assembler
            .accept(frame(
                1,
                false,
                serde_json::json!({"text": "A spoken answer."}),
            ))
            .unwrap();
        let oversized = STANDARD.encode(vec![0u8; MAX_CHUNK_BYTES + 1]);
        assert!(
            assembler
                .accept(frame(2, false, serde_json::json!({"chunk": oversized})))
                .is_err()
        );
        assembler
            .accept(frame(
                1,
                false,
                serde_json::json!({"text": "A spoken answer."}),
            ))
            .unwrap();
        assembler.clear(Uuid::from_u128(7));
        assert!(assembler.partial.is_none());
    }
}
