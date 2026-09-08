use super::*;
use crate::state::{ContextWire, Control, PendingRpc, Stamp};
use p256::ecdsa::{Signature, SigningKey, signature::Signer as _};
use serde_json::{Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

const NOW: i64 = 1_788_645_540_000;

struct TestSigner(SigningKey);

impl TestSigner {
    fn new() -> Self {
        let mut scalar = [0; 32];
        scalar[31] = 1;
        Self(SigningKey::from_bytes(&scalar).unwrap())
    }
}

impl Signer for TestSigner {
    fn public_key_sec1(&self) -> Result<[u8; 65], PlatformError> {
        Ok(self
            .0
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .try_into()
            .unwrap())
    }
    fn sign_sha256(&self, message: &[u8]) -> Result<Vec<u8>, PlatformError> {
        let signature: Signature = self.0.sign(message);
        Ok(signature.to_der().as_bytes().to_vec())
    }
}

#[derive(Default)]
struct TestStore {
    bytes: Mutex<Option<Vec<u8>>>,
    writes: Mutex<Vec<Vec<u8>>>,
    fail: AtomicBool,
}

impl SecureStore for TestStore {
    fn load(&self) -> Result<Option<Vec<u8>>, PlatformError> {
        Ok(self.bytes.lock().unwrap().clone())
    }
    fn save_atomically(&self, bytes: &[u8]) -> Result<(), PlatformError> {
        self.writes.lock().unwrap().push(bytes.to_vec());
        if self.fail.load(Ordering::SeqCst) {
            return Err(PlatformError);
        }
        *self.bytes.lock().unwrap() = Some(bytes.to_vec());
        Ok(())
    }
}

fn config() -> Config {
    Config {
        server_origin: "https://center.example.test".into(),
        enrollment_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
        platform: Platform::Macos,
        boot_epoch: Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap(),
    }
}

fn client() -> (Client, Arc<TestStore>) {
    let store = Arc::new(TestStore::default());
    (
        Client::new(config(), Arc::new(TestSigner::new()), store.clone()).unwrap(),
        store,
    )
}

fn open_journal() -> Journal {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../contracts/fixtures/ambiance-native-open-v1.json"
    ))
    .unwrap();
    let challenge: wire::Challenge =
        serde_json::from_value(fixture["cases"][0]["challenge"].clone()).unwrap();
    let request: wire::OpenRequest =
        serde_json::from_value(fixture["cases"][0]["request"].clone()).unwrap();
    let mut journal = Journal::fresh(&config(), &TestSigner::new().public_key_sec1().unwrap());
    journal.surface_id = Some(challenge.surface_id);
    journal.approval_revision = Some(challenge.approval_revision);
    journal.open = Some(PendingOpen {
        challenge,
        request,
        secret: URL_SAFE_NO_PAD.encode([1; 32]),
        created_at_ms: NOW,
        opened_at_ms: None,
        connection: None,
        joined: false,
        runtime_epoch: None,
        lease_until_ms: 0,
    });
    journal
}

fn connected_journal() -> Journal {
    let mut journal = open_journal();
    let open = journal.open.as_mut().unwrap();
    open.opened_at_ms = Some(NOW);
    open.connection = Some(wire::ConnectionView {
        surface_id: open.challenge.surface_id,
        approval_revision: open.challenge.approval_revision,
        incarnation: Uuid::new_v4(),
        epoch: journal.epoch,
        expires_at_ms: NOW + 3_600_000,
        lease_expires_at_ms: NOW + LEASE_MS,
    });
    open.lease_until_ms = NOW + LEASE_MS;
    open.joined = true;
    open.runtime_epoch = Some(Uuid::new_v4());
    journal
}

fn stage(journal: &mut Journal, text: &str, now: i64) -> Result<(), Error> {
    stage_input(journal, text, None, None, now)
}

