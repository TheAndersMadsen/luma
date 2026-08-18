use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Number, Value};
use uuid::Uuid;

use crate::tier_a::native_actions;

use crate::proto::aibus::{
    tool, ChatCompletionRequest, Function, FunctionCall, FunctionParameter, ToolCall,
};
use crate::synapse::capabilities::settings::{
    normalize_bluetooth_device_name, parse_bluetooth_settings_request, BluetoothSettingsOperation,
};

const MAX_UTTERANCE_BYTES: usize = 512;
const MAX_STATUS_BYTES: usize = 32 * 1024;
const MAX_PARAMETERS: usize = 32;
const MAX_CONTACT_NAME_BYTES: usize = 256;
const MAX_CONTACT_ID_BYTES: usize = 128;
const MAX_BLUETOOTH_RESULTS: usize = 32;
const MAX_TOOL_CALL_ID_BYTES: usize = 128;
const MAX_FOOD_ITEMS: usize = 8;
const MAX_FOOD_NAME_BYTES: usize = 128;
const MAX_FOOD_NAME_WORDS: usize = 16;
const MAX_FOOD_QUANTITY_MILLI: u32 = 100_000;
const MAX_FOOD_TOTAL_QUANTITY_MILLI: u32 = 100_000;

const TIMER_TOOLS: &[&str] = &[
    native_actions::SET_TIMER,
    native_actions::EDIT_TIMER,
    native_actions::DELETE_TIMER,
    native_actions::DISPLAY_TIMER,
    native_actions::PAUSE_TIMER,
    native_actions::RESUME_TIMER,
];
const ALARM_TOOLS: &[&str] = &[
    native_actions::SET_ALARM,
    native_actions::CANCEL_ALARM,
    native_actions::DISPLAY_ALARM,
];
const CONTACT_TOOLS: &[&str] = &[
    native_actions::OPEN_CONTACTS,
    native_actions::SEARCH_CONTACT,
    native_actions::DISPLAY_CONTACT,
    native_actions::SET_QUICK_MESSAGING_CONTACT,
    native_actions::GET_QUICK_MESSAGING_PARTICIPANTS,
];
const SETTINGS_TOOLS: &[&str] = &[
    native_actions::CONNECT_TO_BLUETOOTH,
    native_actions::DEVICE_STATUS,
    native_actions::DISCONNECT_BLUETOOTH,
    native_actions::GET_NEW_BLUETOOTH_ADDRESS,
    native_actions::GET_PAIRED_BLUETOOTH_ADDRESS,
];
const FOOD_TOOLS: &[&str] = &["RetrieveFoodInfo", "TrackFoodConsumption", "GetFoodLog"];
const DENIED_SETTINGS_TOOLS: &[&str] = &[
    native_actions::CHANGE_QUICK_ACTION,
    native_actions::FACTORY_RESET,
    native_actions::LOCK_DEVICE,
    native_actions::REBOOT,
    native_actions::SET_VOLUME,
    native_actions::TURN_OFF_AIRPLANE_MODE,
    native_actions::TURN_OFF_BLUETOOTH,
    native_actions::TURN_OFF_DEVICE,
    native_actions::TURN_OFF_WIFI,
    native_actions::TURN_ON_AIRPLANE_MODE,
    native_actions::TURN_ON_BLUETOOTH,
    native_actions::TURN_ON_WIFI,
];
const DESTRUCTIVE_TOOLS: &[&str] = &[
    native_actions::FACTORY_RESET,
    native_actions::REBOOT,
    native_actions::TURN_OFF_DEVICE,
    native_actions::CREATE_CONTACT,
    native_actions::UPDATE_CONTACT_TRUSTED,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ParameterKind {
    String,
    Number,
    StringList,
    FoodItemList,
    Boolean,
}

#[derive(Clone, Debug)]
struct ParameterSchema {
    kind: ParameterKind,
    enums: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct FunctionSchema {
    parameters: BTreeMap<String, ParameterSchema>,
    required: BTreeSet<String>,
}

impl FunctionSchema {
    fn from_function(function: &Function) -> Option<Self> {
        if function.parameters.len() > MAX_PARAMETERS || function.is_required.len() > MAX_PARAMETERS
        {
            return None;
        }

        let mut parameters = BTreeMap::new();
        for parameter in &function.parameters {
            if parameter.name.is_empty()
                || parameter.name.len() > 64
                || parameters.contains_key(&parameter.name)
            {
                return None;
            }
            let kind = parameter_kind(parameter)?;
            if parameter.enums.len() > 64
                || parameter
                    .enums
                    .iter()
                    .any(|value| value.is_empty() || value.len() > 64)
            {
                return None;
            }
            parameters.insert(
                parameter.name.clone(),
                ParameterSchema {
                    kind,
                    enums: parameter.enums.clone(),
                },
            );
        }

        let mut required = BTreeSet::new();
        for name in &function.is_required {
            if !parameters.contains_key(name) || !required.insert(name.clone()) {
                return None;
            }
        }

        Some(Self {
            parameters,
            required,
        })
    }

    fn known(parameters: &[(&str, ParameterKind)]) -> Self {
        Self {
            parameters: parameters
                .iter()
                .map(|(name, kind)| {
                    (
                        (*name).to_string(),
                        ParameterSchema {
                            kind: *kind,
                            enums: Vec::new(),
                        },
                    )
                })
                .collect(),
            required: BTreeSet::new(),
        }
    }

    fn known_required(parameters: &[(&str, ParameterKind)], required: &[&str]) -> Self {
        let mut schema = Self::known(parameters);
        schema.required = required.iter().map(|name| (*name).to_string()).collect();
        schema
    }

    fn parameter(&self, name: &str, kind: ParameterKind) -> Option<&ParameterSchema> {
        self.parameters
            .get(name)
            .filter(|parameter| parameter.kind == kind)
    }

    fn insert_string(&self, args: &mut Map<String, Value>, name: &str, value: &str) -> bool {
        let Some(parameter) = self.parameter(name, ParameterKind::String) else {
            return false;
        };
        let Some(value) = schema_string_value(parameter, value) else {
            return false;
        };
        args.insert(name.to_string(), Value::String(value));
        true
    }

    fn insert_number(&self, args: &mut Map<String, Value>, name: &str, value: u32) -> bool {
        if self.parameter(name, ParameterKind::Number).is_none() {
            return false;
        }
        args.insert(name.to_string(), Value::Number(Number::from(value)));
        true
    }

    fn insert_string_list(
        &self,
        args: &mut Map<String, Value>,
        name: &str,
        values: &[String],
    ) -> bool {
        let Some(parameter) = self.parameter(name, ParameterKind::StringList) else {
            return false;
        };
        let values = values
            .iter()
            .map(|value| schema_string_value(parameter, value))
            .collect::<Option<Vec<_>>>();
        let Some(values) = values else {
            return false;
        };
        args.insert(
            name.to_string(),
            Value::Array(values.into_iter().map(Value::String).collect()),
        );
        true
    }

    fn insert_food_item_list(
        &self,
        args: &mut Map<String, Value>,
        name: &str,
        items: &[FoodItemSpec],
    ) -> bool {
        if self.parameter(name, ParameterKind::FoodItemList).is_none()
            || items.is_empty()
            || items.len() > MAX_FOOD_ITEMS
        {
            return false;
        }
        let Some(values) = items
            .iter()
            .map(FoodItemSpec::to_json)
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };
        args.insert(name.to_string(), Value::Array(values));
        true
    }

    fn validates(&self, args: &Map<String, Value>) -> bool {
        if self.required.iter().any(|name| !args.contains_key(name)) {
            return false;
        }
        args.iter().all(|(name, value)| {
            self.parameters.get(name).is_some_and(|parameter| {
                let type_matches = match parameter.kind {
                    ParameterKind::String => value
                        .as_str()
                        .is_some_and(|value| enum_allows(parameter, value)),
                    ParameterKind::Number => value.is_number(),
                    ParameterKind::StringList => value.as_array().is_some_and(|values| {
                        values.iter().all(|value| {
                            value
                                .as_str()
                                .is_some_and(|value| enum_allows(parameter, value))
                        })
                    }),
                    ParameterKind::FoodItemList => valid_food_item_list_value(value),
                    ParameterKind::Boolean => value.is_boolean(),
                };
                type_matches
            })
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DurationUnit {
    Seconds,
    Minutes,
    Hours,
}

impl DurationUnit {
    fn numeric_field(self) -> &'static str {
        match self {
            Self::Seconds => "secondDuration",
            Self::Minutes => "minuteDuration",
            Self::Hours => "hourDuration",
        }
    }

    fn plural(self) -> &'static str {
        match self {
            Self::Seconds => "seconds",
            Self::Minutes => "minutes",
            Self::Hours => "hours",
        }
    }

    fn allows(self, amount: u32) -> bool {
        match self {
            Self::Seconds => (1..=86_400).contains(&amount),
            Self::Minutes => (1..=1_440).contains(&amount),
            Self::Hours => (1..=24).contains(&amount),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DurationSpec {
    amount: u32,
    unit: DurationUnit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Meridiem {
    Am,
    Pm,
}

impl Meridiem {
    fn as_str(self) -> &'static str {
        match self {
            Self::Am => "am",
            Self::Pm => "pm",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TimeSpec {
    hour: u32,
    minute: u32,
    meridiem: Option<Meridiem>,
}

impl TimeSpec {
    fn canonical_time(self) -> String {
        format!("{}:{:02}", self.hour, self.minute)
    }

    fn time_24h(self) -> String {
        let hour = match self.meridiem {
            Some(Meridiem::Am) if self.hour == 12 => 0,
            Some(Meridiem::Am) => self.hour,
            Some(Meridiem::Pm) if self.hour == 12 => 12,
            Some(Meridiem::Pm) => self.hour + 12,
            None => self.hour,
        };
        format!("{hour}:{:02}", self.minute)
    }

    fn matches_status(self, status: TimeSpec) -> bool {
        match self.meridiem {
            Some(_) => self == status,
            None if self.hour > 12 => self.time_24h() == status.time_24h(),
            None => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AlarmSchedule {
    time: TimeSpec,
    recurring_days: Option<Vec<String>>,
    once_day: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ContactResolution {
    Contact,
    PhoneNumber,
}

impl ContactResolution {
    fn as_str(self) -> &'static str {
        match self {
            Self::Contact => "contact",
            Self::PhoneNumber => "phone_number",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ContactAfterSearch {
    Respond,
    Display,
    SetQuickMessaging,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ContactGoal {
    Open,
    Search {
        query: String,
        resolution: ContactResolution,
        after_search: ContactAfterSearch,
    },
    GetQuickMessagingParticipants,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FoodItemSpec {
    name: String,
    /// Fixed-point quantity in thousandths. This avoids accepting NaN/infinity
    /// or introducing floating-point drift before serializing the stock Float.
    quantity_milli: u32,
}

impl FoodItemSpec {
    fn to_json(&self) -> Option<Value> {
        if !valid_food_name(&self.name)
            || !(1..=MAX_FOOD_QUANTITY_MILLI).contains(&self.quantity_milli)
        {
            return None;
        }
        let quantity = if self.quantity_milli.is_multiple_of(1_000) {
            Number::from(self.quantity_milli / 1_000)
        } else {
            Number::from_f64(f64::from(self.quantity_milli) / 1_000.0)?
        };
        Some(Value::Object(Map::from_iter([
            ("FoodItemName".to_string(), Value::String(self.name.clone())),
            ("IsBranded".to_string(), Value::Bool(false)),
            ("Quantity".to_string(), Value::Number(quantity)),
        ])))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum StockIntent {
    SetTimer(DurationSpec),
    EditTimer(DurationSpec),
    DeleteTimer(Option<String>),
    DisplayTimer(Option<String>),
    PauseTimer(Option<String>),
    ResumeTimer(Option<String>),
    SetAlarm(AlarmSchedule),
    CancelAlarm(Option<String>),
    DisplayAlarm(Option<String>),
    OpenContacts,
    SearchContact {
        query: String,
        resolution: ContactResolution,
    },
    DisplayContact(String),
    SetQuickMessagingContact(Vec<String>),
    GetQuickMessagingParticipants,
    DeviceStatus,
    GetNewBluetoothAddress,
    GetPairedBluetoothAddress,
    ConnectToBluetooth(String),
    DisconnectBluetooth(String),
    RetrieveFoodInfo(Vec<FoodItemSpec>),
    TrackFoodConsumption(Vec<FoodItemSpec>),
    GetFoodLog(u32),
}

/// A stock-compatible top-level clock entry selected from one saved ordinary
/// utterance.
///
/// Timer and Alarm deliberately contain the original request instead of a
/// materialized nested tool call. The device's stock agent handler will submit
/// that request against `timer/1` or `alarm/1`, where [`plan_tool_call`] applies
/// the same bounded parser and schema checks used for ordinary nested turns.
/// WorldClock has no nested agent, so its one required field is returned
/// directly after matching one of the stock regex-shaped phrases.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClockFamilyEntry {
    Timer {
        request: String,
        nested_action_name: &'static str,
        continuation_action_name: Option<&'static str>,
    },
    Alarm {
        request: String,
        nested_action_name: &'static str,
        continuation_action_name: Option<&'static str>,
    },
    WorldClock {
        location: String,
    },
}

impl ClockFamilyEntry {
    /// Top-level `nameForModel` understood by the stock clock experience.
    pub(crate) fn action_name(&self) -> &'static str {
        match self {
            Self::Timer { .. } => native_actions::TIMER,
            Self::Alarm { .. } => native_actions::ALARM,
            Self::WorldClock { .. } => native_actions::WORLD_CLOCK,
        }
    }

    /// The single stock string input to place on the top-level action.
    pub(crate) fn string_input(&self) -> (&'static str, &str) {
        match self {
            Self::Timer { request, .. } | Self::Alarm { request, .. } => ("Request", request),
            Self::WorldClock { location } => ("Location", location),
        }
    }

    /// Nested stock tool that the Timer/Alarm agent will materialize. The
    /// top-level planner checks both this and the family action against the
    /// request's exclusions before entering the agent.
    pub(crate) fn nested_action_name(&self) -> Option<&'static str> {
        match self {
            Self::Timer {
                nested_action_name, ..
            }
            | Self::Alarm {
                nested_action_name, ..
            } => Some(*nested_action_name),
            Self::WorldClock { .. } => None,
        }
    }

    /// A second mutation that is intentionally reached only after a fresh
    /// linked stock observation (currently cancellation by spoken alarm time).
    pub(crate) fn continuation_action_name(&self) -> Option<&'static str> {
        match self {
            Self::Timer {
                continuation_action_name,
                ..
            }
            | Self::Alarm {
                continuation_action_name,
                ..
            } => *continuation_action_name,
            Self::WorldClock { .. } => None,
        }
    }
}

/// Classify a saved, standalone utterance into the stock clock entry point that
/// can execute it.
///
/// This is intentionally not a fuzzy router. Timer and Alarm are admitted only
/// when the existing nested-tool parser can produce an initial supported
/// intent from the exact utterance. Informational questions, compounds,
/// malformed text, unsupported schedules, and inputs beyond
/// [`MAX_UTTERANCE_BYTES`] therefore fail closed. WorldClock accepts only the
/// three stock regex-shaped prefixes followed by one to three plain name words.
pub(crate) fn classify_clock_family_entry(utterance: &str) -> Option<ClockFamilyEntry> {
    if utterance.chars().any(char::is_control) {
        return None;
    }
    let tokens = normalized_tokens(utterance)?;

    if let Some(location) = parse_world_clock_entry(utterance, &tokens) {
        return Some(ClockFamilyEntry::WorldClock { location });
    }

    let tokens = strip_polite_prefix(&tokens);
    let alarm_cancel_by_time = cancel_alarm_remainder(tokens)
        .and_then(cancel_alarm_target_time)
        .is_some();
    let intent = parse_clock_intent(&ChatCompletionRequest::default(), tokens)?;
    let nested_action_name = intent.name();
    match intent {
        StockIntent::SetTimer(_)
        | StockIntent::EditTimer(_)
        | StockIntent::DeleteTimer(_)
        | StockIntent::DisplayTimer(_)
        | StockIntent::PauseTimer(_)
        | StockIntent::ResumeTimer(_) => Some(ClockFamilyEntry::Timer {
            request: utterance.to_string(),
            nested_action_name,
            continuation_action_name: None,
        }),
        StockIntent::SetAlarm(_) | StockIntent::CancelAlarm(_) | StockIntent::DisplayAlarm(_) => {
            Some(ClockFamilyEntry::Alarm {
                request: utterance.to_string(),
                nested_action_name,
                continuation_action_name: alarm_cancel_by_time
                    .then_some(native_actions::CANCEL_ALARM),
            })
        }
        _ => None,
    }
}

impl StockIntent {
    fn name(&self) -> &'static str {
        match self {
            Self::SetTimer(_) => native_actions::SET_TIMER,
            Self::EditTimer(_) => native_actions::EDIT_TIMER,
            Self::DeleteTimer(_) => native_actions::DELETE_TIMER,
            Self::DisplayTimer(_) => native_actions::DISPLAY_TIMER,
            Self::PauseTimer(_) => native_actions::PAUSE_TIMER,
            Self::ResumeTimer(_) => native_actions::RESUME_TIMER,
            Self::SetAlarm(_) => native_actions::SET_ALARM,
            Self::CancelAlarm(_) => native_actions::CANCEL_ALARM,
            Self::DisplayAlarm(_) => native_actions::DISPLAY_ALARM,
            Self::OpenContacts => native_actions::OPEN_CONTACTS,
            Self::SearchContact { .. } => native_actions::SEARCH_CONTACT,
            Self::DisplayContact(_) => native_actions::DISPLAY_CONTACT,
            Self::SetQuickMessagingContact(_) => native_actions::SET_QUICK_MESSAGING_CONTACT,
            Self::GetQuickMessagingParticipants => native_actions::GET_QUICK_MESSAGING_PARTICIPANTS,
            Self::DeviceStatus => native_actions::DEVICE_STATUS,
            Self::GetNewBluetoothAddress => native_actions::GET_NEW_BLUETOOTH_ADDRESS,
            Self::GetPairedBluetoothAddress => native_actions::GET_PAIRED_BLUETOOTH_ADDRESS,
            Self::ConnectToBluetooth(_) => native_actions::CONNECT_TO_BLUETOOTH,
            Self::DisconnectBluetooth(_) => native_actions::DISCONNECT_BLUETOOTH,
            Self::RetrieveFoodInfo(_) => "RetrieveFoodInfo",
            Self::TrackFoodConsumption(_) => "TrackFoodConsumption",
            Self::GetFoodLog(_) => "GetFoodLog",
        }
    }
}

pub(in crate::services::aibus) fn plan_tool_call(
    request: &ChatCompletionRequest,
) -> Option<ToolCall> {
    if request.tag != "agent" || request.tool_choice.eq_ignore_ascii_case("none") {
        return None;
    }

    let offered = offered_functions(request);
    let contact_offered = offered
        .keys()
        .any(|name| CONTACT_TOOLS.contains(&name.as_str()));
    let food_offered = offered
        .keys()
        .any(|name| FOOD_TOOLS.contains(&name.as_str()));
    let alarm_offered = offered
        .keys()
        .any(|name| ALARM_TOOLS.contains(&name.as_str()));
    let settings_offered = offered
        .keys()
        .any(|name| SETTINGS_TOOLS.contains(&name.as_str()));
    let intent = if contact_offered {
        parse_contact_intent(request)
    } else {
        None
    }
    .or_else(|| {
        food_offered
            .then(|| latest_user_utterance(request).and_then(parse_food_intent))
            .flatten()
    })
    .or_else(|| {
        settings_offered
            .then(|| parse_bluetooth_intent(request))
            .flatten()
    })
    .or_else(|| {
        alarm_offered
            .then(|| parse_alarm_status_continuation(request))
            .flatten()
    })
    .or_else(|| {
        let utterance = latest_user_utterance(request)?;
        let tokens = normalized_tokens(utterance)?;
        parse_intent(request, strip_polite_prefix(&tokens))
    })?;
    let name = intent.name();

    if !tool_choice_allows(&request.tool_choice, name)
        || is_destructive(name)
        || (requires_explicit_unlocked_status(&intent)
            && !current_status_is_explicitly_unlocked(request))
    {
        return None;
    }

    let schema = offered.get(name)?;
    let args = materialize_arguments(&intent, schema)?;
    if !schema.validates(&args) {
        return None;
    }

    let call_id = format!(
        "call_penumbra_{}_{}",
        name.to_ascii_lowercase(),
        Uuid::new_v4().simple()
    );
    if call_id.len() > MAX_TOOL_CALL_ID_BYTES {
        return None;
    }

    Some(ToolCall {
        id: call_id,
        r#type: "function".to_string(),
        function: Some(FunctionCall {
            name: name.to_string(),
            arguments: Value::Object(args).to_string(),
            ..FunctionCall::default()
        }),
    })
}

fn offered_functions(request: &ChatCompletionRequest) -> BTreeMap<String, FunctionSchema> {
    if !request.tools.is_empty() {
        return explicit_functions(request);
    }

    let Some(version) = request.tool_set_version.as_ref() else {
        return BTreeMap::new();
    };
    match (version.set_name.as_str(), version.version) {
        ("timer", 1) => timer_v1_functions(),
        ("alarm", 1) => alarm_v1_functions(),
        ("contacts", 1) => contacts_v1_functions(),
        ("settings", 3) => settings_v3_functions(),
        ("food", 4) => food_v4_functions(),
        _ => BTreeMap::new(),
    }
}

fn explicit_functions(request: &ChatCompletionRequest) -> BTreeMap<String, FunctionSchema> {
    let mut offered = BTreeMap::new();
    let mut seen_names = BTreeSet::new();
    let mut duplicate_names = BTreeSet::new();

    for tool in &request.tools {
        let Some(tool::Content::Function(function)) = tool.content.as_ref() else {
            continue;
        };
        if !is_allowlisted(&function.name) || is_destructive(&function.name) {
            continue;
        }
        if !seen_names.insert(function.name.clone()) {
            duplicate_names.insert(function.name.clone());
            continue;
        }
        if let Some(schema) = FunctionSchema::from_function(function) {
            offered.insert(function.name.clone(), schema);
        }
    }

    for name in duplicate_names {
        offered.remove(&name);
    }
    offered
}

fn timer_v1_functions() -> BTreeMap<String, FunctionSchema> {
    use ParameterKind::{Number, String as StringKind};

    BTreeMap::from([
        (
            native_actions::SET_TIMER.to_string(),
            FunctionSchema::known(&[
                ("secondDuration", Number),
                ("minuteDuration", Number),
                ("hourDuration", Number),
                ("name", StringKind),
            ]),
        ),
        (
            native_actions::EDIT_TIMER.to_string(),
            FunctionSchema::known(&[
                ("id", StringKind),
                ("secondDuration", Number),
                ("minuteDuration", Number),
                ("hourDuration", Number),
            ]),
        ),
        (
            native_actions::DELETE_TIMER.to_string(),
            FunctionSchema::known(&[("id", StringKind)]),
        ),
        (
            native_actions::DISPLAY_TIMER.to_string(),
            FunctionSchema::known(&[("id", StringKind)]),
        ),
        (
            native_actions::PAUSE_TIMER.to_string(),
            FunctionSchema::known(&[("id", StringKind)]),
        ),
        (
            native_actions::RESUME_TIMER.to_string(),
            FunctionSchema::known(&[("id", StringKind)]),
        ),
    ])
}

fn alarm_v1_functions() -> BTreeMap<String, FunctionSchema> {
    use ParameterKind::{String as StringKind, StringList};

    BTreeMap::from([
        (
            native_actions::SET_ALARM.to_string(),
            FunctionSchema::known(&[
                ("time", StringKind),
                ("recurringDays", StringList),
                ("ampm", StringKind),
                ("onceDay", StringKind),
            ]),
        ),
        (
            native_actions::CANCEL_ALARM.to_string(),
            FunctionSchema::known(&[("id", StringKind)]),
        ),
        (
            native_actions::DISPLAY_ALARM.to_string(),
            FunctionSchema::known(&[("id", StringKind)]),
        ),
    ])
}

fn contacts_v1_functions() -> BTreeMap<String, FunctionSchema> {
    use ParameterKind::{String as StringKind, StringList};

    BTreeMap::from([
        (
            native_actions::OPEN_CONTACTS.to_string(),
            FunctionSchema::known(&[]),
        ),
        (
            native_actions::SEARCH_CONTACT.to_string(),
            FunctionSchema::known_required(
                &[("query", StringKind), ("resolutionType", StringKind)],
                &["query"],
            ),
        ),
        (
            native_actions::DISPLAY_CONTACT.to_string(),
            FunctionSchema::known(&[("id", StringKind)]),
        ),
        (
            native_actions::SET_QUICK_MESSAGING_CONTACT.to_string(),
            FunctionSchema::known_required(&[("ids", StringList)], &["ids"]),
        ),
        (
            native_actions::GET_QUICK_MESSAGING_PARTICIPANTS.to_string(),
            FunctionSchema::known(&[]),
        ),
    ])
}

fn settings_v3_functions() -> BTreeMap<String, FunctionSchema> {
    use ParameterKind::String as StringKind;

    BTreeMap::from([
        (
            native_actions::CONNECT_TO_BLUETOOTH.to_string(),
            FunctionSchema::known_required(&[("address", StringKind)], &["address"]),
        ),
        (
            native_actions::DEVICE_STATUS.to_string(),
            FunctionSchema::known(&[]),
        ),
        (
            native_actions::DISCONNECT_BLUETOOTH.to_string(),
            FunctionSchema::known_required(&[("address", StringKind)], &["address"]),
        ),
        (
            native_actions::GET_NEW_BLUETOOTH_ADDRESS.to_string(),
            FunctionSchema::known(&[]),
        ),
        (
            native_actions::GET_PAIRED_BLUETOOTH_ADDRESS.to_string(),
            FunctionSchema::known(&[]),
        ),
    ])
}

fn food_v4_functions() -> BTreeMap<String, FunctionSchema> {
    use ParameterKind::{FoodItemList, Number};

    BTreeMap::from([
        (
            "RetrieveFoodInfo".to_string(),
            FunctionSchema::known_required(&[("FoodItemList", FoodItemList)], &["FoodItemList"]),
        ),
        (
            "TrackFoodConsumption".to_string(),
            FunctionSchema::known_required(&[("FoodItemList", FoodItemList)], &["FoodItemList"]),
        ),
        (
            "GetFoodLog".to_string(),
            FunctionSchema::known_required(&[("DayCount", Number)], &["DayCount"]),
        ),
    ])
}

fn materialize_arguments(
    intent: &StockIntent,
    schema: &FunctionSchema,
) -> Option<Map<String, Value>> {
    let mut args = Map::new();
    match intent {
        StockIntent::SetTimer(duration) | StockIntent::EditTimer(duration) => {
            if !schema.insert_number(&mut args, duration.unit.numeric_field(), duration.amount)
                && (!schema.insert_string(&mut args, "Duration", &duration.amount.to_string())
                    || !schema.insert_string(&mut args, "Unit", duration.unit.plural()))
            {
                return None;
            }
        }
        StockIntent::DeleteTimer(id)
        | StockIntent::DisplayTimer(id)
        | StockIntent::PauseTimer(id)
        | StockIntent::ResumeTimer(id)
        | StockIntent::CancelAlarm(id)
        | StockIntent::DisplayAlarm(id) => {
            if let Some(id) = id {
                if !schema.insert_string(&mut args, "id", id) {
                    return None;
                }
            }
        }
        StockIntent::SetAlarm(schedule) => {
            if schema.parameter("time", ParameterKind::String).is_some() {
                let time = if schedule.time.meridiem.is_some()
                    && schema.parameter("ampm", ParameterKind::String).is_none()
                {
                    schedule.time.time_24h()
                } else {
                    schedule.time.canonical_time()
                };
                if !schema.insert_string(&mut args, "time", &time) {
                    return None;
                }
            } else if schedule.time.minute == 0
                && schema
                    .parameter("HourTime", ParameterKind::String)
                    .is_some()
            {
                if !schema.insert_string(&mut args, "HourTime", &schedule.time.hour.to_string()) {
                    return None;
                }
            } else {
                return None;
            }

            if let Some(meridiem) = schedule.time.meridiem {
                if schema.parameter("ampm", ParameterKind::String).is_some()
                    && !schema.insert_string(&mut args, "ampm", meridiem.as_str())
                {
                    return None;
                }
            }
            if let Some(days) = &schedule.recurring_days {
                if !schema.insert_string_list(&mut args, "recurringDays", days) {
                    return None;
                }
            }
            if let Some(day) = &schedule.once_day {
                if !schema.insert_string(&mut args, "onceDay", day) {
                    return None;
                }
            }
        }
        StockIntent::OpenContacts
        | StockIntent::GetQuickMessagingParticipants
        | StockIntent::DeviceStatus
        | StockIntent::GetNewBluetoothAddress
        | StockIntent::GetPairedBluetoothAddress => {
            // These are no-argument stock actions. Reject a conflicting explicit
            // schema instead of silently accepting unknown fields.
            if !schema.parameters.is_empty() {
                return None;
            }
        }
        StockIntent::ConnectToBluetooth(address) | StockIntent::DisconnectBluetooth(address) => {
            let exact_address_schema = schema.parameters.len() == 1
                && schema.required.len() == 1
                && schema.required.contains("address")
                && schema
                    .parameter("address", ParameterKind::String)
                    .is_some_and(|parameter| parameter.enums.is_empty());
            if !exact_address_schema || !schema.insert_string(&mut args, "address", address) {
                return None;
            }
        }
        StockIntent::SearchContact { query, resolution } => {
            if !schema.insert_string(&mut args, "query", query) {
                return None;
            }
            if schema
                .parameter("resolutionType", ParameterKind::String)
                .is_some()
                && !schema.insert_string(&mut args, "resolutionType", resolution.as_str())
            {
                return None;
            }
            if *resolution == ContactResolution::PhoneNumber
                && schema
                    .parameter("resolutionType", ParameterKind::String)
                    .is_none()
            {
                return None;
            }
        }
        StockIntent::DisplayContact(id) => {
            if !schema.insert_string(&mut args, "id", id) {
                return None;
            }
        }
        StockIntent::SetQuickMessagingContact(ids) => {
            if ids.is_empty() || ids.len() > 8 || !schema.insert_string_list(&mut args, "ids", ids)
            {
                return None;
            }
        }
        StockIntent::RetrieveFoodInfo(items) | StockIntent::TrackFoodConsumption(items) => {
            if !schema.insert_food_item_list(&mut args, "FoodItemList", items) {
                return None;
            }
        }
        StockIntent::GetFoodLog(day_count) => {
            if !(1..=30).contains(day_count)
                || !schema.insert_number(&mut args, "DayCount", *day_count)
            {
                return None;
            }
        }
    }
    Some(args)
}

fn parse_food_intent(raw: &str) -> Option<StockIntent> {
    if raw.is_empty() || raw.len() > MAX_UTTERANCE_BYTES || raw.chars().any(char::is_control) {
        return None;
    }

    let command = strip_contact_polite_prefix(raw.trim())
        .trim_end_matches(['.', '?', '!'])
        .trim();
    let normalized = normalize_contact_phrase(command);
    if normalized.is_empty() || contains_food_medical_or_advice_clause(&normalized) {
        return None;
    }

    if let Some(day_count) = parse_food_log_day_count(&normalized) {
        return Some(StockIntent::GetFoodLog(day_count));
    }

    if normalized.starts_with("i ate at ") || normalized.starts_with("i just ate at ") {
        return None;
    }
    for prefix in [
        "i just ate ",
        "i ate ",
        "i drank ",
        "log that i ate ",
        "track that i ate ",
        "track my meal:",
        "track my meal ",
        "track my food:",
        "track my food ",
        "log my meal:",
        "log my meal ",
        "log my food:",
        "log my food ",
    ] {
        if let Some(items) = strip_prefix_ascii_case(command, prefix).and_then(parse_food_items) {
            return Some(StockIntent::TrackFoodConsumption(items));
        }
    }

    for prefix in [
        "what are the nutrition facts for ",
        "what is the nutrition information for ",
        "nutrition information for ",
        "nutrition facts for ",
        "how many calories are in ",
        "how many calories in ",
        "how much protein is in ",
        "how much protein in ",
        "how much sugar is in ",
        "how much sugar in ",
    ] {
        if let Some(items) = strip_prefix_ascii_case(command, prefix).and_then(parse_food_items) {
            return Some(StockIntent::RetrieveFoodInfo(items));
        }
    }
    None
}

fn parse_food_log_day_count(normalized: &str) -> Option<u32> {
    if matches!(
        normalized,
        "what have i eaten today"
            | "what did i eat today"
            | "what have i eaten"
            | "show my food log"
            | "show me my food log"
            | "how many calories did i eat today"
            | "how many calories have i eaten today"
    ) {
        return Some(1);
    }

    for (prefix, suffix) in [
        ("what have i eaten in the last ", " days"),
        ("show my food log for the last ", " days"),
    ] {
        let Some(day_text) = normalized
            .strip_prefix(prefix)
            .and_then(|value| value.strip_suffix(suffix))
        else {
            continue;
        };
        let tokens = normalized_tokens(day_text)?;
        let (days, consumed) = parse_number_at(&tokens, 0)?;
        if consumed == tokens.len() && (1..=30).contains(&days) {
            return Some(days);
        }
    }
    None
}

fn parse_food_items(raw: &str) -> Option<Vec<FoodItemSpec>> {
    let value = raw
        .trim()
        .trim_start_matches(|character: char| character == ':' || character.is_whitespace())
        .trim_end_matches(['.', '?', '!'])
        .trim()
        .to_lowercase();
    if value.is_empty() || value.len() > MAX_UTTERANCE_BYTES {
        return None;
    }

    let raw_parts = if value.contains(',') {
        let parts = value
            .split(',')
            .map(|part| part.trim().strip_prefix("and ").unwrap_or(part.trim()))
            .collect::<Vec<_>>();
        if !parts.iter().all(|part| has_explicit_food_quantity(part)) {
            return None;
        }
        parts
    } else {
        let conjunction_parts = value.split(" and ").collect::<Vec<_>>();
        if conjunction_parts.len() > 1
            && conjunction_parts
                .iter()
                .all(|part| has_explicit_food_quantity(part))
        {
            conjunction_parts
        } else {
            vec![value.as_str()]
        }
    };
    if raw_parts.is_empty() || raw_parts.len() > MAX_FOOD_ITEMS {
        return None;
    }

    let mut seen = BTreeSet::new();
    let mut total_quantity = 0_u32;
    let mut items = Vec::with_capacity(raw_parts.len());
    for part in raw_parts {
        let item = parse_food_item(part)?;
        if !seen.insert(normalize_contact_phrase(&item.name)) {
            return None;
        }
        total_quantity = total_quantity.checked_add(item.quantity_milli)?;
        if total_quantity > MAX_FOOD_TOTAL_QUANTITY_MILLI {
            return None;
        }
        items.push(item);
    }
    Some(items)
}

fn has_explicit_food_quantity(raw: &str) -> bool {
    let first = raw.split_whitespace().next().unwrap_or_default();
    matches!(first, "a" | "an" | "half")
        || parse_decimal_quantity_milli(first).is_some()
        || small_number(first).is_some()
        || matches!(
            first,
            "twenty" | "thirty" | "forty" | "fifty" | "sixty" | "seventy" | "eighty" | "ninety"
        )
}

fn parse_food_item(raw: &str) -> Option<FoodItemSpec> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let words = value
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let first = words.first()?.as_str();

    let (quantity_milli, consumed) = if matches!(first, "a" | "an") {
        (1_000, 1)
    } else if first == "half" {
        let article = words
            .get(1)
            .is_some_and(|word| matches!(word.as_str(), "a" | "an"));
        (500, if article { 2 } else { 1 })
    } else if let Some(quantity) = parse_decimal_quantity_milli(first) {
        (quantity, 1)
    } else if first
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_digit() || character == '.')
    {
        return None;
    } else if let Some((quantity, consumed)) = parse_number_at(&words, 0) {
        (quantity.checked_mul(1_000)?, consumed)
    } else {
        (1_000, 0)
    };

    if !(1..=MAX_FOOD_QUANTITY_MILLI).contains(&quantity_milli) {
        return None;
    }
    let name = words.get(consumed..)?.join(" ");
    if consumed > 0
        && name
            .split_whitespace()
            .next()
            .is_some_and(|word| matches!(word, "dozen" | "hundred" | "thousand" | "point"))
    {
        return None;
    }
    valid_food_name(&name).then_some(FoodItemSpec {
        name,
        quantity_milli,
    })
}

fn parse_decimal_quantity_milli(value: &str) -> Option<u32> {
    if value.is_empty() || value.starts_with('-') || value.starts_with('+') {
        return None;
    }
    let (whole, fractional) = match value.split_once('.') {
        Some((whole, fractional)) => {
            if whole.is_empty()
                || fractional.is_empty()
                || fractional.len() > 3
                || !fractional
                    .chars()
                    .all(|character| character.is_ascii_digit())
            {
                return None;
            }
            (whole, Some(fractional))
        }
        None => (value, None),
    };
    if !whole.chars().all(|character| character.is_ascii_digit()) || whole.len() > 3 {
        return None;
    }
    let whole = whole.parse::<u32>().ok()?;
    let fractional = match fractional {
        Some(fractional) => {
            let scale = match fractional.len() {
                1 => 100,
                2 => 10,
                3 => 1,
                _ => return None,
            };
            fractional.parse::<u32>().ok()?.checked_mul(scale)?
        }
        None => 0,
    };
    let quantity = whole.checked_mul(1_000)?.checked_add(fractional)?;
    (1..=MAX_FOOD_QUANTITY_MILLI)
        .contains(&quantity)
        .then_some(quantity)
}

fn valid_food_name(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty()
        || name.len() > MAX_FOOD_NAME_BYTES
        || name.split_whitespace().count() > MAX_FOOD_NAME_WORDS
        || !name.chars().any(char::is_alphabetic)
        || name.chars().any(|character| {
            !(character.is_alphanumeric()
                || character.is_whitespace()
                || matches!(character, '-' | '\'' | '’' | '&' | '/'))
        })
    {
        return false;
    }
    let normalized = normalize_contact_phrase(name);
    !matches!(
        normalized.as_str(),
        "food"
            | "meal"
            | "my food"
            | "my meal"
            | "something"
            | "that"
            | "that food"
            | "that meal"
            | "them"
            | "this"
            | "this food"
            | "this meal"
            | "these"
            | "those"
            | "it"
            | "what i am eating"
            | "what im eating"
    ) && !normalized.starts_with("this ")
        && !normalized.starts_with("that ")
        && ![
            "this photo",
            "this picture",
            "the photo",
            "the picture",
            "an image",
            "the image",
            "camera",
            "in front of me",
            "what i see",
            "what i am looking at",
            "what im looking at",
        ]
        .iter()
        .any(|reference| normalized.contains(reference))
}

fn contains_food_medical_or_advice_clause(normalized: &str) -> bool {
    let padded = format!(" {normalized} ");
    [
        " should i ",
        " is it healthy",
        " are they healthy",
        " good for me",
        " bad for me",
        " for diabetes",
        " diabetic",
        " medication",
        " medicine",
        " allergy",
        " allergic",
        " disease",
        " lose weight",
        " weight loss",
    ]
    .iter()
    .any(|clause| padded.contains(clause))
}

fn valid_food_item_list_value(value: &Value) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    if items.is_empty() || items.len() > MAX_FOOD_ITEMS {
        return false;
    }
    let mut seen = BTreeSet::new();
    let mut total_milli = 0_u32;
    items.iter().all(|item| {
        let Some(item) = item.as_object() else {
            return false;
        };
        if !(2..=3).contains(&item.len())
            || item
                .keys()
                .any(|key| !matches!(key.as_str(), "FoodItemName" | "IsBranded" | "Quantity"))
        {
            return false;
        }
        let Some(name) = item.get("FoodItemName").and_then(Value::as_str) else {
            return false;
        };
        if !valid_food_name(name)
            || !seen.insert(normalize_contact_phrase(name))
            || item.get("IsBranded").and_then(Value::as_bool) != Some(false)
        {
            return false;
        }
        let quantity = item
            .get("Quantity")
            .map_or(Some(1.0), Value::as_f64)
            .filter(|quantity| quantity.is_finite() && *quantity > 0.0 && *quantity <= 100.0);
        let Some(quantity) = quantity else {
            return false;
        };
        let quantity_milli = (quantity * 1_000.0).round() as u32;
        if (f64::from(quantity_milli) / 1_000.0 - quantity).abs() > f64::EPSILON {
            return false;
        }
        let Some(new_total) = total_milli.checked_add(quantity_milli) else {
            return false;
        };
        total_milli = new_total;
        total_milli <= MAX_FOOD_TOTAL_QUANTITY_MILLI
    })
}

fn parse_contact_intent(request: &ChatCompletionRequest) -> Option<StockIntent> {
    let (goal_index, goal) = request
        .messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| {
            message.role == "user" && parse_selected_contact_id(&message.content).is_none()
        })
        .and_then(|(index, message)| {
            parse_contact_goal(&message.content).map(|goal| (index, goal))
        })?;
    let latest = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role != "system")?;

    if latest.role == "user" {
        if let Some(selected_id) = parse_selected_contact_id(&latest.content) {
            let search = validated_contact_search(request, goal_index, &goal)?;
            if !contact_ids_from_status(search.content).contains(&selected_id) {
                return None;
            }
            return contact_followup_intent(&goal, selected_id, true);
        }
        return initial_contact_intent(goal);
    }

    if latest.role == "tool" && latest.name == native_actions::SEARCH_CONTACT {
        let search = validated_contact_search(request, goal_index, &goal)?;
        let id = unique_contact_id_from_status(search.content, search.resolution)?;
        return contact_followup_intent(&goal, id, false);
    }
    None
}

fn initial_contact_intent(goal: ContactGoal) -> Option<StockIntent> {
    match goal {
        ContactGoal::Open => Some(StockIntent::OpenContacts),
        ContactGoal::Search {
            query, resolution, ..
        } => Some(StockIntent::SearchContact { query, resolution }),
        ContactGoal::GetQuickMessagingParticipants => {
            Some(StockIntent::GetQuickMessagingParticipants)
        }
    }
}

fn contact_followup_intent(
    goal: &ContactGoal,
    id: String,
    after_disambiguation: bool,
) -> Option<StockIntent> {
    let ContactGoal::Search {
        resolution,
        after_search,
        ..
    } = goal
    else {
        return None;
    };
    match after_search {
        ContactAfterSearch::Display => Some(StockIntent::DisplayContact(id)),
        ContactAfterSearch::SetQuickMessaging => (*resolution == ContactResolution::PhoneNumber)
            .then_some(StockIntent::SetQuickMessagingContact(vec![id])),
        ContactAfterSearch::Respond
            if after_disambiguation && *resolution == ContactResolution::Contact =>
        {
            Some(StockIntent::DisplayContact(id))
        }
        ContactAfterSearch::Respond => None,
    }
}

struct ValidatedContactSearch<'a> {
    resolution: ContactResolution,
    content: &'a str,
}

fn validated_contact_search<'a>(
    request: &'a ChatCompletionRequest,
    goal_index: usize,
    goal: &ContactGoal,
) -> Option<ValidatedContactSearch<'a>> {
    let ContactGoal::Search {
        query, resolution, ..
    } = goal
    else {
        return None;
    };
    let (function, content) = completed_contact_search_after_goal(request, goal_index)?;
    if function.arguments.len() > MAX_STATUS_BYTES || content.len() > MAX_STATUS_BYTES {
        return None;
    }
    let args = serde_json::from_str::<Value>(&function.arguments)
        .ok()?
        .as_object()?
        .clone();
    if args.len() > 2
        || args
            .keys()
            .any(|name| !matches!(name.as_str(), "query" | "resolutionType"))
    {
        return None;
    }
    let searched_query = args.get("query")?.as_str()?;
    if !valid_contact_query(searched_query) || searched_query.to_lowercase() != query.to_lowercase()
    {
        return None;
    }
    let searched_resolution = match args
        .get("resolutionType")
        .and_then(Value::as_str)
        .unwrap_or("contact")
    {
        "contact" => ContactResolution::Contact,
        "phone_number" => ContactResolution::PhoneNumber,
        _ => return None,
    };
    if searched_resolution != *resolution {
        return None;
    }
    Some(ValidatedContactSearch {
        resolution: searched_resolution,
        content,
    })
}

fn completed_contact_search_after_goal(
    request: &ChatCompletionRequest,
    goal_index: usize,
) -> Option<(&FunctionCall, &str)> {
    let mut completed_searches = request
        .messages
        .iter()
        .enumerate()
        .skip(goal_index.saturating_add(1))
        .filter(|(_, message)| {
            message.role == "tool" && message.name == native_actions::SEARCH_CONTACT
        });
    let (tool_index, tool_message) = completed_searches.next()?;
    if completed_searches.next().is_some()
        || tool_message.tool_call_id.is_empty()
        || tool_message.tool_call_id.len() > MAX_TOOL_CALL_ID_BYTES
        || !tool_message.tool_calls.is_empty()
    {
        return None;
    }

    let mut parents = request.messages[goal_index + 1..tool_index]
        .iter()
        .filter(|message| message.role != "system");
    let parent = parents.next()?;
    if parents.next().is_some() || parent.role != "assistant" {
        return None;
    }
    let mut calls = parent.tool_calls.iter();
    let call = calls.next()?;
    if calls.next().is_some() || call.id != tool_message.tool_call_id {
        return None;
    }
    let function = call.function.as_ref()?;
    (function.name == native_actions::SEARCH_CONTACT)
        .then_some((function, tool_message.content.as_str()))
}

fn unique_contact_id_from_status(content: &str, resolution: ContactResolution) -> Option<String> {
    if content.len() > MAX_STATUS_BYTES {
        return None;
    }
    let raw_id = match resolution {
        ContactResolution::Contact => {
            let content = content.strip_prefix("Contact ")?;
            let (_, id_and_suffix) = content.rsplit_once(" and id ")?;
            id_and_suffix.strip_suffix(" matches the query")?
        }
        ContactResolution::PhoneNumber => {
            let content = content.strip_prefix("Phone number ")?;
            let (_, id_and_contact) = content.split_once(" with id ")?;
            let (id, contact_and_suffix) = id_and_contact.split_once(" for ")?;
            contact_and_suffix
                .strip_suffix(" matches the query")
                .filter(|contact| !contact.trim().is_empty())?;
            id
        }
    };
    bounded_contact_id(raw_id.trim())
}

fn contact_ids_from_status(content: &str) -> BTreeSet<String> {
    if content.len() > MAX_STATUS_BYTES {
        return BTreeSet::new();
    }
    let mut ids = BTreeSet::new();
    let mut remainder = content;
    while ids.len() < 32 {
        let Some((_, after_marker)) = remainder.split_once("{id: ") else {
            break;
        };
        let end = after_marker
            .find([',', '\n', '}'])
            .unwrap_or(after_marker.len());
        if let Some(id) = bounded_contact_id(after_marker[..end].trim()) {
            ids.insert(id);
        }
        remainder = &after_marker[end..];
    }
    if let Some(id) = unique_contact_id_from_status(content, ContactResolution::Contact)
        .or_else(|| unique_contact_id_from_status(content, ContactResolution::PhoneNumber))
    {
        ids.insert(id);
    }
    ids
}

fn parse_selected_contact_id(content: &str) -> Option<String> {
    let id = content.strip_prefix("User selected choice with id ")?;
    bounded_contact_id(id.trim())
}

fn parse_contact_goal(raw: &str) -> Option<ContactGoal> {
    if raw.is_empty() || raw.len() > MAX_UTTERANCE_BYTES || raw.chars().any(char::is_control) {
        return None;
    }
    let command = strip_contact_polite_prefix(raw.trim());
    let command = command.trim_end_matches(['.', '?', '!']).trim();
    let normalized = normalize_contact_phrase(command);

    if matches!(
        normalized.as_str(),
        "open contacts" | "open my contacts" | "show contacts" | "show my contacts"
    ) {
        return Some(ContactGoal::Open);
    }
    if matches!(
        normalized.as_str(),
        "who are my quick messaging contacts"
            | "who is my quick messaging contact"
            | "show my quick messaging contacts"
            | "list my quick messaging contacts"
            | "get my quick messaging contacts"
            | "who can i quick message"
    ) {
        return Some(ContactGoal::GetQuickMessagingParticipants);
    }

    if let Some(query) = quick_messaging_contact_query(command) {
        return Some(ContactGoal::Search {
            query,
            resolution: ContactResolution::PhoneNumber,
            after_search: ContactAfterSearch::SetQuickMessaging,
        });
    }
    if let Some(query) = display_contact_query(command) {
        return Some(ContactGoal::Search {
            query,
            resolution: ContactResolution::Contact,
            after_search: ContactAfterSearch::Display,
        });
    }
    if let Some(query) = phone_number_contact_query(command) {
        return Some(ContactGoal::Search {
            query,
            resolution: ContactResolution::PhoneNumber,
            after_search: ContactAfterSearch::Respond,
        });
    }
    generic_contact_query(command).map(|query| ContactGoal::Search {
        query,
        resolution: ContactResolution::Contact,
        after_search: ContactAfterSearch::Respond,
    })
}

fn quick_messaging_contact_query(command: &str) -> Option<String> {
    for prefix in [
        "set my quick messaging contact to ",
        "set quick messaging contact to ",
        "use ",
    ] {
        let Some(remainder) = strip_prefix_ascii_case(command, prefix) else {
            continue;
        };
        let query = if prefix == "use " {
            strip_suffix_ascii_case(remainder, " for quick messaging")?
        } else {
            remainder
        };
        return single_contact_query(query);
    }
    for (prefix, suffix) in [
        ("make ", " my quick messaging contact"),
        ("set ", " as my quick messaging contact"),
        ("set ", " as the quick messaging contact"),
    ] {
        if let Some(remainder) = strip_prefix_ascii_case(command, prefix) {
            if let Some(query) = strip_suffix_ascii_case(remainder, suffix) {
                return single_contact_query(query);
            }
        }
    }
    None
}

fn display_contact_query(command: &str) -> Option<String> {
    for prefix in [
        "open contact for ",
        "open contact ",
        "show contact details for ",
        "show contact for ",
        "show me the contact for ",
        "display contact for ",
    ] {
        if let Some(query) = strip_prefix_ascii_case(command, prefix) {
            return single_contact_query(query);
        }
    }
    for prefix in ["show me ", "open ", "show ", "display "] {
        let Some(remainder) = strip_prefix_ascii_case(command, prefix) else {
            continue;
        };
        for suffix in ["'s contact", "’s contact"] {
            if let Some(query) = strip_suffix_ascii_case(remainder, suffix) {
                return single_contact_query(query);
            }
        }
    }
    None
}

fn phone_number_contact_query(command: &str) -> Option<String> {
    for prefix in [
        "find the phone number for ",
        "find phone number for ",
        "look up the phone number for ",
        "look up phone number for ",
        "get the phone number for ",
        "what is the phone number for ",
        "what's the phone number for ",
    ] {
        if let Some(query) = strip_prefix_ascii_case(command, prefix) {
            return single_contact_query(query);
        }
    }
    for prefix in ["what is ", "get ", "find "] {
        let Some(remainder) = strip_prefix_ascii_case(command, prefix) else {
            continue;
        };
        for suffix in ["'s phone number", "’s phone number"] {
            if let Some(query) = strip_suffix_ascii_case(remainder, suffix) {
                return single_contact_query(query);
            }
        }
    }
    None
}

fn generic_contact_query(command: &str) -> Option<String> {
    for prefix in [
        "search my contacts for ",
        "search contacts for ",
        "find a contact for ",
        "find contact ",
        "look up a contact for ",
        "look up contact ",
        "do i have a contact for ",
    ] {
        if let Some(query) = strip_prefix_ascii_case(command, prefix) {
            return single_contact_query(query);
        }
    }
    for prefix in ["find ", "look up "] {
        if let Some(remainder) = strip_prefix_ascii_case(command, prefix) {
            if let Some(query) = strip_suffix_ascii_case(remainder, " in my contacts") {
                return single_contact_query(query);
            }
        }
    }
    None
}

fn single_contact_query(raw: &str) -> Option<String> {
    let query = raw.trim();
    if query.contains(',') || query.to_lowercase().contains(" and ") || !valid_contact_query(query)
    {
        return None;
    }
    Some(query.to_string())
}

fn valid_contact_query(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_CONTACT_NAME_BYTES
        || value.split_whitespace().count() > 8
        || !value.chars().any(char::is_alphabetic)
        || value.chars().any(|character| {
            !(character.is_alphabetic()
                || character.is_whitespace()
                || matches!(character, '-' | '\'' | '’' | '.'))
        })
    {
        return false;
    }
    !matches!(
        normalize_contact_phrase(value).as_str(),
        "a contact"
            | "any contact"
            | "anyone"
            | "contacts"
            | "everyone"
            | "my contact"
            | "phone number"
            | "someone"
            | "trusted contact"
            | "trusted contacts"
    )
}

fn bounded_contact_id(raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > MAX_CONTACT_ID_BYTES
        || !raw.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '.')
        })
    {
        return None;
    }
    Some(raw.to_string())
}

fn normalize_contact_phrase(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character.to_lowercase().next().unwrap_or(character)
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_contact_polite_prefix(mut value: &str) -> &str {
    for prefix in [
        "can you please ",
        "could you please ",
        "would you please ",
        "will you please ",
        "can you ",
        "could you ",
        "would you ",
        "will you ",
        "please ",
    ] {
        if let Some(remainder) = strip_prefix_ascii_case(value, prefix) {
            value = remainder.trim_start();
            break;
        }
    }
    value
}

fn strip_prefix_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let candidate = value.get(..prefix.len())?;
    candidate
        .eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

fn strip_suffix_ascii_case<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    let index = value.len().checked_sub(suffix.len())?;
    value
        .get(index..)?
        .eq_ignore_ascii_case(suffix)
        .then(|| &value[..index])
}

fn parse_intent(request: &ChatCompletionRequest, tokens: &[String]) -> Option<StockIntent> {
    parse_device_status(tokens).or_else(|| parse_clock_intent(request, tokens))
}

/// Shared clock parser used by both nested tool planning and the top-level
/// clock-family entry adapter. Keep clock grammar changes here so a saved
/// vision action and a normal agent turn cannot drift apart.
fn parse_clock_intent(request: &ChatCompletionRequest, tokens: &[String]) -> Option<StockIntent> {
    parse_set_timer(tokens)
        .or_else(|| parse_edit_timer(tokens))
        .or_else(|| parse_simple_timer(tokens))
        .or_else(|| parse_set_alarm(tokens))
        .or_else(|| parse_cancel_alarm(tokens))
        .or_else(|| parse_display_alarm(request, tokens))
}

fn parse_world_clock_entry(raw: &str, tokens: &[String]) -> Option<String> {
    // The firmware regexes are intentionally narrow. Preserve that boundary:
    // punctuation can terminate the utterance (or form "what's"), but cannot
    // turn one captured Location into a list or a compound request.
    if !strict_world_clock_punctuation(raw) {
        return None;
    }

    let location = [
        &["what", "s", "the", "current", "time", "in"][..],
        &["what", "time", "is", "it", "in"][..],
        &["current", "time", "in"][..],
    ]
    .into_iter()
    .find_map(|prefix| strip_words(tokens, prefix))?;

    if !(1..=3).contains(&location.len())
        || location.iter().any(|word| {
            !word.bytes().all(|byte| byte.is_ascii_alphabetic())
                || matches!(word.as_str(), "also" | "and" | "or" | "please" | "then")
        })
    {
        return None;
    }
    Some(location.join(" "))
}

fn strict_world_clock_punctuation(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }

    let body = trimmed
        .strip_suffix('?')
        .or_else(|| trimmed.strip_suffix('.'))
        .or_else(|| trimmed.strip_suffix('!'))
        .unwrap_or(trimmed);
    if body.contains(['?', '.', '!', ',', '"', '-']) {
        return false;
    }

    let apostrophes = body.match_indices('\'').collect::<Vec<_>>();
    apostrophes.is_empty()
        || (apostrophes.len() == 1
            && body
                .get(apostrophes[0].0.saturating_sub(4)..apostrophes[0].0 + 2)
                .is_some_and(|value| value.eq_ignore_ascii_case("what's")))
}

fn parse_device_status(tokens: &[String]) -> Option<StockIntent> {
    [
        &["device", "status"][..],
        &["get", "device", "status"][..],
        &["show", "device", "status"][..],
        &["show", "me", "device", "status"][..],
        &["give", "me", "a", "device", "status"][..],
        &["give", "me", "a", "device", "status", "report"][..],
        &["device", "status", "report"][..],
    ]
    .iter()
    .any(|phrase| matches_words(tokens, phrase))
    .then_some(StockIntent::DeviceStatus)
}

fn parse_set_timer(tokens: &[String]) -> Option<StockIntent> {
    const VERBS: &[&str] = &["set", "start", "create", "begin", "add", "put"];

    for verb in VERBS {
        for prefix in [
            vec![*verb, "a", "timer", "for"],
            vec![*verb, "an", "timer", "for"],
            vec![*verb, "timer", "for"],
        ] {
            if let Some(rest) = strip_words(tokens, &prefix) {
                return parse_duration_exact(rest).map(StockIntent::SetTimer);
            }
        }
    }
    if let Some(rest) = strip_words(tokens, &["timer", "for"]) {
        return parse_duration_exact(rest).map(StockIntent::SetTimer);
    }

    if tokens.last().is_some_and(|token| token == "timer") {
        let mut core = &tokens[..tokens.len() - 1];
        if core
            .first()
            .is_some_and(|token| VERBS.contains(&token.as_str()))
        {
            core = &core[1..];
        }
        if core
            .first()
            .is_some_and(|token| token == "a" || token == "an")
        {
            core = &core[1..];
        }
        return parse_duration_exact(core).map(StockIntent::SetTimer);
    }
    None
}

fn parse_edit_timer(tokens: &[String]) -> Option<StockIntent> {
    if tokens
        .first()
        .is_some_and(|token| matches!(token.as_str(), "add" | "extend" | "increase"))
    {
        for suffix in [
            &["to", "my", "timer"][..],
            &["to", "the", "timer"][..],
            &["to", "timer"][..],
        ] {
            if let Some(duration_tokens) = strip_suffix_words(&tokens[1..], suffix) {
                if let Some(duration) = parse_duration_exact(duration_tokens) {
                    return Some(StockIntent::EditTimer(duration));
                }
            }
        }
    }

    let verb = tokens.first()?.as_str();
    if !matches!(verb, "extend" | "increase" | "lengthen") {
        return None;
    }
    let mut rest = &tokens[1..];
    if rest
        .first()
        .is_some_and(|token| token == "my" || token == "the")
    {
        rest = &rest[1..];
    }
    if rest.first().is_none_or(|token| token != "timer") {
        return None;
    }
    rest = &rest[1..];
    if rest
        .first()
        .is_some_and(|token| matches!(token.as_str(), "by" | "for" | "to"))
    {
        rest = &rest[1..];
    }
    parse_duration_exact(rest).map(StockIntent::EditTimer)
}

fn parse_simple_timer(tokens: &[String]) -> Option<StockIntent> {
    if matches!(tokens.first()?.as_str(), "delete" | "remove" | "cancel") {
        return parse_timer_target(&tokens[1..], false).map(StockIntent::DeleteTimer);
    }
    if matches!(tokens.first()?.as_str(), "pause" | "stop") {
        return parse_timer_target(&tokens[1..], false).map(StockIntent::PauseTimer);
    }
    if matches!(tokens.first()?.as_str(), "resume" | "restart") {
        return parse_timer_target(&tokens[1..], false).map(StockIntent::ResumeTimer);
    }

    for prefix in [
        &["show"][..],
        &["display"][..],
        &["list"][..],
        &["show", "me"][..],
    ] {
        if let Some(rest) = strip_words(tokens, prefix) {
            if let Some(target) = parse_timer_target(rest, true) {
                return Some(StockIntent::DisplayTimer(target));
            }
        }
    }
    if matches_words(tokens, &["what", "are", "my", "timers"])
        || matches_words(tokens, &["what", "is", "my", "timer"])
        || matches_words(tokens, &["how", "much", "time", "is", "left"])
    {
        return Some(StockIntent::DisplayTimer(None));
    }
    None
}

fn parse_timer_target(tokens: &[String], allow_plural: bool) -> Option<Option<String>> {
    let mut rest = tokens;
    if rest
        .first()
        .is_some_and(|token| token == "my" || token == "the")
    {
        rest = &rest[1..];
    }
    if rest.len() == 1 && (rest[0] == "timer" || (allow_plural && rest[0] == "timers")) {
        return Some(None);
    }
    if rest.len() == 3 && rest[0] == "timer" && matches!(rest[1].as_str(), "id" | "number") {
        return bounded_id(&rest[2]).map(Some);
    }
    None
}

fn parse_set_alarm(tokens: &[String]) -> Option<StockIntent> {
    if !tokens
        .first()
        .is_some_and(|token| matches!(token.as_str(), "set" | "start" | "make" | "add" | "create"))
    {
        return None;
    }
    let mut rest = &tokens[1..];
    if rest
        .first()
        .is_some_and(|token| matches!(token.as_str(), "a" | "an" | "my" | "the"))
    {
        rest = &rest[1..];
    }
    let alarm_index = rest.iter().position(|token| token == "alarm")?;
    let pre_modifier = &rest[..alarm_index];
    let mut after_alarm = &rest[alarm_index + 1..];
    if after_alarm
        .first()
        .is_none_or(|token| !matches!(token.as_str(), "for" | "at"))
    {
        return None;
    }
    after_alarm = &after_alarm[1..];

    let (time, consumed) = parse_time_at(after_alarm, 0)?;
    let post_modifier = &after_alarm[consumed..];
    let pre_schedule = parse_alarm_modifier(pre_modifier)?;
    let post_schedule = parse_alarm_modifier(post_modifier)?;
    let (recurring_days, once_day) = merge_alarm_modifiers(pre_schedule, post_schedule)?;

    Some(StockIntent::SetAlarm(AlarmSchedule {
        time,
        recurring_days,
        once_day,
    }))
}

type AlarmModifier = (Option<Vec<String>>, Option<String>);

fn parse_alarm_modifier(tokens: &[String]) -> Option<AlarmModifier> {
    if tokens.is_empty() {
        return Some((None, None));
    }
    let tokens = if tokens.first().is_some_and(|token| token == "on") {
        &tokens[1..]
    } else {
        tokens
    };
    if matches_words(tokens, &["weekday"])
        || matches_words(tokens, &["weekdays"])
        || matches_words(tokens, &["every", "weekday"])
    {
        return Some((Some(weekdays()), None));
    }
    if matches_words(tokens, &["daily"])
        || matches_words(tokens, &["everyday"])
        || matches_words(tokens, &["every", "day"])
    {
        return Some((Some(all_days()), None));
    }
    if matches_words(tokens, &["today"]) || matches_words(tokens, &["tomorrow"]) {
        return Some((None, Some(tokens[0].clone())));
    }
    None
}

fn merge_alarm_modifiers(left: AlarmModifier, right: AlarmModifier) -> Option<AlarmModifier> {
    if (left.0.is_some() && right.0.is_some())
        || (left.1.is_some() && right.1.is_some())
        || ((left.0.is_some() || right.0.is_some()) && (left.1.is_some() || right.1.is_some()))
    {
        return None;
    }
    Some((left.0.or(right.0), left.1.or(right.1)))
}

fn parse_cancel_alarm(tokens: &[String]) -> Option<StockIntent> {
    let rest = cancel_alarm_remainder(tokens)?;

    if matches_words(rest, &["alarm"]) {
        return Some(StockIntent::CancelAlarm(None));
    }
    if rest.len() == 3 && rest[0] == "alarm" && matches!(rest[1].as_str(), "id" | "number") {
        return bounded_id(&rest[2]).map(|id| StockIntent::CancelAlarm(Some(id)));
    }

    // Cancellation by spoken time is a two-step stock flow. First request an
    // unfiltered DisplayAlarm status; only a fresh, exactly linked observation
    // after this same user goal may be resolved into CancelAlarm on the next
    // completion turn.
    cancel_alarm_target_time(rest)?;
    Some(StockIntent::DisplayAlarm(None))
}

fn cancel_alarm_remainder(tokens: &[String]) -> Option<&[String]> {
    let rest = if tokens
        .first()
        .is_some_and(|token| matches!(token.as_str(), "cancel" | "delete" | "remove" | "disable"))
    {
        &tokens[1..]
    } else if starts_with_words(tokens, &["turn", "off"]) {
        &tokens[2..]
    } else {
        return None;
    };
    Some(strip_optional_article(rest))
}

fn cancel_alarm_target_time(rest: &[String]) -> Option<TimeSpec> {
    if rest.first().is_some_and(|token| token == "alarm")
        && rest
            .get(1)
            .is_some_and(|token| matches!(token.as_str(), "at" | "for"))
    {
        parse_time_exact(&rest[2..])
    } else if rest.last().is_some_and(|token| token == "alarm") {
        parse_time_exact(&rest[..rest.len() - 1])
    } else {
        None
    }
}

fn parse_display_alarm(request: &ChatCompletionRequest, tokens: &[String]) -> Option<StockIntent> {
    for prefix in [
        &["show"][..],
        &["display"][..],
        &["list"][..],
        &["show", "me"][..],
    ] {
        let Some(rest) = strip_words(tokens, prefix) else {
            continue;
        };
        let rest = strip_optional_article(rest);
        if rest.len() == 1 && matches!(rest[0].as_str(), "alarm" | "alarms") {
            return Some(StockIntent::DisplayAlarm(None));
        }
        if rest.last().is_some_and(|token| token == "alarm") {
            let time = parse_time_exact(&rest[..rest.len() - 1])?;
            let id = unique_alarm_id_for_time(request, time)?;
            return Some(StockIntent::DisplayAlarm(Some(id)));
        }
    }
    if matches_words(tokens, &["what", "are", "my", "alarms"])
        || matches_words(tokens, &["what", "alarms", "do", "i", "have"])
    {
        return Some(StockIntent::DisplayAlarm(None));
    }
    None
}

fn parse_duration_exact(tokens: &[String]) -> Option<DurationSpec> {
    let (amount, consumed) = parse_number_at(tokens, 0)?;
    if tokens.len() != consumed + 1 {
        return None;
    }
    let unit = match tokens[consumed].as_str() {
        "second" | "seconds" => DurationUnit::Seconds,
        "minute" | "minutes" => DurationUnit::Minutes,
        "hour" | "hours" => DurationUnit::Hours,
        _ => return None,
    };
    unit.allows(amount).then_some(DurationSpec { amount, unit })
}

fn parse_number_at(tokens: &[String], index: usize) -> Option<(u32, usize)> {
    let token = tokens.get(index)?.as_str();
    if token.len() <= 6 && token.chars().all(|character| character.is_ascii_digit()) {
        return token.parse().ok().map(|value| (value, 1));
    }
    if matches!(token, "a" | "an") {
        return Some((1, 1));
    }
    if let Some(value) = small_number(token) {
        return Some((value, 1));
    }
    let tens = match token {
        "twenty" => 20,
        "thirty" => 30,
        "forty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        _ => return None,
    };
    match tokens.get(index + 1).and_then(|token| small_number(token)) {
        Some(value @ 1..=9) => Some((tens + value, 2)),
        _ => Some((tens, 1)),
    }
}

fn small_number(token: &str) -> Option<u32> {
    Some(match token {
        "one" => 1,
        "two" => 2,
        "three" => 3,
        "four" => 4,
        "five" => 5,
        "six" => 6,
        "seven" => 7,
        "eight" => 8,
        "nine" => 9,
        "ten" => 10,
        "eleven" => 11,
        "twelve" => 12,
        "thirteen" => 13,
        "fourteen" => 14,
        "fifteen" => 15,
        "sixteen" => 16,
        "seventeen" => 17,
        "eighteen" => 18,
        "nineteen" => 19,
        _ => return None,
    })
}

fn parse_time_exact(tokens: &[String]) -> Option<TimeSpec> {
    let (time, consumed) = parse_time_at(tokens, 0)?;
    (consumed == tokens.len()).then_some(time)
}

fn parse_time_at(tokens: &[String], index: usize) -> Option<(TimeSpec, usize)> {
    let token = tokens.get(index)?.as_str();
    if token == "noon" {
        return Some((
            TimeSpec {
                hour: 12,
                minute: 0,
                meridiem: Some(Meridiem::Pm),
            },
            1,
        ));
    }
    if token == "midnight" {
        return Some((
            TimeSpec {
                hour: 12,
                minute: 0,
                meridiem: Some(Meridiem::Am),
            },
            1,
        ));
    }

    let (time_token, inline_meridiem) = split_inline_meridiem(token);
    let (hour, minute) = if let Some((hour, minute)) = time_token.split_once(':') {
        if hour.is_empty()
            || minute.len() != 2
            || !hour.chars().all(|character| character.is_ascii_digit())
            || !minute.chars().all(|character| character.is_ascii_digit())
        {
            return None;
        }
        (hour.parse().ok()?, minute.parse().ok()?)
    } else if time_token
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        (time_token.parse().ok()?, 0)
    } else {
        let (hour, consumed) = parse_number_at(tokens, index)?;
        if consumed != 1 {
            return None;
        }
        (hour, 0)
    };

    let mut consumed = 1;
    let meridiem = inline_meridiem.or_else(|| {
        let parsed = parse_meridiem(tokens.get(index + 1)?.as_str());
        if parsed.is_some() {
            consumed += 1;
        }
        parsed
    });
    if minute > 59
        || (meridiem.is_some() && !(1..=12).contains(&hour))
        || (meridiem.is_none() && hour > 23)
    {
        return None;
    }
    Some((
        TimeSpec {
            hour,
            minute,
            meridiem,
        },
        consumed,
    ))
}

fn split_inline_meridiem(token: &str) -> (&str, Option<Meridiem>) {
    if let Some(time) = token.strip_suffix("am") {
        (time, Some(Meridiem::Am))
    } else if let Some(time) = token.strip_suffix("pm") {
        (time, Some(Meridiem::Pm))
    } else {
        (token, None)
    }
}

fn parse_meridiem(token: &str) -> Option<Meridiem> {
    match token {
        "am" => Some(Meridiem::Am),
        "pm" => Some(Meridiem::Pm),
        _ => None,
    }
}

fn parse_alarm_status_continuation(request: &ChatCompletionRequest) -> Option<StockIntent> {
    let user_index = request
        .messages
        .iter()
        .rposition(|message| message.role == "user")?;
    let user_message = request.messages.get(user_index)?;
    let tokens = normalized_tokens(&user_message.content)?;
    let tokens = strip_polite_prefix(&tokens);
    let target_time = cancel_alarm_remainder(tokens).and_then(cancel_alarm_target_time)?;
    let content = completed_alarm_status_after_goal(request, user_index)?;
    let id = unique_alarm_id_in_status(content, target_time)?;
    Some(StockIntent::CancelAlarm(Some(id)))
}

/// Accept only the stock TaoAgent v1 transcript shape produced when the server
/// requested `DisplayAlarm {}` for this exact cancellation goal:
/// user -> one assistant function call -> its linked tool response. Historical,
/// unlinked, duplicated, reordered, or schema-mismatched status is unusable.
fn completed_alarm_status_after_goal(
    request: &ChatCompletionRequest,
    goal_index: usize,
) -> Option<&str> {
    let (tool_index, tool_message) = request
        .messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| message.role != "system")?;
    if tool_index <= goal_index
        || tool_message.role != "tool"
        || tool_message.name != native_actions::DISPLAY_ALARM
        || tool_message.tool_call_id.is_empty()
        || tool_message.tool_call_id.len() > MAX_TOOL_CALL_ID_BYTES
        || tool_message.content.len() > MAX_STATUS_BYTES
        || !tool_message.tool_calls.is_empty()
    {
        return None;
    }

    let mut parents = request.messages[goal_index + 1..tool_index]
        .iter()
        .filter(|message| message.role != "system");
    let parent = parents.next()?;
    if parents.next().is_some() || parent.role != "assistant" || !parent.content.is_empty() {
        return None;
    }
    let mut calls = parent.tool_calls.iter();
    let call = calls.next()?;
    if calls.next().is_some() || call.id != tool_message.tool_call_id || call.r#type != "function" {
        return None;
    }
    let function = call.function.as_ref()?;
    if function.name != native_actions::DISPLAY_ALARM || function.arguments.len() > 64 {
        return None;
    }
    let arguments = serde_json::from_str::<Value>(&function.arguments).ok()?;
    arguments
        .as_object()
        .is_some_and(Map::is_empty)
        .then_some(tool_message.content.as_str())
}

