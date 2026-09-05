//! Durable native Pin connection authority. Transport authentication and current
//! device pairing must be checked by the caller before every operation.
use super::{InputCursor, RuntimeError, RuntimeState};
use crate::surface_registry::{Binding, Record};
use cosmos_core::AuthenticatedDeviceIdentity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Never accept a body-supplied device identity as authentication.
#[derive(Clone)]
pub struct PinProof {
    pub device: AuthenticatedDeviceIdentity,
    pub surface_id: Uuid,
    pub incarnation: Uuid,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinConnection {
    pub approval_revision: u64,
    pub incarnation: Uuid,
    pub epoch: Uuid,
    pub previous_incarnation: Option<Uuid>,
    pub expires_at_ms: i64,
    pub closed: bool,
    #[serde(default)]
    pub media_owner: Option<Uuid>,
}

impl PinConnection {
    pub(super) fn current(&self, record: &Record, now: i64) -> bool {
        !self.closed
            && !record.revoked
            && matches!(record.binding, Binding::Pin { .. })
            && record.revision == self.approval_revision
            && now < self.expires_at_ms
    }
}

pub(super) fn record<'a>(
    principal: &str,
    records: &'a BTreeMap<Uuid, Record>,
    surface_id: Uuid,
    device: &AuthenticatedDeviceIdentity,
) -> Result<&'a Record, RuntimeError> {
    let device = device.expose_for_authorization();
    let id = crate::surface_registry::pin_surface_id(principal, device);
    records
        .get(&surface_id)
        .filter(|r| {
            id == surface_id
                && !r.revoked
                && matches!(&r.binding, Binding::Pin { device_id } if device_id == device)
                && r.approved_manifest == crate::surface_registry::pin_manifest()
        })
        .ok_or(RuntimeError::InvalidOrigin)
}

