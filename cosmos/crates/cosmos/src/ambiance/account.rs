//! Routing accounts are composed from the owner's decision timeline without
//! cognition. Full rationale stays on the owner-authenticated Activity endpoint.
//! Native, browser-surface and Pin questions receive a content-independent
//! sentence without any ledger read: their current profiles attest neither
//! actor identity nor an empty room. An output permission never grants a shared
//! origin private-history access. A future native personal continuation must
//! establish those missing grants before retrieving an account.
//!
//! The composer names device kinds and observed decisions, never request or
//! response content. A bounded empty ledger tail is missing evidence, not proof
//! that the owner made no request.
use super::policy::{Blocker, Channel, PrivacyClass, RoutingTarget, Shape};
use super::state::RuntimeData;
use crate::ambiance::ledger::LedgerEvent;
use crate::surface_registry::Binding;
use std::collections::BTreeMap;
use uuid::Uuid;

/// How far back the account reaches. The same ten minutes the runtime already
/// treats as "a few minutes ago" for recent context, so "why did that go
/// there?" and "play number two" name the same stretch of the owner's day.
pub const WINDOW_MS: i64 = super::state::RECENT_CONTEXT_MS;

/// How many ledger events one account reads. The tail is the decision
/// timeline itself; this bounds the read the same way the owner's own read
/// over `/surface-api/v1/ledger` is bounded, and a turn whose beginning has
/// already scrolled out of it is not accounted for rather than guessed at.
pub const LEDGER_LIMIT: usize = 300;

/// The account card's bound, matched to the note card's so one reply cannot
/// fill a screen.
const MAX_CARD_BYTES: usize = 3800;

/// Which of the owner's two languages an account request is in. Decided from
/// the recogniser's own vocabulary rather than from general text: one word
/// with no English reading is the owner speaking Danish.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    English,
    Danish,
}

/// The one sentence any surface that is not a personal screen may give. It
/// names no device, no class, no blocker and no outcome, so a privacy
/// suppression, a capability miss, an unreachable screen, an ordinary
/// preference and a window with nothing in it are byte-identical from a
/// shared-perceivable channel (§4.3, invariant 7). It claims nothing the
/// ledger has not committed either: it is a statement of where an account may
/// be read, not of what happened (invariant 10).
pub const ELSEWHERE: [&str; 2] = [
    "Open Activity in Center to see the routing account.",
    "Åbn Aktivitet i Center for at se forklaringen på placeringen.",
];

impl Language {
    pub fn elsewhere(self) -> &'static str {
        ELSEWHERE[self as usize]
    }
}

/// Kinds of device, in the owner's words. The account never names which one.
fn kind_word(kind: Option<&str>, language: Language) -> &'static str {
    match (kind, language) {
        (Some("browser"), Language::English) => "a browser",
        (Some("browser"), Language::Danish) => "en browser",
        (Some("macos"), Language::English) => "your Mac",
        (Some("macos"), Language::Danish) => "din Mac",
        (Some("linux"), Language::English) => "your Linux PC",
        (Some("linux"), Language::Danish) => "din Linux-pc",
        (Some("android"), Language::English) => "your phone",
        (Some("android"), Language::Danish) => "din telefon",
        (Some("android_tv"), Language::English) => "your TV",
        (Some("android_tv"), Language::Danish) => "dit tv",
        (Some("pin"), Language::English) => "your Ai Pin",
        (Some("pin"), Language::Danish) => "din Ai Pin",
        (_, Language::English) => "a removed device",
        (_, Language::Danish) => "en fjernet enhed",
    }
}

/// The same kinds counted, so two browser tabs read as one line rather than
/// as the same sentence twice.
fn kind_count(kind: Option<&str>, count: usize, language: Language) -> String {
    if count == 1 {
        return kind_word(kind, language).to_owned();
    }
    let plural = match (kind, language) {
        (Some("browser"), Language::English) => "browsers",
        (Some("browser"), Language::Danish) => "browsere",
        (Some("macos"), Language::English) => "Macs",
        (Some("macos"), Language::Danish) => "Mac'er",
        (Some("linux"), Language::English) => "Linux PCs",
        (Some("linux"), Language::Danish) => "Linux-pc'er",
        (Some("android"), Language::English) => "phones",
        (Some("android"), Language::Danish) => "telefoner",
        (Some("android_tv"), Language::English) => "TVs",
        (Some("android_tv"), Language::Danish) => "tv",
        (Some("pin"), Language::English) => "Ai Pins",
        (Some("pin"), Language::Danish) => "Ai Pins",
        (_, Language::English) => "removed devices",
        (_, Language::Danish) => "fjernede enheder",
    };
    format!("{count} {plural}")
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}

/// The kind an approved surface declares, as the account names it.
pub fn kind(binding: &Binding) -> &'static str {
    match binding {
        Binding::Browser => "browser",
        Binding::Pin { .. } => "pin",
        Binding::Native { platform, .. } => match platform.as_str() {
            "macos" => "macos",
            "linux" => "linux",
            "android" => "android",
            "android_tv" => "android_tv",
            _ => "native",
        },
    }
}

// ---------------------------------------------------------------------------
// Recognising the request
// ---------------------------------------------------------------------------

/// Words that make a request a question about where the last reply went.
const MARKERS: &[&str] = &["why", "hvorfor"];