fn unique_alarm_id_for_time(
    request: &ChatCompletionRequest,
    requested: TimeSpec,
) -> Option<String> {
    let content = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "tool" && message.content.contains("Scheduled alarms:"))?
        .content
        .as_str();
    unique_alarm_id_in_status(content, requested)
}

fn unique_alarm_id_in_status(content: &str, requested: TimeSpec) -> Option<String> {
    let mut matches = alarm_status_entries(content)
        .into_iter()
        .filter(|(_, time)| requested.matches_status(*time))
        .map(|(id, _)| id);
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn alarm_status_entries(content: &str) -> Vec<(String, TimeSpec)> {
    let mut entries = Vec::new();
    if content.len() > MAX_STATUS_BYTES || !content.contains("Scheduled alarms:") {
        return entries;
    }

    for chunk in content.split("{ ID: ").skip(1) {
        let Some((id, rest)) = chunk.split_once(',') else {
            continue;
        };
        let Some(id) = bounded_id(id.trim()) else {
            continue;
        };
        let Some((_, time_text)) = rest.split_once("nextScheduledTime:") else {
            continue;
        };
        let time_text = time_text.split('}').next().unwrap_or(time_text);
        let Some(tokens) = normalized_tokens(time_text) else {
            continue;
        };
        let Some((time, _)) = parse_time_at(&tokens, 0) else {
            continue;
        };
        if time.meridiem.is_some() {
            entries.push((id, time));
        }
    }
    entries
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BluetoothDeviceResult {
    name: String,
    address: String,
}

fn parse_bluetooth_intent(request: &ChatCompletionRequest) -> Option<StockIntent> {
    let (user_index, user_message) = request
        .messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| message.role == "user")?;
    let goal = parse_bluetooth_settings_request(&user_message.content)?;
    let (latest_index, latest) = request
        .messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| message.role != "system")?;

    if latest_index == user_index {
        return Some(match goal.operation {
            BluetoothSettingsOperation::Connect => StockIntent::GetNewBluetoothAddress,
            BluetoothSettingsOperation::Disconnect => StockIntent::GetPairedBluetoothAddress,
        });
    }

    let expected_lookup = goal.operation.lookup_action_name();
    if latest.role != "tool" || latest.name != expected_lookup {
        return None;
    }
    let content = validated_bluetooth_lookup(request, user_index, latest_index, expected_lookup)?;
    let address = unique_bluetooth_address_for_name(content, &goal.device_name)?;
    Some(match goal.operation {
        BluetoothSettingsOperation::Connect => StockIntent::ConnectToBluetooth(address),
        BluetoothSettingsOperation::Disconnect => StockIntent::DisconnectBluetooth(address),
    })
}

