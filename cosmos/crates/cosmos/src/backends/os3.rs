//! OS3, Rabbit's agent service, behind the optional `ask_os3` assistant tool.
//!
//! The owner's OS3 agent can see their other devices, computers, and files.
//! When the owner enables OS3 in Center, Cosmos becomes a plain OS3 client for
//! that owner's own account. This client passes the wearer's explicit OS3
//! requests (questions or tasks) and never answers OS3's confirmations or
//! forms:
//!
//! 1. `GET /api/auth/token` with the stored browser `Cookie` header returns an
//!    access token.
//! 2. `POST /session-directory/route` with that token as a Bearer credential
//!    (and the cookie, as the verified browser request carried both) names the
//!    instance hosting the account, or names none. The official OS3 web
//!    client (verified 2026-09-24 against the os3.rabbit.tech bundle) treats
//!    the route lookup as best effort: `kind: "any"`, a `route` without a
//!    usable `instanceId`, and an unreadable body all fall back to the DEFAULT
//!    host instead of failing. Why an account is pinned to an instance or
//!    served by the default one is Rabbit's alone (INFERRED lifecycle), but
//!    both answers are first-class, so a directory answer without an instance
//!    routes to the default host exactly as the official client's does.
//! 3. `wss://os3-<instance>.rabbit.tech/ws`, or `wss://os3.rabbit.tech/ws`
//!    when no instance was named, carries one JSON object per text message:
//!    `init` → `init_ack`, then a new Ask/Cancel sends `chat.message`. A
//!    retained Status observes only history and worker events, without chat.
//!    Events continue through correlated outcome, owner input, or deadline.
//!
//! The protocol is a reverse-engineered client contract, not a published API.
//! The two HTTP calls, init/init_ack, history snapshots, text chat, reactions,
//! idle, and the agent/activity events are verified.
//! The owner-supplied OS3 WebSocket client reference (2026-09-30), sections
//! 2 and 5, verifies independent history/agent/activity arrival and server-ID
//! correlation: neither a task reaction nor unscoped idle proves worker state.
//! The bounded recovery policy below is INFERRED. Section 4 verifies plaintext
//! form round trips, but Luma intentionally passes every form and confirmation
//! to the owner in OS3. Bearer-only routing, secure/questionId forms,
//! confirmation choices, and successful file retrieval remain unspecified.
//! This client sends the cookie on the route call and sends text only.
//!
//! ## Between questions
//!
//! OS3 often answers "let me check" and finishes the work later, after the
//! wearer's turn has ended. What a follow-up needs, the OS3 session ID and
//! the work OS3 had not finished (bounded), is the account's
//! `Os3Conversation` blob in the store, sealed under an AES key Cosmos mints
//! for that account in the key directory, as `account_api` seals web-written
//! food restrictions ([`ConversationStore`]). So "what did OS3 find?" resumes
//! the same OS3 conversation and reports the finished work, also after Cosmos
//! restarts. Account deletion removes the blob and its key. The conversation
//! remembers a digest of the cookie it was made with: a different cookie can
//! be a different OS3 account, so it starts a fresh conversation instead of
//! resuming another account's session or reporting its work.
//!
//! A question whose connection dropped before OS3's echo leaves a pre-send
//! journal, so Luma never sends it twice. The next question resolves it: a
//! status question hears that task's result, a new request is not sent while
//! its answer holds the earlier result, and a complete history without the
//! echo proves OS3 never received it. A journal Luma cannot resolve (another
//! sign-in, older than [`JOURNAL_LIMIT_MS`], or unreadable) ends with one
//! "could not confirm" line, and the wearer's new words are sent as new work.
//! An explicit stop may instead follow a recovered task's verified echo. Its
//! own uncertain delivery is recovered without resending the stop.
//!
//! While OS3 works, the Pin shows and speaks the stock interstitial: `ask_os3`
//! is a server action, so stock `LoadingMessageManager.onIntermediateAction`
//! asks `ActionBasedInterstitial` for it, and the catalog answers "Checking
//! with OS3" without echoing the request.
//!
//! Each test and question also records what it saw for Center's OS3 card
//! ([`crate::integrations::Os3Status`]): connected as OS3's display name for
//! the agent only when the contact went through, otherwise the step that
//! failed (Rabbit's edge refused it, the sign-in expired, no instance, the
//! socket refused, the connection dropped, or no response in time), and when
//! the assistant last asked. An answer Luma gives without contacting OS3,
//! such as no task to check or stop, records nothing.
//!
//! The cookie, the access token, the OS3 session ID, and the account email in
//! `init_ack` are never logged or returned. Only the agent's display name
//! reaches Center. The token travels only in the `init` message, never in a
//! URL. Replies reach the model as untrusted observation data, like every
//! other backend.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, COOKIE, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::integrations::{MAX_OS3_BUTLER_NAME_CHARS, Os3State};
use crate::keydirectory::{KeyDirectoryError, SharedKeyDirectory};
use crate::store::{AccountBlobKind, SharedStore};

/// Longest one question may hold the wearer's turn. The caller's own deadline
/// usually ends it sooner.
const ANSWER_LIMIT: Duration = Duration::from_secs(60);
/// A stop request stays responsive while waiting for a verified worker state.
const CANCEL_LIMIT: Duration = Duration::from_secs(15);
/// INFERRED: a read-only update observes once, with no background polling.
const STATUS_LIMIT: Duration = Duration::from_secs(10);
const NO_TASK_TO_CHECK: &str = "There's no Luma OS3 task to check.";
const NO_TASK_TO_STOP: &str = "There's no Luma OS3 task to stop.";

/// Luma-owned intent, inferred only from the wearer's current request. The
/// Ask/Cancel use ordinary text chat. Status only observes the retained
/// session. No cancel packet is invented.
#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub enum RequestKind {
    #[default]
    Ask,
    Status,
    Cancel,
}
/// Kept back from the caller's deadline to close the socket, save the
/// conversation, and render.
const SETTLE: Duration = Duration::from_secs(1);
/// Closing the socket and saving the conversation end at most this long after
/// the exchange's deadline, inside [`SETTLE`] ([`save_by`]).
const SAVE_LIMIT: Duration = Duration::from_millis(800);
/// Less time than this cannot sign in, route, initialize, and hear a reply, so
/// OS3 is not contacted at all.
const MIN_ASK_WINDOW: Duration = Duration::from_secs(3);
/// Center's test proxy waits 25 seconds. Finish comfortably inside it.
const PROBE_LIMIT: Duration = Duration::from_secs(20);
const INIT_ACK_LIMIT: Duration = Duration::from_secs(8);
const CLOSE_LIMIT: Duration = Duration::from_millis(500);
/// The largest message the socket accepts at all. History snapshots carry the
/// whole conversation, so a long-lived account's grow large.
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
/// Messages up to this size are read whole. A larger history snapshot is read
/// only for its latest [`MAX_SNAPSHOT_MESSAGES`] messages, a larger chat
/// message is reported without its content, and anything else larger is
/// skipped, so none of them breaks the question.
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOT_MESSAGES: usize = 200;
/// Rows of a table card spoken aloud.
const MAX_TABLE_ROWS: usize = 5;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
// INFERRED: authentication/directory metadata is bounded independently of the token.
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
/// A session, message, or agent ID kept between questions.
const MAX_ID_BYTES: usize = 256;
const MAX_REQUEST_CHARS: usize = 2_000;
const MAX_REPLY_CHARS: usize = 600;
const MAX_TITLE_CHARS: usize = 80;
const MAX_ITEMS: usize = 8;
/// Replies already given to the wearer, remembered while work is unfinished.
const MAX_REPORTED_IDS: usize = 128;
/// Unfinished workers carried to the next question.
const MAX_CARRIED_AGENTS: usize = 16;
/// Socket events retained while a reconnect waits for the authoritative
/// history snapshot that can place them relative to the lost question.
const MAX_RECOVERY_EVENTS: usize = 64;
/// The whole observation, which rides in the model's context afterwards.
const MAX_CHARS: usize = 1_500;
/// How long OS3 may stay quiet after this question's work ended while OS3 was
/// idle before the answer in hand is returned. OS3 relays what the work found
/// in a message of its own, which may already have come before the work's end
/// arrived. One that starts later reaches the next question instead.
const RELAY_GRACE: Duration = Duration::from_secs(3);
/// A task reaction is tied to the echoed message, but does not itself prove a
/// worker exists. Give Rabbit's independently delivered agent snapshot a short
/// window to correlate one before accepting an unscoped idle as final.
const AGENT_CORRELATION_GRACE: Duration = Duration::from_millis(750);
/// Marks a chat message [`next_event`] read without its oversized content.
const OVERSIZED: &str = "luma.oversized";
/// Marks a history snapshot whose older messages were discarded while
/// parsing an oversized event. Such a snapshot can answer an established
/// boundary, but cannot prove a lost question had exactly one matching echo.
const HISTORY_TRUNCATED: &str = "luma.history_truncated";
/// The payload type the saved conversation is sealed with.
const CONVERSATION_AAD: &[u8] = b"luma.os3.Conversation";
/// How long after it was asked a lost question can still be recovered. Past
/// this, or under another sign-in, the journal ends with [`EARLIER_UNCONFIRMED`]
/// rather than holding every later OS3 question (INFERRED bound: Rabbit
/// documents no session lifetime).
const JOURNAL_LIMIT_MS: i64 = 24 * 60 * 60 * 1000;
/// Clock difference allowed between this host and Rabbit when placing a lost
/// question's echo in history. The uniqueness check still applies inside it.
const RECOVERY_SKEW_MS: i64 = 5_000;

const EARLIER_UNCONFIRMED: &str = "Luma could not confirm whether OS3 received an earlier \
     request. Check it in the OS3 app.";

const EARLIER_NOT_RECEIVED: &str = "OS3 never received the earlier request, so it did not run.";

const ASK_AGAIN: &str = "Ask again to send it.";

const NEW_REQUEST_NOT_SENT: &str = "This new request was not sent to OS3 while Luma confirmed \
     the earlier one. Ask again to send it.";

const NEEDS_INPUT: &str = "OS3 needs the owner's input in the OS3 app before it can continue. \
     Nothing was answered on the owner's behalf.";

const DROPPED_AFTER_TAKEN: &str = "OS3 took the question, but the connection dropped before it \
     answered. Ask again later for the result.";

const ERRORED_BEFORE_TAKEN: &str = "OS3 reported an error before it accepted the question. Try \
     again in a moment.";

const ERRORED_AFTER_TAKEN: &str = "OS3 took the question, but reported an error instead of \
     answering. Ask for an update.";

const ERRORED_PART_WAY: &str = "OS3 then reported an error, so this may not be its whole answer.";

const TOO_LARGE_REPLY: &str = "OS3 replied with a message too large to read.";

const TOO_LARGE_EARLIER: &str = "An earlier OS3 result was too large to read.";

/// Why OS3 produced no usable answer, naming the step that failed. Carries no
/// credential or reply content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Os3Error {
    /// OS3 is disabled or has no session cookie.
    NotConfigured,
    /// The owner changed OS3 settings while this request waited its turn.
    ConfigurationChanged,
    /// Rabbit's edge turned the request away before any sign-in check: a 403
    /// that is not the API's own JSON answer.
    Blocked,
    /// OS3 refused the stored browser session.
    SignInExpired,
    /// The routed instance's socket answered the upgrade as missing (404).
    NoInstance,
    /// The conversation socket was refused, or closed before `init_ack`.
    SocketRefused,
    /// Another question from this deployment still holds the conversation.
    Busy,
    /// This account's explicit cancel yielded its older local waiting call.
    Superseded,
    /// Transport, protocol, or server failure.
    Unavailable,
    /// The connection dropped after it opened, before Luma observed OS3's
    /// server echo and could determine whether it took the question.
    Dropped,
    /// OS3 did not respond in time.
    NoAnswer,
    /// Cosmos could not read or save the account's sealed OS3 conversation:
    /// its own storage or key directory, not OS3.
    ConversationStorage,
}

impl Os3Error {
    /// A phrase safe to fold back into the model's transcript.
    pub fn observation(self) -> &'static str {
        match self {
            Self::NotConfigured => "OS3 is not connected in this deployment.",
            Self::ConfigurationChanged => {
                "OS3 settings changed while this request waited. It was not sent. Check Use OS3 in Center, then try again."
            }
            Self::Blocked => {
                "Rabbit's network turned the OS3 connection away before signing in. Try again \
                 later."
            }
            Self::SignInExpired => {
                "The OS3 sign-in has expired. The owner needs to paste a fresh OS3 session \
                 cookie in Center."
            }
            Self::NoInstance => {
                "OS3 signed in but has no agent instance for this account right now. Try again \
                 in a moment."
            }
            Self::SocketRefused => "OS3 refused the connection. Try again in a moment.",
            Self::Busy => "OS3 is still handling another question. Try again in a moment.",
            Self::Superseded => "Stopped waiting for OS3. Its task may still be running.",
            Self::Unavailable => "OS3 could not be reached.",
            Self::Dropped => {
                "The connection to OS3 dropped before Luma could confirm whether OS3 accepted \
                 the question, so it was not sent again. Ask \"What did OS3 find?\" later to \
                 check on it."
            }
            Self::NoAnswer => "OS3 did not answer in time.",
            Self::ConversationStorage => {
                "Luma could not read or save its OS3 conversation, so the OS3 request stopped. \
                 The owner can check Luma with ./luma doctor production."
            }
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::NotConfigured => "not_configured",
            Self::ConfigurationChanged => "configuration_changed",
            Self::Blocked => "blocked",
            Self::SignInExpired => "sign_in_expired",
            Self::NoInstance => "no_instance",
            Self::SocketRefused => "socket_refused",
            Self::Busy => "busy",
            Self::Superseded => "superseded",
            Self::Unavailable => "unavailable",
            Self::Dropped => "dropped",
            Self::NoAnswer => "no_answer",
            Self::ConversationStorage => "conversation_storage",
        }
    }

    /// What this failure shows Center about the connection, or `None` when
    /// it says nothing about the connection: OS3 was never contacted, or the
    /// failure was Cosmos's own storage.
    fn state(self) -> Option<Os3State> {
        match self {
            Self::NotConfigured
            | Self::ConfigurationChanged
            | Self::Busy
            | Self::Superseded
            | Self::ConversationStorage => None,
            Self::Blocked => Some(Os3State::Blocked),
            Self::SignInExpired => Some(Os3State::SignInExpired),
            Self::NoInstance => Some(Os3State::NoInstance),
            Self::SocketRefused => Some(Os3State::SocketRefused),
            Self::Unavailable => Some(Os3State::Unavailable),
            Self::Dropped => Some(Os3State::Dropped),
            Self::NoAnswer => Some(Os3State::TimedOut),
        }
    }
}

/// Whether the owner enabled OS3 and stored a session cookie.
pub fn configured() -> bool {
    crate::integrations::active().os3_session_cookie().is_some()
}

/// Whether `ask_os3` can do its job right now, for the assistant status, and
/// what it needs when it cannot: configured, and the last contact with the
/// current cookie went through.
pub fn readiness(integrations: &crate::integrations::IntegrationStore) -> (bool, &'static str) {
    if integrations.os3_session_cookie().is_none() {
        return (false, "Use OS3 and its session cookie in Center (optional)");
    }
    match integrations.os3_status().state {
        Os3State::Connected => (true, ""),
        Os3State::SignInExpired => (false, "A fresh OS3 session cookie in Center"),
        _ => (false, "A successful OS3 Test in Center"),
    }
}

/// Ask OS3 one text question and render what it said as an observation.
///
/// [`RequestKind::Status`] says the wearer only asked how earlier work is going
/// (`assistant::llm::os3_status_follow_up`), so recovering a lost question
/// answers it in full. `finish_by` is the latest instant the caller can still
/// use a result. The exchange ends [`SETTLE`] before it, or after
/// [`ANSWER_LIMIT`]. `saved` is the asking account's conversation. Without it
/// the question starts a fresh one and nothing carries over to a follow-up.
pub async fn ask(
    request: &str,
    kind: RequestKind,
    finish_by: Option<std::time::Instant>,
    saved: Option<ConversationStore>,
) -> Result<String, Os3Error> {
    let integrations = crate::integrations::active();
    let cookie = integrations
        .os3_session_cookie()
        .ok_or(Os3Error::NotConfigured)?;
    // Out of time is not OS3 being down: say it did not answer in time.
    let now = Instant::now();
    let mut deadline = ask_deadline(now, finish_by).ok_or(Os3Error::NoAnswer)?;
    if kind == RequestKind::Cancel {
        deadline = deadline.min(now + CANCEL_LIMIT);
    } else if kind == RequestKind::Status {
        deadline = deadline.min(now + STATUS_LIMIT);
    }
    let asked = client()
        .ask(&cookie, request, kind, deadline, saved.as_ref())
        .await;
    match (asked.answer.as_ref().err(), asked.interrupted) {
        (Some(Os3Error::Superseded), _) => {
            tracing::debug!("OS3 wait yielded to the wearer's stop request");
        }
        (Some(error), _) => tracing::warn!(error = error.label(), "OS3 question failed"),
        (None, Some(step)) => {
            tracing::warn!(error = step.label(), "OS3 question answered only in part");
        }
        (None, None) => {}
    }
    if let Some((state, butler_name)) =
        contact(&asked.answer, asked.connected_as, asked.interrupted)
    {
        integrations.record_os3_contact(&cookie, state, butler_name, true);
    }
    asked.answer
}

/// When one question must finish, or `None` when the caller's window leaves
/// less than [`MIN_ASK_WINDOW`].
fn ask_deadline(now: Instant, finish_by: Option<std::time::Instant>) -> Option<Instant> {
    let mut deadline = now + ANSWER_LIMIT;
    #[cfg(test)]
    if std::env::var_os("LUMA_HTTP_OS3_FIXTURE_CHILD").is_some() {
        let millis: u64 = std::env::var("LUMA_TEST_OS3_ASK_WINDOW_MS")
            .expect("fixture window")
            .parse()
            .expect("fixture milliseconds");
        assert!((3_000..=60_000).contains(&millis));
        deadline = now + Duration::from_millis(millis);
    }
    if let Some(finish_by) = finish_by {
        let usable = Instant::from_std(finish_by)
            .checked_sub(SETTLE)
            .unwrap_or(now);
        deadline = deadline.min(usable.max(now));
    }
    (deadline >= now + MIN_ASK_WINDOW).then_some(deadline)
}

/// When saving the conversation must give up. An exchange that ran to its
/// deadline has already spent part of [`SETTLE`] closing the socket, so the
/// save ends [`SAVE_LIMIT`] after that deadline, not after the close: a slow
/// store costs the follow-up, never this question's answer.
fn save_by(now: Instant, deadline: Instant) -> Instant {
    (now + SAVE_LIMIT).min(deadline + SAVE_LIMIT)
}

/// An in-flight checkpoint may never spend the caller's remaining answer
/// window. Unlike the final save, this cannot run past `deadline`: before the
/// chat is submitted, failure means Rabbit must not receive the work.
fn checkpoint_by(now: Instant, deadline: Instant) -> Instant {
    (now + SAVE_LIMIT).min(deadline)
}

/// Center's connection test: sign in, route, and initialize, but ask nothing.
/// Answers OS3's display name for the agent, empty when it gave none.
pub async fn probe() -> Result<String, Os3Error> {
    let integrations = crate::integrations::active();
    let cookie = integrations
        .os3_session_cookie()
        .ok_or(Os3Error::NotConfigured)?;
    let probed = client().probe(&cookie, Instant::now() + PROBE_LIMIT).await;
    if let Err(error) = probed {
        tracing::warn!(error = error.label(), "OS3 test failed");
    }
    if let Some((state, butler_name)) = contact(&probed, probed.clone().ok(), None) {
        integrations.record_os3_contact(&cookie, state, butler_name, false);
    }
    probed
}

/// What one contact with OS3 showed, for Center's status, or `None` when it
/// showed nothing because OS3 was never contacted. Only a contact that went
/// through is `Connected`, as OS3's name for the agent (`connected_as`, from
/// `init_ack`). An answer without it is Luma's own, such as no task to check
/// or stop, and shows nothing. `interrupted` is the step that failed a
/// question the wearer still hears something about.
fn contact<T>(
    result: &Result<T, Os3Error>,
    connected_as: Option<String>,
    interrupted: Option<Os3Error>,
) -> Option<(Os3State, Option<String>)> {
    match (result, interrupted) {
        (Ok(_), Some(step)) => step.state().map(|state| (state, None)),
        (Ok(_), None) => connected_as.map(|name| {
            (
                Os3State::Connected,
                Some(name).filter(|name| !name.is_empty()),
            )
        }),
        (Err(error), _) => error.state().map(|state| (state, None)),
    }
}

/// INFERRED: closed assistant follow-ups may inspect only whether their verified
/// account has work under the currently linked cookie. No provider request,
/// content, identifiers or task titles leave this bounded policy query.
pub async fn has_retained_task(
    saved: &ConversationStore,
    finish_by: Option<std::time::Instant>,
) -> Result<bool, Os3Error> {
    if saved.canonical_account().is_none() {
        return Ok(false);
    }
    let Some(cookie) = crate::integrations::active().os3_session_cookie() else {
        return Ok(false);
    };
    let now = Instant::now();
    let mut deadline = now + crate::assistant::runtime::CONTEXT_LOAD_LIMIT;
    if let Some(finish_by) = finish_by {
        deadline = deadline.min(Instant::from_std(finish_by));
    }
    if deadline <= now {
        return Err(Os3Error::NoAnswer);
    }
    let conversation = tokio::time::timeout_at(deadline, saved.load())
        .await
        .map_err(|_| Os3Error::ConversationStorage)?
        .ok_or(Os3Error::ConversationStorage)?;
    Ok(
        conversation.cookie.as_deref() == Some(cookie_digest(&cookie).as_str())
            && conversation.session_id.is_some()
            && (conversation
                .unfinished
                .as_ref()
                .is_some_and(|work| work.boundary.is_some())
                || conversation.in_flight.as_ref().is_some_and(|journal| {
                    journal.recoverable(i64::try_from(now_ms()).unwrap_or(i64::MAX))
                })),
    )
}

/// Where OS3 lives. Production always uses [`Endpoints::production`]. Only
/// tests point a client at a local mock, which is the one way a plaintext
/// `ws://` socket URL can exist.
#[derive(Clone)]
struct Endpoints {
    origin: String,
    /// Socket URL in which `{instance}` stands for the validated instance ID.
    socket: String,
    /// The default socket, which serves an account the directory routed to no
    /// instance. The official web client's fallback for every `kind: "any"`
    /// routing answer is its own page host, `os3.rabbit.tech` (verified
    /// 2026-09-24).
    socket_any: String,
}

impl Endpoints {
    fn production() -> Self {
        // HTTP workflow fixtures run in a fresh test subprocess. Production
        // never reads these loopback-only test variables.
        #[cfg(test)]
        if std::env::var_os("LUMA_HTTP_OS3_FIXTURE_CHILD").is_some() {
            let origin = std::env::var("LUMA_TEST_OS3_HTTP_ORIGIN").expect("fixture origin");
            let socket = std::env::var("LUMA_TEST_OS3_SOCKET").expect("fixture socket");
            assert!(origin.starts_with("http://127.0.0.1:"));
            assert!(socket.starts_with("ws://127.0.0.1:"));
            return Self {
                origin,
                socket: socket.clone(),
                socket_any: socket,
            };
        }
        Self {
            origin: "https://os3.rabbit.tech".to_owned(),
            socket: "wss://os3-{instance}.rabbit.tech/ws".to_owned(),
            socket_any: "wss://os3.rabbit.tech/ws".to_owned(),
        }
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn client() -> &'static Os3Client {
    static CLIENT: OnceLock<Os3Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let mut client = Os3Client::new(Endpoints::production());
        client.integrations = Some(crate::integrations::active());
        client
    })
}

/// The User-Agent every OS3 request carries, HTTP and WebSocket alike.
///
/// Rabbit's edge answers 403 to non-browser clients before any sign-in check
/// (verified 2026-09-23: no User-Agent, `curl/…` and an honest `Luma/…` all
/// got an HTML 403, a browser User-Agent got the API's own 401). Rabbit gave
/// the owner the go-ahead to send a browser User-Agent for this integration.
/// If Rabbit publishes an official client identity, use that instead.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/// A dedicated HTTP client: a redirect from the token endpoint is a sign-in
/// page, not a token, so redirects are reported rather than followed.
fn http() -> reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .timeout(Duration::from_secs(8))
            .connect_timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
    .clone()
}

/// The socket handshake a browser on `origin` sends: the same User-Agent as
/// the HTTP calls, plus the page origin browsers always attach to WebSockets.
fn socket_request(
    url: &str,
    origin: &str,
) -> Option<tokio_tungstenite::tungstenite::handshake::client::Request> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::{HeaderValue as WsHeader, header};

    let mut request = url.into_client_request().ok()?;
    let headers = request.headers_mut();
    headers.insert(
        header::USER_AGENT,
        WsHeader::from_static(BROWSER_USER_AGENT),
    );
    headers.insert(header::ORIGIN, WsHeader::from_str(origin).ok()?);
    Some(request)
}

/// What one account's OS3 conversation carries from one question to the next.
/// Deliberately no `Debug`: the session ID is never logged.
#[derive(Clone, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
struct Conversation {
    /// [`cookie_digest`] of the cookie this conversation was made with. A
    /// question with any other cookie starts a fresh conversation.
    cookie: Option<String>,
    /// Returned by `init_ack`. Sent on the next `init` so follow-up questions
    /// continue the same OS3 conversation.
    session_id: Option<String>,
    /// A question durably recorded before its chat frame was sent, but whose
    /// exact server echo has not yet been durably installed as a boundary.
    /// Only a digest is retained. The request text never enters this blob.
    in_flight: Option<InFlight>,
    /// Work OS3 had not finished when the previous question returned.
    unfinished: Option<Unfinished>,
}

#[derive(Clone, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
struct InFlight {
    /// [`request_digest`] of the exact normalized chat text and `asked_at`.
    request_digest: String,
    /// Client wall-clock milliseconds placed on the submitted chat frame.
    asked_at: i64,
    /// A lost stop request is recovered without sending a second one, even
    /// when the wearer phrases their next cancellation differently.
    cancel: bool,
}

impl InFlight {
    fn valid(&self) -> bool {
        self.asked_at > 0
            && self.request_digest.len() == 64
            && self
                .request_digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    /// Whether this journal can still be recovered at `now` (Unix ms): valid,
    /// and asked within [`JOURNAL_LIMIT_MS`].
    fn recoverable(&self, now: i64) -> bool {
        self.valid() && now.saturating_sub(self.asked_at) <= JOURNAL_LIMIT_MS
    }

    /// Keep a corrupt or future over-bound journal without keeping
    /// attacker-sized fields. It is not recoverable, so the next question ends
    /// it with [`EARLIER_UNCONFIRMED`] rather than trusting it.
    fn blocked() -> Self {
        Self::default()
    }
}

#[derive(Clone, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
struct Unfinished {
    /// Server ID of that question's echo. Agent replies after it in a later
    /// history snapshot are its late results.
    boundary: Option<String>,
    /// Agent replies already given to the wearer.
    reported: HashSet<String>,
    /// Workers still running for it, by agent ID, with their titles.
    agents: HashMap<String, String>,
}

impl Conversation {
    /// Only what questions can legitimately leave behind. A saved record is
    /// read back through this too, so it can never grow past these bounds.
    fn bounded(mut self) -> Self {
        self.cookie = self.cookie.filter(|digest| valid_id(digest));
        self.session_id = self.session_id.filter(|id| valid_id(id));
        if self
            .in_flight
            .as_ref()
            .is_some_and(|journal| !journal.valid())
        {
            self.in_flight = Some(InFlight::blocked());
        }
        if let Some(unfinished) = self.unfinished.as_mut() {
            unfinished.boundary = unfinished.boundary.take().filter(|id| valid_id(id));
            if unfinished.reported.len() > MAX_REPORTED_IDS {
                unfinished.reported.clear();
            }
            unfinished.reported.retain(|id| valid_id(id));
            unfinished.agents.retain(|id, _| valid_id(id));
            if unfinished.agents.len() > MAX_CARRIED_AGENTS {
                let mut ids: Vec<String> = unfinished.agents.keys().cloned().collect();
                ids.sort();
                for id in ids.split_off(MAX_CARRIED_AGENTS) {
                    unfinished.agents.remove(&id);
                }
            }
            for title in unfinished.agents.values_mut() {
                *title = tidy(title, MAX_TITLE_CHARS);
            }
        }
        self
    }
}

/// Names the stored cookie a conversation belongs to without keeping it.
fn cookie_digest(cookie: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::new()
        .chain_update(b"luma.os3.cookie\0")
        .chain_update(cookie.as_bytes())
        .finalize()[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A non-reversible name for one exact normalized submission. `asked_at` is
/// inside the domain-separated digest as well as stored beside it, so a same-
/// text message from another turn cannot share the journal value.
fn request_digest(request: &str, asked_at: i64) -> String {
    use sha2::{Digest, Sha256};
    Sha256::new()
        .chain_update(b"luma.os3.in_flight.request.v1\0")
        .chain_update(asked_at.to_be_bytes())
        .chain_update(request.as_bytes())
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Where one account's OS3 conversation waits between questions: the
/// account's [`AccountBlobKind::Os3Conversation`] blob, sealed under an AES
/// key Cosmos mints for the account in the key directory, with the payload
/// type as AAD.
pub struct ConversationStore {
    store: SharedStore,
    keys: SharedKeyDirectory,
    account: String,
}

impl ConversationStore {
    pub fn new(store: SharedStore, keys: SharedKeyDirectory, account: &str) -> Self {
        Self {
            store,
            keys,
            account: account.to_owned(),
        }
    }

    /// Callers create this store from their authenticated account principal.
    /// Reject noncanonical/absent account names for local preemption, even
    /// though historical synthetic stores may still be read by other tests.
    fn canonical_account(&self) -> Option<&str> {
        let user = self.account.strip_prefix("U:")?;
        if user.is_empty() {
            return None;
        }
        let principal = cosmos_core::AuthenticatedPrincipal::for_user(user).ok()?;
        (principal.expose_for_authorization() == self.account).then_some(self.account.as_str())
    }

    /// Named after the account, as the food restrictions key is, so the key
    /// directory and account deletion attribute it.
    fn kid(&self) -> String {
        format!("{}/os3/conversation", self.account)
    }

    /// The saved conversation, or `None` when it cannot be read safely. No blob
    /// or an intentionally removed account key starts fresh. An operational,
    /// authentication, type, or parse failure stops the question so unreadable
    /// in-flight work cannot be submitted twice.
    async fn load(&self) -> Option<Conversation> {
        let data = self
            .store
            .get_account_blob(&self.account, AccountBlobKind::Os3Conversation)
            .await
            .ok()?;
        let Some(data) = data else {
            return Some(Conversation::default());
        };
        let envelope = cosmos_crypto::EncryptedData {
            kid: self.kid(),
            data,
        };
        let plaintext = match self.keys.open(&envelope).await {
            Ok(Some(plaintext)) => plaintext,
            // No key means the account's conversation key was intentionally
            // removed, as during account deletion. The orphaned blob can no
            // longer name resumable work and starts fresh.
            Ok(None) => return Some(Conversation::default()),
            // A held key that cannot authenticate this blob is corruption, not
            // an empty conversation: asking again could duplicate accepted
            // work whose in-flight journal can no longer be read.
            Err(KeyDirectoryError::OpenFailed) => return None,
            Err(_) => return None,
        };
        let aad = cosmos_crypto::envelope_aad(&envelope.data).ok()?;
        if aad != CONVERSATION_AAD {
            return None;
        }
        serde_json::from_slice::<Conversation>(&plaintext)
            .ok()
            .map(Conversation::bounded)
    }

    /// Seal and keep the conversation, minting the account's key the first
    /// time. `false` when it could not be kept.
    async fn save(&self, conversation: &Conversation) -> bool {
        let Ok(plaintext) = serde_json::to_vec(&conversation.clone().bounded()) else {
            return false;
        };
        let kid = self.kid();
        let sealed = async {
            if !self.keys.holds(&kid).await? {
                let mut key = [0u8; cosmos_crypto::AES_KEY_LEN];
                rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
                self.keys.put(&kid, key).await?;
            }
            self.keys.seal(&kid, &plaintext, CONVERSATION_AAD).await
        };
        let Ok(Some(envelope)) = sealed.await else {
            return false;
        };
        self.store
            .put_account_blob(
                &self.account,
                AccountBlobKind::Os3Conversation,
                &envelope.data,
            )
            .await
            .is_ok()
    }
}

struct Os3Client {
    endpoints: Endpoints,
    integrations: Option<std::sync::Arc<crate::integrations::IntegrationStore>>,
    /// One question at a time: the conversation has no request IDs, so two
    /// concurrent questions could not tell their replies apart.
    turn: tokio::sync::Mutex<()>,
    active_turn: std::sync::Mutex<Option<ActiveTurn>>,
}

struct ActiveTurn {
    account: String,
    cookie_digest: String,
    yield_wait: std::sync::Arc<tokio::sync::Notify>,
}

/// The holder clears its identity when the caller future is dropped. The
/// global socket lock outlives this guard, including any normal final save.
struct ActiveTurnGuard<'a> {
    holder: &'a std::sync::Mutex<Option<ActiveTurn>>,
    yield_wait: std::sync::Arc<tokio::sync::Notify>,
}

impl Drop for ActiveTurnGuard<'_> {
    fn drop(&mut self) {
        let mut active = self.holder.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|turn| std::sync::Arc::ptr_eq(&turn.yield_wait, &self.yield_wait))
        {
            *active = None;
        }
    }
}

/// One question's answer, and what it showed of the connection on the way.
struct Asked {
    answer: Result<String, Os3Error>,
    /// OS3's display name for the agent once `init_ack` accepted the session,
    /// empty when it gave none. An answer without it never reached OS3.
    connected_as: Option<String>,
    /// The step that failed this question although the answer has text: the
    /// connection dropped, or OS3 never took the question, while earlier
    /// results or the drop itself are still worth saying.
    interrupted: Option<Os3Error>,
}

impl Asked {
    fn failed(error: Os3Error) -> Self {
        Self {
            answer: Err(error),
            connected_as: None,
            interrupted: None,
        }
    }
}

/// An initialized socket.
struct Connected {
    socket: Socket,
    butler_name: String,
}

impl Os3Client {
    fn new(endpoints: Endpoints) -> Self {
        Self {
            endpoints,
            integrations: None,
            turn: tokio::sync::Mutex::new(()),
            active_turn: std::sync::Mutex::new(None),
        }
    }

    /// Sign in, route, and initialize a fresh session without asking, so a
    /// test needs no account's conversation. It still waits its turn: a
    /// second socket beside a question is not part of the verified contract.
    async fn probe(&self, cookie: &str, deadline: Instant) -> Result<String, Os3Error> {
        let _turn = self.take_turn(deadline).await?;
        if self
            .integrations
            .as_ref()
            .is_some_and(|store| store.os3_session_cookie().as_deref() != Some(cookie))
        {
            return Err(Os3Error::ConfigurationChanged);
        }
        let connected = self
            .connect(cookie, &mut Conversation::default(), deadline)
            .await?;
        close(connected.socket).await;
        Ok(connected.butler_name)
    }

