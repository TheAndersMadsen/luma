use std::fmt;

use prost::Message as _;
use serde::de::{self, Deserialize, Deserializer, IgnoredAny, MapAccess, Visitor};
use tonic::{Request, Response, Status};
use tracing::info;

use super::super::envelope::unwrap_plaintext_data_for_kid;
use crate::config::spoken_progress_cues_enabled;
use crate::proto::{aibus::*, common::encryption::EncryptedData};
use crate::synapse::catalog::read_tool_spec;
use crate::tier_a::proto_kids;

// The stock request is normally only a handful of tiny JSON action objects.
// Keep both the protobuf and its repeated fields bounded before doing any JSON
// work so this convenience RPC cannot become an allocation/CPU sink.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_ACTION_STRINGS: usize = 32;
const MAX_ACTION_STRING_BYTES: usize = 4 * 1024;
const MAX_ACTION_NAME_BYTES: usize = 128;
const MAX_PROGRESS_CUE_BYTES: usize = 48;

/// Answers the stock action-interstitial envelope with a deterministic,
/// closed-vocabulary progress phrase — or with silence.
///
/// Two independent gates stand in front of any prose:
///
/// 1. `llm.spoken_progress_cues` must be armed. It ships false, so an
///    un-opted-in device gets the byte-identical empty interstitial this
///    handler returned before the phrase table existed.
/// 2. The request must name exactly one registered READ tool. Stock reaches
///    this RPC whenever the last streamed action is missing from its own
///    schema catalog, which already happens in production for real
///    feature-gated terminal actions (`Tickle`, `AddIfThenEntry`, the fitness
///    and quick-action families) whose flags were off when stock's catalog
///    snapshot was taken. Speaking before one of those would be a new,
///    unrequested behavior, so anything outside the read catalog is silent.
///
/// The handler stays stateless: no model call (a warm generation measured
/// ~3.7s against 2.8-14.8s model steps, i.e. the cue would land after the work
/// finished), no prewarming, no referent sharing, and no process-wide repeat
/// tracking. Repeat suppression is derived from the request itself — see
/// [`interstitial_phrase`].
///
/// This handler is the PROSE half only. Nothing here streams an interim action
/// turn, and stock only calls this RPC in response to one, so arming the
/// setting cannot by itself make the device speak; see the delivery note in
/// `understand.rs` at the production turn observer.
#[derive(Default)]
pub struct ActionInterstitialHandler;

impl ActionInterstitialHandler {
    pub const fn new() -> Self {
        Self
    }

    pub async fn encrypted_action_based_interstitial(
        &self,
        request: Request<EncryptedActionBasedInterstitialRequest>,
    ) -> Result<Response<EncryptedActionBasedInterstitialResponse>, Status> {
        let request = request.into_inner();
        let request_bytes = unwrap_plaintext_data_for_kid(
            &request.request,
            proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
            MAX_REQUEST_BYTES,
        )?;
        let request = ActionBasedInterstitialRequest::decode(request_bytes)
            .map_err(|_| Status::invalid_argument("bad ActionBasedInterstitialRequest"))?;
        let names = bounded_action_names(request.action_strings)?;
        let action_count = names.len();
        let armed = spoken_progress_cues_enabled();
        let interstitial = interstitial_phrase(&names, armed);

        // Never log supplied JSON or action names. Parameters can contain
        // private user data; the bounded count and closed outcome are enough.
        // `emitted` is derived, not asserted: it is exactly what went on the
        // wire.
        info!(
            action_count,
            armed,
            emitted = !interstitial.is_empty(),
            "<<< Returning action interstitial"
        );

        let response = ActionBasedInterstitialResponse {
            interstitial: interstitial.to_string(),
        };
        Ok(Response::new(EncryptedActionBasedInterstitialResponse {
            response: Some(EncryptedData::new(
                proto_kids::ACTION_BASED_INTERSTITIAL_RESPONSE,
                response.encode_to_vec(),
            )),
        }))
    }
}

