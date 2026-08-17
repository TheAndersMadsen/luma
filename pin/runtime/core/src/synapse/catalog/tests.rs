use std::collections::{BTreeMap, BTreeSet};

use crate::tier_a::native_actions;

use super::*;

#[test]
fn a_mutation_needs_the_user_to_ask_for_it_in_this_turn() {
    let spec = native_action_spec(native_actions::PLAY_MUSIC).expect("PlayMusic is callable");
    let arguments = serde_json::json!({});

    // The anchor is present: this is a real request to play something.
    assert!(
        enforce_mutation_grounding(spec, &arguments, "play the best song by Nina Simone").is_ok()
    );
    // Punctuation and case must not defeat the anchor.
    assert!(enforce_mutation_grounding(spec, &arguments, "Play  it!").is_ok());

    // No anchor: the model decided to start playback from context alone,
    // which is exactly what the contract exists to stop.
    let refused = enforce_mutation_grounding(spec, &arguments, "who sang that again");
    assert!(refused.is_err(), "an unanchored mutation must be refused");
}

#[test]
fn strict_fieldless_music_commands_accept_local_phrases_and_bounded_wrappers() {
    let arguments = serde_json::json!({});
    for (action, utterances) in [
        (
            native_actions::PLAY_FAVORITE_TRACKS,
            &[
                "play favorites",
                "play favorite tracks",
                "play my favourites",
                "play my favourite songs",
                "play my favourite track",
                "play liked songs",
                "play my liked tracks",
                "play my saved song",
                "play my saved songs",
                "play my saved tracks",
                "could you put on my favourites",
                "would you please put on my saved tracks for me",
            ][..],
        ),
        (
            native_actions::PLAY_CURRENT_TRACK_RADIO,
            &[
                "play similar music",
                "play similar songs",
                "play similar tracks",
                "play songs like this",
                "play more like this",
                "track radio",
                "song radio",
                "play current song radio",
                "play current track radio",
                "play the current song radio",
                "play the current track radio",
                "start a radio from this song",
                "start a radio from this track",
                "start a radio from the current song",
                "could you please start a radio from the current track now",
            ][..],
        ),
        (
            native_actions::PLAY_FEATURED_MUSIC,
            &[
                "play music",
                "play some music",
                "play something",
                "please play music",
                "could you play something",
                "would you please play some music for me",
            ][..],
        ),
    ] {
        let spec = native_action_spec(action).expect("music action is callable");
        for utterance in utterances {
            assert!(
                enforce_mutation_grounding(spec, &arguments, utterance).is_ok(),
                "{action} should be grounded by {utterance:?}",
            );
        }
    }
}

#[test]
fn radio_grounding_rejects_bare_deictics_but_accepts_explicit_commands() {
    let radio = native_action_spec(native_actions::PLAY_CURRENT_TRACK_RADIO).unwrap();
    let arguments = serde_json::json!({});

    for utterance in [
        "more like this",
        "more like this one",
        "songs like this",
        "please more like this",
        "songs like this please",
    ] {
        assert_eq!(
            classify_fieldless_music_grounding(radio, utterance),
            Some(FieldlessMusicGrounding::NonAuthoritativeDirectActionMention),
            "bare deictic {utterance:?} must require deterministic recent-track context",
        );
        assert!(
            enforce_mutation_grounding(radio, &arguments, utterance).is_err(),
            "bare deictic {utterance:?} must not authorize terminal dispatch",
        );
    }

    for utterance in [
        "play similar songs",
        "play more like this",
        "please play more like this",
        "track radio",
        "start a radio from this track",
        "start a radio from the current song",
    ] {
        assert_eq!(
            classify_fieldless_music_grounding(radio, utterance),
            Some(FieldlessMusicGrounding::AuthoritativeDirectCommand),
            "explicit radio command {utterance:?} should carry current-turn authority",
        );
        assert!(
            enforce_mutation_grounding(radio, &arguments, utterance).is_ok(),
            "explicit radio command {utterance:?} should authorize terminal dispatch",
        );
    }
}

