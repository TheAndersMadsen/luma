//! Owner-approved surfaces. No dispatch authority is granted here.
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
    ApprovePin {
        device_id: String,
    },
    RevokePin,
    ApproveNative {
        enrollment_id: Uuid,
        public_key: String,
        platform: String,
        expected_revision: u64,
    },
    RevokeNative {
        expected_revision: u64,
    },
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

/// Runtime binding, never inferred from a caller's claimed surface identifier.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "profile", rename_all = "snake_case")]
pub enum Binding {
    #[default]
    Browser,
    Pin {
        device_id: String,
    },
    Native {
        enrollment_id: Uuid,
        public_key: String,
        platform: String,
    },
}
impl std::fmt::Debug for Binding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Browser => "Browser",
            Self::Pin { .. } => "Pin([REDACTED])",
            Self::Native { .. } => "Native([REDACTED])",
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub binding: Binding,
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
    #[serde(skip)]
    pub binding: Binding,
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
            binding: self.binding.clone(),
            surface_id: self.surface_id,
            name: match self.binding {
                Binding::Pin { .. } => "Ai Pin",
                Binding::Browser => "Browser display",
                Binding::Native { .. } => "Native device",
            },
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

pub const PIN_APPROVAL: &str = "pin-shared-speech-v1";

pub fn pin_manifest() -> serde_json::Value {
    serde_json::json!({
        "class": "wearable",
        "capabilities": {"input": ["user.request"], "output": {"audio.tts": {"maxClass": "shared_room", "shared": true}}},
        "constraints": ["actor_unknown", "occupancy_unknown", "render_unverified", "playback_unverified", "no_verified_epoch_sequence"],
        "expression": {},
        "cognition": {"declaredClass": 0, "models": []},
        "authority": {"mayOriginate": ["user.request"], "reflexive": []}
    })
}

/// The selection key is account-scoped, not a credential or device boot epoch.
pub fn pin_surface_id(principal: &str, device_id: &str) -> Uuid {
    let digest =
        Sha256::digest(format!("cosmos-pin-surface-v1\0{principal}\0{device_id}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    Uuid::from_bytes(bytes)
}

pub const NATIVE_APPROVAL: &str = "native-shared-text-v1";
pub const MAX_NATIVE_REVISION: u64 = MAX_SEQUENCE;

pub fn native_manifest() -> serde_json::Value {
    serde_json::json!({
        "class": "native",
        "capabilities": {"input": ["text.public"], "output": {}},
        "constraints": ["actor_unknown", "occupancy_unknown", "render_unverified", "playback_unverified"],
        "expression": {},
        "cognition": {"declaredClass": 0, "models": []},
        "authority": {"mayOriginate": ["user.request"], "reflexive": []}
    })
}

pub fn native_platform(platform: &str) -> bool {
    matches!(platform, "macos" | "linux" | "android" | "android_tv")
}

/// The descriptor locator selects a surface; it is never authentication.
pub fn native_surface_id(principal: &str, enrollment_id: Uuid) -> Uuid {
    let digest = Sha256::digest(
        format!("cosmos-native-surface-v1\0{principal}\0{enrollment_id}").as_bytes(),
    );
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    Uuid::from_bytes(bytes)
}

#[derive(Clone)]
pub struct NativeLocation {
    pub principal: String,
    pub surface_id: Uuid,
}

/// Owner-only enrollment metadata grants no connection or actor authority.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSurface {
    pub surface_id: Uuid,
    pub enrollment_id: Uuid,
    pub platform: String,
    pub name: &'static str,
    pub approval: &'static str,
    pub revision: u64,
    pub public_key_fingerprint: String,
    pub manifest: serde_json::Value,
    pub trust_level: u8,
    pub occupancy: &'static str,
    pub actor_identity: &'static str,
    pub render_verified: bool,
    pub playback_verified: bool,
    pub revoked: bool,
}

impl Surface {
    pub fn native_view(&self) -> Result<NativeSurface, RegistryError> {
        let Binding::Native {
            enrollment_id,
            public_key,
            platform,
        } = &self.binding
        else {
            return Err(RegistryError::NotFound);
        };
        let public_key_fingerprint =
            crate::ambiance::native_connection::public_key_fingerprint(public_key)
                .map_err(|_| RegistryError::Unavailable)?;
        Ok(NativeSurface {
            surface_id: self.surface_id,
            enrollment_id: *enrollment_id,
            platform: platform.clone(),
            name: "Native device",
            approval: NATIVE_APPROVAL,
            revision: self.revision,
            public_key_fingerprint,
            manifest: self.manifest.clone(),
            trust_level: 0,
            occupancy: "unknown",
            actor_identity: "unknown",
            render_verified: false,
            playback_verified: false,
            revoked: self.revoked,
        })
    }
}

/// Available only through verified owner management; never model context.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinSurface {
    pub current_paired: Option<bool>,
    pub surface_id: Uuid,
    pub device_id: String,
    pub name: &'static str,
    pub approval: &'static str,
    pub revision: u64,
    pub manifest: serde_json::Value,
    pub trust_level: u8,
    pub occupancy: &'static str,
    pub actor_identity: &'static str,
    pub render_verified: bool,
    pub playback_verified: bool,
    pub revoked: bool,
}
impl Surface {
    pub fn pin_view(&self, current_paired: Option<bool>) -> Result<PinSurface, RegistryError> {
        let Binding::Pin { device_id } = &self.binding else {
            return Err(RegistryError::NotFound);
        };
        Ok(PinSurface {
            current_paired,
            surface_id: self.surface_id,
            device_id: device_id.clone(),
            name: "Ai Pin",
            approval: PIN_APPROVAL,
            revision: self.revision,
            manifest: self.manifest.clone(),
            trust_level: 0,
            occupancy: "unknown",
            actor_identity: "unknown",
            render_verified: false,
            playback_verified: false,
            revoked: self.revoked,
        })
    }
}

