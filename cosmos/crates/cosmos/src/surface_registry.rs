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

pub const NATIVE_APPROVAL: &str = "native-audience-v6";
pub const NATIVE_LINUX_APPROVAL: &str = "native-linux-tasks-v7";

pub fn current_native_approval(platform: &str) -> &'static str {
    if platform == "linux" {
        NATIVE_LINUX_APPROVAL
    } else {
        NATIVE_APPROVAL
    }
}
pub const LEGACY_NATIVE_VOICE_APPROVAL: &str = "native-voice-input-v5";
pub const LEGACY_NATIVE_ACTION_APPROVAL: &str = "native-device-action-v4";
pub const LEGACY_NATIVE_SPEECH_APPROVAL: &str = "native-shared-speech-v3";
pub const LEGACY_NATIVE_DISPLAY_APPROVAL: &str = "native-shared-display-v2";
pub const MAX_NATIVE_REVISION: u64 = MAX_SEQUENCE;
pub const NATIVE_PLATFORMS: [&str; 4] = ["macos", "linux", "android", "android_tv"];
/// The one input channel that opens a microphone. It is an input declaration,
/// so it carries no class of its own: what a spoken request may be admitted at
/// is the owner's `approve-native-voice-v1` floor for that installation,
/// itself capped by the installation's own personal declaration.
pub const NATIVE_VOICE_INPUT: &str = "voice.push_to_talk";

/// Persisted display-only approvals keep rendering shared cards until the
/// owner reapproves them. Older text-only records are unknown.
pub fn legacy_native_display_manifest() -> serde_json::Value {
    serde_json::json!({
        "class": "native",
        "capabilities": {"input": ["text.public", "state.visibility"], "output": {"visual.card": {"maxClass": "shared_room", "shared": true}}},
        "constraints": ["actor_unknown", "occupancy_unknown", "render_unverified", "playback_unverified", "visible_foreground_only", "no_background_output"],
        "expression": {"visual.card": ["acknowledged", "degraded"]},
        "cognition": {"declaredClass": 0, "models": []},
        "authority": {"mayOriginate": ["state.change", "user.request"], "reflexive": []}
    })
}

/// Persisted speech approvals keep rendering cards and speaking, on every
/// platform, and declare no action channel until the owner reapproves.
pub fn legacy_native_speech_manifest() -> serde_json::Value {
    let mut manifest = legacy_native_display_manifest();
    manifest["capabilities"]["output"]["audio.tts"] =
        serde_json::json!({"maxClass": "shared_room", "shared": true});
    manifest["expression"]["audio.tts"] = serde_json::json!(["acknowledged", "degraded"]);
    manifest
}