#[test]
fn strict_fieldless_music_commands_reject_mentions_and_other_authority() {
    let arguments = serde_json::json!({});
    for (action, utterance, category) in [
        (
            native_actions::PLAY_FEATURED_MUSIC,
            "I heard you play music yesterday",
            "incidental mention",
        ),
        (
            native_actions::PLAY_FEATURED_MUSIC,
            "don't play music",
            "negated command",
        ),
        (
            native_actions::PLAY_CURRENT_TRACK_RADIO,
            "I don't like songs like this",
            "negated opinion",
        ),
        (
            native_actions::PLAY_FEATURED_MUSIC,
            "Why did you play something?",
            "informational question",
        ),
        (
            native_actions::PLAY_CURRENT_TRACK_RADIO,
            "what does track radio mean?",
            "metalinguistic question",
        ),
        (
            native_actions::PLAY_FEATURED_MUSIC,
            "\"play music\"",
            "quoted exact command",
        ),
        (
            native_actions::PLAY_FAVORITE_TRACKS,
            "repeat 'play my favorites'",
            "quoted mention",
        ),
        (
            native_actions::PLAY_FEATURED_MUSIC,
            "play music and text Alice",
            "compound command",
        ),
        (
            native_actions::PLAY_FAVORITE_TRACKS,
            "play my favorites, then call Alice",
            "compound command",
        ),
        (
            native_actions::PLAY_FEATURED_MUSIC,
            "play something by Nina Simone",
            "named artist",
        ),
        (
            native_actions::PLAY_FAVORITE_TRACKS,
            "play favorite songs by Adele",
            "named artist",
        ),
        (
            native_actions::PLAY_FAVORITE_TRACKS,
            "Play Adele's favourite song",
            "third-party possessive",
        ),
        (
            native_actions::PLAY_CURRENT_TRACK_RADIO,
            "make the projector more like this one",
            "non-music projector request",
        ),
        (
            native_actions::PLAY_CURRENT_TRACK_RADIO,
            "songs like this and turn on the projector",
            "non-music compound",
        ),
        (
            native_actions::PLAY_FEATURED_MUSIC,
            "please please play music",
            "unbounded wrapper stacking",
        ),
        (
            native_actions::PLAY_FAVORITE_TRACKS,
            "play music",
            "different music action",
        ),
    ] {
        let spec = native_action_spec(action).expect("music action is callable");
        assert!(
            enforce_mutation_grounding(spec, &arguments, utterance).is_err(),
            "{category} authorized {action}: {utterance:?}",
        );
    }
}

#[test]
fn fieldless_music_classifier_separates_commands_mentions_and_catalog_collisions() {
    let featured = native_action_spec(native_actions::PLAY_FEATURED_MUSIC).unwrap();
    let favorites = native_action_spec(native_actions::PLAY_FAVORITE_TRACKS).unwrap();
    let radio = native_action_spec(native_actions::PLAY_CURRENT_TRACK_RADIO).unwrap();

    assert_eq!(
        classify_fieldless_music_grounding(featured, "play some music"),
        Some(FieldlessMusicGrounding::AuthoritativeDirectCommand)
    );
    for (spec, utterance) in [
        (favorites, "what happens if I say play my favorites"),
        (featured, "do not play music"),
        (radio, "make the projector more like this one"),
        (featured, "play music and text Alice"),
    ] {
        assert_eq!(
            classify_fieldless_music_grounding(spec, utterance),
            Some(FieldlessMusicGrounding::NonAuthoritativeDirectActionMention),
            "{utterance:?}"
        );
    }
    for (spec, utterance) in [
        (featured, "play something by Nina Simone"),
        (favorites, "Play Favorite Tracks by Prince"),
        (favorites, "Play Adele's favourite song"),
    ] {
        assert_eq!(
            classify_fieldless_music_grounding(spec, utterance),
            Some(FieldlessMusicGrounding::NamedCatalogCollision),
            "{utterance:?}"
        );
    }
    assert_eq!(
        classify_fieldless_music_grounding(favorites, "what is playing"),
        None
    );
}

