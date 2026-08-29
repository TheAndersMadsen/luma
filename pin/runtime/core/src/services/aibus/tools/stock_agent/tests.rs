use super::*;
use crate::proto::aibus::{ChatCompletionMessage, Tool, ToolSetVersion};

fn message(role: &str, content: &str) -> ChatCompletionMessage {
    ChatCompletionMessage {
        role: role.to_string(),
        content: content.to_string(),
        ..ChatCompletionMessage::default()
    }
}

fn toolset_request(set_name: &str, prompt: &str) -> ChatCompletionRequest {
    ChatCompletionRequest {
        messages: vec![message("user", prompt)],
        tag: "agent".to_string(),
        tool_set_version: Some(ToolSetVersion {
            set_name: set_name.to_string(),
            version: 1,
        }),
        ..ChatCompletionRequest::default()
    }
}

fn with_current_status(mut request: ChatCompletionRequest, locked: bool) -> ChatCompletionRequest {
    let request_messages = std::mem::take(&mut request.messages);
    request.messages = vec![
        ChatCompletionMessage {
            role: "assistant".to_string(),
            tool_calls: vec![ToolCall {
                id: "call_status".to_string(),
                r#type: "function".to_string(),
                function: Some(FunctionCall {
                    name: "CurrentStatus".to_string(),
                    arguments: "{}".to_string(),
                    ..FunctionCall::default()
                }),
            }],
            ..ChatCompletionMessage::default()
        },
        ChatCompletionMessage {
            role: "tool".to_string(),
            content: format!("Device status:\nAi Pin is locked: {locked}\n"),
            name: "CurrentStatus".to_string(),
            tool_call_id: "call_status".to_string(),
            ..ChatCompletionMessage::default()
        },
    ];
    request.messages.extend(request_messages);
    request
}

fn settings_request(prompt: &str, locked: bool) -> ChatCompletionRequest {
    let mut request = toolset_request("settings", prompt);
    request.tool_set_version.as_mut().unwrap().version = 3;
    with_current_status(request, locked)
}

fn contacts_request(prompt: &str, locked: bool) -> ChatCompletionRequest {
    with_current_status(toolset_request("contacts", prompt), locked)
}

fn food_request(prompt: &str) -> ChatCompletionRequest {
    let mut request = toolset_request("food", prompt);
    request.tool_set_version.as_mut().unwrap().version = 4;
    request
}

fn parameter(name: &str, kind: &str) -> FunctionParameter {
    FunctionParameter {
        name: name.to_string(),
        r#type: kind.to_string(),
        ..FunctionParameter::default()
    }
}

fn function_tool(name: &str, parameters: Vec<FunctionParameter>, required: &[&str]) -> Tool {
    Tool {
        content: Some(tool::Content::Function(Function {
            name: name.to_string(),
            parameters,
            is_required: required.iter().map(|value| (*value).to_string()).collect(),
            ..Function::default()
        })),
    }
}

fn explicit_request(prompt: &str, tools: Vec<Tool>) -> ChatCompletionRequest {
    ChatCompletionRequest {
        messages: vec![message("user", prompt)],
        tag: "agent".to_string(),
        tools,
        ..ChatCompletionRequest::default()
    }
}

fn append_tool_result(
    request: &mut ChatCompletionRequest,
    name: &str,
    arguments: Value,
    content: &str,
) {
    let id = format!("call_test_{}", request.messages.len());
    request.messages.push(ChatCompletionMessage {
        role: "assistant".to_string(),
        tool_calls: vec![ToolCall {
            id: id.clone(),
            r#type: "function".to_string(),
            function: Some(FunctionCall {
                name: name.to_string(),
                arguments: arguments.to_string(),
                ..FunctionCall::default()
            }),
        }],
        ..ChatCompletionMessage::default()
    });
    request.messages.push(ChatCompletionMessage {
        role: "tool".to_string(),
        content: content.to_string(),
        name: name.to_string(),
        tool_call_id: id,
        ..ChatCompletionMessage::default()
    });
}