fn stage_input(
    journal: &mut Journal,
    text: &str,
    target: Option<Platform>,
    context: Option<ScreenContext>,
    now: i64,
) -> Result<(), Error> {
    let message = RpcMessage::Input {
        stamp: Stamp {
            epoch: journal.epoch,
            sequence: journal.sequence + 1,
            instance_id: Uuid::new_v4(),
        },
        text: text.into(),
        target,
        context: context.map(ContextWire::try_from).transpose()?,
    };
    let open = journal.open.as_ref().unwrap();
    journal.stage(
        message,
        now,
        open.runtime_epoch.unwrap(),
        open.connection.as_ref().unwrap().incarnation,
    )
}

#[test]
fn document_context_survives_exact_retry_and_reopen() {
    let document = json!({
        "app": "Preview",
        "locator": {"scheme": "file", "rootId": "documents", "relative": "Notes/Agenda.pdf"},
        "version": "a".repeat(64),
        "position": {"kind": "page", "page": 3},
        "label": "Agenda"
    });
    let mut journal = connected_journal();
    stage_input(
        &mut journal,
        "Explain this and continue on my PC",
        Some(Platform::Linux),
        Some(ScreenContext {
            app: "Preview".into(),
            text: "The selected paragraph".into(),
            document: Some(document.to_string()),
        }),
        NOW,
    )
    .unwrap();
    let before = serde_json::to_vec(&journal.pending.as_ref().unwrap().message).unwrap();
    let mut restored = Journal::load(
        &journal.bytes().unwrap(),
        &config(),
        &TestSigner::new().public_key_sec1().unwrap(),
    )
    .unwrap();
    restored.reconcile(config().boot_epoch, NOW + 1);
    let pending = restored.pending.as_ref().unwrap();
    assert!(pending.retryable(NOW + 1));
    assert_eq!(serde_json::to_vec(&pending.message).unwrap(), before);
    let wire: Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(wire["context"]["document"], document);
    assert_eq!(wire["target"], "linux");
}

#[tokio::test]
async fn invalid_documents_never_consume_a_sequence_or_replace_pending_context() {
    for document in [
        "{".to_owned(),
        "null".into(),
        "[]".into(),
        "42".into(),
        "\"document\"".into(),
        json!({"path": "x".repeat(MAX_DOCUMENT_BYTES)}).to_string(),
        format!("{}{{}}", " ".repeat(MAX_DOCUMENT_BYTES)),
    ] {
        let context = ScreenContext {
            app: "Preview".into(),
            text: "The selected paragraph".into(),
            document: Some(document),
        };
        let mut journal = connected_journal();
        let before = journal.bytes().unwrap();
        assert_eq!(
            stage_input(
                &mut journal,
                "Explain this",
                None,
                Some(context.clone()),
                NOW
            ),
            Err(Error::InvalidInput)
        );
        assert_eq!(journal.bytes().unwrap(), before);
        let (mut client, store) = client();
        let before = client.journal.bytes().unwrap();
        let writes = store.writes.lock().unwrap().len();
        assert_eq!(
            client
                .send_text_with_context("Explain this", context, None)
                .await,
            Err(Error::InvalidInput)
        );
        assert_eq!(client.journal.bytes().unwrap(), before);
        assert_eq!(store.writes.lock().unwrap().len(), writes);
    }
}

#[test]
fn restored_document_context_rejects_null_nonobjects_and_oversized_handles() {
    let mut journal = connected_journal();
    stage_input(
        &mut journal,
        "Explain this",
        None,
        Some(ScreenContext {
            app: "Preview".into(),
            text: "Paragraph".into(),
            document: Some("{}".into()),
        }),
        NOW,
    )
    .unwrap();
    let original: Value = serde_json::from_slice(&journal.bytes().unwrap()).unwrap();
    for invalid in [
        Value::Null,
        json!([]),
        json!("document"),
        json!({"path": "x".repeat(MAX_DOCUMENT_BYTES)}),
    ] {
        let mut value = original.clone();
        value["pending"]["message"]["context"]["document"] = invalid;
        assert!(matches!(
            Journal::load(
                &serde_json::to_vec(&value).unwrap(),
                &config(),
                &TestSigner::new().public_key_sec1().unwrap(),
            ),
            Err(Error::InvalidJournal)
        ));
    }
}