#[test]
fn an_exact_user_span_argument_cannot_be_a_paraphrase() {
    let spec = native_action_spec(native_actions::SET_ALARM).expect("SetAlarm is callable");

    // `time` is ExactUserSpan: "7:30" is in the utterance, so it stands.
    let honest = serde_json::json!({ "time": "7:30" });
    assert!(enforce_mutation_grounding(spec, &honest, "set an alarm for 7:30").is_ok());

    // The model rewrote the span into something the user never said. The
    // action is still plausible, which is why only the span check catches it.
    let invented = serde_json::json!({ "time": "6:15" });
    assert!(
        enforce_mutation_grounding(spec, &invented, "set an alarm for 7:30").is_err(),
        "an invented span must be refused",
    );

    let playlist = native_action_spec(native_actions::GENERATE_MUSIC_PLAYLIST)
        .expect("GenerateMusicPlaylist is callable");
    assert!(enforce_mutation_grounding(
        playlist,
        &serde_json::json!({"Playlist": "running"}),
        "make a playlist for running",
    )
    .is_ok());
    for partial in ["run", "inning"] {
        assert!(
            enforce_mutation_grounding(
                playlist,
                &serde_json::json!({"Playlist": partial}),
                "make a playlist for running",
            )
            .is_err(),
            "partial word {partial:?} must not count as an exact user span",
        );
    }
}

#[test]
fn lexical_action_anchors_match_whole_words_only() {
    let call = native_action_spec(native_actions::CALL_PERSON).expect("CallPerson is callable");
    assert!(
        enforce_mutation_grounding(call, &serde_json::json!({"To": ["Sarah"]}), "call Sarah",)
            .is_ok()
    );
    assert!(
        enforce_mutation_grounding(call, &serde_json::json!({"To": ["Sarah"]}), "recall Sarah",)
            .is_err(),
        "the single-word call anchor must not match inside recall",
    );
}

#[test]
fn natural_phrasing_still_anchors_but_a_scattered_coincidence_does_not() {
    let spec = native_action_spec(native_actions::SET_ALARM).expect("SetAlarm is callable");
    let empty = serde_json::json!({});

    // The article is the whole problem: "set alarm" is how the anchor is
    // written, "set an alarm" is how people speak.
    for natural in [
        "set an alarm for 7:30",
        "set a new alarm for the morning",
        "wake me up at 7",
    ] {
        assert!(
            enforce_mutation_grounding(spec, &empty, natural).is_ok(),
            "natural phrasing should anchor: {natural}",
        );
    }

    // Order and closeness still matter, so unrelated prose that happens to
    // contain both words is not a request to set an alarm.
    for unrelated in [
        "the alarm went off and I had to set the coffee going",
        "alarm set",
    ] {
        assert!(
            enforce_mutation_grounding(spec, &empty, unrelated).is_err(),
            "scattered or reversed words must not anchor: {unrelated}",
        );
    }
}

#[test]
fn music_queue_grounding_accepts_natural_questions_without_a_bare_queue_anchor() {
    let spec =
        native_action_spec(native_actions::GET_MUSIC_QUEUE).expect("GetMusicQueue is callable");
    let empty = serde_json::json!({});

    for utterance in [
        "what's next in the queue",
        "what's in my queue",
        "what's next",
    ] {
        assert!(
            enforce_mutation_grounding(spec, &empty, utterance).is_ok(),
            "natural queue question should ground: {utterance:?}",
        );
    }

    assert!(
        !spec.required_user_terms.contains(&"queue"),
        "a bare queue anchor would pre-empt commands such as 'queue up Beat It'",
    );
    for unrelated in [
        "what is next on my calendar",
        "queue up Beat It",
        "I stood in a queue today",
    ] {
        assert!(
            enforce_mutation_grounding(spec, &empty, unrelated).is_err(),
            "unbounded queue mention must stay refused: {unrelated:?}",
        );
    }
}

