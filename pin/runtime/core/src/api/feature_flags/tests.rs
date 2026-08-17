use super::*;
use crate::config::Config;
use crate::proto::featureflags::feature_flags_service_server::FeatureFlagsService;
use crate::proto::featureflags::DeviceFeatureFlagRequest;
use crate::services::featureflags::FeatureFlagsServiceImpl;
use std::sync::{Arc, Mutex as StdMutex};

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

#[derive(Default)]
struct MockSettingsGlobalCommandRunner {
    values: StdMutex<BTreeMap<String, Option<bool>>>,
    commands: StdMutex<Vec<SettingsGlobalCommand>>,
    fail_next_put_key: StdMutex<Option<String>>,
    ignore_next_put_key: StdMutex<Option<String>>,
    fail_get_key: StdMutex<Option<String>>,
    hang_commands: StdMutex<Vec<SettingsGlobalCommand>>,
    feature_flag_apply_ack: StdMutex<Option<FeatureFlagApplyAckReceipt>>,
    feature_flag_apply_ack_after_write: StdMutex<Option<FeatureFlagApplyAckReceipt>>,
}

#[tonic::async_trait]
impl SettingsGlobalCommandRunner for MockSettingsGlobalCommandRunner {
    async fn run(&self, command: SettingsGlobalCommand) -> Result<String, String> {
        self.commands.lock().unwrap().push(command.clone());
        let should_hang = self.hang_commands.lock().unwrap().contains(&command);
        if should_hang {
            return std::future::pending().await;
        }
        match command {
            SettingsGlobalCommand::Get { key } => {
                if self.fail_get_key.lock().unwrap().as_deref() == Some(key.as_str()) {
                    return Err("mock read failure".into());
                }
                Ok(
                    match self.values.lock().unwrap().get(&key).copied().flatten() {
                        Some(true) => "1".into(),
                        Some(false) => "0".into(),
                        None => "null".into(),
                    },
                )
            }
            SettingsGlobalCommand::Put { key, value } => {
                let should_fail =
                    self.fail_next_put_key.lock().unwrap().as_deref() == Some(key.as_str());
                if should_fail {
                    self.fail_next_put_key.lock().unwrap().take();
                    return Err("mock write failure".into());
                }
                let should_ignore =
                    self.ignore_next_put_key.lock().unwrap().as_deref() == Some(key.as_str());
                if should_ignore {
                    self.ignore_next_put_key.lock().unwrap().take();
                    return Ok(String::new());
                }
                self.values.lock().unwrap().insert(key, Some(value));
                if let Some(receipt) = self
                    .feature_flag_apply_ack_after_write
                    .lock()
                    .unwrap()
                    .take()
                {
                    *self.feature_flag_apply_ack.lock().unwrap() = Some(receipt);
                }
                Ok(String::new())
            }
            SettingsGlobalCommand::Delete { key } => {
                self.values.lock().unwrap().insert(key, None);
                if let Some(receipt) = self
                    .feature_flag_apply_ack_after_write
                    .lock()
                    .unwrap()
                    .take()
                {
                    *self.feature_flag_apply_ack.lock().unwrap() = Some(receipt);
                }
                Ok(String::new())
            }
            SettingsGlobalCommand::FeatureFlagApplyAck => Ok(self
                .feature_flag_apply_ack
                .lock()
                .unwrap()
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .unwrap()
                .unwrap_or_else(|| "null".into())),
        }
    }
}

struct MockFeatureFlagSyncRequester {
    accepted: bool,
    fetch: bool,
    overwrite_latest_after_fetch: bool,
    live_config: Arc<tokio::sync::RwLock<Config>>,
    delivery_tracker: FeatureFlagDeliveryTracker,
    events: Arc<StdMutex<Vec<&'static str>>>,
}

#[tonic::async_trait]
impl FeatureFlagSyncRequester for MockFeatureFlagSyncRequester {
    async fn request_sync(&self) -> bool {
        self.events.lock().unwrap().push("sync");
        if !self.accepted {
            return false;
        }
        if self.fetch {
            let service = FeatureFlagsServiceImpl::new(
                self.live_config.clone(),
                self.delivery_tracker.clone(),
            );
            service
                .get_flags(tonic::Request::new(DeviceFeatureFlagRequest {}))
                .await
                .expect("mock stock fetch should succeed");
            self.events.lock().unwrap().push("fetch");
            if self.overwrite_latest_after_fetch {
                self.delivery_tracker
                    .record_fetch("late-response-for-an-older-snapshot".into());
            }
        }
        true
    }
}

fn default_config() -> Config {
    let dir = tempfile::tempdir().unwrap();
    Config::load(&dir.path().join("missing.toml")).unwrap()
}

fn default_settings_global_reads() -> Vec<SettingsGlobalGateRead> {
    SETTINGS_GLOBAL_FEATURE_GATES
        .iter()
        .map(|spec| SettingsGlobalGateRead {
            key: spec.key,
            label: spec.label,
            default: spec.default,
            writable: spec.writable,
            warning: spec.warning,
            restart_recommended: spec.restart_recommended,
            stored_value: None,
            available: true,
        })
        .collect()
}

#[test]
fn api_values_are_explicitly_tagged() {
    let json = serde_json::to_value(FeatureFlagValueDto::Int(42)).unwrap();
    assert_eq!(json, serde_json::json!({"type": "int", "value": 42}));
}