/// Words that make it a question about *routing*: a placement, a place, or a
/// kind of device. Without one of these a why-question is an ordinary
/// request, and it goes to cognition like any other.
const ROUTING: &[&str] = &[
    // English placement
    "go",
    "goes",
    "going",
    "went",
    "gone",
    "show",
    "shows",
    "showed",
    "shown",
    "showing",
    "display",
    "displays",
    "displayed",
    "say",
    "says",
    "said",
    "saying",
    "speak",
    "speaks",
    "spoke",
    "spoken",
    "put",
    "puts",
    "send",
    "sends",
    "sent",
    "land",
    "lands",
    "landed",
    "appear",
    "appears",
    "appeared",
    "route",
    "routed",
    "pick",
    "picks",
    "picked",
    "choose",
    "chose",
    "chosen",
    "handle",
    "handles",
    "handled",
    "end",
    "ends",
    "ended",
    "read", // English places
    "there",
    "here", // English kinds of device
    "phone",
    "tv",
    "television",
    "mac",
    "macbook",
    "computer",
    "laptop",
    "pc",
    "speaker",
    "speakers",
    "screen",
    "browser",
    "tab",
    "pin",
    "device",
    "devices",
    "card",
    "answer",
    "reply",
    // Danish placement
    "gik",
    "gå",
    "går",
    "gået",
    "kom",
    "kommer",
    "komme",
    "kommet",
    "vist",
    "vise",
    "viser",
    "viste",
    "sagt",
    "sige",
    "siger",
    "sagde",
    "sendt",
    "sende",
    "sender",
    "havnede",
    "havne",
    "endte",
    "ende",
    "valgte",
    "vælge",
    "vælger",
    "valgt",
    "læst",
    "læse",
    "læser",
    "lagt",
    // Danish places
    "der",
    "derhen",
    "dér",
    "her",
    "herhen", // Danish kinds of device
    "telefon",
    "telefonen",
    "tvet",
    "fjernsyn",
    "fjernsynet",
    "macen",
    "computeren",
    "skærm",
    "skærmen",
    "højttaler",
    "højttaleren",
    "enhed",
    "enheden",
    "browseren",
    "faneblad",
    "svar",
    "svaret",
    "kort",
    "kortet",
    "pinnen",
];

/// Words an account request may also contain: articles, pronouns, auxiliaries
/// and the debris an apostrophe leaves behind. They carry no subject of their
/// own, which is what lets the whitelist below stay a whitelist.
const FILLERS: &[&str] = &[
    // English
    "a", "an", "the", "my", "mine", "your", "this", "that", "those", "these", "it", "its", "one",
    "to", "on", "in", "at", "of", "for", "from", "into", "onto", "up", "over", "and", "or", "but",
    "not", "no", "so", "just", "now", "then", "again", "instead", "rather", "only", "even",
    "actually", "please", "really", "exactly", "did", "do", "does", "was", "were", "is", "are",
    "be", "been", "being", "have", "has", "had", "you", "i", "we", "me", "cosmos", "ok", "okay",
    "hey", "well", "how", "come", "all", "last", "s", "t", "nt", "m", "re", "ve", "ll", "don",
    "doesn", "didn", "isn", "aren", "wasn", "weren", "hasn", "haven", "couldn", "wouldn", "u",
    // Danish
    "og", "men", "så", "øh", "jo", "ikke", "ikk", "det", "den", "dette", "denne", "de", "dem",
    "min", "mit", "mine", "din", "dit", "dine", "en", "et", "til", "på", "af", "fra", "med", "om",
    "ved", "ud", "ind", "op", "lige", "igen", "bare", "kun", "altså", "faktisk", "tak", "er",
    "var", "blev", "bliver", "blevet", "har", "havde", "gør", "gjorde", "kan", "kunne", "skal",
    "skulle", "vil", "ville", "du", "jeg", "vi", "mig", "dig", "alt", "sådan", "hvad", "hvordan",
];

/// Words with no English reading. One of them is the owner speaking Danish.
const DANISH: &[&str] = &[
    "hvorfor",
    "hvordan",
    "hvad",
    "gik",
    "gå",
    "går",
    "gået",
    "kom",
    "kommer",
    "komme",
    "kommet",
    "vist",
    "vise",
    "viser",
    "viste",
    "sagt",
    "sige",
    "siger",
    "sagde",
    "sendt",
    "sende",
    "sender",
    "havnede",
    "havne",
    "endte",
    "ende",
    "valgte",
    "vælge",
    "vælger",
    "valgt",
    "læst",
    "læse",
    "læser",
    "lagt",
    "telefon",
    "telefonen",
    "tvet",
    "fjernsyn",
    "fjernsynet",
    "macen",
    "computeren",
    "skærm",
    "skærmen",
    "højttaler",
    "højttaleren",
    "enhed",
    "enheden",
    "browseren",
    "faneblad",
    "svar",
    "svaret",
    "kortet",
    "pinnen",
    "derhen",
    "dér",
    "herhen",
    "og",
    "men",
    "så",
    "jo",
    "ikke",
    "ikk",
    "det",
    "den",
    "dette",
    "denne",
    "dem",
    "min",
    "mit",
    "mine",
    "din",
    "dit",
    "dine",
    "til",
    "på",
    "af",
    "fra",
    "med",
    "om",
    "ved",
    "ud",
    "ind",
    "op",
    "lige",
    "igen",
    "bare",
    "kun",
    "altså",
    "faktisk",
    "tak",
    "er",
    "var",
    "blev",
    "bliver",
    "blevet",
    "har",
    "havde",
    "gør",
    "gjorde",
    "kan",
    "kunne",
    "skal",
    "skulle",
    "vil",
    "ville",
    "du",
    "jeg",
    "vi",
    "mig",
    "dig",
    "alt",
    "sådan",
    "et",
    "en",
];

/// The words of one request, lowercased, with apostrophes cut so `didn't` and
/// `tv'et` split into parts the vocabulary can name.
fn words(request: &str) -> Vec<String> {
    request
        .to_lowercase()
        .replace(['\u{2019}', '\''], " ")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Whether this request asks where the last reply went, and in which language.
///
/// The test is a whitelist, deliberately: a why-question every one of whose
/// words belongs to the routing vocabulary is an account request, and
/// anything else is an ordinary request that goes to cognition. Erring
/// towards cognition is the safe direction — a missed phrasing costs one
/// ordinary answer, while a greedy recogniser would answer "why is the sky
/// blue" with a routing card. It is also what keeps the request itself from
/// carrying content: there is nothing an owner can put in an account request
/// that is not already one of these words.
pub fn asks(request: &str) -> Option<Language> {
    let words = words(request);
    if words.is_empty() || words.len() > 24 || !words.iter().any(|w| MARKERS.contains(&w.as_str()))
    {
        return None;
    }
    if !words.iter().all(|w| {
        MARKERS.contains(&w.as_str())
            || ROUTING.contains(&w.as_str())
            || FILLERS.contains(&w.as_str())
    }) {
        return None;
    }
    // A bare "why?" is the most deictic form of the question there is; beyond
    // that the request has to name a placement, a place or a kind of device,
    // so "why is that?" after an ordinary answer stays an ordinary request.
    let only_marker = words.iter().all(|w| MARKERS.contains(&w.as_str()));
    if !only_marker && !words.iter().any(|w| ROUTING.contains(&w.as_str())) {
        return None;
    }
    Some(if words.iter().any(|w| DANISH.contains(&w.as_str())) {
        Language::Danish
    } else {
        Language::English
    })
}

// ---------------------------------------------------------------------------
// Reading the decision timeline
// ---------------------------------------------------------------------------

/// One candidate as the account remembers it: which surface, on which
/// channel, and why it was passed over if it was. The score components stay
/// in the ledger; the account names the ordering, never a number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub surface_id: Uuid,
    pub channel: Channel,
    pub blocker: Option<Blocker>,
    pub fit: i32,
    pub unattended: bool,
}