#[test]
fn explicit_target_and_screen_context_are_journaled_exactly_and_bounded() {
    let mut journal = connected_journal();
    stage_input(
        &mut journal,
        "Play trailer for number two",
        Some(Platform::AndroidTv),
        Some(ScreenContext {
            app: "Settings".into(),
            text: "Wi-Fi\nConnected to Home".into(),
            document: None,
        }),
        NOW,
    )
    .unwrap();
    let wire = serde_json::to_value(&journal.pending.as_ref().unwrap().message).unwrap();
    assert_eq!(wire["kind"], "input");
    assert_eq!(wire["text"], "Play trailer for number two");
    assert_eq!(wire["target"], "android_tv");
    assert_eq!(
        wire["context"],
        json!({"kind":"screen","app":"Settings","text":"Wi-Fi\nConnected to Home"})
    );
    assert_eq!(wire.as_object().unwrap().len(), 5);
    // The pending request survives the journal exactly, so an exact retry
    // replays the same target and context.
    let restored = Journal::load(
        &journal.bytes().unwrap(),
        &config(),
        &TestSigner::new().public_key_sec1().unwrap(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&restored.pending.as_ref().unwrap().message).unwrap(),
        wire
    );
    // Plain text serializes exactly as before: no target or context keys.
    let mut plain = connected_journal();
    stage(&mut plain, "plain", NOW).unwrap();
    let plain = serde_json::to_value(&plain.pending.as_ref().unwrap().message).unwrap();
    assert_eq!(plain.as_object().unwrap().len(), 3);
    for (label, context) in [
        (
            "blank app",
            ScreenContext {
                app: " ".into(),
                text: "x".into(),
                document: None,
            },
        ),
        (
            "long app",
            ScreenContext {
                app: "x".repeat(MAX_CONTEXT_APP_BYTES + 1),
                text: "x".into(),
                document: None,
            },
        ),
        (
            "blank text",
            ScreenContext {
                app: "App".into(),
                text: " \n".into(),
                document: None,
            },
        ),
        (
            "long text",
            ScreenContext {
                app: "App".into(),
                text: "x".repeat(MAX_CONTEXT_BYTES + 1),
                document: None,
            },
        ),
        (
            "control text",
            ScreenContext {
                app: "App".into(),
                text: "a\u{0007}b".into(),
                document: None,
            },
        ),
    ] {
        let mut journal = connected_journal();
        let before = journal.bytes().unwrap();
        assert_eq!(
            stage_input(&mut journal, "request", None, Some(context), NOW),
            Err(Error::InvalidInput),
            "{label}"
        );
        assert_eq!(journal.bytes().unwrap(), before, "{label}");
    }
    // Both maxima together still fit the transport envelope, so a full request
    // about a full screen is never refused for its size alone.
    let mut journal = connected_journal();
    stage_input(
        &mut journal,
        &"x".repeat(MAX_TEXT_BYTES),
        None,
        Some(ScreenContext {
            app: "App".into(),
            text: "y".repeat(MAX_CONTEXT_BYTES),
            document: None,
        }),
        NOW,
    )
    .unwrap();
    // JSON escaping is what overruns it: quotation marks in screen text cost
    // two bytes each on the wire, and the message is refused before it claims
    // a durable sequence.
    let mut journal = connected_journal();
    let before = journal.bytes().unwrap();
    assert_eq!(
        stage_input(
            &mut journal,
            &"x".repeat(MAX_TEXT_BYTES),
            None,
            Some(ScreenContext {
                app: "App".into(),
                text: "\"".repeat(MAX_CONTEXT_BYTES),
                document: None,
            }),
            NOW
        ),
        Err(Error::InvalidInput)
    );
    assert_eq!(journal.bytes().unwrap(), before);
    let mut journal = connected_journal();
    stage_input(
        &mut journal,
        "short request",
        None,
        Some(ScreenContext {
            app: "App".into(),
            text: "y".repeat(MAX_CONTEXT_BYTES),
            document: None,
        }),
        NOW,
    )
    .unwrap();
    // A journal with an unknown context kind never loads as a fresh one.
    let mut value: Value = serde_json::from_slice(&journal.bytes().unwrap()).unwrap();
    value["pending"]["message"]["context"]["kind"] = json!("clipboard");
    assert!(
        Journal::load(
            &serde_json::to_vec(&value).unwrap(),
            &config(),
            &TestSigner::new().public_key_sec1().unwrap()
        )
        .is_err()
    );
    assert_eq!(Platform::parse("android_tv"), Some(Platform::AndroidTv));
    assert_eq!(Platform::parse("browser"), None);
    assert_eq!(Platform::AndroidTv.as_str(), "android_tv");
}

