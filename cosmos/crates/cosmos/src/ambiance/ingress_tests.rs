use super::*;
use crate::surface_registry::{Mutation, Record, hash, transition};
use std::collections::BTreeMap;
use uuid::Uuid;

fn fixture() -> (
    RuntimeState,
    BTreeMap<Uuid, Record>,
    BrowserProof,
    InputStamp,
) {
    let id = Uuid::new_v4();
    let proof = BrowserProof {
        surface_id: id,
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"fixture capability"),
    };
    let (record, _) = transition(
        None,
        0,
        id,
        &Mutation::Approve {
            token_hash: proof.token_hash.clone(),
            incarnation: proof.incarnation,
        },
        100,
    )
    .unwrap();
    let (record, _) = transition(
        Some(&record),
        1,
        id,
        &Mutation::State {
            token_hash: proof.token_hash.clone(),
            incarnation: proof.incarnation,
            sequence: 1,
            visible: true,
        },
        101,
    )
    .unwrap();
    let records = BTreeMap::from([(id, record)]);
    let stamp = InputStamp {
        epoch: Uuid::new_v4(),
        sequence: 1,
        instance_id: Uuid::new_v4(),
    };
    let mut state = RuntimeState::default();
    state
        .apply(
            "U:fixture",
            &records,
            RuntimeOperation::OpenBrowser {
                connection: proof.clone(),
                epoch: stamp.epoch,
            },
            102,
        )
        .unwrap();
    (state, records, proof, stamp)
}

fn input(proof: &BrowserProof, stamp: &InputStamp, text: &str) -> RuntimeOperation {
    RuntimeOperation::Begin {
        turn_id: stamp.instance_id,
        worker: Uuid::new_v4(),
        origin: OriginProof::SequencedBrowser {
            connection: proof.clone(),
            stamp: stamp.clone(),
        },
        request_digest: hash(text.as_bytes()),
        privacy_floor: PrivacyClass::Public,
    }
}

#[test]
fn ambiance_ingress_reopen_and_late_duplicate_never_replace_the_current_turn() {
    let (mut state, records, proof, stamp) = fixture();
    let (RuntimeResult::Begun(first), events) = state
        .apply("U:fixture", &records, input(&proof, &stamp, "request"), 103)
        .unwrap()
    else {
        panic!()
    };
    assert!(
        events
            .iter()
            .any(|e| matches!(e, state::RuntimeData::InputAdmitted { .. }))
    );
    let encoded = serde_json::to_string(&state).unwrap();
    assert!(!encoded.contains("fixture capability"));
    let mut reopened: RuntimeState = serde_json::from_str(&encoded).unwrap();
    let (RuntimeResult::Duplicate(duplicate), events) = reopened
        .apply("U:fixture", &records, input(&proof, &stamp, "request"), 104)
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(duplicate.worker, first.worker);
    assert!(events.is_empty());
    assert_eq!(reopened.generation, first.generation);
    reopened
        .apply(
            "U:fixture",
            &records,
            RuntimeOperation::Finish {
                turn_id: first.turn_id,
                generation: first.generation,
                worker: first.worker,
            },
            105,
        )
        .unwrap();
    let next = InputStamp {
        sequence: 2,
        instance_id: Uuid::new_v4(),
        ..stamp.clone()
    };
    let (RuntimeResult::Begun(second), _) = reopened
        .apply(
            "U:fixture",
            &records,
            input(&proof, &next, "another request"),
            106,
        )
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        reopened
            .apply("U:fixture", &records, input(&proof, &stamp, "request"), 107)
            .unwrap()
            .0,
        RuntimeResult::Duplicate(_)
    ));
    assert_eq!(
        reopened.turn.as_ref().unwrap().fence.turn_id,
        second.turn_id
    );
    assert_eq!(reopened.generation, second.generation);
}

