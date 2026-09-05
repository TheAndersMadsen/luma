use super::*;
use std::{fs::OpenOptions, sync::mpsc, time::SystemTime};

#[test]
fn local_stt_input_and_result_bounds_are_fail_closed() {
    for samples in [
        vec![],
        vec![0.0; MAX_SAMPLES + 1],
        vec![f32::NAN],
        vec![f32::INFINITY],
        vec![1.01],
    ] {
        assert!(matches!(Pcm16Mono::new(samples), Err(Error::Input)));
    }
    assert!(Pcm16Mono::new(vec![-1.0, 0.0, 1.0]).is_ok());
    assert!(Pcm16Mono::new(vec![0.0; MAX_SAMPLES]).is_ok());
    assert!(matches!(
        collect_text([Ok("  ")].into_iter()),
        Ok(Recognition::NoMatch)
    ));
    let Recognition::Transcript(text) =
        collect_text([Ok(" Hej "), Ok(" verden. ")].into_iter()).unwrap()
    else {
        panic!("missing transcript")
    };
    assert_eq!(text, "Hej verden.");
    let unicode = "ø".repeat(MAX_TEXT_BYTES / 2 + 1);
    assert!(matches!(
        collect_text([Ok(unicode.as_str())].into_iter()),
        Err(Error::ResultBounds)
    ));
    assert!(matches!(
        collect_text(std::iter::repeat_n(Ok("x"), MAX_SEGMENTS + 1)),
        Err(Error::ResultBounds)
    ));
    assert!(matches!(
        collect_text([Err(Error::ResultBounds)].into_iter()),
        Err(Error::ResultBounds)
    ));
}

#[test]
fn local_stt_model_missing_wrong_size_and_checksum_are_rejected_before_native_load() {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("cosmos-stt-model-{}-{unique}", std::process::id()));
    assert!(matches!(verified_model(&path), Err(Error::ModelFile)));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    assert!(matches!(verified_model(&path), Err(Error::ModelFile)));
    file.set_len(MODEL_BYTES).unwrap();
    assert!(matches!(verified_model(&path), Err(Error::ModelChecksum)));
    drop(file);
    std::fs::remove_file(path).unwrap();
}