fn admission(pending: &PendingRpc) -> Admission {
    Admission {
        turn_id: pending.message.stamp().instance_id,
        generation: 1,
        duplicate: false,
    }
}

#[test]
fn descriptor_is_public_bounded_and_does_not_contain_connection_credentials() {
    let (client, store) = client();
    let value = serde_json::to_value(client.descriptor()).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 4);
    // A fresh enrollment asks the owner to approve the newest profile this
    // build understands; an installation already approved at an earlier one
    // keeps it, because the challenge carries the record's own approval.
    assert_eq!(value["approval"], "native-audience-v6");
    for approval in [
        "native-voice-input-v5",
        "native-device-action-v4",
        "native-shared-speech-v3",
        "native-shared-display-v2",
    ] {
        assert!(crate::wire::known_approval(approval), "{approval}");
    }
    // A rung this build has never heard of is refused, so a newer server
    // cannot talk an older installation into a posture it cannot honour.
    assert!(!crate::wire::known_approval("native-audience-v7"));
    assert!(!crate::wire::known_approval("native-shared-text-v1"));
    assert_eq!(value["platform"], "macos");
    assert!(serde_json::to_vec(&value).unwrap().len() < 1024);
    assert_eq!(store.writes.lock().unwrap().len(), 1);
    assert!(!client.status().connected);
}

#[test]
fn linux_descriptor_requests_tasks_without_changing_other_platforms() {
    for platform in [
        Platform::Macos,
        Platform::Linux,
        Platform::Android,
        Platform::AndroidTv,
    ] {
        let mut config = config();
        config.platform = platform;
        let client = Client::new(
            config,
            Arc::new(TestSigner::new()),
            Arc::new(TestStore::default()),
        )
        .unwrap();
        assert_eq!(
            client.descriptor().approval,
            if platform == Platform::Linux {
                "native-linux-tasks-v7"
            } else {
                "native-audience-v6"
            }
        );
        assert!(wire::known_approval("native-audience-v6"));
        assert!(wire::known_approval("native-linux-tasks-v7"));
    }
}

#[test]
fn invalid_or_unavailable_journal_never_becomes_a_fresh_installation() {
    let store = Arc::new(TestStore::default());
    *store.bytes.lock().unwrap() = Some(b"corrupt journal".to_vec());
    assert!(matches!(
        Client::new(config(), Arc::new(TestSigner::new()), store.clone()),
        Err(Error::InvalidJournal)
    ));
    assert!(store.writes.lock().unwrap().is_empty());
    assert_eq!(store.load().unwrap().unwrap(), b"corrupt journal");
    *store.bytes.lock().unwrap() = None;
    store.fail.store(true, Ordering::SeqCst);
    assert!(matches!(
        Client::new(config(), Arc::new(TestSigner::new()), store.clone()),
        Err(Error::Persistence)
    ));
    assert!(store.load().unwrap().is_none());
    assert_eq!(store.writes.lock().unwrap().len(), 1);
}

