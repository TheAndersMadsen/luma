//! One mixed-version chain. Legacy structs retain their original field order.
use super::state::RuntimeData;
use crate::surface_registry::{Event, RegistryError, hash};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeEvent {
    pub version: u8,
    pub principal: String,
    pub sequence: u64,
    pub previous_hash: String,
    pub receipt_ms: i64,
    pub data: RuntimeData,
}
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum LedgerEvent {
    Enrollment(Event),
    Runtime(RuntimeEvent),
}
impl<'de> Deserialize<'de> for LedgerEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let version = value
            .get("version")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| serde::de::Error::custom("missing ledger version"))?;
        match version {
            1 | 2 => {
                let allowed = [
                    "version",
                    "principal",
                    "sequence",
                    "previous_hash",
                    "kind",
                    "surface_id",
                    "revision",
                    "receipt_ms",
                    "visible",
                    "approved_manifest",
                    "binding_digest",
                ];
                let object = value
                    .as_object()
                    .ok_or_else(|| serde::de::Error::custom("invalid ledger event"))?;
                if object.keys().any(|k| !allowed.contains(&k.as_str()))
                    || (version == 1 && object.contains_key("binding_digest"))
                    || (version == 2 && !value.get("binding_digest").is_some_and(|v| v.is_string()))
                {
                    return Err(serde::de::Error::custom("invalid enrollment event version"));
                }
                serde_json::from_value(value)
                    .map(Self::Enrollment)
                    .map_err(serde::de::Error::custom)
            }
            3 => serde_json::from_value(value)
                .map(Self::Runtime)
                .map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom("unsupported ledger version")),
        }
    }
}
impl LedgerEvent {
    pub fn hash(&self) -> Result<String, RegistryError> {
        serde_json::to_vec(self)
            .map(|v| hash(&v))
            .map_err(|_| RegistryError::Unavailable)
    }
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Enrollment(e) => e.sequence,
            Self::Runtime(e) => e.sequence,
        }
    }
    pub fn previous_hash(&self) -> &str {
        match self {
            Self::Enrollment(e) => &e.previous_hash,
            Self::Runtime(e) => &e.previous_hash,
        }
    }
    pub fn runtime(
        principal: &str,
        sequence: u64,
        previous_hash: String,
        receipt_ms: i64,
        data: RuntimeData,
    ) -> Self {
        Self::Runtime(RuntimeEvent {
            version: 3,
            principal: principal.to_owned(),
            sequence,
            previous_hash,
            receipt_ms,
            data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ambiance_mixed_ledger_preserves_legacy_bytes_and_rejects_unknown_shapes() {
        let v1 = r#"{"version":1,"principal":"U:owner","sequence":1,"previous_hash":"","kind":"surface.approved","surface_id":"00000000-0000-0000-0000-000000000000","revision":1,"receipt_ms":100,"visible":false,"approved_manifest":{}}"#;
        let first: LedgerEvent = serde_json::from_str(v1).unwrap();
        assert_eq!(first.hash().unwrap(), hash(v1.as_bytes()));
        let v2 = format!(
            "{{\"version\":2,\"principal\":\"U:owner\",\"sequence\":2,\"previous_hash\":\"{}\",\"kind\":\"surface.approved\",\"surface_id\":\"00000000-0000-0000-0000-000000000000\",\"revision\":1,\"receipt_ms\":101,\"visible\":false,\"approved_manifest\":{{}},\"binding_digest\":\"{}\"}}",
            first.hash().unwrap(),
            hash(b"binding")
        );
        let second: LedgerEvent = serde_json::from_str(&v2).unwrap();
        assert_eq!(second.hash().unwrap(), hash(v2.as_bytes()));
        let third = LedgerEvent::runtime(
            "U:owner",
            3,
            second.hash().unwrap(),
            102,
            RuntimeData::TurnCancelled {
                turn_id: uuid::Uuid::nil(),
                generation: 1,
            },
        );
        for event in [&first, &second, &third] {
            // JSONB may reorder every object. Typed decode restores canonical order.
            let jsonb = serde_json::to_value(event).unwrap();
            let decoded: LedgerEvent = serde_json::from_value(jsonb).unwrap();
            assert_eq!(event.hash().unwrap(), decoded.hash().unwrap());
        }
        for invalid in [
            v1.replace("\"version\":1", "\"version\":4"),
            v1.replace("\"version\":1", "\"version\":2"),
            v1.replace("\"version\":1", "\"version\":1,\"binding_digest\":null"),
            v1.replace("\"version\":1", "\"version\":1,\"text\":\"secret\""),
        ] {
            assert!(serde_json::from_str::<LedgerEvent>(&invalid).is_err());
        }
    }
}