fn planned(request: &ChatCompletionRequest) -> (String, Value) {
    let call = plan_tool_call(request).expect("planned tool call");
    assert_eq!(call.r#type, "function");
    let function = call.function.expect("function call");
    let arguments = serde_json::from_str(&function.arguments).expect("valid arguments JSON");
    (function.name, arguments)
}

#[test]
fn timer_and_alarm_v1_allowlist_emits_each_supported_action() {
    let cases = [
        (
            "timer",
            "set a timer for five minutes",
            native_actions::SET_TIMER,
        ),
        (
            "timer",
            "add two minutes to my timer",
            native_actions::EDIT_TIMER,
        ),
        ("timer", "delete my timer", native_actions::DELETE_TIMER),
        ("timer", "show my timers", native_actions::DISPLAY_TIMER),
        ("timer", "pause my timer", native_actions::PAUSE_TIMER),
        ("timer", "resume my timer", native_actions::RESUME_TIMER),
        ("alarm", "set an alarm for 7 am", native_actions::SET_ALARM),
        ("alarm", "cancel my alarm", native_actions::CANCEL_ALARM),
        ("alarm", "show my alarms", native_actions::DISPLAY_ALARM),
    ];

    for (set_name, prompt, expected) in cases {
        let (name, _) = planned(&toolset_request(set_name, prompt));
        assert_eq!(name, expected, "prompt: {prompt}");
    }
}

#[test]
fn clock_family_entry_reuses_every_supported_timer_and_alarm_grammar_family() {
    let timer_prompts = [
        ("set a timer for five minutes", native_actions::SET_TIMER),
        ("add two minutes to my timer", native_actions::EDIT_TIMER),
        ("delete my timer", native_actions::DELETE_TIMER),
        ("show my timers", native_actions::DISPLAY_TIMER),
        ("pause my timer", native_actions::PAUSE_TIMER),
        ("resume my timer", native_actions::RESUME_TIMER),
        ("what are my timers?", native_actions::DISPLAY_TIMER),
    ];
    for (prompt, nested_action_name) in timer_prompts {
        let entry = classify_clock_family_entry(prompt).expect("timer entry");
        assert_eq!(
            entry.action_name(),
            native_actions::TIMER,
            "prompt: {prompt}"
        );
        assert_eq!(entry.nested_action_name(), Some(nested_action_name));
        assert_eq!(entry.continuation_action_name(), None);
        assert_eq!(
            entry.string_input(),
            ("Request", prompt),
            "prompt: {prompt}"
        );
        assert_eq!(
            entry,
            ClockFamilyEntry::Timer {
                request: prompt.to_string(),
                nested_action_name,
                continuation_action_name: None,
            },
            "prompt: {prompt}"
        );
    }

    let alarm_prompts = [
        ("set an alarm for 7 am", native_actions::SET_ALARM, None),
        (
            "set a weekday alarm for 7:30 am",
            native_actions::SET_ALARM,
            None,
        ),
        ("cancel my alarm", native_actions::CANCEL_ALARM, None),
        (
            "cancel my 7 am alarm",
            native_actions::DISPLAY_ALARM,
            Some(native_actions::CANCEL_ALARM),
        ),
        ("show my alarms", native_actions::DISPLAY_ALARM, None),
        (
            "what alarms do I have?",
            native_actions::DISPLAY_ALARM,
            None,
        ),
    ];
    for (prompt, nested_action_name, continuation_action_name) in alarm_prompts {
        let entry = classify_clock_family_entry(prompt).expect("alarm entry");
        assert_eq!(
            entry.action_name(),
            native_actions::ALARM,
            "prompt: {prompt}"
        );
        assert_eq!(entry.nested_action_name(), Some(nested_action_name));
        assert_eq!(entry.continuation_action_name(), continuation_action_name);
        assert_eq!(
            entry.string_input(),
            ("Request", prompt),
            "prompt: {prompt}"
        );
        assert_eq!(
            entry,
            ClockFamilyEntry::Alarm {
                request: prompt.to_string(),
                nested_action_name,
                continuation_action_name,
            },
            "prompt: {prompt}"
        );
    }
}

#[test]
fn clock_family_entry_emits_only_strict_world_clock_locations() {
    for (prompt, location) in [
        ("current time in Copenhagen", "copenhagen"),
        ("What time is it in Tokyo?", "tokyo"),
        ("What's the current time in New York?", "new york"),
        ("current time in Salt Lake City", "salt lake city"),
    ] {
        let entry = classify_clock_family_entry(prompt).expect("world-clock entry");
        assert_eq!(entry.action_name(), native_actions::WORLD_CLOCK);
        assert_eq!(entry.string_input(), ("Location", location));
        assert_eq!(
            entry,
            ClockFamilyEntry::WorldClock {
                location: location.to_string()
            }
        );
    }

    for prompt in [
        "time in Tokyo",
        "what is the current time in Tokyo",
        "please tell me the current time in Tokyo",
        "what time is it in",
        "what time is it in one two three four",
        "what time is it in Tokyo and London",
        "what time is it in Tokyo, London",
        "what time is it in Tokyo then set a timer",
        "what time is it in St. Louis",
    ] {
        assert!(
            classify_clock_family_entry(prompt).is_none(),
            "prompt: {prompt}"
        );
    }
}

#[test]
fn clock_family_entry_rejects_questions_compounds_malformed_and_oversized_input() {
    let oversized = format!(
        "set a timer for {} minutes",
        "1".repeat(MAX_UTTERANCE_BYTES)
    );
    for prompt in [
        "how do I set a timer?".to_string(),
        "should I set an alarm for 7 am?".to_string(),
        "what happens if I pause my timer?".to_string(),
        "set a timer for five minutes and play music".to_string(),
        "set an alarm for 7 am then delete my timer".to_string(),
        "set a timer for five minutes; delete my alarm".to_string(),
        "set a timer\nfor five minutes".to_string(),
        "set a tímer for five minutes".to_string(),
        "set a timer for zero minutes".to_string(),
        "set an alarm for 29:99".to_string(),
        "device status".to_string(),
        oversized,
    ] {
        assert!(
            classify_clock_family_entry(&prompt).is_none(),
            "prompt: {prompt:?}"
        );
    }
}

#[test]
fn repeated_plans_use_unique_bounded_stock_tool_call_ids() {
    let request = food_request("I ate two eggs");
    let first = plan_tool_call(&request).expect("first tool call");
    let second = plan_tool_call(&request).expect("second tool call");

    assert_ne!(first.id, second.id);
    for id in [&first.id, &second.id] {
        assert!(id.starts_with("call_penumbra_trackfoodconsumption_"));
        assert!(id.len() <= MAX_TOOL_CALL_ID_BYTES);
        assert!(id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_'));
    }
}

#[test]
fn food_v4_exposes_only_the_three_exact_stock_tools() {
    let offered = offered_functions(&food_request("show my food log"));
    assert_eq!(
        offered.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["GetFoodLog", "RetrieveFoodInfo", "TrackFoodConsumption"]
    );

    let list_schema = offered["RetrieveFoodInfo"]
        .parameter("FoodItemList", ParameterKind::FoodItemList)
        .expect("known nested stock schema");
    assert!(list_schema.enums.is_empty());
    assert!(offered["RetrieveFoodInfo"]
        .required
        .contains("FoodItemList"));
    assert!(offered["GetFoodLog"].required.contains("DayCount"));
}

#[test]
fn food_v4_tracks_bounded_items_with_exact_stock_fields() {
    let cases = [
        (
            "I ate two eggs",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "eggs",
                    "IsBranded": false,
                    "Quantity": 2
                }]
            }),
        ),
        (
            "Track my food: one banana.",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "banana",
                    "IsBranded": false,
                    "Quantity": 1
                }]
            }),
        ),
        (
            "I ate two eggs and a banana",
            serde_json::json!({
                "FoodItemList": [
                    {"FoodItemName": "eggs", "IsBranded": false, "Quantity": 2},
                    {"FoodItemName": "banana", "IsBranded": false, "Quantity": 1}
                ]
            }),
        ),
        (
            "I ate a Big Mac",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "big mac",
                    "IsBranded": false,
                    "Quantity": 1
                }]
            }),
        ),
    ];

    for (prompt, expected_args) in cases {
        let (name, args) = planned(&food_request(prompt));
        assert_eq!(name, "TrackFoodConsumption", "prompt: {prompt}");
        assert_eq!(args, expected_args, "prompt: {prompt}");
    }
}

#[test]
fn food_v4_retrieves_information_without_inventing_nutrition_values() {
    let cases = [
        (
            "How many calories are in an apple?",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "apple",
                    "IsBranded": false,
                    "Quantity": 1
                }]
            }),
        ),
        (
            "What are the nutrition facts for oatmeal?",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "oatmeal",
                    "IsBranded": false,
                    "Quantity": 1
                }]
            }),
        ),
        (
            "How much protein is in two eggs?",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "eggs",
                    "IsBranded": false,
                    "Quantity": 2
                }]
            }),
        ),
        (
            "How many calories are in 1.5 cups of milk?",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "cups of milk",
                    "IsBranded": false,
                    "Quantity": 1.5
                }]
            }),
        ),
        (
            "How much protein is in half an avocado?",
            serde_json::json!({
                "FoodItemList": [{
                    "FoodItemName": "avocado",
                    "IsBranded": false,
                    "Quantity": 0.5
                }]
            }),
        ),
    ];

    for (prompt, expected_args) in cases {
        let (name, args) = planned(&food_request(prompt));
        assert_eq!(name, "RetrieveFoodInfo", "prompt: {prompt}");
        assert_eq!(args, expected_args, "prompt: {prompt}");
    }
}

#[test]
fn food_v4_gets_only_explicit_bounded_log_windows() {
    for (prompt, expected_days) in [
        ("What have I eaten today?", 1),
        ("How many calories have I eaten today?", 1),
        ("Show my food log", 1),
        ("Show my food log for the last 3 days", 3),
        ("Show my food log for the last three days.", 3),
        ("What have I eaten in the last thirty days?", 30),
    ] {
        let (name, args) = planned(&food_request(prompt));
        assert_eq!(name, "GetFoodLog", "prompt: {prompt}");
        assert_eq!(args, serde_json::json!({"DayCount": expected_days}));
    }

    for prompt in [
        "Show my food log for the last 0 days",
        "Show my food log for the last 31 days",
        "Show my food log for a while",
    ] {
        assert!(plan_tool_call(&food_request(prompt)).is_none(), "{prompt}");
    }
}

