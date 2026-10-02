//! Computational knowledge, Wolfram|Alpha (`MODE_WOLFRAM` in cosmos's backend
//! enumeration).
//!
//! This backs the assistant's `wolfram` tool: facts, unit conversions, math, and
//! measurements that a search engine answers poorly. It uses the **LLM API**
//! (`/api/v1/llm-api`), which is purpose-built to be read by a model, it returns
//! a compact plain-text block (interpretation, value, alternate forms), exactly
//! the shape a ReAct observation wants.
//!
//! The credential is an *App ID*, not a secret key, but it is still read from the
//! environment and never compiled in.

use super::{BackendError, http, key, refused};

const APP_ID_VAR: &str = "COSMOS_WOLFRAM_APP_ID";

/// Cap the observation: the LLM API can return long comparison sections, and the
/// transcript rides in the model's context on every subsequent step.
const MAX_CHARS: usize = 1200;

/// Query Wolfram|Alpha and render the result as an observation.
pub async fn query(input: &str) -> Result<String, BackendError> {
    let app_id = key(APP_ID_VAR).ok_or(BackendError::NotConfigured)?;
    let url = format!(
        "https://www.wolframalpha.com/api/v1/llm-api?input={}&appid={app_id}",
        super::places::encode(input)
    );
    // The App ID rides in the query, so neither the URL nor a reqwest error
    // (whose text includes it) is logged.
    let resp = http().get(url).send().await.map_err(|error| {
        tracing::warn!(
            timeout = error.is_timeout(),
            "Wolfram|Alpha could not be reached"
        );
        BackendError::Unavailable
    })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|_| BackendError::Unavailable)?;
    decode(status, &body)
}

/// The LLM API's answer. 200 is text; 501 is its "no short answer / did you
/// mean" reply to a query it cannot interpret, and 400 an input it cannot
/// read, both an honest no-result rather than a fabricated answer. 403 is an
/// App ID it refuses, and anything else an outage: neither is "no results",
/// which the model would repeat as a fact about the question.
fn decode(status: u16, body: &str) -> Result<String, BackendError> {
    match status {
        200..=299 => render(body).ok_or(BackendError::NoResult),
        400 | 501 => Err(BackendError::NoResult),
        status => Err(refused("wolfram", status)),
    }
}

/// Trim the LLM-API text block to a transcript-sized observation without
/// inventing or reshaping content, Wolfram already formats it for a model.
///
/// The one thing dropped is `image:` lines. The live API interleaves plot and
/// history URLs among the facts. A text model cannot use them and they consume
/// context on every subsequent step of the run.
fn render(body: &str) -> Option<String> {
    let stripped: Vec<&str> = body
        .lines()
        .filter(|l| !l.trim_start().starts_with("image:"))
        .collect();
    let joined = stripped.join("\n");
    let text = joined.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() <= MAX_CHARS {
        return Some(text.to_owned());
    }
    // Truncate on a char boundary and mark it, rather than splitting a byte.
    let mut end = MAX_CHARS;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}…", &text[..end]))
}