#[test]
fn ambiance_ingress_rejects_changed_replays_and_epoch_reset_without_reapproval() {
    let (mut state, mut records, proof, stamp) = fixture();
    state
        .apply("U:fixture", &records, input(&proof, &stamp, "request"), 103)
        .unwrap();
    assert!(matches!(
        state.apply(
            "U:fixture",
            &records,
            input(&proof, &stamp, "changed request"),
            104
        ),
        Err(RuntimeError::Stale)
    ));
    for changed in [
        InputStamp {
            epoch: Uuid::new_v4(),
            ..stamp.clone()
        },
        InputStamp {
            instance_id: Uuid::new_v4(),
            ..stamp.clone()
        },
        InputStamp {
            sequence: 2,
            ..stamp.clone()
        },
    ] {
        assert!(matches!(
            state.apply(
                "U:fixture",
                &records,
                input(&proof, &changed, "request"),
                104
            ),
            Err(RuntimeError::Stale)
        ));
    }
    assert!(matches!(
        state.apply(
            "U:fixture",
            &records,
            RuntimeOperation::OpenBrowser {
                connection: proof.clone(),
                epoch: Uuid::new_v4()
            },
            104
        ),
        Err(RuntimeError::Stale)
    ));
    let next = InputStamp {
        sequence: 2,
        instance_id: Uuid::new_v4(),
        ..stamp.clone()
    };
    assert!(matches!(
        state.apply("U:fixture", &records, input(&proof, &next, "next"), 104),
        Err(RuntimeError::Busy)
    ));
    assert_eq!(state.ingress[&proof.surface_id].high_water, 1);
    records.get_mut(&proof.surface_id).unwrap().revoked = true;
    assert!(matches!(
        state.apply("U:fixture", &records, input(&proof, &stamp, "request"), 105),
        Err(RuntimeError::InvalidOrigin)
    ));
}

#[test]
fn ambiance_ingress_expired_receipt_does_not_reopen_the_sequence_window() {
    let (mut state, mut records, proof, stamp) = fixture();
    state
        .apply("U:fixture", &records, input(&proof, &stamp, "request"), 103)
        .unwrap();
    records.get_mut(&proof.surface_id).unwrap().lease_expires_at = 1_000_000;
    assert!(matches!(
        state.apply(
            "U:fixture",
            &records,
            input(&proof, &stamp, "request"),
            300_104
        ),
        Err(RuntimeError::Stale)
    ));
    assert_eq!(state.ingress[&proof.surface_id].high_water, 1);
}

#[tokio::test]
async fn ambiance_ingress_retried_input_never_calls_cognition_twice() {
    use crate::{
        assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
        store::Store,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    struct Model(AtomicUsize);
    #[tonic::async_trait]
    impl ChatModel for Model {
        async fn complete(
            &self,
            _: &[ChatMessage],
            _: &[ToolDef],
        ) -> Result<ChatResponse, LlmError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(ChatResponse { tool_call: Some(ToolCall {
                name: "propose_information".into(),
                arguments: serde_json::json!({"intent":{"kind":"visual_text_card","text":"Synthetic response"},"privacy":"public"}).to_string(),
            }), ..Default::default() })
        }
    }
    let store = Arc::new(crate::store::MemoryStore::default());
    let model = Arc::new(Model(AtomicUsize::new(0)));
    let runtime = runtime::AmbianceRuntime::new(store.clone(), model.clone(), None);
    let proof = BrowserProof {
        surface_id: Uuid::new_v4(),
        incarnation: Uuid::new_v4(),
        token_hash: hash(b"capability"),
    };
    store
        .mutate_surface(
            "U:fixture",
            proof.surface_id,
            Mutation::Approve {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
            },
        )
        .await
        .unwrap();
    store
        .mutate_surface(
            "U:fixture",
            proof.surface_id,
            Mutation::State {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
                sequence: 1,
                visible: true,
            },
        )
        .await
        .unwrap();
    let stamp = InputStamp {
        epoch: Uuid::new_v4(),
        sequence: 1,
        instance_id: Uuid::new_v4(),
    };
    store
        .runtime(
            "U:fixture",
            RuntimeOperation::OpenBrowser {
                connection: proof.clone(),
                epoch: stamp.epoch,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        runtime
            .sequenced_browser_text(
                "U:fixture",
                proof.clone(),
                stamp.clone(),
                "test request".into()
            )
            .await
            .unwrap(),
        RuntimeResult::Proposed(_)
    ));
    assert!(matches!(
        runtime
            .sequenced_browser_text(
                "U:fixture",
                proof.clone(),
                stamp.clone(),
                "test request".into()
            )
            .await
            .unwrap(),
        RuntimeResult::Duplicate(_)
    ));
    assert_eq!(model.0.load(Ordering::SeqCst), 1);
    assert!(
        runtime
            .sequenced_browser_text("U:fixture", proof, stamp, "changed text".into())
            .await
            .is_err()
    );
    assert_eq!(model.0.load(Ordering::SeqCst), 1);
}