#[test]
fn secure_journal_rejects_wrong_binding_corruption_and_omitted_pending_fields() {
    let key = TestSigner::new().public_key_sec1().unwrap();
    let bytes = open_journal().bytes().unwrap();
    Journal::load(&bytes, &config(), &key).unwrap();
    for field in ["origin", "enrollment", "platform", "publicKey"] {
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["binding"][field] = json!("changed");
        assert!(matches!(
            Journal::load(&serde_json::to_vec(&value).unwrap(), &config(), &key),
            Err(Error::InvalidJournal)
        ));
    }
    for field in [
        "open",
        "pending",
        "surfaceId",
        "approvalRevision",
        "lastUnknown",
        "lastAdmission",
        "lastResult",
    ] {
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value.as_object_mut().unwrap().remove(field);
        assert!(
            Journal::load(&serde_json::to_vec(&value).unwrap(), &config(), &key).is_err(),
            "{field}"
        );
    }
    for invalid in [Vec::new(), b"{".to_vec(), vec![b' '; MAX_JOURNAL_BYTES + 1]] {
        assert!(Journal::load(&invalid, &config(), &key).is_err());
    }
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    value["unexpected"] = json!(true);
    assert!(Journal::load(&serde_json::to_vec(&value).unwrap(), &config(), &key).is_err());
}

#[test]
fn superseded_profile_connections_are_dropped_without_losing_the_installation() {
    let key = TestSigner::new().public_key_sec1().unwrap();
    let bytes = open_journal().bytes().unwrap();
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    // A profile this build no longer understands at all. An installation the
    // owner approved at an earlier published profile keeps connecting under
    // it: the challenge carries the record's own approval, so publishing a new
    // one never strands a client that has not been updated.
    value["open"]["challenge"]["approval"] = json!("native-shared-text-v1");
    let restored = Journal::load(&serde_json::to_vec(&value).unwrap(), &config(), &key).unwrap();
    assert!(restored.open.is_none());
    assert!(restored.pending.is_none());
    assert_eq!(restored.surface_id, open_journal().surface_id);
    assert_eq!(
        serde_json::to_value(&restored).unwrap()["binding"],
        serde_json::to_value(open_journal()).unwrap()["binding"]
    );
    // The current profile still resumes exactly.
    assert!(
        Journal::load(&bytes, &config(), &key)
            .unwrap()
            .open
            .is_some()
    );
}

#[test]
fn pending_signed_open_roundtrips_exactly_and_rejects_secret_or_signature_changes() {
    let journal = open_journal();
    let key = TestSigner::new().public_key_sec1().unwrap();
    let bytes = journal.bytes().unwrap();
    let restored = Journal::load(&bytes, &config(), &key).unwrap();
    assert_eq!(restored.bytes().unwrap(), bytes);
    for (field, replacement) in [
        ("secret", json!(URL_SAFE_NO_PAD.encode([2; 32]))),
        ("joined", json!(true)),
        ("openedAtMs", json!(NOW)),
        ("runtimeEpoch", json!(Uuid::new_v4())),
    ] {
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["open"][field] = replacement;
        assert!(
            Journal::load(&serde_json::to_vec(&value).unwrap(), &config(), &key).is_err(),
            "{field}"
        );
    }
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    value["open"]["request"]["signature"] = json!(URL_SAFE_NO_PAD.encode([0; 64]));
    assert!(Journal::load(&serde_json::to_vec(&value).unwrap(), &config(), &key).is_err());
}

#[test]
fn loading_another_boot_preserves_bytes_until_explicit_reconciliation() {
    let mut journal = connected_journal();
    stage(&mut journal, "do not replay this old boot text", NOW).unwrap();
    let bytes = journal.bytes().unwrap();
    let store = Arc::new(TestStore::default());
    *store.bytes.lock().unwrap() = Some(bytes.clone());
    let mut next_config = config();
    next_config.boot_epoch = Uuid::new_v4();
    let client = Client::new(
        next_config.clone(),
        Arc::new(TestSigner::new()),
        store.clone(),
    )
    .unwrap();
    assert_eq!(client.journal.bytes().unwrap(), bytes);
    assert!(store.writes.lock().unwrap().is_empty());
    assert!(!client.status().pending.unwrap().can_retry);
    let instance = journal
        .pending
        .as_ref()
        .unwrap()
        .message
        .stamp()
        .instance_id;
    journal.reconcile(next_config.boot_epoch, NOW + 1);
    assert!(journal.pending.is_none() && journal.open.is_none());
    assert_eq!(journal.sequence, 0);
    assert_eq!(journal.last_unknown.unwrap().instance_id, instance);
    assert!(!journal.last_unknown.unwrap().can_retry);
    assert!(
        !String::from_utf8(journal.bytes().unwrap())
            .unwrap()
            .contains("do not replay")
    );
}

