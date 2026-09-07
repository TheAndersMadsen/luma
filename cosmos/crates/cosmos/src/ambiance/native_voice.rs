//! Speaking to a native installation. The person holds a push-to-talk control
//! down; the client records while it shows that it is recording; on release it
//! hands Cosmos the bounded audio over the connection it already holds. Cosmos
//! transcribes it with the isolated local recognizer and admits the transcript
//! as one ordinary sequenced request that is marked as spoken.
//!
//! Three lines run through the whole path. Nothing here opens a microphone:
//! there is no command a runtime, a model or another device can send that
//! makes a client listen, so capture begins at the person's own press and at
//! nothing else. No raw audio leaves the owner's own infrastructure: the bytes
//! reach `cosmos-stt` inside Cosmos and no provider, and neither the audio nor
//! the transcript is durable state. And the class a spoken request is admitted
//! at is the owner's own floor for that one installation, capped by what that
//! installation is: a television sits in a room with other people, so it can
//! never claim a private floor no matter what the owner writes.
use super::{
    InputStamp, PrivacyClass, RuntimeData, RuntimeError, RuntimeState,
    native_connection::NativeProof,
};
use crate::surface_registry::{self, Binding, Record, hash};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const OWNER_APPROVAL: &str = "approve-native-voice-v1";
/// One press is at most fifteen seconds of audio at 16 kHz mono. This is the
/// server's own bound on what it will accept, not a promise about a client's
/// microphone: `cosmos-stt` refuses anything longer either way.
pub const MAX_CAPTURE_MS: i64 = 15_000;
pub const SAMPLE_RATE: u32 = 16_000;
pub const MAX_SAMPLES: u32 = 15 * SAMPLE_RATE;
/// Signed 16-bit little-endian mono, the one encoding the recognizer takes.
pub const MAX_AUDIO_BYTES: usize = MAX_SAMPLES as usize * 2;

/// The owner's statement that this installation may be spoken to, and the
/// class its speech is admitted at. `sourceFloor` is a floor, never a ceiling:
/// the transcript's own classifier terms still raise the turn from here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub source_floor: PrivacyClass,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub approval_revision: u64,
    pub revision: u64,
    pub policy: Option<Policy>,
}

/// What the installation states about the capture it already made. Cosmos
/// cannot see a microphone LED, so this is an attestation in exactly the sense
/// `confirm.tap` is one: the client names what it did, the name is bound into
/// the admitted request, and a capture that does not carry both halves is not
/// a capture Cosmos accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Attestation {
    /// The person held a control down; nothing else started this.
    PushToTalk,
    /// The client showed that it was capturing for the whole capture.
    CaptureIndicator,
}

pub const REQUIRED_ATTESTATION: [Attestation; 2] =
    [Attestation::PushToTalk, Attestation::CaptureIndicator];

/// The client's half of one capture: what it attests and how long it held the
/// microphone open. The sample count and the audio digest are the runtime's
/// own reading of the bytes it received, never a claim the request makes.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claim {
    pub attestation: Vec<Attestation>,
    pub capture_ms: i64,
}

/// One admitted push-to-talk capture. Constructed only by the runtime, from
/// the checked policy and its own decode of the received audio.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub attestation: Vec<Attestation>,
    pub capture_ms: i64,
    pub samples: u32,
    pub audio_digest: String,
    pub policy_revision: u64,
    pub source_floor: PrivacyClass,
}

impl Capture {
    pub(crate) fn new(
        claim: &Claim,
        samples: u32,
        audio_digest: String,
        policy_revision: u64,
        source_floor: PrivacyClass,
    ) -> Self {
        Self {
            attestation: claim.attestation.clone(),
            capture_ms: claim.capture_ms,
            samples,
            audio_digest,
            policy_revision,
            source_floor,
        }
    }

    /// Bounded by the server, in both directions: a press longer than the
    /// budget is refused, and audio longer than the press it declares is
    /// refused too, so the declared window can never understate what was
    /// recorded.
    pub fn valid(&self) -> bool {
        self.attestation == REQUIRED_ATTESTATION
            && self.capture_ms > 0
            && self.capture_ms <= MAX_CAPTURE_MS
            && self.samples > 0
            && self.samples <= MAX_SAMPLES
            && u64::from(self.samples) * 1000 <= (self.capture_ms as u64) * u64::from(SAMPLE_RATE)
            && super::state::digest_valid(&self.audio_digest)
            && self.policy_revision > 0
            && self.source_floor >= PrivacyClass::SharedRoom
    }

    #[cfg(test)]
    pub(super) fn source_digest_for_test(&self, stamp: &InputStamp) -> String {
        self.source_digest(stamp).unwrap()
    }