#[test]
fn update_is_atomic_when_one_value_is_invalid() {
    let mut config = default_config();
    let original = config.feature_flags.clone();
    let body = serde_json::from_value::<UpdateFeatureFlagsRequest>(serde_json::json!({
        "overrides": {
            "vision_actions_enabled": {"type": "bool", "value": true},
            "touchcode_timeout_millis": {"type": "int", "value": 2147483648_i64}
        }
    }))
    .unwrap();

    assert!(apply_updates(&mut config, body.overrides).is_err());
    assert_eq!(config.feature_flags, original);
}

#[test]
fn null_removes_override_and_restores_penumbra_default() {
    let mut config = default_config();
    config.feature_flags.overrides.insert(
        "vision_custom_gesture_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(false),
    );
    let body = serde_json::from_value::<UpdateFeatureFlagsRequest>(serde_json::json!({
        "overrides": {"vision_custom_gesture_enabled": null}
    }))
    .unwrap();
    apply_updates(&mut config, body.overrides).unwrap();

    let delivery_tracker = FeatureFlagDeliveryTracker::default();
    let response = serde_json::to_value(
        feature_flags_response(
            &config,
            None,
            &default_settings_global_reads(),
            &delivery_tracker,
            None,
        )
        .unwrap(),
    )
    .unwrap();
    let vision = response["flags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flag| flag["key"] == "vision_custom_gesture_enabled")
        .unwrap();
    assert_eq!(vision["source"], "penumbra_default");
    assert_eq!(vision["desired_value"]["value"], true);
    assert_eq!(vision["assignment_value"]["value"], true);

    let timeout = response["flags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|flag| flag["key"] == "touchcode_timeout_millis")
        .unwrap();
    assert_eq!(timeout["source"], "firmware_default");
    assert_eq!(timeout["desired_value"]["value"], 5_000);
    assert_eq!(timeout["assignment_value"], serde_json::Value::Null);
}

#[test]
fn response_keeps_settings_global_out_of_cloud_assignments() {
    let delivery_tracker = FeatureFlagDeliveryTracker::default();
    let response = serde_json::to_value(
        feature_flags_response(
            &default_config(),
            None,
            &default_settings_global_reads(),
            &delivery_tracker,
            None,
        )
        .unwrap(),
    )
    .unwrap();
    let flags = response["flags"].as_array().unwrap();
    assert!(!flags
        .iter()
        .any(|flag| flag["key"] == "humane_food_enabled"));
    assert!(response["settings_global_gates"]
        .as_array()
        .unwrap()
        .iter()
        .any(|gate| gate["key"] == "humane_food_enabled"));
    assert_eq!(crate::feature_flags::SETTINGS_GLOBAL_FEATURE_GATES.len(), 6);
}

#[test]
fn delivery_state_reports_only_observed_milestones() {
    let config = default_config();
    let settings_global = default_settings_global_reads();
    let delivery_tracker = FeatureFlagDeliveryTracker::default();
    let assignments = proto_assignments(&config.feature_flags).unwrap();
    let desired_hash = assignment_set_hash(&assignments);
    let old_apply_ack = FeatureFlagApplyAckReceipt {
        sequence: 8,
        assignment_set_hash: desired_hash.clone(),
        assignment_count: u32::try_from(assignments.len()).unwrap(),
        applied_at_unix_ms: 1,
    };

    let persisted = serde_json::to_value(
        feature_flags_response(&config, None, &settings_global, &delivery_tracker, None).unwrap(),
    )
    .unwrap();
    assert_eq!(persisted["delivery"]["state"], "persisted");
    assert_eq!(persisted["delivery"]["grpc_fetch_observed"], false);
    assert_eq!(persisted["delivery"]["stock_cache_verified"], false);

    let old_ack_without_current_fetch = serde_json::to_value(
        feature_flags_response(
            &config,
            None,
            &settings_global,
            &delivery_tracker,
            Some(&old_apply_ack),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        old_ack_without_current_fetch["delivery"]["state"],
        "persisted"
    );
    assert_eq!(
        old_ack_without_current_fetch["delivery"]["stock_cache_verified"],
        false
    );

    let dispatched = serde_json::to_value(
        feature_flags_response(
            &config,
            Some(true),
            &settings_global,
            &delivery_tracker,
            None,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(dispatched["delivery"]["state"], "sync_dispatched");
    assert_eq!(dispatched["delivery"]["grpc_fetch_observed"], false);

    delivery_tracker.record_fetch(desired_hash.clone());
    delivery_tracker.record_fetch("later-response-for-an-older-snapshot".into());
    assert_ne!(
        delivery_tracker.latest_fetch().unwrap().assignment_set_hash,
        desired_hash
    );
    let fetched = serde_json::to_value(
        feature_flags_response(
            &config,
            Some(true),
            &settings_global,
            &delivery_tracker,
            None,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fetched["delivery"]["state"], "grpc_fetched");
    assert_eq!(fetched["delivery"]["desired_assignment_hash"], desired_hash);
    assert_eq!(fetched["delivery"]["grpc_fetch_observed"], true);
    assert!(fetched["delivery"]["last_grpc_fetch_unix_ms"]
        .as_u64()
        .is_some_and(|timestamp| timestamp > 0));
    assert_eq!(fetched["delivery"]["stock_cache_verified"], false);

    let stale_ack_after_current_fetch = serde_json::to_value(
        feature_flags_response(
            &config,
            Some(true),
            &settings_global,
            &delivery_tracker,
            Some(&old_apply_ack),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        stale_ack_after_current_fetch["delivery"]["state"],
        "grpc_fetched"
    );
    assert_eq!(
        stale_ack_after_current_fetch["delivery"]["stock_cache_verified"],
        false
    );

    let apply_ack = FeatureFlagApplyAckReceipt {
        sequence: 9,
        assignment_set_hash: desired_hash,
        assignment_count: u32::try_from(assignments.len()).unwrap(),
        applied_at_unix_ms: delivery_tracker
            .latest_matching_fetch(&assignment_set_hash(&assignments), None)
            .unwrap()
            .fetched_at_unix_ms,
    };
    let applied = serde_json::to_value(
        feature_flags_response(
            &config,
            Some(true),
            &settings_global,
            &delivery_tracker,
            Some(&apply_ack),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(applied["delivery"]["state"], "stock_cache_applied");
    assert_eq!(applied["delivery"]["stock_cache_verified"], true);
    assert_eq!(
        applied["delivery"]["last_stock_cache_apply_unix_ms"],
        apply_ack.applied_at_unix_ms
    );
}

#[test]
fn locked_keys_can_only_clear_legacy_overrides_and_unknown_resets_fail() {
    for key in [
        "feature_flag_suppress_sync_on_startup",
        "accessory_feature_flags",
        "laser_finding_guide",
        "server_side_speech_synthesis_voice_name",
    ] {
        let mut config = default_config();
        config.feature_flags.overrides.insert(
            key.to_string(),
            feature_flag_spec(key)
                .unwrap()
                .firmware_default
                .to_configured(),
        );
        let body = serde_json::from_value::<UpdateFeatureFlagsRequest>(serde_json::json!({
            "overrides": {key: null}
        }))
        .unwrap();
        apply_updates(&mut config, body.overrides).unwrap();
        assert!(!config.feature_flags.overrides.contains_key(key));

        let body = UpdateFeatureFlagsRequest {
            overrides: BTreeMap::from([(
                key.to_string(),
                Some(FeatureFlagValueDto::from(
                    feature_flag_spec(key).unwrap().firmware_default,
                )),
            )]),
            settings_global: BTreeMap::new(),
        };
        assert!(apply_updates(&mut default_config(), body.overrides).is_err());
    }

    let body = serde_json::from_value::<UpdateFeatureFlagsRequest>(serde_json::json!({
        "overrides": {"made_up": null}
    }))
    .unwrap();
    assert!(apply_updates(&mut default_config(), body.overrides).is_err());
}

#[test]
fn settings_global_parser_accepts_only_boolean_integer_representations() {
    for (input, expected) in [
        ("null", None),
        ("", None),
        ("0", Some(false)),
        ("false", Some(false)),
        ("1", Some(true)),
        ("true", Some(true)),
    ] {
        assert_eq!(parse_settings_global_value(input), Ok(expected));
    }
    for invalid in ["2", "yes", "-1", "enabled"] {
        assert!(parse_settings_global_value(invalid).is_err());
    }
}

#[tokio::test]
async fn settings_global_reads_exact_allowlist_and_reports_current_values() {
    let runner = MockSettingsGlobalCommandRunner::default();
    runner
        .values
        .lock()
        .unwrap()
        .insert("humane_food_enabled".into(), Some(true));

    let reads = read_settings_global_gates(&runner).await;
    assert_eq!(reads.len(), SETTINGS_GLOBAL_FEATURE_GATES.len());
    assert!(reads.iter().all(|read| read.available));
    let food = reads
        .iter()
        .find(|read| read.key == "humane_food_enabled")
        .unwrap()
        .response();
    assert_eq!(food.stored_value, Some(true));
    assert_eq!(food.current_value, Some(true));
    assert_eq!(food.source, "stored");
    assert!(food.restart_recommended);

    let commands = runner.commands.lock().unwrap();
    assert_eq!(commands.len(), SETTINGS_GLOBAL_FEATURE_GATES.len());
    assert!(commands.iter().all(|command| matches!(command, SettingsGlobalCommand::Get { key } if settings_global_feature_gate_spec(key).is_some())));
}

#[tokio::test]
async fn food_runtime_refresh_publishes_only_fresh_canonical_readback() {
    let runner = MockSettingsGlobalCommandRunner::default();
    let gate = FoodRuntimeGate::default();
    runner
        .values
        .lock()
        .unwrap()
        .insert(FOOD_SETTINGS_GLOBAL_KEY.into(), Some(true));

    assert!(refresh_food_runtime_gate_with_runner(&gate, &runner).await);
    let old_permit = gate.permit().expect("fresh true readback");

    *runner.fail_get_key.lock().unwrap() = Some(FOOD_SETTINGS_GLOBAL_KEY.into());
    assert!(!refresh_food_runtime_gate_with_runner(&gate, &runner).await);
    assert!(!gate.permit_is_current(old_permit));
    assert!(gate.permit().is_none());

    *runner.fail_get_key.lock().unwrap() = None;
    runner
        .values
        .lock()
        .unwrap()
        .insert(FOOD_SETTINGS_GLOBAL_KEY.into(), None);
    assert!(refresh_food_runtime_gate_with_runner(&gate, &runner).await);
    assert!(
        gate.permit().is_none(),
        "deleted key must resolve to default false"
    );
}

#[tokio::test]
async fn food_api_mutation_invalidates_before_write_and_publishes_verified_readback() {
    let runner = MockSettingsGlobalCommandRunner::default();
    let gate = FoodRuntimeGate::default();
    gate.enable_for_test();
    let old_permit = gate.permit().unwrap();
    let patch = BTreeMap::from([(FOOD_SETTINGS_GLOBAL_KEY.into(), Some(false))]);

    let mutation = gate.begin_mutation();
    assert!(!gate.permit_is_current(old_permit));
    let reads = read_settings_global_gates(&runner).await;
    apply_settings_global_updates(&runner, &patch, &reads, None)
        .await
        .unwrap();
    let committed = read_settings_global_gates(&runner).await;
    mutation.publish(effective_food_gate_readback(&committed));
    assert!(gate.permit().is_none());

    let enable = BTreeMap::from([(FOOD_SETTINGS_GLOBAL_KEY.into(), Some(true))]);
    let mutation = gate.begin_mutation();
    let reads = read_settings_global_gates(&runner).await;
    apply_settings_global_updates(&runner, &enable, &reads, None)
        .await
        .unwrap();
    let committed = read_settings_global_gates(&runner).await;
    mutation.publish(effective_food_gate_readback(&committed));
    assert!(gate.permit().is_some());
}

#[tokio::test]
async fn weather_unit_sync_uses_only_the_private_boolean_selector() {
    let runner = MockSettingsGlobalCommandRunner::default();

    sync_weather_temperature_unit_with_runner(&runner, TemperatureUnit::Celsius)
        .await
        .unwrap();
    sync_weather_temperature_unit_with_runner(&runner, TemperatureUnit::Fahrenheit)
        .await
        .unwrap();

    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        &[
            SettingsGlobalCommand::Put {
                key: WEATHER_CELSIUS_SETTING_KEY.into(),
                value: true,
            },
            SettingsGlobalCommand::Put {
                key: WEATHER_CELSIUS_SETTING_KEY.into(),
                value: false,
            },
        ],
    );
    assert!(settings_global_feature_gate_spec(WEATHER_CELSIUS_SETTING_KEY).is_none());
    assert!(settings_global_bridge_key_allowed(
        WEATHER_CELSIUS_SETTING_KEY
    ));
}

#[tokio::test]
async fn settings_global_apply_changes_only_requested_different_keys() {
    let runner = MockSettingsGlobalCommandRunner::default();
    runner
        .values
        .lock()
        .unwrap()
        .insert("humane_photo_sharing_enabled".into(), Some(false));
    let reads = read_settings_global_gates(&runner).await;
    runner.commands.lock().unwrap().clear();
    let patch = BTreeMap::from([
        ("humane_food_enabled".into(), Some(true)),
        ("humane_photo_sharing_enabled".into(), Some(false)),
    ]);

    assert!(apply_settings_global_updates(&runner, &patch, &reads, None)
        .await
        .unwrap());
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        &[
            SettingsGlobalCommand::Put {
                key: "humane_food_enabled".into(),
                value: true,
            },
            SettingsGlobalCommand::Get {
                key: "humane_food_enabled".into(),
            },
            SettingsGlobalCommand::Get {
                key: "humane_photo_sharing_enabled".into(),
            },
        ]
    );
}

#[tokio::test]
async fn settings_global_apply_requires_readback_acknowledgement() {
    let runner = MockSettingsGlobalCommandRunner::default();
    let reads = read_settings_global_gates(&runner).await;
    runner.commands.lock().unwrap().clear();
    *runner.ignore_next_put_key.lock().unwrap() = Some("humane_food_enabled".into());
    let patch = BTreeMap::from([("humane_food_enabled".into(), Some(true))]);

    let failure = apply_settings_global_updates(&runner, &patch, &reads, None)
        .await
        .unwrap_err();

    assert_eq!(
        failure.failures,
        vec![SettingsGlobalOperationFailure {
            key: "humane_food_enabled".into(),
            operation: "verify",
        }]
    );
    assert!(failure.rollback_failures.is_empty());
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        &[
            SettingsGlobalCommand::Put {
                key: "humane_food_enabled".into(),
                value: true,
            },
            SettingsGlobalCommand::Get {
                key: "humane_food_enabled".into(),
            },
            SettingsGlobalCommand::Delete {
                key: "humane_food_enabled".into(),
            },
        ]
    );
}

#[tokio::test]
async fn settings_global_apply_rolls_back_earlier_writes_after_failure() {
    let runner = MockSettingsGlobalCommandRunner::default();
    runner.values.lock().unwrap().extend([
        ("humane_photo_sharing_enabled".into(), Some(false)),
        ("humane_photography_jpg_enabled".into(), Some(true)),
    ]);
    let reads = read_settings_global_gates(&runner).await;
    *runner.fail_next_put_key.lock().unwrap() = Some("humane_photography_jpg_enabled".into());
    let patch = BTreeMap::from([
        ("humane_photo_sharing_enabled".into(), Some(true)),
        ("humane_photography_jpg_enabled".into(), Some(false)),
    ]);

    let failure = apply_settings_global_updates(&runner, &patch, &reads, None)
        .await
        .unwrap_err();
    assert_eq!(
        failure.failures,
        vec![SettingsGlobalOperationFailure {
            key: "humane_photography_jpg_enabled".into(),
            operation: "apply",
        }]
    );
    assert!(failure.rollback_failures.is_empty());
    let values = runner.values.lock().unwrap();
    assert_eq!(
        values.get("humane_photo_sharing_enabled"),
        Some(&Some(false))
    );
    assert_eq!(
        values.get("humane_photography_jpg_enabled"),
        Some(&Some(true))
    );
}

#[tokio::test]
async fn dependent_gate_rolls_back_if_stock_cache_identity_changes_during_apply() {
    let runner = MockSettingsGlobalCommandRunner::default();
    runner
        .values
        .lock()
        .unwrap()
        .insert("humane_cmu_ultra_enabled".into(), Some(false));
    let expected = FeatureFlagApplyAckReceipt {
        sequence: 7,
        assignment_set_hash: "a".repeat(64),
        assignment_count: 8,
        applied_at_unix_ms: 1,
    };
    *runner.feature_flag_apply_ack.lock().unwrap() = Some(expected.clone());
    *runner.feature_flag_apply_ack_after_write.lock().unwrap() = Some(FeatureFlagApplyAckReceipt {
        sequence: 8,
        assignment_set_hash: "b".repeat(64),
        assignment_count: 8,
        applied_at_unix_ms: 2,
    });
    let reads = read_settings_global_gates(&runner).await;
    runner.commands.lock().unwrap().clear();
    let patch = BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(true))]);

    let failure = apply_settings_global_updates(&runner, &patch, &reads, Some(&expected))
        .await
        .unwrap_err();

    assert_eq!(
        failure.failures,
        vec![SettingsGlobalOperationFailure {
            key: "humane_cmu_ultra_enabled".into(),
            operation: "cache_guard",
        }]
    );
    assert!(failure.rollback_failures.is_empty());
    assert_eq!(
        runner
            .values
            .lock()
            .unwrap()
            .get("humane_cmu_ultra_enabled"),
        Some(&Some(false)),
    );
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        &[
            SettingsGlobalCommand::FeatureFlagApplyAck,
            SettingsGlobalCommand::Put {
                key: "humane_cmu_ultra_enabled".into(),
                value: true,
            },
            SettingsGlobalCommand::Get {
                key: "humane_cmu_ultra_enabled".into(),
            },
            SettingsGlobalCommand::FeatureFlagApplyAck,
            SettingsGlobalCommand::Put {
                key: "humane_cmu_ultra_enabled".into(),
                value: false,
            },
        ],
    );
}

#[tokio::test]
async fn dependent_gate_is_never_written_when_stock_cache_guard_is_already_stale() {
    let runner = MockSettingsGlobalCommandRunner::default();
    runner
        .values
        .lock()
        .unwrap()
        .insert("humane_cmu_ultra_enabled".into(), Some(false));
    let expected = FeatureFlagApplyAckReceipt {
        sequence: 7,
        assignment_set_hash: "a".repeat(64),
        assignment_count: 8,
        applied_at_unix_ms: 1,
    };
    *runner.feature_flag_apply_ack.lock().unwrap() = Some(FeatureFlagApplyAckReceipt {
        sequence: 8,
        assignment_set_hash: "b".repeat(64),
        assignment_count: 8,
        applied_at_unix_ms: 2,
    });
    let reads = read_settings_global_gates(&runner).await;
    runner.commands.lock().unwrap().clear();
    let patch = BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(true))]);

    let failure = apply_settings_global_updates(&runner, &patch, &reads, Some(&expected))
        .await
        .unwrap_err();

    assert_eq!(failure.failures[0].operation, "cache_guard");
    assert_eq!(
        runner
            .values
            .lock()
            .unwrap()
            .get("humane_cmu_ultra_enabled"),
        Some(&Some(false)),
    );
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        &[SettingsGlobalCommand::FeatureFlagApplyAck],
    );
}