#[test]
fn every_callable_mutation_declares_anchors_that_its_own_phrasing_satisfies() {
    // Guards the contract itself: an anchor list that cannot be satisfied
    // by the phrase it describes would silently make an action unreachable.
    for spec in NATIVE_ACTION_CATALOG {
        for term in spec.required_user_terms {
            if spec.name == native_actions::PLAY_CURRENT_TRACK_RADIO
                && CONTEXT_DEPENDENT_RADIO_DEICTICS.contains(term)
            {
                assert_eq!(
                    classify_fieldless_music_grounding(spec, term),
                    Some(FieldlessMusicGrounding::NonAuthoritativeDirectActionMention),
                    "context-dependent radio deictic {term:?} must stay non-authoritative",
                );
                continue;
            }
            assert!(
                enforce_mutation_grounding(spec, &serde_json::json!({}), term).is_ok(),
                "{} declares anchor {term:?} that its own text fails",
                spec.name,
            );
        }
    }
}

const PARITY_LEDGER: &str = include_str!("../../../../../contracts/tier-a/native-actions.tsv");
const CALLABLE_ROUTES: &[&str] = &["restored_direct", "restored_agent", "provider_bridge"];
const EXCLUDED_ROUTES: &[&str] = &[
    "context_only",
    "internal_only",
    "safety_denied",
    "developer_only",
    "stock_only",
    "replacement_rpc",
];
const READ_TOOL_NAMES: &[&str] = &[
    "knowledge_lookup",
    "web_search",
    "place_search",
    "weather_at_place",
    "current_location",
    "current_weather",
    "reverse_geocode",
    "nearby_search",
    "music_artist_top_tracks",
    "music_catalog_search",
    "current_music",
    "route",
    "food_lookup",
    "memory_search",
];

#[test]
fn catalog_exactly_matches_promptable_parity_ledger_rows() {
    let rows = ledger_rows();
    let expected = rows
        .iter()
        .filter(|row| CALLABLE_ROUTES.contains(&row["penumbra_route"]))
        .map(|row| row["action"])
        .collect::<BTreeSet<_>>();
    let actual = NATIVE_ACTION_CATALOG
        .iter()
        .map(|spec| spec.name)
        .collect::<BTreeSet<_>>();

    assert_eq!(expected.len(), 105, "ledger callable count changed");
    assert_eq!(
        actual.len(),
        NATIVE_ACTION_CATALOG.len(),
        "duplicate action"
    );
    assert_eq!(actual, expected, "catalog drifted from parity ledger");

    for spec in NATIVE_ACTION_CATALOG {
        let row = rows
            .iter()
            .find(|row| row["action"] == spec.name)
            .expect("catalog action must have a ledger row");
        assert_eq!(spec.route, route(row["penumbra_route"]), "{}", spec.name);
        assert_eq!(
            spec.keyguard,
            keyguard(row["enabled_in_keyguard"]),
            "{}",
            spec.name
        );
        assert_eq!(spec.risk, risk(row["safety_boundary"]), "{}", spec.name);
    }
}

#[test]
fn catalog_excludes_denied_internal_and_context_only_actions() {
    let catalog = NATIVE_ACTION_CATALOG
        .iter()
        .map(|spec| spec.name)
        .collect::<BTreeSet<_>>();
    for row in ledger_rows()
        .iter()
        .filter(|row| EXCLUDED_ROUTES.contains(&row["penumbra_route"]))
    {
        assert!(
            !catalog.contains(row["action"]),
            "excluded {} action {} leaked into catalog",
            row["penumbra_route"],
            row["action"]
        );
    }
}

