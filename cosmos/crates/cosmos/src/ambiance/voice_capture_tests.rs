use super::*;
use crate::{
    ambiance::{PrivacyClass, RuntimeOperation, voice::Policy},
    assistant::llm::{ChatMessage, ChatModel, ChatResponse, LlmError, ToolCall, ToolDef},
    store::Store,
    surface_registry::pin_surface_id,
};
use cosmos_rtc::audio::{AudioSender, AudioSession, Role};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

struct Model {
    calls: AtomicUsize,
    synthetic_case: &'static str,
}
#[tonic::async_trait]
impl ChatModel for Model {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        _: &[ToolDef],
    ) -> Result<ChatResponse, LlmError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(messages.len(), 2);
        let text = messages[1].content.to_lowercase();
        assert!(
            text.contains("planet"),
            "{} synthetic transcript: {text:?}",
            self.synthetic_case
        );
        assert!(
            text.contains("solar") || text.contains("solsystem"),
            "{} synthetic transcript: {text:?}",
            self.synthetic_case
        );
        Ok(ChatResponse { tool_call: Some(ToolCall {
            name: "propose_information".into(),
            arguments: serde_json::json!({"intent":{"kind":"informational_speech","text":"Jupiter is the largest planet."},"privacy":"public"}).to_string(),
        }), ..Default::default() })
    }
}

#[test]
fn ambiance_voice_capture_resampling_output_is_normalized_and_overflow_is_terminal() {
    let mut samples = Vec::new();
    append(&mut samples, &[i16::MIN, -1, 0, 1, i16::MAX]).unwrap();
    assert_eq!(samples[0], -1.0);
    assert_eq!(samples[2], 0.0);
    assert!(samples[4] < 1.0);
    samples.resize(cosmos_stt::MAX_SAMPLES, 0.0);
    assert_eq!(
        append(&mut samples, &[1]).unwrap_err().code(),
        tonic::Code::ResourceExhausted
    );
    assert_eq!(samples.len(), cosmos_stt::MAX_SAMPLES);
}

async fn push(sender: &AudioSender, frame: &[i16; FRAME_SAMPLES]) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match sender.push(frame) {
                Ok(()) => break,
                Err(cosmos_rtc::Error::Busy) => tokio::time::sleep(Duration::from_millis(2)).await,
                Err(error) => panic!("synthetic publication failed: {error:?}"),
            }
        }
    })
    .await
    .unwrap();
}

async fn prime(sender: &AudioSender, mut ready: oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut interval = tokio::time::interval(Duration::from_millis(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! { biased;
                ready = &mut ready => { ready.expect("capture must become ready"); break; },
                _ = interval.tick() => push(sender, &[0; FRAME_SAMPLES]).await,
            }
        }
    })
    .await
    .expect("synthetic zero RTP must attach the pinned decoder");
}

fn fixture_frames(environment: &str) -> Vec<[i16; FRAME_SAMPLES]> {
    let path = std::env::var(environment).expect("explicit synthetic 16kHz f32 fixture required");
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(bytes.len() % 4, 0);
    let samples: Vec<i16> = bytes
        .chunks_exact(4)
        .flat_map(|b| {
            let sample = f32::from_le_bytes(b.try_into().unwrap());
            assert!(sample.is_finite() && sample.abs() <= 1.0);
            let sample = (sample * 32768.0)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            [sample; 3]
        })
        .collect();
    assert!(samples.len() < MAX_SOURCE_SAMPLES - SAMPLE_RATE as usize);
    samples
        .chunks(FRAME_SAMPLES)
        .map(|samples| {
            let mut frame = [0; FRAME_SAMPLES];
            frame[..samples.len()].copy_from_slice(samples);
            frame
        })
        .collect()
}