impl RuntimeState {
    pub(super) fn pin_record<'a>(
        &self,
        principal: &str,
        records: &'a BTreeMap<Uuid, Record>,
        proof: &PinProof,
        now: i64,
    ) -> Result<&'a Record, RuntimeError> {
        let record = record(principal, records, proof.surface_id, &proof.device)?;
        self.pin_connections
            .get(&proof.surface_id)
            .filter(|c| c.incarnation == proof.incarnation && c.current(record, now))
            .ok_or(RuntimeError::Stale)?;
        Ok(record)
    }

    pub(super) fn open_pin(
        &mut self,
        record: &Record,
        approval_revision: u64,
        epoch: Uuid,
        expected: Option<Uuid>,
        incarnation: Uuid,
        now: i64,
    ) -> Result<(PinConnection, bool), RuntimeError> {
        if epoch.is_nil() || incarnation.is_nil() || expected.is_some_and(|id| id.is_nil()) {
            return Err(RuntimeError::InvalidRequest);
        }
        if approval_revision != record.revision {
            return Err(RuntimeError::Stale);
        }
        let current = self
            .pin_connections
            .get(&record.surface_id)
            .filter(|c| c.approval_revision == approval_revision);
        if let Some(current) = current {
            if current.epoch == epoch && current.previous_incarnation == expected {
                // Retry never renews the deadline or grants connection ownership.
                return if current.current(record, now) {
                    Ok((current.clone(), true))
                } else {
                    Err(RuntimeError::Stale)
                };
            }
            if expected != Some(current.incarnation) || incarnation == current.incarnation {
                return Err(RuntimeError::Stale);
            }
        } else if expected.is_some() {
            return Err(RuntimeError::Stale);
        }
        let connection = PinConnection {
            approval_revision,
            incarnation,
            epoch,
            previous_incarnation: expected,
            expires_at_ms: now
                .checked_add(crate::surface_registry::CONNECTION_MS)
                .ok_or(RuntimeError::Unavailable)?,
            closed: false,
            media_owner: None,
        };
        // Reconnecting within one boot must preserve its sequence high-water
        // mark. Only a new boot epoch starts a fresh cursor. The old proof
        // cannot reach either cursor after this incarnation changes.
        let mut cursor = self
            .ingress
            .get(&record.surface_id)
            .filter(|c| {
                current.is_some_and(|previous| {
                    previous.epoch == epoch && previous.incarnation == c.incarnation
                })
            })
            .cloned()
            .unwrap_or(InputCursor {
                incarnation,
                epoch,
                high_water: 0,
                receipts: Vec::new(),
                controls: Vec::new(),
            });
        cursor.incarnation = incarnation;
        self.ingress.insert(record.surface_id, cursor);
        self.pin_connections
            .insert(record.surface_id, connection.clone());
        Ok((connection, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambiance::*;
    use crate::surface_registry::{Mutation, hash, pin_surface_id, transition};

    const PRINCIPAL: &str = "U:pin-connection-fixture";
    fn fixture() -> (RuntimeState, BTreeMap<Uuid, Record>, PinProof, Uuid) {
        let id = pin_surface_id(PRINCIPAL, "aabb");
        let (record, _) = transition(
            None,
            0,
            id,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap();
        let records = BTreeMap::from([(id, record)]);
        let proof = PinProof {
            device: AuthenticatedDeviceIdentity::from_edge("aabb").unwrap(),
            surface_id: id,
            incarnation: Uuid::new_v4(),
        };
        (RuntimeState::default(), records, proof, Uuid::new_v4())
    }
    fn open(
        proof: &PinProof,
        epoch: Uuid,
        expected: Option<Uuid>,
        revision: u64,
    ) -> RuntimeOperation {
        RuntimeOperation::OpenPin {
            device: proof.device.clone(),
            surface_id: proof.surface_id,
            approval_revision: revision,
            epoch,
            expected_incarnation: expected,
            incarnation: proof.incarnation,
        }
    }
    fn input(proof: &PinProof, stamp: &InputStamp, text: &str) -> RuntimeOperation {
        RuntimeOperation::Begin {
            turn_id: stamp.instance_id,
            worker: Uuid::new_v4(),
            origin: OriginProof::SequencedPin {
                connection: proof.clone(),
                stamp: stamp.clone(),
                echo_fingerprint: echo::fingerprint(text),
            },
            request_digest: hash(text.as_bytes()),
            privacy_floor: PrivacyClass::SharedRoom,
        }
    }
    fn check(proof: &PinProof) -> RuntimeOperation {
        RuntimeOperation::CheckPin {
            connection: proof.clone(),
        }
    }

    #[test]
    fn ambiance_pin_epoch_cas_retries_do_not_renew_or_own_a_new_connection() {
        let (mut state, records, proof, epoch) = fixture();
        let (
            RuntimeResult::PinOpened {
                connection,
                duplicate: false,
            },
            events,
        ) = state
            .apply(PRINCIPAL, &records, open(&proof, epoch, None, 1), 101)
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(events.len(), 1);
        let other_worker = PinProof {
            incarnation: Uuid::new_v4(),
            ..proof.clone()
        };
        let (
            RuntimeResult::PinOpened {
                connection: retried,
                duplicate: true,
            },
            events,
        ) = state
            .apply(
                PRINCIPAL,
                &records,
                open(&other_worker, epoch, None, 1),
                500,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(retried.incarnation, connection.incarnation);
        assert_eq!(retried.expires_at_ms, connection.expires_at_ms);
        assert!(events.is_empty());
        assert!(matches!(
            state.apply(
                PRINCIPAL,
                &records,
                open(&other_worker, Uuid::new_v4(), None, 1),
                501
            ),
            Err(RuntimeError::Stale)
        ));
        let encoded = serde_json::to_string(&state).unwrap();
        assert!(!encoded.contains("aabb"));
        let mut state: RuntimeState = serde_json::from_str(&encoded).unwrap();
        let stamp = InputStamp {
            epoch,
            sequence: 1,
            instance_id: Uuid::new_v4(),
        };
        let (RuntimeResult::Begun(fence), _) = state
            .apply(PRINCIPAL, &records, input(&proof, &stamp, "hello"), 502)
            .unwrap()
        else {
            panic!()
        };
        let new_epoch = Uuid::new_v4();
        let (_, events) = state
            .apply(
                PRINCIPAL,
                &records,
                open(&other_worker, new_epoch, Some(proof.incarnation), 1),
                503,
            )
            .unwrap();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, RuntimeData::TurnCancelled { .. }))
        );
        assert!(matches!(
            state.apply(
                PRINCIPAL,
                &records,
                RuntimeOperation::CheckCognition { fence },
                504
            ),
            Err(RuntimeError::Stale)
        ));
        assert!(
            state
                .apply(PRINCIPAL, &records, check(&proof), 504)
                .is_err()
        );
        assert!(
            state
                .apply(
                    PRINCIPAL,
                    &records,
                    RuntimeOperation::ClosePin { connection: proof },
                    504
                )
                .is_err()
        );
        assert!(
            state
                .apply(PRINCIPAL, &records, check(&other_worker), 505)
                .is_ok()
        );
        let expiry = state.pin_connections[&other_worker.surface_id].expires_at_ms;
        assert!(state.next_maintenance_ms(&records) <= expiry);
        let events = state.reconcile(&records, expiry);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, RuntimeData::PinEpochClosed { .. }))
        );
        assert!(
            state
                .apply(PRINCIPAL, &records, check(&other_worker), expiry)
                .is_err()
        );
        assert!(
            state
                .apply(
                    PRINCIPAL,
                    &records,
                    open(&other_worker, new_epoch, Some(connection.incarnation), 1),
                    expiry
                )
                .is_err()
        );
    }

    #[test]
    fn ambiance_pin_reconnect_in_one_boot_preserves_input_sequence_and_deduplication() {
        let (mut state, records, proof, epoch) = fixture();
        state
            .apply(PRINCIPAL, &records, open(&proof, epoch, None, 1), 101)
            .unwrap();
        let stamp = InputStamp {
            epoch,
            sequence: 1,
            instance_id: Uuid::new_v4(),
        };
        state
            .apply(PRINCIPAL, &records, input(&proof, &stamp, "hello"), 102)
            .unwrap();
        let next = PinProof {
            incarnation: Uuid::new_v4(),
            ..proof.clone()
        };
        state
            .apply(
                PRINCIPAL,
                &records,
                open(&next, epoch, Some(proof.incarnation), 1),
                103,
            )
            .unwrap();
        assert!(state.turn.as_ref().unwrap().cancelled);
        assert!(matches!(
            state
                .apply(PRINCIPAL, &records, input(&next, &stamp, "hello"), 104)
                .unwrap()
                .0,
            RuntimeResult::Duplicate(_)
        ));
        assert!(
            state
                .apply(PRINCIPAL, &records, input(&next, &stamp, "changed"), 104)
                .is_err()
        );
        assert_eq!(state.ingress[&proof.surface_id].high_water, 1);
        let next_stamp = InputStamp {
            sequence: 2,
            instance_id: Uuid::new_v4(),
            ..stamp
        };
        assert!(matches!(
            state
                .apply(PRINCIPAL, &records, input(&next, &next_stamp, "next"), 105)
                .unwrap()
                .0,
            RuntimeResult::Begun(_)
        ));
    }

    #[test]
    fn ambiance_pin_sequenced_echo_retries_are_consumed_without_cognition_or_new_events() {
        let (mut state, records, proof, epoch) = fixture();
        state
            .apply(PRINCIPAL, &records, open(&proof, epoch, None, 1), 101)
            .unwrap();
        let stamp = InputStamp {
            epoch,
            sequence: 1,
            instance_id: Uuid::new_v4(),
        };
        let (RuntimeResult::Begun(fence), _) = state
            .apply(PRINCIPAL, &records, input(&proof, &stamp, "hello"), 102)
            .unwrap()
        else {
            panic!()
        };
        let (RuntimeResult::Duplicate(retried), events) = state
            .apply(PRINCIPAL, &records, input(&proof, &stamp, "hello"), 103)
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(fence.worker, retried.worker);
        assert!(events.is_empty());
        assert!(matches!(
            state.apply(PRINCIPAL, &records, input(&proof, &stamp, "changed"), 103),
            Err(RuntimeError::Stale)
        ));
        let (RuntimeResult::Proposed(action), _) = state
            .apply(
                PRINCIPAL,
                &records,
                RuntimeOperation::Propose {
                    turn_id: fence.turn_id,
                    generation: fence.generation,
                    worker: fence.worker,
                    intent: SemanticIntent::InformationalSpeech {
                        text: "Welcome back.".into(),
                    },
                    privacy: PrivacyClass::Public,
                },
                104,
            )
            .unwrap()
        else {
            panic!()
        };
        state
            .apply(
                PRINCIPAL,
                &records,
                RuntimeOperation::Claim {
                    action_id: action.id,
                    generation: fence.generation,
                    worker: fence.worker,
                },
                105,
            )
            .unwrap();
        let echo_stamp = InputStamp {
            epoch,
            sequence: 2,
            instance_id: Uuid::new_v4(),
        };
        let (RuntimeResult::EchoRejected, events) = state
            .apply(
                PRINCIPAL,
                &records,
                input(&proof, &echo_stamp, "welcome back!"),
                106,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, RuntimeData::EchoRejected { .. }))
                .count(),
            1
        );
        assert_eq!(state.generation, 1);
        let encoded = serde_json::to_string(&state).unwrap();
        assert!(!encoded.contains("welcome back"));
        let mut state: RuntimeState = serde_json::from_str(&encoded).unwrap();
        let (RuntimeResult::EchoRejected, events) = state
            .apply(
                PRINCIPAL,
                &records,
                input(&proof, &echo_stamp, "welcome back!"),
                107,
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(events.is_empty());
        assert!(
            state
                .apply(
                    PRINCIPAL,
                    &records,
                    input(&proof, &echo_stamp, "changed"),
                    108
                )
                .is_err()
        );
        // Expiring the receipt must not reset the durable high-water mark.
        assert!(matches!(
            state.apply(
                PRINCIPAL,
                &records,
                input(&proof, &echo_stamp, "welcome back!"),
                400_000
            ),
            Err(RuntimeError::Stale)
        ));
        assert_eq!(state.ingress[&proof.surface_id].high_water, 2);
    }

    #[test]
    fn ambiance_pin_reapproval_and_owner_boundaries_cannot_reanimate_an_old_epoch() {
        let (mut state, mut records, proof, epoch) = fixture();
        assert!(
            state
                .apply("U:another", &records, open(&proof, epoch, None, 1), 101)
                .is_err()
        );
        let mut wrong = proof.clone();
        wrong.device = AuthenticatedDeviceIdentity::from_edge("bbcc").unwrap();
        assert!(
            state
                .apply(PRINCIPAL, &records, open(&wrong, epoch, None, 1), 101)
                .is_err()
        );
        state
            .apply(PRINCIPAL, &records, open(&proof, epoch, None, 1), 101)
            .unwrap();
        let (revoked, _) = transition(
            Some(&records[&proof.surface_id]),
            1,
            proof.surface_id,
            &Mutation::RevokePin,
            102,
        )
        .unwrap();
        records.insert(proof.surface_id, revoked);
        assert!(
            state
                .apply(PRINCIPAL, &records, check(&proof), 103)
                .is_err()
        );
        let (approved, _) = transition(
            Some(&records[&proof.surface_id]),
            0,
            proof.surface_id,
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            104,
        )
        .unwrap();
        records.insert(proof.surface_id, approved);
        assert!(
            state
                .apply(PRINCIPAL, &records, open(&proof, epoch, None, 1), 105)
                .is_err()
        );
        let next = PinProof {
            incarnation: Uuid::new_v4(),
            ..proof.clone()
        };
        state
            .apply(
                PRINCIPAL,
                &records,
                open(&next, Uuid::new_v4(), None, 3),
                106,
            )
            .unwrap();
        assert!(
            state
                .apply(PRINCIPAL, &records, check(&proof), 107)
                .is_err()
        );
        assert!(state.apply(PRINCIPAL, &records, check(&next), 107).is_ok());
    }
}