/// Resolve only a tool observation linked to exactly one parent lookup call
/// after the current named-device request. The lookup actions have no fields;
/// any arguments or mismatched tool name fail closed.
fn validated_bluetooth_lookup<'a>(
    request: &'a ChatCompletionRequest,
    user_index: usize,
    tool_index: usize,
    expected_lookup: &str,
) -> Option<&'a str> {
    let tool_message = request.messages.get(tool_index)?;
    if tool_index <= user_index
        || tool_message.tool_call_id.is_empty()
        || tool_message.tool_call_id.len() > MAX_TOOL_CALL_ID_BYTES
        || tool_message.content.len() > MAX_STATUS_BYTES
    {
        return None;
    }

    let mut linked_calls = request.messages[user_index + 1..tool_index]
        .iter()
        .filter(|message| message.role == "assistant")
        .flat_map(|message| message.tool_calls.iter());
    let call = linked_calls.next()?;
    if linked_calls.next().is_some() || call.id != tool_message.tool_call_id {
        return None;
    }
    let function = call.function.as_ref()?;
    if function.name != expected_lookup || function.arguments.len() > 64 {
        return None;
    }
    let arguments = serde_json::from_str::<Value>(&function.arguments).ok()?;
    if !arguments.as_object()?.is_empty() {
        return None;
    }
    Some(tool_message.content.as_str())
}