/// One accountable turn, folded out of the ledger tail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accounted {
    pub turn_id: Uuid,
    pub generation: u64,
    pub began_at_ms: i64,
    pub origin: Uuid,
    pub privacy: PrivacyClass,
    pub shape: Option<Shape>,
    pub hint: Option<RoutingTarget>,
    pub candidates: Vec<Candidate>,
    /// The surface the reply was bound to, when one was eligible.
    pub lead: Option<Uuid>,
    /// The exact substantive action and channel selected by this decision.
    pub action: Option<(Uuid, Channel)>,
    /// The surface that rendered the reply or reported a completed action.
    pub outcome: Option<(Uuid, Channel)>,
}

/// The most recent turn this account may describe: the newest turn in the
/// window that the runtime actually decided, other than the turn now asking
/// and any earlier account. Skipping accounts is what makes asking twice give
/// the same answer instead of an account of an account.
pub fn accountable(events: &[LedgerEvent], asking: Uuid, now: i64) -> Option<Accounted> {
    let mut turns: Vec<Accounted> = Vec::new();
    let mut accounts: Vec<Uuid> = Vec::new();
    for event in events {
        let LedgerEvent::Runtime(event) = event else {
            continue;
        };
        match &event.data {
            RuntimeData::TurnBegan {
                turn_id,
                generation,
                origin,
                privacy,
                ..
            } => {
                turns.retain(|turn| turn.turn_id != *turn_id);
                turns.push(Accounted {
                    turn_id: *turn_id,
                    generation: *generation,
                    began_at_ms: event.receipt_ms,
                    origin: *origin,
                    privacy: *privacy,
                    shape: None,
                    hint: None,
                    candidates: Vec::new(),
                    lead: None,
                    action: None,
                    outcome: None,
                });
            }
            RuntimeData::AccountRequested { fence } => accounts.push(fence.turn_id),
            RuntimeData::Decision {
                turn_id,
                generation,
                privacy,
                shape,
                hint,
                expression,
                candidates,
                action_id,
                ..
            } => {
                // The runtime's own shared-safe sentence is not the reply, and
                // an account that described it would describe itself.
                let Some(turn) = turns
                    .iter_mut()
                    .find(|turn| turn.turn_id == *turn_id && turn.generation == *generation)
                else {
                    continue;
                };
                if *expression {
                    continue;
                }
                turn.privacy = *privacy;
                turn.shape = *shape;
                turn.hint = *hint;
                turn.candidates = candidates
                    .iter()
                    .map(|candidate| Candidate {
                        surface_id: candidate.surface_id,
                        channel: candidate.channel,
                        blocker: candidate.blocker,
                        fit: candidate.shape_fit,
                        unattended: candidate.attention < 0,
                    })
                    .collect();
                turn.lead = action_id.and(
                    candidates
                        .iter()
                        .find(|candidate| candidate.blocker.is_none())
                        .map(|candidate| candidate.surface_id),
                );
                turn.action = action_id.zip(
                    candidates
                        .iter()
                        .find(|candidate| candidate.blocker.is_none())
                        .map(|candidate| candidate.channel),
                );
                turn.outcome = None;
            }
            RuntimeData::Repair {
                previous_action,
                action_id,
                surface_id,
                candidates,
            } => {
                let Some(turn) = turns
                    .iter_mut()
                    .find(|turn| turn.action.is_some_and(|(id, _)| id == *previous_action))
                else {
                    continue;
                };
                let Some(candidate) = candidates.iter().find(|candidate| {
                    candidate.surface_id == *surface_id && candidate.blocker.is_none()
                }) else {
                    continue;
                };
                turn.lead = Some(*surface_id);
                turn.action = Some((*action_id, candidate.channel));
                turn.candidates = candidates
                    .iter()
                    .map(|candidate| Candidate {
                        surface_id: candidate.surface_id,
                        channel: candidate.channel,
                        blocker: candidate.blocker,
                        fit: candidate.shape_fit,
                        unattended: candidate.attention < 0,
                    })
                    .collect();
                turn.outcome = None;
            }
            RuntimeData::ActionChanged {
                action_id,
                turn_id,
                generation,
                status,
                channel,
                surface_id,
                ..
            } if (*status == super::state::ActionStatus::Acknowledged
                && matches!(channel, Channel::VisualCard | Channel::AudioTts))
                || (*status == super::state::ActionStatus::Completed && channel.is_action()) =>
            {
                if let Some(turn) = turns.iter_mut().find(|turn| {
                    turn.turn_id == *turn_id
                        && turn.generation == *generation
                        && turn.action == Some((*action_id, *channel))
                        && turn.lead == Some(*surface_id)
                }) {
                    turn.outcome = Some((*surface_id, *channel));
                }
            }
            _ => {}
        }
    }
    turns
        .into_iter()
        .filter(|turn| turn.turn_id != asking && !accounts.contains(&turn.turn_id))
        .filter(|turn| turn.shape.is_some())
        .filter(|turn| now.saturating_sub(turn.began_at_ms) <= WINDOW_MS)
        .next_back()
}

// ---------------------------------------------------------------------------
// Composing the account
// ---------------------------------------------------------------------------

fn heading(language: Language) -> &'static str {
    match language {
        Language::English => "Why that went where it did",
        Language::Danish => "Hvorfor det gik derhen",
    }
}