#[test]
fn same_boot_retains_exact_payload_and_cursor_until_receipt_expires() {
    let mut journal = connected_journal();
    stage(&mut journal, "unchanged \"quoted\" request", NOW).unwrap();
    let original = serde_json::to_vec(&journal.pending).unwrap();
    journal.reconcile(journal.epoch, NOW + RECEIPT_MS - 1);
    assert_eq!(serde_json::to_vec(&journal.pending).unwrap(), original);
    assert_eq!(journal.sequence, 1);
    let summary = journal.pending.as_ref().unwrap().summary(NOW);
    journal.reconcile(journal.epoch, NOW + RECEIPT_MS);
    assert!(journal.pending.is_none());
    assert_eq!(journal.sequence, 1);
    assert_eq!(
        journal.last_unknown.unwrap().instance_id,
        summary.instance_id
    );
    assert!(!journal.last_unknown.unwrap().can_retry);
}

#[test]
fn clock_reversal_never_makes_an_old_request_eligible_for_replay() {
    let mut journal = connected_journal();
    stage(&mut journal, "request", NOW).unwrap();
    assert!(!journal.pending.as_ref().unwrap().retryable(NOW - 1));
    journal.reconcile(journal.epoch, NOW - 1);
    assert!(journal.pending.is_none());
    assert_eq!(journal.sequence, 1);
    assert!(journal.last_unknown.is_some());
}

#[test]
fn pending_rpc_roundtrip_preserves_boot_sequence_instance_and_payload() {
    let mut journal = connected_journal();
    stage(&mut journal, "Which actor is this?", NOW).unwrap();
    let before = serde_json::to_vec(&journal.pending.as_ref().unwrap().message).unwrap();
    let restored = Journal::load(
        &journal.bytes().unwrap(),
        &config(),
        &TestSigner::new().public_key_sec1().unwrap(),
    )
    .unwrap();
    assert_eq!(
        before,
        serde_json::to_vec(&restored.pending.as_ref().unwrap().message).unwrap()
    );
    assert_eq!(
        journal.pending.as_ref().unwrap().summary(NOW),
        restored.pending.as_ref().unwrap().summary(NOW)
    );
}

#[test]
fn pending_operation_prevents_new_sequence_allocation() {
    let mut journal = connected_journal();
    stage(&mut journal, "first", NOW).unwrap();
    let before = journal.bytes().unwrap();
    assert_eq!(stage(&mut journal, "second", NOW), Err(Error::Pending));
    assert_eq!(journal.bytes().unwrap(), before);
}

#[test]
fn text_and_serialized_envelope_limits_apply_before_persistence() {
    for invalid in [
        "".into(),
        " \n".into(),
        "x".repeat(MAX_TEXT_BYTES + 1),
        "\u{0001}".repeat(MAX_TEXT_BYTES),
    ] {
        let mut journal = connected_journal();
        let before = journal.bytes().unwrap();
        assert_eq!(stage(&mut journal, &invalid, NOW), Err(Error::InvalidInput));
        assert_eq!(journal.bytes().unwrap(), before);
    }
    let mut journal = connected_journal();
    stage(&mut journal, &"x".repeat(MAX_TEXT_BYTES), NOW).unwrap();
    let mut journal = connected_journal();
    journal.sequence = MAX_SEQUENCE;
    assert_eq!(
        stage(&mut journal, "one too many", NOW),
        Err(Error::InvalidInput)
    );
    assert_eq!(journal.sequence, MAX_SEQUENCE);
}

