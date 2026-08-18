//! Self-hosted SearXNG: the unmetered half of the search policy.
//!
//! Brave answers fast, but its Free plan allows one request per second and a
//! couple of thousand calls a month, and one agentic turn can legitimately
//! search twice. A second provider with no quota is the structural fix, not a
//! nicety — measured at ~1.1s, which is inside the same conversational budget.
//! Because nothing is billed or rate limited, this provider keeps
//! [`WebSearchProvider::is_metered`]'s `false` default and belongs in the
//! routine hedge rather than being saved for last.
//!
//! The instance must be SELF-HOSTED. Public SearXNG instances disable
//! `format=json`, which is the only response shape parsed here, so there is
//! nothing to fall back to and no API key to configure — only a base URL. A
//! missing or blank one means the provider is simply absent, and
//! [`SearxngClient::is_configured`] is what the tool catalog gates on so an
//! unconfigured Pin never advertises a search it cannot run.
//!
//! Every string in the response is untrusted data — SearXNG aggregates other
//! engines and hands their text through verbatim. Titles and snippets are
//! stripped of markup before the Pin speaks them or the planner cites an exact
//! span from one, and a result whose URL is not http(s) is dropped rather than
//! passed on.

use std::time::Duration;

use futures::StreamExt as _;
use reqwest::{StatusCode, Url};

use crate::external::web_search::{
    WebSearchError, WebSearchGeo, WebSearchProvider, WebSearchResult, WebSearchResults,
};

/// Matches the sibling providers: a wearer is standing in silence while this
/// runs, and a search that has not answered in four seconds has already lost.
const SEARXNG_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_QUERY_BYTES: usize = 512;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
/// The Pin speaks its answers. More than a handful of results is unusable as
/// speech and only widens the untrusted surface the planner has to reason over.
const MAX_RESULTS: usize = 3;
/// SearXNG queries a few dozen engines, so a bad day can list many failures.
/// The debug line exists to tell an operator *what* is degrading, not to
/// transcribe the whole set.
const MAX_LOGGED_ENGINES: usize = 8;

#[derive(Clone)]
pub struct SearxngClient {
    http: reqwest::Client,
    /// Normalised at construction, `None` when unusable — see
    /// [`normalize_base_url`].
    base_url: Option<String>,
}

/// Redacted by hand: a self-hosted base URL may contain `user:password@` for an
/// instance behind basic auth, and the derived form would print it.
impl std::fmt::Debug for SearxngClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SearxngClient")
            .field("base_url", &self.base_url.as_deref().map(redacted_base_url))
            .field("configured", &self.is_configured())
            .finish()
    }
}

impl SearxngClient {
    pub fn new(http: reqwest::Client, base_url: Option<String>) -> Self {
        Self {
            http,
            base_url: normalize_base_url(base_url),
        }
    }

    /// Whether a usable instance is configured. The tool catalog is gated on
    /// this so an unconfigured Pin never advertises a search it cannot run.
    pub fn is_configured(&self) -> bool {
        self.base_url.is_some()
    }

    /// Endpoint and parameters verified against a live instance: with
    /// `language=en-DK` the query `netto opening hours copenhagen` returned
    /// `visitcopenhagen.dk` first, so the locale is doing real work rather than
    /// being decorative.
    fn search_url(&self, query: &str, geo: &WebSearchGeo) -> Result<Url, WebSearchError> {
        let base_url = self
            .base_url
            .as_deref()
            .ok_or(WebSearchError::NotConfigured)?;
        // Unreachable in practice — `new` already parsed this. `NotConfigured`
        // rather than a transient error because a base URL that cannot be
        // joined is a settings fault that no retry will repair.
        let mut url =
            Url::parse(&format!("{base_url}/search")).map_err(|_| WebSearchError::NotConfigured)?;
        url.query_pairs_mut()
            .append_pair("q", query)
            // The only shape this parser accepts; a public instance answers 403
            // here, which is why the deployment must be self-hosted.
            .append_pair("format", "json")
            .append_pair("language", &geo.locale())
            .append_pair("safesearch", "1");
        Ok(url)
    }