async fn wait_for_worker_exit() {
    let deadline = Instant::now() + Duration::from_secs(3);
    while worker_limit().available_permits() == 0 {
        assert!(Instant::now() < deadline, "blocking worker did not exit");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn local_stt_cancellation_deadline_dropped_future_and_busy_keep_worker_bounded() {
    let never = || panic!("inadmissible work ran");
    let cancelled = Cancellation::default();
    cancelled.cancel();
    assert!(matches!(
        bounded_work(
            Instant::now() + Duration::from_secs(1),
            cancelled,
            move |_| never()
        )
        .await,
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        bounded_work(Instant::now(), Cancellation::default(), move |_| never()).await,
        Err(Error::Deadline)
    ));
    assert!(matches!(
        bounded_work(
            Instant::now() + Duration::from_secs(31),
            Cancellation::default(),
            move |_| never()
        )
        .await,
        Err(Error::Deadline)
    ));

    // Fake native work deliberately ignores cancellation and returns a late
    // transcript. Cancellation/drop must neither publish it nor free capacity.
    for mode in ["cancel", "drop", "deadline"] {
        let cancellation = Cancellation::default();
        let held_cancellation = cancellation.clone();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, wait) = mpsc::channel();
        let duration = if mode == "deadline" {
            Duration::from_millis(100)
        } else {
            Duration::from_secs(2)
        };
        let task = tokio::spawn(bounded_work(
            Instant::now() + duration,
            cancellation.clone(),
            move |_| {
                let _ = entered.send(());
                wait.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(Recognition::Transcript("late".into()))
            },
        ));
        started.await.unwrap();
        assert!(matches!(
            bounded_work(
                Instant::now() + Duration::from_secs(1),
                Cancellation::default(),
                move |_| never()
            )
            .await,
            Err(Error::Busy)
        ));
        match mode {
            "cancel" => {
                cancellation.cancel();
                assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
            }
            "drop" => {
                task.abort();
                let Err(error) = task.await else {
                    panic!("dropped task returned a result")
                };
                assert!(error.is_cancelled());
            }
            "deadline" => assert!(matches!(task.await.unwrap(), Err(Error::Deadline))),
            _ => unreachable!(),
        }
        assert!(held_cancellation.is_cancelled());
        assert_eq!(worker_limit().available_permits(), 0);
        release.send(()).unwrap();
        wait_for_worker_exit().await;
    }
    let cancellation = Cancellation::default();
    assert!(matches!(
        bounded_work(
            Instant::now() + Duration::from_secs(1),
            cancellation.clone(),
            |_| Ok(Recognition::NoMatch)
        )
        .await,
        Ok(Recognition::NoMatch)
    ));
    assert!(
        !cancellation.is_cancelled(),
        "success must not mark cancellation"
    );
}

fn fixture_pcm(name: &str) -> Pcm16Mono {
    let path = std::env::var(name).expect("explicit synthetic fixture path is required");
    let bytes = std::fs::read(path).expect("synthetic PCM fixture");
    assert_eq!(bytes.len() % 4, 0);
    Pcm16Mono::new(
        bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect(),
    )
    .unwrap()
}

/// Opt-in acceptance against exact pinned model bytes and explicit nonprivate
/// synthetic English/Danish fixtures. Files are raw mono16k little-endian f32,
/// generated outside the checkout, e.g. with macOS say plus afconvert. Fixture
/// questions ask about the largest planet in our solar system in each language.
#[tokio::test]
#[ignore = "requires verified external model and explicit synthetic speech fixtures"]
async fn pinned_model_acceptance_english_danish_silence_and_native_abort() {
    let model = std::env::var("REVIVAL_STT_TEST_MODEL").expect("external pinned model is required");
    let recognizer = LocalRecognizer::load(Path::new(&model)).unwrap();
    for (language, fixture, words) in [
        (
            Language::English,
            "REVIVAL_STT_TEST_EN_PCM",
            ["planet", "solar"],
        ),
        (
            Language::Danish,
            "REVIVAL_STT_TEST_DA_PCM",
            ["planet", "solsystem"],
        ),
    ] {
        let started = Instant::now();
        let result = recognizer
            .transcribe(
                fixture_pcm(fixture),
                language,
                started + MAX_WORK_TIME,
                Cancellation::default(),
            )
            .await
            .unwrap();
        let Recognition::Transcript(text) = result else {
            panic!("synthetic speech produced no match")
        };
        let normalized = text.to_lowercase();
        assert!(
            words.iter().all(|word| normalized.contains(word)),
            "synthetic language fixture missed expected content words"
        );
        eprintln!(
            "pinned model synthetic {language:?}: accepted in {}ms",
            started.elapsed().as_millis()
        );
    }
    // The exact-zero adapter gate must produce no match. The pinned native
    // model hallucinated on this fixture before that gate; this is neither VAD
    // coverage nor evidence about natural silence, background media or noise.
    assert!(matches!(
        recognizer
            .transcribe(
                Pcm16Mono::new(vec![0.0; SAMPLE_RATE * 2]).unwrap(),
                Language::English,
                Instant::now() + MAX_WORK_TIME,
                Cancellation::default()
            )
            .await
            .unwrap(),
        Recognition::NoMatch
    ));

    // Cancel a real 15s inference after it owns the permit. The callback must
    // actually report an abort, and capacity must return only after native exit.
    let cancellation = Cancellation::default();
    let recognition = recognizer.clone();
    let worker_cancel = cancellation.clone();
    let task = tokio::spawn(async move {
        recognition
            .transcribe(
                Pcm16Mono::new(vec![0.15; MAX_SAMPLES]).unwrap(),
                Language::English,
                Instant::now() + MAX_WORK_TIME,
                worker_cancel,
            )
            .await
    });
    let startup_deadline = Instant::now() + Duration::from_secs(3);
    while worker_limit().available_permits() != 0 {
        assert!(
            Instant::now() < startup_deadline,
            "native worker did not start"
        );
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let cancelled_at = Instant::now();
    cancellation.cancel();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    wait_for_worker_exit().await;
    assert!(
        cancellation.0.native_abort_observed.load(Ordering::Acquire),
        "actual native abort callback was not observed"
    );
    eprintln!(
        "pinned model cooperative abort and worker exit: {}ms",
        cancelled_at.elapsed().as_millis()
    );
    // A fresh decoder after cancellation must still recognize the same fixture.
    let result = recognizer
        .transcribe(
            fixture_pcm("REVIVAL_STT_TEST_EN_PCM"),
            Language::English,
            Instant::now() + MAX_WORK_TIME,
            Cancellation::default(),
        )
        .await
        .unwrap();
    let Recognition::Transcript(text) = result else {
        panic!("fresh decoder produced no match")
    };
    let normalized = text.to_lowercase();
    assert!(
        normalized.contains("planet") && normalized.contains("solar"),
        "fresh decoder missed fixture content after abort"
    );
}