#[test]
fn food_v4_fails_closed_for_context_inference_advice_and_unsafe_quantities() {
    let too_many = "I ate one apple, one banana, one pear, one peach, one plum, one orange, one kiwi, one mango, one melon";
    let oversized_name = format!("I ate {}", "apple".repeat(MAX_FOOD_NAME_BYTES));
    for prompt in [
        "Add this meal to my food log".to_string(),
        "What are the nutrition facts for this photo?".to_string(),
        "What are the nutrition facts for it?".to_string(),
        "How many calories are in the apple in front of me?".to_string(),
        "How many calories are in an apple and is it healthy?".to_string(),
        "What diet should I follow for diabetes?".to_string(),
        "I ate at a restaurant yesterday".to_string(),
        "I ate 0 eggs".to_string(),
        "I ate 101 eggs".to_string(),
        "I ate one hundred eggs".to_string(),
        "I ate a dozen eggs".to_string(),
        "I ate eggs, eggs".to_string(),
        too_many.to_string(),
        oversized_name,
        "Tell me about nutrition".to_string(),
    ] {
        assert!(
            plan_tool_call(&food_request(&prompt)).is_none(),
            "unexpected food tool for {prompt}"
        );
    }
}

#[test]
fn explicit_food_item_array_schema_fails_closed_but_scalar_log_schema_is_safe() {
    // FunctionParameter cannot describe the nested FoodItemSpec object. Treating
    // an explicit `array` as a string list must never authorize object output.
    for name in ["RetrieveFoodInfo", "TrackFoodConsumption"] {
        let request = explicit_request(
            if name == "RetrieveFoodInfo" {
                "nutrition facts for oatmeal"
            } else {
                "I ate two eggs"
            },
            vec![function_tool(
                name,
                vec![parameter("FoodItemList", "array")],
                &["FoodItemList"],
            )],
        );
        assert!(plan_tool_call(&request).is_none(), "tool: {name}");
    }

    let log = explicit_request(
        "show my food log for the last 3 days",
        vec![function_tool(
            "GetFoodLog",
            vec![parameter("DayCount", "integer")],
            &["DayCount"],
        )],
    );
    assert_eq!(
        planned(&log),
        ("GetFoodLog".to_string(), serde_json::json!({"DayCount": 3}))
    );
}

#[test]
fn food_toolset_version_choice_and_terminal_observations_are_exact() {
    for version in [1, 3, 5] {
        let mut request = food_request("I ate two eggs");
        request.tool_set_version.as_mut().unwrap().version = version;
        assert!(plan_tool_call(&request).is_none(), "version: {version}");
    }

    let terminal_cases = [
        (
            "I ate two eggs",
            "TrackFoodConsumption",
            serde_json::json!({"FoodItemList": [{"FoodItemName": "eggs", "IsBranded": false, "Quantity": 2}]}),
            "Food consumption tracked.",
        ),
        (
            "Nutrition facts for oatmeal",
            "RetrieveFoodInfo",
            serde_json::json!({"FoodItemList": [{"FoodItemName": "oatmeal", "IsBranded": false, "Quantity": 1}]}),
            "Nutrition facts returned.",
        ),
        (
            "Show my food log",
            "GetFoodLog",
            serde_json::json!({"DayCount": 1}),
            "Food log returned.",
        ),
    ];
    for (prompt, name, args, observation) in terminal_cases {
        let mut request = food_request(prompt);
        append_tool_result(&mut request, name, args, observation);
        assert!(
            plan_tool_call(&request).is_none(),
            "re-emitted {name} after its tool observation"
        );
    }

    let mut wrong_choice = food_request("I ate two eggs");
    wrong_choice.tool_choice = "RetrieveFoodInfo".to_string();
    assert!(plan_tool_call(&wrong_choice).is_none());
    wrong_choice.tool_choice = "none".to_string();
    assert!(plan_tool_call(&wrong_choice).is_none());
}

#[test]
fn settings_v3_emits_only_exact_unlocked_device_status() {
    for prompt in [
        "device status",
        "get device status",
        "show me device status",
        "give me a device status report",
        "device status report",
    ] {
        let (name, args) = planned(&settings_request(prompt, false));
        assert_eq!(name, native_actions::DEVICE_STATUS, "prompt: {prompt}");
        assert_eq!(args, serde_json::json!({}));
    }
}

#[test]
fn settings_v3_exposes_only_status_and_the_bounded_bluetooth_loop() {
    let offered = offered_functions(&settings_request("device status", false));
    assert_eq!(
        offered.keys().map(String::as_str).collect::<Vec<_>>(),
        vec![
            native_actions::CONNECT_TO_BLUETOOTH,
            native_actions::DEVICE_STATUS,
            native_actions::DISCONNECT_BLUETOOTH,
            native_actions::GET_NEW_BLUETOOTH_ADDRESS,
            native_actions::GET_PAIRED_BLUETOOTH_ADDRESS,
        ]
    );

    for lookup in [
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        native_actions::GET_PAIRED_BLUETOOTH_ADDRESS,
    ] {
        assert!(offered[lookup].parameters.is_empty());
        assert!(offered[lookup].required.is_empty());
    }
    for mutation in [
        native_actions::CONNECT_TO_BLUETOOTH,
        native_actions::DISCONNECT_BLUETOOTH,
    ] {
        let schema = &offered[mutation];
        assert_eq!(schema.parameters.len(), 1);
        assert_eq!(schema.required, BTreeSet::from(["address".to_string()]));
        assert!(schema
            .parameter("address", ParameterKind::String)
            .is_some_and(|parameter| parameter.enums.is_empty()));
    }
}

#[test]
fn settings_named_bluetooth_uses_lookup_then_one_validated_address_mutation() {
    let mut connect = settings_request("connect to my Acme Nova X1", false);
    assert_eq!(
        planned(&connect),
        (
            native_actions::GET_NEW_BLUETOOTH_ADDRESS.to_string(),
            serde_json::json!({})
        )
    );
    append_tool_result(
        &mut connect,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Kitchen Speaker address: \"00:00:5E:00:53:03\" name: ACME NOVA X1 address: \"00:00:5E:00:53:01\"",
    );
    assert_eq!(
        planned(&connect),
        (
            native_actions::CONNECT_TO_BLUETOOTH.to_string(),
            serde_json::json!({"address": "00:00:5E:00:53:01"}),
        )
    );
    append_tool_result(
        &mut connect,
        native_actions::CONNECT_TO_BLUETOOTH,
        serde_json::json!({"address": "00:00:5E:00:53:01"}),
        "Connected to ACME NOVA X1",
    );
    assert!(plan_tool_call(&connect).is_none());

    let mut disconnect = settings_request("disconnect from Taylor’s Nova X1", false);
    assert_eq!(
        planned(&disconnect),
        (
            native_actions::GET_PAIRED_BLUETOOTH_ADDRESS.to_string(),
            serde_json::json!({}),
        )
    );
    append_tool_result(
        &mut disconnect,
        native_actions::GET_PAIRED_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Taylor's Nova X1 address: \"00:00:5E:00:53:02\"",
    );
    assert_eq!(
        planned(&disconnect),
        (
            native_actions::DISCONNECT_BLUETOOTH.to_string(),
            serde_json::json!({"address": "00:00:5E:00:53:02"}),
        )
    );
}