    /// Wait for the conversation. A wait that leaves less than
    /// [`MIN_ASK_WINDOW`] is `Busy`: another question held OS3 the whole
    /// time, and this one was never asked.
    async fn take_turn(
        &self,
        deadline: Instant,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>, Os3Error> {
        if let Ok(turn) = self.turn.try_lock() {
            return Ok(turn);
        }
        let turn = tokio::time::timeout_at(deadline, self.turn.lock())
            .await
            .map_err(|_| Os3Error::Busy)?;
        if Instant::now() + MIN_ASK_WINDOW > deadline {
            return Err(Os3Error::Busy);
        }
        Ok(turn)
    }

    async fn ask(
        &self,
        cookie: &str,
        request: &str,
        kind: RequestKind,
        deadline: Instant,
        saved: Option<&ConversationStore>,
    ) -> Asked {
        let request = tidy(request, MAX_REQUEST_CHARS);
        // Reject changed configuration before signaling another waiting call,
        // and again after acquiring the socket lock for queued changes.
        if self
            .integrations
            .as_ref()
            .is_some_and(|store| store.os3_session_cookie().as_deref() != Some(cookie))
        {
            return Asked::failed(Os3Error::ConfigurationChanged);
        }
        let account = saved.and_then(ConversationStore::canonical_account);
        let sign_in = cookie_digest(cookie);
        if kind == RequestKind::Cancel
            && let Some(account) = account
        {
            let active = self.active_turn.lock().unwrap();
            if let Some(active) = active
                .as_ref()
                .filter(|active| active.account == account && active.cookie_digest == sign_in)
            {
                active.yield_wait.notify_one();
            }
        }
        let _turn = match self.take_turn(deadline).await {
            Ok(turn) => turn,
            Err(error) => return Asked::failed(error),
        };
        // INFERRED: a settings change while waiting revokes this queued request
        // before authentication or any sealed conversation is touched. Work
        // already accepted on an earlier turn keeps its recovery journal.
        if self
            .integrations
            .as_ref()
            .is_some_and(|store| store.os3_session_cookie().as_deref() != Some(cookie))
        {
            return Asked::failed(Os3Error::ConfigurationChanged);
        }
        // Stock TaoEventDispatcher.onChatTurn dispatches new requests without
        // canceling the earlier SynapseInterpreter.interpretLegacy RPC. That
        // method waits a plain future. INFERRED: only this authenticated
        // account's explicit cancel may yield its same-cookie local wait.
        let active = account
            .filter(|_| kind != RequestKind::Cancel)
            .map(|account| {
                let yield_wait = std::sync::Arc::new(tokio::sync::Notify::new());
                *self.active_turn.lock().unwrap() = Some(ActiveTurn {
                    account: account.to_owned(),
                    cookie_digest: sign_in.clone(),
                    yield_wait: yield_wait.clone(),
                });
                ActiveTurnGuard {
                    holder: &self.active_turn,
                    yield_wait,
                }
            });
        let work = async {
            // Production work must be resumable before Rabbit can receive it. If
            // the account's sealed conversation cannot be read, fail closed rather
            // than asking ephemerally and losing accepted Mac work on cancellation.
            let before = match saved {
                Some(saved) => {
                    match tokio::time::timeout_at(
                        checkpoint_by(Instant::now(), deadline),
                        saved.load(),
                    )
                    .await
                    {
                        Ok(Some(conversation)) => conversation,
                        _ => {
                            tracing::warn!("the OS3 conversation could not be read before asking");
                            return (Asked::failed(Os3Error::ConversationStorage), None);
                        }
                    }
                }
                None => Conversation::default(),
            };
            // A conversation made with another cookie, perhaps another OS3
            // account, is neither resumed nor reported: start over.
            let signed_in_with = cookie_digest(cookie);
            let same_sign_in = before.cookie.as_deref() == Some(signed_in_with.as_str());
            if kind == RequestKind::Status
                && (!same_sign_in
                    || before.session_id.is_none()
                    || (!before.in_flight.as_ref().is_some_and(|journal| {
                        journal.recoverable(i64::try_from(now_ms()).unwrap_or(i64::MAX))
                    }) && before
                        .unfinished
                        .as_ref()
                        .is_none_or(|work| work.boundary.is_none())))
            {
                return (
                    Asked {
                        answer: Ok(NO_TASK_TO_CHECK.to_owned()),
                        connected_as: None,
                        interrupted: None,
                    },
                    None,
                );
            }
            // A cancellation is restricted to this wearer's retained Luma work,
            // never whatever the newly linked Rabbit account happens to be doing.
            // No task means no authentication, socket, or remote stop request.
            if kind == RequestKind::Cancel
                && (!same_sign_in
                    || before.session_id.is_none()
                    || (before.unfinished.is_none() && before.in_flight.is_none()))
            {
                return (
                    Asked {
                        answer: Ok(NO_TASK_TO_STOP.to_owned()),
                        connected_as: None,
                        interrupted: None,
                    },
                    None,
                );
            }
            if kind == RequestKind::Cancel
                && before.in_flight.as_ref().is_some_and(|journal| {
                    !journal.recoverable(i64::try_from(now_ms()).unwrap_or(i64::MAX))
                })
            {
                return (
                    Asked {
                        answer: Ok(
                            "I couldn't confirm the earlier OS3 request. Stop the task in OS3."
                                .to_owned(),
                        ),
                        connected_as: None,
                        interrupted: None,
                    },
                    None,
                );
            }
            let mut conversation = if same_sign_in {
                before.clone()
            } else {
                Conversation::default()
            };
            // A lost question another sign-in asked, or one too old or unreadable
            // to recover, has no status left to check. Holding its journal would
            // fail every later question, so it ends here with one line, and the
            // wearer's new words go to OS3 as new work. Luma never resends the
            // lost question itself. (When this question then fails before an
            // answer, the line goes unsaid. The journal still ends.)
            let mut notice = None;
            let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
            if (!same_sign_in && before.in_flight.is_some())
                || conversation
                    .in_flight
                    .as_ref()
                    .is_some_and(|journal| !journal.recoverable(now))
            {
                conversation.in_flight = None;
                notice = Some(EARLIER_UNCONFIRMED);
            }
            conversation.cookie = Some(signed_in_with);
            let mut asked = self
                .exchange(cookie, &request, kind, deadline, &mut conversation, saved)
                .await;
            if let Some(notice) = notice {
                asked.answer = asked.answer.map(|answer| with_notice(notice, &answer));
            }
            (asked, Some(conversation))
        };
        let result = if let Some(active) = active.as_ref() {
            tokio::select! {
                biased;
                _ = active.yield_wait.notified() => return Asked::failed(Os3Error::Superseded),
                result = work => result,
            }
        } else {
            work.await
        };
        // Remove preemption identity before final save. The socket lock stays
        // held until the save finishes. A yielded call performs no final save,
        // so it cannot overwrite its successor's cancellation checkpoint.
        drop(active);
        let (asked, conversation) = result;
        let Some(conversation) = conversation else {
            return asked;
        };
        // An inline checkpoint may have changed the stored blob even when the
        // final in-memory value equals `before`. Always write the final state
        // so a completed worker is not resurrected by that checkpoint.
        if let Some(saved) = saved
            && !matches!(
                tokio::time::timeout_at(
                    save_by(Instant::now(), deadline),
                    saved.save(&conversation)
                )
                .await,
                Ok(true)
            )
        {
            tracing::warn!("the OS3 conversation could not be saved");
        }
        asked
    }

    /// One question over a fresh socket, updating `conversation` with what a
    /// follow-up needs.
    async fn exchange(
        &self,
        cookie: &str,
        request: &str,
        kind: RequestKind,
        deadline: Instant,
        conversation: &mut Conversation,
        saved: Option<&ConversationStore>,
    ) -> Asked {
        let retained_session = conversation.session_id.clone();
        let recovering = conversation.in_flight.clone();
        let recovery_session = recovering
            .as_ref()
            .and_then(|_| conversation.session_id.clone());
        // `ask` already ended a journal it cannot recover. One saved without
        // its session has no route back to the question.
        if recovering.is_some() && recovery_session.is_none() {
            return Asked::failed(Os3Error::Dropped);
        }
        let Connected {
            mut socket,
            butler_name,
        } = match self.connect(cookie, conversation, deadline).await {
            Ok(connected) => connected,
            Err(error) => {
                // A refused retained session cannot authorize resubmitting an
                // ambiguously accepted task. Keep the journal and its only
                // reconnect route so every later attempt remains fail-closed.
                if let Some(session_id) = recovery_session {
                    conversation.session_id = Some(session_id);
                }
                return Asked::failed(error);
            }
        };
        let connected_as = Some(butler_name);

        // Recovery sends nothing until it knows what OS3 received. The init
        // must resume exactly the session saved atomically with the journal. A
        // new or replaced session cannot prove whether the old one accepted
        // the question.
        if let Some(journal) = recovering {
            if conversation.session_id != recovery_session {
                conversation.session_id = recovery_session;
                close(socket).await;
                return Asked {
                    answer: Err(Os3Error::Dropped),
                    connected_as,
                    interrupted: None,
                };
            }
            // Recovery reads the earlier question's result and sends nothing.
            // Unless the wearer only asked for that status, their new request
            // was not sent, and the answer must say so rather than present
            // the earlier result as its reply.
            let exchange = match self
                .recover_exchange(
                    &mut socket,
                    &journal,
                    conversation.unfinished.clone(),
                    kind == RequestKind::Ask,
                    deadline,
                )
                .await
            {
                Ok(Recovered::Echoed(exchange)) => {
                    let exchange = *exchange;
                    if kind == RequestKind::Cancel && !journal.cancel {
                        // The original task's exact echo is verified in the
                        // retained session before the owner's stop can leave.
                        if let Err(error) = self
                            .checkpoint_exchange(saved, conversation, &exchange, deadline)
                            .await
                        {
                            close(socket).await;
                            return Asked {
                                answer: Err(error),
                                connected_as,
                                interrupted: None,
                            };
                        }
                        return self
                            .submit(
                                socket,
                                request,
                                Vec::new(),
                                kind,
                                deadline,
                                conversation,
                                saved,
                                connected_as,
                            )
                            .await;
                    }
                    exchange
                }
                Ok(Recovered::NotReceived { history, before }) => {
                    // OS3 never received it: end the journal durably before
                    // anything else can be sent.
                    let mut proposed = conversation.clone();
                    proposed.in_flight = None;
                    if let Err(error) = self
                        .checkpoint(saved, &proposed, deadline, "after recovery")
                        .await
                    {
                        close(socket).await;
                        return Asked {
                            answer: Err(error),
                            connected_as,
                            interrupted: None,
                        };
                    }
                    *conversation = proposed;
                    if kind == RequestKind::Status {
                        close(socket).await;
                        return Asked {
                            answer: Ok(format!("{EARLIER_NOT_RECEIVED} {ASK_AGAIN}")),
                            connected_as,
                            interrupted: None,
                        };
                    }
                    if kind == RequestKind::Cancel && conversation.unfinished.is_none() {
                        close(socket).await;
                        return Asked {
                            answer: Ok(NO_TASK_TO_STOP.to_owned()),
                            connected_as,
                            interrupted: None,
                        };
                    }
                    // New words are new work: send them on this socket.
                    let mut replayed = vec![history];
                    replayed.extend(before);
                    let mut asked = self
                        .submit(
                            socket,
                            request,
                            replayed,
                            kind,
                            deadline,
                            conversation,
                            saved,
                            connected_as,
                        )
                        .await;
                    asked.answer = asked
                        .answer
                        .map(|answer| with_notice(EARLIER_NOT_RECEIVED, &answer));
                    return asked;
                }
                Err(error) => {
                    close(socket).await;
                    return Asked {
                        answer: Err(error),
                        connected_as,
                        interrupted: None,
                    };
                }
            };
            return self
                .drive_exchange(
                    socket,
                    exchange,
                    deadline,
                    conversation,
                    saved,
                    connected_as,
                )
                .await;
        }

        if kind == RequestKind::Status {
            // INFERRED: an update reads the retained task, never creates a new
            // Rabbit chat/model request. Only that exact initialized session
            // can speak for work accepted on its saved server boundary.
            if conversation.session_id != retained_session {
                conversation.session_id = retained_session;
                close(socket).await;
                return Asked {
                    answer: Err(Os3Error::Dropped),
                    connected_as,
                    interrupted: None,
                };
            }
            let previous = conversation.unfinished.clone();
            let exchange = Exchange {
                boundary: previous.as_ref().and_then(|work| work.boundary.clone()),
                ..Exchange::for_request(previous, RequestKind::Status)
            };
            return self
                .drive_exchange(
                    socket,
                    exchange,
                    deadline,
                    conversation,
                    saved,
                    connected_as,
                )
                .await;
        }

        self.submit(
            socket,
            request,
            Vec::new(),
            kind,
            deadline,
            conversation,
            saved,
            connected_as,
        )
        .await
    }

    /// Send `request` as a new question on an initialized socket: seal the
    /// pre-send journal, send the chat, and drive the exchange. `replayed`
    /// holds events a recovery already read from this socket.
    #[allow(clippy::too_many_arguments)]
    async fn submit(
        &self,
        mut socket: Socket,
        request: &str,
        replayed: Vec<Value>,
        kind: RequestKind,
        deadline: Instant,
        conversation: &mut Conversation,
        saved: Option<&ConversationStore>,
        connected_as: Option<String>,
    ) -> Asked {
        // `init_ack` gives the only durable session identifier. The session
        // and pre-send journal are sealed in one blob before Rabbit can receive
        // the chat, so cancellation can always reconnect without resubmitting.
        if saved.is_some() && conversation.session_id.is_none() {
            close(socket).await;
            return Asked {
                answer: Err(Os3Error::Unavailable),
                connected_as,
                interrupted: None,
            };
        }
        let asked_at = i64::try_from(now_ms()).unwrap_or(i64::MAX);
        if saved.is_some() {
            let mut proposed = conversation.clone();
            proposed.in_flight = Some(InFlight {
                request_digest: request_digest(request, asked_at),
                asked_at,
                cancel: kind == RequestKind::Cancel,
            });
            if let Err(error) = self
                .checkpoint(saved, &proposed, deadline, "before asking")
                .await
            {
                // The journal was not durably installed, so the chat may not
                // leave this socket. Keep the in-memory conversation journal-
                // free as well: ask's final save must not fabricate an
                // in-flight task that Rabbit was never sent.
                close(socket).await;
                return Asked {
                    answer: Err(error),
                    connected_as,
                    interrupted: None,
                };
            }
            *conversation = proposed;
        }
        let chat = json!({
            "type": "chat.message",
            "version": 1,
            "timestamp": asked_at,
            "text": request,
        });
        if socket.send(Message::Text(chat.to_string())).await.is_err() {
            close(socket).await;
            return Asked {
                answer: Err(Os3Error::Dropped),
                connected_as,
                interrupted: None,
            };
        }

        // Keep the event view separate from the stored conversation. Accepted
        // boundaries and correlated running worker IDs are checkpointed before
        // another socket event is read. Replies are marked reported only after
        // this call actually returns them to the wearer.
        let mut exchange = Exchange {
            asked_at,
            request: request.to_owned(),
            ..Exchange::for_request(conversation.unfinished.clone(), kind)
        };
        if kind == RequestKind::Cancel {
            exchange.cancel_targets = Some(
                exchange
                    .previous
                    .as_ref()
                    .map(|previous| previous.agents.keys().cloned().collect())
                    .unwrap_or_default(),
            );
        }
        for event in &replayed {
            exchange.observe(event);
        }
        self.drive_exchange(
            socket,
            exchange,
            deadline,
            conversation,
            saved,
            connected_as,
        )
        .await
    }

    /// Reconstruct the one ambiguously submitted question without sending any
    /// chat. `session.history` is the only verified source that can place its
    /// exact server echo. Independently delivered agent/activity events are
    /// retained only to a small bound until that boundary is known.
    async fn recover_exchange(
        &self,
        socket: &mut Socket,
        journal: &InFlight,
        previous: Option<Unfinished>,
        request_not_sent: bool,
        deadline: Instant,
    ) -> Result<Recovered, Os3Error> {
        let mut before_history = Vec::new();
        loop {
            let event = match tokio::time::timeout_at(deadline, next_event(socket)).await {
                Ok(Some(event)) => event,
                Ok(None) | Err(_) => return Err(Os3Error::Dropped),
            };
            if field(&event, "type") != "session.history" {
                if before_history.len() == MAX_RECOVERY_EVENTS {
                    return Err(Os3Error::Dropped);
                }
                before_history.push(event);
                continue;
            }
            let (boundary, boundary_at) = match recovered_boundary(&event, journal) {
                Recovery::Echoed(boundary, boundary_at) => (boundary, boundary_at),
                Recovery::NotReceived => {
                    return Ok(Recovered::NotReceived {
                        history: event,
                        before: before_history,
                    });
                }
                Recovery::Unknown => return Err(Os3Error::Dropped),
            };
            let mut exchange = Exchange {
                asked_at: journal.asked_at,
                boundary: Some(boundary),
                boundary_at,
                request_not_sent,
                // Old non-cancel journals do not store intent. Recover them
                // conservatively as bounded work, never resubmitting the text.
                ..Exchange::for_request(
                    previous,
                    if journal.cancel {
                        RequestKind::Cancel
                    } else {
                        RequestKind::Ask
                    },
                )
            };
            if journal.cancel {
                exchange.cancel_targets = Some(
                    exchange
                        .previous
                        .as_ref()
                        .map(|previous| previous.agents.keys().cloned().collect())
                        .unwrap_or_default(),
                );
            }
            exchange.observe(&event);
            for event in before_history {
                exchange.observe(&event);
            }
            return Ok(Recovered::Echoed(Box::new(exchange)));
        }
    }

    /// Drive a newly submitted or recovered exchange. Whenever the observed
    /// state changes, persist it before accepting another event. In particular,
    /// clearing the journal and installing its exact boundary are one sealed
    /// blob replacement.
    async fn drive_exchange(
        &self,
        mut socket: Socket,
        mut exchange: Exchange,
        deadline: Instant,
        conversation: &mut Conversation,
        saved: Option<&ConversationStore>,
        connected_as: Option<String>,
    ) -> Asked {
        if let Err(error) = self
            .checkpoint_exchange(saved, conversation, &exchange, deadline)
            .await
        {
            close(socket).await;
            return Asked {
                answer: Err(error),
                connected_as,
                interrupted: None,
            };
        }
        while !exchange.done() {
            // Once OS3 has stayed quiet this long after the work it may relay,
            // the answer in hand is returned. The question is not marked
            // finished, so a relay OS3 sends later still reaches the next
            // question as an earlier result.
            let mut wait_until = if exchange.awaiting_relay() {
                deadline.min(Instant::now() + RELAY_GRACE)
            } else {
                deadline
            };
            if let Some(correlation_until) = exchange.correlation_deadline() {
                wait_until = wait_until.min(correlation_until);
            }
            match tokio::time::timeout_at(wait_until, next_event(&mut socket)).await {
                Ok(Some(event)) => {
                    exchange.observe(&event);
                    if self
                        .checkpoint_exchange(saved, conversation, &exchange, deadline)
                        .await
                        .is_err()
                    {
                        // Cosmos's own storage failed, not the connection:
                        // say so rather than report a drop.
                        tracing::warn!("the OS3 conversation checkpoint could not be saved");
                        exchange.storage_failed = true;
                        break;
                    }
                }
                Ok(None) => {
                    exchange.closed = true;
                    break;
                }
                Err(_) => {
                    exchange.finish_agent_correlation_grace();
                    if exchange.done() || Instant::now() >= deadline || exchange.awaiting_relay() {
                        break;
                    }
                }
            }
        }
        close(socket).await;
        tracing::info!(
            accepted = exchange.boundary.is_some(),
            task_reaction = exchange.task_reaction,
            current_workers = exchange.agents.values().filter(|agent| agent.new).count(),
            finished = exchange.finished,
            input_required = exchange.needs_input.is_some(),
            errored = exchange.errored,
            closed = exchange.closed,
            "OS3 foreground exchange finished"
        );

        let answer = exchange.render();
        let interrupted = exchange.interrupted();
        let final_safe = exchange.boundary.is_some() && (exchange.finished || exchange.errored);
        conversation.unfinished = exchange.follow_up();
        if final_safe {
            conversation.in_flight = None;
        }
        Asked {
            answer,
            connected_as,
            interrupted,
        }
    }

    async fn checkpoint_exchange(
        &self,
        saved: Option<&ConversationStore>,
        conversation: &mut Conversation,
        exchange: &Exchange,
        deadline: Instant,
    ) -> Result<(), Os3Error> {
        let mut proposed = conversation.clone();
        proposed.unfinished = exchange.checkpoint();
        // `checkpoint` intentionally keeps the oldest unresolved boundary: it
        // covers every later message in history, including this question's
        // verified echo. Requiring equality with the current boundary leaves
        // the pre-send journal armed whenever older work is still pending, so
        // the next question enters ambiguity recovery and drops both results.
        let installed = exchange.boundary.as_deref().is_some_and(valid_id)
            && proposed
                .unfinished
                .as_ref()
                .and_then(|unfinished| unfinished.boundary.as_deref())
                .is_some_and(valid_id);
        if installed {
            proposed.in_flight = None;
        }
        if proposed == *conversation {
            return Ok(());
        }
        self.checkpoint(saved, &proposed, deadline, "during the question")
            .await?;
        *conversation = proposed;
        Ok(())
    }

    /// Save a cancellation boundary inline. There is deliberately no spawned
    /// work: Rabbit owns long-running Mac execution, while Cosmos only keeps
    /// the bounded identifiers needed to reconnect to it.
    async fn checkpoint(
        &self,
        saved: Option<&ConversationStore>,
        conversation: &Conversation,
        deadline: Instant,
        stage: &'static str,
    ) -> Result<(), Os3Error> {
        let Some(saved) = saved else {
            return Ok(());
        };
        if Instant::now() >= deadline {
            return Err(Os3Error::NoAnswer);
        }
        if matches!(
            tokio::time::timeout_at(
                checkpoint_by(Instant::now(), deadline),
                saved.save(conversation)
            )
            .await,
            Ok(true)
        ) {
            Ok(())
        } else {
            tracing::warn!(stage, "the OS3 conversation could not be checkpointed");
            Err(Os3Error::ConversationStorage)
        }
    }

    /// Sign in, route, open the socket, and complete `init` → `init_ack`.
    async fn connect(
        &self,
        cookie: &str,
        conversation: &mut Conversation,
        deadline: Instant,
    ) -> Result<Connected, Os3Error> {
        // Every wait here that runs out, the caller's or a step's own, is OS3
        // not responding in time, never OS3 being unreachable.
        if Instant::now() >= deadline {
            return Err(Os3Error::NoAnswer);
        }
        let mut cookie = HeaderValue::from_str(cookie).map_err(|_| Os3Error::NotConfigured)?;
        cookie.set_sensitive(true);
        let (token, instance) = tokio::time::timeout_at(deadline, self.sign_in(&cookie))
            .await
            .map_err(|_| Os3Error::NoAnswer)??;

        let config = WebSocketConfig {
            max_message_size: Some(MAX_MESSAGE_BYTES),
            max_frame_size: Some(MAX_MESSAGE_BYTES),
            ..WebSocketConfig::default()
        };
        let url = match instance.as_deref() {
            Some(instance) => self.endpoints.socket.replace("{instance}", instance),
            None => self.endpoints.socket_any.clone(),
        };
        let request = socket_request(&url, &self.endpoints.origin).ok_or(Os3Error::Unavailable)?;
        let (mut socket, _) = tokio::time::timeout_at(
            deadline,
            tokio_tungstenite::connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| Os3Error::NoAnswer)?
        .map_err(socket_refused)?;

        let mut init = json!({
            "type": "init",
            "version": 1,
            "timestamp": now_ms(),
            "accessToken": token,
        });
        if let Some(session_id) = conversation.session_id.as_deref() {
            init["sessionId"] = json!(session_id);
        }
        if socket.send(Message::Text(init.to_string())).await.is_err() {
            close(socket).await;
            return Err(Os3Error::SocketRefused);
        }

        let ack_deadline = deadline.min(Instant::now() + INIT_ACK_LIMIT);
        // The server refused this init. A retained session it no longer
        // honours must not wedge every later question.
        let refused = |conversation: &mut Conversation| -> Result<Connected, Os3Error> {
            conversation.session_id = None;
            Err(Os3Error::SocketRefused)
        };
        loop {
            match tokio::time::timeout_at(ack_deadline, next_event(&mut socket)).await {
                Ok(Some(event)) if field(&event, "type") == "init_ack" => {
                    let session_id = field(&event, "sessionId");
                    if !valid_id(session_id) {
                        close(socket).await;
                        return refused(conversation);
                    }
                    conversation.session_id = Some(session_id.to_owned());
                    // The account email beside it is never read.
                    let butler_name = display_name(field(&event, "butlerName"));
                    return Ok(Connected {
                        socket,
                        butler_name,
                    });
                }
                // An error in place of `init_ack`: waiting on cannot help.
                Ok(Some(event)) if field(&event, "type") == "error" => {
                    close(socket).await;
                    return refused(conversation);
                }
                // Nothing else before `init_ack` is part of the verified
                // contract.
                Ok(Some(_)) => {}
                Ok(None) => return refused(conversation),
                Err(_) => {
                    close(socket).await;
                    // Silent for its whole acknowledgement wait, not just out
                    // of the caller's time: a retained session OS3 ignores
                    // must not stall every later question the same way.
                    if ack_deadline < deadline {
                        conversation.session_id = None;
                    }
                    return Err(Os3Error::NoAnswer);
                }
            }
        }
    }

    async fn sign_in(&self, cookie: &HeaderValue) -> Result<(String, Option<String>), Os3Error> {
        let http = http();
        let response = http
            .get(format!("{}/api/auth/token", self.endpoints.origin))
            .header(COOKIE, cookie.clone())
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(transport)?;
        let body = authentication_body(response).await?;
        let token = serde_json::from_slice::<TokenResponse>(&body)
            .map_err(|_| Os3Error::Unavailable)?
            .access_token
            .filter(|token| !token.is_empty())
            .ok_or(Os3Error::SignInExpired)?;
        if token.len() > MAX_TOKEN_BYTES || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(Os3Error::Unavailable);
        }

        let response = http
            .post(format!("{}/session-directory/route", self.endpoints.origin))
            .bearer_auth(&token)
            .header(COOKIE, cookie.clone())
            .header(ACCEPT, "application/json")
            .body(Vec::new())
            .send()
            .await
            .map_err(transport)?;
        // A refused sign-in is a step failure, as above. A successful answer
        // that names no instance is not: the official client reads the route
        // lookup as best effort and opens the default host instead (verified
        // 2026-09-24), and so does this client, that fallback is what keeps a
        // delegation working when the directory has no instance for the
        // account today.
        let body = authentication_body(response).await?;
        Ok((token, routed_instance(&String::from_utf8_lossy(&body))))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
}

/// The instance the directory named for this account, or `None` when the
/// answer names none and the default host serves the conversation. Every
/// non-`route` outcome mirrors the official web client's `kind: "any"`
/// fallback (verified 2026-09-24): `route` without a usable `instanceId`,
/// another `kind`, and an unreadable body all route to the default host, so
/// the wearer's task is asked rather than dead-ended on a missing instance.
/// An instance ID is validated before it may name a host.
fn routed_instance(body: &str) -> Option<String> {
    let route: Value = serde_json::from_str(body).ok()?;
    if route.get("kind").and_then(Value::as_str) != Some("route") {
        return None;
    }
    let id = field(&route, "instanceId");
    valid_instance(id).then(|| id.to_owned())
}

/// A response OS3 gave to a signed-in request, or the step that refused it.
///
/// Rabbit's edge answers non-browser clients with an HTML 403 before any
/// sign-in check (verified 2026-09-23), so only the API's own answers say the
/// sign-in expired: 401, a JSON 403, a redirect to the sign-in page, or that
/// page served as a 200.
fn signed_in(response: reqwest::Response) -> Result<reqwest::Response, Os3Error> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if status.is_success() {
        return if content_type.starts_with("text/html") {
            Err(Os3Error::SignInExpired)
        } else {
            Ok(response)
        };
    }
    Err(
        if status == StatusCode::UNAUTHORIZED || status.is_redirection() {
            Os3Error::SignInExpired
        } else if status == StatusCode::FORBIDDEN {
            if content_type.contains("json") {
                Os3Error::SignInExpired
            } else {
                Os3Error::Blocked
            }
        } else {
            Os3Error::Unavailable
        },
    )
}

/// Read only a bounded successful authentication response, including chunked
/// bodies whose length is unavailable. Sign-in/edge refusal classifications
/// remain independent of the response body and the directory's default route.
async fn authentication_body(response: reqwest::Response) -> Result<Vec<u8>, Os3Error> {
    let mut response = signed_in(response)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_BODY_BYTES as u64)
    {
        return Err(Os3Error::Unavailable);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        if chunk.len() > MAX_HTTP_BODY_BYTES - body.len() {
            return Err(Os3Error::Unavailable);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// An HTTP call that did not complete.
fn transport(error: reqwest::Error) -> Os3Error {
    if error.is_timeout() {
        Os3Error::NoAnswer
    } else {
        Os3Error::Unavailable
    }
}

/// A socket that did not open. The socket carries no sign-in, so a 403 on the
/// upgrade is Rabbit's edge, and a 404 is an instance that is not there.
fn socket_refused(error: tokio_tungstenite::tungstenite::Error) -> Os3Error {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Http(response) if response.status().as_u16() == 403 => Os3Error::Blocked,
        Error::Http(response) if response.status().as_u16() == 404 => Os3Error::NoInstance,
        _ => Os3Error::SocketRefused,
    }
}

fn valid_instance(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_id(id: &str) -> bool {
    (1..=MAX_ID_BYTES).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_graphic())
}

/// OS3's display name for the agent, as plain bounded text.
fn display_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    tidy(&name, MAX_OS3_BUTLER_NAME_CHARS)
}

/// The next JSON text message, or `None` once the socket is closed or broken.
/// Binary and control frames are not part of the protocol and are skipped, as
/// is a message over [`MAX_EVENT_BYTES`] other than a history snapshot or a
/// chat message ([`oversized_event`]).
async fn next_event(socket: &mut Socket) -> Option<Value> {
    loop {
        match socket.next().await? {
            Ok(Message::Text(text)) if text.len() <= MAX_EVENT_BYTES => {
                return Some(serde_json::from_str(&text).unwrap_or(Value::Null));
            }
            Ok(Message::Text(text)) => {
                if let Some(event) = oversized_event(&text) {
                    return Some(event);
                }
                tracing::warn!(bytes = text.len(), "an oversized OS3 message was skipped");
            }
            Ok(Message::Close(_)) => return None,
            Err(error) => {
                if matches!(error, tokio_tungstenite::tungstenite::Error::Capacity(_)) {
                    tracing::warn!(
                        limit_bytes = MAX_MESSAGE_BYTES,
                        "OS3 sent a message over the size limit; the connection closed"
                    );
                }
                return None;
            }
            Ok(_) => {}
        }
    }
}

/// An oversized message as the event it stands for, or `None` when it is
/// neither of the two kinds read: a history snapshot as a snapshot of its
/// latest [`MAX_SNAPSHOT_MESSAGES`] messages, and a chat message as its ID and
/// role, marked [`OVERSIZED`], so a reply still counts and is reported instead
/// of waited for. Only those parts are ever held parsed. The log lines carry
/// sizes only.
fn oversized_event(text: &str) -> Option<Value> {
    #[derive(Deserialize)]
    struct Oversized {
        #[serde(rename = "type", default)]
        kind: String,
        #[serde(default)]
        messages: Latest,
        #[serde(rename = "messageId", default)]
        message_id: String,
        #[serde(default)]
        role: String,
    }

    #[derive(Default)]
    struct Latest {
        total: usize,
        kept: std::collections::VecDeque<Value>,
    }

    impl<'de> Deserialize<'de> for Latest {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Latest;
                fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                    formatter.write_str("a list of messages")
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut messages: A,
                ) -> Result<Latest, A::Error> {
                    let mut latest = Latest::default();
                    while let Some(message) = messages.next_element::<Value>()? {
                        latest.total += 1;
                        if latest.kept.len() == MAX_SNAPSHOT_MESSAGES {
                            latest.kept.pop_front();
                        }
                        latest.kept.push_back(message);
                    }
                    Ok(latest)
                }
            }
            deserializer.deserialize_seq(Visitor)
        }
    }

    let event: Oversized = serde_json::from_str(text).ok()?;
    match event.kind.as_str() {
        "session.history" => {
            tracing::info!(
                bytes = text.len(),
                messages = event.messages.total,
                kept = event.messages.kept.len(),
                "an oversized OS3 history snapshot was read for its latest messages"
            );
            Some(json!({
                "type": "session.history",
                "messages": Vec::from(event.messages.kept),
                HISTORY_TRUNCATED: event.messages.total > MAX_SNAPSHOT_MESSAGES,
            }))
        }
        // Without its ID it could not be placed relative to the question.
        "chat.message" if valid_id(&event.message_id) && event.role.len() <= MAX_ID_BYTES => {
            tracing::warn!(
                bytes = text.len(),
                "an oversized OS3 chat message was read without its content"
            );
            Some(json!({
                "type": "chat.message",
                "messageId": event.message_id,
                "role": event.role,
                OVERSIZED: true,
            }))
        }
        _ => None,
    }
}

async fn close(mut socket: Socket) {
    let _ = tokio::time::timeout(CLOSE_LIMIT, socket.close(None)).await;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// What recovery read from the socket for a pre-send journal.
enum Recovered {
    /// The question's one server echo, placed as the exchange's boundary.
    Echoed(Box<Exchange>),
    /// A complete history of the retained session without the echo: OS3
    /// never received the question. The events read so far, for the next
    /// exchange on this socket.
    NotReceived { history: Value, before: Vec<Value> },
}

/// What one history snapshot proves about a pre-send journal.
#[derive(Debug, Eq, PartialEq)]
enum Recovery {
    /// Exactly one server echo: its ID and OS3's time for it.
    Echoed(String, i64),
    /// A complete snapshot holds no echo of the question.
    NotReceived,
    /// A truncated snapshot, two candidate echoes, or one without a time:
    /// what OS3 received cannot be told.
    Unknown,
}

/// Find one and only one server echo for a pre-send journal. The verified
/// protocol timestamps an echo when Rabbit accepts it, so it cannot honestly
/// precede the client's `asked_at` by more than the two clocks differ
/// ([`RECOVERY_SKEW_MS`]). A user form answer is excluded even when its
/// visible text happens to be identical.
fn recovered_boundary(history: &Value, journal: &InFlight) -> Recovery {
    if !journal.valid()
        || history
            .get(HISTORY_TRUNCATED)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Recovery::Unknown;
    }
    let Some(messages) = history.get("messages").and_then(Value::as_array) else {
        return Recovery::Unknown;
    };
    let earliest = journal.asked_at.saturating_sub(RECOVERY_SKEW_MS);
    let mut matched = None;
    for message in messages {
        if field(message, "type") != "chat.message"
            || field(message, "role") != "user"
            || message.get("answeredCard").is_some()
            || request_digest(field(message, "text"), journal.asked_at) != journal.request_digest
        {
            continue;
        }
        let id = field(message, "messageId");
        let Some(timestamp) = message.get("timestamp").and_then(Value::as_i64) else {
            // The same text with no time could be the echo.
            return Recovery::Unknown;
        };
        // The same words asked earlier are another question.
        if timestamp < earliest {
            continue;
        }
        if !valid_id(id) || matched.is_some() {
            return Recovery::Unknown;
        }
        matched = Some((id.to_owned(), timestamp));
    }
    match matched {
        Some((id, timestamp)) => Recovery::Echoed(id, timestamp),
        None => Recovery::NotReceived,
    }
}

/// `notice` said before an answer, as its own line.
fn with_notice(notice: &str, answer: &str) -> String {
    tidy_lines(&format!("{notice}\n{answer}"), MAX_CHARS)
}

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Collapse whitespace and bound the length on a character boundary.
fn tidy(text: &str, limit: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= limit {
        return text;
    }
    let mut shortened = text.chars().take(limit).collect::<String>();
    shortened.push('…');
    shortened
}

#[derive(Clone, Copy)]
enum CompletionLine {
    Current(usize),
    Earlier(usize),
}

struct Agent {
    title: String,
    running: bool,
    /// First seen after this question's echo, so started for it.
    new: bool,
    /// Its end was already reported.
    ended: bool,
    /// A failed/canceled snapshot must not later be rewritten as a successful
    /// completion merely because an out-of-order completion event arrives.
    failed: bool,
    canceled: bool,
    /// Exact rendered slot for this agent's terminal result. Titles are not
    /// unique, so a later richer completion must reconcile by agent ID/index.
    completion_line: Option<CompletionLine>,
}

impl Agent {
    fn seen(new: bool) -> Self {
        Self {
            title: String::new(),
            running: false,
            new,
            ended: false,
            failed: false,
            canceled: false,
            completion_line: None,
        }
    }
}

/// Only the list fields needed to reconcile an independently delivered worker.
/// Owner OS3 API reference §5: createdAt and retained IDs establish its scope.
struct AgentSnapshot {
    title: String,
    state: AgentState,
    created_at: Option<i64>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AgentState {
    Running,
    Completed,
    Failed,
    Canceled,
    Unknown,
}

impl AgentState {
    fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Canceled)
    }
}

/// Bounded signals for an agent whose identity has not yet been placed by an
/// `agent.list` snapshot. Arrival order is not correlation: these become
/// actionable only if the list's `createdAt` proves the agent belongs to this
/// question.
#[derive(Default)]
struct PendingAgent {
    snapshot: Option<AgentSnapshot>,
    needs_input: Option<String>,
    completed: Option<String>,
}

/// One question's view of the event stream.
///
/// The conversation has no request IDs: the question's echo is the boundary,
/// and agent replies after it are the answer. Events are reconciled by
/// `messageId` and `agentId`, never by arrival order, and history snapshots
/// can repeat what already arrived live.
#[derive(Default)]
struct Exchange {
    /// Unix milliseconds at which this client sent the question.
    asked_at: i64,
    /// The exact normalized text sent in this exchange. OS3 provides no
    /// client-generated request ID, so only its echo of this text can become
    /// the durable boundary. An identical concurrent owner submission remains
    /// inherently ambiguous in the recovered protocol.
    request: String,
    boundary: Option<String>,
    boundary_at: i64,
    previous: Option<Unfinished>,
    /// The latest snapshot seen before the echo, read once the echo arrives.
    pending_history: Option<Vec<Value>>,
    /// Messages already placed: this question's replies, and live messages.
    known: HashSet<String>,
    /// This question's replies by message ID, with their spoken text.
    replies: Vec<(String, String)>,
    /// What OS3 said and did for this question, in order: its readable
    /// replies, and its work that finished or failed.
    lines: Vec<String>,
    /// Lines about what an earlier question left unfinished.
    earlier: Vec<String>,
    /// Earlier reply IDs observed during this call. They become durably
    /// `reported` only when this call returns them to the wearer. A cancelled
    /// Pin turn must not suppress them on the next reconnect.
    earlier_ids: HashSet<String>,
    agents: HashMap<String, Agent>,
    /// Agent signals received before an ID is correlated by a timestamped
    /// list record. Bounded like the unfinished workers carried across turns.
    pending_agents: HashMap<String, PendingAgent>,
    needs_input: Option<String>,
    /// OS3 went idle after the question, and after this question's work last
    /// ended: OS3 usually relays what that work found in a message of its
    /// own, so an ending waits for the next idle.
    idle: bool,
    /// OS3 said it was processing and has not gone idle since.
    processing: bool,
    /// A reaction tied to this question said Rabbit treated it as a task.
    /// This does not itself create or identify a worker.
    task_reaction: bool,
    /// Reactions can precede their exact user echo. Keep bounded IDs only,
    /// then discard every ID except the verified current message boundary.
    pending_task_reactions: HashSet<String>,
    /// Once an unscoped idle follows an answer with no correlated worker, wait
    /// briefly for the independently delivered agent snapshot before ending.
    correlation_until: Option<Instant>,
    /// This question's work ended while OS3 was not processing, and OS3 has
    /// not resumed since: its relay may follow, or may already have come.
    relay_pending: bool,
    /// OS3 reported an error during the question.
    errored: bool,
    finished: bool,
    closed: bool,
    /// Cosmos could not save a checkpoint, so the exchange stopped.
    storage_failed: bool,
    /// A recovered exchange answering a new request that was not sent: its
    /// replies are the earlier question's, and the answer says so.
    request_not_sent: bool,
    /// Only previously correlated workers can confirm a requested stop. A
    /// reply saying "stopped" or an unrelated canceled worker cannot do so.
    cancel_targets: Option<HashSet<String>>,
    /// INFERRED: ordinary delegated work stays in its bounded foreground turn
    /// until correlated terminal evidence. ACK and unscoped idle cannot prove
    /// completion when Rabbit omits optional task metadata.
    bounded_completion: bool,
    /// Status checks only the retained original worker IDs. New interleaved
    /// workers cannot finish that task or hold up its confirmed completion.
    status_targets: Option<HashSet<String>>,
    /// Read-only free text is scoped by restored history's last ordinary user
    /// boundary, not by arriving on this socket after a stored task ID.
    status_text_open: bool,
}

impl Exchange {
    fn new(previous: Option<Unfinished>) -> Self {
        Self {
            previous,
            ..Self::default()
        }
    }