    async fn fetch_json(&self, url: Url) -> Result<serde_json::Value, WebSearchError> {
        let requested_url = url.clone();

        let response = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(SEARXNG_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    WebSearchError::Timeout
                } else {
                    WebSearchError::Transport
                }
            })?;

        // The production HTTP client disables redirects. Kept here as a defense
        // for independently constructed clients and tests: results that came
        // from a host the operator did not configure are not this instance's
        // answers, and the base URL may contain basic-auth credentials that a
        // redirect would replay elsewhere.
        if response.url() != &requested_url {
            return Err(WebSearchError::ProviderUnavailable);
        }

        match response.status() {
            StatusCode::TOO_MANY_REQUESTS => return Err(WebSearchError::RateLimited),
            // Includes 401/403, which is how an instance with JSON output
            // disabled or an auth-gated one answers: a rejection of the way we
            // asked, not an outage, so it must not read as retryable.
            status if status.is_client_error() => return Err(WebSearchError::ProviderRejected),
            status if !status.is_success() => return Err(WebSearchError::ProviderUnavailable),
            _ => {}
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(WebSearchError::ResponseTooLarge);
        }

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| WebSearchError::Transport)?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(WebSearchError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| WebSearchError::InvalidResponse)
    }
}

#[tonic::async_trait]
impl WebSearchProvider for SearxngClient {
    fn name(&self) -> &'static str {
        "searxng"
    }

    async fn search(
        &self,
        query: &str,
        geo: &WebSearchGeo,
    ) -> Result<WebSearchResults, WebSearchError> {
        let query = validate_query(query)?;
        let url = self.search_url(query, geo)?;
        // One `search` call costs a caller at most `SEARXNG_TIMEOUT` end to end:
        // the per-request timeout above bounds the response head, this bounds
        // the streamed body too, so a stalled instance cannot eat the turn.
        tokio::time::timeout(SEARXNG_TIMEOUT, self.fetch_json(url))
            .await
            .map_err(|_| WebSearchError::Timeout)?
            .and_then(|json| parse_search_response(&json))
    }
}

/// Reduce a configured base URL to the one form the rest of this module can
/// join `/search` onto, or `None` when the provider should count as absent.
///
/// A settings write that clears the field leaves an empty string behind, so
/// blank means "no SearXNG". A syntactically unusable value is treated the same
/// way rather than kept: `is_configured` gates the tool catalog, and
/// advertising a search that can only ever fail is worse for the wearer than
/// not offering one.
fn normalize_base_url(base_url: Option<String>) -> Option<String> {
    let raw = base_url?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match Url::parse(raw) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {
            // The trailing slash goes here so the `/search` join cannot produce
            // `//search`, which reverse proxies in front of SearXNG do 404.
            Some(url.to_string().trim_end_matches('/').to_owned())
        }
        // Logged without the value: this is precisely the path where a base URL
        // containing basic-auth credentials would be malformed.
        _ => {
            tracing::warn!(
                "the configured SearXNG base URL is not an http(s) URL; \
                 the provider stays unconfigured"
            );
            None
        }
    }
}

/// The base URL with any `user:password@` removed, for logs and `Debug`.
fn redacted_base_url(base_url: &str) -> String {
    let Ok(mut url) = Url::parse(base_url) else {
        return "<invalid>".to_owned();
    };
    // Both setters fail only on cannot-be-a-base URLs, which `normalize_base_url`
    // has already excluded; ignoring the result keeps the redaction total either
    // way, since a failure leaves nothing added.
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.to_string()
}

fn validate_query(query: &str) -> Result<&str, WebSearchError> {
    let query = query.trim();
    if query.is_empty() || query.len() > MAX_QUERY_BYTES {
        return Err(WebSearchError::InvalidRequest);
    }
    // Whitespace-exempt, matching the sibling providers and the shared typed
    // argument validator. A bare `is_control()` rejection would fail a query
    // containing a newline only AFTER it had passed typed validation and
    // grounding, and `InvalidRequest` is not retryable, so the turn would die
    // on a character the rest of the stack considers ordinary whitespace.
    if query.chars().any(|character| {
        character == '\0' || (character.is_control() && !character.is_whitespace())
    }) {
        return Err(WebSearchError::InvalidRequest);
    }
    Ok(query)
}