#[tokio::test]
async fn settings_global_read_failure_prevents_every_write() {
    let runner = MockSettingsGlobalCommandRunner::default();
    *runner.fail_get_key.lock().unwrap() = Some("humane_food_enabled".into());
    let reads = read_settings_global_gates(&runner).await;
    runner.commands.lock().unwrap().clear();
    let patch = BTreeMap::from([("humane_food_enabled".into(), Some(true))]);

    let failure = apply_settings_global_updates(&runner, &patch, &reads, None)
        .await
        .unwrap_err();
    assert_eq!(failure.failures[0].operation, "read");
    assert!(runner.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn feature_flag_get_finishes_when_every_gate_read_hangs() {
    let runner = MockSettingsGlobalCommandRunner::default();
    runner
        .hang_commands
        .lock()
        .unwrap()
        .extend(
            SETTINGS_GLOBAL_FEATURE_GATES
                .iter()
                .map(|spec| SettingsGlobalCommand::Get {
                    key: spec.key.to_string(),
                }),
        );

    let reads = tokio::time::timeout(Duration::from_secs(1), read_settings_global_gates(&runner))
        .await
        .expect("bounded gate reads must finish");

    assert_eq!(reads.len(), SETTINGS_GLOBAL_FEATURE_GATES.len());
    assert!(reads.iter().all(|read| !read.available));
    let response = serde_json::to_value(
        feature_flags_response(
            &default_config(),
            None,
            &reads,
            &FeatureFlagDeliveryTracker::default(),
            None,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(response["settings_global_gates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|gate| gate["available"] == false
            && gate["error"] == "Unable to read this Settings.Global gate."));
}

#[tokio::test]
async fn timed_out_apply_and_rollback_return_a_safe_generic_failure() {
    let runner = MockSettingsGlobalCommandRunner::default();
    runner.hang_commands.lock().unwrap().extend([
        SettingsGlobalCommand::Put {
            key: "humane_food_enabled".into(),
            value: true,
        },
        SettingsGlobalCommand::Delete {
            key: "humane_food_enabled".into(),
        },
    ]);
    let patch = BTreeMap::from([("humane_food_enabled".into(), Some(true))]);

    let failure = tokio::time::timeout(
        Duration::from_secs(1),
        apply_settings_global_updates(&runner, &patch, &default_settings_global_reads(), None),
    )
    .await
    .expect("bounded apply and rollback must finish")
    .unwrap_err();

    assert_eq!(
        failure.failures,
        vec![SettingsGlobalOperationFailure {
            key: "humane_food_enabled".into(),
            operation: "apply",
        }]
    );
    assert_eq!(
        failure.rollback_failures,
        vec![SettingsGlobalOperationFailure {
            key: "humane_food_enabled".into(),
            operation: "rollback",
        }]
    );

    let response = serde_json::to_value(failure.response(false)).unwrap();
    assert_eq!(
        response["error"],
        "Failed to apply one or more Settings.Global feature gates."
    );
    assert_eq!(response["failures"][0]["operation"], "apply");
    assert_eq!(response["rollback_failures"][0]["operation"], "rollback");
    assert_eq!(response["partial_applied"], false);
}

#[tokio::test]
async fn immediate_sync_finishes_when_command_output_hangs() {
    let succeeded = tokio::time::timeout(
        Duration::from_secs(1),
        command_output_succeeded_within_timeout(std::future::pending::<
            Result<std::process::Output, std::io::Error>,
        >()),
    )
    .await
    .expect("bounded sync command must finish");

    assert!(!succeeded);
}

#[test]
fn settings_global_patch_rejects_every_non_allowlisted_key() {
    assert!(validate_settings_global_patch(&BTreeMap::from([(
        "penumbra.hand_tracking.enabled".into(),
        Some(true)
    ),]))
    .is_err());
}

#[test]
fn locked_global_gates_accept_only_their_safe_default_or_delete() {
    let jpg_off = BTreeMap::from([("humane_photography_jpg_enabled".into(), Some(false))]);
    assert!(validate_settings_global_patch(&jpg_off)
        .unwrap_err()
        .contains("not writable"));

    for safe_value in [Some(true), None] {
        validate_settings_global_patch(&BTreeMap::from([(
            "humane_photography_jpg_enabled".into(),
            safe_value,
        )]))
        .unwrap();
    }

    let sharing_on = BTreeMap::from([("humane_photo_sharing_enabled".into(), Some(true))]);
    assert!(validate_settings_global_patch(&sharing_on)
        .unwrap_err()
        .contains("not writable"));
    for safe_value in [Some(false), None] {
        validate_settings_global_patch(&BTreeMap::from([(
            "humane_photo_sharing_enabled".into(),
            safe_value,
        )]))
        .unwrap();
    }
}

#[test]
fn settings_global_dependencies_validate_the_final_cross_plane_state() {
    let config = default_config();

    let locked_on = BTreeMap::from([("humane_photo_sharing_enabled".into(), Some(true))]);
    assert!(validate_settings_global_patch(&locked_on)
        .unwrap_err()
        .contains("not writable"));
    for recovery in [Some(false), None] {
        validate_settings_global_patch(&BTreeMap::from([(
            "humane_photo_sharing_enabled".into(),
            recovery,
        )]))
        .unwrap();
    }

    let enable_food = BTreeMap::from([("humane_food_enabled".into(), Some(true))]);
    assert!(validate_settings_global_dependencies(
        &config,
        &enable_food,
        &default_settings_global_reads(),
    )
    .unwrap_err()
    .message()
    .contains("Open Food Facts"));
    let mut configured_food = config.clone();
    configured_food.open_food_facts.enabled = true;
    configured_food.open_food_facts.attribution_acknowledged = true;
    validate_settings_global_dependencies(
        &configured_food,
        &enable_food,
        &default_settings_global_reads(),
    )
    .unwrap();

    let mut disabled_cloud_cmu = config.clone();
    disabled_cloud_cmu.feature_flags.overrides.insert(
        "cmu_ultra_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(false),
    );
    let enable_global_cmu = BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(true))]);
    assert!(validate_settings_global_dependencies(
        &disabled_cloud_cmu,
        &enable_global_cmu,
        &default_settings_global_reads(),
    )
    .unwrap_err()
    .message()
    .contains("cloud `cmu_ultra_enabled`"));

    // Reverse-direction drift used to pass because validation only looked
    // at a requested global=true value. An already-on global master must
    // also block disabling its cloud dependency.
    let mut global_cmu_on = default_settings_global_reads();
    global_cmu_on
        .iter_mut()
        .find(|read| read.key == "humane_cmu_ultra_enabled")
        .unwrap()
        .stored_value = Some(true);
    assert!(validate_settings_global_dependencies(
        &disabled_cloud_cmu,
        &BTreeMap::new(),
        &global_cmu_on,
    )
    .unwrap_err()
    .message()
    .contains("cloud `cmu_ultra_enabled`"));
    validate_settings_global_dependencies(
        &disabled_cloud_cmu,
        &BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(false))]),
        &global_cmu_on,
    )
    .expect("one combined request can repair both planes");

    let mut chime_on = config.clone();
    chime_on.feature_flags.overrides.insert(
        "cmu_ultra_chime_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(true),
    );
    validate_settings_global_dependencies(
        &chime_on,
        &BTreeMap::new(),
        &default_settings_global_reads(),
    )
    .expect("the unconsumed legacy global setting is not a prerequisite for the cloud chime flag");

    let mut global_food_on = default_settings_global_reads();
    global_food_on
        .iter_mut()
        .find(|read| read.key == "humane_food_enabled")
        .unwrap()
        .stored_value = Some(true);
    assert!(
        validate_settings_global_dependencies(&config, &BTreeMap::new(), &global_food_on,)
            .unwrap_err()
            .message()
            .contains("Open Food Facts")
    );
    validate_settings_global_dependencies(
        &config,
        &BTreeMap::from([("humane_food_enabled".into(), Some(false))]),
        &global_food_on,
    )
    .expect("one combined request can disable an orphaned food gate");
}

