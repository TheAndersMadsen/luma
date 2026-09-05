//! Installation key possession and bounded connection authority. This does not
//! attest hardware, actors, occupancy, capture, rendering or media capabilities.
use super::{InputCursor, RuntimeData, RuntimeError, RuntimeState};
use crate::surface_registry::{self, Binding, Record};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[cfg(test)]
#[path = "native_connection_tests.rs"]
mod tests;

pub const CHALLENGE_MS: i64 = 60_000;
const DOMAIN: &[u8] = b"cosmos.native.open.v1\0";

fn decode(value: &str, size: usize) -> Result<Vec<u8>, RuntimeError> {
    if value.len() != (size * 8).div_ceil(6) {
        return Err(RuntimeError::InvalidRequest);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| RuntimeError::InvalidRequest)?;
    if bytes.len() != size || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(RuntimeError::InvalidRequest);
    }
    Ok(bytes)
}

fn key(value: &str) -> Result<VerifyingKey, RuntimeError> {
    let bytes = decode(value, 65)?;
    if bytes[0] != 4 {
        return Err(RuntimeError::InvalidRequest);
    }
    VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| RuntimeError::InvalidRequest)
}

pub fn validate_public_key(value: &str) -> Result<(), RuntimeError> {
    key(value).map(|_| ())
}

pub fn public_key_fingerprint(value: &str) -> Result<String, RuntimeError> {
    validate_public_key(value)?;
    Ok(surface_registry::hash(&decode(value, 65)?))
}

/// Configuration owns the audience. Neither Host nor forwarded headers do.
pub fn canonical_audience(value: &str) -> Result<String, RuntimeError> {
    if value.len() > 255 || value.trim() != value {
        return Err(RuntimeError::InvalidRequest);
    }
    let url = reqwest::Url::parse(value).map_err(|_| RuntimeError::InvalidRequest)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(RuntimeError::InvalidRequest);
    }
    let origin = url.origin().ascii_serialization();
    if value != origin && value != format!("{origin}/") {
        return Err(RuntimeError::InvalidRequest);
    }
    Ok(origin)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Challenge {
    pub version: u8,
    pub audience: String,
    pub enrollment_id: Uuid,
    pub surface_id: Uuid,
    pub approval_revision: u64,
    pub approval: String,
    pub public_key_fingerprint: String,
    pub challenge_id: Uuid,
    pub nonce: String,
    pub expires_at_ms: i64,
    pub current_incarnation: Option<Uuid>,
}

/// A signature and session digest are credentials: deliberately no Debug.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    pub enrollment_id: Uuid,
    pub challenge_id: Uuid,
    pub epoch: Uuid,
    #[serde(deserialize_with = "required_incarnation")]
    pub expected_incarnation: Option<Uuid>,
    pub session_token_hash: String,
    pub signature: String,
}

fn required_incarnation<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error> {
    Option::deserialize(deserializer)
}

/// Constructed from the exact installation session capability, never an owner
/// bearer or a stock device identity. Authority is checked in the Store.
#[derive(Clone)]
pub struct NativeProof {
    pub surface_id: Uuid,
    pub incarnation: Uuid,
    pub token_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeConnection {
    pub approval_revision: u64,
    pub incarnation: Uuid,
    pub epoch: Uuid,
    pub previous_incarnation: Option<Uuid>,
    pub expires_at_ms: i64,
    pub lease_expires_at_ms: i64,
    pub closed: bool,
    token_hash: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub surface_id: Uuid,
    pub approval_revision: u64,
    pub incarnation: Uuid,
    pub epoch: Uuid,
    pub expires_at_ms: i64,
    pub lease_expires_at_ms: i64,
}

impl NativeConnection {
    pub(super) fn current(&self, record: &Record, now: i64) -> bool {
        !self.closed
            && !record.revoked
            && matches!(record.binding, Binding::Native { .. })
            && record.approved_manifest == surface_registry::native_manifest()
            && self.approval_revision == record.revision
            && now < self.expires_at_ms
            && now < self.lease_expires_at_ms
    }

