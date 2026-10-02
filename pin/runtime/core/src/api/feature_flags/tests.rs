use super::*;
use std::sync::Arc;

#[tokio::test(start_paused = true)]
async fn startup_feature_flag_sync_waits_before_polling_the_request() {
    let delivery_tracker = FeatureFlagDeliveryTracker::default();
    let tracker_in_task = delivery_tracker.clone();
    let tracker_in_request = delivery_tracker.clone();
    let requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let requested_in_task = requested.clone();
    let delay = Duration::from_millis(750);
    let task = tokio::spawn(async move {
        request_startup_feature_flag_sync_with(
            &tracker_in_task,
            &[delay],
            Duration::from_millis(100),
            move || {
                let requested = requested_in_task.clone();
                let tracker = tracker_in_request.clone();
                async move {
                    requested.store(true, std::sync::atomic::Ordering::SeqCst);
                    tracker.record_fetch("startup-test".into());
                    true
                }
            },
        )
        .await
    });

    tokio::task::yield_now().await;
    assert!(!requested.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!task.is_finished());

    tokio::time::advance(delay - Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert!(!requested.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!task.is_finished());

    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(task.await.unwrap());
    assert!(requested.load(std::sync::atomic::Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn startup_feature_flag_sync_retries_until_a_fetch_is_observed() {
    let delivery_tracker = FeatureFlagDeliveryTracker::default();
    let tracker_in_request = delivery_tracker.clone();
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let attempts_in_request = attempts.clone();

    let observed = request_startup_feature_flag_sync_with(
        &delivery_tracker,
        &[Duration::from_millis(10), Duration::from_millis(20)],
        Duration::from_millis(5),
        move || {
            let tracker = tracker_in_request.clone();
            let attempts = attempts_in_request.clone();
            async move {
                let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if attempt == 2 {
                    tracker.record_fetch("startup-retry-test".into());
                }
                true
            }
        },
    )
    .await;

    assert!(observed);
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[test]
fn settings_global_bridge_request_is_authenticated_bounded_and_allowlisted() {
    let token = "0123456789abcdef".repeat(4);
    let command = SettingsGlobalCommand::Put {
        key: "humane_clock_enabled".into(),
        value: true,
    };
    let encoded = settings_global_bridge_request(&command, &token).unwrap();
    assert!(encoded.len() <= SETTINGS_GLOBAL_BRIDGE_MAX_LINE_BYTES + 1);
    assert_eq!(encoded.last(), Some(&b'\n'));
    let json: serde_json::Value = serde_json::from_slice(&encoded[..encoded.len() - 1]).unwrap();
    assert_eq!(json["version"], 1);
    assert_eq!(json["token"], token);
    assert_eq!(json["op"], "put");
    assert_eq!(json["key"], "humane_clock_enabled");
    assert_eq!(json["value"], true);

    let ack = settings_global_bridge_request(&SettingsGlobalCommand::FeatureFlagApplyAck, &token)
        .unwrap();
    let ack_json: serde_json::Value = serde_json::from_slice(&ack[..ack.len() - 1]).unwrap();
    assert_eq!(
        ack_json,
        serde_json::json!({
            "version": 1,
            "token": token,
            "op": "feature_flag_ack",
        })
    );

    assert!(settings_global_bridge_request(&command, &"A".repeat(64)).is_err());
    assert!(settings_global_bridge_request(
        &SettingsGlobalCommand::Delete {
            key: "not_allowlisted".into(),
        },
        &token,
    )
    .is_err());
    assert_eq!(
        SETTINGS_GLOBAL_BRIDGE_TOKEN_ENV,
        "PENUMBRA_SETTINGS_GLOBAL_BRIDGE_TOKEN"
    );
    assert_eq!(SETTINGS_GLOBAL_BRIDGE_ADDR, "127.0.0.1:16791");
}

#[test]
fn settings_global_bridge_response_contract_is_operation_specific() {
    let get = SettingsGlobalCommand::Get {
        key: "humane_clock_enabled".into(),
    };
    assert_eq!(
        parse_settings_global_bridge_response(&get, br#"{"version":1,"ok":true,"value":"1"}"#,),
        Ok("1".into()),
    );
    assert_eq!(
        parse_settings_global_bridge_response(&get, br#"{"version":1,"ok":true,"value":null}"#,),
        Ok("null".into()),
    );

    let put = SettingsGlobalCommand::Put {
        key: "humane_clock_enabled".into(),
        value: true,
    };
    assert_eq!(
        parse_settings_global_bridge_response(&put, br#"{"version":1,"ok":true}"#),
        Ok(String::new()),
    );
    for invalid in [
        br#"{"version":1,"ok":true,"value":"1","extra":true}"#.as_slice(),
        br#"{"version":2,"ok":true,"value":"1"}"#.as_slice(),
        br#"{"version":1,"ok":true,"value":1}"#.as_slice(),
        br#"{"version":1,"ok":false}"#.as_slice(),
        br#"[]"#.as_slice(),
    ] {
        assert!(parse_settings_global_bridge_response(&get, invalid).is_err());
    }
    assert!(parse_settings_global_bridge_response(
        &put,
        br#"{"version":1,"ok":false,"error":"unauthorized"}"#,
    )
    .is_err());

    let ack = SettingsGlobalCommand::FeatureFlagApplyAck;
    assert_eq!(
        parse_settings_global_bridge_response(&ack, br#"{"version":1,"ok":true,"receipt":null}"#,),
        Ok("null".into())
    );
    let hash = "a".repeat(64);
    let valid = serde_json::json!({
        "version": 1,
        "ok": true,
        "receipt": {
            "sequence": 7,
            "assignment_set_hash": hash,
            "assignment_count": 8,
            "applied_at_unix_ms": 1_784_000_000_000_u64,
        }
    });
    let parsed = parse_settings_global_bridge_response(
        &ack,
        serde_json::to_string(&valid).unwrap().as_bytes(),
    )
    .unwrap();
    let receipt: FeatureFlagApplyAckReceipt = serde_json::from_str(&parsed).unwrap();
    assert_eq!(receipt.sequence, 7);
    for invalid in [
        serde_json::json!({"version":1,"ok":true}),
        serde_json::json!({"version":1,"ok":true,"receipt":{"sequence":0,"assignment_set_hash":"a".repeat(64),"assignment_count":1,"applied_at_unix_ms":1}}),
        serde_json::json!({"version":1,"ok":true,"receipt":{"sequence":1,"assignment_set_hash":"A".repeat(64),"assignment_count":1,"applied_at_unix_ms":1}}),
        serde_json::json!({"version":1,"ok":true,"receipt":{"sequence":1,"assignment_set_hash":"a".repeat(64),"assignment_count":0,"applied_at_unix_ms":1}}),
        serde_json::json!({"version":1,"ok":true,"receipt":{"sequence":1,"assignment_set_hash":"a".repeat(64),"assignment_count":257,"applied_at_unix_ms":1}}),
        serde_json::json!({"version":1,"ok":true,"receipt":{"sequence":1,"assignment_set_hash":"a".repeat(64),"assignment_count":1,"applied_at_unix_ms":1,"extra":true}}),
    ] {
        assert!(parse_settings_global_bridge_response(
            &ack,
            serde_json::to_string(&invalid).unwrap().as_bytes(),
        )
        .is_err());
    }
}

#[test]
fn feature_value_type_strings_match_api_contract() {
    use crate::feature_flags::FeatureFlagValueType;

    assert_eq!(FeatureFlagValueType::Bool.as_str(), "bool");
    assert_eq!(FeatureFlagValueType::Int.as_str(), "int");
    assert_eq!(FeatureFlagValueType::Float.as_str(), "float");
    assert_eq!(FeatureFlagValueType::String.as_str(), "string");
}