#[test]
fn unavailable_dependency_reads_map_to_service_unavailable() {
    let mut reads = default_settings_global_reads();
    let cmu = reads
        .iter_mut()
        .find(|read| read.key == "humane_cmu_ultra_enabled")
        .unwrap();
    cmu.available = false;
    cmu.stored_value = None;

    let error = validate_settings_global_dependencies(&default_config(), &BTreeMap::new(), &reads)
        .unwrap_err();
    assert_eq!(
        error.into_response().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[test]
fn unrelated_updates_ignore_unavailable_dependency_reads() {
    let original = default_config();
    let mut candidate = original.clone();
    candidate.feature_flags.overrides.insert(
        "touchcode_timeout_millis".into(),
        ConfiguredFeatureFlagValue::Int(7_500),
    );
    let patch = BTreeMap::from([("humane_photography_jpg_enabled".into(), Some(false))]);
    let mut reads = default_settings_global_reads();
    for key in ["humane_food_enabled", "humane_cmu_ultra_enabled"] {
        let read = reads.iter_mut().find(|read| read.key == key).unwrap();
        read.available = false;
        read.stored_value = None;
    }

    let scope = cross_plane_dependency_scope(&original, &candidate, &patch).unwrap();
    assert_eq!(
        scope,
        CrossPlaneDependencyScope {
            food: false,
            cmu: false,
        }
    );
    validate_settings_global_dependencies_in_scope(&candidate, &patch, &reads, scope)
        .expect("unrelated updates must not require unavailable dependency gates");
    assert_eq!(
        plan_cross_plane_transition(&original, &candidate, &patch, &reads)
            .unwrap()
            .steps(),
        &[
            CrossPlaneTransitionStep::PersistCloud,
            CrossPlaneTransitionStep::ApplySettingsGlobal,
        ]
    );
}

#[tokio::test]
async fn dependent_global_enable_waits_for_a_fresh_exact_stock_fetch() {
    let mut original = default_config();
    original.feature_flags.overrides.insert(
        "cmu_ultra_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(false),
    );
    let mut candidate = original.clone();
    candidate.feature_flags.overrides.insert(
        "cmu_ultra_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(true),
    );
    let live_config = Arc::new(tokio::sync::RwLock::new(original));
    let delivery_tracker = FeatureFlagDeliveryTracker::default();
    let target_hash = assignment_set_hash(
        &proto_assignments(&candidate.feature_flags).expect("valid candidate assignments"),
    );
    // A stale matching receipt must not satisfy the transaction barrier.
    delivery_tracker.record_fetch(target_hash);
    let events = Arc::new(StdMutex::new(Vec::new()));
    let sync_requester = MockFeatureFlagSyncRequester {
        accepted: true,
        fetch: true,
        overwrite_latest_after_fetch: true,
        live_config: live_config.clone(),
        delivery_tracker: delivery_tracker.clone(),
        events: events.clone(),
    };

    let observation = publish_feature_flags_and_sync(
        &live_config,
        &delivery_tracker,
        &candidate,
        &sync_requester,
        true,
    )
    .await
    .expect("fresh exact fetch should release the dependency barrier");
    events.lock().unwrap().push("global_put");

    assert_eq!(
        observation,
        FeatureFlagSyncObservation {
            sync_requested: true,
            fresh_fetch_observed: true,
        }
    );
    assert_eq!(*events.lock().unwrap(), ["sync", "fetch", "global_put"]);
    assert_eq!(delivery_tracker.latest_fetch().unwrap().sequence, 3);
    assert_eq!(
        delivery_tracker.latest_fetch().unwrap().assignment_set_hash,
        "late-response-for-an-older-snapshot"
    );
    assert_eq!(
        live_config.read().await.feature_flags,
        candidate.feature_flags
    );
}

#[tokio::test]
async fn missing_fresh_fetch_leaves_the_android_gate_deferred() {
    let mut candidate = default_config();
    candidate.feature_flags.overrides.insert(
        "cmu_ultra_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(true),
    );
    let live_config = Arc::new(tokio::sync::RwLock::new(default_config()));
    let delivery_tracker = FeatureFlagDeliveryTracker::default();
    let events = Arc::new(StdMutex::new(Vec::new()));
    let sync_requester = MockFeatureFlagSyncRequester {
        accepted: true,
        fetch: false,
        overwrite_latest_after_fetch: false,
        live_config: live_config.clone(),
        delivery_tracker: delivery_tracker.clone(),
        events: events.clone(),
    };

    let failure = publish_feature_flags_and_sync(
        &live_config,
        &delivery_tracker,
        &candidate,
        &sync_requester,
        true,
    )
    .await
    .unwrap_err();

    assert!(failure.sync_requested);
    assert!(failure
        .message
        .contains("no fresh matching stock gRPC fetch"));
    assert_eq!(*events.lock().unwrap(), ["sync"]);
    assert!(delivery_tracker.latest_fetch().is_none());
    assert_eq!(
        live_config.read().await.feature_flags,
        candidate.feature_flags
    );
}

#[tokio::test]
async fn stock_apply_ack_barrier_requires_newer_exact_hash_and_count() {
    let runner = MockSettingsGlobalCommandRunner::default();
    let hash = "b".repeat(64);
    *runner.feature_flag_apply_ack.lock().unwrap() = Some(FeatureFlagApplyAckReceipt {
        sequence: 4,
        assignment_set_hash: hash.clone(),
        assignment_count: 7,
        applied_at_unix_ms: 1_784_000_000_000,
    });

    let receipt = wait_for_fresh_exact_feature_flag_apply_ack(&runner, &hash, 7, 3)
        .await
        .expect("newer exact cache acknowledgement should release the barrier");
    assert_eq!(receipt.sequence, 4);
    assert!(
        wait_for_fresh_exact_feature_flag_apply_ack(&runner, &hash, 7, 4)
            .await
            .is_none()
    );
    assert!(
        wait_for_fresh_exact_feature_flag_apply_ack(&runner, &hash, 8, 3)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn food_provider_transition_observes_the_live_global_gate() {
    let mut config = default_config();
    config.open_food_facts.enabled = false;
    config.open_food_facts.attribution_acknowledged = false;

    let runner = MockSettingsGlobalCommandRunner::default();
    runner
        .values
        .lock()
        .unwrap()
        .insert("humane_food_enabled".into(), Some(true));
    let conflict = validate_open_food_facts_provider_dependency_with_runner(&config, &runner)
        .await
        .unwrap_err();
    assert_eq!(conflict.into_response().status(), StatusCode::BAD_REQUEST);

    runner
        .values
        .lock()
        .unwrap()
        .insert("humane_food_enabled".into(), Some(false));
    validate_open_food_facts_provider_dependency_with_runner(&config, &runner)
        .await
        .unwrap();

    *runner.fail_get_key.lock().unwrap() = Some("humane_food_enabled".into());
    let unavailable = validate_open_food_facts_provider_dependency_with_runner(&config, &runner)
        .await
        .unwrap_err();
    assert_eq!(
        unavailable.into_response().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );

    // Enabling the provider repairs the dependency in every possible gate
    // state and therefore must not depend on a bridge read.
    config.open_food_facts.enabled = true;
    config.open_food_facts.attribution_acknowledged = true;
    runner.commands.lock().unwrap().clear();
    validate_open_food_facts_provider_dependency_with_runner(&config, &runner)
        .await
        .expect("provider recovery is safe even while the bridge is unavailable");
    assert!(runner.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn intrinsic_food_configuration_fails_before_any_bridge_read() {
    let mut config = default_config();
    config.open_food_facts.enabled = true;
    config.open_food_facts.attribution_acknowledged = false;
    let runner = MockSettingsGlobalCommandRunner::default();
    *runner.fail_get_key.lock().unwrap() = Some("humane_food_enabled".into());

    let error = validate_open_food_facts_provider_dependency_with_runner(&config, &runner)
        .await
        .unwrap_err();

    assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
    assert!(
        runner.commands.lock().unwrap().is_empty(),
        "invalid local provider settings must not touch the live bridge"
    );
}

#[test]
fn cross_plane_transition_planner_uses_only_dependency_safe_orders() {
    let mut all_off = default_config();
    all_off.feature_flags.overrides.insert(
        "cmu_ultra_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(false),
    );
    let mut all_on = all_off.clone();
    all_on.feature_flags.overrides.insert(
        "cmu_ultra_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(true),
    );

    let off_reads = default_settings_global_reads();
    let mut on_reads = default_settings_global_reads();
    on_reads
        .iter_mut()
        .find(|read| read.key == "humane_cmu_ultra_enabled")
        .unwrap()
        .stored_value = Some(true);

    let enable = plan_cross_plane_transition(
        &all_off,
        &all_on,
        &BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(true))]),
        &off_reads,
    )
    .unwrap();
    assert_eq!(
        enable.steps(),
        &[
            CrossPlaneTransitionStep::PersistCloud,
            CrossPlaneTransitionStep::ApplySettingsGlobal,
        ]
    );

    let disable = plan_cross_plane_transition(
        &all_on,
        &all_off,
        &BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(false))]),
        &on_reads,
    )
    .unwrap();
    assert_eq!(
        disable.steps(),
        &[
            CrossPlaneTransitionStep::ApplySettingsGlobal,
            CrossPlaneTransitionStep::PersistCloud,
        ]
    );

    let mut all_on_with_chime = all_on.clone();
    all_on_with_chime.feature_flags.overrides.insert(
        "cmu_ultra_chime_enabled".into(),
        ConfiguredFeatureFlagValue::Bool(true),
    );
    let disable_with_chime = plan_cross_plane_transition(
        &all_on_with_chime,
        &all_off,
        &BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(false))]),
        &on_reads,
    )
    .unwrap();
    assert_eq!(
        disable_with_chime.steps(),
        &[
            CrossPlaneTransitionStep::ApplySettingsGlobal,
            CrossPlaneTransitionStep::PersistCloud,
        ]
    );

    // A legacy orphan is still recoverable in one request. Reads are not
    // writes; the only durable step turns the orphaned global master off.
    let recovery = plan_cross_plane_transition(
        &all_off,
        &all_off,
        &BTreeMap::from([("humane_cmu_ultra_enabled".into(), Some(false))]),
        &on_reads,
    )
    .unwrap();
    assert_eq!(
        recovery.steps(),
        &[CrossPlaneTransitionStep::ApplySettingsGlobal]
    );

    let verify_same_value = plan_cross_plane_transition(
        &all_off,
        &all_off,
        &BTreeMap::from([("humane_photography_jpg_enabled".into(), None)]),
        &off_reads,
    )
    .unwrap();
    assert!(!verify_same_value.settings_global_changed());
    assert_eq!(
        verify_same_value.steps(),
        &[CrossPlaneTransitionStep::ApplySettingsGlobal],
        "a non-empty patch must be re-read and verified even when preflight matched"
    );
}

#[test]
fn unreadable_requested_gate_fails_preflight_before_a_transition_plan() {
    let mut reads = default_settings_global_reads();
    let photo = reads
        .iter_mut()
        .find(|read| read.key == "humane_photography_jpg_enabled")
        .unwrap();
    photo.available = false;
    photo.stored_value = None;
    let patch = BTreeMap::from([("humane_photography_jpg_enabled".into(), Some(false))]);

    let config = default_config();
    let error = plan_cross_plane_transition(&config, &config, &patch, &reads).unwrap_err();
    assert_eq!(error.status_code(), StatusCode::SERVICE_UNAVAILABLE);
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
