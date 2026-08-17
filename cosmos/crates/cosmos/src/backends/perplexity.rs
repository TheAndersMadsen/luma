//! Web-grounded answer engine — Perplexity (`MODE_PPLX_API` in carry's backend
//! enumeration).
//!
//! Distinct from `web_search` (SerpApi): that returns raw result snippets for the
//! model to read; this returns a *synthesized, cited* answer from a web-connected
//! model. carry carried both as separate backends, so they are separate tools —
//! the assistant picks raw retrieval vs a ready answer per question.
//!
//! Perplexity's API is OpenAI-chat-shaped, so the request/response mirror the
//! `OpenAiChatModel` wire types. `CARRY_PPLX_MODEL` overrides the model
//! (default `sonar`, their small online model).

use serde::{Deserialize, Serialize};

use super::{BackendError, http, key};

const KEY_VAR: &str = "CARRY_PPLX_API_KEY";
const MODEL_VAR: &str = "CARRY_PPLX_MODEL";
const DEFAULT_MODEL: &str = "sonar";
const MAX_CHARS: usize = 1200;

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
    let resp: ChatResp = http()
        .post("https://api.perplexity.ai/chat/completions")
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    render(&resp).ok_or(BackendError::NoResult)
}

/// Strip screen-only syntax from an answer destined for speech.
///
/// Perplexity marks sources inline as `[1]`, `[2]`… and bolds with `**`. Both are
/// right on a screen and wrong in an ear: this text becomes an observation the
/// assistant may echo nearly verbatim into `Respond`, which is played through
/// TTS, where "bracket one" and "asterisk asterisk" are noise. Only the markup is
/// removed — no wording is changed, added, or summarized, so the model still
/// decides what to say. Sources survive separately in the `Sources:` line below.
fn despeak(answer: &str) -> String {
    let mut out = String::with_capacity(answer.len());
    let mut chars = answer.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' {
            // Consume a digit run followed by ']' — a citation marker. Any other
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

/// Render the answer + a few citations, trimmed for the transcript. Wording is
/// passed through untouched; only screen-only markup is removed (see [`despeak`]).
fn render(resp: &ChatResp) -> Option<String> {
    let raw = resp.choices.first().map(|c| c.message.content.trim())?;
    let despoken = despeak(raw);
    let answer = despoken.trim();
    if answer.is_empty() {
        return None;
    }

    let mut out = if answer.len() <= MAX_CHARS {
        answer.to_owned()
    } else {
        let mut end = MAX_CHARS;
        while end > 0 && !answer.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &answer[..end])
    };

    // A few grounding sources help the model judge and cite. Cap tightly.
    let sources: Vec<&String> = resp.citations.iter().take(3).collect();
    if !sources.is_empty() {
        out.push_str("\nSources: ");
        out.push_str(
            &sources
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(content: &str, citations: &[&str]) -> ChatResp {
        ChatResp {
            choices: vec![Choice {
                message: RespMsg {
                    content: content.into(),
                },
            }],
            citations: citations.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn empty_answer_is_no_result() {
        assert!(render(&resp("   ", &[])).is_none());
        assert!(
            render(&ChatResp {
                choices: vec![],
                citations: vec![]
            })
            .is_none()
        );
    }

    #[test]
    fn citation_markers_and_bold_are_stripped_for_speech() {
        // Shape taken from a real `sonar` response.
        let r = resp(
            "Mars is currently about **362,548,923 km** from Earth, or about **2.42 AU**.[1]",
            &["https://example.invalid/a"],
        );
        let out = render(&r).unwrap();
        assert!(out.contains("362,548,923 km"));
        assert!(out.contains("2.42 AU"));
        // Neither may ever reach TTS.
        assert!(!out.contains("[1]"));
        assert!(!out.contains("**"));
        // Sources still reach the model, just not the sentence.
        assert!(out.contains("Sources: "));
    }

    #[test]
    fn genuine_bracketed_text_survives() {
        let r = resp("The array [a, b] and the note [see also] stay.", &[]);
        let out = render(&r).unwrap();
        assert!(out.contains("[a, b]"));
        assert!(out.contains("[see also]"));
    }

    #[test]
    fn an_answer_that_is_only_markers_is_no_result() {
        assert!(render(&resp("[1][2]", &[])).is_none());
    }

    #[test]
    fn answer_and_sources_are_rendered() {
        let out = render(&resp(
            "Paris is the capital of France.",
            &[
                "https://en.wikipedia.org/wiki/Paris",
                "https://example.invalid",
            ],
        ))
        .unwrap();
        assert!(out.contains("Paris is the capital"));
        assert!(out.contains("Sources: "));
        assert!(out.contains("wikipedia.org/wiki/Paris"));
    }

    #[test]
    fn a_long_answer_truncates_on_a_char_boundary() {
        let out = render(&resp(&"δ".repeat(2000), &[])).unwrap();
        assert!(out.ends_with('…'));
    }
}
