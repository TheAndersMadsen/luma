//! Computational knowledge — Wolfram|Alpha (`MODE_WOLFRAM` in carry's backend
//! enumeration).
//!
//! This backs the assistant's `wolfram` tool: facts, unit conversions, math, and
//! measurements that a search engine answers poorly. It uses the **LLM API**
//! (`/api/v1/llm-api`), which is purpose-built to be read by a model — it returns
//! a compact plain-text block (interpretation, value, alternate forms), exactly
//! the shape a ReAct observation wants.
//!
//! The credential is an *App ID*, not a secret key, but it is still read from the
//! environment and never compiled in.

use super::{BackendError, http, key};

const APP_ID_VAR: &str = "CARRY_WOLFRAM_APP_ID";

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
    let resp = http()
        .get(url)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    // The LLM API answers 200 with text on success and 501 with a
    // "no short answer / did you mean" body when it cannot interpret the query.
    // Treat the latter as an honest no-result, not a fabricated answer.
    let interpretable = resp.status().is_success();
    let body = resp.text().await.map_err(|_| BackendError::Unavailable)?;
    if !interpretable {
        return Err(BackendError::NoResult);
    }
    render(&body).ok_or(BackendError::NoResult)
}

/// Trim the LLM-API text block to a transcript-sized observation without
/// inventing or reshaping content — Wolfram already formats it for a model.
///
/// The one thing dropped is `image:` lines. The live API interleaves plot and
/// history URLs among the facts; a text model cannot use them and they consume
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_body_is_no_result_not_an_empty_answer() {
        assert!(render("   ").is_none());
        // An answer that is nothing but plot URLs carries no fact either.
        assert!(
            render("image: https://example.invalid/a.png\nimage: https://example.invalid/b.png")
                .is_none()
        );
    }

    #[test]
    fn image_urls_are_dropped_but_the_facts_around_them_are_kept() {
        // Shape taken from a real llm-api response for "distance from earth to mars".
        let body = "Current result:\n1.995 au (astronomical units)\n\n\
                    History:\nimage: https://public6.wolframalpha.com/files/PNG_z6.png\n\n\
                    Unit conversions:\n2.984 × 10^8 km (kilometers)";
        let out = render(body).unwrap();
        assert!(out.contains("1.995 au"));
        assert!(out.contains("2.984 × 10^8 km"));
        assert!(!out.contains("image:"));
        assert!(!out.contains("wolframalpha.com/files"));
    }

    #[test]
    fn short_result_passes_through_unchanged() {
        let out = render("Value:\n2.998 × 10^8 m/s").unwrap();
        assert!(out.contains("2.998"));
        assert!(!out.ends_with('…'));
    }

    #[test]
    fn long_result_is_truncated_on_a_char_boundary() {
        let long = "α".repeat(2000); // multi-byte, to exercise the boundary walk
        let out = render(&long).unwrap();
        assert!(out.ends_with('…'));
        assert!(out.len() <= MAX_CHARS + 4);
    }
}