#[test]
fn settings_bluetooth_fails_closed_on_untrusted_or_ambiguous_lookup_results() {
    let observations = [
        "getDiscoveredDevices found no devices".to_string(),
        "getDiscoveredDevices failed".to_string(),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:GG\"".to_string(),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\" trailing".to_string(),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\" name: ACME_NOVA X1 address: \"00:00:5E:00:53:04\"".to_string(),
        (0..33)
            .map(|index| {
                format!(
                    " name: Device {index} address: \"00:00:5E:00:53:{index:02X}\""
                )
            })
            .collect::<String>(),
    ];
    for observation in observations {
        let mut request = settings_request("connect to Acme Nova X1", false);
        append_tool_result(
            &mut request,
            native_actions::GET_NEW_BLUETOOTH_ADDRESS,
            serde_json::json!({}),
            &observation,
        );
        assert!(
            plan_tool_call(&request).is_none(),
            "trusted malformed observation: {observation}"
        );
    }

    let mut wrong_lookup = settings_request("connect to Acme Nova X1", false);
    append_tool_result(
        &mut wrong_lookup,
        native_actions::GET_PAIRED_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
    );
    assert!(plan_tool_call(&wrong_lookup).is_none());

    let mut wrong_arguments = settings_request("connect to Acme Nova X1", false);
    append_tool_result(
        &mut wrong_arguments,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        serde_json::json!({"name": "Acme Nova X1"}),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
    );
    assert!(plan_tool_call(&wrong_arguments).is_none());

    let mut unlinked = settings_request("connect to Acme Nova X1", false);
    append_tool_result(
        &mut unlinked,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
    );
    unlinked.messages.last_mut().unwrap().tool_call_id = "unlinked".to_string();
    assert!(plan_tool_call(&unlinked).is_none());

    let mut multiple_parents = settings_request("connect to Acme Nova X1", false);
    append_tool_result(
        &mut multiple_parents,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
    );
    let parent_index = multiple_parents.messages.len() - 2;
    let duplicate = multiple_parents.messages[parent_index].tool_calls[0].clone();
    multiple_parents.messages[parent_index]
        .tool_calls
        .push(duplicate);
    assert!(plan_tool_call(&multiple_parents).is_none());
}

#[test]
fn settings_bluetooth_requires_fresh_unlocked_status_on_both_steps() {
    assert!(plan_tool_call(&settings_request("connect to Acme Nova X1", true)).is_none());

    let mut locked_mutation = settings_request("connect to Acme Nova X1", true);
    append_tool_result(
        &mut locked_mutation,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
    );
    assert!(plan_tool_call(&locked_mutation).is_none());

    let mut stale = settings_request("connect to Acme Nova X1", false);
    stale
        .messages
        .insert(2, message("assistant", "unrelated response"));
    assert!(plan_tool_call(&stale).is_none());
}

#[test]
fn settings_bluetooth_tool_choice_cannot_skip_or_repeat_a_loop_step() {
    let mut initial = settings_request("connect to Acme Nova X1", false);
    initial.tool_choice = native_actions::CONNECT_TO_BLUETOOTH.to_string();
    assert!(plan_tool_call(&initial).is_none());
    initial.tool_choice = native_actions::GET_NEW_BLUETOOTH_ADDRESS.to_string();
    assert_eq!(
        planned(&initial).0,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS
    );

    append_tool_result(
        &mut initial,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
    );
    assert!(plan_tool_call(&initial).is_none());
    initial.tool_choice = native_actions::CONNECT_TO_BLUETOOTH.to_string();
    assert_eq!(planned(&initial).0, native_actions::CONNECT_TO_BLUETOOTH);
}

#[test]
fn explicit_bluetooth_schemas_must_match_the_recovered_stock_contract() {
    let correct_tools = || {
        vec![
            function_tool(native_actions::GET_NEW_BLUETOOTH_ADDRESS, Vec::new(), &[]),
            function_tool(
                native_actions::CONNECT_TO_BLUETOOTH,
                vec![parameter("address", "string")],
                &["address"],
            ),
        ]
    };
    let mut correct = with_current_status(
        explicit_request("connect to Acme Nova X1", correct_tools()),
        false,
    );
    assert_eq!(
        planned(&correct).0,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS
    );
    append_tool_result(
        &mut correct,
        native_actions::GET_NEW_BLUETOOTH_ADDRESS,
        serde_json::json!({}),
        " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
    );
    assert_eq!(planned(&correct).0, native_actions::CONNECT_TO_BLUETOOTH);

    let wrong_lookup_schemas = [
        function_tool(
            native_actions::GET_NEW_BLUETOOTH_ADDRESS,
            vec![parameter("name", "string")],
            &[],
        ),
        function_tool(
            native_actions::GET_NEW_BLUETOOTH_ADDRESS,
            vec![parameter("address", "string")],
            &["address"],
        ),
    ];
    for lookup in wrong_lookup_schemas {
        let request = with_current_status(
            explicit_request(
                "connect to Acme Nova X1",
                vec![
                    lookup,
                    function_tool(
                        native_actions::CONNECT_TO_BLUETOOTH,
                        vec![parameter("address", "string")],
                        &["address"],
                    ),
                ],
            ),
            false,
        );
        assert!(plan_tool_call(&request).is_none());
    }

    let wrong_mutation_schemas = [
        function_tool(
            native_actions::CONNECT_TO_BLUETOOTH,
            vec![parameter("Address", "string")],
            &["Address"],
        ),
        function_tool(
            native_actions::CONNECT_TO_BLUETOOTH,
            vec![parameter("address", "string")],
            &[],
        ),
        function_tool(
            native_actions::CONNECT_TO_BLUETOOTH,
            vec![parameter("address", "string"), parameter("name", "string")],
            &["address"],
        ),
    ];
    for mutation in wrong_mutation_schemas {
        let mut request = with_current_status(
            explicit_request(
                "connect to Acme Nova X1",
                vec![
                    function_tool(native_actions::GET_NEW_BLUETOOTH_ADDRESS, Vec::new(), &[]),
                    mutation,
                ],
            ),
            false,
        );
        append_tool_result(
            &mut request,
            native_actions::GET_NEW_BLUETOOTH_ADDRESS,
            serde_json::json!({}),
            " name: Acme Nova X1 address: \"00:00:5E:00:53:03\"",
        );
        assert!(plan_tool_call(&request).is_none());
    }
}

#[test]
fn settings_device_status_fails_closed_for_lock_or_status_contract_mismatch() {
    assert!(plan_tool_call(&settings_request("device status", true)).is_none());

    let mut missing_status = toolset_request("settings", "device status");
    missing_status.tool_set_version.as_mut().unwrap().version = 3;
    assert!(plan_tool_call(&missing_status).is_none());

    let mut malformed = settings_request("device status", false);
    malformed.messages[1].content = "Ai Pin is locked: unknown".to_string();
    assert!(plan_tool_call(&malformed).is_none());

    let mut unpaired = settings_request("device status", false);
    unpaired.messages[1].tool_call_id = "different_call".to_string();
    assert!(plan_tool_call(&unpaired).is_none());
}