/// The whole cue decision, as a pure function of the request and the arming
/// bit. Total, allocation-free, and identical for identical input, so a stock
/// retry cannot observe drift.
///
/// Silence (`""`) is returned for every case that is not a first cue naming a
/// registered read tool:
///
/// * not armed — the shipped default;
/// * an empty action list;
/// * more than one accumulated action — this is the REPEAT case. Stock's
///   request builder iterates the accumulated turns but reads the LAST turn's
///   action inside the loop body, so a repeat arrives as N identical copies of
///   the current action rather than as history. Either way the count is the
///   accumulated action count, so `1` is the only first cue of a run and every
///   later invitation is declined. A run therefore speaks at most once, on
///   both the buggy stock shape and a hypothetically fixed one;
/// * a name outside the registered read catalog — native/mutating actions,
///   `play_music`, writes, and unknown names;
/// * a phrase that fails the closed-vocabulary gate (unreachable; pinned by
///   test, kept as defence in depth).
fn interstitial_phrase(names: &[String], armed: bool) -> &'static str {
    if !armed || names.len() != 1 {
        return "";
    }
    cue_phrase_for_read_tool(names[0].as_str()).unwrap_or("")
}

/// The deterministic name -> phrase mapping.
///
/// A name must resolve in the shared registered-read-tool catalog before its
/// phrase is considered, so this can never speak for a mutation, a write, or
/// an unknown action even if the table below drifts.
fn cue_phrase_for_read_tool(name: &str) -> Option<&'static str> {
    read_tool_spec(name)?;
    let phrase = CUE_PHRASES
        .iter()
        .find_map(|(tool, phrase)| (*tool == name).then_some(*phrase))?;
    valid_progress_phrase(phrase).then_some(phrase)
}

/// One phrase per registered read tool. Deliberately one, not a rotation: an
/// unheard extra variant buys nothing today and every additional spoken cue is
/// unverifiable audio on a daily driver. The second and later cues of a run are
/// silent instead.
///
/// Each phrase names only a generic category of external work. No phrase may
/// contain a query, a place, a name, a result, or the word "your" — the closed
/// vocabulary below enforces that, and a test pins every entry against it.
const CUE_PHRASES: &[(&str, &str)] = &[
    ("knowledge_lookup", "Looking up facts"),
    ("web_search", "Searching the web"),
    ("place_search", "Finding places"),
    ("weather_at_place", "Checking the forecast"),
    ("current_location", "Checking location"),
    ("current_weather", "Checking the forecast"),
    ("reverse_geocode", "Checking location"),
    ("nearby_search", "Finding nearby places"),
    ("route", "Finding directions"),
    ("music_artist_top_tracks", "Finding songs"),
    ("music_catalog_search", "Finding songs"),
    ("current_music", "Checking the music"),
    ("memory_search", "Checking memories"),
    ("food_lookup", "Checking nutrition"),
];

// ── Closed-vocabulary privacy gate ──────────────────────────────────────────
//
// Restored verbatim from the deleted cue-generation module. A cue is spoken
// aloud in whatever room the user is in, so the vocabulary is a closed list of
// generic work verbs and generic category nouns. "Checking location" is legal;
// "Checking your location" is not, because "your" is in none of the three
// lists. Anything that could contain user or result data (names, numbers,
// addresses, coordinates, accounts, summaries) must stay out.

// The closed set of one-word opening verbs. Every entry is a generic "work in
// progress" verb that reads naturally with a subject and never states a result.
// Kept alphabetically sorted. The first word of any two-word start (below) must
// NOT appear here so start matching is unambiguous.
const SAFE_PROGRESS_STARTS: &[&str] = &[
    "Assembling",
    "Browsing",
    "Calculating",
    "Checking",
    "Collecting",
    "Comparing",
    "Compiling",
    "Confirming",
    "Consulting",
    "Estimating",
    "Exploring",
    "Fetching",
    "Finding",
    "Gathering",
    "Locating",
    "Mapping",
    "Matching",
    "Querying",
    "Retrieving",
    "Reviewing",
    "Scanning",
    "Searching",
    "Surveying",
    "Translating",
    "Verifying",
];

