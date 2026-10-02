//! Web-grounded answer engine, Perplexity (`MODE_PPLX_API` in cosmos's backend
//! enumeration).
//!
//! Distinct from `web_search` (SerpApi): that returns raw result snippets for the
//! model to read. This returns a *synthesized, cited* answer from a web-connected
//! model. cosmos carried both as separate backends, so they are separate tools,
//! the assistant picks raw retrieval vs a ready answer per question.
//!
//! Perplexity's API is OpenAI-chat-shaped, so the request/response mirror the
//! `OpenAiChatModel` wire types. `COSMOS_PPLX_MODEL` overrides the model
//! (default `sonar`, their small online model).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{BackendError, http, key, refused};

const KEY_VAR: &str = "COSMOS_PPLX_API_KEY";
const MODEL_VAR: &str = "COSMOS_PPLX_MODEL";
const DEFAULT_MODEL: &str = "sonar";
/// The whole observation, answer and sources. The model is shown at most
/// `MAX_MODEL_FACING_OBSERVATION` of it, which this must not exceed.
pub(crate) const MAX_CHARS: usize = 1200;
/// The answer engine searches and writes before it replies. Live, "What is the
/// latest news in Denmark?" answers took 3.7 to 7.6 s, and 3 of 13 lookups
/// hit the shared 8 s vendor limit as "could not be reached", which the model
/// met by asking again. The run's own deadline still bounds the call.
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
struct ChatReq<'a> {
    model: &'a str,
    messages: [Msg<'a>; 1],
}
#[derive(Serialize)]
struct Msg<'a> {
    role: &'a str,
    content: &'a str,
}
#[derive(Deserialize)]
struct ChatResp {
    #[serde(default)]
    choices: Vec<Choice>,
    /// Perplexity appends the sources it grounded the answer on.
    #[serde(default)]
    citations: Vec<String>,
}
#[derive(Deserialize)]
struct Choice {
    message: RespMsg,
}
#[derive(Deserialize)]
struct RespMsg {
    #[serde(default)]
    content: String,
}

/// Ask the answer engine and render its reply (plus its sources) as an
/// observation.
pub async fn ask(question: &str) -> Result<String, BackendError> {
    let api_key = key(KEY_VAR).ok_or(BackendError::NotConfigured)?;
    let model = key(MODEL_VAR).unwrap_or_else(|| DEFAULT_MODEL.to_owned());

    let body = ChatReq {
        model: &model,
        messages: [Msg {
            role: "user",
            content: question,
        }],
    };
    let response = request(&api_key, &body).send().await.map_err(|error| {
        tracing::warn!(
            timeout = error.is_timeout(),
            "Perplexity could not be reached"
        );
        BackendError::Unavailable
    })?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    decode(status, &body)
}

/// Perplexity's answer: a refused key (401, 403) is not connected, any other
/// refusal (a mistyped `COSMOS_PPLX_MODEL` is a 400) or an unreadable body is
/// an outage, and the operator's log names the status either way.
fn decode(status: u16, body: &[u8]) -> Result<String, BackendError> {
    if !(200..300).contains(&status) {
        return Err(refused("perplexity", status));
    }
    let resp: ChatResp = serde_json::from_slice(body).map_err(|_| {
        tracing::warn!("Perplexity answered with an unreadable body");
        BackendError::Unavailable
    })?;
    render(&resp).ok_or(BackendError::NoResult)
}

fn request(api_key: &str, body: &ChatReq<'_>) -> reqwest::RequestBuilder {
    http()
        .post("https://api.perplexity.ai/chat/completions")
        .bearer_auth(api_key)
        .timeout(TIMEOUT)
        .json(body)
}

/// Strip screen-only syntax from an answer destined for speech.
///
/// Perplexity marks sources inline as `[1]`, `[2]`… and bolds with `**`. Both are
/// right on a screen and wrong in an ear: this text becomes an observation the
/// assistant may echo nearly verbatim into `Respond`, which is played through
/// TTS, where "bracket one" and "asterisk asterisk" are noise. Only the markup is
/// removed, no wording is changed, added, or summarized, so the model still
/// decides what to say. Sources survive separately in the `Sources:` line below.
fn despeak(answer: &str) -> String {
    let mut out = String::with_capacity(answer.len());
    let mut chars = answer.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' {
            // Consume a digit run followed by ']', a citation marker. Any other
            // bracketed content is real text and must survive intact.
            let mut digits = String::new();
            let mut matched = false;
            while let Some(&next) = chars.peek() {
                if next.is_ascii_digit() {
                    digits.push(next);
                    chars.next();
                } else {
                    if next == ']' && !digits.is_empty() {
                        chars.next();
                        matched = true;
                    }
                    break;
                }
            }
            if !matched {
                out.push('[');
                out.push_str(&digits);
            }
            continue;
        }
        out.push(c);
    }
    out.replace("**", "")
}

/// Render the answer + a few citations as one observation of at most
/// [`MAX_CHARS`], all of which the model is shown. Wording is passed through
/// untouched. Only screen-only markup is removed (see [`despeak`]).
fn render(resp: &ChatResp) -> Option<String> {
    let raw = resp.choices.first().map(|c| c.message.content.trim())?;
    let despoken = despeak(raw);
    let answer = despoken.trim();
    if answer.is_empty() {
        return None;
    }

    // A few grounding sources help the model judge and cite. Cap tightly.
    let mut sources = String::new();
    for citation in resp.citations.iter().take(3) {
        let entry = if sources.is_empty() {
            format!("\nSources: {citation}")
        } else {
            format!(", {citation}")
        };
        if sources.len() + entry.len() > MAX_CHARS / 4 {
            break;
        }
        sources.push_str(&entry);
    }

    // The answer gets what the sources leave, ending on its last whole
    // sentence or line. A longer observation reached the model cut mid-word,
    // marked "[truncated]" and without its sources.
    let budget = MAX_CHARS - sources.len();
    let mut out = if answer.len() <= budget {
        answer.to_owned()
    } else {
        let mut end = budget - '…'.len_utf8();
        while end > 0 && !answer.is_char_boundary(end) {
            end -= 1;
        }
        let clipped = &answer[..end];
        // "U.S. signed" does not end a sentence.
        let sentence_end = clipped
            .match_indices(". ")
            .filter(|(index, _)| !clipped[index + 2..].starts_with(char::is_lowercase))
            .map(|(index, _)| index + 1)
            .last();
        let cut = sentence_end
            .max(clipped.rfind('\n'))
            .filter(|index| *index > end / 2)
            .unwrap_or(end);
        format!("{}…", answer[..cut].trim_end())
    };
    out.push_str(&sources);
    Some(out)
}