fn unique_bluetooth_address_for_name(content: &str, requested_name: &str) -> Option<String> {
    let requested_name = normalize_bluetooth_device_name(requested_name)?;
    let mut addresses = BTreeSet::new();
    for device in parse_bluetooth_device_results(content)? {
        if normalize_bluetooth_device_name(&device.name)? == requested_name {
            addresses.insert(device.address);
        }
    }
    let address = addresses.pop_first()?;
    addresses.is_empty().then_some(address)
}

/// Exact output contract recovered from both stock lookup handlers:
/// ` name: <name> address: "<MAC>"` repeated without a separator.
fn parse_bluetooth_device_results(content: &str) -> Option<Vec<BluetoothDeviceResult>> {
    if content.is_empty() || content.len() > MAX_STATUS_BYTES {
        return None;
    }
    if matches!(
        content,
        "getDiscoveredDevices found no devices" | "getPairedDevices found no devices"
    ) {
        return Some(Vec::new());
    }

    let mut remainder = content;
    let mut devices = Vec::new();
    while !remainder.is_empty() {
        remainder = remainder.strip_prefix(" name: ")?;
        let (name, after_name) = remainder.split_once(" address: \"")?;
        let closing_quote = after_name.find('"')?;
        let address = &after_name[..closing_quote];
        remainder = &after_name[closing_quote + 1..];

        let name = name.trim();
        if devices.len() >= MAX_BLUETOOTH_RESULTS
            || normalize_bluetooth_device_name(name).is_none()
            || !valid_bluetooth_address(address)
            || (!remainder.is_empty() && !remainder.starts_with(" name: "))
        {
            return None;
        }
        devices.push(BluetoothDeviceResult {
            name: name.to_string(),
            address: address.to_string(),
        });
    }
    (!devices.is_empty()).then_some(devices)
}