/// Persisted action approvals keep connecting, rendering, speaking and
/// carrying out what the owner allowed, and declare no microphone until the
/// owner reapproves at the current profile.
///
/// The action profile is per platform, because what a device may be asked to
/// do differs by what its operating system can honestly report. The set of
/// legal manifests stays closed and enumerated, and the owner reads the exact
/// capability list in Center before approving.
///
/// `maxClass: "shared_room"` and `shared: true` are physical output ceilings.
/// An owner's private-display preference cannot raise them or establish room
/// occupancy; private outputs require separately verified current evidence.
/// `effect_unverified` and `no_effect_isolation` are honesty fields: a client
/// cannot prove an effect it did not observe, and neither desktop client can
/// sandbox what it launches.
pub fn legacy_native_action_manifest(platform: &str) -> serde_json::Value {
    let card = serde_json::json!({"maxClass": "shared_room", "shared": true});
    let acknowledged = serde_json::json!(["acknowledged", "degraded"]);
    let mut output = serde_json::json!({"visual.card": card, "audio.tts": card});
    let mut expression =
        serde_json::json!({"visual.card": acknowledged, "audio.tts": acknowledged});
    let mut input = serde_json::json!(["text.public", "state.visibility", "action.report"]);
    let mut constraints = vec![
        "actor_unknown",
        "occupancy_unknown",
        "render_unverified",
        "playback_unverified",
        "visible_foreground_only",
        "no_background_output",
        "effect_unverified",
    ];
    let open = serde_json::json!({"maxClass": "shared_room", "shared": true, "risk": "low", "idempotent": true, "reportBudgetMs": 10000});
    match platform {
        "macos" | "linux" => {
            input = serde_json::json!([
                "text.public",
                "state.visibility",
                "context.screen",
                "action.report"
            ]);
            constraints.push("no_effect_isolation");
            output["action.open"] = open;
            expression["action.open"] = acknowledged.clone();
            let attestation = if platform == "macos" {
                output["action.run"] = serde_json::json!({"maxClass": "shared_room", "shared": true, "risk": "high", "idempotent": false, "reportBudgetMs": 900000});
                expression["action.run"] =
                    serde_json::json!(["thinking", "acknowledged", "degraded"]);
                serde_json::json!(["foreground_tap", "device_owner_auth"])
            } else {
                serde_json::json!(["foreground_tap"])
            };
            output["confirm.tap"] = serde_json::json!({"maxClass": "shared_room", "shared": true, "attestation": attestation});
            expression["confirm.tap"] = serde_json::json!(["confirming", "awaiting_permission"]);
        }
        "android" => {
            input = serde_json::json!([
                "text.public",
                "state.visibility",
                "context.screen",
                "action.report"
            ]);
            constraints.push("foreground_or_assistant_session_only");
            output["action.open"] = open;
            output["action.route"] = serde_json::json!({"maxClass": "shared_room", "shared": true, "risk": "low", "idempotent": true, "reportBudgetMs": 20000});
            output["confirm.tap"] = serde_json::json!({"maxClass": "shared_room", "shared": true, "attestation": ["foreground_tap"]});
            expression["action.open"] = acknowledged.clone();
            expression["action.route"] = acknowledged.clone();
            expression["confirm.tap"] = serde_json::json!(["confirming", "awaiting_permission"]);
        }
        // A television is bystander-perceivable by construction, so it is
        // never a ceremony venue and never holds a personal declaration.
        _ => {
            output["action.play"] = serde_json::json!({"maxClass": "shared_room", "shared": true, "risk": "low", "idempotent": true, "reportBudgetMs": 30000});
            expression["action.play"] = acknowledged.clone();
        }
    }
    serde_json::json!({
        "class": "native",
        "capabilities": {"input": input, "output": output},
        "constraints": constraints,
        "expression": expression,
        "cognition": {"declaredClass": 0, "models": []},
        "authority": {"mayOriginate": ["state.change", "user.request", "action.report"], "reflexive": []}
    })
}

/// Every platform Cosmos publishes a manifest for has a microphone, so the
/// current profile is the action profile plus one push-to-talk input channel
/// and the three honesty constraints that bound it. The runtime never asks a
/// client to listen: there is no command that opens a microphone, capture
/// starts only at the person's own press, and the client must show it while
/// it holds one open. None of that is verifiable server-side, which is
/// exactly why it is declared here and attested per capture.
pub fn legacy_native_voice_manifest(platform: &str) -> serde_json::Value {
    let mut manifest = legacy_native_action_manifest(platform);
    let Some(input) = manifest["capabilities"]["input"].as_array_mut() else {
        return manifest;
    };
    input.push(serde_json::json!(NATIVE_VOICE_INPUT));
    let Some(constraints) = manifest["constraints"].as_array_mut() else {
        return manifest;
    };
    constraints.extend([
        serde_json::json!("push_to_talk_only"),
        serde_json::json!("no_background_capture"),
        serde_json::json!("capture_indicator_required"),
    ]);
    manifest
}

/// Which audience each published profile declares. Choosing it per platform
/// is the publisher's job and the owner's approval; the router never reads
/// it. What the router reads is the `audience` word inside the manifest the
/// owner approved, which is why a hypothetical new platform shipping the
/// room profile routes exactly like the television.
fn published_audience(platform: &str) -> &'static str {
    match platform {
        // A television is output the whole room receives.
        "android_tv" => "room",
        // A phone travels on the person who is holding it.
        "android" => "handheld",
        // A laptop or a desktop is a screen someone is sitting at.
        _ => "desk",
    }
}

