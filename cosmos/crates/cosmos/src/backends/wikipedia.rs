//! Encyclopedia lookup — Wikipedia (`MODE_WIKIPEDIA` in carry's backend
//! enumeration).
//!
//! carry treated retrieval (SerpApi), computation (Wolfram), and encyclopedia
//! (Wikipedia) as *separate* tool backends, so this is its own tool rather than a
//! fold into `web_search`. It needs **no credential** — the MediaWiki API is
//! public — so it is the one search-ensemble backend that is always available.
//!
//! One call does both search and extract: the `generator=search` API finds the
//! best-matching article and returns its intro extract in the same response.

use serde::Deserialize;

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
         &prop=extracts&exintro=1&explaintext=1&generator=search&gsrlimit=1&gsrsearch={}",
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

    render(resp).ok_or(BackendError::NoResult)
}

/// Pick the top-ranked page and trim its extract, without reshaping content.
fn render(resp: WikiResponse) -> Option<String> {
    let pages = resp.query?.pages;
    let best = pages
        .into_values()
        .filter(|p| !p.extract.trim().is_empty())
        .min_by_key(|p| p.index)?;

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
        assert!(render(WikiResponse { query: None }).is_none());
    }

    #[test]
    fn picks_the_top_ranked_page_and_prefixes_its_title() {
        let out = render(resp(vec![
            page("Second", "runner up", 2),
            page("First", "the best match intro", 1),
        ]))
        .unwrap();
        assert!(out.starts_with("First: "));
        assert!(out.contains("the best match intro"));
    }

    #[test]
    fn a_page_with_an_empty_extract_is_skipped() {
        let out = render(resp(vec![
            page("Empty", "   ", 1),
            page("Real", "content", 2),
        ]));
        assert_eq!(out.unwrap(), "Real: content");
    }
}