    /// The admitted request's identity is its capture, not its words: an
    /// exact retry replays the same press and returns the same admission
    /// instead of paying for a second recognition of the same audio.
    pub(super) fn source_digest(&self, stamp: &InputStamp) -> Result<String, RuntimeError> {
        Ok(hash(
            &serde_json::to_vec(&("cosmos.native-voice.v1", stamp, self))
                .map_err(|_| RuntimeError::Unavailable)?,
        ))
    }
}

/// What one installation is allowed to be spoken to at, before the owner's own
/// policy narrows it further.
///
/// A shared device cannot claim a private floor. The only thing that makes an
/// installation personal in Cosmos is the owner's `approve-private-display-v1`
/// declaration for it, which a television cannot hold at all; without one, the
/// most a spoken request there can be admitted at is `shared_room`, which is
/// also the least it can be admitted at, because an unknown actor in a room of
/// unknown occupancy never establishes public capture.
pub(super) fn ceiling(personal: Option<PrivacyClass>) -> PrivacyClass {
    personal.unwrap_or(PrivacyClass::SharedRoom)
}

fn native_record(records: &BTreeMap<Uuid, Record>, surface: Uuid) -> Result<&Record, RuntimeError> {
    records
        .get(&surface)
        .filter(|record| !record.revoked && matches!(record.binding, Binding::Native { .. }))
        .ok_or(RuntimeError::InvalidOrigin)
}

