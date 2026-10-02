//! The humane.center `notable-events` surface, the Memories dashboard
//! aggregate and the cross-domain search: every web view of what the Pin
//! records through `EventsIngestService` (recovered `K/api-client.js`, service
//! clients `notable-events`, `capture` and `ai-bus`; `K/API-REFERENCE.md` §2–4).
//!
//! - `GET /notable-events/mydata?domain&page&size&sort&startTime&endTime`, one
//!   Spring page of a My Data domain, newest first unless
//!   `sort=eventCreationTime,ASC` (the recovered `getWebapiEvents` default).
//! - `GET /notable-events/mydata/overview?todayStart`, Today and Total per
//!   domain, counted by the store.
//! - `GET /notable-events/foodevents`, the food domain, for the Food page.
//! - `DELETE /notable-events/event/{id}`, the "Forget" control.
//! - `POST|DELETE /notable-events/event/{id}/feedback`, the Ai Mic up/down vote.
//! - `GET /capture/memories`, the dashboard aggregate
//!   `{photos, aiSessions, playTrackEvents, notes, phoneCalls, health}`.
//! - `GET /ai-bus/search?domain&query`, search, `domain` defaulting to
//!   `CAPTURE` as the recovered `search()` did.
//!
//! Every domain filter, projection, count and grouping is decided here, once,
//! so Center renders what it is handed and holds no rule of its own.
//!
//! ## Which events each view lists
//!
//! [`STOCK_EVENT_TYPES`] names every type the stock firmware records
//! (`humane.ui.notableevents.NotableEvent.EVENT_TYPE_*`, plus the dialer's
//! `FilteredCallEvent`) and where the web shows it. The recovered My Data had
//! Ai Mic, Calls, Music and Translation. Everything else is stored, and
//! restored to a reinstalled Pin by `QueryEvents`, but listed nowhere, as far
//! as the recovered web shows (INFERRED).
//!
//! ## Honest by construction
//!
//! Lists and counts answer any identified caller. Event properties go only to
//! a verified web caller ([`RequestPlane::Web`]). A Pin or developer-fallback
//! read receives every row `sealed: true` with empty `eventData`. A row whose
//! key Cosmos does not hold is sealed for that row alone. Only a store or key
//! directory that cannot answer fails a read (503): an empty or sealed answer
//! is a claim about the wearer's data. Forget, votes and search are web-only.

use std::collections::HashSet;

use axum::{
    Json, Router,
    extract::{Path, Query, RawQuery, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use futures_util::StreamExt as _;
use prost_types::value::Kind;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::types::chrono::{DateTime, Utc};

use crate::keydirectory::KeyDirectoryError;
use crate::services::events::{open_for_web, persist_backfill};
use crate::store::{
    EventFilter, EventSearchIndex, EventVote, NotableEventRecord, StoreError, SyncTime,
};
use crate::web_api::{
    ApiState, DeletedDto, MAX_PAGE_SIZE, PAGE_SIDE_READ_CONCURRENCY, PageQuery, RequestPlane,
    ResolvedPrincipal, delete_failed, page_of, unavailable,
};

/// Mount the notable-events, dashboard and search routes over the shared web
/// state.
pub(crate) fn router(state: ApiState) -> Router {
    Router::new()
        .route("/notable-events/mydata", get(my_data))
        .route("/notable-events/mydata/overview", get(overview))
        .route("/notable-events/foodevents", get(food_events))
        .route("/notable-events/event/:id", delete(delete_event))
        .route(
            "/notable-events/event/:id/feedback",
            post(put_feedback).delete(delete_feedback),
        )
        .route("/capture/memories", get(memories))
        .route("/ai-bus/search", get(search))
        .with_state(state)
}

// ── Where each stock event type is shown ────────────────────────────────────

/// A My Data domain. Only `CAPTURE` survived verbatim in the recovered client;
/// these spellings are Luma's (INFERRED).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Domain {
    AiMic,
    Call,
    Music,
    Translation,
    Food,
}

/// The four tiles of the recovered My Data overview, in its order.
const OVERVIEW_DOMAINS: [Domain; 4] = [
    Domain::AiMic,
    Domain::Call,
    Domain::Music,
    Domain::Translation,
];

impl Domain {
    fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_uppercase().as_str() {
            "AI_MIC" => Some(Self::AiMic),
            "CALL" => Some(Self::Call),
            "MUSIC" => Some(Self::Music),
            "TRANSLATION" => Some(Self::Translation),
            "FOOD" => Some(Self::Food),
            _ => None,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::AiMic => "AI_MIC",
            Self::Call => "CALL",
            Self::Music => "MUSIC",
            Self::Translation => "TRANSLATION",
            Self::Food => "FOOD",
        }
    }

    /// The domain's events, newest first.
    ///
    /// Ai Mic is every answer the wearer got, whoever recorded it: Answers,
    /// Central's `Narrate` answers (`CentralActionHandler.resolve`, recorded
    /// under originator `hu.ma.ne.ironman`), and the turns typed in Center's
    /// chat (`crate::http::CENTER_CHAT_ORIGINATOR`), which [`ai_mic_row`]
    /// marks, so the wearer can see, search and Forget everything
    /// `recall_history` can speak back. Calls page and count the event that
    /// ends each call, one per call ([`call_rows`]).
    fn filter(self) -> EventFilter {
        EventFilter {
            types: match self {
                Self::Call => CALL_END_TYPES.map(str::to_owned).to_vec(),
                _ => listed(Listing::MyData(self)),
            },
            ..EventFilter::default()
        }
    }
}

/// Where the web shows one event type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Listing {
    MyData(Domain),
    /// The dashboard's `health` slot.
    Health,
    /// Stored and restored to the Pin, listed nowhere on the web (INFERRED).
    Unlisted,
}

/// Every event type the stock firmware records, and where the web lists it.
///
/// - Music lists `playMusicTrack` alone: stock `MediaManager` records play,
///   pause, completed and skipped for the same track, and the recovered
///   My Data › Music view shows one row per play (eight distinct tracks in one
///   minute), which only the play events produce (INFERRED).
/// - Calls leave out `callFiltered`, which carries no peer: `CallManager`
///   records it when an incoming call passes the trusted-contact check.
/// - The food types feed `/notable-events/foodevents` (`FoodServiceWrapper`,
///   `FoodNotableEventUtilities` sums `humane.foodIntake`).
/// - `humane.health.als` (`ALSManager.uploadALS`, only while the
///   `humane_health_tracker_enabled` setting is on) is the one stock health
///   event, and feeds the dashboard's `health` slot.
/// - Message activity, alarms, Catch Me Up, iPhone notifications, weather,
///   nearby, settings changes, navigation, captures (listed by the capture
///   API), web pages, pushes and test events are unlisted.
const STOCK_EVENT_TYPES: &[(&str, Listing)] = &[
    ("humane.respond", Listing::MyData(Domain::AiMic)),
    ("humane.respond.vision", Listing::MyData(Domain::AiMic)),
    ("humane.initiateCall", Listing::MyData(Domain::Call)),
    ("humane.answerCall", Listing::MyData(Domain::Call)),
    ("humane.missedCall", Listing::MyData(Domain::Call)),
    ("humane.endCall", Listing::MyData(Domain::Call)),
    ("humane.callFiltered", Listing::Unlisted),
    ("humane.playMusicTrack", Listing::MyData(Domain::Music)),
    ("humane.pauseMusicTrack", Listing::Unlisted),
    ("humane.completedMusicTrack", Listing::Unlisted),
    ("humane.skippedMusicTrack", Listing::Unlisted),
    ("humane.playMusicCollection", Listing::Unlisted),
    ("humane.playMusicError", Listing::Unlisted),
    ("humane.playSmartPlaylist", Listing::Unlisted),
    ("humane.translation", Listing::MyData(Domain::Translation)),
    ("humane.food", Listing::MyData(Domain::Food)),
    ("humane.foodIntake", Listing::MyData(Domain::Food)),
    ("humane.foodDetected", Listing::MyData(Domain::Food)),
    ("humane.health.als", Listing::Health),
    ("humane.alarm.create", Listing::Unlisted),
    ("humane.alarm.delete", Listing::Unlisted),
    ("humane.alarm.scheduled", Listing::Unlisted),
    ("humane.capture", Listing::Unlisted),
    ("humane.photography.takePhoto", Listing::Unlisted),
    ("humane.catchMeUp", Listing::Unlisted),
    ("humane.catchMeUpClearByButton", Listing::Unlisted),
    ("humane.catchMeUpClearByResponse", Listing::Unlisted),
    ("humane.catchMeUpInformationalPriority", Listing::Unlisted),
    ("humane.catchMeUpJunkPriority", Listing::Unlisted),
    ("humane.catchMeUpTrustedOrLeasedPriority", Listing::Unlisted),
    ("humane.catchMeUpTimeSensitivePriority", Listing::Unlisted),
    ("humane.catchMeUpUnknownPriority", Listing::Unlisted),
    ("humane.composeMessage.cancel", Listing::Unlisted),
    ("humane.composeMessage.disambiguation", Listing::Unlisted),
    ("humane.composeMessage.missing_contact", Listing::Unlisted),
    ("humane.composeMessage.missing_message", Listing::Unlisted),
    ("humane.composeMessage.start", Listing::Unlisted),
    (
        "humane.composeMessage.stop_quick_message",
        Listing::Unlisted,
    ),
    ("humane.composeMessage.success", Listing::Unlisted),
    ("humane.sendMessage", Listing::Unlisted),
    ("humane.receiveMessage", Listing::Unlisted),
    ("humane.sendGroupMessage", Listing::Unlisted),
    ("humane.receiveGroupMessage", Listing::Unlisted),
    ("humane.sendQuickMessage", Listing::Unlisted),
    ("humane.smsFiltered", Listing::Unlisted),
    ("humane.iPhoneNotificationAddAction", Listing::Unlisted),
    ("humane.iPhoneNotificationRemoveAction", Listing::Unlisted),
    ("humane.iPhoneNotificationUnknownAction", Listing::Unlisted),
    ("humane.iPhoneNotificationUpdateAction", Listing::Unlisted),
    ("humane.weather", Listing::Unlisted),
    ("humane.nearby", Listing::Unlisted),
    ("humane.updateSettings", Listing::Unlisted),
    ("humane.activateExperience", Listing::Unlisted),
    ("humane.navigateExperienceNode", Listing::Unlisted),
    ("humane.openWebPage", Listing::Unlisted),
    ("humane.pushNotification", Listing::Unlisted),
    ("humane.unitTestExperience", Listing::Unlisted),
    ("humane.central.unitTest", Listing::Unlisted),
];

