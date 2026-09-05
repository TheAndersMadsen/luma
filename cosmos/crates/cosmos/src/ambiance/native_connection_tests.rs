use super::*;
use crate::ambiance::{RuntimeOperation, RuntimeResult};
use p256::ecdsa::{SigningKey, signature::Signer};

const AUDIENCE: &str = "https://native.example";
const PRINCIPAL: &str = "U:native-enrollment-test";

#[test]
fn native_enrollment_independent_node_vectors_match_bytes_and_verify_signatures() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../contracts/fixtures/ambiance-native-open-v1.json"
    ))
    .unwrap();
    let public_key = fixture["publicKey"].as_str().unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 2);
    for case in cases {
        let challenge: Challenge = serde_json::from_value(case["challenge"].clone()).unwrap();
        let request: OpenRequest = serde_json::from_value(case["request"].clone()).unwrap();
        let bytes = signing_message(&challenge, &request).unwrap();
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, case["messageHex"].as_str().unwrap());
        assert_eq!(
            surface_registry::hash(&bytes),
            case["messageSha256"].as_str().unwrap()
        );
        assert_eq!(
            verify(public_key, &challenge, &request).unwrap(),
            case["messageSha256"].as_str().unwrap()
        );
    }
}

fn signing_key() -> SigningKey {
    let mut scalar = [0u8; 32];
    scalar[31] = 1;
    SigningKey::from_bytes(&scalar).unwrap()
}

fn fixture() -> (RuntimeState, BTreeMap<Uuid, Record>, Uuid) {
    let enrollment_id = Uuid::from_u128(1);
    let surface_id = surface_registry::native_surface_id(PRINCIPAL, enrollment_id);
    let (record, _) = surface_registry::transition(
        None,
        0,
        surface_id,
        &crate::store::native_test_approval(enrollment_id, 0),
        100,
    )
    .unwrap();
    (
        RuntimeState::default(),
        BTreeMap::from([(surface_id, record)]),
        surface_id,
    )
}

fn challenge(
    state: &mut RuntimeState,
    records: &BTreeMap<Uuid, Record>,
    surface_id: Uuid,
    now: i64,
) -> Challenge {
    let (RuntimeResult::NativeChallenge(challenge), _) = state
        .apply(
            PRINCIPAL,
            records,
            RuntimeOperation::NativeChallenge {
                surface_id,
                enrollment_id: Uuid::from_u128(1),
                audience: AUDIENCE.to_owned(),
                challenge_id: Uuid::from_u128(now as u128 + 100),
                nonce: URL_SAFE_NO_PAD.encode([4u8; 32]),
            },
            now,
        )
        .unwrap()
    else {
        panic!("challenge result")
    };
    challenge
}

fn signed(challenge: &Challenge, epoch: Uuid, token: u8) -> OpenRequest {
    let mut request = OpenRequest {
        enrollment_id: challenge.enrollment_id,
        challenge_id: challenge.challenge_id,
        epoch,
        expected_incarnation: challenge.current_incarnation,
        session_token_hash: surface_registry::hash(&[token; 32]),
        signature: String::new(),
    };
    let signature: Signature = signing_key().sign(&signing_message(challenge, &request).unwrap());
    request.signature = URL_SAFE_NO_PAD.encode(signature.to_der().as_bytes());
    request
}

fn operation(surface_id: Uuid, request: OpenRequest, incarnation: u128) -> RuntimeOperation {
    RuntimeOperation::OpenNative {
        surface_id,
        audience: AUDIENCE.to_owned(),
        request,
        incarnation: Uuid::from_u128(incarnation),
    }
}

