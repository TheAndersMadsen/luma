//! Explicit integration test against a localhost-only, disposable LiveKit room.
use cosmos_rtc::{Error, MAX_PAYLOAD, Session};

#[tokio::test]
#[ignore = "requires COSMOS_RTC_TEST_INPUT with two synthetic room tokens"]
async fn attributed_rpc_roundtrip_bounds_and_shutdown() {
    let file = std::env::var("COSMOS_RTC_TEST_INPUT").expect("isolated LiveKit fixture required");
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(
        url.starts_with("ws://127.0.0.1:"),
        "localhost fixture required"
    );
    let (runtime, mut requests) = Session::connect(url, input["runtime_token"].as_str().unwrap())
        .await
        .unwrap();
    let (surface, mut renders) = Session::connect(url, input["surface_token"].as_str().unwrap())
        .await
        .unwrap();
    let (input_result, ()) = tokio::join!(
        surface.invoke(
            "runtime",
            r#"{"claimedOrigin":"runtime","text":"synthetic"}"#.into()
        ),
        async {
            let call = requests.recv().await.unwrap();
            assert_eq!(call.caller, "surface");
            assert!(call.payload.contains("claimedOrigin"));
            call.reply.send(Ok("admitted".into())).unwrap();
        },
    );
    assert_eq!(input_result.unwrap(), "admitted");
    let (render_result, ()) =
        tokio::join!(runtime.invoke("surface", "synthetic card".into()), async {
            let call = renders.recv().await.unwrap();
            assert_eq!(call.caller, "runtime");
            assert_eq!(call.payload, "synthetic card");
            call.reply.send(Ok("rendered".into())).unwrap();
        },);
    assert_eq!(render_result.unwrap(), "rendered");
    assert_eq!(
        surface.invoke("runtime", "x".repeat(MAX_PAYLOAD + 1)).await,
        Err(Error::Invalid)
    );
    assert!(requests.try_recv().is_err());
    let mut connected = surface.connected();
    surface.close().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while *connected.borrow_and_update() {
            connected.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    runtime.close().await.unwrap();
}

/// Driven by center/verify/browser-room-live.mjs and an actual browser. This
/// proves the SDK/adapter transport boundary, not the Cosmos policy engine.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires isolated SFU configuration and the real browser fixture"]
async fn browser_adapter_native_roundtrip() {
    use std::{io::Write, os::unix::fs::OpenOptionsExt, time::Duration};
    let input: serde_json::Value = serde_json::from_slice(
        &std::fs::read(std::env::var("COSMOS_RTC_BROWSER_TEST_INPUT").unwrap()).unwrap(),
    )
    .unwrap();
    let url = input["url"].as_str().unwrap();
    assert!(url.starts_with("ws://127.0.0.1:"));
    let key = input["key"].as_str().unwrap();
    let secret = input["secret"].as_str().unwrap();
    let name = format!(
        "browser-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let participant = "66666666-6666-6666-6666-666666666666";
    let runtime_token = cosmos_rtc::coordination_token(key, secret, &name, "runtime").unwrap();
    let surface_token = cosmos_rtc::coordination_token(key, secret, &name, participant).unwrap();
    let (runtime, mut requests) = Session::connect(url, &runtime_token).await.unwrap();
    let bootstrap = serde_json::json!({"version":1,"url":url,"token":surface_token,"participant":participant,
        "runtimeParticipant":"runtime","runtimeEpoch":"55555555-5555-5555-5555-555555555555",
        "epoch":"44444444-4444-4444-4444-444444444444"});
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(std::env::var("COSMOS_RTC_BROWSER_TEST_OUTPUT").unwrap())
        .unwrap();
    file.write_all(bootstrap.to_string().as_bytes()).unwrap();
    file.sync_all().unwrap();
    let call = tokio::time::timeout(Duration::from_secs(180), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call.caller, participant);
    assert_eq!(call.payload, "synthetic browser input");
    call.reply.send(Ok("native admission".into())).unwrap();
    assert_eq!(
        runtime
            .invoke(participant, "synthetic native frame".into())
            .await
            .unwrap(),
        "browser receipt"
    );
    runtime.close().await.unwrap();
}