    fn view(&self, surface_id: Uuid) -> ConnectionView {
        ConnectionView {
            surface_id,
            approval_revision: self.approval_revision,
            incarnation: self.incarnation,
            epoch: self.epoch,
            expires_at_ms: self.expires_at_ms,
            lease_expires_at_ms: self.lease_expires_at_ms,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Consumed {
    challenge: Challenge,
    request_digest: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeState {
    approval_revision: u64,
    pending: Option<Challenge>,
    pub connection: Option<NativeConnection>,
    consumed: Option<Consumed>,
}

fn record(
    records: &BTreeMap<Uuid, Record>,
    surface_id: Uuid,
    enrollment_id: Uuid,
) -> Result<&Record, RuntimeError> {
    records
        .get(&surface_id)
        .filter(|record| {
            !record.revoked
                && record.approved_manifest == surface_registry::native_manifest()
                && matches!(record.binding, Binding::Native { enrollment_id: id, .. } if id == enrollment_id)
        })
        .ok_or(RuntimeError::InvalidOrigin)
}

fn digest_bytes(value: &str) -> Result<Vec<u8>, RuntimeError> {
    if !super::state::digest_valid(value) {
        return Err(RuntimeError::InvalidRequest);
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|_| RuntimeError::InvalidRequest)?;
            u8::from_str_radix(text, 16).map_err(|_| RuntimeError::InvalidRequest)
        })
        .collect()
}

/// Fixed signing bytes: domain; u16-BE byte-length + audience; enrollment UUID;
/// surface UUID; u64-BE approval revision; u16-BE length + approval profile;
/// key SHA256; challenge UUID; 32-byte nonce; i64-BE server expiry; boot UUID;
/// expected-incarnation tag (0/1), followed by UUID iff 1; session-secret SHA256.
/// UUIDs use their 16 network-order bytes. The ECDSA API hashes these bytes once.
pub fn signing_message(
    challenge: &Challenge,
    request: &OpenRequest,
) -> Result<Vec<u8>, RuntimeError> {
    if challenge.version != 1
        || challenge.audience != canonical_audience(&challenge.audience)?
        || challenge.approval != surface_registry::NATIVE_APPROVAL
        || challenge.approval_revision == 0
        || challenge.approval_revision > surface_registry::MAX_NATIVE_REVISION
        || challenge.expires_at_ms <= 0
        || challenge.enrollment_id.is_nil()
        || challenge.surface_id.is_nil()
        || challenge.challenge_id.is_nil()
        || request.enrollment_id != challenge.enrollment_id
        || request.challenge_id != challenge.challenge_id
        || request.epoch.is_nil()
        || request.expected_incarnation.is_some_and(|id| id.is_nil())
        || request.expected_incarnation != challenge.current_incarnation
    {
        return Err(RuntimeError::InvalidRequest);
    }
    let mut message = DOMAIN.to_vec();
    message.extend_from_slice(&(challenge.audience.len() as u16).to_be_bytes());
    message.extend_from_slice(challenge.audience.as_bytes());
    message.extend_from_slice(challenge.enrollment_id.as_bytes());
    message.extend_from_slice(challenge.surface_id.as_bytes());
    message.extend_from_slice(&challenge.approval_revision.to_be_bytes());
    message.extend_from_slice(&(challenge.approval.len() as u16).to_be_bytes());
    message.extend_from_slice(challenge.approval.as_bytes());
    message.extend_from_slice(&digest_bytes(&challenge.public_key_fingerprint)?);
    message.extend_from_slice(challenge.challenge_id.as_bytes());
    message.extend_from_slice(&decode(&challenge.nonce, 32)?);
    message.extend_from_slice(&challenge.expires_at_ms.to_be_bytes());
    message.extend_from_slice(request.epoch.as_bytes());
    message.push(u8::from(request.expected_incarnation.is_some()));
    if let Some(id) = request.expected_incarnation {
        message.extend_from_slice(id.as_bytes());
    }
    message.extend_from_slice(&digest_bytes(&request.session_token_hash)?);
    Ok(message)
}

fn verify(
    public_key: &str,
    challenge: &Challenge,
    request: &OpenRequest,
) -> Result<String, RuntimeError> {
    if request.signature.is_empty() || request.signature.len() > 96 {
        return Err(RuntimeError::InvalidOrigin);
    }
    let signature = URL_SAFE_NO_PAD
        .decode(&request.signature)
        .map_err(|_| RuntimeError::InvalidOrigin)?;
    if signature.len() > 72 || URL_SAFE_NO_PAD.encode(&signature) != request.signature {
        return Err(RuntimeError::InvalidOrigin);
    }
    let signature = Signature::from_der(&signature).map_err(|_| RuntimeError::InvalidOrigin)?;
    let message = signing_message(challenge, request)?;
    key(public_key)?
        .verify(&message, &signature)
        .map_err(|_| RuntimeError::InvalidOrigin)?;
    Ok(surface_registry::hash(&message))
}

impl RuntimeState {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn native_challenge(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface_id: Uuid,
        enrollment_id: Uuid,
        audience: String,
        challenge_id: Uuid,
        nonce: String,
        now: i64,
    ) -> Result<(Challenge, bool), RuntimeError> {
        let record = record(records, surface_id, enrollment_id)?;
        if challenge_id.is_nil() || audience != canonical_audience(&audience)? {
            return Err(RuntimeError::InvalidRequest);
        }
        decode(&nonce, 32)?;
        let Binding::Native { public_key, .. } = &record.binding else {
            return Err(RuntimeError::InvalidOrigin);
        };
        let state = self
            .native_connections
            .entry(surface_id)
            .or_insert(NativeState {
                approval_revision: record.revision,
                pending: None,
                connection: None,
                consumed: None,
            });
        if state.approval_revision != record.revision {
            return Err(RuntimeError::Stale);
        }
        if let Some(pending) = state.pending.as_ref().filter(|c| now < c.expires_at_ms) {
            return if pending.audience == audience {
                Ok((pending.clone(), true))
            } else {
                Err(RuntimeError::Stale)
            };
        }
        let challenge = Challenge {
            version: 1,
            audience,
            enrollment_id,
            surface_id,
            approval_revision: record.revision,
            approval: surface_registry::NATIVE_APPROVAL.to_owned(),
            public_key_fingerprint: public_key_fingerprint(public_key)?,
            challenge_id,
            nonce,
            expires_at_ms: now
                .checked_add(CHALLENGE_MS)
                .ok_or(RuntimeError::Unavailable)?,
            current_incarnation: state.connection.as_ref().map(|c| c.incarnation),
        };
        state.pending = Some(challenge.clone());
        Ok((challenge, false))
    }

    pub(super) fn open_native(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        surface_id: Uuid,
        audience: &str,
        request: &OpenRequest,
        incarnation: Uuid,
        now: i64,
    ) -> Result<(ConnectionView, bool), RuntimeError> {
        let record = record(records, surface_id, request.enrollment_id)?;
        if incarnation.is_nil() || audience != canonical_audience(audience)? {
            return Err(RuntimeError::InvalidRequest);
        }
        let Binding::Native { public_key, .. } = &record.binding else {
            return Err(RuntimeError::InvalidOrigin);
        };
        let state = self
            .native_connections
            .get_mut(&surface_id)
            .ok_or(RuntimeError::Stale)?;
        if state.approval_revision != record.revision {
            return Err(RuntimeError::Stale);
        }
        if let Some(consumed) = state
            .consumed
            .as_ref()
            .filter(|c| c.challenge.challenge_id == request.challenge_id)
        {
            if consumed.challenge.audience != audience {
                return Err(RuntimeError::Stale);
            }
            let digest = verify(public_key, &consumed.challenge, request)?;
            let connection = state
                .connection
                .as_ref()
                .filter(|c| c.current(record, now))
                .ok_or(RuntimeError::Stale)?;
            return if consumed.request_digest == digest {
                Ok((connection.view(surface_id), true))
            } else {
                Err(RuntimeError::Stale)
            };
        }
        let challenge = state
            .pending
            .as_ref()
            .filter(|c| {
                c.challenge_id == request.challenge_id
                    && c.audience == audience
                    && c.approval_revision == record.revision
                    && now < c.expires_at_ms
            })
            .ok_or(RuntimeError::Stale)?;
        let digest = verify(public_key, challenge, request)?;
        let previous = state.connection.as_ref();
        if request.expected_incarnation != previous.map(|c| c.incarnation)
            || previous.is_some_and(|c| {
                c.incarnation == incarnation || c.token_hash == request.session_token_hash
            })
        {
            return Err(RuntimeError::Stale);
        }
        let expires_at_ms = now
            .checked_add(surface_registry::CONNECTION_MS)
            .ok_or(RuntimeError::Unavailable)?;
        let connection = NativeConnection {
            approval_revision: record.revision,
            incarnation,
            epoch: request.epoch,
            previous_incarnation: request.expected_incarnation,
            expires_at_ms,
            lease_expires_at_ms: now
                .checked_add(surface_registry::LEASE_MS)
                .ok_or(RuntimeError::Unavailable)?
                .min(expires_at_ms),
            closed: false,
            token_hash: request.session_token_hash.clone(),
        };
        let mut cursor = self
            .ingress
            .get(&surface_id)
            .filter(|cursor| {
                previous.is_some_and(|c| {
                    c.epoch == request.epoch && c.incarnation == cursor.incarnation
                })
            })
            .cloned()
            .unwrap_or(InputCursor {
                incarnation,
                epoch: request.epoch,
                high_water: 0,
                receipts: Vec::new(),
                controls: Vec::new(),
            });
        cursor.incarnation = incarnation;
        self.ingress.insert(surface_id, cursor);
        state.consumed = Some(Consumed {
            challenge: challenge.clone(),
            request_digest: digest,
        });
        state.pending = None;
        state.connection = Some(connection.clone());
        Ok((connection.view(surface_id), false))
    }

    pub(super) fn check_native(
        &self,
        records: &BTreeMap<Uuid, Record>,
        proof: &NativeProof,
        now: i64,
    ) -> Result<ConnectionView, RuntimeError> {
        let record = records
            .get(&proof.surface_id)
            .ok_or(RuntimeError::InvalidOrigin)?;
        let connection = self
            .native_connections
            .get(&proof.surface_id)
            .and_then(|s| s.connection.as_ref())
            .filter(|c| c.current(record, now) && c.incarnation == proof.incarnation)
            .ok_or(RuntimeError::Stale)?;
        let same = super::state::digest_valid(&proof.token_hash)
            && proof.token_hash.len() == connection.token_hash.len()
            && proof
                .token_hash
                .bytes()
                .zip(connection.token_hash.bytes())
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                == 0;
        if !same {
            return Err(RuntimeError::InvalidOrigin);
        }
        Ok(connection.view(proof.surface_id))
    }

    pub(super) fn native_maintenance_ms(&self) -> i64 {
        self.native_connections
            .values()
            .fold(i64::MAX, |due, state| {
                let due = state
                    .pending
                    .as_ref()
                    .map_or(due, |c| due.min(c.expires_at_ms));
                state
                    .connection
                    .as_ref()
                    .filter(|c| !c.closed)
                    .map_or(due, |c| due.min(c.expires_at_ms).min(c.lease_expires_at_ms))
            })
    }

    pub(super) fn reconcile_native(
        &mut self,
        records: &BTreeMap<Uuid, Record>,
        now: i64,
    ) -> Vec<RuntimeData> {
        let mut events = Vec::new();
        self.native_connections.retain(|id, state| {
            let approved = records.get(id).is_some_and(|r| {
                !r.revoked
                    && r.revision == state.approval_revision
                    && matches!(r.binding, Binding::Native { .. })
                    && r.approved_manifest == surface_registry::native_manifest()
            });
            if let Some(connection) = state.connection.as_mut().filter(|c| !c.closed)
                && (!approved
                    || now >= connection.expires_at_ms
                    || now >= connection.lease_expires_at_ms)
            {
                connection.closed = true;
                state.consumed = None;
                events.push(RuntimeData::NativeEpochClosed {
                    surface_id: *id,
                    incarnation: connection.incarnation,
                });
            }
            if state
                .pending
                .as_ref()
                .is_some_and(|c| now >= c.expires_at_ms)
            {
                state.pending = None;
            }
            approved
        });
        events
    }
}