pub const BROWSER_APPROVAL: &str = "browser-shared-display-v2";

/// Persisted v1 approvals remain output-only until explicit reapproval.
pub fn legacy_browser_manifest() -> serde_json::Value {
    serde_json::json!({
                "class": "browser",
                "capabilities": {"input": ["state.visibility"], "output": {"visual.card": {"maxClass": "shared_room", "shared": true}}},
                "constraints": ["visible_page_only", "no_background_output"],
                "expression": {"visual.card": ["acknowledged", "degraded"]},
                "cognition": {"declaredClass": 0, "models": []},
                "authority": {"mayOriginate": ["state.change"], "reflexive": []}
    })
}

pub fn browser_manifest() -> serde_json::Value {
    let mut manifest = legacy_browser_manifest();
    manifest["capabilities"]["input"] = serde_json::json!(["state.visibility", "text.public"]);
    manifest["authority"]["mayOriginate"] = serde_json::json!(["state.change", "user.request"]);
    manifest
}

pub fn known_browser_manifest(manifest: &serde_json::Value) -> bool {
    *manifest == browser_manifest() || *manifest == legacy_browser_manifest()
}

#[derive(Clone, Default)]
pub struct Registry {
    pub records: BTreeMap<Uuid, Record>,
    pub events: Vec<crate::ambiance::ledger::LedgerEvent>,
    pub runtime: crate::ambiance::RuntimeState,
    pub maintenance_ms: i64,
}

/// Registry and due-time index share the same in-memory commit lock.
#[derive(Default)]
pub struct RegistryBook {
    records: std::collections::HashMap<String, Registry>,
    native_locations: std::collections::HashMap<Uuid, NativeLocation>,
    pub due: std::collections::BTreeSet<(i64, String)>,
}
impl RegistryBook {
    pub(crate) fn native_location(&self, enrollment_id: Uuid) -> Option<NativeLocation> {
        self.native_locations.get(&enrollment_id).cloned()
    }

    pub(crate) fn validate_native_location(
        &self,
        principal: &str,
        enrollment_id: Uuid,
        surface_id: Uuid,
    ) -> Result<(), RegistryError> {
        if self
            .native_locations
            .get(&enrollment_id)
            .is_some_and(|location| {
                location.principal != principal || location.surface_id != surface_id
            })
        {
            return Err(RegistryError::SequenceConflict);
        }
        Ok(())
    }