// Two-word opening phrases. Handled as a unit by the validator so their subject
// offset (2 words) is computed generically instead of a hardcoded special case.
const SAFE_PROGRESS_TWO_WORD_STARTS: &[&str] = &[
    "Digging into",
    "Looking into",
    "Looking up",
    "Narrowing down",
    "Piecing together",
    "Pulling together",
    "Pulling up",
    "Rounding up",
    "Sifting through",
    "Sorting through",
    "Tracking down",
];

// The closed set of subject words. Every entry is a GENERIC category of an
// external read — never a specific name, place, value, provider, account, or
// result content. Kept alphabetically sorted.
const SAFE_PROGRESS_SUBJECTS: &[&str] = &[
    "albums",
    "alternatives",
    "answers",
    "arrivals",
    "articles",
    "artists",
    "availability",
    "calories",
    "comparisons",
    "conditions",
    "connections",
    "definitions",
    "delays",
    "departures",
    "details",
    "directions",
    "dishes",
    "distances",
    "estimates",
    "events",
    "facts",
    "fares",
    "features",
    "fixtures",
    "flights",
    "food",
    "forecast",
    "guides",
    "headlines",
    "hotels",
    "information",
    "ingredients",
    "itineraries",
    "language",
    "listings",
    "location",
    "maps",
    "matches",
    "meanings",
    "memories",
    "menus",
    "methods",
    "models",
    "music",
    "nearby",
    "news",
    "notes",
    "nutrition",
    "offers",
    "options",
    "phrases",
    "places",
    "players",
    "prices",
    "pricing",
    "rankings",
    "ratings",
    "recipes",
    "recommendations",
    "reports",
    "reservations",
    "restaurants",
    "results",
    "reviews",
    "rides",
    "routes",
    "schedules",
    "scores",
    "songs",
    "sources",
    "specs",
    "sports",
    "spots",
    "standings",
    "stations",
    "steps",
    "stops",
    "teams",
    "temperatures",
    "text",
    "times",
    "timings",
    "tips",
    "traffic",
    "transit",
    "translation",
    "trends",
    "tutorials",
    "updates",
    "venues",
    "versions",
    "weather",
    "web",
];

fn valid_progress_phrase(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_PROGRESS_CUE_BYTES
        || value.trim() != value
        || value
            .bytes()
            .any(|byte| !(byte.is_ascii_alphabetic() || byte == b' '))
    {
        return false;
    }
    let words = value.split_whitespace().collect::<Vec<_>>();
    if !(2..=5).contains(&words.len()) || words.join(" ") != value {
        return false;
    }

    let Some(subject_start) = safe_start_word_count(&words) else {
        return false;
    };
    let subjects = &words[subject_start..];
    !subjects.is_empty()
        && subjects
            .iter()
            .all(|word| *word == "for" || *word == "the" || SAFE_PROGRESS_SUBJECTS.contains(word))
        && subjects
            .iter()
            .any(|word| SAFE_PROGRESS_SUBJECTS.contains(word))
}

/// The number of leading words consumed by an allowed opening verb phrase, or
/// `None` when the phrase does not begin with one. A two-word start is matched
/// before a one-word start so the offset is unambiguous.
fn safe_start_word_count(words: &[&str]) -> Option<usize> {
    if words.len() >= 2 {
        let two_word = [words[0], words[1]].join(" ");
        if SAFE_PROGRESS_TWO_WORD_STARTS.contains(&two_word.as_str()) {
            return Some(2);
        }
    }
    SAFE_PROGRESS_STARTS.contains(&words[0]).then_some(1)
}

fn bounded_action_names(action_strings: Vec<String>) -> Result<Vec<String>, Status> {
    if action_strings.len() > MAX_ACTION_STRINGS {
        return Err(Status::invalid_argument("too many interstitial actions"));
    }

    action_strings
        .into_iter()
        .map(|action| {
            if action.len() > MAX_ACTION_STRING_BYTES {
                return Err(Status::invalid_argument(
                    "interstitial action JSON is too large",
                ));
            }
            serde_json::from_str::<ActionNameOnly>(&action)
                .map(|parsed| parsed.0)
                .map_err(|_| Status::invalid_argument("invalid interstitial action JSON"))
        })
        .collect()
}

/// A stock action string is `{ "ActionName": { ...private parameters... } }`.
/// This visitor retains only the single top-level key and consumes the value as
/// `IgnoredAny`, preventing action parameters from being copied into a JSON tree.
struct ActionNameOnly(String);