/// The types a view lists.
fn listed(listing: Listing) -> Vec<String> {
    STOCK_EVENT_TYPES
        .iter()
        .filter(|(_, shown)| *shown == listing)
        .map(|(kind, _)| (*kind).to_owned())
        .collect()
}

// ── Reading a page ──────────────────────────────────────────────────────────

/// A read that could not answer: the store, or the key directory behind a
/// plaintext read. Either is a 503, never an empty or sealed page.
struct Outage;

impl From<StoreError> for Outage {
    fn from(_: StoreError) -> Self {
        Self
    }
}

impl From<KeyDirectoryError> for Outage {
    fn from(_: KeyDirectoryError) -> Self {
        Self
    }
}

impl IntoResponse for Outage {
    fn into_response(self) -> Response {
        unavailable()
    }
}

/// One stored event, with its properties when this request may see them.
struct Opened {
    record: NotableEventRecord,
    data: Option<prost_types::Struct>,
}

/// Open a page's events for `plane`, in order, overlapping the key lookups.
/// The second half is the search-index backfill the opens derived.
async fn open_page(
    state: &ApiState,
    plane: RequestPlane,
    records: Vec<NotableEventRecord>,
) -> Result<(Vec<Opened>, Vec<EventSearchIndex>), Outage> {
    if plane != RequestPlane::Web {
        let sealed = records
            .into_iter()
            .map(|record| Opened { record, data: None })
            .collect();
        return Ok((sealed, Vec::new()));
    }
    let results: Vec<_> = futures_util::stream::iter(records)
        .map(|record| {
            let keys = state.keys.clone();
            async move {
                let web = open_for_web(&keys, &record).await?;
                Ok::<_, KeyDirectoryError>((record, web))
            }
        })
        .buffered(PAGE_SIDE_READ_CONCURRENCY)
        .collect()
        .await;
    let mut opened = Vec::with_capacity(results.len());
    let mut backfill = Vec::new();
    for result in results {
        let (record, web) = result?;
        backfill.extend(web.backfill);
        opened.push(Opened {
            record,
            data: web.data,
        });
    }
    Ok((opened, backfill))
}

/// One window of a domain's rows, and how many events the filter matches.
async fn domain_rows(
    state: &ApiState,
    caller: &ResolvedPrincipal,
    domain: Domain,
    filter: &EventFilter,
    offset: i64,
    limit: i64,
) -> Result<(Vec<Value>, i64), Outage> {
    let page = state
        .store
        .query_event_page(&caller.account, filter, offset, limit)
        .await?;
    let (opened, backfill) = open_page(state, caller.plane, page.records).await?;
    persist_backfill(&state.store, &caller.account, &backfill).await;
    Ok((rows(state, caller, domain, opened).await?, page.total))
}

/// A page's rows, in its order.
async fn rows(
    state: &ApiState,
    caller: &ResolvedPrincipal,
    domain: Domain,
    opened: Vec<Opened>,
) -> Result<Vec<Value>, Outage> {
    Ok(match domain {
        Domain::Call => call_rows(state, caller, &opened).await?,
        Domain::AiMic => {
            let ids: Vec<String> = opened
                .iter()
                .map(|event| event.record.event_identifier.clone())
                .collect();
            let votes = state.store.event_feedback(&caller.account, &ids).await?;
            opened
                .iter()
                .map(|event| ai_mic_row(event, votes.get(&event.record.event_identifier)))
                .collect()
        }
        _ => opened
            .iter()
            .map(|event| event_row(domain, event))
            .collect(),
    })
}

// ── Projections ─────────────────────────────────────────────────────────────

/// The envelope every recovered record shares: `{uuid, userCreatedAt, data}`.
/// An event the device sent with no creation time has an empty
/// `userCreatedAt`, never a substituted "now".
fn envelope(record: &NotableEventRecord, data: Map<String, Value>) -> Value {
    json!({
        "uuid": record.event_identifier,
        "userCreatedAt": iso(record.creation_time),
        "data": data,
    })
}

/// A row's `data`: its type, its properties under `eventData` (the recovered
/// mappers read `data.eventData.<property>`), and `sealed` when this request
/// may not see them.
fn event_data(
    record: &NotableEventRecord,
    properties: Option<Map<String, Value>>,
) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert(
        "eventType".to_owned(),
        Value::from(record.event_type.clone()),
    );
    match properties {
        Some(properties) => {
            data.insert("eventData".to_owned(), Value::Object(properties));
        }
        None => {
            data.insert("eventData".to_owned(), json!({}));
            data.insert("sealed".to_owned(), Value::Bool(true));
        }
    }
    data
}

fn event_row(domain: Domain, event: &Opened) -> Value {
    let properties = event.data.as_ref().map(|data| {
        let mut properties = struct_json(data);
        match domain {
            Domain::Music => {
                let provider = music_provider(&properties);
                properties.insert(
                    "provider".to_owned(),
                    provider.map_or(Value::Null, Value::from),
                );
            }
            Domain::Translation => source_language(&mut properties),
            _ => {}
        }
        properties
    });
    envelope(&event.record, event_data(&event.record, properties))
}

/// An Ai Mic row carries the wearer's vote, `null` when they gave none, and
/// `typedInCenter: true` on a turn typed in Center's chat rather than spoken
/// to the Pin (INFERRED: humane.center had no chat, so the flag is Luma's).
fn ai_mic_row(event: &Opened, vote: Option<&EventVote>) -> Value {
    let mut data = event_data(&event.record, event.data.as_ref().map(struct_json));
    data.insert(
        "vote".to_owned(),
        vote.map_or(Value::Null, |vote| Value::from(vote_name(*vote))),
    );
    if event.record.originator_identifier == crate::http::CENTER_CHAT_ORIGINATOR {
        data.insert("typedInCenter".to_owned(), Value::Bool(true));
    }
    envelope(&event.record, data)
}

/// The recovered health record: `data.eventData.eventData` holds the reading
/// and `data.eventType.type` its kind (`K/API-REFERENCE.md` §3).
fn health_row(event: &Opened) -> Value {
    let mut data = Map::new();
    data.insert(
        "eventType".to_owned(),
        json!({ "type": event.record.event_type }),
    );
    match &event.data {
        Some(reading) => {
            data.insert(
                "eventData".to_owned(),
                json!({ "eventData": struct_json(reading) }),
            );
        }
        None => {
            data.insert("eventData".to_owned(), json!({ "eventData": {} }));
            data.insert("sealed".to_owned(), Value::Bool(true));
        }
    }
    envelope(&event.record, data)
}

/// `TranslationNotableEvent` records `originLanguage` and `targetLanguage`, the
/// display names `StopTranslationActionHandler` passes ("English",
/// "Spanish"). The recovered web client reads `eventData.sourceLanguage`, so
/// the web contract names it that, once, for every client.
fn source_language(properties: &mut Map<String, Value>) {
    if let Some(origin) = properties.remove("originLanguage") {
        properties
            .entry("sourceLanguage".to_owned())
            .or_insert(origin);
    }
}

/// Which service a played track came from.
///
/// Stock `Track.emitNotableEvent` hard-codes `sourceService` to `"TIDAL"`, and
/// Luma's providers play through that same stock `Track`, so the source is
/// read from Luma's `trackID` prefix first (`youtube_music:<11>`,
/// `tidal:<id>`, `apple_music:<id>`, or a bare 22-character Spotify id). Only a
/// track without one is a genuine TIDAL track when its `sourceService` says
/// so. Artwork stays Center's to map: it holds the provider credentials the
/// YouTube and Spotify covers need, and the TIDAL cover is a public URL built
/// from `albumArtUuid`, which is returned as recorded.
fn music_provider(properties: &Map<String, Value>) -> Option<&'static str> {
    let text = |key: &str| {
        properties
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let valid = |id: &str| {
        (1..=256).contains(&id.len())
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    };
    let track = text("trackID");
    if let Some(id) = track.strip_prefix("youtube_music:") {
        return (id.len() == 11 && valid(id)).then_some("youtube_music");
    }
    if let Some(id) = track.strip_prefix("tidal:") {
        return valid(id).then_some("tidal");
    }
    if let Some(id) = track.strip_prefix("apple_music:") {
        return valid(id).then_some("apple_music");
    }
    if track.len() == 22 && track.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Some("spotify");
    }
    text("sourceService")
        .eq_ignore_ascii_case("TIDAL")
        .then_some("tidal")
}