    pub fn publish(&mut self, principal: String, registry: Registry) {
        for record in registry.records.values() {
            if let Binding::Native { enrollment_id, .. } = record.binding {
                self.native_locations.insert(
                    enrollment_id,
                    NativeLocation {
                        principal: principal.clone(),
                        surface_id: record.surface_id,
                    },
                );
            }
        }
        if let Some(previous) = self.records.get(&principal) {
            self.due
                .remove(&(previous.maintenance_ms, principal.clone()));
        }
        if registry.maintenance_ms != i64::MAX {
            self.due
                .insert((registry.maintenance_ms, principal.clone()));
        }
        self.records.insert(principal, registry);
    }
}
impl std::ops::Deref for RegistryBook {
    type Target = std::collections::HashMap<String, Registry>;
    fn deref(&self) -> &Self::Target {
        &self.records
    }
}
#[cfg(test)]
impl std::ops::DerefMut for RegistryBook {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.records
    }
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
    /// Absent on v1 events, preserving their exact canonical hash bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_digest: Option<String>,
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
    if let Mutation::ApproveNative {
        enrollment_id,
        public_key,
        platform,
        expected_revision,
    } = mutation
    {
        if enrollment_id.is_nil()
            || *expected_revision >= MAX_NATIVE_REVISION
            || !native_platform(platform)
            || crate::ambiance::native_connection::validate_public_key(public_key).is_err()
        {
            return Err(RegistryError::InvalidConnection);
        }
        if let Some(record) = current {
            let Binding::Native {
                enrollment_id: existing_id,
                public_key: existing_key,
                platform: existing_platform,
            } = &record.binding
            else {
                return Err(RegistryError::NotFound);
            };
            if existing_id != enrollment_id
                || existing_key != public_key
                || existing_platform != platform
            {
                return Err(RegistryError::InvalidConnection);
            }
            if !record.revoked {
                return if *expected_revision == record.revision
                    || record.revision.checked_sub(1) == Some(*expected_revision)
                {
                    Ok((record.clone(), None))
                } else {
                    Err(RegistryError::SequenceConflict)
                };
            }
        }
        if *expected_revision != current.map_or(0, |record| record.revision) {
            return Err(RegistryError::SequenceConflict);
        }
        if active_count >= 16 {
            return Err(RegistryError::SurfaceLimit);
        }
        return Ok((
            Record {
                binding: Binding::Native {
                    enrollment_id: *enrollment_id,
                    public_key: public_key.clone(),
                    platform: platform.clone(),
                },
                approved_manifest: native_manifest(),
                surface_id,
                revision: expected_revision
                    .checked_add(1)
                    .ok_or(RegistryError::Unavailable)?,
                revoked: false,
                visible: false,
                sequence: 0,
                incarnation: Uuid::nil(),
                token_hash: String::new(),
                connection_expires_at: 0,
                lease_expires_at: 0,
                left: true,
            },
            Some("surface.approved"),
        ));
    }
    if let Mutation::ApprovePin { device_id } = mutation {
        if current.is_some_and(|r| !matches!(r.binding, Binding::Pin { .. })) {
            return Err(RegistryError::NotFound);
        }
        if current.is_none_or(|r| r.revoked) && active_count >= 16 {
            return Err(RegistryError::SurfaceLimit);
        }
        return Ok((
            Record {
                binding: Binding::Pin {
                    device_id: device_id.clone(),
                },
                approved_manifest: pin_manifest(),
                surface_id,
                revision: current.map_or(Ok(1), |r| {
                    r.revision.checked_add(1).ok_or(RegistryError::Unavailable)
                })?,
                revoked: false,
                visible: false,
                sequence: 0,
                incarnation: Uuid::nil(),
                token_hash: String::new(),
                connection_expires_at: 0,
                lease_expires_at: 0,
                left: true,
            },
            Some("surface.approved"),
        ));
    }
    if let Mutation::Approve {
        token_hash,
        incarnation,
    } = mutation
    {
        if current.is_some_and(|r| !matches!(r.binding, Binding::Browser)) {
            return Err(RegistryError::NotFound);
        }
        if current.is_none_or(|r| r.revoked) && active_count >= 16 {
            return Err(RegistryError::SurfaceLimit);
        }
        let revision = current.map_or(Ok(1), |r| {
            r.revision.checked_add(1).ok_or(RegistryError::Unavailable)
        })?;
        return Ok((
            Record {
                binding: Binding::Browser,
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
    if matches!(
        mutation,
        Mutation::Revoke | Mutation::RevokePin | Mutation::RevokeNative { .. }
    ) {
        if !matches!(
            (mutation, &record.binding),
            (Mutation::Revoke, Binding::Browser)
                | (Mutation::RevokePin, Binding::Pin { .. })
                | (Mutation::RevokeNative { .. }, Binding::Native { .. })
        ) {
            return Err(RegistryError::NotFound);
        }
        if let Mutation::RevokeNative { expected_revision } = mutation {
            if *expected_revision >= MAX_NATIVE_REVISION {
                return Err(RegistryError::InvalidConnection);
            }
            if record.revoked {
                return if record.revision.checked_sub(1) == Some(*expected_revision) {
                    Ok((record, None))
                } else {
                    Err(RegistryError::SequenceConflict)
                };
            }
            if *expected_revision != record.revision {
                return Err(RegistryError::SequenceConflict);
            }
        }
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
    if !matches!(record.binding, Binding::Browser) {
        return Err(RegistryError::InvalidConnection);
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
        version: match record.binding {
            Binding::Browser => 1,
            Binding::Pin { .. } | Binding::Native { .. } => 2,
        },
        principal: principal.to_owned(),
        sequence,
        previous_hash,
        kind: kind.to_owned(),
        surface_id: record.surface_id,
        revision: record.revision,
        receipt_ms: now,
        visible: record.visible,
        approved_manifest: record.approved_manifest.clone(),
        binding_digest: match &record.binding {
            Binding::Browser => None,
            Binding::Pin { device_id } => Some(hash(
                format!("pin-device-v1\0{principal}\0{device_id}").as_bytes(),
            )),
            Binding::Native {
                enrollment_id,
                public_key,
                platform,
            } => Some(hash(
                format!("native-device-v1\0{principal}\0{enrollment_id}\0{public_key}\0{platform}")
                    .as_bytes(),
            )),
        },
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

    const NATIVE_KEY: &str =
        "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
    const OTHER_NATIVE_KEY: &str =
        "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWsBy9HAHlgGVxGBS1g_Bh6dQxzKmUzqExNEm_l8hArgo";

    fn native_approval(enrollment_id: Uuid, expected_revision: u64) -> Mutation {
        Mutation::ApproveNative {
            enrollment_id,
            public_key: NATIVE_KEY.into(),
            platform: "macos".into(),
            expected_revision,
        }
    }

    #[test]
    fn native_registry_approval_retries_and_revocation_fence_delayed_requests() {
        let enrollment = Uuid::new_v4();
        let id = native_surface_id("U:owner", enrollment);
        assert_ne!(id, native_surface_id("U:other", enrollment));
        let (approved, kind) =
            transition(None, 0, id, &native_approval(enrollment, 0), 100).unwrap();
        assert_eq!(kind, Some("surface.approved"));
        assert_eq!(approved.revision, 1);
        assert_eq!(approved.approved_manifest, native_manifest());
        for revision in [0, 1] {
            let (retry, kind) = transition(
                Some(&approved),
                16,
                id,
                &native_approval(enrollment, revision),
                200,
            )
            .unwrap();
            assert!(kind.is_none());
            assert_eq!(
                serde_json::to_value(retry).unwrap(),
                serde_json::to_value(&approved).unwrap()
            );
        }
        assert!(matches!(
            transition(
                Some(&approved),
                1,
                id,
                &Mutation::RevokeNative {
                    expected_revision: 0
                },
                300
            ),
            Err(RegistryError::SequenceConflict)
        ));
        let revoke = Mutation::RevokeNative {
            expected_revision: 1,
        };
        let (revoked, kind) = transition(Some(&approved), 1, id, &revoke, 300).unwrap();
        assert_eq!(kind, Some("surface.revoked"));
        assert_eq!(revoked.revision, 2);
        assert!(revoked.revoked);
        assert!(
            transition(Some(&revoked), 0, id, &revoke, 400)
                .unwrap()
                .1
                .is_none()
        );
        for revision in [0, 1] {
            assert!(matches!(
                transition(
                    Some(&revoked),
                    0,
                    id,
                    &native_approval(enrollment, revision),
                    400
                ),
                Err(RegistryError::SequenceConflict)
            ));
        }
        let (reapproved, _) =
            transition(Some(&revoked), 0, id, &native_approval(enrollment, 2), 500).unwrap();
        assert_eq!(reapproved.revision, 3);
        assert!(!reapproved.revoked);
        assert!(matches!(
            transition(Some(&reapproved), 1, id, &revoke, 600),
            Err(RegistryError::SequenceConflict)
        ));
        assert!(matches!(
            transition(
                Some(&reapproved),
                1,
                id,
                &native_approval(enrollment, 0),
                600
            ),
            Err(RegistryError::SequenceConflict)
        ));
        let projection = serde_json::to_value(reapproved.view(600).native_view().unwrap()).unwrap();
        assert_eq!(projection["trustLevel"], 0);
        assert_eq!(projection["occupancy"], "unknown");
        assert_eq!(projection["actorIdentity"], "unknown");
        assert_eq!(projection["renderVerified"], false);
        assert_eq!(projection["playbackVerified"], false);
        assert_eq!(
            projection["manifest"]["capabilities"]["output"],
            serde_json::json!({})
        );
        assert!(projection.get("publicKey").is_none());
        assert!(!reapproved.view(600).available);
    }

    #[test]
    fn native_registry_immutable_descriptor_profile_boundaries_and_cap() {
        let enrollment = Uuid::new_v4();
        let id = native_surface_id("U:owner", enrollment);
        let approve = native_approval(enrollment, 0);
        let (native, _) = transition(None, 0, id, &approve, 100).unwrap();
        let (revoked, _) = transition(
            Some(&native),
            1,
            id,
            &Mutation::RevokeNative {
                expected_revision: 1,
            },
            200,
        )
        .unwrap();
        for current in [&native, &revoked] {
            for (enrollment_id, public_key, platform) in [
                (Uuid::new_v4(), NATIVE_KEY, "macos"),
                (enrollment, OTHER_NATIVE_KEY, "macos"),
                (enrollment, NATIVE_KEY, "linux"),
            ] {
                assert!(matches!(
                    transition(
                        Some(current),
                        0,
                        id,
                        &Mutation::ApproveNative {
                            enrollment_id,
                            public_key: public_key.into(),
                            platform: platform.into(),
                            expected_revision: current.revision,
                        },
                        300
                    ),
                    Err(RegistryError::InvalidConnection)
                ));
            }
            for mutation in [Mutation::Revoke, Mutation::RevokePin, approval()] {
                assert!(matches!(
                    transition(Some(current), 1, id, &mutation, 300),
                    Err(RegistryError::NotFound)
                ));
            }
            assert!(matches!(
                transition(Some(current), 1, id, &state(1, true), 300),
                Err(RegistryError::InvalidConnection)
            ));
        }
        for platform in ["macos", "linux", "android", "android_tv"] {
            assert!(
                transition(
                    None,
                    0,
                    id,
                    &Mutation::ApproveNative {
                        enrollment_id: enrollment,
                        public_key: NATIVE_KEY.into(),
                        platform: platform.into(),
                        expected_revision: 0,
                    },
                    100
                )
                .is_ok()
            );
        }
        assert!(matches!(
            transition(None, 16, id, &approve, 100),
            Err(RegistryError::SurfaceLimit)
        ));
        assert!(matches!(
            transition(Some(&revoked), 16, id, &native_approval(enrollment, 2), 300),
            Err(RegistryError::SurfaceLimit)
        ));
        assert!(matches!(
            transition(None, 0, id, &native_approval(Uuid::nil(), 0), 100),
            Err(RegistryError::InvalidConnection)
        ));
        assert!(matches!(
            transition(
                Some(&native),
                1,
                id,
                &native_approval(enrollment, MAX_NATIVE_REVISION),
                300
            ),
            Err(RegistryError::InvalidConnection)
        ));
        assert!(matches!(
            transition(
                Some(&native),
                1,
                id,
                &Mutation::RevokeNative {
                    expected_revision: MAX_NATIVE_REVISION
                },
                300
            ),
            Err(RegistryError::InvalidConnection)
        ));
        let (browser, _) = transition(None, 0, id, &approval(), 100).unwrap();
        assert!(matches!(
            transition(Some(&browser), 1, id, &approve, 200),
            Err(RegistryError::NotFound)
        ));
        assert!(matches!(
            transition(
                Some(&browser),
                1,
                id,
                &Mutation::RevokeNative {
                    expected_revision: 1
                },
                200
            ),
            Err(RegistryError::NotFound)
        ));
        let entry = event(
            "U:owner",
            1,
            String::new(),
            "surface.approved",
            &native,
            100,
        );
        assert_eq!(entry.version, 2);
        assert!(!serde_json::to_string(&entry).unwrap().contains(NATIVE_KEY));
        assert_ne!(
            entry.binding_digest,
            event(
                "U:other",
                1,
                String::new(),
                "surface.approved",
                &native,
                100
            )
            .binding_digest
        );
    }

    #[test]
    fn native_registry_locator_claim_survives_revocation() {
        let enrollment = Uuid::new_v4();
        let id = native_surface_id("U:owner", enrollment);
        let (native, _) = transition(None, 0, id, &native_approval(enrollment, 0), 100).unwrap();
        let (revoked, _) = transition(
            Some(&native),
            1,
            id,
            &Mutation::RevokeNative {
                expected_revision: 1,
            },
            200,
        )
        .unwrap();
        let mut book = RegistryBook::default();
        book.validate_native_location("U:owner", enrollment, id)
            .unwrap();
        book.publish(
            "U:owner".into(),
            Registry {
                records: [(id, revoked)].into(),
                ..Registry::default()
            },
        );
        let located = book.native_location(enrollment).unwrap();
        assert_eq!(located.principal, "U:owner");
        assert_eq!(located.surface_id, id);
        assert!(
            book.validate_native_location("U:owner", enrollment, id)
                .is_ok()
        );
        assert!(matches!(
            book.validate_native_location("U:other", enrollment, id),
            Err(RegistryError::SequenceConflict)
        ));
        assert!(matches!(
            book.validate_native_location("U:owner", enrollment, Uuid::new_v4()),
            Err(RegistryError::SequenceConflict)
        ));
    }

    #[test]
    fn pin_admission_manifest_binding_and_v1_chain_are_fixed() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/pin-surface.json")).unwrap();
        assert_eq!(contract["PinSurface"]["manifest"], pin_manifest());
        let id = pin_surface_id("U:owner", "aabb");
        let (pin, _) = transition(
            None,
            0,
            id,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap();
        assert_eq!(
            pin.view(100).pin_view(Some(true)).unwrap().actor_identity,
            "unknown"
        );
        assert!(!pin.view(100).available);
        assert!(transition(Some(&pin), 1, id, &approval(), 101).is_err());
        assert!(transition(Some(&pin), 1, id, &state(1, true), 101).is_err());
        let entry = event("U:owner", 1, String::new(), "surface.approved", &pin, 100);
        assert_eq!(entry.version, 2);
        assert!(!serde_json::to_string(&entry).unwrap().contains("aabb"));
        let other = event("U:other", 1, String::new(), "surface.approved", &pin, 100);
        assert_ne!(entry.binding_digest, other.binding_digest);
        let (browser, _) = transition(None, 0, Uuid::nil(), &approval(), 100).unwrap();
        let v1 = event(
            "U:owner",
            1,
            String::new(),
            "surface.approved",
            &browser,
            100,
        );
        let encoded = serde_json::to_string(&v1).unwrap();
        assert!(!encoded.contains("binding_digest"));
        let legacy = format!(
            "{{\"version\":1,\"principal\":\"U:owner\",\"sequence\":1,\"previous_hash\":\"\",\"kind\":\"surface.approved\",\"surface_id\":\"{}\",\"revision\":1,\"receipt_ms\":100,\"visible\":false,\"approved_manifest\":{}}}",
            Uuid::nil(),
            browser_manifest()
        );
        assert_eq!(v1.hash().unwrap(), hash(legacy.as_bytes()));
        let recovered: Event = serde_json::from_str(&legacy).unwrap();
        assert_eq!(recovered.hash().unwrap(), v1.hash().unwrap());
    }

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