#[test]
fn native_enrollment_signing_golden_vector_and_real_crypto_bind_every_field() {
    let public_key = URL_SAFE_NO_PAD.encode(
        signing_key()
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    let challenge = Challenge {
        version: 1,
        audience: AUDIENCE.to_owned(),
        enrollment_id: Uuid::from_u128(1),
        surface_id: Uuid::from_u128(2),
        approval_revision: 7,
        approval: surface_registry::NATIVE_APPROVAL.to_owned(),
        public_key_fingerprint: public_key_fingerprint(&public_key).unwrap(),
        challenge_id: Uuid::from_u128(3),
        nonce: URL_SAFE_NO_PAD.encode([4u8; 32]),
        expires_at_ms: 1_700_000_060_000,
        current_incarnation: Some(Uuid::from_u128(5)),
    };
    let request = signed(&challenge, Uuid::from_u128(4), 6);
    // Independently packed with Python struct/hashlib, not this serializer.
    let expected = concat!(
        "636f736d6f732e6e61746976652e6f70656e2e763100001668747470733a2f2f6e61746976652e6578616d706c65",
        "000000000000000000000000000000010000000000000000000000000000000200000000000000070015",
        "6e61746976652d7368617265642d746578742d7631698bea63dc44a344663ff1429aea10842df27b6b991ef25866b2c6c02cdcc5be",
        "000000000000000000000000000000030404040404040404040404040404040404040404040404040404040404040404",
        "0000018bcfe65260000000000000000000000000000000040100000000000000000000000000000005",
        "e802086ad6a1e16b78352ad7296d2aabd835b1b16dbe951e1135b97c68e29d81",
    );
    let message = signing_message(&challenge, &request).unwrap();
    let encoded: String = message.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(encoded, expected);
    assert_eq!(message.len(), 262);
    assert_eq!(
        verify(&public_key, &challenge, &request).unwrap(),
        "14cc99d31f87cd23deaf9b77cdf63dfb606559b3aa79b9d7feff1b5ecb8e56c6"
    );

    for field in 0..10 {
        let mut altered = challenge.clone();
        match field {
            0 => altered.audience = "https://other.example".into(),
            1 => altered.surface_id = Uuid::from_u128(6),
            2 => altered.approval_revision += 1,
            3 => altered.public_key_fingerprint = "a".repeat(64),
            4 => altered.nonce = URL_SAFE_NO_PAD.encode([5u8; 32]),
            5 => altered.expires_at_ms += 1,
            6 => altered.approval = "native-private".into(),
            7 => altered.enrollment_id = Uuid::from_u128(8),
            8 => altered.challenge_id = Uuid::from_u128(9),
            _ => altered.version = 2,
        }
        assert!(
            verify(&public_key, &altered, &request).is_err(),
            "field {field}"
        );
    }
    for field in 0..4 {
        let mut altered = request.clone();
        match field {
            0 => altered.epoch = Uuid::from_u128(10),
            1 => altered.expected_incarnation = None,
            2 => altered.session_token_hash = "a".repeat(64),
            _ => altered.signature = URL_SAFE_NO_PAD.encode([0u8; 72]),
        }
        assert!(verify(&public_key, &challenge, &altered).is_err());
    }
    let other_key = SigningKey::from_bytes(&[2u8; 32]).unwrap();
    assert!(
        verify(
            &URL_SAFE_NO_PAD.encode(other_key.verifying_key().to_encoded_point(false).as_bytes()),
            &challenge,
            &request
        )
        .is_err()
    );
    for malformed in [
        format!("{public_key}="),
        URL_SAFE_NO_PAD.encode([4u8; 65]),
        URL_SAFE_NO_PAD.encode(
            signing_key()
                .verifying_key()
                .to_encoded_point(true)
                .as_bytes(),
        ),
    ] {
        assert!(validate_public_key(&malformed).is_err());
    }
}

#[test]
fn native_enrollment_retry_reconnect_cas_preserves_sequence_without_renewal() {
    let (mut state, records, id) = fixture();
    let first = challenge(&mut state, &records, id, 100);
    assert_eq!(challenge(&mut state, &records, id, 110), first);
    let request = signed(&first, Uuid::from_u128(2), 6);
    let (
        RuntimeResult::NativeOpened {
            connection,
            duplicate: false,
        },
        _,
    ) = state
        .apply(PRINCIPAL, &records, operation(id, request.clone(), 20), 120)
        .unwrap()
    else {
        panic!("open")
    };
    state.ingress.get_mut(&id).unwrap().high_water = 42;
    let (
        RuntimeResult::NativeOpened {
            connection: replay,
            duplicate: true,
        },
        events,
    ) = state
        .apply(PRINCIPAL, &records, operation(id, request.clone(), 21), 130)
        .unwrap()
    else {
        panic!("retry")
    };
    assert_eq!(replay, connection);
    assert!(events.is_empty());
    let proof = NativeProof {
        surface_id: id,
        incarnation: connection.incarnation,
        token_hash: request.session_token_hash.clone(),
    };
    assert!(state.check_native(&records, &proof, 140).is_ok());

    let next = challenge(&mut state, &records, id, 150);
    assert_eq!(next.current_incarnation, Some(connection.incarnation));
    // Allocating the next challenge does not destroy response-loss recovery.
    assert!(matches!(
        state
            .apply(PRINCIPAL, &records, operation(id, request.clone(), 22), 160)
            .unwrap()
            .0,
        RuntimeResult::NativeOpened {
            duplicate: true,
            ..
        }
    ));
    let next_request = signed(&next, request.epoch, 7);
    let (
        RuntimeResult::NativeOpened {
            connection: next_connection,
            duplicate: false,
        },
        _,
    ) = state
        .apply(PRINCIPAL, &records, operation(id, next_request, 23), 170)
        .unwrap()
    else {
        panic!("reconnect")
    };
    assert_eq!(state.ingress[&id].high_water, 42);
    assert_eq!(state.ingress[&id].incarnation, next_connection.incarnation);
    assert!(state.check_native(&records, &proof, 180).is_err());
    assert!(
        state
            .apply(PRINCIPAL, &records, operation(id, request, 24), 180)
            .is_err()
    );

    let next_boot = challenge(&mut state, &records, id, 190);
    let next_request = signed(&next_boot, Uuid::from_u128(3), 8);
    state
        .apply(PRINCIPAL, &records, operation(id, next_request, 25), 200)
        .unwrap();
    assert_eq!(state.ingress[&id].high_water, 0);
    assert_eq!(state.ingress[&id].epoch, Uuid::from_u128(3));
}

#[test]
fn native_enrollment_expiry_reapproval_and_failed_signature_never_create_authority() {
    let (mut state, mut records, id) = fixture();
    let first = challenge(&mut state, &records, id, 100);
    let request = signed(&first, Uuid::from_u128(2), 6);
    let mut invalid = request.clone();
    invalid.session_token_hash = "b".repeat(64);
    assert!(
        state
            .apply(PRINCIPAL, &records, operation(id, invalid, 20), 120)
            .is_err()
    );
    assert!(state.native_connections[&id].connection.is_none());
    assert_eq!(state.native_connections[&id].pending.as_ref(), Some(&first));
    assert_eq!(state.next_maintenance_ms(&records), first.expires_at_ms);
    assert!(
        state
            .apply(
                PRINCIPAL,
                &records,
                operation(id, request.clone(), 20),
                first.expires_at_ms
            )
            .is_err()
    );
    assert!(state.native_connections[&id].pending.is_none());
    assert_eq!(state.next_maintenance_ms(&records), i64::MAX);

    let second = challenge(&mut state, &records, id, 70_000);
    let second_request = signed(&second, request.epoch, 7);
    let (RuntimeResult::NativeOpened { connection, .. }, _) = state
        .apply(
            PRINCIPAL,
            &records,
            operation(id, second_request.clone(), 21),
            70_100,
        )
        .unwrap()
    else {
        panic!("open")
    };
    let serialized = serde_json::to_vec(&state).unwrap();
    let mut restored: RuntimeState = serde_json::from_slice(&serialized).unwrap();
    assert!(matches!(
        restored
            .apply(
                PRINCIPAL,
                &records,
                operation(id, second_request.clone(), 22),
                70_200
            )
            .unwrap()
            .0,
        RuntimeResult::NativeOpened {
            duplicate: true,
            ..
        }
    ));
    let proof = NativeProof {
        surface_id: id,
        incarnation: connection.incarnation,
        token_hash: second_request.session_token_hash.clone(),
    };
    restored.reconcile(&records, connection.lease_expires_at_ms);
    assert!(
        restored
            .check_native(&records, &proof, connection.lease_expires_at_ms)
            .is_err()
    );
    assert_eq!(restored.next_maintenance_ms(&records), i64::MAX);

    records.get_mut(&id).unwrap().revoked = true;
    records.get_mut(&id).unwrap().revision = 2;
    state.reconcile(&records, 70_300);
    assert!(state.native_connections.is_empty());
    assert!(state.ingress.is_empty());
    records.get_mut(&id).unwrap().revoked = false;
    records.get_mut(&id).unwrap().revision = 3;
    assert!(
        state
            .apply(
                PRINCIPAL,
                &records,
                operation(id, second_request, 23),
                70_400
            )
            .is_err()
    );
    let reapproved = challenge(&mut state, &records, id, 70_500);
    assert_eq!(reapproved.approval_revision, 3);
    assert_eq!(reapproved.current_incarnation, None);
}