fn nothing(language: Language) -> &'static str {
    match language {
        Language::English => {
            "Nothing to account for\n\nNo routing decision is available in the recent history."
        }
        Language::Danish => {
            "Intet at forklare\n\nDer er ingen tilgængelig beslutning om placering i den seneste historik."
        }
    }
}

fn ago(ms: i64, language: Language) -> String {
    let minutes = ms.max(0) / 60_000;
    match (minutes, language) {
        (0, Language::English) => "just now".to_owned(),
        (0, Language::Danish) => "lige før".to_owned(),
        (1, Language::English) => "a minute ago".to_owned(),
        (1, Language::Danish) => "for et minut siden".to_owned(),
        (n, Language::English) => format!("{n} minutes ago"),
        (n, Language::Danish) => format!("for {n} minutter siden"),
    }
}

/// What the class meant, as a sentence. The owner never reads the class name.
fn class(privacy: PrivacyClass, language: Language) -> &'static str {
    match (privacy, language) {
        (PrivacyClass::Public, Language::English) => "This reply was safe for anyone to see.",
        (PrivacyClass::Public, Language::Danish) => "Det svar var trygt for alle at se.",
        (PrivacyClass::SharedRoom, Language::English) => {
            "This reply was safe to show on a screen other people can see."
        }
        (PrivacyClass::SharedRoom, Language::Danish) => {
            "Det svar var trygt at vise på en skærm, andre kan se."
        }
        (PrivacyClass::NearUser, Language::English) => {
            "This reply was only for a screen right beside you."
        }
        (PrivacyClass::NearUser, Language::Danish) => {
            "Det svar var kun til en skærm lige ved siden af dig."
        }
        (PrivacyClass::Private, Language::English) => "This reply was private to you.",
        (PrivacyClass::Private, Language::Danish) => "Det svar var privat for dig.",
        (PrivacyClass::Sensitive, Language::English) => {
            "This reply was too sensitive for any screen."
        }
        (PrivacyClass::Sensitive, Language::Danish) => "Det svar var for følsomt til nogen skærm.",
    }
}

/// What the reply was, in the owner's words, as the middle of "This was …".
fn answer(shape: Shape, language: Language) -> &'static str {
    match (shape, language) {
        (Shape::Utterance, Language::English) => "a short answer to say out loud",
        (Shape::Utterance, Language::Danish) => "et kort svar at sige højt",
        (Shape::Note, Language::English) => "a short card to take in at a glance",
        (Shape::Note, Language::Danish) => "et kort kort at overskue på et blik",
        (Shape::Passage, Language::English) => "longer text to sit and read",
        (Shape::Passage, Language::Danish) => "længere tekst at sidde og læse",
        (Shape::Roster, Language::English) => "a list to choose from",
        (Shape::Roster, Language::Danish) => "en liste at vælge fra",
        (Shape::Place, Language::English) => "one place and its address",
        (Shape::Place, Language::Danish) => "ét sted og dets adresse",
        (Shape::Play, Language::English) => "something to play",
        (Shape::Play, Language::Danish) => "noget at afspille",
        (Shape::Route, Language::English) => "directions to somewhere",
        (Shape::Route, Language::Danish) => "vejen til et sted",
        (Shape::Open, Language::English) => "something to open",
        (Shape::Open, Language::Danish) => "noget at åbne",
        (Shape::Run, Language::English) => "a task to run",
        (Shape::Run, Language::Danish) => "en opgave at køre",
    }
}

/// What each channel was asked to do, as the end of "X could …".
fn act(channel: Channel, language: Language) -> &'static str {
    match (channel, language) {
        (Channel::VisualCard, Language::English) => "show a card",
        (Channel::VisualCard, Language::Danish) => "vise et kort",
        (Channel::AudioTts, Language::English) => "speak it",
        (Channel::AudioTts, Language::Danish) => "sige det",
        (Channel::ActionOpen, Language::English) => "open it",
        (Channel::ActionOpen, Language::Danish) => "åbne det",
        (Channel::ActionRoute, Language::English) => "show the way there",
        (Channel::ActionRoute, Language::Danish) => "vise vejen derhen",
        (Channel::ActionPlay, Language::English) => "play it",
        (Channel::ActionPlay, Language::Danish) => "afspille det",
        (Channel::ActionRun, Language::English) => "run that task",
        (Channel::ActionRun, Language::Danish) => "køre den opgave",
        (Channel::ConfirmTap, Language::English) => "ask you to confirm",
        (Channel::ConfirmTap, Language::Danish) => "bede dig bekræfte",
    }
}

/// The same, as the end of "X could have …".
fn done(channel: Channel, language: Language) -> &'static str {
    match (channel, language) {
        (Channel::VisualCard, Language::English) => "shown a card",
        (Channel::VisualCard, Language::Danish) => "vist et kort",
        (Channel::AudioTts, Language::English) => "spoken it",
        (Channel::AudioTts, Language::Danish) => "sagt det",
        (Channel::ActionOpen, Language::English) => "opened it",
        (Channel::ActionOpen, Language::Danish) => "åbnet det",
        (Channel::ActionRoute, Language::English) => "shown the way there",
        (Channel::ActionRoute, Language::Danish) => "vist vejen derhen",
        (Channel::ActionPlay, Language::English) => "played it",
        (Channel::ActionPlay, Language::Danish) => "afspillet det",
        (Channel::ActionRun, Language::English) => "run that task",
        (Channel::ActionRun, Language::Danish) => "kørt den opgave",
        (Channel::ConfirmTap, Language::English) => "asked you to confirm",
        (Channel::ConfirmTap, Language::Danish) => "bedt dig bekræfte",
    }
}

/// Why a device was passed over, as the end of a sentence.
fn because(blocker: Blocker, channel: Channel, language: Language) -> &'static str {
    match (blocker, language) {
        (Blocker::Privacy, Language::English) => "private content is not allowed there",
        (Blocker::Privacy, Language::Danish) => "privat indhold må ikke vises der",
        (Blocker::Capability, Language::English) => match channel {
            Channel::AudioTts => "it cannot speak this",
            Channel::VisualCard => "it cannot show this",
            _ => "it is not approved for that",
        },
        (Blocker::Capability, Language::Danish) => match channel {
            Channel::AudioTts => "den kan ikke sige det",
            Channel::VisualCard => "den kan ikke vise det",
            _ => "den er ikke godkendt til det",
        },
        (Blocker::Unavailable, Language::English) => "it was not connected",
        (Blocker::Unavailable, Language::Danish) => "der var ingen forbindelse til den",
        (Blocker::Unattended, Language::English) => "its app was not in front",
        (Blocker::Unattended, Language::Danish) => "dens app var ikke fremme",
    }
}