/// The current profile: the voice profile plus one `audience` word on every
/// output channel. It is the manifest dimension §4.1 says content-shape
/// matching consumes, and until an installation is reapproved at this
/// profile the runtime does not know what kind of screen it is and scores it
/// at the floor of whatever shape is being routed.
pub fn legacy_native_audience_manifest(platform: &str) -> serde_json::Value {
    let mut manifest = legacy_native_voice_manifest(platform);
    let audience = serde_json::json!(published_audience(platform));
    let Some(output) = manifest["capabilities"]["output"].as_object_mut() else {
        return manifest;
    };
    for channel in output.values_mut() {
        let Some(channel) = channel.as_object_mut() else {
            continue;
        };
        channel.insert("audience".into(), audience.clone());
    }
    manifest
}

/// Linux adds only tasks its local confirmation can authorize. Existing
/// audience approvals remain byte-identical and acquire no command channel.
pub fn native_manifest(platform: &str) -> serde_json::Value {
    let mut manifest = legacy_native_audience_manifest(platform);
    if platform == "linux" {
        manifest["capabilities"]["output"]["action.run"] = serde_json::json!({
            "maxClass": "shared_room", "shared": true, "risk": "moderate",
            "idempotent": false, "reportBudgetMs": 900000, "audience": "desk"
        });
        manifest["expression"]["action.run"] =
            serde_json::json!(["thinking", "acknowledged", "degraded"]);
    }
    manifest
}

/// The audience this installation's approved manifest declares for one
/// output channel, or `None` when the profile predates the declaration. The
/// manifest is one of the enumerated published values, so reading a word out
/// of it is the same closed check the byte equality is.
pub fn native_audience<'a>(record: &'a Record, channel: &str) -> Option<&'a str> {
    if !known_native_manifest(record) {
        return None;
    }
    record.approved_manifest["capabilities"]["output"][channel]["audience"].as_str()
}

/// The approval profile this record's manifest byte-equals for its own
/// platform, or `None` when the manifest is not one Cosmos published. Binding
/// to the record's own platform is what keeps the set closed: an Android
/// manifest on a Mac record is unknown, not "some known manifest".
pub fn native_approval(record: &Record) -> Option<&'static str> {
    let Binding::Native { platform, .. } = &record.binding else {
        return None;
    };
    if !native_platform(platform) {
        return None;
    }
    if record.approved_manifest == native_manifest(platform) {
        Some(current_native_approval(platform))
    } else if record.approved_manifest == legacy_native_audience_manifest(platform) {
        Some(NATIVE_APPROVAL)
    } else if record.approved_manifest == legacy_native_voice_manifest(platform) {
        Some(LEGACY_NATIVE_VOICE_APPROVAL)
    } else if record.approved_manifest == legacy_native_action_manifest(platform) {
        Some(LEGACY_NATIVE_ACTION_APPROVAL)
    } else if record.approved_manifest == legacy_native_speech_manifest() {
        Some(LEGACY_NATIVE_SPEECH_APPROVAL)
    } else if record.approved_manifest == legacy_native_display_manifest() {
        Some(LEGACY_NATIVE_DISPLAY_APPROVAL)
    } else {
        None
    }
}

pub fn known_native_manifest(record: &Record) -> bool {
    native_approval(record).is_some()
}

pub fn known_native_approval(approval: &str) -> bool {
    matches!(
        approval,
        NATIVE_APPROVAL
            | NATIVE_LINUX_APPROVAL
            | LEGACY_NATIVE_VOICE_APPROVAL
            | LEGACY_NATIVE_ACTION_APPROVAL
            | LEGACY_NATIVE_SPEECH_APPROVAL
            | LEGACY_NATIVE_DISPLAY_APPROVAL
    )
}

/// Whether this installation's approved manifest declares one input channel.
/// A legacy profile declares no microphone, so an installation the owner has
/// not reapproved at the current profile cannot be spoken to at all.
pub fn native_declares_input(record: &Record, channel: &str) -> bool {
    known_native_manifest(record)
        && record.approved_manifest["capabilities"]["input"]
            .as_array()
            .is_some_and(|declared| declared.iter().any(|value| value == channel))
}