impl<'de> Deserialize<'de> for ActionNameOnly {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(ActionNameVisitor)
    }
}

struct ActionNameVisitor;

impl<'de> Visitor<'de> for ActionNameVisitor {
    type Value = ActionNameOnly;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an object containing exactly one bounded action name")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let name = map
            .next_key::<String>()?
            .ok_or_else(|| de::Error::custom("action object is empty"))?;
        if name.is_empty() || name.len() > MAX_ACTION_NAME_BYTES {
            return Err(de::Error::custom("action name is invalid"));
        }
        map.next_value::<IgnoredAny>()?;
        if map.next_key::<IgnoredAny>()?.is_some() {
            return Err(de::Error::custom("action object has multiple keys"));
        }
        Ok(ActionNameOnly(name))
    }
}

#[cfg(test)]
mod tests {
    use prost::Message;
    use tonic::Code;

    use super::*;
    use crate::tier_a::native_actions;

    fn encrypted_request(
        kid: &str,
        inner: impl Message,
    ) -> EncryptedActionBasedInterstitialRequest {
        EncryptedActionBasedInterstitialRequest {
            request: Some(EncryptedData::new(kid, inner.encode_to_vec())),
        }
    }

    fn action_json(action: &str, parameters: &str) -> String {
        format!(r#"{{"{action}":{parameters}}}"#)
    }

    async fn response_for(actions: &[String]) -> ActionBasedInterstitialResponse {
        let inner = ActionBasedInterstitialRequest {
            action_strings: actions.to_vec(),
        };
        let response = ActionInterstitialHandler::new()
            .encrypted_action_based_interstitial(Request::new(encrypted_request(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                inner,
            )))
            .await
            .unwrap()
            .into_inner()
            .response
            .unwrap();
        assert_eq!(
            response.encryption_information.as_ref().unwrap().kid,
            proto_kids::ACTION_BASED_INTERSTITIAL_RESPONSE
        );
        ActionBasedInterstitialResponse::decode(response.data.as_slice()).unwrap()
    }

    #[test]
    fn handler_has_no_model_or_process_wide_cue_state() {
        assert_eq!(std::mem::size_of::<ActionInterstitialHandler>(), 0);
    }

    #[test]
    fn stock_inner_messages_have_the_exact_wire_layout() {
        let request = ActionBasedInterstitialRequest {
            action_strings: vec!["x".into(), "y".into()],
        };
        assert_eq!(
            request.encode_to_vec(),
            [0x0a, 0x01, b'x', 0x0a, 0x01, b'y']
        );

        let response = ActionBasedInterstitialResponse {
            interstitial: "x".into(),
        };
        assert_eq!(response.encode_to_vec(), [0x0a, 0x01, b'x']);
    }

    #[tokio::test]
    async fn every_valid_action_request_returns_a_decryptable_empty_interstitial() {
        // The default-off proof at the real RPC boundary. Nothing in this test
        // binary arms the setting, so the process is in its shipped state; the
        // read-tool entries below are exactly the requests that WOULD speak if
        // the arming gate were dropped from the handler.
        assert!(
            !crate::config::spoken_progress_cues_enabled(),
            "the shipped process state must be unarmed"
        );
        for actions in [
            Vec::<String>::new(),
            vec![action_json(
                native_actions::PLAY_MUSIC,
                r#"{"Track":"private title"}"#,
            )],
            vec![r#"{"knowledge_lookup":{"query":"private query"}}"#.into()],
            vec![r#"{"web_search":{"query":"private query"}}"#.into()],
            vec![
                r#"{"nearby_search":{}}"#.into(),
                r#"{"nearby_search":{}}"#.into(),
                r#"{"route":{}}"#.into(),
            ],
        ] {
            let response = response_for(&actions).await;
            assert!(response.interstitial.is_empty());
        }
    }

    fn names(actions: &[&str]) -> Vec<String> {
        actions.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn the_shipped_default_is_off_and_silences_every_mapped_phrase() {
        // A fresh install must not arm spoken progress cues. Compile-time so
        // flipping the shipped default cannot even build the test binary.
        const { assert!(!crate::config::DEFAULT_SPOKEN_PROGRESS_CUES) };
        for (tool, phrase) in CUE_PHRASES {
            assert_eq!(
                interstitial_phrase(&names(&[tool]), false),
                "",
                "{tool} must be silent while unarmed"
            );
            // The same input speaks once armed, so the assertion above is
            // testing the gate rather than a dead mapping.
            assert_eq!(interstitial_phrase(&names(&[tool]), true), *phrase);
        }
    }

    #[test]
    fn an_armed_first_cue_speaks_and_every_repeat_is_silent() {
        assert_eq!(
            interstitial_phrase(&names(&["web_search"]), true),
            "Searching the web"
        );
        // Stock's builder emits N identical copies of the current action, so a
        // repeat is the shape below, not a mixed list. Both are declined.
        assert_eq!(
            interstitial_phrase(&names(&["web_search", "web_search"]), true),
            ""
        );
        assert_eq!(
            interstitial_phrase(&names(&["web_search", "web_search", "web_search"]), true),
            ""
        );
        assert_eq!(
            interstitial_phrase(&names(&["nearby_search", "route"]), true),
            ""
        );
        assert_eq!(interstitial_phrase(&[], true), "");
    }

    #[test]
    fn only_registered_read_tools_can_speak() {
        for silent in [
            // Real stock terminal actions reach this RPC today whenever their
            // feature flag was off when stock snapshotted its schema catalog.
            native_actions::RESPOND,
            native_actions::TICKLE,
            native_actions::ADD_IF_THEN_ENTRY,
            native_actions::CHANGE_QUICK_ACTION,
            native_actions::PLAY_MUSIC,
            // Mutations, the write tool, and the advertised play tool.
            "play_music",
            "remember_fact",
            "compose_message",
            // Not a tool at all.
            "penumbra_cue_repeat",
            "",
        ] {
            assert_eq!(
                interstitial_phrase(&names(&[silent]), true),
                "",
                "{silent} must never produce a spoken cue"
            );
        }
    }

    #[test]
    fn the_cue_table_covers_exactly_the_registered_read_catalog() {
        use std::collections::BTreeSet;
        let table = CUE_PHRASES
            .iter()
            .map(|(tool, _)| *tool)
            .collect::<BTreeSet<_>>();
        let catalog = crate::synapse::catalog::READ_TOOL_CATALOG
            .iter()
            .map(|spec| spec.name)
            .collect::<BTreeSet<_>>();
        assert_eq!(table, catalog, "cue table drifted from the read catalog");
        assert_eq!(
            table.len(),
            CUE_PHRASES.len(),
            "duplicate tool in the table"
        );
    }

    #[test]
    fn every_emittable_phrase_survives_the_closed_vocabulary_gate() {
        for (tool, phrase) in CUE_PHRASES {
            assert!(
                valid_progress_phrase(phrase),
                "'{phrase}' ({tool}) is outside the closed vocabulary"
            );
            assert!(
                !phrase.to_ascii_lowercase().split_whitespace().any(|word| {
                    matches!(word, "your" | "you" | "my" | "their" | "his" | "her")
                }),
                "'{phrase}' ({tool}) addresses or describes the user"
            );
            assert!(phrase.len() <= MAX_PROGRESS_CUE_BYTES);
        }
        // The gate is real, not a rubber stamp: the historic privacy defect is
        // still rejected, and so is anything containing user or result content.
        for illegal in [
            "Checking your location",
            "Checking location in Paris",
            "Searching",
            "",
            " Checking location",
            "Checking location!",
            "Reading messages",
        ] {
            assert!(!valid_progress_phrase(illegal), "'{illegal}' passed");
        }
    }

    #[test]
    fn a_table_phrase_outside_the_vocabulary_cannot_reach_the_wire() {
        // Defence in depth: the mapping runs the gate on the way out, so a
        // future table edit that slips past review is silenced, not spoken.
        assert!(!valid_progress_phrase("Checking your location"));
        assert_eq!(
            cue_phrase_for_read_tool("current_location"),
            Some("Checking location")
        );
        assert_eq!(cue_phrase_for_read_tool("not_a_tool"), None);
    }

    #[tokio::test]
    async fn retries_are_idempotent_and_retain_no_prior_action_state() {
        let handler = ActionInterstitialHandler::new();
        let request = || ActionBasedInterstitialRequest {
            action_strings: vec![
                r#"{"knowledge_lookup":{"query":"synthetic private argument"}}"#.into(),
            ],
        };

        let mut encoded_responses = Vec::new();
        for _ in 0..2 {
            let response = handler
                .encrypted_action_based_interstitial(Request::new(encrypted_request(
                    proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                    request(),
                )))
                .await
                .unwrap()
                .into_inner()
                .response
                .unwrap();
            let decoded =
                ActionBasedInterstitialResponse::decode(response.data.as_slice()).unwrap();
            assert!(decoded.interstitial.is_empty());
            encoded_responses.push(response.data);
        }
        assert_eq!(encoded_responses[0], encoded_responses[1]);
    }

    #[test]
    fn action_parameters_are_consumed_without_becoming_handler_state() {
        let names = bounded_action_names(vec![action_json(
            native_actions::PLAY_MUSIC,
            r#"{"Track":"private title","Provider":"private provider","Latitude":55.0}"#,
        )])
        .unwrap();
        assert_eq!(names, [native_actions::PLAY_MUSIC]);
    }

    #[tokio::test]
    async fn handler_rejects_wrong_kid_malformed_proto_and_oversize_envelope() {
        let valid = ActionBasedInterstitialRequest::default();
        let wrong_kid = ActionInterstitialHandler::new()
            .encrypted_action_based_interstitial(Request::new(encrypted_request(
                proto_kids::LOADING_MESSAGE_REQUEST,
                valid,
            )))
            .await
            .unwrap_err();
        assert_eq!(wrong_kid.code(), Code::InvalidArgument);

        let malformed = EncryptedActionBasedInterstitialRequest {
            request: Some(EncryptedData::new(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                vec![0x0a, 0x02, b'{'],
            )),
        };
        let malformed = ActionInterstitialHandler::new()
            .encrypted_action_based_interstitial(Request::new(malformed))
            .await
            .unwrap_err();
        assert_eq!(malformed.code(), Code::InvalidArgument);

        let oversized = EncryptedActionBasedInterstitialRequest {
            request: Some(EncryptedData::new(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                vec![0; MAX_REQUEST_BYTES + 1],
            )),
        };
        let oversized = ActionInterstitialHandler::new()
            .encrypted_action_based_interstitial(Request::new(oversized))
            .await
            .unwrap_err();
        assert_eq!(oversized.code(), Code::InvalidArgument);
    }

    #[tokio::test]
    async fn handler_rejects_unbounded_or_non_stock_action_json() {
        let too_many = ActionBasedInterstitialRequest {
            action_strings: vec![
                action_json(native_actions::PLAY_MUSIC, "{}");
                MAX_ACTION_STRINGS + 1
            ],
        };
        let status = ActionInterstitialHandler::new()
            .encrypted_action_based_interstitial(Request::new(encrypted_request(
                proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                too_many,
            )))
            .await
            .unwrap_err();
        assert_eq!(status.code(), Code::InvalidArgument);

        for invalid in [
            "not-json".to_string(),
            "[]".to_string(),
            "{}".to_string(),
            format!(
                r#"{{"{}":{{}},"{}":{{}}}}"#,
                native_actions::PLAY_MUSIC,
                native_actions::CALL_PERSON
            ),
            format!(r#"{{"{}":{{}}}}"#, "x".repeat(MAX_ACTION_NAME_BYTES + 1)),
            "x".repeat(MAX_ACTION_STRING_BYTES + 1),
        ] {
            let inner = ActionBasedInterstitialRequest {
                action_strings: vec![invalid],
            };
            let status = ActionInterstitialHandler::new()
                .encrypted_action_based_interstitial(Request::new(encrypted_request(
                    proto_kids::ACTION_BASED_INTERSTITIAL_REQUEST,
                    inner,
                )))
                .await
                .unwrap_err();
            assert_eq!(status.code(), Code::InvalidArgument);
        }
    }
}