fn hint_word(target: RoutingTarget, language: Language) -> &'static str {
    match (target, language) {
        (RoutingTarget::Browser, Language::English) => "the browser",
        (RoutingTarget::Browser, Language::Danish) => "browseren",
        (RoutingTarget::Macos, Language::English) => "the Mac",
        (RoutingTarget::Macos, Language::Danish) => "Mac'en",
        (RoutingTarget::Linux, Language::English) => "the Linux PC",
        (RoutingTarget::Linux, Language::Danish) => "Linux-pc'en",
        (RoutingTarget::Android, Language::English) => "the phone",
        (RoutingTarget::Android, Language::Danish) => "telefonen",
        (RoutingTarget::AndroidTv, Language::English) => "the TV",
        (RoutingTarget::AndroidTv, Language::Danish) => "the TV",
    }
}

/// The kinds of the owner's approved surfaces, by surface id.
pub type Kinds = BTreeMap<Uuid, &'static str>;

fn named(kinds: &Kinds, surface: Uuid, language: Language) -> &'static str {
    kind_word(kinds.get(&surface).copied(), language)
}

/// The full account: the whole of one decision in the owner's own words.
///
/// Call only after owner authorization. Native surface requests cannot use
/// this reader. Nothing here comes from the turn's request or reply content.
pub fn compose(turn: Option<&Accounted>, kinds: &Kinds, language: Language, now: i64) -> String {
    let Some(turn) = turn else {
        return nothing(language).to_owned();
    };
    let mut lines: Vec<String> = vec![heading(language).to_owned()];
    let from = named(kinds, turn.origin, language);
    let when = ago(now.saturating_sub(turn.began_at_ms), language);
    lines.push(match language {
        Language::English => format!("You asked from {from}, {when}."),
        Language::Danish => format!("Du spurgte fra {from} {when}."),
    });
    lines.push(class(turn.privacy, language).to_owned());
    if let Some(shape) = turn.shape {
        let what = answer(shape, language);
        lines.push(match (turn.lead, language) {
            (Some(lead), Language::English) => format!(
                "This was {what}. Cosmos selected {} for it.",
                named(kinds, lead, language)
            ),
            (Some(lead), Language::Danish) => format!(
                "Det var {what}. Cosmos valgte {} til det.",
                named(kinds, lead, language)
            ),
            (None, Language::English) => format!("This was {what}, and no device was eligible."),
            (None, Language::Danish) => format!("Det var {what}, og ingen enhed var egnet."),
        });
    }
    if let Some((surface, channel)) = turn.outcome {
        let name = capitalize(named(kinds, surface, language));
        let did = match (channel, language) {
            (Channel::AudioTts, Language::English) => "said it",
            (Channel::AudioTts, Language::Danish) => "sagde det",
            (Channel::VisualCard, Language::English) => "showed it",
            (Channel::VisualCard, Language::Danish) => "viste det",
            (_, Language::English) => "reported completing the action",
            (_, Language::Danish) => "rapporterede, at handlingen var afsluttet",
        };
        lines.push(format!("{name} {did}."));
    }
    if let Some(hint) = turn.hint {
        let target = hint_word(hint, language);
        lines.push(match language {
            Language::English => format!("The request carried a preference for {target}."),
            Language::Danish => format!("Anmodningen havde en præference for {target}."),
        });
    }
    lines.extend(candidate_lines(turn, kinds, language));
    let mut card = String::new();
    for line in lines {
        let piece = if card.is_empty() {
            line
        } else {
            format!("\n\n{line}")
        };
        if card.len() + piece.len() > MAX_CARD_BYTES {
            break;
        }
        card.push_str(&piece);
    }
    card
}