#[test]
fn settings_toolset_version_and_tool_choice_are_exact() {
    for version in [1, 2, 4] {
        let mut request = settings_request("device status", false);
        request.tool_set_version.as_mut().unwrap().version = version;
        assert!(plan_tool_call(&request).is_none(), "version: {version}");
    }

    let mut selected = settings_request("device status", false);
    selected.tool_choice = native_actions::DEVICE_STATUS.to_string();
    assert_eq!(planned(&selected).0, native_actions::DEVICE_STATUS);

    for choice in [
        "none",
        native_actions::SET_VOLUME,
        native_actions::TURN_ON_WIFI,
    ] {
        let mut request = settings_request("device status", false);
        request.tool_choice = choice.to_string();
        assert!(plan_tool_call(&request).is_none(), "choice: {choice}");
    }
}

#[test]
fn explicit_device_status_schema_is_authoritative_and_must_be_empty() {
    let offered = with_current_status(
        explicit_request(
            "device status",
            vec![function_tool(
                native_actions::DEVICE_STATUS,
                Vec::new(),
                &[],
            )],
        ),
        false,
    );
    let (name, args) = planned(&offered);
    assert_eq!(name, native_actions::DEVICE_STATUS);
    assert_eq!(args, serde_json::json!({}));

    for tool in [
        function_tool(
            native_actions::DEVICE_STATUS,
            vec![parameter("detail", "string")],
            &[],
        ),
        function_tool(
            native_actions::DEVICE_STATUS,
            vec![parameter("detail", "string")],
            &["detail"],
        ),
    ] {
        let request = with_current_status(explicit_request("device status", vec![tool]), false);
        assert!(plan_tool_call(&request).is_none());
    }

    let excluded = with_current_status(
        explicit_request(
            "device status",
            vec![function_tool(
                native_actions::SET_TIMER,
                vec![parameter("minuteDuration", "number")],
                &[],
            )],
        ),
        false,
    );
    assert!(plan_tool_call(&excluded).is_none());
}

#[test]
fn settings_unsafe_power_radio_reset_and_quick_action_tools_are_never_emitted() {
    for name in DENIED_SETTINGS_TOOLS {
        let request = with_current_status(
            explicit_request(
                &name
                    .chars()
                    .flat_map(char::to_lowercase)
                    .collect::<String>(),
                vec![function_tool(name, Vec::new(), &[])],
            ),
            false,
        );
        assert!(plan_tool_call(&request).is_none(), "tool: {name}");
    }
}

#[test]
fn settings_device_status_observation_is_not_re_emitted_on_second_turn() {
    let mut request = settings_request("device status", false);
    request.messages.push(ChatCompletionMessage {
        role: "assistant".to_string(),
        tool_calls: vec![ToolCall {
            id: "call_device_status".to_string(),
            r#type: "function".to_string(),
            function: Some(FunctionCall {
                name: native_actions::DEVICE_STATUS.to_string(),
                arguments: "{}".to_string(),
                ..FunctionCall::default()
            }),
        }],
        ..ChatCompletionMessage::default()
    });
    request.messages.push(ChatCompletionMessage {
        role: "tool".to_string(),
        content: "Device status returned.".to_string(),
        name: native_actions::DEVICE_STATUS.to_string(),
        tool_call_id: "call_device_status".to_string(),
        ..ChatCompletionMessage::default()
    });

    assert!(plan_tool_call(&request).is_none());
}

#[test]
fn contacts_v1_emits_only_the_exact_safe_stock_actions_and_fields() {
    let cases = [
        (
            "Open my contacts",
            native_actions::OPEN_CONTACTS,
            serde_json::json!({}),
        ),
        (
            "Search contacts for Søren Ågård",
            native_actions::SEARCH_CONTACT,
            serde_json::json!({
                "query": "Søren Ågård",
                "resolutionType": "contact"
            }),
        ),
        (
            "What is Alice Smith's phone number?",
            native_actions::SEARCH_CONTACT,
            serde_json::json!({
                "query": "Alice Smith",
                "resolutionType": "phone_number"
            }),
        ),
        (
            "Who are my quick messaging contacts?",
            native_actions::GET_QUICK_MESSAGING_PARTICIPANTS,
            serde_json::json!({}),
        ),
    ];

    for (prompt, expected_name, expected_args) in cases {
        let request = if matches!(
            expected_name,
            native_actions::OPEN_CONTACTS | native_actions::GET_QUICK_MESSAGING_PARTICIPANTS
        ) {
            contacts_request(prompt, false)
        } else {
            toolset_request("contacts", prompt)
        };
        let (name, args) = planned(&request);
        assert_eq!(name, expected_name, "prompt: {prompt}");
        assert_eq!(args, expected_args, "prompt: {prompt}");
    }

    let offered = offered_functions(&toolset_request("contacts", "open contacts"));
    assert_eq!(
        offered.keys().map(String::as_str).collect::<Vec<_>>(),
        vec![
            native_actions::DISPLAY_CONTACT,
            native_actions::GET_QUICK_MESSAGING_PARTICIPANTS,
            native_actions::OPEN_CONTACTS,
            native_actions::SEARCH_CONTACT,
            native_actions::SET_QUICK_MESSAGING_CONTACT
        ]
    );
    assert!(!offered.contains_key(native_actions::CREATE_CONTACT));
    assert!(!offered.contains_key(native_actions::UPDATE_CONTACT_TRUSTED));
}

#[test]
fn keyguard_disabled_contact_tools_require_fresh_exact_unlocked_status() {
    for (prompt, expected) in [
        ("Open my contacts", native_actions::OPEN_CONTACTS),
        (
            "Who are my quick messaging contacts?",
            native_actions::GET_QUICK_MESSAGING_PARTICIPANTS,
        ),
    ] {
        assert!(plan_tool_call(&toolset_request("contacts", prompt)).is_none());
        assert!(plan_tool_call(&contacts_request(prompt, true)).is_none());
        assert_eq!(planned(&contacts_request(prompt, false)).0, expected);

        let mut wrong_name = contacts_request(prompt, false);
        wrong_name.messages[1].name = "OtherStatus".to_string();
        assert!(plan_tool_call(&wrong_name).is_none());

        let mut malformed = contacts_request(prompt, false);
        malformed.messages[1].content = "Ai Pin is locked: unknown".to_string();
        assert!(plan_tool_call(&malformed).is_none());

        let mut unlinked = contacts_request(prompt, false);
        unlinked.messages[1].tool_call_id = "unlinked-status".to_string();
        assert!(plan_tool_call(&unlinked).is_none());

        let mut stale = contacts_request(prompt, false);
        stale.messages.push(message("user", prompt));
        assert!(plan_tool_call(&stale).is_none());
    }

    // Stock marks SearchContact as keyguard-enabled; do not accidentally
    // apply the stricter two-action boundary to the rest of contacts/1.
    assert_eq!(
        planned(&toolset_request("contacts", "Search contacts for Alice")).0,
        native_actions::SEARCH_CONTACT
    );
}