#[test]
fn every_action_has_unambiguous_fields_and_lexical_authorization() {
    for spec in NATIVE_ACTION_CATALOG {
        assert!(!spec.required_user_terms.is_empty(), "{}", spec.name);
        assert!(spec.required_user_terms.iter().all(|term| {
            !term.trim().is_empty() && term.len() <= 128 && !term.chars().any(char::is_control)
        }));

        let names = spec
            .arguments
            .iter()
            .map(|field| field.name)
            .collect::<BTreeSet<_>>();
        assert_eq!(names.len(), spec.arguments.len(), "{}", spec.name);
    }

    for action in [
        native_actions::CANCEL_ALARM,
        native_actions::DELETE_TIMER,
        native_actions::DISPLAY_ALARM,
        native_actions::DISPLAY_CONTACT,
        native_actions::DISPLAY_MESSAGES,
        native_actions::DISPLAY_TIMER,
        native_actions::EDIT_TIMER,
        native_actions::PAUSE_TIMER,
        native_actions::RESUME_TIMER,
        native_actions::SET_QUICK_MESSAGING_CONTACT,
    ] {
        let spec = native_action_spec(action).expect("catalog action");
        assert!(spec
            .arguments
            .iter()
            .any(|field| { field.source == SourcePolicy::StockObservationOnly }));
    }
}

#[test]
fn feature_gates_match_runtime_keys_and_stop_remains_callable() {
    let expected = [
        (
            native_actions::ADD_IF_THEN_ENTRY,
            FeatureGate::VisionActionsEnabled,
        ),
        (
            native_actions::CHANGE_QUICK_ACTION,
            FeatureGate::QuickActionsRemappingEnabled,
        ),
        (
            native_actions::CLEAR_IF_THEN_MAP,
            FeatureGate::VisionActionsEnabled,
        ),
        (
            native_actions::GET_IF_THEN_MAP_SIZE,
            FeatureGate::VisionActionsEnabled,
        ),
        (
            native_actions::START_ACTIVITY_TRACKER,
            FeatureGate::FitnessTrackerEnabled,
        ),
        (native_actions::TICKLE, FeatureGate::Tickle),
    ];
    for (action, gate) in expected {
        assert_eq!(native_action_spec(action).unwrap().feature_gate, Some(gate));
        assert!(!gate.settings_key().is_empty());
    }
    assert_eq!(
        native_action_spec(native_actions::STOP_ACTIVITY_TRACKER)
            .unwrap()
            .feature_gate,
        None
    );
}

#[test]
fn read_tool_catalog_is_unique_and_complete() {
    let declared_names = READ_TOOL_NAMES.iter().copied().collect::<BTreeSet<_>>();
    let spec_names = READ_TOOL_CATALOG
        .iter()
        .map(|spec| spec.name)
        .collect::<BTreeSet<_>>();
    assert_eq!(declared_names.len(), READ_TOOL_NAMES.len());
    assert_eq!(spec_names.len(), READ_TOOL_CATALOG.len());
    assert_eq!(declared_names, spec_names);
    assert_eq!(spec_names.len(), 14);

    for spec in READ_TOOL_CATALOG {
        assert!(!spec.read_only_purpose.is_empty());
        assert!(spec.read_only_purpose.len() <= 192);
        let fields = spec
            .arguments
            .iter()
            .map(|field| field.name)
            .collect::<BTreeSet<_>>();
        assert_eq!(fields.len(), spec.arguments.len(), "{}", spec.name);
    }

    for spec in READ_TOOL_CATALOG {
        assert_eq!(
            spec.external_device_preflight,
            (spec.name == "current_location").then_some(native_actions::GET_CURRENT_LOCATION)
        );
    }

    let expected_shapes = [
        ("knowledge_lookup", vec!["query"], vec!["query"]),
        ("web_search", vec!["query"], vec!["query"]),
        ("place_search", vec!["query", "context"], vec!["query"]),
        (
            "weather_at_place",
            vec!["location", "latitude", "longitude"],
            vec!["location", "latitude", "longitude"],
        ),
        ("current_location", vec![], vec![]),
        ("current_weather", vec!["location"], vec![]),
        (
            "reverse_geocode",
            vec!["latitude", "longitude"],
            vec!["latitude", "longitude"],
        ),
        (
            "nearby_search",
            vec!["query", "latitude", "longitude", "radius_m"],
            vec!["query", "latitude", "longitude"],
        ),
        (
            "music_artist_top_tracks",
            vec!["artist", "limit"],
            vec!["artist"],
        ),
        (
            "music_catalog_search",
            vec!["query", "kind", "limit"],
            vec!["query"],
        ),
        ("current_music", vec![], vec![]),
        (
            "route",
            vec!["origin", "destination", "mode"],
            vec!["origin", "destination"],
        ),
        ("food_lookup", vec!["query"], vec!["query"]),
        ("memory_search", vec!["query", "limit"], vec!["query"]),
    ];
    for (name, fields, required) in expected_shapes {
        let spec = read_tool_spec(name).unwrap();
        assert_eq!(
            spec.arguments
                .iter()
                .map(|field| field.name)
                .collect::<BTreeSet<_>>(),
            fields.into_iter().collect::<BTreeSet<_>>(),
            "{name}"
        );
        assert_eq!(
            spec.arguments
                .iter()
                .filter(|field| field.required)
                .map(|field| field.name)
                .collect::<BTreeSet<_>>(),
            required.into_iter().collect::<BTreeSet<_>>(),
            "{name}"
        );
    }
}

