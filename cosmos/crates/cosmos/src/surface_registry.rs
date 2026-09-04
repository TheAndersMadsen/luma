//! Owner-approved browser surfaces. No dispatch authority is granted here.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const CONNECTION_MS: i64 = 3_600_000;
pub const LEASE_MS: i64 = 45_000;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistryError {
    Unavailable,
    NotFound,
    InvalidConnection,
    SequenceConflict,
    SurfaceLimit,
}

/// Credentials intentionally have no Debug implementation.
pub enum Mutation {
    Approve {
        token_hash: String,
        incarnation: Uuid,
    },
    State {
        token_hash: String,
        incarnation: Uuid,
        sequence: u64,
        visible: bool,
    },
    Leave {
        token_hash: String,
        incarnation: Uuid,
    },
    Revoke,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub approved_manifest: serde_json::Value,
    pub surface_id: Uuid,
    pub revision: u64,
    pub revoked: bool,
    pub visible: bool,
    pub sequence: u64,
    pub incarnation: Uuid,
    pub token_hash: String,
    pub connection_expires_at: i64,
    pub lease_expires_at: i64,
    pub left: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Surface {
    pub surface_id: Uuid,
    pub name: &'static str,
    pub revision: u64,
    pub manifest: serde_json::Value,
    pub trust_level: u8,
    pub occupancy: &'static str,
    pub render_verified: bool,
    pub revoked: bool,
    pub visible: bool,
    pub connected: bool,
    pub available: bool,
    pub sequence: u64,
    pub connection_expires_at: i64,
    pub lease_expires_at: i64,
}

impl Record {
    pub fn view(&self, now: i64) -> Surface {
        let connected = !self.revoked
            && !self.left
            && now < self.connection_expires_at
            && now < self.lease_expires_at;
        Surface {
            surface_id: self.surface_id,
            name: "Browser display",
            revision: self.revision,
            manifest: self.approved_manifest.clone(),
            trust_level: 0,
            occupancy: "unknown",
            render_verified: false,
            revoked: self.revoked,
            visible: self.visible,
            connected,
            available: connected && self.visible,
            sequence: self.sequence,
            connection_expires_at: self.connection_expires_at,
            lease_expires_at: self.lease_expires_at,
        }
    }
}

pub fn browser_manifest() -> serde_json::Value {
    serde_json::json!({
                "class": "browser",
                "capabilities": {"input": ["state.visibility"], "output": {"visual.card": {"maxClass": "shared_room", "shared": true}}},
                "constraints": ["visible_page_only", "no_background_output"],
                "expression": {"visual.card": ["acknowledged", "degraded"]},
                "cognition": {"declaredClass": 0, "models": []},
                "authority": {"mayOriginate": ["state.change"], "reflexive": []}
    })
}

#[derive(Clone, Default)]
pub struct Registry {
    pub records: BTreeMap<Uuid, Record>,
    pub events: Vec<Event>,
}

/// Fixed-order versioned serialization is the canonical hash input. Contains
/// only enrollment metadata, never tokens, token hashes or model/user content.
#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    pub version: u8,
    pub principal: String,
    pub sequence: u64,
    pub previous_hash: String,
    pub kind: String,
    pub surface_id: Uuid,
    pub revision: u64,
    pub receipt_ms: i64,
    pub visible: bool,
    pub approved_manifest: serde_json::Value,
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
impl Event {
    pub fn hash(&self) -> Result<String, RegistryError> {
        serde_json::to_vec(self)
            .map(|bytes| hash(&bytes))
            .map_err(|_| RegistryError::Unavailable)
    }
}

/// Must run while holding the same lock/transaction as the event append.
pub fn transition(
    current: Option<&Record>,
    active_count: usize,
    surface_id: Uuid,
    mutation: &Mutation,
    now: i64,
) -> Result<(Record, Option<&'static str>), RegistryError> {
    if let Mutation::Approve {
        token_hash,
        incarnation,
    } = mutation
    {
        if current.is_none_or(|r| r.revoked) && active_count >= 16 {
            return Err(RegistryError::SurfaceLimit);
        }
        let revision = current.map_or(Ok(1), |r| {
            r.revision.checked_add(1).ok_or(RegistryError::Unavailable)
        })?;
        return Ok((
            Record {
                approved_manifest: browser_manifest(),
                surface_id,
                revision,
                revoked: false,
                visible: false,
                sequence: 0,
                incarnation: *incarnation,
                token_hash: token_hash.clone(),
                connection_expires_at: now + CONNECTION_MS,
                lease_expires_at: now + LEASE_MS,
                left: false,
            },
            Some("surface.approved"),
        ));
    }
    let mut record = current.cloned().ok_or(RegistryError::NotFound)?;
    if matches!(mutation, Mutation::Revoke) {
        if record.revoked {
            return Ok((record, None));
        }
        record.revoked = true;
        record.left = true;
        record.visible = false;
        record.token_hash.clear();
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or(RegistryError::Unavailable)?;
        return Ok((record, Some("surface.revoked")));
    }
    let (token_hash, incarnation) = match mutation {
        Mutation::State {
            token_hash,
            incarnation,
            ..
        }
        | Mutation::Leave {
            token_hash,
            incarnation,
        } => (token_hash, incarnation),
        _ => unreachable!(),
    };
    // Compare digests without an early exit. Both originate as fixed SHA-256 hex.
    let matches = token_hash.len() == record.token_hash.len()
        && token_hash
            .bytes()
            .zip(record.token_hash.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0;
    if !matches
        || *incarnation != record.incarnation
        || record.revoked
        || record.left
        || now >= record.connection_expires_at
    {
        return Err(RegistryError::InvalidConnection);
    }
    let kind = match mutation {
        Mutation::State {
            sequence, visible, ..
        } => {
            if *sequence == 0
                || *sequence > MAX_SEQUENCE
                || *sequence < record.sequence
                || (*sequence == record.sequence && *visible != record.visible)
            {
                return Err(RegistryError::SequenceConflict);
            }
            if *sequence == record.sequence {
                return Ok((record, None));
            }
            record.sequence = *sequence;
            record.visible = *visible;
            record.lease_expires_at = (now + LEASE_MS).min(record.connection_expires_at);
            "surface.state"
        }
        Mutation::Leave { .. } => {
            record.left = true;
            record.visible = false;
            record.token_hash.clear();
            "surface.left"
        }
        _ => unreachable!(),
    };
    record.revision = record
        .revision
        .checked_add(1)
        .ok_or(RegistryError::Unavailable)?;
    Ok((record, Some(kind)))
}

pub fn event(
    principal: &str,
    sequence: u64,
    previous_hash: String,
    kind: &str,
    record: &Record,
    now: i64,
) -> Event {
    Event {
        version: 1,
        principal: principal.to_owned(),
        sequence,
        previous_hash,
        kind: kind.to_owned(),
        surface_id: record.surface_id,
        revision: record.revision,
        receipt_ms: now,
        visible: record.visible,
        approved_manifest: record.approved_manifest.clone(),
    }
}

pub fn now_ms() -> i64 {
    // The existing time dependency handles dates before the epoch without
    // treating clock failure as a fresh credential timestamp.
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval() -> Mutation {
        Mutation::Approve {
            token_hash: hash(b"test-token"),
            incarnation: Uuid::nil(),
        }
    }
    fn state(sequence: u64, visible: bool) -> Mutation {
        Mutation::State {
            token_hash: hash(b"test-token"),
            incarnation: Uuid::nil(),
            sequence,
            visible,
        }
    }

    #[test]
    fn surface_registry_contract_matches_runtime_ceiling_and_limits() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/surface-registry.json"))
                .unwrap();
        assert_eq!(contract["Surface"]["manifest"], browser_manifest());
        assert_eq!(contract["limits"]["connectionLifetimeMs"], CONNECTION_MS);
        assert_eq!(contract["limits"]["livenessLeaseMs"], LEASE_MS);
        assert_eq!(contract["limits"]["activeSurfacesPerOwner"], 16);
        let (record, _) = transition(None, 0, Uuid::new_v4(), &approval(), 100).unwrap();
        assert!(!record.view(101).available);
        assert!(!record.view(101).render_verified);
        assert_eq!(record.view(101).occupancy, "unknown");
        assert_eq!(record.view(101).trust_level, 0);
    }

    #[test]
    fn surface_registry_state_sequence_expiry_and_approval_are_independent() {
        let id = Uuid::new_v4();
        let (mut approved, _) = transition(None, 0, id, &approval(), 100).unwrap();
        // A future template cannot upgrade an already approved record.
        approved.approved_manifest["constraints"] = serde_json::json!([
            "visible_page_only",
            "no_background_output",
            "test_old_ceiling"
        ]);
        let (visible, _) = transition(Some(&approved), 1, id, &state(1, true), 200).unwrap();
        assert_eq!(visible.approved_manifest, approved.approved_manifest);
        assert!(visible.view(201).available);
        let (duplicate, kind) = transition(Some(&visible), 1, id, &state(1, true), 300).unwrap();
        assert!(kind.is_none());
        assert_eq!(duplicate.lease_expires_at, visible.lease_expires_at);
        assert!(matches!(
            transition(Some(&visible), 1, id, &state(1, false), 300),
            Err(RegistryError::SequenceConflict)
        ));
        assert!(matches!(
            transition(Some(&visible), 1, id, &state(0, true), 300),
            Err(RegistryError::SequenceConflict)
        ));
        assert!(!visible.view(visible.lease_expires_at).available);
        let (hidden, _) = transition(Some(&visible), 1, id, &state(2, false), 400).unwrap();
        assert!(!hidden.view(401).available);
        let (visible, _) = transition(Some(&hidden), 1, id, &state(3, true), 500).unwrap();
        assert!(visible.view(501).available);
        assert_eq!(
            visible.connection_expires_at,
            approved.connection_expires_at
        );
        assert!(matches!(
            transition(
                Some(&visible),
                1,
                id,
                &state(4, true),
                visible.connection_expires_at
            ),
            Err(RegistryError::InvalidConnection)
        ));
        let (reapproved, _) = transition(Some(&visible), 1, id, &approval(), 600).unwrap();
        assert_eq!(reapproved.approved_manifest, browser_manifest());
        assert_eq!(reapproved.sequence, 0);
    }

    #[test]
    fn surface_registry_chain_binds_owner_order_and_approved_ceiling_without_credentials() {
        let (record, _) = transition(None, 0, Uuid::new_v4(), &approval(), 100).unwrap();
        let first = event(
            "U:owner",
            1,
            String::new(),
            "surface.approved",
            &record,
            100,
        );
        let second = event(
            "U:owner",
            2,
            first.hash().unwrap(),
            "surface.state",
            &record,
            101,
        );
        assert_eq!(second.previous_hash, first.hash().unwrap());
        let encoded = serde_json::to_string(&first).unwrap();
        assert!(!encoded.contains(&record.token_hash));
        let mut changed = first.clone();
        changed.principal = "U:other".to_owned();
        assert_ne!(first.hash().unwrap(), changed.hash().unwrap());
        changed = first.clone();
        changed.approved_manifest["cognition"]["declaredClass"] = 5.into();
        assert_ne!(first.hash().unwrap(), changed.hash().unwrap());
    }
}
