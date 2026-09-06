use super::*;
use serde_json::{Value, json};

const ORIGIN: &str = "https://center.example.test";
const NOW: i64 = 1_788_645_540_000;

type ChallengeMutation = (&'static str, fn(&mut Challenge));
type ConnectionMutation = (&'static str, fn(&mut ConnectionView));

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/ambiance-native-open-v1.json"
    ))
    .unwrap()
}

fn fixture() -> (Challenge, OpenRequest, [u8; 65]) {
    let data = vectors();
    (
        serde_json::from_value(data["cases"][0]["challenge"].clone()).unwrap(),
        serde_json::from_value(data["cases"][0]["request"].clone()).unwrap(),
        URL_SAFE_NO_PAD
            .decode(data["publicKey"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap(),
    )
}

fn connection(challenge: &Challenge, epoch: Uuid) -> ConnectionView {
    ConnectionView {
        surface_id: challenge.surface_id,
        approval_revision: challenge.approval_revision,
        incarnation: Uuid::parse_str("66666666-6666-4666-8666-666666666666").unwrap(),
        epoch,
        expires_at_ms: NOW + CONNECTION_MS,
        lease_expires_at_ms: NOW + LEASE_MS,
    }
}

fn room(epoch: Uuid) -> RoomResponse {
    RoomResponse {
        version: 1,
        url: "wss://center.example.test/livekit".into(),
        token: [b"header".as_slice(), b"payload", b"signature"]
            .map(|part| URL_SAFE_NO_PAD.encode(part))
            .join("."),
        participant: Uuid::parse_str("77777777-7777-4777-8777-777777777777").unwrap(),
        runtime_participant: "runtime".into(),
        runtime_epoch: Uuid::parse_str("88888888-8888-4888-8888-888888888888").unwrap(),
        epoch,
    }
}

#[test]
fn native_signing_matches_independent_transcripts_and_signatures() {
    let data = vectors();
    let (_, _, key) = fixture();
    for case in data["cases"].as_array().unwrap() {
        let challenge: Challenge = serde_json::from_value(case["challenge"].clone()).unwrap();
        let request: OpenRequest = serde_json::from_value(case["request"].clone()).unwrap();
        challenge
            .validate(ORIGIN, challenge.enrollment_id, &key, NOW)
            .unwrap();
        let bytes = signing_message(&challenge, &request).unwrap();
        let hex = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(hex, case["messageHex"].as_str().unwrap());
        assert_eq!(fingerprint(&bytes), case["messageSha256"].as_str().unwrap());
        let signature = URL_SAFE_NO_PAD.decode(&request.signature).unwrap();
        verify_signature(&key, &bytes, &signature).unwrap();

        // Passing a prehash to the ordinary ECDSA API would hash it twice.
        assert!(verify_signature(&key, &Sha256::digest(&bytes), &signature).is_err());
        let mut changed = bytes.clone();
        changed[0] ^= 1;
        assert!(verify_signature(&key, &changed, &signature).is_err());
    }
}

#[test]
fn canonical_origin_rejects_ambiguous_or_non_https_configuration() {
    for (input, expected) in [
        (ORIGIN, ORIGIN),
        ("https://center.example.test/", ORIGIN),
        (
            "https://center.example.test:8443",
            "https://center.example.test:8443",
        ),
        ("https://[::1]:8443/", "https://[::1]:8443"),
    ] {
        assert_eq!(canonical_origin(input).unwrap(), expected);
    }
    for input in [
        "",
        "http://center.example.test",
        "wss://center.example.test",
        "https://CENTER.example.test",
        "https://center.example.test:443",
        "https://center.example.test//",
        "https://center.example.test/path",
        "https://center.example.test/./",
        "https://center.example.test?",
        "https://center.example.test#",
        "https://user@center.example.test",
        "https://@center.example.test",
        "https://center.example.test\\",
        " https://center.example.test",
        "https://center.example.test\n",
        "https://c\tenter.example.test",
        "https://%63enter.example.test",
        "//center.example.test",
    ] {
        assert!(
            matches!(canonical_origin(input), Err(Error::InvalidConfig)),
            "{input:?}"
        );
    }
    assert!(canonical_origin(&format!("https://{}.test", "a".repeat(256))).is_err());
}

#[test]
fn public_key_and_secret_require_the_exact_canonical_encoding() {
    let (_, _, key) = fixture();
    public_key(key).unwrap();
    assert_eq!(
        fingerprint(&key),
        "698bea63dc44a344663ff1429aea10842df27b6b991ef25866b2c6c02cdcc5be"
    );
    let mut wrong_tag = key;
    wrong_tag[0] = 2;
    assert!(public_key(wrong_tag).is_err());
    let mut off_curve = [0; 65];
    off_curve[0] = 4;
    assert!(public_key(off_curve).is_err());
    let secret = URL_SAFE_NO_PAD.encode([0xff; 32]);
    assert_eq!(decode_secret(&secret).unwrap(), [0xff; 32]);
    for value in [
        String::new(),
        format!("{secret}="),
        secret.replace('_', "/"),
        URL_SAFE_NO_PAD.encode([1; 31]),
        URL_SAFE_NO_PAD.encode([1; 33]),
        format!("{}9", &secret[..42]), // nonzero unused trailing bits
        format!("{} ", &secret[..42]),
    ] {
        assert!(decode_secret(&value).is_err());
    }
}

#[test]
fn challenge_rejects_wrong_binding_profile_ids_and_malformed_proof() {
    let (challenge, _, key) = fixture();
    let invalid: &[ChallengeMutation] = &[
        ("version", |c| c.version = 2),
        ("audience", |c| {
            c.audience = "https://elsewhere.example.test".into()
        }),
        ("audience spelling", |c| c.audience.push('/')),
        ("enrollment", |c| c.enrollment_id = Uuid::nil()),
        ("surface", |c| c.surface_id = Uuid::nil()),
        ("challenge", |c| c.challenge_id = Uuid::nil()),
        ("incarnation", |c| c.current_incarnation = Some(Uuid::nil())),
        ("revision zero", |c| c.approval_revision = 0),
        ("revision unsafe", |c| {
            c.approval_revision = MAX_REVISION + 1
        }),
        ("profile", |c| c.approval = "native-private-v1".into()),
        ("fingerprint", |c| c.public_key_fingerprint = "0".repeat(64)),
        ("fingerprint case", |c| {
            c.public_key_fingerprint.make_ascii_uppercase()
        }),
        ("fingerprint length", |c| {
            c.public_key_fingerprint.pop();
        }),
        ("nonce", |c| c.nonce.push('=')),
        ("expiry zero", |c| c.expires_at_ms = 0),
    ];
    for (label, mutate) in invalid {
        let mut changed = challenge.clone();
        mutate(&mut changed);
        assert!(
            changed
                .validate(ORIGIN, challenge.enrollment_id, &key, NOW)
                .is_err(),
            "{label}"
        );
    }
    assert!(challenge.validate(ORIGIN, Uuid::nil(), &key, NOW).is_err());
    let mut wrong_key = key;
    wrong_key[64] ^= 1;
    assert!(
        challenge
            .validate(ORIGIN, challenge.enrollment_id, &wrong_key, NOW)
            .is_err()
    );
}

#[test]
fn challenge_deadline_is_future_bounded_and_overflow_safe() {
    let (challenge, _, key) = fixture();
    for delta in [1, CHALLENGE_MS, CHALLENGE_MS + CLOCK_ALLOWANCE_MS] {
        let mut changed = challenge.clone();
        changed.expires_at_ms = NOW + delta;
        changed
            .validate(ORIGIN, challenge.enrollment_id, &key, NOW)
            .unwrap();
    }
    for expiry in [
        NOW - 1,
        NOW,
        NOW + CHALLENGE_MS + CLOCK_ALLOWANCE_MS + 1,
        i64::MAX,
    ] {
        let mut changed = challenge.clone();
        changed.expires_at_ms = expiry;
        assert!(
            changed
                .validate(ORIGIN, challenge.enrollment_id, &key, NOW)
                .is_err()
        );
    }
    for now in [0, -1, i64::MAX] {
        assert!(
            challenge
                .validate(ORIGIN, challenge.enrollment_id, &key, now)
                .is_err()
        );
    }
}

#[test]
fn signing_binds_request_identity_epoch_cas_and_session_digest() {
    let (challenge, request, key) = fixture();
    let invalid: &[fn(&mut OpenRequest)] = &[
        |r| r.enrollment_id = Uuid::nil(),
        |r| r.challenge_id = Uuid::nil(),
        |r| r.epoch = Uuid::nil(),
        |r| r.expected_incarnation = Some(Uuid::nil()),
        |r| r.expected_incarnation = Some(r.epoch),
        |r| r.session_token_hash.make_ascii_uppercase(),
        |r| r.session_token_hash.push('0'),
    ];
    for mutate in invalid {
        let mut changed = request.clone();
        mutate(&mut changed);
        assert!(signing_message(&challenge, &changed).is_err());
    }
    let signature = URL_SAFE_NO_PAD.decode(&request.signature).unwrap();
    let mut changed = request.clone();
    changed.epoch = challenge.surface_id;
    let bytes = signing_message(&challenge, &changed).unwrap();
    assert!(verify_signature(&key, &bytes, &signature).is_err());
    changed = request.clone();
    changed.session_token_hash = fingerprint(&[9; 32]);
    let bytes = signing_message(&challenge, &changed).unwrap();
    assert!(verify_signature(&key, &bytes, &signature).is_err());
}

#[test]
fn signatures_require_strict_der_and_the_correct_key() {
    let (challenge, request, key) = fixture();
    let message = signing_message(&challenge, &request).unwrap();
    let signature = URL_SAFE_NO_PAD.decode(&request.signature).unwrap();
    let parsed = Signature::from_der(&signature).unwrap();
    let mut trailing = signature.clone();
    trailing.push(0);
    let mut wrong = signature.clone();
    *wrong.last_mut().unwrap() ^= 1;
    for invalid in [
        Vec::new(),
        vec![0; 8],
        vec![0; 73],
        trailing,
        wrong,
        parsed.as_ref().to_vec(),
    ] {
        assert!(matches!(
            verify_signature(&key, &message, &invalid),
            Err(Error::InvalidSignature)
        ));
    }
    assert!(matches!(
        verify_signature(&[0; 65], &message, &signature),
        Err(Error::InvalidSignature)
    ));
}

#[test]
fn wire_requires_nullable_cas_fields_and_rejects_unknown_properties() {
    let (challenge, request, _) = fixture();
    let mut challenge_json = serde_json::to_value(&challenge).unwrap();
    let mut request_json = serde_json::to_value(&request).unwrap();
    assert!(challenge_json["currentIncarnation"].is_null());
    assert!(request_json["expectedIncarnation"].is_null());
    challenge_json
        .as_object_mut()
        .unwrap()
        .remove("currentIncarnation");
    request_json
        .as_object_mut()
        .unwrap()
        .remove("expectedIncarnation");
    assert!(serde_json::from_value::<Challenge>(challenge_json).is_err());
    assert!(serde_json::from_value::<OpenRequest>(request_json).is_err());

    let connection = connection(&challenge, request.epoch);
    let values = [
        serde_json::to_value(&challenge).unwrap(),
        serde_json::to_value(&request).unwrap(),
        serde_json::to_value(&connection).unwrap(),
        json!({ "challenge": challenge }),
        json!({ "connection": connection, "duplicate": false }),
        serde_json::to_value(room(request.epoch)).unwrap(),
    ];
    for (index, mut value) in values.into_iter().enumerate() {
        value["unexpected"] = json!(true);
        let rejected = match index {
            0 => serde_json::from_value::<Challenge>(value).is_err(),
            1 => serde_json::from_value::<OpenRequest>(value).is_err(),
            2 => serde_json::from_value::<ConnectionView>(value).is_err(),
            3 => serde_json::from_value::<ChallengeEnvelope>(value).is_err(),
            4 => serde_json::from_value::<OpenResponse>(value).is_err(),
            5 => serde_json::from_value::<RoomResponse>(value).is_err(),
            _ => unreachable!(),
        };
        assert!(rejected, "schema {index}");
    }
}

#[test]
fn open_response_binds_connection_and_bounds_both_deadlines() {
    let (challenge, request, _) = fixture();
    let valid = connection(&challenge, request.epoch);
    valid.validate(&challenge, request.epoch, NOW).unwrap();
    let invalid: &[ConnectionMutation] = &[
        ("surface", |c| c.surface_id = Uuid::nil()),
        ("other surface", |c| c.surface_id = c.epoch),
        ("revision", |c| c.approval_revision += 1),
        ("revision zero", |c| c.approval_revision = 0),
        ("incarnation", |c| c.incarnation = Uuid::nil()),
        ("epoch", |c| c.epoch = Uuid::nil()),
        ("other epoch", |c| c.epoch = c.surface_id),
        ("expired", |c| c.expires_at_ms = NOW),
        ("expired lease", |c| c.lease_expires_at_ms = NOW),
        ("absolute extension", |c| {
            c.expires_at_ms = NOW + CONNECTION_MS + CLOCK_ALLOWANCE_MS + 1
        }),
        ("lease extension", |c| {
            c.lease_expires_at_ms = NOW + LEASE_MS + CLOCK_ALLOWANCE_MS + 1
        }),
        ("lease beyond absolute", |c| {
            c.expires_at_ms = c.lease_expires_at_ms - 1
        }),
    ];
    for (label, mutate) in invalid {
        let mut changed = valid.clone();
        mutate(&mut changed);
        assert!(
            changed.validate(&challenge, request.epoch, NOW).is_err(),
            "{label}"
        );
    }
    let mut edge = valid.clone();
    edge.expires_at_ms += CLOCK_ALLOWANCE_MS;
    edge.lease_expires_at_ms += CLOCK_ALLOWANCE_MS;
    edge.validate(&challenge, request.epoch, NOW).unwrap();
    edge.expires_at_ms = edge.lease_expires_at_ms;
    edge.validate(&challenge, request.epoch, NOW).unwrap();
    assert!(valid.validate(&challenge, request.epoch, i64::MAX).is_err());
}

#[test]
fn room_allows_only_canonical_wss_paths_on_the_configured_origin() {
    let (_, request, _) = fixture();
    let mut response = room(request.epoch);
    for path in ["/", "/livekit", "/rtc/", "/nested/room"] {
        response.url = format!("wss://center.example.test{path}");
        response.validate(ORIGIN, request.epoch).unwrap();
    }
    for url in [
        "wss://elsewhere.example.test/livekit",
        "ws://center.example.test/livekit",
        "https://center.example.test/livekit",
        "wss://center.example.test:8443/livekit",
        "wss://center.example.test:443/livekit",
        "wss://CENTER.example.test/livekit",
        "wss://user@center.example.test/livekit",
        "wss://@center.example.test/livekit",
        "wss://center.example.test/livekit?token=credential",
        "wss://center.example.test/livekit?",
        "wss://center.example.test/livekit#",
        "wss://center.example.test/a/../livekit",
        "wss://center.example.test\\livekit",
        "wss://center.example.test",
        " wss://center.example.test/livekit",
        "wss://center.example.test/livekit\n",
    ] {
        response.url = url.into();
        assert!(response.validate(ORIGIN, request.epoch).is_err(), "{url:?}");
    }
    response.url = "wss://[::1]:8443/livekit".into();
    response
        .validate("https://[::1]:8443", request.epoch)
        .unwrap();
    response.url = format!("wss://center.example.test/{}", "x".repeat(2048));
    assert!(response.validate(ORIGIN, request.epoch).is_err());
}

#[test]
fn room_rejects_wrong_ids_versions_and_unbounded_or_noncanonical_tokens() {
    let (_, request, _) = fixture();
    let response = room(request.epoch);
    let invalid: &[fn(&mut RoomResponse)] = &[
        |r| r.version = 2,
        |r| r.participant = Uuid::nil(),
        |r| r.runtime_epoch = Uuid::nil(),
        |r| r.epoch = Uuid::nil(),
        |r| r.epoch = r.participant,
        |r| r.runtime_participant = "another-runtime".into(),
    ];
    for mutate in invalid {
        let mut changed = response.clone();
        mutate(&mut changed);
        assert!(changed.validate(ORIGIN, request.epoch).is_err());
    }
    for token in [
        "",
        "YQ.Yg",
        "YQ.Yg.Yw.ZA",
        ".Yg.Yw",
        "YQ..Yw",
        "YQ.Yg.",
        "YQ==.Yg.Yw",
        "YR.Yg.Yw",
        "YQ.Yg./w",
        "YQ.Yg.Y w",
    ] {
        let mut changed = response.clone();
        changed.token = token.into();
        assert!(
            changed.validate(ORIGIN, request.epoch).is_err(),
            "token shape"
        );
    }
    let mut oversized = response;
    oversized.token = format!("{}.Yg.Yw", "YQ".repeat(2048));
    assert!(oversized.validate(ORIGIN, request.epoch).is_err());
}