#[test]
fn contact_display_and_quick_messaging_use_only_ids_from_linked_search_results() {
    let mut display = toolset_request("contacts", "Show me Alice Smith's contact");
    append_tool_result(
        &mut display,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "contact"}),
        "Contact Alice Smith with phone number +45 42 49 35 91 and id contact-42 matches the query",
    );
    assert_eq!(
        parse_contact_intent(&display),
        Some(StockIntent::DisplayContact("contact-42".to_string()))
    );
    let (name, args) = planned(&display);
    assert_eq!(name, native_actions::DISPLAY_CONTACT);
    assert_eq!(args, serde_json::json!({"id": "contact-42"}));

    let mut quick = toolset_request("contacts", "Set my quick messaging contact to Alice Smith");
    append_tool_result(
        &mut quick,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "phone_number"}),
        "Phone number +45 42 49 35 91 with id phone-7 for Alice Smith matches the query",
    );
    let (name, args) = planned(&quick);
    assert_eq!(name, native_actions::SET_QUICK_MESSAGING_CONTACT);
    assert_eq!(args, serde_json::json!({"ids": ["phone-7"]}));
}

#[test]
fn contact_disambiguation_accepts_only_a_current_bounded_search_choice() {
    let mut request = toolset_request("contacts", "Show me Alice's contact");
    append_tool_result(
        &mut request,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice", "resolutionType": "contact"}),
        "Multiple contacts match: {id: alice-1,\nname: Alice Smith}, {id: alice-2,\nname: Alice Jones}",
    );

    let mut selected = request.clone();
    selected
        .messages
        .push(message("user", "User selected choice with id alice-2"));
    let (name, args) = planned(&selected);
    assert_eq!(name, native_actions::DISPLAY_CONTACT);
    assert_eq!(args, serde_json::json!({"id": "alice-2"}));

    for selection in [
        "User selected choice with id guessed-id",
        "User selected choice with id ../../secret",
        "alice-1",
    ] {
        let mut rejected = request.clone();
        rejected.messages.push(message("user", selection));
        assert!(
            plan_tool_call(&rejected).is_none(),
            "selection: {selection}"
        );
    }
}

#[test]
fn stale_contact_search_cannot_drive_a_new_display_or_quick_contact_mutation() {
    let mut stale_display = toolset_request("contacts", "Show me Alice Smith's contact");
    append_tool_result(
        &mut stale_display,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "contact"}),
        "Multiple contacts match: {id: alice-1,\nname: Alice Smith}, {id: alice-2,\nname: Alice Jones}",
    );
    stale_display
        .messages
        .push(message("user", "Show me Alice Smith's contact"));
    stale_display
        .messages
        .push(message("user", "User selected choice with id alice-2"));
    assert!(plan_tool_call(&stale_display).is_none());

    let mut stale_mutation =
        toolset_request("contacts", "Set my quick messaging contact to Alice Smith");
    append_tool_result(
        &mut stale_mutation,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "phone_number"}),
        "Phone number +45 42 49 35 91 with id phone-7 for Alice Smith matches the query",
    );
    stale_mutation.messages.push(message(
        "user",
        "Set my quick messaging contact to Alice Smith",
    ));
    stale_mutation
        .messages
        .push(message("user", "User selected choice with id phone-7"));
    assert!(plan_tool_call(&stale_mutation).is_none());
}

#[test]
fn contact_search_results_must_match_the_current_linked_request_exactly() {
    let unique =
        "Contact Alice Smith with phone number +45 42 49 35 91 and id contact-42 matches the query";

    let mut wrong_query = toolset_request("contacts", "Show me Alice Smith's contact");
    append_tool_result(
        &mut wrong_query,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Mallory", "resolutionType": "contact"}),
        unique,
    );
    assert!(plan_tool_call(&wrong_query).is_none());

    let mut wrong_resolution = toolset_request("contacts", "Show me Alice Smith's contact");
    append_tool_result(
        &mut wrong_resolution,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "phone_number"}),
        unique,
    );
    assert!(plan_tool_call(&wrong_resolution).is_none());

    let mut unlinked = toolset_request("contacts", "Show me Alice Smith's contact");
    append_tool_result(
        &mut unlinked,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "contact"}),
        unique,
    );
    unlinked.messages.last_mut().unwrap().tool_call_id = "call_not_present".to_string();
    assert!(plan_tool_call(&unlinked).is_none());

    let mut stale = toolset_request("contacts", "Show me Alice Smith's contact");
    append_tool_result(
        &mut stale,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "contact"}),
        unique,
    );
    stale
        .messages
        .push(message("user", "Show me Bob Jones's contact"));
    assert!(plan_tool_call(&stale).is_some());
    stale.messages.push(message("assistant", ""));
    stale.messages.push(message("tool", unique));
    assert!(plan_tool_call(&stale).is_none());
}

#[test]
fn plain_contact_search_preserves_the_agent_fallback_after_the_search_tool() {
    let mut request = toolset_request("contacts", "Search contacts for Alice Smith");
    append_tool_result(
        &mut request,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "contact"}),
        "Contact Alice Smith with phone number +45 42 49 35 91 and id contact-42 matches the query",
    );
    assert!(plan_tool_call(&request).is_none());
}

#[test]
fn terminal_stock_tool_observations_never_repeat_side_effecting_actions() {
    let terminal_cases = [
        (
            "timer",
            "set a timer for five minutes",
            native_actions::SET_TIMER,
            serde_json::json!({"minuteDuration": 5}),
            "Timer set.",
        ),
        (
            "alarm",
            "set an alarm for 7 am",
            native_actions::SET_ALARM,
            serde_json::json!({"time": "7:00", "ampm": "am"}),
            "Alarm set.",
        ),
        (
            "contacts",
            "open my contacts",
            native_actions::OPEN_CONTACTS,
            serde_json::json!({}),
            "Contacts opened.",
        ),
        (
            "contacts",
            "who are my quick messaging contacts",
            native_actions::GET_QUICK_MESSAGING_PARTICIPANTS,
            serde_json::json!({}),
            "No quick messaging participants are set.",
        ),
    ];

    for (set_name, prompt, action, args, observation) in terminal_cases {
        let mut request = if matches!(
            action,
            native_actions::OPEN_CONTACTS | native_actions::GET_QUICK_MESSAGING_PARTICIPANTS
        ) {
            contacts_request(prompt, false)
        } else {
            toolset_request(set_name, prompt)
        };
        append_tool_result(&mut request, action, args, observation);
        assert!(
            plan_tool_call(&request).is_none(),
            "repeated terminal action {action} for {prompt}"
        );
    }

    let mut display = toolset_request("contacts", "Show me Alice Smith's contact");
    append_tool_result(
        &mut display,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "contact"}),
        "Contact Alice Smith with phone number +45 42 49 35 91 and id contact-42 matches the query",
    );
    append_tool_result(
        &mut display,
        native_actions::DISPLAY_CONTACT,
        serde_json::json!({"id": "contact-42"}),
        "Displayed contact Alice Smith.",
    );
    assert!(plan_tool_call(&display).is_none());

    let mut quick = toolset_request("contacts", "Set my quick messaging contact to Alice Smith");
    append_tool_result(
        &mut quick,
        native_actions::SEARCH_CONTACT,
        serde_json::json!({"query": "Alice Smith", "resolutionType": "phone_number"}),
        "Phone number +45 42 49 35 91 with id phone-7 for Alice Smith matches the query",
    );
    append_tool_result(
        &mut quick,
        native_actions::SET_QUICK_MESSAGING_CONTACT,
        serde_json::json!({"ids": ["phone-7"]}),
        "Quick messaging contact set.",
    );
    assert!(plan_tool_call(&quick).is_none());
}