/// Longer than any call: stock `EndCallNotableEvent.durationSeconds` is
/// `now − connectTimeMillis / 1000`, and a call that never connected has a
/// connect time of 0, which makes the "duration" the whole Unix epoch.
const MAX_CALL_SECONDS: f64 = 7.0 * 86_400.0;

/// The event that ends a stock call: `CallManager.emitNotableEventForStateChange`
/// records exactly one when a call disconnects, `missedCall` when it was still
/// ringing and `endCall` otherwise.
const CALL_END_TYPES: [&str; 2] = ["humane.endCall", "humane.missedCall"];

/// The event that starts a stock call: `CallManager.onCallInitiated` when the
/// wearer dials, `CallManager.acceptCall` when they answer. A call that rang
/// and was missed has none.
const CALL_START_TYPES: [&str; 2] = ["humane.initiateCall", "humane.answerCall"];

/// How many call events, newest first, are searched for a call's start. Only
/// another call's events can fall between a call's start and its end, and a
/// Pin holds at most a waiting call beside the active one.
const CALL_START_WINDOW: i64 = 8;

/// Calls, one row per call (INFERRED pairing).
///
/// The stock `CallManager` records a start event (`initiateCall` or
/// `answerCall`) and exactly one end event (`endCall` or `missedCall`) for each
/// call, and never sets `TelephonyNotableEvent.conversationID` on either. So
/// the domain pages and counts end events, one per call, and each `endCall`
/// is joined to the start just before it that shares a peer number, unless
/// that peer's previous call ended in between ([`call_start`]). The row lists
/// both events in `eventIds`, so Forget erases the whole call. A start with
/// no end yet is a call in progress, or one the dialer never placed. It is
/// listed nowhere, as a call only has a direction, outcome and length once it
/// ends. `peers` stays the stock `data.eventData.peers`.
async fn call_rows(
    state: &ApiState,
    caller: &ResolvedPrincipal,
    ends: &[Opened],
) -> Result<Vec<Value>, Outage> {
    let lookups: Vec<_> = ends
        .iter()
        .map(|end| call_start(state, caller, end))
        .collect();
    let starts: Vec<Option<Opened>> = futures_util::stream::iter(lookups)
        .buffered(PAGE_SIDE_READ_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<_, _>>()?;
    Ok(ends
        .iter()
        .zip(&starts)
        .map(|(end, start)| {
            let mut members = vec![end];
            members.extend(start.as_ref());
            call_row(&members)
        })
        .collect())
}

/// The start event of the call `end` finished, if the page may open it.
///
/// One bounded read: the call events up to `end`, newest first. The first
/// earlier event that shares one of `end`'s peer numbers decides: a start is
/// this call's, and an end means that peer's previous call, so this one
/// never had a start. A `missedCall` never has one, and a sealed `end` cannot
/// be matched.
async fn call_start(
    state: &ApiState,
    caller: &ResolvedPrincipal,
    end: &Opened,
) -> Result<Option<Opened>, Outage> {
    let (Some(data), Some(at)) = (end.data.as_ref(), end.record.creation_time) else {
        return Ok(None);
    };
    let numbers = peer_numbers(data);
    if end.record.event_type != "humane.endCall" || numbers.is_empty() {
        return Ok(None);
    }
    let filter = EventFilter {
        types: CALL_START_TYPES
            .iter()
            .chain(&CALL_END_TYPES)
            .map(|kind| (*kind).to_owned())
            .collect(),
        end: Some(at),
        ..EventFilter::default()
    };
    let page = state
        .store
        .query_event_page(&caller.account, &filter, 0, CALL_START_WINDOW)
        .await?;
    // The store's own order: time, then identifier, newest first.
    let mark = (end.record.creation_time, &end.record.event_identifier);
    let earlier = page
        .records
        .into_iter()
        .filter(|record| (record.creation_time, &record.event_identifier) < mark)
        .collect();
    let (earlier, _) = open_page(state, caller.plane, earlier).await?;
    for event in earlier {
        let shares_a_peer = event
            .data
            .as_ref()
            .is_some_and(|data| !peer_numbers(data).is_disjoint(&numbers));
        if shares_a_peer {
            let started = CALL_START_TYPES.contains(&event.record.event_type.as_str());
            return Ok(started.then_some(event));
        }
    }
    Ok(None)
}

/// A call event's peer numbers, as [`peer_key`]s.
fn peer_numbers(data: &prost_types::Struct) -> HashSet<String> {
    let Some(Kind::ListValue(peers)) = data.fields.get("peers").and_then(|v| v.kind.as_ref())
    else {
        return HashSet::new();
    };
    peers
        .values
        .iter()
        .filter_map(|peer| match peer.kind.as_ref()? {
            Kind::StructValue(peer) => match peer.fields.get("phoneNumber")?.kind.as_ref()? {
                Kind::StringValue(number) => Some(peer_key(number)),
                _ => None,
            },
            _ => None,
        })
        .filter(|number| !number.is_empty())
        .collect()
}

/// A peer number compared by its digits (INFERRED): a call's start records
/// the dialled URI (`onCallInitiated`) or the ringing call's handle
/// (`acceptCall`), its end the call's own handle (`getNumbersInCall`), and a
/// dialled number may be spaced differently. A number with no digits (a SIP
/// address) compares as written.
fn peer_key(number: &str) -> String {
    let digits: String = number.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        number.trim().to_owned()
    } else {
        digits
    }
}

/// One call: its end event, then its start when it has one. The row is named
/// by the end and dated by the start.
fn call_row(members: &[&Opened]) -> Value {
    let newest = members[0];
    let started = members.last().copied().unwrap_or(newest);
    let has = |kind: &str| {
        members
            .iter()
            .any(|event| event.data.is_some() && event.record.event_type == kind)
    };
    let duration = members.iter().find_map(|event| {
        let data = event.data.as_ref()?;
        (event.record.event_type == "humane.endCall")
            .then(|| number(data, "durationSeconds"))
            .flatten()
    });
    let connected = duration.map(|seconds| (0.0..MAX_CALL_SECONDS).contains(&seconds));

    let mut properties = Map::new();
    properties.insert("peers".to_owned(), Value::Array(call_peers(members)));
    let direction = if has("humane.initiateCall") {
        Some("outgoing")
    } else if has("humane.answerCall") || has("humane.missedCall") {
        Some("incoming")
    } else {
        None
    };
    if let Some(direction) = direction {
        properties.insert("direction".to_owned(), Value::from(direction));
    }
    let outcome = if has("humane.missedCall") {
        Some("missed")
    } else if let Some(connected) = connected {
        Some(if connected { "answered" } else { "unanswered" })
    } else if has("humane.answerCall") {
        Some("answered")
    } else {
        None
    };
    if let Some(outcome) = outcome {
        properties.insert("outcome".to_owned(), Value::from(outcome));
    }
    if let (Some(true), Some(seconds)) = (connected, duration) {
        properties.insert("durationSeconds".to_owned(), number_json(seconds.round()));
    }
    properties.insert(
        "eventIds".to_owned(),
        members
            .iter()
            .map(|event| Value::from(event.record.event_identifier.clone()))
            .collect(),
    );

    let mut data = Map::new();
    data.insert(
        "eventType".to_owned(),
        Value::from(newest.record.event_type.clone()),
    );
    data.insert("eventData".to_owned(), Value::Object(properties));
    if members.iter().all(|event| event.data.is_none()) {
        data.insert("sealed".to_owned(), Value::Bool(true));
    }
    json!({
        "uuid": newest.record.event_identifier,
        "userCreatedAt": iso(started.record.creation_time),
        "data": data,
    })
}

/// Every peer on the call once, by [`peer_key`], keeping the number and name
/// the first member recorded (`CallManager` names the peer from the wearer's
/// contacts).
fn call_peers(members: &[&Opened]) -> Vec<Value> {
    let mut peers: Vec<Map<String, Value>> = Vec::new();
    for event in members.iter().rev() {
        let Some(Value::Array(listed)) = event
            .data
            .as_ref()
            .and_then(|data| data.fields.get("peers"))
            .map(value_json)
        else {
            continue;
        };
        for peer in listed {
            let Value::Object(peer) = peer else { continue };
            let key = |peer: &Map<String, Value>| {
                peer.get("phoneNumber")
                    .and_then(Value::as_str)
                    .map(peer_key)
            };
            let number = key(&peer);
            match peers.iter_mut().find(|known| key(known) == number) {
                Some(known) => {
                    let unnamed = known
                        .get("displayName")
                        .and_then(Value::as_str)
                        .is_none_or(|name| name.trim().is_empty());
                    if unnamed && let Some(name) = peer.get("displayName") {
                        known.insert("displayName".to_owned(), name.clone());
                    }
                }
                None => peers.push(peer),
            }
        }
    }
    peers.into_iter().map(Value::Object).collect()
}