fn valid_bluetooth_address(value: &str) -> bool {
    let mut octets = value.split(':');
    (0..6).all(|_| {
        octets.next().is_some_and(|octet| {
            octet.len() == 2 && octet.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    }) && octets.next().is_none()
}

fn latest_user_utterance(request: &ChatCompletionRequest) -> Option<&str> {
    let latest = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role != "system")?;
    (latest.role == "user" && !latest.content.trim().is_empty()).then_some(latest.content.as_str())
}

fn requires_explicit_unlocked_status(intent: &StockIntent) -> bool {
    matches!(
        intent,
        StockIntent::OpenContacts
            | StockIntent::GetQuickMessagingParticipants
            | StockIntent::DeviceStatus
            | StockIntent::GetNewBluetoothAddress
            | StockIntent::GetPairedBluetoothAddress
            | StockIntent::ConnectToBluetooth(_)
            | StockIntent::DisconnectBluetooth(_)
    )
}

/// DeviceStatus and the two keyguard-disabled Contacts tools expose private
/// state, while Bluetooth lookup/mutation touches nearby radio state. Require
/// an exactly linked CurrentStatus observation immediately before the current
/// user goal to say the Pin is unlocked. Missing, stale, malformed, or
/// oversized status fails closed.
fn current_status_is_explicitly_unlocked(request: &ChatCompletionRequest) -> bool {
    let Some(user_index) = request
        .messages
        .iter()
        .rposition(|message| message.role == "user")
    else {
        return false;
    };
    let mut preceding = request.messages[..user_index]
        .iter()
        .rev()
        .filter(|message| message.role != "system");
    let Some(status) = preceding.next() else {
        return false;
    };
    let Some(parent) = preceding.next() else {
        return false;
    };
    if status.role != "tool"
        || status.name != "CurrentStatus"
        || parent.role != "assistant"
        || status.tool_call_id.is_empty()
        || status.tool_call_id.len() > MAX_TOOL_CALL_ID_BYTES
        || status.content.len() > MAX_STATUS_BYTES
    {
        return false;
    }
    let mut calls = parent.tool_calls.iter();
    let Some(call) = calls.next() else {
        return false;
    };
    if calls.next().is_some() || call.id != status.tool_call_id {
        return false;
    }
    let Some(function) = call.function.as_ref() else {
        return false;
    };
    if function.name != "CurrentStatus" || function.arguments.len() > 64 {
        return false;
    }
    let Ok(arguments) = serde_json::from_str::<Value>(&function.arguments) else {
        return false;
    };
    arguments.as_object().is_some_and(Map::is_empty)
        && parse_device_lock_state(&status.content) == Some(false)
}

fn parse_device_lock_state(status: &str) -> Option<bool> {
    status.lines().find_map(|line| {
        let value = strip_prefix_ascii_case(line.trim(), "Ai Pin is locked:")?.trim();
        match value {
            value if value.eq_ignore_ascii_case("true") => Some(true),
            value if value.eq_ignore_ascii_case("false") => Some(false),
            _ => None,
        }
    })
}

fn normalized_tokens(raw: &str) -> Option<Vec<String>> {
    if raw.is_empty() || raw.len() > MAX_UTTERANCE_BYTES || !raw.is_ascii() {
        return None;
    }
    let mut normalized = String::with_capacity(raw.len());
    for character in raw.chars() {
        match character {
            character if character.is_ascii_alphanumeric() || character == ':' => {
                normalized.push(character.to_ascii_lowercase());
            }
            character
                if character.is_ascii_whitespace()
                    || matches!(character, '.' | ',' | '?' | '!' | '-' | '\'' | '"') =>
            {
                normalized.push(' ');
            }
            _ => return None,
        }
    }
    let tokens = normalized
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    (!tokens.is_empty()).then_some(tokens)
}

fn strip_polite_prefix(mut tokens: &[String]) -> &[String] {
    if tokens.first().is_some_and(|token| token == "please") {
        tokens = &tokens[1..];
    }
    if tokens.len() >= 2
        && matches!(tokens[0].as_str(), "can" | "could" | "would" | "will")
        && tokens[1] == "you"
    {
        tokens = &tokens[2..];
        if tokens.first().is_some_and(|token| token == "please") {
            tokens = &tokens[1..];
        }
    }
    tokens
}

fn strip_optional_article(tokens: &[String]) -> &[String] {
    if tokens
        .first()
        .is_some_and(|token| matches!(token.as_str(), "my" | "the" | "a" | "an"))
    {
        &tokens[1..]
    } else {
        tokens
    }
}

fn strip_words<'a>(tokens: &'a [String], prefix: &[&str]) -> Option<&'a [String]> {
    starts_with_words(tokens, prefix).then(|| &tokens[prefix.len()..])
}