fn parse_search_response(json: &serde_json::Value) -> Result<WebSearchResults, WebSearchError> {
    let entries = json
        .get("results")
        .and_then(serde_json::Value::as_array)
        .ok_or(WebSearchError::InvalidResponse)?;

    // Partial engine failure is the NORMAL steady state, not an error: a live
    // instance returned 47 usable results while startpage was answering CAPTCHA.
    // Debug-only, so an operator can see what is degrading without it ever
    // becoming silence the wearer hears.
    let unresponsive = unresponsive_engine_notes(json);
    if !unresponsive.is_empty() {
        tracing::debug!(
            engines = ?unresponsive,
            "some SearXNG engines did not answer; the results that did still count"
        );
    }

    let results: Vec<WebSearchResult> = entries
        .iter()
        .filter_map(parse_result)
        .take(MAX_RESULTS)
        .collect();

    // Only an empty result set is a miss. Which engines failed to produce it is
    // not the wearer's problem and must not change this answer.
    if results.is_empty() {
        return Err(WebSearchError::NotFound);
    }
    Ok(WebSearchResults { results })
}

fn parse_result(entry: &serde_json::Value) -> Option<WebSearchResult> {
    let source_url = entry.get("url").and_then(serde_json::Value::as_str)?;
    // Only ever hand back a fetchable public web address. Anything else in that
    // field is a provider-controlled string we have no reason to trust.
    let parsed = Url::parse(source_url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }

    let title = strip_markup(entry.get("title").and_then(serde_json::Value::as_str)?);
    if title.is_empty() {
        return None;
    }
    // SearXNG names the snippet `content`; the shared result type calls it a
    // description because that is what the planner and the Pin see.
    let description = strip_markup(
        entry
            .get("content")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
    );
    // Usually `null`, occasionally an ISO timestamp — the only freshness signal
    // SearXNG publishes.
    let age = entry
        .get("publishedDate")
        .and_then(serde_json::Value::as_str)
        .map(strip_markup)
        .filter(|age| !age.is_empty());

    Some(WebSearchResult {
        title,
        description,
        source_url: parsed.to_string(),
        age,
    })
}

/// `unresponsive_engines` is a list of `[engine, reason]` pairs, e.g.
/// `[["startpage", "CAPTCHA"]]`. Both halves are provider-controlled strings, so
/// they are stripped like any other untrusted text before reaching a log line.
fn unresponsive_engine_notes(json: &serde_json::Value) -> Vec<String> {
    let Some(entries) = json
        .get("unresponsive_engines")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .take(MAX_LOGGED_ENGINES)
        .map(|entry| {
            let pair = entry.as_array().map(Vec::as_slice).unwrap_or_default();
            let field = |index: usize| {
                pair.get(index)
                    .and_then(serde_json::Value::as_str)
                    .map(strip_markup)
                    .unwrap_or_default()
            };
            format!("{}: {}", field(0), field(1))
        })
        .collect()
}