fn number(data: &prost_types::Struct, key: &str) -> Option<f64> {
    match data.fields.get(key)?.kind.as_ref()? {
        Kind::NumberValue(number) if number.is_finite() => Some(*number),
        _ => None,
    }
}

/// A `google.protobuf.Struct` as the JSON object it models.
fn struct_json(data: &prost_types::Struct) -> Map<String, Value> {
    data.fields
        .iter()
        .map(|(key, value)| (key.clone(), value_json(value)))
        .collect()
}

fn value_json(value: &prost_types::Value) -> Value {
    match &value.kind {
        None | Some(Kind::NullValue(_)) => Value::Null,
        Some(Kind::NumberValue(number)) => number_json(*number),
        Some(Kind::StringValue(text)) => Value::from(text.clone()),
        Some(Kind::BoolValue(flag)) => Value::Bool(*flag),
        Some(Kind::StructValue(inner)) => Value::Object(struct_json(inner)),
        Some(Kind::ListValue(list)) => Value::Array(list.values.iter().map(value_json).collect()),
    }
}

/// `google.protobuf.Value` numbers are doubles, and the device writes longs
/// and epoch milliseconds through them (`NotableEvent.fillWithEventProperites`),
/// so a whole number goes back out whole.
fn number_json(number: f64) -> Value {
    const EXACT: f64 = 9_007_199_254_740_992.0;
    if number.fract() == 0.0 && number.abs() < EXACT {
        Value::from(number as i64)
    } else {
        serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

const fn vote_name(vote: EventVote) -> &'static str {
    match vote {
        EventVote::Up => "up",
        EventVote::Down => "down",
    }
}

// ── Time ────────────────────────────────────────────────────────────────────

/// ISO 8601 with milliseconds, UTC: what the recovered records carried.
fn iso(time: Option<SyncTime>) -> String {
    time.and_then(|time| {
        DateTime::<Utc>::from_timestamp(time.seconds(), u32::try_from(time.nanos()).unwrap_or(0))
    })
    .map(|time| time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
    .unwrap_or_default()
}

fn iso_seconds(seconds: i64) -> String {
    iso(Some(SyncTime::from_parts(seconds, 0)))
}

/// An RFC 3339 instant, as the recovered client sent `startTime`/`endTime`.
fn instant(value: &str) -> Option<SyncTime> {
    let parsed = DateTime::parse_from_rfc3339(value.trim()).ok()?;
    Some(SyncTime::from_parts(
        parsed.timestamp(),
        i32::try_from(parsed.timestamp_subsec_nanos()).unwrap_or(0),
    ))
}

fn bad_request(reason: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, reason).into_response()
}

// ── GET /notable-events/mydata, /notable-events/foodevents ─────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MyDataQuery {
    domain: Option<String>,
    page: Option<i64>,
    size: Option<i64>,
    sort: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
}