fn strip_suffix_words<'a>(tokens: &'a [String], suffix: &[&str]) -> Option<&'a [String]> {
    if tokens.len() < suffix.len()
        || !tokens[tokens.len() - suffix.len()..]
            .iter()
            .map(String::as_str)
            .eq(suffix.iter().copied())
    {
        return None;
    }
    Some(&tokens[..tokens.len() - suffix.len()])
}

fn starts_with_words(tokens: &[String], prefix: &[&str]) -> bool {
    tokens.len() >= prefix.len()
        && tokens
            .iter()
            .take(prefix.len())
            .map(String::as_str)
            .eq(prefix.iter().copied())
}

fn matches_words(tokens: &[String], expected: &[&str]) -> bool {
    tokens.len() == expected.len() && starts_with_words(tokens, expected)
}

fn bounded_id(raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > 18
        || !raw.chars().all(|character| character.is_ascii_digit())
        || raw == "0"
    {
        return None;
    }
    Some(raw.to_string())
}

fn parameter_kind(parameter: &FunctionParameter) -> Option<ParameterKind> {
    match parameter.r#type.trim().to_ascii_lowercase().as_str() {
        "string" => Some(ParameterKind::String),
        "number" | "integer" => Some(ParameterKind::Number),
        "array" | "string_list" | "string-list" | "list<string>" => Some(ParameterKind::StringList),
        "boolean" | "bool" => Some(ParameterKind::Boolean),
        _ => None,
    }
}