#[test]
fn phone_resolution_requires_the_exact_optional_stock_field_when_explicit() {
    let without_resolution = explicit_request(
        "What is Alice Smith's phone number?",
        vec![function_tool(
            native_actions::SEARCH_CONTACT,
            vec![parameter("query", "string")],
            &["query"],
        )],
    );
    assert!(plan_tool_call(&without_resolution).is_none());

    let contact_default = explicit_request(
        "Search contacts for Alice Smith",
        vec![function_tool(
            native_actions::SEARCH_CONTACT,
            vec![parameter("query", "string")],
            &["query"],
        )],
    );
    let (name, args) = planned(&contact_default);
    assert_eq!(name, native_actions::SEARCH_CONTACT);
    assert_eq!(args, serde_json::json!({"query": "Alice Smith"}));
}

#[test]
fn ambiguous_mutating_or_out_of_bounds_contact_prompts_never_emit_tools() {
    let oversized = format!(
        "search contacts for {}",
        "A".repeat(MAX_CONTACT_NAME_BYTES + 1)
    );
    for prompt in [
        "Set quick messaging contacts to Alice and Bob".to_string(),
        "Display contact id guessed-id".to_string(),
        "Create a contact for Alice".to_string(),
        "Make Alice a trusted contact".to_string(),
        oversized,
    ] {
        assert!(
            plan_tool_call(&toolset_request("contacts", &prompt)).is_none(),
            "prompt: {prompt}"
        );
    }

    let mut wrong_version = toolset_request("contacts", "open contacts");
    wrong_version.tool_set_version.as_mut().unwrap().version = 2;
    assert!(plan_tool_call(&wrong_version).is_none());
}

#[test]
fn set_timer_uses_exact_stock_numeric_field_and_bounded_value() {
    let (name, args) = planned(&toolset_request("timer", "Please set a 25 minute timer."));
    assert_eq!(name, native_actions::SET_TIMER);
    assert_eq!(args, serde_json::json!({"minuteDuration": 25}));

    assert!(plan_tool_call(&toolset_request("timer", "set a timer for 25 hours")).is_none());
    assert!(plan_tool_call(&toolset_request("timer", "set a timer for 0 minutes")).is_none());
}

#[test]
fn weekday_alarm_emits_exact_stock_fields_when_schema_supports_them() {
    let (name, args) = planned(&toolset_request("alarm", "set a weekday alarm for 7 am"));
    assert_eq!(name, native_actions::SET_ALARM);
    assert_eq!(
        args,
        serde_json::json!({
            "time": "7:00",
            "ampm": "am",
            "recurringDays": ["monday", "tuesday", "wednesday", "thursday", "friday"]
        })
    );

    let request = explicit_request(
        "set a weekday alarm for 7 am",
        vec![function_tool(
            native_actions::SET_ALARM,
            vec![parameter("time", "string"), parameter("ampm", "string")],
            &[],
        )],
    );
    assert!(plan_tool_call(&request).is_none());
}

#[test]
fn cancel_alarm_by_time_uses_unique_id_from_stock_status() {
    let mut request = toolset_request("alarm", "cancel my 7am alarm");
    let (lookup_name, lookup_args) = planned(&request);
    assert_eq!(lookup_name, native_actions::DISPLAY_ALARM);
    assert_eq!(lookup_args, serde_json::json!({}));

    append_tool_result(
        &mut request,
        native_actions::DISPLAY_ALARM,
        serde_json::json!({}),
        "The current time is 2026-07-14 06:00 AM. Scheduled alarms: \n{ ID: 42, nextScheduledTime: 07:00 AM today },\n{ ID: 99, nextScheduledTime: 08:30 PM today }",
    );

    let (name, args) = planned(&request);
    assert_eq!(name, native_actions::CANCEL_ALARM);
    assert_eq!(args, serde_json::json!({"id": "42"}));
}

#[test]
fn cancel_alarm_by_time_never_guesses_without_one_unique_status_match() {
    assert_eq!(
        planned(&toolset_request("alarm", "cancel my 7am alarm")).0,
        native_actions::DISPLAY_ALARM
    );

    let mut request = toolset_request("alarm", "cancel my 7 am alarm");
    append_tool_result(
        &mut request,
        native_actions::DISPLAY_ALARM,
        serde_json::json!({}),
        "Scheduled alarms: \n{ ID: 42, nextScheduledTime: 07:00 AM today },\n{ ID: 43, nextScheduledTime: 07:00 AM tomorrow }",
    );
    assert!(plan_tool_call(&request).is_none());
}

#[test]
fn cancel_alarm_by_time_rejects_stale_unlinked_or_malformed_status_history() {
    const STATUS: &str = "Scheduled alarms: \n{ ID: 42, nextScheduledTime: 07:00 AM today },\n{ ID: 99, nextScheduledTime: 08:30 PM today }";

    // A valid-looking result before the current goal is stale. The planner
    // must request a new DisplayAlarm rather than cancelling from it.
    let mut stale = toolset_request("alarm", "cancel my 7 am alarm");
    let current_goal = stale.messages.pop().unwrap();
    append_tool_result(
        &mut stale,
        native_actions::DISPLAY_ALARM,
        serde_json::json!({}),
        STATUS,
    );
    stale.messages.push(current_goal);
    assert_eq!(planned(&stale).0, native_actions::DISPLAY_ALARM);

    let fresh = || {
        let mut request = toolset_request("alarm", "cancel my 7 am alarm");
        append_tool_result(
            &mut request,
            native_actions::DISPLAY_ALARM,
            serde_json::json!({}),
            STATUS,
        );
        request
    };

    let mut unlinked = fresh();
    unlinked.messages.last_mut().unwrap().tool_call_id = "unlinked".to_string();
    assert!(plan_tool_call(&unlinked).is_none());

    let mut wrong_tool_name = fresh();
    wrong_tool_name.messages.last_mut().unwrap().name = native_actions::CANCEL_ALARM.to_string();
    assert!(plan_tool_call(&wrong_tool_name).is_none());

    let mut wrong_function = fresh();
    wrong_function.messages[1].tool_calls[0]
        .function
        .as_mut()
        .unwrap()
        .name = native_actions::CANCEL_ALARM.to_string();
    assert!(plan_tool_call(&wrong_function).is_none());

    let mut nonempty_schema = fresh();
    nonempty_schema.messages[1].tool_calls[0]
        .function
        .as_mut()
        .unwrap()
        .arguments = r#"{"id":"42"}"#.to_string();
    assert!(plan_tool_call(&nonempty_schema).is_none());

    let mut duplicate_parent_calls = fresh();
    let duplicate = duplicate_parent_calls.messages[1].tool_calls[0].clone();
    duplicate_parent_calls.messages[1]
        .tool_calls
        .push(duplicate);
    assert!(plan_tool_call(&duplicate_parent_calls).is_none());

    let mut no_parent = toolset_request("alarm", "cancel my 7 am alarm");
    no_parent.messages.push(ChatCompletionMessage {
        role: "tool".to_string(),
        content: STATUS.to_string(),
        name: native_actions::DISPLAY_ALARM.to_string(),
        tool_call_id: "missing-parent".to_string(),
        ..ChatCompletionMessage::default()
    });
    assert!(plan_tool_call(&no_parent).is_none());
}

