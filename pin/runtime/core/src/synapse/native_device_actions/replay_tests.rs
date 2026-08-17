use super::*;
use std::collections::BTreeSet;

/// `implemented`: independently authored, non-mutating prompts exercise the
/// boundary between server-side understanding and native device actions.
///
/// The source fixture is synthetic by policy. Failures identify only a
/// fixture ID and category so prompt content never leaks into test output.
#[test]
fn synthetic_non_mutating_inputs_are_not_hijacked_into_device_actions() {
    let raw = include_str!("../../../../../contracts/fixtures/non-mutating-planner.synthetic.json");
    let corpus: serde_json::Value = serde_json::from_str(raw).expect("synthetic fixture parses");
    assert_eq!(corpus["schema_version"], 1);
    assert_eq!(corpus["provenance"], "synthetic");
    assert_eq!(corpus["evidence"], "implemented");
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= 12,
        "synthetic coverage must not silently shrink"
    );

    let mut checked = 0;
    let mut ids = BTreeSet::new();
    for case in cases {
        let id = case["id"].as_str().expect("fixture id");
        let category = case["category"].as_str().expect("fixture category");
        let input = case["input"].as_str().expect("synthetic input");
        assert!(!id.is_empty(), "fixture id must not be empty");
        assert!(
            !category.is_empty(),
            "fixture {id}: category must not be empty"
        );
        assert!(!input.is_empty(), "fixture {id}: input must not be empty");
        assert!(
            input.len() <= 256,
            "fixture {id}: input is unexpectedly large"
        );
        assert!(
            case.get("expected_native_action")
                .is_some_and(serde_json::Value::is_null),
            "fixture {id}: expected_native_action must be explicit null"
        );
        assert!(ids.insert(id), "duplicate fixture id: {id}");

        let request = SynapseUnderstandingRequest {
            utterance: input.to_string(),
            device_context: Some(crate::proto::aibus::SynapseDeviceContext {
                is_locked: false,
                ..Default::default()
            }),
            ..Default::default()
        };

        if let Some(planned) = plan_native_device_action(&request) {
            panic!(
                "fixture {id} ({category}) must remain server-side, but the planner \
                 chose native action {:?}",
                planned.action_name,
            );
        }
        checked += 1;
    }

    assert_eq!(
        checked,
        cases.len(),
        "every synthetic fixture must be replayed, not skipped",
    );
}