#[test]
fn read_tool_unlock_gate_stays_in_lockstep_with_the_invocation() {
    // The dispatch gate reads the unlock requirement from the tool NAME
    // (`read_tool_name_requires_confirmed_unlock`, before arguments are bound);
    // the broker reads it from the typed INVOCATION
    // (`ReadToolInvocation::requires_confirmed_unlock`). If the two ever
    // disagree, a read is gated one way and executed the other. The mirror's own
    // doc-comment long claimed "a test asserts the two stay in lockstep across
    // the whole catalog" — until now no such test existed. This is it: build a
    // minimal instance of every read tool and assert name-mirror == method.
    let minimal_arguments = [
        ("knowledge_lookup", serde_json::json!({"query": "x"})),
        ("web_search", serde_json::json!({"query": "x"})),
        ("place_search", serde_json::json!({"query": "x"})),
        (
            "weather_at_place",
            serde_json::json!({"location": "x", "latitude": 0.0, "longitude": 0.0}),
        ),
        ("current_location", serde_json::json!({})),
        ("current_weather", serde_json::json!({})),
        (
            "reverse_geocode",
            serde_json::json!({"latitude": 0.0, "longitude": 0.0}),
        ),
        ("nearby_search", serde_json::json!({"query": "x"})),
        (
            "music_artist_top_tracks",
            serde_json::json!({"artist": "x"}),
        ),
        ("music_catalog_search", serde_json::json!({"query": "x"})),
        ("current_music", serde_json::json!({})),
        (
            "route",
            serde_json::json!({"origin": "x", "destination": "y"}),
        ),
        ("food_lookup", serde_json::json!({"query": "x"})),
        ("memory_search", serde_json::json!({"query": "x"})),
    ];

    // Cover every catalog tool. Without this, a newly added read whose gate
    // drifted would simply not be exercised here — the guard would go vacuous
    // rather than red, which is the exact failure this file exists to prevent.
    let covered = minimal_arguments
        .iter()
        .map(|(name, _)| *name)
        .collect::<BTreeSet<_>>();
    let catalog = READ_TOOL_CATALOG
        .iter()
        .map(|spec| spec.name)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        covered, catalog,
        "the lockstep test must exercise every read tool in the catalog"
    );

    for (name, arguments) in minimal_arguments {
        let invocation: ReadToolInvocation =
            serde_json::from_value(serde_json::json!({"tool": name, "arguments": arguments}))
                .unwrap_or_else(|error| panic!("read tool '{name}' failed to build: {error}"));
        assert_eq!(
            invocation.name(),
            name,
            "constructed the wrong variant for {name}"
        );
        assert_eq!(
            read_tool_name_requires_confirmed_unlock(name),
            invocation.requires_confirmed_unlock(),
            "unlock gate for '{name}' disagrees between the name-mirror and the invocation",
        );
    }
}

