//! Independent client interpretation of the native installation and room wire
//! contracts. No server implementation or server credentials are used here.
use crate::Error;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const PROFILE: &str = "native-shared-text-v1";
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const CLOCK_ALLOWANCE_MS: i64 = 5_000;
const CHALLENGE_MS: i64 = 60_000;
const CONNECTION_MS: i64 = 3_600_000;
const LEASE_MS: i64 = 45_000;
const DOMAIN: &[u8] = b"cosmos.native.open.v1\0";

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;

pub(crate) fn canonical_origin(value: &str) -> Result<String, Error> {
    if value.len() > 255 || value.trim() != value {
        return Err(Error::InvalidConfig);
    }
    let url = reqwest::Url::parse(value).map_err(|_| Error::InvalidConfig)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidConfig);
    }
    let origin = url.origin().ascii_serialization();
    if value != origin && value != format!("{origin}/") {
        return Err(Error::InvalidConfig);
    }
    Ok(origin)
}

pub(crate) fn public_key(bytes: [u8; 65]) -> Result<VerifyingKey, Error> {
    if bytes[0] != 4 {
        return Err(Error::InvalidConfig);
    }
    VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| Error::InvalidConfig)
}

pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn decode_secret(value: &str) -> Result<[u8; 32], Error> {
    if value.len() != 43 {
        return Err(Error::InvalidResponse);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::InvalidResponse)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(Error::InvalidResponse);
    }
    decoded.try_into().map_err(|_| Error::InvalidResponse)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChallengeEnvelope {
    pub(crate) challenge: Challenge,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Challenge {
    pub(crate) version: u8,
    pub(crate) audience: String,
    pub(crate) enrollment_id: Uuid,
    pub(crate) surface_id: Uuid,
    pub(crate) approval_revision: u64,
    pub(crate) approval: String,
    pub(crate) public_key_fingerprint: String,
    pub(crate) challenge_id: Uuid,
    pub(crate) nonce: String,
    pub(crate) expires_at_ms: i64,
    #[serde(deserialize_with = "required_incarnation")]
    pub(crate) current_incarnation: Option<Uuid>,
}

/// A pending signature and session digest are credentials: no Debug.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenRequest {
    pub(crate) enrollment_id: Uuid,
    pub(crate) challenge_id: Uuid,
    pub(crate) epoch: Uuid,
    #[serde(deserialize_with = "required_incarnation")]
    pub(crate) expected_incarnation: Option<Uuid>,
    pub(crate) session_token_hash: String,
    pub(crate) signature: String,
}

