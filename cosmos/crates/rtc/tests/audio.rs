use cosmos_rtc::{
    Error,
    audio::{self, AudioSession, Binding, FRAME_SAMPLES, QUEUE_FRAMES, Role},
};
use std::time::Duration;
use uuid::Uuid;

#[test]
fn audio_tokens_isolate_incarnations_and_exclude_other_transport_roles() {
    let secret = "s".repeat(32);
    let verifier = livekit_token::TokenVerifier::with_api_key("fixture", &secret);
    let first = audio::tokens("fixture", &secret).unwrap();
    let second = audio::tokens("fixture", &secret).unwrap();
    let runtime = verifier.verify(&first.runtime).unwrap();
    let surface = verifier.verify(&first.surface).unwrap();
    assert_eq!(runtime.sub, "runtime");
    assert_eq!(surface.sub, "surface");
    assert_eq!(runtime.video.room, surface.video.room);
    assert_ne!(
        runtime.video.room,
        verifier.verify(&second.runtime).unwrap().video.room
    );
    for token in [runtime, surface] {
        assert_eq!(token.exp - token.nbf, 60);
        assert!(token.video.room_join && token.video.can_subscribe);
        assert_eq!(token.video.can_publish_sources, ["microphone"]);
        assert!(token.video.can_publish && !token.video.can_publish_data);
        assert!(!token.video.can_update_own_metadata && !token.video.hidden);
        assert!(!token.video.room_admin && !token.video.room_record && !token.video.room_create);
        assert!(!token.video.room_list && !token.video.ingress_admin && !token.video.recorder);
        assert!(!token.sip.admin && !token.sip.call);
    }
}

async fn sessions() -> (AudioSession, AudioSession) {
    let input: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            std::env::var("COSMOS_RTC_AUDIO_TEST_INPUT").expect("isolated SFU fixture required"),
        )
        .unwrap(),
    )
    .unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(
        url.starts_with("ws://127.0.0.1:"),
        "local synthetic fixture only"
    );
    let tokens = audio::tokens(
        input["key"].as_str().unwrap(),
        input["secret"].as_str().unwrap(),
    )
    .unwrap();
    let runtime = AudioSession::connect(url, &tokens.runtime, Role::Runtime)
        .await
        .unwrap();
    let surface = AudioSession::connect(url, &tokens.surface, Role::Surface)
        .await
        .unwrap();
    (runtime, surface)
}

fn tone(index: usize) -> [i16; FRAME_SAMPLES] {
    std::array::from_fn(|offset| {
        let t = (index * FRAME_SAMPLES + offset) as f64 / audio::SAMPLE_RATE as f64;
        (10_000.0 * (t * 440.0 * std::f64::consts::TAU).sin()) as i16
    })
}

// WebRTC attaches a decoded track after its first RTP packets. Prime the
// admitted stream with silence; content starts only after receiver attachment.
async fn attach(surface: &AudioSession, sender: &audio::AudioSender) -> audio::AudioReceiver {
    let subscription = surface.subscribe(sender.binding().clone());
    tokio::pin!(subscription);
    loop {
        tokio::select! { biased;
            receiver = &mut subscription => return receiver.unwrap(),
            _ = tokio::time::sleep(Duration::from_millis(12)) => { let _ = sender.push(&[0; FRAME_SAMPLES]); }
        }
    }
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_AUDIO_TEST_INPUT with an isolated localhost SFU"]
async fn audio_pcm_roundtrip_attribution_interruption_and_new_publication() {
    tokio::time::timeout(Duration::from_secs(35), async {
        let (runtime, surface) = sessions().await;
        let epoch = Uuid::new_v4();
        let mut sender = runtime.publish(epoch, 1).await.unwrap();
        let first = sender.binding().clone();
        let mut receiver = attach(&surface, &sender).await;
        assert_eq!(receiver.binding(), &first);
        assert_eq!(first.track.participant, "runtime");
        assert!(!first.track.participant_sid.is_empty());
        assert_eq!(sender.push(&[0; 479]), Err(Error::Invalid));
        let ((), energy) = tokio::join!(
            async {
                for n in 0..60 {
                    sender.push(&tone(n)).unwrap();
                    tokio::time::sleep(Duration::from_millis(12)).await;
                }
            },
            async {
                let mut energy = 0_u64;
                for _ in 0..60 {
                    let frame = receiver.recv().await.unwrap();
                    energy += frame
                        .iter()
                        .map(|v| i64::from(*v).unsigned_abs())
                        .sum::<u64>();
                }
                energy
            }
        );
        // Opus is lossy; verify actual non-silent audio rather than exact bytes.
        assert!(
            energy > 1_000_000,
            "synthetic tone reached the decoded PCM path"
        );
        receiver.stop().await;
        sender.stop().await.unwrap();
        assert_eq!(sender.push(&tone(0)), Err(Error::Unavailable));
        assert_eq!(receiver.recv().await, Err(Error::Unavailable));
        let mut replacement = runtime.publish(epoch, 2).await.unwrap();
        assert_ne!(replacement.binding().track.track_sid, first.track.track_sid);
        let mut next = attach(&surface, &replacement).await;
        assert_eq!(next.binding().generation, 2);
        let mut wrong = replacement.binding().clone();
        wrong.track.participant = "surface".into();
        assert!(matches!(surface.subscribe(wrong).await, Err(Error::Denied)));
        surface.close().await.unwrap();
        assert_eq!(next.recv().await, Err(Error::Unavailable));
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut connected = runtime.connected();
            while *connected.borrow_and_update() {
                connected.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(replacement.push(&tone(0)), Err(Error::Unavailable));
        next.stop().await;
        let _ = replacement.stop().await;
        assert!(matches!(
            runtime.publish(epoch, 3).await,
            Err(Error::Unavailable)
        ));
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_AUDIO_TEST_INPUT with an isolated localhost SFU"]
async fn audio_queues_are_bounded_and_receive_overflow_retires_generation() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (runtime, surface) = sessions().await;
        let mut sender = runtime.publish(Uuid::new_v4(), 1).await.unwrap();
        // A current-thread task cannot drain between these synchronous calls.
        for _ in 0..QUEUE_FRAMES {
            sender.push(&tone(0)).unwrap();
        }
        assert_eq!(sender.push(&tone(0)), Err(Error::Busy));
        let mut receiver = attach(&surface, &sender).await;
        for n in 0..50 {
            let _ = sender.push(&tone(n));
            tokio::time::sleep(Duration::from_millis(12)).await;
        }
        assert_eq!(receiver.recv().await, Err(Error::Unavailable));
        receiver.stop().await;
        sender.stop().await.unwrap();
        let _ = surface.close().await;
        let _ = runtime.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires COSMOS_RTC_AUDIO_TEST_INPUT with an isolated localhost SFU"]
async fn audio_separate_rooms_have_no_other_client_publications() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let (runtime, surface) = sessions().await;
        let (other_runtime, other_surface) = sessions().await;
        let mut sender = runtime.publish(Uuid::new_v4(), 1).await.unwrap();
        let binding: Binding = sender.binding().clone();
        // Another room has broad subscription permission but cannot see this
        // publication. No administrative or alternate signaling paths are used.
        assert!(matches!(
            other_surface.subscribe(binding.clone()).await,
            Err(Error::Unavailable)
        ));
        let mut receiver = attach(&surface, &sender).await;
        receiver.stop().await;
        sender.stop().await.unwrap();
        let _ = surface.close().await;
        let _ = runtime.close().await;
        let _ = other_surface.close().await;
        let _ = other_runtime.close().await;
    })
    .await
    .unwrap();
}
