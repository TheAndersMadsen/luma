use super::*;
use crate::{
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolDef},
    auth::AuthenticationPlane,
    enrollment::{MemoryEnrollmentStore, SharedEnrollmentStore},
    store::{MemoryStore, Store},
    surface_registry::{Mutation, pin_surface_id},
};

struct NoCognition;
#[tonic::async_trait]
impl ChatModel for NoCognition {
    async fn complete(&self, _: &[ChatMessage], _: &[ToolDef]) -> Result<ChatResponse, LlmError> {
        panic!("media membership must never invoke cognition")
    }
}
pub(super) fn config() -> Config {
    let path = std::env::var("COSMOS_RTC_AUDIO_TEST_INPUT").expect("isolated SFU fixture required");
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"));
    Config::new(
        url.into(),
        url.into(),
        input["key"].as_str().unwrap().into(),
        input["secret"].as_str().unwrap().into(),
    )
    .unwrap()
}
async fn fixture() -> (
    Arc<AmbianceRuntime>,
    Arc<MemoryStore>,
    SharedEnrollmentStore,
    AuthenticatedRequest,
    Uuid,
) {
    fixture_model(Arc::new(NoCognition)).await
}
pub(super) async fn fixture_model(
    model: Arc<dyn ChatModel>,
) -> (
    Arc<AmbianceRuntime>,
    Arc<MemoryStore>,
    SharedEnrollmentStore,
    AuthenticatedRequest,
    Uuid,
) {
    let store = Arc::new(MemoryStore::default());
    let pairing: SharedEnrollmentStore = Arc::new(MemoryEnrollmentStore::default());
    let subject = format!("media-fixture-{}", Uuid::new_v4());
    pairing.put_device_account("aabb", &subject).await.unwrap();
    let auth = AuthenticatedRequest {
        principal: cosmos_core::AuthenticatedPrincipal::for_user(&subject).unwrap(),
        device: Some(cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb").unwrap()),
        plane: AuthenticationPlane::Device,
    };
    let id = pin_surface_id(auth.principal.expose_for_authorization(), "aabb");
    store
        .mutate_surface(
            auth.principal.expose_for_authorization(),
            id,
            Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
        )
        .await
        .unwrap();
    let runtime = Arc::new(AmbianceRuntime::new(
        store.clone(),
        model,
        Some(pairing.clone()),
    ));
    let RuntimeResult::PinOpened {
        connection,
        duplicate: false,
    } = runtime
        .open_pin(&auth, 1, Uuid::new_v4(), None)
        .await
        .unwrap()
    else {
        panic!()
    };
    (runtime, store, pairing, auth, connection.incarnation)
}
async fn disconnected(mut connected: watch::Receiver<bool>) {
    tokio::time::timeout(Duration::from_secs(4), async move {
        while *connected.borrow_and_update() {
            connected.changed().await.unwrap();
        }
    })
    .await
    .expect("runtime must retire media without caller polling");
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_AUDIO_TEST_INPUT with an isolated localhost SFU"]
async fn ambiance_pin_media_membership_is_once_per_incarnation_and_revocation_closes_it() {
    let (runtime, store, _, auth, incarnation) = fixture().await;
    let (media, bootstrap) =
        PinMedia::with_config(runtime.clone(), auth.clone(), incarnation, config())
            .await
            .unwrap();
    let surface = AudioSession::connect(&bootstrap.url, &bootstrap.token, Role::Surface)
        .await
        .unwrap();
    assert_eq!(bootstrap.incarnation, incarnation);
    assert!(
        PinMedia::with_config(runtime.clone(), auth.clone(), incarnation, config())
            .await
            .is_err()
    );
    // A losing attach's destructor cannot retire the successful owner's room.
    tokio::time::sleep(Duration::from_millis(400)).await;
    runtime.check_pin(&auth, incarnation).await.unwrap();
    assert!(*media.connected().borrow());
    assert!(*surface.connected().borrow());
    store
        .mutate_surface(
            auth.principal.expose_for_authorization(),
            pin_surface_id(auth.principal.expose_for_authorization(), "aabb"),
            Mutation::RevokePin,
        )
        .await
        .unwrap();
    disconnected(media.connected()).await;
    assert!(runtime.check_pin(&auth, incarnation).await.is_err());
    surface.close().await.unwrap();
    // The self-hosted SFU still accepts an unexpired cached join token. That
    // residual membership must not recreate a runtime room or its authority.
    let cached = AudioSession::connect(&bootstrap.url, &bootstrap.token, Role::Surface)
        .await
        .unwrap();
    assert!(
        PinMedia::with_config(runtime.clone(), auth.clone(), incarnation, config())
            .await
            .is_err()
    );
    assert!(runtime.check_pin(&auth, incarnation).await.is_err());
    assert!(!*media.connected().borrow());
    cached.close().await.unwrap();
    media.close().await;
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_AUDIO_TEST_INPUT with an isolated localhost SFU"]
async fn ambiance_pin_media_repair_requires_new_incarnation_and_pairing_loss_closes_it() {
    let (runtime, _, pairing, auth, incarnation) = fixture().await;
    let (media, _) = PinMedia::with_config(runtime.clone(), auth.clone(), incarnation, config())
        .await
        .unwrap();
    let RuntimeResult::PinOpened {
        connection: next,
        duplicate: false,
    } = runtime
        .open_pin(&auth, 1, Uuid::new_v4(), Some(incarnation))
        .await
        .unwrap()
    else {
        panic!()
    };
    disconnected(media.connected()).await;
    assert!(
        PinMedia::with_config(runtime.clone(), auth.clone(), incarnation, config())
            .await
            .is_err()
    );
    let (replacement, _) =
        PinMedia::with_config(runtime.clone(), auth.clone(), next.incarnation, config())
            .await
            .unwrap();
    media.close().await;
    runtime.check_pin(&auth, next.incarnation).await.unwrap();
    pairing
        .put_device_account("aabb", "other-owner")
        .await
        .unwrap();
    disconnected(replacement.connected()).await;
    replacement.close().await;
}

#[tokio::test]
async fn ambiance_pin_media_failed_signaling_retires_the_committed_grant() {
    let (runtime, _, _, auth, incarnation) = fixture().await;
    let config = Config::new(
        "ws://127.0.0.1:1".into(),
        "ws://127.0.0.1:1".into(),
        "fixture".into(),
        "s".repeat(32),
    )
    .unwrap();
    assert!(
        PinMedia::with_config(runtime.clone(), auth.clone(), incarnation, config)
            .await
            .is_err()
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if runtime.check_pin(&auth, incarnation).await.is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_AUDIO_TEST_INPUT with an isolated localhost SFU"]
async fn ambiance_pin_media_voice_admission_requires_observed_source_and_separate_policy() {
    let (runtime, store, _, auth, incarnation) = fixture().await;
    let (media, bootstrap) =
        PinMedia::with_config(runtime.clone(), auth.clone(), incarnation, config())
            .await
            .unwrap();
    let surface = AudioSession::connect(&bootstrap.url, &bootstrap.token, Role::Surface)
        .await
        .unwrap();
    let mut publisher = surface.publish(bootstrap.epoch, 1).await.unwrap();
    let track = publisher.binding().track.clone();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !media.session.publication_current(&track) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let stamp = crate::ambiance::InputStamp {
        epoch: bootstrap.epoch,
        sequence: 1,
        instance_id: Uuid::new_v4(),
    };
    assert!(
        media
            .begin_local_voice(stamp.clone(), track.clone())
            .await
            .is_err()
    );
    let principal = auth.principal.expose_for_authorization();
    store
        .runtime(
            principal,
            RuntimeOperation::SetVoicePolicy {
                surface_id: pin_surface_id(principal, "aabb"),
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(super::super::voice::Policy {
                    source_floor: crate::ambiance::PrivacyClass::SharedRoom,
                }),
            },
        )
        .await
        .unwrap();
    for field in ["participant", "session", "track"] {
        let mut forged = track.clone();
        match field {
            "participant" => forged.participant = "runtime".into(),
            "session" => forged.participant_sid = "PA_other".into(),
            "track" => forged.track_sid = "TR_other".into(),
            _ => unreachable!(),
        }
        assert!(
            media
                .begin_local_voice(stamp.clone(), forged)
                .await
                .is_err()
        );
    }
    let intake = media
        .begin_local_voice(stamp.clone(), track.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(
        media
            .begin_local_voice(stamp.clone(), track.clone())
            .await
            .unwrap()
            .is_none()
    );
    intake.check().await.unwrap();
    publisher.stop().await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while media.session.publication_current(&track) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(intake.check().await.is_err());
    assert!(
        intake
            .complete("A stale source transcript".into())
            .await
            .is_err()
    );
    assert!(media.begin_local_voice(stamp, track).await.is_err());
    media.close().await;
    surface.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_AUDIO_TEST_INPUT with an isolated localhost SFU"]
async fn ambiance_pin_media_drop_synchronously_retires_retained_voice_intake() {
    let (runtime, store, _, auth, incarnation) = fixture().await;
    let (media, bootstrap) = PinMedia::with_config(runtime, auth.clone(), incarnation, config())
        .await
        .unwrap();
    let surface = AudioSession::connect(&bootstrap.url, &bootstrap.token, Role::Surface)
        .await
        .unwrap();
    let mut publisher = surface.publish(bootstrap.epoch, 1).await.unwrap();
    let track = publisher.binding().track.clone();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !media.session.publication_current(&track) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let principal = auth.principal.expose_for_authorization();
    store
        .runtime(
            principal,
            RuntimeOperation::SetVoicePolicy {
                surface_id: pin_surface_id(principal, "aabb"),
                approval_revision: 1,
                expected_revision: 0,
                policy: Some(super::super::voice::Policy {
                    source_floor: crate::ambiance::PrivacyClass::SharedRoom,
                }),
            },
        )
        .await
        .unwrap();
    let intake = media
        .begin_local_voice(
            crate::ambiance::InputStamp {
                epoch: bootstrap.epoch,
                sequence: 1,
                instance_id: Uuid::new_v4(),
            },
            track,
        )
        .await
        .unwrap()
        .unwrap();
    intake.check().await.unwrap();
    drop(media);
    // No task yield or completed asynchronous cleanup is required for denial.
    assert!(!(intake.source_current)());
    assert!(intake.check().await.is_err());
    assert!(
        intake
            .complete("A dropped media transcript".into())
            .await
            .is_err()
    );
    publisher.stop().await.unwrap();
    surface.close().await.unwrap();
}