// Plain Option fields accept omission in serde; the contract requires an
// explicit null on a first connection so an omitted CAS value cannot pass.
fn required_incarnation<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error> {
    Option::deserialize(deserializer)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionView {
    pub(crate) surface_id: Uuid,
    pub(crate) approval_revision: u64,
    pub(crate) incarnation: Uuid,
    pub(crate) epoch: Uuid,
    pub(crate) expires_at_ms: i64,
    pub(crate) lease_expires_at_ms: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenResponse {
    pub(crate) connection: ConnectionView,
    pub(crate) duplicate: bool,
}

/// Contains a short-lived room credential: deliberately no Debug.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RoomResponse {
    pub(crate) version: u8,
    pub(crate) url: String,
    pub(crate) token: String,
    pub(crate) participant: Uuid,
    pub(crate) runtime_participant: String,
    pub(crate) runtime_epoch: Uuid,
    pub(crate) epoch: Uuid,
}

impl Challenge {
    fn validate_fields(&self) -> Result<(), Error> {
        if self.version != 1
            || self.audience
                != canonical_origin(&self.audience).map_err(|_| Error::InvalidResponse)?
            || self.approval != PROFILE
            || self.approval_revision == 0
            || self.approval_revision > MAX_REVISION
            || self.enrollment_id.is_nil()
            || self.surface_id.is_nil()
            || self.challenge_id.is_nil()
            || self.current_incarnation.is_some_and(|id| id.is_nil())
            || self.expires_at_ms <= 0
        {
            return Err(Error::InvalidResponse);
        }
        digest_bytes(&self.public_key_fingerprint)?;
        decode_secret(&self.nonce)?;
        Ok(())
    }

    pub(crate) fn validate(
        &self,
        origin: &str,
        enrollment: Uuid,
        key: &[u8; 65],
        now_ms: i64,
    ) -> Result<(), Error> {
        let origin = canonical_origin(origin)?;
        public_key(*key)?;
        self.validate_fields()?;
        if self.audience != origin
            || self.enrollment_id != enrollment
            || self.public_key_fingerprint != fingerprint(key)
        {
            return Err(Error::InvalidResponse);
        }
        deadline(self.expires_at_ms, now_ms, CHALLENGE_MS)
    }
}

impl ConnectionView {
    pub(crate) fn validate(
        &self,
        challenge: &Challenge,
        epoch: Uuid,
        now_ms: i64,
    ) -> Result<(), Error> {
        if self.surface_id.is_nil()
            || self.surface_id != challenge.surface_id
            || self.approval_revision == 0
            || self.approval_revision > MAX_REVISION
            || self.approval_revision != challenge.approval_revision
            || self.incarnation.is_nil()
            || self.epoch.is_nil()
            || self.epoch != epoch
            || self.lease_expires_at_ms > self.expires_at_ms
        {
            return Err(Error::InvalidResponse);
        }
        deadline(self.expires_at_ms, now_ms, CONNECTION_MS)?;
        deadline(self.lease_expires_at_ms, now_ms, LEASE_MS)
    }
}

impl RoomResponse {
    pub(crate) fn validate(&self, origin: &str, epoch: Uuid) -> Result<(), Error> {
        let origin = canonical_origin(origin)?;
        let origin = reqwest::Url::parse(&origin).map_err(|_| Error::InvalidConfig)?;
        if self.version != 1
            || self.epoch.is_nil()
            || self.epoch != epoch
            || self.runtime_participant != "runtime"
            || self.participant.is_nil()
            || self.runtime_epoch.is_nil()
            || self.url.len() > 2048
            || self.token.len() > 4096
        {
            return Err(Error::InvalidResponse);
        }
        let url = reqwest::Url::parse(&self.url).map_err(|_| Error::InvalidResponse)?;
        if url.scheme() != "wss"
            || url.host_str() != origin.host_str()
            || url.port_or_known_default() != origin.port_or_known_default()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.as_str() != self.url
        {
            return Err(Error::InvalidResponse);
        }
        let mut count = 0;
        for part in self.token.split('.') {
            if part.is_empty() {
                return Err(Error::InvalidResponse);
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(part)
                .map_err(|_| Error::InvalidResponse)?;
            if URL_SAFE_NO_PAD.encode(bytes) != part {
                return Err(Error::InvalidResponse);
            }
            count += 1;
        }
        if count != 3 {
            return Err(Error::InvalidResponse);
        }
        Ok(())
    }
}

fn deadline(value: i64, now_ms: i64, maximum_ms: i64) -> Result<(), Error> {
    let upper = now_ms
        .checked_add(maximum_ms + CLOCK_ALLOWANCE_MS)
        .ok_or(Error::InvalidResponse)?;
    if now_ms <= 0 || value <= now_ms || value > upper {
        return Err(Error::InvalidResponse);
    }
    Ok(())
}

fn digest_bytes(value: &str) -> Result<[u8; 32], Error> {
    if value.len() != 64 {
        return Err(Error::InvalidResponse);
    }
    fn nibble(byte: u8) -> Result<u8, Error> {
        match byte {
            b'0'..=b'9' => Ok(byte - b'0'),
            b'a'..=b'f' => Ok(byte - b'a' + 10),
            _ => Err(Error::InvalidResponse),
        }
    }
    let mut result = [0; 32];
    for (byte, pair) in result.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Ok(result)
}

/// Encode the exact version-one transcript. Verification/signing hashes these
/// complete bytes once with SHA-256; callers must not sign its digest again.
pub(crate) fn signing_message(
    challenge: &Challenge,
    request: &OpenRequest,
) -> Result<Vec<u8>, Error> {
    challenge.validate_fields()?;
    if request.enrollment_id != challenge.enrollment_id
        || request.challenge_id != challenge.challenge_id
        || request.epoch.is_nil()
        || request.expected_incarnation != challenge.current_incarnation
    {
        return Err(Error::InvalidResponse);
    }
    let key_fingerprint = digest_bytes(&challenge.public_key_fingerprint)?;
    let nonce = decode_secret(&challenge.nonce)?;
    let token_hash = digest_bytes(&request.session_token_hash)?;
    let mut message = Vec::with_capacity(512);
    message.extend_from_slice(DOMAIN);
    message.extend_from_slice(&(challenge.audience.len() as u16).to_be_bytes());
    message.extend_from_slice(challenge.audience.as_bytes());
    message.extend_from_slice(challenge.enrollment_id.as_bytes());
    message.extend_from_slice(challenge.surface_id.as_bytes());
    message.extend_from_slice(&challenge.approval_revision.to_be_bytes());
    message.extend_from_slice(&(challenge.approval.len() as u16).to_be_bytes());
    message.extend_from_slice(challenge.approval.as_bytes());
    message.extend_from_slice(&key_fingerprint);
    message.extend_from_slice(challenge.challenge_id.as_bytes());
    message.extend_from_slice(&nonce);
    message.extend_from_slice(&challenge.expires_at_ms.to_be_bytes());
    message.extend_from_slice(request.epoch.as_bytes());
    message.push(u8::from(request.expected_incarnation.is_some()));
    if let Some(incarnation) = request.expected_incarnation {
        message.extend_from_slice(incarnation.as_bytes());
    }
    message.extend_from_slice(&token_hash);
    Ok(message)
}

pub(crate) fn verify_signature(key: &[u8; 65], message: &[u8], der: &[u8]) -> Result<(), Error> {
    if !(8..=72).contains(&der.len()) {
        return Err(Error::InvalidSignature);
    }
    let signature = Signature::from_der(der).map_err(|_| Error::InvalidSignature)?;
    if signature.to_der().as_bytes() != der {
        return Err(Error::InvalidSignature);
    }
    public_key(*key)
        .map_err(|_| Error::InvalidSignature)?
        .verify(message, &signature)
        .map_err(|_| Error::InvalidSignature)
}