/// One line per kind of device, with identical ones folded into a count: two
/// browser tabs that both could not speak are two devices, not a stutter.
fn candidate_lines(turn: &Accounted, kinds: &Kinds, language: Language) -> Vec<String> {
    struct Group {
        kind: Option<&'static str>,
        channel: Channel,
        blocker: Option<Blocker>,
        unattended: bool,
        lead: bool,
        count: usize,
    }
    let mut groups: Vec<Group> = Vec::new();
    for candidate in &turn.candidates {
        let kind = kinds.get(&candidate.surface_id).copied();
        let lead = turn.lead == Some(candidate.surface_id);
        if let Some(group) = groups.iter_mut().find(|group| {
            group.kind == kind
                && group.channel == candidate.channel
                && group.blocker == candidate.blocker
                && group.unattended == candidate.unattended
                && group.lead == lead
        }) {
            group.count += 1;
        } else {
            groups.push(Group {
                kind,
                channel: candidate.channel,
                blocker: candidate.blocker,
                unattended: candidate.unattended,
                lead,
                count: 1,
            });
        }
    }
    let chosen = turn.lead.map(|lead| named(kinds, lead, language));
    groups
        .iter()
        .filter(|group| !group.lead)
        .map(|group| {
            let name = capitalize(&kind_count(group.kind, group.count, language));
            let doing = act(group.channel, language);
            let many = group.count > 1;
            match (group.blocker, chosen) {
                (Some(blocker), _) => {
                    let reason = because(blocker, group.channel, language);
                    match language {
                        Language::English => format!("{name} could not {doing} — {reason}."),
                        Language::Danish => format!("{name} kunne ikke {doing} — {reason}."),
                    }
                }
                // Eligible, and passed over. An owner reads "not in front" as
                // "not connected" and goes looking for the device, so a device
                // that was only ranked down says which of the two it was.
                (None, _) if group.unattended => match (language, many) {
                    (Language::English, false) => {
                        format!("{name} could have, but its app was not in front.")
                    }
                    (Language::English, true) => {
                        format!("{name} could have, but their apps were not in front.")
                    }
                    (Language::Danish, false) => {
                        format!("{name} kunne have, men dens app var ikke fremme.")
                    }
                    (Language::Danish, true) => {
                        format!("{name} kunne have, men deres apps var ikke fremme.")
                    }
                },
                (None, Some(chosen)) => {
                    let instead = done(group.channel, language);
                    match language {
                        Language::English => {
                            format!("{name} could have {instead}; Cosmos selected {chosen}.")
                        }
                        Language::Danish => {
                            format!("{name} kunne have {instead}; Cosmos valgte {chosen}.")
                        }
                    }
                }
                (None, None) => {
                    let instead = done(group.channel, language);
                    match language {
                        Language::English => format!("{name} could have {instead}."),
                        Language::Danish => format!("{name} kunne have {instead}."),
                    }
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambiance::ledger::RuntimeEvent;
    use crate::ambiance::policy::{self, Candidate as Scored};
    use crate::ambiance::state::{ActionStatus, TurnFence};

    fn event(sequence: u64, receipt_ms: i64, data: RuntimeData) -> LedgerEvent {
        LedgerEvent::Runtime(RuntimeEvent {
            version: 3,
            principal: "U:owner".to_owned(),
            sequence,
            previous_hash: String::new(),
            receipt_ms,
            data,
        })
    }

    fn scored(surface_id: Uuid, blocker: Option<Blocker>, fit: i32) -> Scored {
        Scored {
            surface_id,
            channel: Channel::VisualCard,
            blocker,
            score_version: policy::SCORE_VERSION,
            shape_fit: fit,
            origin_affinity: 0,
            hint: 0,
            attention: 0,
            preference: 0,
        }
    }

    fn outcome_history(channel: Channel) -> Vec<LedgerEvent> {
        let mut candidate = scored(Uuid::from_u128(2), None, 200);
        candidate.channel = channel;
        vec![
            event(
                1,
                1_000,
                RuntimeData::TurnBegan {
                    turn_id: Uuid::from_u128(10),
                    generation: 1,
                    origin: Uuid::from_u128(1),
                    request_digest: "0".repeat(64),
                    privacy: PrivacyClass::SharedRoom,
                },
            ),
            event(
                2,
                1_001,
                RuntimeData::Decision {
                    turn_id: Uuid::from_u128(10),
                    generation: 1,
                    action_id: Some(Uuid::from_u128(20)),
                    privacy: PrivacyClass::SharedRoom,
                    shape: Some(Shape::Note),
                    hint: None,
                    expression: false,
                    candidates: vec![candidate],
                },
            ),
        ]
    }

    fn changed(
        action_id: u128,
        generation: u64,
        surface_id: u128,
        channel: Channel,
        status: ActionStatus,
    ) -> RuntimeData {
        RuntimeData::ActionChanged {
            action_id: Uuid::from_u128(action_id),
            turn_id: Uuid::from_u128(10),
            generation,
            status,
            channel,
            surface_id: Uuid::from_u128(surface_id),
            incarnation: Uuid::from_u128(30),
            content_digest: "0".repeat(64),
            deadline_ms: 10_000,
            attempt: 1,
        }
    }

    #[test]
    fn ambiance_account_outcome_requires_the_exact_substantive_action() {
        for channel in [Channel::VisualCard, Channel::AudioTts] {
            for (id, generation, surface, reported_channel) in [
                (21, 1, 2, channel),
                (20, 2, 2, channel),
                (20, 1, 3, channel),
                (20, 1, 2, Channel::ConfirmTap),
            ] {
                let mut events = outcome_history(channel);
                events.push(event(
                    3,
                    1_002,
                    changed(
                        id,
                        generation,
                        surface,
                        reported_channel,
                        ActionStatus::Acknowledged,
                    ),
                ));
                assert!(
                    accountable(&events, Uuid::nil(), 2_000)
                        .unwrap()
                        .outcome
                        .is_none()
                );
            }

            let mut events = outcome_history(channel);
            let mut expression = events[1].clone();
            let LedgerEvent::Runtime(ref mut runtime) = expression else {
                unreachable!()
            };
            runtime.sequence = 3;
            let RuntimeData::Decision {
                action_id,
                expression,
                candidates,
                ..
            } = &mut runtime.data
            else {
                unreachable!()
            };
            *action_id = Some(Uuid::from_u128(21));
            *expression = true;
            candidates[0].surface_id = Uuid::from_u128(3);
            candidates[0].channel = Channel::VisualCard;
            // The status card is not evidence that the answer was shown or spoken.
            events.push(LedgerEvent::Runtime(runtime.clone()));
            events.push(event(
                4,
                1_003,
                changed(21, 1, 3, Channel::VisualCard, ActionStatus::Acknowledged),
            ));
            assert!(
                accountable(&events, Uuid::nil(), 2_000)
                    .unwrap()
                    .outcome
                    .is_none()
            );

            events.push(event(
                5,
                1_004,
                changed(20, 1, 2, channel, ActionStatus::Acknowledged),
            ));
            let expected = Some((Uuid::from_u128(2), channel));
            assert_eq!(
                accountable(&events, Uuid::nil(), 2_000).unwrap().outcome,
                expected
            );
            // A later cosmetic acknowledgment cannot move the substantive outcome.
            events.push(event(
                6,
                1_005,
                changed(21, 1, 3, Channel::VisualCard, ActionStatus::Acknowledged),
            ));
            assert_eq!(
                accountable(&events, Uuid::nil(), 2_000).unwrap().outcome,
                expected
            );

            let mut next = events[1].clone();
            let LedgerEvent::Runtime(ref mut runtime) = next else {
                unreachable!()
            };
            runtime.sequence = 7;
            let RuntimeData::Decision { action_id, .. } = &mut runtime.data else {
                unreachable!()
            };
            *action_id = Some(Uuid::from_u128(22));
            events.push(next);
            // An earlier answer is not evidence of delivery of a new decision.
            assert!(
                accountable(&events, Uuid::nil(), 2_000)
                    .unwrap()
                    .outcome
                    .is_none()
            );
        }
    }

    #[test]
    fn ambiance_account_follows_the_committed_repair_and_ignores_the_old_action() {
        let mut events = outcome_history(Channel::VisualCard);
        events.push(event(
            3,
            1_002,
            RuntimeData::Repair {
                previous_action: Uuid::from_u128(20),
                action_id: Uuid::from_u128(21),
                surface_id: Uuid::from_u128(3),
                candidates: vec![scored(Uuid::from_u128(3), None, 200)],
            },
        ));
        events.push(event(
            4,
            1_003,
            changed(20, 1, 2, Channel::VisualCard, ActionStatus::Acknowledged),
        ));
        let turn = accountable(&events, Uuid::nil(), 2_000).unwrap();
        assert_eq!(turn.lead, Some(Uuid::from_u128(3)));
        assert!(turn.outcome.is_none());
        events.push(event(
            5,
            1_004,
            changed(21, 1, 3, Channel::VisualCard, ActionStatus::Acknowledged),
        ));
        let turn = accountable(&events, Uuid::nil(), 2_000).unwrap();
        assert_eq!(
            turn.outcome,
            Some((Uuid::from_u128(3), Channel::VisualCard))
        );
    }

    #[test]
    fn ambiance_account_device_acceptance_is_not_completion() {
        for channel in [
            Channel::ActionOpen,
            Channel::ActionRoute,
            Channel::ActionPlay,
            Channel::ActionRun,
        ] {
            for status in [
                ActionStatus::Acknowledged,
                ActionStatus::Running,
                ActionStatus::Failed,
                ActionStatus::Refused,
                ActionStatus::OutcomeUnknown,
            ] {
                let mut events = outcome_history(channel);
                events.push(event(3, 1_002, changed(20, 1, 2, channel, status)));
                assert!(
                    accountable(&events, Uuid::nil(), 2_000)
                        .unwrap()
                        .outcome
                        .is_none(),
                    "{channel:?}: {status:?}"
                );
            }
            let mut events = outcome_history(channel);
            events.push(event(
                3,
                1_002,
                changed(20, 1, 2, channel, ActionStatus::Completed),
            ));
            let turn = accountable(&events, Uuid::nil(), 2_000).unwrap();
            assert_eq!(turn.outcome, Some((Uuid::from_u128(2), channel)));
            let kinds = Kinds::from([(Uuid::from_u128(2), "macos")]);
            assert!(
                compose(Some(&turn), &kinds, Language::English, 2_000)
                    .contains("Your Mac reported completing the action.")
            );
        }
    }

    #[test]
    fn ambiance_account_recognises_both_languages_and_refuses_ordinary_questions() {
        for asked in [
            "Why did that go to the speaker?",
            "why did it go there",
            "Why?",
            "Why did you show that on the TV instead of my phone?",
            "Why not the TV?",
            "why there?",
        ] {
            assert_eq!(asks(asked), Some(Language::English), "{asked}");
        }
        for asked in [
            "Hvorfor gik det til højttaleren?",
            "hvorfor kom det ikke på tv'et",
            "Hvorfor?",
            "Hvorfor blev det vist på min telefon og ikke her?",
        ] {
            assert_eq!(asks(asked), Some(Language::Danish), "{asked}");
        }
        // A why-question with any word of its own is an ordinary request, and
        // it goes to cognition like every other one.
        for asked in [
            "Why is the sky blue?",
            "Why do birds go south for the winter?",
            "Why is my phone slow?",
            "Hvorfor er himlen blå?",
            "Show me the route",
            "Why is that?",
            "Remember that the kitchen tap leaks",
            "Why did the transfer to account 4471 not go through?",
        ] {
            assert_eq!(asks(asked), None, "{asked}");
        }
    }

    #[test]
    fn ambiance_account_reads_the_last_decided_turn_and_skips_accounts_and_expressions() {
        let origin = Uuid::from_u128(1);
        let phone = Uuid::from_u128(2);
        let (first, second, third) = (
            Uuid::from_u128(10),
            Uuid::from_u128(11),
            Uuid::from_u128(12),
        );
        let began = |turn_id: Uuid, generation: u64| RuntimeData::TurnBegan {
            turn_id,
            generation,
            origin,
            request_digest: "0".repeat(64),
            privacy: PrivacyClass::SharedRoom,
        };
        let decided = |turn_id: Uuid, generation: u64, expression: bool| RuntimeData::Decision {
            turn_id,
            generation,
            action_id: Some(Uuid::new_v4()),
            privacy: PrivacyClass::SharedRoom,
            shape: Some(Shape::Note),
            hint: None,
            expression,
            candidates: vec![scored(phone, None, 200)],
        };
        let fence = |turn_id: Uuid, generation: u64| TurnFence {
            turn_id,
            generation,
            worker: Uuid::from_u128(99),
            origin_surface: origin,
        };
        let events = vec![
            event(1, 1_000, began(first, 1)),
            event(2, 1_001, decided(first, 1, false)),
            event(3, 2_000, began(second, 2)),
            event(
                4,
                2_001,
                RuntimeData::AccountRequested {
                    fence: fence(second, 2),
                },
            ),
            event(5, 2_002, decided(second, 2, false)),
            event(6, 3_000, began(third, 3)),
            event(7, 3_001, decided(third, 3, true)),
        ];
        // The newest turn only produced the runtime's own shared sentence, and
        // the one before it was itself an account: both are skipped.
        let found = accountable(&events, Uuid::from_u128(50), 4_000).unwrap();
        assert_eq!(found.turn_id, first);
        // A turn older than the window is not accounted for.
        assert!(accountable(&events, Uuid::from_u128(50), 1_000 + WINDOW_MS + 1).is_none());
        // The turn now asking never accounts for itself.
        assert!(accountable(&events, first, 4_000).is_none());
    }

    #[test]
    fn ambiance_account_card_names_kinds_reasons_and_never_a_surface() {
        let pin = Uuid::from_u128(1);
        let phone = Uuid::from_u128(2);
        let tv = Uuid::from_u128(3);
        let (tab, other) = (Uuid::from_u128(4), Uuid::from_u128(5));
        let kinds: Kinds = BTreeMap::from([
            (pin, "pin"),
            (phone, "android"),
            (tv, "android_tv"),
            (tab, "browser"),
            (other, "browser"),
        ]);
        let turn = Accounted {
            turn_id: Uuid::from_u128(9),
            generation: 1,
            began_at_ms: 0,
            origin: pin,
            privacy: PrivacyClass::Private,
            shape: Some(Shape::Note),
            hint: None,
            candidates: vec![
                scored(phone, None, 200),
                scored(tv, Some(Blocker::Privacy), 0),
                scored(tab, Some(Blocker::Unavailable), 0),
                scored(other, Some(Blocker::Unavailable), 0),
            ]
            .into_iter()
            .map(|candidate| Candidate {
                surface_id: candidate.surface_id,
                channel: candidate.channel,
                blocker: candidate.blocker,
                fit: candidate.shape_fit,
                unattended: false,
            })
            .collect(),
            lead: Some(phone),
            action: Some((Uuid::from_u128(10), Channel::VisualCard)),
            outcome: Some((phone, Channel::VisualCard)),
        };
        let card = compose(Some(&turn), &kinds, Language::English, 120_000);
        assert!(card.contains("You asked from your Ai Pin, 2 minutes ago."));
        assert!(card.contains("This reply was private to you."));
        assert!(card.contains("Cosmos selected your phone for it."));
        assert!(card.contains("Your phone showed it."));
        assert!(
            card.contains("Your TV could not show a card — private content is not allowed there.")
        );
        // Two browser tabs are one line with a count, not the same sentence twice.
        assert!(card.contains("2 browsers could not show a card — it was not connected."));
        for surface in [pin, phone, tv, tab, other] {
            assert!(!card.contains(&surface.to_string()));
        }
        let danish = compose(Some(&turn), &kinds, Language::Danish, 120_000);
        assert!(danish.contains("Du spurgte fra din Ai Pin for 2 minutter siden."));
        assert!(danish.contains("Det svar var privat for dig."));
        assert!(danish.contains("privat indhold må ikke vises der"));
        // Nothing to account for reads the same way in either language.
        assert!(compose(None, &kinds, Language::English, 0).starts_with("Nothing to account for"));
        assert!(compose(None, &kinds, Language::Danish, 0).starts_with("Intet at forklare"));
    }

    #[test]
    fn ambiance_account_speaks_every_class_and_never_the_shared_sentence() {
        let phone = Uuid::from_u128(2);
        let tv = Uuid::from_u128(3);
        let kinds: Kinds = BTreeMap::from([(phone, "android"), (tv, "android_tv")]);
        let at = |privacy| Accounted {
            turn_id: Uuid::from_u128(9),
            generation: 1,
            began_at_ms: 0,
            origin: phone,
            privacy,
            shape: Some(Shape::Note),
            hint: Some(RoutingTarget::AndroidTv),
            candidates: vec![
                Candidate {
                    surface_id: phone,
                    channel: Channel::VisualCard,
                    blocker: None,
                    fit: 200,
                    unattended: false,
                },
                Candidate {
                    surface_id: tv,
                    channel: Channel::VisualCard,
                    blocker: Some(Blocker::Privacy),
                    fit: 0,
                    unattended: false,
                },
            ],
            lead: Some(phone),
            action: Some((Uuid::from_u128(10), Channel::VisualCard)),
            outcome: Some((phone, Channel::VisualCard)),
        };
        // Every class the runtime can bind has an account, and each one says
        // what the class meant rather than naming it.
        for (privacy, english, danish) in [
            (
                PrivacyClass::Public,
                "safe for anyone to see",
                "trygt for alle at se",
            ),
            (
                PrivacyClass::SharedRoom,
                "other people can see",
                "andre kan se",
            ),
            (
                PrivacyClass::NearUser,
                "right beside you",
                "lige ved siden af dig",
            ),
            (PrivacyClass::Private, "private to you", "privat for dig"),
            (
                PrivacyClass::Sensitive,
                "too sensitive for any screen",
                "for følsomt til nogen skærm",
            ),
        ] {
            let card = compose(Some(&at(privacy)), &kinds, Language::English, 0);
            assert!(card.contains(english), "{privacy:?}: {card}");
            assert!(card.contains("The request carried a preference for the TV."));
            assert!(!card.contains("because you asked"));
            let card = compose(Some(&at(privacy)), &kinds, Language::Danish, 0);
            assert!(card.contains(danish), "{privacy:?}: {card}");
            // A full account is never the sentence a shared channel may carry,
            // at any class: the two are different objects, not two renderings
            // of one.
            for privacy in [
                PrivacyClass::Public,
                PrivacyClass::SharedRoom,
                PrivacyClass::NearUser,
                PrivacyClass::Private,
                PrivacyClass::Sensitive,
            ] {
                for language in [Language::English, Language::Danish] {
                    assert_ne!(
                        compose(Some(&at(privacy)), &kinds, language, 0),
                        language.elsewhere()
                    );
                }
            }
        }
    }

    #[test]
    fn ambiance_account_shared_sentence_is_one_fixed_string_for_every_turn() {
        // Whatever the class, the blocker or the absence of a turn, the
        // sentence a shared-perceivable channel may carry is the same bytes:
        // invariant 7 holds for the account exactly as it holds for the LED.
        assert_eq!(Language::English.elsewhere(), ELSEWHERE[0]);
        assert_eq!(Language::Danish.elsewhere(), ELSEWHERE[1]);
        for sentence in ELSEWHERE {
            for word in [
                "private",
                "privat",
                "sensitive",
                "følsom",
                "phone",
                "telefon",
                "TV",
                "Mac",
                "Pin",
                "blocked",
                "suppress",
            ] {
                assert!(!sentence.contains(word), "{sentence} names {word}");
            }
        }
    }

    #[test]
    fn ambiance_account_status_kinds_cover_every_binding() {
        assert_eq!(kind(&Binding::Browser), "browser");
        assert_eq!(
            kind(&Binding::Pin {
                device_id: "aabb".into()
            }),
            "pin"
        );
        for (platform, expected) in [
            ("macos", "macos"),
            ("linux", "linux"),
            ("android", "android"),
            ("android_tv", "android_tv"),
            ("something_new", "native"),
        ] {
            assert_eq!(
                kind(&Binding::Native {
                    enrollment_id: Uuid::nil(),
                    public_key: String::new(),
                    platform: platform.to_owned(),
                }),
                expected
            );
        }
    }
}