#[test]
fn text_receipt_requires_exact_kind_version_turn_and_valid_generation() {
    let mut journal = connected_journal();
    stage(&mut journal, "question", NOW).unwrap();
    let pending = journal.pending.as_ref().unwrap();
    let good = json!({"version":1,"kind":"admitted","turnId":pending.message.stamp().instance_id,"generation":7,"duplicate":true});
    let (result, duplicate) = pending.response(&good.to_string()).unwrap();
    assert!(duplicate);
    assert_eq!(
        result,
        OperationResult::Text(Admission {
            turn_id: pending.message.stamp().instance_id,
            generation: 7,
            duplicate: true
        })
    );
    for (field, value) in [
        ("version", json!(2)),
        ("kind", json!("accepted")),
        ("turnId", json!(Uuid::new_v4())),
        ("generation", json!(0)),
        ("generation", json!(MAX_SEQUENCE + 1)),
        ("duplicate", json!("true")),
        ("extra", json!(false)),
    ] {
        let mut reply = good.clone();
        reply[field] = value;
        assert_eq!(
            pending.response(&reply.to_string()),
            Err(Error::InvalidResponse),
            "{field}"
        );
    }
    let mut reply = good;
    reply.as_object_mut().unwrap().remove("duplicate");
    assert!(pending.response(&reply.to_string()).is_err());
    assert!(pending.response(&"x".repeat(1025)).is_err());
}