#[test]
fn explicit_tools_are_the_authoritative_offered_set() {
    let request = explicit_request(
        "set a timer for five minutes",
        vec![function_tool(
            native_actions::DELETE_TIMER,
            vec![parameter("id", "string")],
            &[],
        )],
    );
    assert!(plan_tool_call(&request).is_none());

    let request = explicit_request(
        "set a timer for five minutes",
        vec![function_tool(
            native_actions::SET_TIMER,
            vec![parameter("minuteDuration", "number")],
            &[],
        )],
    );
    let (name, args) = planned(&request);
    assert_eq!(name, native_actions::SET_TIMER);
    assert_eq!(args, serde_json::json!({"minuteDuration": 5}));
}

#[test]
fn explicit_enum_casing_is_preserved_exactly() {
    let mut recurring_days = parameter("recurringDays", "array");
    recurring_days.enums = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let mut ampm = parameter("ampm", "string");
    ampm.enums = vec!["AM".to_string(), "PM".to_string()];
    let request = explicit_request(
        "set a weekday alarm for 7 am",
        vec![function_tool(
            native_actions::SET_ALARM,
            vec![parameter("time", "string"), ampm, recurring_days],
            &[],
        )],
    );

    let (_, args) = planned(&request);
    assert_eq!(
        args,
        serde_json::json!({
            "time": "7:00",
            "ampm": "AM",
            "recurringDays": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
        })
    );
}

#[test]
fn explicit_previous_stock_fields_are_used_only_when_offered() {
    let timer = explicit_request(
        "set a timer for five minutes",
        vec![function_tool(
            native_actions::SET_TIMER,
            vec![parameter("Duration", "string"), parameter("Unit", "string")],
            &["Duration", "Unit"],
        )],
    );
    let (_, timer_args) = planned(&timer);
    assert_eq!(
        timer_args,
        serde_json::json!({"Duration": "5", "Unit": "minutes"})
    );

    let alarm = explicit_request(
        "set an alarm for 7 am",
        vec![function_tool(
            native_actions::SET_ALARM,
            vec![parameter("HourTime", "string"), parameter("ampm", "string")],
            &["HourTime"],
        )],
    );
    let (_, alarm_args) = planned(&alarm);
    assert_eq!(
        alarm_args,
        serde_json::json!({"HourTime": "7", "ampm": "am"})
    );
}

#[test]
fn plural_timer_mutations_are_not_guessed() {
    for prompt in ["delete my timers", "pause my timers", "resume my timers"] {
        assert!(plan_tool_call(&toolset_request("timer", prompt)).is_none());
    }
    let (name, args) = planned(&toolset_request("timer", "show my timers"));
    assert_eq!(name, native_actions::DISPLAY_TIMER);
    assert_eq!(args, serde_json::json!({}));
}

#[test]
fn unknown_or_missing_toolsets_never_offer_functions() {
    let missing = ChatCompletionRequest {
        messages: vec![message("user", "delete my timer")],
        tag: "agent".to_string(),
        ..ChatCompletionRequest::default()
    };
    assert!(plan_tool_call(&missing).is_none());
    assert!(plan_tool_call(&toolset_request("settings", "delete my timer")).is_none());

    let mut wrong_version = toolset_request("timer", "delete my timer");
    wrong_version.tool_set_version.as_mut().unwrap().version = 2;
    assert!(plan_tool_call(&wrong_version).is_none());
}

#[test]
fn destructive_functions_are_denied_even_when_explicitly_offered() {
    for name in DESTRUCTIVE_TOOLS {
        let request = explicit_request(
            &name.to_ascii_lowercase(),
            vec![function_tool(name, Vec::new(), &[])],
        );
        assert!(plan_tool_call(&request).is_none(), "tool: {name}");
    }
}

#[test]
fn malformed_or_ambiguous_explicit_schemas_are_ignored() {
    let duplicate_parameter = explicit_request(
        "set a timer for five minutes",
        vec![function_tool(
            native_actions::SET_TIMER,
            vec![
                parameter("minuteDuration", "number"),
                parameter("minuteDuration", "number"),
            ],
            &[],
        )],
    );
    assert!(plan_tool_call(&duplicate_parameter).is_none());

    let missing_required = explicit_request(
        "set a timer for five minutes",
        vec![function_tool(
            native_actions::SET_TIMER,
            vec![parameter("minuteDuration", "number")],
            &["name"],
        )],
    );
    assert!(plan_tool_call(&missing_required).is_none());

    let bad_type = explicit_request(
        "set a timer for five minutes",
        vec![function_tool(
            native_actions::SET_TIMER,
            vec![parameter("minuteDuration", "object")],
            &[],
        )],
    );
    assert!(plan_tool_call(&bad_type).is_none());

    let duplicate_function = explicit_request(
        "delete my timer",
        vec![
            function_tool(
                native_actions::DELETE_TIMER,
                vec![parameter("id", "string")],
                &[],
            ),
            function_tool(
                native_actions::DELETE_TIMER,
                vec![parameter("id", "string")],
                &[],
            ),
        ],
    );
    assert!(plan_tool_call(&duplicate_function).is_none());

    let malformed_then_valid_duplicate = explicit_request(
        "set a timer for five minutes",
        vec![
            function_tool(
                native_actions::SET_TIMER,
                vec![parameter("minuteDuration", "object")],
                &[],
            ),
            function_tool(
                native_actions::SET_TIMER,
                vec![parameter("minuteDuration", "number")],
                &[],
            ),
        ],
    );
    assert!(plan_tool_call(&malformed_then_valid_duplicate).is_none());
}

#[test]
fn unmatched_and_post_tool_requests_preserve_llm_fallback() {
    assert!(plan_tool_call(&toolset_request("timer", "what is the weather")).is_none());

    let mut request = toolset_request("timer", "delete my timer");
    request.messages.push(message("assistant", ""));
    request.messages.push(message("tool", "Timer deleted."));
    assert!(plan_tool_call(&request).is_none());
}

#[test]
fn tool_choice_and_agent_tag_are_respected() {
    let mut request = toolset_request("timer", "delete my timer");
    request.tool_choice = native_actions::SET_TIMER.to_string();
    assert!(plan_tool_call(&request).is_none());

    request.tool_choice = "none".to_string();
    assert!(plan_tool_call(&request).is_none());

    request.tool_choice.clear();
    request.tag = "other".to_string();
    assert!(plan_tool_call(&request).is_none());
}