    fn for_request(previous: Option<Unfinished>, kind: RequestKind) -> Self {
        let status_targets = if kind == RequestKind::Status {
            previous
                .as_ref()
                .map(|work| work.agents.keys().cloned().collect())
        } else {
            None
        };
        Self {
            bounded_completion: kind == RequestKind::Ask || status_targets.is_some(),
            status_targets,
            ..Self::new(previous)
        }
    }

    fn completion_confirmed(&self) -> bool {
        if !self.bounded_completion {
            return true;
        }
        if let Some(targets) = &self.status_targets {
            return !targets.is_empty()
                && targets
                    .iter()
                    .all(|id| self.agents.get(id).is_some_and(|agent| agent.ended));
        }
        let mut current = self.agents.values().filter(|agent| agent.new).peekable();
        current.peek().is_some() && current.all(|agent| agent.ended)
    }

    fn done(&self) -> bool {
        self.finished || self.needs_input.is_some() || self.errored
    }

    fn observe(&mut self, event: &Value) {
        match field(event, "type") {
            "chat.message" => self.live_message(event),
            "session.history" => {
                if let Some(messages) = event.get("messages").and_then(Value::as_array) {
                    self.history(messages);
                }
            }
            "conversation.processing" => {
                self.idle = false;
                self.processing = true;
                self.relay_pending = false;
                self.correlation_until = None;
            }
            "conversation.idle" => {
                self.processing = false;
                self.relay_pending = false;
                // An idle state from before the question was echoed says
                // nothing about this question.
                if self.boundary.is_some() {
                    self.idle = true;
                }
                self.begin_agent_correlation_grace();
                self.settle();
            }
            "chat.reaction" if field(event, "reaction") == "task" => {
                self.observe_task_reaction(field(event, "messageId"));
            }
            "agent.list" => {
                for record in event
                    .get("agents")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    self.agent(record);
                }
                self.settle();
            }
            "agent.completed" => {
                self.agent_completed(event);
                self.settle();
            }
            "activity.summary" => self.activity_summary(event),
            "activity.step" => self.step(event),
            // Waiting on cannot help. What OS3 said so far still counts.
            "error" => {
                let code = field(event, "code");
                let plain = (1..=64).contains(&code.len())
                    && code
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
                tracing::warn!(
                    code = if plain { code } else { "" },
                    "OS3 reported an error during the question"
                );
                self.errored = true;
            }
            _ => {}
        }
    }

    /// Owner OS3 API reference §2: reactions are independently delivered and
    /// matched by messageId. Inline chat.message reaction is the same evidence.
    /// Task acceptance never establishes worker creation or completion.
    fn observe_task_reaction(&mut self, id: &str) {
        if !valid_id(id) {
            return;
        }
        if self.boundary.as_deref() == Some(id) {
            self.task_reaction = true;
            self.correlation_until = None;
        } else if self.boundary.is_none() && self.pending_task_reactions.len() < MAX_RECOVERY_EVENTS
        {
            self.pending_task_reactions.insert(id.to_owned());
        }
    }

    fn live_message(&mut self, message: &Value) {
        let id = field(message, "messageId");
        // Metadata can be added to a repeated message after its text was seen.
        if field(message, "role") == "user" && field(message, "reaction") == "task" {
            self.observe_task_reaction(id);
        }
        if id.is_empty() || !self.known.insert(id.to_owned()) {
            return;
        }
        if self.status_targets.is_some() {
            match field(message, "role") {
                "user" if message.get("answeredCard").is_none() => {
                    if self.boundary.as_deref() != Some(id) {
                        self.status_text_open = false;
                    }
                }
                "agent" if self.status_text_open => self.earlier_reply(message, false),
                _ => {}
            }
            return;
        }
        match field(message, "role") {
            // OS3 has no client-generated request ID. A concurrent form answer
            // from the owner is also a user message, so only the exact server
            // echo of the normalized text Luma sent can establish the boundary.
            "user"
                if self.boundary.is_none()
                    && message.get("answeredCard").is_none()
                    && field(message, "text") == self.request.as_str() =>
            {
                self.boundary = Some(id.to_owned());
                if self.pending_task_reactions.remove(id) {
                    self.observe_task_reaction(id);
                }
                self.pending_task_reactions.clear();
                // Without OS3's time for the echo, the time the question was
                // sent still tells older work from work started for it: OS3
                // starts that only after the question reached it, possibly
                // before its echo reaches this client.
                self.boundary_at = message
                    .get("timestamp")
                    .and_then(Value::as_f64)
                    .map_or(self.asked_at, |timestamp| timestamp as i64);
                // Reconcile only bounded typed list evidence once the exact
                // echo can place createdAt. Existing agent mapping applies
                // terminal monotonicity and buffered completion/input by ID.
                let snapshots: Vec<_> = self
                    .pending_agents
                    .iter_mut()
                    .filter_map(|(id, pending)| {
                        if pending
                            .snapshot
                            .as_ref()
                            .is_some_and(|snapshot| snapshot.created_at.is_some())
                        {
                            pending
                                .snapshot
                                .take()
                                .map(|snapshot| (id.clone(), snapshot))
                        } else {
                            None
                        }
                    })
                    .collect();
                for (id, snapshot) in snapshots {
                    self.apply_agent_snapshot(&id, snapshot);
                }
                if let Some(messages) = self.pending_history.take() {
                    self.history(&messages);
                }
            }
            "agent" if self.boundary.is_some() => self.reply(message, false),
            "agent" => self.earlier_reply(message, false),
            _ => {}
        }
    }

    fn history(&mut self, messages: &[Value]) {
        // Before the echo nothing can be placed relative to this question, and
        // a snapshot may already list the echo and its reply. Keep the latest
        // one and read it once the live echo sets the boundary.
        if self.boundary.is_none() {
            self.pending_history = Some(messages.to_vec());
            return;
        }
        let previous_boundary = self
            .previous
            .as_ref()
            .and_then(|previous| previous.boundary.clone());
        // A restored snapshot keeps an owner's submitted form answer as a user
        // message whose `answeredCard.messageId` points back to the card. Read
        // the whole snapshot before rendering it so an already answered card is
        // not presented as still waiting merely because its answer follows it.
        let answered_cards: HashSet<String> = messages
            .iter()
            .filter_map(|message| message.get("answeredCard"))
            .map(|answer| field(answer, "messageId"))
            .filter(|id| valid_id(id))
            .map(str::to_owned)
            .collect();
        if self.status_targets.is_some() {
            self.status_text_open = false;
            for message in messages {
                let id = field(message, "messageId");
                if self.boundary.as_deref() == Some(id) {
                    self.status_text_open = true;
                    self.known.insert(id.to_owned());
                } else if field(message, "role") == "user" && message.get("answeredCard").is_none()
                {
                    self.status_text_open = false;
                } else if self.status_text_open && field(message, "role") == "agent" {
                    self.earlier_reply(message, answered_cards.contains(id));
                }
            }
            return;
        }
        let mut after_boundary = false;
        let mut after_previous = false;
        for message in messages {
            let id = field(message, "messageId");
            if id.is_empty() {
                continue;
            }
            if field(message, "role") == "user" && field(message, "reaction") == "task" {
                self.observe_task_reaction(id);
            }
            if self.boundary.as_deref() == Some(id) {
                after_boundary = true;
                continue;
            }
            if previous_boundary.as_deref() == Some(id) {
                after_previous = true;
                continue;
            }
            if field(message, "role") != "agent" {
                continue;
            }
            if after_boundary {
                // Known only once counted, so its live copy is skipped.
                if self.known.insert(id.to_owned()) {
                    self.reply(message, answered_cards.contains(id));
                }
            } else if after_previous {
                // Deduplicated through the previous question's reported set.
                self.earlier_reply(message, answered_cards.contains(id));
            }
        }
    }

    fn reply(&mut self, message: &Value, card_answered: bool) {
        if !card_answered && card_needs_input(message) {
            self.needs_input.get_or_insert_with(String::new);
        }
        if self.replies.len() < MAX_ITEMS {
            let (text, line) = if message.get(OVERSIZED).is_some() {
                (TOO_LARGE_REPLY.to_owned(), TOO_LARGE_REPLY.to_owned())
            } else {
                let text = spoken_text(message);
                let line = if self.request_not_sent {
                    format!("Earlier OS3 result: {text}")
                } else {
                    format!("OS3 replied: {text}")
                };
                (text, line)
            };
            if !text.is_empty() {
                self.lines.push(line);
            }
            self.replies
                .push((field(message, "messageId").to_owned(), text));
        }
    }

    fn earlier_reply(&mut self, message: &Value, card_answered: bool) {
        let Some(previous) = self.previous.as_mut() else {
            return;
        };
        // An unresolved card remains actionable every time Rabbit restores it.
        // `reported` suppresses repeated result narration, not the owner's
        // outstanding input boundary. Once history carries an `answeredCard`
        // for this message, the same replay no longer asks for input.
        if !card_answered && card_needs_input(message) {
            self.needs_input.get_or_insert_with(String::new);
        }
        let id = field(message, "messageId");
        if previous.reported.contains(id) || !self.earlier_ids.insert(id.to_owned()) {
            return;
        }
        let line = if message.get(OVERSIZED).is_some() {
            TOO_LARGE_EARLIER.to_owned()
        } else {
            let text = spoken_text(message);
            if text.is_empty() {
                return;
            }
            format!("Earlier OS3 result: {text}")
        };
        if self.earlier.len() < MAX_ITEMS {
            self.earlier.push(line);
        }
    }

    fn agent(&mut self, record: &Value) {
        let id = field(record, "agentId");
        if !valid_id(id) {
            return;
        }
        let mut snapshot = AgentSnapshot {
            title: tidy(field(record, "title"), MAX_TITLE_CHARS),
            state: match field(record, "state") {
                "running" => AgentState::Running,
                "completed" => AgentState::Completed,
                "failed" => AgentState::Failed,
                "canceled" => AgentState::Canceled,
                _ => AgentState::Unknown,
            },
            created_at: record
                .get("createdAt")
                .and_then(Value::as_f64)
                .map(|at| at as i64),
        };
        let previous = self
            .previous
            .as_ref()
            .is_some_and(|unfinished| unfinished.agents.contains_key(id));
        if let Some(old) = self
            .pending_agents
            .get_mut(id)
            .and_then(|pending| pending.snapshot.take())
        {
            // Defensive partial-record recovery (INFERRED): enrich metadata
            // without erasing known creation time or regressing terminal state.
            snapshot.created_at = old.created_at.or(snapshot.created_at);
            if snapshot.title.is_empty() {
                snapshot.title = old.title;
            }
            if old.state.terminal() || snapshot.state == AgentState::Unknown {
                snapshot.state = old.state;
            }
        }
        let current = self.agents.get(id).is_some_and(|agent| agent.new);
        if !previous && (self.boundary.is_none() || (snapshot.created_at.is_none() && !current)) {
            // Do not consume provisional completion/input or mutate ended
            // until exact echo plus timing (or retained identity) scopes it.
            if let Some(pending) = self.pending_agent(id) {
                pending.snapshot = Some(snapshot);
            }
            return;
        }
        self.apply_agent_snapshot(id, snapshot);
    }

    fn apply_agent_snapshot(&mut self, id: &str, snapshot: AgentSnapshot) {
        let asked = self.boundary.is_some();
        let created_at = snapshot.created_at;
        let previous = self
            .previous
            .as_ref()
            .is_some_and(|unfinished| unfinished.agents.contains_key(id));
        // Arrival after the echo is not correlation. A new worker remains old
        // or unknown until its creation time places it at this boundary.
        let agent = self
            .agents
            .entry(id.to_owned())
            .or_insert(Agent::seen(false));
        // The creation time settles it whenever a record carries one, also for
        // a worker first seen through a step before any list named it.
        if let Some(created_at) = created_at {
            agent.new = self.status_targets.is_none()
                && !previous
                && asked
                && created_at >= self.boundary_at;
        }
        if agent.new {
            // The timer exists only to wait for this independently delivered
            // correlation evidence. Keeping it armed would make a subsequent
            // completion and idle wait for a deadline that no longer applies.
            self.correlation_until = None;
        }
        let state = snapshot.state;
        let was_running = agent.running;
        // Terminal state is monotonic. A delayed running snapshot cannot
        // resurrect a worker after its completion event was already observed.
        if !agent.ended && state != AgentState::Unknown {
            agent.running = state == AgentState::Running;
        }
        let title = snapshot.title;
        if !title.is_empty() {
            agent.title = title;
        }
        let new = agent.new;
        let terminal = state.terminal();

        // A timestamped record is the evidence that settles any earlier,
        // out-of-order event for this ID. Old work's buffered signals are
        // discarded. Current work's completion or input request is applied.
        let pending = if created_at.is_some() {
            self.pending_agents.remove(id)
        } else {
            None
        };
        if new
            && !matches!(state, AgentState::Failed | AgentState::Canceled)
            && let Some(result) = pending
                .as_ref()
                .and_then(|pending| pending.completed.clone())
        {
            self.finish_current_agent(id, &result);
        }
        if new
            && !terminal
            && !self.agents.get(id).is_some_and(|agent| agent.ended)
            && let Some(question) = pending.and_then(|pending| pending.needs_input)
        {
            self.needs_input = Some(question);
        }
        if !terminal || self.agents.get(id).is_some_and(|agent| agent.ended) {
            return;
        }
        let failed = state != AgentState::Completed;
        let agent = self.agents.get_mut(id).expect("agent record was inserted");
        agent.running = false;
        agent.ended = true;
        agent.failed = failed;
        agent.canceled = state == AgentState::Canceled;
        let (title, new) = (agent.title.clone(), agent.new);
        // A worker the previous question left running may have ended while no
        // socket was open. The list is then the only word of it.
        let mut resolved_title = None;
        let completion_line = if let Some(earlier) = self
            .previous
            .as_mut()
            .and_then(|previous| previous.agents.remove(id))
        {
            let title = if title.is_empty() { earlier } else { title };
            resolved_title = Some(title.clone());
            if self.earlier.len() < MAX_ITEMS {
                self.earlier.push(if failed {
                    format!("OS3 could not finish {}.", earlier_task(&title))
                } else {
                    finished_earlier(&title, "")
                });
                Some(CompletionLine::Earlier(self.earlier.len() - 1))
            } else {
                None
            }
        } else if new && (was_running || created_at.is_some()) {
            // This question's work ended while the socket was open. A record
            // with neither a creation time nor a running state seen here could
            // be any old worker, so it is not reported as this question's.
            self.work_ended(if failed {
                format!("OS3 could not finish {}.", task(&title))
            } else {
                format!("OS3 finished {}", completion(&title, ""))
            })
            .map(CompletionLine::Current)
        } else {
            None
        };
        if let Some(agent) = self.agents.get_mut(id) {
            if let Some(title) = resolved_title {
                agent.title = title;
            }
            agent.completion_line = completion_line;
        }
    }

    fn agent_completed(&mut self, event: &Value) {
        let id = field(event, "agentId");
        if !valid_id(id) {
            return;
        }
        let result = event
            .get("ext")
            .map(|ext| tidy(field(ext, "result"), MAX_REPLY_CHARS))
            .unwrap_or_default();

        if let Some(earlier) = self
            .previous
            .as_mut()
            .and_then(|previous| previous.agents.remove(id))
        {
            let title = self
                .agents
                .get(id)
                .map(|agent| agent.title.clone())
                .filter(|title| !title.is_empty())
                .unwrap_or(earlier);
            let completion_line = if self.earlier.len() < MAX_ITEMS {
                self.earlier.push(finished_earlier(&title, &result));
                Some(CompletionLine::Earlier(self.earlier.len() - 1))
            } else {
                None
            };
            let agent = self
                .agents
                .entry(id.to_owned())
                .or_insert(Agent::seen(false));
            agent.title = title;
            agent.running = false;
            agent.ended = true;
            agent.completion_line = completion_line;
            return;
        }

        match self.agents.get(id) {
            Some(agent) if agent.new || agent.ended => self.finish_current_agent(id, &result),
            Some(_) => {}
            None => self.remember_completion(id, result),
        }
    }

    fn finish_current_agent(&mut self, id: &str, result: &str) {
        let Some(agent) = self.agents.get(id) else {
            return;
        };
        if agent.ended {
            self.enrich_completed_agent(id, result);
            return;
        }
        if !agent.new {
            return;
        }
        let title = agent.title.clone();
        let agent = self.agents.get_mut(id).expect("agent still exists");
        agent.running = false;
        agent.ended = true;
        let completion_line = self
            .work_ended(format!("OS3 finished {}", completion(&title, result)))
            .map(CompletionLine::Current);
        if let Some(agent) = self.agents.get_mut(id) {
            agent.completion_line = completion_line;
        }
    }

    /// A terminal list snapshot can precede the richer completion event. The
    /// snapshot's generic success line is replaced in place so the result is
    /// neither lost nor duplicated. Failed/canceled work stays failed.
    fn enrich_completed_agent(&mut self, id: &str, result: &str) {
        if result.is_empty() {
            return;
        }
        let Some(agent) = self.agents.get(id) else {
            return;
        };
        if !agent.ended || agent.failed {
            return;
        }
        let title = agent.title.clone();
        match agent.completion_line {
            Some(CompletionLine::Current(index)) => {
                if let Some(line) = self.lines.get_mut(index) {
                    *line = format!("OS3 finished {}", completion(&title, result));
                }
            }
            Some(CompletionLine::Earlier(index)) => {
                if let Some(line) = self.earlier.get_mut(index) {
                    *line = finished_earlier(&title, result);
                }
            }
            None => {}
        }
    }

    fn remember_completion(&mut self, id: &str, result: String) {
        if let Some(pending) = self.pending_agent(id) {
            pending.completed = Some(result);
        }
    }

    fn remember_input(&mut self, id: &str, question: String) {
        let previous = self
            .previous
            .as_ref()
            .is_some_and(|unfinished| unfinished.agents.contains_key(id));
        if previous {
            self.needs_input = Some(question);
            return;
        }
        match self.agents.get(id) {
            Some(agent) if agent.new && !agent.ended => self.needs_input = Some(question),
            Some(_) => {}
            None => {
                if let Some(pending) = self.pending_agent(id) {
                    pending.needs_input = Some(question);
                }
            }
        }
    }

    fn pending_agent(&mut self, id: &str) -> Option<&mut PendingAgent> {
        if !valid_id(id) {
            return None;
        }
        if !self.pending_agents.contains_key(id) && self.pending_agents.len() >= MAX_CARRIED_AGENTS
        {
            return None;
        }
        Some(self.pending_agents.entry(id.to_owned()).or_default())
    }

    /// This question's work finished or failed: report it, and wait for the
    /// idle after OS3's own message about it. When OS3 was not processing, it
    /// may have sent that message before the work's end arrived, so the wait
    /// is [`RELAY_GRACE`] of quiet at most ([`Self::awaiting_relay`]).
    fn work_ended(&mut self, line: String) -> Option<usize> {
        let mut index = None;
        if self.lines.len() < 2 * MAX_ITEMS {
            self.lines.push(line);
            index = Some(self.lines.len() - 1);
        }
        self.idle = false;
        self.relay_pending = !self.processing;
        index
    }

    /// Owner-supplied OS3 WebSocket reference §2/5: activity summaries and
    /// agent lists arrive independently. Reuse the bounded live-step buffer;
    /// only a previously retained ID or timestamp-correlated current worker
    /// can ask for input. A final ask_user alone is still awaiting an answer.
    fn activity_summary(&mut self, event: &Value) {
        let id = field(event, "agentId");
        let Some(step) = event
            .get("steps")
            .and_then(Value::as_array)
            .and_then(|steps| steps.last())
        else {
            return;
        };
        if field(step, "kind") == "ask_user" {
            self.remember_input(id, tidy(field(step, "text"), MAX_REPLY_CHARS));
        } else if let Some(pending) = self.pending_agents.get_mut(id) {
            // A later summary supersedes an earlier provisional input request.
            // Keep any independently buffered completion for this same ID.
            pending.needs_input = None;
        }
    }

    fn step(&mut self, event: &Value) {
        let step = event.get("step").unwrap_or(&Value::Null);
        let id = field(event, "agentId");
        // Background workers interleave. A live step does not establish that
        // an unseen ID belongs to this question. Retain only its bounded input
        // signal until a timestamped list record correlates the worker.
        if field(event, "agentType") == "worker" && field(step, "kind") == "ask_user" {
            self.remember_input(id, tidy(field(step, "text"), MAX_REPLY_CHARS));
        }
    }

    /// OS3 answered or reported work, and no worker it started for this
    /// question is still running.
    fn answered_with_nothing_running(&self) -> bool {
        let answered = !self.replies.is_empty() || !self.lines.is_empty();
        if let Some(targets) = &self.cancel_targets {
            return !targets.is_empty()
                && targets
                    .iter()
                    .all(|id| self.agents.get(id).is_some_and(|agent| agent.ended));
        }
        if self.bounded_completion {
            return self.completion_confirmed();
        }
        answered && !self.agents.values().any(|agent| agent.new && agent.running)
    }

    /// Finished once OS3 is idle after answering, or after reporting its work,
    /// with no worker it started for this question still running.
    fn settle(&mut self) {
        if self.idle
            && self.answered_with_nothing_running()
            && self.correlation_until.is_none()
            && (self.bounded_completion
                || self.cancel_targets.is_some()
                || !self.uncorrelated_task_reaction())
        {
            self.finished = true;
        }
    }

    fn uncorrelated_task_reaction(&self) -> bool {
        self.task_reaction && !self.agents.values().any(|agent| agent.new)
    }

    fn begin_agent_correlation_grace(&mut self) {
        if self.idle
            && !self.bounded_completion
            && !self.task_reaction
            && self.boundary.is_some()
            && self.answered_with_nothing_running()
            && !self.agents.values().any(|agent| agent.new)
            && self.correlation_until.is_none()
        {
            self.correlation_until = Some(Instant::now() + AGENT_CORRELATION_GRACE);
        }
    }

    fn correlation_deadline(&self) -> Option<Instant> {
        self.correlation_until
            .filter(|_| !self.agents.values().any(|agent| agent.new))
    }

    fn finish_agent_correlation_grace(&mut self) {
        if self
            .correlation_until
            .is_some_and(|until| until <= Instant::now())
        {
            self.correlation_until = None;
            self.settle();
        }
    }

    /// Everything is answered but the idle after this question's work ended
    /// while OS3 was not processing, which may never come.
    fn awaiting_relay(&self) -> bool {
        self.relay_pending && self.answered_with_nothing_running()
    }

    /// OS3 has neither replied nor reported work for this question.
    fn said_nothing(&self) -> bool {
        self.replies.is_empty() && self.lines.is_empty() && self.needs_input.is_none()
    }

    /// The step that failed this question although the answer may still say
    /// something: the connection closed before OS3 said anything about it, or
    /// OS3 never took it.
    fn interrupted(&self) -> Option<Os3Error> {
        // An error OS3 reported came over a working connection, and the answer
        // says so.
        if self.finished || self.needs_input.is_some() || self.errored {
            return None;
        }
        if self.storage_failed {
            return Some(Os3Error::ConversationStorage);
        }
        match (self.boundary.is_some(), self.closed) {
            (false, true) => Some(Os3Error::Dropped),
            (false, false) => Some(Os3Error::NoAnswer),
            (true, true) if self.said_nothing() => Some(Os3Error::Dropped),
            (true, _) => None,
        }
    }

    fn running_titles(&self) -> (usize, Vec<String>) {
        let running: Vec<&Agent> = self
            .agents
            .iter()
            .filter(|(id, agent)| {
                agent.running
                    && self
                        .status_targets
                        .as_ref()
                        .map_or(agent.new, |targets| targets.contains(*id))
            })
            .map(|(_, agent)| agent)
            .collect();
        let mut titles: Vec<String> = running
            .iter()
            .map(|agent| agent.title.clone())
            .filter(|title| !title.is_empty())
            .collect();
        titles.sort();
        titles.truncate(3);
        (running.len(), titles)
    }

    fn render(&self) -> Result<String, Os3Error> {
        if let Some(targets) = &self.cancel_targets {
            // Receipt and completion are different. Confirmation comes only
            // from original worker identities, never provider error prose or
            // the stop request's own newly created worker.
            if self.boundary.is_none() {
                return Err(self.interrupted().unwrap_or(Os3Error::NoAnswer));
            }
            let confirmed: Vec<&Agent> = targets
                .iter()
                .filter_map(|id| self.agents.get(id).filter(|agent| agent.ended))
                .collect();
            let answer = if !targets.is_empty() && confirmed.len() == targets.len() {
                if confirmed.iter().all(|agent| agent.canceled) {
                    "OS3 stopped your task."
                } else if confirmed.iter().all(|agent| !agent.failed) {
                    "Your OS3 task had already finished."
                } else if confirmed
                    .iter()
                    .any(|agent| agent.failed && !agent.canceled)
                {
                    "Your OS3 task ended with an error."
                } else {
                    "Your OS3 work has ended. Some parts finished before the stop."
                }
            } else {
                "Stop requested. OS3 hasn't confirmed your task stopped. Check OS3 for an update."
            };
            return Ok(if self.request_not_sent {
                with_notice(NEW_REQUEST_NOT_SENT, answer)
            } else {
                answer.to_owned()
            });
        }
        let mut parts: Vec<String> = self.earlier.clone();
        parts.extend(self.lines.iter().cloned());
        let provider_parts = parts.len();
        let readable = self.replies.iter().any(|(_, text)| !text.is_empty());
        if !readable && !self.replies.is_empty() && self.needs_input.is_none() {
            parts.push("OS3 replied with a card that has no readable text.".to_owned());
        }
        if let Some(question) = &self.needs_input {
            if question.is_empty() {
                parts.push(NEEDS_INPUT.to_owned());
            } else {
                parts.push(format!("{NEEDS_INPUT} OS3 asks: {question}"));
            }
        } else if self.errored {
            parts.push(
                if self.boundary.is_none() {
                    ERRORED_BEFORE_TAKEN
                } else if self.said_nothing() {
                    ERRORED_AFTER_TAKEN
                } else {
                    ERRORED_PART_WAY
                }
                .to_owned(),
            );
            if self.running_titles().0 > 0 {
                parts.push("Your OS3 task is still pending. Ask for an update.".to_owned());
            }
        } else if !self.finished && (!self.bounded_completion || !self.completion_confirmed()) {
            let (running, titles) = self.running_titles();
            if !titles.is_empty() {
                parts.push(format!(
                    "OS3 is still working on: {}. Ask again later for the result.",
                    titles.join("; ")
                ));
            } else if let Some(step) = self.interrupted() {
                // OS3 took the question: say the connection dropped. It never
                // did: say so beside earlier results, or fail with it alone.
                // A storage failure is said as itself either way.
                if step == Os3Error::ConversationStorage {
                    parts.push(step.observation().to_owned());
                } else if self.boundary.is_some() {
                    parts.push(DROPPED_AFTER_TAKEN.to_owned());
                } else if !parts.is_empty() {
                    parts.push(step.observation().to_owned());
                }
            } else if self.bounded_completion && !self.completion_confirmed() {
                parts.push("OS3 hasn't confirmed this request is complete.".to_owned());
            } else if self.uncorrelated_task_reaction() {
                parts.push(
                    "OS3 hasn't confirmed this task is finished. Ask again for an update."
                        .to_owned(),
                );
            } else if running > 0 || self.processing || self.said_nothing() {
                // Only while something runs, or OS3 has not answered at all.
                parts.push(
                    "OS3 is still working on this. Ask again later for the result.".to_owned(),
                );
            }
        }
        if self.request_not_sent {
            parts.push(NEW_REQUEST_NOT_SENT.to_owned());
        }
        if parts.is_empty() {
            return Err(self.interrupted().unwrap_or(Os3Error::NoAnswer));
        }
        // State/input/error notices are essential to the spoken outcome.
        // Bound provider prose first so its legal individual replies cannot
        // hide the final task state or owner's permission boundary.
        let notice = parts[provider_parts..].join("\n");
        let prose = parts[..provider_parts].join("\n");
        if notice.is_empty() {
            return Ok(tidy_lines(&prose, MAX_CHARS.saturating_sub(1)));
        }
        let remaining = MAX_CHARS.saturating_sub(notice.chars().count() + 2);
        let prose = tidy_lines(&prose, remaining);
        Ok(if prose.is_empty() {
            notice
        } else {
            format!("{prose}\n{notice}")
        })
    }

    /// State that must survive while this call is still in flight. The
    /// current boundary is retained even if an answer is already in memory:
    /// until the call returns, the wearer has not received it. Current replies
    /// likewise are not added to `reported` until [`Self::follow_up`].
    fn checkpoint(&self) -> Option<Unfinished> {
        let previous = self.previous.as_ref().cloned().unwrap_or_default();
        let mut agents: HashMap<String, String> = self
            .agents
            .iter()
            .filter(|(_, agent)| agent.new && !agent.ended && self.status_targets.is_none())
            .map(|(id, agent)| (id.clone(), agent.title.clone()))
            .collect();
        for (id, title) in &previous.agents {
            let finished = self.agents.get(id).is_some_and(|agent| agent.ended);
            if !finished {
                agents.entry(id.clone()).or_insert_with(|| title.clone());
            }
        }
        // Keep the oldest unresolved boundary until its late replies reach the
        // wearer. Current correlated worker IDs are still added below, so a
        // cancellation preserves their completion by identity without making
        // an undelivered earlier reply unreachable in history.
        let boundary = previous.boundary.or_else(|| self.boundary.clone());
        if agents.is_empty() && boundary.is_none() {
            return None;
        }
        Some(Unfinished {
            boundary,
            reported: previous.reported,
            agents,
        })
    }

    /// What the next question should still look out for.
    fn follow_up(self) -> Option<Unfinished> {
        // INFERRED bounded-session policy: retain an accepted request without
        // terminal evidence even when optional task metadata is absent. A task
        // reaction still does not prove worker creation. Never invent an ID.
        let awaiting_current_task = self.cancel_targets.is_none()
            && (self.uncorrelated_task_reaction()
                || (self.bounded_completion && !self.completion_confirmed()));
        let preserve_status_boundary = self.status_targets.is_some() && !self.finished;
        let previous = self.previous.unwrap_or_default();
        // A status acknowledgment does not finish older unconfirmed work.
        // Retain its original boundary for late replies. Already known workers
        // keep their own identity-based terminal handling.
        let awaiting_previous_reply =
            previous.boundary.is_some() && previous.agents.is_empty() && self.earlier.is_empty();
        let preserve_running_boundary = previous
            .agents
            .keys()
            .any(|id| self.agents.get(id).is_none_or(|agent| !agent.ended));
        let mut agents: HashMap<String, String> = self
            .agents
            .iter()
            .filter(|(_, agent)| agent.new && !agent.ended && self.status_targets.is_none())
            .map(|(id, agent)| (id.clone(), agent.title.clone()))
            .collect();
        for (id, title) in previous.agents {
            let finished = self.agents.get(&id).is_some_and(|agent| agent.ended);
            if !finished {
                agents.entry(id).or_insert(title);
            }
        }
        let boundary =
            if preserve_status_boundary || preserve_running_boundary || awaiting_previous_reply {
                // Status or a new Ask must not replace the oldest accepted
                // boundary while its earlier work remains unresolved. Otherwise
                // a separate late chat relay before the new echo is lost.
                previous.boundary.or(self.boundary)
            } else if self.finished && !awaiting_current_task {
                previous.boundary
            } else {
                self.boundary.or(previous.boundary)
            };
        if agents.is_empty()
            && ((self.finished && !awaiting_previous_reply && !awaiting_current_task)
                || boundary.is_none())
        {
            return None;
        }
        let mut reported = previous.reported;
        if reported.len() + self.earlier_ids.len() + self.replies.len() > MAX_REPORTED_IDS {
            reported.clear();
        }
        reported.extend(self.earlier_ids);
        reported.extend(self.replies.into_iter().map(|(id, _)| id));
        Some(Unfinished {
            boundary,
            reported,
            agents,
        })
    }
}

/// A task by its title, for a line about how it ended.
fn task(title: &str) -> String {
    if title.is_empty() {
        "a task".to_owned()
    } else {
        format!("\"{title}\"")
    }
}

fn completion(title: &str, result: &str) -> String {
    let task = task(title);
    if result.is_empty() {
        format!("{task}.")
    } else {
        format!("{task}: {result}")
    }
}

/// Work an earlier question left running, by its title.
fn earlier_task(title: &str) -> String {
    if title.is_empty() {
        "an earlier task".to_owned()
    } else {
        format!("the earlier task \"{title}\"")
    }
}

fn finished_earlier(title: &str, result: &str) -> String {
    let task = earlier_task(title);
    if result.is_empty() {
        format!("OS3 finished {task}.")
    } else {
        format!("OS3 finished {task}: {result}")
    }
}

/// A form or confirmation card waits for the owner. This client never answers
/// one on their behalf.
fn card_needs_input(message: &Value) -> bool {
    message
        .get("cardSpec")
        .and_then(|card| card.get("elements"))
        .and_then(Value::as_object)
        .is_some_and(|elements| {
            elements
                .values()
                .any(|element| matches!(field(element, "type"), "form" | "confirm"))
        })
}

/// The reply's text, or for a card-only reply what its elements say, in order.
fn spoken_text(message: &Value) -> String {
    let text = tidy(field(message, "text"), MAX_REPLY_CHARS);
    if !text.is_empty() {
        return text;
    }
    let Some(card) = message.get("cardSpec") else {
        return String::new();
    };
    let elements = card.get("elements");
    let text = card
        .get("root")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|id| elements.and_then(|elements| elements.get(id)))
        .filter_map(element_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    tidy(&text, MAX_REPLY_CHARS)
}

/// What one card element says aloud: its text, a file by name and size, or a
/// table's first rows. Forms, confirmations, and images say nothing.
fn element_text(element: &Value) -> Option<String> {
    let props = element.get("props")?;
    match field(element, "type") {
        "text" => Some(field(props, "text").to_owned()),
        "file" => {
            let name = field(props, "name");
            let size = field(props, "size");
            match (name.is_empty(), size.is_empty()) {
                (true, _) => None,
                (false, true) => Some(format!("File: {name}.")),
                (false, false) => Some(format!("File: {name} ({size}).")),
            }
        }
        "table" => table_text(props),
        _ => None,
    }
}