#[test]
fn controls_require_their_own_reply_and_cancel_stamp_binding() {
    let mut journal = connected_journal();
    stage(&mut journal, "question", NOW).unwrap();
    let mut pending = journal.pending.unwrap();
    let stamp = pending.message.stamp().clone();
    pending.message = RpcMessage::Control {
        stamp: stamp.clone(),
        control: Control::Heartbeat,
    };
    assert_eq!(
        pending
            .response(r#"{"version":1,"kind":"accepted","duplicate":false}"#)
            .unwrap(),
        (OperationResult::Heartbeat, false)
    );
    assert!(pending.response(&json!({"version":1,"kind":"admitted","turnId":stamp.instance_id,"generation":1,"duplicate":false}).to_string()).is_err());
    pending.message = RpcMessage::Control {
        stamp: stamp.clone(),
        control: Control::Cancel {
            turn_id: Uuid::new_v4(),
            generation: 1,
        },
    };
    assert_eq!(pending.message.validate(), Err(Error::InvalidInput));
    pending.message = RpcMessage::Control {
        stamp: stamp.clone(),
        control: Control::Cancel {
            turn_id: stamp.instance_id,
            generation: 0,
        },
    };
    assert_eq!(pending.message.validate(), Err(Error::InvalidInput));
    pending.message = RpcMessage::Control {
        stamp: stamp.clone(),
        control: Control::Cancel {
            turn_id: stamp.instance_id,
            generation: 1,
        },
    };
    pending.message.validate().unwrap();
    assert_eq!(
        pending
            .response(r#"{"version":1,"kind":"accepted","duplicate":true}"#)
            .unwrap(),
        (OperationResult::Cancel, true)
    );
}

#[test]
fn uncertain_secure_save_freezes_exact_candidate_before_any_new_transition() {
    let (mut client, store) = client();
    client.persist(connected_journal()).unwrap();
    let mut next = client.journal.clone();
    stage(
        &mut next,
        "pending securely before any RPC",
        now_ms().unwrap(),
    )
    .unwrap();
    let candidate = next.bytes().unwrap();
    store.fail.store(true, Ordering::SeqCst);
    assert_eq!(client.persist(next), Err(Error::Persistence));
    assert_eq!(client.journal.sequence, 0);
    assert_eq!(client.status().pending.unwrap().sequence, 1);
    assert_eq!(
        client.persist(Journal::fresh(&config(), &client.public_key)),
        Err(Error::Persistence)
    );
    assert_eq!(client.flush(), Err(Error::Persistence));
    let writes = store.writes.lock().unwrap();
    assert_eq!(writes[writes.len() - 1], candidate);
    assert_eq!(writes[writes.len() - 2], candidate);
    drop(writes);
    store.fail.store(false, Ordering::SeqCst);
    assert_eq!(client.flush(), Ok(None));
    assert_eq!(client.journal.bytes().unwrap(), candidate);
    assert_eq!(store.load().unwrap().unwrap(), candidate);
}

#[test]
fn observed_admission_save_failure_retains_pending_and_returns_original_on_retry() {
    let (mut client, store) = client();
    let mut journal = connected_journal();
    stage(&mut journal, "question", NOW).unwrap();
    let admission = admission(journal.pending.as_ref().unwrap());
    client.persist(journal).unwrap();
    let mut completed = client.journal.clone();
    completed.complete(OperationResult::Text(admission));
    store.fail.store(true, Ordering::SeqCst);
    assert_eq!(client.persist(completed), Err(Error::Persistence));
    assert_eq!(
        client.status().pending.unwrap().instance_id,
        admission.turn_id
    );
    assert_eq!(client.status().last_admission, Some(admission));
    store.fail.store(false, Ordering::SeqCst);
    assert_eq!(client.flush(), Ok(Some(OperationResult::Text(admission))));
    assert!(client.status().pending.is_none());
    assert_eq!(client.status().last_admission, Some(admission));
}

#[test]
fn recovered_old_connection_receipt_cannot_create_a_new_cancel() {
    let mut journal = connected_journal();
    stage(&mut journal, "old connection", NOW).unwrap();
    let mut recovered = admission(journal.pending.as_ref().unwrap());
    recovered.duplicate = true;
    journal
        .open
        .as_mut()
        .unwrap()
        .connection
        .as_mut()
        .unwrap()
        .incarnation = Uuid::new_v4();
    journal.complete(OperationResult::Text(recovered));
    assert_eq!(journal.last_result, Some(OperationResult::Text(recovered)));
    assert!(journal.last_admission.is_none());
    assert!(journal.pending.is_none());
}

#[tokio::test]
async fn disconnect_preserves_unknown_rpc_and_clears_cancellable_admission() {
    let (mut client, _) = client();
    let mut journal = connected_journal();
    stage(&mut journal, "unknown request", NOW).unwrap();
    journal.last_admission = Some(admission(journal.pending.as_ref().unwrap()));
    let before = serde_json::to_vec(&journal.pending).unwrap();
    client.persist(journal).unwrap();
    client.disconnect().await.unwrap();
    assert_eq!(serde_json::to_vec(&client.journal.pending).unwrap(), before);
    assert!(client.journal.open.is_none() && client.journal.last_admission.is_none());
    assert_eq!(client.journal.sequence, 1);
}

#[test]
fn token_shape_rejects_media_management_and_mismatched_participant() {
    let participant = Uuid::new_v4();
    let claims = json!({"sub":participant,"video":{"room":"fixture","roomJoin":true,"canPublishData":true,
        "canPublish":false,"canSubscribe":false,"canUpdateOwnMetadata":false}});
    let room = |claims: Value| wire::RoomResponse {
        version: 1,
        url: "wss://center.example.test/livekit".into(),
        token: format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode(b"header"),
            URL_SAFE_NO_PAD.encode(claims.to_string()),
            URL_SAFE_NO_PAD.encode(b"signature")
        ),
        participant,
        runtime_participant: "runtime".into(),
        runtime_epoch: Uuid::new_v4(),
        epoch: config().boot_epoch,
    };
    validate_coordination_token(&room(claims.clone())).unwrap();
    for field in [
        "canPublish",
        "canSubscribe",
        "canUpdateOwnMetadata",
        "roomAdmin",
        "recorder",
        "hidden",
    ] {
        let mut changed = claims.clone();
        changed["video"][field] = json!(true);
        assert_eq!(
            validate_coordination_token(&room(changed)),
            Err(Error::InvalidResponse)
        );
    }
    let mut changed = claims.clone();
    changed["sub"] = json!(Uuid::new_v4());
    assert_eq!(
        validate_coordination_token(&room(changed)),
        Err(Error::InvalidResponse)
    );
    let mut changed = claims;
    changed["sip"] = json!({"admin":true});
    assert_eq!(
        validate_coordination_token(&room(changed)),
        Err(Error::InvalidResponse)
    );
}