fn enum_allows(parameter: &ParameterSchema, value: &str) -> bool {
    parameter.enums.is_empty()
        || parameter
            .enums
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(value))
}

fn schema_string_value(parameter: &ParameterSchema, value: &str) -> Option<String> {
    if parameter.enums.is_empty() {
        return Some(value.to_string());
    }
    parameter
        .enums
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(value))
        .cloned()
}

fn is_allowlisted(name: &str) -> bool {
    TIMER_TOOLS.contains(&name)
        || ALARM_TOOLS.contains(&name)
        || CONTACT_TOOLS.contains(&name)
        || SETTINGS_TOOLS.contains(&name)
        || FOOD_TOOLS.contains(&name)
}

fn is_destructive(name: &str) -> bool {
    DESTRUCTIVE_TOOLS.contains(&name) || DENIED_SETTINGS_TOOLS.contains(&name)
}

fn tool_choice_allows(choice: &str, name: &str) -> bool {
    choice.is_empty()
        || choice.eq_ignore_ascii_case("auto")
        || choice.eq_ignore_ascii_case("required")
        || choice == name
}

fn weekdays() -> Vec<String> {
    ["monday", "tuesday", "wednesday", "thursday", "friday"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn all_days() -> Vec<String> {
    [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

#[cfg(test)]
#[path = "stock_agent/tests.rs"]
mod tests;