#[test]
fn corrected_native_shapes_match_stock_public_fields() {
    let connect_wifi = native_action_spec(native_actions::CONNECT_TO_WIFI).unwrap();
    assert_eq!(connect_wifi.arguments.len(), 1);
    assert_eq!(connect_wifi.arguments[0].name, "SSID");
    assert!(!connect_wifi.arguments[0].required);

    let create_contact = native_action_spec(native_actions::CREATE_CONTACT).unwrap();
    assert_eq!(
        create_contact
            .arguments
            .iter()
            .map(|field| field.name)
            .collect::<Vec<_>>(),
        ["firstName", "lastName", "trusted", "phoneNumber"]
    );
    assert!(create_contact.arguments.iter().all(|field| !field.required));
    assert_eq!(create_contact.arguments[2].kind, ArgumentKind::Boolean);

    let language = native_action_spec(native_actions::SET_DEFAULT_TRANSLATE_LANGUAGE).unwrap();
    assert_eq!(language.arguments.len(), 1);
    assert_eq!(language.arguments[0].name, "Language");
    assert!(language.arguments[0].required);

    let vision = native_action_spec(native_actions::UNDERSTAND_SCENE).unwrap();
    assert_eq!(vision.arguments.len(), 1);
    assert_eq!(vision.arguments[0].name, "Question");
    assert!(vision.arguments[0].required);

    let display_contact = native_action_spec(native_actions::DISPLAY_CONTACT).unwrap();
    assert!(!display_contact.arguments[0].required);
    assert_eq!(
        display_contact.arguments[0].source,
        SourcePolicy::StockObservationOnly
    );
}

fn ledger_rows() -> Vec<BTreeMap<&'static str, &'static str>> {
    let mut lines = PARITY_LEDGER.lines();
    let headers = lines.next().unwrap().split('\t').collect::<Vec<_>>();
    lines
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let values = line.split('\t').collect::<Vec<_>>();
            assert_eq!(values.len(), headers.len(), "malformed ledger row: {line}");
            headers
                .iter()
                .copied()
                .zip(values)
                .collect::<BTreeMap<_, _>>()
        })
        .collect()
}

fn route(value: &str) -> NativeActionRoute {
    match value {
        "restored_direct" => NativeActionRoute::RestoredDirect,
        "restored_agent" => NativeActionRoute::RestoredAgent,
        "provider_bridge" => NativeActionRoute::ProviderBridge,
        other => panic!("unexpected callable route {other}"),
    }
}

fn keyguard(value: &str) -> KeyguardBehavior {
    match value {
        "true" => KeyguardBehavior::Allowed,
        "false" => KeyguardBehavior::RequiresUnlocked,
        other => panic!("unexpected keyguard value {other}"),
    }
}

fn risk(value: &str) -> RiskClass {
    match value {
        "call_state" => RiskClass::CallState,
        "camera_state" => RiskClass::CameraState,
        "contact_mutation" => RiskClass::ContactMutation,
        "destructive_mutation" => RiskClass::DestructiveMutation,
        "keyguard_safe" => RiskClass::KeyguardSafe,
        "messaging_state" => RiskClass::MessagingState,
        "power_mutation" => RiskClass::PowerMutation,
        "private_data" => RiskClass::PrivateData,
        "provider_consent" => RiskClass::ProviderConsent,
        "radio_mutation" => RiskClass::RadioMutation,
        "trust_mutation" => RiskClass::TrustMutation,
        "unlocked_required" => RiskClass::UnlockedRequired,
        other => panic!("unexpected risk class {other}"),
    }
}