impl RuntimeState {
    pub(super) fn native_voice_policy(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> Result<Option<Approval>, RuntimeError> {
        let record = native_record(records, surface)?;
        Ok(self
            .native_voice_policies
            .get(&surface)
            .filter(|approval| approval.approval_revision == record.revision)
            .cloned())
    }

    pub(super) fn native_voice_ceiling(
        &self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
    ) -> PrivacyClass {
        ceiling(self.personal_ceiling(records, surface))
    }

    /// The owner's own write. A microphone the installation's approved
    /// manifest does not declare is not writable here at all, so an
    /// installation still on a legacy profile has to be reapproved before it
    /// can be spoken to.
    pub(super) fn set_native_voice_policy(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface: Uuid,
        approval_revision: u64,
        expected_revision: u64,
        policy: Option<Policy>,
    ) -> Result<(Approval, Vec<RuntimeData>), RuntimeError> {
        let current = self.native_voice_policy(records, surface)?;
        let record = native_record(records, surface)?;
        if record.revision != approval_revision
            || current.as_ref().map_or(0, |approval| approval.revision) != expected_revision
        {
            return Err(RuntimeError::Stale);
        }
        if policy.is_some()
            && !surface_registry::native_declares_input(
                record,
                surface_registry::NATIVE_VOICE_INPUT,
            )
        {
            return Err(RuntimeError::PolicyBlocked);
        }
        let ceiling = self.native_voice_ceiling(records, surface);
        if policy.is_some_and(|policy| {
            policy.source_floor < PrivacyClass::SharedRoom || policy.source_floor > ceiling
        }) {
            return Err(RuntimeError::InvalidRequest);
        }
        let approval = Approval {
            approval_revision,
            revision: expected_revision
                .checked_add(1)
                .ok_or(RuntimeError::Unavailable)?,
            policy,
        };
        self.native_voice_policies.insert(surface, approval.clone());
        Ok((
            approval.clone(),
            vec![RuntimeData::NativeVoicePolicyChanged {
                surface_id: surface,
                approval,
            }],
        ))
    }

    /// The one gate that decides whether any audio is worth receiving, checked
    /// before a single sample reaches the recognizer. `PolicyBlocked` is the
    /// owner's answer: this installation may not be spoken to.
    pub(super) fn admit_native_voice(
        &self,
        records: &BTreeMap<Uuid, Record>,
        connection: &NativeProof,
        now: i64,
    ) -> Result<(u64, PrivacyClass), RuntimeError> {
        self.check_native(records, connection, now)?;
        let record = native_record(records, connection.surface_id)?;
        if !surface_registry::native_declares_input(record, surface_registry::NATIVE_VOICE_INPUT) {
            return Err(RuntimeError::InvalidOrigin);
        }
        let approval = self
            .native_voice_policies
            .get(&connection.surface_id)
            .filter(|approval| approval.approval_revision == record.revision)
            .ok_or(RuntimeError::PolicyBlocked)?;
        let policy = approval.policy.ok_or(RuntimeError::PolicyBlocked)?;
        let ceiling = self.native_voice_ceiling(records, connection.surface_id);
        if policy.source_floor < PrivacyClass::SharedRoom || policy.source_floor > ceiling {
            return Err(RuntimeError::PolicyBlocked);
        }
        Ok((approval.revision, policy.source_floor))
    }

    /// Re-run under the admission lock, against the policy as it stands now.
    /// A permission withdrawn, an installation reapproved or a personal
    /// declaration dropped between the press and this transition all land
    /// here, and all refuse the request rather than admitting it at the class
    /// the press was checked at.
    pub(super) fn validate_native_voice(
        &self,
        records: &BTreeMap<Uuid, Record>,
        connection: &NativeProof,
        capture: &Capture,
        now: i64,
    ) -> Result<(), RuntimeError> {
        if !capture.valid() {
            return Err(RuntimeError::InvalidRequest);
        }
        let (policy_revision, source_floor) = self.admit_native_voice(records, connection, now)?;
        if policy_revision != capture.policy_revision || source_floor != capture.source_floor {
            return Err(RuntimeError::Stale);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture() -> Capture {
        Capture {
            attestation: REQUIRED_ATTESTATION.to_vec(),
            capture_ms: 2_000,
            samples: 32_000,
            audio_digest: hash(b"synthetic-capture"),
            policy_revision: 1,
            source_floor: PrivacyClass::SharedRoom,
        }
    }

    #[test]
    fn ambiance_native_voice_capture_is_bounded_and_attested() {
        let valid = capture();
        assert!(valid.valid());
        assert_eq!(MAX_AUDIO_BYTES, 480_000);
        assert_eq!(MAX_SAMPLES as usize, cosmos_stt::MAX_SAMPLES);
        assert_eq!(SAMPLE_RATE as usize, cosmos_stt::SAMPLE_RATE);
        // Exactly the declared window, at the recognizer's own rate, is the
        // largest capture a press of that length can carry.
        let mut full = valid.clone();
        full.capture_ms = MAX_CAPTURE_MS;
        full.samples = MAX_SAMPLES;
        assert!(full.valid());
        for invalid in [
            Capture {
                attestation: vec![Attestation::PushToTalk],
                ..valid.clone()
            },
            Capture {
                attestation: vec![Attestation::CaptureIndicator, Attestation::PushToTalk],
                ..valid.clone()
            },
            Capture {
                attestation: Vec::new(),
                ..valid.clone()
            },
            Capture {
                capture_ms: 0,
                ..valid.clone()
            },
            Capture {
                capture_ms: MAX_CAPTURE_MS + 1,
                samples: MAX_SAMPLES,
                ..valid.clone()
            },
            Capture {
                samples: 0,
                ..valid.clone()
            },
            // More audio than the press it declares.
            Capture {
                capture_ms: 1_000,
                samples: 16_001,
                ..valid.clone()
            },
            Capture {
                samples: MAX_SAMPLES + 1,
                capture_ms: MAX_CAPTURE_MS,
                ..valid.clone()
            },
            Capture {
                audio_digest: "not-a-digest".into(),
                ..valid.clone()
            },
            Capture {
                policy_revision: 0,
                ..valid.clone()
            },
            Capture {
                source_floor: PrivacyClass::Public,
                ..valid.clone()
            },
        ] {
            assert!(!invalid.valid(), "{invalid:?}");
        }
    }

    #[test]
    fn ambiance_native_voice_source_digest_binds_the_press_not_the_words() {
        let stamp = InputStamp {
            epoch: Uuid::from_u128(1),
            sequence: 4,
            instance_id: Uuid::from_u128(2),
        };
        let capture = capture();
        let digest = capture.source_digest(&stamp).unwrap();
        assert_eq!(digest, capture.source_digest(&stamp).unwrap());
        let mut later = stamp.clone();
        later.sequence = 5;
        assert_ne!(digest, capture.source_digest(&later).unwrap());
        let mut louder = capture.clone();
        louder.samples += 1;
        assert_ne!(digest, louder.source_digest(&stamp).unwrap());
        let mut private = capture.clone();
        private.source_floor = PrivacyClass::Private;
        assert_ne!(digest, private.source_digest(&stamp).unwrap());
    }

    /// A television holds no personal declaration, so its ceiling is the
    /// shared room and its floor is the shared room: one class, no room for
    /// the owner to claim otherwise.
    #[test]
    fn ambiance_native_voice_ceiling_follows_the_personal_declaration() {
        assert_eq!(ceiling(None), PrivacyClass::SharedRoom);
        assert_eq!(
            ceiling(Some(PrivacyClass::NearUser)),
            PrivacyClass::NearUser
        );
        assert_eq!(ceiling(Some(PrivacyClass::Private)), PrivacyClass::Private);
    }
}
