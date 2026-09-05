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