/// Aggregated engines mark matched terms with tags and encode a few entities.
/// The Pin speaks these strings, and the planner may cite an exact span from
/// one, so tags have to be gone before either happens — not merely rendered
/// away.
fn strip_markup(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    // Buffered rather than a bare bool: a `<` that does not begin a tag is
    // ordinary text ("best if pH < 7 and the water is soft"), and treating it
    // as one silently deleted the rest of the field. Only `<` followed by a
    // letter or `/` opens a tag; anything else — including an unterminated one
    // at end of input — is flushed back out as the literal text it was.
    let mut pending_tag: Option<String> = None;
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if let Some(buffer) = pending_tag.as_mut() {
            if character == '>' {
                pending_tag = None;
            } else {
                buffer.push(character);
            }
            continue;
        }
        match character {
            '<' if characters
                .peek()
                .is_some_and(|next| next.is_ascii_alphabetic() || *next == '/') =>
            {
                pending_tag = Some(String::new());
            }
            _ if character.is_control() => text.push(' '),
            _ => text.push(character),
        }
    }
    if let Some(buffer) = pending_tag {
        text.push('<');
        text.push_str(&buffer);
    }
    let text = text
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        // Ampersand last: decoding it first would let "&amp;lt;" become "<".
        .replace("&amp;", "&");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(base_url: Option<&str>) -> SearxngClient {
        SearxngClient::new(
            reqwest::Client::new(),
            base_url.map(std::borrow::ToOwned::to_owned),
        )
    }

    /// The shape captured from a live instance, trimmed to the fields parsed.
    fn captured_body() -> serde_json::Value {
        serde_json::json!({
            "query": "netto opening hours copenhagen",
            "results": [
                {
                    "title": "<strong>Netto</strong> Copenhagen",
                    "url": "https://www.visitcopenhagen.dk/a",
                    "content": "Open 7&nbsp;days &#39;til 22.",
                    "engine": "google",
                    "publishedDate": null,
                    "score": 3.0,
                    "category": "general",
                    "template": "default.html"
                },
                {
                    "title": "Second",
                    "url": "https://example.dk/b",
                    "content": "b",
                    "publishedDate": "2026-07-30T00:00:00+00:00"
                },
                {"title": "Third", "url": "https://example.dk/c", "content": "c"},
                {"title": "Fourth", "url": "https://example.dk/d", "content": "d"}
            ],
            "answers": [],
            "corrections": [],
            "infoboxes": [],
            "suggestions": [],
            "unresponsive_engines": []
        })
    }

    #[test]
    fn results_are_parsed_stripped_and_capped() {
        let parsed = parse_search_response(&captured_body()).expect("the captured shape parses");

        assert_eq!(
            parsed.results.len(),
            MAX_RESULTS,
            "the speakable cap must hold"
        );
        assert_eq!(parsed.results[0].title, "Netto Copenhagen");
        assert_eq!(parsed.results[0].description, "Open 7 days 'til 22.");
        assert_eq!(
            parsed.results[0].source_url,
            "https://www.visitcopenhagen.dk/a"
        );
        assert_eq!(
            parsed.results[0].age, None,
            "a null publishedDate is no freshness label, not an empty one"
        );
        assert_eq!(
            parsed.results[1].age.as_deref(),
            Some("2026-07-30T00:00:00+00:00")
        );
    }

    /// THE SUBTLE ONE. Some engines failing while others answer is the normal
    /// steady state — measured: 47 results came back alongside a startpage
    /// CAPTCHA. Treating `unresponsive_engines` as a failure would turn a good
    /// answer into silence for the wearer.
    #[test]
    fn unresponsive_engines_do_not_fail_a_search_that_returned_results() {
        let json = serde_json::json!({
            "results": [
                {"title": "Still good", "url": "https://example.dk/ok", "content": "x"}
            ],
            "unresponsive_engines": [["startpage", "CAPTCHA"], ["qwant", "timeout"]]
        });

        let parsed =
            parse_search_response(&json).expect("a degraded engine set still answers the query");
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].title, "Still good");
        assert_eq!(
            unresponsive_engine_notes(&json),
            vec!["startpage: CAPTCHA", "qwant: timeout"],
            "the failures are diagnostics only"
        );
    }

    #[test]
    fn an_empty_or_shapeless_response_is_an_error_not_an_empty_answer() {
        // Empty results are a miss even when the engine failures explain why.
        assert_eq!(
            parse_search_response(&serde_json::json!({
                "results": [],
                "unresponsive_engines": [["startpage", "CAPTCHA"]]
            })),
            Err(WebSearchError::NotFound)
        );
        assert_eq!(
            parse_search_response(&serde_json::json!({"query": "x"})),
            Err(WebSearchError::InvalidResponse)
        );
    }

    #[test]
    fn a_non_web_url_is_dropped_rather_than_handed_to_the_planner() {
        let json = serde_json::json!({
            "results": [
                {"title": "Bad", "url": "javascript:alert(1)", "content": "x"},
                {"title": "Also bad", "url": "file:///etc/passwd", "content": "x"},
                {"title": "Good", "url": "https://example.dk/ok", "content": "x"}
            ]
        });

        let parsed = parse_search_response(&json).expect("the one good result survives");
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].source_url, "https://example.dk/ok");
    }

    #[tokio::test]
    async fn a_missing_or_blank_base_url_is_reported_not_guessed() {
        for base_url in [None, Some(""), Some("   ")] {
            let client = client(base_url);
            assert!(!client.is_configured(), "{base_url:?}");

            let error = client
                .search("who won", &WebSearchGeo::default())
                .await
                .expect_err("an unconfigured client must not reach the network");
            assert_eq!(error, WebSearchError::NotConfigured);
            assert!(
                !error.is_transient(),
                "a missing instance never fixes itself"
            );
        }
    }

    /// A base URL that cannot be searched is the same absence as none at all:
    /// `is_configured` gates the tool catalog, so advertising a search that can
    /// only fail is worse than not offering one.
    #[test]
    fn an_unusable_base_url_counts_as_unconfigured() {
        assert!(!client(Some("file:///etc/passwd")).is_configured());
        assert!(!client(Some("not a url")).is_configured());
    }

    #[test]
    fn a_trailing_slash_is_trimmed_so_the_search_path_stays_single() {
        let client = client(Some("https://searx.example.dk/"));
        assert_eq!(client.base_url.as_deref(), Some("https://searx.example.dk"));

        let url = client
            .search_url("q", &WebSearchGeo::default())
            .expect("a configured client builds a URL");
        assert_eq!(url.path(), "/search");
    }

    /// Geography is part of correctness here: verified against a live instance,
    /// `language=en-DK` put `visitcopenhagen.dk` first for a Copenhagen query.
    #[test]
    fn the_request_carries_the_wearers_locale_and_asks_for_json() {
        let url = client(Some("https://searx.example.dk"))
            .search_url("netto opening hours copenhagen", &WebSearchGeo::default())
            .expect("a configured client builds a URL");

        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert!(
            pairs.contains(&("q".to_owned(), "netto opening hours copenhagen".to_owned())),
            "{pairs:?}"
        );
        assert!(
            pairs.contains(&("format".to_owned(), "json".to_owned())),
            "{pairs:?}"
        );
        assert!(
            pairs.contains(&("language".to_owned(), "en-DK".to_owned())),
            "{pairs:?}"
        );
        assert!(
            pairs.contains(&("safesearch".to_owned(), "1".to_owned())),
            "{pairs:?}"
        );
    }

    #[test]
    fn debug_output_never_carries_credentials_from_the_base_url() {
        let client = client(Some("https://ops:hunter2@searx.example.dk/"));
        let rendered = format!("{client:?}");

        assert!(!rendered.contains("hunter2"), "{rendered}");
        assert!(!rendered.contains("ops:"), "{rendered}");
        assert!(rendered.contains("searx.example.dk"), "{rendered}");
        assert!(rendered.contains("configured: true"), "{rendered}");
    }

    #[test]
    fn queries_are_bounded_and_control_free() {
        assert_eq!(validate_query("  "), Err(WebSearchError::InvalidRequest));
        assert_eq!(
            validate_query(&"a".repeat(MAX_QUERY_BYTES + 1)),
            Err(WebSearchError::InvalidRequest)
        );
        // A newline is whitespace, not a control-character rejection: the typed
        // validator upstream already lets one through, so rejecting it here
        // would kill the turn on a character everything else tolerates.
        assert_eq!(validate_query("news\nabout"), Ok("news\nabout"));
        assert_eq!(
            validate_query("news\u{0}about"),
            Err(WebSearchError::InvalidRequest)
        );
        assert_eq!(validate_query("  danish news  "), Ok("danish news"));
    }

    #[test]
    fn markup_stripping_keeps_text_that_only_looks_like_a_tag() {
        assert_eq!(strip_markup("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
        assert_eq!(
            strip_markup("best if pH < 7 and the water is soft"),
            "best if pH < 7 and the water is soft"
        );
        assert_eq!(strip_markup("a <b>bold</b> claim"), "a bold claim");
        assert_eq!(strip_markup("truncated <spa"), "truncated <spa");
        assert_eq!(strip_markup("a\u{0}b"), "a b");
    }

    #[test]
    fn the_provider_is_unmetered_so_it_stays_in_the_routine_hedge() {
        let client = client(Some("https://searx.example.dk"));
        assert_eq!(client.name(), "searxng");
        assert!(
            !client.is_metered(),
            "a self-hosted instance has no quota to protect"
        );
    }
}
