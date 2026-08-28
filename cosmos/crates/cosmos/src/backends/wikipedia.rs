//! Encyclopedia lookup — Wikipedia (`MODE_WIKIPEDIA` in cosmos's backend
//! enumeration).
//!
//! cosmos treated retrieval (SerpApi), computation (Wolfram), and encyclopedia
//! (Wikipedia) as *separate* tool backends, so this is its own tool rather than a
//! fold into `web_search`. It needs **no credential** — the MediaWiki API is
//! public — so it is the one search-ensemble backend that is always available.
//!
//! One call does both search and extract: the `generator=search` API finds the
//! best-matching article and returns its intro extract in the same response.

use serde::Deserialize;
use std::{cmp::Reverse, collections::HashSet};

use super::{BackendError, http};

/// Cap the intro extract folded into the transcript.
const MAX_CHARS: usize = 1200;

#[derive(Deserialize)]
struct WikiResponse {
    query: Option<QueryBlock>,
}

#[derive(Deserialize)]
struct QueryBlock {
    #[serde(default)]
    pages: std::collections::HashMap<String, Page>,
}

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    title: String,
    #[serde(default)]
    extract: String,
    /// Present + lowest wins: the search generator ranks matches by `index`.
    #[serde(default)]
    index: i32,
}

/// Look up the best-matching article's intro and render it as an observation.
pub async fn lookup(query: &str) -> Result<String, BackendError> {
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1\
         &prop=extracts&exintro=1&explaintext=1&generator=search&gsrlimit=5&gsrsearch={}",
        super::places::encode(query)
    );
    let resp: WikiResponse = http()
        .get(url)
        // MediaWiki asks callers to identify themselves; a descriptive UA is
        // required to avoid being throttled.
        .header("User-Agent", "ai-pin-revival-cosmos/1.0 (assistant tool)")
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    render(resp, query).ok_or(BackendError::NoResult)
}

fn normalized_tokens(value: &str) -> HashSet<String> {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// Prefer the title that most precisely names the requested entity. MediaWiki's
/// full-text rank can otherwise put a disambiguated replica first merely because
/// its extract contains an attribute word such as "height". Provider rank stays
/// the fallback and final tie-breaker.
fn page_rank(page: &Page, query_tokens: &HashSet<String>) -> (u8, Reverse<usize>, usize, i32) {
    let title_tokens = normalized_tokens(&page.title);
    let overlap = title_tokens.intersection(query_tokens).count();
    let unmatched_title = title_tokens.difference(query_tokens).count();
    (
        u8::from(overlap == 0),
        Reverse(overlap),
        unmatched_title,
        page.index,
    )
}

/// Pick the most relevant returned page and trim its extract, without reshaping
/// content.
fn render(resp: WikiResponse, query: &str) -> Option<String> {
    let pages = resp.query?.pages;
    let query_tokens = normalized_tokens(query);
    let best = pages
        .into_values()
        .filter(|p| !p.extract.trim().is_empty())
        .min_by_key(|page| page_rank(page, &query_tokens))?;

    let extract = best.extract.trim();
    let body = if extract.len() <= MAX_CHARS {
        extract.to_owned()
    } else {
        let mut end = MAX_CHARS;
        while end > 0 && !extract.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &extract[..end])
    };
    Some(format!("{}: {}", best.title, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(title: &str, extract: &str, index: i32) -> Page {
        Page {
            title: title.into(),
            extract: extract.into(),
            index,
        }
    }

    fn resp(pages: Vec<Page>) -> WikiResponse {
        let map = pages
            .into_iter()
            .enumerate()
            .map(|(i, p)| (i.to_string(), p))
            .collect();
        WikiResponse {
            query: Some(QueryBlock { pages: map }),
        }
    }

    #[test]
    fn no_query_block_is_no_result() {
        assert!(render(WikiResponse { query: None }, "anything").is_none());
    }

    #[test]
    fn picks_the_top_ranked_page_and_prefixes_its_title() {
        let out = render(
            resp(vec![
                page("Second", "runner up", 2),
                page("First", "the best match intro", 1),
            ]),
            "anything",
        )
        .unwrap();
        assert!(out.starts_with("First: "));
        assert!(out.contains("the best match intro"));
    }

    #[test]
    fn a_base_entity_beats_a_disambiguated_title_that_only_matches_query_detail() {
        let out = render(
            resp(vec![
                page(
                    "Eiffel Tower (Paris, Texas)",
                    "A 20 metre replica in Texas.",
                    1,
                ),
                page("Eiffel Tower", "The 330 metre landmark in Paris.", 2),
            ]),
            "Eiffel Tower height",
        )
        .unwrap();

        assert!(out.starts_with("Eiffel Tower: "), "wrong article: {out}");
    }

    #[test]
    fn a_page_with_an_empty_extract_is_skipped() {
        let out = render(
            resp(vec![page("Empty", "   ", 1), page("Real", "content", 2)]),
            "anything",
        );
        assert_eq!(out.unwrap(), "Real: content");
    }
}