/// `GET /notable-events/mydata`, one page of a My Data domain.
async fn my_data(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<MyDataQuery>,
) -> Response {
    let caller = match state.account_for(&headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    let Some(domain) = query.domain.as_deref().and_then(Domain::parse) else {
        return bad_request("domain must be AI_MIC, CALL, MUSIC, TRANSLATION or FOOD");
    };
    list_domain(&state, &caller, domain, &query).await
}

/// `GET /notable-events/foodevents`, the food domain. The recovered
/// `getWebapiFoodEvents` sent no parameters. The page parameters of
/// `/mydata` are honoured when given.
async fn food_events(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<MyDataQuery>,
) -> Response {
    let caller = match state.account_for(&headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    list_domain(&state, &caller, Domain::Food, &query).await
}

async fn list_domain(
    state: &ApiState,
    caller: &ResolvedPrincipal,
    domain: Domain,
    query: &MyDataQuery,
) -> Response {
    let mut filter = domain.filter();
    filter.oldest_first = match oldest_first(query.sort.as_deref()) {
        Ok(oldest_first) => oldest_first,
        Err(response) => return response,
    };
    for (bound, value) in [
        (&mut filter.start, &query.start_time),
        (&mut filter.end, &query.end_time),
    ] {
        if let Some(value) = value.as_deref().filter(|value| !value.trim().is_empty()) {
            let Some(parsed) = instant(value) else {
                return bad_request("startTime and endTime must be RFC 3339 instants");
            };
            *bound = Some(parsed);
        }
    }
    if let (Some(start), Some(end)) = (filter.start, filter.end)
        && start.seconds() > end.seconds()
    {
        return bad_request("startTime is after endTime");
    }
    let (page, size, offset) = PageQuery {
        page: query.page,
        size: query.size,
    }
    .window();
    match domain_rows(state, caller, domain, &filter, offset, size).await {
        Ok((rows, total)) => Json(page_of(rows, total, page, size)).into_response(),
        Err(outage) => outage.into_response(),
    }
}

/// The order `sort` asks for: `eventCreationTime` (the recovered spelling)
/// or `userCreatedAt`, `ASC` or `DESC`. Absent is newest first, the order the
/// recovered My Data views show.
fn oldest_first(sort: Option<&str>) -> Result<bool, Response> {
    let Some(sort) = sort.map(str::trim).filter(|sort| !sort.is_empty()) else {
        return Ok(false);
    };
    let (field, direction) = sort.split_once(',').unwrap_or((sort, "ASC"));
    if !matches!(field.trim(), "eventCreationTime" | "userCreatedAt") {
        return Err(bad_request(
            "sort must be eventCreationTime or userCreatedAt, ASC or DESC",
        ));
    }
    match direction.trim().to_ascii_uppercase().as_str() {
        "ASC" => Ok(true),
        "DESC" => Ok(false),
        _ => Err(bad_request(
            "sort must be eventCreationTime or userCreatedAt, ASC or DESC",
        )),
    }
}

// ── GET /notable-events/mydata/overview ─────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewQuery {
    today_start: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverviewDto {
    /// The instant "Today" was counted from.
    today_start: String,
    domains: Vec<DomainCount>,
}

#[derive(Serialize)]
struct DomainCount {
    domain: &'static str,
    today: i64,
    total: i64,
}

/// A day with a daylight-saving change lasts 25 hours, and the browser's clock
/// may run a little ahead of the server's.
const LONGEST_DAY_SECONDS: i64 = 26 * 3_600;
const CLOCK_SKEW_SECONDS: i64 = 3_600;

/// `GET /notable-events/mydata/overview`, the My Data tiles.
///
/// Counted by the store (`COUNT(*)` per domain), so no event is opened to
/// produce a number and no total is capped. "Today" is the wearer's day:
/// `todayStart` is their local midnight as an RFC 3339 instant, which only
/// their browser knows exactly, Cosmos holds no time-zone database, and the
/// recovered call sent no parameter, so an absent `todayStart` counts from
/// midnight UTC and says so in the answer. An event with no creation time is
/// never counted as today's. Calls count the event that ends each call, as the
/// list pages them, so one call counts once.
async fn overview(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<OverviewQuery>,
) -> Response {
    let caller = match state.account_for(&headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    let now = SyncTime::now().seconds();
    let today_start = match query.today_start.as_deref() {
        None => SyncTime::from_parts(now - now.rem_euclid(86_400), 0),
        Some(value) => match instant(value) {
            Some(start)
                if start.seconds() > now - LONGEST_DAY_SECONDS
                    && start.seconds() <= now + CLOCK_SKEW_SECONDS =>
            {
                start
            }
            _ => {
                return bad_request(
                    "todayStart must be the RFC 3339 instant of the wearer's last midnight",
                );
            }
        },
    };
    let counts = futures_util::future::join_all(
        OVERVIEW_DOMAINS
            .iter()
            .map(|domain| domain_count(&state, &caller.account, *domain, today_start)),
    )
    .await;
    match counts.into_iter().collect::<Result<Vec<_>, _>>() {
        Ok(domains) => Json(OverviewDto {
            today_start: iso(Some(today_start)),
            domains,
        })
        .into_response(),
        Err(_) => unavailable(),
    }
}

async fn domain_count(
    state: &ApiState,
    account: &str,
    domain: Domain,
    today_start: SyncTime,
) -> Result<DomainCount, StoreError> {
    let total = domain.filter();
    let today = EventFilter {
        start: Some(today_start),
        ..domain.filter()
    };
    let (total, today) = futures_util::future::try_join(
        state.store.count_events(account, &total),
        state.store.count_events(account, &today),
    )
    .await?;
    Ok(DomainCount {
        domain: domain.name(),
        today,
        total,
    })
}

// ── Forget and vote ─────────────────────────────────────────────────────────

/// `DELETE /notable-events/event/{id}`, Forget one row.
///
/// `{id}` is the device-minted `event_identifier`, the key `IngestBatch`
/// upserts on. The recovered `deleteAllNotes()` also sent the literal id
/// `createNote`; `DELETE /capture/notes` already erases those events itself
/// (`notes_api`), so here it is an ordinary id that matches nothing.
///
/// `200 {"deleted": bool}`: `false` when this wearer had no such row, not a
/// 404, and never an answer about another account. The Pin keeps its own copy
/// until its 14-day TTL: `events.proto` has no delete to tell it.
async fn delete_event(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let caller = match state.web_account_for(&headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    match state.store.delete_event(&caller.account, &id).await {
        Ok(deleted) => Json(DeletedDto { deleted }).into_response(),
        Err(_) => delete_failed(),
    }
}

/// The body of `POST /notable-events/event/{id}/feedback`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VoteWrite {
    vote: VoteName,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum VoteName {
    Up,
    Down,
}

/// `POST /notable-events/event/{id}/feedback {"vote": "up" | "down"}`, the
/// Ai Mic up/down buttons of the recovered My Data rows (`upvote-button`,
/// `downvote-button`). No stock RPC carries a vote, so this is web-only
/// (INFERRED), stored beside the event and erased with it.
async fn put_feedback(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<VoteWrite>, JsonRejection>,
) -> Response {
    let caller = match state.web_account_for(&headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    let Ok(Json(body)) = body else {
        return bad_request("expected a JSON {\"vote\": \"up\" | \"down\"} object");
    };
    let vote = match body.vote {
        VoteName::Up => EventVote::Up,
        VoteName::Down => EventVote::Down,
    };
    match state
        .store
        .put_event_feedback(&caller.account, &id, vote)
        .await
    {
        Ok(true) => Json(json!({ "vote": vote_name(vote) })).into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => unavailable(),
    }
}

/// `DELETE /notable-events/event/{id}/feedback`, withdraw the vote.
async fn delete_feedback(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let caller = match state.web_account_for(&headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    match state
        .store
        .delete_event_feedback(&caller.account, &id)
        .await
    {
        Ok(deleted) => Json(DeletedDto { deleted }).into_response(),
        Err(_) => delete_failed(),
    }
}

// ── GET /capture/memories ───────────────────────────────────────────────────

/// How many records each slot of the aggregate carries. The recovered page
/// renders `photos[0]`, every `aiSessions` entry, `playTrackEvents[0..1]`,
/// `notes[0..2]`, `phoneCalls[0]` and `health[0]`. The rest is margin, so a
/// row the wearer forgets still leaves its card filled until the next poll.
const PHOTO_SLOTS: i64 = 4;
const AI_MIC_SLOTS: i64 = 3;
const MUSIC_SLOTS: i64 = 4;
const NOTE_SLOTS: i64 = 6;
const CALL_SLOTS: i64 = 3;
const HEALTH_SLOTS: i64 = 1;

/// `GET /capture/memories`, the Memories dashboard in one read (recovered
/// `getDashboardContent`, polled every 5 s): `{photos, aiSessions,
/// playTrackEvents, notes, phoneCalls, health}`, every record in the
/// recovered envelope.
///
/// Photos and notes come from the capture and notes projections themselves
/// (`capture_api::memory_dtos`, `notes_api::note_dtos`), so a card and its
/// page can never disagree. A slot Cosmos could not read is `null`, the
/// recovered client reads each slot as `data?.slot ?? null`, never `[]`,
/// which would claim the wearer has none. A read where every slot failed is a
/// 503.
async fn memories(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let caller = match state.account_for(&headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    let (photos, ai_sessions, play_track_events, notes, phone_calls, health) = tokio::join!(
        photo_slot(&state, &caller.account),
        event_slot(&state, &caller, Domain::AiMic, AI_MIC_SLOTS),
        event_slot(&state, &caller, Domain::Music, MUSIC_SLOTS),
        note_slot(&state, &caller),
        event_slot(&state, &caller, Domain::Call, CALL_SLOTS),
        health_slot(&state, &caller),
    );
    let slots = [
        &photos,
        &ai_sessions,
        &play_track_events,
        &notes,
        &phone_calls,
        &health,
    ];
    if slots.iter().all(|slot| slot.is_none()) {
        return unavailable();
    }
    Json(json!({
        "photos": photos,
        "aiSessions": ai_sessions,
        "playTrackEvents": play_track_events,
        "notes": notes,
        "phoneCalls": phone_calls,
        "health": health,
    }))
    .into_response()
}

fn slot_failed(slot: &str) {
    tracing::warn!(slot, "a Memories dashboard slot could not be read");
}

async fn photo_slot(state: &ApiState, account: &str) -> Option<Vec<Value>> {
    let Ok(page) = state
        .store
        .memory_page(
            account,
            crate::capture_api::CAPTURE_KINDS,
            false,
            0,
            PHOTO_SLOTS,
        )
        .await
    else {
        slot_failed("photos");
        return None;
    };
    let dtos = crate::capture_api::memory_dtos(state, account, page.records).await;
    Some(dtos.iter().map(photo_record).collect())
}

/// One capture in the recovered photo record: `{uuid, userCreatedAt, data:
/// {thumbnail: {fileUUID, accessToken}}}`, with the capture index beside
/// `thumbnail`. `fileUUID` names the Pin's thumbnail as the file route serves
/// it (`thumbnail-0`); `accessToken` is empty because the wearer's own
/// credentials authorise the read, not a per-capture token.
fn photo_record(dto: &impl Serialize) -> Value {
    let Ok(Value::Object(mut data)) = serde_json::to_value(dto) else {
        return Value::Null;
    };
    let uuid = data.remove("uuid").unwrap_or(Value::Null);
    let created = data
        .remove("userCreatedAt")
        .and_then(|seconds| seconds.as_i64())
        .or_else(|| data.get("createdAt").and_then(Value::as_i64));
    for index_only in ["id", "deviceLocalId", "createdAt", "deleted"] {
        data.remove(index_only);
    }
    let kind = data.remove("type").unwrap_or(Value::Null);
    let thumbnail = if data.get("thumbnailCount").and_then(Value::as_u64) > Some(0) {
        "thumbnail-0"
    } else {
        ""
    };
    data.insert("memoryType".to_owned(), kind);
    data.insert(
        "thumbnail".to_owned(),
        json!({ "fileUUID": thumbnail, "accessToken": "" }),
    );
    json!({
        "uuid": uuid,
        "userCreatedAt": created.map(iso_seconds).unwrap_or_default(),
        "data": data,
    })
}

async fn note_slot(state: &ApiState, caller: &ResolvedPrincipal) -> Option<Vec<Value>> {
    let Ok(page) = state
        .store
        .note_page(&caller.account, None, 0, NOTE_SLOTS)
        .await
    else {
        slot_failed("notes");
        return None;
    };
    let Ok(dtos) = crate::notes_api::note_dtos(&state.keys, caller.plane, page.records).await
    else {
        slot_failed("notes");
        return None;
    };
    Some(dtos.iter().map(note_record).collect())
}

/// One note in the recovered note record: `{uuid, userLastModified, data:
/// {note: {title | null, text}}}`, plus the notes page's `sealed` and
/// `hasLocation`.
fn note_record(dto: &impl Serialize) -> Value {
    let Ok(Value::Object(row)) = serde_json::to_value(dto) else {
        return Value::Null;
    };
    let seconds = |key: &str| {
        row.get(key)
            .and_then(Value::as_i64)
            .map(iso_seconds)
            .unwrap_or_default()
    };
    let mut note = Map::new();
    note.insert(
        "title".to_owned(),
        row.get("title").cloned().unwrap_or(Value::Null),
    );
    note.insert(
        "text".to_owned(),
        row.get("text").cloned().unwrap_or_else(|| json!("")),
    );
    for flag in ["sealed", "hasLocation", "titleGenerated"] {
        if let Some(value) = row.get(flag) {
            note.insert(flag.to_owned(), value.clone());
        }
    }
    json!({
        "uuid": row.get("uuid").cloned().unwrap_or(Value::Null),
        "userCreatedAt": seconds("createdAt"),
        "userLastModified": seconds("modifiedAt"),
        "data": { "note": note },
    })
}

async fn event_slot(
    state: &ApiState,
    caller: &ResolvedPrincipal,
    domain: Domain,
    limit: i64,
) -> Option<Vec<Value>> {
    match domain_rows(state, caller, domain, &domain.filter(), 0, limit).await {
        Ok((rows, _)) => Some(rows),
        Err(Outage) => {
            slot_failed(domain.name());
            None
        }
    }
}

/// The latest `humane.health.als` reading.
async fn health_slot(state: &ApiState, caller: &ResolvedPrincipal) -> Option<Vec<Value>> {
    let filter = EventFilter {
        types: listed(Listing::Health),
        ..EventFilter::default()
    };
    let read = async {
        let page = state
            .store
            .query_event_page(&caller.account, &filter, 0, HEALTH_SLOTS)
            .await?;
        let (opened, backfill) = open_page(state, caller.plane, page.records).await?;
        persist_backfill(&state.store, &caller.account, &backfill).await;
        Ok::<_, Outage>(opened.iter().map(health_row).collect())
    };
    match read.await {
        Ok(rows) => Some(rows),
        Err(Outage) => {
            slot_failed("health");
            None
        }
    }
}

// ── GET /ai-bus/search ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SearchQuery {
    domain: Option<String>,
    query: Option<String>,
    page: Option<i64>,
    size: Option<i64>,
}

/// Longest search, in characters. The notes search's bound.
const MAX_QUERY_CHARS: usize = 256;

/// `GET /ai-bus/search?domain&query`, the recovered `search({query, domain =
/// "CAPTURE"})`.
///
/// Captures and notes already have their search on the `capture` service, so
/// `CAPTURE` and `NOTE` (INFERRED spelling) answer `307` to it with the same
/// parameters: one search per domain, never two that can drift. `AI_MIC` and
/// `MUSIC` search their events here; "only Ai Mic and Music events are
/// searchable" (`services::events::SEARCHABLE_EVENT_TYPES`), so the other
/// domains are a 400. The matching is derived from content, so it is web-only.
async fn search(
    State(state): State<ApiState>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
    Query(query): Query<SearchQuery>,
) -> Response {
    let domain = query
        .domain
        .as_deref()
        .map(str::trim)
        .filter(|domain| !domain.is_empty())
        .unwrap_or("CAPTURE")
        .to_ascii_uppercase();
    let forwarded = raw
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty() && !pair.starts_with("domain="))
        .collect::<Vec<_>>()
        .join("&");
    match domain.as_str() {
        "CAPTURE" => redirect(&format!("/capture/search?{forwarded}")),
        "NOTE" | "NOTES" => redirect(&format!("/capture/notes?{forwarded}")),
        name => match Domain::parse(name) {
            Some(domain @ (Domain::AiMic | Domain::Music)) => {
                search_events(&state, &headers, domain, &query).await
            }
            Some(_) => bad_request("only captures, notes, Ai Mic and Music are searchable"),
            None => bad_request("domain must be CAPTURE, NOTE, AI_MIC or MUSIC"),
        },
    }
}

fn redirect(location: &str) -> Response {
    (
        StatusCode::TEMPORARY_REDIRECT,
        [(header::LOCATION, location.to_owned())],
    )
        .into_response()
}

/// Every event of `domain` whose index holds the query, newest first, paged.
///
/// Matched on the lowercase index `IngestBatch` derived. A row stored before
/// its key arrived is opened here and its index backfilled, so it becomes
/// searchable the moment Cosmos can read it.
async fn search_events(
    state: &ApiState,
    headers: &HeaderMap,
    domain: Domain,
    query: &SearchQuery,
) -> Response {
    let caller = match state.web_account_for(headers) {
        Ok(caller) => caller,
        Err(status) => return status.into_response(),
    };
    let needle = query
        .query
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if needle.chars().count() > MAX_QUERY_CHARS {
        return bad_request("the search is too long");
    }
    let (page, size, offset) = PageQuery {
        page: query.page,
        size: query.size,
    }
    .window();
    if needle.is_empty() {
        return Json(page_of(Vec::<Value>::new(), 0, page, size)).into_response();
    }
    match matching_rows(state, &caller, domain, &needle, offset, size).await {
        Ok((rows, total)) => Json(page_of(rows, total, page, size)).into_response(),
        Err(outage) => outage.into_response(),
    }
}

async fn matching_rows(
    state: &ApiState,
    caller: &ResolvedPrincipal,
    domain: Domain,
    needle: &str,
    offset: i64,
    size: i64,
) -> Result<(Vec<Value>, i64), Outage> {
    let filter = domain.filter();
    let mut matches = Vec::new();
    let mut backfill = Vec::new();
    let mut read = 0;
    loop {
        let chunk = state
            .store
            .query_event_page(&caller.account, &filter, read, MAX_PAGE_SIZE)
            .await?;
        let count = chunk.records.len() as i64;
        for record in chunk.records {
            let index = match &record.indexed_text {
                Some(index) => Some(index.clone()),
                None => {
                    let web = open_for_web(&state.keys, &record).await?;
                    let index = web
                        .backfill
                        .as_ref()
                        .map(|filled| filled.indexed_text.clone());
                    backfill.extend(web.backfill);
                    index
                }
            };
            if index.is_some_and(|index| index.contains(needle)) {
                matches.push(record);
            }
        }
        read += count;
        if count == 0 || read >= chunk.total {
            break;
        }
    }
    persist_backfill(&state.store, &caller.account, &backfill).await;
    let total = matches.len() as i64;
    let window = matches
        .into_iter()
        .skip(usize::try_from(offset).unwrap_or(usize::MAX))
        .take(usize::try_from(size).unwrap_or(0))
        .collect();
    let (opened, _) = open_page(state, caller.plane, window).await?;
    Ok((rows(state, caller, domain, opened).await?, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{MemoryKind, NewMemory, NewNote, NoteSource};
    use crate::web_api::test_support::*;
    use crate::web_api::{DEMO_PRINCIPAL, HttpTrust};
    use axum::http::Method;
    use prost_types::value::Kind as K;

    const ALICE: &str = "alice";

    fn app(
        store: crate::store::SharedStore,
        keys: crate::keydirectory::SharedKeyDirectory,
    ) -> Router {
        crate::web_api::router(ApiState::for_tests(
            store,
            keys,
            DEMO_PRINCIPAL,
            internet_facing(),
            Some(test_verifier()),
            None,
        ))
    }

    fn wearer() -> Vec<(&'static str, String)> {
        vec![bearer_header(ALICE)]
    }

    /// The Pin behind the edge: identified, on the device plane.
    fn pin() -> Vec<(&'static str, String)> {
        let [xfcc, ..] = edge_subjects(ALICE);
        vec![
            (crate::config::EDGE_PRINCIPAL_HEADER, xfcc),
            (crate::config::EDGE_TOKEN_HEADER, EDGE_TOKEN.to_owned()),
        ]
    }

    async fn read(
        app: &Router,
        uri: &str,
        headers: &[(&'static str, String)],
    ) -> (StatusCode, Value) {
        send(app, Method::GET, uri, headers, None).await
    }

    fn string(value: &str) -> prost_types::Value {
        prost_types::Value {
            kind: Some(K::StringValue(value.to_owned())),
        }
    }

    fn num(value: f64) -> prost_types::Value {
        prost_types::Value {
            kind: Some(K::NumberValue(value)),
        }
    }

    fn fields(pairs: Vec<(&str, prost_types::Value)>) -> prost_types::Struct {
        prost_types::Struct {
            fields: pairs
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        }
    }

    /// `TelephonyNotableEvent.peerInfoToStruct`.
    fn peers(list: &[(&str, &str)]) -> prost_types::Value {
        prost_types::Value {
            kind: Some(K::ListValue(prost_types::ListValue {
                values: list
                    .iter()
                    .map(|(number, name)| prost_types::Value {
                        kind: Some(K::StructValue(fields(vec![
                            ("phoneNumber", string(number)),
                            ("displayName", string(name)),
                        ]))),
                    })
                    .collect(),
            })),
        }
    }

    /// An event as the store holds it; `at` is its creation second.
    fn event(
        id: &str,
        kind: &str,
        originator: &str,
        at: i64,
        data: Option<prost_types::Struct>,
    ) -> NotableEventRecord {
        NotableEventRecord {
            event_identifier: id.to_owned(),
            originator_identifier: originator.to_owned(),
            creation_time: Some(SyncTime::from_parts(at, 0)),
            event_type: kind.to_owned(),
            indexed_text: None,
            event_data: data,
            encrypted_event_data: None,
            encrypted_location: None,
            device_is_locked: false,
            ingested: SyncTime::now(),
        }
    }

    fn answer(request: &str, response: &str) -> prost_types::Struct {
        fields(vec![
            ("request", string(request)),
            ("response", string(response)),
        ])
    }

    async fn ingest(store: &crate::store::SharedStore, events: Vec<NotableEventRecord>) {
        store
            .ingest_events(&format!("U:{ALICE}"), &events)
            .await
            .expect("ingest");
    }

    fn uuids(page: &Value) -> Vec<&str> {
        page["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["uuid"].as_str().unwrap())
            .collect()
    }

    /// The stock type list, `NotableEvent.EVENT_TYPE_*` in every app's copy of
    /// `humane.ui.notableevents`, plus the dialer's `FilteredCallEvent`.
    const STOCK_CONSTANTS: &[&str] = &[
        "humane.alarm.create",
        "humane.alarm.delete",
        "humane.alarm.scheduled",
        "humane.health.als",
        "humane.answerCall",
        "humane.callFiltered",
        "humane.capture",
        "humane.catchMeUp",
        "humane.catchMeUpClearByButton",
        "humane.catchMeUpClearByResponse",
        "humane.catchMeUpInformationalPriority",
        "humane.catchMeUpJunkPriority",
        "humane.catchMeUpTrustedOrLeasedPriority",
        "humane.catchMeUpTimeSensitivePriority",
        "humane.catchMeUpUnknownPriority",
        "humane.composeMessage.cancel",
        "humane.composeMessage.disambiguation",
        "humane.composeMessage.missing_contact",
        "humane.composeMessage.missing_message",
        "humane.composeMessage.start",
        "humane.composeMessage.stop_quick_message",
        "humane.composeMessage.success",
        "humane.endCall",
        "humane.activateExperience",
        "humane.navigateExperienceNode",
        "humane.food",
        "humane.foodDetected",
        "humane.foodIntake",
        "humane.initiateCall",
        "humane.missedCall",
        "humane.completedMusicTrack",
        "humane.pauseMusicTrack",
        "humane.playMusicCollection",
        "humane.playMusicError",
        "humane.playSmartPlaylist",
        "humane.playMusicTrack",
        "humane.skippedMusicTrack",
        "humane.nearby",
        "humane.openWebPage",
        "humane.iPhoneNotificationAddAction",
        "humane.iPhoneNotificationRemoveAction",
        "humane.iPhoneNotificationUnknownAction",
        "humane.iPhoneNotificationUpdateAction",
        "humane.receiveGroupMessage",
        "humane.receiveMessage",
        "humane.respond",
        "humane.sendGroupMessage",
        "humane.sendMessage",
        "humane.sendQuickMessage",
        "humane.smsFiltered",
        "humane.photography.takePhoto",
        "humane.unitTestExperience",
        "humane.translation",
        "humane.updateSettings",
        "humane.respond.vision",
        "humane.weather",
        "humane.central.unitTest",
        "humane.pushNotification",
    ];

    /// Every stock type is placed on the web exactly once, on purpose: message
    /// activity, alarms, Catch Me Up, iPhone notifications, weather, nearby
    /// and settings changes included.
    #[test]
    fn every_stock_event_type_has_exactly_one_listing() {
        for kind in STOCK_CONSTANTS {
            let placed = STOCK_EVENT_TYPES
                .iter()
                .filter(|(listed, _)| listed == kind)
                .count();
            assert_eq!(placed, 1, "{kind} must be placed exactly once");
        }
        assert_eq!(STOCK_EVENT_TYPES.len(), STOCK_CONSTANTS.len());
        for kind in [
            "humane.sendMessage",
            "humane.alarm.create",
            "humane.catchMeUp",
            "humane.iPhoneNotificationAddAction",
            "humane.weather",
            "humane.nearby",
            "humane.updateSettings",
        ] {
            assert!(
                STOCK_EVENT_TYPES.contains(&(kind, Listing::Unlisted)),
                "{kind} is stored but listed nowhere"
            );
        }
        assert_eq!(
            listed(Listing::MyData(Domain::Music)),
            ["humane.playMusicTrack"]
        );
    }

    /// Forget and votes are writes: a Pin gets 403 and nobody gets 401.
    #[tokio::test]
    async fn event_writes_refuse_device_plane_and_anonymous_callers() {
        let store = fresh();
        ingest(&store, vec![event("ev-1", "humane.respond", "a", 10, None)]).await;
        let app = app(store.clone(), fresh_keys());
        let vote = Some(json!({ "vote": "up" }));
        for (method, uri, body) in [
            (Method::DELETE, "/notable-events/event/ev-1", None),
            (
                Method::POST,
                "/notable-events/event/ev-1/feedback",
                vote.clone(),
            ),
            (Method::DELETE, "/notable-events/event/ev-1/feedback", None),
        ] {
            let (status, _) = send(&app, method.clone(), uri, &pin(), body.clone()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri} from a Pin");
            let (status, _) = send(&app, method.clone(), uri, &[], body).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {uri} from nobody"
            );
        }
        assert_eq!(
            store
                .query_events("U:alice", "", "", None, None, 0)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    /// Ai Mic is every answer the wearer got, Answers, vision answers,
    /// Central's Narrate answers under `hu.ma.ne.ironman`, and Center's own
    /// chat turns, marked `typedInCenter`.
    #[tokio::test]
    async fn mydata_ai_mic_includes_ironman_narrate_rows() {
        let store = fresh();
        ingest(
            &store,
            vec![
                event(
                    "answers",
                    "humane.respond",
                    "humane.experience.answers",
                    10,
                    Some(answer("a", "A")),
                ),
                event(
                    "vision",
                    "humane.respond.vision",
                    "humane.experience.answers",
                    20,
                    Some(answer("v", "V")),
                ),
                event(
                    "narrate",
                    "humane.respond",
                    "hu.ma.ne.ironman",
                    30,
                    Some(answer("n", "N")),
                ),
                event(
                    "web-chat",
                    "humane.respond",
                    crate::http::CENTER_CHAT_ORIGINATOR,
                    40,
                    Some(answer("typed", "on the web")),
                ),
                event(
                    "song",
                    "humane.playMusicTrack",
                    "humane.experience.music",
                    50,
                    None,
                ),
            ],
        )
        .await;
        let app = app(store, fresh_keys());

        let (status, page) = read(&app, "/notable-events/mydata?domain=AI_MIC", &wearer()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(uuids(&page), ["web-chat", "narrate", "vision", "answers"]);
        assert_eq!(page["totalElements"], 4);
        assert_eq!(page["content"][0]["data"]["eventData"]["request"], "typed");
        assert_eq!(page["content"][0]["data"]["typedInCenter"], true);
        assert_eq!(page["content"][1]["data"]["eventData"]["response"], "N");
        assert_eq!(page["content"][1]["data"]["vote"], Value::Null);
        assert!(
            page["content"][1]["data"].get("typedInCenter").is_none(),
            "a Pin answer carries no Center marker"
        );

        // The recovered getWebapiEvents default order, and a window.
        let (_, page) = read(
            &app,
            "/notable-events/mydata?domain=AI_MIC&sort=eventCreationTime,ASC&size=2",
            &wearer(),
        )
        .await;
        assert_eq!(uuids(&page), ["answers", "vision"]);
        assert_eq!(page["last"], false);
        let (_, page) = read(
            &app,
            "/notable-events/mydata?domain=AI_MIC&startTime=1970-01-01T00:00:15Z&endTime=1970-01-01T00:00:25Z",
            &wearer(),
        )
        .await;
        assert_eq!(uuids(&page), ["vision"]);
    }

    /// One row per play, provider read from Luma's `trackID` even though the
    /// stock `Track` records `sourceService: "TIDAL"` for every track.
    #[tokio::test]
    async fn mydata_music_derives_provider_from_luma_track_id_despite_tidal_source_service() {
        let track = |id: &str, title: &str, art: &str| {
            fields(vec![
                ("trackID", string(id)),
                ("trackTitle", string(title)),
                ("artistName", string("Artist")),
                ("albumName", string("Album")),
                ("albumArtUuid", string(art)),
                ("sourceService", string("TIDAL")),
            ])
        };
        let store = fresh();
        ingest(
            &store,
            vec![
                event(
                    "yt",
                    "humane.playMusicTrack",
                    "m",
                    10,
                    Some(track("youtube_music:dQw4w9WgXcQ", "Song", "")),
                ),
                event(
                    "sp",
                    "humane.playMusicTrack",
                    "m",
                    20,
                    Some(track("4uLU6hMCjMI75M1A2tKUQC", "Song", "")),
                ),
                event(
                    "td",
                    "humane.playMusicTrack",
                    "m",
                    30,
                    Some(track(
                        "12345678",
                        "Song",
                        "a1b2c3d4-0000-1111-2222-333344445555",
                    )),
                ),
                event(
                    "bad",
                    "humane.playMusicTrack",
                    "m",
                    40,
                    Some(track("youtube_music:short", "Song", "")),
                ),
                // The same play paused and finished: not rows of their own.
                event(
                    "pause",
                    "humane.pauseMusicTrack",
                    "m",
                    11,
                    Some(track("youtube_music:dQw4w9WgXcQ", "Song", "")),
                ),
                event(
                    "done",
                    "humane.completedMusicTrack",
                    "m",
                    12,
                    Some(track("youtube_music:dQw4w9WgXcQ", "Song", "")),
                ),
            ],
        )
        .await;
        let app = app(store, fresh_keys());

        let (_, page) = read(&app, "/notable-events/mydata?domain=MUSIC", &wearer()).await;
        assert_eq!(uuids(&page), ["bad", "td", "sp", "yt"]);
        let provider = |at: usize| page["content"][at]["data"]["eventData"]["provider"].clone();
        assert_eq!(provider(0), Value::Null, "a malformed Luma id is not TIDAL");
        assert_eq!(provider(1), "tidal");
        assert_eq!(provider(2), "spotify");
        assert_eq!(provider(3), "youtube_music");
        assert_eq!(
            page["content"][1]["data"]["eventData"]["albumArtUuid"],
            "a1b2c3d4-0000-1111-2222-333344445555",
            "Center builds the TIDAL cover from this"
        );
        assert_eq!(
            page["content"][3]["data"]["eventData"]["trackID"],
            "youtube_music:dQw4w9WgXcQ"
        );
    }

    /// `TelephonyNotableEvent.peerInfoToStruct` for one peer, and a call event.
    fn call(
        kind: &str,
        id: &str,
        at: i64,
        number: &str,
        seconds: Option<f64>,
    ) -> NotableEventRecord {
        let mut pairs = vec![("peers", peers(&[(number, "Ada")]))];
        if let Some(seconds) = seconds {
            pairs.push(("durationSeconds", num(seconds)));
        }
        event(id, kind, "d", at, Some(fields(pairs)))
    }

    /// Each stock call is one row: its end event, joined to the start that
    /// shares its peer, with the direction, outcome and length the pair says,
    /// dated by the start, and listing both events for Forget. A call still
    /// in progress, and `callFiltered`, are listed nowhere.
    #[tokio::test]
    async fn each_stock_call_is_one_row_with_direction_outcome_and_both_events() {
        let store = fresh();
        ingest(
            &store,
            vec![
                // Dialled as typed, ended on the call's own handle.
                call("humane.initiateCall", "out", 10, "+1 555 123 4567", None),
                call("humane.endCall", "out-end", 70, "15551234567", Some(59.6)),
                call("humane.answerCall", "in", 100, "15550001111", None),
                call("humane.endCall", "in-end", 160, "15550001111", Some(60.2)),
                call("humane.missedCall", "missed", 200, "15551234567", None),
                call("humane.initiateCall", "dial", 290, "15551234567", None),
                // `connectTimeMillis` 0: the "duration" is the Unix epoch.
                call("humane.endCall", "never", 300, "15551234567", Some(1.76e9)),
                event(
                    "filtered",
                    "humane.callFiltered",
                    "d",
                    400,
                    Some(fields(vec![])),
                ),
                call("humane.initiateCall", "ringing", 500, "15551234567", None),
            ],
        )
        .await;
        let app = app(store, fresh_keys());

        let (_, page) = read(&app, "/notable-events/mydata?domain=CALL", &wearer()).await;
        assert_eq!(uuids(&page), ["never", "missed", "in-end", "out-end"]);
        assert_eq!(page["totalElements"], 4);
        assert_eq!(page["last"], true);
        let row = |at: usize| page["content"][at].clone();
        let data = |at: usize| row(at)["data"]["eventData"].clone();

        assert_eq!(data(0)["direction"], "outgoing");
        assert_eq!(data(0)["outcome"], "unanswered");
        assert!(data(0).get("durationSeconds").is_none());
        assert_eq!(data(0)["eventIds"], json!(["never", "dial"]));

        assert_eq!(data(1)["direction"], "incoming");
        assert_eq!(data(1)["outcome"], "missed");
        assert_eq!(data(1)["eventIds"], json!(["missed"]));

        assert_eq!(data(2)["direction"], "incoming");
        assert_eq!(data(2)["outcome"], "answered");
        assert_eq!(data(2)["durationSeconds"], 60);
        assert_eq!(data(2)["eventIds"], json!(["in-end", "in"]));

        assert_eq!(row(3)["uuid"], "out-end");
        assert_eq!(row(3)["userCreatedAt"], "1970-01-01T00:00:10.000Z");
        assert_eq!(row(3)["data"]["eventType"], "humane.endCall");
        assert_eq!(data(3)["direction"], "outgoing");
        assert_eq!(data(3)["outcome"], "answered");
        assert_eq!(data(3)["durationSeconds"], 60);
        assert_eq!(data(3)["eventIds"], json!(["out-end", "out"]));
        assert_eq!(
            data(3)["peers"],
            json!([{ "phoneNumber": "+1 555 123 4567", "displayName": "Ada" }]),
            "one peer, as dialled"
        );
    }

    /// The vote is stored beside the event, shown on the Ai Mic row, scoped to
    /// the wearer, and withdrawn on request.
    #[tokio::test]
    async fn event_feedback_is_projected_and_principal_scoped() {
        let store = fresh();
        ingest(
            &store,
            vec![event(
                "q",
                "humane.respond",
                "a",
                10,
                Some(answer("q", "a")),
            )],
        )
        .await;
        let app = app(store, fresh_keys());
        let uri = "/notable-events/event/q/feedback";

        let (status, body) = send(
            &app,
            Method::POST,
            uri,
            &wearer(),
            Some(json!({ "vote": "down" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["vote"], "down");
        let (_, page) = read(&app, "/notable-events/mydata?domain=AI_MIC", &wearer()).await;
        assert_eq!(page["content"][0]["data"]["vote"], "down");

        let (status, _) = send(
            &app,
            Method::POST,
            uri,
            &[bearer_header("mallory")],
            Some(json!({ "vote": "up" })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "no vote on someone else's event"
        );
        for bad in [
            json!({ "vote": "meh" }),
            json!({ "vote": "up", "why": "x" }),
            json!("up"),
        ] {
            let (status, _) = send(&app, Method::POST, uri, &wearer(), Some(bad)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
        }

        let (_, body) = send(&app, Method::DELETE, uri, &wearer(), None).await;
        assert_eq!(body["deleted"], true);
        let (_, page) = read(&app, "/notable-events/mydata?domain=AI_MIC", &wearer()).await;
        assert_eq!(page["content"][0]["data"]["vote"], Value::Null);
    }

    /// The recovered aggregate, whole: its six keys, each slot in the recovered
    /// record shape, each no longer than the page renders plus its margin, and
    /// `health` fed by the stock ALS reading.
    #[tokio::test]
    async fn dashboard_aggregate_has_stock_keys_and_slot_counts() {
        let store = fresh();
        let account = format!("U:{ALICE}");
        for n in 0..6 {
            store
                .create_memory(
                    &account,
                    NewMemory {
                        kind: MemoryKind::Photo,
                        device_local_id: format!("photo-{n}"),
                        bursts: 1,
                        files_per_burst: 1,
                        device_created_time: Some(SyncTime::from_parts(1_700_000_000 + n, 0)),
                        gmt_offset: 0,
                        thumbnails: Vec::new(),
                        encrypted_location: None,
                        metadata: Default::default(),
                    },
                )
                .await
                .unwrap();
        }
        for n in 0..8 {
            store
                .create_note(
                    &account,
                    NewNote {
                        source: NoteSource::Web,
                        title: Some(format!("Title {n}")),
                        body: Some(format!("Body {n}")),
                        opened_text: None,
                        time_zone: None,
                        location: None,
                        encrypted_note: None,
                        encrypted_location: None,
                        tags: Vec::new(),
                    },
                )
                .await
                .unwrap();
        }
        let mut events = Vec::new();
        for n in 0..5 {
            events.push(event(
                &format!("ask-{n}"),
                "humane.respond",
                "a",
                100 + n,
                Some(answer("q", "a")),
            ));
            events.push(event(
                &format!("play-{n}"),
                "humane.playMusicTrack",
                "m",
                100 + n,
                Some(fields(vec![("trackTitle", string("T"))])),
            ));
            events.push(event(
                &format!("call-{n}"),
                "humane.missedCall",
                "d",
                100 + n,
                Some(fields(vec![("peers", peers(&[("1555", "Ada")]))])),
            ));
        }
        events.push(event(
            "light",
            "humane.health.als",
            "s",
            100,
            Some(fields(vec![("lux", num(120.0)), ("uv", num(0.0))])),
        ));
        ingest(&store, events).await;
        let app = app(store, fresh_keys());

        let (status, body) = read(&app, "/capture/memories", &wearer()).await;
        assert_eq!(status, StatusCode::OK);
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            [
                "aiSessions",
                "health",
                "notes",
                "phoneCalls",
                "photos",
                "playTrackEvents"
            ]
        );
        let count = |slot: &str| body[slot].as_array().unwrap().len();
        assert_eq!(count("photos"), 4);
        assert_eq!(count("aiSessions"), 3);
        assert_eq!(count("playTrackEvents"), 4);
        assert_eq!(count("notes"), 6);
        assert_eq!(count("phoneCalls"), 3);
        assert_eq!(count("health"), 1);

        let photo = &body["photos"][0];
        assert!(
            photo["userCreatedAt"]
                .as_str()
                .is_some_and(|at| at.starts_with("2023-11-14T22:13:2") && at.ends_with(".000Z")),
            "the device's capture time, ISO: {photo}"
        );
        assert_eq!(photo["data"]["memoryType"], "PHOTO");
        assert_eq!(
            photo["data"]["thumbnail"],
            json!({ "fileUUID": "", "accessToken": "" })
        );
        assert!(photo["data"].get("uploadState").is_some());

        let note = &body["notes"][0];
        let title = note["data"]["note"]["title"].as_str().unwrap();
        let number = title.strip_prefix("Title ").expect("a titled web note");
        assert_eq!(note["data"]["note"]["text"], format!("Body {number}"));
        assert_eq!(note["data"]["note"]["sealed"], false);
        assert!(
            note["userLastModified"]
                .as_str()
                .is_some_and(|at| !at.is_empty())
        );

        assert_eq!(body["aiSessions"][0]["data"]["eventData"]["request"], "q");
        assert_eq!(
            body["playTrackEvents"][0]["data"]["eventData"]["trackTitle"],
            "T"
        );
        assert_eq!(
            body["phoneCalls"][0]["data"]["eventData"]["peers"][0]["displayName"],
            "Ada"
        );
        assert_eq!(
            body["health"][0]["data"]["eventType"]["type"],
            "humane.health.als"
        );
        assert_eq!(
            body["health"][0]["data"]["eventData"]["eventData"]["lux"],
            120
        );

        // A Pin reads the same slots, with nothing it may not see.
        let (status, body) = read(&app, "/capture/memories", &pin()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["notes"][0]["data"]["note"]["sealed"], true);
        assert_eq!(body["notes"][0]["data"]["note"]["text"], "");
        assert_eq!(body["aiSessions"][0]["data"]["sealed"], true);
    }

    /// The developer profile's anonymous fallback reads the demo partition
    /// sealed, like any non-web caller, and a bare Pin principal it believes
    /// still cannot Forget.
    #[tokio::test]
    async fn the_developer_fallback_reads_rows_sealed() {
        let store = fresh();
        store
            .ingest_events(
                DEMO_PRINCIPAL,
                &[event(
                    "demo",
                    "humane.respond",
                    "a",
                    10,
                    Some(answer("q", "a")),
                )],
            )
            .await
            .unwrap();
        let app = crate::web_api::router(ApiState::for_tests(
            store,
            fresh_keys(),
            DEMO_PRINCIPAL,
            HttpTrust::development(),
            None,
            None,
        ));
        let (status, page) =
            crate::web_api::test_support::get(&app, "/notable-events/mydata?domain=AI_MIC").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["content"][0]["data"]["sealed"], true);

        let (status, _) = delete_as(
            &app,
            "/notable-events/event/demo",
            "V:01:D:web-demo:U:operator",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