#[tokio::test]
#[ignore = "requires isolated SFU, pinned local STT model and synthetic English/Danish PCM"]
async fn ambiance_voice_capture_real_sfu_local_recognition_uses_the_admitted_turn() {
    let model_path =
        std::env::var("REVIVAL_STT_TEST_MODEL").expect("external pinned model required");
    let recognizer = LocalRecognizer::load(Path::new(&model_path)).unwrap();
    for (language, input) in [
        (Language::English, Some("REVIVAL_STT_TEST_EN_PCM")),
        (Language::Danish, Some("REVIVAL_STT_TEST_DA_PCM")),
        (Language::English, None),
    ] {
        let model = Arc::new(Model {
            calls: AtomicUsize::new(0),
            synthetic_case: input.unwrap_or("exact_zero"),
        });
        eprintln!("synthetic capture case={}", model.synthetic_case);
        let (runtime, store, _, auth, incarnation) =
            super::super::tests::fixture_model(model.clone()).await;
        let (media, bootstrap) = PinMedia::with_config(
            runtime,
            auth.clone(),
            incarnation,
            super::super::tests::config(),
        )
        .await
        .unwrap();
        let media = Arc::new(media);
        let surface = AudioSession::connect(&bootstrap.url, &bootstrap.token, Role::Surface)
            .await
            .unwrap();
        let mut sender = surface.publish(bootstrap.epoch, 1).await.unwrap();
        let track = sender.binding().track.clone();
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
                    policy: Some(Policy {
                        source_floor: PrivacyClass::SharedRoom,
                    }),
                },
            )
            .await
            .unwrap();
        let stamp = InputStamp {
            epoch: bootstrap.epoch,
            sequence: 1,
            instance_id: uuid::Uuid::new_v4(),
        };
        let request_id = stamp.instance_id;
        let retry_stamp = stamp.clone();
        let retry_track = track.clone();
        let (ready, waiting) = oneshot::channel();
        let (ended, end) = oneshot::channel();
        let task_media = media.clone();
        let task_recognizer = recognizer.clone();
        let task = tokio::spawn(async move {
            task_media
                .capture_voice(stamp, track, language, &task_recognizer, ready, end)
                .await
        });
        prime(&sender, waiting).await;
        let (unused_ready, _) = oneshot::channel();
        let (_unused_end, unused_endpoint) = oneshot::channel();
        assert!(
            media
                .capture_voice(
                    retry_stamp,
                    retry_track,
                    language,
                    &recognizer,
                    unused_ready,
                    unused_endpoint
                )
                .await
                .unwrap()
                .is_none()
        );
        let frames = input
            .map(fixture_frames)
            .unwrap_or_else(|| vec![[0; FRAME_SAMPLES]; 100]);
        let mut interval = tokio::time::interval(Duration::from_millis(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        for frame in frames {
            interval.tick().await;
            push(&sender, &frame).await;
        }
        // Local producer drain is deliberately not asserted as receive proof.
        sender.finish_input().await.unwrap();
        ended.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(35), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .unwrap();
        if input.is_some() {
            let RuntimeResult::Proposed(action) = result else {
                panic!("synthetic speech needs an informational proposal")
            };
            assert_eq!(action.turn_id, request_id);
            assert_eq!(action.privacy, PrivacyClass::SharedRoom);
            assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        } else {
            assert!(matches!(result, RuntimeResult::Cancelled));
            assert_eq!(model.calls.load(Ordering::SeqCst), 0);
        }
        assert_eq!(store.assistant_private_accesses.load(Ordering::SeqCst), 0);
        sender.stop().await.unwrap();
        media.close().await;
        surface.close().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires isolated SFU and pinned local STT model"]
async fn ambiance_voice_capture_endpoint_loss_revocation_source_loss_and_drop_never_reach_cognition()
 {
    let path = std::env::var("REVIVAL_STT_TEST_MODEL").expect("external pinned model required");
    let recognizer = LocalRecognizer::load(Path::new(&path)).unwrap();
    for cause in [
        "endpoint_drop",
        "policy",
        "source",
        "caller",
        "media_close",
        "missing_end",
    ] {
        let model = Arc::new(Model {
            calls: AtomicUsize::new(0),
            synthetic_case: cause,
        });
        let (runtime, store, _, auth, incarnation) =
            super::super::tests::fixture_model(model.clone()).await;
        let (media, bootstrap) = PinMedia::with_config(
            runtime.clone(),
            auth.clone(),
            incarnation,
            super::super::tests::config(),
        )
        .await
        .unwrap();
        let media = Arc::new(media);
        let surface = AudioSession::connect(&bootstrap.url, &bootstrap.token, Role::Surface)
            .await
            .unwrap();
        let mut sender = surface.publish(bootstrap.epoch, 1).await.unwrap();
        let track = sender.binding().track.clone();
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
                    policy: Some(Policy {
                        source_floor: PrivacyClass::SharedRoom,
                    }),
                },
            )
            .await
            .unwrap();
        let stamp = InputStamp {
            epoch: bootstrap.epoch,
            sequence: 1,
            instance_id: uuid::Uuid::new_v4(),
        };
        let (ready, waiting) = oneshot::channel();
        let (ended, end) = oneshot::channel();
        let task_media = media.clone();
        let task_recognizer = recognizer.clone();
        let task_stamp = stamp.clone();
        let task_track = track.clone();
        let task = tokio::spawn(async move {
            task_media
                .capture_voice(
                    task_stamp,
                    task_track,
                    Language::English,
                    &task_recognizer,
                    ready,
                    end,
                )
                .await
        });
        prime(&sender, waiting).await;
        // The Store exposes a duplicate receipt to this trusted fixture, not a
        // second capture owner. Use it to observe exact-fence retirement.
        let RuntimeResult::Duplicate(fence) = store
            .runtime(
                principal,
                RuntimeOperation::BeginVoice {
                    connection: runtime.pin_proof(&auth, incarnation).await.unwrap(),
                    stamp,
                    worker: uuid::Uuid::new_v4(),
                    intake_id: uuid::Uuid::new_v4(),
                    binding: crate::ambiance::voice::Binding {
                        media_owner: media.cleanup.owner,
                        participant_sid: track.participant_sid,
                        track_sid: track.track_sid,
                    },
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        let mut ended = Some(ended);
        match cause {
            "endpoint_drop" => {
                ended.take();
            }
            "policy" => {
                store
                    .runtime(
                        principal,
                        RuntimeOperation::SetVoicePolicy {
                            surface_id: fence.origin_surface,
                            approval_revision: 1,
                            expected_revision: 1,
                            policy: None,
                        },
                    )
                    .await
                    .unwrap();
            }
            "source" => sender.stop().await.unwrap(),
            "caller" => task.abort(),
            "media_close" => media.close().await,
            "missing_end" => {}
            _ => unreachable!(),
        }
        let result = tokio::time::timeout(Duration::from_secs(17), task)
            .await
            .unwrap();
        if cause == "caller" {
            assert!(result.unwrap_err().is_cancelled());
        } else {
            let error = result.unwrap().unwrap_err();
            if cause == "missing_end" {
                assert_eq!(error.code(), tonic::Code::DeadlineExceeded);
            }
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if store
                    .runtime(
                        principal,
                        RuntimeOperation::Inspect {
                            turn_id: fence.turn_id,
                            generation: fence.generation,
                            worker: fence.worker,
                        },
                    )
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(model.calls.load(Ordering::SeqCst), 0, "{cause}");
        drop(ended);
        let _ = sender.stop().await;
        media.close().await;
        surface.close().await.unwrap();
    }
}