fn table_text(props: &Value) -> Option<String> {
    fn cell(value: &Value) -> String {
        match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            Value::Object(_) => ["label", "title", "name", "text"]
                .into_iter()
                .map(|key| field(value, key))
                .find(|text| !text.is_empty())
                .unwrap_or("")
                .to_owned(),
            _ => String::new(),
        }
    }
    fn joined(cells: impl Iterator<Item = String>) -> String {
        cells
            .filter(|cell| !cell.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    }
    let rows = props.get("rows").and_then(Value::as_array)?;
    let spoken: Vec<String> = rows
        .iter()
        .take(MAX_TABLE_ROWS)
        .map(|row| match row {
            Value::Array(cells) => joined(cells.iter().map(cell)),
            Value::Object(cells) => joined(cells.values().map(cell)),
            other => cell(other),
        })
        .filter(|row| !row.is_empty())
        .collect();
    if spoken.is_empty() {
        return None;
    }
    let columns = joined(
        props
            .get("columns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(cell),
    );
    let count = match rows.len() {
        1 => "1 row".to_owned(),
        count => format!("{count} rows"),
    };
    let heading = if columns.is_empty() {
        format!("A table with {count}:")
    } else {
        format!("A table with {count} ({columns}):")
    };
    Some(format!("{heading} {}.", spoken.join("; ")))
}

/// Bound the observation while keeping its line structure.
fn tidy_lines(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut shortened = text.chars().take(limit).collect::<String>();
    shortened.push('…');
    shortened
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

    const COOKIE_VALUE: &str = "session=private-os3-cookie";
    const TOKEN: &str = "private-access-token";
    const EMAIL: &str = "owner@example.test";
    const OWNER: &str = "U:owner";

    struct Peer {
        socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        received: Arc<Mutex<Vec<Value>>>,
    }

    impl Peer {
        /// The next client text message, or `None` once the client closed.
        async fn recv(&mut self) -> Option<Value> {
            while let Some(Ok(frame)) = self.socket.next().await {
                match frame {
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        self.received.lock().unwrap().push(value.clone());
                        return Some(value);
                    }
                    Message::Close(_) => return None,
                    _ => {}
                }
            }
            None
        }

        async fn send(&mut self, value: Value) {
            let _ = self.socket.send(Message::Text(value.to_string())).await;
        }

        async fn ack(&mut self, session_id: &str) {
            let init = self.recv().await.expect("init");
            assert_eq!(init["type"], "init");
            assert_eq!(init["version"], 1);
            assert_eq!(init["accessToken"], TOKEN);
            self.send(json!({
                "type": "init_ack",
                "version": 1,
                "timestamp": 1_700_000_000_100_i64,
                "sessionId": session_id,
                "protocolVersion": 1,
                "butlerName": "Butler",
                "email": EMAIL,
                "commands": [{"name": "help", "description": "Show the available commands"}],
                "onboarding": false,
            }))
            .await;
        }

        /// Receive the question and echo it as the server does.
        async fn question(&mut self, echo_id: &str) -> Value {
            let chat = self.asked().await;
            self.send(echo(echo_id, &chat)).await;
            chat
        }

        /// Receive the question without echoing it yet.
        async fn asked(&mut self) -> Value {
            let chat = self.recv().await.expect("chat.message");
            assert_eq!(chat["type"], "chat.message");
            chat
        }

        async fn until_closed(&mut self) {
            while self.recv().await.is_some() {}
        }
    }

    fn agent_reply(id: &str, text: &str) -> Value {
        json!({
            "type": "chat.message",
            "version": 1,
            "timestamp": 1_700_000_002_000_i64,
            "messageId": id,
            "text": text,
            "role": "agent",
            "butlerName": "Butler",
            "cardSpec": {"root": ["text"], "elements": {"text": {"type": "text", "props": {"text": text, "role": "butler"}}}},
        })
    }

    fn idle() -> Value {
        json!({"type": "conversation.idle", "version": 1, "timestamp": 1_700_000_002_010_i64})
    }

    /// The server's echo of the client's question.
    fn echo(id: &str, chat: &Value) -> Value {
        json!({
            "type": "chat.message",
            "version": 1,
            "timestamp": 1_700_000_001_100_i64,
            "messageId": id,
            "text": chat["text"],
            "role": "user",
        })
    }

    fn worker_step(agent: &str, step: Value) -> Value {
        json!({"type": "activity.step", "version": 1, "agentId": agent, "agentType": "worker", "step": step})
    }

    /// The first question about the Mac: OS3 acknowledges it, starts a worker
    /// for it, and goes idle with that worker still running.
    async fn leave_the_mac_check_running(peer: &mut Peer) {
        peer.question("msg_user_1").await;
        peer.send(json!({"type": "conversation.processing", "version": 1}))
            .await;
        peer.send(agent_reply("msg_ack", "Let me check your Mac."))
            .await;
        peer.send(json!({
            "type": "agent.list",
            "version": 1,
            "agents": [
                {"agentId": "agent_old", "title": "Old chore", "state": "running", "createdAt": 1_600_000_000_000_i64, "startedInHouse": false},
                {"agentId": "agent_mac", "title": "Check the Mac's desktop", "state": "running", "createdAt": 1_700_000_001_200_i64, "startedInHouse": false},
            ],
        }))
        .await;
        peer.send(idle()).await;
    }

    /// A reconnect's snapshot: the Mac question's worker has since answered.
    fn late_history() -> Value {
        json!({
            "type": "session.history",
            "version": 1,
            "messages": [
                {"type": "chat.message", "messageId": "msg_before", "text": "Unrelated", "role": "agent"},
                {"type": "chat.message", "messageId": "msg_user_1", "text": "What is on my Mac's desktop?", "role": "user"},
                {"type": "chat.message", "messageId": "msg_ack", "text": "Let me check your Mac.", "role": "agent"},
                {"type": "chat.message", "messageId": "msg_late", "text": "Your desktop has two folders.", "role": "agent"},
            ],
        })
    }

    /// One account's conversation in a memory store and key directory.
    fn memory_conversation() -> ConversationStore {
        ConversationStore::new(
            Arc::new(crate::store::MemoryStore::default()),
            Arc::new(crate::keydirectory::KeyDirectory::in_memory()),
            OWNER,
        )
    }

    struct Mock {
        client: Os3Client,
        saved: ConversationStore,
        received: Arc<Mutex<Vec<Value>>>,
        socket_paths: Arc<Mutex<Vec<String>>>,
        http_hits: Arc<AtomicUsize>,
    }

    impl Mock {
        fn sent(&self) -> Vec<Value> {
            self.received.lock().unwrap().clone()
        }

        fn inits(&self) -> Vec<Value> {
            self.sent()
                .into_iter()
                .filter(|message| message["type"] == "init")
                .collect()
        }

        async fn ask(&self, question: &str, within: Duration) -> Result<String, Os3Error> {
            self.ask_as(COOKIE_VALUE, question, within).await
        }

        /// A question signed in with `cookie`, told whether it only asks for
        /// status exactly as the assistant tells it.
        async fn ask_as(
            &self,
            cookie: &str,
            question: &str,
            within: Duration,
        ) -> Result<String, Os3Error> {
            self.client
                .ask(
                    cookie,
                    question,
                    if crate::assistant::llm::os3_cancel_request(question) {
                        RequestKind::Cancel
                    } else if crate::assistant::llm::os3_status_follow_up(question) {
                        RequestKind::Status
                    } else {
                        RequestKind::Ask
                    },
                    Instant::now() + within,
                    Some(&self.saved),
                )
                .await
                .answer
        }

        /// What the next question resumes.
        async fn conversation(&self) -> Conversation {
            self.saved
                .load()
                .await
                .expect("the conversation is readable")
        }

        /// Cosmos restarted: a new process asks the same OS3 and reads the
        /// conversation back from `saved`.
        fn restart(&mut self, saved: ConversationStore) {
            self.client = Os3Client::new(self.client.endpoints.clone());
            self.saved = saved;
        }
    }

    /// How one of the mock's HTTP steps answers a signed-in request.
    #[derive(Clone)]
    struct Answer {
        status: StatusCode,
        content_type: &'static str,
        body: String,
        chunked: bool,
    }

    impl Answer {
        fn json(status: StatusCode, body: Value) -> Self {
            Self {
                status,
                content_type: "application/json",
                body: body.to_string(),
                chunked: false,
            }
        }

        /// An HTML page, as Rabbit's edge refusal or the sign-in page.
        fn html(status: StatusCode) -> Self {
            Self {
                status,
                content_type: "text/html; charset=utf-8",
                body: "<html>Sign in</html>".to_owned(),
                chunked: false,
            }
        }

        fn into_response(self) -> axum::response::Response {
            let mut response = axum::http::Response::builder()
                .status(self.status)
                .header("content-type", self.content_type);
            if self.status.is_redirection() {
                response = response.header("location", "https://os3.rabbit.tech/login");
            }
            let body = if self.chunked {
                axum::body::Body::from_stream(futures_util::stream::once(async move {
                    Ok::<_, std::convert::Infallible>(self.body)
                }))
            } else {
                axum::body::Body::from(self.body)
            };
            response.body(body).unwrap()
        }
    }

    /// What the token and route calls answer once the request is signed in.
    #[derive(Clone)]
    struct Http {
        token: Answer,
        route: Answer,
    }

    impl Http {
        fn routed_to(instance: &str) -> Self {
            Self {
                token: Answer::json(StatusCode::OK, json!({"accessToken": TOKEN})),
                route: Answer::json(
                    StatusCode::OK,
                    json!({"kind": "route", "instanceId": instance}),
                ),
            }
        }
    }

    /// A cookie for a second OS3 account, which the mock also signs in.
    const OTHER_COOKIE: &str = "session=another-os3-account";

    fn signed_in(headers: &axum::http::HeaderMap) -> bool {
        matches!(
            headers.get("cookie").and_then(|v| v.to_str().ok()),
            Some(COOKIE_VALUE | OTHER_COOKIE)
        )
    }

    async fn mock<F, Fut>(token_status: StatusCode, instance: &'static str, script: F) -> Mock
    where
        F: Fn(Peer) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let mut http = Http::routed_to(instance);
        if token_status != StatusCode::OK {
            http.token = Answer::json(token_status, json!({"error": "unauthorized"}));
        }
        mock_http(http, script).await
    }

    async fn mock_http<F, Fut>(answers: Http, script: F) -> Mock
    where
        F: Fn(Peer) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        use axum::http::HeaderMap;

        let http_hits = Arc::new(AtomicUsize::new(0));
        let counted = {
            let http_hits = http_hits.clone();
            axum::middleware::from_fn(
                move |request: axum::extract::Request, next: axum::middleware::Next| {
                    http_hits.fetch_add(1, Ordering::SeqCst);
                    next.run(request)
                },
            )
        };
        // Like Rabbit's edge: anything that is not the approved browser
        // User-Agent is turned away with an HTML 403 before any other check.
        let browser_only = axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let browser = request
                    .headers()
                    .get("user-agent")
                    .and_then(|v| v.to_str().ok())
                    == Some(BROWSER_USER_AGENT);
                if !browser {
                    return axum::response::IntoResponse::into_response((
                        StatusCode::FORBIDDEN,
                        [("content-type", "text/html")],
                        "<html>403 Forbidden</html>",
                    ));
                }
                next.run(request).await
            },
        );
        let refused = || Answer::json(StatusCode::UNAUTHORIZED, json!({})).into_response();
        let token = answers.token;
        let route = answers.route;
        let router = axum::Router::new()
            .route(
                "/api/auth/token",
                axum::routing::get(move |headers: HeaderMap| {
                    let token = token.clone();
                    async move {
                        if !signed_in(&headers) {
                            return refused();
                        }
                        token.into_response()
                    }
                }),
            )
            .route(
                "/session-directory/route",
                axum::routing::post(move |headers: HeaderMap| {
                    let route = route.clone();
                    async move {
                        let bearer = headers.get("authorization").and_then(|v| v.to_str().ok())
                            == Some(format!("Bearer {TOKEN}").as_str());
                        if !bearer || !signed_in(&headers) {
                            return refused();
                        }
                        route.into_response()
                    }
                }),
            )
            .layer(browser_only)
            .layer(counted);
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_address = http.local_addr().unwrap();
        let expected_origin = format!("http://{http_address}");
        tokio::spawn(async move {
            let _ = axum::serve(http, router).await;
        });

        let sockets = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket_address = sockets.local_addr().unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let socket_paths = Arc::new(Mutex::new(Vec::new()));
        {
            let received = received.clone();
            let socket_paths = socket_paths.clone();
            let socket_origin = expected_origin.clone();
            tokio::spawn(async move {
                while let Ok((stream, _)) = sockets.accept().await {
                    let paths = socket_paths.clone();
                    let expected_origin = socket_origin.clone();
                    let callback = move |request: &Request, response: Response| {
                        paths.lock().unwrap().push(request.uri().path().to_owned());
                        let header =
                            |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
                        if header("user-agent") != Some(BROWSER_USER_AGENT)
                            || header("origin") != Some(expected_origin.as_str())
                        {
                            let mut refusal = ErrorResponse::new(Some("forbidden".to_owned()));
                            *refusal.status_mut() =
                                tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                            return Err(refusal);
                        }
                        Ok::<_, ErrorResponse>(response)
                    };
                    let Ok(socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await
                    else {
                        continue;
                    };
                    script(Peer {
                        socket,
                        received: received.clone(),
                    })
                    .await;
                }
            });
        }

        Mock {
            client: Os3Client::new(Endpoints {
                origin: expected_origin,
                socket: format!("ws://{socket_address}/ws/{{instance}}"),
                socket_any: format!("ws://{socket_address}/ws"),
            }),
            saved: memory_conversation(),
            received,
            socket_paths,
            http_hits,
        }
    }

    // Failure matrix (synthetic/unrecorded): missing/unknown state must not
    // retire a correlated running identity. Explicit completed/failed/canceled
    // still do. The next cancel must reach only that retained original worker.
    async fn unresolved_snapshot_workflow(state: Option<&'static str>, terminal: bool) {
        let count = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let number = count.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                peer.question(if number == 0 { "msg_original" } else { "msg_cancel" }).await;
                if number == 0 {
                    peer.send(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Synthetic read","state":"running","createdAt":1_700_000_001_200_i64}]})).await;
                    let mut partial = json!({"agentId":"original_worker"});
                    if let Some(state) = state { partial["state"] = json!(state); }
                    peer.send(json!({"type":"agent.list","agents":[partial]})).await;
                    peer.send(agent_reply("ack_original","Synthetic task accepted.")).await;
                } else {
                    peer.send(json!({"type":"agent.list","agents":[{"agentId":"original_worker","state":"canceled"}]})).await;
                }
                peer.send(idle()).await;
                peer.until_closed().await;
            }
        }).await;
        let answer = mock
            .ask(
                "Ask OS3 to inspect the synthetic fixture",
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        let conversation = mock.conversation().await;
        if terminal {
            assert!(
                conversation
                    .unfinished
                    .as_ref()
                    .is_none_or(|work| !work.agents.contains_key("original_worker")),
                "confirmed terminal retires original identity"
            );
        } else {
            assert!(
                conversation
                    .unfinished
                    .as_ref()
                    .is_some_and(|work| work.agents.contains_key("original_worker")),
                "unknown/missing state must keep original worker: {answer}"
            );
            let stopped = mock
                .ask("cancel OS3", Duration::from_secs(2))
                .await
                .unwrap();
            assert!(
                stopped.contains("OS3 stopped your task"),
                "retained original worker remains cancelable: {stopped}"
            );
            assert_eq!(mock.inits()[1]["sessionId"], "session_a");
        }
    }

    #[tokio::test]
    async fn unresolved_state_missing_preserves_correlated_running_worker() {
        unresolved_snapshot_workflow(None, false).await;
    }
    #[tokio::test]
    async fn unresolved_state_unknown_preserves_correlated_running_worker() {
        unresolved_snapshot_workflow(Some("future_nonterminal"), false).await;
    }
    #[tokio::test]
    async fn unresolved_state_confirmed_terminals_still_retire_worker() {
        for state in ["completed", "failed", "canceled"] {
            unresolved_snapshot_workflow(Some(state), true).await;
        }
    }

    #[tokio::test]
    async fn unresolved_state_partial_reconnect_keeps_retained_original_identity() {
        let mock = mock(StatusCode::OK,"instance-1",|mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_new").await;
            peer.send(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Updated title"}]})).await;
            peer.send(agent_reply("msg_new_ack","Synthetic new request accepted.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        }).await;
        assert!(
            mock.saved
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_a".to_owned()),
                    unfinished: Some(Unfinished {
                        boundary: Some("msg_original".to_owned()),
                        agents: HashMap::from([(
                            "original_worker".to_owned(),
                            "Synthetic original".to_owned()
                        )]),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .await
        );
        mock.ask("Ask OS3 another synthetic request", Duration::from_secs(2))
            .await
            .unwrap();
        let work = mock.conversation().await.unfinished.unwrap();
        assert!(
            work.agents.contains_key("original_worker"),
            "partial reconnect cannot retire accepted original identity"
        );
        assert_eq!(
            work.boundary.as_deref(),
            Some("msg_original"),
            "oldest unresolved boundary retained"
        );
    }

    // Defensive initial partial/future records: a verified createdAt correlates
    // identity, not a running state. Keep that unresolved identity for later
    // input/cancel/terminal events without claiming the worker is running.
    async fn unresolved_initial_identity_workflow(state: Option<&'static str>, complete: bool) {
        let count = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK,"instance-1",move |mut peer| {
            let number = count.fetch_add(1,Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                peer.question(if number == 0 {"msg_original"} else {"msg_cancel"}).await;
                if number == 0 {
                    let mut record = json!({"agentId":"original_worker","title":"Synthetic unknown-state task","createdAt":1_700_000_001_200_i64});
                    if let Some(state) = state { record["state"] = json!(state); }
                    peer.send(json!({"type":"agent.list","agents":[record]})).await;
                    if complete {
                        peer.send(json!({"type":"agent.completed","agentId":"original_worker","ext":{"result":"Synthetic confirmed result","resultFiles":[]}})).await;
                    } else {
                        peer.send(worker_step("original_worker",json!({"kind":"ask_user","text":"Approve in OS3."}))).await;
                    }
                } else {
                    peer.send(json!({"type":"agent.list","agents":[{"agentId":"original_worker","state":"canceled"}]})).await;
                }
                peer.send(idle()).await;
                peer.until_closed().await;
            }
        }).await;
        let answer = mock
            .ask(
                "Ask OS3 to inspect the synthetic unknown-state fixture",
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert!(
            !answer.contains("still working"),
            "unknown state is not running: {answer}"
        );
        if complete {
            assert!(
                answer.contains("Synthetic confirmed result") && answer.contains("OS3 finished"),
                "same-ID terminal event still resolves task: {answer}"
            );
            assert!(mock.conversation().await.unfinished.is_none());
        } else {
            assert!(answer.contains("owner's input"));
            let work = mock.conversation().await.unfinished.unwrap();
            assert!(
                work.agents.contains_key("original_worker"),
                "correlated unresolved identity must survive input before state known"
            );
            let stopped = mock
                .ask("cancel OS3", Duration::from_secs(2))
                .await
                .unwrap();
            assert!(
                stopped.contains("OS3 stopped your task"),
                "same original canceled ID confirms stop: {stopped}"
            );
            assert_eq!(
                mock.sent()
                    .iter()
                    .filter(|packet| packet["type"] == "chat.message"
                        && packet["text"]
                            == "Ask OS3 to inspect the synthetic unknown-state fixture")
                    .count(),
                1
            );
        }
        assert!(
            !mock
                .sent()
                .iter()
                .any(|packet| packet.get("answeredCard").is_some())
        );
    }
    #[tokio::test]
    async fn unresolved_initial_identity_survives_input_and_can_be_canceled() {
        for state in [None, Some("future_nonterminal")] {
            unresolved_initial_identity_workflow(state, false).await;
        }
    }
    #[tokio::test]
    async fn unresolved_initial_identity_same_id_terminal_still_finishes() {
        unresolved_initial_identity_workflow(None, true).await;
    }

    async fn read_only_status_workflow(shape: &'static str) {
        let mock = mock(StatusCode::OK,"instance-1",move |mut peer| async move {
            peer.ack("session_a").await;
            let mut messages = vec![json!({"type":"chat.message","messageId":"msg_original","role":"user","text":"Synthetic accepted task","timestamp":1_700_000_001_100_i64})];
            if shape == "missing_boundary" { messages.clear(); }
            if shape == "interleaved" { messages.push(json!({"type":"chat.message","messageId":"other_user","role":"user","text":"An unrelated synthetic request"})); }
            messages.push(json!({"type":"chat.message","messageId":"late_reply","role":"agent","text":if shape == "interleaved" || shape == "missing_boundary" {"Unrelated result must not be attributed"} else {"Synthetic original result"}}));
            peer.send(json!({"type":"session.history","messages":messages})).await;
            peer.send(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Synthetic read","state":"completed","createdAt":1_700_000_001_200_i64}]})).await;
            if shape != "terminal_no_idle" { peer.send(idle()).await; }
            peer.until_closed().await;
        }).await;
        assert!(
            mock.saved
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_a".to_owned()),
                    unfinished: Some(Unfinished {
                        boundary: Some("msg_original".to_owned()),
                        agents: HashMap::from([(
                            "original_worker".to_owned(),
                            "Synthetic read".to_owned()
                        )]),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .await
        );
        let answer = mock
            .ask("What did OS3 find?", Duration::from_secs(2))
            .await
            .unwrap();
        assert!(
            !mock
                .sent()
                .iter()
                .any(|packet| packet["type"] == "chat.message"),
            "status observes retained task without a new chat"
        );
        assert_eq!(mock.inits()[0]["sessionId"], "session_a");
        if shape == "terminal_no_idle" {
            assert!(
                answer.contains("OS3 finished"),
                "confirmed original terminal state: {answer}"
            );
            assert!(
                !answer.contains("still working")
                    && !answer.contains("still pending")
                    && !answer.contains("unconfirmed"),
                "confirmed terminal cannot be called pending: {answer}"
            );
        } else if shape == "normal" {
            assert!(answer.contains("Synthetic original result"), "{answer}");
        } else {
            assert!(
                !answer.contains("Unrelated result"),
                "unrelated/missing boundary cannot authorize text: {answer}"
            );
        }
    }

    #[tokio::test]
    async fn read_only_status_observes_retained_original_without_chat() {
        read_only_status_workflow("normal").await;
    }
    #[tokio::test]
    async fn read_only_status_does_not_attribute_interleaved_text() {
        read_only_status_workflow("interleaved").await;
    }
    #[tokio::test]
    async fn read_only_status_does_not_attribute_missing_boundary_text() {
        read_only_status_workflow("missing_boundary").await;
    }
    #[tokio::test]
    async fn read_only_status_without_matching_task_is_local() {
        for shape in ["empty", "changed_cookie", "expired_journal"] {
            let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
                peer.ack("session_a").await;
                peer.until_closed().await;
            })
            .await;
            if shape == "changed_cookie" {
                assert!(
                    mock.saved
                        .save(&Conversation {
                            cookie: Some(cookie_digest(OTHER_COOKIE)),
                            session_id: Some("session_a".to_owned()),
                            unfinished: Some(Unfinished {
                                boundary: Some("msg_original".to_owned()),
                                ..Default::default()
                            }),
                            ..Default::default()
                        })
                        .await
                );
            }
            if shape == "expired_journal" {
                assert!(
                    mock.saved
                        .save(&journal_conversation(
                            COOKIE_VALUE,
                            i64::try_from(now_ms()).unwrap() - JOURNAL_LIMIT_MS - 1
                        ))
                        .await
                );
            }
            let answer = mock
                .ask("What did OS3 find?", Duration::from_secs(2))
                .await
                .unwrap();
            assert!(
                answer.to_lowercase().contains("no luma os3 task"),
                "{answer}"
            );
            assert_eq!(
                mock.http_hits.load(Ordering::SeqCst),
                0,
                "no retained task needs no authentication or socket"
            );
            assert!(mock.sent().is_empty());
        }
    }

    #[tokio::test]
    async fn read_only_status_terminal_without_idle_does_not_claim_still_running() {
        read_only_status_workflow("terminal_no_idle").await;
    }

    #[tokio::test]
    async fn read_only_status_replaced_session_cannot_resume_original_work() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("replacement_session").await;
            peer.until_closed().await;
        })
        .await;
        assert!(
            mock.saved
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_a".to_owned()),
                    unfinished: Some(Unfinished {
                        boundary: Some("msg_original".to_owned()),
                        agents: HashMap::from([(
                            "original_worker".to_owned(),
                            "Synthetic read".to_owned()
                        )]),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .await
        );
        assert_eq!(
            mock.ask("What did OS3 find?", Duration::from_secs(2)).await,
            Err(Os3Error::Dropped)
        );
        assert!(
            !mock
                .sent()
                .iter()
                .any(|packet| packet["type"] == "chat.message")
        );
        let retained = mock.conversation().await;
        assert_eq!(retained.session_id.as_deref(), Some("session_a"));
        assert!(
            retained
                .unfinished
                .unwrap()
                .agents
                .contains_key("original_worker")
        );
    }

    // Three individually legal replies exceed the final observation cap.
    // The permission/error/pending notice must remain audible after truncation.
    async fn bounded_notice_workflow(mode: &'static str) {
        let mock = mock(StatusCode::OK,"instance-1",move |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_original").await;
            peer.send(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Synthetic read","state":"running","createdAt":1_700_000_001_200_i64}]})).await;
            for number in 0..3 { peer.send(agent_reply(&format!("reply_{number}"),&"x".repeat(600))).await; }
            if mode == "input" { peer.send(worker_step("original_worker",json!({"kind":"ask_user","text":"Approve in OS3."}))).await; }
            else if mode == "error" { peer.send(json!({"type":"error","code":"synthetic_failure"})).await; }
            else { peer.send(idle()).await; }
            peer.until_closed().await;
        }).await;
        let answer = mock
            .ask(
                "Ask OS3 to inspect the synthetic fixture",
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        if mode == "input" {
            assert!(
                answer.contains("owner's input") && answer.contains("Nothing was answered"),
                "input boundary notice must survive: {answer}"
            );
        } else if mode == "error" {
            assert!(
                answer.contains("error") && answer.contains("still"),
                "error does not imply known-running task ended: {answer}"
            );
        } else {
            assert!(
                answer.contains("still working"),
                "pending notice survives: {answer}"
            );
        }
        assert!(
            answer.chars().count() <= MAX_CHARS,
            "final observation remains bounded"
        );
        assert!(
            mock.conversation()
                .await
                .unfinished
                .as_ref()
                .is_some_and(|work| work.agents.contains_key("original_worker")),
            "input/error/deadline keeps unresolved worker"
        );
        assert!(
            !mock
                .sent()
                .iter()
                .any(|packet| packet.get("answeredCard").is_some())
        );
    }
    #[tokio::test]
    async fn bounded_notice_error_without_ack_preserves_pending_and_requests_update() {
        let mock = mock(StatusCode::OK,"instance-1",|mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_original").await;
            peer.send(json!({"type":"agent.list","agents":[{"agentId":"original_worker","title":"Synthetic read","state":"running","createdAt":1_700_000_001_200_i64}]})).await;
            peer.send(json!({"type":"error","code":"synthetic_failure"})).await;
            peer.until_closed().await;
        }).await;
        let answer = mock
            .ask(
                "Ask OS3 to inspect the synthetic fixture",
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert!(
            !answer.contains("Try again"),
            "accepted task error must direct update, not relaunch: {answer}"
        );
        assert!(
            answer.contains("still pending") && answer.contains("Ask for an update"),
            "{answer}"
        );
        assert!(
            mock.conversation()
                .await
                .unfinished
                .unwrap()
                .agents
                .contains_key("original_worker")
        );
    }

    #[tokio::test]
    async fn bounded_notice_input_survives_long_replies() {
        bounded_notice_workflow("input").await;
    }
    #[tokio::test]
    async fn bounded_notice_error_and_running_state_survive_long_replies() {
        bounded_notice_workflow("error").await;
    }
    #[tokio::test]
    async fn bounded_notice_pending_state_survives_long_replies() {
        bounded_notice_workflow("pending").await;
    }

    #[tokio::test]
    async fn a_question_returns_the_agent_reply_that_follows_its_echo() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.send(json!({
                "type": "session.history",
                "version": 1,
                "timestamp": 1_700_000_000_110_i64,
                "messages": [{"type": "chat.message", "version": 1, "timestamp": 1_699_999_999_000_i64,
                              "messageId": "msg_previous", "text": "Earlier reply", "role": "agent"}],
            }))
            .await;
            peer.question("msg_user").await;
            peer.send(json!({"type": "conversation.processing", "version": 1, "timestamp": 1})).await;
            peer.send(json!({"type": "chat.reaction", "version": 1, "timestamp": 1, "messageId": "msg_user", "reaction": "task"})).await;
            peer.send(agent_reply("msg_reply", "Your MacBook is at 80% battery.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        let started = std::time::Instant::now();
        let answer = mock
            .ask(
                "  What is my MacBook's battery?  ",
                Duration::from_millis(2_500),
            )
            .await
            .unwrap();
        assert!(
            answer.starts_with("OS3 replied: Your MacBook is at 80% battery."),
            "{answer}"
        );
        assert!(started.elapsed() >= Duration::from_millis(2_300));
        assert!(started.elapsed() < Duration::from_millis(3_300));
        assert_eq!(
            *mock.socket_paths.lock().unwrap(),
            vec!["/ws/instance-1".to_owned()]
        );

        let sent = mock.sent();
        assert_eq!(sent.len(), 2, "init and one chat message: {sent:?}");
        assert!(sent[0].get("sessionId").is_none());
        assert_eq!(sent[1]["text"], "What is my MacBook's battery?");
        assert!(sent[1].get("messageId").is_none() && sent[1].get("role").is_none());
        for private in [COOKIE_VALUE, TOKEN, EMAIL, "session_a", "Earlier reply"] {
            assert!(!answer.contains(private), "{private} leaked into {answer}");
        }
    }

    #[tokio::test]
    async fn the_session_id_is_retained_for_the_next_question() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let echo = format!("msg_user_{}", now_ms());
            peer.question(&echo).await;
            peer.send(agent_reply(&format!("{echo}_reply"), "Done."))
                .await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        mock.ask("First", Duration::from_secs(5)).await.unwrap();
        mock.ask("Second", Duration::from_secs(5)).await.unwrap();
        let inits = mock.inits();
        assert_eq!(inits.len(), 2);
        assert!(inits[0].get("sessionId").is_none());
        assert_eq!(inits[1]["sessionId"], "session_a");
    }

    #[tokio::test]
    async fn unknown_messages_frames_and_fields_are_tolerated() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.send(json!({"type": "mystery.event", "version": 7, "payload": [1, 2, 3]}))
                .await;
            let _ = peer.socket.send(Message::Binary(vec![0, 1, 2])).await;
            let _ = peer.socket.send(Message::Text("not json".to_owned())).await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": "not a list"}))
                .await;
            peer.question("msg_user").await;
            let mut reply = agent_reply("msg_reply", "Still fine.");
            reply["futureField"] = json!({"nested": true});
            reply["attachments"] = json!([{"name": "a.txt", "size": 6, "href": "/files/x"}]);
            peer.send(reply).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        assert_eq!(
            mock.ask("Anything?", Duration::from_secs(5)).await.unwrap(),
            "OS3 replied: Still fine.\nOS3 hasn't confirmed this request is complete."
        );
    }

    #[tokio::test]
    async fn recurring_history_snapshots_do_not_duplicate_replies() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(agent_reply("msg_reply", "Three files.")).await;
            let snapshot = json!({
                "type": "session.history",
                "version": 1,
                "messages": [
                    {"type": "chat.message", "messageId": "msg_old", "text": "Old", "role": "agent"},
                    {"type": "chat.message", "messageId": "msg_user", "text": "How many files?", "role": "user"},
                    {"type": "chat.message", "messageId": "msg_reply", "text": "Three files.", "role": "agent"},
                ],
            });
            peer.send(snapshot.clone()).await;
            peer.send(snapshot).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        assert_eq!(
            mock.ask("How many files?", Duration::from_secs(5))
                .await
                .unwrap(),
            "OS3 replied: Three files.\nOS3 hasn't confirmed this request is complete."
        );
    }

    #[tokio::test]
    async fn a_deadline_names_the_work_os3_is_still_doing_and_the_next_question_gets_it() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    peer.send(late_history()).await;
                    peer.question("msg_user_2").await;
                    peer.send(agent_reply("msg_reply_2", "You're welcome."))
                        .await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;

        let partial = mock
            .ask("What is on my Mac's desktop?", Duration::from_millis(1_500))
            .await
            .unwrap();
        assert!(
            partial.contains("OS3 replied: Let me check your Mac."),
            "{partial}"
        );
        assert!(
            partial.contains("OS3 is still working on: Check the Mac's desktop."),
            "{partial}"
        );
        assert!(!partial.contains("Old chore"), "{partial}");

        let later = mock.ask("Thanks", Duration::from_secs(5)).await.unwrap();
        assert!(
            later.contains("Earlier OS3 result: Your desktop has two folders."),
            "{later}"
        );
        assert!(later.contains("OS3 replied: You're welcome."), "{later}");
        assert!(!later.contains("Let me check your Mac"), "{later}");
        assert!(!later.contains("Unrelated"), "{later}");
    }

    /// The wearer asks about the Mac and the turn ends while OS3 is still
    /// checking. Cosmos restarts (a deploy), and "what did OS3 find?" then
    /// resumes the same OS3 conversation and hears the finished work. The
    /// restart is a new client reading the conversation back from `restart`.
    async fn a_follow_up_after_a_restart_hears_the_finished_work(
        before: ConversationStore,
        restart: impl AsyncFnOnce() -> ConversationStore,
    ) {
        let connection = Arc::new(AtomicUsize::new(0));
        let mut mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    // The worker finished while no socket was open: the list
                    // says so, and the snapshot holds what it found.
                    peer.send(json!({
                        "type": "agent.list",
                        "version": 1,
                        "agents": [{"agentId": "agent_mac", "title": "Check the Mac's desktop", "state": "completed",
                                    "createdAt": 1_700_000_001_200_i64, "completedAt": 1_700_000_050_000_i64}],
                    }))
                    .await;
                    peer.send(late_history()).await;
                    peer.question("msg_user_2").await;
                    peer.send(agent_reply("msg_reply_2", "I found two folders."))
                        .await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;
        mock.saved = before;

        let partial = mock
            .ask("What is on my Mac's desktop?", Duration::from_millis(1_500))
            .await
            .unwrap();
        assert!(
            partial.contains("OS3 is still working on: Check the Mac's desktop."),
            "{partial}"
        );

        mock.restart(restart().await);
        let found = mock
            .ask("What did you find?", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            found,
            "OS3 finished the earlier task \"Check the Mac's desktop\".\n\
             Earlier OS3 result: Your desktop has two folders.\n\
             OS3 replied: I found two folders.\nOS3 hasn't confirmed this request is complete."
        );
        let inits = mock.inits();
        assert_eq!(inits.len(), 2);
        assert_eq!(
            inits[1]["sessionId"], "session_a",
            "the follow-up continues the same OS3 conversation"
        );
        let conversation = mock.conversation().await;
        assert_eq!(conversation.session_id.as_deref(), Some("session_a"));
        let retained = conversation
            .unfinished
            .expect("new marker-free Ask remains unconfirmed");
        assert!(
            retained.agents.is_empty(),
            "finished earlier worker is not carried further"
        );
        assert_eq!(retained.boundary.as_deref(), Some("msg_user_2"));
    }

    #[tokio::test]
    async fn a_follow_up_after_a_restart_hears_the_finished_work_on_the_memory_store() {
        let directory = std::env::temp_dir().join(format!("cosmos-os3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let snapshot = directory.join("state.json");
        // The key authority outlives the process, as the PostgreSQL directory
        // does. The store comes back from its snapshot.
        let keys: SharedKeyDirectory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let open = || {
            ConversationStore::new(
                Arc::new(crate::store::MemoryStore::at_path(snapshot.clone())),
                keys.clone(),
                OWNER,
            )
        };
        a_follow_up_after_a_restart_hears_the_finished_work(open(), async || open()).await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn a_follow_up_after_a_restart_hears_the_finished_work_on_postgres() {
        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let account = format!("U:os3-{}", uuid::Uuid::new_v4());
        let open = async || {
            ConversationStore::new(
                Arc::new(
                    crate::store_postgres::PostgresStore::connect(&url)
                        .await
                        .expect("COSMOS_TEST_DATABASE_URL is set but connect/migrate failed"),
                ),
                Arc::new(
                    crate::keydirectory::KeyDirectory::connect(&url)
                        .await
                        .expect("COSMOS_TEST_DATABASE_URL is set but connect/migrate failed"),
                ),
                &account,
            )
        };
        let before = open().await;
        a_follow_up_after_a_restart_hears_the_finished_work(before, open).await;
    }

    /// The conversation is the account's own, sealed at rest under a key named
    /// for the account (so account deletion removes it), and bounded however
    /// it was written.
    #[tokio::test]
    async fn the_saved_conversation_is_sealed_per_account_and_bounded() {
        let store: SharedStore = Arc::new(crate::store::MemoryStore::default());
        let keys: SharedKeyDirectory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let owner = ConversationStore::new(store.clone(), keys.clone(), OWNER);
        assert!(owner.load().await.unwrap() == Conversation::default());

        let agents = (0..40)
            .map(|n| (format!("agent_{n:02}"), "x".repeat(200)))
            .collect();
        let private_request = "Read the private MacBook battery";
        let asked_at = 1_700_000_001_000_i64;
        let journal = InFlight {
            cancel: false,
            request_digest: request_digest(private_request, asked_at),
            asked_at,
        };
        let overgrown = Conversation {
            cookie: Some(cookie_digest(COOKIE_VALUE)),
            session_id: Some("session_private".to_owned()),
            in_flight: Some(journal.clone()),
            unfinished: Some(Unfinished {
                boundary: Some("msg_user".to_owned()),
                reported: (0..500).map(|n| format!("msg_{n}")).collect(),
                agents,
            }),
        };
        assert!(owner.save(&overgrown).await);
        let raw = store
            .get_account_blob(OWNER, AccountBlobKind::Os3Conversation)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&raw).contains("session_private"),
            "sealed at rest"
        );
        let plaintext = keys
            .open(&cosmos_crypto::EncryptedData {
                kid: owner.kid(),
                data: raw.clone(),
            })
            .await
            .unwrap()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&plaintext).contains(private_request),
            "the sealed payload contains only the request digest, never plaintext"
        );
        assert_eq!(
            crate::services::public_privacy::kid_user_id(&owner.kid()),
            Some("owner"),
            "account deletion attributes the key to its wearer"
        );
        assert!(keys.holds(&owner.kid()).await.unwrap());

        let loaded = owner.load().await.unwrap();
        assert_eq!(loaded.cookie, Some(cookie_digest(COOKIE_VALUE)));
        assert_eq!(loaded.session_id.as_deref(), Some("session_private"));
        assert!(loaded.in_flight == Some(journal));
        let unfinished = loaded.unfinished.unwrap();
        assert_eq!(unfinished.boundary.as_deref(), Some("msg_user"));
        assert!(
            unfinished.reported.is_empty(),
            "an overgrown set starts over"
        );
        assert_eq!(unfinished.agents.len(), MAX_CARRIED_AGENTS);
        assert!(
            unfinished
                .agents
                .values()
                .all(|title| title.chars().count() <= MAX_TITLE_CHARS + 1)
        );

        // Another account never reads it, even when handed the same bytes.
        let other = ConversationStore::new(store.clone(), keys.clone(), "U:someone-else");
        assert!(other.load().await.unwrap() == Conversation::default());
        store
            .put_account_blob("U:someone-else", AccountBlobKind::Os3Conversation, &raw)
            .await
            .unwrap();
        assert!(other.load().await.unwrap() == Conversation::default());

        assert!(
            owner
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_private".to_owned()),
                    in_flight: Some(InFlight {
                        cancel: false,
                        request_digest: "x".repeat(10_000),
                        asked_at: -1,
                    }),
                    unfinished: None,
                })
                .await
        );
        assert!(
            owner.load().await.unwrap().in_flight == Some(InFlight::blocked()),
            "an invalid journal stays present and bounded so recovery fails closed"
        );

        // Once its key is gone the record can never be resumed.
        keys.remove(&owner.kid()).await.unwrap();
        assert!(owner.load().await.unwrap() == Conversation::default());
    }

    #[tokio::test]
    async fn corrupt_saved_conversation_fails_closed_but_a_missing_key_starts_fresh() {
        let store: SharedStore = Arc::new(crate::store::MemoryStore::default());
        let keys: SharedKeyDirectory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let owner = ConversationStore::new(store.clone(), keys.clone(), OWNER);
        assert!(
            owner
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_a".to_owned()),
                    in_flight: Some(InFlight {
                        cancel: false,
                        request_digest: request_digest("Inspect my Mac", 1_700_000_001_000),
                        asked_at: 1_700_000_001_000,
                    }),
                    unfinished: None,
                })
                .await
        );

        let mut wrong_key = keys.get(&owner.kid()).await.unwrap().unwrap();
        wrong_key[0] ^= 1;
        let tampered = cosmos_crypto::seal(&owner.kid(), &wrong_key, b"{}", CONVERSATION_AAD)
            .unwrap()
            .data;
        store
            .put_account_blob(OWNER, AccountBlobKind::Os3Conversation, &tampered)
            .await
            .unwrap();
        assert!(
            owner.load().await.is_none(),
            "unauthenticated state must not permit a duplicate task"
        );

        let wrong_aad = keys
            .seal(&owner.kid(), b"{}", b"luma.os3.NotConversation")
            .await
            .unwrap()
            .unwrap();
        store
            .put_account_blob(OWNER, AccountBlobKind::Os3Conversation, &wrong_aad.data)
            .await
            .unwrap();
        assert!(owner.load().await.is_none(), "the AAD is part of the type");

        let malformed = keys
            .seal(&owner.kid(), b"not json", CONVERSATION_AAD)
            .await
            .unwrap()
            .unwrap();
        store
            .put_account_blob(OWNER, AccountBlobKind::Os3Conversation, &malformed.data)
            .await
            .unwrap();
        assert!(
            owner.load().await.is_none(),
            "invalid state is not empty state"
        );

        keys.remove(&owner.kid()).await.unwrap();
        assert!(
            owner.load().await == Some(Conversation::default()),
            "an intentionally removed account key starts a fresh conversation"
        );
    }

    #[tokio::test]
    async fn a_verified_echo_clears_its_journal_behind_an_older_boundary() {
        let saved = memory_conversation();
        let previous = Unfinished {
            boundary: Some("msg_older_question".to_owned()),
            reported: HashSet::new(),
            agents: HashMap::from([("agent_older".to_owned(), "Older task".to_owned())]),
        };
        let mut conversation = Conversation {
            cookie: Some(cookie_digest(COOKIE_VALUE)),
            session_id: Some("session_a".to_owned()),
            in_flight: Some(InFlight {
                cancel: false,
                request_digest: request_digest("Inspect my Mac", 1_700_000_001_000),
                asked_at: 1_700_000_001_000,
            }),
            unfinished: Some(previous.clone()),
        };
        assert!(saved.save(&conversation).await);
        let exchange = Exchange {
            asked_at: 1_700_000_001_000,
            request: "Inspect my Mac".to_owned(),
            boundary: Some("msg_current_question".to_owned()),
            boundary_at: 1_700_000_001_100,
            ..Exchange::new(Some(previous))
        };
        let client = Os3Client::new(Endpoints::production());

        client
            .checkpoint_exchange(
                Some(&saved),
                &mut conversation,
                &exchange,
                Instant::now() + Duration::from_secs(2),
            )
            .await
            .unwrap();

        assert!(conversation.in_flight.is_none());
        assert_eq!(
            conversation
                .unfinished
                .as_ref()
                .and_then(|unfinished| unfinished.boundary.as_deref()),
            Some("msg_older_question")
        );
        let loaded = saved.load().await.unwrap();
        assert!(loaded.in_flight.is_none());
        assert_eq!(
            loaded.unfinished.and_then(|unfinished| unfinished.boundary),
            Some("msg_older_question".to_owned())
        );
    }

    #[tokio::test]
    async fn forms_and_ask_user_steps_are_reported_without_answering_them() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.question("msg_user").await;
            if chat["text"] == "Rename my file" {
                peer.send(json!({
                    "type": "chat.message",
                    "version": 1,
                    "messageId": "msg_form",
                    "text": "",
                    "role": "agent",
                    "cardSpec": {"root": ["profile-form"], "elements": {"profile-form": {"type": "form",
                        "props": {"fields": [{"name": "nickname", "label": "Nickname", "type": "text"}]}}}},
                }))
                .await;
            } else {
                peer.send(json!({
                    "type": "agent.list",
                    "version": 1,
                    "agents": [{
                        "agentId": "agent_bank",
                        "title": "Check the balance",
                        "state": "running",
                        "createdAt": 1_700_000_001_200_i64
                    }]
                }))
                .await;
                peer.send(json!({
                    "type": "activity.step",
                    "version": 1,
                    "agentId": "agent_bank",
                    "agentType": "worker",
                    "step": {"kind": "ask_user", "text": "Which account should I use?", "sensitivity": "normal"},
                }))
                .await;
            }
            peer.until_closed().await;
        })
        .await;

        let form = mock
            .ask("Rename my file", Duration::from_secs(5))
            .await
            .unwrap();
        assert!(form.contains(NEEDS_INPUT), "{form}");
        let asked = mock
            .ask("Check my balance", Duration::from_secs(5))
            .await
            .unwrap();
        assert!(asked.contains(NEEDS_INPUT), "{asked}");
        assert!(
            asked.contains("OS3 asks: Which account should I use?"),
            "{asked}"
        );

        let sent = mock.sent();
        assert!(
            sent.iter()
                .all(|message| message.get("answeredCard").is_none()),
            "nothing may be answered on the owner's behalf: {sent:?}"
        );
        assert_eq!(
            sent.iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            2
        );
    }

    /// Owner-supplied OS3 WebSocket reference §2/5: summary and agent list
    /// arrive independently. Only an exact timestamp-correlated worker may
    /// pause for its final ask_user. The client never submits the answer.
    #[tokio::test]
    async fn activity_summary_before_agent_list_waits_for_exact_worker_identity() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(json!({"type": "activity.summary", "version": 1,
                "timestamp": 1_700_000_001_300_i64, "agentId": "agent_mac",
                "toolCount": 1, "currentStep": "ask_user", "stepsBeforeWindow": 0,
                "steps": [{"kind": "ask_user", "text": "Which folder should I inspect?", "sensitivity": "normal"}]
            })).await;
            peer.send(json!({"type": "agent.list", "version": 1,
                "timestamp": 1_700_000_001_400_i64, "agents": [{
                    "agentId": "agent_mac", "title": "Inspect folder", "state": "running",
                    "createdAt": 1_700_000_001_200_i64, "startedInHouse": false
                }]
            })).await;
            peer.until_closed().await;
        }).await;
        let answer = mock
            .ask("Inspect a folder on my Mac", Duration::from_millis(1200))
            .await
            .unwrap();
        assert!(answer.contains(NEEDS_INPUT), "{answer}");
        assert!(
            answer.contains("Which folder should I inspect?"),
            "{answer}"
        );
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn activity_summary_before_agent_list_rejects_unrelated_or_obsolete_input() {
        for question in [
            "Old worker",
            "Provisional",
            "Before echo",
            "Obsolete ask",
            "Overflow",
            "Updated summary",
        ] {
            let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            let question = field(&chat, "text");
            if question != "Before echo" { peer.send(echo("msg_user", &chat)).await; }
            let mut steps = vec![json!({"kind": "ask_user", "text": "Unrelated permission?", "sensitivity": "normal"})];
            if question == "Obsolete ask" { steps.push(json!({"kind": "tool_result", "toolCallId": "call_1", "output": "Done"})); }
            // Overflow stays bounded: the seventeenth unknown ID is not
            // retained and must not turn its later list into permission.
            if question == "Overflow" {
                for index in 0..MAX_CARRIED_AGENTS {
                    peer.send(json!({"type": "activity.summary", "version": 1,
                        "agentId": format!("unknown_{index}"), "steps": steps})).await;
                }
            }
            peer.send(json!({"type": "activity.summary", "version": 1,
                "agentId": "agent_mac", "steps": steps})).await;
            if question == "Updated summary" {
                peer.send(json!({"type": "activity.summary", "version": 1,
                    "agentId": "agent_mac", "steps": [{"kind": "tool_result", "toolCallId": "call_1", "output": "Done"}]})).await;
            }
            if question == "Before echo" { peer.send(echo("msg_user", &chat)).await; }
            let mut worker = json!({"agentId": "agent_mac", "title": "Background", "state": "running"});
            if question != "Provisional" {
                // Pre-echo delivery alone is no longer a reason to discard
                // confirmed current input. This negative control is older work.
                worker["createdAt"] = json!(if matches!(question, "Old worker" | "Before echo") { 1_600_000_000_000_i64 } else { 1_700_000_001_200_i64 });
            }
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [worker]})).await;
            peer.send(agent_reply("msg_reply", "Your laptop is charging.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        }).await;
            let answer = mock
                .ask(question, Duration::from_millis(1000))
                .await
                .unwrap();
            assert!(!answer.contains(NEEDS_INPUT), "{question}: {answer}");
            assert!(
                !answer.contains("Unrelated permission"),
                "{question}: {answer}"
            );
            assert!(
                answer.contains("Your laptop is charging."),
                "{question}: {answer}"
            );
        }
    }

    /// A worker can reach `ask_user` while Cosmos has no socket open. Rabbit
    /// restores that state in an independent activity snapshot on reconnect;
    /// only a worker this account's saved question left unfinished may pause
    /// the new exchange. An unrelated background worker must not be attributed
    /// to the wearer's question.
    #[tokio::test]
    async fn a_reconnected_unfinished_worker_reports_its_activity_summary_input_request() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    let chat = peer.question("msg_user_2").await;
                    assert_eq!(chat["text"], "What does OS3 need?");
                    peer.send(json!({
                        "type": "activity.summary",
                        "version": 1,
                        "agentId": "agent_unrelated",
                        "toolCount": 1,
                        "currentStep": "ask_user",
                        "steps": [{
                            "kind": "ask_user",
                            "text": "Unrelated background question?",
                            "sensitivity": "normal"
                        }],
                        "stepsBeforeWindow": 0
                    }))
                    .await;
                    peer.send(json!({
                        "type": "activity.summary",
                        "version": 1,
                        "agentId": "agent_mac",
                        "toolCount": 2,
                        "currentStep": "ask_user",
                        "steps": [
                            {"kind": "tool_call", "toolCallId": "call_mac", "toolName": "files", "input": {}},
                            {"kind": "ask_user", "text": "Which folder should I inspect?", "sensitivity": "normal"}
                        ],
                        "stepsBeforeWindow": 0
                    }))
                    .await;
                }
                peer.until_closed().await;
            }
        })
        .await;

        mock.ask("What is on my Mac's desktop?", Duration::from_millis(1_500))
            .await
            .unwrap();
        let answer = mock
            .ask("What does OS3 need?", Duration::from_millis(700))
            .await
            .unwrap();
        assert!(answer.contains(NEEDS_INPUT), "{answer}");
        assert!(
            answer.contains("OS3 asks: Which folder should I inspect?"),
            "{answer}"
        );
        assert!(
            !answer.contains("Unrelated background question"),
            "{answer}"
        );
        assert!(
            mock.sent()
                .iter()
                .all(|message| message.get("answeredCard").is_none()),
            "Luma never answers OS3 input on the owner's behalf"
        );
    }

    /// A form or confirmation created while Cosmos was disconnected is replayed
    /// through `session.history`. History entries use the same card contract as
    /// live chat messages, so each still has to tell the owner where to answer;
    /// Luma must never manufacture an `answeredCard` submission.
    #[tokio::test]
    async fn replayed_form_and_confirmation_cards_still_require_owner_input() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    let chat = peer.asked().await;
                    let (previous_boundary, card_id, kind, current_boundary) = if connection == 1 {
                        ("msg_user_1", "msg_form", "form", "msg_user_2")
                    } else {
                        ("msg_user_2", "msg_confirm", "confirm", "msg_user_3")
                    };
                    // Restore the oldest accepted echo while its known worker
                    // remains unresolved, alongside each later request/card.
                    let mut messages = vec![json!({"type": "chat.message", "messageId": "msg_user_1", "text": "What is on my Mac's desktop?", "role": "user"})];
                    if previous_boundary != "msg_user_1" {
                        messages.push(json!({"type": "chat.message", "messageId": previous_boundary, "text": "What form does OS3 need?", "role": "user"}));
                    }
                    messages.push(json!({"type": "chat.message", "messageId": card_id, "text": "", "role": "agent",
                        "cardSpec": {"root": ["owner-input"], "elements": {"owner-input": {"type": kind, "props": {}}}}}));
                    peer.send(json!({
                        "type": "session.history",
                        "version": 1,
                        "messages": messages
                    }))
                    .await;
                    peer.send(echo(current_boundary, &chat)).await;
                }
                peer.until_closed().await;
            }
        })
        .await;

        mock.ask("What is on my Mac's desktop?", Duration::from_millis(1_500))
            .await
            .unwrap();
        for question in ["What form does OS3 need?", "What should I confirm?"] {
            let answer = mock
                .ask(question, Duration::from_millis(700))
                .await
                .unwrap();
            assert!(answer.contains(NEEDS_INPUT), "{question}: {answer}");
        }
        assert!(
            mock.sent()
                .iter()
                .all(|message| message.get("answeredCard").is_none()),
            "Luma never answers a replayed card on the owner's behalf"
        );
    }

    #[test]
    fn an_unanswered_replayed_card_remains_pending_until_history_shows_its_answer() {
        let card = json!({
            "type": "chat.message",
            "messageId": "msg_form",
            "text": "",
            "role": "agent",
            "cardSpec": {"root": ["owner-input"], "elements": {
                "owner-input": {"type": "form", "props": {}}
            }}
        });
        let mut exchange = Exchange::new(Some(Unfinished {
            boundary: Some("msg_user".to_owned()),
            ..Unfinished::default()
        }));

        exchange.earlier_reply(&card, false);
        assert!(exchange.needs_input.is_some());

        // The first reconnect recorded the message ID, but the owner has not
        // answered it. A later replay must still expose the same handoff.
        exchange.needs_input = None;
        exchange.earlier_reply(&card, false);
        assert!(exchange.needs_input.is_some());

        // A user history entry whose answeredCard points at this message is the
        // verified signal that the form is no longer pending. Drive the real
        // snapshot parser so the protocol field, not a test-only flag, proves it.
        exchange.needs_input = None;
        exchange.boundary = Some("msg_current".to_owned());
        exchange.history(&[
            json!({"messageId": "msg_user", "role": "user", "text": "Earlier request"}),
            card,
            json!({
                "messageId": "msg_answer",
                "role": "user",
                "text": "Here is the form I filled in",
                "answeredCard": {
                    "messageId": "msg_form",
                    "elementId": "owner-input",
                    "value": {"kind": "form", "values": {"folder": "Documents"}}
                }
            }),
        ]);
        assert!(exchange.needs_input.is_none());
    }

    /// A snapshot can list the echo and its reply before the live echo
    /// arrives. The reply must still be found once. Absent own terminal work,
    /// the accepted request waits to its original deadline and stays unconfirmed.
    #[tokio::test]
    async fn a_snapshot_listing_the_echo_before_it_arrives_still_yields_the_reply() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            peer.send(json!({
                "type": "session.history",
                "version": 1,
                "messages": [
                    {"type": "chat.message", "messageId": "msg_old", "text": "Old", "role": "agent"},
                    {"type": "chat.message", "messageId": "msg_user", "text": chat["text"], "role": "user"},
                    {"type": "chat.message", "messageId": "msg_reply", "text": "Three files.", "role": "agent"},
                ],
            }))
            .await;
            peer.send(echo("msg_user", &chat)).await;
            // The early snapshot can be the only place the reply is listed.
            if chat["text"] != "Listed only in the snapshot?" {
                peer.send(agent_reply("msg_reply", "Three files.")).await;
            }
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        for question in ["How many files?", "Listed only in the snapshot?"] {
            let started = std::time::Instant::now();
            assert_eq!(
                mock.ask(question, Duration::from_millis(1500))
                    .await
                    .unwrap(),
                "OS3 replied: Three files.\nOS3 hasn't confirmed this request is complete.",
                "{question}"
            );
            assert!(
                started.elapsed() >= Duration::from_millis(1400),
                "{question}"
            );
            assert!(
                started.elapsed() < Duration::from_millis(2300),
                "{question}"
            );
        }
    }

    /// Background workers interleave with the question. A request for input
    /// from one that predates the question, or one sent before the echo, is
    /// not about this question and must not replace its answer.
    #[tokio::test]
    async fn ask_user_from_unrelated_work_does_not_end_the_exchange() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.send(json!({
                "type": "agent.list",
                "version": 1,
                "agents": [{"agentId": "agent_old", "title": "Pay the card bill", "state": "running", "createdAt": 1_600_000_000_000_i64}],
            }))
            .await;
            let chat = peer.asked().await;
            if chat["text"] == "Before the echo" {
                peer.send(worker_step("agent_new", json!({"kind": "ask_user", "text": "Who?"})))
                    .await;
                peer.send(echo("msg_user", &chat)).await;
            } else {
                peer.send(echo("msg_user", &chat)).await;
                peer.send(worker_step("agent_old", json!({"kind": "ask_user", "text": "Which card?"})))
                    .await;
            }
            peer.send(agent_reply("msg_reply", "Your laptop is charging.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        for question in ["From an older worker", "Before the echo"] {
            assert_eq!(
                mock.ask(question, Duration::from_secs(5)).await.unwrap(),
                "OS3 replied: Your laptop is charging.\nOS3 hasn't confirmed this request is complete.",
                "{question}"
            );
        }
    }

    /// The protocol has no client-generated correlation ID. The verified echo
    /// does repeat the submitted text, so an owner answering a card in OS3 at
    /// the same time must not become this client's durable question boundary.
    #[tokio::test]
    async fn a_concurrent_owner_submission_is_not_mistaken_for_the_question_echo() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            peer.send(json!({
                "type": "chat.message",
                "version": 1,
                "timestamp": 1_700_000_001_050_i64,
                "messageId": "msg_owner_answer",
                "text": "Inspect my Mac",
                "role": "user",
                "answeredCard": {
                    "messageId": "msg_form",
                    "elementId": "owner-input",
                    "value": {"kind": "form", "values": {"folder": "Documents"}}
                }
            }))
            .await;
            peer.send(echo("msg_question", &chat)).await;
            peer.send(agent_reply("msg_ack", "Let me check your Mac."))
                .await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                {"agentId": "agent_mac", "title": "Check the Mac", "state": "running",
                 "createdAt": 1_700_000_001_200_i64}
            ]}))
            .await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        let answer = mock
            .ask("Inspect my Mac", Duration::from_millis(700))
            .await
            .unwrap();
        assert!(answer.contains("Check the Mac"), "{answer}");
        assert_eq!(
            mock.conversation()
                .await
                .unfinished
                .and_then(|unfinished| unfinished.boundary)
                .as_deref(),
            Some("msg_question")
        );
    }

    #[test]
    fn recovery_requires_one_exact_timestamped_non_form_echo() {
        let asked_at = 1_700_000_001_000_i64;
        let request = "Inspect my Mac";
        let journal = InFlight {
            cancel: false,
            request_digest: request_digest(request, asked_at),
            asked_at,
        };
        let form_answer = json!({
            "type": "chat.message",
            "messageId": "msg_form_answer",
            "timestamp": asked_at + 1,
            "text": request,
            "role": "user",
            "answeredCard": {"messageId": "msg_form", "elementId": "answer"}
        });
        let exact_echo = json!({
            "type": "chat.message",
            "messageId": "msg_echo",
            "timestamp": asked_at,
            "text": request,
            "role": "user"
        });
        let history = |messages: Vec<Value>| json!({"type": "session.history", "version": 1, "messages": messages});

        assert_eq!(
            recovered_boundary(
                &history(vec![form_answer.clone(), exact_echo.clone()]),
                &journal
            ),
            Recovery::Echoed("msg_echo".to_owned(), asked_at)
        );
        assert_eq!(
            recovered_boundary(&history(vec![form_answer]), &journal),
            Recovery::NotReceived,
            "a form answer is not the echo, and nothing else is"
        );

        // Rabbit's clock may run a little behind this host's.
        let mut skewed = exact_echo.clone();
        skewed["timestamp"] = json!(asked_at - 1_000);
        assert_eq!(
            recovered_boundary(&history(vec![skewed]), &journal),
            Recovery::Echoed("msg_echo".to_owned(), asked_at - 1_000)
        );
        let mut earlier_question = exact_echo.clone();
        earlier_question["timestamp"] = json!(asked_at - RECOVERY_SKEW_MS - 1);
        assert_eq!(
            recovered_boundary(&history(vec![earlier_question]), &journal),
            Recovery::NotReceived,
            "the same words asked earlier are another question"
        );
        let mut no_timestamp = exact_echo.clone();
        no_timestamp.as_object_mut().unwrap().remove("timestamp");
        assert_eq!(
            recovered_boundary(&history(vec![no_timestamp]), &journal),
            Recovery::Unknown
        );

        let mut duplicate = exact_echo.clone();
        duplicate["messageId"] = json!("msg_echo_duplicate");
        duplicate["timestamp"] = json!(asked_at + 1);
        assert_eq!(
            recovered_boundary(&history(vec![exact_echo.clone(), duplicate]), &journal),
            Recovery::Unknown,
            "identical owner submissions are ambiguous"
        );
        let mut truncated = history(vec![exact_echo]);
        truncated[HISTORY_TRUNCATED] = json!(true);
        assert_eq!(recovered_boundary(&truncated, &journal), Recovery::Unknown);
        assert_eq!(
            recovered_boundary(&history(Vec::new()), &journal),
            Recovery::NotReceived
        );
    }

    /// Background activity is allowed to interleave. An unseen ID therefore
    /// stays provisional until an agent snapshot's creation time correlates it
    /// with this question. Old work is ignored, while out-of-order events for a
    /// genuinely new worker are retained until that classification arrives.
    #[test]
    fn out_of_order_agent_events_wait_for_identity_correlation() {
        let exchange = || {
            let mut exchange = Exchange::new(None);
            exchange.boundary = Some("msg_user".to_owned());
            exchange.boundary_at = 1_700_000_001_100_i64;
            exchange
        };
        let ask = |id: &str| {
            worker_step(
                id,
                json!({"kind": "ask_user", "text": "Which folder?", "sensitivity": "normal"}),
            )
        };
        let completed = |id: &str| {
            json!({
                "type": "agent.completed",
                "version": 1,
                "agentId": id,
                "fromState": "running",
                "ext": {"result": "Two folders.", "resultFiles": []}
            })
        };
        let listed = |id: &str, created_at: i64| {
            json!({"type": "agent.list", "version": 1, "agents": [{
                "agentId": id,
                "title": "Check the Mac",
                "state": "running",
                "createdAt": created_at
            }]})
        };

        let mut old = exchange();
        old.observe(&ask("agent_old"));
        old.observe(&completed("agent_old"));
        assert!(old.needs_input.is_none());
        assert!(old.lines.is_empty());
        assert!(
            old.checkpoint()
                .is_none_or(|unfinished| !unfinished.agents.contains_key("agent_old")),
            "an unknown background worker is never checkpointed by arrival order"
        );
        old.observe(&listed("agent_old", 1_600_000_000_000_i64));
        assert!(old.needs_input.is_none());
        assert!(old.lines.is_empty());
        assert!(
            old.checkpoint()
                .is_none_or(|unfinished| !unfinished.agents.contains_key("agent_old"))
        );

        let mut current_input = exchange();
        current_input.observe(&ask("agent_new_input"));
        assert!(current_input.needs_input.is_none());
        current_input.observe(&listed("agent_new_input", 1_700_000_001_200_i64));
        assert_eq!(current_input.needs_input.as_deref(), Some("Which folder?"));

        let mut current_completion = exchange();
        current_completion.observe(&completed("agent_new_completion"));
        assert!(current_completion.lines.is_empty());
        current_completion.observe(&listed("agent_new_completion", 1_700_000_001_200_i64));
        assert!(
            current_completion
                .lines
                .iter()
                .any(|line| line.contains("Two folders.")),
            "{:?}",
            current_completion.lines
        );
    }

    /// Agent snapshots and completion events reconcile by ID, not arrival
    /// order. Once an agent has ended, a delayed running snapshot cannot
    /// resurrect it and make a later follow-up wait on finished work.
    #[test]
    fn a_terminal_agent_cannot_be_resurrected_by_a_late_running_snapshot() {
        let mut exchange = Exchange::new(None);
        exchange.boundary = Some("msg_user".to_owned());
        exchange.boundary_at = 1_700_000_001_100_i64;
        let running = json!({"type": "agent.list", "version": 1, "agents": [{
            "agentId": "agent_mac",
            "title": "Check the Mac",
            "state": "running",
            "createdAt": 1_700_000_001_200_i64
        }]});
        exchange.observe(&running);
        exchange.observe(&json!({
            "type": "agent.completed",
            "version": 1,
            "agentId": "agent_mac",
            "fromState": "running",
            "ext": {"result": "Two folders.", "resultFiles": []}
        }));
        exchange.observe(&running);

        let agent = exchange.agents.get("agent_mac").unwrap();
        assert!(agent.ended);
        assert!(!agent.running);
        assert!(
            exchange
                .follow_up()
                .is_none_or(|unfinished| !unfinished.agents.contains_key("agent_mac"))
        );
    }

    /// `agent.list` and `agent.completed` are independent streams. A generic
    /// terminal snapshot may arrive first. The later completion's richer
    /// result replaces that exact agent's line rather than being dropped or
    /// changing another same-titled worker.
    #[test]
    fn a_late_completion_enriches_its_terminal_snapshot_by_agent_id() {
        let mut exchange = Exchange::new(None);
        exchange.boundary = Some("msg_user".to_owned());
        exchange.boundary_at = 1_700_000_001_100_i64;
        exchange.observe(&json!({"type": "agent.list", "version": 1, "agents": [
            {"agentId": "agent_other", "title": "Check the Mac", "state": "completed",
             "createdAt": 1_700_000_001_150_i64},
            {"agentId": "agent_mac", "title": "Check the Mac", "state": "completed",
             "createdAt": 1_700_000_001_200_i64}
        ]}));
        exchange.observe(&json!({
            "type": "agent.completed",
            "version": 1,
            "agentId": "agent_mac",
            "fromState": "running",
            "ext": {"result": "Two folders.", "resultFiles": []}
        }));

        assert_eq!(
            exchange.lines,
            vec![
                "OS3 finished \"Check the Mac\".".to_owned(),
                "OS3 finished \"Check the Mac\": Two folders.".to_owned()
            ]
        );
    }

    #[test]
    fn a_late_completion_keeps_a_carried_workers_saved_title() {
        let mut exchange = Exchange::new(Some(Unfinished {
            agents: HashMap::from([("agent_mac".to_owned(), "Check the Mac".to_owned())]),
            ..Unfinished::default()
        }));
        exchange.observe(&json!({"type": "agent.list", "version": 1, "agents": [{
            "agentId": "agent_mac",
            "title": "",
            "state": "completed"
        }]}));
        exchange.observe(&json!({
            "type": "agent.completed",
            "version": 1,
            "agentId": "agent_mac",
            "ext": {"result": "Two folders.", "resultFiles": []}
        }));

        assert_eq!(
            exchange.earlier,
            vec!["OS3 finished the earlier task \"Check the Mac\": Two folders.".to_owned()]
        );
    }

    /// A global idle can arrive before Rabbit's independently delivered worker
    /// snapshot. Once that snapshot correlates a current worker, the short
    /// pre-correlation timer must no longer hold a later terminal result open.
    #[test]
    fn a_correlated_worker_clears_the_idle_correlation_timer() {
        let mut exchange = Exchange {
            asked_at: 1_700_000_001_000_i64,
            request: "Inspect my Mac".to_owned(),
            ..Exchange::new(None)
        };
        exchange.observe(&echo("msg_user", &json!({"text": "Inspect my Mac"})));
        exchange.observe(&agent_reply("msg_ack", "Let me check your Mac."));
        exchange.observe(&idle());
        assert!(exchange.correlation_until.is_some());

        exchange.observe(&json!({"type": "agent.list", "version": 1, "agents": [{
            "agentId": "agent_mac",
            "title": "Inspect the Mac",
            "state": "running",
            "createdAt": 1_700_000_001_200_i64
        }]}));
        exchange.observe(&json!({
            "type": "agent.completed",
            "version": 1,
            "agentId": "agent_mac",
            "fromState": "running",
            "ext": {"result": "Done.", "resultFiles": []}
        }));
        exchange.observe(&idle());

        assert!(exchange.done(), "terminal work should settle immediately");
        assert!(exchange.follow_up().is_none());
    }

    /// A task reaction is tied to this question, while idle is global and an
    /// agent snapshot is delivered independently. The idle must not close the
    /// exchange before a slightly delayed current worker can be correlated.
    #[tokio::test]
    async fn a_task_reaction_waits_briefly_for_the_worker_snapshot_after_idle() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(agent_reply("msg_ack", "Let me check your Mac."))
                .await;
            peer.send(json!({
                "type": "chat.reaction",
                "version": 1,
                "messageId": "msg_user",
                "reaction": "task"
            }))
            .await;
            peer.send(idle()).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                "agentId": "agent_mac",
                "title": "Check the Mac",
                "state": "running",
                "createdAt": 1_700_000_001_200_i64
            }]}))
            .await;
            peer.until_closed().await;
        })
        .await;

        let answer = mock
            .ask("Inspect my Mac", Duration::from_millis(1_200))
            .await
            .unwrap();
        assert!(
            answer.contains("OS3 replied: Let me check your Mac."),
            "{answer}"
        );
        assert!(
            answer.contains("OS3 is still working on: Check the Mac."),
            "{answer}"
        );
        assert_eq!(
            mock.conversation()
                .await
                .unfinished
                .and_then(|unfinished| unfinished.agents.get("agent_mac").cloned())
                .as_deref(),
            Some("Check the Mac")
        );
    }

    /// Idle is unscoped and can beat the current message's scoped task
    /// reaction. A short pre-evidence grace keeps the socket open for that
    /// reorder. Once the reaction arrives, the independently delivered worker
    /// snapshot is awaited to the normal question deadline.
    #[tokio::test]
    async fn idle_before_the_task_reaction_does_not_hide_its_worker() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(agent_reply("msg_ack", "Let me check your Mac."))
                .await;
            peer.send(idle()).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            peer.send(json!({
                "type": "chat.reaction",
                "version": 1,
                "messageId": "msg_user",
                "reaction": "task"
            }))
            .await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                "agentId": "agent_mac",
                "title": "Check the Mac",
                "state": "running",
                "createdAt": 1_700_000_001_200_i64
            }]}))
            .await;
            peer.until_closed().await;
        })
        .await;

        let answer = mock
            .ask("Inspect my Mac", Duration::from_millis(1_200))
            .await
            .unwrap();
        assert!(
            answer.contains("OS3 is still working on: Check the Mac."),
            "{answer}"
        );
    }

    // INFERRED bounded-session policy: the owner delegates a foreground task;
    // optional/independently delivered Rabbit metadata cannot make ACK+idle a
    // terminal result. Real loopback HTTP/WebSocket fixtures, never recordings.
    const BOUNDED_RESULT: &str =
        "Battery 82%. monthly_report_final.csv. 2*3 + 4*5 = 26. Fresh marker LUMA-BOUNDED.";
    const BOUNDED_UNCONFIRMED: &str = "OS3 hasn't confirmed this request is complete.";

    async fn seed_bounded_work(mock: &Mock, known: bool) {
        assert!(
            mock.saved
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_a".to_owned()),
                    unfinished: Some(Unfinished {
                        boundary: Some("msg_original".to_owned()),
                        agents: if known {
                            HashMap::from([(
                                "agent_original".to_owned(),
                                "Original Mac task".to_owned(),
                            )])
                        } else {
                            HashMap::new()
                        },
                        ..Unfinished::default()
                    }),
                    ..Conversation::default()
                })
                .await
        );
    }

    async fn bounded_session_workflow(shape: &'static str) {
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| async move {
    peer.ack("session_a").await;
    let chat = if matches!(shape, "status_unknown" | "status_known" | "status_empty") {
        peer.send(json!({"type":"session.history","messages":[{"type":"chat.message","messageId":"msg_original","role":"user","text":"Original Mac task"}]})).await;
        None
    } else { Some(peer.question("msg_user").await) };
    peer.send(agent_reply("msg_ack", "Let me check.")).await;
    if shape == "previous_terminal" {
        peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
            "agentId": "agent_original", "title": "Original Mac task", "state": "completed", "createdAt": 1_600_000_000_000_i64
        }]})).await;
    }
    if shape == "status_known" {
        peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
            "agentId": "agent_unrelated", "title": "Different work", "state": "completed", "createdAt": 1_700_000_001_200_i64
        }]})).await;
    }
    peer.send(idle()).await;
    if matches!(shape, "late_markers" | "late_marker_free" | "status_unknown" | "status_known") {
        tokio::time::sleep(Duration::from_millis(1100)).await;
        if matches!(shape, "late_markers" | "status_known") {
            if shape == "late_markers" {
                peer.send(json!({"type": "chat.reaction", "messageId": "msg_user", "reaction": "task"})).await;
                peer.send(json!({"type": "agent.list", "agents": [{
                    "agentId": "agent_current", "title": "Read the Mac", "state": "running", "createdAt": 1_700_000_001_200_i64
                }]})).await;
            }
            peer.send(json!({"type": "agent.completed", "agentId": if shape == "status_known" { "agent_original" } else { "agent_current" },
                "ext": {"result": BOUNDED_RESULT, "resultFiles": []}})).await;
        } else if shape == "status_unknown" {
            peer.send(json!({"type": "session.history", "messages": [
                {"type": "chat.message", "role": "user", "messageId": "msg_original", "text": "Original Mac task"},
                {"type": "chat.message", "role": "agent", "messageId": "msg_result", "text": BOUNDED_RESULT},
            ]})).await;
        } else {
            peer.send(agent_reply("msg_result", BOUNDED_RESULT)).await;
            // Snapshot repeats must not duplicate the late actual reply.
            let history = json!({"type": "session.history", "messages": [echo("msg_user", chat.as_ref().expect("new Ask chat")),
                agent_reply("msg_ack", "Let me check."), agent_reply("msg_result", BOUNDED_RESULT)]});
            peer.send(history.clone()).await;
            peer.send(history).await;
        }
        peer.send(idle()).await;
    }
    peer.until_closed().await;
}).await;
        let retained = matches!(
            shape,
            "status_unknown" | "status_known" | "previous_terminal"
        );
        if retained {
            seed_bounded_work(&mock, shape != "status_unknown").await;
        }
        let question = if matches!(shape, "status_unknown" | "status_known" | "status_empty") {
            "What did OS3 find?"
        } else {
            "Ask OS3 to read my Mac battery"
        };
        let started = Instant::now();
        let answer = mock
            .ask(question, Duration::from_millis(2100))
            .await
            .unwrap();
        if matches!(
            shape,
            "late_markers" | "late_marker_free" | "status_unknown" | "status_known"
        ) {
            assert!(answer.contains(BOUNDED_RESULT), "{shape}: {answer}");
            assert_eq!(
                answer.matches("Fresh marker LUMA-BOUNDED.").count(),
                1,
                "{shape}: {answer}"
            );
        }
        if matches!(
            shape,
            "ack_only" | "late_marker_free" | "status_unknown" | "previous_terminal"
        ) {
            assert!(
                started.elapsed() >= Duration::from_millis(1900),
                "{shape}: premature end at {:?}: {answer}",
                started.elapsed()
            );
            assert!(answer.contains(BOUNDED_UNCONFIRMED), "{shape}: {answer}");
            let unfinished = mock
                .conversation()
                .await
                .unfinished
                .expect("accepted marker-free boundary remains recoverable");
            assert_eq!(
                unfinished.boundary.as_deref(),
                Some(if shape == "status_unknown" {
                    "msg_original"
                } else {
                    "msg_user"
                })
            );
            assert!(unfinished.agents.is_empty());
        }
        if shape == "status_empty" {
            assert!(
                started.elapsed() < Duration::from_millis(1300),
                "status without work changed"
            );
            assert!(!answer.contains(BOUNDED_UNCONFIRMED));
        }
        if matches!(shape, "late_markers" | "status_known") {
            assert!(
                started.elapsed() < Duration::from_millis(1700),
                "confirmed own worker should end promptly"
            );
            assert!(!answer.contains(BOUNDED_UNCONFIRMED));
        }
        assert!(
            started.elapsed() < Duration::from_millis(2800),
            "absolute test deadline expanded"
        );
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            if matches!(shape, "status_unknown" | "status_known" | "status_empty") {
                0
            } else {
                1
            }
        );
    }

    #[tokio::test]
    async fn bounded_session_delayed_task_metadata_survives_ack_idle() {
        bounded_session_workflow("late_markers").await;
    }
    #[tokio::test]
    async fn bounded_session_optional_metadata_absent_gets_later_actual_reply() {
        bounded_session_workflow("late_marker_free").await;
    }
    #[tokio::test]
    async fn bounded_session_ack_only_preserves_boundary_at_deadline() {
        bounded_session_workflow("ack_only").await;
    }
    #[tokio::test]
    async fn bounded_session_status_unknown_keeps_waiting_for_late_original_result() {
        bounded_session_workflow("status_unknown").await;
    }
    #[tokio::test]
    async fn bounded_session_status_known_ignores_unrelated_terminal_until_original_finishes() {
        bounded_session_workflow("status_known").await;
    }
    #[tokio::test]
    async fn bounded_session_ask_cannot_end_on_previous_worker_terminal() {
        bounded_session_workflow("previous_terminal").await;
    }
    #[tokio::test]
    async fn bounded_session_status_without_retained_work_stays_prompt() {
        bounded_session_workflow("status_empty").await;
    }

    #[tokio::test]
    async fn bounded_session_status_finishes_on_original_identity_despite_new_running_work() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
    peer.ack("session_a").await;
    peer.send(json!({"type":"session.history","messages":[{"type":"chat.message","messageId":"msg_original","role":"user","text":"Original Mac task"}]})).await;
    peer.send(agent_reply("msg_ack", "Checking.")).await;
    peer.send(json!({"type": "agent.list", "agents": [{"agentId": "agent_other", "title": "Other work", "state": "running", "createdAt": 1_700_000_001_200_i64}]})).await;
    peer.send(json!({"type": "agent.completed", "agentId": "agent_original", "ext": {"result": BOUNDED_RESULT, "resultFiles": []}})).await;
    peer.send(idle()).await;
    peer.until_closed().await;
}).await;
        seed_bounded_work(&mock, true).await;
        let started = Instant::now();
        let answer = mock
            .ask("What did OS3 find?", Duration::from_secs(2))
            .await
            .unwrap();
        assert!(answer.contains(BOUNDED_RESULT), "{answer}");
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "original terminal identity did not release status wait"
        );
    }

    #[tokio::test]
    async fn bounded_session_marker_free_cancel_yields_saved_wait_without_claiming_stop() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = Arc::new(
            mock(StatusCode::OK, "instance-1", move |mut peer| {
                let number = connection.fetch_add(1, Ordering::SeqCst);
                async move {
                    peer.ack("session_a").await;
                    peer.question(if number == 0 {
                        "msg_original"
                    } else {
                        "msg_stop"
                    })
                    .await;
                    peer.send(agent_reply(
                        if number == 0 {
                            "msg_ack"
                        } else {
                            "msg_stop_ack"
                        },
                        "Received.",
                    ))
                    .await;
                    peer.send(idle()).await;
                    peer.until_closed().await;
                }
            })
            .await,
        );
        let first_mock = mock.clone();
        let first = tokio::spawn(async move {
            first_mock
                .ask("Ask OS3 to read my Mac battery", Duration::from_secs(10))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if mock
                    .conversation()
                    .await
                    .unfinished
                    .as_ref()
                    .and_then(|u| u.boundary.as_deref())
                    == Some("msg_original")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert!(
            !first.is_finished(),
            "ACK+idle ended the ordinary wait before cancellation"
        );
        let stop = mock
            .ask("Cancel OS3", Duration::from_secs(4))
            .await
            .unwrap();
        assert!(stop.starts_with("Stop requested."), "{stop}");
        assert!(!stop.contains("OS3 stopped your task"));
        assert!(matches!(first.await.unwrap(), Err(Os3Error::Superseded)));
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn bounded_session_lost_non_cancel_journal_recovery_waits_for_original_result() {
        let connection = Arc::new(AtomicUsize::new(0));
        let submitted = Arc::new(Mutex::new(None::<Value>));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
    let number = connection.fetch_add(1, Ordering::SeqCst);
    let submitted = submitted.clone();
    async move {
        peer.ack("session_a").await;
        if number == 0 {
            *submitted.lock().unwrap() = Some(peer.asked().await);
            let _ = peer.socket.send(Message::Close(None)).await;
            return;
        }
        let first = submitted.lock().unwrap().clone().unwrap();
        let mut user = echo("msg_original", &first);
        user["timestamp"] = json!(first["timestamp"].as_i64().unwrap() + 10);
        peer.send(json!({"type": "session.history", "messages": [user, agent_reply("msg_ack", "Received.")]})).await;
        peer.send(idle()).await;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        peer.send(agent_reply("msg_result", BOUNDED_RESULT)).await;
        peer.send(idle()).await;
        peer.until_closed().await;
    }
}).await;
        assert!(
            mock.ask("Ask OS3 to read my Mac battery", Duration::from_secs(2))
                .await
                .is_err()
        );
        assert!(mock.conversation().await.in_flight.is_some());
        let started = Instant::now();
        let answer = mock
            .ask("What did OS3 find?", Duration::from_secs(2))
            .await
            .unwrap();
        assert!(answer.contains(BOUNDED_RESULT), "{answer}");
        assert!(answer.contains(BOUNDED_UNCONFIRMED), "{answer}");
        assert!(started.elapsed() >= Duration::from_millis(1800));
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            1,
            "accepted original must never be resubmitted"
        );
        assert_eq!(
            mock.conversation()
                .await
                .unfinished
                .and_then(|u| u.boundary)
                .as_deref(),
            Some("msg_original")
        );
    }

    // Explicit test-first follow-up to independent review: an older live
    // worker's separate chat relay precedes the newer request in history.
    #[tokio::test]
    async fn bounded_session_new_ask_preserves_oldest_running_work_relay_boundary() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let number = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if number == 0 { peer.question("msg_new").await; }
                if number == 0 {
                    peer.send(agent_reply("msg_new_ack", "Received new question.")).await;
                } else {
                    let history = json!({"type": "session.history", "messages": [
                        {"type": "chat.message", "role": "user", "messageId": "msg_original", "text": "Original Mac task"},
                        agent_reply("msg_original_result", BOUNDED_RESULT),
                        {"type": "chat.message", "role": "user", "messageId": "msg_new", "text": "Ask OS3 to read another Mac file"},
                        agent_reply("msg_new_ack", "Received new question.")
                    ]});
                    peer.send(history.clone()).await;
                    peer.send(history).await;
                    peer.send(json!({"type": "agent.completed", "agentId": "agent_original", "ext": {"result": "", "resultFiles": []}})).await;

                }
                peer.send(idle()).await;
                peer.until_closed().await;
            }
        }).await;
        seed_bounded_work(&mock, true).await;
        let first = mock
            .ask("Ask OS3 to read another Mac file", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(first.contains(BOUNDED_UNCONFIRMED), "{first}");
        let unfinished = mock
            .conversation()
            .await
            .unfinished
            .expect("unfinished original and new work");
        assert_eq!(
            unfinished.boundary.as_deref(),
            Some("msg_original"),
            "final save replaced the oldest accepted running-work boundary"
        );
        assert!(unfinished.agents.contains_key("agent_original"));
        let answer = mock
            .ask("What did OS3 find?", Duration::from_secs(2))
            .await
            .unwrap();
        assert!(answer.contains(BOUNDED_RESULT), "{answer}");
        assert_eq!(answer.matches("Fresh marker LUMA-BOUNDED.").count(), 1);
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|m| m["type"] == "chat.message"
                    && m["text"] == "Ask OS3 to read another Mac file")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn bounded_session_marker_free_timeout_reconnect_reads_late_history_once() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
    let number = connection.fetch_add(1, Ordering::SeqCst);
    async move {
        peer.ack("session_a").await;
        if number == 0 { peer.question("msg_original").await; }
        if number == 0 {
            peer.send(agent_reply("msg_ack", "Received.")).await;
        } else {
            let history = json!({"type": "session.history", "messages": [
                {"type": "chat.message", "role": "user", "messageId": "msg_original", "text": "Ask OS3 to read my Mac battery"},
                agent_reply("msg_ack", "Received."), agent_reply("msg_result", BOUNDED_RESULT)]});
            peer.send(history.clone()).await;
            peer.send(history).await;

        }
        peer.send(idle()).await;
        peer.until_closed().await;
    }
}).await;
        let first = mock
            .ask("Ask OS3 to read my Mac battery", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(first.contains(BOUNDED_UNCONFIRMED), "{first}");
        let result = mock
            .ask("What did OS3 find?", Duration::from_millis(1200))
            .await
            .unwrap();
        assert!(result.contains(BOUNDED_RESULT), "{result}");
        assert_eq!(result.matches("Fresh marker LUMA-BOUNDED.").count(), 1);
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|m| m["type"] == "chat.message"
                    && m["text"] == "Ask OS3 to read my Mac battery")
                .count(),
            1
        );
    }

    // Defensive partial-record recovery (INFERRED): the reference's complete
    // list records carry createdAt, but omission must not erase earlier evidence
    // or prevent later valid metadata from scoping a terminal state.
    async fn partial_worker_metadata_workflow(shape: &'static str, terminal: &'static str) {
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            let mut first = json!({"agentId": "agent_mac", "state": terminal});
            if shape == "running_partial" {
                first["state"] = json!("running");
                first["title"] = json!("Read the Mac battery");
                first["createdAt"] = json!(1_700_000_001_200_i64);
            }
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [first]})).await;
            if shape == "echo_before_metadata" {
                peer.send(echo("msg_user", &chat)).await;
            }
            if shape != "missing_only" {
                let mut second = json!({"agentId": "agent_mac", "title": "Read the Mac battery", "state": "running",
                    "createdAt": if shape == "older_metadata" { 1_600_000_000_000_i64 } else { 1_700_000_001_200_i64 }});
                if shape == "running_partial" {
                    second.as_object_mut().unwrap().remove("createdAt");
                    second.as_object_mut().unwrap().remove("title");
                }
                peer.send(json!({"type": "agent.list", "version": 1, "agents": [second]})).await;
            }
            if shape != "echo_before_metadata" {
                peer.send(echo("msg_user", &chat)).await;
            }
            peer.send(json!({"type": "agent.completed", "version": 1,
                "agentId": "agent_mac", "fromState": "running",
                "ext": {"result": "Battery 82%. Fresh marker LUMA-PARTIAL.", "resultFiles": []}})).await;
            peer.send(agent_reply("msg_ack", "Let me check your Mac.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        }).await;
        let answer = mock
            .ask("Ask OS3 to read my Mac battery", Duration::from_secs(2))
            .await
            .unwrap();
        if matches!(shape, "older_metadata" | "missing_only") {
            assert!(
                !answer.contains("Battery 82%")
                    && !answer.contains("OS3 finished")
                    && !answer.contains("could not finish")
                    && !answer.contains("still working"),
                "{shape}/{terminal}: {answer}"
            );
        } else if matches!(terminal, "failed" | "canceled") && shape != "running_partial" {
            assert!(
                answer.contains("OS3 could not finish \"Read the Mac battery\"")
                    && !answer.contains("Battery 82%")
                    && !answer.contains("still working"),
                "{shape}/{terminal}: {answer}"
            );
        } else {
            assert!(
                answer.contains("Battery 82%. Fresh marker LUMA-PARTIAL.")
                    && answer.contains("Read the Mac battery")
                    && !answer.contains("still working"),
                "{shape}/{terminal}: {answer}"
            );
        }
    }

    #[tokio::test]
    async fn partial_worker_terminal_before_timed_running_echo() {
        for state in ["completed", "failed", "canceled"] {
            partial_worker_metadata_workflow("metadata_before_echo", state).await;
        }
    }
    #[tokio::test]
    async fn partial_worker_terminal_echo_before_timed_running() {
        for state in ["completed", "failed", "canceled"] {
            partial_worker_metadata_workflow("echo_before_metadata", state).await;
        }
    }
    #[tokio::test]
    async fn partial_worker_timed_running_partial_echo() {
        partial_worker_metadata_workflow("running_partial", "running").await;
    }
    #[tokio::test]
    async fn partial_worker_missing_timestamp_only_not_attributed() {
        partial_worker_metadata_workflow("missing_only", "completed").await;
    }
    #[tokio::test]
    async fn partial_worker_old_timestamp_terminal_not_attributed() {
        partial_worker_metadata_workflow("older_metadata", "completed").await;
    }

    // Owner OS3 API reference §2/5: agent.list, completion and activity are
    // independently delivered. Synthetic/unrecorded HTTP/WebSocket sequences
    // verify correlation by exact echo, createdAt and already retained IDs.
    async fn pre_echo_worker_workflow(shape: &'static str) {
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            let completion = json!({"type": "agent.completed", "version": 1,
                "agentId": "agent_mac", "fromState": "running",
                "ext": {"result": "Battery 82%. Fresh marker LUMA-WORKER-ORDER.", "resultFiles": []}});
            if matches!(shape, "completion_list_echo" | "input_list_echo" | "older" | "missing_time") {
                if shape != "completion_list_echo" {
                    peer.send(json!({"type": "activity.summary", "version": 1,
                        "agentId": "agent_mac", "steps": [{"kind": "ask_user", "text": "Which Mac should I inspect?"}]})).await;
                }
                if shape != "input_list_echo" {
                    peer.send(completion.clone()).await;
                }
            }
            let state = match shape {
                "completed" => "completed",
                "failed" => "failed",
                "canceled" => "canceled",
                _ => "running",
            };
            let mut record = json!({"agentId": "agent_mac", "title": "Read the Mac battery", "state": state,
                "createdAt": if shape == "older" { 1_600_000_000_000_i64 } else { 1_700_000_001_200_i64 }});
            if shape == "missing_time" {
                record.as_object_mut().unwrap().remove("createdAt");
            }
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [record.clone()]})).await;
            if matches!(shape, "list_completion_echo" | "failed" | "canceled" | "previous") {
                peer.send(completion.clone()).await;
            }
            if matches!(shape, "completed" | "failed" | "canceled") {
                // A stale running snapshot must not overwrite the terminal one.
                record["state"] = json!("running");
                peer.send(json!({"type": "agent.list", "version": 1, "agents": [record]})).await;
            }
            peer.send(echo("msg_user", &chat)).await;
            if shape == "list_echo_completion" {
                peer.send(completion).await;
            }
            peer.send(agent_reply("msg_ack", "Let me check your Mac.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        }).await;
        if shape == "previous" {
            assert!(
                mock.saved
                    .save(&Conversation {
                        cookie: Some(cookie_digest(COOKIE_VALUE)),
                        session_id: Some("session_a".to_owned()),
                        unfinished: Some(Unfinished {
                            boundary: Some("msg_previous".to_owned()),
                            agents: HashMap::from([(
                                "agent_mac".to_owned(),
                                "Read the Mac battery".to_owned()
                            )]),
                            ..Unfinished::default()
                        }),
                        ..Conversation::default()
                    })
                    .await
            );
        }
        let answer = mock
            .ask("Ask OS3 to read my Mac battery", Duration::from_secs(2))
            .await
            .unwrap();
        match shape {
            "input_list_echo" => assert!(
                answer.contains("OS3 asks: Which Mac should I inspect?"),
                "{shape}: {answer}"
            ),
            "older" | "missing_time" => {
                assert!(
                    !answer.contains("Battery 82%")
                        && !answer.contains(NEEDS_INPUT)
                        && !answer.contains("still working"),
                    "{shape}: {answer}"
                );
            }
            "completed" => assert!(
                answer.contains("OS3 finished \"Read the Mac battery\"")
                    && !answer.contains("still working"),
                "{shape}: {answer}"
            ),
            "failed" | "canceled" => assert!(
                answer.contains("OS3 could not finish \"Read the Mac battery\"")
                    && !answer.contains("Battery 82%")
                    && !answer.contains("still working"),
                "{shape}: {answer}"
            ),
            "previous" => assert!(
                answer.contains("OS3 finished the earlier task")
                    && answer.contains("Battery 82%")
                    && !answer.contains("OS3 finished \"Read the Mac battery\""),
                "{shape}: {answer}"
            ),
            _ => assert!(
                answer.contains("Battery 82%. Fresh marker LUMA-WORKER-ORDER."),
                "{shape}: {answer}"
            ),
        }
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn pre_echo_worker_list_echo_completion() {
        pre_echo_worker_workflow("list_echo_completion").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_list_completion_echo() {
        pre_echo_worker_workflow("list_completion_echo").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_completion_list_echo() {
        pre_echo_worker_workflow("completion_list_echo").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_input_list_echo() {
        pre_echo_worker_workflow("input_list_echo").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_completed_snapshot() {
        pre_echo_worker_workflow("completed").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_failed_snapshot() {
        pre_echo_worker_workflow("failed").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_canceled_snapshot() {
        pre_echo_worker_workflow("canceled").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_older_snapshot_not_current() {
        pre_echo_worker_workflow("older").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_missing_timestamp_not_current() {
        pre_echo_worker_workflow("missing_time").await;
    }
    #[tokio::test]
    async fn pre_echo_worker_previous_known_id_stays_previous() {
        pre_echo_worker_workflow("previous").await;
    }

    // Owner OS3 API reference §2: reactions match messageId and chat.message
    // has an optional reaction field. Synthetic, unrecorded loopback workflows
    // exercise independent delivery and repeated history, never reply prose.
    async fn scoped_task_reaction_workflow(shape: &'static str) {
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            if shape == "before_echo" || shape == "unrelated" {
                peer.send(json!({"type": "chat.reaction", "version": 1,
                    "messageId": if shape == "unrelated" { "msg_old" } else { "msg_user" },
                    "reaction": "task"})).await;
            }
            let mut user = echo("msg_user", &chat);
            if shape == "inline" {
                user["reaction"] = json!("task");
            }
            peer.send(user.clone()).await;
            if shape == "history" {
                user["reaction"] = json!("task");
                let history = json!({"type": "session.history", "version": 1,
                    "messages": [
                        {"type": "chat.message", "role": "user", "messageId": "msg_old", "text": "Older task", "reaction": "task"},
                        user
                    ]});
                peer.send(history.clone()).await;
                peer.send(history).await;
            }
            peer.send(agent_reply("msg_ack", "Let me check your Mac.")).await;
            peer.send(idle()).await;
            if shape == "unrelated" {
                peer.until_closed().await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(1100)).await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                "agentId": "agent_mac", "title": "Read the Mac battery", "state": "running",
                "createdAt": 1_700_000_001_200_i64
            }]})).await;
            peer.send(json!({"type": "agent.completed", "version": 1,
                "agentId": "agent_mac", "fromState": "running",
                "ext": {"result": "Battery 82%. Fresh marker LUMA-REACTION.", "resultFiles": []}
            })).await;
            peer.send(agent_reply("msg_result", "Battery 82%. Fresh marker LUMA-REACTION.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        }).await;
        let started = Instant::now();
        let answer = mock
            .ask("Ask OS3 to read my Mac battery", Duration::from_secs(4))
            .await
            .unwrap();
        if shape == "unrelated" {
            assert!(
                answer.contains(BOUNDED_UNCONFIRMED) && !answer.contains("Battery 82%"),
                "{answer}"
            );
            assert!(
                started.elapsed() >= Duration::from_millis(3800)
                    && started.elapsed() < Duration::from_millis(4700),
                "ordinary Ask follows its absolute deadline independently of unrelated reaction"
            );
        } else {
            assert!(
                answer.contains("Battery 82%. Fresh marker LUMA-REACTION."),
                "{shape}: {answer}"
            );
            assert_eq!(
                answer
                    .matches("OS3 replied: Let me check your Mac.")
                    .count(),
                1
            );
        }
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            1
        );
        if shape == "unrelated" {
            let work = mock
                .conversation()
                .await
                .unfinished
                .expect("unconfirmed accepted Ask retained");
            assert_eq!(work.boundary.as_deref(), Some("msg_user"));
            assert!(work.agents.is_empty());
        } else {
            assert!(mock.conversation().await.unfinished.is_none());
        }
    }

    #[tokio::test]
    async fn scoped_task_reaction_before_echo_keeps_the_same_turn_open() {
        scoped_task_reaction_workflow("before_echo").await;
    }

    #[tokio::test]
    async fn scoped_task_reaction_inline_echo_keeps_the_same_turn_open() {
        scoped_task_reaction_workflow("inline").await;
    }

    #[tokio::test]
    async fn scoped_task_reaction_repeated_history_keeps_the_same_turn_open() {
        scoped_task_reaction_workflow("history").await;
    }

    #[tokio::test]
    async fn scoped_task_reaction_unrelated_message_does_not_keep_chat_open() {
        scoped_task_reaction_workflow("unrelated").await;
    }

    /// A task reaction without a correlated worker is not proof of one. It
    /// keeps the accepted task open within the caller's deadline. An unscoped
    /// idle cannot claim that work is complete.
    #[test]
    fn a_task_reaction_without_a_worker_stays_pending_within_the_turn() {
        let mut exchange = Exchange::new(None);
        exchange.boundary = Some("msg_user".to_owned());
        exchange.request = "Inspect my Mac".to_owned();
        exchange.reply(&agent_reply("msg_ack", "Let me check your Mac."), false);
        exchange.observe(&json!({
            "type": "chat.reaction",
            "messageId": "msg_user",
            "reaction": "task"
        }));
        exchange.observe(&idle());

        assert!(!exchange.finished);
        assert!(
            exchange.correlation_deadline().is_none(),
            "a scoped task uses the remaining caller deadline, not the plain-chat grace"
        );
        assert!(
            exchange
                .render()
                .unwrap()
                .contains("OS3 hasn't confirmed this task is finished."),
        );
        assert_eq!(
            exchange
                .follow_up()
                .and_then(|unfinished| unfinished.boundary)
                .as_deref(),
            Some("msg_user")
        );
    }

    /// INFERRED Rabbit protocol. An unrecorded HTTP/WebSocket fixture delays
    /// a timestamp-correlated worker beyond the initial idle/acknowledgement.
    /// Keep the same foreground call open for its actual result, rather than
    /// treating the independently delivered idle as task completion.
    #[tokio::test]
    async fn a_delayed_mac_task_finishes_in_the_same_foreground_exchange() {
        for idle_before_reaction in [false, true] {
            let mock = mock(StatusCode::OK, "instance-1", move |mut peer| async move {
                peer.ack("session_a").await;
                peer.question("msg_user").await;
                peer.send(agent_reply("msg_ack", "Let me check your Mac.")).await;
                if idle_before_reaction {
                    peer.send(idle()).await;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                peer.send(json!({"type": "chat.reaction", "version": 1,
                    "messageId": "msg_user", "reaction": "task"})).await;
                peer.send(idle()).await;
                peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                    "agentId": "agent_old", "title": "Unrelated work", "state": "running",
                    "createdAt": 1_600_000_000_000_i64
                }]})).await;
                tokio::time::sleep(Duration::from_millis(1100)).await;
                peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                    "agentId": "agent_mac", "title": "Read the Mac battery", "state": "running",
                    "createdAt": 1_700_000_001_200_i64
                }]})).await;
                peer.send(json!({"type": "agent.completed", "version": 1,
                    "agentId": "agent_mac", "fromState": "running",
                    "ext": {"result": "Battery 82%. Fresh marker LUMA-SAME-TURN.", "resultFiles": []}
                })).await;
                peer.send(agent_reply("msg_result", "Battery 82%. Fresh marker LUMA-SAME-TURN.")).await;
                peer.send(idle()).await;
                peer.until_closed().await;
            }).await;

            let started = Instant::now();
            let answer = mock
                .ask("Ask OS3 to read my Mac battery", Duration::from_secs(4))
                .await
                .unwrap();
            assert!(
                answer.contains("Battery 82%. Fresh marker LUMA-SAME-TURN."),
                "{answer}"
            );
            assert!(!answer.contains("still working"), "{answer}");
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "completion should end this call promptly"
            );
            assert_eq!(
                mock.sent()
                    .iter()
                    .filter(|message| message["type"] == "chat.message")
                    .count(),
                1
            );
            assert!(mock.conversation().await.unfinished.is_none());
        }
    }

    /// INFERRED Rabbit protocol. An unrecorded HTTP/WebSocket fixture delays
    /// worker/history delivery beyond the bounded correlation grace. The exact
    /// task reaction retains the accepted boundary without inventing a worker.
    #[tokio::test]
    async fn a_late_worker_after_correlation_grace_keeps_its_follow_up_boundary() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    peer.question("msg_user_1").await;
                    peer.send(agent_reply("msg_ack", "Let me check your Mac.")).await;
                    peer.send(json!({"type": "chat.reaction", "version": 1, "timestamp": 1_700_000_001_200_i64, "messageId": "msg_user_1", "reaction": "task"})).await;
                    peer.send(json!({"type": "agent.list", "version": 1, "timestamp": 1_700_000_003_000_i64, "agents": [{
                        "agentId": "agent_old", "title": "Unrelated old task", "state": "running", "startedInHouse": false, "createdAt": 1_600_000_000_000_i64
                    }]})).await;
                    peer.send(idle()).await;
                } else if connection < 4 {
                    let mut history = late_history();
                    history["messages"].as_array_mut().unwrap().pop();
                    peer.send(history).await;
                    // This late running worker was created after the original
                    // echo but before this read-only status check. With no carried ID it
                    // must not be invented as the retained task's worker.
                    peer.send(json!({"type": "agent.list", "version": 1, "timestamp": 1_700_000_011_000_i64,
                        "agents": [{"agentId": "agent_mac", "title": "Check the Mac", "state": "running",
                            "startedInHouse": false, "createdAt": 1_700_000_001_200_i64}]})).await;
                    peer.send(agent_reply(&format!("msg_status_ack_{connection}"), "Still checking.")).await;
                    // The second status never reaches its idle before the
                    // caller deadline. The check must not replace older work.
                    if connection == 1 {
                        peer.send(idle()).await;
                    } else if connection == 3 {
                        let _ = peer.socket.send(Message::Close(None)).await;
                        return;
                    }
                } else {
                    // Rabbit completed this after the first socket's grace
                    // expired. Old task/reply data remains unrelated.
                    peer.send(json!({"type": "agent.list", "version": 1, "timestamp": 1_700_000_003_000_i64, "agents": [
                        {"agentId": "agent_old", "title": "Unrelated old task", "state": "running", "startedInHouse": false, "createdAt": 1_600_000_000_000_i64},
                        {"agentId": "agent_mac", "title": "Check the Mac", "state": "completed", "startedInHouse": false, "createdAt": 1_700_000_001_200_i64}
                    ]})).await;
                    let mut history = late_history();
                    history["messages"][3]["text"] = json!("Battery is at 82%. LUMA-OS3-LATE-WORKER");
                    peer.send(history).await;
                    peer.send(agent_reply("msg_status", "The earlier check is ready.")).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        }).await;

        let started = Instant::now();
        let partial = mock
            .ask("What is on my Mac's desktop?", Duration::from_millis(1_200))
            .await
            .unwrap();
        let elapsed = started.elapsed();
        let first_state = mock.conversation().await;
        // Advance provider time beyond the grace before delivering its worker
        // snapshot/history on a new socket, without extending the first turn.
        tokio::time::sleep(AGENT_CORRELATION_GRACE + Duration::from_millis(100)).await;
        let first_status = mock
            .ask("What did OS3 find?", Duration::from_secs(5))
            .await
            .unwrap();
        let second_state = mock.conversation().await;
        let second_status = mock
            .ask("What did OS3 find?", Duration::from_millis(1_200))
            .await
            .unwrap();
        let third_state = mock.conversation().await;
        let closed_status = mock
            .ask("What did OS3 find?", Duration::from_secs(5))
            .await
            .unwrap();
        let fourth_state = mock.conversation().await;
        let later = mock
            .ask("What did OS3 find?", Duration::from_secs(5))
            .await
            .unwrap();

        assert!(
            elapsed < Duration::from_secs(2),
            "foreground waited {elapsed:?}"
        );
        // The supplied reference says a task reaction is not worker proof.
        // Retained state, not a false working claim, proves bounded recovery.
        assert!(
            partial.contains("OS3 replied: Let me check your Mac.\nOS3 hasn't confirmed this request is complete."),
            "{partial}"
        );
        assert_eq!(
            first_state
                .unfinished
                .and_then(|state| state.boundary)
                .as_deref(),
            Some("msg_user_1")
        );
        for state in [second_state, third_state, fourth_state] {
            assert_eq!(
                state.unfinished.and_then(|state| state.boundary).as_deref(),
                Some("msg_user_1"),
                "a completed status acknowledgement is not the old task's result"
            );
        }
        assert!(first_status.contains("Still checking."));
        assert!(second_status.contains("Still checking."));
        assert!(closed_status.contains("Still checking."));
        assert!(
            later.contains("Earlier OS3 result: Battery is at 82%. LUMA-OS3-LATE-WORKER"),
            "{later}"
        );
        assert!(!later.contains("Let me check your Mac"), "{later}");
        assert!(!later.contains("Unrelated"), "{later}");
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message"
                    && message["text"] == "What is on my Mac's desktop?")
                .count(),
            1
        );
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message"
                    && message["text"] == "What did OS3 find?")
                .count(),
            0,
            "four read-only updates never submit another chat"
        );
        assert_eq!(mock.inits()[1]["sessionId"], "session_a");
        assert_eq!(
            partial,
            "OS3 replied: Let me check your Mac.\nOS3 hasn't confirmed this request is complete.",
            "unknown worker state reports uncertainty without inventing a running worker"
        );
        assert_eq!(
            mock.conversation()
                .await
                .unfinished
                .and_then(|work| work.boundary)
                .as_deref(),
            Some("msg_user_1"),
            "an actual reply without an original correlated terminal ID keeps completion unconfirmed"
        );
    }

    /// INFERRED local preemption. Stock legacy requests stay open when a new
    /// wearer utterance starts. Keep the first caller alive while cancellation
    /// reconnects its already checkpointed task through real HTTP/WebSocket.
    #[tokio::test]
    async fn same_account_cancel_preempts_an_open_legacy_os3_wait_without_losing_checkpoint() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = Arc::new(mock(StatusCode::OK, "instance-1", move |mut peer| {
            let number = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if number == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    peer.question("msg_cancel").await;
                    peer.send(agent_reply("msg_stop_ack", "Stop requested.")).await;
                    peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                        "agentId": "agent_mac", "title": "Check the Mac's desktop", "state": "canceled", "createdAt": 1_700_000_001_200_i64
                    }]})).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        }).await);
        let first_mock = mock.clone();
        let first = tokio::spawn(async move {
            first_mock
                .ask("What is on my Mac's desktop?", Duration::from_secs(30))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if mock
                    .conversation()
                    .await
                    .unfinished
                    .is_some_and(|u| u.agents.contains_key("agent_mac"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!first.is_finished(), "legacy response is still open");
        let started = Instant::now();
        let stop = mock.ask("Cancel OS3", Duration::from_secs(5)).await;
        let before_cleanup = mock.conversation().await;
        let ended = first.is_finished();
        first.abort();
        let _ = first.await;
        assert_eq!(stop.unwrap(), "OS3 stopped your task.");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancel queued behind old call"
        );
        assert!(
            ended,
            "old waiting caller must yield before cancel writes new state"
        );
        assert_eq!(mock.inits()[1]["sessionId"], "session_a");
        assert_eq!(
            mock.sent()
                .iter()
                .filter(
                    |m| m["type"] == "chat.message" && m["text"] == "What is on my Mac's desktop?"
                )
                .count(),
            1
        );
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|m| m["type"] == "chat.message" && m["text"] == "Cancel OS3")
                .count(),
            1
        );
        assert!(
            before_cleanup
                .unfinished
                .as_ref()
                .is_none_or(|u| !u.agents.contains_key("agent_mac")),
            "old final save must not resurrect stopped task"
        );
    }

    #[tokio::test]
    async fn same_account_cancel_preempts_before_socket_initialization_finishes() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = Arc::new(mock(StatusCode::OK, "instance-1", move |mut peer| {
            let number = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                if number == 0 {
                    assert_eq!(peer.recv().await.unwrap()["type"], "init");
                } else {
                    peer.ack("session_a").await;
                    peer.question("msg_cancel").await;
                    peer.send(json!({"type": "agent.list", "agents": [{"agentId": "agent_mac", "title": "Read battery", "state": "canceled", "createdAt": 1_700_000_001_200_i64}]})).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        }).await);
        assert!(
            mock.saved
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_a".into()),
                    unfinished: Some(Unfinished {
                        boundary: Some("msg_original".into()),
                        agents: HashMap::from([("agent_mac".into(), "Read battery".into())]),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .await
        );
        let first_mock = mock.clone();
        let first = tokio::spawn(async move {
            first_mock
                .ask("What did OS3 find?", Duration::from_secs(30))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while mock.inits().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let started = Instant::now();
        let stop = mock.ask("Cancel OS3", Duration::from_secs(5)).await;
        let ended = first.is_finished();
        first.abort();
        let _ = first.await;
        assert_eq!(stop.unwrap(), "OS3 stopped your task.");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(
            ended,
            "preemption must cover initialization, not just exchange driver"
        );
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|m| m["type"] == "chat.message")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn local_cancel_preemption_never_crosses_account_cookie_or_request_kind() {
        let mock = Arc::new(
            mock(StatusCode::OK, "instance-1", |mut peer| async move {
                peer.ack("session_a").await;
                leave_the_mac_check_running(&mut peer).await;
                peer.until_closed().await;
            })
            .await,
        );
        let first_mock = mock.clone();
        let first = tokio::spawn(async move {
            first_mock
                .ask("What is on my Mac's desktop?", Duration::from_secs(30))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if mock
                    .conversation()
                    .await
                    .unfinished
                    .is_some_and(|u| u.agents.contains_key("agent_mac"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let other =
            ConversationStore::new(mock.saved.store.clone(), mock.saved.keys.clone(), "U:other");
        let malformed = ConversationStore::new(
            mock.saved.store.clone(),
            mock.saved.keys.clone(),
            "not-an-account",
        );
        for (cookie, kind, saved) in [
            (COOKIE_VALUE, RequestKind::Cancel, Some(&other)),
            ("changed-cookie", RequestKind::Cancel, Some(&mock.saved)),
            (COOKIE_VALUE, RequestKind::Cancel, None),
            (COOKIE_VALUE, RequestKind::Cancel, Some(&malformed)),
            (COOKIE_VALUE, RequestKind::Status, Some(&mock.saved)),
            (COOKIE_VALUE, RequestKind::Ask, Some(&mock.saved)),
        ] {
            let result = mock
                .client
                .ask(
                    cookie,
                    "Cancel OS3",
                    kind,
                    Instant::now() + Duration::from_millis(150),
                    saved,
                )
                .await
                .answer;
            assert_eq!(result, Err(Os3Error::Busy));
            assert!(
                !first.is_finished(),
                "a different account/cookie or ordinary request preempted old caller"
            );
        }
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|m| m["type"] == "chat.message")
                .count(),
            1
        );
        first.abort();
        let _ = first.await;
        assert!(
            mock.conversation()
                .await
                .unfinished
                .is_some_and(|u| u.agents.contains_key("agent_mac"))
        );
    }

    /// A worker first seen through a step after the echo is only provisionally
    /// this question's. Its creation time in a later list settles it.
    /// INFERRED cancellation policy: normal owner-authored chat requests a
    /// stop, but only the original correlated worker's state confirms it.
    /// These unrecorded HTTP/WebSocket workflows never send a made-up cancel
    /// packet or count a chat acknowledgement as proof that Mac work stopped.
    #[tokio::test]
    async fn cancelling_os3_requires_a_retained_task_and_its_confirmed_state() {
        let empty = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_unwanted").await;
            peer.send(agent_reply("msg_ack", "Stopped.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;
        assert_eq!(
            empty
                .ask("Cancel OS3", Duration::from_secs(2))
                .await
                .unwrap(),
            "There's no Luma OS3 task to stop."
        );
        assert_eq!(empty.http_hits.load(Ordering::SeqCst), 0);
        assert!(empty.sent().is_empty());

        for state in ["canceled", "completed", "failed", "running", "unknown"] {
            let mock = mock(StatusCode::OK, "instance-1", move |mut peer| async move {
                peer.ack("session_a").await;
                peer.question("msg_cancel").await;
                peer.send(agent_reply("msg_ack", "Stopped.")).await;
                peer.send(idle()).await;
                peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                    "agentId": "agent_unrelated", "title": "Unrelated owner work", "state": "canceled",
                    "createdAt": 1_600_000_000_000_i64
                }]})).await;
                tokio::time::sleep(Duration::from_millis(1100)).await;
                if state != "unknown" {
                    peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                        "agentId": "agent_mac", "title": "Read the Mac battery", "state": state,
                        "createdAt": 1_700_000_001_200_i64
                    }]})).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }).await;
            let before = Conversation {
                cookie: Some(cookie_digest(COOKIE_VALUE)),
                session_id: Some("session_a".to_owned()),
                unfinished: Some(Unfinished {
                    boundary: Some("msg_original".to_owned()),
                    agents: HashMap::from([(
                        "agent_mac".to_owned(),
                        "Read the Mac battery".to_owned(),
                    )]),
                    ..Unfinished::default()
                }),
                ..Conversation::default()
            };
            assert!(mock.saved.save(&before).await);
            let started = Instant::now();
            let answer = mock
                .ask("Cancel OS3", Duration::from_millis(1500))
                .await
                .unwrap();
            assert!(
                started.elapsed() >= Duration::from_millis(1000),
                "premature cancellation: {answer}"
            );
            assert!(started.elapsed() < Duration::from_millis(2300));
            match state {
                "canceled" => assert_eq!(answer, "OS3 stopped your task."),
                "completed" => assert_eq!(answer, "Your OS3 task had already finished."),
                "failed" => assert_eq!(answer, "Your OS3 task ended with an error."),
                _ => assert_eq!(
                    answer,
                    "Stop requested. OS3 hasn't confirmed your task stopped. Check OS3 for an update."
                ),
            }
            assert_eq!(mock.inits()[0]["sessionId"], "session_a");
            let chats: Vec<Value> = mock
                .sent()
                .into_iter()
                .filter(|m| m["type"] == "chat.message")
                .collect();
            assert_eq!(chats.len(), 1);
            assert_eq!(chats[0]["text"], "Cancel OS3");
            assert!(
                mock.sent()
                    .iter()
                    .all(|m| m["type"] == "init" || m["type"] == "chat.message")
            );
            let after = mock.conversation().await;
            if matches!(state, "running" | "unknown") {
                assert!(
                    after
                        .unfinished
                        .as_ref()
                        .is_some_and(|u| u.agents.contains_key("agent_mac"))
                );
            } else {
                assert!(
                    after
                        .unfinished
                        .as_ref()
                        .is_none_or(|u| !u.agents.contains_key("agent_mac"))
                );
            }
        }
    }

    #[tokio::test]
    async fn a_worker_that_predates_the_question_is_not_its_pending_work() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            let mut echoed = echo("msg_user", &chat);
            echoed["timestamp"] = json!(1_700_000_001_100.5_f64);
            peer.send(echoed).await;
            peer.send(worker_step("agent_old", json!({"kind": "tool_call", "text": "Reading"})))
                .await;
            peer.send(json!({
                "type": "agent.list",
                "version": 1,
                "agents": [{"agentId": "agent_old", "title": "Old chore", "state": "running", "createdAt": 1_600_000_000_000_i64}],
            }))
            .await;
            peer.send(agent_reply("msg_reply", "Two folders.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;

        let started = std::time::Instant::now();
        assert_eq!(
            mock.ask("What is on my desktop?", Duration::from_millis(1500))
                .await
                .unwrap(),
            "OS3 replied: Two folders.\nOS3 hasn't confirmed this request is complete."
        );
        assert!(started.elapsed() >= Duration::from_millis(1400));
        assert!(started.elapsed() < Duration::from_millis(2300));
    }

    /// Two real reconnect workflows prove send-once cancellation: resolve a
    /// lost original echo before requesting a stop, and resolve a lost stop
    /// echo without asking twice. No speculative remote cancel packet exists.
    #[tokio::test]
    async fn cancelling_os3_recovers_accepted_work_without_repeating_a_stop() {
        for lost_stop in [false, true] {
            let connection = Arc::new(AtomicUsize::new(0));
            let submitted = Arc::new(Mutex::new(None::<Value>));
            let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
                let connection = connection.fetch_add(1, Ordering::SeqCst);
                let submitted = submitted.clone();
                async move {
                    peer.ack("session_a").await;
                    if connection == 0 {
                        let chat = peer.asked().await;
                        *submitted.lock().unwrap() = Some(chat);
                        let _ = peer.socket.send(Message::Close(None)).await;
                        return;
                    }
                    let first = submitted.lock().unwrap().clone().unwrap();
                    let first_at = first["timestamp"].as_i64().unwrap();
                    let mut original_echo = echo("msg_original", &first);
                    original_echo["timestamp"] = json!(first_at + 10);
                    let messages = if lost_stop {
                        original_echo["messageId"] = json!("msg_stop");
                        vec![json!({"type": "chat.message", "messageId": "msg_original",
                            "role": "user", "text": "Ask OS3 to read my Mac battery"}), original_echo]
                    } else {
                        vec![original_echo]
                    };
                    if !lost_stop {
                        peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                            "agentId": "agent_mac", "title": "Read the Mac battery", "state": "running",
                            "createdAt": first_at + 20
                        }]})).await;
                    }
                    peer.send(json!({"type": "session.history", "version": 1, "messages": messages})).await;
                    if !lost_stop {
                        peer.question("msg_stop").await;
                    }
                    peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                        "agentId": "agent_mac", "title": "Read the Mac battery", "state": "canceled",
                        "createdAt": if lost_stop { 1_700_000_001_200_i64 } else { first_at + 20 }
                    }]})).await;
                    peer.send(agent_reply("msg_stopped", "Stopped.")).await;
                    peer.send(idle()).await;
                    peer.until_closed().await;
                }
            }).await;
            if lost_stop {
                assert!(
                    mock.saved
                        .save(&Conversation {
                            cookie: Some(cookie_digest(COOKIE_VALUE)),
                            session_id: Some("session_a".to_owned()),
                            unfinished: Some(Unfinished {
                                boundary: Some("msg_original".to_owned()),
                                agents: HashMap::from([(
                                    "agent_mac".to_owned(),
                                    "Read the Mac battery".to_owned()
                                )]),
                                ..Unfinished::default()
                            }),
                            ..Conversation::default()
                        })
                        .await
                );
            }
            let first = if lost_stop {
                "Cancel OS3"
            } else {
                "Ask OS3 to read my Mac battery"
            };
            let _ = mock.ask(first, Duration::from_secs(2)).await;
            assert!(mock.conversation().await.in_flight.is_some());
            let answer = mock
                .ask("Stop the OS3 task", Duration::from_secs(2))
                .await
                .unwrap();
            assert_eq!(answer, "OS3 stopped your task.", "lost_stop={lost_stop}");
            assert_eq!(mock.inits()[1]["sessionId"], "session_a");
            let chats: Vec<Value> = mock
                .sent()
                .into_iter()
                .filter(|m| m["type"] == "chat.message")
                .collect();
            assert_eq!(chats.len(), if lost_stop { 1 } else { 2 });
            assert_eq!(chats.iter().filter(|m| m["text"] == first).count(), 1);
            assert!(mock.conversation().await.in_flight.is_none());
        }
    }

    /// A question dropped mid-exchange, as when the wearer speaks again, told
    /// the wearer nothing, so the earlier question's unfinished work survives.
    #[tokio::test]
    async fn a_cancelled_question_keeps_the_earlier_unfinished_work() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    peer.send(late_history()).await;
                    peer.question(&format!("msg_user_{}", connection + 1)).await;
                    if connection == 2 {
                        peer.send(agent_reply("msg_reply_3", "You're welcome."))
                            .await;
                        peer.send(idle()).await;
                    }
                }
                peer.until_closed().await;
            }
        })
        .await;

        let partial = mock
            .ask("What is on my Mac's desktop?", Duration::from_millis(1_500))
            .await
            .unwrap();
        assert!(partial.contains("Check the Mac's desktop"), "{partial}");
        assert!(
            tokio::time::timeout(
                Duration::from_millis(700),
                mock.ask("Hmm", Duration::from_secs(5))
            )
            .await
            .is_err(),
            "the second question is cancelled mid-exchange"
        );
        let later = mock.ask("Thanks", Duration::from_secs(5)).await.unwrap();
        assert!(
            later.contains("Earlier OS3 result: Your desktop has two folders."),
            "{later}"
        );
    }

    /// A Pin barge-in drops the foreground future, but Rabbit keeps running
    /// the Mac task. The session, exact echo boundary, and correlated worker
    /// ID were checkpointed inline, so the next turn reconnects and reports
    /// that worker's completion instead of orphaning it.
    #[tokio::test]
    async fn a_cancelled_question_reconnects_to_the_worker_it_started() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    peer.question("msg_user_1").await;
                    peer.send(json!({"type": "conversation.processing", "version": 1}))
                        .await;
                    peer.send(json!({"type": "agent.list", "version": 1, "agents": [{
                        "agentId": "agent_mac",
                        "title": "Check the Mac",
                        "state": "running",
                        "createdAt": 1_700_000_001_200_i64
                    }]}))
                    .await;
                } else {
                    peer.send(json!({
                        "type": "agent.completed",
                        "version": 1,
                        "agentId": "agent_mac",
                        "fromState": "running",
                        "ext": {"result": "Two folders.", "resultFiles": []}
                    }))
                    .await;

                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;

        assert!(
            tokio::time::timeout(
                Duration::from_millis(700),
                mock.ask("What is on my Mac?", Duration::from_secs(5))
            )
            .await
            .is_err(),
            "the Pin turn is cancelled while Rabbit keeps working"
        );
        let checkpoint = mock.conversation().await;
        assert_eq!(checkpoint.session_id.as_deref(), Some("session_a"));
        let unfinished = checkpoint.unfinished.expect("accepted work is durable");
        assert_eq!(unfinished.boundary.as_deref(), Some("msg_user_1"));
        assert_eq!(
            unfinished.agents.get("agent_mac").map(String::as_str),
            Some("Check the Mac")
        );

        assert_eq!(
            mock.ask("What did OS3 find?", Duration::from_secs(5))
                .await
                .unwrap(),
            "OS3 finished the earlier task \"Check the Mac\": Two folders."
        );
        assert_eq!(mock.inits()[1]["sessionId"], "session_a");
    }

    /// A worker that ended while no socket was open shows up only as a list
    /// record. A failure is reported, not dropped, and then forgotten.
    #[tokio::test]
    async fn a_worker_that_failed_while_disconnected_is_reported_once() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    peer.send(json!({
                        "type": "agent.list",
                        "version": 1,
                        "agents": [{"agentId": "agent_mac", "state": "failed", "error": "Mac offline"}],
                    }))
                    .await;
                    peer.question("msg_user_2").await;
                    peer.send(agent_reply("msg_reply_2", "You're welcome.")).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;

        mock.ask("What is on my Mac's desktop?", Duration::from_millis(1_500))
            .await
            .unwrap();
        let later = mock.ask("Thanks", Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            later,
            "OS3 could not finish the earlier task \"Check the Mac's desktop\".\n\
             OS3 replied: You're welcome.\nOS3 hasn't confirmed this request is complete."
        );
        assert!(
            !mock
                .conversation()
                .await
                .unfinished
                .is_some_and(|unfinished| unfinished.agents.contains_key("agent_mac")),
            "a reported failure is not carried forward"
        );
    }

    /// Running out of the caller's time is not OS3 being unreachable, and a
    /// window too short to be useful never contacts OS3 at all.
    #[tokio::test]
    async fn an_exhausted_window_is_no_answer_without_contacting_os3() {
        let now = Instant::now();
        let finish_in = |seconds| Some(now.into_std() + Duration::from_secs(seconds));
        assert_eq!(ask_deadline(now, None), Some(now + ANSWER_LIMIT));
        assert_eq!(
            ask_deadline(now, finish_in(10)),
            Some(now + Duration::from_secs(9))
        );
        assert_eq!(ask_deadline(now, finish_in(3)), None);
        assert_eq!(ask_deadline(now, Some(now.into_std())), None);

        let untouched = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.until_closed().await;
        })
        .await;
        assert_eq!(
            untouched
                .client
                .ask(
                    COOKIE_VALUE,
                    "Hello",
                    RequestKind::Ask,
                    Instant::now(),
                    None
                )
                .await
                .answer,
            Err(Os3Error::NoAnswer)
        );
        assert_eq!(
            untouched.client.probe(COOKIE_VALUE, Instant::now()).await,
            Err(Os3Error::NoAnswer)
        );
        assert_eq!(untouched.http_hits.load(Ordering::SeqCst), 0);
        assert!(untouched.socket_paths.lock().unwrap().is_empty());

        let unacknowledged = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            let _ = peer.recv().await;
            peer.until_closed().await;
        })
        .await;
        assert_eq!(
            unacknowledged
                .ask("Hello", Duration::from_millis(500))
                .await,
            Err(Os3Error::NoAnswer)
        );
    }

    /// The caller abandons the question at its own deadline, so closing the
    /// socket and saving the conversation must both fit in [`SETTLE`], even
    /// when the exchange ran to its deadline and the close took its limit.
    #[test]
    fn closing_and_saving_fit_inside_the_settle_margin() {
        let deadline = Instant::now() + Duration::from_secs(10);
        let early = deadline - Duration::from_secs(5);
        assert_eq!(save_by(early, deadline), early + SAVE_LIMIT);
        let closed_at_the_limit = deadline + CLOSE_LIMIT;
        assert!(save_by(closed_at_the_limit, deadline) < deadline + SETTLE);
        assert!(CLOSE_LIMIT < SETTLE && SAVE_LIMIT < SETTLE);
    }

    /// An instance ID that could not safely name a host is never placed in
    /// one. The account falls back to the default host like any unrouted
    /// answer, and the question still runs.
    #[tokio::test]
    async fn an_unsafe_instance_id_never_reaches_a_host_name() {
        for instance in ["evil.example.com/x", "a b", "x@y"] {
            let mock = mock(StatusCode::OK, instance, |mut peer| async move {
                peer.ack("session_a").await;
                peer.question("msg_user").await;
                peer.send(agent_reply("msg_reply", "Two folders.")).await;
                peer.send(idle()).await;
                peer.until_closed().await;
            })
            .await;
            let answer = mock
                .ask("Hello", Duration::from_secs(5))
                .await
                .unwrap_or_else(|error| panic!("{instance:?}: {error:?}"));
            assert_eq!(
                answer, "OS3 replied: Two folders.\nOS3 hasn't confirmed this request is complete.",
                "{instance:?}"
            );
            assert_eq!(
                *mock.socket_paths.lock().unwrap(),
                vec!["/ws".to_owned()],
                "{instance:?}: the unsafe ID named no host"
            );
        }
    }

    /// Each refused sign-in names the step that refused it, and only the
    /// API's own refusals ask for a fresh cookie: Rabbit's edge answers an
    /// HTML 403 before any sign-in check.
    #[tokio::test]
    async fn each_refused_sign_in_names_its_step() {
        let token = |answer: Answer| Http {
            token: answer,
            ..Http::routed_to("instance-1")
        };
        let route = |answer: Answer| Http {
            route: answer,
            ..Http::routed_to("instance-1")
        };
        let cases = [
            (
                "token 401",
                token(Answer::json(StatusCode::UNAUTHORIZED, json!({}))),
                Os3Error::SignInExpired,
            ),
            (
                "token JSON 403",
                token(Answer::json(StatusCode::FORBIDDEN, json!({}))),
                Os3Error::SignInExpired,
            ),
            (
                "token redirect to sign-in",
                token(Answer::html(StatusCode::FOUND)),
                Os3Error::SignInExpired,
            ),
            (
                "token 200 sign-in page",
                token(Answer::html(StatusCode::OK)),
                Os3Error::SignInExpired,
            ),
            (
                "token without a token",
                token(Answer::json(StatusCode::OK, json!({"accessToken": null}))),
                Os3Error::SignInExpired,
            ),
            (
                "edge HTML 403 on token",
                token(Answer::html(StatusCode::FORBIDDEN)),
                Os3Error::Blocked,
            ),
            (
                "edge HTML 403 on route",
                route(Answer::html(StatusCode::FORBIDDEN)),
                Os3Error::Blocked,
            ),
            (
                "route 401",
                route(Answer::json(StatusCode::UNAUTHORIZED, json!({}))),
                Os3Error::SignInExpired,
            ),
            (
                "token 500",
                token(Answer::json(StatusCode::INTERNAL_SERVER_ERROR, json!({}))),
                Os3Error::Unavailable,
            ),
            (
                "token not JSON",
                token(Answer {
                    status: StatusCode::OK,
                    content_type: "text/plain",
                    body: "not json".to_owned(),
                    chunked: false,
                }),
                Os3Error::Unavailable,
            ),
        ];
        for (case, http, expected) in cases {
            let mock = mock_http(http, |mut peer| async move {
                peer.until_closed().await;
            })
            .await;
            let asked = mock
                .client
                .ask(
                    COOKIE_VALUE,
                    "Hello",
                    RequestKind::Ask,
                    Instant::now() + Duration::from_secs(5),
                    Some(&mock.saved),
                )
                .await;
            assert_eq!(asked.answer, Err(expected), "{case}");
            assert_eq!(
                contact(&asked.answer, asked.connected_as, asked.interrupted),
                expected.state().map(|state| (state, None)),
                "{case}"
            );
            assert!(mock.socket_paths.lock().unwrap().is_empty(), "{case}");
            let probed = mock
                .client
                .probe(COOKIE_VALUE, Instant::now() + Duration::from_secs(5))
                .await;
            assert_eq!(
                probed,
                Err(expected),
                "the test names the same step: {case}"
            );
        }
        assert!(
            Os3Error::SignInExpired
                .observation()
                .contains("fresh OS3 session cookie in Center")
        );
        assert!(!Os3Error::Blocked.observation().contains("cookie"));
    }

    /// A directory answer that names no instance is not a dead end. The
    /// official web client treats `kind: "any"`, a `route` without a usable
    /// `instanceId`, another `kind`, and an unreadable body alike: fall back
    /// to the DEFAULT host and hold the conversation there (verified
    /// 2026-09-24). This is the production failure v0.3.4 shipped: a healthy
    /// sign-in answered "no agent instance" for an account the directory
    /// routed to no instance that day, while the same account's delegation
    /// works on the default host.
    #[tokio::test]
    async fn an_unrouted_account_reaches_the_default_host() {
        let unrouted = |route: Answer| Http {
            route,
            ..Http::routed_to("instance-1")
        };
        let answers = [
            (
                "any kind",
                Answer::json(StatusCode::OK, json!({"kind": "any"})),
            ),
            (
                "route without an instance",
                Answer::json(StatusCode::OK, json!({"kind": "route"})),
            ),
            (
                "route with an unusable instance",
                Answer::json(StatusCode::OK, json!({"kind": "route", "instanceId": ".."})),
            ),
            (
                "another kind",
                Answer::json(StatusCode::OK, json!({"kind": "queue"})),
            ),
            (
                "unreadable body",
                Answer {
                    status: StatusCode::OK,
                    content_type: "application/json",
                    body: "<html>not json</html>".to_owned(),
                    chunked: false,
                },
            ),
        ];
        for (case, route) in answers {
            let mock = mock_http(unrouted(route), |mut peer| async move {
                peer.ack("session_a").await;
                peer.question("msg_user").await;
                peer.send(agent_reply("msg_reply", "Two folders.")).await;
                peer.send(idle()).await;
                peer.until_closed().await;
            })
            .await;
            let answer = mock
                .ask("What is on my Mac?", Duration::from_secs(5))
                .await
                .unwrap_or_else(|error| panic!("{case}: {error:?}"));
            assert_eq!(
                answer, "OS3 replied: Two folders.\nOS3 hasn't confirmed this request is complete.",
                "{case}"
            );
            assert_eq!(
                *mock.socket_paths.lock().unwrap(),
                vec!["/ws".to_owned()],
                "{case}: the default host serves the conversation"
            );
        }
        // An explicit instance still names its own host.
        let routed = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(agent_reply("msg_reply", "Two folders.")).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;
        routed
            .ask("What is on my Mac?", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            *routed.socket_paths.lock().unwrap(),
            vec!["/ws/instance-1".to_owned()]
        );
    }

    /// The default host is the fallback, never an override: an instance the
    /// directory names is used even when the conversation could also fit the
    /// default host.
    #[test]
    fn routed_instance_reads_only_a_usable_route_record() {
        assert_eq!(
            routed_instance(r#"{"kind":"route","instanceId":"instance-1"}"#),
            Some("instance-1".to_owned())
        );
        assert_eq!(routed_instance(r#"{"kind":"any"}"#), None);
        assert_eq!(routed_instance(r#"{"kind":"route"}"#), None);
        assert_eq!(routed_instance(r#"{"kind":"route","instanceId":""}"#), None);
        // The instance ID becomes part of a host name: anything but a plain
        // label could point the socket, and the access token, elsewhere.
        assert_eq!(
            routed_instance(r#"{"kind":"route","instanceId":"a.b"}"#),
            None
        );
        assert_eq!(routed_instance("not json"), None);
    }

    /// The socket carries no sign-in, so a refused upgrade is Rabbit's edge
    /// (403), an instance that is not there (404), or the socket refusing.
    #[test]
    fn a_refused_socket_upgrade_names_its_step() {
        use tokio_tungstenite::tungstenite::{Error, http};
        let refusal = |status: u16| {
            Error::Http(
                http::Response::builder()
                    .status(status)
                    .body(Some(b"<html>403</html>".to_vec()))
                    .unwrap(),
            )
        };
        assert_eq!(socket_refused(refusal(403)), Os3Error::Blocked);
        assert_eq!(socket_refused(refusal(404)), Os3Error::NoInstance);
        assert_eq!(socket_refused(refusal(502)), Os3Error::SocketRefused);
        assert_eq!(
            socket_refused(Error::Io(std::io::ErrorKind::ConnectionRefused.into())),
            Os3Error::SocketRefused
        );
    }

    /// An error event or a close in place of `init_ack` refuses the socket
    /// at once instead of after the whole acknowledgement wait, and forgets
    /// the session it named.
    #[tokio::test]
    async fn a_socket_refused_before_init_ack_is_named_promptly() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                match connection {
                    0 => {
                        peer.ack("session_a").await;
                        peer.question("msg_user_1").await;
                        peer.send(agent_reply("msg_reply_1", "Hi.")).await;
                        peer.send(idle()).await;
                        peer.until_closed().await;
                    }
                    1 => {
                        let _ = peer.recv().await;
                        peer.send(json!({"type": "error", "version": 1, "code": "unauthorized"}))
                            .await;
                        peer.until_closed().await;
                    }
                    _ => {
                        let _ = peer.recv().await;
                    }
                }
            }
        })
        .await;
        mock.ask("One", Duration::from_secs(5)).await.unwrap();
        for _ in ["error event held open", "closed without init_ack"] {
            let started = std::time::Instant::now();
            let asked = mock
                .client
                .ask(
                    COOKIE_VALUE,
                    "Hello",
                    RequestKind::Ask,
                    Instant::now() + Duration::from_secs(15),
                    Some(&mock.saved),
                )
                .await;
            assert_eq!(asked.answer, Err(Os3Error::SocketRefused));
            assert_eq!(
                contact(&asked.answer, asked.connected_as, asked.interrupted),
                Some((Os3State::SocketRefused, None))
            );
            assert!(started.elapsed() < Duration::from_secs(2));
        }
        let inits = mock.inits();
        assert_eq!(inits[1]["sessionId"], "session_a");
        assert!(
            inits[2].get("sessionId").is_none(),
            "a refused session is not offered again"
        );
    }

    /// Unrecorded local HTTP/WebSocket fixture. A queued ask or connection
    /// test must not authenticate with a cookie captured before disable/change.
    #[tokio::test]
    async fn queued_requests_stop_before_http_when_os3_settings_change() {
        use crate::integrations::{
            IntegrationStore, IntegrationsConfig, IntegrationsUpdate, Os3Update,
        };
        let mut outcomes = Vec::new();
        let mut hits = Vec::new();
        for probe in [false, true] {
            for replace in [false, true] {
                let directory =
                    std::env::temp_dir().join(format!("luma-os3-queued-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&directory).unwrap();
                let mut config = IntegrationsConfig::default();
                config.os3.enabled = true;
                config.os3.session_cookie = Some(COOKIE_VALUE.to_owned());
                std::fs::write(
                    directory.join("integrations.json"),
                    serde_json::to_vec(&config).unwrap(),
                )
                .unwrap();
                let integrations = IntegrationStore::load(directory.to_str()).unwrap();
                let mut mock = mock(StatusCode::OK, "review", move |mut peer| async move {
                    peer.ack("session_review").await;
                    if !probe {
                        peer.question("msg_review").await;
                        peer.send(agent_reply("reply_review", "Synthetic status."))
                            .await;
                        peer.send(idle()).await;
                    }
                    peer.until_closed().await;
                })
                .await;
                mock.client.integrations = Some(integrations.clone());
                let turn = mock.client.turn.lock().await;
                let deadline = Instant::now() + Duration::from_secs(5);
                let queued = async {
                    if probe {
                        mock.client.probe(COOKIE_VALUE, deadline).await
                    } else {
                        mock.client
                            .ask(
                                COOKIE_VALUE,
                                "Synthetic status?",
                                RequestKind::Ask,
                                deadline,
                                Some(&mock.saved),
                            )
                            .await
                            .answer
                    }
                };
                tokio::pin!(queued);
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), &mut queued)
                        .await
                        .is_err()
                );
                integrations
                    .update(IntegrationsUpdate {
                        os3: Some(Os3Update {
                            enabled: Some(replace),
                            session_cookie: replace
                                .then(|| "session=replacement-synthetic".to_owned()),
                        }),
                        ..Default::default()
                    })
                    .unwrap();
                drop(turn);
                outcomes.push(queued.await);
                hits.push(mock.http_hits.load(Ordering::SeqCst));
                assert!(mock.saved.load().await.unwrap().in_flight.is_none());
                std::fs::remove_dir_all(directory).unwrap();
            }
        }
        assert_eq!(outcomes, vec![Err(Os3Error::ConfigurationChanged); 4]);
        assert_eq!(hits, vec![0; 4]);
    }

    /// Unrecorded HTTP fixtures: an otherwise valid token/directory object
    /// with excessive unknown metadata. The INFERRED 64 KiB HTTP budget must
    /// stop the connection before even an init, independently of token size.
    #[tokio::test]
    async fn authentication_http_bodies_are_bounded_before_opening_a_socket() {
        let mut outcomes = Vec::new();
        let mut sockets = Vec::new();
        for (token_body, chunked) in [(true, false), (false, false), (true, true), (false, true)] {
            let mut answers = Http::routed_to("review");
            let response = if token_body {
                json!({"accessToken": TOKEN, "padding": "x".repeat(64 * 1024)})
            } else {
                json!({"kind": "route", "instanceId": "review", "padding": "x".repeat(64 * 1024)})
            };
            if token_body {
                answers.token = Answer::json(StatusCode::OK, response);
                answers.token.chunked = chunked;
            } else {
                answers.route = Answer::json(StatusCode::OK, response);
                answers.route.chunked = chunked;
            }
            let mock = mock_http(answers, |mut peer| async move {
                peer.ack("session_review").await;
                peer.until_closed().await;
            })
            .await;
            if chunked {
                let framing = http()
                    .get(format!("{}/api/auth/token", mock.client.endpoints.origin))
                    .header(COOKIE, COOKIE_VALUE)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(framing.content_length().is_none(), token_body);
            }
            outcomes.push(
                mock.client
                    .probe(COOKIE_VALUE, Instant::now() + Duration::from_secs(2))
                    .await,
            );
            sockets.push(mock.socket_paths.lock().unwrap().clone());
        }
        assert_eq!(outcomes, vec![Err(Os3Error::Unavailable); 4]);
        assert!(sockets.iter().all(Vec::is_empty));
    }

    /// The test answers OS3's name for the agent and never the account email,
    /// opens a fresh session, and asks nothing.
    #[tokio::test]
    async fn the_probe_names_the_agent_and_asks_nothing() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.until_closed().await;
        })
        .await;
        let probed = mock
            .client
            .probe(COOKIE_VALUE, Instant::now() + Duration::from_secs(5))
            .await;
        assert_eq!(probed, Ok("Butler".to_owned()));
        assert_eq!(
            contact(&probed, probed.clone().ok(), None),
            Some((Os3State::Connected, Some("Butler".to_owned())))
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        let sent = mock.sent();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(sent[0]["type"], "init");
        assert!(sent[0].get("sessionId").is_none());

        assert_eq!(display_name("  Rab\u{7}bit\n  Butler "), "Rabbit Butler");
        assert_eq!(
            display_name(&"n".repeat(200)).chars().count(),
            MAX_OS3_BUTLER_NAME_CHARS + 1
        );
    }

    /// What each outcome tells Center. Only a contact that went through says
    /// connected. Every failure names its step.
    #[test]
    fn each_outcome_maps_to_the_status_center_shows() {
        let butler = || Some("Butler".to_owned());
        let answered: Result<String, Os3Error> = Ok("OS3 replied: Hi.".to_owned());
        assert_eq!(
            contact(&answered, butler(), None),
            Some((Os3State::Connected, butler()))
        );
        assert_eq!(
            contact(&answered, Some(String::new()), None),
            Some((Os3State::Connected, None))
        );
        assert_eq!(
            contact(&answered, None, None),
            None,
            "Luma answered without contacting OS3"
        );
        assert_eq!(
            contact(&answered, butler(), Some(Os3Error::Dropped)),
            Some((Os3State::Dropped, None)),
            "OS3 took the question, then the connection dropped"
        );
        assert_eq!(
            contact(&answered, butler(), Some(Os3Error::NoAnswer)),
            Some((Os3State::TimedOut, None)),
            "only earlier results: OS3 never took this question"
        );
        for (error, state) in [
            (Os3Error::SignInExpired, Os3State::SignInExpired),
            (Os3Error::Blocked, Os3State::Blocked),
            (Os3Error::NoInstance, Os3State::NoInstance),
            (Os3Error::SocketRefused, Os3State::SocketRefused),
            (Os3Error::Unavailable, Os3State::Unavailable),
            (Os3Error::Dropped, Os3State::Dropped),
            (Os3Error::NoAnswer, Os3State::TimedOut),
        ] {
            // Signed in first or not, a failed contact is never connected.
            assert_eq!(
                contact(&Err::<String, _>(error), butler(), None),
                Some((state, None)),
                "{error:?}"
            );
        }
        for error in [Os3Error::NotConfigured, Os3Error::Busy] {
            assert_eq!(
                contact(&Err::<String, _>(error), None, None),
                None,
                "{error:?} never contacted OS3"
            );
        }
        // Cosmos's own storage says nothing about the connection to OS3.
        assert_eq!(
            contact(
                &Err::<String, _>(Os3Error::ConversationStorage),
                butler(),
                None
            ),
            None
        );
        assert_eq!(
            contact(&answered, butler(), Some(Os3Error::ConversationStorage)),
            None
        );
    }

    /// The assistant status offers `ask_os3` as live only once the last
    /// contact with the current cookie went through, and otherwise says what
    /// it needs.
    #[test]
    fn the_assistant_status_follows_the_last_contact() {
        use crate::integrations::{IntegrationStore, IntegrationsConfig};
        let mut config = IntegrationsConfig::default();
        let off = IntegrationStore::memory(config.clone());
        assert!(!readiness(&off).0);
        config.os3.enabled = true;
        config.os3.session_cookie = Some(COOKIE_VALUE.to_owned());
        let store = IntegrationStore::memory(config);
        let (live, needs) = readiness(&store);
        assert!(!live && needs.contains("Test"), "{needs}");
        store.record_os3_contact(
            COOKIE_VALUE,
            Os3State::Connected,
            Some("Butler".to_owned()),
            false,
        );
        assert_eq!(readiness(&store), (true, ""));
        store.record_os3_contact(COOKIE_VALUE, Os3State::SignInExpired, None, true);
        let (live, needs) = readiness(&store);
        assert!(
            !live && needs.contains("fresh OS3 session cookie"),
            "{needs}"
        );
        store.record_os3_contact(COOKIE_VALUE, Os3State::Blocked, None, true);
        assert!(!readiness(&store).0);
    }

    /// What the wearer says, and the kind the assistant asks OS3 with.
    const CHECK: (&str, RequestKind) = ("What did OS3 find?", RequestKind::Status);
    const STOP: (&str, RequestKind) = ("Cancel OS3", RequestKind::Cancel);

    /// Asks through the public [`ask`], as `ask_os3` does, and checks that Luma
    /// answered `answer` itself: `os3` saw no sign-in and no socket, and
    /// Center's OS3 card and `ask_os3`'s readiness are exactly as before.
    async fn answered_without_contact(
        os3: &Mock,
        (request, kind): (&str, RequestKind),
        saved: Option<ConversationStore>,
        answer: &str,
    ) {
        let integrations = crate::integrations::active();
        let card = integrations.os3_status();
        let ready = readiness(&integrations);
        let contacts = || {
            (
                os3.http_hits.load(Ordering::SeqCst),
                os3.socket_paths.lock().unwrap().len(),
            )
        };
        let before = contacts();
        assert_eq!(
            super::ask(request, kind, None, saved).await.as_deref(),
            Ok(answer),
            "{request}"
        );
        assert_eq!(contacts(), before, "{request}: OS3 was contacted");
        assert_eq!(integrations.os3_status(), card, "{request}: the OS3 card");
        assert_eq!(readiness(&integrations), ready, "{request}: readiness");
    }

    /// Failure plan: no task to check, no task to stop, and a lost request
    /// too old to confirm are answered without contacting OS3, so they show
    /// nothing about the connection. Each must keep its words, contact
    /// nothing, and leave Center's OS3 card (state, agent name, checked and
    /// last-used times) and `ask_os3`'s readiness as the last real contact
    /// left them: after an expired sign-in, after a cookie change, and after
    /// a question that went through. The public `ask` records into the
    /// process-wide settings and client, so this runs alone in a child
    /// process against a loopback OS3 that counts every contact. A real
    /// question proves the card is observed at all. Unrecorded fixture.
    #[tokio::test]
    async fn answers_given_without_contacting_os3_leave_its_status_untouched() {
        const CHILD: &str = "LUMA_HTTP_OS3_FIXTURE_CHILD";
        const TEST: &str =
            "backends::os3::tests::answers_given_without_contacting_os3_leave_its_status_untouched";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD, "local-answers")
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success() && stdout.contains("test result: ok. 1 passed"),
                "isolated OS3 status workflow: {stdout}{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use crate::integrations::{IntegrationsConfig, IntegrationsUpdate, Os3Update};
        const UNCONFIRMED: &str =
            "I couldn't confirm the earlier OS3 request. Stop the task in OS3.";
        let os3 = answering("Hello.").await;
        let directory =
            std::env::temp_dir().join(format!("luma-os3-local-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut config = IntegrationsConfig::default();
        config.os3.enabled = true;
        config.os3.session_cookie = Some(COOKIE_VALUE.to_owned());
        std::fs::write(
            directory.join("integrations.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let integrations = crate::integrations::install(directory.to_str()).unwrap();
        // This child process runs this one test alone.
        unsafe {
            std::env::set_var("LUMA_TEST_OS3_HTTP_ORIGIN", &os3.client.endpoints.origin);
            std::env::set_var("LUMA_TEST_OS3_SOCKET", &os3.client.endpoints.socket_any);
            std::env::set_var("LUMA_TEST_OS3_ASK_WINDOW_MS", "5000");
        }
        let store: SharedStore = Arc::new(crate::store::MemoryStore::default());
        let keys: SharedKeyDirectory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let owner = || ConversationStore::new(store.clone(), keys.clone(), OWNER);

        // The last Test found the sign-in expired. No task, or only a lost
        // request too old to confirm, is answered locally.
        integrations.record_os3_contact(COOKIE_VALUE, Os3State::SignInExpired, None, false);
        assert_eq!(
            readiness(&integrations),
            (false, "A fresh OS3 session cookie in Center")
        );
        answered_without_contact(&os3, CHECK, Some(owner()), NO_TASK_TO_CHECK).await;
        answered_without_contact(&os3, STOP, Some(owner()), NO_TASK_TO_STOP).await;
        let expired = i64::try_from(now_ms()).unwrap() - JOURNAL_LIMIT_MS - 1;
        let lost = journal_conversation(COOKIE_VALUE, expired);
        assert!(owner().save(&lost).await);
        answered_without_contact(&os3, STOP, Some(owner()), UNCONFIRMED).await;

        // The owner pastes another cookie. Nothing has reached OS3 with it,
        // and the wearer's retained task belongs to the old one.
        assert!(
            owner()
                .save(&Conversation {
                    cookie: Some(cookie_digest(COOKIE_VALUE)),
                    session_id: Some("session_a".to_owned()),
                    unfinished: Some(Unfinished {
                        boundary: Some("msg_original".to_owned()),
                        ..Unfinished::default()
                    }),
                    ..Conversation::default()
                })
                .await
        );
        integrations
            .update(IntegrationsUpdate {
                os3: Some(Os3Update {
                    session_cookie: Some(OTHER_COOKIE.to_owned()),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            readiness(&integrations),
            (false, "A successful OS3 Test in Center")
        );
        answered_without_contact(&os3, CHECK, Some(owner()), NO_TASK_TO_CHECK).await;
        answered_without_contact(&os3, STOP, Some(owner()), NO_TASK_TO_STOP).await;

        // A question that reaches OS3 is recorded, so the card was observed.
        let hello = super::ask("Ask OS3 to say hi", RequestKind::Ask, None, Some(owner())).await;
        assert!(hello.is_ok(), "{hello:?}");
        let connected = integrations.os3_status();
        assert_eq!(connected.state, Os3State::Connected);
        assert_eq!(connected.butler_name.as_deref(), Some("Butler"));
        assert!(connected.last_used_at_ms.is_some());
        assert_eq!(readiness(&integrations), (true, ""));
        assert_eq!(os3.socket_paths.lock().unwrap().len(), 1);
        // A later local answer keeps that contact, the agent's name included.
        answered_without_contact(&os3, CHECK, None, NO_TASK_TO_CHECK).await;
        answered_without_contact(&os3, STOP, None, NO_TASK_TO_STOP).await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// While OS3 works the Pin shows and speaks the stock interstitial: stock
    /// `LoadingMessageManager` asks `ActionBasedInterstitial` with one
    /// `{"ask_os3": {...}}` string per action so far, and the answer never
    /// echoes the private request.
    #[test]
    fn the_pin_hears_the_stock_interstitial_while_os3_works() {
        let action =
            json!({ crate::assistant::catalog::OS3_TOOL: {"request": "what is in my tax folder"} })
                .to_string();
        assert_eq!(
            crate::assistant::catalog::progress_cue_from_action_strings(&[action]).as_deref(),
            Some("Checking with OS3")
        );
    }

    #[tokio::test]
    async fn silence_after_init_is_no_answer_and_a_close_before_the_echo_is_a_drop() {
        let quiet = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.until_closed().await;
        })
        .await;
        assert_eq!(
            quiet.ask("Hello", Duration::from_millis(500)).await,
            Err(Os3Error::NoAnswer)
        );

        let dropping = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let _ = peer.socket.close(None).await;
        })
        .await;
        let asked = dropping
            .client
            .ask(
                COOKIE_VALUE,
                "Hello",
                RequestKind::Ask,
                Instant::now() + Duration::from_secs(5),
                None,
            )
            .await;
        assert_eq!(asked.answer, Err(Os3Error::Dropped));
        assert_eq!(
            asked.answer.unwrap_err().observation(),
            "The connection to OS3 dropped before Luma could confirm whether OS3 accepted the \
             question, so it was not sent again. Ask \"What did OS3 find?\" later to check on it."
        );
    }

    /// The socket drops after OS3 took the question. The wearer hears that
    /// the connection dropped and to ask again, not that OS3 could not be
    /// reached. Center says the connection dropped. And the follow-up hears
    /// the result.
    #[tokio::test]
    async fn a_drop_after_os3_took_the_question_is_not_unreachable() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    peer.question("msg_user_1").await;
                    peer.send(json!({"type": "conversation.processing", "version": 1}))
                        .await;
                    let _ = peer.socket.close(None).await;
                    return;
                }
                peer.send(json!({"type": "session.history", "version": 1, "messages": [
                    {"type": "chat.message", "messageId": "msg_user_1", "text": "Q", "role": "user"},
                    {"type": "chat.message", "messageId": "msg_late", "text": "Found it in Documents.", "role": "agent"},
                ]}))
                .await;

                peer.send(idle()).await;
                peer.until_closed().await;
            }
        })
        .await;
        let first = mock
            .client
            .ask(
                COOKIE_VALUE,
                "Where is my tax PDF?",
                RequestKind::Ask,
                Instant::now() + Duration::from_secs(5),
                Some(&mock.saved),
            )
            .await;
        assert_eq!(first.answer.as_deref(), Ok(DROPPED_AFTER_TAKEN));
        assert_eq!(
            contact(&first.answer, first.connected_as, first.interrupted),
            Some((Os3State::Dropped, None))
        );
        let later = mock
            .ask("What did OS3 find?", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            later,
            "Earlier OS3 result: Found it in Documents.\nOS3 hasn't confirmed this request is complete."
        );
    }

    /// A transport can accept the chat and disappear before its echo reaches
    /// Cosmos. After a restart the sealed pre-send journal must recover that
    /// exact echo from history and consume this follow-up as status-only,
    /// rather than submitting the Mac task a second time.
    #[tokio::test]
    async fn a_hard_drop_before_the_echo_recovers_after_a_memory_store_restart() {
        let connection = Arc::new(AtomicUsize::new(0));
        let submitted = Arc::new(Mutex::new(None::<Value>));
        let server_submitted = submitted.clone();
        let mut mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            let submitted = server_submitted.clone();
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    let chat = peer.asked().await;
                    *submitted.lock().unwrap() = Some(chat);
                    let _ = peer.socket.close(None).await;
                    return;
                }
                let chat = submitted.lock().unwrap().clone().expect("first chat");
                peer.send(json!({
                    "type": "session.history",
                    "version": 1,
                    "messages": [
                        {"type": "chat.message", "messageId": "msg_recovered", "timestamp": chat["timestamp"],
                         "text": chat["text"], "role": "user"},
                        {"type": "chat.message", "messageId": "msg_result", "timestamp": chat["timestamp"].as_i64().unwrap() + 1,
                         "text": "The battery is at 80%.", "role": "agent"}
                    ]
                }))
                .await;
                peer.send(idle()).await;
                peer.until_closed().await;
            }
        })
        .await;

        let directory = std::env::temp_dir().join(format!("cosmos-os3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let snapshot = directory.join("state.json");
        let keys: SharedKeyDirectory = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let open = || {
            ConversationStore::new(
                Arc::new(crate::store::MemoryStore::at_path(snapshot.clone())),
                keys.clone(),
                OWNER,
            )
        };
        mock.saved = open();

        assert_eq!(
            mock.ask("Read my MacBook battery", Duration::from_secs(2))
                .await,
            Err(Os3Error::Dropped)
        );
        let dropped = mock.conversation().await;
        assert_eq!(dropped.session_id.as_deref(), Some("session_a"));
        assert!(dropped.in_flight.is_some());
        mock.restart(open());
        assert_eq!(
            mock.ask("What did OS3 find?", Duration::from_secs(2))
                .await
                .unwrap(),
            "OS3 replied: The battery is at 80%.\nOS3 hasn't confirmed this request is complete."
        );
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            1,
            "recovery must not submit the task or follow-up again"
        );
        assert!(mock.conversation().await.in_flight.is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// A sealed journal of this account's session asked `asked_at` ms ago.
    fn journal_conversation(cookie: &str, asked_at: i64) -> Conversation {
        Conversation {
            cookie: Some(cookie_digest(cookie)),
            session_id: Some("session_a".to_owned()),
            in_flight: Some(InFlight {
                cancel: false,
                request_digest: request_digest("Inspect my Mac", asked_at),
                asked_at,
            }),
            unfinished: None,
        }
    }

    fn chats(mock: &Mock) -> Vec<String> {
        mock.sent()
            .iter()
            .filter(|message| message["type"] == "chat.message")
            .map(|message| message["text"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    /// An OS3 that answers any question it is sent with `reply`.
    async fn answering(reply: &'static str) -> Mock {
        mock(StatusCode::OK, "instance-1", move |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_new").await;
            peer.send(agent_reply("msg_new_reply", reply)).await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await
    }

    /// A question lost under a previous sign-in cannot be checked with this
    /// one. It used to hold every later OS3 question as "dropped" while the
    /// Test said Connected. Now it ends once, with one line, and the wearer's
    /// new words are sent.
    #[tokio::test]
    async fn a_journal_from_another_sign_in_ends_once_and_the_new_request_is_sent() {
        let mock = answering("Safari is open.").await;
        let recent = i64::try_from(now_ms()).unwrap() - 60_000;
        assert!(
            mock.saved
                .save(&journal_conversation(OTHER_COOKIE, recent))
                .await
        );

        assert_eq!(
            mock.ask("Ask OS3 to open Safari on my Mac", Duration::from_secs(5))
                .await
                .unwrap(),
            format!(
                "{EARLIER_UNCONFIRMED}\nOS3 replied: Safari is open.\nOS3 hasn't confirmed this request is complete."
            )
        );
        assert_eq!(chats(&mock), vec!["Ask OS3 to open Safari on my Mac"]);
        assert!(
            mock.inits()[0].get("sessionId").is_none(),
            "the other sign-in's session is not resumed"
        );
        let saved = mock.conversation().await;
        assert!(saved.in_flight.is_none());
        assert_eq!(saved.cookie, Some(cookie_digest(COOKIE_VALUE)));
    }

    /// A journal too old to recover, or unreadable, ends the same way instead
    /// of holding OS3 closed for good.
    #[tokio::test]
    async fn an_expired_or_unreadable_journal_ends_once_and_the_new_request_is_sent() {
        let expired = i64::try_from(now_ms()).unwrap() - JOURNAL_LIMIT_MS - 60_000;
        let unreadable = Conversation {
            in_flight: Some(InFlight::blocked()),
            ..journal_conversation(COOKIE_VALUE, expired)
        };
        for saved in [journal_conversation(COOKIE_VALUE, expired), unreadable] {
            let mock = answering("Safari is open.").await;
            assert!(mock.saved.save(&saved).await);
            assert_eq!(
                mock.ask("Ask OS3 to open Safari on my Mac", Duration::from_secs(5))
                    .await
                    .unwrap(),
                format!(
                    "{EARLIER_UNCONFIRMED}\nOS3 replied: Safari is open.\nOS3 hasn't confirmed this request is complete."
                )
            );
            assert_eq!(chats(&mock), vec!["Ask OS3 to open Safari on my Mac"]);
            assert!(mock.conversation().await.in_flight.is_none());
        }
    }

    /// An OS3 that lost the first question: that connection closes before
    /// Rabbit records it, and every later history is complete without it.
    async fn never_received() -> Mock {
        let connection = Arc::new(AtomicUsize::new(0));
        mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    peer.asked().await;
                    let _ = peer.socket.close(None).await;
                    return;
                }
                peer.send(json!({
                    "type": "session.history",
                    "version": 1,
                    "messages": [
                        {"type": "chat.message", "messageId": "msg_before", "timestamp": 1_600_000_000_000_i64,
                         "text": "Unrelated", "role": "agent"}
                    ]
                }))
                .await;
                let Some(chat) = peer.recv().await else { return };
                if chat["type"] == "chat.message" {
                    peer.send(echo("msg_new", &chat)).await;
                    peer.send(agent_reply("msg_new_reply", "Safari is open.")).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await
    }

    /// A complete history without the lost question's echo proves OS3 never
    /// received it. A status question hears exactly that. The journal ends,
    /// so the next request is sent rather than failing as "dropped" forever.
    #[tokio::test]
    async fn a_question_os3_never_received_is_reported_and_releases_the_journal() {
        let mock = never_received().await;
        assert_eq!(
            mock.ask("Ask OS3 to read my MacBook battery", Duration::from_secs(2))
                .await,
            Err(Os3Error::Dropped)
        );
        assert!(mock.conversation().await.in_flight.is_some());

        assert_eq!(
            mock.ask("What did OS3 find?", Duration::from_secs(5))
                .await
                .unwrap(),
            format!("{EARLIER_NOT_RECEIVED} {ASK_AGAIN}")
        );
        assert_eq!(
            chats(&mock),
            vec!["Ask OS3 to read my MacBook battery"],
            "a status question sends nothing"
        );
        assert!(mock.conversation().await.in_flight.is_none());

        assert_eq!(
            mock.ask("Ask OS3 to open Safari on my Mac", Duration::from_secs(5))
                .await
                .unwrap(),
            "OS3 replied: Safari is open.\nOS3 hasn't confirmed this request is complete."
        );
        assert_eq!(chats(&mock).len(), 2);
    }

    /// When the request after the lost question is new work, it goes to OS3
    /// on the same connection once the history proves the first never arrived.
    #[tokio::test]
    async fn new_work_after_a_question_os3_never_received_is_sent_at_once() {
        let mock = never_received().await;
        assert_eq!(
            mock.ask("Ask OS3 to read my MacBook battery", Duration::from_secs(2))
                .await,
            Err(Os3Error::Dropped)
        );
        assert_eq!(
            mock.ask("Ask OS3 to open Safari on my Mac", Duration::from_secs(5))
                .await
                .unwrap(),
            format!(
                "{EARLIER_NOT_RECEIVED}\nOS3 replied: Safari is open.\nOS3 hasn't confirmed this request is complete."
            )
        );
        assert_eq!(
            chats(&mock),
            vec![
                "Ask OS3 to read my MacBook battery",
                "Ask OS3 to open Safari on my Mac"
            ]
        );
        assert!(mock.conversation().await.in_flight.is_none());
    }

    /// Recovering a lost question reads its result and sends nothing. When
    /// the wearer asked for new work instead of that status, the answer says
    /// the result is the earlier one and that the new request was not sent,
    /// rather than presenting the battery reading as the lock's reply. The
    /// next request is sent.
    #[tokio::test]
    async fn recovery_never_presents_the_earlier_result_as_a_new_requests_reply() {
        let connection = Arc::new(AtomicUsize::new(0));
        let submitted = Arc::new(Mutex::new(None::<Value>));
        let server_submitted = submitted.clone();
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            let submitted = server_submitted.clone();
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    let chat = peer.asked().await;
                    *submitted.lock().unwrap() = Some(chat);
                    let _ = peer.socket.close(None).await;
                    return;
                }
                let chat = submitted.lock().unwrap().clone().expect("first chat");
                peer.send(json!({
                    "type": "session.history",
                    "version": 1,
                    "messages": [
                        {"type": "chat.message", "messageId": "msg_recovered", "timestamp": chat["timestamp"],
                         "text": chat["text"], "role": "user"},
                        {"type": "chat.message", "messageId": "msg_result", "timestamp": chat["timestamp"].as_i64().unwrap() + 1,
                         "text": "The battery is at 80%.", "role": "agent"}
                    ]
                }))
                .await;
                peer.send(idle()).await;
                if connection >= 2 {
                    peer.question("msg_lock").await;
                    peer.send(agent_reply("msg_locked", "Your Mac is locked.")).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;

        assert_eq!(
            mock.ask("Ask OS3 to read my MacBook battery", Duration::from_secs(2))
                .await,
            Err(Os3Error::Dropped)
        );
        assert_eq!(
            mock.ask("Ask OS3 to lock my Mac now", Duration::from_secs(5))
                .await
                .unwrap(),
            format!(
                "Earlier OS3 result: The battery is at 80%.\n{BOUNDED_UNCONFIRMED}\n{NEW_REQUEST_NOT_SENT}"
            )
        );
        assert_eq!(chats(&mock), vec!["Ask OS3 to read my MacBook battery"]);
        assert!(mock.conversation().await.in_flight.is_none());

        let locked = mock
            .ask("Ask OS3 to lock my Mac now", Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            locked.ends_with(
                "OS3 replied: Your Mac is locked.\nOS3 hasn't confirmed this request is complete."
            ),
            "{locked}"
        );
        assert!(!locked.contains(NEW_REQUEST_NOT_SENT), "{locked}");
        assert_eq!(chats(&mock).len(), 2);
    }

    /// A conversation Cosmos cannot read is Cosmos's own storage failing, not
    /// OS3 being unreachable: it is named as such, OS3 is not contacted, and
    /// Center's OS3 connection status is left as it was.
    #[tokio::test]
    async fn an_unreadable_conversation_is_named_as_storage_not_os3() {
        let mock = answering("unused").await;
        assert!(mock.saved.save(&Conversation::default()).await);
        let malformed = mock
            .saved
            .keys
            .seal(&mock.saved.kid(), b"not json", CONVERSATION_AAD)
            .await
            .unwrap()
            .unwrap();
        mock.saved
            .store
            .put_account_blob(OWNER, AccountBlobKind::Os3Conversation, &malformed.data)
            .await
            .unwrap();

        assert_eq!(
            mock.ask("Ask OS3 to open Safari on my Mac", Duration::from_secs(2))
                .await,
            Err(Os3Error::ConversationStorage)
        );
        assert_eq!(
            mock.http_hits.load(Ordering::SeqCst),
            0,
            "OS3 was not contacted"
        );
        assert_eq!(Os3Error::ConversationStorage.state(), None);
        assert!(
            Os3Error::ConversationStorage
                .observation()
                .contains("could not read or save its OS3 conversation")
        );
    }

    #[tokio::test]
    async fn recovery_rejects_a_malformed_or_replaced_session_ack() {
        // A fresh journal: one past `JOURNAL_LIMIT_MS` ends instead.
        let asked_at = i64::try_from(now_ms()).unwrap() - 60_000;
        let journal = InFlight {
            cancel: false,
            request_digest: request_digest("Inspect my Mac", asked_at),
            asked_at,
        };
        let recovering = || Conversation {
            cookie: Some(cookie_digest(COOKIE_VALUE)),
            session_id: Some("session_a".to_owned()),
            in_flight: Some(journal.clone()),
            unfinished: None,
        };

        let malformed = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            let init = peer.recv().await.expect("init");
            assert_eq!(init["sessionId"], "session_a");
            peer.send(json!({
                "type": "init_ack",
                "version": 1,
                "timestamp": 1_700_000_000_100_i64,
                "sessionId": "",
                "butlerName": "Butler"
            }))
            .await;
            peer.until_closed().await;
        })
        .await;
        assert!(malformed.saved.save(&recovering()).await);
        assert_eq!(
            malformed
                .ask("What did OS3 find?", Duration::from_secs(5))
                .await,
            Err(Os3Error::SocketRefused)
        );
        assert!(
            malformed
                .sent()
                .iter()
                .all(|message| message["type"] != "chat.message"),
            "a malformed acknowledgement must not authorize recovery or a new task"
        );
        assert!(malformed.conversation().await.in_flight.is_some());

        let replaced = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            let init = peer.recv().await.expect("init");
            assert_eq!(init["sessionId"], "session_a");
            peer.send(json!({
                "type": "init_ack",
                "version": 1,
                "timestamp": 1_700_000_000_100_i64,
                "sessionId": "session_b",
                "butlerName": "Butler"
            }))
            .await;
            peer.until_closed().await;
        })
        .await;
        assert!(replaced.saved.save(&recovering()).await);
        assert_eq!(
            replaced
                .ask("What did OS3 find?", Duration::from_secs(5))
                .await,
            Err(Os3Error::Dropped)
        );
        assert!(
            replaced
                .sent()
                .iter()
                .all(|message| message["type"] != "chat.message"),
            "a replacement session cannot observe or resubmit the old task"
        );
        let saved = replaced.conversation().await;
        assert_eq!(saved.session_id.as_deref(), Some("session_a"));
        assert!(saved.in_flight.is_some());
    }

    #[tokio::test]
    async fn a_failed_pre_send_journal_checkpoint_sends_no_chat() {
        let mut mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.until_closed().await;
        })
        .await;
        let store: SharedStore = Arc::new(crate::store::MemoryStore::default());
        let keys = Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        keys.fail_next(crate::keydirectory::DirectoryFault::Put);
        mock.saved = ConversationStore::new(store, keys, OWNER);

        assert_eq!(
            mock.ask("Inspect my Mac", Duration::from_secs(2)).await,
            Err(Os3Error::ConversationStorage),
            "Cosmos's own storage failed, not the connection to OS3"
        );
        assert!(
            mock.sent()
                .iter()
                .all(|message| message["type"] != "chat.message"),
            "the socket must close before the task can be submitted"
        );
        assert!(
            mock.conversation().await.in_flight.is_none(),
            "the final save must not fabricate a journal for an unsent task"
        );
    }

    #[tokio::test]
    async fn recovery_returns_pending_state_and_ignores_an_unknown_background_worker() {
        let connection = Arc::new(AtomicUsize::new(0));
        let submitted = Arc::new(Mutex::new(None::<Value>));
        let server_submitted = submitted.clone();
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            let submitted = server_submitted.clone();
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    let chat = peer.asked().await;
                    *submitted.lock().unwrap() = Some(chat);
                    let _ = peer.socket.close(None).await;
                    return;
                }
                let chat = submitted.lock().unwrap().clone().expect("first chat");
                let asked_at = chat["timestamp"].as_i64().unwrap();
                peer.send(worker_step(
                    "agent_background",
                    json!({"kind": "tool_call", "text": "Unrelated"}),
                ))
                .await;
                peer.send(json!({
                    "type": "session.history",
                    "version": 1,
                    "messages": [
                        {"type": "chat.message", "messageId": "msg_recovered", "timestamp": asked_at,
                         "text": chat["text"], "role": "user"},
                        {"type": "chat.message", "messageId": "msg_ack", "timestamp": asked_at + 1,
                         "text": "Let me check your Mac.", "role": "agent"}
                    ]
                }))
                .await;
                peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                    {"agentId": "agent_background", "title": "Old task", "state": "running",
                     "createdAt": asked_at - 1},
                    {"agentId": "agent_mac", "title": "Read the battery", "state": "running",
                     "createdAt": asked_at + 2}
                ]}))
                .await;
                let _ = peer.socket.close(None).await;
            }
        })
        .await;

        assert_eq!(
            mock.ask("Read my MacBook battery", Duration::from_secs(2))
                .await,
            Err(Os3Error::Dropped)
        );
        let status = mock
            .ask("What did OS3 find?", Duration::from_secs(2))
            .await
            .unwrap();
        assert!(
            status.contains("OS3 replied: Let me check your Mac."),
            "{status}"
        );
        assert!(
            status.contains("OS3 is still working on: Read the battery."),
            "{status}"
        );
        assert!(!status.contains("Old task"), "{status}");
        let conversation = mock.conversation().await;
        assert!(conversation.in_flight.is_none());
        let unfinished = conversation.unfinished.expect("the task is still running");
        assert_eq!(unfinished.boundary.as_deref(), Some("msg_recovered"));
        assert_eq!(
            unfinished.agents,
            HashMap::from([("agent_mac".to_owned(), "Read the battery".to_owned())])
        );
        assert_eq!(
            mock.sent()
                .iter()
                .filter(|message| message["type"] == "chat.message")
                .count(),
            1
        );
    }

    /// A worker started for the question finishes, and OS3 then relays what
    /// it found in a message of its own. The answer waits for that message,
    /// and reads in the order OS3 said it.
    #[tokio::test]
    async fn a_finished_task_waits_for_the_answer_os3_relays() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.question("msg_user").await;
            peer.send(json!({"type": "conversation.processing", "version": 1}))
                .await;
            peer.send(agent_reply("msg_ack", "Let me check your Mac."))
                .await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                {"agentId": "agent_mac", "title": "Check the Mac", "state": "running", "createdAt": 1_700_000_001_200_i64}]}))
            .await;
            peer.send(idle()).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let ext = if chat["text"] == "With a result" {
                json!({"result": "Task completed.", "resultFiles": []})
            } else {
                json!({"resultFiles": []})
            };
            peer.send(json!({"type": "agent.completed", "version": 1, "agentId": "agent_mac", "fromState": "running", "ext": ext}))
                .await;
            peer.send(json!({"type": "conversation.processing", "version": 1}))
                .await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            peer.send(agent_reply(
                "msg_final",
                "Your desktop has two folders: Taxes and Photos.",
            ))
            .await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;
        for (question, finished) in [
            (
                "With a result",
                "OS3 finished \"Check the Mac\": Task completed.",
            ),
            ("Without one", "OS3 finished \"Check the Mac\"."),
        ] {
            let started = std::time::Instant::now();
            let answer = mock.ask(question, Duration::from_secs(5)).await.unwrap();
            assert_eq!(
                answer,
                format!(
                    "OS3 replied: Let me check your Mac.\n{finished}\n\
                     OS3 replied: Your desktop has two folders: Taxes and Photos."
                )
            );
            assert!(started.elapsed() < Duration::from_secs(2), "{question}");
        }
        assert!(
            mock.conversation().await.unfinished.is_none(),
            "finished work is not carried to the next question"
        );
    }

    /// OS3 answers only through the task's completion: that is the answer,
    /// promptly, with nothing said to be still running.
    #[tokio::test]
    async fn a_completion_alone_answers_without_waiting_out_the_window() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(json!({"type": "conversation.processing", "version": 1}))
                .await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                {"agentId": "agent_mac", "title": "Check the Mac", "state": "running", "createdAt": 1_700_000_001_200_i64}]}))
            .await;
            peer.send(idle()).await;
            peer.send(json!({"type": "agent.completed", "version": 1, "agentId": "agent_mac", "ext": {"result": "Two folders."}}))
                .await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;
        let started = std::time::Instant::now();
        assert_eq!(
            mock.ask("Mac?", Duration::from_secs(4)).await.unwrap(),
            "OS3 finished \"Check the Mac\": Two folders."
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// A worker started for the question fails while the socket is open. The
    /// failure is reported, and nothing is said to be still running.
    #[tokio::test]
    async fn a_task_failing_during_the_question_is_reported() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(agent_reply("msg_ack", "Let me check your Mac."))
                .await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                {"agentId": "agent_mac", "title": "Check the Mac", "state": "running", "createdAt": 1_700_000_001_200_i64}]}))
            .await;
            peer.send(idle()).await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                {"agentId": "agent_mac", "title": "Check the Mac", "state": "failed", "createdAt": 1_700_000_001_200_i64}]}))
            .await;
            peer.until_closed().await;
        })
        .await;
        assert_eq!(
            mock.ask("Mac?", Duration::from_millis(1_500))
                .await
                .unwrap(),
            "OS3 replied: Let me check your Mac.\nOS3 could not finish \"Check the Mac\"."
        );
        assert!(
            mock.conversation()
                .await
                .unfinished
                .is_none_or(|unfinished| unfinished.agents.is_empty()),
            "a failed task is not carried forward"
        );
    }

    /// OS3 sends its relay before the work's end arrives, and goes idle in
    /// between: the complete answer returns once OS3 stays quiet for
    /// [`RELAY_GRACE`], not when the window closes. A relay that starts within
    /// the grace is still waited for.
    #[tokio::test]
    async fn a_relay_before_the_work_ends_does_not_wait_out_the_window() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.question("msg_user").await;
            peer.send(json!({"type": "conversation.processing", "version": 1}))
                .await;
            peer.send(agent_reply("msg_ack", "Let me check your Mac."))
                .await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                {"agentId": "agent_mac", "title": "Check the Mac", "state": "running", "createdAt": 1_700_000_001_200_i64}]}))
            .await;
            let completed = json!({"type": "agent.completed", "version": 1, "agentId": "agent_mac", "ext": {"resultFiles": []}});
            if chat["text"] == "Relayed first" {
                peer.send(agent_reply("msg_final", "Your desktop has two folders."))
                    .await;
                peer.send(idle()).await;
                peer.send(completed).await;
            } else {
                peer.send(idle()).await;
                peer.send(completed).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
                peer.send(json!({"type": "conversation.processing", "version": 1}))
                    .await;
                peer.send(agent_reply("msg_final", "Your desktop has two folders."))
                    .await;
                peer.send(idle()).await;
            }
            peer.until_closed().await;
        })
        .await;
        for (question, answer) in [
            (
                "Relayed first",
                "OS3 replied: Let me check your Mac.\nOS3 replied: Your desktop has two folders.\n\
                 OS3 finished \"Check the Mac\".",
            ),
            (
                "Relayed later",
                "OS3 replied: Let me check your Mac.\nOS3 finished \"Check the Mac\".\n\
                 OS3 replied: Your desktop has two folders.",
            ),
        ] {
            let started = std::time::Instant::now();
            assert_eq!(
                mock.ask(question, Duration::from_secs(20)).await.unwrap(),
                answer
            );
            assert!(
                started.elapsed() < RELAY_GRACE + Duration::from_secs(2),
                "{question}"
            );
            assert!(
                mock.conversation()
                    .await
                    .unfinished
                    .is_none_or(|unfinished| unfinished.agents.is_empty()),
                "{question}: finished work is not carried to the next question"
            );
        }
    }

    /// OS3 starts its relay only after [`RELAY_GRACE`] of quiet: the question
    /// still ends with what it has, and the next question hears the relay as
    /// an earlier result instead of losing it.
    #[tokio::test]
    async fn a_relay_later_than_the_grace_reaches_the_next_question() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    peer.question("msg_user_1").await;
                    peer.send(json!({"type": "conversation.processing", "version": 1}))
                        .await;
                    peer.send(agent_reply("msg_ack", "Let me check your Mac."))
                        .await;
                    peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                        {"agentId": "agent_mac", "title": "Check the Mac", "state": "running", "createdAt": 1_700_000_001_200_i64}]}))
                    .await;
                    peer.send(idle()).await;
                    peer.send(json!({"type": "agent.completed", "version": 1, "agentId": "agent_mac", "ext": {"resultFiles": []}}))
                        .await;
                    // By now the client has stopped waiting and closed.
                    tokio::time::sleep(RELAY_GRACE + Duration::from_millis(500)).await;
                    peer.send(json!({"type": "conversation.processing", "version": 1}))
                        .await;
                    peer.send(agent_reply("msg_late", "Your desktop has two folders."))
                        .await;
                } else {
                    peer.send(late_history()).await;
                    peer.question("msg_user_2").await;
                    peer.send(agent_reply("msg_reply_2", "You're welcome."))
                        .await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;

        let started = std::time::Instant::now();
        assert_eq!(
            mock.ask("What is on my Mac's desktop?", Duration::from_secs(20))
                .await
                .unwrap(),
            "OS3 replied: Let me check your Mac.\nOS3 finished \"Check the Mac\"."
        );
        assert!(started.elapsed() < RELAY_GRACE + Duration::from_secs(2));

        let later = mock.ask("Thanks", Duration::from_secs(10)).await.unwrap();
        assert_eq!(
            later,
            "Earlier OS3 result: Your desktop has two folders.\nOS3 replied: You're welcome.\nOS3 hasn't confirmed this request is complete."
        );
        let retained = mock
            .conversation()
            .await
            .unfinished
            .expect("marker-free new Ask remains unconfirmed");
        assert_eq!(retained.boundary.as_deref(), Some("msg_user_2"));
        assert!(
            retained.reported.contains("msg_late"),
            "the old relay is reported once"
        );
    }

    /// An error OS3 reports ends the question at once: the wearer hears that
    /// OS3 reported an error, beside whatever it said before, never that it
    /// is still working or unreachable.
    #[tokio::test]
    async fn an_error_from_os3_ends_the_question_and_says_so() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            if chat["text"] != "Before" {
                peer.send(echo("msg_user", &chat)).await;
                peer.send(json!({"type": "conversation.processing", "version": 1}))
                    .await;
            }
            if chat["text"] == "Part way" {
                peer.send(agent_reply("msg_ack", "Let me check.")).await;
            }
            peer.send(
                json!({"type": "error", "version": 1, "code": "internal_error", "message": "boom"}),
            )
            .await;
            peer.until_closed().await;
        })
        .await;
        for (question, answer) in [
            ("Nothing yet", ERRORED_AFTER_TAKEN.to_owned()),
            (
                "Part way",
                format!("OS3 replied: Let me check.\n{ERRORED_PART_WAY}"),
            ),
            ("Before", ERRORED_BEFORE_TAKEN.to_owned()),
        ] {
            let started = std::time::Instant::now();
            let asked = mock
                .client
                .ask(
                    COOKIE_VALUE,
                    question,
                    RequestKind::Ask,
                    Instant::now() + Duration::from_secs(20),
                    Some(&mock.saved),
                )
                .await;
            assert_eq!(asked.answer.as_deref(), Ok(answer.as_str()), "{question}");
            assert!(started.elapsed() < Duration::from_secs(2), "{question}");
            // The connection itself worked.
            assert_eq!(
                contact(&asked.answer, asked.connected_as, asked.interrupted),
                Some((Os3State::Connected, Some("Butler".to_owned()))),
                "{question}"
            );
        }
    }

    /// Oversized replies are reported without their content. Without own
    /// terminal evidence the accepted Ask remains bounded and unconfirmed.
    #[tokio::test]
    async fn an_oversized_reply_is_reported_not_waited_out() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            peer.question("msg_user").await;
            peer.send(json!({"type": "conversation.processing", "version": 1}))
                .await;
            peer.send(agent_reply("msg_big", &"word ".repeat(MAX_EVENT_BYTES / 4)))
                .await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;
        let started = std::time::Instant::now();
        assert_eq!(
            mock.ask("Everything?", Duration::from_millis(1500)).await,
            Ok(format!("{TOO_LARGE_REPLY}\n{BOUNDED_UNCONFIRMED}"))
        );
        assert!(started.elapsed() >= Duration::from_millis(1400));
        assert!(started.elapsed() < Duration::from_secs(3));

        let unplaced =
            json!({"type": "chat.message", "role": "agent", "text": "x".repeat(MAX_EVENT_BYTES)})
                .to_string();
        assert_eq!(
            oversized_event(&unplaced),
            None,
            "without an ID it is skipped"
        );
    }

    /// A long-lived account's history snapshot outgrows what one message is
    /// read whole at. The question still works, and a follow-up still finds
    /// the late result among the snapshot's latest messages.
    #[tokio::test]
    async fn an_oversized_history_snapshot_does_not_break_questions() {
        fn padded(count: usize, tail: Vec<Value>) -> Value {
            let text = "word ".repeat(2_000);
            let mut messages: Vec<Value> = (0..count)
                .map(|n| json!({"type": "chat.message", "messageId": format!("msg_old_{n}"), "text": text, "role": "agent"}))
                .collect();
            messages.extend(tail);
            json!({"type": "session.history", "version": 1, "messages": messages})
        }
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack("session_a").await;
                if connection == 0 {
                    peer.send(padded(450, Vec::new())).await;
                    peer.question("msg_user_1").await;
                    peer.send(json!({"type": "conversation.processing", "version": 1}))
                        .await;
                } else {
                    peer.send(padded(450, vec![
                        json!({"type": "chat.message", "messageId": "msg_user_1", "text": "Q", "role": "user"}),
                        json!({"type": "chat.message", "messageId": "msg_late", "text": "Two folders.", "role": "agent"}),
                    ]))
                    .await;

                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;
        assert_eq!(
            mock.ask("Desktop?", Duration::from_millis(1_500)).await,
            Ok(BOUNDED_UNCONFIRMED.to_owned())
        );
        assert_eq!(
            mock.ask("What did OS3 find?", Duration::from_secs(5)).await,
            Ok(
                "Earlier OS3 result: Two folders.\nOS3 hasn't confirmed this request is complete."
                    .to_owned()
            )
        );

        let oversized = padded(450, Vec::new()).to_string();
        assert!(oversized.len() > MAX_EVENT_BYTES);
        let latest = oversized_event(&oversized).expect("a snapshot");
        let kept = latest["messages"].as_array().unwrap();
        assert_eq!(kept.len(), MAX_SNAPSHOT_MESSAGES);
        assert_eq!(kept.last().unwrap()["messageId"], "msg_old_449");
        let other =
            json!({"type": "chat.message", "text": "x".repeat(MAX_EVENT_BYTES)}).to_string();
        assert_eq!(oversized_event(&other), None, "anything else is skipped");
    }

    /// File and table cards say what they hold instead of "no readable
    /// text".
    #[test]
    fn file_and_table_cards_are_spoken() {
        let card = json!({"type": "chat.message", "messageId": "msg_file", "text": "", "role": "agent",
            "cardSpec": {"root": ["f", "t", "i"], "elements": {
                "f": {"type": "file", "props": {"name": "taxes-2025.pdf", "size": "1.2 MB", "path": "/Users/owner/Documents/taxes-2025.pdf"}},
                "t": {"type": "table", "props": {"columns": ["Name", "Size"], "rows": [["taxes-2025.pdf", "1.2 MB"], ["notes.txt", 12]]}},
                "i": {"type": "image", "props": {"src": "/files/x"}}}}});
        assert_eq!(
            spoken_text(&card),
            "File: taxes-2025.pdf (1.2 MB). A table with 2 rows (Name, Size): \
             taxes-2025.pdf, 1.2 MB; notes.txt, 12."
        );
        let mut exchange = Exchange::new(None);
        exchange.boundary = Some("msg_user".to_owned());
        exchange.reply(&card, false);
        assert!(
            exchange
                .render()
                .unwrap()
                .starts_with("OS3 replied: File: taxes-2025.pdf")
        );
        let image_only = json!({"messageId": "msg_image", "role": "agent",
            "cardSpec": {"root": ["i"], "elements": {"i": {"type": "image", "props": {}}}}});
        assert_eq!(spoken_text(&image_only), "");
    }

    /// Earlier results can fill an answer to a question OS3 never took. The
    /// wearer still hears that this question went unanswered, and Center does
    /// not record the contact as connected.
    #[test]
    fn earlier_results_do_not_hide_a_question_os3_never_took() {
        let unfinished = || Unfinished {
            agents: HashMap::from([("agent_mac".to_owned(), "Check the Mac".to_owned())]),
            ..Unfinished::default()
        };
        let ended = json!({"type": "agent.list", "agents": [{"agentId": "agent_mac", "state": "completed"}]});
        for (closed, step) in [(false, Os3Error::NoAnswer), (true, Os3Error::Dropped)] {
            let mut exchange = Exchange::new(Some(unfinished()));
            exchange.observe(&ended);
            exchange.closed = closed;
            let answer = exchange.render();
            assert_eq!(
                answer.as_deref(),
                Ok(format!(
                    "OS3 finished the earlier task \"Check the Mac\".\n{}",
                    step.observation()
                )
                .as_str())
            );
            assert_eq!(exchange.interrupted(), Some(step));
            assert_eq!(
                contact(&answer, Some("Butler".to_owned()), exchange.interrupted()),
                step.state().map(|state| (state, None))
            );
        }
    }

    /// A second question while the first holds OS3 for its whole window is
    /// told OS3 is busy, never that OS3 did not answer: it was never asked.
    #[tokio::test]
    async fn a_second_concurrent_question_is_busy() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.question("msg_user").await;
            if chat["text"] != "Slow one" {
                peer.send(agent_reply("msg_reply", "Quick answer.")).await;
                peer.send(idle()).await;
            }
            peer.until_closed().await;
        })
        .await;
        let later = |within: Duration| {
            let mock = &mock;
            async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                mock.ask("Quick one", within).await
            }
        };
        let (slow, quick) = tokio::join!(
            mock.ask("Slow one", Duration::from_millis(1_500)),
            later(Duration::from_millis(1_500))
        );
        assert!(slow.is_ok());
        assert_eq!(quick, Err(Os3Error::Busy));
        let questions = mock
            .sent()
            .into_iter()
            .filter(|message| message["type"] == "chat.message")
            .count();
        assert_eq!(questions, 1, "the second question never reached OS3");

        // With time left once the first is done, the second is asked.
        let (_, quick) = tokio::join!(
            mock.ask("Slow one", Duration::from_millis(1_500)),
            later(Duration::from_secs(6))
        );
        assert_eq!(
            quick,
            Ok(
                "OS3 replied: Quick answer.\nOS3 hasn't confirmed this request is complete."
                    .to_owned()
            )
        );
    }

    /// An echo without OS3's timestamp is placed by when the question was
    /// sent: a worker created long before the question is not taken for its
    /// work, and one OS3 started for it before the echo arrived here is.
    #[tokio::test]
    async fn an_echo_without_a_timestamp_still_tells_old_work_from_new() {
        let mock = mock(StatusCode::OK, "instance-1", |mut peer| async move {
            peer.ack("session_a").await;
            let chat = peer.asked().await;
            let started_for_it = now_ms() as i64;
            let mut echoed = echo("msg_user", &chat);
            echoed.as_object_mut().unwrap().remove("timestamp");
            // The echo is still on its way when OS3 starts the work.
            tokio::time::sleep(Duration::from_millis(50)).await;
            peer.send(echoed).await;
            peer.send(json!({"type": "agent.list", "version": 1, "agents": [
                {"agentId": "agent_old", "title": "Old chore", "state": "running", "createdAt": 1_600_000_000_000_i64},
                {"agentId": "agent_mac", "title": "Check the Mac", "state": "running", "createdAt": started_for_it}]}))
            .await;
            peer.send(agent_reply("msg_reply", "Let me check.")).await;
            peer.send(idle()).await;
            peer.send(json!({"type": "agent.completed", "version": 1, "agentId": "agent_mac", "ext": {"result": "Two folders."}}))
                .await;
            peer.send(idle()).await;
            peer.until_closed().await;
        })
        .await;
        let started = std::time::Instant::now();
        assert_eq!(
            mock.ask("Desktop?", Duration::from_secs(3)).await,
            Ok(
                "OS3 replied: Let me check.\nOS3 finished \"Check the Mac\": Two folders."
                    .to_owned()
            )
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// OS3 never acknowledges a retained session. That question times out,
    /// and the next one starts a fresh session instead of waiting the same way.
    #[tokio::test]
    async fn a_session_os3_never_acknowledges_is_not_offered_again() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                match connection {
                    0 => peer.ack("session_a").await,
                    1 => {
                        let _ = peer.recv().await;
                        peer.until_closed().await;
                        return;
                    }
                    _ => peer.ack("session_b").await,
                }
                let echo_id = format!("msg_user_{connection}");
                peer.question(&echo_id).await;
                peer.send(agent_reply(&format!("{echo_id}_reply"), "Hi."))
                    .await;
                peer.send(idle()).await;
                peer.until_closed().await;
            }
        })
        .await;
        mock.ask("One", Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            mock.ask("Two", Duration::from_secs(12)).await,
            Err(Os3Error::NoAnswer)
        );
        assert_eq!(
            mock.ask("Three", Duration::from_secs(5)).await,
            Ok("OS3 replied: Hi.\nOS3 hasn't confirmed this request is complete.".to_owned())
        );
        let inits = mock.inits();
        assert_eq!(inits[1]["sessionId"], "session_a");
        assert!(
            inits[2].get("sessionId").is_none(),
            "the ignored session is not offered again"
        );
        assert_eq!(
            mock.conversation().await.session_id.as_deref(),
            Some("session_b")
        );
    }

    /// A new cookie may be another OS3 account: its questions neither resume
    /// the old session nor report the old account's unfinished work.
    #[tokio::test]
    async fn a_new_cookie_starts_a_fresh_conversation() {
        let connection = Arc::new(AtomicUsize::new(0));
        let mock = mock(StatusCode::OK, "instance-1", move |mut peer| {
            let connection = connection.fetch_add(1, Ordering::SeqCst);
            async move {
                peer.ack(if connection == 0 {
                    "session_a"
                } else {
                    "session_b"
                })
                .await;
                if connection == 0 {
                    leave_the_mac_check_running(&mut peer).await;
                } else {
                    peer.send(late_history()).await;
                    peer.question("msg_user_2").await;
                    peer.send(agent_reply("msg_reply_2", "Hello.")).await;
                    peer.send(idle()).await;
                }
                peer.until_closed().await;
            }
        })
        .await;
        mock.ask("What is on my Mac's desktop?", Duration::from_millis(1_500))
            .await
            .unwrap();
        assert!(mock.conversation().await.unfinished.is_some());

        let other = mock
            .client
            .ask(
                OTHER_COOKIE,
                "Hi",
                RequestKind::Ask,
                Instant::now() + Duration::from_secs(5),
                Some(&mock.saved),
            )
            .await;
        assert_eq!(
            other.answer.as_deref(),
            Ok("OS3 replied: Hello.\nOS3 hasn't confirmed this request is complete.")
        );
        let inits = mock.inits();
        assert!(
            inits[1].get("sessionId").is_none(),
            "the old account's session is not offered"
        );
        let conversation = mock.conversation().await;
        assert_eq!(conversation.cookie, Some(cookie_digest(OTHER_COOKIE)));
        assert_eq!(conversation.session_id.as_deref(), Some("session_b"));
        let retained = conversation
            .unfinished
            .expect("new account's marker-free Ask remains unconfirmed");
        assert_eq!(retained.boundary.as_deref(), Some("msg_user_2"));
        assert!(retained.agents.is_empty());
        assert!(!retained.reported.contains("msg_late"));
        assert_ne!(cookie_digest(COOKIE_VALUE), cookie_digest(OTHER_COOKIE));
        assert!(!cookie_digest(COOKIE_VALUE).contains("private"));
    }

    #[test]
    fn errors_and_config_debug_output_carry_no_secrets() {
        let config = crate::integrations::Os3Config {
            enabled: true,
            session_cookie: Some(COOKIE_VALUE.to_owned()),
        };
        assert!(!format!("{config:?}").contains("private-os3-cookie"));
        for error in [
            Os3Error::NotConfigured,
            Os3Error::Blocked,
            Os3Error::SignInExpired,
            Os3Error::NoInstance,
            Os3Error::SocketRefused,
            Os3Error::Busy,
            Os3Error::Unavailable,
            Os3Error::Dropped,
            Os3Error::NoAnswer,
            Os3Error::ConversationStorage,
        ] {
            assert!(!format!("{error:?}").contains("private"));
            assert!(!error.observation().is_empty());
            assert!(!error.label().is_empty());
        }
        assert!(valid_instance("0f8a-42"));
        assert!(!valid_instance(&"a".repeat(65)));
    }
}