/// Whether this installation's approved manifest declares one output channel.
/// The manifest is one of the enumerated published values, so reading the
/// declaration out of it is the same closed check the byte equality is.
pub fn native_declares(record: &Record, channel: &str) -> bool {
    known_native_manifest(record)
        && record.approved_manifest["capabilities"]["output"][channel].is_object()
}

pub fn native_platform(platform: &str) -> bool {
    NATIVE_PLATFORMS.contains(&platform)
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
            approval: if self.manifest == native_manifest(platform) {
                current_native_approval(platform)
            } else if self.manifest == legacy_native_audience_manifest(platform) {
                NATIVE_APPROVAL
            } else if self.manifest == legacy_native_voice_manifest(platform) {
                LEGACY_NATIVE_VOICE_APPROVAL
            } else if self.manifest == legacy_native_action_manifest(platform) {
                LEGACY_NATIVE_ACTION_APPROVAL
            } else if self.manifest == legacy_native_speech_manifest() {
                LEGACY_NATIVE_SPEECH_APPROVAL
            } else {
                LEGACY_NATIVE_DISPLAY_APPROVAL
            },
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
            // Reapproving a persisted earlier profile is a real transition to
            // the current action profile; a current profile is idempotent.
            if !record.revoked && record.approved_manifest == native_manifest(platform) {
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
        if current.is_none_or(|record| record.revoked) && active_count >= 16 {
            return Err(RegistryError::SurfaceLimit);
        }
        return Ok((
            Record {
                binding: Binding::Native {
                    enrollment_id: *enrollment_id,
                    public_key: public_key.clone(),
                    platform: platform.clone(),
                },
                approved_manifest: native_manifest(platform),
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

    fn native_mutation(enrollment_id: Uuid, expected_revision: u64) -> Mutation {
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
            transition(None, 0, id, &native_mutation(enrollment, 0), 100).unwrap();
        assert_eq!(kind, Some("surface.approved"));
        assert_eq!(approved.revision, 1);
        assert_eq!(approved.approved_manifest, native_manifest("macos"));
        for revision in [0, 1] {
            let (retry, kind) = transition(
                Some(&approved),
                16,
                id,
                &native_mutation(enrollment, revision),
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
                    &native_mutation(enrollment, revision),
                    400
                ),
                Err(RegistryError::SequenceConflict)
            ));
        }
        let (reapproved, _) =
            transition(Some(&revoked), 0, id, &native_mutation(enrollment, 2), 500).unwrap();
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
                &native_mutation(enrollment, 0),
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
        assert_eq!(projection["approval"], NATIVE_APPROVAL);
        assert_eq!(
            projection["manifest"]["capabilities"]["output"],
            native_manifest("macos")["capabilities"]["output"]
        );
        assert!(projection.get("publicKey").is_none());
        assert!(!reapproved.view(600).available);
    }

    /// The set of legal native manifests is closed and enumerated, and the
    /// owner reads the exact capability list in Center before approving.
    #[test]
    fn native_action_manifest_is_the_exact_value_per_platform() {
        let channels = |platform: &str| {
            let manifest = native_manifest(platform);
            let mut names: Vec<String> = manifest["capabilities"]["output"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            names.sort();
            names
        };
        assert_eq!(
            channels("macos"),
            [
                "action.open",
                "action.run",
                "audio.tts",
                "confirm.tap",
                "visual.card"
            ]
        );
        assert_eq!(
            channels("linux"),
            [
                "action.open",
                "action.run",
                "audio.tts",
                "confirm.tap",
                "visual.card"
            ]
        );
        assert_eq!(
            channels("android"),
            [
                "action.open",
                "action.route",
                "audio.tts",
                "confirm.tap",
                "visual.card"
            ]
        );
        assert_eq!(
            channels("android_tv"),
            ["action.play", "audio.tts", "visual.card"]
        );
        // Who each installation's output reaches, published per platform and
        // approved by the owner. It is the one manifest word the router reads
        // to decide where an answer belongs, and it names no product.
        for (platform, expected) in [
            ("macos", "desk"),
            ("linux", "desk"),
            ("android", "handheld"),
            ("android_tv", "room"),
        ] {
            let manifest = native_manifest(platform);
            for (channel, declared) in manifest["capabilities"]["output"].as_object().unwrap() {
                assert_eq!(declared["audience"], expected, "{platform} {channel}");
            }
        }
        // Only macOS can ask a person to prove they are the device owner, so
        // only macOS declares the attestation a high-risk command requires.
        assert_eq!(
            native_manifest("macos")["capabilities"]["output"]["confirm.tap"]["attestation"],
            serde_json::json!(["foreground_tap", "device_owner_auth"])
        );
        assert_eq!(
            native_manifest("linux")["capabilities"]["output"]["confirm.tap"]["attestation"],
            serde_json::json!(["foreground_tap"])
        );
        for platform in NATIVE_PLATFORMS {
            let manifest = native_manifest(platform);
            assert_eq!(
                manifest["cognition"],
                serde_json::json!({"declaredClass": 0, "models": []})
            );
            assert_eq!(manifest["authority"]["reflexive"], serde_json::json!([]));
            let constraints = manifest["constraints"].as_array().unwrap().clone();
            for required in ["actor_unknown", "occupancy_unknown", "effect_unverified"] {
                assert!(
                    constraints.contains(&serde_json::json!(required)),
                    "{platform}"
                );
            }
            // Every channel defaults to the shared-room ceiling; only the
            // owner's own personal declaration lifts it, at routing time.
            for channel in manifest["capabilities"]["output"]
                .as_object()
                .unwrap()
                .values()
            {
                assert_eq!(channel["maxClass"], "shared_room");
            }
            // The manifest names exactly one approval, for its own platform.
            let mut record = transition(
                None,
                0,
                Uuid::new_v4(),
                &Mutation::ApproveNative {
                    enrollment_id: Uuid::new_v4(),
                    public_key: NATIVE_KEY.into(),
                    platform: platform.into(),
                    expected_revision: 0,
                },
                100,
            )
            .unwrap()
            .0;
            assert_eq!(
                native_approval(&record),
                Some(current_native_approval(platform))
            );
            record.approved_manifest = legacy_native_speech_manifest();
            assert_eq!(
                native_approval(&record),
                Some(LEGACY_NATIVE_SPEECH_APPROVAL)
            );
            assert!(native_declares(&record, "audio.tts"));
            assert!(!native_declares(&record, "action.open"));
            record.approved_manifest = legacy_native_display_manifest();
            assert_eq!(
                native_approval(&record),
                Some(LEGACY_NATIVE_DISPLAY_APPROVAL)
            );
            assert!(!native_declares(&record, "audio.tts"));
            // A manifest from another platform is unknown, not "some known one".
            let other = NATIVE_PLATFORMS.iter().find(|p| **p != platform).unwrap();
            record.approved_manifest = native_manifest(other);
            assert_eq!(native_approval(&record), None);
            assert!(!native_declares(&record, "visual.card"));
        }
    }

    /// The published contract and the code are one statement, not two. Every
    /// manifest, profile name and enumerated value the owner reads in Center
    /// is the exact value this registry mints.
    #[test]
    fn native_contract_matches_the_published_manifests_and_profiles() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/ambiance-native.json"))
                .unwrap();
        assert_eq!(contract["profile"], NATIVE_APPROVAL);
        assert_eq!(
            contract["descriptor"]["fields"]["approval"],
            "platformProfiles[platform]"
        );
        for platform in NATIVE_PLATFORMS {
            assert_eq!(
                contract["platformProfiles"][platform],
                current_native_approval(platform)
            );
            assert_eq!(
                contract["deviceActions"]["manifests"][platform],
                native_manifest(platform),
                "{platform}"
            );
        }
        let statuses = contract["deviceActions"]["statuses"].as_array().unwrap();
        let expected = [
            crate::ambiance::ActionStatus::Proposed,
            crate::ambiance::ActionStatus::AwaitingGrant,
            crate::ambiance::ActionStatus::Dispatched,
            crate::ambiance::ActionStatus::Acknowledged,
            crate::ambiance::ActionStatus::Running,
            crate::ambiance::ActionStatus::Completed,
            crate::ambiance::ActionStatus::Refused,
            crate::ambiance::ActionStatus::Failed,
            crate::ambiance::ActionStatus::Cancelled,
            crate::ambiance::ActionStatus::OutcomeUnknown,
        ];
        assert_eq!(statuses.len(), expected.len());
        for (published, status) in statuses.iter().zip(expected) {
            assert_eq!(*published, serde_json::to_value(status).unwrap());
        }
        let channels = contract["deviceActions"]["channels"].as_object().unwrap();
        let declared = [
            crate::ambiance::Channel::ActionOpen,
            crate::ambiance::Channel::ActionRoute,
            crate::ambiance::Channel::ActionPlay,
            crate::ambiance::Channel::ActionRun,
            crate::ambiance::Channel::ConfirmTap,
        ];
        assert_eq!(channels.len(), declared.len());
        for channel in declared {
            assert!(channels.contains_key(channel.as_str()), "{channel:?}");
        }
        assert_eq!(
            contract["deviceActions"]["digests"]["vectors"],
            "contracts/fixtures/ambiance-device-action-digests-v1.json"
        );
        assert_eq!(
            contract["deviceActions"]["owner"]["approve-device-actions-v1"]["routes"]["GET|POST"],
            "/surface-api/v1/surfaces/:surfaceId/device-actions"
        );
        assert_eq!(
            contract["deviceActions"]["owner"]["approve-device-command-v1"]["platforms"],
            serde_json::json!(["macos", "linux"])
        );
        // Every enumeration a client, Center or an owner reads is the exact
        // set this runtime mints. One drift refuses an action with no useful
        // error, or renders a state nobody wrote words for.
        let states = contract["deviceActions"]["turnStates"].as_array().unwrap();
        let expected = [
            crate::ambiance::status::TurnState::Working,
            crate::ambiance::status::TurnState::Waiting,
            crate::ambiance::status::TurnState::Confirming,
            crate::ambiance::status::TurnState::Acting,
            crate::ambiance::status::TurnState::Shown,
            crate::ambiance::status::TurnState::Spoken,
            crate::ambiance::status::TurnState::Done,
            crate::ambiance::status::TurnState::Refused,
            crate::ambiance::status::TurnState::Nowhere,
            crate::ambiance::status::TurnState::Unknown,
        ];
        assert_eq!(states.len(), expected.len());
        for (published, state) in states.iter().zip(expected) {
            assert_eq!(*published, serde_json::to_value(state).unwrap());
        }
        let evidence = contract["deviceActions"]["evidence"].as_object().unwrap();
        for kind in [
            crate::ambiance::action::EvidenceKind::Open,
            crate::ambiance::action::EvidenceKind::Route,
            crate::ambiance::action::EvidenceKind::Playback,
            crate::ambiance::action::EvidenceKind::Command,
            crate::ambiance::action::EvidenceKind::Declined,
        ] {
            let name = serde_json::to_value(kind).unwrap();
            assert!(evidence.contains_key(name.as_str().unwrap()), "{kind:?}");
        }
        let budgets = &contract["deviceActions"]["clocks"]["report_budget_ms"];
        for (channel, operation) in [
            (
                crate::ambiance::Channel::ActionOpen,
                crate::ambiance::action::Operation::Open {
                    locator: crate::ambiance::action::Locator::App {
                        id: "dev.zed.Zed".into(),
                    },
                    version: None,
                    position: None,
                    label: "Zed".into(),
                },
            ),
            (
                crate::ambiance::Channel::ActionRoute,
                crate::ambiance::action::Operation::Route {
                    place_id: "p".into(),
                    name: "n".into(),
                    address: "a".into(),
                    lat: "0.000000".into(),
                    lng: "0.000000".into(),
                },
            ),
            (
                crate::ambiance::Channel::ActionPlay,
                crate::ambiance::action::Operation::Play {
                    title: "t".into(),
                    query: "q".into(),
                    providers: vec!["youtube".into()],
                    item_digest: "c".repeat(64),
                },
            ),
        ] {
            assert_eq!(
                budgets[channel.as_str()].as_i64(),
                Some(operation.report_budget_ms()),
                "{channel:?}"
            );
        }
        assert_eq!(
            contract["deviceActions"]["clocks"]["grant_ms"].as_i64(),
            Some(crate::ambiance::grant::GRANT_MS)
        );
        assert_eq!(
            contract["deviceActions"]["clocks"]["progress_grace_ms"].as_i64(),
            Some(crate::ambiance::action::PROGRESS_GRACE_MS)
        );
        assert_eq!(
            contract["deviceActions"]["clocks"]["act_to_acknowledge_ms"].as_i64(),
            Some(crate::ambiance::ACK_MS)
        );
        assert_eq!(
            contract["deviceActions"]["clocks"]["wait_for_a_foreground_ms"].as_i64(),
            Some(crate::ambiance::personal::PRIVATE_DISPLAY_MS)
        );
        // The two fixed sentences are published exactly as the runtime speaks
        // them, because a client that paraphrased one would leak the
        // difference the invariant exists to hide.
        let expression = contract["deviceActions"]["expression"]["shared"]
            .as_str()
            .unwrap();
        assert!(expression.contains(crate::ambiance::ACTION_COMPLETED_EXPRESSION));
        assert!(expression.contains(crate::ambiance::ACTION_HANDLED_EXPRESSION));
    }

    /// A television is bystander-perceivable by construction: it is never a
    /// ceremony venue and never runs an owner command.
    #[test]
    fn android_tv_never_declares_confirm_tap_or_action_run() {
        let tv = native_manifest("android_tv");
        for absent in ["confirm.tap", "action.run", "action.open", "action.route"] {
            assert!(tv["capabilities"]["output"][absent].is_null(), "{absent}");
            assert!(tv["expression"][absent].is_null(), "{absent}");
        }
        assert_eq!(
            tv["capabilities"]["output"]["action.play"],
            serde_json::json!({"maxClass": "shared_room", "shared": true, "risk": "low", "idempotent": true, "reportBudgetMs": 30000, "audience": "room"})
        );
        // It never captures the owner's screen either. Its remote's
        // microphone is admitted, because a person pressing a button on a
        // remote is as deliberate as one pressing a key; what the room it
        // sits in costs it is the class, not the channel. A television holds
        // no `approve-private-display-v1` declaration, so its voice ceiling is
        // the shared room and its floor is the shared room too.
        assert_eq!(
            tv["capabilities"]["input"],
            serde_json::json!([
                "text.public",
                "state.visibility",
                "action.report",
                NATIVE_VOICE_INPUT
            ])
        );
    }

    #[test]
    fn linux_task_profile_requires_reapproval_without_widening_prior_permissions() {
        let id = Uuid::new_v4();
        let mutation = Mutation::ApproveNative {
            enrollment_id: Uuid::new_v4(),
            public_key: NATIVE_KEY.into(),
            platform: "linux".into(),
            expected_revision: 0,
        };
        let mut record = transition(None, 0, id, &mutation, 100).unwrap().0;
        record.approved_manifest = legacy_native_audience_manifest("linux");
        assert_eq!(native_approval(&record), Some(NATIVE_APPROVAL));
        assert!(native_declares(&record, "action.open"));
        assert!(!native_declares(&record, "action.run"));
        assert_eq!(
            record.view(100).native_view().unwrap().approval,
            NATIVE_APPROVAL
        );
        let Mutation::ApproveNative {
            enrollment_id,
            public_key,
            platform,
            ..
        } = mutation
        else {
            unreachable!()
        };
        let revision = record.revision;
        let upgraded = transition(
            Some(&record),
            1,
            id,
            &Mutation::ApproveNative {
                enrollment_id,
                public_key,
                platform,
                expected_revision: revision,
            },
            101,
        )
        .unwrap()
        .0;
        assert_eq!(upgraded.revision, revision + 1);
        assert_eq!(native_approval(&upgraded), Some(NATIVE_LINUX_APPROVAL));
        assert_eq!(
            upgraded.approved_manifest["capabilities"]["output"]["action.run"]["risk"],
            "moderate"
        );
        assert!(!crate::ambiance::grant::venue_declares(
            &upgraded,
            crate::ambiance::action::Attestation::DeviceOwnerAuth
        ));
    }

    /// Every published platform declares the microphone, and every legacy
    /// profile declares none: an installation the owner has not reapproved
    /// cannot be spoken to, whatever else it may still do.
    #[test]
    fn native_voice_input_is_declared_by_the_current_profile_alone() {
        for platform in NATIVE_PLATFORMS {
            let mut record = transition(
                None,
                0,
                Uuid::new_v4(),
                &Mutation::ApproveNative {
                    enrollment_id: Uuid::new_v4(),
                    public_key: NATIVE_KEY.into(),
                    platform: platform.into(),
                    expected_revision: 0,
                },
                100,
            )
            .unwrap()
            .0;
            assert_eq!(
                native_approval(&record),
                Some(current_native_approval(platform))
            );
            assert!(native_declares_input(&record, NATIVE_VOICE_INPUT));
            assert!(native_declares_input(&record, "text.public"));
            // The voice rung added one input channel and nothing else; this
            // rung adds one `audience` word to each output channel and
            // nothing else.
            assert_eq!(
                legacy_native_voice_manifest(platform)["capabilities"]["output"],
                legacy_native_action_manifest(platform)["capabilities"]["output"]
            );
            let mut stripped = legacy_native_audience_manifest(platform);
            for channel in stripped["capabilities"]["output"]
                .as_object_mut()
                .unwrap()
                .values_mut()
            {
                assert!(
                    crate::ambiance::policy::Audience::parse(channel["audience"].as_str().unwrap())
                        .is_some(),
                    "{platform} declares a published audience on every output channel"
                );
                channel.as_object_mut().unwrap().remove("audience");
            }
            assert_eq!(stripped, legacy_native_voice_manifest(platform));
            for constraint in [
                "push_to_talk_only",
                "no_background_capture",
                "capture_indicator_required",
            ] {
                assert!(
                    record.approved_manifest["constraints"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!(constraint)),
                    "{platform} {constraint}"
                );
            }
            // The rung below this one keeps its ear and loses only the
            // audience declaration; the ones below that have neither.
            record.approved_manifest = legacy_native_voice_manifest(platform);
            assert_eq!(native_approval(&record), Some(LEGACY_NATIVE_VOICE_APPROVAL));
            assert!(known_native_approval(LEGACY_NATIVE_VOICE_APPROVAL));
            assert!(native_declares_input(&record, NATIVE_VOICE_INPUT));
            assert_eq!(native_audience(&record, "visual.card"), None);
            for (legacy, profile) in [
                (
                    legacy_native_action_manifest(platform),
                    LEGACY_NATIVE_ACTION_APPROVAL,
                ),
                (
                    legacy_native_speech_manifest(),
                    LEGACY_NATIVE_SPEECH_APPROVAL,
                ),
                (
                    legacy_native_display_manifest(),
                    LEGACY_NATIVE_DISPLAY_APPROVAL,
                ),
            ] {
                record.approved_manifest = legacy;
                assert_eq!(native_approval(&record), Some(profile));
                assert!(known_native_approval(profile));
                assert!(
                    !native_declares_input(&record, NATIVE_VOICE_INPUT),
                    "{profile}"
                );
                assert_eq!(native_audience(&record, "visual.card"), None);
            }
            // A v4 record still renders, speaks and acts; it just has no ear.
            record.approved_manifest = legacy_native_action_manifest(platform);
            assert!(native_declares(&record, "visual.card"));
            assert!(native_declares(&record, "audio.tts"));
        }
    }

    #[test]
    fn native_registry_immutable_descriptor_profile_boundaries_and_cap() {
        let enrollment = Uuid::new_v4();
        let id = native_surface_id("U:owner", enrollment);
        let approve = native_mutation(enrollment, 0);
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
            transition(Some(&revoked), 16, id, &native_mutation(enrollment, 2), 300),
            Err(RegistryError::SurfaceLimit)
        ));
        assert!(matches!(
            transition(None, 0, id, &native_mutation(Uuid::nil(), 0), 100),
            Err(RegistryError::InvalidConnection)
        ));
        assert!(matches!(
            transition(
                Some(&native),
                1,
                id,
                &native_mutation(enrollment, MAX_NATIVE_REVISION),
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
        let (native, _) = transition(None, 0, id, &native_mutation(enrollment, 0), 100).unwrap();
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
